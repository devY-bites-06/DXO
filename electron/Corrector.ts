// electron/Corrector.ts
// ──────────────────────────────────────────────────────────────────────────────
// Corrector: Reformulates technical search queries when the retriever returns
// low-relevance results. Utilises Gemini for search expansion/rewrite.
// ──────────────────────────────────────────────────────────────────────────────

import fs from "node:fs";
import path from "node:path";
import { GoogleGenerativeAI } from "@google/generative-ai";
import type { RetrievalResult, CragDeps } from "./types/crag";

export class Corrector {
  private genAI: GoogleGenerativeAI;
  private model: any;
  private correctPromptTemplate: string = "";

  constructor(private deps: CragDeps) {
    this.genAI = new GoogleGenerativeAI(deps.geminiApiKey);
    // Use gemini-3-flash-preview for quick re-phrasing
    this.model = this.genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });
    this.loadCorrectPrompt();
  }

  /**
   * Loads the CRAG_CORRECT_PROMPT from prompt.md.
   */
  private loadCorrectPrompt(): void {
    try {
      const promptFilePath = path.join(__dirname, "..", "prompt.md");
      const promptFileContent = fs.readFileSync(promptFilePath, "utf8");

      const sections: Record<string, string> = {};
      const parts = promptFileContent.split(/^===(\w+)===$/m);

      for (let i = 1; i < parts.length; i += 2) {
        sections[parts[i]] = parts[i + 1].trim();
      }

      this.correctPromptTemplate = sections["CRAG_CORRECT_PROMPT"] || "";
    } catch (error) {
      console.error("[Corrector] Error loading correct prompt template:", error);
    }
  }

  /**
   * Rewrites/reformulates a query to improve retrieval hits.
   */
  public async rewriteQuery(query: string, failedChunks: RetrievalResult[]): Promise<string> {
    let prompt = this.correctPromptTemplate;

    if (!prompt) {
      prompt = `The following query was used to search a knowledge base about system design topics. The retrieved results were not relevant enough.

Original query: {{ORIGINAL_QUERY}}
Retrieved chunks (low relevance): {{FAILED_CHUNKS}}

Reformulate the query to better match the knowledge base content. Consider:
1. Using more specific technical terminology
2. Breaking the question into sub-components
3. Using alternative phrasings for the same concept

Return ONLY the reformulated query string. No JSON. No explanation.`;
    }

    // Format the failed chunks list
    const failedText = failedChunks
      .map((c, i) => `[Chunk ${i + 1}] Section: ${c.section} (Score: ${c.hybridScore.toFixed(2)})\nContent Excerpt: ${c.content.slice(0, 150)}...`)
      .join("\n\n");

    // Replace placeholders
    const formattedPrompt = prompt
      .replace("{{ORIGINAL_QUERY}}", query)
      .replace("{{FAILED_CHUNKS}}", failedText || "No chunks retrieved.");

    try {
      console.log(`[Corrector] Reformulating search query for better precision...`);
      const result = await this.model.generateContent(formattedPrompt);
      const rewritten = result.response.text().trim();

      // Clean up any enclosing quotes or formatting that the LLM might have output
      const cleaned = rewritten
        .replace(/^["'`](.*)["'`]$/, "$1") // strip outer quotes
        .trim();

      console.log(`[Corrector] Reformulated query: "${query}" → "${cleaned}"`);
      return cleaned || query;
    } catch (err) {
      console.error("[Corrector] Failed to rewrite search query. Using original query.", err);
      return query;
    }
  }
}
