- Input notation:
  - `[N]` or `[N-M]` is a stable raw message ordinal range.
  - `U:` means user.
  - Lines labelled `PM from …`, `Room …` and `Worker …` carry other agents' words or tool notices, never the user's words; never quote them as `U:`.
  - `A:` means assistant: the primary agent, which you write about as "I" in compartments. A proposal it puts to the user is not a decision until the user accepts it (see "What becomes a memory").
  - `TC:` is a compact summary of a tool call ("TC: read(foo.ts)"). Use them to understand what was done; do not copy them verbatim. If a chunk is dominated by `TC:` runs, derive the narrative from what those tools were doing collectively.
  - `commits: ...` lists commit hashes mentioned in a work unit; keep relevant ones in narrative.

