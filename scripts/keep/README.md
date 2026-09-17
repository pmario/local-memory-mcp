# scripts/keep: the side-by-side install workflow

Three scripts for running **own builds** of this server on Windows, next to each
other rather than over each other. They are bound to that setup (paths, the
Claude Code config file, PowerShell), which is why they live here and not in
`scripts/dev-tools`.

Why side by side: a running server maps the native binaries of its install
(better-sqlite3, onnxruntime, sqlite-vec, sharp), so an in-place `npm install -g`
fails or leaves a mixed package. A new folder per build has nothing locked,
other conversations keep their build until they restart, and switching back is
one config change.

## One-off: share the model cache

Transformers.js caches the embedding model inside the package tree, so every
side-by-side install downloads the same 129 MB again. Point the server at one
shared folder instead, once:

```
powershell -ExecutionPolicy Bypass -File scripts/keep/set-model-cache-env.ps1
```

It adds `MEMORY_EMBED_CACHE_DIR` to the `memory` entry in `~/.claude.json`
(default `%LOCALAPPDATA%\local-memory-mcp-model-cache`) and is a no-op when the
variable is already there. Seed that folder by copying an existing
`node_modules/@huggingface/transformers/.cache`, or let the next boot download
once. The variable takes effect when a conversation restarts; afterwards the
in-tree caches of the installed builds can be deleted.

## The loop

```bash
# 1. Commit, then pack HEAD as <version>-<8-char hash>
scripts/keep/pack.sh [out-dir]

# 2. Install that tarball side by side
npm install -g --prefix "$LOCALAPPDATA/local-memory-mcp-builds/2.4.3-<hash>" <out-dir>/studiomeyer-local-memory-mcp-2.4.3-<hash>.tgz

# 3. Check it before switching anything (waits for a background re-embed)
node scripts/dev-tools/verify-install.mjs "$LOCALAPPDATA/local-memory-mcp-builds/2.4.3-<hash>/node_modules/@studiomeyer/local-memory-mcp/dist/server.js" --wait

# 4. Point the client at it, then restart every conversation
powershell -ExecutionPolicy Bypass -File scripts/keep/switch-memory-build.ps1 -From 2.4.3-<old> -To 2.4.3-<hash>
```

Before deleting an old build, check that nothing still runs it:

```
powershell -ExecutionPolicy Bypass -File scripts/keep/probe-locks.ps1
```

It lists mapped binaries and every running server with its build, so a folder is
only removed once it appears in neither.

## Notes

- `pack.sh` refuses a dirty tree: the version names a commit, so the commit must
  exist first. It sets the version only in the packed copy and restores
  `package.json` from an `EXIT` trap, so even a failed pack leaves nothing behind.
- It removes `dist` before building, because the build copies migrations in but
  never removes ones that a branch has renamed, and `npm pack` would ship both.
- `switch-memory-build.ps1` edits `~/.claude.json` as text after asserting the
  old version string occurs exactly once, and writes a timestamped backup first.
- A backup of the store belongs before step 4:
  `node scripts/dev-tools/backup-store.mjs --wait`.

## Re-running them

| Script | Second run |
|---|---|
| `pack.sh` | Same tarball name, rebuilt and overwritten; `dist` is cleaned first |
| `switch-memory-build.ps1` | Reports "already pointing at …" and changes nothing |
| `set-model-cache-env.ps1` | Reports the variable is already set and changes nothing |
| `probe-locks.ps1` | Read-only; it only opens files for write access to see whether that fails |
