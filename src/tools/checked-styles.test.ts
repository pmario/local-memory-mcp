/**
 * Styles only when checked (local-memory-mcp-i8n): no default stamp, the style is required at the
 * tool boundary, more appended-correction headers are refused, and a split is recorded in split_from
 * with links checked in both directions. memoryType changes on update (local-memory-mcp-9z9).
 * By hand: memory_learn({category: "pattern", content: "x"}) now fails validation with a pointer
 * to memory_guide({topic: "writing"}); the same call with style: ["atomic", "factual"] stores it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHECKED = ['atomic', 'factual'] as const;

let tmp = '';
beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'local-memory-checked-'));
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
  const r = await learn({ category: 'pattern', content, style: [...CHECKED], ...extra });
  if (!r.success) throw new Error(r.error);
  return (r.data as { id: string }).id;
}

async function row(id: string) {
  const { getDb } = await import('../db/client.js');
  return getDb()
    .prepare('SELECT content, style_json, split_from, memory_type FROM learnings WHERE id = ?')
    .get(id) as { content: string; style_json: string; split_from: string | null; memory_type: string };
}

async function count(): Promise<number> {
  const { getDb } = await import('../db/client.js');
  return (getDb().prepare('SELECT COUNT(*) AS c FROM learnings').get() as { c: number }).c;
}

const id8 = (id: string) => id.slice(0, 8);

describe('style is required at the tool boundary', () => {
  it('memory_learn without style fails validation and points to the writing guide', async () => {
    const { learnSchema } = await import('./learn.js');
    const r = learnSchema.safeParse({ category: 'pattern', content: 'x' });
    expect(r.success).toBe(false);
    if (!r.success) {
      const message = r.error.issues.map((i) => i.message).join(' ');
      expect(message).toContain('memory_guide({topic: "writing"})');
      expect(message).toContain('MUST');
    }
  });

  it('memory_learn needs both values, in any order', async () => {
    const { learnSchema } = await import('./learn.js');
    expect(learnSchema.safeParse({ category: 'pattern', content: 'x', style: ['atomic'] }).success).toBe(false);
    expect(learnSchema.safeParse({ category: 'pattern', content: 'x', style: ['factual', 'atomic'] }).success).toBe(true);
  });

  it('each memory_learn_bulk item needs the style', async () => {
    const { learnBulkSchema } = await import('./learn.js');
    const ok = { category: 'pattern', content: 'a', style: [...CHECKED] };
    expect(learnBulkSchema.safeParse({ items: [ok, { category: 'pattern', content: 'b' }] }).success).toBe(false);
    expect(learnBulkSchema.safeParse({ items: [ok] }).success).toBe(true);
  });

  it('the tool list marks style as required for memory_learn and each bulk item', async () => {
    const { toMcpToolList } = await import('./registry.js');
    const tools = toMcpToolList();
    const learnSchema = tools.find((t) => t.name === 'memory_learn')!.inputSchema as { required: string[] };
    expect(learnSchema.required).toContain('style');
    const bulk = tools.find((t) => t.name === 'memory_learn_bulk')!.inputSchema as {
      properties: { items: { items: { required: string[] } } };
    };
    expect(bulk.properties.items.items.required).toContain('style');
  });

  it('the source parameter says what source is for, on memory_learn and each bulk item (local-memory-mcp-ag7)', async () => {
    const { toMcpToolList } = await import('./registry.js');
    const tools = toMcpToolList();
    type Props = { properties: Record<string, { description?: string }> };
    const learn = (tools.find((t) => t.name === 'memory_learn')!.inputSchema as Props).properties.source;
    const bulk = (
      tools.find((t) => t.name === 'memory_learn_bulk')!.inputSchema as { properties: { items: { items: Props } } }
    ).properties.items.items.properties.source;
    for (const source of [learn, bulk]) {
      expect(source.description).toContain('where the finding came from');
      expect(source.description).toContain("copies its hub's source");
      expect(source.description).toContain('splitFrom');
    }
  });

  it('the write-tool descriptions say style is required, in RFC 2119 key words (local-memory-mcp-jz8)', async () => {
    const { toMcpToolList } = await import('./registry.js');
    for (const name of ['memory_learn', 'memory_learn_update', 'memory_learn_bulk']) {
      const description = toMcpToolList().find((t) => t.name === name)!.description;
      expect(description).toContain('is REQUIRED and MUST NOT be passed before checking');
      expect(description).not.toContain('stored with style');
      expect(description).not.toContain('stored as style');
    }
  });
});

describe('no default stamp', () => {
  it('stores exactly the style given', async () => {
    const id = await store('A finding checked against the rule.');
    expect(JSON.parse((await row(id)).style_json)).toEqual(['atomic', 'factual']);
  });

  it('stores no style when a direct call passes none', async () => {
    const { learn, learnBulk } = await import('./learn.js');
    const single = await learn({ category: 'pattern', content: 'direct call, no style' });
    if (!single.success) throw new Error(single.error);
    expect(JSON.parse((await row((single.data as { id: string }).id)).style_json)).toEqual([]);
    const bulk = await learnBulk({ items: [{ category: 'pattern', content: 'bulk direct call, no style' }] });
    if (!bulk.success) throw new Error(bulk.error);
    const bulkId = (bulk.data as { results: Array<{ id: string }> }).results[0]!.id;
    expect(JSON.parse((await row(bulkId)).style_json)).toEqual([]);
  });
});

describe('memory_learn_update: a content rewrite must declare the style', () => {
  it('refuses a rewrite without style, points to the guide and leaves the row alone', async () => {
    const { learnUpdate } = await import('./learn.js');
    const id = await store('Original text.');
    const r = await learnUpdate({ learningId: id, content: 'Rewritten text.' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.code).toBe('STYLE_REQUIRED');
      expect(r.error).toContain('memory_guide({topic: "writing"})');
    }
    expect((await row(id)).content).toBe('Original text.');
  });

  it('refuses a rewrite that declares only one of the two values', async () => {
    const { learnUpdate } = await import('./learn.js');
    const id = await store('Original text.');
    const r = await learnUpdate({ learningId: id, content: 'Rewritten text.', style: ['atomic'] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe('STYLE_REQUIRED');
  });

  it('stores a rewrite that declares both', async () => {
    const { learnUpdate } = await import('./learn.js');
    const id = await store('Original text.');
    expect((await learnUpdate({ learningId: id, content: 'Rewritten text.', style: ['atomic', 'factual'] })).success).toBe(true);
    expect((await row(id)).content).toBe('Rewritten text.');
  });

  it('sending the unchanged text is not a rewrite', async () => {
    const { learnUpdate } = await import('./learn.js');
    const id = await store('Same text.');
    expect((await learnUpdate({ learningId: id, content: 'Same text.', tags: ['x'] })).success).toBe(true);
  });
});

describe('appended-correction headers are refused under factual', () => {
  const refused = [
    'Claim.\n\nSUPERSEDED by the entry below.',
    'Claim.\n\n=== CORRECTED 2026-09-24 ===\n\nDetail.',
    'Claim.\n\nUPDATE: it now works.',
    'Claim.\n\nUPDATE 2026-09-24 it now works.',
    'Claim.\n\n=== UPDATE ===\n\nDetail.',
    'Claim.\n\nUPDATE\n\nDetail.',
    'Claim.\n\nADDENDUM: one more case.',
  ];
  for (const content of refused) {
    it(`refuses ${JSON.stringify(content)}`, async () => {
      const { learn } = await import('./learn.js');
      const r = await learn({ category: 'pattern', content, style: [...CHECKED] });
      expect(r.success).toBe(false);
      if (!r.success) expect(r.code).toBe('AMENDMENT_SECTION');
      expect(await count()).toBe(0);
    });
  }

  const accepted = [
    'The first design was superseded by a second one.',
    'Updated tests pass, and so does the word update inside a sentence.',
    'Run this:\n\nUPDATE learnings SET content = ? WHERE id = ?',
    'A fenced example:\n\n```\n=== AMENDED 2026-09-08 ===\nUPDATE: x\n```\n\nEnd.',
  ];
  for (const content of accepted) {
    it(`accepts ${JSON.stringify(content.slice(0, 40))}`, async () => {
      await store(content);
      expect(await count()).toBe(1);
    });
  }
});

describe('split_from: a split records its hub and links both ways', () => {
  it('stores a part that links its hub, and memory_get shows both sides', async () => {
    const { memoryGet } = await import('./get.js');
    const hub = await store('Hub text.');
    const part = await store(`Part text. Split out of [[${id8(hub)}]].`, { splitFrom: hub });
    expect((await row(part)).split_from).toBe(hub);

    const r = memoryGet({ ids: [hub, part] });
    if (!r.success) throw new Error(r.error);
    const [h, p] = (r.data as { results: Array<{ parts?: string[]; splitFrom?: string | null }> }).results;
    expect(h!.parts).toEqual([part]);
    expect(p!.splitFrom).toBe(hub);
  });

  it('refuses a part that does not link its hub, and writes nothing', async () => {
    const { learn } = await import('./learn.js');
    const hub = await store('Hub text.');
    const r = await learn({ category: 'pattern', content: 'Part without a link.', style: [...CHECKED], splitFrom: hub });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe('SPLIT_LINK_MISSING');
    expect(await count()).toBe(1);
  });

  it('refuses an unknown hub', async () => {
    const { learn } = await import('./learn.js');
    const r = await learn({ category: 'pattern', content: 'Part. [[deadbeef]]', style: [...CHECKED], splitFrom: 'deadbeef-0000-0000-0000-000000000000' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe('HUB_NOT_FOUND');
  });

  it('refuses a split of a split in both directions', async () => {
    const { learn, learnUpdate } = await import('./learn.js');
    const hub = await store('Hub text.');
    const part = await store(`Part. [[${id8(hub)}]]`, { splitFrom: hub });
    const nested = await learn({ category: 'pattern', content: `Nested. [[${id8(part)}]]`, style: [...CHECKED], splitFrom: part });
    expect(nested.success).toBe(false);
    if (!nested.success) expect(nested.code).toBe('NESTED_SPLIT');

    const other = await store('Another hub.');
    const hubAsPart = await learnUpdate({ learningId: hub, splitFrom: other, content: `Hub text. [[${id8(part)}]] [[${id8(other)}]]`, style: [...CHECKED] });
    expect(hubAsPart.success).toBe(false);
    if (!hubAsPart.success) expect(hubAsPart.code).toBe('NESTED_SPLIT');
  });

  it('refuses a hub rewrite that misses a part, naming it', async () => {
    const { learnUpdate } = await import('./learn.js');
    const hub = await store('Hub text.');
    const a = await store(`Part A. [[${id8(hub)}]]`, { splitFrom: hub });
    const b = await store(`Part B. [[${id8(hub)}]]`, { splitFrom: hub });
    const r = await learnUpdate({ learningId: hub, content: `Hub. Parts: [[${id8(a)}]].`, style: [...CHECKED] });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.code).toBe('SPLIT_LINK_MISSING');
      expect(r.error).toContain(id8(b));
    }
    const ok = await learnUpdate({ learningId: hub, content: `Hub. Parts: [[${id8(a)}]], [[${id8(b)}]].`, style: [...CHECKED] });
    expect(ok.success).toBe(true);
  });

  it('checks the hub links also on a style-only update of the hub', async () => {
    const { learnUpdate } = await import('./learn.js');
    const hub = await store('Hub text without links.');
    await store(`Part. [[${id8(hub)}]]`, { splitFrom: hub });
    const r = await learnUpdate({ learningId: hub, style: [...CHECKED] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe('SPLIT_LINK_MISSING');
  });

  it('refuses a part rewrite that drops the hub link', async () => {
    const { learnUpdate } = await import('./learn.js');
    const hub = await store('Hub text.');
    const part = await store(`Part. [[${id8(hub)}]]`, { splitFrom: hub });
    const r = await learnUpdate({ learningId: part, content: 'Part, link gone.', style: [...CHECKED] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe('SPLIT_LINK_MISSING');
  });

  it('keeps links across archiving: an archived hub still takes parts, an archived part is no longer required', async () => {
    const { learnArchive, learnUpdate } = await import('./learn.js');
    const { memoryGet } = await import('./get.js');
    const hub = await store('Hub text.');
    const kept = await store(`Kept part. [[${id8(hub)}]]`, { splitFrom: hub });
    const dropped = await store(`Dropped part. [[${id8(hub)}]]`, { splitFrom: hub });

    expect(learnArchive({ learningId: dropped }).success).toBe(true);
    const r = memoryGet({ ids: [hub] });
    if (!r.success) throw new Error(r.error);
    expect((r.data as { results: Array<{ parts: string[] }> }).results[0]!.parts).toEqual([kept]);
    expect((await learnUpdate({ learningId: hub, content: `Hub. [[${id8(kept)}]]`, style: [...CHECKED] })).success).toBe(true);

    expect(learnArchive({ learningId: hub }).success).toBe(true);
    const late = await store(`Late part of an archived hub. [[${id8(hub)}]]`, { splitFrom: hub });
    expect((await row(late)).split_from).toBe(hub);
    expect((await learnUpdate({ learningId: kept, content: `Kept part, rewritten. [[${id8(hub)}]]`, style: [...CHECKED] })).success).toBe(true);
  });

  it('sets and clears split_from on an existing entry, for the backfill', async () => {
    const { learnUpdate } = await import('./learn.js');
    const hub = await store('Hub text.');
    const part = await store(`Written before split_from existed. [[${id8(hub)}]]`);
    expect((await learnUpdate({ learningId: part, splitFrom: hub })).success).toBe(true);
    expect((await row(part)).split_from).toBe(hub);
    expect((await learnUpdate({ learningId: part, splitFrom: null })).success).toBe(true);
    expect((await row(part)).split_from).toBeNull();
  });

  it('checks split_from on bulk items too', async () => {
    const { learnBulk } = await import('./learn.js');
    const hub = await store('Hub text.');
    const r = await learnBulk({
      items: [
        { category: 'pattern', content: `Good part. [[${id8(hub)}]]`, style: [...CHECKED], splitFrom: hub },
        { category: 'pattern', content: 'Bad part.', style: [...CHECKED], splitFrom: hub },
      ],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.code).toBe('SPLIT_LINK_MISSING');
      expect(r.error).toContain('Item 1');
    }
    expect(await count()).toBe(1);
  });

  it('survives an export and import round trip', async () => {
    const { memoryExport, memoryImport } = await import('./export.js');
    const hub = await store('Hub text.');
    const part = await store(`Part. [[${id8(hub)}]]`, { splitFrom: hub });
    const exported = memoryExport({});
    if (!exported.success) throw new Error(exported.error);
    const envelope = exported.data as { learnings: Array<{ id: string; splitFrom?: string | null }> };
    expect(envelope.learnings.find((l) => l.id === part)!.splitFrom).toBe(hub);

    const { closeDb } = await import('../db/client.js');
    closeDb();
    process.env.MEMORY_DB_PATH = join(tmp, 'imported.sqlite');
    expect((await memoryImport({ data: envelope as unknown as Record<string, unknown> })).success).toBe(true);
    expect((await row(part)).split_from).toBe(hub);
  });

  it('adds the split_from column to a store created before it existed', async () => {
    const { getDb, closeDb } = await import('../db/client.js');
    const id = await store('entry from before the column');
    getDb().exec('DROP INDEX idx_learnings_split_from; ALTER TABLE learnings DROP COLUMN split_from');
    closeDb();
    expect((await row(id)).split_from).toBeNull();
  });
});

describe('memory_learn_update changes memoryType (local-memory-mcp-9z9)', () => {
  it('sets the memory type without touching the text or style', async () => {
    const { learnUpdate } = await import('./learn.js');
    const id = await store('A rule that was classified as an event.', { memoryType: 'episodic' });
    expect((await learnUpdate({ learningId: id, memoryType: 'semantic' })).success).toBe(true);
    const r = await row(id);
    expect(r.memory_type).toBe('semantic');
    expect(JSON.parse(r.style_json)).toEqual(['atomic', 'factual']);
  });

  it('refuses an unknown memory type at the schema', async () => {
    const { learnUpdateSchema } = await import('./learn.js');
    expect(learnUpdateSchema.safeParse({ learningId: 'x', memoryType: 'procedural' }).success).toBe(false);
  });
});
