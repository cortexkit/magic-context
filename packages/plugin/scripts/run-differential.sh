#!/usr/bin/env bash
# git archive exports the selected commit to a temporary directory. Compare
# identical provider event sequences in that directory and in this checkout.
set -euo pipefail
finished=0
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
cd "$ROOT"
BASE=${REVIEW_BASE:-fe7e2dffe7c3ef40b6d2a8c5c01509c5a5b198e6}
WORK=$(mktemp -d)
trap 'status=$?
if [ "$status" -eq 0 ] && [ "${finished:-0}" != 1 ]; then
    printf "%s\n" "$0: exited before successful completion" >&2
    status=1
fi
rm -rf "$WORK" || { cleanup_status=$?; [ "$status" -ne 0 ] || status=$cleanup_status; }
exit "$status"' EXIT
MASTER="$WORK/master"
TEST=packages/plugin/src/hooks/magic-context/system-prompt-delivery-differential.test.ts
GOLDEN=packages/plugin/src/hooks/magic-context/fixtures/system-delivery-unheld-digests.json
mkdir -p "$MASTER"
git -C "$ROOT" archive "$BASE" | tar -x -C "$MASTER"
mkdir -p "$MASTER/$(dirname "$TEST")/fixtures"
cp "$ROOT/$TEST" "$MASTER/$TEST"
cp "$ROOT/$GOLDEN" "$MASTER/$GOLDEN"
for dir in node_modules packages/*/node_modules; do
    [ -e "$ROOT/$dir" ] && ln -s "$ROOT/$dir" "$MASTER/$dir"
done
(cd "$MASTER" && REVIEW_OUT="$WORK/master.json" bun test --timeout 300000 "$TEST")
(cd "$ROOT" && REVIEW_OUT="$WORK/reviewed.json" bun test --timeout 300000 "$TEST")
bun "$ROOT/packages/plugin/scripts/compare-system-delivery-differential.ts" "$WORK/master.json" "$WORK/reviewed.json"
if [ -n "${DELIVERY_BASELINE_OUT:-}" ]; then
    mkdir -p "$(dirname "$DELIVERY_BASELINE_OUT")"
    cp "$WORK/master.json" "$DELIVERY_BASELINE_OUT"
fi
finished=1
