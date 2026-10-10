#!/usr/bin/env bash
# Local merge gate: GitHub's successful bot checks do not mean their findings
# were handled. Only resolving the review threads on GitHub clears this gate.
# Usage: scripts/merge-pr.sh <number> [--dry-run | --findings-only]
# Requires gh, jq, GNU timeout (coreutils on macOS), git, and the touched runners.
# AFT's gh shim may refuse read-only GraphQL until gh api graphql is declared;
# this script reports that limitation and never bypasses the shim.
set -euo pipefail

REVIEW_BOTS='["cubic-dev-ai", "greptile-apps"]'
REPOSITORY=cortexkit/magic-context
COMMAND_TIMEOUT=20m

die() { printf 'merge-pr: %s\n' "$*" >&2; exit 1; }
run() {
  local status=0
  timeout "$COMMAND_TIMEOUT" "$@" || status=$?
  if [ "$status" -ne 0 ]; then
    die "Command failed (exit $status): $*"
  fi
}

number=''
dry_run=0
findings_only=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    --findings-only) findings_only=1 ;;
    *)
      [[ "$arg" =~ ^[1-9][0-9]*$ ]] || die "Usage: scripts/merge-pr.sh <number> [--dry-run | --findings-only]"
      [ -z "$number" ] || die 'Supply exactly one PR number.'
      number=$arg
      ;;
  esac
done
[ -n "$number" ] || die 'Supply a PR number.'
[ "$dry_run" -eq 0 ] || [ "$findings_only" -eq 0 ] || die 'Choose --dry-run or --findings-only, not both.'

# Keep this query and the findings filter identical to review-findings.yml.
# GraphQL variables must reach the API unchanged, not expand in the shell.
# shellcheck disable=SC2016
QUERY='query($owner:String!, $repo:String!, $number:Int!, $cursor:String) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$number) {
      number title headRefOid isCrossRepository state baseRefName
      reviewThreads(first:100, after:$cursor) {
        nodes {
          isResolved path line originalLine
          comments(first:1) { nodes { author { login } body url } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}'
VALID_PAGE='(.errors // [] | length) == 0 and
  (.data.repository.pullRequest | type == "object") and
  (.data.repository.pullRequest.reviewThreads | ( .nodes | type == "array") and
    (.pageInfo.hasNextPage | type == "boolean"))'
# These are jq variables, not shell variables.
# shellcheck disable=SC2016
FINDINGS_FILTER='.data.repository.pullRequest.reviewThreads.nodes[] |
  .comments.nodes[0] as $comment |
  ($comment.author.login // "" | sub("\\[bot\\]$"; "")) as $author |
  select(($bots | index($author)) != null and .isResolved == false) |
  ($comment.body | gsub("(?s)<!--.*?-->"; "") | split("\n") |
    map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0)) | .[0] // "(empty body)") as $body |
  "\($author) \(.path):\(.line // .originalLine // "?"): \($body)\n  \($comment.url)"'

check_findings() {
  local cursor='' page findings blocked=0 first=1 next status
  while :; do
    local args=(api graphql -f query="$QUERY" -f owner="${REPOSITORY%/*}" -f repo="${REPOSITORY#*/}" -F number="$number")
    [ -z "$cursor" ] || args+=(-f cursor="$cursor")
    status=0
    page=$(timeout "$COMMAND_TIMEOUT" gh "${args[@]}" 2>&1) || status=$?
    if [ "$status" -ne 0 ]; then
      printf '%s\n' "$page" >&2
      if [ "$status" -eq 86 ] && [[ "$page" = *gh_shim_unclassified* ]]; then
        die 'The AFT gh shim refused this read-only GraphQL query (exit 86). Ask for gh api graphql to be declared in the manifest; no GitHub request was made.'
      fi
      die "GraphQL query failed (gh exit $status)."
    fi
    run jq -e "$VALID_PAGE" >/dev/null <<< "$page"
    if [ "$first" -eq 1 ]; then
      head=$(run jq -er '.data.repository.pullRequest.headRefOid' <<< "$page")
      title=$(run jq -er '.data.repository.pullRequest.title' <<< "$page")
      [[ "$head" =~ ^[0-9a-f]{40}$ ]] || die 'GitHub returned an invalid head SHA.'
      if [ "$findings_only" -eq 0 ]; then
        local mergeable
        mergeable=$(run jq -r '.data.repository.pullRequest | .state == "OPEN" and .baseRefName == "master"' <<< "$page")
        [ "$mergeable" = true ] || die 'PR must be open and target master.'
      fi
      first=0
    fi
    findings=$(run jq -r --argjson bots "$REVIEW_BOTS" "$FINDINGS_FILTER" <<< "$page")
    if [ -n "$findings" ]; then
      printf '%s\n' "$findings"
      blocked=1
    fi
    next=$(run jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage' <<< "$page")
    [ "$next" = true ] || break
    local previous=$cursor
    cursor=$(run jq -er '.data.repository.pullRequest.reviewThreads.pageInfo.endCursor' <<< "$page")
    [ "$cursor" != "$previous" ] || die 'GitHub returned a repeated review-thread cursor.'
  done
  [ "$blocked" -eq 0 ] || die "PR #$number has unresolved reviewer-bot findings. Resolve each thread on GitHub before merging."
  printf 'PR #%s: no unresolved reviewer-bot findings.\n' "$number"
}

check_runs() {
  local pages pending
  # REST pagination matters too: a running bot check can follow 100 other runs.
  pages=$(run gh api --paginate --slurp "repos/$REPOSITORY/commits/$head/check-runs?per_page=100")
  run jq -e 'type == "array" and length > 0 and all(.[]; .check_runs | type == "array")' >/dev/null <<< "$pages"
  pending=$(run jq -r --argjson bots "$REVIEW_BOTS" '.[] | .check_runs[] |
    .app.slug as $app | select(($bots | index($app)) != null) |
    select(.status == "in_progress" or .status == "queued") |
    "\(.app.slug): \(.name) (\(.status)) \(.html_url // "")"' <<< "$pages")
  [ -z "$pending" ] || die "Reviewer-bot checks are still running; findings may not be posted yet:
$pending"
}

head=''
title=''
check_findings
[ "$findings_only" -eq 0 ] || exit 0
check_runs

root=$(run git rev-parse --show-toplevel)
cd "$root"
check_checkout() {
  [ "$(run git branch --show-current)" = master ] || die 'Run this from the master branch.'
  [ -z "$(run git status --porcelain --untracked-files=all)" ] || die 'Working tree is dirty; commit or remove local changes first.'
}
check_checkout
run git fetch origin master
if ! timeout "$COMMAND_TIMEOUT" git merge-base --is-ancestor origin/master master; then
  die 'Local master is behind or diverged from origin/master; update it before merging.'
fi
master_sha=$(run git rev-parse master)
run git fetch origin "pull/$number/head"
fetched_head=$(run git rev-parse FETCH_HEAD)
[ "$fetched_head" = "$head" ] || die 'PR head changed between the GitHub query and fetch; retry with the new head.'

worktree="${TMPDIR:-/tmp}/magic-context/merge-pr-$number"
[ ! -e "$worktree" ] && [ ! -L "$worktree" ] || die "Temporary worktree already exists: $worktree (not removed)."
run mkdir -p "${worktree%/*}"
added=0
changed_file=''
cleanup() {
  local status=$?
  trap - EXIT
  if [ "$added" -eq 1 ]; then
    if ! timeout "$COMMAND_TIMEOUT" git worktree remove --force "$worktree"; then
      printf 'merge-pr: Could not remove temporary worktree: %s\n' "$worktree" >&2
      status=1
    fi
  fi
  if [ -n "$changed_file" ]; then
    timeout "$COMMAND_TIMEOUT" rm -f "$changed_file" || status=1
  fi
  exit "$status"
}
trap cleanup EXIT
run git worktree add --detach "$worktree" master
added=1
run git -C "$worktree" merge --no-ff --no-edit "$head"

changed_file=$(run mktemp "${worktree%/*}/merge-pr-files.XXXXXX")
run git diff --name-only -z "master...$head" > "$changed_file"
# Package impact table: package | runner | changed source-path prefixes.
# Pi imports the plugin's shared core; CLI shares its config, loader and doctor
# code. Those dependents must run even when only the plugin changes. Add a new
# package in one row; include each shared source prefix that can affect it.
PACKAGE_GATES=(
  'plugin|test-typecheck|packages/plugin/'
  'pi-plugin|test-typecheck|packages/pi-plugin/ packages/plugin/'
  'cli|test|packages/cli/ packages/plugin/'
  'e2e-tests|mode-manifest|packages/e2e-tests/'
)
rust=0
biome_files=()
while IFS= read -r -d '' file; do
  case "$file" in
    crates/*) rust=1 ;;
  esac
  # Deleted paths still select package gates but cannot be linted. Prefix paths
  # with ./ so a filename beginning with a dash cannot become a Biome option.
  [ ! -f "$worktree/$file" ] || biome_files+=("./$file")
done < "$changed_file"
(
  cd "$worktree"
  run bun install --frozen-lockfile
  for rule in "${PACKAGE_GATES[@]}"; do
    IFS='|' read -r package runner prefixes <<< "$rule"
    selected=0
    while IFS= read -r -d '' file; do
      for prefix in $prefixes; do
        if [[ "$file" = "$prefix"* ]]; then
          selected=1
          break 2
        fi
      done
    done < "$changed_file"
    if [ "$selected" -eq 1 ]; then
      (
        cd "packages/$package"
        # Run each package's own test script, as CI does: it carries the
        # timeouts, parallelism and engine flags the suite was written for. Plain
        # `bun test` uses Bun's 5 s default timeout and fails tests that wait on
        # a bounded database writer retry, which CI never sees.
        case "$runner" in
          test-typecheck) run bun run test; run bun run typecheck ;;
          test) run bun run test ;;
          mode-manifest) run bun test scripts/validate-mode-manifest.test.ts ;;
          *) die "Unknown package gate runner: $runner" ;;
        esac
      )
    fi
  done
  if [ "$rust" -eq 1 ]; then
    run cargo clippy --workspace -- -D warnings
    run cargo test --workspace
  fi
  if [ "${#biome_files[@]}" -gt 0 ]; then
    # Biome does not support every extension (notably shell, Python, and YAML).
    run bunx biome check --no-errors-on-unmatched "${biome_files[@]}"
  else
    printf 'Biome: no surviving changed files to check.\n'
  fi
)

check_title() {
  local closing
  closing=$(run jq -nr --arg title "$title" '$title | test("(^|[^[:alnum:]_])(fix(es|ed)?|close[sd]?|resolve[sd]?)[[:space:]]+#[0-9]+"; "i")')
  if [ "$closing" = true ]; then
    die 'PR title contains a GitHub closing keyword with a number. Edit the title/message before merging; no automatic issue closing is allowed.'
  fi
}
check_title
if [ "$dry_run" -eq 1 ]; then
  printf 'Dry run passed. Would merge %s with message "Merge PR #%s: %s", then push origin master.\n' "$head" "$number" "$title"
  exit 0
fi

# Gates can take minutes. Recheck the remote review state and local checkout so
# a new finding, PR push, or local edit during testing cannot silently slip in.
tested_head=$head
check_findings
[ "$head" = "$tested_head" ] || die 'PR head changed during verification; retry.'
check_runs
check_title
check_checkout
[ "$(run git rev-parse master)" = "$master_sha" ] || die 'Local master changed during verification; retry.'
run git fetch origin master
if ! timeout "$COMMAND_TIMEOUT" git merge-base --is-ancestor origin/master master; then
  die 'origin/master advanced during verification; update local master and retry.'
fi
run git merge --no-ff -m "Merge PR #$number: $title" "$tested_head"
run git push origin master
run git log --oneline -1
