/**
 * Tests for memory_get: full text of learnings and decisions by id.
 *
 * By hand against a scratch store (MEMORY_DB_PATH pointing at an empty file):
 *   memory_learn({category: 'pattern', content: 'alpha'})  -> data.id = L
 *   memory_get({ids: [L, 'nope']})
 *   -> { results: [{ type: 'learning', id: L, content: 'alpha', archived: false, ... }], missing: ['nope'] }
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmp = '';
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'local-memory-get-'));
  process.env.MEMORY_DB_PATH = join(tmp, 'test.sqlite');
});
afterEach(async () => {
  const { closeDb } = await import('../db/client.js');
  closeDb();
  delete process.env.MEMORY_DB_PATH;
  rmSync(tmp, { recursive: true, force: true });
});

type GetData = {
  results: Array<Record<string, unknown> & { type: string; id: string }>;
  missing: string[];
};

async function storeLearning(content: string): Promise<string> {
  const { learn } = await import('./learn.js');
  const r = await learn({ category: 'pattern', content, tags: ['t1'] });
  if (!r.success) throw new Error('setup failed');
  return (r.data as { id: string }).id;
}

async function storeDecision(): Promise<string> {
  const { decide } = await import('./decide.js');
  const r = await decide({ title: 'Database choice', decision: 'SQLite', reasoning: 'local file', alternatives: 'Postgres' });
  if (!r.success) throw new Error('setup failed');
  return (r.data as { id: string }).id;
}

describe('memoryGet', () => {
  it('returns the full rows of a learning and a decision, in the order asked', async () => {
    const { memoryGet } = await import('./get.js');
    const long = 'first line\n' + 'x'.repeat(5000);
    const learningId = await storeLearning(long);
    const decisionId = await storeDecision();

    const result = memoryGet({ ids: [decisionId, learningId] });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const d = result.data as GetData;
    expect(d.missing).toEqual([]);
    expect(d.results.map((r) => r.id)).toEqual([decisionId, learningId]);
    expect(d.results[0]).toMatchObject({
      type: 'decision',
      title: 'Database choice',
      decision: 'SQLite',
      reasoning: 'local file',
      alternatives: 'Postgres',
    });
    expect(d.results[1]).toMatchObject({ type: 'learning', category: 'pattern', content: long, tags: ['t1'], archived: false });
  });

  it('lists unknown ids in missing', async () => {
    const { memoryGet } = await import('./get.js');
    const learningId = await storeLearning('known');
    const result = memoryGet({ ids: [learningId, 'no-such-id'] });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const d = result.data as GetData;
    expect(d.results.map((r) => r.id)).toEqual([learningId]);
    expect(d.missing).toEqual(['no-such-id']);
  });

  it('returns an archived learning, marked archived', async () => {
    const { memoryGet } = await import('./get.js');
    const { learnArchive } = await import('./learn.js');
    const learningId = await storeLearning('retired fact');
    learnArchive({ learningId, reason: 'superseded' });

    const result = memoryGet({ ids: [learningId] });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const d = result.data as GetData;
    expect(d.missing).toEqual([]);
    expect(d.results[0]).toMatchObject({ id: learningId, content: 'retired fact', archived: true });
  });

  it('does not bump the usage counter', async () => {
    const { memoryGet } = await import('./get.js');
    const { getDb } = await import('../db/client.js');
    const learningId = await storeLearning('read me');
    const usage = () =>
      (getDb().prepare('SELECT usage_count FROM learnings WHERE id = ?').get(learningId) as { usage_count: number }).usage_count;
    const before = usage();
    memoryGet({ ids: [learningId] });
    expect(usage()).toBe(before);
  });

  it('returns a repeated id once', async () => {
    const { memoryGet } = await import('./get.js');
    const learningId = await storeLearning('once');
    const result = memoryGet({ ids: [learningId, learningId] });
    if (!result.success) throw new Error('memoryGet failed');
    expect((result.data as GetData).results.length).toBe(1);
  });
});

describe('memoryGet schema', () => {
  it('accepts 1 to 20 ids and rejects 0 or 21', async () => {
    const { getSchema } = await import('./get.js');
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);
    expect(getSchema.safeParse({ ids: ids(1) }).success).toBe(true);
    expect(getSchema.safeParse({ ids: ids(20) }).success).toBe(true);
    expect(getSchema.safeParse({ ids: ids(0) }).success).toBe(false);
    expect(getSchema.safeParse({ ids: ids(21) }).success).toBe(false);
  });
});

describe('memory_get registration', () => {
  it('is registered as a read-only, idempotent tool that requires ids', async () => {
    const { toMcpToolList } = await import('./registry.js');
    const tool = toMcpToolList().find((t) => t.name === 'memory_get');
    expect(tool).toBeDefined();
    expect(tool!.annotations).toEqual({ readOnlyHint: true, idempotentHint: true, openWorldHint: false });
    expect((tool!.inputSchema as { required?: string[] }).required).toEqual(['ids']);
  });
});
