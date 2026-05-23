# CRAG System Implementation Plan — dto2

## Overview

This document outlines the full architecture and implementation plan for a **Corrective Retrieval-Augmented Generation (CRAG)** system built into the dto2 Electron app. The system uses `notes.txt` as a curated knowledge base and **Gemini 3 Flash** as the generative backbone. The goal: provide contextually accurate, knowledge-grounded answers to technical interview questions — particularly System Design, DSA theory, and distributed systems concepts — by retrieving the most relevant context from notes before generating a response, and *correcting* retrieval when confidence is low.

---

## What is CRAG?

CRAG (Corrective Retrieval-Augmented Generation) is an advanced RAG pattern that adds a **self-correction loop** on top of standard retrieval:

```
User Query
    │
    ▼
┌──────────────────┐
│  1. RETRIEVER     │  ← Finds top-K relevant chunks from notes.txt
│     (Semantic +   │
│      Keyword)     │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  2. EVALUATOR     │  ← Scores relevance of each retrieved chunk
│     (Confidence   │     against the user query
│      Scoring)     │
└────────┬─────────┘
         │
    ┌────┴────┐
    │         │
 CORRECT   INCORRECT / AMBIGUOUS
    │         │
    │         ▼
    │    ┌──────────────────┐
    │    │  3. CORRECTOR     │  ← Reformulates query, retries retrieval,
    │    │     (Query        │     or falls back to web/broader knowledge
    │    │      Rewrite +   │
    │    │      Re-retrieve)│
    │    └────────┬─────────┘
    │             │
    └──────┬──────┘
           │
           ▼
┌──────────────────┐
│  4. GENERATOR     │  ← Gemini 3 Flash produces final answer
│     (Gemini 3     │     grounded in validated context
│      Flash)       │
└──────────────────┘
```

### Why CRAG over plain RAG?

| Problem with Plain RAG | CRAG Solution |
|---|---|
| Retriever returns irrelevant chunks → hallucinated answer | Evaluator catches bad retrievals before generation |
| Single query phrasing may miss relevant content | Corrector rewrites the query and re-retrieves |
| No confidence signal to the user | Confidence score exposed in UI |
| Blind trust in retrieved context | Only validated chunks reach the generator |

---

## Architecture

### System Components

```
┌─────────────────────────────────────────────────────────┐
│                    ELECTRON MAIN PROCESS                 │
│                                                          │
│  ┌─────────────────┐    ┌──────────────────────────┐    │
│  │  ConfigHelper    │    │    CragHelper (NEW)       │    │
│  │  (API Key, Model)│    │                           │    │
│  └────────┬────────┘    │  ┌──────────────────────┐ │    │
│           │              │  │  NotesChunker         │ │    │
│           │              │  │  - Parses notes.txt   │ │    │
│           │              │  │  - Splits into chunks │ │    │
│           │              │  │  - Maintains metadata │ │    │
│           │              │  └──────────┬───────────┘ │    │
│           │              │             │              │    │
│           │              │  ┌──────────▼───────────┐ │    │
│           │              │  │  Retriever            │ │    │
│           │              │  │  - TF-IDF keyword     │ │    │
│           │              │  │  - Semantic similarity│ │    │
│           │              │  │  - Hybrid scoring     │ │    │
│           │              │  └──────────┬───────────┘ │    │
│           │              │             │              │    │
│           │              │  ┌──────────▼───────────┐ │    │
│           │              │  │  Evaluator            │ │    │
│           │              │  │  - Gemini mini-call   │ │    │
│           │              │  │  - Relevance scoring  │ │    │
│           │              │  │  - Confidence gating  │ │    │
│           │              │  └──────────┬───────────┘ │    │
│           │              │             │              │    │
│           │              │  ┌──────────▼───────────┐ │    │
│           │              │  │  Corrector            │ │    │
│           │              │  │  - Query rewriting    │ │    │
│           │              │  │  - Re-retrieval       │ │    │
│           │              │  │  - Context refinement │ │    │
│           │              │  └──────────┬───────────┘ │    │
│           │              │             │              │    │
│           │              │  ┌──────────▼───────────┐ │    │
│           │              │  │  Generator            │ │    │
│           │              │  │  - Gemini 3 Flash     │ │    │
│           │              │  │  - Grounded generation│ │    │
│           │              │  └──────────────────────┘ │    │
│           │              └──────────────────────────┘    │
│           │                                              │
│  ┌────────▼────────┐    ┌──────────────────────────┐    │
│  │ ProcessingHelper │    │    ScreenshotHelper       │    │
│  │ (Existing - uses │    │    (Existing)              │    │
│  │  CragHelper now) │    │                           │    │
│  └─────────────────┘    └──────────────────────────┘    │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

---

## Phase 1: Notes Chunking Engine

### File: `electron/NotesChunker.ts` (NEW)

The notes.txt file is ~27KB with 332 lines covering 6 major topic sections separated by `---` delimiters. Each section covers a distinct system design topic.

#### Chunking Strategy

```
notes.txt (27KB, 332 lines)
     │
     ▼ Split by "---" delimiter
     │
┌────┴────────────────────────────────────────────────┐
│ Section 1: Load Balancing & Consistent Hashing       │ Lines 1-24
│ Section 2: Caching & Optimization Techniques         │ Lines 26-107
│ Section 3: Caching System Design (Deep Dive)         │ Lines 111-154
│ Section 4: Caching in Software Systems               │ Lines 158-203
│ Section 5: Distributed Systems & Newsfeed            │ Lines 207-253
│ Section 6: CAP Theorem & Database Consistency        │ Lines 257-288
│ Section 7: Data Sharding                             │ Lines 292-331
└─────────────────────────────────────────────────────┘
     │
     ▼ Further split into semantic sub-chunks (~200-400 tokens each)
     │
     ▼ Each chunk gets metadata:
       {
         id: "chunk_3_2",
         section: "Caching System Design",
         topics: ["LRU", "eviction", "invalidation", "local cache", "global cache"],
         lineRange: [130, 154],
         tokenCount: 320,
         text: "..."
       }
```

#### Chunking Rules

1. **Primary split**: By `---` delimiters (section boundaries)
2. **Secondary split**: Within sections, split by numbered headings (e.g., "1.", "2.", "3.") or blank-line-separated paragraphs
3. **Chunk size target**: 200-400 tokens per chunk (sweet spot for Gemini context relevance)
4. **Overlap**: 1-2 sentences of overlap between adjacent sub-chunks to preserve context continuity
5. **Metadata extraction**: Auto-extract topic keywords from each chunk for keyword-based retrieval

---

## Phase 2: Retriever (pgvector + Postgres FTS)

### File: `electron/Retriever.ts` (NEW)

**Hybrid retrieval combining pgvector cosine similarity + Postgres full-text search.**

Storage and retrieval are delegated entirely to PostgreSQL with the `pgvector` extension. No local JSON files or in-memory vector math.

#### Approach A: Semantic Search (pgvector cosine)
- Query is embedded using Gemini `text-embedding-004` (768 dimensions)
- Single SQL query against the `knowledge_chunks` table using the `<=>` cosine distance operator
- HNSW index provides sub-millisecond approximate nearest-neighbour lookup

#### Approach B: Keyword Search (Postgres Full-Text Search)
- `content_tsv` column (auto-generated `TSVECTOR`) indexed with GIN
- Query is converted to a `tsquery` with OR-joined terms
- `ts_rank_cd()` provides BM25-like relevance scoring

#### Hybrid Scoring (Single SQL CTE)
```sql
hybrid_score = α × normalised_fts_rank + (1-α) × cosine_similarity
```
Where `α = 0.3` (favor semantic understanding, fall back to keywords for exact term matches).
Both scores are computed in a single database round-trip using a CTE.

#### Retrieval Parameters
- **Top-K**: Return top 5 chunks
- **Minimum threshold**: hybrid_score must be > 0.15 to be included
- **Deduplication**: Handled by Postgres — each chunk is a unique row

---

## Phase 3: Evaluator (The "Corrective" Part)

### File: `electron/Evaluator.ts` (NEW)

The evaluator is what makes this CRAG and not just RAG. After retrieval, each chunk is scored for actual relevance to the query.

#### Evaluation Strategy

Use a lightweight Gemini call to score relevance:

```
PROMPT TO EVALUATOR:
"Given this user question: '{query}'
And this retrieved context chunk: '{chunk_text}'
Rate the relevance on a scale of 1-5:
  1 = Completely irrelevant
  2 = Tangentially related
  3 = Somewhat relevant
  4 = Highly relevant  
  5 = Directly answers the question
Return ONLY a JSON: {"score": N, "reason": "brief explanation"}"
```

#### Decision Logic

```
Average score of top-K chunks:
  ≥ 3.5  → CORRECT   → Proceed to Generator with these chunks
  2.0-3.5 → AMBIGUOUS → Trigger Corrector (query rewrite + re-retrieve)
  < 2.0  → INCORRECT → Trigger Corrector with broader strategy / fall back to pure Gemini
```

#### Optimization: Batch Evaluation
Instead of K separate API calls, batch all chunks into a single evaluation prompt:
```
"Evaluate the relevance of each context chunk to the question.
Question: '{query}'
Chunk 1: '{chunk_1}'
Chunk 2: '{chunk_2}'
...
Return JSON array: [{"chunk": 1, "score": N}, ...]"
```
This reduces API calls from K to 1.

---

## Phase 4: Corrector

### File: `electron/Corrector.ts` (NEW)

When the evaluator flags low confidence, the corrector kicks in.

#### Correction Strategies

1. **Query Decomposition**: Break complex questions into sub-questions
   - "Explain sharding with consistent hashing for a chat app" →
     - "What is data sharding?"
     - "How does consistent hashing work?"
     - "How to design a chat app database?"

2. **Query Expansion**: Add related terms
   - "CAP theorem" → "CAP theorem consistency availability partition tolerance distributed systems"

3. **Query Reformulation**: Rephrase using Gemini
   - Send original query + failed chunks to Gemini
   - Ask: "The retrieved context was not relevant. Reformulate this question to better match a knowledge base about system design topics"

4. **Re-Retrieval**: Run the retriever again with corrected query

5. **Fallback**: If re-retrieval still scores low, proceed with:
   - Whatever chunks scored best (even if below threshold)
   - Flag the response with `confidence: "low"` so the UI can show a warning

#### Max Correction Rounds: 2
(To prevent infinite loops and keep latency reasonable)

---

## Phase 5: Generator

### Modification: `electron/ProcessingHelper.ts` (MODIFIED)

The existing ProcessingHelper already handles Gemini calls. We modify it to:

1. Accept retrieved + validated context chunks alongside screenshot data
2. Inject context into the prompt before the screenshot analysis
3. Add confidence metadata to the response

#### Context Injection Format

```
===KNOWLEDGE_CONTEXT===
The following context was retrieved from your study notes and is relevant to this question.
Use this context to inform your answer. If the context contradicts what you see in the screenshot,
prioritize the screenshot (it's the actual question being asked).

[Section: Load Balancing & Consistent Hashing]
{chunk text here}

[Section: Caching System Design]  
{chunk text here}

Confidence: HIGH | MEDIUM | LOW
===END_CONTEXT===

{existing system prompt + initial prompt}
```

---

## Phase 6: Integration with Existing App

### Files Modified

| File | Change | Status |
|---|---|---|
| `electron/ProcessingHelper.ts` | Import CragHelper, call retrieval pipeline before `generateContent()`, inject context into prompt | ⏳ Pending |
| `electron/main.ts` | Initialize CragHelper alongside other helpers, pass it to ProcessingHelper | ⏳ Pending |
| `electron/ipcHandlers.ts` | Add IPC handler for manual CRAG queries (if user types a question instead of screenshot) | ⏳ Pending |
| `electron/preload.ts` | Expose CRAG-related IPC channels to renderer | ⏳ Pending |
| `src/App.tsx` | Add text input mode for direct system design questions | ⏳ Pending |
| `prompt.md` | Add CRAG context injection section to system and initial prompts | ✅ Done |

### Files Created

| File | Purpose | Status |
|---|---|---|
| `electron/schema.sql` | Postgres schema: pgvector extension, knowledge_chunks table, HNSW + GIN indexes | ✅ Done |
| `electron/database.ts` | Global Postgres connection pool, auto-migration on first launch | ✅ Done |
| `electron/types/crag.ts` | TypeScript interfaces for CRAG pipeline (KnowledgeChunk, RetrievalResult, CragDeps, etc.) | ✅ Done |
| `electron/NotesChunker.ts` | Parse + chunk notes files, generate Gemini embeddings, upsert into Postgres | ✅ Done |
| `electron/Retriever.ts` | pgvector cosine + Postgres FTS hybrid retrieval | ✅ Done |
| `electron/Evaluator.ts` | Score retrieved chunks for relevance | ⏳ Pending |
| `electron/Corrector.ts` | Query rewrite + re-retrieval on low confidence | ⏳ Pending |
| `electron/CragHelper.ts` | Orchestrator that ties Chunker → Retriever → Evaluator → Corrector → output | ⏳ Pending |

---

## Data Flow: End-to-End

```
1. User captures screenshot of interview question (existing flow)
      │
      ▼
2. ProcessingHelper receives screenshot paths
      │
      ▼
3. [NEW] Extract question text from screenshot via Gemini
   (Quick call: "What is the question being asked in this screenshot? Return only the question text.")
      │
      ▼
4. [NEW] CragHelper.retrieve(questionText)
      │
      ├── NotesChunker.getChunks()  ← Cached after first load
      ├── Retriever.search(query, chunks) → top-5 chunks
      ├── Evaluator.score(query, top5) → scored chunks
      │     │
      │     ├── Score ≥ 3.5 → Use chunks directly
      │     └── Score < 3.5 → Corrector.correct(query) → re-retrieve → re-evaluate
      │
      ▼
5. [NEW] Merge validated context into the generation prompt
      │
      ▼
6. Gemini 3 Flash generates solution (existing flow, now with context)
      │
      ▼
7. Response includes:
   - solution (code/MCQ answer/LLD design)
   - confidence level (HIGH/MEDIUM/LOW)
   - source sections referenced
      │
      ▼
8. UI displays solution with confidence badge and source citations
```

---

## Performance Budget

| Step | Target Latency | Strategy |
|---|---|---|
| Notes ingestion | ~5-10s (one-time at startup) | Batch embed + Postgres upsert. Skipped if already ingested. |
| Hybrid retrieval (Postgres) | ~20-50ms | Single SQL CTE: pgvector HNSW + GIN FTS in one round-trip |
| Query embedding (Gemini) | ~200ms | Single Gemini `text-embedding-004` call |
| Evaluation | ~500ms | Single batched Gemini call |
| Correction (if needed) | ~800ms | Query rewrite + re-embed + re-query Postgres |
| Generation | ~2-4s | Existing Gemini generation time |
| **Total (happy path)** | **~3-5s** | |
| **Total (with correction)** | **~4-6s** | |

---

## Storage Strategy (pgvector)

1. **Chunk + Embedding storage**: All chunks and their 768-dim embeddings live in the `knowledge_chunks` Postgres table. No local JSON files.
2. **Upsert safety**: `NotesChunker.ingestAll()` uses `ON CONFLICT (id) DO UPDATE`, so re-ingestion is idempotent.
3. **Full-text index**: `content_tsv` column is auto-generated (`GENERATED ALWAYS AS`) and indexed with GIN for keyword search.
4. **Semantic index**: HNSW index on the `embedding` column for fast approximate cosine search.
5. **Query cache**: In-memory LRU cache of recent queries → results (optional, configured via `enableQueryCache`).
6. **Re-ingestion trigger**: If notes files are modified, call `chunker.deleteBySourceFile()` then `chunker.ingestAll()` to refresh.

---

## Configuration Additions

Add to `config.json` (via ConfigHelper):

```json
{
  "apiKey": "...",
  "model": "gemini-3-flash-preview",
  "opacity": 1.0,
  "crag": {
    "enabled": true,
    "topK": 5,
    "minRelevanceThreshold": 0.15,
    "evaluationThreshold": 3.5,
    "maxCorrectionRounds": 2,
    "retrievalAlpha": 0.3,
    "notesPaths": ["notes.txt", "notes2.txt"],
    "enableQueryCache": true,
    "queryCacheSize": 50,
    "postgres": {
      "host": "localhost",
      "port": 5432,
      "user": "crag_user",
      "password": "your_password_here",
      "database": "crag_knowledge",
      "maxPoolSize": 5
    }
  }
}
```

---

## Implementation Order

### Sprint 1: Foundation (Core CRAG Pipeline)
1. `[x] electron/types/crag.ts` — Define all interfaces (✅ Done)
2. `[x] electron/schema.sql` — Postgres schema with pgvector + FTS indexes (✅ Done)
3. `[x] electron/database.ts` — Global connection pool + auto-migration (✅ Done)
4. `[x] electron/NotesChunker.ts` — Parse, chunk, embed, upsert into Postgres (✅ Done)
5. `[x] electron/Retriever.ts` — pgvector cosine + Postgres FTS hybrid search (✅ Done)
6. `[ ]` Basic integration test: ingest notes → query → chunks returned (⏳ Pending)

### Sprint 2: Intelligence (Evaluation + Correction)
7. `[ ] electron/Evaluator.ts` — Gemini-powered relevance scoring (⏳ Pending)
8. `[ ] electron/Corrector.ts` — Query rewrite and re-retrieval (⏳ Pending)
9. `[ ] electron/CragHelper.ts` — Full orchestration pipeline (⏳ Pending)

### Sprint 3: Integration (Wire into Existing App)
10. `[ ]` Modify `ProcessingHelper.ts` — Inject CRAG context into generation (⏳ Pending)
11. `[x]` Modify `prompt.md` — Add context injection sections (✅ Done)
12. `[ ]` Modify `main.ts` — Initialize CRAG system (⏳ Pending)
13. `[ ]` Modify `ipcHandlers.ts` + `preload.ts` — Expose CRAG to renderer (⏳ Pending)

### Sprint 4: UI + Polish
14. `[ ]` Add confidence badges to solution display (⏳ Pending)
15. `[ ]` Add source citation (which notes section was used) (⏳ Pending)
16. `[ ]` Add CRAG toggle in settings (⏳ Pending)
17. `[ ]` Performance optimization + caching (⏳ Pending)

---

## Topic Coverage Analysis (notes.txt)

The current notes.txt provides strong coverage for these interview topics:

| Topic | Coverage Level | Relevant Sections |
|---|---|---|
| Load Balancing | ██████████ Strong | Section 1, Section 2 |
| Consistent Hashing | ██████████ Strong | Section 1 |
| Caching (all types) | ██████████ Strong | Sections 2, 3, 4 |
| Cache Eviction (LRU/LFU) | ██████████ Strong | Sections 2, 3, 4 |
| Cache Invalidation | ████████░░ Good | Sections 3, 4 |
| CDN | ██████░░░░ Moderate | Section 2 |
| DNS | ████░░░░░░ Basic | Section 2 |
| SOLID Principles | ████░░░░░░ Basic | Section 2 |
| CAP Theorem | ██████████ Strong | Sections 5, 6 |
| Data Sharding | ██████████ Strong | Section 7 |
| Database Replication | ████████░░ Good | Section 6 |
| ACID Properties | ████████░░ Good | Section 6 |
| Newsfeed System Design | ████████░░ Good | Sections 4, 5 |
| Quorum Systems | ██████░░░░ Moderate | Section 6 |
| Master-Slave Architecture | ██████░░░░ Moderate | Section 6 |

### Gaps to consider filling in notes.txt later:
- API Design / REST vs GraphQL
- Message Queues (Kafka, RabbitMQ)
- Microservices patterns
- Rate Limiting
- Database indexing deep dive
- Consensus algorithms (Raft, Paxos)

---

## Risk Mitigation

| Risk | Mitigation |
|---|---|
| Gemini API rate limits during rapid fire interview | Query cache + throttling + batch evaluation calls |
| notes.txt too small for complex questions | Corrector falls back to pure Gemini (still works, just without grounding) |
| Latency too high with evaluation step | Make evaluation optional via config toggle; skip in "speed mode" |
| Chunks too coarse, retrieval imprecise | Fine-tune chunk size; add overlap; improve keyword extraction |
| User modifies notes.txt while app is running | fs.watchFile triggers re-chunk + re-index automatically |

---

## Success Metrics

1. **Retrieval Accuracy**: >80% of queries retrieve at least 1 highly relevant chunk (score ≥ 4)
2. **Correction Effectiveness**: Corrector improves retrieval score in >60% of ambiguous cases
3. **Answer Quality**: Context-grounded answers are more accurate than pure Gemini for system design topics covered in notes
4. **Latency**: End-to-end under 6 seconds including correction
5. **User Experience**: Confidence badge accurately reflects answer reliability
