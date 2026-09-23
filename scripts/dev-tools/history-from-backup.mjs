#!/usr/bin/env node
/**
 * history-from-backup.mjs — store a learning's text from a backup as its first version (local-memory-mcp-mnb).
 *
 * For learnings rewritten before learnings_history existed, whose old text now survives only in a backup.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);

function defaultDataDir() {
	const home = homedir();
	if (platform() === 'darwin') return join(home, 'Library', 'Application Support', 'local-memory-mcp');
	if (platform() === 'win32') return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'local-memory-mcp');
	return join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'local-memory-mcp');
}

const HELP = `history-from-backup.mjs — a backup's text of a learning as its first version

Usage: node scripts/dev-tools/history-from-backup.mjs --backup <file> --expired-at <time> [options] <id>...

For each learning id (full, or an 8-character prefix unique in the store), stores
the backup's row as a version valid from the learning's creation until
--expired-at, the time the rewrite replaced it. Dry run unless --apply.

A learning is skipped when its text in the backup equals the current one, or when
it already has versions: run this before any other change to those learnings,
so the new version is the first in their chain. Re-running changes nothing.

Options:
  --backup <file>     backup store holding the old text (opened read-only)
  --expired-at <time> when the old text was replaced, "YYYY-MM-DD HH:MM:SS" UTC
  --db <path>         target store
                      (default: MEMORY_DB_PATH env, else <data-dir>/memory.sqlite)
  --apply             write the versions
  --help              show this help
`;

const argv = process.argv.slice(2);
const flagValue = (name) => {
	const i = argv.indexOf(name);
	return i === -1 ? undefined : argv[i + 1];
};
if (argv.includes('--help') || argv.length === 0) {
	console.log(HELP);
	process.exit(0);
}
const backupPath = flagValue('--backup');
const expiredAt = flagValue('--expired-at');
const dbPath = flagValue('--db') ?? process.env.MEMORY_DB_PATH ?? join(defaultDataDir(), 'memory.sqlite');
const apply = argv.includes('--apply');
const valueFlags = new Set(['--backup', '--expired-at', '--db']);
const ids = argv.filter((a, i) => !a.startsWith('--') && !valueFlags.has(argv[i - 1]));

if (!backupPath || !existsSync(backupPath)) {
	console.error(`No backup at ${backupPath}. Pass --backup <file>.`);
	process.exit(2);
}
if (!expiredAt || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(expiredAt)) {
	console.error('Pass --expired-at "YYYY-MM-DD HH:MM:SS" (UTC), the time the old text was replaced.');
	process.exit(2);
}
if (ids.length === 0) {
	console.error('Name at least one learning id.');
	process.exit(2);
}

const Database = require('better-sqlite3');
const backup = new Database(backupPath, { readonly: true });
const db = new Database(dbPath, { readonly: !apply });
db.pragma('busy_timeout = 5000');
if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'learnings_history'").get()) {
	console.error(`${dbPath} has no learnings_history table; start a server of this version on it first.`);
	process.exit(2);
}

// A backup taken before a column existed lacks it; the column's default applies.
const backupColumns = new Set(backup.prepare('PRAGMA table_info(learnings)').all().map((c) => c.name));
const col = (name, fallback) => (backupColumns.has(name) ? name : `${fallback} AS ${name}`);
const readBackup = backup.prepare(
	`SELECT id, date, category, content, project, tags_json, confidence, memory_type,
	        ${col('style_json', "'[]'")}, ${col('split_from', 'NULL')}, archived, lifecycle_state
	 FROM learnings WHERE id = ?`
);
const insert = db.prepare(
	`INSERT INTO learnings_history
	 (id, learning_id, category, content, project, tags_json, confidence, memory_type,
	  style_json, split_from, archived, lifecycle_state, recorded_at, expired_at)
	 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

let added = 0;
for (const given of ids) {
	const matches = db.prepare('SELECT id, content FROM learnings WHERE id GLOB ?').all(`${given}*`);
	if (matches.length !== 1) {
		console.log(`SKIP ${given}: ${matches.length === 0 ? 'no learning' : `${matches.length} learnings`} with this id`);
		continue;
	}
	const current = matches[0];
	const old = readBackup.get(current.id);
	if (!old) { console.log(`SKIP ${current.id}: not in the backup`); continue; }
	if (old.content === current.content) { console.log(`SKIP ${current.id}: text unchanged since the backup`); continue; }
	if (db.prepare('SELECT 1 FROM learnings_history WHERE learning_id = ?').get(current.id)) {
		console.log(`SKIP ${current.id}: already has versions`);
		continue;
	}
	if (!(old.date < expiredAt)) { console.log(`SKIP ${current.id}: --expired-at is not after its creation ${old.date}`); continue; }
	console.log(`${apply ? 'ADD' : 'WOULD ADD'} ${current.id}: ${old.content.length} characters, ${old.date} .. ${expiredAt}`);
	if (apply) {
		insert.run(
			randomUUID(), current.id, old.category, old.content, old.project, old.tags_json, old.confidence,
			old.memory_type, old.style_json, old.split_from, old.archived, old.lifecycle_state, old.date, expiredAt
		);
	}
	added++;
}
console.log(`${added} version(s) ${apply ? 'added' : 'would be added; pass --apply to write'}.`);
