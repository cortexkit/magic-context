# Pi terminal-drain result preservation (issue 637)

## Verified failure and baseline state machine

The report is consistent with the runner at `30f43e7f03bdd485f5f5f750590efeac3af2ac99`.
The regression produced exactly the reported failure: `no_assistant`, empty text,
and `Cloud Code Assist API error (400)` after the runner's real two-second drain
SIGTERM. No provider or live session database was needed.

Baseline references below are to `packages/pi-plugin/src/subagent-runner.ts` at
that revision:

| Transition | Baseline source | Effect |
| --- | --- | --- |
| Start child | `:1601-1620` | Null final text/status/error, `sawAgentEnd=false`, no drain. |
| Terminal assistant `message_end` | `:1918-1957` | Always accumulate the message. For `stop`, `length`, `error`, or `aborted` without a `toolCall`, set `sawAgentEnd=true` and replace all three final fields with the last assistant in the accumulated stream. |
| Full-transcript `agent_end` | `:1889-1907` | Set `sawAgentEnd=true`, replace transcript/accounting pointers and all three final fields. The early return skips the drain block on this event's own line. A later event reaching that block can start the drain. |
| Begin drain | `:1974-1986`, grace `:527` | Any detected terminal turn reaching this block starts a 2000 ms timer and clears the hard timeout. The timer invokes `terminateChild`. |
| Terminate child | `:2816-2833` | SIGTERM immediately, SIGKILL after another 2000 ms if still alive. Output remains readable until child close or the exit/stdio grace. |
| In-child retry | `:1870-1884` | `auto_retry_start` or `agent_end` with `willRetry:true` runs **before** terminal capture, clears `sawAgentEnd`, the authoritative transcript and drain state, cancels the drain, re-arms the original hard deadline, then returns. The old final fields were not cleared, but were no longer eligible for settlement until another terminal. |
| Settle | `:2063-2240`, `:2242-2259` | Close settles immediately; exit gets a 1000 ms stdio grace. If `sawAgentEnd`, empty captured text fails `no_assistant` before the stop-reason checks; nonempty error/aborted fails `model_failed`, length fails `truncated`, otherwise text succeeds. Signaled exit deliberately does not invalidate captured terminal text. |

**A stop can arrive without any wire `agent_end` before SIGTERM.** This is already
supported by the `message_end` path. Despite its name, `sawAgentEnd` means a
terminal result was detected, not necessarily that an `agent_end` event arrived:
`:1945` sets it for terminal `message_end`. Consequently the reporter's proposed
`!sawAgentEnd` gate would cover the no-`agent_end` case in this revision. Its
broader first-terminal-wins rule is not needed: failure/empty/tool-call results
must not acquire the usable-result protection.

## Implemented rule

Current references are to `packages/pi-plugin/src/subagent-runner.ts`:

- `:1605`, `:1666-1687`: capture text/status/error together and latch preservation
  only for non-whitespace `stop` or `length` text whose final assistant contains
  no tool call. `length` remains a truncation failure; preserving it prevents
  shutdown from misclassifying it as an empty/aborted response.
- `:1911-1930`, `:1940-1982`: both transcript and message terminal paths respect
  the latch. Raw progress and message accumulation still observe shutdown
  events, but those events cannot replace the captured result or its selected
  transcript. Error/aborted/empty first terminals retain existing failure rules.
- `:1997-2010`: both paths reach the same drain block, including a standalone
  `agent_end`. Removing its early return makes capture and drain initiation one
  transition instead of depending on a later unrelated event.
- `:1889-1906`: either retry signal clears the latch and all final fields along
  with the pre-existing drain reset. The new attempt can capture its own answer;
  the hard deadline remains fixed rather than extending on retry.
- `:2130-2199`: settlement classifications are unchanged.

## Harness scope and other runners

- Pi and OMP use the same `PiSubagentRunner`: historian wiring is in
  `packages/pi-plugin/src/index.ts:1098-1104`, dispatch in
  `packages/pi-plugin/src/pi-historian-runner.ts:278-283`, and target selection in
  `packages/pi-plugin/src/subagent-runner.ts:932-958`. The target changes CLI/model
  arguments, not this event/exit state machine. Regression replay is run with
  **both** `targetHarness: "pi"` and `"omp"`; this is not a live-provider or OMP
  binary integration reproduction.
- OpenCode 1 dispatches a hidden session prompt, waits for completion/idle, then
  reads its messages once (`packages/plugin/src/hooks/magic-context/compartment-runner-historian.ts:204-242`).
  It does choose the latest stored assistant, but has no pending print child,
  drain SIGTERM, or repeated terminal-event capture during shutdown.
- OpenCode 2 waits for a persisted terminal assistant
  (`packages/plugin/src/v2/hidden-completion.ts:281-341`), saves one completion
  (`:693-735`), and `collect` returns that saved value (`:777-780`) before lifecycle
  cleanup (`:782-807`). It does not have the same shutdown overwrite loop. This
  comparison is not a claim that arbitrary host-side row rewrites are impossible.
- Rust's Broca historian producer accumulates text and **returns immediately** on
  the matching run's first terminal control unit
  (`crates/mc-module/src/historian_producer.rs:1186-1283`); no post-terminal drain
  can replace its output. Rust's host runner uses the OpenCode completion carrier
  and reports its collected completion once
  (`packages/plugin/src/hooks/magic-context/historian-host-runner.ts:505-533`,
  `:635-725`). Pi/OMP do not currently expose the Rust transform/host route
  (`crates/mc-module/src/historian_runner.rs:63-76`). No changes to these runners.

## Verification

- Before the implementation, `bun test src/subagent-runner.test.ts --test-name-pattern
  'preserves pi stop text without agent_end through drain SIGTERM and two aborted events'`
  failed its success assertion with `reason: "no_assistant"` and the stale provider
  error (1 test, 1 failure, Bun 1.4.2).
- The regression drives shutdown output from the runner's actual SIGTERM, asserts
  the ordered trace `stop -> SIGTERM -> aborted -> aborted`, and checks the saved
  6103-character text. There is no wire `agent_end` in this trace.
- Additional controls cover later aborted `agent_end` and `message_end`, standalone
  `agent_end` draining, both retry reset signals with a successful second attempt,
  first-terminal empty error/aborted failures, length classification, and a pending
  tool call that must not latch. Existing real-child retry/backoff and nonempty
  first-terminal error/aborted tests also pass.
- `bun run test` in `packages/pi-plugin`: 1636 passed, 3 skipped, 0 failed across
  155 files (Bun 1.4.2); the frozen-lockfile install checked 996 installs across
  1251 packages without changes. Suites used a throwaway HOME/data/config tree,
  with `OPENCODE_DB` unset, and did not access the live stores.
- Neutralizing either preservation gate independently made only its named
  regression fail: the SIGTERM/two-aborts test for `message_end`, and the later
  aborted transcript test for `agent_end`. In each four-test mutant run the
  corresponding retry reset and both first-terminal failure controls stayed
  green. Mutants were restored from the staged implementation, with nonempty
  unstaged diffs during mutation and empty unstaged diffs after restoration.
- Pi package typecheck passed (TypeScript 5.9.3); lint passed after formatting the
  two changed files (Biome 2.5.1, 247 files). Six non-null assertion warnings in
  unrelated pre-existing files remain unchanged.

## Draft bot reply (not posted)

Thanks @red-projects for the precise timeline and reproduction. We reproduced the
6103-character stop followed by the runner's SIGTERM and two empty aborted events.
The fix preserves usable terminal text during shutdown on both Pi and OMP, while
retry signals start a fresh attempt and genuine first-terminal failures still
fail. The no-`agent_end` path is covered too, and length-capped output still reports
truncation. The Pi suite, typecheck and lint pass. Your report made the shutdown
race straightforward to isolate.
