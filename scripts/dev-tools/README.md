# Dev tools: markdown export / import

Two standalone scripts that turn the memory store into a human-readable,
lossless markdown tree and back. They are an independent backup path: the
export needs no build and no running server, so it works even while the
server code has flaws mid-development.

## Back up your data first

`BACKUP - Backup - BACKUP - Backup`

### This markdown export

It reads the database through a
read-only SQLite connection, so it sees a consistent snapshot even while
MCP servers are running, and it never copies or deletes files:

```
node scripts/dev-tools/export-md.mjs -e [new-or-empty-dir]
```

Without a directory argument it defaults to the OS Downloads folder,
`<Downloads>/local-memory-export`.

### Create a JSON envelope

The **MD tree** converts to the server's own
`studiomeyer-memory-export` v1 format without any server involved:

```
node scripts/dev-tools/import-md.mjs <tree> --envelope-only backup.json
```

`backup.json` restores through `memory_import` (the MCP tool, or this
script's `--apply`), which re-embeds everything from the text:

```
node scripts/dev-tools/import-md.mjs --from-envelope backup.json --db <newfile> --apply
```

To turn an envelope back into markdown, import it into a fresh store
first, then export from that store.


### Last resort: copying the raw `memory.sqlite`

**Shut down every** MCP server first (Claude Code, Claude Desktop,
Cursor, anything connected). This applies on every OS.

- The store is in WAL mode. While a server runs, it is really three
  files: `memory.sqlite`, `-wal` and `-shm`. A copy of just the
  `.sqlite` file can silently miss the newest writes.
- On Linux and macOS it is worse. Moving or deleting the live file
  "succeeds", running servers keep writing to the detached inode, and
  the next session silently starts an empty store.

## export-md.mjs: store to markdown tree

```
node scripts/dev-tools/export-md.mjs [options] [outDir]
```

Run bare for help plus a dry run; nothing is written without `-e`/`--export`.
Defaults: live store to `<Downloads>/local-memory-export`; `--db <path>`
selects another store.

- One file per learning, decision and session, full frontmatter, verbatim
  body. Entities carry every observation as a `## Observation <id>` section
  with its validity window, source and confidence; `relations.md` is the
  canonical edge list; `meta.md` records all store meta keys.
- The target must be a new or empty directory. The script never deletes
  anything; remove a previous export yourself.
- Idempotent: the same store always produces a byte-identical tree.
- Refuses (instead of silently losing data) when the store's columns or
  `schema_version` do not match what the script was written for.
- Needs `npm install` only, no build.

## import-md.mjs: markdown tree to store

```
node scripts/dev-tools/import-md.mjs [options] [mdDir]
```

The default run is a dry run: it validates the tree and predicts adds and
skips, writing nothing. `--apply` performs the import and requires a built
server (`npm run build`, or `--server <path>` to any built copy) because it
drives the real `memory_import` over MCP stdio. Validation, re-embedding
and FTS rebuild all apply.

- Additive only: existing ids are skipped, never updated. Re-applying the
  same tree adds 0 records.
- New entries: drop an id-less `.md` into `learnings/`. The script assigns
  a UUID and writes it back into the file, so nothing imports twice.
  Importing into an existing store additionally needs `--merge`.
- Edits to existing entries land only via a fresh rebuild: import into a
  new file (`--db <newfile> --apply`), then swap it in **with all MCP
  servers stopped** (also remove the old `-wal`/`-shm` siblings).
- `--from-envelope <file>` imports an existing JSON envelope instead of a
  tree; it cannot be combined with a tree argument or the envelope output
  flags.
- `--verify` compares the tree field-by-field against the target database.
- Refuses a tree or an existing target whose `schema_version` differs from
  the one the script was written for.

## Tests

The main test suite pins both scripts to the shipped schema
(`schema-pin.test.mjs`) and fails the moment a schema change requires
updating them.
