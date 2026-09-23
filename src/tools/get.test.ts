/**
 * Tests for memory_get: full text of learnings and decisions by id.
 *
 * By hand against a scratch store (MEMORY_DB_PATH pointing at an empty file):
 *   memory_learn({category: 'pattern', content: 'alpha'})  -> data.id = L
 *   memory_get({ids: [L, 'nope']})
 *   -> { results: [{ type: 'learning', id: L, content: 'alpha', archived: false, ... }], missing: ['nope'], ambiguous: [] }
 *   memory_get({ids: [L.slice(0, 8)]})
 *   -> { results: [{ type: 'learning', id: L, ... }], missing: [], ambiguous: [] }
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
  ambiguous: Array<{ id: string; candidates: string[] }>;
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

  it('counts an open in usage_count and last_used', async () => {
    const { memoryGet } = await import('./get.js');
    const { getDb } = await import('../db/client.js');
    const learningId = await storeLearning('read me');
    const row = () =>
      getDb().prepare('SELECT usage_count, last_used FROM learnings WHERE id = ?').get(learningId) as {
        usage_count: number;
        last_used: string | null;
      };
    expect(row()).toMatchObject({ usage_count: 0, last_used: null });

    memoryGet({ ids: [learningId] });
    expect(row().usage_count).toBe(1);
    expect(row().last_used).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    memoryGet({ ids: [learningId, learningId] });
    expect(row().usage_count).toBe(2);
  });

  it('counts only the learnings it found', async () => {
    const { memoryGet } = await import('./get.js');
    const { getDb } = await import('../db/client.js');
    const first = await storeLearning('one');
    const second = await storeLearning('two');
    const untouched = await storeLearning('not asked for');
    const decisionId = await storeDecision();

    memoryGet({ ids: [first, second, decisionId, 'no-such-id'] });
    const usage = (id: string) =>
      (getDb().prepare('SELECT usage_count FROM learnings WHERE id = ?').get(id) as { usage_count: number }).usage_count;
    expect([usage(first), usage(second), usage(untouched)]).toEqual([1, 1, 0]);
  });

  it('opens a session by id, with the summary a brief start truncates', async () => {
    const { memoryGet } = await import('./get.js');
    const { sessionStart, sessionEnd } = await import('./session.js');
    const started = await sessionStart({ project: 'alpha' });
    if (!started.success) throw new Error('setup failed');
    const sessionId = (started.data as { sessionId: string }).sessionId;
    const summary = 'First paragraph, which a brief start shows.\n\nSecond paragraph, which it cuts.';
    sessionEnd({ sessionId, summary, tasks: ['open task'] });

    const result = memoryGet({ ids: [sessionId] });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const d = result.data as GetData;
    expect(d.missing).toEqual([]);
    expect(d.results[0]).toMatchObject({
      type: 'session',
      id: sessionId,
      project: 'alpha',
      summary,
      tasks: ['open task'],
    });
    expect(d.results[0]!.ended_at).toBeTruthy();
  });

  it('returns a repeated id once', async () => {
    const { memoryGet } = await import('./get.js');
    const learningId = await storeLearning('once');
    const result = memoryGet({ ids: [learningId, learningId] });
    if (!result.success) throw new Error('memoryGet failed');
    expect((result.data as GetData).results.length).toBe(1);
  });
});

describe('memoryGet by id prefix', () => {
  // Test scaffolding: sessions with hand-made ids, so two of them share a prefix.
  async function insertSession(id: string): Promise<void> {
    const { getDb } = await import('../db/client.js');
    getDb().prepare('INSERT INTO sessions (id, summary) VALUES (?, ?)').run(id, `session ${id}`);
  }

  it('opens an entry by a unique 8-character prefix and reports its full id', async () => {
    const { memoryGet } = await import('./get.js');
    const { getDb } = await import('../db/client.js');
    const learningId = await storeLearning('opened by prefix');

    const result = memoryGet({ ids: [learningId.slice(0, 8)] });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const d = result.data as GetData;
    expect(d).toMatchObject({ missing: [], ambiguous: [] });
    expect(d.results).toHaveLength(1);
    expect(d.results[0]).toMatchObject({ type: 'learning', id: learningId, content: 'opened by prefix' });
    const usage = getDb().prepare('SELECT usage_count FROM learnings WHERE id = ?').get(learningId) as { usage_count: number };
    expect(usage.usage_count).toBe(1);
  });

  it('opens by a longer prefix, dashes and upper case included', async () => {
    const { memoryGet } = await import('./get.js');
    const decisionId = await storeDecision();
    const result = memoryGet({ ids: [decisionId.slice(0, 13).toUpperCase()] });
    if (!result.success) throw new Error('memoryGet failed');
    expect((result.data as GetData).results.map((r) => r.id)).toEqual([decisionId]);
  });

  it('lists a prefix shared by two entries in ambiguous with both full ids, never a guess', async () => {
    const { memoryGet } = await import('./get.js');
    const first = 'abcdef12-0000-4000-8000-000000000001';
    const second = 'abcdef12-0000-4000-8000-000000000002';
    await insertSession(second);
    await insertSession(first);

    const result = memoryGet({ ids: ['abcdef12'] });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({
      results: [],
      missing: [],
      ambiguous: [{ id: 'abcdef12', candidates: [first, second] }],
    });
    expect(result.message).toBe('0 found, 1 ambiguous.');
  });

  it('treats a 7-character prefix as missing', async () => {
    const { memoryGet } = await import('./get.js');
    const learningId = await storeLearning('too short to open');
    const short = learningId.slice(0, 7);
    const result = memoryGet({ ids: [short] });
    if (!result.success) throw new Error('memoryGet failed');
    expect(result.data).toEqual({ results: [], missing: [short], ambiguous: [] });
  });

  it('lists a prefix that matches nothing in missing', async () => {
    const { memoryGet } = await import('./get.js');
    await insertSession('abcdef12-0000-4000-8000-000000000001');
    const result = memoryGet({ ids: ['12345678'] });
    if (!result.success) throw new Error('memoryGet failed');
    expect(result.data).toEqual({ results: [], missing: ['12345678'], ambiguous: [] });
  });

  it('resolves each id of a mixed call and returns an entry asked for twice once', async () => {
    const { memoryGet } = await import('./get.js');
    const learningId = await storeLearning('mixed');
    const decisionId = await storeDecision();
    await insertSession('abcdef12-0000-4000-8000-000000000001');
    await insertSession('abcdef12-0000-4000-8000-000000000002');

    const result = memoryGet({ ids: [decisionId.slice(0, 8), learningId, learningId.slice(0, 8), 'abcdef12', 'no-such-id'] });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const d = result.data as GetData;
    expect(d.results.map((r) => r.id)).toEqual([decisionId, learningId]);
    expect(d.missing).toEqual(['no-such-id']);
    expect(d.ambiguous.map((a) => a.id)).toEqual(['abcdef12']);
    expect(result.message).toBe('2 found, 1 missing, 1 ambiguous.');
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
