#!/usr/bin/env bash
# pack.sh — build HEAD and pack it as <package version>-<8-char commit hash>.
#
# Mario's install scheme: every own build is installed side by side under that
# name, because a running server maps native binaries and an in-place install on
# Windows then fails. The version is set only in the packed copy, so nothing is
# committed for it; commit before packing, or the hash names the wrong code.
#
# Usage: scripts/keep/pack.sh [out-dir]   (default: E:/tmp/LLMs/local-memory-mcp/packs)
# Then:  npm install -g --prefix <builds>/<version> <out-dir>/<tarball>
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
out="${1:-/e/tmp/LLMs/local-memory-mcp/packs}"
cd "$repo"

if [ -n "$(git status --porcelain)" ]; then
	echo "working tree not clean: commit first, or the version names the wrong code" >&2
	exit 1
fi

base=$(node -p "require('./package.json').version")
version="$base-$(git rev-parse --short=8 HEAD)"
mkdir -p "$out"

# A clean dist: the build copies migrations but never removes old ones, and npm packs all of dist.
rm -rf dist
npm run build > /dev/null
# Restore package.json however this exits, so a failed pack cannot leave the
# version behind and make the next run refuse a "dirty" tree.
trap 'git -C "$repo" checkout -- package.json' EXIT
npm pkg set version="$version"
npm pack --pack-destination "$out" 2>&1 | tail -1

git status --short
ls -la "$out/studiomeyer-local-memory-mcp-$version.tgz"
