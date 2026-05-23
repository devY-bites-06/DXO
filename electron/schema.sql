-- ============================================================================
-- schema.sql — CRAG Knowledge Base (pgvector)
-- Run this once against your target Postgres database.
-- Requires: PostgreSQL 15+ with the `pgvector` extension installed.
-- ============================================================================

-- 1. Enable the pgvector extension (idempotent)
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Knowledge chunks table
--    Each row is one semantic chunk from the notes corpus.
CREATE TABLE IF NOT EXISTS knowledge_chunks (
    -- Deterministic chunk ID, e.g. "notes1_s3_c2"
    id             TEXT PRIMARY KEY,

    -- Human-readable section heading (derived from --- delimiters)
    section        TEXT NOT NULL,

    -- Auto-extracted topic keywords for boosting keyword search
    topics         TEXT[] NOT NULL DEFAULT '{}',

    -- The cleaned chunk text (citation tags already stripped)
    content        TEXT NOT NULL,

    -- Full-text search vector, auto-maintained via trigger
    content_tsv    TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,

    -- Citation tag numbers extracted from the original text
    -- e.g. 【7:0†source】 → {7, 0}
    source_tags    INTEGER[] NOT NULL DEFAULT '{}',

    -- Which notes file this chunk came from
    source_file    TEXT NOT NULL DEFAULT '',

    -- 768-dimensional embedding from Gemini text-embedding-004
    embedding      VECTOR(768) NOT NULL,

    -- Housekeeping
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Indexes

-- HNSW index for fast approximate nearest-neighbour cosine search.
-- m = 16, ef_construction = 64 are good defaults for <10k rows.
CREATE INDEX IF NOT EXISTS idx_chunks_embedding_hnsw
    ON knowledge_chunks
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- GIN index on the tsvector column for full-text search.
CREATE INDEX IF NOT EXISTS idx_chunks_content_fts
    ON knowledge_chunks
    USING gin (content_tsv);

-- GIN index on topics array for topic-based filtering.
CREATE INDEX IF NOT EXISTS idx_chunks_topics
    ON knowledge_chunks
    USING gin (topics);

-- B-tree on source_file for per-file filtering / bulk deletion.
CREATE INDEX IF NOT EXISTS idx_chunks_source_file
    ON knowledge_chunks (source_file);

-- 4. Helper: upsert-safe trigger to keep updated_at current
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_chunks_updated_at ON knowledge_chunks;
CREATE TRIGGER trg_chunks_updated_at
    BEFORE UPDATE ON knowledge_chunks
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
