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

	it('carries a rewrite with its tree style, a memoryType and a splitFrom (local-memory-mcp-i8n, -9z9)', () => {
		const other = join(tmp, 'split');
		cpSync(tree, other, { recursive: true });
		// The other machine split this entry out of L_TO_ARCHIVE and corrected its memory type; its style stays [].
		const used = fileEndingIn(other, 'learnings', L_USED);
		edit(used, 'memoryType: semantic', `memoryType: episodic\nsplitFrom: ${L_TO_ARCHIVE}`);
		edit(used, 'recalled often', `recalled often, split out of [[${L_TO_ARCHIVE.slice(0, 8)}]]`);
		const copy = join(tmp, 'split.sqlite');
		cpSync(store, copy);

		const dry = run(IMPORT, [other, '--db', copy, '--update']);
		expect(dry.status, dry.stderr).toBe(0);
		expect(dry.stdout).toContain(`    ${L_USED}: content, memoryType, style, splitFrom`);
		const apply = run(IMPORT, [other, '--db', copy, '--apply', '--update']);
		expect(apply.status, apply.stderr + apply.stdout).toBe(0);
		const ver = run(IMPORT, [other, '--db', copy, '--verify']);
		expect(ver.stdout).toContain('VERIFY: perfect round-trip, 0 mismatches.');
	});
});

describe('confirmation state through the tree (local-memory-mcp-4ip)', () => {
	it('carries a confirmation to the other machine, and an older tree never clears it', async () => {
		// Machine A confirms L_USED without changing its text.
		const machineA = join(tmp, 'verified-a.sqlite');
		cpSync(store, machineA);
		process.env.MEMORY_DB_PATH = machineA;
		const client = await import('../../src/db/client.ts');
		const { learnUpdate } = await import('../../src/tools/learn.ts');
		expect((await learnUpdate({ learningId: L_USED, verified: true })).success).toBe(true);
		const confirmed = client.getDb().prepare('SELECT verified, verified_at FROM learnings WHERE id = ?').get(L_USED);
		client.closeDb();
		expect(confirmed.verified).toBe(1);

		const treeA = join(tmp, 'verified-tree');
		expect(run(EXPORT, ['--sync', '-e', treeA, '--db', machineA]).status).toBe(0);
		const machineB = join(tmp, 'verified-b.sqlite');
		cpSync(store, machineB);
		const apply = run(IMPORT, [treeA, '--db', machineB, '--apply', '--update']);
		expect(apply.status, apply.stderr + apply.stdout).toBe(0);

		// The first tree, exported before the confirmation, must not undo it on B.
		const old = run(IMPORT, [tree, '--db', machineB, '--apply', '--update']);
		expect(old.status, old.stderr + old.stdout).toBe(0);
		process.env.MEMORY_DB_PATH = machineB;
		const onB = client.getDb().prepare('SELECT verified, verified_at FROM learnings WHERE id = ?').get(L_USED);
		client.closeDb();
		delete process.env.MEMORY_DB_PATH;
		expect(onB).toEqual(confirmed);
	});
});

describe('re-check state and reads through the tree (local-memory-mcp-w8u)', () => {
	it('carries a re-check mark to the other machine, an older tree never clears it, and reads stay local', async () => {
		// Machine A re-checks L_USED without changing its text and opens it once.
		const machineA = join(tmp, 'recheck-a.sqlite');
		cpSync(store, machineA);
		process.env.MEMORY_DB_PATH = machineA;
		const client = await import('../../src/db/client.ts');
		const { learnUpdate } = await import('../../src/tools/learn.ts');
		const { memoryGet } = await import('../../src/tools/get.ts');
		let onA;
		try {
			expect((await learnUpdate({ learningId: L_USED, rechecked: true })).success).toBe(true);
			memoryGet({ ids: [L_USED] });
			onA = client.getDb().prepare('SELECT rechecked_at, read_count FROM learnings WHERE id = ?').get(L_USED);
		} finally {
			// Leaves the shared store env clean for the next describe, even when an assertion above fails.
			client.closeDb();
			delete process.env.MEMORY_DB_PATH;
		}
		expect(onA.rechecked_at).not.toBeNull();
		expect(onA.read_count).toBe(1);

		const treeA = join(tmp, 'recheck-tree');
		expect(run(EXPORT, ['--sync', '-e', treeA, '--db', machineA]).status).toBe(0);
		const synced = readFileSync(fileEndingIn(treeA, 'learnings', L_USED), 'utf8');
		expect(synced).toContain(`recheckedAt: ${onA.rechecked_at}`);
		expect(synced).not.toMatch(/^readCount:/m);
		const full = join(tmp, 'recheck-full');
		expect(run(EXPORT, ['-e', full, '--db', machineA]).status).toBe(0);
		expect(readFileSync(fileEndingIn(full, 'learnings', L_USED), 'utf8')).toMatch(/^readCount: 1$/m);

		const machineB = join(tmp, 'recheck-b.sqlite');
		cpSync(store, machineB);
		const dry = run(IMPORT, [treeA, '--db', machineB, '--update']);
		expect(dry.stdout).toContain(`    learning ${L_USED}: rechecked at ${onA.rechecked_at}`);
		expect(run(IMPORT, [treeA, '--db', machineB, '--apply', '--update']).status).toBe(0);
		// The first tree, exported before the re-check, must not undo it on B.
		expect(run(IMPORT, [tree, '--db', machineB, '--apply', '--update']).status).toBe(0);
		process.env.MEMORY_DB_PATH = machineB;
		const onB = client.getDb().prepare('SELECT rechecked_at, read_count FROM learnings WHERE id = ?').get(L_USED);
		client.closeDb();
		delete process.env.MEMORY_DB_PATH;
		expect(onB).toEqual({ rechecked_at: onA.rechecked_at, read_count: 0 });

		const ver = run(IMPORT, [treeA, '--db', machineB, '--verify']);
		expect(ver.stdout).toContain('VERIFY: perfect round-trip, 0 mismatches.');
	});
});

describe('learning history through the tree (local-memory-mcp-mnb)', () => {
	it('carries the version made on one machine to the other, without a second one recorded there', async () => {
		// Machine A rewrites L_USED, which records the old text as a version.
		const machineA = join(tmp, 'history-a.sqlite');
		cpSync(store, machineA);
		process.env.MEMORY_DB_PATH = machineA;
		const client = await import('../../src/db/client.ts');
		const { learnUpdate } = await import('../../src/tools/learn.ts');
		const rewrite = await learnUpdate({ learningId: L_USED, content: 'recalled often, rewritten on A', style: ['atomic', 'factual'] });
		expect(rewrite.success).toBe(true);
		const [version] = client.getDb().prepare('SELECT id FROM learnings_history WHERE learning_id = ?').all(L_USED);
		client.closeDb();

		const treeA = join(tmp, 'history-tree');
		const exp = run(EXPORT, ['--sync', '-e', treeA, '--db', machineA]);
		expect(exp.status, exp.stderr).toBe(0);
		const files = readdirSync(join(treeA, 'learnings-history'));
		expect(files).toHaveLength(1);
		expect(readFileSync(join(treeA, 'learnings-history', files[0]), 'utf8')).toContain('recalled often');

		// Machine B still has the old text and no history.
		const machineB = join(tmp, 'history-b.sqlite');
		cpSync(store, machineB);
		const apply = run(IMPORT, [treeA, '--db', machineB, '--apply', '--update']);
		expect(apply.status, apply.stderr + apply.stdout).toBe(0);
		process.env.MEMORY_DB_PATH = machineB;
		const rows = client.getDb().prepare('SELECT id, content FROM learnings_history WHERE learning_id = ?').all(L_USED);
		const current = client.getDb().prepare('SELECT content FROM learnings WHERE id = ?').get(L_USED);
		client.closeDb();
		delete process.env.MEMORY_DB_PATH;
		expect(rows).toEqual([{ id: version.id, content: 'recalled often' }]);
		expect(current.content).toBe('recalled often, rewritten on A');

		const ver = run(IMPORT, [treeA, '--db', machineB, '--verify']);
		expect(ver.stdout).toContain('VERIFY: perfect round-trip, 0 mismatches.');
	});
});

describe('decision archive state through the tree (wikilabs-kfw)', () => {
	it('carries an archived decision to the other machine, and an older tree never reopens it', async () => {
		// Both machines hold two live decisions; then machine A archives the first.
		const machineA = join(tmp, 'decision-a.sqlite');
		cpSync(store, machineA);
		process.env.MEMORY_DB_PATH = machineA;
		const client = await import('../../src/db/client.ts');
		const { decide, decisionArchive } = await import('../../src/tools/decide.ts');
		let oldId, newId, onA;
		try {
			oldId = (await decide({ title: 'Old rule', decision: 'a', reasoning: 'r' })).data.id;
			newId = (await decide({ title: 'New rule', decision: 'b', reasoning: 'r' })).data.id;
			client.closeDb();
			expect(run(EXPORT, ['--sync', '-e', join(tmp, 'decision-base'), '--db', machineA]).status).toBe(0);
			cpSync(machineA, join(tmp, 'decision-b.sqlite'));
			client.getDb();
			expect(decisionArchive({ decisionId: oldId, reason: 'superseded', supersededBy: [newId] }).success).toBe(true);
			onA = client.getDb().prepare('SELECT archived, archived_at, lifecycle_state, superseded_by_json FROM decisions WHERE id = ?').get(oldId);
		} finally {
			client.closeDb();
			delete process.env.MEMORY_DB_PATH;
		}

		const treeA = join(tmp, 'decision-tree');
		expect(run(EXPORT, ['--sync', '-e', treeA, '--db', machineA]).status).toBe(0);
		const archivedFile = readFileSync(fileEndingIn(treeA, 'decisions-archived', oldId), 'utf8');
		expect(archivedFile).toMatch(/^archived: 1$/m);
		expect(archivedFile).toContain(`archivedAt: ${onA.archived_at}\n`);
		expect(archivedFile).toMatch(/^lifecycleState: archived:superseded$/m);
		expect(archivedFile).toContain(`supersededBy: ["${newId}"]\n`);
		// A live decision file stays as it was before the archive fields existed.
		expect(readFileSync(fileEndingIn(treeA, 'decisions', newId), 'utf8')).not.toMatch(/^(archived|archivedAt|lifecycleState|supersededBy):/m);

		const again = join(tmp, 'decision-tree-again');
		expect(run(EXPORT, ['--sync', '-e', again, '--db', machineA]).status).toBe(0);
		expect(listAll(again)).toEqual(listAll(treeA));
		for (const f of listAll(treeA)) expect(readFileSync(join(again, f), 'utf8'), f).toBe(readFileSync(join(treeA, f), 'utf8'));

		const machineB = join(tmp, 'decision-b.sqlite');
		const dry = run(IMPORT, [treeA, '--db', machineB, '--update']);
		expect(dry.stdout).toContain(`    decision ${oldId}: archived:superseded`);
		expect(run(IMPORT, [treeA, '--db', machineB, '--apply', '--update']).status).toBe(0);
		const second = run(IMPORT, [treeA, '--db', machineB, '--update']);
		expect(second.stdout).toContain('--update: 0 archive, validity or session change(s) would be written');
		// The base tree, exported before the archive, carries no archive fields and must not reopen it.
		const old = run(IMPORT, [join(tmp, 'decision-base'), '--db', machineB, '--apply', '--update']);
		expect(old.status, old.stderr + old.stdout).toBe(0);
		expect(old.stdout).not.toContain('NOT UPDATABLE');
		// A store that never held the decisions gets the archive state through memory_import.
		const fresh = join(tmp, 'decision-fresh.sqlite');
		expect(run(IMPORT, [treeA, '--db', fresh, '--apply']).status).toBe(0);
		for (const machine of [machineB, fresh]) {
			process.env.MEMORY_DB_PATH = machine;
			const row = client.getDb().prepare('SELECT archived, archived_at, lifecycle_state, superseded_by_json FROM decisions WHERE id = ?').get(oldId);
			client.closeDb();
			delete process.env.MEMORY_DB_PATH;
			expect(row, machine).toEqual(onA);
		}

		const ver = run(IMPORT, [treeA, '--db', machineB, '--verify']);
		expect(ver.stdout).toContain('VERIFY: perfect round-trip, 0 mismatches.');
	});
});
