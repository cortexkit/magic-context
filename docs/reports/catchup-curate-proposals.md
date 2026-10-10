# Catch-up: curator proposal completion on OpenCode 2

## Merge and reproduction

The published `train/check-catchup` branch was at
`42cef017b873c0b1f25c2934d46bc2eb485f21fe` before this merge and fix.
Its CI run was https://github.com/cortexkit/magic-context/actions/runs/38039663336:
21 jobs passed; only `E2E (OpenCode 2.0.22, host behavior)` failed.

Current master at merge time was
`9d26c87081a9925217fa09698ce08e7a092e1f4d`. It merges cleanly, including the
per-harness `compress-cues` model selection, ignored/deprecated `mural.model`,
Pi sections handling, SQLite close fix and doctor guards. There are no conflict
hunks to discard or resolve in this merge. Migration's context v100/store v67,
memory lifecycle, rescore, provider pipeline and signed-thinking work remain.

The same test failed locally after that merge, on the real **OpenCode v2.0.22**
host, PID **36748**. Its test-created root was
`/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/issue-647/mc-opencode2-CYCnlL`.
The harness and the test's `lsof` check verified every writable database was
beneath that root. No operator database was opened, even read-only. The host
was stopped through the harness's open-descriptor and write-fence checks.

Printing the result recorded for each `/ctx-dream <task>` command identified
**curate**; the previous assertion printed only the failed status, not the task. Retrospective completed first. Curate's persisted error was:

```text
Curate returned no completed ctx_memory tool result.
```

Curate's structured failure was `parse_failed`, attempted model `openai/mock-model`.
The captured provider transcript proves a successful real `ctx_memory` call:

```text
function_call: ctx_memory
{"action":"update","ids":[1],"content":"Fixture claim is recorded in fact.txt. Clarification 1 preserves the fixture fact."}
function_call_output:
MEMORY_PENDING_PROPOSAL: update retained as a pending proposal; memory [ID: 1] is unchanged.
```

The background OpenCode session used for curate had already been removed by
its normal privacy cleanup, so a
read-only query of the throwaway host database returned no child rows. Diagnosis
therefore uses the retained mock-provider wire capture and the durable dream
run, not assumptions about absent child history. The test now saves failed wire
captures and prints the recorded task/error before keeping the completion
assertion unchanged.

## Product interaction

Migration v99 intentionally records automated edits as proposals without
changing canonical memory. The older completion parser did not recognize that
successful recording. This is not an authority refusal, rescore-table failure,
or hidden-child shaping defect:

- `packages/plugin/src/tools/ctx-memory/tools.ts:642-650` sends an automated
  curator update to `proposeMemoryMutation` and returns `MEMORY_PENDING_PROPOSAL`.
  The corresponding merge and archive branches do the same at 751-759 and
  819-827.
- `packages/plugin/src/features/magic-context/memory/lifecycle-applier.ts:237-263`
  inserts the proposal transactionally into `memory_tool_proposals` and returns
  `decided_pending`; canonical memory is not changed. The explicit distinction
  between agent-authorized writes and automated proposals is documented at 309.
- `packages/plugin/src/v2/hidden-completion.ts:156-200` correctly converts the
  successful host result into a completed `ctx_memory` tool part with its text.
- The old `inspectCurateMemoryOperations` accepted only applied-result text
  (`Updated memory`, `Merged memories`, `Archived memor`, or `completed`). A
  completed proposal thus counted as zero successful mutations, and the curate
  validator failed the task. The original parser was at
  `packages/plugin/src/features/magic-context/dreamer/task-executor.ts:341-370`
  in parent `42cef017`.

The chosen contract preserves v99: **a successfully recorded proposal completes
curation, but it must be reported as proposed, never applied**. No immediate
curator-application path or memory-authority bypass was added.

The parser now admits the exact `MEMORY_PENDING_PROPOSAL:` prefix only on a
completed `ctx_memory` merge/archive/update result, tracks `proposedActions`
separately, and retains the old applied-result checks. Both session-based and
hidden transports accept that explicit proposal outcome. Progress prints, for
example, `curate: 1 memory operation proposed (update)`. Refusals, error-state
tools and error text merely mentioning the marker do not count as completion.
The accounting changes are at `task-executor.ts:343-386`, the two validators at
2041-2056 and 2136-2150, and the progress separation at 2248-2258.

## Strengthened acceptance

The real-host test still requires every manual task status to be `completed`.
Its stale assertion that a curator update was *applied* is replaced with the
actual first-release contract, not a weaker status assertion. Immediately after
curate it checks:

1. The complete canonical memory row serializes byte-identically to the snapshot
   taken before that task.
2. Exactly one curator update proposal exists for the project and target memory,
   with the controlled curator text and `MEMORY_PENDING_PROPOSAL` reason.
3. Task status is completed and progress says proposed, not applied.

`curate-proposal-result.test.ts` tests both session and hidden execution: durable
proposal completion, authority refusal, tool error and marker-like error text.
A real transcript-shape unit test verifies proposals are not counted as applied
operations. Existing exact summary-shape assertions gain an empty
`proposedActions` array; their applied-action and failed-call assertions remain.

## Verification

Bun 1.4.2 and TypeScript 5.9.3. The first real-host reproduction failed exactly
the reported test before the product fix. The plugin was rebuilt locally for
native-host execution; ordinary compiler/unit gates run on Linux with throwaway
HOME and unset `OPENCODE_DB`. Native-host and CI verification results follow.

- Linux curator/executor/lifecycle selection: **62 pass**, 367 expectations,
  across three files. Both transport paths reject authority refusals, error-state
  tools and marker-like error text; both complete on a durable proposal.
- Linux real transcript conversion selection: **31 pass**, 123 expectations.
- `bun run --cwd packages/plugin typecheck`: passed all three compiler commands.
- The optional whole-e2e `tsc --noEmit -p packages/e2e-tests/tsconfig.json` is red
  in unrelated probes, existing host fixtures and transitive support modules;
  it reports no error in the changed dream-route test. This is not a clean
  whole-e2e typecheck claim.
- Fixed native OpenCode 2.0.22 run: **1 pass**, 85 expectations, 122.76 seconds,
  PID **69281**, root `mc-opencode2-zwOD8N` under the same private test prefix.
  All six manual tasks completed, then the real startup timer completed the
  owning-location controls. Curate reported `1 memory operation proposed
  (update)`; unchanged-row and exactly-one-proposal assertions passed.
  The fixture retained `issue-647-proof.json`, `issue-647-lsof.txt` and
  `issue-647-plugin.log`, and shutdown's write/open-descriptor fences passed.

No v99 writer policy, rescore table or hidden-child shaping code was modified.
The old applied-result format remains available for genuinely applied legacy
results; pending proposals have their own count and progress wording.
