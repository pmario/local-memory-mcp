/**
 * Moving and labelling learnings without archiving them (local-memory-mcp-57k):
 * memory_learn_update changes project and category, searches can exclude tags,
 * projects and styles, and every newly written text carries the atomic/factual style.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmp = '';
beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'local-memory-style-'));
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
  const r = await learn({ category: 'pattern', content, ...extra });
  if (!r.success) throw new Error(r.error);
  return (r.data as { id: string }).id;
}

// An entry written before styles existed: no style, whatever its text, so it bypasses learn()'s checks.
async function storeLegacy(content: string): Promise<string> {
  const id = await store('legacy placeholder ' + Math.random());
  (await import('../db/client.js')).getDb().prepare("UPDATE learnings SET content = ?, style_json = '[]' WHERE id = ?").run(content, id);
  return id;
}

async function row(id: string) {
  const { getDb } = await import('../db/client.js');
  return getDb()
    .prepare('SELECT project, category, content, tags_json, style_json FROM learnings WHERE id = ?')
    .get(id) as { project: string | null; category: string; content: string; tags_json: string; style_json: string };
}

async function ids(result: { success: boolean; data?: unknown; error?: string }): Promise<string[]> {
  if (!result.success) throw new Error(result.error);
  return (result.data as { results: Array<{ id: string }> }).results.map((r) => r.id);
}

describe('memory_learn_update: project and category', () => {
  it('moves a learning to another project and back to none, without re-embedding', async () => {
    const { learnUpdate } = await import('./learn.js');
    const id = await store('project move target', { project: 'P2P' });

    const moved = await learnUpdate({ learningId: id, project: 'PGSD' });
    expect(moved.success).toBe(true);
    if (moved.success) expect((moved.data as { reembedded: boolean }).reembedded).toBe(false);
    expect((await row(id)).project).toBe('PGSD');

    expect((await learnUpdate({ learningId: id, project: null })).success).toBe(true);
    expect((await row(id)).project).toBeNull();
  });

  it('changes the category, and the keyword index follows', async () => {
    const { learnUpdate } = await import('./learn.js');
    const { getDb } = await import('../db/client.js');
    const id = await store('category move target');
    expect((await learnUpdate({ learningId: id, category: 'mistake' })).success).toBe(true);
    expect((await row(id)).category).toBe('mistake');
    const fts = getDb().prepare("SELECT title FROM search_fts WHERE content_id = ? AND content_type = 'learning'").get(id) as { title: string };
    expect(fts.title).toBe('mistake');
  });

  it('refuses an unknown category at the schema', async () => {
    const { learnUpdateSchema } = await import('./learn.js');
    expect(learnUpdateSchema.safeParse({ learningId: 'x', category: 'technical' }).success).toBe(false);
  });

  it('advertises project as string or null in the tool list', async () => {
    const { toMcpToolList } = await import('./registry.js');
    const tool = toMcpToolList().find((t) => t.name === 'memory_learn_update')!;
    const props = (tool.inputSchema as { properties: Record<string, { type: unknown }> }).properties;
    expect(props.project!.type).toEqual(['string', 'null']);
    expect(props.category).toBeDefined();
    expect(props.style).toBeDefined();
  });
});

describe('style: atomic and factual', () => {
  it('marks a new learning atomic and factual', async () => {
    const id = await store('A new finding, written to the rule.');
    expect(JSON.parse((await row(id)).style_json)).toEqual(['atomic', 'factual']);
  });

  it('marks bulk-added learnings the same way', async () => {
    const { learnBulk } = await import('./learn.js');
    const r = await learnBulk({ items: [{ category: 'pattern', content: 'bulk style target' }] });
    if (!r.success) throw new Error(r.error);
    const id = (r.data as { results: Array<{ id: string }> }).results[0]!.id;
    expect(JSON.parse((await row(id)).style_json)).toEqual(['atomic', 'factual']);
  });

  it('refuses a style value outside the fixed list', async () => {
    const { learnSchema, learnUpdateSchema } = await import('./learn.js');
    expect(learnSchema.safeParse({ category: 'pattern', content: 'x', style: ['consise'] }).success).toBe(false);
    expect(learnUpdateSchema.safeParse({ learningId: 'x', style: ['consise'] }).success).toBe(false);
  });

  it('refuses a factual text with an appended amendment section, and writes nothing', async () => {
    const { learn } = await import('./learn.js');
    const { getDb } = await import('../db/client.js');
    for (const content of ['Claim.\n\n=== AMENDED 2026-09-08: more ===\n\nDetail.', 'Claim.\n\nAMENDED 2026-09-22: more.']) {
      const r = await learn({ category: 'pattern', content });
      expect(r.success).toBe(false);
      if (!r.success) expect(r.code).toBe('AMENDMENT_SECTION');
    }
    expect((getDb().prepare('SELECT COUNT(*) AS c FROM learnings').get() as { c: number }).c).toBe(0);
  });

  it('accepts the word amended inside a sentence', async () => {
    const id = await store('The policy was amended in 2026 and now says X.');
    expect(JSON.parse((await row(id)).style_json)).toEqual(['atomic', 'factual']);
  });

  it('marks a content rewrite of a legacy entry atomic and factual', async () => {
    const { learnUpdate } = await import('./learn.js');
    const id = await storeLegacy('OLD STYLE ENTRY.\n\n=== AMENDED 2026-08-01 ===\n\nMore.');
    expect((await learnUpdate({ learningId: id, content: 'Rewritten to the current state.' })).success).toBe(true);
    expect(JSON.parse((await row(id)).style_json)).toEqual(['atomic', 'factual']);
  });

  it('refuses a content rewrite that appends an amendment section, and leaves the row alone', async () => {
    const { learnUpdate } = await import('./learn.js');
    const id = await store('Claim: X is true.');
    const r = await learnUpdate({ learningId: id, content: 'Claim: X is true.\n\nAMENDED 2026-09-23: only on Tuesdays.' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe('AMENDMENT_SECTION');
    expect((await row(id)).content).toBe('Claim: X is true.');
  });

  it('leaves the style alone on a tag, project or category update', async () => {
    const { learnUpdate } = await import('./learn.js');
    const id = await storeLegacy('legacy entry, tagged later');
    await learnUpdate({ learningId: id, tags: ['pgsd-server'], project: 'PGSD', category: 'infrastructure' });
    expect(JSON.parse((await row(id)).style_json)).toEqual([]);
  });

  it('sets a style without a rewrite, but not factual over an amendment section', async () => {
    const { learnUpdate } = await import('./learn.js');
    const clean = await storeLegacy('An entry already written to the rule.');
    expect((await learnUpdate({ learningId: clean, style: ['atomic', 'factual'] })).success).toBe(true);
    expect(JSON.parse((await row(clean)).style_json)).toEqual(['atomic', 'factual']);

    const amended = await storeLegacy('Claim.\n\n=== AMENDED 2026-09-08 ===\n\nMore.');
    const r = await learnUpdate({ learningId: amended, style: ['factual'] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe('AMENDMENT_SECTION');
    expect(JSON.parse((await row(amended)).style_json)).toEqual([]);
  });

  it('memory_get shows the style', async () => {
    const { memoryGet } = await import('./get.js');
    const id = await store('style shown by get');
    const r = memoryGet({ ids: [id] });
    if (!r.success) throw new Error(r.error);
    expect((r.data as { results: Array<{ style: string[] }> }).results[0]!.style).toEqual(['atomic', 'factual']);
  });

  it('survives an export and import round trip, dropping unknown values', async () => {
    const { memoryExport, memoryImport } = await import('./export.js');
    const id = await store('style round trip');
    const exported = memoryExport({});
    if (!exported.success) throw new Error(exported.error);
    const envelope = exported.data as { learnings: Array<{ id: string; style: string[] }> };
    expect(envelope.learnings.find((l) => l.id === id)!.style).toEqual(['atomic', 'factual']);

    const { closeDb } = await import('../db/client.js');
    closeDb();
    process.env.MEMORY_DB_PATH = join(tmp, 'imported.sqlite');
    envelope.learnings[0]!.style = ['atomic', 'future-style'];
    const imported = await memoryImport({ data: envelope as unknown as Record<string, unknown> });
    expect(imported.success).toBe(true);
    expect(JSON.parse((await row(id)).style_json)).toEqual(['atomic']);
  });

  it('adds the style column to a store created before it existed', async () => {
    const { getDb, closeDb } = await import('../db/client.js');
    const id = await store('entry from before the column');
    getDb().exec('ALTER TABLE learnings DROP COLUMN style_json');
    closeDb();
    expect(JSON.parse((await row(id)).style_json)).toEqual([]);
  });
});

describe('search and recall: exclusion and style filters', () => {
  async function seed() {
    return {
      facets: await store('okapi facets finding', { project: 'P2P', tags: ['facets'] }),
      server: await store('okapi server finding', { project: 'PGSD', tags: ['pgsd-server'] }),
      legacy: await storeLegacy('okapi legacy finding'),
    };
  }

  it('memory_search excludes tags and projects', async () => {
    const { search } = await import('./search.js');
    const e = await seed();
    const byTag = await ids(await search({ query: 'okapi', mode: 'fts', excludeTags: ['pgsd-server'] }));
    expect(byTag).toContain(e.facets);
    expect(byTag).not.toContain(e.server);
    const byProject = await ids(await search({ query: 'okapi', mode: 'fts', excludeProjects: ['PGSD'] }));
    expect(byProject).not.toContain(e.server);
    expect(byProject).toContain(e.legacy);
  });

  it('memory_search filters by style and excludes a style', async () => {
    const { search } = await import('./search.js');
    const e = await seed();
    expect(await ids(await search({ query: 'okapi', mode: 'fts', style: ['factual'] }))).not.toContain(e.legacy);
    expect(await ids(await search({ query: 'okapi', mode: 'fts', excludeStyle: ['factual'] }))).toEqual([e.legacy]);
  });

  it('memory_recall takes the same filters, with and without a query', async () => {
    const { recall } = await import('./learn.js');
    const e = await seed();
    for (const query of ['okapi', undefined]) {
      expect(await ids(recall({ query, excludeTags: ['pgsd-server'] }))).not.toContain(e.server);
      expect(await ids(recall({ query, excludeProjects: ['PGSD'] }))).toContain(e.legacy);
      expect(await ids(recall({ query, excludeStyle: ['factual'] }))).toEqual([e.legacy]);
      expect(await ids(recall({ query, style: ['atomic'] }))).not.toContain(e.legacy);
    }
  });
});

describe('memory_health: styles', () => {
  it('counts active learnings per style and names the longest without factual', async () => {
    const { health } = await import('./insights.js');
    const { learnArchive } = await import('./learn.js');
    await store('styled one');
    const long = await storeLegacy('x'.repeat(500));
    await storeLegacy('y'.repeat(50));
    learnArchive({ learningId: await storeLegacy('z'.repeat(900)) });

    const r = health();
    if (!r.success) throw new Error(r.error);
    const styles = (r.data as { styles: { atomic: number; factual: number; none: number; longestWithoutFactual: Array<[string, number]> } }).styles;
    expect(styles.atomic).toBe(1);
    expect(styles.factual).toBe(1);
    expect(styles.none).toBe(2);
    expect(styles.longestWithoutFactual[0]).toEqual([long.slice(0, 8), 500]);
    expect(styles.longestWithoutFactual).toHaveLength(2);
  });
});
