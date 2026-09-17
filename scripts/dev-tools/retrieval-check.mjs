#!/usr/bin/env node
/**
 * retrieval-check.mjs — measure how well a build retrieves whole entries.
 *
 * Queries are sentences taken from the store's own learnings, so the entry each
 * one comes from is the known answer: a query from the end of a long entry only
 * ranks first if the build embeds more than the first 512 tokens. Runs against a
 * copy of the store through the build's own memory_search, with the real model,
 * so a chunker, penalty or scoring change can be compared build by build.
 */
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir, platform, tmpdir } from 'node:os';

const require = createRequire(import.meta.url);

function defaultDataDir() {
	const home = homedir();
	if (platform() === 'darwin') return join(home, 'Library', 'Application Support', 'local-memory-mcp');
	if (platform() === 'win32') return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'local-memory-mcp');
	return join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'local-memory-mcp');
}

// About 512 tokens: the embedding model's window, at the measured 3.4 chars per token.
const WINDOW_CHARS = 1742;

const HELP = `retrieval-check.mjs — measure a build's retrieval quality on a copy of a store

Usage: node scripts/dev-tools/retrieval-check.mjs [options]

Without -r or --run this is a DRY RUN: it reports the store, the build and
the queries it would use, and measures nothing. A real run needs several
minutes: it embeds every query with the real model, and re-embeds the whole
copy when the build's embeddings differ from the ones in the store.

The source store is only ever read, through a read-only connection, so it
can stay in use. Everything else happens on a copy in the output directory.
That copy holds your memories: keep it out of a repository.

Queries come from the copy itself, in three sets, and the entry a query was
taken from is the expected first result:
  tail   the last long sentence past char 3000 of entries over 3600 chars
  head   a sentence between chars 100 and 900, from every third entry
  short  a sentence from entries that fit the model's window (${WINDOW_CHARS} chars)

Reported per mode and set: r1 and r5 (share of queries whose entry ranks
first, or in the top five) and MRR (mean reciprocal rank). An entry that the
result list misses counts as one rank past --limit.

Options:
  -r, --run         perform the measurement (default is a dry run)
  --db <path>       source store
                    (default: MEMORY_DB_PATH env, else <data-dir>/memory.sqlite)
  --build <dir>     package directory whose dist/ and dependencies are used
                    (default: this repository)
  --out <dir>       directory for the copy and the result JSON
                    (default: <tmp>/local-memory-retrieval-check)
  --label <name>    names the copy and the result file (default: the build's
                    directory name)
  --queries <n>     maximum queries per set (default: 80)
  --limit <n>       result depth per query (default: 20)
  --help            show this help

Comparing two builds: run it once per build with different --build and
--label, then diff the two result files.
`;

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
	process.stdout.write(HELP);
	process.exit(0);
}
if (argv.length === 0) process.stdout.write(HELP + '\n');

const flag = (name, fallback) => {
	const at = argv.indexOf(name);
	return at === -1 ? fallback : argv[at + 1];
};
const doRun = argv.includes('-r') || argv.includes('--run');
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dbPath = resolve(flag('--db', process.env.MEMORY_DB_PATH ?? join(defaultDataDir(), 'memory.sqlite')));
const buildDir = resolve(flag('--build', repoRoot));
const outDir = resolve(flag('--out', join(tmpdir(), 'local-memory-retrieval-check')));
const label = flag('--label', basename(buildDir));
const perSet = Number(flag('--queries', '80'));
const limit = Number(flag('--limit', '20'));

if (!existsSync(dbPath)) {
	process.stderr.write(`No store at ${dbPath}\n`);
	process.exit(1);
}
const searchModule = join(buildDir, 'dist', 'tools', 'search.js');
if (!existsSync(searchModule)) {
	process.stderr.write(`No build at ${searchModule} — run npm run build in ${buildDir}\n`);
	process.exit(1);
}

const Database = require('better-sqlite3');

/** The last sentence of 80 to 250 chars that starts inside [from, to), skipping the first line and code spans. */
function sentenceIn(content, from, to) {
	let found = null;
	const re = /[^.!?\n]{80,250}[.!?]/g;
	let m;
	while ((m = re.exec(content))) {
		if (m.index > content.indexOf('\n') && m.index >= from && m.index < to && !m[0].includes('`')) found = m[0].trim();
	}
	return found;
}

function querySets(rows) {
	const take = (list) => list.filter((x) => x.q).slice(0, perSet);
	return {
		tail: take(rows.filter((r) => r.content.length > 3600).map((r) => ({ id: r.id, q: sentenceIn(r.content, 3000, Infinity) }))),
		head: take(rows.filter((_, i) => i % 3 === 1).map((r) => ({ id: r.id, q: sentenceIn(r.content, 100, 900) }))),
		short: take(rows.filter((r) => r.content.length <= WINDOW_CHARS).map((r) => ({ id: r.id, q: sentenceIn(r.content, 60, WINDOW_CHARS) }))),
	};
}

const liveRows = () => {
	const live = new Database(dbPath, { readonly: true, fileMustExist: true });
	const rows = live.prepare('SELECT id, content FROM learnings WHERE archived = 0 ORDER BY id').all();
	live.close();
	return rows;
};

if (!doRun) {
	const sets = querySets(liveRows());
	process.stdout.write(`DRY RUN — nothing measured, nothing written.
  store   ${dbPath}
  build   ${buildDir}
  out     ${join(outDir, label + '.sqlite')} and ${join(outDir, label + '.json')}
  queries ${Object.entries(sets).map(([name, qs]) => `${name} ${qs.length}`).join(', ')} (limit ${limit})
Add --run to measure.
`);
	process.exit(0);
}

mkdirSync(outDir, { recursive: true });
const copyPath = join(outDir, `${label}.sqlite`);
for (const suffix of ['', '-wal', '-shm']) if (existsSync(copyPath + suffix)) rmSync(copyPath + suffix);
const live = new Database(dbPath, { readonly: true, fileMustExist: true });
await live.backup(copyPath);
live.close();

// The build resolves the store at its first query, so point it at the copy before importing it.
process.env.MEMORY_DB_PATH = copyPath;
delete process.env.MEMORY_EMBED_MOCK;

const load = (file) => import(pathToFileURL(join(buildDir, 'dist', file)).href);
const { getDb } = await load('db/client.js');
const vector = await load('db/vector.js');
const { search } = await load('tools/search.js');
const db = getDb();

// Bring the copy's embeddings up to what this build writes; a build with the same
// model and chunker finds nothing to do.
const backfill = vector.backfillEmbeddings ?? vector.backfillEntityEmbeddings;
if (backfill) {
	const started = Date.now();
	const n = await backfill(db);
	process.stdout.write(`${label}: re-embedded ${n} entries in ${((Date.now() - started) / 1000).toFixed(0)} s\n`);
}

const sets = querySets(db.prepare('SELECT id, content FROM learnings WHERE archived = 0 ORDER BY id').all());
const summary = { label, build: buildDir, store: dbPath, limit, sets: {} };
for (const mode of ['vector', 'hybrid']) {
	for (const [name, queries] of Object.entries(sets)) {
		const ranks = [];
		for (const { id, q } of queries) {
			const r = await search({ query: q, mode, types: ['learning'], limit });
			if (!r.success) {
				process.stderr.write(`${r.error}\n`);
				process.exit(1);
			}
			const at = r.data.results.findIndex((x) => x.id === id);
			ranks.push(at === -1 ? limit + 1 : at + 1);
		}
		const share = (k) => Number((ranks.filter((x) => x <= k).length / ranks.length).toFixed(2));
		const line = { n: ranks.length, r1: share(1), r5: share(5), mrr: Number((ranks.reduce((s, x) => s + 1 / x, 0) / ranks.length).toFixed(3)) };
		summary.sets[`${mode} ${name}`] = line;
		process.stdout.write(`${label} ${mode} ${name}: n ${line.n} r1 ${line.r1} r5 ${line.r5} mrr ${line.mrr}\n`);
	}
}

const jsonPath = join(outDir, `${label}.json`);
writeFileSync(jsonPath, JSON.stringify(summary, null, 2) + '\n');
// Checkpoint the copy's WAL, so the run leaves one file behind instead of three.
(await load('db/client.js')).closeDb();
process.stdout.write(`Wrote ${jsonPath}\nThe copy at ${copyPath} holds your memories; delete it when done.\n`);
