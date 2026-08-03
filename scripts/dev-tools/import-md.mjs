#!/usr/bin/env node
/**
 * import-md.mjs — import a markdown tree (from export-md.mjs) into a memory
 * store, by converting it to a studiomeyer-memory-export v1 envelope and
 * driving the built server's memory_import over MCP stdio. Using the official
 * import path means validation, re-embedding, FTS rebuild and FK-safe
 * ordering all apply; this script never writes SQL itself.
 *
 * The default run is a DRY RUN (validate + predict, write nothing); only
 * --apply imports. memory_import is additive (INSERT OR IGNORE on id):
 * existing ids are skipped, never updated, so re-applying the same tree is a
 * no-op. Editing an existing entry therefore lands only via a fresh-store
 * rebuild; adding new entries works against a live store with --merge. A
 * learning or decision file WITHOUT an id is a new entry: it gets a UUID
 * written back into its frontmatter, so repeated runs produce the identical
 * envelope (no duplicate imports).
 */
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { homedir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);

function defaultDataDir() {
	const home = homedir();
	if (platform() === 'darwin') return join(home, 'Library', 'Application Support', 'local-memory-mcp');
	if (platform() === 'win32') return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'local-memory-mcp');
	return join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'local-memory-mcp');
}

const HELP = `import-md.mjs — import a markdown tree into a memory store

Usage: node scripts/dev-tools/import-md.mjs [options] [mdDir]

Arguments:
  mdDir                 markdown tree produced by export-md.mjs
                        (default: <Downloads>/local-memory-export)

By default this script is a DRY RUN: it validates the tree and predicts
adds/skips against the target, writing nothing. Pass --apply to import.
Run bare to see this help plus the dry-run prediction with defaults.

The import is IDEMPOTENT: re-applying the same tree adds 0 records
(existing ids are skipped, never updated), and generated ids are written
back into the markdown files so new entries can never import twice.

SKIP-AND-WARN: a tree file that is unreadable, escapes the tree, or is
malformed is excluded rather than aborting the whole import. Every skip,
naming the file and (where known) the line, is written to <mdDir>/error.log
on a durable run so the bad files are findable and their bytes recoverable.

Options:
  --apply               actually import (default is a dry run). Requires a
                        BUILT SERVER: dist/server.js in this repository
                        ("npm run build") or --server <path> to any built
                        copy, e.g. a globally installed package. Without
                        one the run refuses; the dry run needs no server.
  --db <path>           target database
                        (default: MEMORY_DB_PATH env, else <data-dir>/memory.sqlite)
                        A nonexistent target is created fresh; an existing one
                        additionally requires --merge.
  --merge               allow importing into an existing store (additive:
                        existing ids are skipped, never updated; re-running
                        the same import is a no-op). Only meaningful with
                        --apply; --merge alone is still a dry run.
  --envelope <file>     also write the intermediate JSON envelope
  --envelope-only <file>  write the envelope and stop (no server, no import)
                        Envelope output assigns missing ids (write-back), so
                        the envelope is stable across runs.
  --from-envelope <file>  import from an existing JSON envelope instead of
                        a markdown tree. Cannot be combined with a tree
                        argument or the envelope output flags.
  --server <path>       server entrypoint (default: dist/server.js in this
                        repository; run "npm run build" first)
  --verify              compare the tree field-by-field against the target
                        database (with --apply: after the import) and report
                        mismatches
  --help                show this help

Caveats:
  Decision files are parsed by their "## Decision" / "## Reasoning" /
  "## Alternatives considered" headings; entity files by their
  "## Observation <id>" sections (entity files therefore require ids and
  cannot be hand-authored without them). Content must not itself contain
  lines starting with "## ". The import refuses a tree or an existing
  target whose schema_version differs from the one this script was
  written for, and flags a freshly created store that ends up on one.
`;

// Same resolution as export-md.mjs: xdg-user-dirs on Linux, ~/Downloads else.
function downloadsDir() {
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

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
	process.stdout.write(HELP);
	process.exit(0);
}
if (argv.length === 0) process.stdout.write(HELP + '\n');
const flagValue = (name) => {
	const i = argv.indexOf(name);
	return i !== -1 ? argv[i + 1] : undefined;
};
const valueFlags = ['--db', '--envelope', '--envelope-only', '--server', '--from-envelope'];
const positional = argv.filter((a, i) => !a.startsWith('-') && !valueFlags.includes(argv[i - 1]));
const fromEnvelope = flagValue('--from-envelope');
const mdDir = positional[0] ?? join(downloadsDir(), 'local-memory-export');
const targetDb = flagValue('--db') ?? process.env.MEMORY_DB_PATH ?? join(defaultDataDir(), 'memory.sqlite');

// Schema guard, mirroring export-md.mjs: importing a tree of one schema
// vintage into a store of another can lose or misplace data, so refuse an
// existing target on a version mismatch and flag a freshly created store
// that ends up on an unexpected version.
const EXPECTED_SCHEMA_VERSION = '2';
function schemaVersionOf(path) {
	const Database = require('better-sqlite3');
	const sdb = new Database(path, { readonly: true });
	const v = sdb.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value ?? 'unknown';
	sdb.close();
	return v;
}
const merge = argv.includes('--merge');
const apply = argv.includes('--apply');
const verify = argv.includes('--verify');
const envelopeOut = flagValue('--envelope') ?? flagValue('--envelope-only');
const envelopeOnly = argv.includes('--envelope-only');
const serverPath = flagValue('--server') ?? fileURLToPath(new URL('../../dist/server.js', import.meta.url));

if (fromEnvelope) {
	if (positional[0]) {
		console.error('Pass either a markdown tree or --from-envelope, not both.');
		process.exit(2);
	}
	if (envelopeOut) {
		console.error('--envelope/--envelope-only with --from-envelope would only copy the input file.');
		process.exit(2);
	}
	if (!existsSync(fromEnvelope)) {
		console.error(`No envelope at ${fromEnvelope}.`);
		process.exit(2);
	}
} else if (!mdDir || !existsSync(mdDir)) {
	console.error(`No markdown tree at "${mdDir ?? ''}". See --help.`);
	process.exit(2);
}

// ── markdown tree → envelope ─────────────────────────

const NUM_FIELDS = new Set(['usageCount', 'confidence', 'verified', 'archived', 'importance']);

// Inverse of export-md.mjs's frontmatter contract: values starting with " or
// [ are JSON; NUM_FIELDS are numbers; everything else is a raw string. The
// body regains its exact original bytes by stripping the one trailing newline
// the exporter added.
// Read a tree file, refusing anything that reaches outside the tree. Two
// distinct reparse hazards on Windows and *nix:
//   - a symlinked leaf .md (isSymbolicLink true, junctions included): refuse
//     the link itself, so an id write-back can never follow it and clobber
//     the target;
//   - a junctioned or symlinked DIRECTORY component (e.g. learnings/ pointing
//     elsewhere): the leaf is a real file, so only PHYSICAL containment
//     catches it. realpathSync collapses every reparse point; the resolved
//     path must stay under the tree's real root. This read-time guard runs
//     before any id write-back, so aborting here protects the write too.
// Skip-and-warn. A tree file or record that cannot be trusted or parsed
// (symlink, escaping path, malformed frontmatter, wrong layout) is EXCLUDED
// rather than aborting the whole import, and recorded in full so nothing is
// silently dropped and the offending data stays recoverable. Genuine I/O
// errors still propagate. The good records still import; the log lands at
// <mdDir>/error.log on a durable run.
const skipLog = [];
const skip = (id, reason, data) => {
	skipLog.push({ id, reason, data: data == null ? '' : String(data) });
	console.warn(`  SKIPPED ${id}: ${reason}`);
};

// Parse a frontmatter value. Malformed JSON is an anticipated bad-input
// condition on an untrusted tree, so a SyntaxError is reported to the caller;
// any other error propagates.
function parseFmValue(key, raw, numeric) {
	if (/^["[]/.test(raw)) {
		try {
			return { ok: true, value: JSON.parse(raw) };
		} catch (err) {
			if (err instanceof SyntaxError) return { ok: false, reason: `invalid JSON for "${key}"` };
			throw err;
		}
	}
	return { ok: true, value: numeric.has(key) ? Number(raw) : raw };
}

const mdRealRoot = fromEnvelope ? null : realpathSync(mdDir);
// Returns { ok, text } or { ok:false, reason } for the anticipated reparse
// hazards; a vanished file (realpath/lstat throwing) is a real error and
// propagates.
function readTreeFile(path) {
	if (lstatSync(path).isSymbolicLink()) return { ok: false, reason: 'symlinked tree file (refused)' };
	const real = realpathSync(path);
	if (real !== mdRealRoot && !real.startsWith(mdRealRoot + sep)) {
		return { ok: false, reason: `resolves outside the tree (${real})` };
	}
	return { ok: true, text: readFileSync(path, 'utf8') };
}

function parseFile(path) {
	const r = readTreeFile(path);
	if (!r.ok) return r;
	const m = r.text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!m) return { ok: false, reason: 'line 1: no "---" frontmatter block at the top of the file', data: r.text };
	const fields = {};
	// Line 1 is the opening "---", so frontmatter line i (0-based) is file line i+2.
	const fmLines = m[1].split('\n');
	for (let i = 0; i < fmLines.length; i++) {
		const line = fmLines[i];
		if (line.trim() === '') continue;
		const idx = line.indexOf(': ');
		if (idx === -1) return { ok: false, reason: `frontmatter line ${i + 2}: not "key: value" -> "${line}"`, data: r.text };
		const key = line.slice(0, idx);
		const val = parseFmValue(key, line.slice(idx + 2), NUM_FIELDS);
		if (!val.ok) return { ok: false, reason: `frontmatter line ${i + 2}: ${val.reason}`, data: r.text };
		fields[key] = val.value;
	}
	return { ok: true, fields, body: m[2].replace(/\n$/, '') };
}

const listMd = (sub) => {
	if (fromEnvelope) return [];
	const dir = join(mdDir, sub);
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => join(dir, f));
};

// Ids are written back only when this run produces durable output (--apply
// or an envelope file); a pure dry run must not touch the tree, and an
// envelope with throwaway ids would import duplicates on the next run.
const persistIds = apply || Boolean(envelopeOut);
function ensureId(path, fields) {
	if (fields.id) return fields.id;
	const id = randomUUID();
	if (persistIds) {
		// The write-back rewrites the tree file in place. A symlinked entry
		// would make writeFileSync follow it and clobber the target, so a
		// hostile tree could overwrite an arbitrary file. Only touch a real file.
		if (lstatSync(path).isSymbolicLink()) {
			throw new Error(`${path}: refusing to write an id back through a symlink.`);
		}
		const text = readFileSync(path, 'utf8');
		writeFileSync(path, text.replace(/^---\n/, `---\nid: ${id}\n`), 'utf8');
		console.log(`assigned id ${id} to ${path}`);
	} else {
		console.log(`DRY-RUN: would assign id ${id} to ${path}`);
	}
	return id;
}

const learnings = [];
for (const path of [...listMd('learnings'), ...listMd('learnings-archived')]) {
	const p = parseFile(path);
	if (!p.ok) { skip(path, p.reason, p.data); continue; }
	const { fields: f, body } = p;
	learnings.push({
		id: ensureId(path, f),
		date: f.date ?? null,
		category: f.category,
		content: body,
		project: f.project ?? null,
		tags: f.tags ?? [],
		usageCount: f.usageCount ?? 0,
		lastUsed: f.lastUsed ?? null,
		confidence: f.confidence ?? 0.7,
		source: f.source ?? null,
		verified: f.verified ?? 0,
		verifiedAt: f.verifiedAt ?? null,
		archived: f.archived ?? 0,
		archivedAt: f.archivedAt ?? null,
		importance: f.importance ?? null,
		lifecycleState: f.lifecycleState ?? 'active',
		memoryType: f.memoryType ?? 'semantic',
	});
}

const decisions = [];
for (const path of listMd('decisions')) {
	const p = parseFile(path);
	if (!p.ok) { skip(path, p.reason, p.data); continue; }
	const { fields: f, body } = p;
	const m = body.match(
		/^# (.*)\n\n## Decision\n\n([\s\S]*?)\n\n## Reasoning\n\n([\s\S]*?)(?:\n\n## Alternatives considered\n\n([\s\S]*))?$/
	);
	if (!m) { skip(path, 'body does not match the decision layout (see --help)', body); continue; }
	decisions.push({
		id: ensureId(path, f),
		date: f.date ?? null,
		title: m[1],
		decision: m[2],
		reasoning: m[3],
		alternatives: m[4] ?? null,
		project: f.project ?? null,
		tags: f.tags ?? [],
		confidence: f.confidence ?? 0.7,
		source: f.source ?? null,
		verified: f.verified ?? 0,
		verifiedAt: f.verifiedAt ?? null,
	});
}

const sessions = [];
for (const path of listMd('sessions')) {
	const p = parseFile(path);
	if (!p.ok) { skip(path, p.reason, p.data); continue; }
	const { fields: f, body } = p;
	const parts = body.split('\n\n## Open tasks\n\n');
	const tasks = parts[1] ? parts[1].split('\n').map((l) => l.replace(/^- /, '')) : [];
	sessions.push({
		id: f.id,
		startedAt: f.startedAt ?? null,
		endedAt: f.endedAt ?? null,
		project: f.project ?? null,
		summary: parts[0] || null,
		tasks,
	});
}

// ── entities: frontmatter + "## Observation <id>" sections; the Relations
// section is regenerated decoration and ignored. Entity files must carry ids
// (they come from export-md.mjs); hand-authored id-less entities are not
// supported, unlike learnings/decisions.
const NUM_KV = new Set(['confidence', 'weight']);
const parseKvBlock = (lines) => {
	const kv = {};
	for (const line of lines) {
		const idx = line.indexOf(': ');
		if (idx === -1) return { ok: false, reason: `unparseable metadata line "${line}"` };
		const key = line.slice(0, idx);
		const val = parseFmValue(key, line.slice(idx + 2), NUM_KV);
		if (!val.ok) return { ok: false, reason: val.reason };
		kv[key] = val.value;
	}
	return { ok: true, kv };
};

const entities = [];
const observations = [];
for (const path of listMd('entities')) {
	const p = parseFile(path);
	if (!p.ok) { skip(path, p.reason, p.data); continue; }
	const { fields: f, body } = p;
	if (!f.id || !f.name || !f.type) { skip(path, 'entity file requires id, name and type in the frontmatter', body); continue; }
	const chunks = body.split(/\n(?=## )/);
	const head = chunks[0].replace(/^# .*\n*/, '').replace(/\n+$/, '');
	// Collect observations first; a malformed section skips the WHOLE entity
	// so the entity and its observations import atomically or not at all.
	const pending = [];
	let bad = null;
	for (const chunk of chunks.slice(1)) {
		const m = chunk.match(/^## Observation (\S+)\n([\s\S]*)$/);
		if (!m) {
			if (/^## Relations/.test(chunk)) continue;
			bad = `unexpected section "${chunk.split('\n')[0]}"`;
			break;
		}
		const blank = m[2].indexOf('\n\n');
		if (blank === -1) { bad = `observation ${m[1]} has no content block`; break; }
		const kvr = parseKvBlock(m[2].slice(0, blank).split('\n'));
		if (!kvr.ok) { bad = `observation ${m[1]}: ${kvr.reason}`; break; }
		pending.push({
			id: m[1],
			entityId: f.id,
			content: m[2].slice(blank + 2).replace(/\n+$/, ''),
			source: kvr.kv.source ?? null,
			sessionId: kvr.kv.sessionId ?? null,
			validFrom: kvr.kv.validFrom ?? null,
			validTo: kvr.kv.validTo ?? null,
			confidence: kvr.kv.confidence ?? 0.7,
			createdAt: kvr.kv.createdAt ?? null,
		});
	}
	if (bad) { skip(path, bad, body); continue; }
	entities.push({
		id: f.id,
		name: f.name,
		entityType: f.type,
		createdAt: f.created ?? null,
		updatedAt: f.updated ?? null,
		summary: head || null,
		confidence: f.confidence ?? 0.7,
	});
	observations.push(...pending);
}

// ── relations.md: canonical edge list, headings are decorative ──
const relations = [];
if (existsSync(join(mdDir, 'relations.md'))) {
	const relPath = join(mdDir, 'relations.md');
	const r = readTreeFile(relPath);
	if (!r.ok) {
		skip(relPath, r.reason, '');
	} else {
		for (const chunk of r.text.split(/\n(?=## )/).slice(1)) {
			const lines = chunk.split('\n').slice(1).filter((l) => l.trim() !== '');
			const kvr = parseKvBlock(lines);
			if (!kvr.ok) { skip(relPath, kvr.reason, chunk); continue; }
			const kv = kvr.kv;
			if (!kv.id || !kv.from || !kv.to || !kv.relationType) { skip(relPath, 'relation missing id/from/to/relationType', chunk); continue; }
			relations.push({
				id: kv.id,
				fromEntityId: kv.from,
				toEntityId: kv.to,
				relationType: kv.relationType,
				weight: kv.weight ?? 1.0,
				createdAt: kv.createdAt ?? null,
			});
		}
	}
}

const profile = {};
let goal = null;
let treeSchemaVersion = null;
if (!fromEnvelope && existsSync(join(mdDir, 'meta.md'))) {
	const { fields: f } = parseFile(join(mdDir, 'meta.md'));
	for (const [k, v] of Object.entries(f)) {
		if (k.startsWith('profile_')) profile[k.replace(/^profile_/, '')] = v;
		if (k === 'current_goal') goal = v;
		if (k === 'schema_version') treeSchemaVersion = String(v);
	}
}
if (treeSchemaVersion !== null && treeSchemaVersion !== EXPECTED_SCHEMA_VERSION) {
	console.error(`Refusing: the tree records schema_version ${treeSchemaVersion}, this script was written for ${EXPECTED_SCHEMA_VERSION}. Re-export with the matching script.`);
	process.exit(2);
}

let envelope = {
	format: 'studiomeyer-memory-export',
	version: 1,
	exportedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
	source: 'import-md.mjs',
	schemaVersion: treeSchemaVersion ?? 'unknown',
	counts: { learnings: learnings.length, decisions: decisions.length, entities: entities.length, observations: observations.length, relations: relations.length, sessions: sessions.length },
	profile,
	goal,
	learnings,
	decisions,
	entities,
	observations,
	relations,
	sessions,
};
if (fromEnvelope) {
	// Replace the (empty) tree-derived envelope with the given file, after
	// the same vintage checks the tree's meta.md gets.
	envelope = JSON.parse(readFileSync(fromEnvelope, 'utf8'));
	if (envelope.format !== 'studiomeyer-memory-export') {
		console.error(`Unrecognised envelope format "${envelope.format}". Expected studiomeyer-memory-export.`);
		process.exit(2);
	}
	if (envelope.version !== 1) {
		console.error(`Envelope version ${envelope.version}; this script was written for 1.`);
		process.exit(2);
	}
	const sv = envelope.schemaVersion == null ? 'unknown' : String(envelope.schemaVersion);
	if (sv !== 'unknown' && sv !== EXPECTED_SCHEMA_VERSION) {
		console.error(`Refusing: the envelope records schema_version ${sv}, this script was written for ${EXPECTED_SCHEMA_VERSION}.`);
		process.exit(2);
	}
	for (const kind of ['learnings', 'decisions', 'entities', 'observations', 'relations', 'sessions']) {
		envelope[kind] = envelope[kind] ?? [];
	}
	console.log(`Read ${fromEnvelope}: ${envelope.learnings.length} learnings, ${envelope.decisions.length} decisions, ${envelope.sessions.length} sessions, ${envelope.entities.length} entities, ${envelope.observations.length} observations, ${envelope.relations.length} relations`);
} else {
	console.log(`Read ${mdDir}: ${learnings.length} learnings, ${decisions.length} decisions, ${sessions.length} sessions, ${entities.length} entities, ${observations.length} observations, ${relations.length} relations`);
	if (skipLog.length) {
		console.log(`  ${skipLog.length} tree file(s) skipped as unreadable or malformed`);
		// Durable runs record the skips in full so the bad files are findable
		// and the offending bytes recoverable. A pure dry run only warns above.
		if (persistIds) {
			const lines = [
				`# Import error log`,
				`# tree: ${mdDir}`,
				`# ${skipLog.length} file(s) skipped; the rest were read normally`,
				`# each entry names the FILE PATH and, where known, the line number`,
				'',
			];
			for (const s of skipLog) {
				lines.push(`## ${s.id}`, `reason: ${s.reason}`, '', '--- file contents ---', s.data, '--- end ---', '');
			}
			writeFileSync(join(mdDir, 'error.log'), lines.join('\n'), 'utf8');
			console.log(`  see ${join(mdDir, 'error.log')}`);
		}
	}
}

if (envelopeOut) {
	writeFileSync(envelopeOut, JSON.stringify(envelope, null, '\t') + '\n', 'utf8');
	console.log(`Envelope written to ${envelopeOut}`);
}

// ── --verify: field-by-field comparison against the target DB ──

function runVerify() {
	const Database = require('better-sqlite3');
	const vdb = new Database(targetDb, { readonly: true });
	let mismatches = 0;
	const norm = (v) => (v === undefined || v === '' ? null : v);
	const compare = (kind, id, field, mdVal, dbVal) => {
		if (JSON.stringify(norm(mdVal)) !== JSON.stringify(norm(dbVal))) {
			mismatches++;
			console.log(`MISMATCH ${kind} ${id} .${field}:\n  md: ${JSON.stringify(mdVal)?.slice(0, 120)}\n  db: ${JSON.stringify(dbVal)?.slice(0, 120)}`);
		}
	};
	const dbLearnings = new Map(vdb.prepare('SELECT * FROM learnings').all().map((r) => [r.id, r]));
	for (const l of envelope.learnings) {
		const r = dbLearnings.get(l.id);
		if (!r) { mismatches++; console.log(`MISSING in DB: learning ${l.id}`); continue; }
		compare('learning', l.id, 'date', l.date, r.date);
		compare('learning', l.id, 'category', l.category, r.category);
		compare('learning', l.id, 'content', l.content, r.content);
		compare('learning', l.id, 'project', l.project, r.project);
		compare('learning', l.id, 'tags', l.tags, JSON.parse(r.tags_json));
		compare('learning', l.id, 'usageCount', l.usageCount, r.usage_count);
		compare('learning', l.id, 'lastUsed', l.lastUsed, r.last_used);
		compare('learning', l.id, 'confidence', l.confidence, r.confidence);
		compare('learning', l.id, 'source', l.source, r.source);
		compare('learning', l.id, 'verified', l.verified, r.verified);
		compare('learning', l.id, 'verifiedAt', l.verifiedAt, r.verified_at);
		compare('learning', l.id, 'archived', l.archived, r.archived);
		compare('learning', l.id, 'archivedAt', l.archivedAt, r.archived_at);
		compare('learning', l.id, 'importance', l.importance, r.importance);
		compare('learning', l.id, 'lifecycleState', l.lifecycleState, r.lifecycle_state);
		compare('learning', l.id, 'memoryType', l.memoryType, r.memory_type);
	}
	if (envelope.learnings.length !== dbLearnings.size) { mismatches++; console.log(`COUNT: md has ${envelope.learnings.length} learnings, DB has ${dbLearnings.size}`); }
	const dbDecisions = new Map(vdb.prepare('SELECT * FROM decisions').all().map((r) => [r.id, r]));
	for (const d of envelope.decisions) {
		const r = dbDecisions.get(d.id);
		if (!r) { mismatches++; console.log(`MISSING in DB: decision ${d.id}`); continue; }
		compare('decision', d.id, 'title', d.title, r.title);
		compare('decision', d.id, 'decision', d.decision, r.decision);
		compare('decision', d.id, 'reasoning', d.reasoning, r.reasoning);
		compare('decision', d.id, 'alternatives', d.alternatives, r.alternatives);
		compare('decision', d.id, 'project', d.project, r.project);
		compare('decision', d.id, 'tags', d.tags, JSON.parse(r.tags_json));
	}
	const dbSessions = new Map(vdb.prepare('SELECT * FROM sessions').all().map((r) => [r.id, r]));
	for (const s of envelope.sessions) {
		const r = dbSessions.get(s.id);
		if (!r) { mismatches++; console.log(`MISSING in DB: session ${s.id}`); continue; }
		compare('session', s.id, 'summary', s.summary, r.summary);
		compare('session', s.id, 'tasks', s.tasks, JSON.parse(r.tasks_json ?? '[]'));
		compare('session', s.id, 'project', s.project, r.project);
	}
	const dbEntities = new Map(vdb.prepare('SELECT * FROM entities').all().map((r) => [r.id, r]));
	for (const e of envelope.entities) {
		const r = dbEntities.get(e.id);
		if (!r) { mismatches++; console.log(`MISSING in DB: entity ${e.id}`); continue; }
		compare('entity', e.id, 'name', e.name, r.name);
		compare('entity', e.id, 'entityType', e.entityType, r.entity_type);
		compare('entity', e.id, 'createdAt', e.createdAt, r.created_at);
		compare('entity', e.id, 'updatedAt', e.updatedAt, r.updated_at);
		compare('entity', e.id, 'summary', e.summary, r.summary);
		compare('entity', e.id, 'confidence', e.confidence, r.confidence);
	}
	const dbObs = new Map(vdb.prepare('SELECT * FROM entity_observations').all().map((r) => [r.id, r]));
	for (const o of envelope.observations) {
		const r = dbObs.get(o.id);
		if (!r) { mismatches++; console.log(`MISSING in DB: observation ${o.id}`); continue; }
		compare('observation', o.id, 'entityId', o.entityId, r.entity_id);
		compare('observation', o.id, 'content', o.content, r.content);
		compare('observation', o.id, 'source', o.source, r.source);
		compare('observation', o.id, 'sessionId', o.sessionId, r.session_id);
		compare('observation', o.id, 'validFrom', o.validFrom, r.valid_from);
		compare('observation', o.id, 'validTo', o.validTo, r.valid_to);
		compare('observation', o.id, 'confidence', o.confidence, r.confidence);
		compare('observation', o.id, 'createdAt', o.createdAt, r.created_at);
	}
	const dbRels = new Map(vdb.prepare('SELECT * FROM entity_relations').all().map((r) => [r.id, r]));
	for (const rel of envelope.relations) {
		const r = dbRels.get(rel.id);
		if (!r) { mismatches++; console.log(`MISSING in DB: relation ${rel.id}`); continue; }
		compare('relation', rel.id, 'fromEntityId', rel.fromEntityId, r.from_entity_id);
		compare('relation', rel.id, 'toEntityId', rel.toEntityId, r.to_entity_id);
		compare('relation', rel.id, 'relationType', rel.relationType, r.relation_type);
		compare('relation', rel.id, 'weight', rel.weight, r.weight);
		compare('relation', rel.id, 'createdAt', rel.createdAt, r.created_at);
	}
	vdb.close();
	console.log(mismatches === 0 ? 'VERIFY: perfect round-trip, 0 mismatches.' : `VERIFY: ${mismatches} mismatches.`);
	if (mismatches > 0) process.exitCode = 1;
}
if (verify && !apply) runVerify();

if (envelopeOnly) process.exit(process.exitCode ?? 0);

// ── default: predict the additive outcome, read-only ──

if (!apply) {
	const exists = existsSync(targetDb);
	const TABLE_OF = { learnings: 'learnings', decisions: 'decisions', sessions: 'sessions', entities: 'entities', observations: 'entity_observations', relations: 'entity_relations' };
	const existingIds = Object.fromEntries(Object.keys(TABLE_OF).map((k) => [k, new Set()]));
	if (exists) {
		const Database = require('better-sqlite3');
		const pdb = new Database(targetDb, { readonly: true });
		for (const [key, table] of Object.entries(TABLE_OF)) {
			existingIds[key] = new Set(pdb.prepare(`SELECT id FROM ${table}`).all().map((r) => r.id));
		}
		pdb.close();
	}
	console.log(`DRY-RUN against ${targetDb}`);
	if (exists) {
		const v = schemaVersionOf(targetDb);
		if (v !== EXPECTED_SCHEMA_VERSION) {
			console.log(`  SCHEMA MISMATCH: target schema_version is ${v}, this script was written for ${EXPECTED_SCHEMA_VERSION}; a real run would refuse.`);
		}
	}
	console.log('');
	console.log(exists ? 'Existing store:' : 'New store (will be created):');
	for (const key of Object.keys(TABLE_OF)) {
		const items = envelope[key];
		const dupes = items.filter((i) => existingIds[key].has(i.id)).length;
		console.log(`  ${key}: ${items.length - dupes} would be added, ${dupes} already present (skipped)`);
	}
	console.log('');
	if (exists && !merge) console.log('  NOTE: importing into this existing store requires --apply --merge.');
	else if (merge) console.log('  NOTE: --merge alone is still a dry run; pass --apply --merge to import.');
	else console.log('  Pass --apply to perform the import.');
	if (!existsSync(serverPath)) {
		console.log(`  NOTE: no server at ${serverPath}; --apply would refuse. Run "npm run build" or pass --server <path>.`);
	}
	console.log('');
	console.log('Nothing was written.');
	process.exit(process.exitCode ?? 0);
}

// ── real import via the server's memory_import ──

if (existsSync(targetDb)) {
	if (!merge) {
		console.error(`Refusing: ${targetDb} already exists. Pass --merge to add into it, or --db <newfile> for a fresh rebuild.`);
		process.exit(2);
	}
	const v = schemaVersionOf(targetDb);
	if (v !== EXPECTED_SCHEMA_VERSION) {
		console.error(`Refusing: target schema_version is ${v}, this script was written for ${EXPECTED_SCHEMA_VERSION}. Importing could lose or misplace data; update the scripts for the new schema.`);
		process.exit(2);
	}
}
if (!existsSync(serverPath)) {
	console.error(`No server at ${serverPath}. Run "npm run build" first, or pass --server <path>.`);
	process.exit(2);
}

const p = spawn(process.execPath, [serverPath], {
	stdio: ['pipe', 'pipe', 'pipe'],
	env: { ...process.env, MEMORY_DB_PATH: targetDb },
});
let out = '';
let err = '';
p.stdout.on('data', (d) => (out += d));
p.stderr.on('data', (d) => (err += d));

const send = (msg) => p.stdin.write(JSON.stringify(msg) + '\n');
send({
	jsonrpc: '2.0',
	id: 1,
	method: 'initialize',
	params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'import-md', version: '1' } },
});
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_import', arguments: { data: envelope } } });

// Re-embedding hundreds of entries takes a while on first run (model
// download + inference), hence the generous deadline.
const deadline = setTimeout(() => finish('TIMEOUT after 10 minutes'), 600000);
const poll = setInterval(() => {
	if (out.split('\n').some((l) => l.includes('"id":2'))) finish();
}, 1000);

function finish(failNote) {
	clearTimeout(deadline);
	clearInterval(poll);
	if (failNote) {
		p.kill();
		console.error(failNote);
		console.error('STDERR tail:', err.split('\n').slice(-8).join('\n'));
		process.exit(1);
	}
	// Post-steps only after the server has really exited: it may still hold
	// the SQLite lock, and reading the store too early is a crash race.
	const post = () => {
		const reply = JSON.parse(out.split('\n').find((l) => l.includes('"id":2')));
		const text = reply.result?.content?.[0]?.text ?? JSON.stringify(reply);
		console.log(text);
		const embedWarns = err.split('\n').filter((l) => l.includes('embedding write skipped'));
		if (embedWarns.length) console.log(`WARN: ${embedWarns.length} embeddings skipped (rows imported without vectors).`);
		const v = schemaVersionOf(targetDb);
		if (v !== EXPECTED_SCHEMA_VERSION) {
			console.error(`WARNING: the server created schema_version ${v}, but this tree and script were written for ${EXPECTED_SCHEMA_VERSION}. Review the result before trusting it.`);
			process.exitCode = 1;
		}
		if (verify) runVerify();
	};
	if (p.exitCode !== null) {
		post();
	} else {
		p.once('exit', post);
		p.kill();
	}
}
