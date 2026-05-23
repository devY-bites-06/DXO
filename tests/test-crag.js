// tests/test-crag.js
// ──────────────────────────────────────────────────────────────────────────────
// Integration test to verify PostgreSQL 18 connectivity, schema bootstrap,
// notes chunking & ingestion, and CRAG hybrid search pipelines.
//
// All configuration is read from the .env file in the project root.
// See tests/testmethod.md for setup instructions.
//
// Usage:
//   node tests/test-crag.js
// ──────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// Load .env from project root
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

async function run() {
  // ── Read all config from environment variables ──────────────────────────
  const host     = process.env.POSTGRES_HOST     || 'localhost';
  const port     = parseInt(process.env.POSTGRES_PORT || '5432', 10);
  const user     = process.env.POSTGRES_USER     || 'postgres';
  const password = process.env.POSTGRES_PASSWORD;
  const database = process.env.POSTGRES_DATABASE || 'crag_knowledge';

  if (!password) {
    console.error("❌ Error: POSTGRES_PASSWORD is not set in .env. See tests/testmethod.md.");
    process.exit(1);
  }

  // ── Read Gemini API Key with fallback to app config ─────────────────────
  const apiKey = process.env.GEMINI_API_KEY || (() => {
    const configDir = process.env.APPDATA || (process.platform === 'darwin'
      ? path.join(process.env.HOME, 'Library/Application Support')
      : path.join(process.env.HOME, '.config'));
    const configPath = path.join(configDir, 'interview-coder-v1', 'config.json');
    try {
      return fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')).apiKey : null;
    } catch {
      return null;
    }
  })();

  if (!apiKey) {
    console.error("❌ Error: No Gemini API Key found in .env or app settings.");
    process.exit(1);
  }

  // ── Print config summary ────────────────────────────────────────────────
  console.log(`\n🚀 Initialising CRAG Integration Test`);
  console.log(`=====================================`);
  console.log(`Database Host:     ${host}`);
  console.log(`Database Port:     ${port}`);
  console.log(`Database User:     ${user}`);
  console.log(`Target Database:   ${database}`);
  console.log(`Gemini API Key:    ${apiKey.slice(0, 5)}...${apiKey.slice(-4)}\n`);

  // ── Step 1: Create database if needed ───────────────────────────────────
  console.log("Step 1: Connecting to 'postgres' administrative database...");
  const adminPool = new Pool({ host, port, user, password, database: 'postgres' });
  try {
    const adminClient = await adminPool.connect();
    const dbCheck = await adminClient.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
    if (dbCheck.rows.length === 0) {
      console.log(`  -> Creating database '${database}'...`);
      await adminClient.query(`CREATE DATABASE ${database}`);
      console.log("  -> Database created successfully.");
    } else {
      console.log(`  -> Database '${database}' already exists.`);
    }
    adminClient.release();
  } catch (err) {
    console.error("❌ Connection to administrative database failed:", err.message);
    process.exit(1);
  } finally {
    await adminPool.end();
  }

  // ── Step 2: Verify pgvector extension ───────────────────────────────────
  console.log("\nStep 2: Connecting to target database...");
  const targetPool = new Pool({ host, port, user, password, database, max: 5 });

  try {
    const client = await targetPool.connect();
    console.log(`  -> Enabling pgvector extension...`);
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");

    const extCheck = await client.query("SELECT extname FROM pg_extension WHERE extname = 'vector'");
    if (extCheck.rows.length > 0) {
      console.log("  -> ✅ pgvector extension is enabled and verified.");
    } else {
      throw new Error("pgvector extension was not created successfully.");
    }
    client.release();
  } catch (err) {
    console.error("❌ pgvector verification failed:", err.message);
    console.log("\n💡 Make sure you copied the vector.dll to your PostgreSQL 18 'lib' folder");
    console.log("and SQL files to 'share/extension' folder as detailed in testmethod.md");
    process.exit(1);
  }

  // ── Step 3: Bootstrap schema ────────────────────────────────────────────
  console.log("\nStep 3: Bootstrapping database schema (schema.sql)...");
  try {
    const schemaSqlPath = path.join(__dirname, '..', 'electron', 'schema.sql');
    const schemaSql = fs.readFileSync(schemaSqlPath, 'utf8');
    await targetPool.query(schemaSql);
    console.log("  -> ✅ Database tables and HNSW/GIN indexes initialized.");
  } catch (err) {
    console.error("❌ Schema bootstrap failed:", err.message);
    process.exit(1);
  }

  // ── Step 4: Ingest knowledge notes ──────────────────────────────────────
  console.log("\nStep 4: Compiling and importing Notes Ingestion Engine...");

  const cragConfig = {
    enabled: true,
    topK: 5,
    minRelevanceThreshold: 0.15,
    evaluationThreshold: 3.5,
    maxCorrectionRounds: 2,
    retrievalAlpha: 0.3,
    notesPaths: ["knowledge/notes.txt", "knowledge/notes2.txt"],
    enableQueryCache: true,
    queryCacheSize: 50,
    postgres: { host, port, user, password, database, maxPoolSize: 5 }
  };

  const deps = {
    pool: targetPool,
    geminiApiKey: apiKey,
    cragConfig: cragConfig
  };

  try {
    const { NotesChunker } = require('../dist-electron/NotesChunker');
    const { Retriever }    = require('../dist-electron/Retriever');
    const { CragHelper }   = require('../dist-electron/CragHelper');

    console.log("  -> Instantiating NotesChunker...");
    const chunker = new NotesChunker(deps);

    console.log("  -> Ingesting knowledge notes (generating embeddings)...");
    console.time("ingestion-time");
    const count = await chunker.ingestAll();
    console.timeEnd("ingestion-time");
    console.log(`  -> ✅ Ingested and stored ${count} knowledge chunks inside Postgres.`);

    // ── Step 5: Hybrid Search ───────────────────────────────────────────
    console.log("\nStep 5: Testing hybrid search retrieval...");
    const retriever = new Retriever(deps);
    const searchQuery = "Explain sharding vs consistent hashing eviction cache";
    console.log(`  -> Query: "${searchQuery}"`);

    const results = await retriever.hybridSearch(searchQuery);
    console.log(`  -> Retrieved ${results.length} relevant chunks:`);
    results.forEach((c, i) => {
      console.log(`     [${i + 1}] Section: ${c.section} | File: ${c.sourceFile} | Hybrid Score: ${c.hybridScore.toFixed(3)}`);
      console.log(`         Snippet: "${c.content.slice(0, 100)}..."\n`);
    });

    if (results.length === 0) {
      throw new Error("Hybrid search returned 0 results — ingestion or search may be broken.");
    }

    // ── Step 6: Full CRAG pipeline ──────────────────────────────────────
    console.log("\nStep 6: Testing full CRAG pipeline (Search + Evaluation + Correction)...");
    const cragHelper = new CragHelper(deps);

    const cragQuery = "Explain CAP theorem and CAP trade-offs";
    console.log(`  -> Query: "${cragQuery}"`);
    console.time("crag-execution");
    const cragResult = await cragHelper.retrieveAndCorrect(cragQuery);
    console.timeEnd("crag-execution");

    console.log(`\n  -> CRAG Pipeline Result:`);
    console.log(`     - Confidence:           ${cragResult.confidence}`);
    console.log(`     - Search Rounds:        ${cragResult.queryRounds.join(" ➔ ")}`);
    console.log(`     - Average Relevance:   ${cragResult.finalRelevanceScore.toFixed(2)}/5.0`);
    console.log(`     - Chunks Selected:      ${cragResult.chunks.length}`);

    if (cragResult.chunks.length === 0) {
      throw new Error("CRAG pipeline returned 0 chunks — pipeline may be broken.");
    }

    console.log(`\n🎉 INTEGRATION TEST SUCCEEDED! All CRAG systems are fully functional.`);
  } catch (err) {
    console.error("❌ Integration test failed during execution:", err);
    process.exit(1);
  } finally {
    await targetPool.end();
  }
}

run();
