#!/usr/bin/env bash
# Local counterpart of CI's Cargo.lock-pinned source checkout action.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
pins="$(python3 scripts/cargo-lock-pins.py)"
revision="$(printf '%s\n' "$pins" | sed -n 's/^subc_revision=//p')"
[[ "$revision" =~ ^[0-9a-f]{40}$ ]]
source="$root/.siblings/subconscious"
if [[ ! -d "$source/.git" ]]; then
  mkdir -p "$root/.siblings"
  git clone --no-checkout https://github.com/cortexkit/subconscious.git "$source"
  git -C "$source" checkout --detach "$revision"
fi
# Never change an existing dirty source checkout to make the gate pass.
test -z "$(git -C "$source" status --porcelain)"
git -C "$source" cat-file -e "$revision^{commit}" || git -C "$source" fetch origin "$revision"
git -C "$source" checkout --detach "$revision"
test "$(git -C "$source" rev-parse HEAD)" = "$revision"
printf 'Locked daemon source: %s\n' "$revision"
