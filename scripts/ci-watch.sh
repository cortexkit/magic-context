#!/usr/bin/env bash
# ci-watch.sh — fail-fast CI watcher.
#
# Polls a GitHub Actions run and STOPS THE MOMENT any job fails, printing that
# job's failing-step error log immediately instead of waiting for the whole
# pipeline. Classifies the failure as TRANSIENT (retryable infra: bun/npm
# download, tarball extract, network reset, registry 5xx, runner lost) vs REAL
# (test/build/lint failure) so you know whether to re-run or to fix code.
#
# Why this exists: `gh run watch` waits for the entire run and, piped through
# tail, swallows the real exit code — so a failure can look green. This watcher
# returns as soon as the verdict is known.
#
# Usage:
#   scripts/ci-watch.sh                 # newest run on the current branch HEAD
#   scripts/ci-watch.sh <run-id>        # a specific run
#   scripts/ci-watch.sh --sha <sha>     # newest run for a commit sha
#
# Env:
#   GH_BIN     gh binary to use (default: gh). Set to your auth wrapper if needed.
#   REPO       owner/repo (default: parsed from the `origin` remote).
#   POLL_SECS  poll interval seconds (default: 15).
#
# Exit codes:
#   0  every job succeeded (or was skipped)
#   1  a job FAILED for a REAL reason (code: test/build/lint) — fix it
#   2  a job FAILED for a TRANSIENT reason — safe to re-run (`gh run rerun --failed <id>`)
#   3  usage / setup error (no run found, gh missing, etc.)

set -uo pipefail

GH_BIN="${GH_BIN:-gh}"
POLL_SECS="${POLL_SECS:-15}"

die() { echo "ci-watch: $*" >&2; exit 3; }
command -v "$GH_BIN" >/dev/null 2>&1 || die "gh binary '$GH_BIN' not found (set GH_BIN)"

# Resolve repo (owner/repo) from REPO env or the origin remote.
if [[ -z "${REPO:-}" ]]; then
    origin_url="$(git remote get-url origin 2>/dev/null || true)"
    # Two plain substitutions: a lazy `+?` is not POSIX, and BSD sed refuses it.
    REPO="$(printf '%s' "$origin_url" | sed -E 's#^.*github\.com[/:]##; s#\.git$##')"
fi
[[ -n "${REPO:-}" && "$REPO" == */* ]] || die "could not resolve owner/repo (set REPO=owner/repo)"

gh_json() { "$GH_BIN" "$@" -R "$REPO" 2>/dev/null; }

# ── Resolve the run id ───────────────────────────────────────────────────────
RUN_ID=""
if [[ "${1:-}" == "--sha" ]]; then
    [[ -n "${2:-}" ]] || die "--sha needs a commit sha"
    RUN_ID="$(gh_json run list --commit "$2" --workflow CI --limit 1 --json databaseId \
        | python3 -c 'import sys,json;r=json.load(sys.stdin);print(r[0]["databaseId"] if r else "")')"
elif [[ -n "${1:-}" ]]; then
    RUN_ID="$1"
else
    sha="$(git rev-parse HEAD)"
    # Retry briefly: the run may not be registered the instant after a push.
    for _ in 1 2 3 4 5 6; do
        RUN_ID="$(gh_json run list --commit "$sha" --workflow CI --limit 1 --json databaseId \
            | python3 -c 'import sys,json;r=json.load(sys.stdin);print(r[0]["databaseId"] if r else "")')"
        [[ -n "$RUN_ID" ]] && break
        sleep 5
    done
fi
[[ -n "$RUN_ID" ]] || die "no CI run found (push first, or pass a run id)"

echo "ci-watch: watching run $RUN_ID on $REPO (poll ${POLL_SECS}s, fail-fast)"

# Transient/infra failure signatures — a FAILED job whose log matches any of
# these is retryable, not a code defect.
TRANSIENT_RE='Fail extracting tarball|failed to download|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|503 Service|502 Bad Gateway|429 Too Many|TLS connection|SSL_ERROR|network error|The runner has received a shutdown|lost communication|Received request to deprovision|Could not resolve host|Temporary failure in name resolution|registry\.npmjs\.org.*(reset|timeout)'

# Pull the failing-step log for one job and print a focused error tail.
dump_job_failure() {
    local job_name="$1"
    local log
    log="$("$GH_BIN" run view "$RUN_ID" -R "$REPO" --log-failed 2>/dev/null \
        | grep -F "$job_name	" | tail -60)"
    echo "──────── failing job: $job_name ────────"
    if [[ -n "$log" ]]; then
        printf '%s\n' "$log" | sed -E 's/^[^	]*	[^	]*	[0-9T:.Z-]+ ?//' | tail -40
    else
        echo "(no --log-failed output yet; check the run page)"
    fi
    echo "─────────────────────────────────────────"
    printf '%s' "$log"   # return for classification
}

while true; do
    state="$(gh_json run view "$RUN_ID" --json status,conclusion,jobs)"
    [[ -n "$state" ]] || { echo "ci-watch: transient API read miss, retrying"; sleep "$POLL_SECS"; continue; }

    # First failed job (if any), the overall status, and the in-progress count.
    # Three separate lines so a job name containing spaces (e.g. "Check (plugin)")
    # survives intact — a whitespace split would shred it.
    parsed="$(printf '%s' "$state" | python3 -c '
import sys,json
d=json.load(sys.stdin)
failed=""
inprog=0
for j in d.get("jobs",[]):
    c=j.get("conclusion"); s=j.get("status")
    if c=="failure" and not failed:
        failed=j["name"]
    if s in ("in_progress","queued","waiting","pending"):
        inprog+=1
print(d.get("status","") or "-")
print(failed or "-")
print(inprog)
' )"
    run_status="$(sed -n 1p <<<"$parsed")"
    failed_job="$(sed -n 2p <<<"$parsed")"
    inprogress="$(sed -n 3p <<<"$parsed")"

    if [[ "$failed_job" != "-" ]]; then
        echo ""
        echo "ci-watch: ✗ FAIL detected — $failed_job"
        joblog="$(dump_job_failure "$failed_job")"
        if printf '%s' "$joblog" | grep -qiE "$TRANSIENT_RE"; then
            echo "ci-watch: classification = TRANSIENT (retryable infra). Re-run: $GH_BIN run rerun --failed $RUN_ID -R $REPO"
            exit 2
        fi
        echo "ci-watch: classification = REAL (code/test/build). Fix before re-running."
        exit 1
    fi

    if [[ "$run_status" == "completed" ]]; then
        echo "ci-watch: ✓ all jobs passed (run $RUN_ID)"
        exit 0
    fi

    echo "ci-watch: in progress ($inprogress job(s) running)…"
    sleep "$POLL_SECS"
done
