/**
 * Schema pin for the dev tools — runs as part of the MAIN suite (npm test).
 *
 * The markdown export/import scripts in this directory are the independent
 * backup path: they read the database directly and are pinned to a schema
 * version, so a backup works even while the server code is broken. The cost
 * of that independence is that nothing updates them automatically.
 *
 * This test is the tripwire: it compares the scripts' pinned version against
 * the schema_version the SHIPPED SQL writes (base schema plus migrations —
 * what will actually reach production). It fails the moment a new schema
 * version lands in the codebase, naming the two scripts that now need
 * updating. Until then it is silent and the scripts stay untouched.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dbDir = join(here, '..', '..', 'src', 'db');

const pinnedVersion = (script) => {
	const m = readFileSync(join(here, script), 'utf8').match(/EXPECTED_SCHEMA_VERSION = '(\d+)'/);
	return m ? m[1] : `no EXPECTED_SCHEMA_VERSION found in ${script}`;
};

// The version that will reach production: the highest schema_version any
// shipped SQL file writes.
const shippedVersion = () => {
	const files = [
		join(dbDir, 'schema.sql'),
		...readdirSync(join(dbDir, 'migrations'))
			.filter((f) => f.endsWith('.sql'))
			.map((f) => join(dbDir, 'migrations', f)),
	];
	let max = 0;
	for (const file of files) {
		for (const m of readFileSync(file, 'utf8').matchAll(/\('schema_version',\s*'(\d+)'\)/g)) {
			max = Math.max(max, Number(m[1]));
		}
	}
	return String(max);
};

describe('dev-tools schema pin', () => {
	const shipped = shippedVersion();
	it('shipped SQL declares a schema_version', () => {
		expect(Number(shipped)).toBeGreaterThan(0);
	});
	for (const script of ['export-md.mjs', 'import-md.mjs']) {
		it(`${script} is written for shipped schema_version ${shipped}`, () => {
			expect(
				pinnedVersion(script),
				`The shipped schema_version is now ${shipped}. scripts/dev-tools/${script} is the independent backup path and must be updated for the new schema (then bump its EXPECTED_SCHEMA_VERSION).`
			).toBe(shipped);
		});
	}
});
