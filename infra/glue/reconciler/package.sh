#!/usr/bin/env bash
# Bundle the reconciler Lambda. Mirrors infra/glue/hydration/package.sh.
#
# Output: infra/glue/reconciler/dist/index.js

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

cd "$REPO_ROOT"

if [ ! -d node_modules ]; then
  echo "node_modules missing — running npm ci"
  npm ci
fi

rm -rf "$SCRIPT_DIR/dist"
mkdir -p "$SCRIPT_DIR/dist"

npx --no-install esbuild \
  "$SCRIPT_DIR/src/index.ts" \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=cjs \
  --minify \
  --outfile="$SCRIPT_DIR/dist/index.js"

echo "built $(du -h "$SCRIPT_DIR/dist/index.js" | cut -f1) → $SCRIPT_DIR/dist/index.js"
