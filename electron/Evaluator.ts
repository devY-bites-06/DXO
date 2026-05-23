// electron/Evaluator.ts
// ──────────────────────────────────────────────────────────────────────────────
// Evaluator: Scores retrieved context chunks for actual relevance to the user's
// query using a batched Gemini mini-call.
// ──────────────────────────────────────────────────────────────────────────────

import fs from "node:fs";
import path from "node:path";
import { GoogleGenerativeAI } from "@google/generative-ai";
import type { RetrievalResult, EvaluationResult, CragDeps } from "./types/crag";

export class Evaluator {
  private genAI: GoogleGenerativeAI;
  private model: any;
  private evaluatePromptTemplate: string = "";

  constructor(private deps: CragDeps) {
    this.genAI = new GoogleGenerativeAI(deps.geminiApiKey);
    // Use gemini-3-flash-preview for fast evaluation
    this.model = this.genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });
    this.loadEvaluatePrompt();
  }

  /**
   * Loads the CRAG_EVALUATE_PROMPT from prompt.md.
   */
  private loadEvaluatePrompt(): void {
    try {
      const promptFilePath = path.join(__dirname, "..", "prompt.md");
      const promptFileContent = fs.readFileSync(promptFilePath, "utf8");

      const sections: Record<string, string> = {};
      const parts = promptFileContent.split(/^===(\w+)===$/m);

      for (let i = 1; i < parts.length; i += 2) {
        sections[parts[i]] = parts[i + 1].trim();
      }

      this.evaluatePromptTemplate = sections["CRAG_EVALUATE_PROMPT"] || "";
    } catch (error) {
      console.error("[Evaluator] Error loading evaluate prompt template:", error);
    }
  }

  /**
   * Scores the relevance of each retrieved chunk using Gemini in a single batched call.
   */
  public async evaluateChunks(query: string, chunks: RetrievalResult[]): Promise<EvaluationResult[]> {
    if (chunks.length === 0) return [];

    let prompt = this.evaluatePromptTemplate;

    // If template load failed, fallback to a robust embedded default prompt
    if (!prompt) {
      prompt = `You are a relevance evaluator. Given a user's interview question and a set of retrieved knowledge chunks, score each chunk's relevance to answering the question.

Question: {{QUERY}}

Chunks:
{{CHUNKS}}

For each chunk, rate relevance 1-5:
  1 = Completely irrelevant to the question
  2 = Tangentially related (same broad topic but doesn't help answer)
  3 = Somewhat relevant (related concepts but not directly answering)
  4 = Highly relevant (directly related concepts that inform the answer)
  5 = Directly answers or provides key information for the answer

Return ONLY valid JSON array:
[{"chunk_id": "chunk_X_Y", "score": N, "reason": "brief explanation"}]`;
    }

    // Format the chunks list
    const chunksText = chunks
      .map((c, i) => `[Chunk ${i + 1}] ID: ${c.id}\nSection: ${c.section}\nContent: ${c.content}`)
      .join("\n\n");

    // Replace placeholders
    const formattedPrompt = prompt
      .replace("{{QUERY}}", query)
      .replace("{{CHUNKS}}", chunksText);

    try {
      console.log(`[Evaluator] Batch evaluating ${chunks.length} chunks against query...`);
      const result = await this.model.generateContent(formattedPrompt);
      const rawText = result.response.text();
      const sanitized = this.sanitizeJsonResponse(rawText);
      const parsed = JSON.parse(sanitized);

      if (Array.isArray(parsed)) {
        return parsed.map((item: any) => ({
          chunkId: item.chunk_id || item.chunkId || "",
          relevanceScore: parseInt(item.score ?? item.relevanceScore ?? "1", 10),
          reason: item.reason || "",
        }));
      }

      // Handle cases where the model returns an object with evaluations key
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.evaluations)) {
        return parsed.evaluations.map((item: any) => ({
          chunkId: item.chunk_id || item.chunkId || "",
          relevanceScore: parseInt(item.score ?? item.relevanceScore ?? "1", 10),
          reason: item.reason || "",
        }));
      }

      throw new Error("Response is not a JSON array");
    } catch (err) {
      console.error("[Evaluator] Failed to evaluate chunks. Using similarity-based fallback scoring.", err);
      // Robust fallback scoring: translate hybrid/similarity score to 1-5
      return chunks.map((c) => {
        let score = 2; // default tangentially related
        if (c.hybridScore >= 0.6) {
          score = 5;
        } else if (c.hybridScore >= 0.4) {
          score = 4;
        } else if (c.hybridScore >= 0.2) {
          score = 3;
        }
        return {
          chunkId: c.id,
          relevanceScore: score,
          reason: `Fallback score derived from vector search score of ${c.hybridScore.toFixed(2)}.`,
        };
      });
    }
  }

  /**
   * Clean markdown tags off JSON block responses.
   */
  private sanitizeJsonResponse(raw: string): string {
    let cleaned = raw.trim();
    const fenceStart = /^```(?:json)?\s*\n?/i;
    const fenceEnd = /\n?```\s*$/;
    if (fenceStart.test(cleaned) && fenceEnd.test(cleaned)) {
      cleaned = cleaned.replace(fenceStart, "").replace(fenceEnd, "").trim();
    }
    return cleaned;
  }
}
