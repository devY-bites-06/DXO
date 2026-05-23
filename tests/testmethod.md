# CRAG Integration Test — Setup & Usage

## Prerequisites

1. **PostgreSQL 18** installed and running (any port).
2. **pgvector** extension installed (vector.dll in `lib/`, SQL files in `share/extension/`).
3. **Gemini API Key** with access to the `gemini-embedding-001` model.
4. **Knowledge notes** placed in the `knowledge/` folder at the project root:
   - `knowledge/notes.txt`
   - `knowledge/notes2.txt`
5. **TypeScript compiled**: Run `npx tsc -p tsconfig.electron.json` before running tests.

---

## Configuration

All test configuration is read from a single `.env` file in the project root.

### Step 1: Create `.env`

Copy the example and fill in your values:

```bash
cp .env.example .env
```

### Step 2: Edit `.env`

Open `.env` and set your credentials:

```env
# Gemini API Key
GEMINI_API_KEY=YOUR_GEMINI_API_KEY_HERE

# PostgreSQL Connection
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=postgres
POSTGRES_PASSWORD=YOUR_POSTGRES_PASSWORD_HERE
POSTGRES_DATABASE=crag_knowledge
```

> **Note:** The `.env` file is git-ignored and will never be committed.

---

## Running the Test

```bash
node tests/test-crag.js
```

That's it. No CLI arguments needed — everything is read from `.env`.

---

## What the Test Verifies

| Step | What it does |
|------|-------------|
| 1 | Connects to the `postgres` admin database, creates `crag_knowledge` if it doesn't exist |
| 2 | Connects to `crag_knowledge`, enables and verifies the `pgvector` extension |
| 3 | Runs `electron/schema.sql` to create the `knowledge_chunks` table with HNSW + GIN indexes |
| 4 | Ingests study notes from `knowledge/` folder — chunks text, generates Gemini embeddings, upserts into Postgres |
| 5 | Runs a hybrid search query (vector similarity + keyword FTS) and verifies results are returned |
| 6 | Runs the full Corrective RAG pipeline — retrieval → evaluation → correction loop — and verifies confidence |

---

## Expected Output (Success)

```
🚀 Initialising CRAG Integration Test
=====================================
Step 1: ✅ Database exists or created
Step 2: ✅ pgvector extension verified
Step 3: ✅ Schema bootstrapped
Step 4: ✅ 34 knowledge chunks ingested
Step 5: ✅ Hybrid search returned relevant chunks
Step 6: ✅ CRAG pipeline: Confidence HIGH

🎉 INTEGRATION TEST SUCCEEDED!
```

---

## Troubleshooting

| Error | Fix |
|-------|-----|
| `POSTGRES_PASSWORD is not set` | Add `POSTGRES_PASSWORD=yourpass` to `.env` |
| `No Gemini API Key found` | Add `GEMINI_API_KEY=yourkey` to `.env` |
| `pgvector verification failed` | Copy `vector.dll` to PostgreSQL's `lib/` folder and restart the service |
| `Schema bootstrap failed` | Check that `electron/schema.sql` exists and the DB user has CREATE TABLE permissions |
| `Cannot find module '../dist-electron/NotesChunker'` | Run `npx tsc -p tsconfig.electron.json` first |
| `Hybrid search returned 0 results` | Check that `knowledge/notes.txt` and `knowledge/notes2.txt` exist and are not empty |
