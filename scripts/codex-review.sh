#!/usr/bin/env bash
# codex-review.sh — independent (cross-model) review of in-progress work via the Codex CLI.
#
# Claude implements; Codex (gpt-5.5, xhigh) reviews. A different model catches different
# bugs. Run this after every meaningful chunk; address findings before moving on.
#
#   scripts/codex-review.sh                  review working-tree changes (staged+unstaged+untracked)
#   scripts/codex-review.sh --base main      review the whole branch vs a base
#   scripts/codex-review.sh --commit <sha>   review the changes introduced by one commit
#
# Review priorities live in AGENTS.md (§ Code review) — Codex reads AGENTS.md as shared agent
# instructions, so the rubric is one source of truth both agents see (the `review` subcommand
# does not accept a custom prompt alongside a scope flag). Output is streamed and the clean
# final review is saved to .codex-review/<timestamp>.md.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

scope=("$@")
[ ${#scope[@]} -eq 0 ] && scope=(--uncommitted)

mkdir -p .codex-review
out=".codex-review/$(date +%Y%m%d-%H%M%S).md"

echo "codex-review: codex exec review ${scope[*]} -> ${out}" >&2
codex exec review "${scope[@]}" -o "$out"

echo >&2
echo "-------- review saved: ${out} --------" >&2
grep -iE 'verdict' "$out" >&2 || true
