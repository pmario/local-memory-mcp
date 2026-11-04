/**
 * memory_decision_archive (wikilabs-kfw): a replaced decision leaves search, reflect and insights, and memory_get still opens it.
 *
 * By hand against a scratch store (MEMORY_DB_PATH pointing at an empty file):
 *   memory_decide({title: 'Old rule', decision: 'a', reasoning: 'r'})  -> data.id = OLD
 *   memory_decide({title: 'New rule', decision: 'b', reasoning: 'r'})  -> data.id = NEW
 *   memory_decision_archive({decisionId: OLD, reason: 'superseded', supersededBy: [NEW]})
 *   -> { action: 'archived', lifecycleState: 'archived:superseded', supersededBy: [NEW] }
 *   memory_search({query: 'rule'})  -> only NEW
 *   memory_get({ids: [OLD]})        -> { type: 'decision', archived: true, lifecycle_state: 'archived:superseded', supersededBy: [NEW] }
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmp = '';
beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'local-memory-decision-archive-'));
  process.env.MEMORY_DB_PATH = join(tmp, 'test.sqlite');
  // Open the store first: isVectorEnabled() is false until getDb() loads sqlite-vec.
  (await import('../db/client.js')).getDb();
});
afterEach(async () => {
  const { closeDb } = await import('../db/client.js');
  closeDb();
  delete process.env.MEMORY_DB_PATH;
  rmSync(tmp, { recursive: true, force: true });
});

async function decision(title: string, project?: string): Promise<string> {
  const { decide } = await import('./decide.js');
  const r = await decide({ title, decision: `${title} chosen`, reasoning: 'because', project });
  if (!r.success) throw new Error('setup failed');
  return (r.data as { id: string }).id;
}

async function row(id: string) {
  const { getDb } = await import('../db/client.js');
  return getDb()
    .prepare('SELECT archived, archived_at, lifecycle_state, superseded_by_json FROM decisions WHERE id = ?')
    .get(id) as { archived: number; archived_at: string | null; lifecycle_state: string; superseded_by_json: string };
}

describe('memory_decision_archive', () => {
  it('archives a decision with its reason and successors', async () => {
    const { decisionArchive } = await import('./decide.js');
    const old = await decision('walrus storage rule');
    const next = await decision('walrus storage rule, second take');
    const r = decisionArchive({ decisionId: old, reason: 'superseded', supersededBy: [next] });
    expect(r).toMatchObject({ success: true, data: { id: old, action: 'archived', lifecycleState: 'archived:superseded', supersededBy: [next] } });
    const stored = await row(old);
    expect(stored).toMatchObject({ archived: 1, lifecycle_state: 'archived:superseded', superseded_by_json: JSON.stringify([next]) });
    expect(stored.archived_at).not.toBeNull();
    expect(await row(next)).toMatchObject({ archived: 0, lifecycle_state: 'active', superseded_by_json: '[]' });
  });

  it('archives without successors, for a decision that was wrong', async () => {
    const { decisionArchive } = await import('./decide.js');
    const id = await decision('wrong call');
    expect(decisionArchive({ decisionId: id, reason: 'wrong' })).toMatchObject({ success: true, data: { supersededBy: [] } });
    expect(await row(id)).toMatchObject({ archived: 1, lifecycle_state: 'archived:wrong', superseded_by_json: '[]' });
  });

  it('requires a reason', async () => {
    const { decisionArchiveSchema } = await import('./decide.js');
    expect(decisionArchiveSchema.safeParse({ decisionId: 'x' }).success).toBe(false);
    expect(decisionArchiveSchema.safeParse({ decisionId: 'x', reason: '' }).success).toBe(false);
  });

  it('answers already_archived on a second call and keeps the first state', async () => {
    const { decisionArchive } = await import('./decide.js');
    const old = await decision('first');
    const next = await decision('second');
    decisionArchive({ decisionId: old, reason: 'superseded', supersededBy: [next] });
    const before = await row(old);
    expect(decisionArchive({ decisionId: old, reason: 'other' })).toMatchObject({ success: true, data: { action: 'already_archived' } });
    expect(await row(old)).toEqual(before);
  });

  it('refuses an unknown decision id, a learning id included', async () => {
    const { decisionArchive } = await import('./decide.js');
    const { learn } = await import('./learn.js');
    const l = await learn({ category: 'pattern', content: 'a learning, not a decision' });
    if (!l.success) throw new Error('setup failed');
    expect(decisionArchive({ decisionId: 'nope', reason: 'x' })).toMatchObject({ success: false, code: 'NOT_FOUND' });
    expect(decisionArchive({ decisionId: (l.data as { id: string }).id, reason: 'x' })).toMatchObject({ success: false, code: 'NOT_FOUND' });
  });

  it('refuses itself or an unknown id as successor and writes nothing', async () => {
    const { decisionArchive } = await import('./decide.js');
    const id = await decision('lonely');
    expect(decisionArchive({ decisionId: id, reason: 'x', supersededBy: [id] })).toMatchObject({ success: false, code: 'SELF_SUPERSEDE' });
    const r = decisionArchive({ decisionId: id, reason: 'x', supersededBy: ['ghost-id'] });
    expect(r).toMatchObject({ success: false, code: 'SUPERSEDER_NOT_FOUND' });
    if (!r.success) expect(r.error).toContain('ghost-id');
    expect(await row(id)).toMatchObject({ archived: 0, lifecycle_state: 'active', superseded_by_json: '[]' });
  });

  it('accepts a learning or an archived decision as successor', async () => {
    const { decisionArchive } = await import('./decide.js');
    const { learn } = await import('./learn.js');
    const l = await learn({ category: 'workflow', content: 'the rule now lives in a learning' });
    if (!l.success) throw new Error('setup failed');
    const learningId = (l.data as { id: string }).id;
    const a = await decision('a');
    const b = await decision('b');
    const c = await decision('c');
    expect(decisionArchive({ decisionId: b, reason: 'superseded', supersededBy: [c] }).success).toBe(true);
    // a names both a learning and b, which is itself archived: a successor chain may continue.
    expect(decisionArchive({ decisionId: a, reason: 'superseded', supersededBy: [learningId, b, b] }).success).toBe(true);
    expect(JSON.parse((await row(a)).superseded_by_json)).toEqual([learningId, b]);
  });
});

describe('an archived decision leaves the live views', () => {
  it('drops out of fts, vector and hybrid search while its successor stays', async () => {
    const { decisionArchive } = await import('./decide.js');
    const { search } = await import('./search.js');
    const { isVectorEnabled } = await import('../db/vector.js');
    const old = await decision('pelican nesting policy');
    const next = await decision('pelican nesting policy revised');
    decisionArchive({ decisionId: old, reason: 'superseded', supersededBy: [next] });
    const modes = isVectorEnabled() ? (['fts', 'vector', 'hybrid'] as const) : (['fts'] as const);
    for (const mode of modes) {
      const r = await search({ query: 'pelican nesting policy', mode });
      if (!r.success) throw new Error(r.error);
      const ids = (r.data as { results: Array<{ id: string }> }).results.map((x) => x.id);
      expect(ids, mode).toContain(next);
      expect(ids, mode).not.toContain(old);
    }
  });

  it('memory_get still opens it, marked archived with its successors', async () => {
    const { decisionArchive } = await import('./decide.js');
    const { memoryGet } = await import('./get.js');
    const old = await decision('heron rule');
    const next = await decision('heron rule revised');
    decisionArchive({ decisionId: old, reason: 'superseded', supersededBy: [next] });
    const r = memoryGet({ ids: [old, next] });
    if (!r.success) throw new Error(r.error);
    const [o, n] = (r.data as { results: Array<Record<string, unknown>> }).results;
    expect(o).toMatchObject({ type: 'decision', id: old, title: 'heron rule', archived: true, lifecycle_state: 'archived:superseded', supersededBy: [next] });
    expect(n).toMatchObject({ type: 'decision', id: next });
    for (const key of ['archived', 'lifecycle_state', 'supersededBy']) expect(n).not.toHaveProperty(key);
    expect(o).not.toHaveProperty('superseded_by_json');
  });

  it('is left out of reflect and the insights count', async () => {
    const { decisionArchive } = await import('./decide.js');
    const { reflect } = await import('./reflect.js');
    const { insights } = await import('./insights.js');
    const { getDb } = await import('../db/client.js');
    const old = await decision('ibis rule', 'p');
    const next = await decision('ibis rule revised', 'p');
    // Older than the lookback, so both would be listed as recent decisions.
    getDb().prepare("UPDATE decisions SET date = datetime('now', '-14 days')").run();
    decisionArchive({ decisionId: old, reason: 'superseded', supersededBy: [next] });

    const ref = reflect({});
    if (!ref.success) throw new Error(ref.error);
    const listed = JSON.stringify(ref.data);
    expect(listed).toContain(next);
    expect(listed).not.toContain(old);

    for (const project of [undefined, 'p']) {
      const ins = insights({ project });
      if (!ins.success) throw new Error(ins.error);
      expect(JSON.stringify(ins.data), String(project)).toMatch(/"totalDecisions":1\b/);
    }
  });
});

describe('the archive state travels through export and import', () => {
  it('round-trips archived, archivedAt, lifecycleState and supersededBy', async () => {
    const { decisionArchive } = await import('./decide.js');
    const { memoryExport, memoryImport } = await import('./export.js');
    const { closeDb } = await import('../db/client.js');
    const old = await decision('stork rule');
    const next = await decision('stork rule revised');
    decisionArchive({ decisionId: old, reason: 'superseded', supersededBy: [next] });
    const before = await row(old);
    const exp = memoryExport({});
    if (!exp.success) throw new Error(exp.error);
    const envelope = exp.data as { decisions: Array<Record<string, unknown>> };
    expect(envelope.decisions.find((d) => d.id === old)).toMatchObject({ archived: 1, lifecycleState: 'archived:superseded', supersededBy: [next] });

    closeDb();
    process.env.MEMORY_DB_PATH = join(tmp, 'restored.sqlite');
    const imp = await memoryImport({ data: envelope });
    if (!imp.success) throw new Error(imp.error);
    expect(await row(old)).toEqual(before);
    expect(await row(next)).toMatchObject({ archived: 0, lifecycle_state: 'active', superseded_by_json: '[]' });
  });

  it('includeArchived: false leaves an archived decision out', async () => {
    const { decisionArchive } = await import('./decide.js');
    const { memoryExport } = await import('./export.js');
    const old = await decision('crane rule');
    const next = await decision('crane rule revised');
    decisionArchive({ decisionId: old, reason: 'superseded', supersededBy: [next] });
    const exp = memoryExport({ includeArchived: false });
    if (!exp.success) throw new Error(exp.error);
    expect((exp.data as { decisions: Array<{ id: string }> }).decisions.map((d) => d.id)).toEqual([next]);
  });
});

describe('a store from before the decision archive columns', () => {
  it('gains the columns on open, with every decision active', async () => {
    const { getDb, closeDb } = await import('../db/client.js');
    const id = await decision('from before the columns');
    // SQLite refuses to drop an indexed column, so the index goes first.
    getDb().exec(`DROP INDEX idx_decisions_archived;
      ALTER TABLE decisions DROP COLUMN archived;
      ALTER TABLE decisions DROP COLUMN archived_at;
      ALTER TABLE decisions DROP COLUMN lifecycle_state;
      ALTER TABLE decisions DROP COLUMN superseded_by_json`);
    closeDb();
    expect(await row(id)).toEqual({ archived: 0, archived_at: null, lifecycle_state: 'active', superseded_by_json: '[]' });
  });
});
