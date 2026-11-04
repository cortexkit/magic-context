#!/usr/bin/env bash
# Check tracked shell sources without executing them or requiring a newer Bash.
set -euo pipefail
checker_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
root=$(git rev-parse --show-toplevel)
cd "$root"
paths=$(git -c core.quotePath=false ls-files -- '*.sh')
status=0
checks=0
while IFS= read -r path; do
    [ -n "$path" ] || continue
    awk -v path="$path" -f "$checker_dir/check-shell-exit-guards.awk" "$path" || status=1
    checks=$((checks + 1))
done <<< "$paths"
printf 'Shell EXIT guards: %s tracked scripts checked, status=%s\n' "$checks" "$status"
exit "$status"
