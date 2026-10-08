# H4 independent correctness review, round 2

## Verdict

**Do not accept H4 yet.** At `ece4583339fa65defd5ea1196913e2df078af01b`, the setting-off differential is not byte-identical. There are also three further prefix/restart violations and a missing historian pass barrier. This review changes tests and this report only; it does not fix implementation.

The delivered first-review cases and adjacent adapter, payload and durability tests still pass. The second-review suite deliberately contains failing assertions of the required behavior, not assertions accepting the defects.

| Finding | Severity | Failing cases |
| --- | --- | --- |
| R2.0: setting-off v2 projection adds an ID to reconstructed rows | **Blocking** | 4 differential cases (both settings; restored row and actual context checkpoint) |
| R2.1: host aliases can mutate the native runner's cached served message | **Blocking** | v1 and v2 |
| R2.2: v2 restart loses tool bridge bytes, including an image attachment | **Blocking** | v2 durable restart |
| R2.3: v2 rendered cache retains mutable host content | **Blocking** | v2 warm replay |
| R2.4: no matching hook, or an unhooked last append, loses the pass barrier | **Should fix** | 4 cases, v1 and v2 |

## Method and safety

Tests:

- `packages/plugin/src/hooks/magic-context/host-runner/opencode-adapter-review2.test.ts`
- `packages/plugin/src/v2/hooks/payload-review2.test.ts`

The provider tests use a recording fake module with observable ingest, per-subject hook answers, step/status requests, barriers and fallbacks. Bootstrap normally covers no raw tail, so ordinary-pass assertions actually exercise entries rather than hiding everything in a replacement. Separate covered-view controls exercise revert and boundary trim. No real ck-mc module is involved.

All context databases are SQLite `:memory:`. The full v2 context differential additionally creates its own throwaway `session_message`/`session` store, redirects the store-reader pool to that explicit path, and supplies a recording module client. The plugin test preload isolates data/config homes before imports. **No live store or live user configuration was opened, read, written or migrated.**

The differential archives **`b604dfe92cc8^`** (`0fba6f5c7462264dedc51449dcfcb20d27a9094e`) directly with Git, runs that code and the revised worktree in separate fresh Bun processes, and executes the same fixture against each. It does not compare two aliases of the revised code or a stored expected hash. Clocks are fixed; outputs are compared as strings without key sorting or normalization. The trace compares SQL write text and serialized bind arguments, including writes through `run`, `get` and `all`, non-transaction `exec` statements, and host `storage.set` calls. It waits through the deferred LKG capture before taking each snapshot. Initialization/migrations and fixture seeding are outside the per-request trace.

### Setting-off matrix

For each of absent `rust_pipeline` and explicit `full_request`, each lane has three requests: initial tool/media request, a message `X` inserted into the middle, and a revert to `A`.

| Host / lane | Outgoing adapter request bytes | Store-write trace |
| --- | --- | --- |
| OpenCode 1 through `createTransform`: ordinary, recorded boundary, reconstructed row | Identical (6 cases) | Identical |
| OpenCode 2 through `adaptPayload` + `createTransform`: ordinary, recorded boundary | Identical (4 cases) | Identical |
| OpenCode 2 through `adaptPayload` + `createTransform`: reconstructed row | **Different (2 cases)** | Identical |
| OpenCode 2 through actual `registerContext`: ordinary | Identical (2 cases) | Identical |
| OpenCode 2 through actual `registerContext`: native compaction checkpoint | **Different (2 cases)** | Identical |

That is **12 passing and 4 failing differential cases**, covering 48 requests per revision. Every captured request reached the recording module's full-request `transform` method. The fixtures contain split tool calls/results, call metadata, tool-result file attachments, a user media class instance, recorded fold coverage, an actual completed compaction checkpoint, a middle race and revert. The actual context lanes exercise `context.ts`; the direct lanes isolate projection/trim behavior. Both run `rememberHostMedia` and the shared transform. No store-write difference was observed in this matrix.

“Outgoing request bytes” here means the plugin's returned OpenCode 2 `SessionContext` (including system/options/tools/messages), or OpenCode 1 transform output, serialized by `JSON.stringify`. The differential does **not** claim to have captured a network provider request after OpenCode's later AI-SDK serialization. The changed ID is host request metadata; whether a specific provider's wire serializer removes it is a later integration question, not evidence of byte identity at the adapter boundary.

## R2.0 — setting-off reconstructed v2 rows acquire an ID

**Severity: blocking under the requested setting-off byte-identity gate.**

**Input.** A full-request module answer contains an ordinary row whose `info.id` is absent from the current projection's originals. The direct fixture returns assistant `RESTORED`. The actual context fixture supplies a native completed checkpoint; context restoration removes its incoming carrier and the module returns that checkpoint row. Neither session has ever selected provider mode.

**Expected bytes, before H4:**

```json
{"role":"assistant","content":[{"type":"text","text":"restored checkpoint row"}]}
```

**Actual bytes, revised H4 with the setting absent or `full_request`:**

```json
{"id":"RESTORED","role":"assistant","content":[{"type":"text","text":"restored checkpoint row"}]}
```

For the actual context checkpoint, the exact differing row is:

```text
before: {"role":"user","content":[{"type":"text","text":"checkpoint summary\ncheckpoint recent"}]}
after:  {"id":"checkpoint","role":"user","content":[{"type":"text","text":"checkpoint summary\ncheckpoint recent"}]}
```

This occurs on the initial and middle-race requests; the checkpoint revert, after deleting the checkpoint from the throwaway store, is identical. The reconstructed `RESTORED` lane differs on all three requests. All corresponding store traces compare equal before the byte assertions fail.

**Cause.** `v2/hooks/payload.ts:435` changed the non-head ID expression from `original?.id` to `original?.id ?? mid` without gating the fallback on provider mode. It executes with no provider projection/cache. This is an externally visible change in the host draft even if preserving the ID would otherwise be useful.

**Clause.** The brief's highest-priority requirement: setting absent or `full_request` must leave every outgoing request and every write byte-identical to before H4. H4's opt-in behavior and A3's compatibility requirement do not authorize an unconditional shared-pipeline change.

**Tests.** `setting-off differential v2 {absent|full_request} {restored|context-checkpoint}: outgoing request and all store writes equal pre-H4`.

## R2.1 — a host reference can rewrite a recorded native prefix

**Severity: blocking.**

**Input.** Bootstrap `[A]`, retain a second reference to the output array, mutate `retained[0].parts[0].text` in that served object, append `B`, and run another ordinary pass with the same array. This tests mutation of an already published object, not just supplying a new object with a known ID.

**Expected surviving prefix:**

```json
[{"info":{"id":"A","role":"user","sessionID":"session","model":{"providerID":"openai","modelID":"gpt-5.6"}},"parts":[{"id":"A-text","type":"text","text":"A"}]}]
```

**Actual prefix:**

```json
[{"info":{"id":"A","role":"user","sessionID":"session","model":{"providerID":"openai","modelID":"gpt-5.6"}},"parts":[{"id":"A-text","type":"text","text":"HOST MUTATED ALREADY SERVED A"}]}]
```

The test checks that the durable `ingest_json` still contains the original `A` bytes before asserting the output. There was no applied view, exit or declared host-side prefix event. The in-memory served object differs from its durable source.

**Cause.** The record assembles its mutable served objects by reference, and `publishMessages` inserts those same objects into the host-held array. The corrected in-place publication does preserve the array reference, but it also exposes the record's owned message graph to subsequent host mutation. An id-only scan then reuses the poisoned object.

**Clause.** A1 first-serve prefix identity; D2.2.1 known-ID replay from recorded served bytes; D2.2.5 prefix changes only by an applied view or named event. D2.1/D2.3 permit pointer assembly, not unrecorded byte changes.

**Tests.** `H4 second review {v1|v2} > R2.1: mutating the host-retained served object cannot rewrite recorded prefix bytes`.

A passing control replaces the array element with a *fresh* edited object, rather than mutating the record-owned object. In-place publication and recorded-byte replay work for that case on both hosts.

## R2.2 — v2 restart drops tool bridge metadata and the attachment

**Severity: blocking.**

**Input.** Bootstrap a v2 request with assistant `T`, a `read` call, and an id-less result carrier containing `result` plus a PNG file. The call and result carry provider metadata, and the carrier has its own metadata. Commit the projection, dispose/recreate the adapter, hydrate it through `isProviderSession` (the context hook does this before projection), and replay the same host rows.

**Expected first-served tool arc (unchanged on restart):**

```json
[{"id":"T","role":"assistant","stamp":"call metadata","content":[{"type":"text","text":"reply"},{"type":"tool-call","id":"call","name":"read","input":{"path":"fixture"},"providerMetadata":{"vendor":{"signature":"call-signature"}}}]},{"role":"tool","stamp":"result metadata","content":[{"type":"tool-result","id":"call","name":"read","result":{"type":"content","value":[{"type":"text","text":"result"},{"type":"file","uri":"data:image/png;base64,AQID","mime":"image/png","name":"fixture.png"}]},"providerMetadata":{"vendor":{"signature":"result-signature"}}}]}]
```

**Actual restarted arc:**

```json
[{"id":"T","role":"assistant","stamp":"call metadata","content":[{"type":"text","text":"reply"},{"type":"tool-call","id":"call","name":"read","input":{"path":"fixture"}}]},{"role":"tool","content":[{"type":"tool-result","id":"call","name":"read","result":{"type":"text","value":"result"}}]}]
```

The result's file is gone, as are both part-level provider metadata values and the result carrier's `stamp`. This is not merely an ID or serialization-order discrepancy.

**Cause.** `payload.ts` keeps `ToolBridge`, rendered host messages and host parts only in a process-local `WeakMap` keyed by the projection owner. Hydrating the native record registers all IDs as known but does not hydrate those inverse-projection bytes. `adaptPayload` then skips the assistant's content and its id-less result carrier (`:204-210`). `commit` takes the unbridged tool fallback (`:448-485`), which reconstructs a text-only result and ignores `state.attachments`.

If projection runs *before* hydration, it reads the tool again and hides this defect. The test deliberately uses the real context ordering, not that accidental recovery path.

**Clause.** A1 byte prefix identity across restart; A6 durable restart; D2.7 hydration from durable record; H4 inverse host adaptation; D2.3.6's protected images/signatures. A restart is not a named permission to change these bytes.

**Test.** `R2.2 v2: durable restart replays the first-served tool result and attachment bytes`.

## R2.3 — the v2 projection cache replays mutated host content

**Severity: blocking.**

**Input.** Serve and commit a v2 `A`, retain the returned host message, mutate its first text part, and run projection/adapter/commit again with that host draft.

```text
expected: [{"id":"A","role":"user","content":[{"type":"text","text":"A"}]}]
actual:   [{"id":"A","role":"user","content":[{"type":"text","text":"HOST MUTATED PROJECTED A"}]}]
```

The test checks **before commit** that the native adapter output still has text `A`. This distinguishes the v2 cache defect from R2.1: in this case the native record is correct and only the final host projection is poisoned.

**Cause.** `payload.ts:587-590` saves the same `V2Message[]`/content objects that `:602` publishes to the host. The warm `byNative` hit (`:415-420`) reuses them without rebuilding from the unchanged native served bytes. No content read is needed for the bad bytes to escape: they are already in the mutable cache.

**Clause.** A1 and D2.2.1/D2.2.5. The final array the host sends, not just the native adapter's intermediate array, must retain the recorded bytes.

**Test.** `R2.3 v2: mutating retained host content cannot poison the projection cache`.

## R2.4 — unhooked appends lose the historian pass barrier

**Severity: should fix.**

**Inputs.** Two legal frozen declarations:

1. Subscribe only to `post_tool`, bootstrap user `A`, then append user `B`.
2. Subscribe only to `post_assistant`, bootstrap `A`, then append assistant `B` followed by user `C`.

All calls are available; there is no timeout, refusal or safety exit.

**Expected protocol bytes.** Case 1's sync must carry `pass_complete: true`, since the pass has no hooked append. Case 2's actual last hook (on `B`) must carry `pass_complete: true`, or an explicit completing sync must follow. There must be a completed barrier for both passes.

**Actual.** The recording sync receives only `false` in case 1. In case 2 the single hook has no `pass_complete`, and no sync carries `true`. There is no outgoing model-byte delta in this reproduction: the observable failure is the absent protocol control field. The historian is never scheduled at the completed-pass boundary; repeated passes of the same shape can indefinitely omit evaluation despite ingested user/tool work or a synchronized model-chain change.

**Cause.** `opencode-adapter.ts:1184` decides completion from `scan.appends.length === 0`, not the presence of hooked appends. `:1219-1221` labels a hook last only when it belongs to the last *message*, even when that message has no subscribed subjects. All subscribers can legally be filtered out on that message.

**Clause.** D2.3.1 says “on a pass with no hooked append” the sync carries completion. D2.3.6 requires the pass's last hook to carry it. D3.8 schedules historian evaluation **only** at that barrier and requires synchronized inputs and complete pass ingest.

**Tests.** `H4 second review {v1|v2} > R2.4: an append with no matching subscriptions still completes the historian pass`; `R2.4 {v1|v2}: a final unhooked append does not strand the earlier hook's pass barrier`.

## What the revised fixes do correctly

- **In-place publication (R1):** the array reference is retained on v1 and v2 native publication. A second reference observes the managed bytes when host array elements are replaced with fresh edited objects. The remaining R2.1/R2.3 failures involve *mutable object ownership*, not the old replacement-array bug.
- **Tool subject identity (R2):** projected completed tools reach `post_tool`; repeated call IDs within one terminal message are disambiguated as `v2:0:repeat` and `v2:1:repeat`. Warm re-projection and hydrated restart preserve their distinct tagged text-only results without duplicate hooks. R2.2 is a separate failure of durable inverse projection, not a failure to invoke the hook.
- **Invalidated-view retry (R3):** covered reverts refuse on each of two consecutive noops or two consecutive transport failures, remain durably invalidated, then issue another `reason: revert` step and serve the successful replacement. This passed on both hosts after restart.
- **Separate clocks (R4):** the sequence SOFT flush at 4000, live TTL edit from five minutes to one, HARD cold at 62001, then SOFT flush at 65000 preserves the HARD clock at 62001. A later idle pass with no response newer than that clock does not rebuild. Both hosts passed.
- **Burn ordering (R5):** a partially failed assistant message with assistant + two tool subjects freezes wholly raw. Its three burns appear on the next message's first hook; that message's later two hooks no longer carry them after acknowledgement. The durable queue is empty. Both hosts passed, as did the original cadence regression.
- **Switches (R6):** deliberate rollback/re-entry remains supported by the delivered tests and the replacement-transaction control. A `provider_foreign_history` safety exit survives full_request/provider toggles and adapter restarts without a new declaration/Setup or a new lineage. Both hosts passed.
- **Known content (R7):** a *fresh* host object with an edited known ID is deliberately skipped. A getter records zero content reads through projection, adapter and commit; output replays the prior served bytes. That is safe and required by D2.2.1, not an edit-admission mechanism. In-place changes to objects already handed out are unsafe for the separate reasons in R2.1/R2.3. The existing no-content-read and no-duplicate-Setup-serialization tests also pass.
- **Race trim (R8):** an unknown race at the very front prevents premature trim, and an unknown message at the very end survives trim. The adapter serves `[A,B,C,X]` in either case. The first review's interior race/no-store-ordinal-read test also passes.
- **Legacy behavior and config (R9/R11):** original setting-off legacy BUSY replay and user-only setting tests still pass. The independent v1 setting-off request/write differential passes through the shared transform.

### The two new storage options

`hard_materialized_at` is written inside `commitHostRunnerAnswer`'s existing `writeTransaction`: accepted view, pruning, clock UPDATE, then state row, then COMMIT (`storage-host-runner.ts:365-452`). The clock is not a later best-effort write. A trigger aborting the final state update **after the view and clock statements** leaves the old view bytes and old clock intact; after removing the trigger and restarting, the HARD operation succeeds. Both hosts passed.

`replace_retired_rollback` checks the observed exit string and the explicit `rollback` reason *inside* `commitHostRunnerPass`'s transaction, before deleting the retired rows (`:224-245`). A trigger aborting insertion of the replacement state, after retirement deletes, restores the complete retired record byte-for-byte. Re-entry then succeeds once the trigger is removed. Passing a safety-exit record's exact exit string to this option is refused and leaves that record unchanged. Both hosts passed.

**Conclusion for the requested crash-between-statements question:** these new effects really are in the same SQLite transactions; no split clock/record commit or permissive safety-exit replacement was found. The new tests use statement faults/rollback, not a machine power-loss simulation. The adjacent existing storage suite's SIGKILL-after-entries/fence/receipt/view tests also pass; those do not by themselves exercise the new clock and retired-replacement branches.

## Verification

All authoritative checks below ran on the Linux runner using Bun **1.4.2**, TypeScript **5.9.3**, and Biome **2.5.1**. The initial prepared build was reported successful in the brief. No implementation, packaging or generated output changed, so no further build was needed.

From `packages/plugin`:

```sh
bun test src/hooks/magic-context/host-runner/opencode-adapter.test.ts \
  src/hooks/magic-context/host-runner/opencode-adapter-review.test.ts \
  src/hooks/magic-context/host-runner/opencode-adapter-review2.test.ts \
  src/v2/hooks/payload.test.ts src/v2/hooks/payload-review2.test.ts \
  src/features/magic-context/storage-host-runner.test.ts
```

Result: **153 pass, 12 expected finding failures, 909 assertions, 165 tests across 6 files**, exit 1. All 121 tests in the four existing files passed. The two new files contribute 32 passing controls/differentials and the 12 failing cases listed above. These failures are the intended deliverable; expectations have not been weakened to make them green.

- `bun run typecheck`: passed. This package excludes `*.test.ts`, so this was not treated as proof that the new tests typecheck.
- `./node_modules/.bin/tsc -p .h4-review2-typecheck.json`: passed with a temporary package-local config extending `tsconfig.json`, setting `noEmit: true`, `emitDeclarationOnly: false`, `rootDir: "../.."`, including exactly the two new tests, and clearing the test exclusion. The temporary config was removed after verification. No test-file diagnostics remained.
- `./node_modules/.bin/biome check` on the two new test files: passed, 2 files checked. Formatting was applied only to those files.
- AFT inspection was partial: its checkout graph was not ready and its Biome producer unavailable. The compiler and repository-resolved Biome commands are the authoritative gates.

The initial GNU tar extraction attempt on the remote workspace failed with `Function not implemented`; the differential now extracts the Git archive via Node filesystem operations and runs remotely without a local test fallback. Early fixture/setup/typecheck errors were corrected before the reported final run and are not findings. In particular, each side of the differential now runs in a fresh process so global session caches cannot manufacture a write difference.

No full `npm test` run was used to infer findings. The 17 known remote sandbox/HTTP/WAL/Node-WASM baseline failures are outside this review. No live-host provider HTTP request, real ck-mc corpus, timing/scaling acceptance measurement, or canary was run; those remain later integration gates.
