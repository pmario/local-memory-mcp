/**
 * Default fields in memory_recall and memory_search (local-memory-mcp-2mi rule, extended): a field at its default is left
 * out, as memory_get does, so a plain hit carries only what it says.
 * Replicate by hand: memory_learn({category: "pattern", content: "plain", style: ["atomic", "factual"]}), then
 * memory_recall({detail: "brief"}) -> [{id, date, category, headline}], no project, confidence or memory_type.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmp = '';
beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'local-memory-read-defaults-'));
  process.env.MEMORY_DB_PATH = join(tmp, 'test.sqlite');
  (await import('../db/client.js')).getDb();
});
afterEach(async () => {
  const { closeDb } = await import('../db/client.js');
  closeDb();
  delete process.env.MEMORY_DB_PATH;
  rmSync(tmp, { recursive: true, force: true });
});

async function store(content: string, extra: Record<string, unknown> = {}): Promise<string> {
  const { learn } = await import('./learn.js');
  const r = await learn({ category: 'pattern', content, style: ['atomic', 'factual'], memoryType: 'semantic', ...extra });
  if (!r.success) throw new Error(r.error);
  return (r.data as { id: string }).id;
}

async function recallHits(input: Record<string, unknown>) {
  const { recall, recallSchema } = await import('./learn.js');
  const r = recall(recallSchema.parse(input));
  if (!r.success) throw new Error(r.error);
  return (r.data as { results: Array<Record<string, unknown>> }).results;
}

describe('memory_recall leaves out fields at their default', () => {
  it('shows a plain learning with id, date, category and headline only', async () => {
    await store('Plain okapi fact, 2 runs.');
    const [hit] = await recallHits({ detail: 'brief' });
    expect(Object.keys(hit!).sort()).toEqual(['category', 'date', 'headline', 'id']);
  });

  it('shows project, confidence and memory type when they differ from the default', async () => {
    await store('Rich okapi fact, 2 runs.', { project: 'p', confidence: 0.9, memoryType: 'episodic' });
    const [hit] = await recallHits({ query: 'okapi', detail: 'brief' });
    expect(hit).toMatchObject({ project: 'p', confidence: 0.9, memory_type: 'episodic' });
  });
});

describe('memory_search leaves out a requestedMode equal to mode', () => {
  it('shows only mode when the search ran as requested', async () => {
    const { search } = await import('./search.js');
    await store('Okapi search target, 1 run.');
    const r = await search({ query: 'okapi', mode: 'fts' });
    if (!r.success) throw new Error(r.error);
    expect(r.data).toMatchObject({ mode: 'fts' });
    expect(r.data).not.toHaveProperty('requestedMode');
  });
});
