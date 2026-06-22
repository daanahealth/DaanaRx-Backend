#!/usr/bin/env bash
# Deterministic pre-commit gate for DaanaRx-Backend.
# Runs: consolidated typecheck -> changed-service typecheck -> engine tests -> lint (if configured).
# The best-practices review is Claude-driven; run the `daana-precommit-backend` skill for the full gate.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
cd "$ROOT" || { echo "❌ Cannot cd to repo root ($ROOT)"; exit 1; }

if ! grep -q '"name": "daanarx-backend"' package.json 2>/dev/null; then
  echo "❌ This does not look like the DaanaRx-Backend repo (package.json name != daanarx-backend)."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "📦 node_modules missing — running npm install --include=dev..."
  npm install --include=dev || { echo "❌ npm install failed"; exit 1; }
fi

fail=0
section() { printf "\n\033[1m=== %s ===\033[0m\n" "$1"; }

section "1/4 Consolidated typecheck + build (tsc -p tsconfig.consolidated.json)"
if npm run build:consolidated; then echo "✅ consolidated typecheck clean"; else echo "❌ consolidated typecheck failed"; fail=1; fi

# Determine changed services from the staged diff (fall back to all if not a commit context).
CHANGED="$(git diff --cached --name-only 2>/dev/null)"
if [ -z "$CHANGED" ]; then CHANGED="$(git diff --name-only 2>/dev/null)"; fi
SERVICES="$(printf '%s\n' "$CHANGED" | grep -E '^(services/[^/]+|gateway)/' | sed -E 's#^(services/[^/]+|gateway)/.*#\1#' | sort -u)"

section "2/4 Per-service typecheck (tsc --noEmit for changed services)"
if [ -z "$SERVICES" ]; then
  echo "ℹ️  No changed service detected — skipping per-service typecheck."
else
  while IFS= read -r svc; do
    [ -z "$svc" ] && continue
    if [ -f "$ROOT/$svc/tsconfig.json" ]; then
      echo "→ $svc"
      ( cd "$ROOT/$svc" && npx --no-install tsc --noEmit ) \
        && echo "  ✅ $svc typecheck clean" \
        || { echo "  ❌ $svc typecheck failed"; fail=1; }
    fi
  done <<< "$SERVICES"
fi

section "3/4 Engine unit tests (inventory-core)"
if npm run test:engine; then echo "✅ engine tests passed"; else echo "❌ engine tests failed"; fail=1; fi

section "4/4 Lint"
if [ -f "$ROOT/.eslintrc.json" ] || [ -f "$ROOT/.eslintrc.js" ] || [ -f "$ROOT/eslint.config.js" ] || [ -f "$ROOT/eslint.config.mjs" ]; then
  if npx --no-install eslint . ; then echo "✅ lint clean"; else echo "❌ lint failed"; fail=1; fi
else
  echo "⚠️  No ESLint config found — relying on strict tsc as the type gate."
  echo "    Recommendation: add ESLint (@typescript-eslint) for a real lint gate."
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "❌ DaanaRx-Backend deterministic gate FAILED — commit should be blocked."
  exit 1
fi
echo "✅ DaanaRx-Backend deterministic gate passed."
echo "ℹ️  Run the 'daana-precommit-backend' skill for the best-practices + advisors gate before pushing."
exit 0
