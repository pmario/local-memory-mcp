/**
 * memory_recall's signal filter and sort (local-memory-mcp-y0l): signal lists the learnings a re-check signal fires on,
 * each naming what matched; sort orders by read count, use count or ACT-R activation, and shows those numbers.
 *
 * Replicate by hand through the MCP tools:
 *   memory_recall({signal: ["scratch"], detail: "brief"})   // a hit carries signals: {factual: {scratch: ["E:/tmp/p.js"]}}
 *   memory_recall({sort: "reads", detail: "brief"})         // most-read first, each with reads and uses
 * The direct SQL below sets counters and dates, which no tool writes; it is test scaffolding. A factual write that cites
 * a scratch path is refused, so storeUnattested() stands for an entry written before that refusal.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmp = '';
beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'local-memory-recall-signal-'));
  process.env.MEMORY_DB_PATH = join(tmp, 'test.sqlite');
  (await import('../db/client.js')).getDb();
});
afterEach(async () => {
  const { closeDb } = await import('../db/client.js');
  closeDb();
  delete process.env.MEMORY_DB_PATH;
  rmSync(tmp, { recursive: true, force: true });
});

type Hit = Record<string, unknown> & { id: string; signals?: Record<string, Record<string, string[]>> };

async function store(content: string, extra: Record<string, unknown> = {}): Promise<string> {
  const { learn } = await import('./learn.js');
  const r = await learn({ category: 'pattern', content, style: ['atomic', 'factual'], ...extra });
  if (!r.success) throw new Error(r.error);
  return (r.data as { id: string }).id;
}

const storeUnattested = (content: string, extra: Record<string, unknown> = {}) => store(content, { ...extra, style: undefined });

async function recallHits(input: Record<string, unknown>): Promise<Hit[]> {
  const { recall, recallSchema } = await import('./learn.js');
  const r = recall(recallSchema.parse(input));
  if (!r.success) throw new Error(r.error);
  return (r.data as { results: Hit[] }).results;
}

async function sql(statement: string, ...args: unknown[]) {
  (await import('../db/client.js')).getDb().prepare(statement).run(...args);
}

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

describe('memory_recall signal', () => {
  it('lists only the learnings that cite a scratch path, with the paths, re-checked ones included', async () => {
    const plain = await store('Measured in the repository tests.');
    const one = await storeUnattested('Probe in E:/tmp/p.js gave 3.');
    const two = await storeUnattested('Log at /tmp/run.log and E:\\tmp\\x\\y.txt.');
    await sql("UPDATE learnings SET rechecked_at = '2026-01-01 00:00:00' WHERE id = ?", two);

    const hits = await recallHits({ signal: ['scratch'], detail: 'brief' });
    expect(hits.map((h) => h.id).sort()).toEqual([one, two].sort());
    expect(hits.find((h) => h.id === one)!.signals).toEqual({ factual: { scratch: ['E:/tmp/p.js'] } });
    expect(hits.find((h) => h.id === two)!.signals!.factual!.scratch!.sort()).toEqual(['/tmp/run.log', 'E:\\tmp\\x\\y.txt'].sort());
    expect(hits.find((h) => h.id === two)!.recheckedAt).toBe('2026-01-01 00:00:00');
    expect(hits.map((h) => h.id)).not.toContain(plain);
  });

  it('names the hedge words, and only the requested signals that fired', async () => {
    const both = await storeUnattested('It probably holds; probe in E:/tmp/p.js.');
    const hedgeOnly = await store('It likely holds.');

    const hits = await recallHits({ signal: ['scratch', 'hedge'] });
    expect(hits.find((h) => h.id === both)!.signals).toEqual({ factual: { scratch: ['E:/tmp/p.js'], hedge: ['probably'] } });
    expect(hits.find((h) => h.id === hedgeOnly)!.signals).toEqual({ factual: { hedge: ['likely'] } });
  });

  it('names the branch, and puts a prior with an empty list under other', async () => {
    const branchId = await store('Built from branch feat/x-y at its head.');
    const ownerId = await store('The maintainer ruled it in 1 review.');
    expect(await recallHits({ signal: ['branch'] })).toEqual([expect.objectContaining({ id: branchId, signals: { factual: { branch: ['branch feat/x-y'] } } })]);
    expect(await recallHits({ signal: ['owner'] })).toEqual([expect.objectContaining({ id: ownerId, signals: { other: { owner: [] } } })]);
  });

  it('finds a history signal: an update that appended a paragraph', async () => {
    const { learnUpdate } = await import('./learn.js');
    const id = await store('First claim.');
    await store('Untouched claim.');
    await learnUpdate({ learningId: id, content: 'First claim.\n\nA second subject added later.', style: ['atomic', 'factual'] });

    expect((await recallHits({ signal: ['append'] })).map((h) => h.id)).toEqual([id]);
  });

  it('combines with query and project, skips archived learnings, and applies limit after filtering', async () => {
    const { learnArchive } = await import('./learn.js');
    const wanted = await storeUnattested('Heron count probe in E:/tmp/a.js.', { project: 'birds' });
    await storeUnattested('Heron count probe in E:/tmp/b.js.', { project: 'fish' });
    await store('Heron count measured in tests.', { project: 'birds' });
    const archived = await storeUnattested('Heron count probe in E:/tmp/c.js.', { project: 'birds' });
    learnArchive({ learningId: archived, reason: 'superseded' });

    expect((await recallHits({ query: 'heron', project: 'birds', signal: ['scratch'] })).map((h) => h.id)).toEqual([wanted]);

    for (let i = 0; i < 5; i++) await store(`Unrelated measured fact ${i}.`);
    expect(await recallHits({ signal: ['scratch'], limit: 2 })).toHaveLength(2);
  });

  it('accepts every re-check signal id and refuses an unknown one', async () => {
    const { recallSchema } = await import('./learn.js');
    const { SIGNALS } = await import('../signals/index.js');
    for (const s of SIGNALS) expect(recallSchema.safeParse({ signal: [s.id] }).success, s.id).toBe(true);
    expect(recallSchema.safeParse({ signal: ['nope'] }).success).toBe(false);
  });
});

describe('memory_recall sort', () => {
  it('sorts by read count or use count, most first, and shows both numbers', async () => {
    const a = await store('Fact a.');
    const b = await store('Fact b.');
    const c = await store('Fact c.');
    await sql('UPDATE learnings SET read_count = 5, usage_count = 1 WHERE id = ?', a);
    await sql('UPDATE learnings SET read_count = 1, usage_count = 9 WHERE id = ?', b);
    await sql('UPDATE learnings SET read_count = 3, usage_count = 4 WHERE id = ?', c);

    const byReads = await recallHits({ sort: 'reads', detail: 'brief' });
    expect(byReads.map((h) => h.id)).toEqual([a, c, b]);
    expect(byReads[0]).toMatchObject({ reads: 5, uses: 1 });
    expect((await recallHits({ sort: 'uses', detail: 'brief' })).map((h) => h.id)).toEqual([b, c, a]);
  });

  it('sorts by activation: recent and frequent reads first, a learning never read last and without activation', async () => {
    const recent = await store('Read often, lately.');
    const old = await store('Read often, long ago.');
    const never = await store('Never read.');
    await sql("INSERT OR REPLACE INTO meta (key, value) VALUES ('reads_since', ?)", daysAgo(100));
    await sql('UPDATE learnings SET date = ?, read_count = 20, last_used = ? WHERE id = ?', daysAgo(60), daysAgo(1), recent);
    await sql('UPDATE learnings SET date = ?, read_count = 20, last_used = ? WHERE id = ?', daysAgo(60), daysAgo(50), old);
    await sql('UPDATE learnings SET date = ? WHERE id = ?', daysAgo(60), never);

    const hits = await recallHits({ sort: 'activation', detail: 'brief' });
    expect(hits.map((h) => h.id)).toEqual([recent, old, never]);
    expect(hits[0]!.activation).toEqual(expect.any(Number));
    expect(hits[0]!.activation as number).toBeGreaterThan(hits[1]!.activation as number);
    expect(hits[2]).not.toHaveProperty('activation');
  });

  it('counts a learning older than the read counter from the counter start', async () => {
    const ancient = await store('Created long before reads were counted.');
    const fresh = await store('Created when reads started being counted.');
    await sql("INSERT OR REPLACE INTO meta (key, value) VALUES ('reads_since', ?)", daysAgo(30));
    await sql('UPDATE learnings SET date = ?, read_count = 4, last_used = ? WHERE id = ?', daysAgo(400), daysAgo(2), ancient);
    await sql('UPDATE learnings SET date = ?, read_count = 4, last_used = ? WHERE id = ?', daysAgo(30), daysAgo(2), fresh);

    const hits = await recallHits({ sort: 'activation' });
    expect(hits[0]!.activation).toBeCloseTo(hits[1]!.activation as number, 2);
  });

  it('shows no reads, uses or activation without sort', async () => {
    await store('Fact.');
    const [hit] = await recallHits({ detail: 'brief' });
    for (const key of ['reads', 'uses', 'activation', 'signals']) expect(hit).not.toHaveProperty(key);
  });

  it('describes signal and sort on the parameters, with the recency caveat of activation', async () => {
    const { toMcpToolList } = await import('./registry.js');
    const props = (toMcpToolList().find((t) => t.name === 'memory_recall')!.inputSchema as { properties: Record<string, { description?: string }> })
      .properties;
    expect(props.signal!.description).toContain('what matched per check');
    for (const text of ['reads:', 'uses:', 'activation:', 'last hours']) expect(props.sort!.description).toContain(text);
  });
});
