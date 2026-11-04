#!/usr/bin/env bash
# Exercise the real guard in a disposable repository; no operator files are used.
set -euo pipefail
finished=0
root=$(git rev-parse --show-toplevel)
fixture=$(mktemp -d "${TMPDIR:-/tmp}/mc-docs-layout.XXXXXX")
trap 'status=$?
if [ "$status" -eq 0 ] && [ "${finished:-0}" != 1 ]; then
    printf "%s\n" "$0: exited before successful completion" >&2
    status=1
fi
rm -rf "$fixture" || { cleanup_status=$?; [ "$status" -ne 0 ] || status=$cleanup_status; }
exit "$status"' EXIT
cp "$root/.gitignore" "$fixture/.gitignore"
mkdir -p "$fixture/scripts"
cp "$root/scripts/check-docs-layout.sh" "$root/scripts/check-cortexkit-layout.sh" "$fixture/scripts/"
cd "$fixture"
git init -q
git add .gitignore scripts/check-docs-layout.sh scripts/check-cortexkit-layout.sh
checks=0
plant() {
  mkdir -p "$(dirname "$1")"
  printf 'fixture\n' > "$1"
  git add -f -- "$1"
}
expect_red() {
  local path=$1 guard=$2 name=$3 output status=0
  plant "$path"
  output=$(bash "scripts/$guard" 2>&1) || status=$?
  if [ "$status" -ne 1 ]; then
    printf 'FAIL: %s accepted %s\n' "$name" "$path" >&2
    exit 1
  fi
  [[ "$output" == *"$name"* && "$output" == *"$path"* ]] || {
    printf 'FAIL: unexpected guard error: %s\n' "$output" >&2; exit 1;
  }
  git rm --cached -q -- "$path"
  rm "$path"
  checks=$((checks + 1))
}
mkdir -p .cortexkit/internal-docs/investigations
printf 'local document, deliberately not tracked\n' > .cortexkit/internal-docs/investigations/local.md
for path in .cortexkit/release-notes/v1.0.0.md .cortexkit/skills/example.md .cortexkit/rules/example.md docs/architecture/example.md docs/explainers/example.html docs/logo.png docs/logo-cropped.png docs/dist-chunk-lifecycle.md docs/migration-version-lanes.md; do
  plant "$path"
done
bash scripts/check-cortexkit-layout.sh
bash scripts/check-docs-layout.sh
checks=$((checks + 1))
expect_red .cortexkit/internal-docs/investigations/planted.md check-cortexkit-layout.sh 'tracked files under .cortexkit/'
expect_red .cortexkit/alfonso/reviews/planted.md check-cortexkit-layout.sh 'tracked files under .cortexkit/'
expect_red .cortexkit/config.jsonc check-cortexkit-layout.sh 'tracked files under .cortexkit/'
for folder in reports designs evidence specs investigations audits reviews research plans private protected-tokens; do
  expect_red "docs/$folder/planted.md" check-docs-layout.sh 'FAIL: docs public-only guard'
done
expect_red docs/innocuous-name.md check-docs-layout.sh 'FAIL: docs public-only guard'
expect_red 'docs/loose report.md' check-docs-layout.sh 'FAIL: docs public-only guard'
cp .gitignore .gitignore.clean
expect_blind() {
  local output status=0
  output=$(bash scripts/check-cortexkit-layout.sh 2>&1) || status=$?
  [[ "$status" -eq 2 && "$output" == BLIND:* ]] || {
    printf 'FAIL: expected BLIND exit 2, got %s: %s\n' "$status" "$output" >&2; exit 1;
  }
  checks=$((checks + 1))
  cp .gitignore.clean .gitignore
}
printf '\n' > .gitignore
expect_blind
printf '\n/.cortexkit/release-notes/\n' >> .gitignore
expect_blind
bash scripts/check-cortexkit-layout.sh
bash scripts/check-docs-layout.sh
checks=$((checks + 1))
printf 'bash %s: %s layout checks passed\n' "$BASH_VERSION" "$checks"
finished=1
