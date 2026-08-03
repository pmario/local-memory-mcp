#!/usr/bin/env node
/**
 * export-md.mjs — export the memory store to a human-readable markdown tree.
 * Companion of import-md.mjs; together they round-trip the store losslessly:
 * learnings, decisions, sessions, entities with their observations, and
 * relations.
 *
 * Every envelope field is carried in the file's frontmatter and the body is
 * preserved byte-exact: the writer appends exactly one newline, the reader
 * strips exactly one. In bodies the importer re-parses by "## " sections,
 * heading-like content lines are escaped (tree format 2), so body text can
 * never fabricate a section. The target must be a NEW or EMPTY directory: the
 * script never deletes anything, and because every export starts from an
 * empty target, renamed, archived or deleted entries cannot linger as stale
 * files.
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
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

Usage: node scripts/dev-tools/export-md.mjs [options] [outDir]

Without -e or --export this is a DRY RUN: it reports what would be
exported and where, and writes nothing. Run bare to see this help plus
the dry run.

The export is IDEMPOTENT: the same store always produces a byte-identical
tree. The target must be a NEW or EMPTY directory; the script never
deletes anything, so remove a previous export yourself before re-running.

SKIP-AND-WARN: a record that would corrupt the tree (a crafted name, title
or id that cannot sit on its heading line, or a filename clash, only
possible in a poisoned store) is excluded rather than aborting the whole
backup. Every skip, with the full offending data, is written to
<outDir>/error.log so nothing is silently lost.

TREE FORMAT 2: in bodies that import-md.mjs re-parses by "## " sections
(observations, summaries, decision fields, tasks), a content line that
would read as a heading gains a leading backslash ("\## ") and the
importer strips exactly one, so content can never fabricate a record.
meta.md records tree_format: 2; the importer refuses a tree without it.

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
	if (schemaDrift.length) {
		console.log(`  SCHEMA DRIFT: a real run would refuse.\n    ${schemaDrift.join('\n    ')}`);
	}
	console.log('');
	console.log('Store content:');
	console.log(`  learnings: ${count('learnings')} (${db.prepare('SELECT COUNT(*) AS n FROM learnings WHERE archived = 1').get().n} archived)`);
	console.log(`  decisions: ${count('decisions')}`);
	console.log(`  sessions: ${count('sessions')}`);
	console.log(`  entities: ${count('entities')} (${count('entity_observations')} observations, ${count('entity_relations')} relations)`);
	console.log('');
	console.log(`  -> ${outDir} (${targetState === 'missing' ? 'will be created' : targetState === 'empty' ? 'empty, ok' : 'NOT EMPTY: a real run would refuse'})`);
	console.log('  Pass -e or --export to write.');
	console.log('');
	console.log('Nothing was written.');
	db.close();
	process.exit(0);
}

if (schemaDrift.length) {
	console.error('Refusing: the store schema does not match this script, the export would lose data.');
	for (const d of schemaDrift) console.error(`  ${d}`);
	console.error('Update scripts/dev-tools/export-md.mjs (and import-md.mjs) for the new schema.');
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

// Every filename component is derived from store data, so ANY of them can be
// hostile after a crafted --apply (see the memory_import validation gap). id
// fragments, dates and entity_type are not free text but must still never
// carry a path separator or "..": run each through slug so a filename can only
// ever be a single, safe path segment.
const part = (text) => slug(text, 40);

// Tree format version, recorded in meta.md and required by import-md.mjs.
// Format 2 escapes heading-like content lines (escapeContent below) so that a
// "## " line at column 0 is ALWAYS structural and body text can never
// fabricate a sibling record on re-import.
const TREE_FORMAT = '2';

// Escape for bodies the importer re-parses by "## " sections (observation
// content, entity summaries, decision fields, session summaries and tasks):
// a line of backslashes followed by "## " gains one backslash, and the
// importer strips exactly one, so the round trip stays byte-exact. Learning
// bodies are verbatim and never re-parsed, so never escaped.
const escapeContent = (text) => String(text).replace(/^(\\*## )/gm, '\\$1');

// Decorative lines (per-entity relation lists, relations.md headings) embed
// entity names and relation types; a crafted newline in one would start a new
// line that could be structural, so decoration is flattened to one line. The
// canonical values live in kv/frontmatter lines, which JSON-quote newlines.
const oneLine = (text) => String(text).replace(/[\r\n]+/g, ' ');

// Skip-and-warn. A record that would corrupt the tree (reserved heading in
// content, a filename collision, an escaping path, or an unsafe meta key) is
// EXCLUDED from the export rather than aborting the whole backup, and recorded
// here in full so nothing is silently lost and the offending data stays
// recoverable. The good records still export; the log lands at <outDir>/error.log.
const skipLog = [];
// `what` is a HUMAN descriptor (table + natural name + id), so the log is
// actionable without a UUID lookup, e.g. `entity "Evil" (tool) [aaaa…]`.
const skip = (what, reason, data) => {
	skipLog.push({ what, reason, data: data == null ? '' : String(data) });
	console.warn(`  SKIPPED ${what} — ${reason}`);
};

// Frontmatter values must survive a line-based parser: anything risky
// (newlines, leading bracket or quote, edge whitespace) is JSON-quoted and
// the reader detects that by the first character.
const fmValue = (v) => {
	if (typeof v === 'number') return String(v);
	if (Array.isArray(v)) return JSON.stringify(v);
	const s = String(v);
	return /[\r\n]/.test(s) || /^[["\s]/.test(s) || /\s$/.test(s) ? JSON.stringify(s) : s;
};
// Frontmatter keys must be bare identifiers. Record callers pass hardcoded
// keys; only meta.md forwards store-controlled names, and those are
// pre-filtered (and logged) before fm sees them, so this stays a silent
// defensive drop.
const isSafeKey = (k) => /^[A-Za-z0-9_]+$/.test(k);
const fm = (pairs) => {
	const lines = ['---'];
	for (const [k, v] of Object.entries(pairs)) {
		if (v === null || v === undefined || v === '') continue;
		if (!isSafeKey(k)) continue;
		lines.push(`${k}: ${fmValue(v)}`);
	}
	lines.push('---', '');
	return lines.join('\n');
};

// Containment guard: the definitive path-traversal defense. Whatever the
// filename components, the resolved absolute path must stay inside outDir.
const outAbs = resolve(outDir);
const write = (relPath, text, what) => {
	const full = resolve(outDir, relPath);
	// Definitive path-traversal backstop: the resolved path must stay inside
	// outDir. With component sanitising this should never fire; if it does, the
	// record is skipped rather than escaping.
	if (full !== outAbs && !full.startsWith(outAbs + sep)) {
		skip(what, `computed path escapes the target directory: ${relPath}`, text);
		return null;
	}
	// Never overwrite. The target starts empty, so an existing file means two
	// records sanitised to the same filename (crafted ids/entity_type can force
	// this). Skip the clashing record instead of silently overwriting.
	if (existsSync(full)) {
		skip(what, `filename collision on ${relPath.replace(/\\/g, '/')}; another record already wrote it`, text);
		return null;
	}
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, text, 'utf8');
	return relPath.replace(/\\/g, '/');
};

const index = { learnings: [], 'archived learnings': [], decisions: [], entities: [], sessions: [] };
const wrote = { learnings: 0, decisions: 0, entities: 0, sessions: 0 };
const skippedEntityIds = new Set();

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
		join(dir, `${part(day)}_${slug(l.content)}_${part(l.id.slice(0, 8))}.md`),
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
		}) + l.content + '\n',
		`learning ${day} "${String(l.content).split('\n')[0].slice(0, 60)}" [${l.id}]`
	);
	if (!rel) continue;
	wrote.learnings++;
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
	const dWhat = `decision "${oneLine(d.title)}" [${d.id}]`;
	// The title lives on the "# <title>" heading line; a crafted line break in
	// it would spill structural lines into the body, and escaping cannot help a
	// heading. Such a title cannot be represented, so the record is skipped.
	if (/[\r\n]/.test(String(d.title))) {
		skip(dWhat, 'title contains a line break; the "# <title>" heading line cannot hold it', `# ${d.title}\n\n## Decision\n\n${d.decision}\n\n## Reasoning\n\n${d.reasoning}${d.alternatives ? `\n\n## Alternatives considered\n\n${d.alternatives}` : ''}`);
		continue;
	}
	let body = `# ${d.title}\n\n## Decision\n\n${escapeContent(d.decision)}\n\n## Reasoning\n\n${escapeContent(d.reasoning)}`;
	if (d.alternatives) body += `\n\n## Alternatives considered\n\n${escapeContent(d.alternatives)}`;
	const rel = write(
		join('decisions', `${part(day)}_${slug(d.title)}_${part(d.id.slice(0, 8))}.md`),
		fm({
			id: d.id,
			date: d.date,
			project: d.project,
			tags: JSON.parse(d.tags_json),
			confidence: d.confidence,
			source: d.source,
			verified: d.verified,
			verifiedAt: d.verified_at,
		}) + body + '\n',
		dWhat
	);
	if (!rel) continue;
	wrote.decisions++;
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
	const eWhat = `entity "${oneLine(e.name)}" (${oneLine(e.entity_type)}) [${e.id}]`;
	// The name lives on the "# <name>" heading line; a crafted line break in it
	// would spill structural lines into the body (escaping cannot help a
	// heading). Such a name cannot be represented, so the entity is skipped.
	if (/[\r\n]/.test(e.name)) {
		skip(eWhat, 'name contains a line break; the "# <name>" heading line cannot hold it', `# ${e.name}\n\n${e.summary ?? ''}`);
		skippedEntityIds.add(e.id);
		continue;
	}
	let body = `# ${e.name}\n\n`;
	if (e.summary) body += `${escapeContent(e.summary)}\n\n`;
	let keptObs = 0;
	for (const o of obs) {
		// The id sits raw on the "## Observation <id>" heading line and the
		// importer reads it as one non-whitespace token; any whitespace in it is
		// crafted and could spill structural lines, so that observation is skipped.
		if (/\s/.test(o.id)) {
			skip(`observation of entity "${oneLine(e.name)}" [${oneLine(o.id)}]`, 'id contains whitespace; the "## Observation <id>" heading line cannot hold it', o.content);
			continue;
		}
		body += `## Observation ${o.id}\n`;
		body += kvLines({
			validFrom: o.valid_from,
			validTo: o.valid_to,
			confidence: o.confidence,
			createdAt: o.created_at,
			sessionId: o.session_id,
			source: o.source,
		});
		body += `\n\n${escapeContent(o.content)}\n\n`;
		keptObs++;
	}
	if (rels.length) {
		body += `## Relations (regenerated, canonical in relations.md)\n\n`;
		for (const r of rels) body += `- ${oneLine(r.from_name)} —${oneLine(r.relation_type)}→ ${oneLine(r.to_name)}\n`;
		body += '\n';
	}
	const rel = write(
		join('entities', `${part(e.entity_type)}_${slug(e.name)}_${part(e.id.slice(0, 8))}.md`),
		fm({ id: e.id, name: e.name, type: e.entity_type, created: e.created_at, updated: e.updated_at, confidence: e.confidence }) + body.replace(/\n+$/, '\n'),
		eWhat
	);
	if (!rel) { skippedEntityIds.add(e.id); continue; }
	wrote.entities++;
	index.entities.push(`- [${e.name} (${e.entity_type})](${rel}) — ${keptObs} observations`);
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
	let keptRels = 0;
	for (const r of relations) {
		// A relation whose endpoint entity was skipped would dangle: drop it.
		if (skippedEntityIds.has(r.from_entity_id) || skippedEntityIds.has(r.to_entity_id)) {
			skip(`relation "${oneLine(r.from_name)}" —${oneLine(r.relation_type)}→ "${oneLine(r.to_name)}" [${r.id}]`, `an endpoint entity was itself skipped`, `${r.relation_type}: ${r.from_entity_id} -> ${r.to_entity_id}`);
			continue;
		}
		body += `## ${oneLine(r.from_name)} —${oneLine(r.relation_type)}→ ${oneLine(r.to_name)}\n`;
		body += kvLines({
			id: r.id,
			from: r.from_entity_id,
			to: r.to_entity_id,
			relationType: r.relation_type,
			weight: r.weight,
			createdAt: r.created_at,
		});
		body += '\n\n';
		keptRels++;
	}
	if (keptRels && write('relations.md', body.replace(/\n+$/, '\n'), 'relations.md')) {
		index.entities.push(`- [Relations](relations.md) — ${keptRels} edges`);
	}
}

const sessions = db.prepare(
	`SELECT id, started_at, ended_at, project, summary, tasks_json FROM sessions ORDER BY started_at, id`
).all();
sessions.forEach((s, i) => {
	const tasks = JSON.parse(s.tasks_json ?? '[]');
	const sWhat = `session ${String(s.started_at).slice(0, 10)} [${s.id}]`;
	let body = s.summary == null ? '' : escapeContent(s.summary);
	if (tasks.length) body += `\n\n## Open tasks\n\n${tasks.map((t) => `- ${escapeContent(t)}`).join('\n')}`;
	const rel = write(
		join('sessions', `${String(i + 1).padStart(3, '0')}_${part(String(s.started_at).slice(0, 10))}_${part(s.id.slice(0, 8))}.md`),
		fm({ id: s.id, startedAt: s.started_at, endedAt: s.ended_at, project: s.project }) + body + '\n',
		sWhat
	);
	if (!rel) return;
	wrote.sessions++;
	index.sessions.push(`- [${String(s.started_at).slice(0, 16)}${s.project ? ' · ' + s.project : ''}](${rel})`);
});

// All meta keys, always: schema_version lets the tree self-describe its
// vintage (the importer checks it); embedding_model/embedding_dim/first_run_at
// are provenance owned by the server and are never pushed back on import. A
// key that is not a bare identifier would inject frontmatter lines, so it is
// skipped and logged rather than written. tree_format belongs to the TREE,
// not the store: it is written first, and a store key of that name would
// spoof the format marker, so it is skipped too.
const metaPairs = { tree_format: TREE_FORMAT };
for (const r of db.prepare(`SELECT key, value FROM meta ORDER BY key`).all()) {
	if (!isSafeKey(r.key)) {
		skip(`meta key ${JSON.stringify(r.key)}`, 'not a bare identifier; would inject frontmatter lines', `${r.key}: ${r.value}`);
		continue;
	}
	if (r.key === 'tree_format') {
		skip(`meta key "tree_format"`, 'reserved for the tree format marker', `${r.key}: ${r.value}`);
		continue;
	}
	metaPairs[r.key] = r.value;
}
write('meta.md', fm(metaPairs) + 'Store metadata. tree_format is the tree\'s own format marker (not a store key); profile_* keys and current_goal are imported; schema_version guards the round trip; all other keys are server-owned provenance.\n', 'meta.md');

let idx = `# Memory export\n\nSource: \`${dbPath}\` (read-only)\n\n`;
for (const [section, lines] of Object.entries(index)) {
	if (!lines.length) continue;
	idx += `## ${section[0].toUpperCase() + section.slice(1)} (${lines.length})\n\n${lines.join('\n')}\n\n`;
}
write('INDEX.md', idx, 'INDEX.md');

// Skipped records land in a readable log so nothing is silently lost and the
// offending data stays recoverable. Each entry leads with a human descriptor
// (table + natural name + id) so it can be located without a UUID lookup.
if (skipLog.length) {
	const lines = [
		`# Export error log`,
		`# source store: ${dbPath}`,
		`# ${skipLog.length} record(s) skipped; the rest exported normally`,
		`# to locate one: the [bracketed id] is its primary key, e.g. SELECT * FROM <table> WHERE id = '<id>'`,
		'',
	];
	for (const s of skipLog) {
		lines.push(`## ${s.what}`, `reason: ${s.reason}`, '', '--- data ---', s.data, '--- end ---', '');
	}
	writeFileSync(join(outDir, 'error.log'), lines.join('\n'), 'utf8');
}

db.close();
console.log(`Exported to ${outDir}:`);
console.log(`  ${wrote.learnings} learnings, ${wrote.decisions} decisions, ${wrote.entities} entities, ${wrote.sessions} sessions`);
if (skipLog.length) console.log(`  ${skipLog.length} record(s) skipped — see ${join(outDir, 'error.log')}`);
