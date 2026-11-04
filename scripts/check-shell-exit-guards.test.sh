#!/usr/bin/env bash
# All execution is confined to planted scripts and copied EXIT actions, never the
# placement/release bodies or Docker entry points.
set -euo pipefail
finished=0
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
shell=bash
if [ -x /bin/bash ]; then shell=/bin/bash; fi
mkdir -p "$root/target/scratch"
fixture=$(mktemp -d "$root/target/scratch/shell-exit-guards.XXXXXX")
trap 'status=$?
if [ "$status" -eq 0 ] && [ "${finished:-0}" != 1 ]; then
    printf "%s\n" "$0: exited before successful completion" >&2
    status=1
fi
rm -rf "$fixture" || { cleanup_status=$?; [ "$status" -ne 0 ] || status=$cleanup_status; }
exit "$status"' EXIT
checks=0
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
expect_status() {
    local expected=$1 label=$2 actual=0
    shift 2
    "$@" > "$fixture/output" 2>&1 || actual=$?
    [ "$actual" -eq "$expected" ] || {
        printf 'FAIL: %s: expected %s, got %s\n' "$label" "$expected" "$actual" >&2
        while IFS= read -r line; do printf '%s\n' "$line" >&2; done < "$fixture/output"
        exit 1
    }
    checks=$((checks + 1))
    printf 'PASS: %s (status %s)\n' "$label" "$actual"
}
cd "$fixture"
# A caller's Git metadata/index overrides must not escape the disposable repo.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
git init -q
cat > unsafe.sh <<'SH'
set -euo pipefail
unset injected_unbound
trap 'true' EXIT
: "${injected_unbound}"
SH
git add unsafe.sh
expect_status 1 'unsafe tracked script refused' "$shell" "$root/scripts/check-shell-exit-guards.sh"
[[ $(< "$fixture/output") == *unsafe.sh:* ]] || fail 'refusal omitted the unsafe filename'
git rm --cached -q unsafe.sh

cat > guarded.sh <<'SH'
set -euo pipefail
finished=0
trap 'status=$?
if [ "$status" -eq 0 ] && [ "${finished:-0}" != 1 ]; then
    printf "%s\n" "$0: exited before successful completion" >&2
    status=1
fi
printf "cleanup\n" >> "$CLEANUP_LOG"
exit "$status"' EXIT
case "${1:-success}" in
    unbound) unset injected_unbound; : "${injected_unbound}" ;;
    empty-array) array=(); printf '%s\n' "${array[@]}" ;;
    failure) exit 7 ;;
    unfinished) exit 0 ;;
    explicit) finished=1; exit 0 ;;
esac
finished=1
SH
git add guarded.sh
export CLEANUP_LOG="$fixture/cleanup.log"
expect_status 0 'guarded tracked script accepted' "$shell" "$root/scripts/check-shell-exit-guards.sh"
expect_status 0 'natural successful completion' "$shell" guarded.sh
expect_status 0 'explicit successful completion' "$shell" guarded.sh explicit
expect_status 7 'nonzero exit preserved' "$shell" guarded.sh failure
expect_status 1 'zero without completion refused' "$shell" guarded.sh unfinished
expect_status 1 'guarded unbound variable fails closed' "$shell" guarded.sh unbound
[[ $(< "$fixture/output") == *'guarded.sh: exited before successful completion'* || $($shell -c 'echo "$BASH_VERSION"') != 3.* ]] ||
    fail 'Bash 3 failure omitted the script diagnostic'
cleanup_count=0
while IFS= read -r line; do
    [ "$line" = cleanup ] || fail 'unexpected cleanup output'
    cleanup_count=$((cleanup_count + 1))
done < "$CLEANUP_LOG"
[ "$cleanup_count" -eq 5 ] || fail 'cleanup did not run once for each exit'
checks=$((checks + 1))

version=$($shell -c 'printf "%s" "$BASH_VERSION"')
if [[ "$version" == 3.* ]]; then
    expect_status 0 'unsafe unbound variable reproduces Bash 3 false success' "$shell" unsafe.sh
    [[ $(< "$fixture/output") == *injected_unbound* ]] || fail 'unsafe control did not reach nounset'
    expect_status 1 'empty array fails closed on Bash 3' "$shell" guarded.sh empty-array
else
    printf 'SKIP: unsafe false-success and empty-array reproduction require /bin/bash 3.x; selected %s %s\n' "$shell" "$version"
fi

# Cover split/long options, every replacement trap, named actions, and heredoc data.
cp guarded.sh split.sh
awk 'NR == 1 { print "set -o errexit"; print "set -o nounset"; next } { print }' guarded.sh > split.sh
git add split.sh
expect_status 0 'split long strict options accepted with guard' "$shell" "$root/scripts/check-shell-exit-guards.sh"
printf '\ntrap true EXIT\n' >> split.sh
expect_status 1 'unsafe replacement trap refused' "$shell" "$root/scripts/check-shell-exit-guards.sh"
git rm --cached -f -q split.sh
printf '%s\n' 'set -e' 'set -u' 'trap true 0' > split.sh
git add split.sh
expect_status 1 'split short options and EXIT alias refused' "$shell" "$root/scripts/check-shell-exit-guards.sh"
git rm --cached -q split.sh
cat > inline.sh <<'SH'
set -e; set -u; trap 'true' EXIT; echo after
SH
git add inline.sh
expect_status 1 'inline unsafe trap refused' "$shell" "$root/scripts/check-shell-exit-guards.sh"
git rm --cached -q inline.sh
cp guarded.sh replacement.sh
printf '\ntrap true ERR\ntrap true EXIT\n' >> replacement.sh
git add replacement.sh
expect_status 1 'signal trap does not hide later unsafe EXIT trap' "$shell" "$root/scripts/check-shell-exit-guards.sh"
git rm --cached -q replacement.sh
awk '
    /^trap / { sub(/^trap /, "cleanup() {\n", $0) }
    /^exit "\$status"/ { print "exit \"$status\"\n}\ntrap cleanup EXIT"; next }
    { print }
' guarded.sh | tr -d "'" > named.sh
git add named.sh
expect_status 0 'named guarded action accepted' "$shell" "$root/scripts/check-shell-exit-guards.sh"
git rm --cached -q named.sh
cat > data.sh <<'SH'
set -euo pipefail
# trap true EXIT is only documentation.
cat <<'DATA'
trap true EXIT
DATA
SH
git add data.sh
expect_status 0 'comments and heredoc bodies ignored' "$shell" "$root/scripts/check-shell-exit-guards.sh"

# Copy the real top-level trap and suffix, replacing the preceding operations with
# harmless fixture variables. Nounset fires immediately after installation, before
# any command in the copied placement or release body can run.
for script in place-ck-mc release; do
    copy="$fixture/$script.sh"
    printf 'set -euo pipefail\nfinished=0\ntmp=%q\n' "$fixture/placement-tmp" > "$copy"
    : > "$fixture/placement-tmp"
    awk '
        /^trap / && !copying { copying=1 }
        copying { print }
        copying && !injected && /\047 EXIT$/ {
            print "unset injected_unbound; : \"${injected_unbound}\""
            injected=1
        }
        END { if (!injected) exit 1 }
    ' "$root/scripts/$script.sh" >> "$copy"
    expect_status 1 "$script copied trap rejects injected unbound variable" "$shell" "$copy"
    [[ $(< "$fixture/output") == *injected_unbound* ]] || fail "$script injection did not run"
    if [ "$script" = place-ck-mc ]; then
        [ ! -e "$fixture/placement-tmp" ] || fail 'placement cleanup did not run'
    fi
done
printf '%s %s: %s shell EXIT guard checks passed\n' "$shell" "$version" "$checks"
finished=1
