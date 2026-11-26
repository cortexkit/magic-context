#!/usr/bin/env bash
# Compare database schema versions before replacement, and render-format epoch
# constants (versions of cached prompt formats) when both revisions declare them.
set -euo pipefail
finished=0
umask 077

usage() { echo "usage: $0 [--dry-run] [--no-restart] [--require-epochs-unchanged] [--tool-pins-reviewed] [--tool-schemas-changed] [--source-ref REF] STAGED_BINARY" >&2; exit 2; }
die() { echo "place-ck-mc: $*" >&2; exit 1; }
dry_run=0
# --no-restart places and checks the file and stops there. It is for a window in
# which the subc daemon itself is replaced, which restarts every module anyway, so
# ck-mc restarts once instead of twice. Nothing here waits for that restart: the
# script prints the provenance and health commands to run once it has happened.
no_restart=0
require_epochs=0
# A running session keeps the ctx_* tool schemas it started with until its host
# restarts it, and ck-mc refuses a call pinned to a schema it no longer honours.
# --tool-schemas-changed places a build that drops a pin anyway: only inside an
# agreed host-restart window. --tool-pins-reviewed places over a deployed build
# too old to report its pins, after comparing them by hand.
tool_pins_reviewed=0
tool_schemas_changed=0
source_ref=
staged=
shared_staging=${CK_STAGING:-$HOME/.local/share/cortexkit/staging}
while (($#)); do
    case "$1" in
        --dry-run) dry_run=1 ;;
        --no-restart) no_restart=1 ;;
        --require-epochs-unchanged) require_epochs=1 ;;
        --tool-pins-reviewed) tool_pins_reviewed=1 ;;
        --tool-schemas-changed) tool_schemas_changed=1 ;;
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
previous_store_name=mode3.db
current_store_name=sessions.db
fence_pattern='^context\.db=([0-9]+)[[:space:]]([a-z0-9]+\.db)=([0-9]+)$'
[[ "$fences" =~ $fence_pattern ]] || die "invalid --print-fences output: $fences"
context_supported=${BASH_REMATCH[1]}
store_name=${BASH_REMATCH[2]}
store_supported=${BASH_REMATCH[3]}
[[ "$store_name" == "$current_store_name" || "$store_name" == "$previous_store_name" ]] ||
    die "invalid --print-fences output: $fences"
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
data_dir=$(dirname "$context_path")
previous_store="$data_dir/$previous_store_name"
current_default="$data_dir/$current_store_name"
current_store=${MAGIC_CONTEXT_SESSIONS_STORE:-$current_default}
present() { [[ -e "$1" || -L "$1" ]]; }
if [[ "$current_store" != "$current_default" ]]; then
    override_previous="$(dirname "$current_store")/$previous_store_name"
    if present "$previous_store" || present "$override_previous" || [[ "$store_name" == "$previous_store_name" ]]; then
        die "unset MAGIC_CONTEXT_SESSIONS_STORE before switching session store names; the two builds must use the same data directory"
    fi
fi
if present "$previous_store" && present "$current_default"; then
    die "both $previous_store and $current_default exist; determine which holds the session state before placing"
fi
target_store=$current_store
other_store=$previous_store
if [[ "$store_name" == "$previous_store_name" ]]; then
    target_store=$previous_store
    other_store=$current_store
fi
rename_from=
store_path=$target_store
if present "$other_store"; then
    rename_from=$other_store
    store_path=$rename_from
    ((no_restart == 0)) || die "--no-restart cannot rename $rename_from to $target_store: the old process would keep running with the store open under the old name"
fi
read_version() (
    local path=$1 sql=$2 value
    local scratch="" finished=0
    [[ -f "$path" ]] || die "missing live store: $path"
    if present "$path-wal" && { ((dry_run)) || [[ -n "$rename_from" ]] || ! present "$path-shm"; }; then
        # Even a read-only WAL connection can create shared memory. Inspect a
        # disposable copy instead; preflight must not create a sidecar.
        scratch=$(mktemp -d) || die "cannot make a temporary schema probe"
        trap 'status=$?
        if [ "$status" -eq 0 ] && [ "${finished:-0}" != 1 ]; then
            printf "%s\n" "$0: exited before successful completion" >&2
            status=1
        fi
        rm -rf "$scratch" || { cleanup_status=$?; [ "$status" -ne 0 ] || status=$cleanup_status; }
        exit "$status"' EXIT
        cp "$path" "$scratch/store.db" && cp "$path-wal" "$scratch/store.db-wal" ||
            die "cannot copy $path and its WAL for a read-only schema probe"
        path=$scratch/store.db
    fi
    # With no WAL every committed page is in the main file. An immutable
    # reader can check it without creating any SQLite sidecars.
    if present "$path-wal"; then
        value=$(sqlite3 -readonly "$path" "$sql") || die "cannot read schema version from $path"
    else
        value=$(sqlite3 "file:$path?immutable=1" "$sql") || die "cannot read schema version from $path"
    fi
    [[ "$value" =~ ^[0-9]+$ ]] || die "invalid schema version from $path: $value"
    printf '%s\n' "$value"
    finished=1
)
context_live=$(read_version "$context_path" 'SELECT COALESCE(MAX(version), 0) FROM schema_migrations;')
store_live=0
if present "$store_path"; then
    store_live=$(read_version "$store_path" 'PRAGMA user_version;')
fi
echo "context.db: live=$context_live staged=$context_supported; $store_name: live=$store_live staged=$store_supported"
((10#$context_supported >= 10#$context_live)) || die "rollback refused: context.db live=$context_live staged=$context_supported; $store_name live=$store_live staged=$store_supported"
# Up to version 105 the standalone plugin migrated context.db, and ck-mc
# opened it only at exactly the version it was built for: placing such a
# build over an older database would leave it refusing to start. From 106 on
# ck-mc migrates the store itself when it starts, from the released 0.49
# plugin's version (95) up, so a newer build may be placed over an older store.
last_plugin_version=105
released_plugin_version=95
if ((10#$context_supported <= last_plugin_version)); then
    ((10#$context_live == 10#$context_supported)) || die "context.db is at $context_live but this ck-mc opens only $context_supported: start a host with the matching plugin release to migrate it first"
else
    ((10#$context_live >= released_plugin_version)) || die "context.db is at $context_live; ck-mc migrates only from $released_plugin_version, the released 0.49 plugin's version: open it once with Magic Context 0.49 first"
    ((10#$context_live == 10#$context_supported)) || echo "context.db: ck-mc migrates it from $context_live to $context_supported when it starts"
fi
((10#$store_supported >= 10#$store_live)) || die "rollback refused: context.db live=$context_live staged=$context_supported; $store_name live=$store_live staged=$store_supported"

bin_dir=$HOME/.local/share/cortexkit/bin
deployed=$bin_dir/ck-mc
[[ -f "$deployed" && -x "$deployed" ]] || die "missing deployed ck-mc: $deployed"
deployed_sha=$(sha_from "$deployed")
deployed_fences=$("$deployed" --print-fences) || die "deployed binary does not report supported fences"
[[ "$deployed_fences" =~ $fence_pattern ]] || die "invalid deployed --print-fences output: $deployed_fences"
deployed_store_name=${BASH_REMATCH[2]}
if [[ "$deployed_store_name" == store.db ]]; then
    echo "deployed build uses the old store.db; old store.db isn't checked for this placement (left untouched)"
elif [[ "$deployed_store_name" != "$current_store_name" && "$deployed_store_name" != "$previous_store_name" ]]; then
    die "invalid deployed --print-fences output: $deployed_fences"
fi
# Every pin the deployed build serves must still be honoured by the staged one
# (same tool, semantics and schema digest), or running sessions' calls to that
# tool are refused. An older build without --print-tool-pins would start
# serving on the unknown flag, so it is only asked when its revision contains
# the commit that added the flag. (Searching the binary for the flag's text
# doesn't work: the compiler turns a short string comparison into integer
# compares and keeps no copy of the text.)
tool_pins_commit=${PLACE_CK_MC_TOOL_PINS_COMMIT:-9bcd6e7de3a991c1b1d232ca092cf26ade870bc8}
staged_pins=$("$staged" --print-tool-pins) || die "staged binary does not report its tool pins"
[[ -n "$staged_pins" ]] || die "staged binary reports no tool pins"
if git merge-base --is-ancestor "$tool_pins_commit" "$deployed_sha" 2>/dev/null; then
    deployed_pins=$("$deployed" --print-tool-pins) || die "deployed binary does not report its tool pins"
    dropped=$(python3 - "$deployed_pins" "$staged_pins" <<'PY'
import sys
deployed, staged = sys.argv[1], sys.argv[2]
honoured = {tuple(line.split()[:3]) for line in staged.splitlines() if line.strip()}
for line in deployed.splitlines():
    fields = line.split()
    if len(fields) == 4 and fields[3] == "current" and tuple(fields[:3]) not in honoured:
        print(" ".join(fields[:3]))
PY
) || die "cannot compare tool pins"
    if [[ -n "$dropped" ]]; then
        echo "tool pins the deployed build serves and the staged build no longer honours:" >&2
        echo "$dropped" >&2
        ((tool_schemas_changed)) || die "running sessions' calls to these tools would be refused until their hosts restart: honour the old pins (HONOURED_EARLIER in crates/mc-module/src/catalog.rs) or place with --tool-schemas-changed in a host-restart window"
        echo "placing with changed tool schemas (--tool-schemas-changed)"
    else
        echo "tool pins: every pin the deployed build serves is honoured"
    fi
else
    ((tool_pins_reviewed)) || die "deployed build can't report its tool pins: compare the ctx_* tool schemas of both builds by hand, then pass --tool-pins-reviewed"
    echo "tool pins: deployed build predates --print-tool-pins; compared by hand (--tool-pins-reviewed)"
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
if [[ -n "$rename_from" ]]; then
    # A binary-only rollback would reopen the wrong file name. Let placement
    # stop the module and switch the store name back with the binary.
    printf -v rollback_cmd 're-place the rollback binary %q using this script (reconcile the shared staging declaration first, if needed)' "$rollback"
fi
if ((dry_run)); then
    echo "dry-run: would preserve $deployed as $rollback (without overwriting)"
    if [[ -n "$rename_from" ]]; then
        echo "dry-run: would stop magic-context, wait for its PID to exit and store handles to close, rename $rename_from to $target_store (with any -wal and -shm files), atomically place $staged, start magic-context and verify inode/version/digest/health"
    elif ((no_restart)); then
        echo "dry-run: no store rename needed; would atomically place $staged and verify it on disk without restarting"
    else
        echo "dry-run: no store rename needed; would atomically place $staged, restart magic-context, verify inode/version/digest/health"
    fi
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
poll_seconds=${PLACE_CK_MC_POLL_SECONDS:-2}
module_pid() {
    local data
    data=$(ck --json provenance magic-context) || return 2
    python3 -c '
import json, sys
modules = json.load(sys.stdin)["modules"]
if not isinstance(modules, list):
    sys.exit("invalid module list")
for module in modules:
    if module["module_id"] == "magic-context":
        observed = module["daemon_observed"]
        if observed is None:
            pid = None
        elif "pid" in observed:
            pid = observed["pid"]
        elif observed.get("running_image", {}).get("status") == "unavailable":
            pid = None
        else:
            sys.exit("missing magic-context PID or stopped state")
        if pid is not None:
            if type(pid) is not int or pid < 1:
                sys.exit("invalid magic-context PID")
            print(pid)
        break
else:
    sys.exit("missing magic-context module entry")' <<< "$data" || return 3
}
stores_are_closed() {
    local path suffix output status=0
    local paths=()
    for path in "$context_path" "$previous_store" "$current_store"; do
        for suffix in '' -wal -shm .lock; do
            if present "$path$suffix"; then paths+=("$path$suffix"); fi
        done
    done
    ((${#paths[@]})) || { echo "no store files found to check"; return 1; }
    output=$(lsof -nP -Fpcn -- "${paths[@]}" 2>&1) || status=$?
    # lsof exits 1 without output when no process holds any named file. A
    # warning, inability to inspect, or an actual holder cannot prove that.
    if [[ "$status" == 1 && -z "$output" ]]; then return 0; fi
    printf 'store handles could not be ruled out (lsof exit %s): %s\n' "$status" "$output"
    return 1
}
start_original() {
    ck module start magic-context || echo "place-ck-mc: could not start the original magic-context; run ck module start magic-context" >&2
}
wait_stopped() {
    local before=$1 detail holders
    for _ in $(seq 1 60); do
        detail=
        if [[ -n "$before" ]] && ! process_is_gone "$before"; then
            detail="cannot confirm magic-context PID $before exited"
        fi
        if ! holders=$(stores_are_closed); then detail="${detail:+$detail; }$holders"; fi
        [[ -n "$detail" ]] || return 0
        sleep "$poll_seconds"
    done
    echo "$detail"
    return 1
}
process_is_gone() {
    local pid_info status=0
    pid_info=$(ps -p "$1" -o pid= 2>&1) || status=$?
    [[ "$status" == 1 && -z "$pid_info" ]]
}
check_for_restarted_module() {
    local observed pid_info status=0
    observed=$(module_pid 2>/dev/null) || status=$?
    if [[ "$status" == 2 ]]; then
        echo "post-stop provenance command failed; using the process and store handle checks"
    elif [[ "$status" == 3 ]]; then
        echo "post-stop provenance returned an unrecognized reply; using the process and store handle checks"
    elif [[ -z "$observed" ]]; then
        echo "post-stop provenance did not report a PID"
    elif pid_info=$(ps -p "$observed" -o pid= 2>/dev/null) && [[ "$pid_info" =~ ^[[:space:]]*$observed[[:space:]]*$ ]]; then
        echo "daemon reported a live magic-context PID $observed after stop"
        return 1
    else
        echo "post-stop provenance reported PID $observed but the process check did not find it alive"
    fi
}
place_with_rename() {
    local before detail suffix index moves=0
    local moved=()
    before=$(module_pid) || die "cannot identify the running magic-context process before renaming the session store"
    # Do not run ck module rescan or restart the daemon between stop and start.
    if ! ck module stop magic-context; then
        start_original
        die "cannot stop magic-context; session store and binary left in place"
    fi
    if ! detail=$(wait_stopped "$before"); then
        start_original
        die "timed out waiting for magic-context to stop; session store and binary left in place: $detail"
    fi
    for suffix in '' -wal -shm; do
        if present "$target_store$suffix"; then
            start_original
            die "cannot rename the session store: target already exists: $target_store$suffix"
        fi
    done
    if [[ ! -f "$rename_from" ]] || ! cmp -s "$deployed" "$rollback"; then
        start_original
        die "the session store or deployed binary changed during placement; nothing was renamed"
    fi
    if ! store_live=$(read_version "$rename_from" 'PRAGMA user_version;') ||
        ((10#$store_supported < 10#$store_live)); then
        start_original
        die "cannot confirm the stopped session store at $rename_from is compatible with fence $store_supported; nothing was renamed"
    fi
    if ! detail=$(check_for_restarted_module); then
        die "session store and binary left in place: $detail"
    fi
    echo "$detail"
    if ! detail=$(stores_are_closed); then
        start_original
        die "session store and binary left in place: $detail"
    fi
    # Keep any committed pages still in the WAL. Move sidecars first and roll
    # back in reverse order if a move or the binary swap fails.
    for suffix in -wal -shm ''; do
        if ! present "$rename_from$suffix"; then
            [[ -n "$suffix" ]] && continue
            break
        fi
        if ! mv -n "$rename_from$suffix" "$target_store$suffix" || present "$rename_from$suffix"; then
            break
        fi
        moved[moves]=$suffix
        moves=$((moves + 1))
        if [[ -z "$suffix" ]]; then
            if [[ ! -f "$target_store" ]] || present "$rename_from"; then
                echo "place-ck-mc: could not verify the renamed session store at $target_store" >&2
            elif ! detail=$(stores_are_closed); then
                echo "place-ck-mc: cannot place the binary after renaming $target_store: $detail" >&2
            elif mv -f "$tmp" "$deployed"; then
                echo "renamed $rename_from to $target_store and placed ck-mc while magic-context was stopped"
                return 0
            fi
        fi
    done
    for ((index=moves - 1; index >= 0; index--)); do
        suffix=${moved[index]}
        mv -n "$target_store$suffix" "$rename_from$suffix" && ! present "$target_store$suffix" ||
            die "cannot restore $rename_from$suffix from $target_store$suffix; magic-context is stopped; restore the original store files before starting it"
    done
    # The swap is atomic. Verify the original survived the failure, or put
    # the verified rollback copy back before letting the daemon open the store.
    if ! cmp -s "$deployed" "$rollback"; then
        cp -p "$rollback" "$tmp" && mv -f "$tmp" "$deployed" && cmp -s "$deployed" "$rollback" ||
            die "cannot restore $rollback to $deployed; magic-context is stopped; restore the original binary before starting it"
    fi
    start_original
    die "session store rename or binary swap failed; restored original store and binary"
}
if [[ -n "$rename_from" ]]; then
    place_with_rename
else
    mv -f "$tmp" "$deployed"
fi
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
if [[ -n "$rename_from" ]]; then
    ck module start magic-context
else
    ck module restart magic-context
fi
# The restart returns while the old process drains, before the new one has declared its
# build. Wait for the new process to report a build instead of reading a half-started state.
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
echo "placed ck-mc $staged_sha; context.db $context_live/$context_supported $store_name $store_live/$store_supported; inode/version/digest/health ok"
finished=1
