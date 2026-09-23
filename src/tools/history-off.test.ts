/**
 * MEMORY_RECORD_HISTORY=0 stops the server from writing learnings_history (local-memory-mcp-mnb).
 * import-md.mjs starts its server this way: a synced change brings its version from the machine that made it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Read once when history.ts loads, so it is set before any test imports the server code.
process.env.MEMORY_RECORD_HISTORY = '0';

let tmp = '';
beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'local-memory-history-off-'));
  process.env.MEMORY_DB_PATH = join(tmp, 'test.sqlite');
  (await import('../db/client.js')).getDb();
});
afterEach(async () => {
  const { closeDb } = await import('../db/client.js');
  closeDb();
  delete process.env.MEMORY_DB_PATH;
  rmSync(tmp, { recursive: true, force: true });
});

describe('MEMORY_RECORD_HISTORY=0', () => {
  it('updates and archives without writing a version', async () => {
    const { learn, learnUpdate, learnArchive } = await import('./learn.js');
    const { getDb } = await import('../db/client.js');
    const r = await learn({ category: 'pattern', content: 'Old.', style: ['atomic', 'factual'] });
    if (!r.success) throw new Error(r.error);
    const id = (r.data as { id: string }).id;
    expect((await learnUpdate({ learningId: id, content: 'New.', style: ['atomic', 'factual'] })).success).toBe(true);
    learnArchive({ learningId: id });
    expect((getDb().prepare('SELECT COUNT(*) AS c FROM learnings_history').get() as { c: number }).c).toBe(0);
  });
});
