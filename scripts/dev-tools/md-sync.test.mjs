/**
 * --sync export and --update reconcile: the two halves of syncing one store
 * between machines through a git-carried tree. Runs in the MAIN suite.
 *
 * Replicate by hand:
 *   node scripts/dev-tools/export-md.mjs --sync -e <emptyDir> --db <store>
 *   # edit the tree: archive a learning, set an observation's validTo
 *   node scripts/dev-tools/import-md.mjs <emptyDir> --db <store> --update
 *   # the dry run lists every change; --apply --update writes them
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const EXPORT = join(here, 'export-md.mjs');
const IMPORT = join(here, 'import-md.mjs');

const L_USED = '11111111-1111-4111-8111-111111111111';
const L_TO_ARCHIVE = '22222222-2222-4222-8222-222222222222';
const L_ARCHIVED = '33333333-3333-4333-8333-333333333333';
const ENTITY = '44444444-4444-4444-8444-444444444444';
const OBS = '55555555-5555-4555-8555-555555555555';
const S_ENDED = '66666666-6666-4666-8666-666666666666';
const S_OPEN = '77777777-7777-4777-8777-777777777777';

const run = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

let tmp = '';
let store = '';
let tree = '';

beforeAll(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'md-sync-'));
	store = join(tmp, 'store.sqlite');
	tree = join(tmp, 'tree');
	process.env.MEMORY_DB_PATH = store;
	const { getDb, closeDb } = await import('../../src/db/client.ts');
	const db = getDb();
	const learn = db.prepare('INSERT INTO learnings (id, date, category, content, usage_count, last_used, archived, archived_at, lifecycle_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
	learn.run(L_USED, '2026-09-10 10:00:00', 'pattern', 'recalled often', 5, '2026-09-11 08:00:00', 0, null, 'active');
	learn.run(L_TO_ARCHIVE, '2026-09-10 10:00:01', 'pattern', 'about to be archived elsewhere', 0, null, 0, null, 'active');
	learn.run(L_ARCHIVED, '2026-09-10 10:00:02', 'pattern', 'archived here', 0, null, 1, '2026-09-10 12:00:00', 'archived:old');
	db.prepare('INSERT INTO entities (id, name, entity_type, created_at, updated_at, summary) VALUES (?, ?, ?, ?, ?, ?)')
		.run(ENTITY, 'Fixture', 'tool', '2026-09-10 10:00:03', '2026-09-11 09:00:00', 'old summary');
	db.prepare('INSERT INTO entity_observations (id, entity_id, content, valid_from, created_at) VALUES (?, ?, ?, ?, ?)')
		.run(OBS, ENTITY, 'a fact', '2026-09-10 10:00:04', '2026-09-10 10:00:04');
	const session = db.prepare('INSERT INTO sessions (id, started_at, ended_at, summary, tasks_json) VALUES (?, ?, ?, ?, ?)');
	session.run(S_ENDED, '2026-09-10 08:00:00', '2026-09-10 09:00:00', 'did things', '["next step"]');
	session.run(S_OPEN, '2026-09-11 08:00:00', null, null, null);
	db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('first_run_at', '2026-09-01 00:00:00')").run();
	closeDb();
	delete process.env.MEMORY_DB_PATH;
	const r = run(EXPORT, ['--sync', '-e', tree, '--db', store]);
	if (r.status !== 0) throw new Error(`export failed: ${r.stderr}`);
});
afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
});

const fileEndingIn = (root, sub, idPrefix) => {
	const dir = join(root, sub);
	return join(dir, readdirSync(dir).find((f) => f.endsWith(`_${idPrefix.slice(0, 8)}.md`)));
};
const listAll = (root) => readdirSync(root, { recursive: true, withFileTypes: true })
	.filter((d) => d.isFile())
	.map((d) => relative(root, join(d.parentPath ?? d.path, d.name)))
	.sort();
const edit = (path, from, to) => {
	const text = readFileSync(path, 'utf8');
	expect(text, `${path} should contain ${JSON.stringify(from)}`).toContain(from);
	writeFileSync(path, text.replace(from, to), 'utf8');
};

describe('export-md --sync', () => {
	it('leaves out machine-local values, INDEX.md and open sessions', () => {
		expect(existsSync(join(tree, 'INDEX.md'))).toBe(false);
		const used = readFileSync(fileEndingIn(tree, 'learnings', L_USED), 'utf8');
		expect(used).not.toMatch(/^(usageCount|lastUsed):/m);
		expect(readFileSync(fileEndingIn(tree, 'entities', ENTITY), 'utf8')).not.toMatch(/^updated:/m);
		const meta = readFileSync(join(tree, 'meta.md'), 'utf8');
		expect(meta).toMatch(/^tree_format: 2$/m);
		expect(meta).toMatch(/^schema_version: /m);
		expect(meta).not.toMatch(/^first_run_at:/m);
		expect(readdirSync(join(tree, 'sessions'))).toEqual(['2026-09-10-08-00-00_66666666.md']);
	});

	it('writes a byte-identical tree when run again', () => {
		const again = join(tmp, 'again');
		const r = run(EXPORT, ['--sync', '-e', again, '--db', store]);
		expect(r.status, r.stderr).toBe(0);
		expect(listAll(again)).toEqual(listAll(tree));
		for (const f of listAll(tree)) expect(readFileSync(join(again, f), 'utf8'), f).toBe(readFileSync(join(tree, f), 'utf8'));
	});
});

describe('import-md --update against a --sync tree', () => {
	it('finds nothing to change in the tree it just exported, and verifies clean', () => {
		const upd = run(IMPORT, [tree, '--db', store, '--update']);
		expect(upd.status, upd.stderr).toBe(0);
		expect(upd.stdout).toContain('--update: 0 existing learning(s) would be updated');
		expect(upd.stdout).toContain('--update: 0 entity summary(ies) would be updated');
		expect(upd.stdout).toContain('--update: 0 archive, validity or session change(s) would be written');
		expect(upd.stdout).not.toContain('NOT UPDATABLE');
		const ver = run(IMPORT, [tree, '--db', store, '--verify']);
		expect(ver.status, ver.stdout).toBe(0);
		expect(ver.stdout).toContain('VERIFY: perfect round-trip, 0 mismatches.');
	});

	it('predicts every change the other machine made, and refuses to reopen', () => {
		const other = join(tmp, 'other');
		cpSync(tree, other, { recursive: true });
		// The other machine archived one learning, superseded the observation,
		// rewrote the entity summary and amended a session summary.
		const toArchive = fileEndingIn(other, 'learnings', L_TO_ARCHIVE);
		edit(toArchive, 'archived: 0\n', 'archived: 1\narchivedAt: 2026-09-11 10:00:00\n');
		edit(toArchive, 'lifecycleState: active', 'lifecycleState: archived:superseded');
		const entity = fileEndingIn(other, 'entities', ENTITY);
		edit(entity, 'old summary', 'new summary');
		edit(entity, `## Observation ${OBS}\n`, `## Observation ${OBS}\nvalidTo: 2026-09-11 11:00:00\n`);
		edit(fileEndingIn(other, 'sessions', S_ENDED), 'did things', 'did more things');
		// A tree claiming an archived learning is live must not reopen it.
		const archived = fileEndingIn(other, 'learnings-archived', L_ARCHIVED);
		edit(archived, 'archived: 1\n', 'archived: 0\n');
		edit(archived, 'lifecycleState: archived:old', 'lifecycleState: active');

		const upd = run(IMPORT, [other, '--db', store, '--update']);
		expect(upd.status, upd.stderr).toBe(0);
		expect(upd.stdout).toContain('--update: 0 existing learning(s) would be updated');
		expect(upd.stdout).toContain('--update: 1 entity summary(ies) would be updated');
		expect(upd.stdout).toContain(`    ${ENTITY}: summary`);
		expect(upd.stdout).toContain('--update: 3 archive, validity or session change(s) would be written');
		expect(upd.stdout).toContain(`    learning ${L_TO_ARCHIVE}: archived:superseded`);
		expect(upd.stdout).toContain(`    observation ${OBS}: validTo 2026-09-11 11:00:00`);
		expect(upd.stdout).toContain(`    session ${S_ENDED}: ended 2026-09-10 09:00:00`);
		expect(upd.stdout).toContain(`NOT UPDATABLE ${L_ARCHIVED}: archived in the store but not in the tree`);
	});
});
