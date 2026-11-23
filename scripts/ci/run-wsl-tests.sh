#!/usr/bin/env bash
# FILE: scripts/ci/run-wsl-tests.sh
# Purpose: Mirror the checkout into WSL and run the upstream test suite there.
#   The Windows checkout's node_modules contains Windows binaries, so tests
#   always run against a Linux-side mirror with its own bun install.
# Layer: CI helper (invoked from .gitea/workflows/ci.yml on the Windows host)
#
# Usage: run-wsl-tests.sh <repo-path-as-seen-from-wsl> [mirror-dir]
set -euo pipefail

SRC="${1:?usage: run-wsl-tests.sh <wsl-repo-path> [mirror-dir]}"
MIRROR="${2:-${HOME}/iishko-ci}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXCLUDE_FILE="$SCRIPT_DIR/wsl-test-exclusions.txt"

# Proven-baseline failures only, one repo-relative test-file glob per line,
# '#' comments allowed. Empty today; never a blanket package skip.
EXCLUDES=()
if [ -f "$EXCLUDE_FILE" ]; then
  while IFS= read -r line; do
    line="${line%%#*}"
    line="$(echo "$line" | xargs || true)"
    [ -n "$line" ] && EXCLUDES+=("$line")
  done < "$EXCLUDE_FILE"
fi

mkdir -p "$MIRROR"
rsync -a --delete \
  --exclude="node_modules/" --exclude="dist/" --exclude="release/" \
  --exclude=".git/" --exclude="out/" --exclude="coverage/" --exclude="*.log" \
  --exclude=".turbo/" --exclude="data/" \
  "$SRC/" "$MIRROR/"

cd "$MIRROR"
# Use bun + the workspace-local binaries: a bare `bunx` inside WSL can
# resolve to a Windows npm shim through interop PATH and break globs.
bun install --frozen-lockfile
TURBO="$MIRROR/node_modules/.bin/turbo"
VITEST="$MIRROR/node_modules/.bin/vitest"

# IISHKO_TARGETED=1 runs only the ИИШКО-owned blocking suites (the same list
# ci.yml's iishko-tests job documents) instead of the full turbo suite.
if [ "${IISHKO_TARGETED:-0}" = "1" ]; then
  bun run --cwd packages/shared test providerInstances outboundHttpPolicy
  bun run --cwd apps/server test iishko piSubagents piCustomProviders iishkoVoice wsProviderEndpointRpc serverSettings bundledPi providerTerminalProfiles bridge.test main.test
  bun run --cwd apps/web test theme.logic uiFontSize hasSelectorVariants wsNativeApi workLog useAccount navigation.test useChatKeyboardShortcuts
  bun run --cwd apps/web test:browser:install
  bun run --cwd apps/web test:browser ProvidersSettingsPanel
  exit $?
fi

if [ "${#EXCLUDES[@]}" -eq 0 ]; then
  # --continue reports every failing package in one run instead of turbo
  # aborting the remaining tasks at the first failure.
  exec "$TURBO" run test --continue
fi

# Non-empty exclusion list: run every package through turbo except the ones
# owning excluded files (directory --filter), then run those packages'
# vitest with an explicit file list minus the excluded files. Vitest's
# --exclude flag replaces its default ignore list, so it is not used.
echo "Baseline exclusions: ${EXCLUDES[*]}"
PKG_DIRS="$(printf '%s\n' "${EXCLUDES[@]}" | cut -d/ -f1-2 | sort -u)"
FILTERS=()
for dir in $PKG_DIRS; do
  FILTERS+=(--filter="!./$dir")
done
set +e
"$TURBO" run test --continue "${FILTERS[@]}"
TURBO_EXIT=$?
set -e

FAILED=0
for dir in $PKG_DIRS; do
  mapfile -t ALL_TESTS < <(cd "$dir" && find src -type f \( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.test.js' \) 2>/dev/null | sort)
  mapfile -t SKIP < <(printf '%s\n' "${EXCLUDES[@]}" | sed "s|^$dir/||" | grep -v '^$')
  RUN_FILES=()
  for f in "${ALL_TESTS[@]}"; do
    skip=0
    for s in "${SKIP[@]}"; do
      # Full-match glob: exclusion entries may use '*' but never substring-match.
      [[ $f == $s ]] && { skip=1; break; }
    done
    [ "$skip" -eq 0 ] && RUN_FILES+=("$f")
  done
  if [ "${#RUN_FILES[@]}" -gt 0 ]; then
    (cd "$dir" && "$VITEST" run "${RUN_FILES[@]}") || FAILED=1
  fi
done

# Surface every failure: turbo's non-zero exit and any package vitest run.
[ "$TURBO_EXIT" -ne 0 ] && FAILED=1
exit "$FAILED"
