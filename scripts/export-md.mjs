#!/usr/bin/env node
/**
 * export-md.mjs — export the memory store to a human-readable markdown tree.
 * Companion of import-md.mjs; together they round-trip the store losslessly:
 * learnings, decisions, sessions, entities with their observations, and
 * relations.
 *
 * Every envelope field is carried in the file's frontmatter and the body is
 * preserved byte-exact: the writer appends exactly one newline, the reader
 * strips exactly one. The target must be a NEW or EMPTY directory: the
 * script never deletes anything, and because every export starts from an
 * empty target, renamed, archived or deleted entries cannot linger as stale
 * files.
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';

const require = createRequire(import.meta.url);

function defaultDataDir() {
	const home = homedir();
	if (platform() === 'darwin') return join(home, 'Library', 'Application Support', 'local-memory-mcp');
	if (platform() === 'win32') return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'local-memory-mcp');
	return join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'local-memory-mcp');
}

// OS Downloads folder. Windows and macOS keep the filesystem name "Downloads"
// (Finder/Explorer only display it localized); on Linux the localized real
// path lives in xdg-user-dirs config, with ~/Downloads as headless fallback.
export function downloadsDir() {
	const home = homedir();
	if (platform() === 'linux') {
		const conf = join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'user-dirs.dirs');
		if (existsSync(conf)) {
			const m = readFileSync(conf, 'utf8').match(/^XDG_DOWNLOAD_DIR="(.*)"$/m);
			if (m) return m[1].replace('$HOME', home);
		}
	}
	return join(home, 'Downloads');
}

const HELP = `export-md.mjs — export the memory store to a markdown tree

Usage: node scripts/export-md.mjs [options] [outDir]

Without -e or --export this is a DRY RUN: it reports what would be
exported and where, and writes nothing. Run bare to see this help plus
the dry run.

The export is IDEMPOTENT: the same store always produces a byte-identical
tree. The target must be a NEW or EMPTY directory; the script never
deletes anything, so remove a previous export yourself before re-running.

Arguments:
  outDir            target directory
                    (default: <Downloads>/local-memory-export)

Options:
  -e, --export      perform the export (default is a dry run)
  --db <path>       source database
                    (default: MEMORY_DB_PATH env, else <data-dir>/memory.sqlite)
  --dry-run         explicit dry run (same as the default)
  --help            show this help

Output tree:
  INDEX.md                       linked overview (regenerated, not imported)
  learnings/           one file per learning: frontmatter + verbatim content
  learnings-archived/  archived learnings, same format
  decisions/           title/decision/reasoning/alternatives as sections
  sessions/            one file per session, summary + open tasks
  entities/            one file per entity; every observation is a
                       "## Observation <id>" section with its metadata lines
  relations.md         canonical, lossless list of entity relations
  meta.md              all store meta keys; schema_version guards the round trip
`;

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
	process.stdout.write(HELP);
	process.exit(0);
}
if (argv.length === 0) process.stdout.write(HELP + '\n');
const doExport = argv.includes('-e') || argv.includes('--export');
const dbFlag = argv.indexOf('--db');
const dbPath = dbFlag !== -1 ? argv[dbFlag + 1] : (process.env.MEMORY_DB_PATH ?? join(defaultDataDir(), 'memory.sqlite'));
const positional = argv.filter((a, i) => !a.startsWith('-') && argv[i - 1] !== '--db');
const outDir = positional[0] ?? join(downloadsDir(), 'local-memory-export');

const Database = require('better-sqlite3');
const db = new Database(dbPath, { readonly: true });

// Schema drift guard. The export names every column explicitly, so a column
// ADDED by a newer server would be silently dropped and the round trip would
// lose data. Refuse instead, and name what changed. (A removed or renamed
// column already fails loudly in the SELECT.)
const EXPECTED_COLUMNS = {
	learnings: ['id', 'date', 'category', 'content', 'project', 'tags_json', 'usage_count', 'last_used', 'confidence', 'source', 'verified', 'verified_at', 'archived', 'archived_at', 'importance', 'lifecycle_state', 'memory_type'],
	decisions: ['id', 'date', 'title', 'decision', 'alternatives', 'reasoning', 'project', 'tags_json', 'confidence', 'source', 'verified', 'verified_at'],
	entities: ['id', 'name', 'entity_type', 'created_at', 'updated_at', 'summary', 'confidence'],
	entity_observations: ['id', 'entity_id', 'content', 'source', 'session_id', 'valid_from', 'valid_to', 'confidence', 'created_at'],
	entity_relations: ['id', 'from_entity_id', 'to_entity_id', 'relation_type', 'weight', 'created_at'],
	sessions: ['id', 'started_at', 'ended_at', 'project', 'summary', 'tasks_json'],
};
// schema_version is a declaration, the column lists are ground truth; the
// version check additionally catches a migration that ADDS A TABLE this
// script does not know about.
const EXPECTED_SCHEMA_VERSION = '2';
const schemaDrift = [];
const storeSchemaVersion = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value ?? 'unknown';
if (storeSchemaVersion !== EXPECTED_SCHEMA_VERSION) {
	schemaDrift.push(`meta: schema_version is ${storeSchemaVersion}, this script was written for ${EXPECTED_SCHEMA_VERSION}`);
}
for (const [table, expected] of Object.entries(EXPECTED_COLUMNS)) {
	const actual = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
	const unknown = actual.filter((c) => !expected.includes(c));
	const missing = expected.filter((c) => !actual.includes(c));
	if (unknown.length || missing.length) {
		schemaDrift.push(`${table}: ${unknown.length ? `unknown column(s) ${unknown.join(', ')}` : ''}${unknown.length && missing.length ? '; ' : ''}${missing.length ? `missing column(s) ${missing.join(', ')}` : ''}`);
	}
}

const targetState = !existsSync(outDir) ? 'missing' : readdirSync(outDir).length === 0 ? 'empty' : 'not-empty';

if (!doExport) {
	const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
	console.log(`DRY-RUN: would export ${dbPath}`);
	console.log(`  -> ${outDir} (${targetState === 'missing' ? 'will be created' : targetState === 'empty' ? 'empty, ok' : 'NOT EMPTY: a real run would refuse'})`);
	console.log(`  learnings: ${count('learnings')} (${db.prepare('SELECT COUNT(*) AS n FROM learnings WHERE archived = 1').get().n} archived)`);
	console.log(`  decisions: ${count('decisions')}`);
	console.log(`  entities: ${count('entities')} (${count('entity_observations')} observations, ${count('entity_relations')} relations)`);
	console.log(`  sessions: ${count('sessions')}`);
	if (schemaDrift.length) {
		console.log(`  SCHEMA DRIFT: a real run would refuse.\n    ${schemaDrift.join('\n    ')}`);
	}
	console.log('Nothing was written. Pass -e or --export to write.');
	db.close();
	process.exit(0);
}

if (schemaDrift.length) {
	console.error('Refusing: the store schema does not match this script, the export would lose data.');
	for (const d of schemaDrift) console.error(`  ${d}`);
	console.error('Update scripts/export-md.mjs (and import-md.mjs) for the new schema.');
	db.close();
	process.exit(2);
}

if (targetState === 'not-empty') {
	console.error(`Refusing: outDir is not empty: ${outDir}`);
	console.error('The export only writes into a new or empty directory and never deletes anything. Empty it yourself or pass a different outDir.');
	db.close();
	process.exit(2);
}

const slug = (text, max = 60) =>
	String(text)
		.split('\n')[0]
		.toLowerCase()
		.replace(/[^a-z0-9äöüß]+/gi, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, max)
		.replace(/-+$/, '') || 'untitled';

// Frontmatter values must survive a line-based parser: anything risky
// (newlines, leading bracket or quote, edge whitespace) is JSON-quoted and
// the reader detects that by the first character.
const fmValue = (v) => {
	if (typeof v === 'number') return String(v);
	if (Array.isArray(v)) return JSON.stringify(v);
	const s = String(v);
	return /[\r\n]/.test(s) || /^[["\s]/.test(s) || /\s$/.test(s) ? JSON.stringify(s) : s;
};
const fm = (pairs) => {
	const lines = ['---'];
	for (const [k, v] of Object.entries(pairs)) {
		if (v === null || v === undefined || v === '') continue;
		lines.push(`${k}: ${fmValue(v)}`);
	}
	lines.push('---', '');
	return lines.join('\n');
};

const write = (relPath, text) => {
	const full = join(outDir, relPath);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, text, 'utf8');
	return relPath.replace(/\\/g, '/');
};

const index = { learnings: [], 'archived learnings': [], decisions: [], entities: [], sessions: [] };

const learnings = db.prepare(
	`SELECT id, date, category, content, project, tags_json, usage_count, last_used,
	        confidence, source, verified, verified_at, archived, archived_at,
	        importance, lifecycle_state, memory_type
	 FROM learnings ORDER BY date, id`
).all();
for (const l of learnings) {
	const day = String(l.date).slice(0, 10);
	const dir = l.archived ? 'learnings-archived' : 'learnings';
	const rel = write(
		join(dir, `${day}_${slug(l.content)}_${l.id.slice(0, 8)}.md`),
		fm({
			id: l.id,
			date: l.date,
			category: l.category,
			project: l.project,
			tags: JSON.parse(l.tags_json),
			usageCount: l.usage_count,
			lastUsed: l.last_used,
			confidence: l.confidence,
			source: l.source,
			verified: l.verified,
			verifiedAt: l.verified_at,
			archived: l.archived,
			archivedAt: l.archived_at,
			importance: l.importance,
			lifecycleState: l.lifecycle_state,
			memoryType: l.memory_type,
		}) + l.content + '\n'
	);
	index[l.archived ? 'archived learnings' : 'learnings'].push(
		`- [${day} · ${l.category}${l.project ? ' · ' + l.project : ''}](${rel}) — ${String(l.content).split('\n')[0].slice(0, 100)}`
	);
}

const decisions = db.prepare(
	`SELECT id, date, title, decision, alternatives, reasoning, project, tags_json,
	        confidence, source, verified, verified_at
	 FROM decisions ORDER BY date, id`
).all();
for (const d of decisions) {
	const day = String(d.date).slice(0, 10);
	let body = `# ${d.title}\n\n## Decision\n\n${d.decision}\n\n## Reasoning\n\n${d.reasoning}`;
	if (d.alternatives) body += `\n\n## Alternatives considered\n\n${d.alternatives}`;
	const rel = write(
		join('decisions', `${day}_${slug(d.title)}_${d.id.slice(0, 8)}.md`),
		fm({
			id: d.id,
			date: d.date,
			project: d.project,
			tags: JSON.parse(d.tags_json),
			confidence: d.confidence,
			source: d.source,
			verified: d.verified,
			verifiedAt: d.verified_at,
		}) + body + '\n'
	);
	index.decisions.push(`- [${day} · ${d.title}](${rel})`);
}

// Entities are lossless since the round-trip upgrade: every observation is a
// "## Observation <id>" section whose metadata lines sit directly under the
// heading, followed by the verbatim content. The per-entity Relations list is
// regenerated decoration; relations.md is the canonical, lossless home.
const kvLines = (pairs) => {
	const lines = [];
	for (const [k, v] of Object.entries(pairs)) {
		if (v === null || v === undefined || v === '') continue;
		lines.push(`${k}: ${fmValue(v)}`);
	}
	return lines.join('\n');
};

const entities = db.prepare(
	`SELECT id, name, entity_type, created_at, updated_at, summary, confidence FROM entities ORDER BY name, id`
).all();
const obsStmt = db.prepare(
	`SELECT id, content, source, session_id, valid_from, valid_to, confidence, created_at
	 FROM entity_observations WHERE entity_id = ? ORDER BY created_at, id`
);
const relDecoStmt = db.prepare(
	`SELECT r.relation_type, ef.name AS from_name, et.name AS to_name
	 FROM entity_relations r
	 JOIN entities ef ON ef.id = r.from_entity_id
	 JOIN entities et ON et.id = r.to_entity_id
	 WHERE r.from_entity_id = ? OR r.to_entity_id = ?
	 ORDER BY r.created_at, r.id`
);
for (const e of entities) {
	const obs = obsStmt.all(e.id);
	const rels = relDecoStmt.all(e.id, e.id);
	let body = `# ${e.name}\n\n`;
	if (e.summary) body += `${e.summary}\n\n`;
	for (const o of obs) {
		body += `## Observation ${o.id}\n`;
		body += kvLines({
			validFrom: o.valid_from,
			validTo: o.valid_to,
			confidence: o.confidence,
			createdAt: o.created_at,
			sessionId: o.session_id,
			source: o.source,
		});
		body += `\n\n${o.content}\n\n`;
	}
	if (rels.length) {
		body += `## Relations (regenerated, canonical in relations.md)\n\n`;
		for (const r of rels) body += `- ${r.from_name} —${r.relation_type}→ ${r.to_name}\n`;
		body += '\n';
	}
	const rel = write(
		join('entities', `${e.entity_type}_${slug(e.name)}_${e.id.slice(0, 8)}.md`),
		fm({ id: e.id, name: e.name, type: e.entity_type, created: e.created_at, updated: e.updated_at, confidence: e.confidence }) + body.replace(/\n+$/, '\n')
	);
	index.entities.push(`- [${e.name} (${e.entity_type})](${rel}) — ${obs.length} observations`);
}

const relations = db.prepare(
	`SELECT r.id, r.from_entity_id, r.to_entity_id, r.relation_type, r.weight, r.created_at,
	        ef.name AS from_name, et.name AS to_name
	 FROM entity_relations r
	 JOIN entities ef ON ef.id = r.from_entity_id
	 JOIN entities et ON et.id = r.to_entity_id
	 ORDER BY r.created_at, r.id`
).all();
if (relations.length) {
	let body = `# Relations\n\n`;
	for (const r of relations) {
		body += `## ${r.from_name} —${r.relation_type}→ ${r.to_name}\n`;
		body += kvLines({
			id: r.id,
			from: r.from_entity_id,
			to: r.to_entity_id,
			relationType: r.relation_type,
			weight: r.weight,
			createdAt: r.created_at,
		});
		body += '\n\n';
	}
	write('relations.md', body.replace(/\n+$/, '\n'));
	index.entities.push(`- [Relations](relations.md) — ${relations.length} edges`);
}

const sessions = db.prepare(
	`SELECT id, started_at, ended_at, project, summary, tasks_json FROM sessions ORDER BY started_at, id`
).all();
sessions.forEach((s, i) => {
	const tasks = JSON.parse(s.tasks_json ?? '[]');
	let body = s.summary ?? '';
	if (tasks.length) body += `\n\n## Open tasks\n\n${tasks.map((t) => `- ${t}`).join('\n')}`;
	const rel = write(
		join('sessions', `${String(i + 1).padStart(3, '0')}_${String(s.started_at).slice(0, 10)}_${s.id.slice(0, 8)}.md`),
		fm({ id: s.id, startedAt: s.started_at, endedAt: s.ended_at, project: s.project }) + body + '\n'
	);
	index.sessions.push(`- [${String(s.started_at).slice(0, 16)}${s.project ? ' · ' + s.project : ''}](${rel})`);
});

// All meta keys, always: schema_version lets the tree self-describe its
// vintage (the importer checks it); embedding_model/embedding_dim/first_run_at
// are provenance owned by the server and are never pushed back on import.
const metaPairs = {};
for (const r of db.prepare(`SELECT key, value FROM meta ORDER BY key`).all()) metaPairs[r.key] = r.value;
write('meta.md', fm(metaPairs) + 'Store metadata. profile_* keys and current_goal are imported; schema_version guards the round trip; all other keys are server-owned provenance.\n');

let idx = `# Memory export\n\nSource: \`${dbPath}\` (read-only)\n\n`;
for (const [section, lines] of Object.entries(index)) {
	if (!lines.length) continue;
	idx += `## ${section[0].toUpperCase() + section.slice(1)} (${lines.length})\n\n${lines.join('\n')}\n\n`;
}
write('INDEX.md', idx);

db.close();
console.log(`Exported to ${outDir}:`);
console.log(`  ${learnings.length} learnings, ${decisions.length} decisions, ${entities.length} entities, ${sessions.length} sessions`);
