// ConfigHelper.ts
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { EventEmitter } from "events";
import { GoogleGenerativeAI } from "@google/generative-ai";
import type { CragConfig } from "./types/crag";

interface Config {
  apiKey: string;
  model: string;
  opacity: number;
  crag?: CragConfig;
}

export class ConfigHelper extends EventEmitter {
  private configPath: string;
  private defaultConfig: Config = {
    apiKey: "",
    model: "gemini-3-flash-preview",
    // model: "gemini-3.1-pro-preview",
    opacity: 1.0,
    crag: {
      enabled: true,
      topK: 5,
      minRelevanceThreshold: 0.15,
      evaluationThreshold: 3.5,
      maxCorrectionRounds: 2,
      retrievalAlpha: 0.3,
      notesPaths: ["knowledge/notes.txt", "knowledge/notes2.txt"],
      enableQueryCache: true,
      queryCacheSize: 50,
      postgres: {
        host: "localhost",
        port: 5432,
        user: "postgres",
        password: "postgres",
        database: "crag_knowledge",
        maxPoolSize: 5,
      },
    },
  };

  constructor() {
    super();
    // Use the app's user data directory to store the config
    try {
      this.configPath = path.join(app.getPath("userData"), "config.json");
      console.log("Config path:", this.configPath);
    } catch (err) {
      console.warn("Could not access user data path, using fallback");
      this.configPath = path.join(process.cwd(), "config.json");
    }

    // Ensure the initial config file exists
    this.ensureConfigExists();
  }

  /**
   * Ensure config file exists
   */
  private ensureConfigExists(): void {
    try {
      if (!fs.existsSync(this.configPath)) {
        this.saveConfig(this.defaultConfig);
      }
    } catch (err) {
      console.error("Error ensuring config exists:", err);
    }
  }

  public loadConfig(): Config {
    try {
      let loaded: Config = this.defaultConfig;
      if (fs.existsSync(this.configPath)) {
        const configData = fs.readFileSync(this.configPath, "utf8");
        const config = JSON.parse(configData);

        // Migrate old OpenAI models to Gemini
        if (config.model && (config.model.toLowerCase().includes("gpt") || config.model.toLowerCase().startsWith("o"))) {
          config.model = this.defaultConfig.model;
          this.saveConfig({ ...this.defaultConfig, ...config });
        }

        loaded = {
          ...this.defaultConfig,
          ...config,
          crag: {
            ...this.defaultConfig.crag,
            ...config.crag,
            postgres: {
              ...this.defaultConfig.crag?.postgres,
              ...(config.crag?.postgres || {}),
            },
          },
        } as Config;
      } else {
        // If no config exists, create a default one
        this.saveConfig(this.defaultConfig);
      }

      // Layer environment variables on top for developer convenience / local deployment override
      loaded.apiKey = process.env.GEMINI_API_KEY || loaded.apiKey;

      if (loaded.crag?.postgres) {
        const pg = loaded.crag.postgres;
        pg.host = process.env.POSTGRES_HOST || pg.host;
        pg.port = process.env.POSTGRES_PORT ? parseInt(process.env.POSTGRES_PORT, 10) : pg.port;
        pg.user = process.env.POSTGRES_USER || pg.user;
        pg.password = process.env.POSTGRES_PASSWORD || pg.password;
        pg.database = process.env.POSTGRES_DATABASE || pg.database;
      }

      return loaded;
    } catch (err) {
      console.error("Error loading config:", err);
      return this.defaultConfig;
    }
  }

  /**
   * Save configuration to disk
   */
  public saveConfig(config: Config): void {
    try {
      // Ensure the directory exists
      const configDir = path.dirname(this.configPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      // Write the config file
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
    } catch (err) {
      console.error("Error saving config:", err);
    }
  }

  /**
   * Update specific configuration values
   */
  public updateConfig(updates: Partial<Config>): Config {
    try {
      const currentConfig = this.loadConfig();
      const newConfig = { ...currentConfig, ...updates };
      this.saveConfig(newConfig);

      // Only emit update event for changes other than opacity
      // This prevents re-initializing the AI client when only opacity changes
      if (
        updates.apiKey !== undefined ||
        updates.model !== undefined
      ) {
        this.emit("config-updated", newConfig);
      }

      return newConfig;
    } catch (error) {
      console.error("Error updating config:", error);
      return this.defaultConfig;
    }
  }

  /**
   * Check if the API key is configured
   */
  public hasApiKey(): boolean {
    const config = this.loadConfig();
    return !!config.apiKey && config.apiKey.trim().length > 0;
  }

  /**
   * Validate the API key format (Gemini API keys typically start with 'AI' and are 39 characters)
   */
  public isValidApiKeyFormat(apiKey: string): boolean {
    const trimmedKey = apiKey.trim();
    // Gemini API keys are typically 39 characters and start with 'AI'
    return trimmedKey.length >= 30;
  }

  public getOpacity(): number {
    return this.loadConfig().opacity;
  }

  public setOpacity(opacity: number): void {
    this.updateConfig({ opacity });
  }

  public async testApiKey(
    apiKey: string
  ): Promise<{ valid: boolean; error?: string }> {
    if (!this.isValidApiKeyFormat(apiKey)) {
      return { valid: false, error: "Invalid API key format. Please enter a valid Gemini API key." };
    }
    return this.testGeminiKey(apiKey);
  }

  private async testGeminiKey(
    apiKey: string
  ): Promise<{ valid: boolean; error?: string }> {
    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });
      // Make a simple test request to validate the key
      await model.generateContent("Hello");
      return { valid: true };
    } catch (error: any) {
      console.error("Error testing Gemini key:", error);
      if (error.status === 401 || error.message?.includes("API key")) {
        return { valid: false, error: "The provided API key is not valid." };
      } else if (error.status === 403) {
        return {
          valid: false,
          error: "API key lacks necessary permissions.",
        };
      }
      return {
        valid: false,
        error: "Failed to validate API key. Check console for details.",
      };
    }
  }
}

// Export a singleton instance
export const configHelper = new ConfigHelper();
