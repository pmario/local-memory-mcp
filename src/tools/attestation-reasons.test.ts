/**
 * Style as attestation, re-check reasons (local-memory-mcp-zpz): style ["atomic", "factual"] stays required on a new
 * text and a content rewrite, but is not stored, returned, filtered or counted; a factual text that cites a scratch path
 * is refused with the paths; the re-check queue names its reasons per check.
 *
 * Replicate by hand through the MCP tools:
 *   memory_learn({category: "pattern", content: "Probe in E:/tmp/p.js.", style: ["atomic", "factual"]})
 *     // refused, code SCRATCH_PATH, the error names E:/tmp/p.js
 *   memory_health()   // recheck.next entries read [id8, score, reads, {factual: [...], atomic: [...]}]
 * The direct SQL below reads and sets columns no tool exposes; it is test scaffolding.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHECKED = ['atomic', 'factual'] as const;

let tmp = '';
beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'local-memory-attest-'));
  process.env.MEMORY_DB_PATH = join(tmp, 'test.sqlite');
  (await import('../db/client.js')).getDb();
});
afterEach(async () => {
  const { closeDb } = await import('../db/client.js');
  closeDb();
  delete process.env.MEMORY_DB_PATH;
  rmSync(tmp, { recursive: true, force: true });
});

async function learnResult(content: string, extra: Record<string, unknown> = {}) {
  const { learn } = await import('./learn.js');
  return learn({ category: 'research', content, style: [...CHECKED], ...extra } as Parameters<typeof learn>[0]);
}

async function store(content: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await learnResult(content, extra);
  if (!r.success) throw new Error(r.error);
  return (r.data as { id: string }).id;
}

async function column(id: string): Promise<{ style_json: string; content: string }> {
  const { getDb } = await import('../db/client.js');
  return getDb().prepare('SELECT style_json, content FROM learnings WHERE id = ?').get(id) as { style_json: string; content: string };
}

async function count(): Promise<number> {
  const { getDb } = await import('../db/client.js');
  return (getDb().prepare('SELECT COUNT(*) AS n FROM learnings').get() as { n: number }).n;
}

describe('style is an attestation, not stored', () => {
  it('stores no style for a new learning, and memory_get shows none', async () => {
    const { memoryGet } = await import('./get.js');
    const id = await store('Measured in 3 of 3 runs of `x.test.ts`.');
    expect((await column(id)).style_json).toBe('[]');
    const r = memoryGet({ ids: [id] });
    if (!r.success) throw new Error(r.error);
    expect((r.data as { results: Array<Record<string, unknown>> }).results[0]).not.toHaveProperty('style');
  });

  it('leaves the stored column as it was on a content rewrite, for the Markdown sync', async () => {
    const { learnUpdate } = await import('./learn.js');
    const id = await store('First text, 1 run.');
    (await import('../db/client.js')).getDb().prepare(`UPDATE learnings SET style_json = '["atomic"]' WHERE id = ?`).run(id);
    const r = await learnUpdate({ learningId: id, content: 'Second text, 2 runs.', style: [...CHECKED] });
    expect(r.success).toBe(true);
    expect(await column(id)).toEqual({ style_json: '["atomic"]', content: 'Second text, 2 runs.' });
  });

  it('refuses an update that passes only a style', async () => {
    const { learnUpdate } = await import('./learn.js');
    const id = await store('Text, 1 run.');
    const r = await learnUpdate({ learningId: id, style: [...CHECKED] });
    expect(r.success).toBe(false);
  });

  it('no longer offers style filters or style counts', async () => {
    const { toMcpToolList } = await import('./registry.js');
    const { health } = await import('./insights.js');
    const tools = toMcpToolList();
    for (const name of ['memory_search', 'memory_recall']) {
      const props = (tools.find((t) => t.name === name)!.inputSchema as { properties: Record<string, unknown> }).properties;
      expect(props, name).not.toHaveProperty('style');
      expect(props, name).not.toHaveProperty('excludeStyle');
    }
    const h = health();
    if (!h.success) throw new Error(h.error);
    expect(h.data).not.toHaveProperty('styles');
  });

  it('says in the write tools that the style is an attestation and is not stored', async () => {
    const { toMcpToolList } = await import('./registry.js');
    const learn = toMcpToolList().find((t) => t.name === 'memory_learn')!;
    expect(learn.description).toContain('not stored');
  });
});

describe('a factual text that cites a scratch path is refused', () => {
  it('memory_learn refuses it, names the path and why, and writes nothing', async () => {
    const before = await count();
    const r = await learnResult('Probe in E:/tmp/p.js gave 3.');
    expect(r).toMatchObject({ success: false, code: 'SCRATCH_PATH' });
    if (r.success) return;
    expect(r.error).toContain('E:/tmp/p.js');
    expect(r.error).toContain('versioned');
    expect(await count()).toBe(before);
  });

  it('memory_learn_update refuses a rewrite that adds one, and leaves the row alone', async () => {
    const { learnUpdate } = await import('./learn.js');
    const id = await store('Measured in 3 runs.');
    const r = await learnUpdate({ learningId: id, content: 'Measured in 3 runs, log at /tmp/run.log.', style: [...CHECKED] });
    expect(r).toMatchObject({ success: false, code: 'SCRATCH_PATH' });
    expect((await column(id)).content).toBe('Measured in 3 runs.');
  });

  it('memory_learn_bulk refuses the whole batch, like any item refusal, naming the item and the path', async () => {
    const { learnBulk } = await import('./learn.js');
    const before = await count();
    const r = await learnBulk({
      items: [
        { category: 'research', content: 'Clean item, 2 runs.', style: [...CHECKED] },
        { category: 'research', content: 'Dirty item, see E:/tmp/x.txt.', style: [...CHECKED] },
      ],
    });
    expect(r).toMatchObject({ success: false, code: 'SCRATCH_PATH' });
    if (r.success) return;
    expect(r.error).toMatch(/^Item 1: .*E:\/tmp\/x\.txt/);
    expect(await count()).toBe(before);
  });

  it('stores a text not declared factual, a direct call without style, with the notice', async () => {
    const r = await learnResult('Probe in E:/tmp/p.js gave 3.', { style: undefined });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect((r.data as { notice?: string }).notice).toMatch(/^factual: .*E:\/tmp\/p\.js/);
  });
});

describe('write-time notices name their check', () => {
  it('memory_learn notices a story and a date list, each with its check', async () => {
    const r = await learnResult('It turned out stale on 2026-01-01, 2026-01-02 and 2026-01-03.');
    if (!r.success) throw new Error(r.error);
    const notice = (r.data as { notice?: string }).notice!;
    expect(notice).toMatch(/factual: .*turned out/);
    expect(notice).toMatch(/atomic: .*2026-01-01/);
  });
});

describe('memory_health: the re-check queue names its reasons per check', () => {
  it('lists [id8, score, reads, reasons] with the reasons grouped by check, priors left out', async () => {
    const { health } = await import('./insights.js');
    const id = await store('It probably holds, and it turned out so on 2026-01-01, 2026-01-02 and 2026-01-03.', { category: 'workflow' });
    const h = health();
    if (!h.success) throw new Error(h.error);
    const next = (h.data as { recheck: { next: unknown[][] } }).recheck.next;
    const entry = next.find((e) => e[0] === id.slice(0, 8))!;
    expect(entry).toBeDefined();
    expect(entry[3]).toEqual({ factual: ['hedge', 'story'], atomic: ['dates'] });
  });
});
