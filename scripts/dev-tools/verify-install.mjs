#!/usr/bin/env node
/**
 * verify-install.mjs — smoke-test a built server over MCP stdio against a copy of a store.
 *
 * Exercises what a client does on connect and in a session: handshake, tools/list,
 * memory_health, memory_session_start, memory_get, hybrid memory_search. The real
 * embedding model is used, so a search result proves the vector half works. The
 * source store is copied first and only the copy is written to.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, platform, tmpdir } from 'node:os';

const require = createRequire(import.meta.url);

function defaultDataDir() {
	const home = homedir();
	if (platform() === 'darwin') return join(home, 'Library', 'Application Support', 'local-memory-mcp');
	if (platform() === 'win32') return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'local-memory-mcp');
	return join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'local-memory-mcp');
}

const HELP = `verify-install.mjs — smoke-test a built server over MCP stdio

Usage: node scripts/dev-tools/verify-install.mjs <path to dist/server.js> [options]

Copies the store, starts that server against the copy with the real model, and
reports the handshake, the tool count, health, a session start, a memory_get and
a hybrid search. Exit code 1 on the first failed step.

Options:
  --db <path>       source store
                    (default: MEMORY_DB_PATH env, else <data-dir>/memory.sqlite)
  --out <dir>       directory for the copy (default: <tmp>/local-memory-verify)
  --query <text>    search query (default: a German sentence, to exercise the model)
  --wait            wait for a background re-embed before health and search; a
                    build that changed the embeddings answers with 0 chunks and
                    finds nothing until it finishes
  --help            show this help

The copy holds your memories; delete it when you are done.
`;

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
	process.stdout.write(HELP);
	process.exit(argv.length === 0 ? 1 : 0);
}
const flag = (name, fallback) => {
	const at = argv.indexOf(name);
	return at === -1 ? fallback : argv[at + 1];
};
const serverPath = resolve(argv[0]);
const dbPath = resolve(flag('--db', process.env.MEMORY_DB_PATH ?? join(defaultDataDir(), 'memory.sqlite')));
const outDir = resolve(flag('--out', join(tmpdir(), 'local-memory-verify')));
const query = flag('--query', 'wie synchronisiere ich den Speicher zwischen Rechnern');
const doWait = argv.includes('--wait');

if (!existsSync(serverPath)) {
	process.stderr.write(`No server at ${serverPath}\n`);
	process.exit(1);
}
if (!existsSync(dbPath)) {
	process.stderr.write(`No store at ${dbPath}\n`);
	process.exit(1);
}

const Database = require('better-sqlite3');
mkdirSync(outDir, { recursive: true });
const copyPath = join(outDir, 'verify.sqlite');
for (const suffix of ['', '-wal', '-shm']) if (existsSync(copyPath + suffix)) rmSync(copyPath + suffix);
const live = new Database(dbPath, { readonly: true, fileMustExist: true });
await live.backup(copyPath);
const entries = ['learnings', 'decisions', 'entities', 'entity_observations']
	.reduce((sum, table) => sum + live.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c, 0);
live.close();

const env = { ...process.env, MEMORY_DB_PATH: copyPath };
delete env.MEMORY_EMBED_MOCK;
const child = spawn(process.execPath, [serverPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk; });
const pending = new Map();
let buffer = '';
let nextId = 1;
child.stdout.on('data', (chunk) => {
	buffer += chunk;
	let nl;
	while ((nl = buffer.indexOf('\n')) >= 0) {
		const msg = JSON.parse(buffer.slice(0, nl));
		buffer = buffer.slice(nl + 1);
		pending.get(msg.id)?.(msg);
		pending.delete(msg.id);
	}
});
const request = (method, params) => new Promise((resolve) => {
	const id = nextId++;
	pending.set(id, resolve);
	child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const call = async (name, args) => JSON.parse((await request('tools/call', { name, arguments: args })).result.content[0].text);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (message) => {
	process.stderr.write(`${message}\nstderr tail: ${stderr.trim().split('\n').slice(-4).join(' | ')}\n`);
	child.kill();
	process.exit(1);
};

const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify', version: '0' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const tools = (await request('tools/list', {})).result.tools;
process.stdout.write(`version ${init.result.serverInfo.version} | instructions ${init.result.instructions.length} chars | ${tools.length} tools\n`);

const embedded = (health) => health.data.vector.embeddingsCount ?? 0;
let health = await call('memory_health', {});
if (doWait) {
	const started = Date.now();
	while (embedded(health) < entries) {
		if (Date.now() - started > 600_000) fail(`still embedding after 10 minutes: ${embedded(health)} of ${entries}`);
		await sleep(3000);
		health = await call('memory_health', {});
	}
	process.stdout.write(`embeddings complete after ${((Date.now() - started) / 1000).toFixed(0)} s\n`);
}
process.stdout.write(`health ${JSON.stringify(health.data)}\n`);
if (health.data.integrity !== 'ok') fail('integrity check failed');
if (!health.data.vector.enabled) fail('sqlite-vec is not loaded');

const start = await call('memory_session_start', {});
process.stdout.write(`session_start ${JSON.stringify(start).length} chars, ${start.data.recentLearnings.length} learning(s)\n`);
const ids = start.data.recentLearnings.map((l) => l.id);
if (ids.length > 0) {
	const got = await call('memory_get', { ids });
	process.stdout.write(`memory_get ${got.data.results.length} found, first ${got.data.results[0]?.content.length} chars\n`);
	if (got.data.results.length !== ids.length) fail('memory_get did not return every id');
}

const t0 = Date.now();
const search = await call('memory_search', { query, detail: 'brief', limit: 3 });
process.stdout.write(`search ${search.data.mode}${search.data.notice ? ` (${search.data.notice})` : ''} ${Date.now() - t0} ms, ${search.data.results.length} results\n`);
for (const r of search.data.results) process.stdout.write(`   ${r.type} ${(r.headline ?? r.body).slice(0, 90)}\n`);
if (search.data.results.length === 0) fail('hybrid search found nothing; with --wait this means the vector half is broken');

child.kill();
process.stdout.write(`stderr tail: ${stderr.trim().split('\n').slice(-3).join(' | ')}\nok\n`);
