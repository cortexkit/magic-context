# Independent combined correctness review: issue 640 / issue 641

Reviewed **`git diff 5292c42f..ff77df26f732`**, not the older issue branch in isolation. Master is `5292c42f030202a77dfc7ec8080158166acfc17c`; the combined tip is `ff77df26f73211b771e12e94e920d254d150fb79`. This delivery changes no product code or existing assertions. The new review assertions are deliberately red; their names below describe the required property, not current behavior.

The source material is `docs/reports/issue-640-641-integration.md` (merge contracts and gate receipts), `issue-640-subagent-busy-refusal.md` (busy child lifecycle and wire compatibility), `issue-640-review.md` (independent identity/ownership findings), `issue-640-review-r3-resolution.md` (their subsequent repairs), and `issue-641-transform-deadline.md` (OMP timeout behavior and the retained side-session exception), all in `docs/reports/`. `ARCHITECTURE.md` supplies the protected pass lifecycle and failure rules. These were read before reviewing implementation. Earlier reports' host observations are **not** counted as fresh host runs here.

## Recommendation and area verdicts

Do not treat this tip as a universal fail-closed deadline implementation. In particular, the current-tool fit repair has an alternate recovery path that bypasses it, and a completed managed receipt is incorrectly treated as expired while waiting for provider dispatch/retry. The side-session exemption is a documented, previously approved tradeoff, but it still contradicts an unconditional “no unmanaged request on any path” release claim.

| Requested area | Verdict |
|---|---|
| 1. Every Pi path inside budget; 20-second writer | **Finding F4**: synchronous host/CPU work defeats an absolute wall-time bound. Real writer admission is bounded: 6,000-message input, 20-second independent writer, refusal at **16,568.47 ms**, while the writer remains held. Tested newer master stages retain their behavior. |
| 2. Complete late-write fencing | **Finding F5**: an expired cold auto-search pass still installs process-local skip authority, which later passes read. Durable SQLite writes, marker admission, LKG and served publication have the audited fences described below; independent raw-index/project maintenance is not a served-pass publication. |
| 3. Dispatch cannot abort an in-time managed request | **Finding F3**: receipt expiry is checked again at dispatch/retry, even after successful context completion. Ordinary immediate retries and superseded-owner controls pass. |
| 4. Uncontended defer byte differential | **Sound for the committed three fixtures**: separate master/head processes, actual Pi handler, OpenCode 1 transform plus wrapper, and OpenCode 2 hook plus actual transform. Exact output comparison, no timestamp/content normalization. Not an all-history/all-provider proof. |
| 5. No unmanaged sends / no new false refusals | **F1** permits unmanaged main dispatch after the side latch; **F3** falsely refuses managed dispatch without SQLite contention. **F2** can return an over-window saved request using obsolete tool counts. |
| 6. Three conflict resolutions | **Sound for inspected behavior and exercised regressions**: no lost master or incoming behavior identified in the named files. F2 is outside the conflicted files; F3/F4/F5 are limitations of retained guard paths, not a demonstrated dropped conflict hunk. |
| 7. Uncontended per-pass cost | **Sound for the measured fixtures**, with small observed warm changes and substantial shared-runner variation. Measurements and limits below. |

## Findings, ranked by user impact

### F1 — High safety impact: one attributed side context exempts later main dispatches for the registration's lifetime

**Existing, documented limitation**, not a newly discovered merge regression. At `packages/pi-plugin/src/pi-context-refusal.ts:140-145`, `before_provider_request` returns immediately when `sideSessions.get(key)?.sides` is nonzero. The latch is engaged at context entry (`:169-183`), before that side callback must complete. The latch survives later turns and receipt/cache cleanup in this registration; a complete extension/process restart is not proved to retain it. Turn start/end and receipt cleanup do not reset it.

Exact failing test in `packages/pi-plugin/src/issue-640-641-combined-review.test.ts`:

> `combined review: a previous side context must not authorize a later unmanaged main request`

The fixture supplies the exact host-attributed developer reminder and final attributed user prompt, ends that turn, starts a new main turn, supplies **no completed main receipt**, then invokes the registered provider hook with unmanaged main text. Expected: one visible refusal/abort. Actual: **zero refusals, zero aborts**. A missing receipt models OMP's callback-timeout case; this is a product-hook reproduction, not a newly captured HTTP send.

This is not spoofing with user text. Without the side-session exemption, `combined review control: an unfinished receipt is refused at dispatch` observes the expected abort and passes; existing unknown-body/spoofing tests also pass. Nor is turning the existing session-wide abort back on a safe local repair: OMP removes side-operation attribution before the payload hook and its abort API can cancel an unrelated main/side operation. Shipping must explicitly retain the exception or obtain operation-scoped host support; the universal invariant cannot be claimed in the meantime. Ordinary task children are not this attributed side-turn class and remain fenced.

### F2 — High correctness impact: OpenCode 2 exhausted admission replays using old tools

The new outer callback first tries to acquire SQLite's writer and, if it is busy, decides whether the saved request is safe to send by measuring the **current** draft's tools/system at `packages/plugin/src/v2/hooks/context.ts:1430-1502`. But after it exhausts writer admission, the catch at `:1921-1940` creates another messages-transform wrapper with `onLkgReplay`, **without** the current-draft `replayFits` callback. That wrapper's own retry/recovery calls at `packages/plugin/src/plugin/messages-transform.ts:524-541,614-625` use the ordinary cached tool measurements. `recordV2ToolDefinitions(draft)` at `context.ts:1509` has not run because the outer admission failed.

Exact failing test in `packages/plugin/src/v2/hooks/context-640-641-combined-review.test.ts`:

> `combined review: v2 exhausted admission still fits replay against current tools`

Reproduction:

1. Complete one actual V2 hook invocation with a small `read` definition and a saved managed prefix; positively prove that saved request fits.
2. Keep the same history/model/system, grow the current tool description to `"huge tool definition ".repeat(500000)`.
3. Make every `BEGIN IMMEDIATE` throw `SQLITE_BUSY`. Advance the monotonic acquisition clock by 17 seconds per failed BEGIN so the real helper exhausts its 16.5-second allowance without test sleeps.
4. The outer callback rejects the current envelope. Its catch enters the ordinary wrapper, which replays using the previous tool counts. **Two or more failed BEGINs occur, the mutating transform is still called only once overall, and the hook resolves without interruption.**
5. Independently record the current tools and ask the normal replay estimator about that same saved request: it now says **does not fit**. The failing assertion is `expect(error).not.toBeNull()`; actual `error` is `null`.

The seven accompanying OpenCode ordering/history controls pass, including the earlier changed-tools regression. That older fixture releases admission after one failed BEGIN, so it never reaches this exhausted-admission catch. The new test does not equate an old saved managed array with raw history: the defect is admission of an unfit *complete current request*. It can cause a provider overflow or repeat a failed turn. Share the current-envelope check across every V2 replay path, not only the first `beforeRetry` callback.

### F3 — Medium/high availability impact: a successful context receipt ages out during provider delay/retry

`before_provider_request` invokes `budget.assertOutcome()` before checking `active.ready` (`packages/pi-plugin/src/pi-context-refusal.ts:153-161`). `PiContextBudget.assertOutcome` rejects whenever elapsed time since **context entry** reaches 25 seconds, whether or not `completed` is true (`pi-context-budget.ts:58-61`). Completion at `pi-context-refusal.ts:213-217` never turns this preparation deadline into a durable operation receipt.

Exact failing test in `packages/pi-plugin/src/issue-640-641-combined-review.test.ts`:

> `combined review: a completed managed receipt survives delayed provider retries`

A context callback completes immediately, `budget.completed === true`, and the first payload attempt is admitted. No new context or agent lifecycle event occurs. Set that same preparation clock to 26 seconds and invoke another payload attempt: actual result is a visible refusal and session abort, despite the already completed managed result and no database contention. The diagnostic even says `recovery=no managed result; refused`.

OMP 18.8.6 forwards each `onPayload` to `emitBeforeProviderRequest` ([SDK lines 4208–4210](https://raw.githubusercontent.com/can1357/oh-my-pi/v18.8.6/packages/coding-agent/src/sdk.ts); [runner lines 2038–2045](https://raw.githubusercontent.com/can1357/oh-my-pi/v18.8.6/packages/coding-agent/src/extensibility/extensions/runner.ts)). A provider attempt invoking `onPayload` again does not need another conversation-context pass. **Which internal retries call `onPayload` is provider-specific and was not measured on a live host here.** The deterministic hook defect also applies to delayed *first* dispatch after an in-time callback. It is not evidence that every transport retries this way.

Retain generation/refusal/end checks and reject unfinished work, but do not use preparation age to revoke a result already managed in time. The existing test that deliberately expires a completed receipt asserts current policy; its meaning conflicts with the requirement that dispatch must not abort a request whose context preparation completed in time. No existing assertion was rewritten in this delivery.

### F4 — Medium latency impact / hard-bound qualification: synchronous work is not preempted

The one-clock policy is effective for yielding writer admission and guarded awaits. It is **not** an upper bound on every path. `readPiBranchEntriesForContext` calls host `getBranch`/`getLeafId`/`getEntry` synchronously (`packages/pi-plugin/src/context-handler.ts:1932-1950,1963-1973`); the next outcome check is after the read at `:2628`. Likewise `budget.waitMandatory(runPipeline(...))` evaluates the synchronous portion of the pipeline before its promise can be raced. A blocked native SQLite step, filesystem write or large serialization/tokenization loop cannot be interrupted by the JavaScript timer.

Opt-in real-time test in `packages/pi-plugin/src/issue-640-641-combined-review.test.ts`, enabled with `MC_COMBINED_STALL=1`; it fails its `< 30000` handler-duration assertion:

> `combined review timing: synchronous branch projection stays below OMP's deadline`

The real registered handler receives a supported host branch callback which spends **31 seconds synchronously** before returning its normal fixture branch. The handler then refuses, with no tag publication, but its measured outcome is **31,000.59 ms**, not below 30 seconds. This is an intentional event-loop-stall fault injection, **not** a claim that normal branch reads or the private incident store routinely take 31 seconds. It demonstrates the missing absolute bound, not a lost merge stage. The diagnostic's stage remains `schema/claim` even though the stall is in branch projection.

The complementary actual held-writer control uses a Python SQLite connection on a file-backed fixture and does not fabricate native writer delays. Its 20-second lock yields a refusal at **16,568.47 ms**, leaves the writer held, creates no tags/LKG/served-number state, and does not join the never-settling historian. The test's total 20.16-second runner duration includes waiting for that independent locker to finish during cleanup; it is not handler duration. No managed success after a 20-second initial writer is promised: the admission ceiling is deliberately 16.5 seconds.

The independent dispatch backstop is essential for stalls, and F1 makes it unavailable in latched sessions. Calling the budget a cooperative deadline rather than a hard real-time guarantee is accurate until blocking work is moved/bounded at interruptible boundaries.

### F5 — Low correctness/feature-availability impact: an expired cold search freezes a skip for an unserved turn

In `packages/pi-plugin/src/auto-search-pi.ts:344-352`, cold snapshot discovery is followed by `persistAutoSearchSkip` without a new pass assertion. That helper catches the fenced SQLite write error and nevertheless inserts the message into `skippedTurns` (`packages/plugin/src/hooks/magic-context/auto-search-deadline.ts:34-68`). Subsequent passes check this process-local cache **before** searching (`auto-search-pi.ts:307-309`). It is not merely telemetry.

Exact failing test in `packages/pi-plugin/src/issue-640-641-combined-review.test.ts`:

> `combined review: expired cold auto-search must not freeze an unserved skip`

The test uses the real SQLite transform scope and the same optional-budget guard as the handler. Cold snapshot discovery advances the pass clock to 26 seconds. The operation rejects at the budget boundary and **durable hint decisions remain empty**, proving SQLite fencing worked. Nevertheless `wasAutoSearchSkipped(db, sessionId, "u1")` is **true**, where the test requires false. Retrying the same user turn in this process will skip even if registration/search is now available. This fault injection measures the post-discovery window, not the cost of a normal snapshot lookup.

A no-hint result actually returned within the outcome deadline should remain frozen for byte stability. An abandoned result should not authorize that freeze. Fence process-local skip publication as well as the SQLite append. Merely observing that no durable hint row appeared misses this defect.

## Budget and merge-path audit

| Stage | Shared-clock behavior / preserved master contract |
|---|---|
| Entry, callable tool-schema loading, checkout claim | Clock begins in guarded registration. Both awaits use the optional cutoff; owner supersession takes precedence over supplied cancellation. No callable validator is invoked as a schema factory. |
| Branch projection, pressure classification, LKG snapshot | Charged to elapsed time; assertions bracket classification/pre-admission. Synchronous projection is F4. Root bookkeeping normalization remains transport-fenced by the earlier review tests. |
| Initial writer | Actual session-meta read/create inside acquired BEGIN; at most 16.5s, bounded additionally by `21s - elapsed - 2s`; fitting LKG checked after first failed BEGIN, before backoff. Callback is not rerun after entry. |
| Issue 634 floors / issue 636 pressure | `resolvePiProvenInputFloor` and admitted pressure snapshot remain; rejected aggregate billing usage does not become historian/reclaim pressure. `turn-aggregate-usage-pi.test.ts` and `issue-634-fire-counter.test.ts` pass. |
| Emergency historian | No foreground 30-second join. Published history can participate; in-flight work remains independent. Never-settling historian is present in the actual 20-second-lock test. |
| Mandatory tagging/reclaim/injection | Uses the outcome guard and SQLite write fence, not another 21/25-second allowance. Master’s single ride permission and frozen defer replay are retained. Synchronous work remains F4. |
| Reasoning / task-child lifecycle | `keepReasoningTokens`, provider/model protection, protected mutation view, and status capture remain. The issue 620/630 controls and issue 637 terminal-result/drain regression in `subagent-runner.test.ts` pass. |
| Spent drain gate and historian startup | Optional SQLite guard around trigger/drain checks. Deferred startup rechecks originating cutoff; a completed admitted background run is not cancelled merely by the next foreground owner. The spent-budget byte-replay/startup-reset fixture passes. |
| Auto-search | Pure reader worker, registered snapshot, turn coalescing, current-caller replay guard and optional SQLite scope retained. Worker/coalesced late-result tests pass. The cold skip's process-local publication is F5. |
| Final serialization/recovery | LKG and served boundaries check the outcome clock, including after serialization. At expired outcome no new replay/storage wait is attempted; visible refusal does not synchronously persist its diagnostic. F3 mistakenly reuses this clock after context completion. |

The master-to-merge comparison of `context-handler.ts`, `context-handler.test.ts` and `auto-search-pi.ts` retains the above master behavior and the incoming writer/replay/generation/identity controls. The changed historical test fixtures and worker-client cancellation seam are openly documented in `issue-640-641-integration.md`; they are not silently altered by this review. The combined tests include spent drain budget, deferred marker drain, aggregate usage, protected reasoning, task-child drain/latch, adoption races/collisions, wire-schema compatibility and supersession. No lost conflict behavior was demonstrated.

## Pass-write inventory and fence classification

This is an inventory by persistence/authority class, including helper writes; a pass is **not one rollbackable transaction**. Writes committed while current remain available to a later deliberate pass. “Late pass writes nothing” must distinguish new expired *managed publication* from independent raw maintenance and refusal diagnostics.

| Write/authority | Admission/publication fence or harmlessness rationale |
|---|---|
| Session metadata creation; project binding; compaction-mode record; model/restart resets; TTL/hygiene/floor snapshots | All foreground SQLite write entry points use `assertTransformWrite` through the attached guard (`shared/sqlite.ts:677-684,755-776`). Initial metadata additionally uses owner-aware acquisition. Selected model/project facts and content-keyed caches are raw-input facts, not acknowledgments of a served request. |
| Tag allocation, source content, token accounting, fallback rekeys/collision folding, pending-op retargets | Shared SQLite fence; adoption/tagging have explicit owner assertions and transaction checks. Served-number evidence is separate from row existence. Existing racing-drop, duplicate-number and reload assertions pass. |
| Dropped status/mode, pending-operation dequeue, reclaim watermark/sample, caveman compression | SQLite guard before writes; pipeline ride-only permission retained. Committed pre-expiry reduction state is replayed, not undone just because a later stage refuses. |
| Reasoning watermark; native reasoning/tool-input replay decisions; thinking-binding recovery and strip order | Same SQLite fence; current provider/model and protected-turn view retained. Process-local token/identity caches are derived from content and can be invalidated/reloaded; they do not establish served numeric identity. |
| Frozen temporal/placeholder/image/reminder/todo decisions, note anchors and delivery counters | Foreground SQLite fence. First-application follows the priced mutation gate; frozen decisions replay on defer. Protected-section byte contract is unchanged. |
| M0/M1 bytes, fold/history boundaries, pending materialization/history-refresh signals, channel/nudge baselines and leases | SQLite writes fenced; explicit checks before marker/drain publication in the pipeline. In-memory drain flags represent already admitted work; a failed later stage does not invent a second independent bust permission. No new late-drain violation was demonstrated by the exercised controls. |
| Host compaction marker / boundary bookkeeping | `guardedPiAppendCompaction` checks before host append (`context-handler.ts:5026-5037`); marker/deferred drain also asserts current pass. Host JSONL appends cannot be rolled back after external side effects; synchronous-cross-deadline completion remains F4's limitation. |
| Pending/attributed transform decision rows | Staged only on managed completion; original deadline and resolving-pass guard accompany deferred resolution. `assertDecisionPublication` permits an already completed predecessor's attribution after ownership changes, not an unfinished predecessor's writes. Replies arriving after the original 25s cannot publish that decision under current policy; this conservative telemetry loss is not a send authorization. |
| LKG in-memory slot, capture/persistence timer | `captureAppliedPass` receives `budget.assertOutcome`; deferred callbacks recheck it. Identity-persistence failure cancels pending LKG instead of replaying newly unsent authority. Expired/superseded publication controls pass. |
| Durable served-number file; served digest/body queue; previous digest/sequence/reuse set | Explicit outcome checks before/after serialization and around identity recording; deferred digest/body flush carries the guard. Reuse IDs check owner before publication. File-backed durable numbers survive cleanup/reload; append is safety state, not a scan of quoted markers. Blocking filesystem completion is subject to F4. |
| Auto-search hint/no-hint decisions; skip cache | Ordinary worker-result and joining-caller publication assertions plus SQLite guard. **Exception F5:** cold skip cache is installed after a caught expired SQLite append. |
| Project registration/query backfill, raw FTS reconciliation/incremental indexing, optional auto-embedding | Independent maintenance, not evidence that the transformed request was served. Raw providers/indexing use host raw identities and contents; background search worker is read-only. These jobs may legitimately run after a pass; they must not publish its hint/LKG/receipt. Cold registration/backfill enqueues are not all owner-cancelled, so a literal claim of zero work after expiry would be inaccurate. |
| Historian registration, in-flight map, abort controller, lease renewal, run publication, deferred refresh signals | Startup rechecks optional deadline/owner before registration continues; a started historian owns its separate lease/raw-range validation and may publish later. Foreground never awaits its completion in emergency; a later admitted bust drains its work. |
| Conversation/tool/work-metric/status telemetry; pressure/model/branch/token caches; last-heuristic/commit tracking | Foreground DB writes still guarded. Content-derived/display caches are not served receipts. Last-heuristic/commit tracking reflects admitted synchronous pipeline work; budget assertions precede resumed/publication stages. No additional harmful post-result cache write established. F5 is specifically decision-driving state, unlike these display/content caches. |
| Refusal notices/display entry, best-effort `last_transform_error` | Intentionally allowed after expiry: synchronous notice → entry → abort, no SQLite wait on refusal stack. Error persistence is queued outside the foreground scope, short background admission, and owner-checked. It records a refusal, never an applied transform. |
| OMP dispatch receipt and side counters/latch | Completion checks outcome and ownership; successor cannot publish/abort through old owner. **Exceptions F1/F3:** side-session exemption across later turns and erroneous aging of a completed receipt. |

The existing expired-deferred-publication and stalled-serialization controls run green. They prove their named boundaries, not every item in this inventory. The new F5 test observes `wasAutoSearchSkipped`, the process-local cache used to suppress later searches, rather than using “no SQL rows” as a proxy.

## Uncontended differential and cost

Committed opt-in harness: `packages/pi-plugin/src/issue-640-641-combined-differential.test.ts`. Each revision runs in a separate Bun process; master is archived from this worktree's Git objects into a disposable source directory, never another checkout. The fixture asserts that Pi's `@magic-context/core/shared/sqlite` resolves into the selected revision. OpenCode imports resolve explicitly from the selected source tree. Both use the same isolated project cwd. No HTTP host is required.

Each arm performs 32 real handler invocations: two warmup invocations, then **30 identical low-pressure defer samples**. The fixture requires repeated output byte equality and a positively generated `§1§` tag; the OpenCode 1 fixture also requires both leading `syntheticHead` prefix messages. Pi includes 600 fixed text messages, a real tool call/result pair, a completed assistant and a user tail. OpenCode 2 captures the entire draft (system, tools, options, messages). Final master/head output files are compared with `cmp`, not just compared with their own digests.

Final expanded-fixture results (Bun 1.4.2, Linux; milliseconds):

| Harness | Exact bytes / SHA-256 at both revisions | Cold master → head | Warm median master → head | Observed warm overhead | Warm min–max master / head |
|---|---|---:|---:|---:|---|
| Pi | 129,157 / `04ea978c77f9f929db807d4111e1f49655f78db70f78174b62899899dc560d85` | 211.509 → 205.386 | 8.039 → 9.043 | +1.004 ms (+12.5%) | 7.148–13.044 / 7.753–14.334 |
| OpenCode 1 | 599 / `1858cb22d26467847a365974827421103ac1dcc30479b294fdcdc7bf4b4ff80c` | 18.635 → 18.722 | 0.905 → 0.956 | +0.052 ms (+5.7%) | 0.814–1.595 / 0.794–1.387 |
| OpenCode 2 | 26,200 / `779093172a17dcedff761e5127a879627f41e7679775fad93491c1c324dd1c98` | 20.955 → 21.025 | 2.448 → 2.492 | +0.044 ms (+1.8%) | 2.178–3.993 / 2.191–4.011 |

Each arm passed **3 tests / 8 assertions**, and all **3 independent `cmp` checks passed**. Pi's absolute warm overhead is approximately one millisecond in this fixture, but its percentage is not zero or a demonstrated speedup. Min/max ranges overlap; this is one controlled source comparison on a shared builder, not a production latency distribution. The earlier smaller-fixture comparison also passed all three exact-byte comparisons; its timings varied while another gate ran, so those preliminary medians are not substituted for the final expanded measurements.

Setup and reproduction, from the task worktree (archive/dependency links are disposable evidence setup, not files to commit):

```sh
mkdir -p .review-baseline
git archive 5292c42f | tar -x -C .review-baseline
for D in node_modules packages/pi-plugin/node_modules packages/plugin/node_modules \
         packages/retina-local-fs/node_modules packages/retina-local-fs/dist; do
  [ ! -e "$PWD/$D" ] || [ -e ".review-baseline/$D" ] || \
    ln -s "$PWD/$D" ".review-baseline/$D"
done
```

On the Linux runner, with the isolation exports below and distinct `$ROOT/base`/`$ROOT/head` output directories:

```sh
REVIEW_CWD="$PWD" REVIEW_SOURCE="$PWD/.review-baseline" REVIEW_OUTPUT="$ROOT/base" \
  bun run --cwd packages/pi-plugin test:serial \
  src/issue-640-641-combined-differential.test.ts \
  --tsconfig-override "$PWD/.review-baseline/packages/pi-plugin/tsconfig.json"
REVIEW_CWD="$PWD" REVIEW_SOURCE="$PWD" REVIEW_OUTPUT="$ROOT/head" \
  bun run --cwd packages/pi-plugin test:serial \
  src/issue-640-641-combined-differential.test.ts \
  --tsconfig-override "$PWD/packages/pi-plugin/tsconfig.json"
for H in pi oc1 oc2; do cmp "$ROOT/base/$H.json" "$ROOT/head/$H.json"; done
```

Cost includes the whole awaited context/transform result, including foreground capture/publication, not just the existing pipeline `total` observer. It excludes setup, input cloning and the deferred drain between samples. In-memory context stores and synthetic fixed text do **not** establish production p99, cold disk/fsync costs, large collision sets, or historian/network latency. No automatic timeout is disabled. Larger/stateful byte contracts are additionally covered by existing master-stage regressions, not by expanding the equality claim beyond these fixtures.


## Verification, reproduction and isolation

All authoritative gates requested `runon: "linux"`, asserted `uname -s = Linux`, ran as background jobs and were collected with `bash_watch`. **Bun 1.4.2 (744846f84), TypeScript 5.9.3, Biome 2.5.1.** No runner fallback or local build/test fallback was used. Local Biome writes formatted only the three new evidence files; the authoritative lint ran remotely. Frozen installs checked **1,010 installs across 1,251 packages, no changes**; no manifests or lockfiles changed.

| Gate | Result |
|---|---|
| Pi existing safety subset: `test:serial src/issue-640-review.test.ts src/issue-640-review-r2.test.ts src/issue-641-dispatch.test.ts src/issue-641-outcome.test.ts src/issue-641-publication.test.ts src/auto-search-pi.test.ts src/signal-peek-drain.test.ts src/pi-context-budget.test.ts` | **85 pass / 0 fail**, 284 assertions, 8 files. |
| Pi master-stage subset plus new review file: `MC_COMBINED_TIMING=1 ... test:serial src/issue-640-641-combined-review.test.ts src/context-handler.test.ts src/turn-aggregate-usage-pi.test.ts src/issue-634-fire-counter.test.ts src/reasoning-token-budget-review.test.ts src/issue-630-review.test.ts src/subagent-runner.test.ts` | **307 pass / 3 intentional fail**, 1,200 assertions, 7 files. The only failures are F1/F3/F5; no existing assertion fails. At this invocation F4's opt-in stall test had not yet been added. |
| Final Pi evidence: `MC_COMBINED_TIMING=1 MC_COMBINED_STALL=1 bun run --cwd packages/pi-plugin test:serial src/issue-640-641-combined-review.test.ts` | **2 pass / 4 intentional fail**, 20 assertions, 6 tests. F1/F3/F4/F5 fail by the exact names above; missing-receipt and actual 20-second-writer controls pass. |
| Plugin: `bun run --cwd packages/plugin test src/v2/hooks/context-640-641-combined-review.test.ts src/v2/hooks/context-640-review-r2.test.ts src/v2/hooks/context-lkg-admission.test.ts src/shared/sqlite-640-review-r2.test.ts` | **7 pass / 1 intentional fail**, 41 assertions, 4 files. Only F2 fails. |
| Final archived-master/head differential | **3 pass / 0 fail / 8 assertions per arm**, then **3 exact-byte comparisons pass**. 30 measured warm invocations per harness per revision. |
| `bun run --cwd packages/pi-plugin typecheck`; `bun run --cwd packages/plugin typecheck` | **Pass**, including local-fs build configuration, package `tsc --noEmit`, and plugin script configuration. These package configurations exclude tests. |
| Explicit strict test compiler configurations | **Pass**, two `tsc --noEmit -p tsconfig.combined-review.tmp.json` invocations, explicitly covering **3 new test roots** and their imports. Compiler is silent on success; version and exit 0 captured. Configuration recipes below. |
| Package-installed `biome check` on the new files | **Pass**, **2 Pi files + 1 plugin file**, no fixes/errors/warnings in final gate. |
| Editor inspection | **PARTIAL**, no authoritative Biome/callgraph snapshot for these files. Not counted as a clean diagnostic gate. Explicit compiler/lint above are authoritative. |
| Full build/full suites/native host | **Not rerun**: this delivery changes only report/tests; prepared `bun run build` was supplied green. Focused source tests, actual-handler differential, both package typechecks and explicit test checks cover the new evidence. No fresh all-provider or native-host guarantee is claimed. |

The new synchronous-stall test is opt-in, as is the 20-second native writer measurement. The three fast Pi finding assertions and the one V2 finding assertion are intentionally enabled by default so the evidence is reproducible, not silently green. Differential/performance tests require `REVIEW_OUTPUT`; they otherwise skip. **This commit intentionally makes focused tests red and is not a product fix.**

Compiler recipes for explicitly checking the three new test roots (temporary files were removed after verification):

```jsonc
// packages/pi-plugin/tsconfig.combined-review.tmp.json
{"extends":"./tsconfig.json","compilerOptions":{"types":["node","bun"]},"include":["src/issue-640-641-combined-review.test.ts","src/issue-640-641-combined-differential.test.ts"],"exclude":[]}
// packages/plugin/tsconfig.combined-review.tmp.json
{"extends":"./tsconfig.json","compilerOptions":{"noEmit":true,"emitDeclarationOnly":false,"rootDir":"../.."},"include":["src/v2/hooks/context-640-641-combined-review.test.ts"],"exclude":[]}
```

Use this throwaway HOME/XDG/storage setup **inside each gate's shell**, before running the named scripts; do not inherit the operator's HOME or export `OPENCODE_DB` to a package suite:

```sh
test "$(uname -s)" = Linux
unset OPENCODE_DB
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/mc-combined-review.XXXXXX")
export HOME="$ROOT/home" CFFIXED_USER_HOME="$ROOT/home" \
  XDG_DATA_HOME="$ROOT/data" XDG_CONFIG_HOME="$ROOT/config" \
  XDG_STATE_HOME="$ROOT/state" XDG_RUNTIME_DIR="$ROOT/runtime" \
  XDG_CACHE_HOME="$ROOT/cache" MAGIC_CONTEXT_STORAGE_DIR="$ROOT/storage"
mkdir -p "$HOME" "$XDG_RUNTIME_DIR" "$ROOT/base" "$ROOT/head"
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="$PWD"
```

The V2 unit fixtures choose their own **created disposable** `OPENCODE_DB` in the test body and restore it afterward. Pi's isolation preload similarly selects per-test disposable storage roots. The real writer measurement uses only its created file-backed SQLite database and an independent Python connection; the dispatch fixtures are fake host event registrations, **not an OMP CLI launch**.

Live-store isolation rule, verbatim: **never open/read/write/migrate the live stores (`~/.local/share/opencode/*.db`, `~/.local/share/cortexkit/magic-context/{context,store}.db`, `~/.config/opencode/*`, `~/.config/cortexkit/*`)**. No such store/config was opened, copied, read, migrated or written. No real Pi/OMP/OpenCode host was launched in this review, so there is no new host PID or lsof receipt to claim. Any future host reproduction must redirect every required root under `$TMPDIR/magic-context/<task>/` and prove throwaway-only database descriptors with `lsof -p <host pid>` before counting it as evidence.

Initial unsuccessful gates are not hidden product findings: the first strict Pi test configuration lacked Bun types and one new options literal lacked the required `scoreThreshold`; both were corrected. The plugin strict configuration initially inherited a too-narrow `rootDir` when a runner job lacked generated local-fs declarations; broadening only the temporary no-emit configuration fixed that setup constraint. Biome caught a missing import-group blank line, also corrected. The enriched OpenCode 1 fixture initially looked for two parts inside its first message rather than the two actual leading synthetic messages; the final fixture positively checks both `syntheticHead` positions instead. Bun printed a nonfatal tsconfig directory-mismatch warning in both differential arms; both actual source-resolution assertions and final byte comparisons passed. None of these corrections changes product code, an existing test, or a required behavioral expectation.

Final sidekick comment review examined all four staged files. The two genuinely vague code comments were rewritten to name the skip cache and the complete-request fit estimator; report wording now identifies the source reports and states the no-false-abort requirement directly. Internal finding labels refer to the ranked sections in this same document, not an external task. The report retains the material timing/count/hash/failure observations; no delivery evidence depends on `dist`, runner-local build output, or the disposable master archive. No product mutation was used to produce the findings. These are direct failing required-property assertions with passing controls, not mutation proofs or claims that green legacy tests defend every new path.

After comment clarification, the fast finding files were rerun on Linux: Pi **1 pass / 2 opt-in timing skips / 3 intentional fail**, 9 assertions, and OpenCode 2 **0 pass / 1 intentional fail**, 6 assertions. The named failures are unchanged. Strict compilation of all three evidence roots and Biome's **2 + 1 file** checks also pass on the final commented sources. The real-time and byte/cost receipts above remain applicable because no executable test behavior changed during comment review.
