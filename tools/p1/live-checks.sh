#!/usr/bin/env bash
# The P1 live checks (docs/verification/p1-agy-runtime.md), run from a terminal
# whose agy is signed in. Output lands in .sdlc/p1/ (gitignored) for reading.
#   tools/p1/live-checks.sh      checks 1, 2, 4, 5, 6: $0, load_policy and
#                                preflight_dispatch make no vendor call
#   tools/p1/live-checks.sh 16   usage across a --conversation resume: two
#                                short --print calls on the seat, no cash
set -u
cd "$(dirname "$0")/../.."
OUT=".sdlc/p1"; mkdir -p "$OUT"
export PATH="$HOME/.local/bin:$PATH"
T="--print-timeout 4m"

run() { # name, extra-args..., prompt
  local name=$1; shift
  echo "== check $name"
  agy -p "${@: -1}" --output-format stream-json "${@:1:$#-1}" $T > "$OUT/$name.jsonl" 2> "$OUT/$name.err"
  echo "   exit=$? lines=$(wc -l < "$OUT/$name.jsonl")"
  tail -c 400 "$OUT/$name.jsonl"; echo
}

P1='List every tool in your toolset whose name contains model-dispatch, model_dispatch, load_policy or execute_with_model. Print their exact names one per line under the heading TOOLS. Then call the load_policy tool (whatever its exact prefixed name is) with policy_name antigravity-flash38-plus-opus5 and print under RESULT the policy name and the model ids it returned. Do not run any shell command.'
P5='Call the preflight_dispatch tool (whatever its exact prefixed name is) with auth_mode vendor and policy_name antigravity-flash38-plus-opus5. Print the full JSON result it returns. Do not run any shell command.'

if [ "${1:-}" = "16" ]; then
  SLUG="gemini-3.8-flash-high"
  echo "== check 16a (first call)"
  agy -p 'Write about 300 words on any topic of your choice. Do not run any command, read any file or create any subagent.' \
    --output-format stream-json --model "$SLUG" $T > "$OUT/16a-first.jsonl" 2> "$OUT/16a-first.err"
  CONV=$(grep -o '"conversation_id":"[^"]*"' "$OUT/16a-first.jsonl" | head -1 | cut -d'"' -f4)
  if [ -z "$CONV" ]; then echo "   no conversation_id — see $OUT/16a-first.err"; exit 1; fi
  echo "== check 16b (resume of $CONV)"
  agy -p 'Reply with the single word ok.' --output-format stream-json --model "$SLUG" --conversation "$CONV" $T \
    > "$OUT/16b-resume.jsonl" 2> "$OUT/16b-resume.err"
  for f in 16a-first 16b-resume; do
    echo "   $f usage: $(grep '"event":"result"' "$OUT/$f.jsonl" | grep -o '"usage":{[^}]*}' | tail -1)"
  done
  echo; echo "Done. Tell Claude: 'p1 check 16 outputs are in .sdlc/p1'."
  exit 0
fi

run 1-mcp-route      --dangerously-skip-permissions "$P1"
run 2-with-sandbox   --dangerously-skip-permissions --sandbox "$P1"
run 4-slash-pass     --dangerously-skip-permissions "/pass"
run 4-slash-mmo-pass --dangerously-skip-permissions "/mmo:pass"
GEMINI_API_KEY="probe-value-123" run 5-var-expansion --dangerously-skip-permissions "$P5"
run 6-no-skip-perms  "$P1"

echo; echo "Done. Outputs in $OUT/. Tell Claude: 'p1 outputs are in .sdlc/p1'."
