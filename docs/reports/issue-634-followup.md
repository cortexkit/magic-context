# Issue 634 follow-up: fire telemetry, hook boundaries and aggregate usage

## Scope and reference points

Read the last Zireael comment on issue 634 (2026-10-08 **20:17:42Z**) and issue 636. Compared **v0.46.1**, commit `00d9856c4210ca90c01ec14f70330ae6a6248e4c`, with **origin/train/post-046**, pinned at `0049ccaf878e821fae189728aaebd593e64c7e31`. The task checkout is release-based; it is **not** the train. Exact-ref source snapshots and tests, not the current checkout alone, underpin the comparison.

Below, **MC** means Magic Context, **V** means v0.46.1 and **P** means that train commit. `Pi/` abbreviates `packages/pi-plugin/src/`; `Core/` abbreviates `packages/plugin/src/`. A citation marked **both** has the same relevant behavior at both refs. No reporter database/session file was supplied or opened. The quoted session numbers are inputs to a replay, not independent measurements of the reporter's outgoing requests. No product code was changed.

Two unreleased repairs are present on P:

- `924719e29a950f84a0e2c5b4ab8f620754131095`: accepted-provider proven-floor derivation, upgrade repair and window source/denominator status.
- `ba0eca4d0a0460e3f6d28f1848151708cf00dfee`: reject oversized Pi/OMP turn billing input as request pressure, including the host fallback, floor, historian and status paths.
- Integration commit: `a92f676ea1` (issues 634 and 636). Neither repair ships in 0.46.1. Neither wires the legacy fire counter or adds a hook inside Cursor's server-owned loop.

## 1. The fire counter

**The symptom is real; “no write path anywhere” is too broad.** There is no runtime *increment caused by execute or historian firing*. A normally initialized session stays at zero despite actual historian invocations. But the generic metadata updater and clone utility can write/preserve a nonzero value, so “can never be nonzero” is not literally true.

Write/read inventory (both refs unless specified):

| Path | What actually happens |
| --- | --- |
| `Core/features/magic-context/storage-db.ts:1796,1953-1988,2124` | DDL/default-column creation and tag-version trigger inserts initialize the field to zero. Conflicting existing rows update **tags_version**, not the fire counter. |
| `Core/features/magic-context/migrations.ts:3010-3051` | Migration installs the same zero-default trigger inserts; no increment. |
| `Core/features/magic-context/storage-schema-helpers.ts:134` | Schema repair/default metadata initializes zero. |
| `Core/features/magic-context/storage-meta-shared.ts:137,322,386-405,457` | Property-to-column map, zero default, initial insert and read. |
| `Core/features/magic-context/storage-meta-session.ts:128-172` | Generic `updateSessionMeta` **can** assign the field via that map. No scheduling/historian caller supplies an increment. Test fixtures supplying 2 or 3 are not firing writers. |
| `packages/plugin/scripts/clone-session.ts:1050-1089` | Generic discovered-column copy preserves source metadata except named reset fields; this counter is not reset. The ordinary clone core's explicit metadata subset does not include it (`Core/features/magic-context/storage-clone.ts:692-756`). |
| Pi | `Pi/commands/ctx-status.ts:177,184` puts the value into headless details as `lastExecuteThreshold` and `historian.lastFireCount`; `Pi/dialogs/status-dialog.ts` reads it at V:1178 / P:1221. No firing writer. |
| OpenCode / OpenCode 2 TS | Same shared store/updater. The v2 adapter builds the shared scheduler (`Core/v2/hooks/context.ts:330-348`); `Core/features/magic-context/scheduler.ts:55-121` returns a decision without incrementing any counter. No separate v2 increment. |
| Rust | The only engine/store occurrence of this counter is `crates/mc-store/src/move_inventory.rs:1528`, in the session metadata shipping inventory, not a firing update. `crates/mc-module` has no counter producer. Dashboard Rust only reads it (`packages/dashboard/src-tauri/src/db.rs:7617-7632`). |

The dashboard also labels the stored value **“Execute hits”** (`packages/dashboard/src/components/SessionViewer/SessionViewer.tsx:1805-1811`, both). OpenCode 2's `/ctx-status` mounts the **shared status view**, which has no fire-count input (`Core/v2/tui/status-dialog-mount.ts:38-70`, `Core/shared/status-view.ts:93-183`, both). Thus OpenCode has the **same underlying telemetry gap**, but not the same Pi headless `historian.lastFireCount` payload. The current Pi plain summary/shared overlay does not print a `fires` line either: the confirmed stale surface is its structured details, plus dashboard “Execute hits,” not every rendering of `/ctx-status`.

**Witness:** `packages/pi-plugin/src/issue-634-fire-counter.test.ts` runs the real context handler with a mocked historian runner. At both V and P the assertion that the runner was invoked **once passes**, then the exposed counter assertion fails: `Expected: > 0; Received: 0`. This is intentionally committed red under the report-only brief; it is not an implementation or a release-green test.

Recommendation: remove the misleading legacy count from status details, or replace it with a clearly named **recorded historian attempts** count/status breakdown sourced from actual `historian_runs` telemetry, retaining the separate in-progress flag. Pi records an attempt in `finally` (`Pi/pi-historian-runner.ts:1737`, both). Do not substitute compartment count, transform row count, or scheduler execute count: none means “historian fires,” and manual runs/failures need explicit semantics. A lifetime crossing counter would require a new, defined event/writer, not a label on this orphaned field. This recommendation is **not** in P.

**Verdict: confirmed — moderate telemetry/diagnosis defect, not evidence that compression never ran.**

## 2. Sparse decision rows and the mid-turn crossing

### Hook frequency is per client model call, not per user turn

The exact OMP **v18.8.6** source establishes the boundary:

- [`packages/agent/src/agent-loop.ts:1312-1362,1914-1925`](https://github.com/can1357/oh-my-pi/blob/v18.8.6/packages/agent/src/agent-loop.ts#L1914-L1925): each applicable inner-loop provider-call preparation awaits `config.transformContext(messages, signal)` before conversion; the prepared context is streamed at `:2085-2090`. Client-loop tool continuations/re-preparations therefore get another context pass.
- [`packages/coding-agent/src/sdk.ts:4147-4150`](https://github.com/can1357/oh-my-pi/blob/v18.8.6/packages/coding-agent/src/sdk.ts#L4147-L4150) maps `transformContext` to `extensionRunner.emitContext`; [`extensibility/extensions/runner.ts:1969-2035`](https://github.com/can1357/oh-my-pi/blob/v18.8.6/packages/coding-agent/src/extensibility/extensions/runner.ts#L1969-L2035) invokes registered context handlers.
- MC calls the scheduler on every ordinary context pass: `Pi/context-handler.ts` V:3160-3170 / P:3180-3190. It logs `transform: usage=... decision=...` per pass, not only on band transitions (V:3384 / P:3405). Routine heuristic work has a same-user-turn cadence gate (V:5699,5960-5972 / P:5786,6058-6070); that is **not** a gate around pressure evaluation, and force/history/explicit mutations have additional admission paths.

**Executable control at both refs:** two context invocations with the **same user-turn message list**, warm TTL and percentage-only 80% threshold produce `150544 / 224000 = 67.2%, defer`, then `185000 / 224000 = 82.6%, execute`. No new user turn is needed. This is an MC hook test, not a credentialed OMP run.

### Cursor's server-owned loop is inside that single call

OMP v18.8.6 [`packages/ai/src/providers/cursor.ts:1013-1046`](https://github.com/can1357/oh-my-pi/blob/v18.8.6/packages/ai/src/providers/cursor.ts#L1013-L1046) creates one assistant stream/message. Its `:1857-1908` dispatches interaction and exec frames inside that stream; `:2371-2577` handles local read/ls/grep/write/shell requests and sends results back through the exec channel. The successful completion emits one final assistant message (`:1489-1502`). None of those frame-dispatch paths re-enters SDK `transformContext`/extension `context`.

The client prepares one request; Cursor can do many server-side steps within it. MC cannot inspect/reduce each intermediate **model prompt** through its context hook, even when a local tool implementation services a frame. The source proves this topology, **not** that this particular session made exactly 100 steps. The reporter's missing row at a supposed internal crossing cannot prove a missed client hook: there may have been no hook opportunity at that crossing.

### `transform_decisions` is a cache-edit journal, not an evaluation log

At V:3519-3553 / P:3543-3577, `Pi/context-handler.ts` stages a decision only when `result.bustedThisPass` is true. That flag means a first render, applied mutation/reclaim, materialization or consumed published history (V:7399-7405 / P:7590-7596), **not** “percentage changed” or “scheduler evaluated.” A `defer` can have a row when another permitted edit happened; an `execute` with unchanged served bytes can have **no** row.

`Core/features/magic-context/transform-decision-log.ts:245-255,314-344` (both) keeps one pending Pi decision per session, binds it to a newer assistant entry when available, and schedules a best-effort DB write. Before binding, another busted pass can replace the pending entry. It needs a persistent DB path; missing assistant binding/shutdown/write failure can also lose a row. Ordinary OpenCode staging similarly requires `bustedThisPass` (`:234-242`); Rust's decision mapping also excludes unchanged SOFT+ (`:180-220`). Retention is 2,000 rows per session/harness (`:16-22`), not an eight-row cap.

**The 477 denominator is wrong:** `session_meta.counter` is the **tag-number allocation high-water mark**, not evaluation count (`Core/features/magic-context/tagger.ts:405-443,845-855`, both; `Core/hooks/magic-context/execute-status.ts:196` labels it “Tag counter”). The two-call control above leaves it at **3 tags**, not 2 evaluations. Eight durable cache-edit rows among 477 allocated tags is entirely compatible with the code. The exact eight events cannot be reconstructed from the excerpt alone; the full transform text log and assistant binding timeline would be needed. Counting this table as every evaluation is not its contract.

We can improve evaluation telemetry/documentation or build a host integration if OMP exposes per-inner-request interception; neither is delivered here. MC already evaluates each **available** context build. It cannot promise a per-step growth bound inside Cursor's private request/tool loop.

**Verdict: out of our reach (provider-internal model steps); sparse rows and the “477 evaluations” interpretation are not evidence of a scheduler defect.**

## 3. The alleged 7.5× prompt overshoot

Three different phenomena must not be conflated:

1. **No client-call pressure opportunity inside a Cursor server turn.** Genuine prompt growth there is invisible to the extension's context hook until control returns. Moving MC's existing scheduler call cannot insert a hook into that provider stream. This explains a possible jump between successive *visible* context passes, but does not establish the exact intermediate prompt sizes.
2. **Wrong numerator in 0.46.1.** Cursor's [`applyTurnEndedUsage`, OMP v18.8.6 `cursor.ts:5424-5437`](https://github.com/can1357/oh-my-pi/blob/v18.8.6/packages/ai/src/providers/cursor.ts#L5424-L5437) adopts turn-ended input/output/cache counters, subtracts cache from inclusive input, then reconstructs their total. MC extracts **one assistant message** and sums its input/cache components, not multiple messages itself (`Pi/pi-pressure.ts` V:55-120 / P:101-172). V's successful message-end path deliberately omits the absolute wall (`Pi/index.ts:900-904`) and stores the aggregate as `lastInputTokens`. A later snapshot takes the maximum of persisted and live readings (V `pi-pressure.ts:146-189`), producing phantom pressure, emergency and inflated reclaim floor math.
3. **Wrong denominator in the original issue.** The proven-floor bug is separate. A trusted 256k overlay already blocks a floor above its absolute wall (`Core/shared/window-geometry.ts:660-675`, both). The follow-up's constant 224k denominator therefore does **not** support attributing these new giant percentages to the original 8.7M denominator latch. P repairs legacy accepted-input proof with commit `924719e29a` and additionally rejects aggregate evidence with `ba0eca4d0a` (`Pi/pi-proven-floor.ts:238-274`).

OMP's current-context number is also not infallible: v18.8.6 `agent-session.ts:12395-12397` delegates to [`session/session-stats.ts:355-364`](https://github.com/can1357/oh-my-pi/blob/v18.8.6/packages/coding-agent/src/session/session-stats.ts#L355-L364); its prompt anchor calls [`packages/agent/src/compaction/compaction.ts:255-264`](https://github.com/can1357/oh-my-pi/blob/v18.8.6/packages/agent/src/compaction/compaction.ts#L255-L264), which prefers `usage.contextTokens` if present, otherwise input/cache sums. Pending messages are tokenizer estimates (`session-stats.ts:243-269,303-342`). Issue 636 already includes an impossible host `contextTokens=703152`. Neither a transform's `input_tokens` row nor that host field alone proves an actual 573k/1.49M outgoing request. The original usage payload, its contextTokens and the served messages/envelope would distinguish billing aggregation, raw-branch estimates and real growth; they are not in this comment.

### Numerical replay through the train

On P a provider or persisted/live host reading above the **raw trusted 256,000 wall** is rejected, not clamped to an emergency. The **224,000 usable denominator** is different: valid input between 224k and 256k is still admitted. `Pi/index.ts:741-776,853-932` handles message-end; `Pi/pi-pressure.ts:358-402` handles persisted/live snapshots. With unusable readings, the transform tokenizes the request view, replaying a previously served prefix when available, and adds the available system/tool envelope (`Pi/context-handler.ts:3119-3169`). It passes that same admitted pair to the pipeline/reclaim and historian (`:3496-3505,3603-3606`).

| Supplied number | V pressure with 224k denominator | P treatment with trusted 256k wall |
| --- | --- | --- |
| 150,544 | 67.2071%; below either proposed trip | Sane host/request reading remains usable; same percentage. |
| 179,200 | 80%; percentage-only trip | Still executes **when an available context pass sees it** in percentage-only mode. |
| 573,414 (and host 576,230) | 255.9884% (257.2455% for 576,230) | Reject as provider/host evidence; use admitted host or outgoing-request estimate, not 573,414 simply because it was logged. |
| 1,490,740 | 665.5089% | Same rejection/fallback policy. |
| 7,576,040 | 3382.1607% | Reject aggregate. With the supplied sane host fallback **192,801**, pressure is **86.071875%**. |
| 192,801 | 86.071875% | Unchanged sane reading; percentage-only 80% execute, above its 85% force band, **not** absolute-window emergency. |

These are not predictions of replacement values at 06:55 or 07:04: the sane host/actual request estimates for those two passes were not supplied. The replay explicitly uses **192,801 as a conditional fallback**, not an invented historical sample at those timestamps. Executable snapshot controls confirmed that P rejects each of 573,414, 1,490,740 and 7,576,040, and that supplying fallback 192,801 returns exactly it. Conversely a supplied **actual-request estimate of 573,414** remains 573,414 / 224k = 255.9884%: fallback estimates are deliberately **not capped**. P can still execute/emergency on genuinely oversized visible request bytes. It does not guarantee every request fits, or shrink Cursor's internal prompts.

Two corrections to the follow-up's arithmetic/config reading:

- 1,490,740 is **6.655× 224k usable**, **5.823× 256k raw**, or **7.454× a 200k target**. “7.5× the 224k window” uses the wrong denominator.
- If `execute_threshold_tokens.default=200000` is still effective, it **overrides** the 80% setting, not ORs with it. At 224k it is below the 90% clamp (201,600), giving an **89.2857% execute trip at 200k**, not 179,200. Source: `Core/hooks/magic-context/event-resolvers.ts:347-388`, `Core/features/magic-context/scheduler.ts:71-94` (both), plus the train's passing `token mode overrides percentage even with the reported inflated denominator` regression. A warm 192,801 sample defers in that token mode absent other signals/TTL expiry. Our same-turn 185k execute control intentionally uses **percentage-only** configuration. The comment alone does not establish which override was effective on every historical pass.

Thus the log proves that MC eventually **executed**, not that its trip was absent. V's aggregate interpretation explains false giant *pressure samples*; P fixes that. Genuine growth inside the provider's server turn remains a separate limit, and the excerpt cannot establish that the real prompt reached either logged size.

**Verdict: out of our reach (provider-internal growth); the claimed actual 7.5×-window prompt is unproven, while the independently reproduced aggregate-pressure defect is already repaired by `ba0eca4d0a` on P.**

## 4. The emergency input sample

**7,576,040 = 371,304 + 7,204,736**, and **7,576,040 / 192,801 = 39.2946**. Given the reporter's supplied turn counters, that is billing input, not instantaneous context. MC does **not** accumulate this field across calls: `setEmergencyDropSample` assigns `max(0, round(inputSample))`, not `+=` (`Core/features/magic-context/storage-meta-persisted.ts:1088-1103`, both). It samples the current pressure when a reclaim batch actually removes bytes. V admits the already-aggregated message usage as pressure, so it can latch that bad number. This is the issue-636 input defect's downstream effect, not a second summation implementation.

### All runtime readers/writers and their semantics

The relevant field/helper occurrences were searched across both snapshots, including Rust. Storage defaults, clone preservation and inventory transport are separate from these runtime consumers:

| Consumer | V / P source | Use |
| --- | --- | --- |
| Pi context model/episode reset | `Pi/context-handler.ts` V:2933,3268-3276 / P:2945,3291-3297 | Model/scope reset and pressure-exit rearm; numeric magnitude is not pressure. Exit needs positive current pressure five points below force. |
| Pi **historian** force admission | V:5034-5036 / P:5090-5092 | `sample === 0`, with >=95% escape. It **does** have a historian reader, but it reads episode state, not input size. |
| Pi pipeline ride/cleanup gates | V:5917-5919,6460-6485 / P:6014-6017,6640-6654 | Zero/nonzero latch; clear before independently priced mutation; >=95% escape. |
| Pi tiered drop planner | `Pi/heuristic-cleanup-pi.ts:387,453-465` (both) | Passes prior sample and `hasPriorDrop = sample > 0` to shared planner. |
| Pi batch finalization | `Pi/context-handler.ts` V:6942-6953 / P:7132-7143 | **Assigns admitted `contextUsage.inputTokens` only after real reclaim mutation.** P's upstream guard rejects aggregate readings above the trusted raw window and supplies an admitted fallback, covering this producer without changing the setter. |
| Shared TS/OpenCode historian and cleanup | `Core/hooks/magic-context/transform.ts` V:1237,2028,2944 / P:1272,2092,3026; `transform-postprocess-phase.ts` V:1908-1910,2149,2456-2466,2737 / P:1968-1970,2254,2563-2573,2868 | Same episode checks/reset and final assignment; not a numeric input-pressure source. |
| Shared TS planner/producer | `Core/hooks/magic-context/heuristic-cleanup.ts:133,174-186,226-229` (both) | Reads latch for selection; after actual drops writes current usage. |
| Shared planner math | `Core/hooks/magic-context/emergency-drop.ts:201-226` (both) | Nonzero blocks a second force episode below 95%; prior value appears in diagnostic reason only. **fixedFloor uses currentTotalInputTokens − live tail**, not the old latch. |
| TS-to-Rust module state sync | `Core/hooks/magic-context/module-state-sync.ts:1063-1069` (both) | Sends prior sample plus its >0 boolean during forced state sync. |
| Rust loaded/seeded state | `crates/mc-store/src/lib.rs:4995,11359-11365` (both) | Loads/seeds nonnegative sample and separate episode boolean. |
| Rust selection/reset/finalization | `crates/mc-module/src/transform.rs` V:5376-5377,5635,7226 / P:5464-5465,5739,7355 | Prior sample passed to selection, reset on exit, current usage assigned after applied reclaim. `selection.rs:242-245,1287` (both) uses the episode boolean; sample is diagnostic, not an equality/size gate. |

**Upgrade nuance:** rejecting an aggregate does **not** itself migrate/clear an already latched 7,576,040. Our seeded-latch replay kept that stored value after P message-end, while `lastInputTokens` and status pressure became 192,801. That is not continued 39× pressure: **7,576,040 and 192,801 have the same “nonzero episode already acted” meaning** to these readers. It clears through ordinary pressure exit/model reset/independent bust; at >=95% the documented escape allows reclaim. Relatching every fresh input sample would defeat the anti-cache-churn episode gate. No new defect is established by leaving the old nonzero latch alone.

**`/ctx-status` does not display or divide by `last_emergency_input_sample` at either ref.** Its pressure comes from `lastInputTokens`/live usage and window geometry (V `Pi/dialogs/status-dialog.ts:976-1000`; P `:998-1039`), using the shared Pi pressure resolver. P supplies the trusted raw-window bound before resolving it. The footer does likewise (`Pi/status-line.ts` P:95-150). The summary's input/context fields are distinct from episode state (`Pi/dialogs/status-dialog.ts` P:419-452). Thus issue 636 covers the **actual pressure display and future latch samples**, not an emergency-sample display that does not exist. A messages-only fallback is an estimate when system/tool envelope metadata is unavailable; `contextTokens` is also rejected if above the trusted wall.

**Verdict: already fixed on post-046 (`ba0eca4d0a0460e3f6d28f1848151708cf00dfee`) for future Pi pressure-derived samples and status pressure; the surviving old latch is not a size/display defect.**

## Verification, limits and isolation

- **Bun 1.4.2**. V's report-only replay: **3 pass, 0 fail, 17 assertions**, one file. P's same replay plus `turn-aggregate-usage-pi.test.ts`, `proven-floor-measured-pi.test.ts` and `heuristic-cleanup-pi-native-episode.test.ts`: **22 pass, 0 fail, 108 assertions**, four files. These exercised same-turn defer→execute, all three giant numerators, the conditional 192,801 fallback, oversized actual-request estimates, existing floor repair and native episode controls. The passing replay fixture is retained with local evidence, not committed as product/test-suite scope expansion.
- Final intentional counter witness at **each ref**, plus the release-based task checkout locally: **0 pass, 1 fail, 2 assertions**; the mock invocation control passes and **only the zero-counter assertion** fails. Command: `bun test --cwd <snapshot>/packages/pi-plugin src/issue-634-fire-counter.test.ts --timeout 30000` (or `--cwd packages/pi-plugin` for the task checkout), under a fresh throwaway HOME. The test is deliberately not skipped or inverted to conceal the defect.
- Linux shared controls: `bun test --cwd packages/plugin src/features/magic-context/transform-decision-log.test.ts src/features/magic-context/scheduler.test.ts src/v2/hooks/execute-threshold.test.ts src/hooks/magic-context/emergency-drop.test.ts --timeout 30000`: **58 pass, 0 fail, 139 assertions**, four files. In particular, `latches the whole force-pressure episode across fresh usage samples` passes, as do OpenCode 2 token-override controls.
- **TypeScript 5.9.3**: Linux `bun run --cwd packages/pi-plugin typecheck` passed. The package excludes test files, so a temporary config additionally included just the new witness with `exclude: []` and `compilerOptions.types: ["node", "bun"]`; `bun packages/pi-plugin/node_modules/typescript/bin/tsc --noEmit -p packages/pi-plugin/tsconfig.issue634.json` passed. That temporary config is not committed. The initial config without Bun types could not resolve `bun:test`; adding the test's proper ambient type dependency fixed the verification config, not product code.
- **Biome 2.5.1**: Linux `bun run --cwd packages/pi-plugin lint` passed, **249 files**, 10 existing warnings, no errors. A new import-format error was corrected before this final check. Sidekick reviewed the new comments; prose now expands MC and explains the compression-worker control. AFT inspection was partial (no local Biome/LSP producer); explicit compiler/lint checks are the authoritative evidence.
- Remote Linux commands could check the task package, but could not extract the two ref snapshots (`tar: ... Function not implemented`, both dependency-directory and ordinary-directory destinations). Exact-ref installs/replays therefore ran **locally**, once the filesystem limitation was established. `bun install --frozen-lockfile` at each exact-ref snapshot installed **983 packages**; no tracked manifest/lockfile changed. The Linux counter run logged `historian trigger fired` but did not satisfy the mocked runner precondition, unlike local runs; that remote red is **not used** as counter-defect proof. Local V, P and task-checkout runs reached the correct counter assertion.
- No full-suite or native Cargo build was necessary for a report and a Pi-only witness; no product, schema, lockfile or public API change was made. No Rust executable or real OMP/OpenCode/Cursor session was run. Host hook/provider topology is an exact-version source audit, not a live end-to-end or authenticated-provider measurement. There is consequently no host PID/`lsof` claim to substitute for isolation proof.

All test/install/check commands used `env -u OPENCODE_DB HOME=<new temporary directory>`; package test preloads additionally redirected XDG data/config and `MAGIC_CONTEXT_TEST_DATA_DIR`. No live store was opened, read, written or migrated: `~/.local/share/opencode/*.db`, `~/.local/share/cortexkit/magic-context/{context,store}.db`, `~/.config/opencode/*`, `~/.config/cortexkit/*`. No host executable was launched against any store. Replay fixtures use in-memory or test-temporary databases and a temporary overlay, not the reporter's or operator's data.

Local replay source and captured outputs are retained under `.tmp-issue634-evidence/`, **outside** regenerable build/dependency directories. To repeat the ref comparison in this worktree, extract `git archive v0.46.1` and `git archive 0049ccaf878e821fae189728aaebd593e64c7e31` into isolated snapshot directories, install frozen dependencies with throwaway HOME, and copy the retained replay into each Pi `src/` directory. Run `bun test src/issue634-replay.test.ts` from each Pi package with `POST046=1` **only** for P. The new committed counter witness can be copied/run the same way. Retained passing replay code is an investigation artifact, not part of a published test API.

## Draft reply to the reporter (not posted)

Thanks — the zero fire count is a confirmed telemetry bug: we reproduced an actual historian invocation with the counter still at zero. It is not fixed on the release train yet.

Two corrections: `session_meta.counter` counts allocated tags, not evaluations, and decision rows record cache-changing passes, not every context build. We do evaluate every client model call. Cursor can run many server-side steps inside that one call, where our context hook cannot intervene.

The next release includes accepted-input floor repair, window-source/denominator status, and rejection of oversized turn billing usage for pressure, reclaim, historian and status. It does not add a bound inside Cursor's loop. Your 7,576,040 sample is consistent with the old aggregate-input bug, but the stored emergency sample is an episode latch, not the status numerator. The logs alone do not prove a real 1.49M prompt; that number is 6.66× 224k, or 7.45× the 200k target. If the 200k token override remains enabled, the trip is 200k rather than 179,200.
