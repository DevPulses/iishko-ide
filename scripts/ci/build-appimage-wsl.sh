#!/usr/bin/env bash
# FILE: scripts/ci/build-appimage-wsl.sh
# Purpose: Build the Linux AppImage inside WSL with the low-memory recipe
#   proven on this PC: turbo build at --concurrency 2 (the default
#   parallelism OOMs the 6 GB WSL2 VM), then the artifact script with
#   IISHKO_DESKTOP_SKIP_BUILD=1.
# Layer: CI helper (invoked from .gitea/workflows/release.yml on the Windows host)
#
# Usage: build-appimage-wsl.sh <wsl-repo-path> <out-release-dir-on-windows>
set -euo pipefail

SRC="${1:?usage: build-appimage-wsl.sh <wsl-repo-path> <win-out-dir>}"
OUT_WIN="${2:?usage: build-appimage-wsl.sh <wsl-repo-path> <win-out-dir>}"
MIRROR="${HOME}/iishko-release"

# WSL mounts /tmp as a small tmpfs (~3 GB); the desktop-artifact stage dir,
# the electron dist and the AppImage assembly need far more, so point temp
# files at the real filesystem unless the caller already chose a TMPDIR.
export TMPDIR="${TMPDIR:-${HOME}/.cache/iishko-tmp}"
mkdir -p "$TMPDIR"

mkdir -p "$MIRROR"
rsync -a --delete \
  --exclude="node_modules/" --exclude="dist/" --exclude="release/" \
  --exclude=".git/" --exclude="out/" --exclude="coverage/" --exclude="*.log" \
  --exclude=".turbo/" --exclude="data/" \
  "$SRC/" "$MIRROR/"

cd "$MIRROR"
bun install --frozen-lockfile

# Web + desktop + CLI bundles; concurrency 2 keeps the WSL2 VM inside its
# memory budget (see ~/.wslconfig limits on this host). tsdown's contracts
# dts build exceeds Node's default ~2 GB heap inside the 6 GB VM, so raise
# the per-process cap explicitly. Use the workspace-local turbo: a bare
# `bunx` can resolve to a Windows npm shim.
NODE_OPTIONS="--max-old-space-size=4096" \
  "$MIRROR/node_modules/.bin/turbo" run build --filter=@iishko/desktop --filter=@iishko/cli --concurrency 2

IISHKO_DESKTOP_SKIP_BUILD=1 node scripts/build-desktop-artifact.ts --platform linux --target AppImage

# Hand the AppImage and the Linux update manifest back to the Windows
# workspace so the release job can hash and upload them.
mkdir -p "$OUT_WIN"
cp -f release/*.AppImage "$OUT_WIN/" 2>/dev/null || true
cp -f release/iishko-linux.yml "$OUT_WIN/" 2>/dev/null || true
ls -la "$OUT_WIN"
