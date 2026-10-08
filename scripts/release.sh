#!/usr/bin/env bash
set -euo pipefail

# release.sh — Tag and push a new magic-context release
#
# Usage:
#   ./scripts/release.sh 0.1.0        # release v0.1.0
#   ./scripts/release.sh 0.1.0 --dry  # preview without committing/pushing
#
# What it does:
#   1. Validates the version is semver
#   2. Checks for clean working tree (no uncommitted changes)
#   3. Syncs version in package.json
#   4. Runs pre-release checks (lint, typecheck, build)
#   5. Commits the version bump
#   6. Creates a git tag (v0.1.0)
#   7. Pushes commit + tag to origin
#   8. CI takes over: test → build → publish npm + GitHub release

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)

# The host and hermetic e2e lanes spawn `opencode serve` from PATH. The official
# installer puts the binary under ~/.opencode/bin, which login shells add to PATH but
# tool/daemon shells often do not (v0.42.6 r9: the same box that passed r8 lost the
# entry when the tool daemon restarted). Prefer the ambient PATH; fall back to the
# installer location before declaring it missing.
if ! command -v opencode >/dev/null 2>&1 && [ -x "$HOME/.opencode/bin/opencode" ]; then
  export PATH="$HOME/.opencode/bin:$PATH"
fi
VERSION=""
DRY=""
FORCE_E2E_HOST=0
SKIP_RUST_E2E=0
CI_GATE_SHA=""

for arg in "$@"; do
  case "$arg" in
    --dry)
      DRY="--dry"
      ;;
    --e2e-host)
      FORCE_E2E_HOST=1
      ;;
    --ci-gate=*)
      # Use a green master CI run as the test gate instead of re-running the
      # unit and host e2e suites locally (they are load-sensitive on a busy
      # machine). Names the CI-verified commit; checked below. The tag workflow
      # still runs its own full gate before anything publishes.
      CI_GATE_SHA="${arg#--ci-gate=}"
      ;;
    --skip-rust-e2e)
      # One-off operator decision to release without the experimental Rust-mode
      # suite. Requires the repo variable RELEASE_SKIP_RUST_E2E to name this exact
      # tag, so the tag workflow skips the same suite and the skip can never carry
      # over to a later release.
      SKIP_RUST_E2E=1
      ;;
    --*)
      echo "Error: unknown option '$arg'"
      echo "Usage: ./scripts/release.sh <version> [--dry] [--e2e-host] [--skip-rust-e2e] [--ci-gate=<sha>]"
      exit 1
      ;;
    *)
      if [[ -n "$VERSION" ]]; then
        echo "Error: more than one version was supplied"
        echo "Usage: ./scripts/release.sh <version> [--dry] [--e2e-host] [--skip-rust-e2e] [--ci-gate=<sha>]"
        exit 1
      fi
      VERSION="$arg"
      ;;
  esac
done

if [[ -z "$VERSION" ]]; then
  echo "Usage: ./scripts/release.sh <version> [--dry] [--e2e-host] [--skip-rust-e2e] [--ci-gate=<sha>]"
  echo "  e.g. ./scripts/release.sh 0.1.0"
  exit 1
fi

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$ ]]; then
  echo "Error: '$VERSION' is not valid semver (expected X.Y.Z)"
  exit 1
fi

TAG="v$VERSION"

if [[ -n "$CI_GATE_SHA" ]]; then
  CI_GATE_SHA=$(git rev-parse --verify "$CI_GATE_SHA^{commit}") || { echo "Error: --ci-gate names no commit"; exit 1; }
  if ! git merge-base --is-ancestor "$CI_GATE_SHA" HEAD; then
    echo "Error: --ci-gate commit $CI_GATE_SHA is not an ancestor of HEAD"; exit 1
  fi
  # Only release tooling and release notes may differ from the CI-verified commit.
  CI_GATE_DRIFT=$(git diff --name-only "$CI_GATE_SHA" HEAD | grep -vE '^(scripts/release[^/]*\.sh|\.cortexkit/)' || true)
  if [[ -n "$CI_GATE_DRIFT" ]]; then
    echo "Error: HEAD differs from the CI-verified commit outside release tooling:"; echo "$CI_GATE_DRIFT"; exit 1
  fi
  CI_RESULT=$(gh api "repos/cortexkit/magic-context/actions/runs?head_sha=$CI_GATE_SHA&event=push" \
    -q '[.workflow_runs[] | select(.name=="CI")][0] | "\(.status)/\(.conclusion)"' 2>/dev/null || true)
  if [[ "$CI_RESULT" != "completed/success" ]]; then
    echo "Error: master CI for $CI_GATE_SHA is '${CI_RESULT:-missing}', not completed/success"; exit 1
  fi
  echo ""
  echo "  NOTE: test gate = master CI run on $CI_GATE_SHA (completed/success);"
  echo "        local unit and host e2e suites are skipped. Lint, typecheck and builds still run."
  echo ""
fi

if [[ "$SKIP_RUST_E2E" -eq 1 ]]; then
  SKIP_VAR=$(gh api repos/cortexkit/magic-context/actions/variables/RELEASE_SKIP_RUST_E2E -q .value 2>/dev/null || true)
  if [[ "$SKIP_VAR" != "$TAG" ]]; then
    echo "Error: --skip-rust-e2e needs the repo variable RELEASE_SKIP_RUST_E2E set to '$TAG' (found '${SKIP_VAR}'),"
    echo "       so the tag workflow skips the same suite: gh variable set RELEASE_SKIP_RUST_E2E --body $TAG"
    exit 1
  fi
  echo ""
  echo "  WARNING: releasing $TAG WITHOUT the Rust hermetic e2e suite (operator decision)."
  echo "  This release does not claim Rust transform mode passed its behaviour suite."
  echo ""
fi

# Check if tag already exists
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Error: tag '$TAG' already exists"
  exit 1
fi

# Check for clean working tree
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is not clean — commit or stash changes first"
  git status --short
  exit 1
fi

# Check we're on main/master
BRANCH=$(git branch --show-current)
if [[ "$BRANCH" != "main" && "$BRANCH" != "master" ]]; then
  echo "Warning: releasing from '$BRANCH' (not main/master)"
  read -rp "Continue? [y/N] " confirm
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "Aborted."
    exit 1
  fi
fi

echo ""
echo "  Releasing magic-context $TAG"
echo "  ─────────────────────────────"
echo ""

# Step 1: Dry run preview
if [[ "$DRY" == "--dry" ]]; then
  echo "→ Version sync (dry run):"
  bun scripts/version-sync.mjs "$VERSION" --dry-run
  echo ""
  echo "[DRY RUN] Would commit, tag $TAG, and push to origin."
  exit 0
fi

# Step 2: Pre-release checks
echo "→ Running pre-release checks..."
echo ""

REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd -P)
PLUGIN_DIR="$REPO_ROOT/packages/plugin"
PI_DIR="$REPO_ROOT/packages/pi-plugin"
CLI_DIR="$REPO_ROOT/packages/cli"
E2E_DIR="$REPO_ROOT/packages/e2e-tests"
E2E_MANIFEST_VALIDATOR="$E2E_DIR/scripts/validate-mode-manifest.ts"

# The committed validator is the only source of e2e file lists. It validates
# the live tests glob before printing a shell-safe, space-separated list.
manifest_files() {
  local mode="$1" harness="$2"
  bun "$E2E_MANIFEST_VALIDATOR" --mode "$mode" --harness "$harness" | tr '\n' ' '
}

# Run `bun test` for a package and gate on a TRUE pass, not just "no fail line".
#
# Bun has a known post-completion panic on large suites: every test passes and
# the full summary prints, but the process then exits non-zero. We must tolerate
# THAT specific case without becoming fail-open. The old gate (`|| true` + grep
# for "N fail") passed on a panic before any tests ran, a harness timeout, a
# zero-tests-collected run, or any Bun output-format change — all of which a
# release must block on.
#
# Robust gate: require BOTH (a) a positive "<n> pass" completion line AND
# (b) zero "<n> fail". If the exit code is 0 we trust it directly; if non-zero
# we only accept it when the pass/fail summary proves the suite actually ran
# and was green (the Bun-panic case).
run_package_tests() {
  local label="$1" dir="$2" output status
  if [[ -n "$CI_GATE_SHA" ]]; then
    echo "  [$label] tests: covered by master CI on $CI_GATE_SHA"
    return 0
  fi
  echo "  [$label] bun run test..."
  # `set -e` would abort the script at this assignment the instant the package
  # test command exits non-zero — BEFORE `status=$?` and the panic-tolerance
  # below could run. Bun sometimes exits non-zero with a post-completion panic
  # AFTER printing a fully-green summary; the grep checks below are the real
  # gate. Use `|| status=$?` so errexit doesn't fire and the tolerance is
  # reachable.
  status=0
  output=$(bun run --cwd "$dir" test 2>&1) || status=$?
  # Print the verdict facts BEFORE the (large) captured output so they survive
  # even when the stream is cut mid-echo: a run that dies without a summary
  # otherwise leaves no line naming why the release stopped.
  local pass_lines fail_lines
  pass_lines=$(printf '%s\n' "$output" | grep -cE "^ *[1-9][0-9]* pass" || true)
  fail_lines=$(printf '%s\n' "$output" | grep -cE "^ *[1-9][0-9]* fail" || true)
  echo "  [$label] test process exit=$status summary_pass_lines=$pass_lines summary_fail_lines=$fail_lines output_lines=$(printf '%s\n' "$output" | wc -l | tr -d ' ')"
  echo "$output"
  # Decide from the counts computed above, never from `echo | grep -q`: under
  # `set -o pipefail`, grep -q exits on its first match and closes the pipe while
  # echo is still writing the remaining lines, echo dies with SIGPIPE (141), and
  # the pipeline reports failure for a suite that printed "4851 pass" (v0.42.5 r1).
  # `grep -c` consumes the whole stream, so the counts carry no such race.
  # The counts above are anchored to Bun's summary lines (`^ *N pass` / `^ *N fail`);
  # an unanchored "N fail" also matches test names such as "keeps below-95 failures",
  # which the old grep -q form only hid because of the SIGPIPE race.
  if [ "$fail_lines" -gt 0 ]; then
    echo "Error: $label tests failed (fail count > 0)"
    exit 1
  fi
  if [ "$pass_lines" -eq 0 ]; then
    echo "Error: $label tests produced no passing-test summary (crash, timeout, or zero tests collected)"
    exit 1
  fi
  if [ "$status" -ne 0 ]; then
    echo "  [$label] note: tests passed but Bun exited $status (known post-completion panic) — tolerated"
  fi
}

echo "  [plugin] bun lint..."
bun run --cwd "$PLUGIN_DIR" lint 2>&1 || { echo "Error: Plugin lint failed"; exit 1; }

echo "  [plugin] bun typecheck..."
bun run --cwd "$PLUGIN_DIR" typecheck 2>&1 || { echo "Error: Plugin typecheck failed"; exit 1; }

run_package_tests "plugin" "$PLUGIN_DIR"

echo "  [plugin] bun build..."
bun run --cwd "$PLUGIN_DIR" build 2>&1 || { echo "Error: Plugin build failed"; exit 1; }

# Copy root README into plugin package for npm publishing
cp README.md "$PLUGIN_DIR/README.md"

echo "  [pi-plugin] bun lint..."
bun run --cwd "$PI_DIR" lint 2>&1 || { echo "Error: Pi-plugin lint failed"; exit 1; }

echo "  [pi-plugin] bun typecheck..."
bun run --cwd "$PI_DIR" typecheck 2>&1 || { echo "Error: Pi-plugin typecheck failed"; exit 1; }

run_package_tests "pi-plugin" "$PI_DIR"

echo "  [pi-plugin] bun build..."
bun run --cwd "$PI_DIR" build 2>&1 || { echo "Error: Pi-plugin build failed"; exit 1; }

echo "  [cli] bun lint..."
bun run --cwd "$CLI_DIR" lint 2>&1 || { echo "Error: CLI lint failed"; exit 1; }

echo "  [cli] bun typecheck..."
bun run --cwd "$CLI_DIR" typecheck 2>&1 || { echo "Error: CLI typecheck failed"; exit 1; }

run_package_tests "cli" "$CLI_DIR"

echo "  [cli] bun build..."
bun run --cwd "$CLI_DIR" build 2>&1 || { echo "Error: CLI build failed"; exit 1; }

echo "  [packages] auditing packed consumer dependency graphs..."
bun run --cwd "$REPO_ROOT" audit:packed-packages 2>&1 || { echo "Error: Packed-package audit failed"; exit 1; }

# Host behavior E2E suite (packages/e2e-tests). This is the deep suite that
# spawns a real `opencode serve` (and resolves Pi from node_modules) against a
# mock provider — it lives outside the per-package `bun test` runs above and was
# previously caught only in CI's host-e2e jobs. Running it here means a broken
# e2e fails the release locally instead of after a full tag → CI round-trip.
#
# Split OpenCode (non-pi files) vs Pi (pi-*.test.ts) exactly like CI's two host
# jobs, so the local gate mirrors what CI enforces. NODE_ENV="" matches the
# normal runtime the spawned opencode subprocess expects (a stray NODE_ENV=test
# changes plugin logging/behavior). opencode must be on PATH.
run_e2e_group() {
  local mode="$1" label="$2" files="$3" output status
  echo "  [e2e:$mode:$label:start] bun test..."
  status=0
  # --max-concurrency=1: the hermetic stacks spawn real daemons/servers per
  # test file; parallel stacks on one box cross-contaminate (ports, module
  # sockets, timing drills) and produce flaky failures that pass serially.
  # This matches the dedicated test:rust-e2e script's serial invocation.
  output=$(cd "$E2E_DIR" && MC_E2E_MODE="$mode" NODE_ENV="" bun test --timeout 600000 --max-concurrency=1 $files 2>&1) || status=$?
  echo "$output"
  # Same SIGPIPE-safe counting as run_package_tests (see the note there).
  local e2e_fail e2e_pass
  e2e_fail=$(printf '%s\n' "$output" | grep -cE "^ *[1-9][0-9]* fail" || true)
  e2e_pass=$(printf '%s\n' "$output" | grep -cE "^ *[1-9][0-9]* pass" || true)
  if [ "$e2e_fail" -gt 0 ]; then
    echo "Error: e2e ($mode/$label) failed (fail count > 0)"
    echo "  [e2e:$mode:$label:end] status=fail"
    return 1
  fi
  if [ "$e2e_pass" -eq 0 ]; then
    echo "Error: e2e ($mode/$label) produced no passing-test summary (crash, timeout, or zero tests collected)"
    echo "  [e2e:$mode:$label:end] status=fail"
    return 1
  fi
  if [ "$status" -ne 0 ]; then
    echo "  [e2e:$mode:$label] note: tests passed but Bun exited $status (known post-completion panic) — tolerated"
  fi
  echo "  [e2e:$mode:$label:end] status=pass"
}

strip_leading_zeros() {
  local value="$1"
  while [[ "$value" == 0* && "$value" != 0 ]]; do
    value="${value#0}"
  done
  printf '%s' "$value"
}

elapsed_seconds() {
  local elapsed="$1"
  local days=0 hours=0 minutes=0 seconds=0
  local fields field_count
  if [[ "$elapsed" == *-* ]]; then
    days="${elapsed%%-*}"
    elapsed="${elapsed#*-}"
  fi
  IFS=: read -r -a fields <<< "$elapsed"
  field_count="${#fields[@]}"
  if [[ "$field_count" -eq 2 ]]; then
    minutes="${fields[0]}"
    seconds="${fields[1]}"
  elif [[ "$field_count" -eq 3 ]]; then
    hours="${fields[0]}"
    minutes="${fields[1]}"
    seconds="${fields[2]}"
  else
    echo 0
    return
  fi
  if ! [[ "$days" =~ ^[0-9]+$ && "$hours" =~ ^[0-9]+$ && "$minutes" =~ ^[0-9]+$ && "$seconds" =~ ^[0-9]+$ ]]; then
    echo 0
    return
  fi
  days=$(strip_leading_zeros "$days")
  hours=$(strip_leading_zeros "$hours")
  minutes=$(strip_leading_zeros "$minutes")
  seconds=$(strip_leading_zeros "$seconds")
  echo $((days * 86400 + hours * 3600 + minutes * 60 + seconds))
}

process_cwd() {
  local pid="$1" cwd=""
  if [[ -L "/proc/$pid/cwd" ]]; then
    cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)
  elif command -v lsof >/dev/null 2>&1; then
    cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | while IFS= read -r entry; do
      if [[ "$entry" == n* ]]; then
        printf '%s\n' "${entry#n}"
        break
      fi
    done)
  fi
  printf '%s' "$cwd"
}

is_e2e_sandbox_path() {
  case "$1" in
    */opencode-test-*|*/opencode-test-*/*|*/opencode-e2e-*|*/opencode-e2e-*/*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

reap_stale_e2e_opencode() {
  local pid etime command age cwd current_command current_cwd
  local reaped=0
  echo "  WARNING: using the host e2e path; checking only stale sandboxed opencode serve processes..."
  while read -r pid etime command; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    [[ "$command" =~ (^|[[:space:]/])opencode[[:space:]]+serve([[:space:]]|$) ]] || continue
    cwd=$(process_cwd "$pid")
    is_e2e_sandbox_path "$cwd" || continue
    age=$(elapsed_seconds "$etime")
    if (( age < 600 )); then
      continue
    fi
    current_command=$(ps -p "$pid" -o command= 2>/dev/null || true)
    [[ "$current_command" =~ (^|[[:space:]/])opencode[[:space:]]+serve([[:space:]]|$) ]] || continue
    current_cwd=$(process_cwd "$pid")
    is_e2e_sandbox_path "$current_cwd" || continue
    echo "  Reaping stale e2e opencode serve pid=$pid age=${etime} cwd=$current_cwd"
    kill -TERM "$pid" 2>/dev/null || true
    reaped=$((reaped + 1))
  done < <(ps -axo pid=,etime=,command= 2>/dev/null || true)
  echo "  Host e2e reap guard: $reaped stale sandbox process(es) signaled"
}

docker_available() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

run_host_e2e() {
  # Resolve all lists before selecting Docker versus host execution. Both paths
  # receive lists produced by the same validated manifest invocation.
  E2E_OC_FILES=$(manifest_files ts opencode)
  E2E_PI_FILES=$(manifest_files ts pi)
  export E2E_OC_FILES E2E_PI_FILES

  if [[ "$FORCE_E2E_HOST" -eq 0 ]] && docker_available; then
    echo "  [e2e] Docker is available; running both host e2e legs in the native container..."
    "$SCRIPT_DIR/release-e2e-docker.sh"
    return
  fi

  if [[ "$FORCE_E2E_HOST" -eq 1 ]]; then
    echo "  WARNING: --e2e-host requested; bypassing the containerized host e2e gate."
  else
    echo "  WARNING: Docker is unavailable; falling back to the host e2e path (m1bench has no Docker)."
  fi
  reap_stale_e2e_opencode

  if ! command -v opencode >/dev/null 2>&1; then
    echo "Error: 'opencode' not found on PATH — the host E2E suite spawns 'opencode serve'."
    echo "       Install it (curl -fsSL https://opencode.ai/install | bash) and ensure ~/.opencode/bin is on PATH."
    exit 1
  fi
  run_e2e_group "ts" "opencode" "$E2E_OC_FILES"
  run_e2e_group "ts" "pi" "$E2E_PI_FILES"
}

# Rust stays on the host because the hermetic daemon and its module are spawned as
# native processes by the end-to-end scenarios. The shared runner selects the manifest
# tests, checks prerequisites, and requires a positive test summary just like release CI.
if [[ -n "$CI_GATE_SHA" ]]; then
  echo "  [e2e] host legs: covered by master CI on $CI_GATE_SHA"
else
  run_host_e2e
fi
if [[ "$SKIP_RUST_E2E" -eq 1 ]]; then
  echo "  [e2e:rust] SKIPPED by operator for $TAG (--skip-rust-e2e)"
else
  "$SCRIPT_DIR/run-rust-hermetic-e2e.sh"
fi

echo "  ✓ All checks passed"
echo ""

# Step 3: Generate JSON Schema
echo "→ Generating JSON Schema..."
bun packages/plugin/scripts/build-schema.ts || { echo "Error: Schema generation failed"; exit 1; }
echo ""

# Step 3b: Regenerate reference-seed corpus from source XML
echo "→ Generating historian reference seeds..."
bun packages/plugin/scripts/build-reference-seeds.ts || { echo "Error: Reference-seed generation failed"; exit 1; }
echo ""

# Step 3c: Re-lint generated artifacts. The pre-release lint (above) runs BEFORE
# generation, so a generator that emits non-repo-style output would otherwise
# only fail in CI after the tag is cut. Lint the regenerated files here so any
# formatting drift fails locally.
echo "→ Linting generated artifacts..."
bun run --cwd "$PLUGIN_DIR" lint 2>&1 || { echo "Error: Generated artifacts failed lint (regenerated schema/seeds not repo-style)"; exit 1; }
echo ""

# Step 4: Sync version
echo "→ Syncing version to $VERSION..."
bun scripts/version-sync.mjs "$VERSION"
echo ""

# Step 4: Commit (skip if versions were already at target)
# Stage only what this script produced (the version sync and the regenerated
# artifacts the lint step just checked). `git add -A` once swept unrelated files
# edited in the checkout during the long gate phase into a release commit
# (v0.42.4); anything else dirty at this point is a foreign change and aborts.
echo "→ Committing version bump..."
git add -- packages/plugin/package.json packages/pi-plugin/package.json packages/cli/package.json \
  assets/magic-context.schema.json \
  packages/plugin/src/hooks/magic-context/reference-seeds.generated.ts
# Cargo.lock is the common dirty file here: Cargo can update the resolved versions
# of crates declared by this repository while the release gates run. The gates just
# ran on that resolved graph, so the tested artifact IS the drifted lock; committing
# it on its own records the graph they passed. Only a lock that still builds --locked
# qualifies; anything else dirty is foreign and aborts.
unrelated="$(git status --porcelain --untracked-files=no | grep -v '^[MARC] ' || true)"
if [ "$unrelated" = " M Cargo.lock" ]; then
  echo "  Cargo.lock drifted (a crate version or pinned source changed in this repository's lockfile); verifying it builds --locked..."
  if cargo build --locked --release -p mc-module >/dev/null 2>&1; then
    versions="$(git diff Cargo.lock | grep -E '^[-+]version' | sed -E 's/^([-+])version = "([^"]+)"/\1\2/' | paste -sd' ' -)"
    git commit -q -o Cargo.lock -m "cargo: reconcile lock to the tested crate graph (lock-only: ${versions})"
    echo "  committed lock reconciliation: $(git log --oneline -1)"
    unrelated=""
  fi
fi
if [ -n "$unrelated" ]; then
  echo "Error: unrelated modified files present at bump time; refusing to fold them into the release commit:"
  echo "$unrelated"
  git reset -q
  exit 1
fi
if git diff --cached --quiet; then
  echo "  (no changes — version already at $VERSION)"
else
  git commit -m "release: $TAG"
fi

# Step 5: Tag
echo "→ Creating tag $TAG..."
git tag -a "$TAG" -m "Release $TAG"
echo ""

# Step 6: Push
echo "→ Pushing to origin..."
git push origin "$BRANCH"
git push origin "$TAG"
echo ""

echo "  ✓ Tag pushed: $TAG — waiting on the GitHub release workflow (test → build → publish)"

# The release is NOT done when the tag is pushed: the publish happens in CI. Block
# on the workflow run and exit with ITS status, so whoever invoked this script
# (human terminal or a tracked agent task) gets exactly one truthful completion
# signal for the WHOLE release — a silent CI failure here has cost hours before.
RUN_ID=""
for _ in $(seq 1 36); do
    RUN_ID=$(gh run list --workflow=release.yml --limit 5 \
        --json databaseId,headSha -q ".[] | select(.headSha == \"$(git rev-parse HEAD)\") | .databaseId" | head -1)
    [ -n "$RUN_ID" ] && break
    sleep 5
done
if [ -z "$RUN_ID" ]; then
    echo "  ✗ release workflow run for $TAG not found after 3 minutes — check Actions manually" >&2
    exit 1
fi
echo "  → Watching workflow run $RUN_ID (blocks until publish completes or fails)..."
# `gh run watch` exits non-zero on transient API errors too, not only on a
# failed run; a false "RELEASE FAILED" while the run was still in progress cost
# a manual re-watch on 2026-09-13. Trust only the run's terminal status: keep
# watching until the run is no longer queued/in_progress, then judge it.
RUN_STATUS=""
for attempt in 1 2 3 4 5 6; do
    gh run watch "$RUN_ID" --exit-status --interval 30 > /dev/null 2>&1 || true
    RUN_STATUS=$(gh run view "$RUN_ID" --json status -q '.status' 2>/dev/null || echo "")
    case "$RUN_STATUS" in
        queued|in_progress|waiting|requested|pending|"") sleep 30 ;;
        *) break ;;
    esac
done
RUN_CONCLUSION=$(gh run view "$RUN_ID" --json conclusion -q '.conclusion' 2>/dev/null || echo "unknown")
if [ "$RUN_CONCLUSION" != "success" ]; then
    echo "" >&2
    echo "  ✗ RELEASE FAILED in CI (run $RUN_ID, status=$RUN_STATUS conclusion=$RUN_CONCLUSION). Failing jobs:" >&2
    gh run view "$RUN_ID" --json jobs -q '.jobs[] | select(.conclusion != "success" and .conclusion != "skipped") | "    - " + .name + " (" + .status + "/" + .conclusion + ")"' >&2
    exit 1
fi
echo "  ✓ Released $TAG — CI publish completed"

# npm can acknowledge a publish ("+ pkg@version", provenance signed) and still
# leave the version STAGED and invisible: absent from the packument's `time`
# map, 404 on the tarball, and E409 "previously staged version" on every retry
# (2026-09-13: @cortexkit/pi-magic-context@0.42.2). The publish job's exit
# status therefore proves nothing about installability; the packument is the
# only signal that tells the truth. Poll it for each package before calling the
# release shipped.
echo "  → Verifying registry visibility for $VERSION..."
MISSING=""
for pkg in @cortexkit/opencode-magic-context @cortexkit/pi-magic-context @cortexkit/magic-context; do
    seen=""
    for attempt in $(seq 1 20); do
        if curl -fsS "https://registry.npmjs.org/${pkg/\//%2F}" -H 'Cache-Control: no-cache' 2>/dev/null \
            | grep -q "\"$VERSION\":\"[0-9]"; then
            seen=1; break
        fi
        sleep 30
    done
    if [ -n "$seen" ]; then
        echo "    ✓ $pkg@$VERSION visible on the registry"
    else
        echo "    ✗ $pkg@$VERSION NOT visible after 10 minutes (publish acknowledged but staged?)" >&2
        MISSING="$MISSING $pkg"
    fi
done
if [ -n "$MISSING" ]; then
    echo "  ✗ RELEASE INCOMPLETE: not installable at $VERSION:$MISSING" >&2
    echo "    A staged version cannot be re-published (E409); if it never lands, the next patch version is the recovery." >&2
    exit 1
fi
