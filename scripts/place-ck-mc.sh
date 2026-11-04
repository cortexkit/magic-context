#!/usr/bin/env bash
# Compare database schema versions before replacement, and render-format epoch
# constants (versions of cached prompt formats) when both revisions declare them.
set -euo pipefail
finished=0
umask 077

usage() { echo "usage: $0 [--dry-run] [--no-restart] [--require-epochs-unchanged] [--source-ref REF] STAGED_BINARY" >&2; exit 2; }
die() { echo "place-ck-mc: $*" >&2; exit 1; }
dry_run=0
# --no-restart places and checks the file and stops there. It is for a window in
# which the subc daemon itself is replaced, which restarts every module anyway, so
# ck-mc restarts once instead of twice. Nothing here waits for that restart: the
# script prints the provenance and health commands to run once it has happened.
no_restart=0
require_epochs=0
source_ref=
staged=
shared_staging=${CK_STAGING:-$HOME/.local/share/cortexkit/staging}
while (($#)); do
    case "$1" in
        --dry-run) dry_run=1 ;;
        --no-restart) no_restart=1 ;;
        --require-epochs-unchanged) require_epochs=1 ;;
        --source-ref) (($# >= 2)) || usage; source_ref=$2; shift ;;
        --*) usage ;;
        *) [[ -z "$staged" ]] || usage; staged=$1 ;;
    esac
    shift
done
[[ -n "$staged" && -f "$staged" && -x "$staged" ]] || die "staged binary must exist and be executable: $staged"
# Resolve before changing directories; later copies must use exactly the inspected bytes.
staged=$(cd "$(dirname "$staged")" && pwd -P)/$(basename "$staged")
staged_digest=$(shasum -a 256 "$staged" | cut -d' ' -f1)
root=$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)
cd "$root"

codesign --verify --strict "$staged" >/dev/null 2>&1 || die "invalid staged code signature"
signature=$(codesign -dv --verbose=2 "$staged" 2>&1) || die "cannot read staged signature"
[[ "$signature" == *$'\nIdentifier=ck-mc\n'* ]] || die "staged signature identifier is not ck-mc"
# Hardened runtime is what stops another same-user process attaching a debugger to
# read the module's launch code. Sign with `codesign --force --sign - --options runtime
# --identifier ck-mc`; a build without it, or with get-task-allow, is refused.
require_hardened() {
    local sig
    sig=$(codesign -dv --verbose=2 "$1" 2>&1) || die "cannot read signature of $1"
    [[ "$sig" =~ flags=0x[[:xdigit:]]+\(([^\)]*)\) && ",${BASH_REMATCH[1]}," == *,runtime,* ]] ||
        die "$1 is not signed with hardened runtime (re-sign with --options runtime)"
    # Read the entitlements first, then match: a negated `codesign | grep -q` under
    # pipefail would pass a binary that HAS get-task-allow whenever grep exits on
    # its match before codesign finishes writing (codesign gets SIGPIPE).
    local entitlements
    entitlements=$(codesign -d --entitlements - "$1" 2>/dev/null || true)
    [[ "$entitlements" != *get-task-allow* ]] ||
        die "$1 carries the get-task-allow entitlement"
}
require_hardened "$staged"
# A release build strips its debug info with rust-objcopy. When that step fails,
# cargo only prints a warning and the build still succeeds, so a binary still
# carrying debug-map (STABS) entries means the strip silently failed: the binary
# works, but it's larger and carries this machine's build paths. Count before
# matching, so an nm failure can't read as zero.
require_stripped() {
    local symbols debug_entries
    symbols=$(nm -a "$1" 2>/dev/null) || die "cannot list symbols of $1"
    debug_entries=$(awk '$2 == "-"' <<<"$symbols" | wc -l | tr -d ' ')
    ((debug_entries == 0)) ||
        die "$1 carries $debug_entries debug-map entries: its debug-info strip failed (rebuild without the failing rustc wrapper)"
}
require_stripped "$staged"
sha_from() {
    local line sha
    line=$("$1" --version) || die "cannot read $1 --version"
    [[ "$line" =~ ^ck-mc[[:space:]]+[^[:space:]]+[[:space:]]+\(([[:xdigit:]]{40})\)$ ]] || die "invalid full build SHA in $1 --version: $line"
    sha=${BASH_REMATCH[1]}
    printf '%s\n' "$sha"
}
staged_sha=$(sha_from "$staged")
# Resolve without creating the directory: a refused or dry-run placement must not
# leave a staging directory behind. place-module.sh reads these declarations from
# both the staging root and the directory containing it.
shared_staging=$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$shared_staging")
shared_stage="$shared_staging/ck-mc.${staged_sha:0:8}"
check_shared_declarations() {
    local candidate actual
    local expected
    expected=$(printf '%s\n%s' "$shared_stage" "$staged_sha")
    for candidate in \
        "$(dirname "$shared_staging")/magic-context.current" \
        "$(dirname "$shared_staging")/ck-magic-context.current" \
        "$shared_staging/ck-magic-context.current"; do
        [[ -f "$candidate" ]] || continue
        grep -q '^stage=' "$candidate" 2>/dev/null || continue
        # Match the consumer: only stage and revision determine whether two
        # declarations agree; declared_at is informational.
        actual=$(awk -F= '$1 == "stage" || $1 == "revision" { print $2 }' "$candidate")
        [[ "$actual" == "$expected" ]] ||
            die "another magic-context currency declaration disagrees: $candidate (remove or reconcile it before placing)"
    done
}
check_shared_declarations
publish_shared_stage() (
    set -euo pipefail
    finished=0
    local card_name card sidecar
    local card_tmp="" sidecar_tmp="" manifest_tmp="" card_digest declared_at
    trap 'status=$?
    if [ "$status" -eq 0 ] && [ "${finished:-0}" != 1 ]; then
        printf "%s\n" "$0: exited before successful completion" >&2
        status=1
    fi
    rm -f "$card_tmp" "$sidecar_tmp" "$manifest_tmp" || { cleanup_status=$?; [ "$status" -ne 0 ] || status=$cleanup_status; }
    exit "$status"' EXIT
    card_name=$(basename "$shared_stage")
    card="$shared_staging/$card_name"
    sidecar="$card.sha256"
    mkdir -p "$shared_staging"

    # Copy the verified destination bytes; signing here would change the artifact
    # after placement and invalidate the identity checked by the restart gates.
    card_tmp=$(mktemp "$shared_staging/.ck-mc.XXXXXXXX") || die "cannot make shared staging temp"
    cp -p "$deployed" "$card_tmp" || die "cannot copy placed binary into shared staging"
    cmp -s "$deployed" "$card_tmp" || die "shared staging copy differs from placed binary"
    card_digest=$(shasum -a 256 "$card_tmp" | awk '{print $1}')
    [[ "$card_digest" == "$staged_digest" ]] || die "shared staging copy digest differs from verified placement"
    mv -f "$card_tmp" "$card"
    card_tmp=""
    cmp -s "$deployed" "$card" || die "shared staging card differs from placed binary"

    sidecar_tmp=$(mktemp "$shared_staging/.ck-mc.sha256.XXXXXXXX") || die "cannot make shared sidecar temp"
    printf '%s  %s\n' "$card_digest" "$card_name" > "$sidecar_tmp"
    mv -f "$sidecar_tmp" "$sidecar"
    sidecar_tmp=""
    (cd "$shared_staging" && shasum -a 256 -c "$(basename "$sidecar")" >/dev/null) ||
        die "shared staging sidecar does not verify its card"

    declared_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    manifest_tmp=$(mktemp "$shared_staging/.magic-context.current.XXXXXXXX") || die "cannot make shared declaration temp"
    printf 'stage=%s\nrevision=%s\ndeclared_at=%s\n' \
        "$card" "$staged_sha" "$declared_at" > "$manifest_tmp"
    mv -f "$manifest_tmp" "$shared_staging/magic-context.current"
    manifest_tmp=""
    finished=1
)
if [[ -n "$source_ref" ]]; then
    source_sha=$(git rev-parse --verify "${source_ref}^{commit}") || die "unknown source ref: $source_ref"
    [[ "$staged_sha" == "$source_sha" ]] || die "staged SHA $staged_sha differs from source $source_sha"
else
    echo "staged build SHA: $staged_sha (compare with the build source; use --source-ref REF to enforce)"
fi
fences=$("$staged" --print-fences) || die "staged binary does not report supported fences"
[[ "$fences" =~ ^context\.db=([0-9]+)[[:space:]]mode3\.db=([0-9]+)$ ]] || die "invalid --print-fences output: $fences"
context_supported=${BASH_REMATCH[1]}
store_supported=${BASH_REMATCH[2]}
context_path=$(python3 - <<'PY'
import os
from pathlib import Path
def value(name):
    return os.environ.get(name, "").strip()
if os.environ.get("MAGIC_CONTEXT_DB"):
    path = Path(os.environ["MAGIC_CONTEXT_DB"])
else:
    if value("MAGIC_CONTEXT_TEST_DATA_DIR"):
        directory = Path(value("XDG_DATA_HOME") or value("MAGIC_CONTEXT_TEST_DATA_DIR")) / "cortexkit/magic-context"
    elif value("MAGIC_CONTEXT_STORAGE_DIR"):
        directory = Path(value("MAGIC_CONTEXT_STORAGE_DIR"))
    elif value("XDG_DATA_HOME"):
        directory = Path(value("XDG_DATA_HOME")) / "cortexkit/magic-context"
    else:
        directory = Path.home() / ".local/share/cortexkit/magic-context"
    path = directory / "context.db"
print(path)
PY
)
mode3_path=${MAGIC_CONTEXT_MODE3_STORE:-$(dirname "$context_path")/mode3.db}
read_version() {
    local path=$1 sql=$2 value
    [[ -f "$path" ]] || die "missing live store: $path"
    # A WAL-mode store closed cleanly has no -wal/-shm files, and a read-only
    # connection cannot create them (SQLITE_CANTOPEN). With no -wal file every
    # committed page is in the main file, so an immutable read sees the same data.
    if ! value=$(sqlite3 -readonly "$path" "$sql" 2>/dev/null); then
        [[ ! -e "$path-wal" ]] || die "cannot read schema version from $path"
        value=$(sqlite3 "file:$path?immutable=1" "$sql") || die "cannot read schema version from $path"
    fi
    [[ "$value" =~ ^[0-9]+$ ]] || die "invalid schema version from $path: $value"
    printf '%s\n' "$value"
}
context_live=$(read_version "$context_path" 'SELECT COALESCE(MAX(version), 0) FROM schema_migrations;')
store_live=0
if [[ -e "$mode3_path" ]]; then
    store_live=$(read_version "$mode3_path" 'PRAGMA user_version;')
fi
echo "context.db: live=$context_live staged=$context_supported; mode3.db: live=$store_live staged=$store_supported"
((10#$context_supported >= 10#$context_live)) || die "rollback refused: context.db live=$context_live staged=$context_supported; mode3.db live=$store_live staged=$store_supported"
# ck-mc opens context.db only at exactly the version it was built for; the
# standalone plugin migrates it. Placing it over an older database would leave
# it refusing to start.
((10#$context_live == 10#$context_supported)) || die "context.db is at $context_live but this ck-mc opens only $context_supported: start a host with the matching plugin release to migrate it first"
((10#$store_supported >= 10#$store_live)) || die "rollback refused: context.db live=$context_live staged=$context_supported; mode3.db live=$store_live staged=$store_supported"

bin_dir=$HOME/.local/share/cortexkit/bin
deployed=$bin_dir/ck-mc
[[ -f "$deployed" && -x "$deployed" ]] || die "missing deployed ck-mc: $deployed"
deployed_sha=$(sha_from "$deployed")
deployed_fences=$("$deployed" --print-fences) || die "deployed binary does not report supported fences"
if [[ "$deployed_fences" =~ ^context\.db=[0-9]+[[:space:]]store\.db=[0-9]+$ ]]; then
    echo "deployed build uses the old store.db; old store.db isn't checked for this placement (left untouched)"
elif [[ ! "$deployed_fences" =~ ^context\.db=[0-9]+[[:space:]]mode3\.db=[0-9]+$ ]]; then
    die "invalid deployed --print-fences output: $deployed_fences"
fi
# Require both build revisions locally; guessing an unavailable epoch could hide a change.
epochs() {
    git show "$1:crates/mc-module/src/lib.rs" | python3 -c '
import re, sys
source = sys.stdin.read()
names = ("PROFILE_EPOCH_CLAUDE_CODE_ANTHROPIC", "TAGGER_FEATURE_EPOCH", "MEMORY_RENDER_FORMAT_EPOCH", "COMPARTMENT_RENDER_FORMAT_EPOCH")
if any(not re.search(r"pub const " + name + r": u32 = (\d+);", source) for name in names):
    sys.exit(0)
for name in names:
    matches = re.findall(r"pub const " + name + r": u32 = (\d+);", source)
    if len(matches) != 1:
        sys.exit("missing or ambiguous epoch: " + name)
    print(name + "=" + matches[0])
'
}
old_epochs=$(epochs "$deployed_sha") || die "cannot read deployed epochs from git $deployed_sha"
new_epochs=$(epochs "$staged_sha") || die "cannot read staged epochs from git $staged_sha"
if [[ -z "$old_epochs" || -z "$new_epochs" ]]; then
    missing_side="deployed ($deployed_sha)"
    [[ -n "$new_epochs" ]] || missing_side="staged ($staged_sha)"
    [[ -n "$old_epochs" || -n "$new_epochs" ]] || missing_side="both deployed ($deployed_sha) and staged ($staged_sha)"
    echo "render-epoch check does not apply: $missing_side lacks the render-epoch constants; skipping"
    if ((require_epochs)) && [[ -n "$old_epochs" || -n "$new_epochs" ]]; then
        die "--require-epochs-unchanged refused: $missing_side lacks the render-epoch constants, while the other revision has them"
    fi
else
echo "epoch diff ($deployed_sha -> $staged_sha):"
python3 - "$old_epochs" "$new_epochs" <<'PY'
import sys
old = dict(line.split('=') for line in sys.argv[1].splitlines())
new = dict(line.split('=') for line in sys.argv[2].splitlines())
for key in old:
    print(f"  {key}: {old[key]} -> {new[key]}" + (" CHANGED" if old[key] != new[key] else ""))
PY
[[ "$old_epochs" == "$new_epochs" || "$require_epochs" -eq 0 ]] || die "epochs changed; pre-announce before placing"
fi
rollback=$bin_dir/staging/ck-mc.rollback.$deployed_sha
printf -v rollback_cmd 'cp %q %q && ck module restart magic-context' "$rollback" "$deployed"
if ((dry_run)); then
    echo "dry-run: would preserve $deployed as $rollback (without overwriting), atomically place $staged, restart magic-context, verify inode/version/digest/health"
    finished=1
    exit 0
fi
[[ "$staged" != "$deployed" ]] || die "staged path is the deployed binary"
mkdir -p "$bin_dir/staging"
if [[ -e "$rollback" ]]; then
    cmp -s "$deployed" "$rollback" || die "existing rollback $rollback differs from deployed binary"
else
    # cp -n prevents a racing placement from replacing a rollback for this SHA.
    cp -pn "$deployed" "$rollback" || die "cannot preserve rollback $rollback"
    cmp -s "$deployed" "$rollback" || die "rollback copy differs from deployed binary"
fi
[[ $(shasum -a 256 "$staged" | cut -d' ' -f1) == "$staged_digest" ]] || die "staged binary changed since preflight"
tmp=$(mktemp "$bin_dir/.ck-mc.XXXXXXXX") || die "cannot make placement temp"
trap 'status=$?
if [ "$status" -eq 0 ] && [ "${finished:-0}" != 1 ]; then
    printf "%s\n" "$0: exited before successful completion" >&2
    status=1
fi
rm -f "$tmp" || { cleanup_status=$?; [ "$status" -ne 0 ] || status=$cleanup_status; }
exit "$status"' EXIT
cp -p "$staged" "$tmp"
[[ $(shasum -a 256 "$tmp" | cut -d' ' -f1) == "$staged_digest" ]] || die "staged binary changed during placement"
mv -f "$tmp" "$deployed"
trap 'echo "placement verification failed; rollback binary only when both stores are compatible: $rollback_cmd" >&2' ERR
if ((no_restart)); then
    [[ "$(sha_from "$deployed")" == "$staged_sha" ]] || false
    [[ "$(shasum -a 256 "$deployed" | cut -d' ' -f1)" == "$staged_digest" ]] || false
    require_hardened "$deployed"
    trap - ERR
    publish_shared_stage
    echo "placed ck-mc $staged_sha on disk without restarting; the running module still uses the previous build until magic-context restarts. Verify after that restart: ck --json provenance magic-context (build $staged_sha) and ck --json health magic-context. Rollback: $rollback_cmd"
    finished=1
    exit 0
fi
ck module restart magic-context
# The restart returns while the old process drains, before the new one has declared its
# build. Wait for the new process to report a build instead of reading a half-started state.
poll_seconds=${PLACE_CK_MC_POLL_SECONDS:-2}
running=""
for _ in $(seq 1 60); do
    provenance=$(ck --json provenance magic-context 2>/dev/null) || provenance=""
    running=$(printf '%s' "$provenance" | python3 -c 'import json,sys
try:
    x = json.load(sys.stdin)
    m = next(m for m in x["modules"] if m["module_id"] == "magic-context")
    print(m["daemon_observed"]["pid"], m["module_declared"]["build"]["build_git_sha"])
except (KeyError, StopIteration, TypeError, ValueError):
    pass' || true)
    [[ -n "$running" && "${running#* }" == "$staged_sha" ]] && break
    sleep "$poll_seconds"
done
[[ -n "$running" ]] || { echo "magic-context did not declare a build after the restart" >&2; false; }
read -r pid running_sha <<< "$running"
[[ "$pid" =~ ^[0-9]+$ && "$running_sha" == "$staged_sha" ]] || { echo "running build $running_sha does not match staged $staged_sha" >&2; false; }
running_inode=$(lsof -nP -p "$pid" -a -d txt -F in | python3 -c '
import sys
inode = None
for line in sys.stdin:
    line = line.strip()
    if line.startswith("i"): inode = line[1:]
    if line.startswith("n") and line[1:] == sys.argv[1]:
        print(inode or "")
' "$deployed")
[[ "$running_inode" == "$(stat -f %i "$deployed")" ]] || { echo "running inode $running_inode differs from placed inode $(stat -f %i "$deployed")" >&2; false; }
[[ "$(sha_from "$deployed")" == "$staged_sha" ]] || false
[[ "$(shasum -a 256 "$deployed" | cut -d' ' -f1)" == "$staged_digest" ]] || false
# Check the placed file itself, not only the staged one: a later re-sign would strip it.
require_hardened "$deployed"
# Health reads "unknown" until the new process answers its first probe; allow it to settle.
health_ok=0
for _ in $(seq 1 30); do
    health=$(ck --json health magic-context 2>/dev/null) || health=""
    if printf '%s' "$health" | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("status") == "ok" else 1)' 2>/dev/null; then
        health_ok=1
        break
    fi
    sleep "$poll_seconds"
done
[[ $health_ok -eq 1 ]] || { echo "ck health is not ok after the restart" >&2; false; }
trap - ERR
publish_shared_stage
echo "placed ck-mc $staged_sha; context.db $context_live/$context_supported store.db $store_live/$store_supported; inode/version/digest/health ok"
finished=1
