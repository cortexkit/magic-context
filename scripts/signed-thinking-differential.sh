#!/usr/bin/env bash
# Compare the serialized request bytes from every audit pass, not only provider rejection verdicts.
set -euo pipefail

compare() {
    python3 - "$1" "$2" <<'PY'
import json
import pathlib
import sys

base_root, head_root = map(pathlib.Path, sys.argv[1:])
failed = False
compared = 0

def inventory(root, model_class):
    directory = root / model_class
    return {p.relative_to(directory).as_posix(): json.loads(p.read_text())
            for p in directory.rglob('*.json')}

def nonthinking(wire):
    # Rust already emits [role, block]; TS and Pi emit message carriers.
    if wire and isinstance(wire[0], dict):
        blocks = [(m['role'], b) for m in wire for b in m['content']]
    else:
        blocks = wire
    return json.dumps([[role, b] for role, b in blocks
            if b.get('type') not in ('thinking', 'reasoning', 'redacted_thinking', 'redacted_reasoning')], ensure_ascii=False, separators=(',', ':'))

def exception(name, model_class, old, new):
    parts = pathlib.PurePosixPath(name).parts
    if len(parts) != 5:
        return None
    host, scope, scenario, lane, file = parts
    if model_class == 'rejected':
        # Fixing the force latch lets these queued edits land on the next user turn instead of waiting for an unrelated bust.
        if (host == 'opencode-aisdk' and scope == 'primary' and scenario == 'mid-loop'
                and lane in ('DropFull', 'Caveman', 'Image')
                and file in ('pass-0017.default.json', 'pass-0017.strict.json')):
            return 'force-latch bookkeeping release (step-2 trigger control)'
        return None
    if (host in ('v1', 'v2', 'pi') and scope == 'primary' and scenario == 'cut-new-turn'
            and lane == 'prefix-cut-moved-by-a-compartment-rewrite-that-keeps-the-cached-pair'
            and file in ('pass-0014.default.json', 'pass-0014.strict.json')):
        return 'recorded cut on the new-turn defer pass (strict cut test)'
    if nonthinking(old['wire']) == nonthinking(new['wire']):
        if host == 'claude-code-anthropic' and scope == 'primary':
            return 'Claude Code completed-turn strip (strict Claude Code cases)'
        if host in ('v1', 'v2', 'pi') and scope == 'primary' and lane != 'reasoning-clearing-keep_reasoning_tokens-':
            return 'thinking-only companion strip re-gated on admitted edits (strict thinking assertion)'
    return None

inventories = {}
for model_class in ('rejected', 'prefix-bound'):
    base, head = inventory(base_root, model_class), inventory(head_root, model_class)
    inventories[model_class] = (base, head)
    if not base or not head:
        print(f'FAIL {model_class}: empty inventory; both revisions must contain the golden harness')
        failed = True
        continue
    for name in sorted(base.keys() - head.keys()):
        print(f'FAIL {model_class} missing {name}')
        failed = True
    baseline_fixtures = {str(pathlib.PurePosixPath(name).parent) for name in base}
    for name in sorted(head.keys() - base.keys()):
        if str(pathlib.PurePosixPath(name).parent) in baseline_fixtures:
            print(f'FAIL {model_class} extra pass in an existing fixture {name}')
            failed = True
        else:
            print(f'ADDITION {model_class} {name} (new fixture; strict oracle required)')
    print(f'INVENTORY {model_class}: base={len(base)} head={len(head)}')
if failed:
    print('Inventory FAILED; no wire bytes compared')
    sys.exit(1)

for model_class, (base, head) in inventories.items():
    for name in sorted(base.keys() & head.keys()):
        old, new = base[name], head[name]
        eligibility = new.get('eligibility', {})
        keys = ('defer', 'noBoundary', 'noParkedTrigger', 'validatingRecord')
        if (set(eligibility) != set(keys) or any(type(eligibility[k]) is not bool for k in keys)
                or type(new.get('identityEligible')) is not bool
                or new['identityEligible'] != all(eligibility.values())):
            print(f'FAIL {model_class} invalid HEAD eligibility {name}')
            failed = True
            continue
        if model_class == 'prefix-bound' and not new['identityEligible']:
            continue
        compared += 1
        # wireBytes contains the exact serialized request; eligibility fields are capture metadata, not provider bytes.
        old_bytes, new_bytes = old['wireBytes'], new['wireBytes']
        if old_bytes == new_bytes:
            continue
        allowed = exception(name, model_class, old, new)
        if allowed:
            print(f'EXCEPTION {model_class} {name}: {allowed}')
        else:
            print(f'FAIL {model_class} changed {name}')
            failed = True
print(f'Compared {compared} wire files; {"FAILED" if failed else "PASS"}')
sys.exit(1 if failed else 0)
PY
}

# Comparison-only mode tests missing passes, byte changes and exception rules without running the suites.
if [[ "${1:-}" == --compare-only && $# == 3 ]]; then
    compare "$2" "$3"
    exit
fi
if [[ $# != 1 ]]; then
    echo "usage: $0 <integration-merge-base>" >&2
    exit 2
fi
if [[ $(uname -s) != Linux ]]; then
    echo 'Run this build/test harness on Linux.' >&2
    exit 90
fi
root=$(git rev-parse --show-toplevel)
base=$(git rev-parse --verify "$1^{commit}")
git merge-base --is-ancestor "$base" HEAD || { echo 'baseline must be an ancestor of HEAD' >&2; exit 2; }
if [[ -n $(git status --porcelain --untracked-files=normal) ]]; then
    echo 'Commit the candidate before capturing a differential.' >&2
    exit 2
fi
scratch=$(mktemp -d "$root/.signed-thinking-differential.XXXXXX")
owned=false
cleanup() {
    local status=$?
    if $owned; then git -C "$root" worktree remove --force "$scratch/base" || status=1; fi
    rm -rf "$scratch"
    exit "$status"
}
trap cleanup EXIT
git worktree add --detach "$scratch/base" "$base"
owned=true
printf 'BASE %s\nHEAD %s\n' "$base" "$(git rev-parse HEAD)"
bun --version
cargo --version

capture() {
    local tree=$1 destination=$2 model mode
    (
        cd "$tree"
        bun install --frozen-lockfile
        for model in rejected prefix-bound; do
            local id=claude-opus-5-5
            if [[ $model == rejected ]]; then id=claude-opus-4-6; fi
            for mode in default strict; do
                export MC_AUDIT_MODEL=$id MC_AUDIT_GOLDEN="$destination/$model"
                unset MC_AUDIT_LANE MC_AUDIT_STRICT
                if [[ $mode == strict ]]; then export MC_AUDIT_STRICT=1; fi
                BUN_JSC_useOMGJIT=0 bun test \
                    packages/plugin/src/hooks/magic-context/signed-thinking-prefix-audit.test.ts \
                    packages/pi-plugin/src/signed-thinking-prefix-audit.test.ts --timeout 30000
                cargo test -p mc-module --test signed_thinking_prefix_audit -- --nocapture
            done
        done
    )
}
validate_capture() {
    python3 - "$1" <<'PY_CHECK'
import pathlib, sys
root = pathlib.Path(sys.argv[1])
for model in ('rejected', 'prefix-bound'):
    files = [p.relative_to(root / model).as_posix() for p in (root / model).rglob('*.json')]
    default = {p.removesuffix('.default.json') for p in files if p.endswith('.default.json')}
    strict = {p.removesuffix('.strict.json') for p in files if p.endswith('.strict.json')}
    hosts = {p.split('/')[0] for p in files}
    if not default or default != strict or hosts != {'v1', 'v2', 'pi', 'opencode-aisdk', 'claude-code-anthropic'}:
        print(f'FAIL {model}: incomplete capture; check golden-mode early returns and suite coverage', file=sys.stderr)
        sys.exit(1)
    print(f'CAPTURE {model}: {len(default)} passes in each audit mode, all five hosts')
PY_CHECK
}
capture "$scratch/base" "$scratch/golden-base"
validate_capture "$scratch/golden-base"
capture "$root" "$scratch/golden-head"
validate_capture "$scratch/golden-head"
compare "$scratch/golden-base" "$scratch/golden-head"
