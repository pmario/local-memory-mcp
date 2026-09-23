/**
 * MEMORY_REQUIRE_STYLE=0 turns the style requirement off at server start (local-memory-mcp-i8n, D18).
 * By hand: add "MEMORY_REQUIRE_STYLE": "0" to the memory server's env in the MCP config and restart;
 * memory_learn({category: "pattern", content: "x"}) is then stored with style [].
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Read once when style.ts loads, so it is set before any test imports the server code.
process.env.MEMORY_REQUIRE_STYLE = '0';

let tmp = '';
beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'local-memory-optional-'));
  process.env.MEMORY_DB_PATH = join(tmp, 'test.sqlite');
  (await import('../db/client.js')).getDb();
});
afterEach(async () => {
  const { closeDb } = await import('../db/client.js');
  closeDb();
  delete process.env.MEMORY_DB_PATH;
  rmSync(tmp, { recursive: true, force: true });
});

async function styleOf(id: string): Promise<string[]> {
  const { getDb } = await import('../db/client.js');
  return JSON.parse((getDb().prepare('SELECT style_json FROM learnings WHERE id = ?').get(id) as { style_json: string }).style_json);
}

describe('MEMORY_REQUIRE_STYLE=0', () => {
  it('lets memory_learn and bulk items through validation without style', async () => {
    const { learnSchema, learnBulkSchema } = await import('./learn.js');
    expect(learnSchema.safeParse({ category: 'pattern', content: 'x' }).success).toBe(true);
    expect(learnBulkSchema.safeParse({ items: [{ category: 'pattern', content: 'x' }] }).success).toBe(true);
  });

  it('shows style as optional in the tool list and does not call it required', async () => {
    const { toMcpToolList } = await import('./registry.js');
    const tool = toMcpToolList().find((t) => t.name === 'memory_learn')!;
    expect((tool.inputSchema as { required?: string[] }).required ?? []).not.toContain('style');
    expect(tool.description).not.toContain('required');
  });

  it('stores a new learning without style as unstyled', async () => {
    const { learn } = await import('./learn.js');
    const r = await learn({ category: 'pattern', content: 'unchecked finding' });
    if (!r.success) throw new Error(r.error);
    expect(await styleOf((r.data as { id: string }).id)).toEqual([]);
  });

  it('resets the style of a rewrite that passes none, since the old check was on the old text', async () => {
    const { learn, learnUpdate } = await import('./learn.js');
    const r = await learn({ category: 'pattern', content: 'checked text', style: ['atomic', 'factual'] });
    if (!r.success) throw new Error(r.error);
    const id = (r.data as { id: string }).id;
    expect((await learnUpdate({ learningId: id, content: 'unchecked rewrite' })).success).toBe(true);
    expect(await styleOf(id)).toEqual([]);
  });

  it('still refuses factual over an appended correction', async () => {
    const { learn } = await import('./learn.js');
    const r = await learn({ category: 'pattern', content: 'Claim.\n\nCORRECTED: more.', style: ['factual'] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe('AMENDMENT_SECTION');
  });

  it('still checks split links', async () => {
    const { learn } = await import('./learn.js');
    const hub = await learn({ category: 'pattern', content: 'Hub.' });
    if (!hub.success) throw new Error(hub.error);
    const r = await learn({ category: 'pattern', content: 'Part without a link.', splitFrom: (hub.data as { id: string }).id });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe('SPLIT_LINK_MISSING');
  });
});
