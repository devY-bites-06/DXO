// electron/database.ts
// ──────────────────────────────────────────────────────────────────────────────
// Global Postgres connection pool for the CRAG pipeline.
// Initialised once in main.ts via `initDatabase()` and shared across
// NotesChunker, Retriever, Evaluator, Corrector via the CragDeps object.
// ──────────────────────────────────────────────────────────────────────────────

import { Pool, PoolConfig } from "pg";
import fs from "node:fs";
import path from "node:path";
import type { PostgresConfig, CragConfig, CragDeps } from "./types/crag";
import { configHelper } from "./ConfigHelper";

let pool: Pool | null = null;

/**
 * Initialises (or re-initialises) the global Postgres connection pool.
 * Call this once at app startup inside `initializeApp()` in main.ts.
 *
 * Returns a `CragDeps` object that should be injected into
 * NotesChunker, Retriever, etc.
 */
export async function initDatabase(): Promise<CragDeps | null> {
  const config = configHelper.loadConfig() as any;
  const cragConfig: CragConfig | undefined = config.crag;

  if (!cragConfig?.enabled) {
    console.log("[Database] CRAG is disabled in config. Skipping Postgres init.");
    return null;
  }

  const pgCfg = cragConfig.postgres;
  if (!pgCfg?.host || !pgCfg?.database) {
    console.warn("[Database] Postgres config is incomplete. Skipping init.");
    return null;
  }

  // Tear down existing pool if re-initialising
  if (pool) {
    await pool.end().catch(() => {});
  }

  const poolConfig: PoolConfig = {
    host: pgCfg.host,
    port: pgCfg.port || 5432,
    user: pgCfg.user,
    password: pgCfg.password,
    database: pgCfg.database,
    max: pgCfg.maxPoolSize || 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  };

  pool = new Pool(poolConfig);

  // Verify connectivity
  try {
    const client = await pool.connect();
    const { rows } = await client.query("SELECT 1 AS ok");
    client.release();
    console.log("[Database] Postgres pool initialised. Connection verified.");
  } catch (err) {
    console.error("[Database] Failed to connect to Postgres:", err);
    pool = null;
    return null;
  }

  // Run schema migration if table doesn't exist
  try {
    await ensureSchema(pool);
  } catch (err) {
    console.error("[Database] Schema migration failed:", err);
  }

  return {
    pool,
    geminiApiKey: config.apiKey || "",
    cragConfig,
  };
}

/**
 * Returns the existing pool (or null if not initialised).
 */
export function getPool(): Pool | null {
  return pool;
}

/**
 * Gracefully closes the connection pool.
 * Call this in the Electron `before-quit` handler.
 */
export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    console.log("[Database] Postgres pool closed.");
  }
}

// ─── Schema Bootstrap ────────────────────────────────────────────────────────

/**
 * Runs `schema.sql` if the `knowledge_chunks` table doesn't exist yet.
 * This is a simple "apply-once" migration — not a full migration framework.
 */
async function ensureSchema(pool: Pool): Promise<void> {
  const { rows } = await pool.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_name = 'knowledge_chunks'
    ) AS table_exists
  `);

  if (rows[0]?.table_exists) {
    console.log("[Database] knowledge_chunks table already exists.");
    return;
  }

  console.log("[Database] Running schema.sql to create knowledge_chunks...");
  const schemaPath = path.join(__dirname, "schema.sql");

  let appPath = "";
  try {
    const { app } = require("electron");
    appPath = app.getAppPath();
  } catch {}

  // Fallback: try relative to the project root in dev mode
  const candidates = [
    schemaPath,
    path.join(__dirname, "..", "electron", "schema.sql"),
    path.join(process.cwd(), "electron", "schema.sql"),
  ];
  if (appPath) {
    candidates.push(path.join(appPath, "electron", "schema.sql"));
    candidates.push(path.join(appPath, "dist-electron", "schema.sql"));
  }

  let sql = "";
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      sql = fs.readFileSync(p, "utf-8");
      break;
    }
  }

  if (!sql) {
    throw new Error("[Database] schema.sql not found in any expected location.");
  }

  await pool.query(sql);
  console.log("[Database] Schema applied successfully.");
}
