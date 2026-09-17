-- Vectors for hybrid search, one per chunk, because the model reads only 512 tokens (src/lib/chunk.ts).
-- Runs on every boot when sqlite-vec loaded, so every statement is idempotent.

-- One vector per entry, schema 002; derived data that the boot backfill rebuilds below.
DROP TABLE IF EXISTS embeddings;

-- chunk_id is `<content_id>:<n>`.
CREATE VIRTUAL TABLE IF NOT EXISTS embedding_chunks USING vec0(
  chunk_id TEXT PRIMARY KEY,
  embedding float[384]
);

-- One row per embedded entry; a changed hash, chunker or model re-embeds it.
CREATE TABLE IF NOT EXISTS embedding_sources (
  content_id TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  chunk_count INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  chunker TEXT NOT NULL,
  model TEXT NOT NULL
);

-- schema_version stays 2: the exported data is unchanged, and the markdown export/import tools refuse any other version.
INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '2');
INSERT OR REPLACE INTO meta (key, value) VALUES ('embedding_dim', '384');
INSERT OR REPLACE INTO meta (key, value) VALUES ('embedding_model', 'Xenova/multilingual-e5-small');
