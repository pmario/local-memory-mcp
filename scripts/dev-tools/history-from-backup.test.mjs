/**
 * history-from-backup.mjs stores a backup's text of a rewritten learning as its first version (local-memory-mcp-mnb).
 *
 * Replicate by hand:
 *   node scripts/dev-tools/history-from-backup.mjs --backup <backup> --db <store> --expired-at "2026-09-23 20:00:00" <id8>
 *   # the dry run names what it would add; --apply writes it, and a second run skips it
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'history-from-backup.mjs');
const REWRITTEN = 'aaaaaaaa-1111-4111-8111-111111111111';
const UNCHANGED = 'bbbbbbbb-2222-4222-8222-222222222222';

const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

let tmp = '';
let store = '';
let backup = '';

beforeAll(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'history-backfill-'));
	store = join(tmp, 'store.sqlite');
	backup = join(tmp, 'backup.sqlite');
	process.env.MEMORY_DB_PATH = store;
	const { getDb, closeDb } = await import('../../src/db/client.ts');
	const db = getDb();
	const learn = db.prepare('INSERT INTO learnings (id, date, category, content) VALUES (?, ?, ?, ?)');
	learn.run(REWRITTEN, '2026-08-01 10:00:00', 'pattern', 'Old text, before the rewrite.');
	learn.run(UNCHANGED, '2026-08-01 10:00:01', 'pattern', 'Never rewritten.');
	closeDb();
	cpSync(store, backup);
	// The rewrite happened before learnings_history existed, so it left no version.
	process.env.MEMORY_DB_PATH = store;
	getDb().prepare("UPDATE learnings SET content = 'New text.' WHERE id = ?").run(REWRITTEN);
	closeDb();
	delete process.env.MEMORY_DB_PATH;
});
afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe('history-from-backup.mjs', () => {
	const args = () => ['--backup', backup, '--db', store, '--expired-at', '2026-09-23 20:00:00', REWRITTEN.slice(0, 8), UNCHANGED];

	it('predicts the version in a dry run and writes nothing', async () => {
		const r = run(args());
		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toContain(`WOULD ADD ${REWRITTEN}`);
		expect(r.stdout).toContain(`SKIP ${UNCHANGED}: text unchanged since the backup`);
		expect(r.stdout).toContain('1 version(s) would be added');
	});

	it('writes the old text as the first version with --apply, and a second run skips it', async () => {
		const r = run([...args(), '--apply']);
		expect(r.status, r.stderr).toBe(0);
		process.env.MEMORY_DB_PATH = store;
		const { getDb, closeDb } = await import('../../src/db/client.ts');
		const rows = getDb().prepare('SELECT content, recorded_at, expired_at FROM learnings_history WHERE learning_id = ?').all(REWRITTEN);
		closeDb();
		delete process.env.MEMORY_DB_PATH;
		expect(rows).toEqual([{ content: 'Old text, before the rewrite.', recorded_at: '2026-08-01 10:00:00', expired_at: '2026-09-23 20:00:00' }]);

		const again = run([...args(), '--apply']);
		expect(again.stdout).toContain(`SKIP ${REWRITTEN}: already has versions`);
		expect(again.stdout).toContain('0 version(s) added');
	});
});
