// electron/Retriever.ts
// ──────────────────────────────────────────────────────────────────────────────
// Hybrid retriever: pgvector cosine similarity + Postgres full-text search.
// Queries the `knowledge_chunks` table and returns ranked RetrievalResult[].
// ──────────────────────────────────────────────────────────────────────────────

import { Pool } from "pg";
import { GoogleGenerativeAI } from "@google/generative-ai";
import type { RetrievalResult, CragDeps } from "./types/crag";

/** Gemini embedding model – must match the one used during ingestion. */
const EMBEDDING_MODEL = "gemini-embedding-001";

export class Retriever {
  private pool: Pool;
  private genAI: GoogleGenerativeAI;
  private topK: number;
  private minThreshold: number;
  private alpha: number;

  constructor(private deps: CragDeps) {
    this.pool = deps.pool;
    this.genAI = new GoogleGenerativeAI(deps.geminiApiKey);
    this.topK = deps.cragConfig.topK;
    this.minThreshold = deps.cragConfig.minRelevanceThreshold;
    this.alpha = deps.cragConfig.retrievalAlpha;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Pure semantic search using pgvector cosine distance.
   * Fast path when you only need embedding-based retrieval.
   */
  public async semanticSearch(query: string): Promise<RetrievalResult[]> {
    const queryEmbedding = await this.embedQuery(query);

    const sql = `
      SELECT
        id,
        section,
        topics,
        content,
        source_tags,
        source_file,
        1 - (embedding <=> $1::vector) AS similarity_score
      FROM knowledge_chunks
      ORDER BY embedding <=> $1::vector
      LIMIT $2
    `;

    const embeddingStr = `[${queryEmbedding.join(",")}]`;
    const { rows } = await this.pool.query(sql, [embeddingStr, this.topK]);

    return rows
      .map((row) => this.mapRow(row, 0))
      .filter((r) => r.similarityScore >= this.minThreshold);
  }

  /**
   * Pure full-text search using Postgres tsvector/tsquery.
   * Good for exact keyword matches (e.g. "LRU eviction policy").
   */
  public async keywordSearch(query: string): Promise<RetrievalResult[]> {
    // Convert natural language query into a tsquery with OR between terms
    const tsQuery = this.buildTsQuery(query);

    const sql = `
      SELECT
        id,
        section,
        topics,
        content,
        source_tags,
        source_file,
        ts_rank_cd(content_tsv, to_tsquery('english', $1)) AS fts_rank
      FROM knowledge_chunks
      WHERE content_tsv @@ to_tsquery('english', $1)
      ORDER BY fts_rank DESC
      LIMIT $2
    `;

    const { rows } = await this.pool.query(sql, [tsQuery, this.topK]);

    return rows.map((row) => ({
      id: row.id,
      section: row.section,
      topics: row.topics || [],
      content: row.content,
      sourceTags: row.source_tags || [],
      sourceFile: row.source_file,
      similarityScore: 0,
      ftsRank: parseFloat(row.fts_rank) || 0,
      hybridScore: parseFloat(row.fts_rank) || 0,
    }));
  }

  /**
   * Hybrid search: combines pgvector cosine similarity with Postgres FTS
   * in a single SQL query using a weighted score.
   *
   * hybrid_score = α × normalised_fts_rank + (1-α) × cosine_similarity
   *
   * This is the recommended entry point for the CRAG pipeline.
   */
  public async hybridSearch(query: string): Promise<RetrievalResult[]> {
    const queryEmbedding = await this.embedQuery(query);
    const tsQuery = this.buildTsQuery(query);
    const embeddingStr = `[${queryEmbedding.join(",")}]`;

    // We use a CTE to compute both scores, then combine them.
    // The FTS rank is normalised to [0,1] by dividing by the max rank in the result set.
    // If no FTS match exists for a row, fts_rank defaults to 0.
    const sql = `
      WITH scored AS (
        SELECT
          id,
          section,
          topics,
          content,
          source_tags,
          source_file,
          -- Cosine similarity: 1 - cosine_distance. Range [0, 1].
          1 - (embedding <=> $1::vector) AS similarity_score,
          -- Full-text-search rank. 0 if no match.
          COALESCE(
            ts_rank_cd(content_tsv, to_tsquery('english', $2)),
            0
          ) AS fts_rank
        FROM knowledge_chunks
      ),
      normalised AS (
        SELECT
          *,
          -- Normalise FTS rank to [0, 1] relative to the best match.
          CASE
            WHEN MAX(fts_rank) OVER () > 0
            THEN fts_rank / MAX(fts_rank) OVER ()
            ELSE 0
          END AS fts_norm
        FROM scored
      )
      SELECT
        *,
        -- Hybrid score: weighted combination
        ($3::float * fts_norm) + ((1 - $3::float) * similarity_score) AS hybrid_score
      FROM normalised
      ORDER BY
        ($3::float * fts_norm) + ((1 - $3::float) * similarity_score) DESC
      LIMIT $4
    `;

    const { rows } = await this.pool.query(sql, [
      embeddingStr,
      tsQuery,
      this.alpha,
      this.topK,
    ]);

    return rows
      .map((row) => this.mapRowHybrid(row))
      .filter((r) => r.hybridScore >= this.minThreshold);
  }

  // ─── Embedding ─────────────────────────────────────────────────────────────

  /**
   * Embeds a single query string using Gemini gemini-embedding-001.
   * Returns a 768-dimensional float array.
   */
  private async embedQuery(query: string): Promise<number[]> {
    const model = this.genAI.getGenerativeModel({ model: EMBEDDING_MODEL });

    const result = await model.embedContent({
      content: { role: "user", parts: [{ text: query }] },
      outputDimensionality: 768,
    } as any);

    const embedding = result.embedding?.values;
    if (!embedding || embedding.length !== 768) {
      throw new Error(
        `[Retriever] Query embedding failed: got ${embedding?.length ?? 0} dimensions, expected 768`
      );
    }

    return embedding;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Builds a Postgres tsquery string from a natural language query.
   * Tokenises by whitespace, removes very short words, joins with OR (|).
   * Example: "cache eviction LRU" → "cache | eviction | lru"
   */
  private buildTsQuery(query: string): string {
    const tokens = query
      .toLowerCase()
      .replace(/[^\w\s]/g, " ") // strip punctuation
      .split(/\s+/)
      .filter((t) => t.length >= 2)             // drop 1-char noise
      .map((t) => t.replace(/'/g, "''"));        // escape single quotes

    if (tokens.length === 0) return "unknown"; // fallback to avoid empty query

    // Join with | (OR) for broad matching. Use & (AND) for stricter search.
    return tokens.join(" | ");
  }

  /** Maps a pure-semantic result row. */
  private mapRow(row: any, ftsRank: number): RetrievalResult {
    const simScore = parseFloat(row.similarity_score) || 0;
    return {
      id: row.id,
      section: row.section,
      topics: row.topics || [],
      content: row.content,
      sourceTags: row.source_tags || [],
      sourceFile: row.source_file,
      similarityScore: simScore,
      ftsRank,
      hybridScore: simScore, // no FTS component
    };
  }

  /** Maps a hybrid search result row. */
  private mapRowHybrid(row: any): RetrievalResult {
    return {
      id: row.id,
      section: row.section,
      topics: row.topics || [],
      content: row.content,
      sourceTags: row.source_tags || [],
      sourceFile: row.source_file,
      similarityScore: parseFloat(row.similarity_score) || 0,
      ftsRank: parseFloat(row.fts_rank) || 0,
      hybridScore: parseFloat(row.hybrid_score) || 0,
    };
  }
}
