#!/usr/bin/env bash
# Nothing under .cortexkit/ may be tracked except the allowed folders and files.
#
# The fleet layout keeps internal material (design notes, investigations, tool state)
# under .cortexkit/, ignored by git, and tracks only release-notes/, skills/, rules/, WORKER.md and the top-level project
# settings files (<module>.jsonc, which the daemon reads) there. The check lists every tracked file under .cortexkit/ and fails on
# any that is outside that list.
#
# It does not ask git which tracked files are ignored (`git ls-files -ci`): a stray `!`
# line in any .gitignore un-ignores a private file, which is then tracked, not ignored,
# and invisible to that question.
#
# It also confirms the ignore block still works, so that a private file is not tracked
# by a plain `git add` in the first place: an internal path must be ignored and an
# allowed one must not be. If either control fails, or git cannot list the files, the
# checker reports itself BLIND and exits 2 rather than passing.
#
# Exit 0 clean, 1 a disallowed file is tracked, 2 the check could not see.

set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 2

if ! git check-ignore -q --no-index .cortexkit/internal-docs/designs/control.md; then
  echo "BLIND: .cortexkit/internal-docs/ is not ignored; the .cortexkit block is missing from .gitignore" >&2
  exit 2
fi
if git check-ignore -q --no-index .cortexkit/release-notes/control.md; then
  echo "BLIND: .cortexkit/release-notes/ is ignored; the block's allow lines are missing" >&2
  exit 2
fi

if ! all="$(git ls-files -- .cortexkit)"; then
  echo "BLIND: git ls-files failed" >&2
  exit 2
fi
bad="$(printf '%s\n' "$all" | grep -vE '^\.cortexkit/(release-notes/|skills/|rules/|WORKER\.md$|[a-z0-9-]+\.jsonc$)' | grep -v '^$')"
if [ -n "$bad" ]; then
  echo "tracked files under .cortexkit/ that the layout keeps out of git:" >&2
  printf '%s\n' "$bad" | sed 's/^/  /' >&2
  echo "move them to .cortexkit/internal-docs/ (or remove them) and 'git rm --cached' them" >&2
  exit 1
fi
echo "controls hold; no disallowed file is tracked under .cortexkit/"
