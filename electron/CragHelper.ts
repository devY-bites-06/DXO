// electron/CragHelper.ts
// ──────────────────────────────────────────────────────────────────────────────
// CragHelper: Main orchestrator of the Corrective RAG pipeline.
// Coordinates NotesChunker, Retriever, Evaluator, and Corrector, and handles
// automatic ingestion checks and search result query caching.
// ──────────────────────────────────────────────────────────────────────────────

import { NotesChunker } from "./NotesChunker";
import { Retriever } from "./Retriever";
import { Evaluator } from "./Evaluator";
import { Corrector } from "./Corrector";
import type { RetrievalResult, CragDeps } from "./types/crag";

export interface CragQueryResult {
  chunks: RetrievalResult[];
  confidence: "HIGH" | "MEDIUM" | "LOW";
  queryRounds: string[];
  finalRelevanceScore: number;
}

export class CragHelper {
  private chunker: NotesChunker;
  private retriever: Retriever;
  private evaluator: Evaluator;
  private corrector: Corrector;

  // Simple in-memory query cache for rapid lookup
  private queryCache = new Map<string, CragQueryResult>();

  constructor(private deps: CragDeps) {
    this.chunker = new NotesChunker(deps);
    this.retriever = new Retriever(deps);
    this.evaluator = new Evaluator(deps);
    this.corrector = new Corrector(deps);
  }

  /**
   * Bootstraps the database: if `knowledge_chunks` is empty,
   * automatically triggers ingestion of the raw note files.
   * Safe to run on every app startup.
   */
  public async ingestIfNeeded(): Promise<number> {
    try {
      console.log("[CragHelper] Checking database status...");
      const { rows } = await this.deps.pool.query("SELECT COUNT(*) AS count FROM knowledge_chunks");
      const count = parseInt(rows[0]?.count || "0", 10);

      if (count === 0) {
        console.log("[CragHelper] Database is empty. Bootstrapping knowledge base from study notes...");
        const inserted = await this.chunker.ingestAll();
        console.log(`[CragHelper] Bootstrapping complete. ${inserted} chunks ingested.`);
        return inserted;
      }

      console.log(`[CragHelper] Database checks out. Ready with ${count} loaded chunks.`);
      return 0;
    } catch (err) {
      console.error("[CragHelper] Auto-ingestion check failed:", err);
      return 0;
    }
  }

  /**
   * Run the full CRAG search, evaluation, and correction pipeline.
   */
  public async retrieveAndCorrect(query: string): Promise<CragQueryResult> {
    const trimmed = query.trim();
    if (!trimmed) {
      return {
        chunks: [],
        confidence: "LOW",
        queryRounds: [query],
        finalRelevanceScore: 0,
      };
    }

    // Check query cache
    if (this.deps.cragConfig.enableQueryCache && this.queryCache.has(trimmed)) {
      console.log(`[CragHelper] Query cache hit for query: "${trimmed}"`);
      return this.queryCache.get(trimmed)!;
    }

    console.log(`[CragHelper] Processing query: "${trimmed}"`);
    const queryRounds: string[] = [trimmed];

    // Round 1: Hybrid Retrieval + Evaluation
    let currentQuery = trimmed;
    let chunks = await this.retriever.hybridSearch(currentQuery);
    let evaluations = await this.evaluator.evaluateChunks(currentQuery, chunks);

    let avgScore = this.computeAverageRelevance(evaluations);
    console.log(`[CragHelper] Round 1 average relevance: ${avgScore.toFixed(2)}/5.0`);

    const threshold = this.deps.cragConfig.evaluationThreshold || 3.5;
    let finalConfidence: "HIGH" | "MEDIUM" | "LOW" = "LOW";

    // Trigger Correction Loop if average score falls below threshold
    if (avgScore < threshold && this.deps.cragConfig.maxCorrectionRounds > 0) {
      console.log(`[CragHelper] Relevance is below threshold (${threshold}). Triggering query correction loop...`);
      
      let round = 1;
      let bestChunks = chunks;
      let bestEvaluations = evaluations;
      let bestScore = avgScore;

      while (round <= this.deps.cragConfig.maxCorrectionRounds && bestScore < threshold) {
        console.log(`[CragHelper] Correction round ${round}/${this.deps.cragConfig.maxCorrectionRounds}...`);

        // Ask the corrector to rephrase the query
        const rewrittenQuery = await this.corrector.rewriteQuery(trimmed, bestChunks);
        if (rewrittenQuery === currentQuery || rewrittenQuery === trimmed) {
          console.log("[CragHelper] Corrector returned identical query. Terminating loop.");
          break;
        }

        queryRounds.push(rewrittenQuery);
        currentQuery = rewrittenQuery;

        // Perform search and evaluation with rewritten query
        const newChunks = await this.retriever.hybridSearch(currentQuery);
        const newEvaluations = await this.evaluator.evaluateChunks(currentQuery, newChunks);
        const newScore = this.computeAverageRelevance(newEvaluations);

        console.log(`[CragHelper] Round ${round + 1} average relevance: ${newScore.toFixed(2)}/5.0`);

        // Keep the best set of results
        if (newScore > bestScore) {
          console.log(`[CragHelper] Chunks improved! Score rose from ${bestScore.toFixed(2)} to ${newScore.toFixed(2)}`);
          bestScore = newScore;
          bestChunks = newChunks;
          bestEvaluations = newEvaluations;
        } else {
          console.log(`[CragHelper] Chunks did not improve (New: ${newScore.toFixed(2)} vs Best: ${bestScore.toFixed(2)}).`);
        }

        round++;
      }

      chunks = bestChunks;
      evaluations = bestEvaluations;
      avgScore = bestScore;
    }

    // Determine final confidence level
    if (avgScore >= threshold) {
      finalConfidence = "HIGH";
    } else if (avgScore >= 2.0) {
      finalConfidence = "MEDIUM";
    } else {
      finalConfidence = "LOW";
    }

    // Map evaluation scores back to results for frontend metadata
    const evalMap = new Map(evaluations.map((e) => [e.chunkId, e.relevanceScore]));
    const finalChunks = chunks.map((c) => ({
      ...c,
      // Overwrite the similarity score visually with the actual grade out of 5 for clear UI display
      similarityScore: evalMap.get(c.id) ?? Math.round(c.hybridScore * 5),
    }));

    const finalResult: CragQueryResult = {
      chunks: finalChunks,
      confidence: finalConfidence,
      queryRounds,
      finalRelevanceScore: avgScore,
    };

    // Cache the result if enabled
    if (this.deps.cragConfig.enableQueryCache) {
      if (this.queryCache.size >= (this.deps.cragConfig.queryCacheSize || 50)) {
        const oldestKey = this.queryCache.keys().next().value;
        if (oldestKey !== undefined) this.queryCache.delete(oldestKey);
      }
      this.queryCache.set(trimmed, finalResult);
    }

    console.log(`[CragHelper] Done. Retrieved ${chunks.length} chunks. Confidence: ${finalConfidence}`);
    return finalResult;
  }

  /**
   * Helper to compute the average relevance of evaluated chunks.
   */
  private computeAverageRelevance(evals: any[]): number {
    if (evals.length === 0) return 0;
    const sum = evals.reduce((acc, curr) => acc + curr.relevanceScore, 0);
    return sum / evals.length;
  }

  public getChunker(): NotesChunker {
    return this.chunker;
  }
}
