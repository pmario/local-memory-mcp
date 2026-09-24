/**
 * verified and verified_at (local-memory-mcp-4ip): verified_at is "last confirmed at", verified says the current text is the
 * confirmed text. A learning counts as confirmed when stored, so an empty verified_at reads as its date.
 * By hand: memory_learn_update({learningId, verified: true}) then memory_get({ids: [learningId]}) shows verified: true
 * and verifiedAt now; a later memory_learn_update({learningId, content, style}) without verified shows verified: false
 * with verifiedAt unchanged.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHECKED: Array<'atomic' | 'factual'> = ['atomic', 'factual'];
const CREATED = '2026-01-01 00:00:00';

let tmp = '';
beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'local-memory-verified-'));
  process.env.MEMORY_DB_PATH = join(tmp, 'test.sqlite');
  (await import('../db/client.js')).getDb();
});
afterEach(async () => {
  const { closeDb } = await import('../db/client.js');
  closeDb();
  delete process.env.MEMORY_DB_PATH;
  rmSync(tmp, { recursive: true, force: true });
});

// Test scaffolding: a learning dated in the past, so "now" and the creation date differ.
async function storeOld(content: string, extra: Record<string, unknown> = {}): Promise<string> {
  const { learn } = await import('./learn.js');
  const { getDb } = await import('../db/client.js');
  const r = await learn({ category: 'pattern', content, style: CHECKED, ...extra } as Parameters<typeof learn>[0]);
  if (!r.success) throw new Error(r.error);
  const id = (r.data as { id: string }).id;
  getDb().prepare('UPDATE learnings SET date = ? WHERE id = ?').run(CREATED, id);
  return id;
}

async function row(id: string) {
  const { getDb } = await import('../db/client.js');
  return getDb().prepare('SELECT verified, verified_at FROM learnings WHERE id = ?').get(id) as {
    verified: number;
    verified_at: string | null;
  };
}

async function shown(id: string) {
  const { memoryGet } = await import('./get.js');
  const r = memoryGet({ ids: [id] });
  if (!r.success) throw new Error(r.error);
  return (r.data as { results: Array<Record<string, unknown>> }).results[0]!;
}

async function historyCount(id: string) {
  const { getDb } = await import('../db/client.js');
  return (getDb().prepare('SELECT COUNT(*) AS n FROM learnings_history WHERE learning_id = ?').get(id) as { n: number }).n;
}

describe('a new learning is confirmed by being stored', () => {
  it('stores no verified_at, and memory_get shows its date as verifiedAt', async () => {
    const id = await storeOld('Fact measured today.');
    expect(await row(id)).toEqual({ verified: 0, verified_at: null });
    const r = await shown(id);
    expect(r.verified).toBe(false);
    expect(r.verifiedAt).toBe(CREATED);
  });

  it("stores a split part's verifiedAt as given", async () => {
    const id = await storeOld('Part text.', { verifiedAt: '2025-06-01 12:00:00' });
    expect((await row(id)).verified_at).toBe('2025-06-01 12:00:00');
  });

  it('stores a bulk item verifiedAt as given, and the bulk item describes it', async () => {
    const { learnBulk } = await import('./learn.js');
    const { toMcpToolList } = await import('./registry.js');
    const r = await learnBulk({
      items: [
        { category: 'pattern', content: 'Bulk part.', style: CHECKED, verifiedAt: '2025-06-01 12:00:00' },
        { category: 'pattern', content: 'Bulk new.', style: CHECKED },
      ],
    });
    if (!r.success) throw new Error(r.error);
    const [part, fresh] = (r.data as { results: Array<{ id: string }> }).results;
    expect((await row(part!.id)).verified_at).toBe('2025-06-01 12:00:00');
    expect((await row(fresh!.id)).verified_at).toBeNull();
    type Props = { properties: Record<string, { description?: string }> };
    const item = (
      toMcpToolList().find((t) => t.name === 'memory_learn_bulk')!.inputSchema as { properties: { items: { items: Props } } }
    ).properties.items.items;
    expect(item.properties.verifiedAt.description).toContain("hub's");
  });

  it('refuses a verifiedAt that is not a date', async () => {
    const { learnSchema } = await import('./learn.js');
    expect(learnSchema.safeParse({ category: 'pattern', content: 'x', style: CHECKED, verifiedAt: 'soon' }).success).toBe(false);
  });
});

describe('memory_get shows the fields a split part copies from its hub (local-memory-mcp-ler)', () => {
  it('returns source when the learning has one, and leaves it out otherwise', async () => {
    const withSource = await storeOld('Found in a handoff.', { source: 'HANDOFF_x_2026-09-24.md' });
    const without = await storeOld('No provenance given.');
    expect((await shown(withSource)).source).toBe('HANDOFF_x_2026-09-24.md');
    expect(await shown(without)).not.toHaveProperty('source');
  });
});

describe('memory_learn_update with verified: true', () => {
  it('confirms without a content change: verified 1, verified_at now, no history version', async () => {
    const { learnUpdate } = await import('./learn.js');
    const id = await storeOld('Still true.');
    const r = await learnUpdate({ learningId: id, verified: true });
    expect(r.success).toBe(true);
    const v = await row(id);
    expect(v.verified).toBe(1);
    expect(v.verified_at).not.toBeNull();
    expect(v.verified_at! > CREATED).toBe(true);
    expect(await historyCount(id)).toBe(0);
  });

  it('confirms a rewrite in the same call', async () => {
    const { learnUpdate } = await import('./learn.js');
    const id = await storeOld('Old text.');
    expect((await learnUpdate({ learningId: id, content: 'New text.', style: CHECKED, verified: true })).success).toBe(true);
    const v = await row(id);
    expect(v.verified).toBe(1);
    expect(v.verified_at! > CREATED).toBe(true);
  });
});

describe('a content change without verified: true', () => {
  it('clears verified and keeps an existing verified_at', async () => {
    const { learnUpdate } = await import('./learn.js');
    const id = await storeOld('Old text.');
    await learnUpdate({ learningId: id, verified: true });
    const confirmed = (await row(id)).verified_at;
    expect((await learnUpdate({ learningId: id, content: 'New text.', style: CHECKED })).success).toBe(true);
    expect(await row(id)).toEqual({ verified: 0, verified_at: confirmed });
  });

  it('sets an empty verified_at to the creation date: confirmed at creation, changed since', async () => {
    const { learnUpdate } = await import('./learn.js');
    const id = await storeOld('Old text.');
    expect((await learnUpdate({ learningId: id, content: 'New text.', style: CHECKED })).success).toBe(true);
    expect(await row(id)).toEqual({ verified: 0, verified_at: CREATED });
  });

  it('leaves both fields alone on a metadata-only update', async () => {
    const { learnUpdate } = await import('./learn.js');
    const id = await storeOld('Text.');
    await learnUpdate({ learningId: id, verified: true });
    const before = await row(id);
    expect((await learnUpdate({ learningId: id, tags: ['x'] })).success).toBe(true);
    expect(await row(id)).toEqual(before);
  });
});

describe('the rule reaches the writer', () => {
  it('memory_learn_update describes verified and memory_learn describes verifiedAt', async () => {
    const { toMcpToolList } = await import('./registry.js');
    const tools = toMcpToolList();
    type Props = { properties: Record<string, { description?: string }> };
    const update = (tools.find((t) => t.name === 'memory_learn_update')!.inputSchema as Props).properties.verified;
    const learn = (tools.find((t) => t.name === 'memory_learn')!.inputSchema as Props).properties.verifiedAt;
    expect(update.description).toContain('every fact');
    expect(learn.description).toContain("hub's");
  });

  it('the writing guide states when verified_at moves', async () => {
    const { guide } = await import('./insights.js');
    const r = guide({ topic: 'writing' });
    if (!r.success) throw new Error(r.error);
    const content = (r.data as { content: string }).content;
    for (const text of ['verified_at', 'last confirmed', 'every fact', 'sets `verified` to 0', 'a typo fix included', 'MUST NOT start']) {
      expect(content).toContain(text);
    }
  });
});
