# issue 642: historian boundary investigation

## What is established

The issue body and all three comments were read. The log establishes a historian
request for `299-299`, one message and about 258 formatted tokens, followed by a
terminal tool-arc validation error, an out-of-range repair (`290-299`), a failed
session-model fallback, and MC-H01. It does **not** contain the raw messages,
prior compartment anchors, token totals, or captured boundary diagnostics. The
fixtures below reconstruct a source-level path to the same one-message range;
they are not a recovered copy of the reporter's session.

## Selection path and defect

- Pi registers its raw-message provider and uses the shared boundary resolver:
  `packages/pi-plugin/src/context-handler.ts:5333-5350`. Its normal fire decision
  calls the shared trigger: `context-handler.ts:5426-5449`.
- The new range starts at `lastCompartmentEndOrdinal + 1`:
  `packages/plugin/src/hooks/magic-context/protected-tail-boundary.ts:522`.
  The Pi runner independently uses the same prior-compartment end:
  `packages/pi-plugin/src/pi-historian-runner.ts:637-641`.
- The token-size walk and semantic snap are tool-fenced first. The live-user
  floor is applied **after** those fences (`protected-tail-boundary.ts:667-739`).
  A user message interleaved with a parallel tool batch can move that boundary
  back inside a completed invocation/result arc. OpenCode host-row retreat can
  likewise move a previously fenced boundary.
- A second defect was in `applyHeadCap`: when a completed component began before
  the publication floor, its fence moved forward beyond the protected tail; the
  final `Math.min(end, protectedTailStart)` moved it back inside the same arc.
  The fix at `protected-tail-boundary.ts:505-515` returns an empty head instead.
- The final tail and head boundaries are re-fenced toward older history after
  the user/host adjustments (`protected-tail-boundary.ts:740-775`). The shared
  open-tool fence also re-fences completed components after moving to a recent
  open invocation (`read-session-true-raw-tokens.ts:584-598`).
- The Pi runner intersects the selected end with the protected tail and passes
  that exclusive end to `readSessionChunk` (`pi-historian-runner.ts:700-719,
  817-823`). Exclusive end 300 and offset 299 therefore yield `299-299`.

The native Pi fixture converts 473 entries into 473 raw messages, uses the log's
204,000-token window, 180,138 input tokens, 88.3% pressure, a 90% effective
threshold, prior end 298, a 258-token message at 299, overlapping calls at
298/299, results at 301/303, and a user prompt at 300. Before the fix, the selected
exclusive end is 300; after the fix it is 299 (empty). At 95% pressure the floor
lifts and a complete component becomes eligible. A separate 473-row token-index
fixture proves the cap itself used to return exclusive end 300 through the arc.

## Why the minimum-chunk rule did not protect the run

Pi and OpenCode already share the rule; there is no Pi-only missing minimum.
The proactive trigger requires 6,000 raw/formatted tokens, 12 messages, or more
material beyond the scan budget (`compartment-trigger.ts:45-46, 430-435`). But
it inspected the range up to the **uncapped protected tail**, not the smaller
range the runner could actually summarize, and its raw-token count also covered
the uncapped range. Large later history could thus qualify a tiny runnable head.

The trigger now scans the capped exclusive end (`compartment-trigger.ts:403-429`)
and the snapshot counts raw tokens in that same head
(`protected-tail-boundary.ts:798`). A real provider/storage regression with a
small message at 299 and a large next message confirms two consecutive 88.3%
passes do not fire and do not increment historian failures. Empty capped heads
cannot qualify for force-mode dispatch either. Existing emergency behavior that
admits a *complete*, small atomic head under genuine force pressure is retained.

All fixes are in shared code, so OpenCode receives the same protection. This
also prevents the deterministic invalid-boundary retry loop without introducing
an arbitrary cooldown or hiding genuine producer failures.

## Repair range 290-299

The repair does not broaden the raw chunk. Pi builds `<new_messages>` from
`Messages ${chunk.startIndex}-${chunk.endIndex}`
(`pi-historian-runner.ts:934-940`; `compartment-prompt.ts:143-147`).
`buildHistorianRepairPrompt` appends feedback and the previous invalid XML to the
same original prompt (`compartment-runner-validation.ts:280-298`). Separate
bounded session references and examples may mention older ranges; they are not
new raw evidence. Mapping validates against the chunk's raw ordinals.

Consequently `290-299` is an invalid model-selected range, not proof that the
repair supplied raw lines 290-298. The log does not include the prompt or the
previous XML, so it cannot establish where the model obtained `290`.

## UI extension question

In the installed Pi SDK, `sdk.js:248-252` passes agent messages to
`runner.emitContext`; `extensions/runner.js:901-916` clones the messages and lets
context extensions return or edit that message list. Tool results are constructed
from execution `content`/`details`, not render output
(`pi-agent-core/dist/agent-loop.js:530-543`, installed 0.83.0).
`ToolExecutionComponent` adds the return values of call/result renderers to its
UI container (`tool-execution.js:238-269`, installed 0.87.1).

These SDK files are under the corresponding `node_modules/.bun` package-version
paths. They are source inspection, not a runtime reproduction on the reporter's
Pi 1.1.0. A display-only override has no normal path into historian messages.
An extension that also changes context/tool execution, or mutates the data passed
to its renderer in place, is a different case. The reporter's extension was not
available for inspection.

## Verification evidence

Four independent non-vacuity controls were staged safely, applied with a
nonempty one-file `git diff --stat`, tested, and restored with an empty diff:

| Neutralized protection | Only red test | Other tests green |
| --- | --- | --- |
| Refuse a head fence beyond the protected tail | does not clamp a completed component back into the protected tail at ordinal 300 | 25 boundary tests |
| Re-fence after the recent open invocation | re-fences an open invocation inside a completed tool component | 25 boundary tests |
| Re-fence after the live-user floor | Pi 473-message edge waits rather than scheduling the split 299-299 chunk | 4 Pi parity tests |
| Inspect the capped range for trigger meaningfulness | does not fire at 88.3% for a tiny capped head even when later eligible history is large | 18 trigger tests |

The fixtures failed against the original source and pass with the fix. The old
force-threshold test previously allowed a token count to make an **empty** capped
window runnable. Its expectation was deliberately changed: an empty window must
now be rejected at both thresholds, while its raised-threshold no-head recording
assertions remain intact.

Host database proof: an isolated Bun process initialized only a throwaway
`context.db`; `lsof -p 48000` showed only that database and its WAL/SHM files under
`$TMPDIR/magic-context/issue-642/host-proof/storage/`. The complete lsof output is
kept in the sibling `evidence/lsof.txt`. No live stores or host configurations
were opened. Linux test/build runs use throwaway HOME and XDG/storage/tmp roots,
with `OPENCODE_DB` unset for suites.

### Final gates

All requested gates ran on Linux in background tasks, followed by `bash_watch`.
Tool versions: Bun 1.4.2, TypeScript 5.9.3, Biome 2.5.1.

- `bun run build`: passed; all three package build scripts completed.
- Narrow boundary/trigger/Pi parity suites: 50 passed, 0 failed, 113 assertions.
- `bun run --cwd packages/plugin test`: 7,444 passed, 9 skipped, 42 failed out
  of 7,495. The 42 failure names exactly match master 1a7f4f0b.
- `bun run --cwd packages/pi-plugin test`: 1,617 passed, 9 skipped, 144 failed
  out of 1,770. The 144 failure names exactly match master 1a7f4f0b, including
  the existing in-flight publication timeouts. No new failures in either suite.
- `bun run typecheck`: passed across four packages (including plugin scripts).
- `bun run lint`: passed across four packages, with existing warning/info output.
- Sidekick comment review: all six changed source/test files examined; no flags.
- `git diff --check`: passed. AFT inspection was partial (unavailable graph/Biome
  analysis and a later TypeScript timeout); the actual `tsc` and Biome scripts
  above are the authoritative checks.

The suites run their existing `bun install --frozen-lockfile` scripts. No
manifest or lockfile changed. Machine-readable baseline failure names and final
set comparisons are retained in `issue-642-failure-names.json` beside this report.
One Linux mutation call was refused during workspace setup and succeeded on the
next Linux attempt; no local test/build fallback was used. The first combined
final-gate wrapper stopped after plugin tests because temporary baseline files
from a previous remote invocation were unavailable. Baseline names were recovered
from captured output, persisted in the worktree, and the suite/remaining gates
were rerun with exact set comparison. An in-wrapper post-build plugin run had
34 baseline failures (8 fewer); the final comparable isolated run above had the
same 42 names as master. Captured AFT output and the local lsof proof remain
outside regenerable build directories.

## Suggested reporter reply

Thanks — we reproduced the boundary-selection problem in issue 642. A later
boundary adjustment could undo the tool-call/result protection, and the trigger
was checking more history than the run could actually summarize. Both are fixed
in the shared Pi/OpenCode code. When there is no complete eligible chunk, Magic
Context now waits for a later pass instead of dispatching an impossible request
and recording MC-H01. A Pi extension that only changes tool-call display should
not be involved; extensions that change messages or tool results are different.
The repair's `290-299` was outside the requested raw chunk, not an expanded raw
range supplied by the repair.
