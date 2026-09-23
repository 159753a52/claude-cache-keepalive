#!/usr/bin/env bash
# Unit tests for cache-keepalive.js with short intervals and a scratch state dir.
# Native paths for node on Windows (Git Bash); unchanged elsewhere.
winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf "%s" "$1"; fi; }
S="$(winpath "$(cd "$(dirname "$0")/.." && pwd)/cache-keepalive.js")"
D="$(mktemp -d)"
export CCKA_STATE_DIR="$(winpath "$D")" CCKA_INTERVAL=3 CCKA_SETTLE=1 CCKA_CHECK=1 CCKA_MAX_LOOPS=3
unset CLAUDE_PID ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY
# Desktop sessions inherit a relay token from settings but talk to the official API.
export CLAUDE_CODE_ENTRYPOINT=claude-desktop ANTHROPIC_AUTH_TOKEN=leaked ANTHROPIC_BASE_URL=https://api.anthropic.com
T="$D/transcript.jsonl"
fixture() { # $1 = cache TTL (1h|5m), $2 = prompt tokens
  local w1=0 w5=0; [ "$1" = 1h ] && w1=1000 || w5=1000
  printf '{"type":"assistant","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":%d,"cache_creation_input_tokens":1000,"cache_creation":{"ephemeral_1h_input_tokens":%d,"ephemeral_5m_input_tokens":%d}}}}\n' $(( $2 - 1010 )) $w1 $w5 > "$T"
}
fixture 1h 200000
SID=test-session-0001
IN() { printf '{"session_id":"%s","transcript_path":"%s","background_tasks":[],"session_crons":[]%s}' "$SID" "$(winpath "$T")" "$1"; }
st() { [ -f "$D/$SID.json" ] && node -e 'const o=require(process.argv[1]);console.log(o.count+","+o.pinged)' "$(winpath "$D/$SID.json")" || echo "<none>"; }
logged() { grep -c "$1" "$D/keepalive.log"; }
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1: expected [$3] got [$2]"; fail=$((fail+1)); fi; }

IN "" | CLAUDE_CODE_ENTRYPOINT=cli ANTHROPIC_BASE_URL=https://relay.example.com node "$S" stop; check "T1a relay CLI skipped" "$?|$(st)" "0|<none>"
IN "" | CLAUDE_CODE_ENTRYPOINT=sdk-cli node "$S" stop; check "T1b headless -p skipped" "$?|$(st)" "0|<none>"
IN "" | env -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL CLAUDE_CODE_ENTRYPOINT=cli ANTHROPIC_API_KEY=x node "$S" stop; check "T1c API-key CLI skipped" "$?|$(st)" "0|<none>"

err=$(IN "" | node "$S" stop 2>&1 >/dev/null); rc=$?
check "T2 desktop ping exits 2" "$rc" "2"
check "T2 ping message on stderr" "$(echo "$err" | grep -c 'cache keepalive')" "1"
check "T2 state after ping" "$(st)" "1,true"

IN "" | node "$S" stop 2>/dev/null; check "T3 follow-up ping counts on" "$?|$(st)" "2|2,true"
IN "" | node "$S" stop 2>/dev/null; check "T4a third ping" "$?|$(st)" "2|3,true"
t0=$(date +%s); IN "" | node "$S" stop 2>/dev/null; rc=$?; dt=$(( $(date +%s) - t0 ))
check "T4b max loops stops immediately" "$rc|$(st)|$([ $dt -le 1 ] && echo fast)" "0|3,false|fast"

IN "" | node "$S" prompt; check "T5 prompt resets counter" "$?|$(st)" "0|0,false"

CCKA_INTERVAL=6 node "$S" stop < <(IN "") 2>"$D/t6.err" & bg=$!
sleep 2.5; IN "" | node "$S" prompt; wait $bg; rc=$?
check "T6 newer prompt supersedes sleeper" "$rc|$(wc -c < "$D/t6.err" | tr -d ' ')|$(logged superseded)" "0|0|1"

CCKA_INTERVAL=4 node "$S" stop < <(IN "") 2>/dev/null & bg=$!
sleep 2.5; echo '{"type":"user","message":{"content":"hi"}}' >> "$T"; wait $bg; rc=$?
check "T7 conversation activity cancels ping" "$rc|$(logged 'moved on')" "0|1"

CCKA_INTERVAL=4 node "$S" stop < <(IN "") 2>/dev/null & bg=$!
sleep 2.5; echo '{"type":"custom-title","title":"x"}' >> "$T"; wait $bg; rc=$?
check "T8 metadata-only write still pings" "$rc" "2"

IN ',"background_tasks":[{"id":"x"}]' | node "$S" stop; check "T9 background tasks skip" "$?|$(logged 'background work')" "0|1"

IN "" | node "$S" end; check "T10 session end removes state" "$?|$(st)" "0|<none>"

echo '{"count":2,"gen":"x","pinged":false}' > "$D/$SID.json"
IN "" | node "$S" stop 2>/dev/null; check "T11 real turn restarts count" "$?|$(st)" "2|1,true"

touch "$D/DISABLED"; t0=$(date +%s); IN "" | node "$S" stop; rc=$?; dt=$(( $(date +%s) - t0 )); rm -f "$D/DISABLED"
check "T12 DISABLED pauses" "$rc|$([ $dt -le 1 ] && echo fast)" "0|fast"

IN "" | CLAUDE_PID=999999 node "$S" stop 2>/dev/null; check "T13 exits when Claude is gone" "$?|$(logged 'process gone')" "0|1"

echo "garbage" | node "$S" stop; check "T14 bad stdin is harmless" "$?" "0"

fixture 5m 200000; IN "" | CCKA_INTERVAL=3000 node "$S" stop; check "T15 5-minute TTL skipped" "$?|$(logged 'TTL is 5m')" "0|1"
fixture 1h 20000; IN "" | node "$S" stop; check "T16 small context skipped" "$?|$(logged 'not worth')" "0|1"

fixture 1h 200000; rm -f "$D/$SID.json"
IN "" | env -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL CLAUDE_CODE_ENTRYPOINT=cli node "$S" stop 2>/dev/null
check "T17 subscription CLI pings" "$?|$(st)" "2|1,true"

echo "== $pass passed, $fail failed"; echo "== log"; cat "$D/keepalive.log"; rm -rf "$D"
