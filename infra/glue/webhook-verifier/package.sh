#!/usr/bin/env bash
# Bundle the webhook-verifier Lambda into a single CJS file Terraform's
# archive_file can zip. Run from anywhere — paths are resolved from this
# script's location.
#
# Output: infra/glue/webhook-verifier/dist/index.js (+ index.js.map)
#
# Called by CI before `terraform plan` / `terraform apply`. Safe to run
# locally to test packaging without applying.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

cd "$REPO_ROOT"

# Ensure deps the bundler will pull in are installed. CI runs this fresh.
if [ ! -d node_modules ]; then
  echo "node_modules missing — running npm ci"
  npm ci
fi

rm -rf "$SCRIPT_DIR/dist"
mkdir -p "$SCRIPT_DIR/dist"

# Bundle as CJS for Lambda Node.js 22 runtime. AWS SDK v3 is NOT included
# in the runtime — bundle it. esbuild tree-shakes unused clients/commands.
# No source map: Lambda doesn't enable them by default, and the .map file
# would double the deploy-zip size. Re-add --sourcemap if you ever need to
# debug a stack trace against TS line numbers.
npx --no-install esbuild \
  "$SCRIPT_DIR/src/index.ts" \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=cjs \
  --minify \
  --outfile="$SCRIPT_DIR/dist/index.js"

echo "built $(du -h "$SCRIPT_DIR/dist/index.js" | cut -f1) → $SCRIPT_DIR/dist/index.js"
