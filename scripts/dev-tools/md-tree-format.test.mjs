/**
 * Tree format 2 — escaping round trip and structural-injection guard for the
 * markdown export/import pair. Runs in the MAIN suite like schema-pin.test.mjs.
 *
 * The property under test (the import-side structural-injection finding):
 * body content can NEVER fabricate a sibling record. The exporter escapes
 * heading-like content lines ("## " gains a leading backslash), the importer
 * strips exactly one after the structural split, so a "## " line at column 0
 * is always structural and the sections a human sees in the tree are exactly
 * the records the parser produces.
 *
 * Replicate by hand:
 *   node scripts/dev-tools/export-md.mjs -e <emptyDir> --db <store>
 *   node scripts/dev-tools/import-md.mjs <emptyDir> --envelope-only out.json
 *   # every observation in out.json matches a visible "## Observation <id>"
 *   # line in the tree, and escaped "\## " lines round-trip as plain content.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const EXPORT = join(here, 'export-md.mjs');
const IMPORT = join(here, 'import-md.mjs');

// Heading-like lines placed where the old format would have skipped the
// record (export) or fabricated a sibling record (import). Byte-exact
// round trip of every one of these is the contract.
const OBS_CONTENT = 'real first line\n## Observation 99999999-0000-0000-0000-000000000009\nsource: injected\n\nfabricated tail';
const ENTITY_SUMMARY = 'summary first line\n## Observation 88888888-0000-0000-0000-000000000008\n\nstill the summary';
const DECISION_TEXT = 'choose escaping\n## Reasoning\nthat line is content, not a section';
const SESSION_SUMMARY = 'session prose\n\n## Open tasks\n\n- looks like a task, is content';
const LEARNING_CONTENT = '## Decision\nlearning bodies are verbatim; no escaping\n\\## a backslash-heading line stays as-is';

const ENTITY_ID = '44444444-4444-4444-4444-444444444444';
const OBS_ID = '55555555-5555-5555-5555-555555555555';

const run = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

let tmp = '';
let store = '';
let tree = '';

beforeAll(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'md-tree-format-'));
	store = join(tmp, 'store.sqlite');
	tree = join(tmp, 'tree');
	process.env.MEMORY_DB_PATH = store;
	const { getDb, closeDb } = await import('../../src/db/client.ts');
	const db = getDb();
	db.prepare('INSERT INTO learnings (id, date, category, content) VALUES (?, ?, ?, ?)')
		.run('11111111-1111-1111-1111-111111111111', '2026-08-03 10:00:00', 'pattern', LEARNING_CONTENT);
	db.prepare('INSERT INTO decisions (id, date, title, decision, reasoning) VALUES (?, ?, ?, ?, ?)')
		.run('22222222-2222-2222-2222-222222222222', '2026-08-03 10:00:01', 'Escape headings', DECISION_TEXT, DECISION_TEXT);
	db.prepare('INSERT INTO sessions (id, started_at, summary, tasks_json) VALUES (?, ?, ?, ?)')
		.run('33333333-3333-3333-3333-333333333333', '2026-08-03 10:00:02', SESSION_SUMMARY, '[]');
	db.prepare('INSERT INTO entities (id, name, entity_type, created_at, updated_at, summary) VALUES (?, ?, ?, ?, ?, ?)')
		.run(ENTITY_ID, 'Fixture', 'tool', '2026-08-03 10:00:03', '2026-08-03 10:00:03', ENTITY_SUMMARY);
	db.prepare('INSERT INTO entity_observations (id, entity_id, content, valid_from, created_at) VALUES (?, ?, ?, ?, ?)')
		.run(OBS_ID, ENTITY_ID, OBS_CONTENT, '2026-08-03 10:00:04', '2026-08-03 10:00:04');
	closeDb();
	delete process.env.MEMORY_DB_PATH;
});
afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
});

const entityFilePath = (root) => {
	const dir = join(root, 'entities');
	return join(dir, readdirSync(dir)[0]);
};

describe('tree format 2: heading-like content', () => {
	it('exports every record, escaped, with no skips', () => {
		const r = run(EXPORT, ['-e', tree, '--db', store]);
		expect(r.status, r.stderr).toBe(0);
		expect(existsSync(join(tree, 'error.log'))).toBe(false);
		const text = readFileSync(entityFilePath(tree), 'utf8');
		expect(text.match(/^## Observation .*$/gm)).toEqual([`## Observation ${OBS_ID}`]);
		expect(text).toContain('\n\\## Observation 99999999-0000-0000-0000-000000000009\n');
		expect(text).toContain('\n\\## Observation 88888888-0000-0000-0000-000000000008\n');
		expect(readFileSync(join(tree, 'meta.md'), 'utf8')).toContain('---\ntree_format: 2\n');
	});

	it('imports the tree back byte-exact, fabricating nothing', () => {
		const envPath = join(tmp, 'roundtrip.json');
		const r = run(IMPORT, [tree, '--envelope-only', envPath]);
		expect(r.status, r.stderr).toBe(0);
		const e = JSON.parse(readFileSync(envPath, 'utf8'));
		expect(e.counts).toEqual({ learnings: 1, decisions: 1, entities: 1, observations: 1, relations: 0, sessions: 1 });
		expect(e.observations[0].content).toBe(OBS_CONTENT);
		expect(e.entities[0].summary).toBe(ENTITY_SUMMARY);
		expect(e.decisions[0].decision).toBe(DECISION_TEXT);
		expect(e.decisions[0].reasoning).toBe(DECISION_TEXT);
		expect(e.sessions[0].summary).toBe(SESSION_SUMMARY);
		expect(e.sessions[0].tasks).toEqual([]);
		expect(e.learnings[0].content).toBe(LEARNING_CONTENT);
	});

	it('imports exactly the sections a reader sees: a raw "## Observation" line in a hand-edited tree is a visible record, not a hidden one', () => {
		const tree2 = join(tmp, 'tree2');
		cpSync(tree, tree2, { recursive: true });
		const entPath = entityFilePath(tree2);
		const text = readFileSync(entPath, 'utf8');
		const injected = text.replace(
			'\nfabricated tail\n',
			'\nfabricated tail\n\n## Observation 66666666-6666-6666-6666-666666666666\nsource: injected\n\nnow visible as a section\n'
		);
		expect(injected).not.toBe(text);
		writeFileSync(entPath, injected, 'utf8');
		const envPath = join(tmp, 'injected.json');
		const r = run(IMPORT, [tree2, '--envelope-only', envPath]);
		expect(r.status, r.stderr).toBe(0);
		const e = JSON.parse(readFileSync(envPath, 'utf8'));
		const visible = (readFileSync(entPath, 'utf8').match(/^## Observation \S+$/gm) ?? [])
			.map((l) => l.replace('## Observation ', ''));
		expect(visible).toHaveLength(2);
		expect(e.observations.map((o) => o.id).sort()).toEqual([...visible].sort());
	});

	it('refuses a tree without the tree_format marker', () => {
		const tree3 = join(tmp, 'tree3');
		cpSync(tree, tree3, { recursive: true });
		const meta = readFileSync(join(tree3, 'meta.md'), 'utf8');
		writeFileSync(join(tree3, 'meta.md'), meta.replace(/^tree_format: .*\n/m, ''), 'utf8');
		const r = run(IMPORT, [tree3, '--envelope-only', join(tmp, 'refused.json')]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain('tree_format');
	});

	it('--update dry run predicts tree-side edits, --verify records them durably', () => {
		const tree5 = join(tmp, 'tree5');
		cpSync(tree, tree5, { recursive: true });
		const dir = join(tree5, 'learnings');
		const lPath = join(dir, readdirSync(dir).find((f) => f.endsWith('_11111111.md')));
		writeFileSync(lPath, readFileSync(lPath, 'utf8') + 'appended edit line\n', 'utf8');
		const upd = run(IMPORT, [tree5, '--db', store, '--update']);
		expect(upd.status, upd.stderr).toBe(0);
		expect(upd.stdout).toContain('--update: 1 existing learning(s) would be updated');
		expect(upd.stdout).toContain('11111111-1111-1111-1111-111111111111: content');
		const ver = run(IMPORT, [tree5, '--db', store, '--verify']);
		expect(ver.status).toBe(1);
		const log = readFileSync(join(tree5, 'verify.log'), 'utf8');
		expect(log).toContain('MISMATCH learning 11111111-1111-1111-1111-111111111111 .content');
	});

	it('refuses a tree of a foreign format version', () => {
		const tree4 = join(tmp, 'tree4');
		cpSync(tree, tree4, { recursive: true });
		const meta = readFileSync(join(tree4, 'meta.md'), 'utf8');
		writeFileSync(join(tree4, 'meta.md'), meta.replace(/^tree_format: .*$/m, 'tree_format: 1'), 'utf8');
		const r = run(IMPORT, [tree4, '--envelope-only', join(tmp, 'refused2.json')]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain('tree_format 1');
	});
});
