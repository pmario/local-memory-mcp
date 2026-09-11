#!/usr/bin/env node
/**
 * import-md.mjs — import a markdown tree (from export-md.mjs) into a memory
 * store, by converting it to a studiomeyer-memory-export v1 envelope and
 * driving the built server's memory_import over MCP stdio. Using the official
 * import path means validation, re-embedding, FTS rebuild and FK-safe
 * ordering all apply; the only SQL this script writes is --update's exact
 * archive, validity and session-end values, which no tool can set.
 *
 * The tree is FORMAT 2: in re-parsed bodies, heading-like content lines
 * arrive escaped ("\## ") and are unescaped after the structural parse, so a
 * "## " line at column 0 is always structural and content can never
 * fabricate a record. meta.md must record tree_format: 2; a tree without the
 * marker is refused, because parsing it with these rules would reintroduce
 * exactly that ambiguity.
 *
 * The default run is a DRY RUN (validate + predict, write nothing); only
 * --apply imports. memory_import is additive (INSERT OR IGNORE on id):
 * existing ids are skipped, never updated, so re-applying the same tree is a
 * no-op. Edits to existing entries land with --update; adding new entries
 * works against a live store with --merge. A learning or decision file
 * WITHOUT an id is a new entry: it gets a UUID
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
  --update              also bring EXISTING records up to the tree's state,
                        so a tree merged from two machines leaves nothing
                        for the next export to revert:
                          learning content, confidence, tags (through
                          memory_learn_update, which re-embeds);
                          entity summary (memory_entity_create);
                          learning archive state, observation validTo,
                          session end (written as the tree has them).
                        Lifecycle only moves forward: an archived learning,
                        superseded observation or ended session is never
                        reopened. Anything else that differs (category,
                        project, source, memoryType, date, entity name or
                        type) is reported and left untouched. The dry run
                        predicts every change; --apply --update performs
                        them (--update implies --merge); a second run finds
                        nothing to change.
                        CAUTION: an update OVERWRITES the stored value with
                        no history, and it waives the import's "existing
                        rows are never touched" guarantee. Export a backup
                        first, and review the dry run before updating from
                        a tree you did not export yourself. Updates run
                        per entry, not as one transaction.
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
                        mismatches; they also land in <mdDir>/verify.log and
                        set exit code 1, so the answer survives the console
  --help                show this help

Caveats:
  meta.md must record tree_format: 2 (export-md.mjs writes it; add the
  line to a hand-authored tree yourself). In re-parsed bodies the exporter
  escapes heading-like content lines ("## " gains a leading backslash) and
  this importer strips exactly one, so a "## " line at column 0 is always
  structural: the sections the tree shows are the records it imports.
  Decision files are parsed by their "## Decision" / "## Reasoning" /
  "## Alternatives considered" headings; entity files by their
  "## Observation <id>" sections (entity files therefore require ids and
  cannot be hand-authored without them). The import refuses a tree or an
  existing target whose schema_version differs from the one this script
  was written for, and flags a freshly created store that ends up on one.
  A foreign tree or envelope is still untrusted DATA: ids and field values
  are imported as-is (see upstream issue #29), so review it before --apply.
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
// Tree format this parser reads (see export-md.mjs). Checked against
// meta.md's tree_format BEFORE any tree file is parsed.
const EXPECTED_TREE_FORMAT = '2';
function schemaVersionOf(path) {
	const Database = require('better-sqlite3');
	const sdb = new Database(path, { readonly: true });
	const v = sdb.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value ?? 'unknown';
	sdb.close();
	return v;
}
const apply = argv.includes('--apply');
const verify = argv.includes('--verify');
const doUpdate = argv.includes('--update');
// --update cannot mean anything without touching an existing store, so it
// implies --merge: demanding the weaker consent alongside the stronger one
// would be friction, not safety.
const merge = argv.includes('--merge') || doUpdate;
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

// Inverse of export-md.mjs's escapeContent (tree format 2): AFTER the
// structural split, a body line of backslashes followed by "## " loses
// exactly one backslash. Only re-parsed bodies are escaped; learning bodies
// are verbatim.
const unescapeContent = (text) => text.replace(/^\\(\\*## )/gm, '$1');

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

// ── meta.md first: the tree must identify its format before anything is
// parsed. tree_format says which parsing rules (the "\## " escaping) the
// bodies were written for; running these rules on an unmarked tree would
// reintroduce exactly the content-can-be-structural ambiguity format 2
// removes, so a missing or foreign marker refuses the WHOLE tree (this is a
// vintage problem, not a bad record, hence refuse over skip-and-warn — same
// as a schema_version mismatch). profile_*, current_goal and schema_version
// ride along into the envelope as before.
const profile = {};
let goal = null;
let treeSchemaVersion = null;
if (!fromEnvelope) {
	const metaPath = join(mdDir, 'meta.md');
	const metaParsed = existsSync(metaPath) ? parseFile(metaPath) : { ok: false, reason: 'meta.md is missing' };
	if (!metaParsed.ok) {
		console.error(`Refusing: ${metaPath}: ${metaParsed.reason}.`);
		console.error(`A format-${EXPECTED_TREE_FORMAT} tree carries a meta.md whose frontmatter records "tree_format: ${EXPECTED_TREE_FORMAT}". Re-export with the current export-md.mjs, or add the line to a hand-authored tree.`);
		process.exit(2);
	}
	const treeFormat = metaParsed.fields.tree_format == null ? null : String(metaParsed.fields.tree_format);
	if (treeFormat !== EXPECTED_TREE_FORMAT) {
		console.error(`Refusing: the tree records ${treeFormat === null ? 'no tree_format' : `tree_format ${treeFormat}`}, this script reads format ${EXPECTED_TREE_FORMAT}.`);
		console.error(`Re-export with the current export-md.mjs, or add "tree_format: ${EXPECTED_TREE_FORMAT}" to meta.md if the tree's bodies already use its escaping ("\\## ").`);
		process.exit(2);
	}
	for (const [k, v] of Object.entries(metaParsed.fields)) {
		if (k.startsWith('profile_')) profile[k.replace(/^profile_/, '')] = v;
		if (k === 'current_goal') goal = v;
		if (k === 'schema_version') treeSchemaVersion = String(v);
	}
	if (treeSchemaVersion !== null && treeSchemaVersion !== EXPECTED_SCHEMA_VERSION) {
		console.error(`Refusing: the tree records schema_version ${treeSchemaVersion}, this script was written for ${EXPECTED_SCHEMA_VERSION}. Re-export with the matching script.`);
		process.exit(2);
	}
}

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
// --update and --verify must never treat an envelope DEFAULT as a tree value,
// so remember which fields the file itself carried.
const fieldPresence = new Map();
const ALL_PRESENT = { confidence: true, tags: true, archived: true, usageCount: true, lastUsed: true };
for (const path of [...listMd('learnings'), ...listMd('learnings-archived')]) {
	const p = parseFile(path);
	if (!p.ok) { skip(path, p.reason, p.data); continue; }
	const { fields: f, body } = p;
	const lid = ensureId(path, f);
	fieldPresence.set(lid, {
		confidence: f.confidence !== undefined,
		tags: f.tags !== undefined,
		archived: f.archived !== undefined,
		usageCount: f.usageCount !== undefined,
		lastUsed: f.lastUsed !== undefined,
	});
	learnings.push({
		id: lid,
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
		decision: unescapeContent(m[2]),
		reasoning: unescapeContent(m[3]),
		alternatives: m[4] == null ? null : unescapeContent(m[4]),
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
	const tasks = parts[1] ? parts[1].split('\n').map((l) => unescapeContent(l.replace(/^- /, ''))) : [];
	sessions.push({
		id: f.id,
		startedAt: f.startedAt ?? null,
		endedAt: f.endedAt ?? null,
		project: f.project ?? null,
		summary: parts[0] ? unescapeContent(parts[0]) : null,
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
// A --sync tree leaves out entity "updated", so --verify must not compare it.
const entityUpdatedPresent = new Set();
for (const path of listMd('entities')) {
	const p = parseFile(path);
	if (!p.ok) { skip(path, p.reason, p.data); continue; }
	const { fields: f, body } = p;
	if (!f.id || !f.name || !f.type) { skip(path, 'entity file requires id, name and type in the frontmatter', body); continue; }
	const chunks = body.split(/\n(?=## )/);
	const head = unescapeContent(chunks[0].replace(/^# .*\n*/, '').replace(/\n+$/, ''));
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
			content: unescapeContent(m[2].slice(blank + 2).replace(/\n+$/, '')),
			source: kvr.kv.source ?? null,
			sessionId: kvr.kv.sessionId ?? null,
			validFrom: kvr.kv.validFrom ?? null,
			validTo: kvr.kv.validTo ?? null,
			confidence: kvr.kv.confidence ?? 0.7,
			createdAt: kvr.kv.createdAt ?? null,
		});
	}
	if (bad) { skip(path, bad, body); continue; }
	if (f.updated !== undefined) entityUpdatedPresent.add(f.id);
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

// ── --update: bring existing records up to the tree's state ──
// A tree change the import does not apply is reverted by this store's next
// export, so every field that can change after creation is covered here.
const updates = [];
const entityUpdates = [];
const sqlUpdates = [];
const updateWarnings = [];
// The states memory_learn_archive and the schema default produce.
const LIFECYCLE = /^(active|ephemeral|archived|archived:[\s\S]{1,500})$/;
const isoish = (v) => v === null || (typeof v === 'string' && v.length <= 64);
const orNull = (v) => (v === undefined || v === '' ? null : v);
if (doUpdate && existsSync(targetDb)) {
	const Database = require('better-sqlite3');
	const udb = new Database(targetDb, { readonly: true });
	const rows = new Map(udb.prepare('SELECT * FROM learnings').all().map((r) => [r.id, r]));
	const entityRows = new Map(udb.prepare('SELECT id, name, entity_type, summary FROM entities').all().map((r) => [r.id, r]));
	const obsRows = new Map(udb.prepare('SELECT id, valid_to FROM entity_observations').all().map((r) => [r.id, r]));
	const sessionRows = new Map(udb.prepare('SELECT id, ended_at, summary, tasks_json FROM sessions').all().map((r) => [r.id, r]));
	udb.close();
	for (const l of envelope.learnings) {
		const r = rows.get(l.id);
		if (!r) continue;
		const present = fieldPresence.get(l.id) ?? ALL_PRESENT;
		const set = {};
		if (l.content !== r.content) set.content = l.content;
		if (present.confidence && l.confidence !== r.confidence) set.confidence = l.confidence;
		if (present.tags && JSON.stringify(l.tags) !== JSON.stringify(JSON.parse(r.tags_json))) set.tags = l.tags;
		if (Object.keys(set).length) {
			if (r.archived === 1) updateWarnings.push(`${l.id}: ${Object.keys(set).join(', ')} differ, but memory_learn_update cannot change an archived learning`);
			else updates.push({ id: l.id, set });
		}
		// Written after the memory_learn_update calls, which refuse an archived learning.
		if (present.archived) {
			const archived = l.archived === true || l.archived === 1 ? 1 : 0;
			const archivedAt = orNull(l.archivedAt);
			const lifecycle = String(l.lifecycleState ?? 'active');
			if (archived !== r.archived || archivedAt !== r.archived_at || lifecycle !== r.lifecycle_state) {
				if (r.archived === 1 && archived === 0) updateWarnings.push(`${l.id}: archived in the store but not in the tree; nothing reopens an archived learning`);
				else if (!LIFECYCLE.test(lifecycle) || !isoish(archivedAt)) updateWarnings.push(`${l.id}: archive state ${JSON.stringify(lifecycle.slice(0, 40))} at ${JSON.stringify(archivedAt)} is not one the server writes`);
				else sqlUpdates.push({ what: `learning ${l.id}: ${lifecycle.slice(0, 40)}`, sql: 'UPDATE learnings SET archived = ?, archived_at = ?, lifecycle_state = ? WHERE id = ?', args: [archived, archivedAt, lifecycle, l.id] });
			}
		}
		for (const [field, tree, db] of [
			['category', l.category, r.category],
			['project', l.project ?? null, r.project],
			['source', l.source ?? null, r.source],
			['memoryType', l.memoryType, r.memory_type],
			['date', l.date, r.date],
		]) {
			if (tree !== db) updateWarnings.push(`${l.id}: ${field} differs (tree ${JSON.stringify(tree)}, store ${JSON.stringify(db)}); memory_learn_update cannot change it, archive-and-rewrite instead`);
		}
	}
	const idByNameType = new Map([...entityRows.values()].map((r) => [`${r.name}\0${r.entity_type}`, r.id]));
	for (const e of envelope.entities) {
		const r = entityRows.get(e.id);
		if (!r) {
			const other = idByNameType.get(`${e.name}\0${e.entityType}`);
			if (other) updateWarnings.push(`entity "${e.name}" (${e.entityType}) [${e.id}]: the store holds that name as [${other}], so memory_import skips it and its observations`);
			continue;
		}
		if (e.name !== r.name || e.entityType !== r.entity_type) {
			updateWarnings.push(`entity ${e.id}: name or type differs (tree "${e.name}" (${e.entityType}), store "${r.name}" (${r.entity_type})); nothing renames an entity`);
		} else if (orNull(e.summary) !== orNull(r.summary)) {
			if (orNull(e.summary) === null) updateWarnings.push(`entity ${e.id}: no summary in the tree; memory_entity_create cannot clear one`);
			else entityUpdates.push({ id: e.id, args: { name: r.name, entityType: r.entity_type, summary: e.summary } });
		}
	}
	for (const o of envelope.observations) {
		const r = obsRows.get(o.id);
		const validTo = orNull(o.validTo);
		if (!r || validTo === r.valid_to) continue;
		if (validTo === null) updateWarnings.push(`observation ${o.id}: superseded in the store but not in the tree; nothing reopens an observation`);
		else if (!isoish(validTo)) updateWarnings.push(`observation ${o.id}: validTo ${JSON.stringify(String(validTo).slice(0, 40))} is not a timestamp`);
		else sqlUpdates.push({ what: `observation ${o.id}: validTo ${validTo}`, sql: 'UPDATE entity_observations SET valid_to = ? WHERE id = ?', args: [validTo, o.id] });
	}
	for (const s of envelope.sessions) {
		const r = sessionRows.get(s.id);
		const endedAt = orNull(s.endedAt);
		// A session open in the tree is one this tree saw before it ended.
		if (!r || endedAt === null) continue;
		const tasks = s.tasks ?? [];
		if (endedAt === r.ended_at && orNull(s.summary) === orNull(r.summary) && JSON.stringify(tasks) === JSON.stringify(JSON.parse(r.tasks_json ?? '[]'))) continue;
		const valid = isoish(endedAt) && (orNull(s.summary) === null || (typeof s.summary === 'string' && s.summary.length <= 10000)) && Array.isArray(tasks) && tasks.length <= 1000 && tasks.every((t) => typeof t === 'string' && t.length <= 2000);
		if (!valid) updateWarnings.push(`session ${s.id}: end, summary or tasks are not values session_end writes`);
		else sqlUpdates.push({ what: `session ${s.id}: ended ${endedAt}`, sql: 'UPDATE sessions SET ended_at = ?, summary = ?, tasks_json = ? WHERE id = ?', args: [endedAt, orNull(s.summary), tasks.length ? JSON.stringify(tasks) : null, s.id] });
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
	// Mismatches also land in <mdDir>/verify.log: the exit code alone says
	// only THAT the tree and store disagree, the log records WHERE, so the
	// answer survives the console scrollback.
	const reportLines = [];
	const report = (line) => {
		reportLines.push(line);
		console.log(line);
	};
	const norm = (v) => (v === undefined || v === '' ? null : v);
	// Minimal dependency-free diff: trim the common line prefix and suffix,
	// print the one changed region. When that region is one line on each
	// side (the usual case: store bodies are single-line paragraphs), narrow
	// further to the changed WORDS with a little context. Multiple separate
	// edits collapse into one region; still exact for the single-edit case.
	const CONTEXT_WORDS = 6;
	const wordDiff = (oldLine, newLine) => {
		const O = oldLine.split(' ');
		const N = newLine.split(' ');
		let p = 0;
		while (p < O.length && p < N.length && O[p] === N[p]) p++;
		let sO = O.length;
		let sN = N.length;
		while (sO > p && sN > p && O[sO - 1] === N[sN - 1]) {
			sO--;
			sN--;
		}
		const ctxL = O.slice(Math.max(0, p - CONTEXT_WORDS), p).join(' ');
		const ctxR = O.slice(sO, sO + CONTEXT_WORDS).join(' ');
		const wrap = (mid) => `${p > CONTEXT_WORDS ? '... ' : ''}${ctxL} [${mid}] ${ctxR}${sO + CONTEXT_WORDS < O.length ? ' ...' : ''}`;
		return [`- ${wrap(O.slice(p, sO).join(' '))}`, `+ ${wrap(N.slice(p, sN).join(' '))}`];
	};
	const lineDiff = (oldText, newText) => {
		const O = oldText.split('\n');
		const N = newText.split('\n');
		let start = 0;
		while (start < O.length && start < N.length && O[start] === N[start]) start++;
		let endO = O.length;
		let endN = N.length;
		while (endO > start && endN > start && O[endO - 1] === N[endN - 1]) {
			endO--;
			endN--;
		}
		const lines = [];
		if (start > 0) lines.push(`  ... ${start} identical line(s)`);
		if (endO - start === 1 && endN - start === 1) {
			lines.push(...wordDiff(O[start], N[start]));
		} else {
			for (const l of O.slice(start, endO)) lines.push(`- ${l}`);
			for (const l of N.slice(start, endN)) lines.push(`+ ${l}`);
		}
		if (O.length - endO > 0) lines.push(`  ... ${O.length - endO} identical line(s)`);
		return lines.join('\n');
	};
	const compare = (kind, id, field, mdVal, dbVal) => {
		if (JSON.stringify(norm(mdVal)) !== JSON.stringify(norm(dbVal))) {
			mismatches++;
			if (typeof mdVal === 'string' && typeof dbVal === 'string' && (mdVal.includes('\n') || dbVal.includes('\n') || mdVal.length > 120 || dbVal.length > 120)) {
				report(`MISMATCH ${kind} ${id} .${field}: diff (- store, + tree)\n${lineDiff(dbVal, mdVal)}`);
			} else {
				report(`MISMATCH ${kind} ${id} .${field}:\n  md: ${JSON.stringify(mdVal)?.slice(0, 120)}\n  db: ${JSON.stringify(dbVal)?.slice(0, 120)}`);
			}
		}
	};
	const dbLearnings = new Map(vdb.prepare('SELECT * FROM learnings').all().map((r) => [r.id, r]));
	for (const l of envelope.learnings) {
		const r = dbLearnings.get(l.id);
		if (!r) { mismatches++; report(`MISSING in DB: learning ${l.id}`); continue; }
		compare('learning', l.id, 'date', l.date, r.date);
		compare('learning', l.id, 'category', l.category, r.category);
		compare('learning', l.id, 'content', l.content, r.content);
		compare('learning', l.id, 'project', l.project, r.project);
		compare('learning', l.id, 'tags', l.tags, JSON.parse(r.tags_json));
		const present = fieldPresence.get(l.id) ?? ALL_PRESENT;
		if (present.usageCount) compare('learning', l.id, 'usageCount', l.usageCount, r.usage_count);
		if (present.lastUsed) compare('learning', l.id, 'lastUsed', l.lastUsed, r.last_used);
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
	if (envelope.learnings.length !== dbLearnings.size) { mismatches++; report(`COUNT: md has ${envelope.learnings.length} learnings, DB has ${dbLearnings.size}`); }
	const dbDecisions = new Map(vdb.prepare('SELECT * FROM decisions').all().map((r) => [r.id, r]));
	for (const d of envelope.decisions) {
		const r = dbDecisions.get(d.id);
		if (!r) { mismatches++; report(`MISSING in DB: decision ${d.id}`); continue; }
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
		if (!r) { mismatches++; report(`MISSING in DB: session ${s.id}`); continue; }
		compare('session', s.id, 'summary', s.summary, r.summary);
		compare('session', s.id, 'tasks', s.tasks, JSON.parse(r.tasks_json ?? '[]'));
		compare('session', s.id, 'project', s.project, r.project);
	}
	const dbEntities = new Map(vdb.prepare('SELECT * FROM entities').all().map((r) => [r.id, r]));
	for (const e of envelope.entities) {
		const r = dbEntities.get(e.id);
		if (!r) { mismatches++; report(`MISSING in DB: entity ${e.id}`); continue; }
		compare('entity', e.id, 'name', e.name, r.name);
		compare('entity', e.id, 'entityType', e.entityType, r.entity_type);
		compare('entity', e.id, 'createdAt', e.createdAt, r.created_at);
		if (fromEnvelope || entityUpdatedPresent.has(e.id)) compare('entity', e.id, 'updatedAt', e.updatedAt, r.updated_at);
		compare('entity', e.id, 'summary', e.summary, r.summary);
		compare('entity', e.id, 'confidence', e.confidence, r.confidence);
	}
	const dbObs = new Map(vdb.prepare('SELECT * FROM entity_observations').all().map((r) => [r.id, r]));
	for (const o of envelope.observations) {
		const r = dbObs.get(o.id);
		if (!r) { mismatches++; report(`MISSING in DB: observation ${o.id}`); continue; }
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
		if (!r) { mismatches++; report(`MISSING in DB: relation ${rel.id}`); continue; }
		compare('relation', rel.id, 'fromEntityId', rel.fromEntityId, r.from_entity_id);
		compare('relation', rel.id, 'toEntityId', rel.toEntityId, r.to_entity_id);
		compare('relation', rel.id, 'relationType', rel.relationType, r.relation_type);
		compare('relation', rel.id, 'weight', rel.weight, r.weight);
		compare('relation', rel.id, 'createdAt', rel.createdAt, r.created_at);
	}
	vdb.close();
	console.log(mismatches === 0 ? 'VERIFY: perfect round-trip, 0 mismatches.' : `VERIFY: ${mismatches} mismatches.`);
	if (mismatches > 0) {
		process.exitCode = 1;
		if (!fromEnvelope) {
			const reportPath = join(mdDir, 'verify.log');
			writeFileSync(reportPath, [
				'# Verify report',
				`# tree: ${mdDir}`,
				`# target: ${targetDb}`,
				`# ${mismatches} mismatch(es); exit code 1`,
				'',
				...reportLines,
				'',
			].join('\n'), 'utf8');
			console.log(`  see ${reportPath}`);
		}
	}
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
	if (doUpdate) {
		console.log('');
		if (!exists) {
			console.log('  --update: target store does not exist, nothing to update.');
		} else {
			console.log(`  --update: ${updates.length} existing learning(s) would be updated`);
			for (const u of updates) console.log(`    ${u.id}: ${Object.keys(u.set).join(', ')}`);
			console.log(`  --update: ${entityUpdates.length} entity summary(ies) would be updated`);
			for (const u of entityUpdates) console.log(`    ${u.id}: summary`);
			console.log(`  --update: ${sqlUpdates.length} archive, validity or session change(s) would be written`);
			for (const u of sqlUpdates) console.log(`    ${u.what}`);
			for (const w of updateWarnings) console.log(`    NOT UPDATABLE ${w}`);
		}
	}
	console.log('');
	if (exists && !merge) console.log('  NOTE: importing into this existing store requires --apply --merge.');
	else if (merge) console.log(`  NOTE: ${doUpdate ? '--update' : '--merge'} alone is still a dry run; pass --apply ${doUpdate ? '--update' : '--merge'} to import.`);
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
let err = '';
p.stderr.on('data', (d) => (err += d));

// Line-buffered JSON-RPC driver: requests resolve by id, so the import and
// the sequential --update calls share one server session (one model load).
let outBuf = '';
const pending = new Map();
p.stdout.on('data', (d) => {
	outBuf += d;
	let nl;
	while ((nl = outBuf.indexOf('\n')) !== -1) {
		const line = outBuf.slice(0, nl);
		outBuf = outBuf.slice(nl + 1);
		if (!line.trim().startsWith('{')) continue;
		const msg = JSON.parse(line);
		if (msg.id != null && pending.has(msg.id)) {
			pending.get(msg.id)(msg);
			pending.delete(msg.id);
		}
	}
});
const send = (msg) => p.stdin.write(JSON.stringify(msg) + '\n');
let rpcId = 0;
const request = (method, params) =>
	new Promise((resolve) => {
		const id = ++rpcId;
		pending.set(id, resolve);
		send({ jsonrpc: '2.0', id, method, params });
	});

// Re-embedding hundreds of entries takes a while on first run (model
// download + inference), hence the generous deadline over the whole run.
const deadline = setTimeout(() => {
	p.kill();
	console.error('TIMEOUT after 10 minutes');
	console.error('STDERR tail:', err.split('\n').slice(-8).join('\n'));
	process.exit(1);
}, 600000);

await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'import-md', version: '1' } });
send({ jsonrpc: '2.0', method: 'notifications/initialized' });

const importReply = await request('tools/call', { name: 'memory_import', arguments: { data: envelope } });
const importText = importReply.result?.content?.[0]?.text ?? JSON.stringify(importReply);
console.log(importText);
// A record the server skipped is missing from this store, so the store's next
// export would drop it from the tree: fail, and name each one after exit.
let importResult = null;
try {
	importResult = JSON.parse(importText);
} catch (e) {
	if (!(e instanceof SyntaxError)) throw e;
}
const skippedTotal = Object.values(importResult?.data?.skipped ?? {}).reduce((a, b) => a + b, 0);
const importIncomplete = importResult?.success !== true || skippedTotal > 0;

// The reply text is a ToolResult JSON; non-JSON text is an anticipated
// failure shape and stays ok=false, anything else propagates.
const callTool = async (name, args) => {
	const reply = await request('tools/call', { name, arguments: args });
	const text = reply.result?.content?.[0]?.text ?? JSON.stringify(reply);
	try {
		return { ok: JSON.parse(text).success === true, text };
	} catch (e) {
		if (!(e instanceof SyntaxError)) throw e;
		return { ok: false, text };
	}
};

if (doUpdate) {
	let updated = 0;
	let failedCount = 0;
	const calls = [
		...updates.map((u) => ({ id: u.id, what: Object.keys(u.set).join(', '), name: 'memory_learn_update', args: { learningId: u.id, ...u.set } })),
		...entityUpdates.map((u) => ({ id: u.id, what: 'summary', name: 'memory_entity_create', args: u.args })),
	];
	for (const c of calls) {
		const { ok, text } = await callTool(c.name, c.args);
		if (ok) {
			updated++;
			console.log(`updated ${c.id}: ${c.what}`);
		} else {
			failedCount++;
			console.warn(`  UPDATE FAILED ${c.id}: ${text.slice(0, 200)}`);
		}
	}
	console.log(`Updated ${updated} record(s)${failedCount ? `, ${failedCount} FAILED` : ''}.`);
	for (const w of updateWarnings) console.warn(`  NOT UPDATABLE ${w}`);
	if (failedCount) process.exitCode = 1;
}

clearTimeout(deadline);
// Post-steps only after the server has really exited: it may still hold
// the SQLite lock, and reading the store too early is a crash race.
// No tool writes an exact archive time, validity end or session end, so these
// are set directly; the FTS triggers still fire.
function writeSqlUpdates() {
	const Database = require('better-sqlite3');
	const wdb = new Database(targetDb);
	wdb.pragma('busy_timeout = 10000');
	wdb.transaction(() => {
		for (const u of sqlUpdates) wdb.prepare(u.sql).run(...u.args);
	})();
	wdb.close();
	console.log(`Wrote ${sqlUpdates.length} archive, validity or session change(s).`);
}

const post = () => {
	if (importIncomplete) {
		for (const l of err.split('\n').filter((x) => x.includes('[import] skipped'))) console.error(`  ${l.trim()}`);
		console.error(`IMPORT INCOMPLETE: ${importResult?.success === true ? `${skippedTotal} record(s) skipped` : 'memory_import failed'}. This store now lacks them, so its next export would drop them.`);
		process.exitCode = 1;
	}
	if (sqlUpdates.length) writeSqlUpdates();
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
