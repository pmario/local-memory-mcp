/**
 * Learning history (local-memory-mcp-mnb): every change to a learning keeps the previous version
 * in learnings_history, and memory_get reads a learning as it was at a given time.
 * By hand: memory_learn_update({learningId, content, style}) and then
 * memory_get({ids: [learningId], history: true}) lists the old text's headline with its dates;
 * memory_get({ids: [learningId], asOf: "<a time before the update>"}) returns the old text.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHECKED: Array<'atomic' | 'factual'> = ['atomic', 'factual'];

let tmp = '';
beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'local-memory-history-'));
  process.env.MEMORY_DB_PATH = join(tmp, 'test.sqlite');
  (await import('../db/client.js')).getDb();
});
afterEach(async () => {
  const { closeDb } = await import('../db/client.js');
  closeDb();
  delete process.env.MEMORY_DB_PATH;
  rmSync(tmp, { recursive: true, force: true });
});

// Test scaffolding: a learning dated in the past, so versions written now have distinct times.
async function storeOld(content: string, date = '2026-01-01 00:00:00'): Promise<string> {
  const { learn } = await import('./learn.js');
  const { getDb } = await import('../db/client.js');
  const r = await learn({ category: 'pattern', content, style: CHECKED });
  if (!r.success) throw new Error(r.error);
  const id = (r.data as { id: string }).id;
  getDb().prepare('UPDATE learnings SET date = ? WHERE id = ?').run(date, id);
  return id;
}

async function versions(id: string) {
  const { getDb } = await import('../db/client.js');
  return getDb()
    .prepare('SELECT * FROM learnings_history WHERE learning_id = ? ORDER BY expired_at, rowid')
    .all(id) as Array<{ id: string; content: string; style_json: string; archived: number; tags_json: string; recorded_at: string; expired_at: string }>;
}

async function get(input: Record<string, unknown>) {
  const { memoryGet } = await import('./get.js');
  const r = memoryGet(input as { ids: string[] });
  if (!r.success) throw new Error(r.error);
  return r.data as { results: Array<Record<string, unknown>>; missing: string[] };
}

describe('learnings_history records every change', () => {
  it('keeps the old text of a rewrite, dated from creation to the rewrite', async () => {
    const { learnUpdate } = await import('./learn.js');
    const id = await storeOld('Old text.');
    expect((await learnUpdate({ learningId: id, content: 'New text.', style: CHECKED })).success).toBe(true);
    const v = await versions(id);
    expect(v).toHaveLength(1);
    expect(v[0]!.content).toBe('Old text.');
    expect(v[0]!.recorded_at).toBe('2026-01-01 00:00:00');
    expect(v[0]!.expired_at > '2026-09-01').toBe(true);
  });

  it('chains versions: each one starts where the previous one ended', async () => {
    const { learnUpdate } = await import('./learn.js');
    const { getDb } = await import('../db/client.js');
    const id = await storeOld('First.');
    await learnUpdate({ learningId: id, content: 'Second.', style: CHECKED });
    getDb().prepare("UPDATE learnings_history SET expired_at = '2026-02-01 00:00:00' WHERE learning_id = ?").run(id);
    await learnUpdate({ learningId: id, content: 'Third.', style: CHECKED });
    const v = await versions(id);
    expect(v.map((x) => x.content)).toEqual(['First.', 'Second.']);
    expect(v[1]!.recorded_at).toBe('2026-02-01 00:00:00');
  });

  it('versions metadata changes too: tags, style, archive', async () => {
    const { learnUpdate, learnArchive } = await import('./learn.js');
    const id = await storeOld('Stable text.');
    await learnUpdate({ learningId: id, tags: ['a'] });
    await learnUpdate({ learningId: id, style: [] });
    learnArchive({ learningId: id, reason: 'obsolete' });
    const v = await versions(id);
    expect(v).toHaveLength(3);
    expect(JSON.parse(v[0]!.tags_json)).toEqual([]);
    expect(JSON.parse(v[1]!.style_json)).toEqual(['atomic', 'factual']);
    expect(v[2]!.archived).toBe(0);
  });

  it('records nothing when no versioned field changes or the write is refused', async () => {
    const { learnUpdate, learnArchive } = await import('./learn.js');
    const id = await storeOld('Same.');
    await learnUpdate({ learningId: id, content: 'Same.', tags: [] });
    await learnUpdate({ learningId: id, content: 'Rewrite without style.' });
    learnArchive({ learningId: id });
    learnArchive({ learningId: id });
    expect(await versions(id)).toHaveLength(1);
  });
});

describe('memory_get reads history', () => {
  it('asOf returns the version the store held at that time', async () => {
    const { learnUpdate } = await import('./learn.js');
    const id = await storeOld('Old text.');
    await learnUpdate({ learningId: id, content: 'New text.', style: CHECKED });

    const before = await get({ ids: [id], asOf: '2026-06-01' });
    expect(before.results[0]!.content).toBe('Old text.');
    expect(before.results[0]!.style).toEqual(['atomic', 'factual']);
    expect(before.results[0]!.version).toEqual({ recordedAt: '2026-01-01 00:00:00', expiredAt: expect.any(String) });

    const now = await get({ ids: [id], asOf: '2099-01-01' });
    expect(now.results[0]!.content).toBe('New text.');

    const earlier = await get({ ids: [id], asOf: '2025-01-01' });
    expect(earlier.results).toHaveLength(0);
    expect(earlier.missing).toEqual([id]);
  });

  it('refuses an unparseable asOf at the schema', async () => {
    const { getSchema } = await import('./get.js');
    expect(getSchema.safeParse({ ids: ['x'], asOf: 'last tuesday' }).success).toBe(false);
  });

  it('history: true lists the earlier versions oldest first, headlines only', async () => {
    const { learnUpdate } = await import('./learn.js');
    const id = await storeOld('First headline.\n\nFirst body.');
    await learnUpdate({ learningId: id, content: 'Second headline.\n\nSecond body.', style: CHECKED });
    const r = await get({ ids: [id], history: true });
    const history = r.results[0]!.history as Array<Record<string, unknown>>;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ headline: 'First headline.', recordedAt: '2026-01-01 00:00:00' });
    expect(history[0]).not.toHaveProperty('archived');
    expect(history[0]).not.toHaveProperty('content');
    expect(r.results[0]!.content).toBe('Second headline.\n\nSecond body.');
  });

  it('leaves history out unless asked', async () => {
    const { learnUpdate } = await import('./learn.js');
    const id = await storeOld('Old.');
    await learnUpdate({ learningId: id, content: 'New.', style: CHECKED });
    expect((await get({ ids: [id] })).results[0]).not.toHaveProperty('history');
  });
});

describe('memory_export and memory_import carry history', () => {
  it('round trips the versions, adds nothing on a second import, and skips a version whose learning is absent', async () => {
    const { learnUpdate } = await import('./learn.js');
    const { memoryExport, memoryImport } = await import('./export.js');
    const id = await storeOld('Old text.');
    await learnUpdate({ learningId: id, content: 'New text.', style: CHECKED });
    const exported = memoryExport({});
    if (!exported.success) throw new Error(exported.error);
    const envelope = exported.data as { learningsHistory: Array<{ learningId: string; content: string }> };
    expect(envelope.learningsHistory).toHaveLength(1);
    expect(envelope.learningsHistory[0]!.content).toBe('Old text.');

    const { closeDb } = await import('../db/client.js');
    closeDb();
    process.env.MEMORY_DB_PATH = join(tmp, 'imported.sqlite');
    const orphan = { ...envelope.learningsHistory[0]!, id: 'dddddddd-0000-4000-8000-000000000000', learningId: 'eeeeeeee-0000-4000-8000-000000000000' };
    const data = { ...envelope, learningsHistory: [...envelope.learningsHistory, orphan] } as unknown as Record<string, unknown>;
    const first = await memoryImport({ data });
    if (!first.success) throw new Error(first.error);
    expect((first.data as { imported: { learningsHistory: number }; skipped: { historyMissingLearning: number } }).imported.learningsHistory).toBe(1);
    expect((first.data as { skipped: { historyMissingLearning: number } }).skipped.historyMissingLearning).toBe(1);
    expect((await versions(id)).map((v) => v.content)).toEqual(['Old text.']);

    const second = await memoryImport({ data });
    if (!second.success) throw new Error(second.error);
    expect((second.data as { imported: { learningsHistory: number } }).imported.learningsHistory).toBe(0);
  });
});
