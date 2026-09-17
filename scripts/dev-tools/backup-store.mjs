#!/usr/bin/env node
/**
 * backup-store.mjs — a consistent snapshot of the memory store, taken while servers run.
 *
 * SQLite's backup API copies a transactionally consistent image, so this needs no
 * shutdown and never touches the source: the WAL trap of copying `memory.sqlite`
 * with `cp` (see the README) does not apply. `--wait` first waits for a background
 * re-embed to finish, which is what a freshly installed build starts on boot.
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, platform, tmpdir } from 'node:os';

const require = createRequire(import.meta.url);

function defaultDataDir() {
	const home = homedir();
	if (platform() === 'darwin') return join(home, 'Library', 'Application Support', 'local-memory-mcp');
	if (platform() === 'win32') return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'local-memory-mcp');
	return join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'local-memory-mcp');
}

const HELP = `backup-store.mjs — consistent snapshot of the memory store

Usage: node scripts/dev-tools/backup-store.mjs [options]

Writes <out>/memory-<YYYY-MM-DD-HH-mm>.sqlite through SQLite's backup API and
compares the row counts of source and copy. Servers can keep running; the
source store is opened read-only.

Options:
  --db <path>       source store
                    (default: MEMORY_DB_PATH env, else <data-dir>/memory.sqlite)
  --out <dir>       target directory (default: <tmp>/local-memory-backups)
  --wait            wait until every entry has an embedding row before copying,
                    so a snapshot taken right after a new build is complete
  --no-copy         only wait and report; write nothing
  --help            show this help

The snapshot holds your memories in one file: treat it like the store itself.
`;

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
	process.stdout.write(HELP);
	process.exit(0);
}
const flag = (name, fallback) => {
	const at = argv.indexOf(name);
	return at === -1 ? fallback : argv[at + 1];
};
const dbPath = resolve(flag('--db', process.env.MEMORY_DB_PATH ?? join(defaultDataDir(), 'memory.sqlite')));
const outDir = resolve(flag('--out', join(tmpdir(), 'local-memory-backups')));
const doWait = argv.includes('--wait');
const doCopy = !argv.includes('--no-copy');

if (!existsSync(dbPath)) {
	process.stderr.write(`No store at ${dbPath}\n`);
	process.exit(1);
}

const Database = require('better-sqlite3');
const open = () => {
	const db = new Database(dbPath, { readonly: true, fileMustExist: true });
	// The embedding tables are vec0 virtual tables, so counting them needs the extension.
	require('sqlite-vec').load(db);
	return db;
};

const TABLES = ['learnings', 'decisions', 'entities', 'entity_observations', 'sessions'];
function counts(db) {
	const out = {};
	for (const table of TABLES) out[table] = db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
	// embedding_sources per entry since the chunked schema; the older schema had one row per entry in embeddings.
	const embeddingTable = db.prepare("SELECT name FROM sqlite_master WHERE name IN ('embedding_sources', 'embeddings')").get();
	if (embeddingTable) out[embeddingTable.name] = db.prepare(`SELECT COUNT(*) c FROM ${embeddingTable.name}`).get().c;
	return out;
}
const entryCount = (c) => c.learnings + c.decisions + c.entities + c.entity_observations;
const embeddedCount = (c) => c.embedding_sources ?? c.embeddings ?? 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (doWait) {
	const started = Date.now();
	for (let round = 0; ; round++) {
		const db = open();
		const c = counts(db);
		db.close();
		const secs = ((Date.now() - started) / 1000).toFixed(0);
		if (embeddedCount(c) >= entryCount(c)) {
			process.stdout.write(`embeddings complete after ${secs} s: ${embeddedCount(c)} of ${entryCount(c)} entries\n`);
			break;
		}
		if (round % 4 === 0) process.stdout.write(`${secs} s: ${embeddedCount(c)} of ${entryCount(c)} entries embedded\n`);
		if (Date.now() - started > 600_000) {
			process.stderr.write('still embedding after 10 minutes; is a server running?\n');
			process.exit(1);
		}
		await sleep(5000);
	}
}

if (!doCopy) process.exit(0);

mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const target = join(outDir, `memory-${stamp}.sqlite`);
if (existsSync(target)) {
	process.stderr.write(`${target} exists; wait a minute or pass another --out\n`);
	process.exit(1);
}

const live = open();
await live.backup(target);
const before = counts(live);
live.close();

const copy = new Database(target, { readonly: true, fileMustExist: true });
require('sqlite-vec').load(copy);
const after = counts(copy);
copy.close();

process.stdout.write(`backup ${target} (${(statSync(target).size / 1048576).toFixed(1)} MB)\n`);
process.stdout.write(`source ${JSON.stringify(before)}\ncopy   ${JSON.stringify(after)}\n`);
if (JSON.stringify(before) !== JSON.stringify(after)) {
	process.stderr.write('row counts differ between source and copy\n');
	process.exit(1);
}
process.stdout.write('row counts match\n');
