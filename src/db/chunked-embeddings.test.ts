/**
 * Tests for chunked embeddings: one vector per chunk of an entry, one source row per entry.
 * Mock embeddings (vitest.config.ts); the mock token count is chars / 3.4, so a chunk holds about 1,700 chars.
 * By hand on a scratch store: memory_learn a 5,000-char entry, then
 *   SELECT content_id, chunk_count, chunker, model FROM embedding_sources;  -- one row, chunk_count 3 or more
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmp = '';
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'local-memory-chunks-'));
  process.env.MEMORY_DB_PATH = join(tmp, 'test.sqlite');
});
afterEach(async () => {
  const { closeDb } = await import('./client.js');
  closeDb();
  delete process.env.MEMORY_DB_PATH;
  rmSync(tmp, { recursive: true, force: true });
});

// Distinct letter-only words: the mock embedding tokenises on letters, so digits would collapse words together.
const letters = (n: number): string => (n >= 26 ? letters(Math.floor(n / 26) - 1) : '') + String.fromCharCode(97 + (n % 26));
const word = (tag: string, i: number) => `${tag}${letters(i)}x`;
// A paragraph of 55 distinct words, about 300 chars.
const para = (tag: string) => Array.from({ length: 55 }, (_, i) => word(tag, i)).join(' ') + '.';
const longText = (head: string, tags: string[]) => [head, ...tags.map(para)].join('\n\n');
const TWELVE = ['aa', 'bb', 'cc', 'dd', 'ee', 'ff', 'gg', 'hh', 'ii', 'jj', 'kk', 'll'];
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

type SourceRow = { content_id: string; content_type: string; chunk_count: number; source_hash: string; chunker: string; model: string };

async function setup() {
  const { getDb } = await import('./client.js');
  const vector = await import('./vector.js');
  const db = getDb();
  const source = (id: string) => db.prepare('SELECT * FROM embedding_sources WHERE content_id = ?').get(id) as SourceRow | undefined;
  const chunkIds = (id: string) =>
    (db.prepare('SELECT chunk_id FROM embedding_chunks').all() as Array<{ chunk_id: string }>)
      .map((r) => r.chunk_id)
      .filter((c) => c.startsWith(`${id}:`))
      .sort();
  return { db, vector, source, chunkIds };
}

describe('chunked embedding storage', () => {
  it('a fresh store has the chunk tables, no old embeddings table, and schema_version 2', async () => {
    const { db, vector } = await setup();
    if (!vector.isVectorEnabled()) return;
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(names).toContain('embedding_chunks');
    expect(names).toContain('embedding_sources');
    expect(names).not.toContain('embeddings');
    expect((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe('2');
  });

  it('drops an embeddings table left by an older server', async () => {
    const { db, vector } = await setup();
    if (!vector.isVectorEnabled()) return;
    db.exec('CREATE VIRTUAL TABLE embeddings USING vec0(content_id TEXT PRIMARY KEY, +content_type TEXT, embedding float[384])');
    vector.applyVectorSchema(db);
    const old = db.prepare("SELECT name FROM sqlite_master WHERE name = 'embeddings'").get();
    expect(old).toBeUndefined();
  });

  it('learn writes one chunk per piece and one source row naming chunker, model and hash', async () => {
    const { vector, source, chunkIds } = await setup();
    if (!vector.isVectorEnabled()) return;
    const { learn } = await import('../tools/learn.js');
    const { CHUNKER_ID } = await import('../lib/chunk.js');
    const content = longText('LONG ENTRY HEADLINE.', TWELVE);
    const r = await learn({ category: 'pattern', content });
    const id = (r as { data: { id: string } }).data.id;

    const row = source(id)!;
    expect(row.content_type).toBe('learning');
    expect(row.chunk_count).toBeGreaterThanOrEqual(2);
    expect(row.chunker).toBe(CHUNKER_ID);
    expect(row.model).toBe('Xenova/multilingual-e5-small#mock');
    expect(row.source_hash).toBe(sha(content));
    expect(chunkIds(id)).toEqual(Array.from({ length: row.chunk_count }, (_, i) => `${id}:${i}`).sort());
  });

  it('a short learning is one chunk', async () => {
    const { vector, source, chunkIds } = await setup();
    if (!vector.isVectorEnabled()) return;
    const { learn } = await import('../tools/learn.js');
    const r = await learn({ category: 'pattern', content: 'short and sweet' });
    const id = (r as { data: { id: string } }).data.id;
    expect(source(id)!.chunk_count).toBe(1);
    expect(chunkIds(id)).toEqual([`${id}:0`]);
  });

  it('updating to shorter content leaves no chunk behind', async () => {
    const { vector, source, chunkIds } = await setup();
    if (!vector.isVectorEnabled()) return;
    const { learn, learnUpdate } = await import('../tools/learn.js');
    const r = await learn({ category: 'pattern', content: longText('HEAD.', TWELVE) });
    const id = (r as { data: { id: string } }).data.id;
    expect(chunkIds(id).length).toBeGreaterThanOrEqual(2);

    await learnUpdate({ learningId: id, content: 'now it is short' });
    expect(source(id)!.chunk_count).toBe(1);
    expect(source(id)!.source_hash).toBe(sha('now it is short'));
    expect(chunkIds(id)).toEqual([`${id}:0`]);
  });

  it('deleting an entity removes the chunks and source rows of its observations', async () => {
    const { vector, source, chunkIds } = await setup();
    if (!vector.isVectorEnabled()) return;
    const { entityObserve, entityDelete } = await import('../tools/entity.js');
    const o = await entityObserve({ entityName: 'Vesta', entityType: 'asteroid', content: longText('OBSERVATION.', TWELVE.slice(0, 6)) });
    const { observationId, entityId } = (o as { data: { observationId: string; entityId: string } }).data;
    expect(chunkIds(observationId).length).toBeGreaterThanOrEqual(1);

    entityDelete({ id: entityId });
    expect(source(observationId)).toBeUndefined();
    expect(chunkIds(observationId)).toEqual([]);
  });

  it('bulk insert and import write chunks for long learnings', async () => {
    const { vector, source } = await setup();
    if (!vector.isVectorEnabled()) return;
    const { learnBulk } = await import('../tools/learn.js');
    const { memoryImport } = await import('../tools/export.js');
    const bulk = await learnBulk({ items: [{ category: 'pattern', content: longText('BULK.', TWELVE) }] });
    const bulkId = (bulk as { data: { results: Array<{ id: string }> } }).data.results[0]!.id;
    expect(source(bulkId)!.chunk_count).toBeGreaterThanOrEqual(2);

    const importedId = '11111111-2222-4333-8444-555555555555';
    const imp = await memoryImport({
      data: {
        format: 'studiomeyer-memory-export',
        version: 1,
        learnings: [{ id: importedId, date: '2026-09-17 10:00:00', category: 'pattern', content: longText('IMPORTED.', TWELVE) }],
      },
    });
    expect(imp.success).toBe(true);
    expect(source(importedId)!.chunk_count).toBeGreaterThanOrEqual(2);
  });
});

describe('vector search over chunks', () => {
  it('finds a long entry by its last paragraph, where one vector per entry ranks a partial match first', async () => {
    const { vector } = await setup();
    if (!vector.isVectorEnabled()) return;
    const { learn } = await import('../tools/learn.js');
    const { search } = await import('../tools/search.js');
    const { mockEmbed } = await import('../lib/embed.js');
    const tail = Array.from({ length: 40 }, (_, i) => word('tail', i)).join(' ') + '.';
    const longContent = `${longText('FILLER HEADLINE.', TWELVE)}\n\n${tail}`;
    const partial = Array.from({ length: 8 }, (_, i) => word('tail', i)).join(' ') + ' unrelated words here.';
    const long = await learn({ category: 'pattern', content: longContent });
    await learn({ category: 'pattern', content: partial });

    // Precondition: a single vector for the whole long entry scores below the partial match.
    const dot = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i]!, 0);
    const q = mockEmbed(tail);
    expect(dot(q, mockEmbed(longContent))).toBeLessThan(dot(q, mockEmbed(partial)));

    const r = await search({ query: tail, mode: 'vector', types: ['learning'] });
    if (!r.success) throw new Error(r.error);
    const ids = (r.data as { results: Array<{ id: string }> }).results.map((x) => x.id);
    expect(ids[0]).toBe((long as { data: { id: string } }).data.id);
  });

  it('ranks a one-chunk entry above a many-chunk entry whose best chunk matches only slightly better', async () => {
    const { db, vector, source } = await setup();
    if (!vector.isVectorEnabled()) return;
    const { learn } = await import('../tools/learn.js');
    const { search } = await import('../tools/search.js');
    const { mockEmbed } = await import('../lib/embed.js');
    const short = (await learn({ category: 'pattern', content: 'short entry text' })) as { data: { id: string } };
    const long = (await learn({ category: 'pattern', content: longText('LONG.', TWELVE) })) as { data: { id: string } };
    expect(source(long.data.id)!.chunk_count).toBeGreaterThanOrEqual(2);

    // Test scaffolding, not a public API: the long entry's chunk equals the query (cosine 1), the short
    // entry's sits at cosine 0.995, a gap smaller than the penalty for two or more chunks (0.01 * ln 2).
    const query = 'identical best match';
    const q = mockEmbed(query);
    const other = mockEmbed('orthogonal direction for the short entry');
    const along = other.reduce((s, x, i) => s + x * q[i]!, 0);
    const ortho = other.map((x, i) => x - along * q[i]!);
    const norm = Math.hypot(...ortho);
    const nearQ = q.map((x, i) => 0.995 * x + Math.sqrt(1 - 0.995 ** 2) * (ortho[i]! / norm));
    const replace = db.transaction((chunkId: string, vec: Float32Array) => {
      db.prepare('DELETE FROM embedding_chunks WHERE chunk_id = ?').run(chunkId);
      db.prepare('INSERT INTO embedding_chunks (chunk_id, embedding) VALUES (?, ?)').run(chunkId, vec);
    });
    replace(`${short.data.id}:0`, nearQ);
    replace(`${long.data.id}:1`, q);

    const r = await search({ query, mode: 'vector', types: ['learning'] });
    if (!r.success) throw new Error(r.error);
    const ids = (r.data as { results: Array<{ id: string }> }).results.map((x) => x.id);
    expect(ids.indexOf(short.data.id)).toBeLessThan(ids.indexOf(long.data.id));
  });
});

describe('embedding backfill', () => {
  it('embeds learnings, decisions, entities and observations that have no source row', async () => {
    const { db, vector, source } = await setup();
    if (!vector.isVectorEnabled()) return;
    const { learn } = await import('../tools/learn.js');
    const { decide } = await import('../tools/decide.js');
    const { entityCreate, entityObserve } = await import('../tools/entity.js');
    const l = (await learn({ category: 'pattern', content: longText('BACKFILL.', TWELVE) })) as { data: { id: string } };
    const d = (await decide({ title: 'Store', decision: 'SQLite', reasoning: 'local' })) as { data: { id: string } };
    const e = entityCreate({ name: 'Ceres', entityType: 'dwarf planet', summary: 'largest asteroid' }) as { data: { id: string } };
    const o = (await entityObserve({ entityId: e.data.id, content: 'has water ice' })) as { data: { observationId: string } };
    db.exec('DELETE FROM embedding_chunks; DELETE FROM embedding_sources;');

    const n = await vector.backfillEmbeddings(db);
    expect(n).toBe(4);
    expect(source(l.data.id)!.chunk_count).toBeGreaterThanOrEqual(2);
    expect(source(d.data.id)!.content_type).toBe('decision');
    expect(source(e.data.id)!.content_type).toBe('entity');
    expect(source(o.data.observationId)!.content_type).toBe('observation');
  });

  it('re-embeds an entry whose content changed behind its back, or whose chunker or model differs', async () => {
    const { db, vector, source } = await setup();
    if (!vector.isVectorEnabled()) return;
    const { learn } = await import('../tools/learn.js');
    const a = (await learn({ category: 'pattern', content: 'first entry' })) as { data: { id: string } };
    const b = (await learn({ category: 'pattern', content: 'second entry' })) as { data: { id: string } };
    const c = (await learn({ category: 'pattern', content: 'third entry' })) as { data: { id: string } };
    const changed = longText('CHANGED.', TWELVE);
    db.prepare('UPDATE learnings SET content = ? WHERE id = ?').run(changed, a.data.id);
    db.prepare("UPDATE embedding_sources SET chunker = 'older-chunker' WHERE content_id = ?").run(b.data.id);
    db.prepare("UPDATE embedding_sources SET model = 'another-model' WHERE content_id = ?").run(c.data.id);

    expect(await vector.backfillEmbeddings(db)).toBe(3);
    expect(source(a.data.id)!.source_hash).toBe(sha(changed));
    expect(source(a.data.id)!.chunk_count).toBeGreaterThanOrEqual(2);
    expect(source(b.data.id)!.chunker).not.toBe('older-chunker');
    expect(source(c.data.id)!.model).not.toBe('another-model');
  });

  it('does nothing on an up-to-date store', async () => {
    const { db, vector } = await setup();
    if (!vector.isVectorEnabled()) return;
    const { learn } = await import('../tools/learn.js');
    await learn({ category: 'pattern', content: longText('CURRENT.', TWELVE) });
    expect(await vector.backfillEmbeddings(db)).toBe(0);
  });
});

describe('memory_health embedding counts', () => {
  it('reports embedded entries and chunks separately', async () => {
    const { vector } = await setup();
    if (!vector.isVectorEnabled()) return;
    const { learn } = await import('../tools/learn.js');
    const { health } = await import('../tools/insights.js');
    await learn({ category: 'pattern', content: longText('HEALTH.', TWELVE) });
    await learn({ category: 'pattern', content: 'tiny' });
    const r = health();
    if (!r.success) throw new Error(r.error);
    const v = (r.data as { vector: { embeddingsCount: number; chunksCount: number } }).vector;
    expect(v.embeddingsCount).toBe(2);
    expect(v.chunksCount).toBeGreaterThanOrEqual(3);
  });
});
