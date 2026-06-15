#!/usr/bin/env bash
# Boot a throwaway `see` server with fresh storage + DB, seed it with the eval bundle
# fixture, and print the JSON the eval needs (base URL, share id, edit password).
#
# Usage:  evals/llms-txt/boot.sh [PORT]
# Leaves the server running in the foreground. Ctrl-C to stop (temp dir is auto-removed).
set -euo pipefail

PORT="${1:-4787}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURE="$ROOT/evals/llms-txt/fixture"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/uploads"
export PORT
export DATABASE_URL="sqlite:$TMP/app.db"
export STORAGE_DIR="$TMP/uploads"
export PUBLIC_BASE_URL="http://localhost:$PORT"

# Start the server in the background, wait for it to answer.
( cd "$ROOT" && bun src/server.ts ) >"$TMP/server.log" 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null; rm -rf "$TMP"' EXIT

for _ in $(seq 1 50); do
  if curl -fsS "http://localhost:$PORT/llms.txt" >/dev/null 2>&1; then break; fi
  sleep 0.2
done

# Seed: upload the fixture as a bundle (filename carries the resource path).
SEED="$(curl -fsS -X POST "http://localhost:$PORT/api/uploads" \
  -F "file=@$FIXTURE/index.html;filename=index.html" \
  -F "file=@$FIXTURE/pricing.html;filename=pricing.html" \
  -F "file=@$FIXTURE/theme.css;filename=theme.css" \
  -F "file=@$FIXTURE/see.json;filename=see.json" \
  -F "editToken=evalpw")"

ID="$(printf '%s' "$SEED" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)"

echo "{\"baseUrl\":\"http://localhost:$PORT\",\"id\":\"$ID\",\"password\":\"evalpw\"}"
echo "--- server ready (pid $SERVER_PID); fixture seeded as bundle '$ID'. Ctrl-C to stop. ---" >&2
wait "$SERVER_PID"
