# Dev tools

A lossless markdown export and import, `backup-store.mjs` for a snapshot taken
while servers run, `verify-install.mjs` to smoke-test a built server over MCP
stdio, and `retrieval-check.mjs`, which measures how well a build finds whole
entries. The install workflow those last two belong to is in
[../keep/README.md](../keep/README.md).

## Markdown export / import

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

## Tree format 2: what you see is what you import

Bodies that the importer re-parses by `## ` sections (observation content,
entity summaries, decision fields, session summaries and tasks) are
escaped: a content line that would read as a heading gains a leading
backslash (`\## `), and the importer strips exactly one after the
structural parse. A `## ` line at column 0 is therefore always structural,
so body text can never fabricate a sibling record and the sections a
reader sees in a tree are exactly the records the parser produces.
Learning bodies are verbatim (they are never re-parsed) and stay
unescaped. `meta.md` records `tree_format: 2`; the importer refuses a
tree without the marker, so add the line to a hand-authored tree.

A foreign tree or envelope is still untrusted **data**: ids and field
values are imported as-is (the server's `memory_import` does not validate
them, upstream issue #29). Review foreign input before `--apply`.

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
- `--sync` writes a tree two machines can merge in git. It leaves out
  values that differ per machine (learning `usageCount`/`lastUsed`, entity
  `updated`, meta provenance such as `first_run_at`), `INDEX.md`, and
  sessions that have not ended. Session files are named by start time, so
  sessions arriving from another machine renumber nothing.
- Refuses (instead of silently losing data) when the store's columns or
  `schema_version` do not match what the script was written for.
- Heading-like content lines are escaped (`\## `, see tree format above),
  so records whose content contains them are exported, not skipped.
- Skip-and-warn: a record that cannot be represented at all (a name or
  title with a line break, an id with whitespace, a filename clash; only
  possible in a poisoned store) is excluded, not aborted, and logged in
  full to `<outDir>/error.log`. Each entry names the record and how to
  find it.
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
- Edits to existing entries land with `--update` (below). The alternative
  that reproduces every field exactly is a fresh rebuild: import into a new
  file (`--db <newfile> --apply`), then swap it in **with all MCP servers
  stopped** (also remove the old `-wal`/`-shm` siblings).
- `--from-envelope <file>` imports an existing JSON envelope instead of a
  tree; it cannot be combined with a tree argument or the envelope output
  flags.
- `--verify` compares the tree field-by-field against the target database;
  mismatches land in `<mdDir>/verify.log` and set exit code 1. That is the
  modification detector: edit a tree file, `--verify` names the entry and
  field that now differ from the store.
- `--update` (with `--apply`; implies `--merge`) brings existing records up
  to the tree's state, so nothing is left for the next export to revert:
  learning content, confidence and tags through `memory_learn_update`
  (re-embeds), entity summaries through `memory_entity_create`, and
  learning archive state, observation `validTo` and session end written
  exactly as the tree has them. Lifecycle only moves forward: nothing
  reopens an archived learning, a superseded observation or an ended
  session. Other differences (category, project, source, memoryType, date,
  entity name or type) are reported and left untouched. The dry run
  predicts every change; a second run finds none.
  **Caution:** an update overwrites the stored value with no history, and
  it waives the import's "existing rows are never touched" guarantee, so a
  foreign tree carrying your ids could rewrite what you already know.
  Export a backup first; review the dry run before updating from any tree
  you did not export yourself. Updates run per entry, not as one
  transaction.
- Refuses a tree whose `meta.md` does not record `tree_format: 2` (see
  tree format above), and a tree or an existing target whose
  `schema_version` differs from the one the script was written for.
- Skip-and-warn: an unreadable, escaping or malformed tree file is
  excluded, not aborted; the store side is atomic (nothing is written
  unless the whole envelope parses). Durable runs log each skip, with the
  file path and line, to `<mdDir>/error.log`.

## backup-store.mjs: a snapshot while servers run

```
node scripts/dev-tools/backup-store.mjs [--db <path>] [--out <dir>] [--wait] [--no-copy]
```

Copies the store through SQLite's backup API, which yields a transactionally
consistent single file, so no server has to stop and the raw-copy WAL trap above
does not apply. It then compares the row counts of source and copy and fails if
they differ. `--wait` holds off until every entry has an embedding row, which is
what you want right after installing a build that re-embeds; `--no-copy` only
watches that progress. The snapshot holds your memories — treat it like the
store.

## verify-install.mjs: does a built server actually work?

```
node scripts/dev-tools/verify-install.mjs <path to dist/server.js> [--wait] [--db <path>] [--out <dir>] [--query <text>]
```

Copies the store, starts that server against the copy over MCP stdio with the
real model, and walks the path a client takes: handshake, `tools/list`,
`memory_health`, `memory_session_start`, `memory_get`, hybrid `memory_search`.
Exits 1 on the first failed step, including an empty search result, which is how
a broken vector half shows up. Use `--wait` whenever the build changed the
embeddings: until the background pass finishes, health reports no chunks and
hybrid search finds nothing.

## retrieval-check.mjs: does a build find whole entries?

```
node scripts/dev-tools/retrieval-check.mjs [options]
```

Queries are sentences taken from the store's own learnings, so the entry a
query comes from is the known answer. A query from the end of a long entry
therefore only ranks first if the build embeds more than the first 512
tokens the model reads.

Run bare for help plus a dry run; `-r`/`--run` measures, which takes
several minutes (real model, and a re-embed of the copy whenever the
build's embeddings differ from the store's). The source store is only read,
through a read-only connection, so it can stay in use; the copy and the
result JSON land in `--out`. **That copy holds your memories** — keep it
out of a repository and delete it when you are done.

- `--db <path>` source store, `--build <dir>` the package whose `dist/` and
  dependencies run the search, `--label <name>` names the copy and the
  result file. Compare two builds by running it once per build and diffing
  the JSONs.
- Three query sets: `tail` (past char 3000 of long entries), `head`
  (chars 100-900) and `short` (entries inside the model's window). Each is
  reported per mode with r1, r5 and MRR.
- Not part of `npm test`: it needs the real model and a real store.

## Re-running them

| Script | Second run |
|---|---|
| `export-md.mjs` | Byte-identical tree; the target must be new or empty, so remove a previous export yourself |
| `import-md.mjs` | Adds 0 records; `--update` finds no differences after the first pass |
| `backup-store.mjs` | **Adds another snapshot**, named by the minute; within the same minute it refuses rather than overwrite. Delete old snapshots yourself |
| `verify-install.mjs` | Overwrites its one copy (`<out>/verify.sqlite`) and reports the same result |
| `retrieval-check.mjs` | Overwrites its copy and its result file; the re-embed finds nothing to do the second time |

None of them writes to the source store: it is opened read-only, so servers can
keep running.

## Tests

The main test suite pins both scripts to the shipped schema
(`schema-pin.test.mjs`) and fails the moment a schema change requires
updating them, and covers the tree-format escaping round trip and the
structural-injection guard (`md-tree-format.test.mjs`) and the `--sync`
export with the `--update` reconcile (`md-sync.test.mjs`).
