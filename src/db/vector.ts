/**
 * sqlite-vec extension loader + embedding storage layer.
 *
 * `loadVecExtension` is best-effort. On a platform where sqlite-vec ships a
 * prebuilt binary that matches the better-sqlite3 ABI (linux-x64, darwin-x64,
 * darwin-arm64, win32-x64 today) the load succeeds and we get a `vec0`
 * virtual table type that supports KNN MATCH queries against `Float32Array`
 * inputs. On any other platform — or if the dynamic loader is blocked — we
 * stay in FTS5-only mode and `isVectorEnabled()` returns false for the
 * lifetime of the process.
 *
 * Power-user opt-out: setting `MEMORY_REQUIRE_VEC=1` flips the loader from
 * "swallow and degrade" to "crash loud" — useful for users who would rather
 * see a startup error than silently lose semantic recall.
 *
 * The contract for callers (search.ts, learn.ts, decide.ts, entity.ts):
 *   - call `loadVecExtension(db)` exactly once, right after schema bootstrap
 *   - check `isVectorEnabled()` before touching `embedding_chunks` / `embedding_sources`
 *   - `prepareEmbedding()` outside a transaction, `writeEmbeddingSync()` inside it
 *   - use `deleteEmbeddings()` to clean up after deleting source rows
 *   - never crash if a vec query fails; fall through to the FTS5 path
 */
import type { Database } from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../lib/logger.js';
import { embed, EMBEDDING_DIM, embedMode, embedModelId, passageTokenCounter } from '../lib/embed.js';
import { chunkText, CHUNKER_ID } from '../lib/chunk.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ESM has no `require`; the sqlite-vec loader below needs it.
const require = createRequire(import.meta.url);

let vectorEnabled = false;
let lastError: string | null = null;

/**
 * Try to load the sqlite-vec extension into this Database.
 *
 * IMPORTANT: this MUST run once per Database handle. The `vec0` virtual table
 * type is registered against an open SQLite connection by
 * `db.loadExtension()`. A fresh connection (e.g. tests opening a new tmp
 * SQLite per case) starts without vec0 even though the npm package is
 * already loaded into the Node process. Caching "we loaded once → return
 * true forever" would lie about a fresh handle, and the follow-up
 * `CREATE VIRTUAL TABLE … USING vec0` would fail with "no such module:
 * vec0". So we run the load every time we get a new Database in, and
 * `closeDb()` resets the module-level mirror via `_resetForTests()` so
 * other helpers (`isVectorEnabled`, `vectorStatus`) reflect the live state.
 *
 * F2 hardening (Critic R1 + Research R1): if `MEMORY_REQUIRE_VEC=1` is set
 * we rethrow the load failure as a fatal error so the user sees the crash
 * instead of a silent FTS5-only mode. Useful for power-users on platforms
 * where they expect vec to be present (and would rather notice during boot
 * than during a search).
 *
 * Returns true if vec is now usable on this connection.
 */
export function loadVecExtension(db: Database): boolean {
  try {
    // The sqlite-vec npm package exposes a `load(db)` helper that finds the
    // right native binary inside its own node_modules and calls
    // db.loadExtension under the hood. We import dynamically so a missing
    // package or ABI mismatch never crashes the server.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqliteVec = require('sqlite-vec') as { load: (db: Database) => void };
    sqliteVec.load(db);
    vectorEnabled = true;
    lastError = null;
    logger.info('[vector] sqlite-vec extension loaded');
    return true;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    vectorEnabled = false;
    if (process.env.MEMORY_REQUIRE_VEC === '1') {
      // Loud failure path — let the caller crash. Useful for CI integration
      // tests and for users on platforms that must support vec.
      process.stderr.write(
        `[local-memory] FATAL: sqlite-vec failed to load on ${process.platform}-${process.arch}-node${process.version} and MEMORY_REQUIRE_VEC=1 was set: ${lastError}\n`
      );
      throw err instanceof Error ? err : new Error(lastError);
    }
    logger.warn(`[vector] sqlite-vec unavailable, FTS5-only mode: ${lastError}`);
    return false;
  }
}

const MIGRATION = '003_chunked_embeddings.sql';

/**
 * Apply the embedding tables after loadVecExtension succeeded; idempotent, runs every boot.
 * A model or chunker change is not a schema matter: the source rows record both and the backfill re-embeds.
 */
export function applyVectorSchema(db: Database): boolean {
  if (!vectorEnabled) return false;

  // dist/db/migrations after a build, src/db/migrations when run from source.
  const candidates = [
    join(__dirname, 'migrations', MIGRATION),
    join(__dirname, '..', '..', 'src', 'db', 'migrations', MIGRATION),
  ];
  const migrationPath = candidates.find((p) => existsSync(p));
  if (!migrationPath) {
    lastError = `migration file ${MIGRATION} not found`;
    logger.warn(`[vector] ${lastError}`);
    vectorEnabled = false;
    return false;
  }

  try {
    db.exec(readFileSync(migrationPath, 'utf-8'));
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    logger.warn(`[vector] schema migration failed: ${lastError}`);
    vectorEnabled = false;
    return false;
  }
  return true;
}

export function isVectorEnabled(): boolean {
  return vectorEnabled;
}

export function vectorStatus(): { enabled: boolean; error: string | null } {
  return { enabled: vectorEnabled, error: lastError };
}

export type EmbeddingContentType = 'learning' | 'decision' | 'observation' | 'entity';

/** The vectors of one entry's chunks, plus the hash of the text they were made from. */
export interface PreparedEmbedding {
  vectors: Float32Array[];
  hash: string;
}

const contentHash = (text: string): string => createHash('sha256').update(text).digest('hex');

// Mock vectors are tagged, so switching to the real model re-embeds them.
const modelTag = (): string => (embedMode() === 'mock' ? `${embedModelId()}#mock` : embedModelId());

/**
 * Chunk and embed a text outside any transaction; null when vectors are off or any chunk failed to embed.
 * Chunks are embedded one by one: batches padded to the longest chunk were slower (39 vs 92 ms per chunk measured).
 */
export async function prepareEmbedding(text: string): Promise<PreparedEmbedding | null> {
  if (!vectorEnabled) return null;
  const chunks = chunkText(text, await passageTokenCounter());
  const vectors: Float32Array[] = [];
  for (const chunk of chunks) {
    const vec = await embed(chunk);
    if (!vec || vec.length !== EMBEDDING_DIM) return null;
    vectors.push(vec);
  }
  return { vectors, hash: contentHash(text) };
}

export async function prepareEmbeddingBatch(texts: string[]): Promise<(PreparedEmbedding | null)[]> {
  const out: (PreparedEmbedding | null)[] = [];
  for (const text of texts) out.push(await prepareEmbedding(text));
  return out;
}

function deleteChunks(db: Database, contentId: string): void {
  const source = db.prepare('SELECT chunk_count FROM embedding_sources WHERE content_id = ?').get(contentId) as
    | { chunk_count: number }
    | undefined;
  if (!source) return;
  const del = db.prepare('DELETE FROM embedding_chunks WHERE chunk_id = ?');
  for (let i = 0; i < source.chunk_count; i++) del.run(`${contentId}:${i}`);
  db.prepare('DELETE FROM embedding_sources WHERE content_id = ?').run(contentId);
}

/**
 * Replace an entry's chunks inside the caller's transaction; a vec0 error propagates so the source row rolls back too.
 * No-op when vectors are off or `prepared` is null (the entry stays FTS-only).
 */
export function writeEmbeddingSync(
  db: Database,
  contentId: string,
  contentType: EmbeddingContentType,
  prepared: PreparedEmbedding | null,
): void {
  if (!vectorEnabled || !prepared) return;
  deleteChunks(db, contentId);
  const insert = db.prepare('INSERT INTO embedding_chunks (chunk_id, embedding) VALUES (?, ?)');
  prepared.vectors.forEach((vec, i) => insert.run(`${contentId}:${i}`, vec));
  db.prepare(
    `INSERT INTO embedding_sources (content_id, content_type, chunk_count, source_hash, chunker, model)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(contentId, contentType, prepared.vectors.length, prepared.hash, CHUNKER_ID, modelTag());
}

/** Delete the chunks of source rows that are being deleted; vec0 is not part of the foreign-key cascade. */
export function deleteEmbeddings(contentIds: string[], db: Database): void {
  if (!vectorEnabled) return;
  for (const id of contentIds) deleteChunks(db, id);
}

/** The text an entity embeds to, shared by the write paths and the backfill. */
export function entityEmbedText(name: string, summary: string | null, entityType: string): string {
  return `${name} ${summary ?? ''} ${entityType}`.trim();
}

/** The text a decision embeds to, shared by decide, import and the backfill so a round trip keeps its vectors. */
export function decisionEmbeddingText(d: {
  title?: unknown;
  decision?: unknown;
  reasoning?: unknown;
  alternatives?: unknown;
}): string {
  return [d.title, d.decision, d.reasoning, d.alternatives]
    .map((x) => (typeof x === 'string' ? x : ''))
    .filter(Boolean)
    .join('\n');
}

interface Embeddable {
  id: string;
  type: EmbeddingContentType;
  text: string;
}

function embeddables(db: Database, id?: string): Embeddable[] {
  const where = id === undefined ? '' : 'WHERE id = ?';
  const args = id === undefined ? [] : [id];
  const learnings = (db.prepare(`SELECT id, content FROM learnings ${where}`).all(...args) as Array<{ id: string; content: string }>)
    .map((r): Embeddable => ({ id: r.id, type: 'learning', text: r.content }));
  const decisions = (db.prepare(`SELECT id, title, decision, reasoning, alternatives FROM decisions ${where}`).all(...args) as Array<{ id: string; title: string; decision: string; reasoning: string; alternatives: string | null }>)
    .map((r): Embeddable => ({ id: r.id, type: 'decision', text: decisionEmbeddingText(r) }));
  const observations = (db.prepare(`SELECT id, content FROM entity_observations ${where}`).all(...args) as Array<{ id: string; content: string }>)
    .map((r): Embeddable => ({ id: r.id, type: 'observation', text: r.content }));
  const entities = (db.prepare(`SELECT id, name, summary, entity_type FROM entities ${where}`).all(...args) as Array<{ id: string; name: string; summary: string | null; entity_type: string }>)
    .map((r): Embeddable => ({ id: r.id, type: 'entity', text: entityEmbedText(r.name, r.summary, r.entity_type) }));
  return [...learnings, ...decisions, ...observations, ...entities];
}

/**
 * Embed every entry whose vectors are missing or were made from other text, another chunker or another model.
 * Runs in the background after boot; each entry commits alone, and one changed meanwhile is left to its own write.
 */
export async function backfillEmbeddings(db: Database): Promise<number> {
  if (!vectorEnabled) return 0;
  const sources = new Map(
    (db.prepare('SELECT content_id, source_hash, chunker, model FROM embedding_sources').all() as Array<{
      content_id: string;
      source_hash: string;
      chunker: string;
      model: string;
    }>).map((s) => [s.content_id, s])
  );
  const model = modelTag();
  const stale = embeddables(db).filter((e) => {
    const s = sources.get(e.id);
    return !s || s.source_hash !== contentHash(e.text) || s.chunker !== CHUNKER_ID || s.model !== model;
  });

  let written = 0;
  for (const entry of stale) {
    const prepared = await prepareEmbedding(entry.text);
    if (!prepared) continue;
    const tx = db.transaction(() => {
      const [current] = embeddables(db, entry.id).filter((e) => e.type === entry.type);
      if (!current || contentHash(current.text) !== prepared.hash) return false;
      writeEmbeddingSync(db, entry.id, entry.type, prepared);
      return true;
    });
    if (tx()) written++;
  }
  if (written > 0) logger.info(`[vector] embedded ${written} entr${written === 1 ? 'y' : 'ies'}`);
  return written;
}

/**
 * Test helper: reset state between cases. Production callers should never use this.
 */
export function _resetForTests(): void {
  vectorEnabled = false;
  lastError = null;
}
