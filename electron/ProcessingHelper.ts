import fs from "node:fs"
import path from "node:path"
import { ScreenshotHelper } from "./ScreenshotHelper"
import { IProcessingHelperDeps } from "./main"
import { app, BrowserWindow, dialog, clipboard } from "electron"
import { GoogleGenerativeAI } from "@google/generative-ai"
import { configHelper } from "./ConfigHelper"

export class ProcessingHelper {
  private deps: IProcessingHelperDeps
  private originalSolution: string | null = null
  private genAI: GoogleGenerativeAI | null = null
  private model: any = null
  private systemPrompt: string = ""
  private prompt: string = ""
  private debugPrompt: string = ""
  private cragQueryExtractPrompt: string = ""

  constructor(deps: IProcessingHelperDeps) {
    this.deps = deps
    this.initializeAIClient()
    this.loadPrompts()

    configHelper.on("config-updated", () => {
      this.initializeAIClient()
    })
  }

  private initializeAIClient(): void {
    try {
      const config = configHelper.loadConfig()
      if (config.apiKey) {
        this.genAI = new GoogleGenerativeAI(config.apiKey)
        this.model = this.genAI.getGenerativeModel({
          model: config.model || "gemini-3-flash-preview",
        })
        console.log("Gemini client initialized successfully")
      } else {
        this.genAI = null
        this.model = null
        console.warn("No API key available, Gemini client not initialized")
      }
    } catch (error) {
      console.error("Failed to initialize Gemini client:", error)
      this.genAI = null
      this.model = null
    }
  }

  private loadPrompts(): void {
    try {
      const candidates = [
        path.join(__dirname, "..", "prompt.md"),
        path.join(__dirname, "prompt.md"),
        path.join(process.cwd(), "prompt.md"),
      ]
      try {
        const { app } = require("electron")
        candidates.push(path.join(app.getAppPath(), "prompt.md"))
        candidates.push(path.join(app.getAppPath(), "dist-electron", "prompt.md"))
      } catch (e) {}

      let promptFileContent = ""
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          promptFileContent = fs.readFileSync(p, "utf8")
          break
        }
      }

      if (!promptFileContent) {
        throw new Error("prompt.md not found in any expected location.")
      }

      const sections: Record<string, string> = {}
      const parts = promptFileContent.split(/^===(\w+)===$/m)

      for (let i = 1; i < parts.length; i += 2) {
        sections[parts[i]] = parts[i + 1].trim()
      }

      this.systemPrompt = sections["SYSTEM_PROMPT"] || ""
      this.prompt = sections["INITIAL_PROMPT"] || ""
      this.debugPrompt = sections["DEBUG_PROMPT"] || ""
      this.cragQueryExtractPrompt = sections["CRAG_QUERY_EXTRACT_PROMPT"] || ""
    } catch (error) {
      console.error("Error loading prompts:", error)
    }
  }

  private buildImageParts(paths: string[]) {
    return paths.map((p) => ({
      inlineData: {
        mimeType: "image/png",
        data: fs.readFileSync(p).toString("base64"),
      },
    }))
  }

  /**
   * Strips markdown code fences (```json ... ```) from the response
   * so that JSON.parse doesn't choke on them.
   */
  private sanitizeJsonResponse(raw: string): string {
    let cleaned = raw.trim()
    // Remove leading ```json or ``` and trailing ```
    const fenceStart = /^```(?:json)?\s*\n?/i
    const fenceEnd = /\n?```\s*$/
    if (fenceStart.test(cleaned) && fenceEnd.test(cleaned)) {
      cleaned = cleaned.replace(fenceStart, "").replace(fenceEnd, "").trim()
    }
    return cleaned
  }

  public async getSolution(screenshotPaths: string[]): Promise<void> {
    const mainWindow = this.deps.getMainWindow()
    if (!mainWindow) return

    if (!this.model) {
      this.initializeAIClient()
      if (!this.model) {
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.API_KEY_INVALID
        )
        return
      }
    }

    mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.INITIAL_START)

    try {
      console.log("Sending request to Gemini...")
      const imageParts = this.buildImageParts(screenshotPaths)

      // Step 1: Extract technical question from screenshots if CRAG is enabled
      let extractedQuery = ""
      let contextText = ""
      let cragMeta: any = null

      const config = configHelper.loadConfig() as any
      const cragEnabled = config.crag?.enabled ?? true

      if (cragEnabled && this.deps.cragHelper && imageParts.length > 0) {
        try {
          console.time("crag-extraction")
          const extractPrompt = this.cragQueryExtractPrompt || "Look at the screenshot(s) provided. Extract ONLY the core technical question or topic being asked. Return a concise query string that captures the essence of what is being tested. Do not output any explanation or JSON. Return only the question text."
          
          const extractResult = await this.model.generateContent({
            contents: [
              {
                role: "user",
                parts: [
                  { text: extractPrompt },
                  ...imageParts
                ]
              }
            ]
          })
          extractedQuery = extractResult.response.text().trim()
          console.timeEnd("crag-extraction")
          console.log(`[ProcessingHelper] Extracted question: "${extractedQuery}"`)

          if (extractedQuery) {
            // Run CRAG retrieval
            const cragResult = await this.deps.cragHelper.retrieveAndCorrect(extractedQuery)
            cragMeta = {
              confidence: cragResult.confidence,
              queryRounds: cragResult.queryRounds,
              finalRelevanceScore: cragResult.finalRelevanceScore,
              chunks: cragResult.chunks.map(c => ({
                id: c.id,
                section: c.section,
                topics: c.topics,
                content: c.content,
                sourceFile: c.sourceFile
              }))
            }

            if (cragResult.chunks.length > 0) {
              const chunksFormatted = cragResult.chunks
                .map((c, i) => `[Section: ${c.section}]\n${c.content}`)
                .join("\n\n")

              contextText = `===KNOWLEDGE_CONTEXT===\nThe following context was retrieved from your study notes and is highly relevant to this question.\nUse this context to inform your answer.\n\n${chunksFormatted}\n\nConfidence: ${cragResult.confidence}\n===END_CONTEXT===`
            }
          }
        } catch (extractErr) {
          console.error("[ProcessingHelper] CRAG context retrieval failed, continuing standard flow.", extractErr)
        }
      }

      // Step 2: Generate the solution
      let promptText = this.prompt
      if (promptText.includes("{{KNOWLEDGE_CONTEXT}}")) {
        promptText = promptText.replace("{{KNOWLEDGE_CONTEXT}}", contextText)
      } else {
        promptText = contextText ? `${contextText}\n\n${promptText}` : promptText
      }

      console.time("gemini-initial")
      const result = await this.model.generateContent({
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `${this.systemPrompt}\n\n${promptText}\n\nReturn strictly valid JSON with a 'solution' field.`,
              },
              ...imageParts,
            ],
          },
        ],
      })

      const text = result.response.text()
      console.timeEnd("gemini-initial")

      if (!text) throw new Error("Empty response from Gemini")

      this.originalSolution = text
      const solutionData = JSON.parse(this.sanitizeJsonResponse(text))

      if (solutionData.solution) {
        clipboard.writeText(solutionData.solution)
      }

      // Inject CRAG metadata into response
      if (cragMeta) {
        solutionData.crag = cragMeta
      }

      mainWindow.webContents.send(
        this.deps.PROCESSING_EVENTS.SOLUTION_SUCCESS,
        {
          solution: solutionData,
          screenshots: screenshotPaths,
        }
      )
    } catch (error) {
      console.error("Error getting solution from Gemini:", error)
      mainWindow.webContents.send(
        this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
        {
          message: "Failed to get solution from Gemini.",
        }
      )
    }
  }

  public async getSolutionFromText(query: string): Promise<void> {
    const mainWindow = this.deps.getMainWindow()
    if (!mainWindow) return

    if (!this.model) {
      this.initializeAIClient()
      if (!this.model) {
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.API_KEY_INVALID
        )
        return
      }
    }

    mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.INITIAL_START)

    try {
      console.log(`[ProcessingHelper] Processing direct text query: "${query}"...`)
      let contextText = ""
      let cragMeta: any = null

      if (this.deps.cragHelper) {
        const cragResult = await this.deps.cragHelper.retrieveAndCorrect(query)
        cragMeta = {
          confidence: cragResult.confidence,
          queryRounds: cragResult.queryRounds,
          finalRelevanceScore: cragResult.finalRelevanceScore,
          chunks: cragResult.chunks.map(c => ({
            id: c.id,
            section: c.section,
            topics: c.topics,
            content: c.content,
            sourceFile: c.sourceFile
          }))
        }

        if (cragResult.chunks.length > 0) {
          const chunksFormatted = cragResult.chunks
            .map((c, i) => `[Section: ${c.section}]\n${c.content}`)
            .join("\n\n")

          contextText = `===KNOWLEDGE_CONTEXT===\nThe following context was retrieved from your study notes and is highly relevant to this question.\nUse this context to inform your answer.\n\n${chunksFormatted}\n\nConfidence: ${cragResult.confidence}\n===END_CONTEXT===`
        }
      }

      // Step 2: Generate the solution
      let promptText = this.prompt
      if (promptText.includes("{{KNOWLEDGE_CONTEXT}}")) {
        promptText = promptText.replace("{{KNOWLEDGE_CONTEXT}}", contextText)
      } else {
        promptText = contextText ? `${contextText}\n\n${promptText}` : promptText
      }

      const result = await this.model.generateContent({
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `${this.systemPrompt}\n\n${promptText}\n\nUser Question: "${query}"\n\nReturn strictly valid JSON with a 'solution' field.`,
              }
            ],
          },
        ],
      })

      const text = result.response.text()
      if (!text) throw new Error("Empty response from Gemini")

      this.originalSolution = text
      const solutionData = JSON.parse(this.sanitizeJsonResponse(text))

      if (solutionData.solution) {
        clipboard.writeText(solutionData.solution)
      }

      // Inject CRAG metadata
      if (cragMeta) {
        solutionData.crag = cragMeta
      }

      mainWindow.webContents.send(
        this.deps.PROCESSING_EVENTS.SOLUTION_SUCCESS,
        {
          solution: solutionData,
          screenshots: [],
        }
      )
    } catch (error) {
      console.error("Error solving text query:", error)
      mainWindow.webContents.send(
        this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
        {
          message: "Failed to solve technical query. Make sure your database and API keys are set up.",
        }
      )
    }
  }

  public async getDebugSolution(
    screenshotPaths: string[],
    debugScreenshotPaths: string[],
    originalSolution?: string
  ): Promise<void> {
    const mainWindow = this.deps.getMainWindow()
    if (!mainWindow) return

    const solutionToDebug = originalSolution || this.originalSolution

    if (!solutionToDebug) {
      mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.DEBUG_ERROR, {
        message: "No original solution available to debug.",
      })
      return
    }

    if (!this.model) {
      this.initializeAIClient()
      if (!this.model) {
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.API_KEY_INVALID
        )
        return
      }
    }

    mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.DEBUG_START)

    try {
      console.log("Sending debug request to Gemini...")
      console.time("gemini-debug")

      const prompt = this.debugPrompt.replace(
        "{{PREVIOUS_JSON_RESPONSE}}",
        solutionToDebug
      )

      const allPaths = [...screenshotPaths, ...debugScreenshotPaths]
      const imageParts = this.buildImageParts(allPaths)

      const result = await this.model.generateContent({
        contents: [
          {
            role: "user",
            parts: [
              {
                text:
                  this.systemPrompt +
                  "\n\n" +
                  prompt +
                  "\n\nReturn strictly valid JSON with a 'solution' field.",
              },
              ...imageParts,
            ],
          },
        ],
      })

      const text = result.response.text()
      console.timeEnd("gemini-debug")

      if (!text) throw new Error("Empty response from Gemini")

      const solutionData = JSON.parse(this.sanitizeJsonResponse(text))

      if (solutionData.solution) {
        clipboard.writeText(solutionData.solution)
      }

      mainWindow.webContents.send(
        this.deps.PROCESSING_EVENTS.DEBUG_SUCCESS,
        {
          solution: solutionData,
          originalSolution: JSON.parse(solutionToDebug),
          screenshots: screenshotPaths,
          debugScreenshots: debugScreenshotPaths,
        }
      )
    } catch (error) {
      console.error("Error getting debug solution from Gemini:", error)
      mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.DEBUG_ERROR, {
        message: "Failed to get debug solution from Gemini.",
      })
    }
  }

  public cancelOngoingRequests(): void {
    console.log("Cancellation not implemented.")
  }
}