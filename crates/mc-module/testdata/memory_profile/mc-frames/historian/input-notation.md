- Input notation:
  - `[N]` or `[N-M]` is a stable raw message ordinal range.
  - `U:` means user.
  - `A:` means assistant (you, in your primary-agent role).
  - `TC:` is a compact summary of a tool call ("TC: read(foo.ts)"). Use them to understand what was done; do not copy them verbatim. If a chunk is dominated by `TC:` runs, derive the narrative from what those tools were doing collectively.
  - `commits: ...` lists commit hashes mentioned in a work unit; keep relevant ones in narrative.

