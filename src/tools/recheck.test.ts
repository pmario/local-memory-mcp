/**
 * Re-check support (local-memory-mcp-w8u): write-time notices for defects a writer can fix while the text is
 * in context, a re-checked mark that a content change clears, a read counter that counts only deliveries of the
 * full text, and the re-check queue in memory_health.
 *
 * Replicate by hand through the MCP tools:
 *   memory_learn({category: "pattern", content: "It probably holds. Probe in E:/tmp/p.js.", style: ["atomic", "factual"]})
 *     // data.notice names the scratch path and the hedge
 *   memory_learn_update({learningId, rechecked: true})   // memory_get shows recheckedAt
 *   memory_get({ids: [id]})                              // counts one read; memory_health lists the queue, most-read first
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHECKED = ['atomic', 'factual'] as const;

let tmp = '';
beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'local-memory-recheck-'));
  process.env.MEMORY_DB_PATH = join(tmp, 'test.sqlite');
  (await import('../db/client.js')).getDb();
});
afterEach(async () => {
  const { closeDb } = await import('../db/client.js');
  closeDb();
  delete process.env.MEMORY_DB_PATH;
  rmSync(tmp, { recursive: true, force: true });
});

async function learnData(content: string, extra: Record<string, unknown> = {}) {
  const { learn } = await import('./learn.js');
  const r = await learn({ category: 'research', content, style: [...CHECKED], ...extra });
  if (!r.success) throw new Error(r.error);
  return r.data as { id: string; notice?: string };
}

async function store(content: string, extra: Record<string, unknown> = {}): Promise<string> {
  return (await learnData(content, extra)).id;
}

async function update(input: Record<string, unknown>) {
  const { learnUpdate } = await import('./learn.js');
  const r = await learnUpdate(input as Parameters<typeof learnUpdate>[0]);
  if (!r.success) throw new Error(r.error);
  return r.data as { notice?: string };
}

async function row(id: string) {
  const { getDb } = await import('../db/client.js');
  return getDb().prepare('SELECT rechecked_at, read_count, usage_count FROM learnings WHERE id = ?').get(id) as {
    rechecked_at: string | null;
    read_count: number;
    usage_count: number;
  };
}

describe('write-time notices', () => {
  it('memory_learn names a scratch path and a hedge, and stays quiet on a measured text', async () => {
    const bad = await learnData('The walk stops early, probably at the import. Probe at e:/tmp/toc/probe.js.');
    expect(bad.notice).toContain('e:/tmp/toc/probe.js');
    expect(bad.notice).toContain('probably');
    expect((await learnData('The walk stops at the import. Measured 2026-08-01 on master.')).notice).toBeUndefined();
  });

  it('memory_learn_update notices a paragraph inserted before the links, but not an added link alone', async () => {
    const id = await store('Rule.\n\nCase one.\n\nRelated: [[aaaaaaaa]].');
    const inserted = await update({ learningId: id, content: 'Rule.\n\nCase one.\n\nA later finding.\n\nRelated: [[aaaaaaaa]].', style: [...CHECKED] });
    expect(inserted.notice).toContain('first line');
    const linked = await update({ learningId: id, content: 'Rule.\n\nCase one.\n\nA later finding.\n\nRelated: [[aaaaaaaa]], [[bbbbbbbb]].', style: [...CHECKED] });
    expect(linked).not.toHaveProperty('notice');
  });

  it('memory_learn_update names a hedge in the new text', async () => {
    const id = await store('Rule.');
    expect((await update({ learningId: id, content: 'Rule, which likely holds on Linux.', style: [...CHECKED] })).notice).toContain('likely');
  });

  it('memory_learn_bulk puts the notice on the item that needs it', async () => {
    const { learnBulk } = await import('./learn.js');
    const r = await learnBulk({
      items: [
        { category: 'research', content: 'Clean measured item.', style: [...CHECKED] },
        { category: 'research', content: 'Evidence in /tmp/run.log.', style: [...CHECKED] },
      ],
    });
    if (!r.success) throw new Error(r.error);
    const results = (r.data as { results: Array<{ index: number; notice?: string }> }).results;
    expect(results[0]).not.toHaveProperty('notice');
    expect(results[1]!.notice).toContain('/tmp/run.log');
  });
});

describe('re-checked mark', () => {
  it('is set by rechecked: true alone and shown by memory_get', async () => {
    const { memoryGet } = await import('./get.js');
    const id = await store('A checked rule.');
    expect((await row(id)).rechecked_at).toBeNull();
    await update({ learningId: id, rechecked: true });
    const at = (await row(id)).rechecked_at;
    expect(at).not.toBeNull();
    const got = memoryGet({ ids: [id] });
    if (!got.success) throw new Error(got.error);
    expect((got.data as { results: Array<{ recheckedAt?: string }> }).results[0]!.recheckedAt).toBe(at);
  });

  it('survives a style-only update and is cleared by a content change without rechecked', async () => {
    const id = await store('A rule with a closing maxim.');
    await update({ learningId: id, rechecked: true });
    await update({ learningId: id, style: ['atomic'] });
    expect((await row(id)).rechecked_at).not.toBeNull();
    await update({ learningId: id, content: 'A rule, rewritten.', style: [...CHECKED] });
    expect((await row(id)).rechecked_at).toBeNull();
    await update({ learningId: id, content: 'A rule, rewritten after its re-check.', style: [...CHECKED], rechecked: true });
    expect((await row(id)).rechecked_at).not.toBeNull();
    await update({ learningId: id, rechecked: false });
    expect((await row(id)).rechecked_at).toBeNull();
  });
});

describe('read counter', () => {
  it('counts memory_get, but not an update, which usage_count counts', async () => {
    const { memoryGet } = await import('./get.js');
    const id = await store('Counted entry.');
    memoryGet({ ids: [id] });
    memoryGet({ ids: [id] });
    await update({ learningId: id, confidence: 0.9 });
    expect(await row(id)).toMatchObject({ read_count: 2, usage_count: 3 });
  });

  it('counts full search and recall results, not brief ones', async () => {
    const { search } = await import('./search.js');
    const { recall } = await import('./learn.js');
    const id = await store('Zebra crossings count reads.');
    await search({ query: 'zebra', mode: 'fts' });
    await search({ query: 'zebra', mode: 'fts', detail: 'brief' });
    recall({ query: 'zebra' });
    recall({ query: 'zebra', detail: 'brief' });
    expect((await row(id)).read_count).toBe(2);
  });

  it('counts the learnings a full session start delivers, not the brief headlines', async () => {
    const { sessionStart } = await import('./session.js');
    const id = await store('Recent entry.');
    sessionStart({ detail: 'brief' });
    sessionStart({ detail: 'full' });
    expect((await row(id)).read_count).toBe(1);
  });
});

describe('memory_health: the re-check queue', () => {
  it('lists flagged entries not re-checked since their last change, most-read first', async () => {
    const { health } = await import('./insights.js');
    const { memoryGet } = await import('./get.js');
    const { learnArchive } = await import('./learn.js');
    await store('The X operator returns Y. From editions/tw5.com/tiddlers/x.tid, read 2026-08-17.');
    await store('The V operator probably returns U. From the docs.');
    // hedge, owner, handoffs and work-session: score 4.
    const risky = await store('The Y operator probably returns Z; the maintainer reported it (HANDOFF_A_x_2026-07-01.md, HANDOFF_B_y_2026-07-02.md).', { category: 'insight' });
    const scratch = await store('The Z operator returns W. Probe at E:/tmp/z.js.');
    const rechecked = await store('The W operator returns V. Probe at E:/tmp/w.js.');
    await update({ learningId: rechecked, rechecked: true });
    learnArchive({ learningId: await store('Archived. Probe at E:/tmp/a.js.') });
    for (let i = 0; i < 3; i++) memoryGet({ ids: [risky] });
    memoryGet({ ids: [scratch] });

    const r = health();
    if (!r.success) throw new Error(r.error);
    const recheck = (r.data as { recheck: { pending: number; flagged: number; next: Array<[string, number, number, string?]> } }).recheck;
    expect(recheck.pending).toBe(4);
    expect(recheck.flagged).toBe(2);
    expect(recheck.next).toEqual([
      [risky.slice(0, 8), 4, 3],
      [scratch.slice(0, 8), 0, 1, 'scratch'],
    ]);
  });
});

describe('export, import and older stores', () => {
  it('carries recheckedAt and readCount through an export and import round trip', async () => {
    const { memoryExport, memoryImport } = await import('./export.js');
    const { memoryGet } = await import('./get.js');
    const id = await store('Round-tripped entry.');
    await update({ learningId: id, rechecked: true });
    memoryGet({ ids: [id] });
    const before = await row(id);
    const exported = memoryExport({});
    if (!exported.success) throw new Error(exported.error);
    const envelope = exported.data as { learnings: Array<{ id: string; recheckedAt?: string | null; readCount?: number }> };
    expect(envelope.learnings.find((l) => l.id === id)).toMatchObject({ recheckedAt: before.rechecked_at, readCount: 1 });

    const { closeDb } = await import('../db/client.js');
    closeDb();
    process.env.MEMORY_DB_PATH = join(tmp, 'imported.sqlite');
    expect((await memoryImport({ data: envelope as unknown as Record<string, unknown> })).success).toBe(true);
    expect(await row(id)).toMatchObject({ rechecked_at: before.rechecked_at, read_count: 1 });
  });

  it('adds both columns to a store created before they existed', async () => {
    const { getDb, closeDb } = await import('../db/client.js');
    const id = await store('entry from before the columns');
    getDb().exec('ALTER TABLE learnings DROP COLUMN rechecked_at; ALTER TABLE learnings DROP COLUMN read_count');
    closeDb();
    expect(await row(id)).toMatchObject({ rechecked_at: null, read_count: 0 });
  });
});
