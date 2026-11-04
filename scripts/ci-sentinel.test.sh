#!/bin/sh
# Hermetic watcher tests: fake gh uses real jq to evaluate the script's queries.
# No GitHub calls or real launchctl commands, including the installer tests.
set -eu
finished=0
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
SENTINEL="$ROOT/scripts/ci-sentinel.sh"
command -v jq >/dev/null
command -v python3 >/dev/null
printf 'ci-sentinel shell tests on %s; ' "$(uname -s)"
jq --version
python3 --version
TMP=$(mktemp -d)
trap 'status=$?
if [ "$status" -eq 0 ] && [ "${finished:-0}" != 1 ]; then
    printf "%s\n" "$0: exited before successful completion" >&2
    status=1
fi
rm -rf "$TMP" || { cleanup_status=$?; [ "$status" -ne 0 ] || status=$cleanup_status; }
exit "$status"' EXIT
REAL_SLEEP=$(command -v sleep)
REAL_DATE=$(command -v date)
export REAL_SLEEP REAL_DATE
mkdir -p "$TMP/bin"
cat > "$TMP/bin/gh" <<'SH'
#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$FAKE_DIR/calls"
[ "$1" = run ] || exit 64
shift
ACTION=$1
shift
JOB=
RUN=
QUERY=
FIELDS=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --job) JOB=$2; shift 2 ;;
    --json) FIELDS=$2; shift 2 ;;
    -q) QUERY=$2; shift 2 ;;
    --limit) [ "$2" = 15 ]; shift 2 ;;
    --log-failed) shift ;;
    *) RUN=$1; shift ;;
  esac
done
if [ -n "$JOB" ]; then
  [ "$FAKE_SCENARIO" != log-unavailable ] || exit 1
  cat "$FAKE_DIR/log"
  exit 0
fi
if [ "$ACTION" = list ]; then
  if [ "$FAKE_SCENARIO" = query-timeout ]; then
    printf 'ready\n' > "$FAKE_DIR/query-ready"
    exec "$REAL_SLEEP" 999
  fi
  N=$(cat "$FAKE_DIR/list-count")
  N=$((N + 1))
  printf '%s\n' "$N" > "$FAKE_DIR/list-count"
  if [ "$FAKE_SCENARIO" = backoff ] && [ "$N" -le 3 ]; then
    printf 'HTTP 429: rate limited / network unavailable\n' >&2
    exit 1
  fi
  INPUT="$FAKE_DIR/runs"
elif [ "$FIELDS" = jobs ]; then
  [ "$FAKE_SCENARIO" != jobs-unavailable ] || exit 1
  INPUT="$FAKE_DIR/jobs"
  [ ! -f "$FAKE_DIR/jobs-$RUN" ] || INPUT="$FAKE_DIR/jobs-$RUN"
else
  [ "$RUN" = 101 ] || exit 64
  INPUT="$FAKE_DIR/run"
fi
[ -n "$QUERY" ] || exit 64
jq -r "$QUERY" "$INPUT"
SH
cat > "$TMP/bin/sleep" <<'SH'
#!/bin/sh
if [ "$FAKE_SCENARIO" = query-timeout ] && [ "$1" = 30 ]; then
  read -r READY < "$FAKE_DIR/query-ready"
  exit 0
fi
case "$1" in
  1|2|4)
    printf '%s\n' "$1" >> "$FAKE_DIR/sleeps"
    N=$(cat "$FAKE_DIR/ticks")
    printf '%s\n' "$((N + 1))" > "$FAKE_DIR/ticks"
    ;;
  *) exec "$REAL_SLEEP" "$@" ;;
esac
SH
cat > "$TMP/bin/date" <<'SH'
#!/bin/sh
if [ "$FAKE_SCENARIO" = backoff ] && [ "$1" = +%s ]; then
  N=$(cat "$FAKE_DIR/ticks")
  printf '%s\n' "$((1000 + N * 1000))"
else
  exec "$REAL_DATE" "$@"
fi
SH
chmod +x "$TMP/bin/gh" "$TMP/bin/sleep" "$TMP/bin/date"
PATH="$TMP/bin:$PATH"
export PATH
unset CI_SENTINEL_STATE_DIR
CI_SENTINEL_POLL_SECONDS=1
CI_SENTINEL_MAX_BACKOFF_SECONDS=4
export CI_SENTINEL_POLL_SECONDS CI_SENTINEL_MAX_BACKOFF_SECONDS
COUNT=0
CURRENT_TEST=
fail() { printf 'not ok - %s: %s\n' "$CURRENT_TEST" "$*" >&2; exit 1; }
contains() { grep -qF -- "$1" "$OUT" || fail "missing output: $1"; }
absent() { if grep -qF -- "$1" "$OUT"; then fail "unexpected output: $1"; fi; }
expect_rc() { [ "$RC" -eq "$1" ] || fail "expected exit $1, got $RC"; }
invoke() {
  [ "$#" -gt 0 ] || set -- --once
  RC=0
  /bin/sh "$SENTINEL" "$@" > "$OUT" 2> "$ERR" || RC=$?
}
snapshot() {
  cat > "$FAKE_DIR/run" <<'JSON'
{"databaseId":101,"workflowName":"CI checks","headBranch":"feature/sentinel","headSha":"0123456789abcdef","status":"in_progress","conclusion":"","createdAt":"2026-10-14T10:00:00Z","attempt":1}
JSON
  jq -s . "$FAKE_DIR/run" > "$FAKE_DIR/runs"
  cat > "$FAKE_DIR/jobs" <<'JSON'
{"jobs":[{"databaseId":1001,"name":"unit tests","conclusion":"failure"},{"databaseId":1002,"name":"long host tests","conclusion":""}]}
JSON
}
finish_run_fixture() {
  jq '.status = "completed" | .conclusion = "failure"' "$FAKE_DIR/run" > "$FAKE_DIR/new"
  mv "$FAKE_DIR/new" "$FAKE_DIR/run"
  jq -s . "$FAKE_DIR/run" > "$FAKE_DIR/runs"
}
reset() {
  FAKE_DIR="$TMP/case-$COUNT"
  HOME="$FAKE_DIR/home space&value"
  FAKE_SCENARIO=normal
  export FAKE_DIR HOME FAKE_SCENARIO
  mkdir -p "$HOME"
  STATE="$HOME/.local/share/cortexkit/magic-context/ci-sentinel"
  OUT="$FAKE_DIR/out"
  ERR="$FAKE_DIR/err"
  printf '0\n' > "$FAKE_DIR/list-count"
  printf '0\n' > "$FAKE_DIR/ticks"
  : > "$FAKE_DIR/calls"
  : > "$FAKE_DIR/sleeps"
  printf 'setup noise\nFAIL tests/unit.test.ts > meaningful test\nAssertionError: expected 4, received 5\n' > "$FAKE_DIR/log"
  snapshot
}
run_test() {
  if [ -n "${CI_SENTINEL_TEST_FILTER:-}" ] && [ "$CI_SENTINEL_TEST_FILTER" != "$1" ]; then return; fi
  CURRENT_TEST=$1
  COUNT=$((COUNT + 1))
  reset
  "$2"
  printf 'ok - %s\n' "$CURRENT_TEST"
}

mid_run() {
  invoke
  expect_rc 1
  [ "$(head -n1 "$OUT")" = 'CI FAILURE DETECTED:' ] || fail 'missing legacy header'
  contains '101 CI checks feature/sentinel 2026-10-14T10:00:00Z'
  contains 'status: in_progress'
  contains 'head: 0123456789abcdef branch: feature/sentinel'
  contains 'job: unit tests (failure, id: 1001)'
  contains 'log: FAIL tests/unit.test.ts > meaningful test'
  absent 'long host tests'
  absent 'setup noise'
  invoke
  expect_rc 0
  [ ! -s "$OUT" ] || fail 'duplicate job report'
  [ "$(grep -c 'run view --job 1001 --log-failed' "$FAKE_DIR/calls")" -eq 1 ] || fail 'duplicate log fetch'
}
cancelled() {
  printf '{"jobs":[{"databaseId":1003,"name":"cancelled matrix job","conclusion":"cancelled"}]}\n' > "$FAKE_DIR/jobs"
  invoke
  expect_rc 1
  contains 'job: cancelled matrix job (cancelled, id: 1003)'
  contains 'status: in_progress'
  invoke
  expect_rc 0
  [ ! -s "$OUT" ] || fail 'duplicate cancelled job'
}
add_newer_sibling() {
  jq '.status = "completed" | .conclusion = "cancelled"' "$FAKE_DIR/run" > "$FAKE_DIR/old"
  jq '.databaseId = 102 | .createdAt = "2026-10-14T10:01:00Z" | .status = "in_progress" | .conclusion = ""' "$FAKE_DIR/run" > "$FAKE_DIR/new"
  jq -s . "$FAKE_DIR/old" "$FAKE_DIR/new" > "$FAKE_DIR/runs"
  printf '{"jobs":[]}\n' > "$FAKE_DIR/jobs-102"
}
superseded_cancelled_run() {
  add_newer_sibling
  printf '{"jobs":[{"databaseId":1003,"name":"cancelled matrix job","conclusion":"cancelled"}]}\n' > "$FAKE_DIR/jobs"
  invoke
  expect_rc 0
  [ ! -s "$OUT" ] || fail 'superseded cancellation was reported'
}
newest_cancelled_run() {
  jq '.status = "completed" | .conclusion = "cancelled"' "$FAKE_DIR/run" > "$FAKE_DIR/new"
  mv "$FAKE_DIR/new" "$FAKE_DIR/run"
  jq -s . "$FAKE_DIR/run" > "$FAKE_DIR/runs"
  printf '{"jobs":[{"databaseId":1003,"name":"cancelled matrix job","conclusion":"cancelled"}]}\n' > "$FAKE_DIR/jobs"
  invoke
  expect_rc 1
  contains 'job: cancelled matrix job (cancelled, id: 1003)'
  contains 'conclusion: cancelled'
}
failed_job() {
  printf '{"jobs":[{"databaseId":1004,"name":"unit tests","conclusion":"failure"}]}\n' > "$FAKE_DIR/jobs"
  invoke
  expect_rc 1
  contains 'job: unit tests (failure, id: 1004)'
}
superseded_gate() {
  add_newer_sibling
  printf '{"jobs":[{"databaseId":1005,"name":"CI (required)","conclusion":"failure"},{"databaseId":1006,"name":"unit tests","conclusion":"cancelled"}]}\n' > "$FAKE_DIR/jobs"
  invoke
  expect_rc 0
  [ ! -s "$OUT" ] || fail 'superseded gate or cancellation was reported'
}
multiple_jobs() {
  printf '{"jobs":[{"databaseId":1001,"name":"one","conclusion":"failure"},{"databaseId":1003,"name":"two","conclusion":"cancelled"},{"databaseId":1005,"name":"three","conclusion":"failure"}]}\n' > "$FAKE_DIR/jobs"
  invoke
  expect_rc 1
  [ "$(grep -c '^  job:' "$OUT")" -eq 3 ] || fail 'not all failed jobs were reported'
  invoke
  expect_rc 0
  [ ! -s "$OUT" ] || fail 'duplicate batch of jobs'
}
completion() {
  invoke
  expect_rc 1
  finish_run_fixture
  invoke
  expect_rc 1
  contains 'CI FAILURE DETECTED:'
  contains '101 CI checks feature/sentinel 2026-10-14T10:00:00Z'
  contains 'status: completed conclusion: failure'
  absent '  job:'
  invoke
  expect_rc 0
  [ ! -s "$OUT" ] || fail 'duplicate completion report'
}
success() {
  finish_run_fixture
  jq '.[0].conclusion = "success"' "$FAKE_DIR/runs" > "$FAKE_DIR/new"
  mv "$FAKE_DIR/new" "$FAKE_DIR/runs"
  printf '{"jobs":[{"databaseId":1001,"name":"unit tests","conclusion":"success"}]}\n' > "$FAKE_DIR/jobs"
  invoke
  expect_rc 0
  [ ! -s "$OUT" ] || fail 'success emitted failure output'
}
job_in_successful_run() {
  finish_run_fixture
  jq '.[0].conclusion = "success"' "$FAKE_DIR/runs" > "$FAKE_DIR/new"
  mv "$FAKE_DIR/new" "$FAKE_DIR/runs"
  invoke
  expect_rc 1
  contains 'job: unit tests (failure, id: 1001)'
  contains 'status: completed conclusion: success'
  [ "$(grep -c '^101 CI checks' "$OUT")" -eq 1 ] || fail 'success emitted a run completion alert'
  invoke
  expect_rc 0
}
restart() {
  finish_run_fixture
  invoke
  expect_rc 1
  contains 'job: unit tests'
  contains 'status: completed'
  BEFORE=$(cksum "$STATE/seen")
  # invoke starts a new process with the same HOME, not an in-memory cache.
  invoke
  expect_rc 0
  [ ! -s "$OUT" ] || fail 'persisted reports repeated after restart'
  [ "$BEFORE" = "$(cksum "$STATE/seen")" ] || fail 'duplicate state entries'
}
rollover() {
  printf '{"jobs":[]}\n' > "$FAKE_DIR/jobs"
  invoke
  expect_rc 0
  grep -qx 101 "$STATE/active" || fail 'active run not persisted'
  printf '[]\n' > "$FAKE_DIR/runs"
  printf '{"jobs":[{"databaseId":1001,"name":"late failure","conclusion":"failure"}]}\n' > "$FAKE_DIR/jobs"
  invoke
  expect_rc 1
  contains 'job: late failure'
  grep -q 'run view 101 --json databaseId' "$FAKE_DIR/calls" || fail 'displaced run not refreshed'
}
attempt() {
  finish_run_fixture
  invoke
  expect_rc 1
  jq '.[0].attempt = 2' "$FAKE_DIR/runs" > "$FAKE_DIR/new"
  mv "$FAKE_DIR/new" "$FAKE_DIR/runs"
  printf '{"jobs":[{"databaseId":1004,"name":"rerun tests","conclusion":"failure"}]}\n' > "$FAKE_DIR/jobs"
  invoke
  expect_rc 1
  contains 'attempt: 2'
  contains 'job: rerun tests (failure, id: 1004)'
}
exact_keys() {
  printf '{"jobs":[{"databaseId":123,"name":"first","conclusion":"failure"}]}\n' > "$FAKE_DIR/jobs"
  invoke
  expect_rc 1
  printf '{"jobs":[{"databaseId":12,"name":"second","conclusion":"failure"}]}\n' > "$FAKE_DIR/jobs"
  invoke
  expect_rc 1
  contains 'job: second (failure, id: 12)'
}
bounded_log() {
  awk 'BEGIN {for (i=1;i<=100;i++) {printf "FAIL line %d ", i; for (j=0;j<600;j++) printf "x"; print ""}}' > "$FAKE_DIR/log"
  invoke
  expect_rc 1
  [ "$(grep -c '^  log:' "$OUT")" -eq 20 ] || fail 'log line bound incorrect'
  BYTES=$(awk '/^  log:/ {n+=length($0)+1} END {print n+0}' "$OUT")
  [ "$BYTES" -le 8192 ] || fail 'log byte bound exceeded'
  contains 'log: FAIL line 1 '
  absent 'log: FAIL line 21 '
}
unavailable_log() {
  FAKE_SCENARIO=log-unavailable
  invoke
  expect_rc 1
  contains 'job: unit tests'
  absent '  log:'
}
backoff() {
  FAKE_SCENARIO=backoff
  printf '[]\n' > "$FAKE_DIR/runs"
  invoke 1
  expect_rc 0
  absent 'CI FAILURE DETECTED:'
  [ "$(cat "$FAKE_DIR/list-count")" -eq 4 ] || fail 'unexpected query count'
  printf '2\n4\n4\n1\n' > "$FAKE_DIR/expected-sleeps"
  cmp "$FAKE_DIR/expected-sleeps" "$FAKE_DIR/sleeps" || fail 'backoff did not grow, cap, and reset'
  [ "$(grep -c 'gh query failed' "$ERR")" -eq 1 ] || fail 'query errors spammed diagnostics'
  [ ! -s "$STATE/seen" ] || fail 'API failure marked as seen'
}
query_timeout() {
  FAKE_SCENARIO=query-timeout
  # Release the fake deadline only once gh has started, without wall sleeps.
  mkfifo "$FAKE_DIR/query-ready"
  invoke
  expect_rc 2
  [ ! -s "$OUT" ] || fail 'timed-out query produced an alert'
  [ "$(wc -l < "$ERR" | tr -d ' ')" -eq 1 ] || fail 'timeout spammed diagnostics'
  [ ! -s "$STATE/seen" ] || fail 'timeout marked as seen'
}
jobs_retry() {
  finish_run_fixture
  FAKE_SCENARIO=jobs-unavailable
  invoke
  expect_rc 1
  contains 'status: completed'
  absent '  job:'
  grep -qx 101 "$STATE/active" || fail 'unavailable completed jobs not retained'
  FAKE_SCENARIO=normal
  printf '[]\n' > "$FAKE_DIR/runs"
  invoke
  expect_rc 1
  contains 'job: unit tests'
  [ "$(grep -c '^101 CI checks' "$OUT")" -eq 1 ] || fail 'duplicate run completion'
  [ ! -s "$STATE/active" ] || fail 'completed run not retired'
}
permissions() {
  invoke
  expect_rc 1
  for FILE in seen active reports.log errors.log; do
    MODE=$(python3 -c 'import os,stat,sys; print(oct(stat.S_IMODE(os.stat(sys.argv[1]).st_mode))[2:])' "$STATE/$FILE")
    [ "$MODE" = 600 ] || fail "$FILE permissions are $MODE"
  done
  MODE=$(python3 -c 'import os,stat,sys; print(oct(stat.S_IMODE(os.stat(sys.argv[1]).st_mode))[2:])' "$STATE")
  [ "$MODE" = 700 ] || fail "state directory permissions are $MODE"
}
expiry() {
  invoke 0
  expect_rc 0
  contains 'clean window elapsed (0h) — re-arm the sentinel'
  [ ! -s "$FAKE_DIR/calls" ] || fail 'zero-hour window queried gh'
}
installation() {
  # These shims are installed only for this case, in a disposable HOME.
  cat > "$TMP/bin/uname" <<'SH'
#!/bin/sh
printf 'Darwin\n'
SH
  cat > "$TMP/bin/launchctl" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_DIR/launchctl-calls"
SH
  chmod +x "$TMP/bin/uname" "$TMP/bin/launchctl"
  invoke --install
  expect_rc 0
  PLIST="$HOME/Library/LaunchAgents/com.cortexkit.mc-ci-sentinel.plist"
  python3 - "$PLIST" "$SENTINEL" "$ROOT" "$STATE" <<'PY' || fail 'invalid launch agent'
import os, plistlib, stat, sys
path, script, root, state = sys.argv[1:]
with open(path, 'rb') as f:
    p = plistlib.load(f)
assert p['Label'] == 'com.cortexkit.mc-ci-sentinel'
assert p['ProgramArguments'] == ['/bin/sh', script]
assert p['WorkingDirectory'] == root
assert p['RunAtLoad'] and p['KeepAlive'] and p['ThrottleInterval'] == 45
assert p['StandardOutPath'] == state + '/reports.log'
assert p['StandardErrorPath'] == state + '/errors.log'
assert p['EnvironmentVariables']['CI_SENTINEL_STATE_DIR'] == state
assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
PY
  invoke --install
  expect_rc 0
  [ "$(grep -c '^bootstrap ' "$FAKE_DIR/launchctl-calls")" -eq 2 ] || fail 'install not repeatable'
  invoke --uninstall
  expect_rc 0
  [ ! -e "$PLIST" ] || fail 'uninstall retained plist'
  [ -f "$STATE/seen" ] && [ -f "$STATE/reports.log" ] || fail 'uninstall deleted state/logs'
  invoke --uninstall
  expect_rc 0
  rm -f "$TMP/bin/uname" "$TMP/bin/launchctl"
}

run_test 'mid-run failed job is reported once' mid_run
run_test 'cancelled job is reported once' cancelled
run_test 'superseded cancelled run is silent' superseded_cancelled_run
run_test 'newest cancelled run is reported' newest_cancelled_run
run_test 'failed job is still reported' failed_job
run_test 'gate in superseded run is silent' superseded_gate
run_test 'all failed jobs in a poll are reported once' multiple_jobs
run_test 'run completion is a separate report' completion
run_test 'successful run completion is silent' success
run_test 'failed job in a successful run is still reported' job_in_successful_run
run_test 'restart with persisted state has no duplicate report' restart
run_test 'active run survives discovery-window rollover' rollover
run_test 'rerun attempt has separate deduplication' attempt
run_test 'dedup keys match exact IDs' exact_keys
run_test 'first failing log lines are bounded' bounded_log
run_test 'unavailable log does not suppress detection' unavailable_log
run_test 'failing gh backs off without spam' backoff
run_test 'hung gh is bounded without spurious alerts' query_timeout
run_test 'failed job query is retried after run completion' jobs_retry
run_test 'state and logs are owner-only' permissions
run_test 'clean-window output contract is preserved' expiry
run_test 'launchd install and uninstall are repeatable with mocks' installation
[ "$COUNT" -gt 0 ] || fail 'no tests selected'
printf 'Passed %s ci-sentinel tests\n' "$COUNT"
finished=1
