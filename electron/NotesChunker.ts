// electron/NotesChunker.ts
// ──────────────────────────────────────────────────────────────────────────────
// Parses notes files, splits them into semantic chunks, generates Gemini
// embeddings, and upserts everything into the `knowledge_chunks` Postgres table.
// ──────────────────────────────────────────────────────────────────────────────

import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { GoogleGenerativeAI } from "@google/generative-ai";
import type { KnowledgeChunk, EmbeddedChunk, CragDeps } from "./types/crag";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Regex to match citation markers like 【7:0†source】 or 【6:11†transcript.txt】 */
const CITATION_TAG_REGEX = /【(\d+):(\d+)†[^】]*】/g;

/** Target chunk size in approximate tokens (1 token ≈ 4 chars). */
const TARGET_CHUNK_TOKENS = 350;
const TARGET_CHUNK_CHARS = TARGET_CHUNK_TOKENS * 4;

/** Maximum chars per chunk (hard cap). */
const MAX_CHUNK_CHARS = 2000;

/** Overlap between adjacent sub-chunks in characters. */
const OVERLAP_CHARS = 120;

/** Gemini embedding model – 768 dimensions (leveraging gemini-embedding-001 with custom dimensionality). */
const EMBEDDING_MODEL = "gemini-embedding-001";

/** How many chunks to embed in a single batch request. */
const EMBED_BATCH_SIZE = 20;

// ─── Public API ──────────────────────────────────────────────────────────────

export class NotesChunker {
  private pool: Pool;
  private genAI: GoogleGenerativeAI;

  constructor(private deps: CragDeps) {
    this.pool = deps.pool;
    this.genAI = new GoogleGenerativeAI(deps.geminiApiKey);
  }

  /**
   * Full ingestion pipeline:
   *   1. Read each notes file
   *   2. Split into semantic chunks
   *   3. Extract + strip citation tags
   *   4. Generate embeddings via Gemini
   *   5. Upsert into Postgres
   *
   * Safe to call repeatedly — uses ON CONFLICT upsert.
   */
  public async ingestAll(): Promise<number> {
    const notesPaths = this.deps.cragConfig.notesPaths;
    let totalInserted = 0;

    for (const relPath of notesPaths) {
      let absPath = path.resolve(relPath);
      if (!fs.existsSync(absPath)) {
        try {
          const { app } = require("electron");
          const fallbackPath = path.join(app.getAppPath(), relPath);
          if (fs.existsSync(fallbackPath)) {
            absPath = fallbackPath;
          }
        } catch (e) {}
      }

      if (!fs.existsSync(absPath)) {
        console.warn(`[NotesChunker] File not found, skipping: ${absPath}`);
        continue;
      }

      console.log(`[NotesChunker] Ingesting: ${absPath}`);
      const rawText = fs.readFileSync(absPath, "utf-8");
      const sourceFile = path.basename(absPath);

      // Step 1 — Parse into raw chunks
      const rawChunks = this.chunkText(rawText, sourceFile);
      console.log(`[NotesChunker]   → ${rawChunks.length} chunks parsed`);

      // Step 2 — Generate embeddings in batches
      const embeddedChunks = await this.embedChunks(rawChunks);
      console.log(`[NotesChunker]   → ${embeddedChunks.length} embeddings generated`);

      // Step 3 — Upsert into Postgres
      const inserted = await this.upsertChunks(embeddedChunks);
      console.log(`[NotesChunker]   → ${inserted} rows upserted`);
      totalInserted += inserted;
    }

    return totalInserted;
  }

  /**
   * Remove all chunks for a specific source file from the database.
   * Useful before a full re-ingest of that file.
   */
  public async deleteBySourceFile(sourceFile: string): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM knowledge_chunks WHERE source_file = $1`,
      [sourceFile]
    );
    return result.rowCount ?? 0;
  }

  // ─── Chunking Logic ──────────────────────────────────────────────────────

  /**
   * Splits raw notes text into structured KnowledgeChunk objects.
   *
   * Strategy:
   *   1. Primary split by `---` delimiter (section boundaries).
   *   2. Within each section, derive a heading from the first non-blank line.
   *   3. Secondary split into ~350-token sub-chunks with overlap.
   *   4. Extract citation tags and strip them from content.
   *   5. Auto-extract topic keywords from each chunk.
   */
  private chunkText(rawText: string, sourceFile: string): KnowledgeChunk[] {
    const sections = rawText.split(/^-{3,}\s*$/m);
    const chunks: KnowledgeChunk[] = [];

    for (let si = 0; si < sections.length; si++) {
      const sectionText = sections[si].trim();
      if (!sectionText || sectionText.length < 30) continue;

      // Derive section heading from first non-blank line
      const lines = sectionText.split(/\r?\n/);
      const headingLine = lines.find((l) => l.trim().length > 0) ?? `Section ${si + 1}`;
      const sectionHeading = headingLine.trim().replace(/^#+\s*/, "");

      // Split section into sub-chunks
      const subTexts = this.splitIntoSubChunks(sectionText);

      for (let ci = 0; ci < subTexts.length; ci++) {
        const rawContent = subTexts[ci];

        // Extract citation tags before stripping
        const sourceTags = this.extractCitationTags(rawContent);

        // Strip citation tags from content
        const cleanedContent = this.stripCitationTags(rawContent).trim();
        if (cleanedContent.length < 20) continue;

        // Auto-extract topic keywords
        const topics = this.extractTopics(cleanedContent);

        const chunkId = `${sourceFile.replace(/\.[^.]+$/, "")}_s${si}_c${ci}`;

        chunks.push({
          id: chunkId,
          section: sectionHeading,
          topics,
          content: cleanedContent,
          sourceTags,
          sourceFile,
        });
      }
    }

    return chunks;
  }

  /**
   * Splits a section text into overlapping sub-chunks of ~TARGET_CHUNK_CHARS.
   * Tries to break at paragraph boundaries (double newline) or sentence
   * endings when possible.
   */
  private splitIntoSubChunks(text: string): string[] {
    if (text.length <= MAX_CHUNK_CHARS) return [text];

    const paragraphs = text.split(/\n\s*\n/);
    const subChunks: string[] = [];
    let current = "";

    for (const para of paragraphs) {
      const candidate = current ? `${current}\n\n${para}` : para;

      if (candidate.length > MAX_CHUNK_CHARS && current.length > 0) {
        // Current chunk is full — push it
        subChunks.push(current.trim());

        // Start new chunk with overlap from end of previous
        const overlapText = this.getOverlapTail(current, OVERLAP_CHARS);
        current = overlapText ? `${overlapText}\n\n${para}` : para;
      } else if (candidate.length > MAX_CHUNK_CHARS && current.length === 0) {
        // Single paragraph exceeds max — force-split by sentences
        const sentences = para.match(/[^.!?]+[.!?]+/g) || [para];
        let sentBuf = "";
        for (const sent of sentences) {
          if ((sentBuf + sent).length > MAX_CHUNK_CHARS && sentBuf.length > 0) {
            subChunks.push(sentBuf.trim());
            sentBuf = sent;
          } else {
            sentBuf += sent;
          }
        }
        current = sentBuf;
      } else if (candidate.length >= TARGET_CHUNK_CHARS) {
        subChunks.push(candidate.trim());
        current = this.getOverlapTail(candidate, OVERLAP_CHARS);
      } else {
        current = candidate;
      }
    }

    if (current.trim().length > 20) {
      subChunks.push(current.trim());
    }

    return subChunks;
  }

  /** Returns the last N characters of text, breaking at a word boundary. */
  private getOverlapTail(text: string, chars: number): string {
    if (text.length <= chars) return text;
    const slice = text.slice(-chars);
    const firstSpace = slice.indexOf(" ");
    return firstSpace > 0 ? slice.slice(firstSpace + 1) : slice;
  }

  // ─── Citation Tag Handling ────────────────────────────────────────────────

  /**
   * Extracts all unique citation tag numbers from the raw text.
   * 【7:0†source】 → [7, 0]
   * 【6:11†transcript.txt】 → [6, 11]
   * Returns a flat, deduplicated, sorted array of all extracted integers.
   */
  private extractCitationTags(text: string): number[] {
    const tags = new Set<number>();
    let match: RegExpExecArray | null;

    // Reset lastIndex for global regex
    CITATION_TAG_REGEX.lastIndex = 0;
    while ((match = CITATION_TAG_REGEX.exec(text)) !== null) {
      tags.add(parseInt(match[1], 10));
      tags.add(parseInt(match[2], 10));
    }

    return Array.from(tags).sort((a, b) => a - b);
  }

  /** Strips all 【…】 citation tags from the text. */
  private stripCitationTags(text: string): string {
    return text.replace(CITATION_TAG_REGEX, "");
  }

  // ─── Topic Extraction ─────────────────────────────────────────────────────

  /**
   * Simple keyword extractor. Finds capitalised terms, acronyms, and
   * domain-specific vocabulary that appear in the chunk.
   */
  private extractTopics(text: string): string[] {
    const domainTerms = [
      "LRU", "LFU", "FIFO", "LIFO", "cache", "caching", "eviction",
      "invalidation", "TTL", "CDN", "DNS", "load balancer", "consistent hashing",
      "round robin", "sharding", "shard", "replication", "replica",
      "CAP theorem", "ACID", "atomicity", "consistency", "availability",
      "partition tolerance", "eventual consistency", "immediate consistency",
      "quorum", "master-slave", "newsfeed", "leaderboard",
      "SQL", "NoSQL", "Redis", "write through", "write around", "write back",
      "fan-out", "throughput", "latency", "heartbeat", "health check",
      "singleton", "factory", "observer", "strategy", "builder",
      "SOLID", "SRP", "OCP", "LSP", "ISP", "DIP",
    ];

    const lower = text.toLowerCase();
    const found: string[] = [];

    for (const term of domainTerms) {
      if (lower.includes(term.toLowerCase())) {
        found.push(term);
      }
    }

    // Also grab ALL_CAPS acronyms from the text
    const acronyms = text.match(/\b[A-Z]{2,6}\b/g);
    if (acronyms) {
      for (const a of acronyms) {
        if (!found.includes(a)) found.push(a);
      }
    }

    return [...new Set(found)].slice(0, 15); // cap at 15 topics
  }

  // ─── Embedding Generation ─────────────────────────────────────────────────

  /**
   * Generates 768-dim embeddings for an array of KnowledgeChunks using
   * Gemini `gemini-embedding-001`, batched to avoid rate limits.
   */
  private async embedChunks(chunks: KnowledgeChunk[]): Promise<EmbeddedChunk[]> {
    const model = this.genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
    const results: EmbeddedChunk[] = [];

    for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
      const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
      const texts = batch.map((c) => c.content);

      try {
        // Gemini embedding API: batchEmbedContents
        const response = await model.batchEmbedContents({
          requests: texts.map((text) => ({
            model: `models/${EMBEDDING_MODEL}`,
            content: { role: "user", parts: [{ text }] },
            outputDimensionality: 768,
          } as any)),
        });

        for (let j = 0; j < batch.length; j++) {
          const embedding = response.embeddings[j]?.values;
          if (!embedding || embedding.length !== 768) {
            console.warn(
              `[NotesChunker] Bad embedding for chunk ${batch[j].id}, skipping`
            );
            continue;
          }
          results.push({ ...batch[j], embedding });
        }
      } catch (error) {
        console.error(
          `[NotesChunker] Embedding batch ${i}-${i + batch.length} failed:`,
          error
        );
        // Continue with remaining batches rather than aborting
      }

      // Brief pause between batches to respect rate limits
      if (i + EMBED_BATCH_SIZE < chunks.length) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    return results;
  }

  // ─── Postgres Upsert ──────────────────────────────────────────────────────

  /**
   * Upserts an array of EmbeddedChunks into the `knowledge_chunks` table.
   * Uses ON CONFLICT (id) DO UPDATE so re-ingestion is safe.
   */
  private async upsertChunks(chunks: EmbeddedChunk[]): Promise<number> {
    if (chunks.length === 0) return 0;

    const client = await this.pool.connect();
    let upserted = 0;

    try {
      await client.query("BEGIN");

      const upsertSQL = `
        INSERT INTO knowledge_chunks (id, section, topics, content, source_tags, source_file, embedding)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (id) DO UPDATE SET
          section     = EXCLUDED.section,
          topics      = EXCLUDED.topics,
          content     = EXCLUDED.content,
          source_tags = EXCLUDED.source_tags,
          source_file = EXCLUDED.source_file,
          embedding   = EXCLUDED.embedding,
          updated_at  = NOW()
      `;

      for (const chunk of chunks) {
        // pgvector expects the embedding as a string "[0.1, 0.2, ...]"
        const embeddingStr = `[${chunk.embedding.join(",")}]`;

        await client.query(upsertSQL, [
          chunk.id,
          chunk.section,
          chunk.topics,
          chunk.content,
          chunk.sourceTags,
          chunk.sourceFile,
          embeddingStr,
        ]);
        upserted++;
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("[NotesChunker] Upsert transaction failed:", error);
      throw error;
    } finally {
      client.release();
    }

    return upserted;
  }
}
