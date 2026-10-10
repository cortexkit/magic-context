# Issue 641: OMP's context deadline can bypass managed history

## Finding and scope

**The invariant is broken on Oh My Pi (OMP) 18.8.6.** A context-handler timeout is fail-open: OMP ignores the missing replacement and sends its current messages. It does not cancel the extension's JavaScript or expose the handler timeout signal as `event.signal` / `ctx.signal`. Magic Context can subsequently commit state and capture an LKG representation which the provider never received. A generation-only stale-pass guard does not prevent those late state commits when no newer context invocation has started.

Terms: **LKG** is the last-known-good transformed request prefix; **MC** abbreviates Magic Context; **FTS** means full-text search; **WAL** is SQLite's write-ahead log. A **pass receipt** in the proposed design is a small turn-scoped record proving that our context callback completed successfully within its internal budget; it is not an acknowledgment from OMP.

Sections 1–4 record the original report-only investigation. The implemented deadline and dispatch controls, their verification, and the remaining side-session limitation are recorded in section 5. The incident facts—Windows, `cursor/grok-4.7`, OMP 18.8.6, plugin 0.46.1, 394.2 MB store, 573,414 input tokens, 148,608 dropped, marker at 06:55:14.194 and decision at 06:55:14.213 after the 06:55:13.641 timeout—come from **issue 641**, not from inspecting the reporter's store.

Two source revisions' Pi handler stages and writer-contention outcomes were measured:

* **Master at worker base:** `db0582e9c6b44ffafc7a10867ca4e6a24899e19e`.
* **Issue 640 review-fixes tip (bounded writer retries and per-session stale-pass protection):** `ff8d438a16ebbc3eae82acd29ea572731b086971`, materialized from this repository's Git objects inside this worktree's ignored `.cache/issue-641/` directory. The snapshot runner checks that `@magic-context/core/shared/sqlite` resolves into the snapshot, not back into master. No other checkout was accessed.

Unless explicitly marked as the issue 640 tip, all Magic Context `file:line` citations below refer to **master at `db0582e9c6b44ffafc7a10867ca4e6a24899e19e`**. Tip citations use the full `ff8d438...` revision's own line numbers; the same handler has different line numbers in those revisions.

Both advertise plugin version 0.46.1 (`packages/pi-plugin/package.json:2-3`). The real late-Magic-Context host probe used the worktree's prepared build, **not a byte-identical npm release tarball**. At master, decision writes wait for a later assistant message; the incident's row was reported immediately after the late transform. That timing difference is discussed in section 3.

Runs were local macOS arm64, Bun **1.4.2**, actual OMP CLI **18.8.6**, against the repository's loopback Anthropic-protocol mock. No Cursor/Grok service, Windows filesystem, production embeddings service, or real historian was used. The direct handler fixture supplies model metadata `cursor/grok-4.7`, a 256,000-token catalog window and 32,000-token output allowance. A direct `resolvePiWindowGeometry` check produced `usableSoft=224000`, `usableHard=251904`, `geometry=shared_upfront`: the intended 224k usable target, with the separate near-absolute emergency wall. The exact input/output of that geometry check is in `probes/issue-641/evidence/geometry.json`. Its measured synthetic wire is 579,298 estimated conversation + tool-call tokens; the provider-pressure sample is 573,414. This is similar pressure, not a reconstruction of the private conversation.

### Isolation and durable evidence

Every OMP run used a separate root under `$TMPDIR/magic-context/issue-641/`. `HOME`, `CFFIXED_USER_HOME`, `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR`, `OPENCODE_DB`, and `MAGIC_CONTEXT_STORAGE_DIR` pointed into that root. The probes also redirect the host's agent directory. The fixture uses only databases it creates itself. No live store was opened, read, migrated, or copied.

The host extension ran `lsof -p <host pid>` while the context handler was active and the parent captured it again before shutdown; both checks required nonempty `.db` descriptor lists entirely inside the disposable root. The captured databases are `agent.db`, `models.db`, `skill-descriptions.db`, `legacy-pi-extension-cache.db`, and `data/cortexkit/magic-context/context.db`, including WAL/SHM sidecars. The direct fixture process and independent Python writer lockers were checked too.

Generated evidence is stored outside Git at `~/.local/share/cortexkit/magic-context/specimens/issue-641/evidence/` (directories `0700`, files `0600`). Paths below `evidence/` are preserved; the probe scripts remain in `probes/issue-641/`:

* `host-{slow,fast,refuse,late-mc,fenced}.json`: timestamps, handler signal observations, full outgoing request captures (including raw body), host events, state snapshots and served ledgers.
* `host-*-lsof.txt`: full descriptor receipts; each JSON also contains the handler-entry DB descriptor list.
* `late-host-replay.json`: the actual raw request and subsequent replay of the late, never-applied LKG prefix.
* `fixture-{master,issue-640-tip}.json`: all existing stage samples, SQL operation timings, table counts, state before/after the 30s deadline, writer-contention outcomes, and separately measured checkpoints.
* `*-markers.jsonl` and fixture/locker `*-lsof.txt`: synthetic durable marker and isolation receipts.
* `omp-source-excerpts.txt`: pinned npm source excerpts with original line numbers and SHA-256 hashes; upstream MIT license is alongside it. `receipts.json` records run roots and captured-body hashes.

These small receipts are committed outside `dist`, `target`, and caches. Hundreds-of-MB synthetic databases remain disposable and are not committed.

## 1. What OMP does on timeout

The requested runner lives in the pinned package at **`src/extensibility/extensions/runner.ts`**, not a file at this repository's root. All OMP line references in this section refer to `@oh-my-pi/pi-coding-agent@18.8.6`; the excerpts are preserved in the evidence directory.

* `runner.ts:130-143` defines a 30,000 ms default, a module-level value, and a `testSetExtensionHandlerTimeoutMs` helper. There is no supported extension API to configure the deadline. Importing or monkey-patching a test helper is not a supported solution, especially with the CLI's bundled runner.
* `runner.ts:293-368` races the work against an interrupt promise. Expiry aborts a **runner-private** controller and resolves the timeout sentinel (`:317-322`). It does not terminate the work promise. The extra `Bun.sleep(0)` race only gives cooperative cancellation a turn to settle; it is not a join of the extension.
* `runner.ts:1513-1540` passes that private signal to a scoped UI context / registration scope. `createHandlerContext` only overrides `ui` (`:267-279`), not `signal`.
* `emitContext` creates a context with no signal property and emits `{ type: "context", messages: currentMessages }` (`:1969-1995`). The outer operation signal is passed to the **runner**, not exposed to the context handler (`:1995-2003`).
* On timeout it logs/emits an extension error and returns `onFailure?.(...)` (`:1547-1561`). `emitContext` supplies **no** failure callback (`:2000-2002`), so this is `undefined`. Only a nonempty result with `messages` replaces `currentMessages` (`:2005-2018`).
* The final `signal?.throwIfAborted()` (`:2032-2035`) checks the outer operation signal. Aborting the private handler-timeout controller did not abort that operation. The SDK uses this array as its transform result (`src/sdk.ts:4147-4150`).

Thus OMP keeps the **current array entering the timed-out handler**, usually a clone of the original history. It retains edits by preceding extensions, and synchronous in-place edits to the shared array can also survive; it is not a rollback to pristine input. Our probe returns a replacement array only after sleeping, which isolates the ignored-return case.

### Actual host runs

All five were the pinned CLI in RPC mode, not a reimplementation of `emitContext`:

| Probe | Handler behavior | Mock-provider observation |
|---|---|---|
| `slow`, PID 69121 | Sleep 32s; return user text `MC641_TRANSFORMED` | **1 request at 30,089 ms** after prompt submission; contains `MC641_ORIGINAL`, not replacement text |
| `fast`, PID 72200 | Sleep 10 ms; same replacement | **1 request at 2,124 ms**; replacement text present, original absent |
| `refuse`, PID 79685 | At 25s append a refusal record and call `ctx.abort()` | **0 requests** |
| `late-mc`, PID 86408 | Delay 32s before calling the real built MC context handler | **1 request at 30,227 ms** with original text; MC starts/finishes after that request |
| `fenced` | Sleep 32s in `context`; a synchronous `before_provider_request` hook aborts if no managed receipt exists | **0 requests**, despite a context timeout; provider-fence audit records `managed=false` |

Prompt-to-request times include host/inspection work; they are not pure handler times. The fast control proves the replacement would have reached the provider if returned in time. The slow handler's entry/end receipts both report `eventSignal=false`, `ctxSignal=false`; its end arrives about 32,001 ms after entry. Host `extension_error` receipts name `handler timed out after 30000ms`.

The provider body still includes OMP's date/cwd reminder and API conversion. “Original” here means unmanaged user/history bytes, not an assertion that the entire serialized HTTP body equals `AgentMessage[]`.

`ctx.abort()` is a usable escape hatch: our 25s control establishes a pre-deadline refusal without an HTTP request. **Throwing alone is insufficient** because OMP also catches handler errors and continues. Magic Context already wraps escaped exceptions with display-only refusal plus `ctx.abort()` (`packages/pi-plugin/src/pi-context-refusal.ts:15-19,33-65`). A host timeout does not throw into that wrapper, so its refusal code never runs for the timeout itself.

The fifth probe also establishes a useful independent backstop. OMP exposes `before_provider_request`; it has its own handler dispatch (`runner.ts:2038-2073`) and provides `ctx.abort()`. A cheap synchronous dispatch fence can reject a missing/expired context-pass receipt even after OMP stops waiting. This is **not** permission to leave expensive work running or to extend the context deadline. The payload hook's own exceptions/timeouts are also fail-open; its fence must do no DB, network, dialog, or awaited work.

## 2. Where time goes on a large synthetic session

The fixture is schema-valid and entirely generated. `initializeDatabase` + migrations produce **106 SQLite tables**, including FTS shadow tables, versus the issue's approximately 90 tables. The large main file is **399,183,872 bytes** (399.18 decimal MB / 380.69 MiB), close to 394.2 decimal MB. It contains:

* 19,000 `memories` and `memory_embeddings` rows with 1,536-dimensional Float32 vectors;
* 12,000 `compartments` and `compartment_chunk_embeddings` rows with 3,072-dimensional Float32 vectors;
* 5,000 archive `message_history_fts` rows, plus automatically maintained `memories_fts`;
* the actual `message_fts_rowid_map_backfill_state`, `message_time_backfill_state`, and `tool_owner_backfill_state` tables, with unfinished synthetic backfill state;
* a 600-message user / assistant / tool-call / tool-result branch, approximately 573k-token pressure. A new user tail makes 601 messages for the search/wait lanes.

No unrelated “padding” table or copied live DB was used. Archive vectors/content occupy the same DB but are separate from the active session. This separates **total DB size** from **live-wire/session size**. The small control starts at 1,048,576 bytes with the same schema and wire. Default WAL autocheckpoint is 1,000 pages, page size 4,096 bytes.

The handler is `registerPiContextHandler` itself, including `withSqliteTransformPass`, not a stand-in compactor. Existing observer timers are collected (`context-handler.ts:792-813`, `context-perf-hooks.ts:14-34`). The deliberately slow historian is installed through the existing test hook (`context-handler.ts:452-461`); it is a never-settling promise, not a fabricated DB latency. A 30s timer separately snapshots state, simulating the host's stopped wait. That fixture timer does **not** cancel the pass. Real host fail-open behavior is established separately above.

### Whole-pass and writer measurements

Milliseconds, one measured run per lane/revision (not percentiles):

| Lane | Master | Issue 640 tip |
|---|---:|---:|
| Small DB, cold 600-message pass | 522.22 | 821.92 |
| Small DB, warm pass | 142.02 | 94.05 |
| Large DB, cold pass | 321.10 | 290.65 |
| Large DB, warm pass | 76.49 | 70.92 |
| Large DB, new user / auto-search enabled | 141.80 | 123.54 |
| Large DB, emergency with in-flight historian | **30,092.74** | **30,091.95** |
| Small DB, independent writer held; fresh session, no LKG | 329.37, refusal | **16,582.94**, refusal |
| Large DB, independent writer held; fresh session, no LKG | 300.68, refusal | **16,566.17**, refusal |

The two revision commands were concurrent local probes, not controlled isolated CPU benchmarks. Cold small-vs-large comparisons are confounded by process warmup/tokenizer caches; **they do not establish a speedup from a larger DB**. They do disprove “a 394 MB store alone necessarily costs 30s” in this generated workload. The long waits are distinguishable from those subsecond CPU/DB stages.

Writer outcomes are the real `PiStorageBusyError`, not a successful raw return. Direct fixtures omit `ctx.abort`, preserving the thrown refusal contract; the real-host abort controls above establish dispatch behavior. Issue 640's measured 16.57–16.58s wait agrees with its 16.5s ceiling. The follow-up task instructions also supplied a separate **19.1s** observed run; use that as a conservative operational observation, not a value produced by this fixture.

### Large-store existing stage timers

Milliseconds; cells are **master / issue 640 tip**:

| Stage | Cold | Warm | Auto-search | Historian-wait |
|---|---:|---:|---:|---:|
| `findSessionId` (includes project identity/tracking) | 32.24 / 26.23 | 29.26 / 26.42 | 30.61 / 27.00 | 32.38 / 29.71 |
| `getOrCreateSessionMeta` (successful admission) | 0.45 / 0.12 | 0.22 / 0.14 | 0.28 / 0.20 | 0.42 / 0.23 |
| `tag:identity` | 166.90 / 154.54 | 0.54 / 0.45 | 3.40 / 1.02 | 0.38 / 0.35 |
| `tag:tokenCounting` | 25.49 / 22.78 | 0.09 / 0.08 | 0.16 / 0.15 | 0.10 / 0.08 |
| `getTagsBySessionSnapshot` | 0.40 / 0.29 | 0.41 / 0.35 | 0.16 / 0.14 | 0.74 / 0.83 |
| `applyHeuristicCleanup` (includes reclaim) | 37.21 / 34.33 | 20.72 / 19.85 | 23.93 / 20.39 | 30.68 / 31.79 |
| `boundaryTriggerChecks` (historian wait lives here) | 0.01 / 0.01 | <0.01 / <0.01 | <0.01 / <0.01 | **30,000.87 / 30,000.04** |
| `autoSearch` | <0.01 / <0.01 | <0.01 / <0.01 | **55.34 / 48.30** | <0.01 / <0.01 |
| `tokenAccounting` | 24.97 / 19.38 | 1.02 / 0.98 | 1.44 / 0.95 | 1.06 / 1.06 |
| All measured synchronous DB operations, overlapping above | 91.64 / 84.50 | 3.99 / 4.65 | 19.39 / 20.90 | 8.57 / 8.86 |

Full, unrounded samples and all remaining stages are in the JSON receipts. Timer names overlap: `emergencyRecoveryBlock` also includes the historian wait; `runPipeline` includes tagging, reclaim and injection. Do not add them as independent costs. On refusal, `getOrCreateSessionMeta` never records a successful stage sample: the 16.5s missing interval is writer admission, not evidence of a fast failed pass. The logged `total` is also recorded before final LKG/served capture (`context-handler.ts:4037-4044,4085-4131`); the external wall timer is the outcome measure.

### Which work scales, and what is actually awaited

1. **Historian:** the emergency branch explicitly awaits the same-session in-flight promise for **30,000 ms** (`context-handler.ts:3278-3325`). Its child is not aborted by that wait. The historian's default runner timeout is **600,000 ms** (`pi-historian-runner.ts:163`; handler option wiring at `context-handler.ts:4558-4592`). A normal historian starts fire-and-forget after pipeline work (`:3561-3589,4510-4686`), but emergency turns synchronously join it. This alone consumes the entire OMP budget, before any remaining tagging/reclaim/capture work. Both measured revisions therefore miss the deadline even though their DB work is small. Whether an in-flight historian caused the private Windows incident cannot be determined from its two warn lines.
2. **Session/wire work:** parsing/fingerprinting/tokenization, tag creation, transcript building and reclaim operate on live messages/targets. Cold `tag:identity` is 155–167 ms here, versus under 1 ms warm. The scoped tagger derives a conservative live-wire floor (`context-handler.ts:2788-2796`; `storage-tags.ts:2124-2185`) and caches DB/version/floor matches (`tagger.ts:751-855`). It is not always a full session load. However the canonical `getPiTagSnapshot` / `getTagsBySessionSnapshot` path still loads the session tag set for active-tag heuristics and accounting (`context-handler.ts:6423-6433`); that can grow with total session tags even when the wire shrinks. Reclaim is included in `applyHeuristicCleanup`, not an independently timed 30s stage.
3. **FTS:** message-index reconciliation is scheduled from the context pass, not awaited (`context-handler.ts:2603,2782-2786`; `message-index-async.ts:250-278`). It can still contend for the writer / event loop later. Optional Pi auto-search **is awaited** on a qualifying new user tail (`context-handler.ts:3645-3709`; `auto-search-pi.ts:285-319,357-394`). It uses `unifiedSearch`, with message FTS and optional query embedding/vector retrieval. Its local search deadline is 3,000 ms (`auto-search-deadline.ts:1-14`), which must also fit the global pass budget. Our search lane exercised FTS with embeddings unconfigured: 55.34 / 48.30 ms; it did not benchmark an external embedding model's startup/network latency. One concrete DB-size-dependent foreground read was the physical FTS coverage proof: `message_history_fts_docsize EXCEPT message_fts_rowid_map`, followed by reading missing rows' session IDs (`message-fts-session-filter.ts:23-41,76-94`). It took **14.43 / 13.64 ms** over this fixture's 5,000 unmapped archive rows. That cached proof is invalidated by local writes/external commits; it can scale with the whole FTS inventory, not just the active session. The scoped message-content read took **0.41 / 0.40 ms**. Search also performed small model-ID/embedding-scope discovery queries, but no vector generation.
4. **Embeddings/backfills:** vectors merely sharing `context.db` do not imply every pass scans them. The ordinary fixture's SQL contains a small session-scoped compartment-embedding project-path repair, but no bulk vector loading or embedding generation. Normal project/session embedding drains are explicitly deferred before registration, coverage scans or model work (`commands/ctx-embed.ts:258-310`; hook wiring `index.ts:1582-1592`). Database-open backfills are scheduled/deferred by `storage-db.ts:1033-1098`; the fixture creates/migrates an explicit synthetic DB, so it does not pretend to benchmark that whole startup path. Existing unfinished backfill tables establish shape, not a claim that the maintenance ran on the foreground stack. Real background maintenance can still increase writer contention, dirty WAL volume and event-loop stalls.
5. **WAL:** normal setup enables WAL / `synchronous=NORMAL` but no explicit periodic checkpoint task (`shared/sqlite-context-pragmas.ts:12-24`). SQLite's 1,000-page automatic checkpoint can be paid inside a write/commit; the SQL timer cannot separate that component. We measured `wal_checkpoint(PASSIVE)` **after** each pass and deferred drain, outside foreground timing: large cold **3.72 / 6.84 ms**, large warm **0.06 / 1.93 ms**, large historian-wait **6.25 / 5.15 ms**. There was no explicit foreground `wal_checkpoint` statement in the recorded queries. A total DB-file size is not a checkpoint-byte count; dirty WAL size/readers/storage matter. Moving checkpoints out of the pass needs an explicit writer-aware maintenance policy, not just moving an existing timer that does not exist.

The evidence supports removing the synchronous historian wait as the first latency fix. It does **not** support attributing 30s to an unmeasured full embedding scan or FTS maintenance merely because the file was 394 MB.

## 3. What a late result changes

OMP only discards the return value. The extension remains alive, with its DB connection, mutable caches, timers and host session-manager API. There is no “host applied this context result” acknowledgment in the context protocol.

### Observed writes and representations

* **Real late host:** provider receipt is at `1791491856297`; MC's delayed handler starts at `1791491858384`, returns at `1791491858412`, and the LKG slot has `captured_at=1791491858412`. It lands one active tag, clears `last_transform_error` to the empty string, persists an LKG slot and emits a three-message served-ledger record despite the original unmanaged request already having completed. `host-late-mc.json` records all of these.
* **Actual replay of that receipt:** the coordinator accepts the subsequent branch, producing **five messages**: two MC history headers, tagged `§1§ MC641_ORIGINAL`, the real assistant reply, and a new follow-up. The captured provider request contained neither those MC headers nor the tag (`late-host-replay.json:19-65`). This is an actual replay from the late host's stored slot, not a separately synthesized LKG. The probe tests coordinator ancestry/content validation; it does not run a whole second host turn or the handler's separate envelope-fit check.
* **Large emergency fixture, both revisions:** at the simulated host deadline there are **601 active tags**, no new marker and no persisted decision row. After the pass completes approximately 92 ms late, **100 tags are dropped**, one synthetic compaction marker has been appended with `lastCompactedOrdinal: 3`, and the LKG has been captured/updated. The marker JSONL is an explicit durable fixture callback implementing the host append contract; it is not claimed to be a real OMP session compaction in this direct-handler fixture.

Persisted dropped statuses replay on later passes (`context-handler.ts:6203-6213,6290-6316`), and the handler can drain the deferred Pi marker through `appendCompaction` (`:7150-7277`). These are not a whole-pass transaction: even a later refusal cannot generally retract an already appended JSONL marker (`:7233-7246`). “Fence late writes” must mean preventing admission/publication in the first place, not rolling back a single surrounding transaction afterward.

The output boundaries are unambiguous:

| State | Current publication boundary | Effect after host timeout |
|---|---|---|
| Tag/source/drop/reasoning state | Inside tagging/heuristics/transcript work | Continues; later passes can replay statuses never applied on the timed-out turn |
| Marker / boundary bookkeeping | Deferred drain near end of pipeline | Can append a real host marker after OMP has selected the unmanaged request |
| Transform decision | Successful bust stages a decision; later assistant resolution writes it | Can describe discarded work or bind to a later assistant, not proof of host acceptance |
| Scheduler/reuse/channel/injection caches | Pipeline and post-pipeline success updates | Can advance as though the transformed prefix was served |
| LKG / served digest | Immediately before returning the replacement; deferred persistence afterward | Can designate a never-applied representation as “good/served” |

For decisions, this base has **deferred logging**: `context-handler.ts:3512-3554` stages a pending decision only when the pass busted and has an assistant snapshot; `:2549-2564` schedules later resolution. `transform-decision-log.ts:314-345,369-383` binds it to a later assistant and schedules the write. Thus the generated fixture's `transform_decisions` table remains empty; this report does **not** claim to have reproduced the issue's exact immediate 0.57s-late decision row. That row is incident evidence. The current source still lacks host acceptance as a condition for staging/publishing a decision. The difference between this checkout and the published incident build must not be hidden by the shared package version string.

LKG serialization detaches the returned output and deferred capture can supersede earlier pending captures (`pi-lkg.ts:468-480,719-753,836-960`). Replay checks raw-input digests, model/provider and branch ancestry (`:632-675`); the handler separately fit-checks replay (`context-handler.ts:4169-4190`). **None of those checks proves the host used the saved array.** The served ledger likewise explicitly means the array returned to Pi, not an HTTP acknowledgment (`served-array-ledger.ts:185-243`). The LKG/replay, usage-measurement and cache state can become inconsistent; this is not demonstrated SQLite structural corruption. A next pass may serve reductions the previous model never saw, move a compaction boundary, or misattribute provider usage to a never-served prefix. Those can violate cache/replay consistency even when the replay passes ancestry and size checks.

### Relationship to the issue 640 guard

At **`ff8d438a16ebbc3eae82acd29ea572731b086971`**, `context-handler.ts:2517-2546` creates a per-session generation token, checks it after guarded awaits, and consumes optional `event.signal` / `ctx.signal`. Writer admission and its retry callback are guarded too (`:2711-2773`). The shared writer helper has a 16.5s overall acquisition ceiling, short 25 ms attempts, yielding backoff, and abort-aware checks (`shared/sqlite.ts:678-682,873-940`). There is still a separate 250 ms in-pass writer lease, not another independent 16.5s allowance (`:630-650,715-747`).

A timeout in OMP 18.8.6 **does not replace the generation token** and **does not abort either exposed signal**, because neither is present. The tip's emergency-wait pass still takes 30,091.95 ms and publishes the marker/drops. This is measured evidence that the new guard alone does not cover issue 641.

A deadline-aware guard should invalidate on **generation mismatch OR cancellation OR monotonic budget expiry**, including deferred capture callbacks and writer admission/publication boundaries. Checking it only after the historian await stops some late writes but is too late to prevent OMP's unmanaged send. It also cannot undo earlier commits. Abandoned-pass error handling must not call the host's global `ctx.abort()` against a newer turn; cancellation/refusal must be scoped to the still-current operation, with late passes restricted to a discarded-result diagnostic.

## 4. Fix plan: one budget, fail-closed dispatch, and fenced publication

### Recommended design

1. **Start one monotonic clock at entry to our registered context callback**, before schema/claim checks and DB-independent snapshot preparation. Do not start it at the existing `transformStartTime` after early work. Carry the clock/generation/operation state through writer acquisition, pipeline stages, search, historian scheduling, deferred decision logging, marker publication, LKG capture and served bookkeeping.
2. **Resolve in the required order: fit-checked LKG first, bounded retries second, visible refusal last.** Writer admission already attempts LKG before backed-off waiting on the issue 640 tip (`context-handler.ts:2711-2773` at that tip). Preserve that order. Recovery must not need a successful writer admission; retain a detached good prefix and enough current model/envelope data to fit-check it under contention. A miss, emergency-disallowed slot, invalid ancestry/content or oversize replay is not permission to send raw messages.
3. **Remove the synchronous emergency historian join.** Let already published work participate in this pass; otherwise reclaim deterministically from available state, replay a fitting LKG, or refuse and let the historian publish for the next deliberate retry. A small optional join must consume remaining budget, not a fresh 30s. Prefer no join: our measured wait adds almost exactly 30s and dominates both revisions. Do not convert a still-running child into authority to mutate the abandoned foreground pass.
4. **Bound all work by remaining time**, not independent local caps. Abort/yield checks must run before mutation batches and inside writer admission; an expired pass must not append a marker, publish a decision, replace LKG, advance served state or flush an already queued capture. Give each deferred callback the captured pass token and expiry. Keep diagnostics about a discarded result separate from “applied transform” decisions.
5. **Use a cheap OMP `before_provider_request` dispatch fence** keyed to the active turn/pass receipt. On missing/expired/refused receipt, append a display-only refusal and call `ctx.abort()` synchronously, without SQLite or any awaited work. The `fenced` host control proves this can stop the unmanaged request after OMP's context timeout. An in-progress pass is not a receipt. A late pass cannot set a usable receipt after its deadline. Receipt checks must be turn/generation-specific, not a sticky session-wide boolean like the minimal probe.
6. **Surface the failure before aborting:** UI error notice plus display-only session entry, reason/stage/elapsed/attempt count and recovery result. Persist `session_meta.last_transform_error` best-effort when storage is available, but never block refusal on that write. Storage contention is exactly when that persistence may fail; a host-visible entry/log must exist independently. Do not mislabel an abandoned result as a successful drop/materialization.

### Combining issue 641 with the issue 640 writer wait

**Do not add a 25s pass timer outside an independent 16.5s retry loop and independent 30s historian join.** The join still guarantees an overrun; a writer released near the end of its allowance could be followed by another entire wait. Even without historian, a 3s auto-search allowance and recovery/capture work consume real headroom.

A defensible **initial** OMP policy, to be validated on Windows, is:

* Host handler deadline: **30s** (measured source/probe).
* Internal outcome deadline: **25s**, leaving **5s host margin**. Our real 25s abort control reached no provider, while a 32s hook did. This is a measured feasibility control, not a Windows worst-case proof.
* Normal work cutoff: **21s**, reserving **4s inside the 25s budget for bounded fit-checked replay or visible refusal**. A timeout is not followed by another full transform retry.
* Writer admission ceiling: `min(16.5s, work_cutoff - now - mandatory_completion_reserve)`, with a **2s initial reserve for mandatory remaining non-wait work**, never below zero. Clamp the helper's short SQLite attempt and backoff sleep to that allowance. LKG replay is attempted before this retry budget is spent.
* Optional search/historian-related work is skipped or cancelled when it cannot fit remaining time. The search's existing 3s local ceiling is subordinate to the shared cutoff. No synchronous historian join is the default.

Why these numbers: this fixture's largest non-wait handler wall time was **0.822s**, large cold was **0.291–0.321s**, and large search was **0.124–0.142s**. A 2s mandatory reserve is over twice that observed non-wait maximum. Issue 640's writer refusal measured **16.57–16.58s** here; the supplied **19.1s** operational run is substantially larger and must be respected. A single clock clamps late entry/retry overhead rather than assuming the nominal 16.5s translates to a 16.5s whole turn. For example, if preparation has already used 5s, admission cannot consume another 16.5s: with the suggested reserve it receives at most **14s** (`21 - 5 - 2`).

These are **candidate engineering budgets, not statistically proven upper bounds**. One synthetic Mac run cannot establish Windows p99 or an LKG replay/refusal worst case. Add stage distributions under CPU/I/O contention, large retained tails, model switches, held writers and embedding startup before fixing production constants. If replay itself exhausts its reserved allowance, refuse; do not restart acquisition or return an unfit prefix.

The global deadline must be checked using elapsed monotonic time even if a `setTimeout` callback ran late. Large synchronous SQLite calls/serialization/tokenization can block the event loop and cannot be preempted by a JavaScript timer. Chunk/yield those operations, bound DB query/batch work, and check expiry before commit/publication. Detached worker work must be cancellable or discardable. Just `Promise.race` around today's whole handler reproduces OMP's bug inside the plugin: it stops waiting without stopping writes.

### What OMP permits, and the remaining limit

Possible on 18.8.6: our own clock/controller, generation-aware guards, `ctx.abort()`, display entries/notices, and the independently verified payload-stage dispatch fence. Not exposed: the context handler's private timeout signal, exact remaining host budget, a supported deadline-setting API, or an acknowledgment that our returned array was applied. The issue 640 optional-signal guard cannot acquire a signal which OMP never puts on the event/context.

An internal clock **alone** is therefore only a best-effort fix, not the invariant. Pair it with the no-await dispatch fence; test that fence on every supported provider path, including retries, streaming, subagents and embedded ephemeral turns. Use an operation-local receipt only after a complete managed result is ready within budget. Fence/invalidity should abort the current dispatch, while a late old handler must neither abort a newer operation nor replace that operation's receipt.

For the strongest host contract, also request an OMP change: context handlers declaring themselves mandatory must cause the provider operation to abort on timeout/error; expose an operation-scoped signal/deadline and an applied-result acknowledgment. The extension's private controller being aborted is not enough. A failed/disabled/skipped payload hook itself must not silently reopen dispatch. Until a host fail-closed contract exists, the no-await fence reduces the concrete demonstrated hole, but cannot claim a mathematical guarantee under every host failure or event-loop failure.

### Cost and ordering

Engineering estimates below are planning estimates, not measured implementation effort:

| Option | Runtime effect supported by evidence | Estimated effort / tradeoff |
|---|---|---|
| Remove emergency historian join | Removes approximately **30.0s** of critical-path latency in both measured revisions | **0.5–1 day** plus emergency/retry tests; more turns may visibly refuse until the historian finishes |
| Thread a shared deadline through issue 640 admission and all waits | Caps writer + subsequent work as one allowance; normal passes here under 1s | **2–4 days** for audit and adversarial clocks/writer tests; earlier refusal under contention is intentional |
| Fence foreground/deferred decisions, drops, markers, LKG and served state | Prevents publishing a never-applied late pass; guards are cheap compared with work | **2–4 days**, overlapping deadline work; journal/DB ordering and partial commits require care |
| No-await pre-provider receipt fence + visible diagnostics | Real probe: raw request count **1 → 0** after context timeout | **1–2 days** plus provider/subagent/retry coverage; do not substitute an approximate payload hash for pass identity |
| Move/limit maintenance and use writer-aware checkpoints | Normal explicit checkpoint cost here only **0.06–6.84 ms** for the large store; may reduce contention elsewhere | **2–5 days** with WAL/readers measurements; moving already-deferred embedding drains alone will not remove this wait |
| OMP fail-closed mandatory-context API / signal / acknowledgment | Eliminates host-side fail-open contract rather than racing it | Upstream coordination plus several days of host tests; no local delivery-time estimate can promise upstream release |

The first four should be treated as one correctness change with tests, not a timeout-notification patch. A toast after an unmanaged request has already been sent does not restore the invariant.

## Reproduction and verification

From a prepared/buildable copy of this worktree, install the pinned probe host only into an ignored local directory:

```sh
mkdir -p .cache/issue-641/host
printf '%s\n' '{"private":true,"dependencies":{"@oh-my-pi/pi-coding-agent":"18.8.6"}}' > .cache/issue-641/host/package.json
bun install --cwd .cache/issue-641/host
bun docs/reports/probes/issue-641/host.ts slow
bun docs/reports/probes/issue-641/host.ts fast
bun docs/reports/probes/issue-641/host.ts refuse
bun docs/reports/probes/issue-641/host.ts late-mc
bun docs/reports/probes/issue-641/host.ts fenced
bun docs/reports/probes/issue-641/fixture.ts
bun docs/reports/probes/issue-641/snapshot.ts ff8d438a16ebbc3eae82acd29ea572731b086971
```

Run long commands through the agent shell tool with `background: true`, then wait with `bash_watch`; an ordinary terminal user can run each command to completion normally. Host runs stay local; no cargo was needed. The prepared build was supplied as passing by the task-giver. The pinned install installed 112 packages under `.cache`; Bun blocked two dependency postinstalls. The real CLI still ran and reported `omp/18.8.6`; no repository manifest/lockfile was changed.

`host.ts` prints its disposable root and keeps the host alive long enough to observe late completion. `fixture.ts` prints a separate `report.json` root. Pass the five host roots, then the master fixture root, then the tip fixture root to `collect.ts` to preserve their receipts. Pass the `late-mc` root to `replay.ts` to regenerate the coordinator replay evidence. The scripts reject evidence inputs outside the disposable task root. Keep the large generated stores out of Git.

Probe typecheck command (installed workspace TypeScript, no fetched runner):

```sh
bun packages/pi-plugin/node_modules/typescript/bin/tsc --version
bun packages/pi-plugin/node_modules/typescript/bin/tsc -p docs/reports/probes/issue-641/tsconfig.json
```

Run that gate on Linux. The source includes the probes and imported Pi/core code; Bun runtime success is not a substitute for this check. No full package test suite was necessary for a report-only change; no `OPENCODE_DB` was exported to one. The final scoped typecheck passed on Linux with TypeScript **5.9.3**, checking the five probes and their imported sources. Editor inspection was partial: its TypeScript SDK was unavailable, so the explicit typecheck was the authoritative gate.

### Required implementation acceptance cases

* 32s context work: **zero unmanaged provider requests**, loud refusal, and no late drop/marker/decision/LKG/served mutation; prove the HTTP capture, not only an error log.
* Writer released just before its local ceiling plus costly search/reclaim: outcome before the **shared** deadline, not “each stage below 30s.” Held writer without LKG: bounded visible refusal. Valid fitting LKG: replay before waiting. Oversize/model/ancestry mismatch: no raw fallback.
* Historian still running after 30s/600s: foreground never joins for 30s; publication is independently valid background work and only a later admitted pass materializes it.
* Newer context generation while an older pass waits; late catch/deferred capture: old pass cannot write state, publish a dispatch receipt, or abort the new operation.
* Event-loop stall past the deadline, retry/subagent/ephemeral request paths, and payload-hook error: no unmanaged dispatch through the fence. Pin actual OMP versions/provider adapters in these tests.
* Compare provider bytes with the purported served/LKG representation using the real provider capture; the successful late-host replay here shows why comparing an LKG to its own stored digest is not proof of application.


## 5. Implemented controls and verification

The implementation continues the three committed controls (`c88d047d87`, `baea9f6b40`, `33432c8203`) and finishes the dispatch receipt fence. Evidence below is from the built extension on **OMP 18.8.6**, Bun **1.4.2**, macOS arm64, with a loopback Anthropic mock; it is not a Windows/Grok latency claim. New receipts are at `~/.local/share/cortexkit/magic-context/specimens/issue-641/evidence/implementation/` outside Git. The original investigation receipts above remain unchanged.

### Shipped dispatch mechanism: verified-context session latch

`before_provider_request` is synchronous: no await, SQLite access, history hashing or replay work. In an unlatched session with compaction enabled, it requires the current operation's latest pass to have returned its transformed messages array before its preparation outcome deadline. Missing, in-progress, ended or refused receipts produce an error notice and display-only entry before `ctx.abort()`. A completed result is durable for that operation: later provider dispatch/retry is not rejected merely because preparation began more than 25 seconds earlier. Turn start resets the receipt; payload retries use the same pass. Old waiting handlers retain their original owner token and cannot abort or replace a newer operation's receipt.

**Body classification did not ship.** The actual concurrent probe preserved OMP's full ephemeral developer reminder and final side prompt, but Anthropic conversion changed the developer role to `user` and erased both `attribution: "agent"` fields. Reminder text alone is user-spoofable. The original WIP also let unknown bodies through; that bypass is removed. All bodies in an unlatched session require the main receipt, including unfamiliar adapters and user text imitating the reminder.

With explicit review approval, the fence instead latches off for a session only after its **context event** contains OMP's exact full developer reminder attributed to `agent`, plus the final user prompt attributed to `agent`. Payload text cannot engage the latch. The latch survives receipt/cache eviction and session reload, logs its activation once, and reports cumulative `side_contexts` / `context_passes` at turn end. Budget, no-historian-join and publication controls remain active for side and main work. A side result does not publish the main receipt, LKG, served ledger or transform decision, and a side refusal never calls the session-wide abort API.

**Limitation:** after a verified side context, this session loses the independent provider-dispatch backstop. A host timeout can therefore still send unmanaged history there even though the internal budget and late-publication controls remain active. This is an explicit safety/availability tradeoff, not a universal fail-closed guarantee. OMP needs an operation-scoped ID or signal on the provider-request hook, an operation-local abort, and ideally a mandatory-context/applied-result contract to close it.

The side probe deliberately holds its mock response for two seconds and asserts that its HTTP request overlaps the main request. Both finish, neither is aborted, and the main captured managed text appears in the real provider body. Its context audit preserves the attributed pair, while the HTTP capture proves their loss. Observed frequency is **one deliberately generated side context in two passes** in that session; no spontaneous side contexts appeared in the ordinary deadline/writer or task-child controls. This synthetic sample is not a production incidence estimate; the shipped counters allow that measurement without reading a live store.

### Retained side-operation limitation after combined review

The issue 640 / issue 641 combined review proposed clearing the latch after side work ends so later main requests would again require a completed transform receipt. The installed OMP **18.8.6** source provides no safe finite expiry boundary to the extension:

* [`runner.ts:1993–2004,2052–2065`](https://github.com/can1357/oh-my-pi/blob/v18.8.6/packages/coding-agent/src/extensibility/extensions/runner.ts#L1993-L2004) creates context/payload events without the side `AbortSignal`; the SDK forwards it only to the runner's internal timeout/cancellation machinery ([`sdk.ts:4147–4150,4208–4213`](https://github.com/can1357/oh-my-pi/blob/v18.8.6/packages/coding-agent/src/sdk.ts#L4147-L4150)). The payload also has no operation identity.
* [`runEphemeralTurn`, `agent-session.ts:10943–11121`](https://github.com/can1357/oh-my-pi/blob/v18.8.6/packages/coding-agent/src/session/agent-session.ts#L10943-L11121) runs a distinct side stream and resolves its caller's promise only after the final provider message (or rejects). It emits no extension `agent_end`/`turn_end` for that side operation. The extension receives a newly constructed callback context, so wrapping its own `ctx.runEphemeralTurn` method cannot observe promises started by `/btw` or another extension's callback context.
* [`agent-session-types.ts:563–582`](https://github.com/can1357/oh-my-pi/blob/v18.8.6/packages/coding-agent/src/session/agent-session-types.ts#L563-L582) has no finite provider-duration cap. Neither the 30-second context-handler timeout nor an unrelated main `agent_end` proves that a side stream or retry has finished.

**Decision:** retain the safety-first session latch, not a timer or main-turn clear. Clearing on a main end can trigger the session-wide abort against a legitimate side retry/late dispatch from an otherwise healthy state. The retained defect needs both a prior attributed side context and a later main context pass that yields no completed result without refusing first; that main payload can then leave unmanaged, as before the issue 641 dispatch fence. Avoiding false aborts of healthy side work is preferred until the host supplies a completion boundary.

**Exact remaining window:** from the first attributed side context's entry until this extension registration/process ends, for that session key, every provider payload bypasses the independent receipt fence. Main turn end/start, side callback return, receipt/cache eviction and session reload within that registration do not clear it. This window is not bounded by 25 or 30 seconds. Preparation budgets, visible context refusals, supersession and late-publication guards remain active; other session keys and ordinary task-child requests still use the receipt fence. No universal no-unmanaged-dispatch claim is made. The assertions in `combined review: a previous side context must not authorize a later unmanaged main request` still require a later main dispatch without a completed receipt to be refused. They are now `test.failing` by explicit review decision because retaining the latch cannot meet that property safely on this host; an unexpected success forces review rather than silently deleting the claim.

#### Draft upstream request (text only; not posted)

> OMP 18.8.6 removes ephemeral attribution before `before_provider_request`, and the extension abort API is session-wide. Please expose a stable operation ID and main/side kind on both `context` and `before_provider_request`, or emit a side-turn completion event carrying the same operation ID after the provider stream/retries finish. The completion signal must cover `/btw` and extension-created side turns, including error and cancellation paths. Operation-local refusal/abort would additionally let extensions fence an unfinished main request without cancelling concurrent side work. A context-handler timeout or unrelated main `agent_end` is not a side completion receipt.

### Final budget policy and expiry fallback

All constants live in `PI_CONTEXT_BUDGET`. These are cooperative preparation budgets, not hard real-time bounds. OMP's 30s handler deadline minus a 5s host margin gives the **25s outcome deadline**. Writer retries and optional search use the **21s optional cutoff**; writer allowance still charges preparation and preserves the 2s admission reserve and 16.5s ceiling. Mandatory tagging/reclaim and final serialization may consume the existing outcome margin rather than starting another clock. Optional search does not gain that margin.

This distinction was necessary for the unchanged finding-6 fixture: after a 15.5s writer, a 6,000-message tagging pass could cross 21s under Mac load even though it could finish before 25s. Initially successful 18s runs did not establish a robust 21s mandatory-work ceiling. The final native control returns a tagged result in **3.184s uncontended / 18.461s held**. The archived baseline returns in **15.703s / 31.089s**, failing its unchanged `< 30000` expectation. The imported file named in the brief has no deadline test; finding 6 is in the adjacent `issue-640-deadline-review-r2.test.ts` at the same supplied commit. Both files were imported; the deadline expectations are unchanged. Only Windows subprocess hygiene and durable timing/lsof receipts were added to the native fixture.

**The 25s outcome guard is cooperative.** Once control returns to a checkpoint, an expired pass publishes no managed result or receipt and does not begin replay, new database work or another wait. Its storage-independent fallback is the synchronous visible refusal; fit-checked LKG recovery is only attempted while the existing budget permits it. Synchronous host callbacks, native SQLite/filesystem calls and CPU work cannot be preempted by JavaScript timers: the independent provider-dispatch receipt fence is the backstop when those stalls prevent timely context completion (subject to the side-operation exception below). A real OMP probe with the writer held for 60s and a 25.1s internal stall measured **4ms from expiry detection to callback return**, including notice, display entry and abort. Total handler time, including the probe's lsof instrumentation, was **25.745s**, leaving **4.255s** before OMP's 30s handler deadline. Prompt-to-refusal was 31.707s because host work before entering the context callback is not part of that handler timer. One Mac observation is not a Windows upper bound.

The new `mandatory work beyond 25s refuses without storage waits or managed publication` regression advances the real handler's clock at the mandatory pipeline seam. It proves notice → entry → abort with no intervening storage access, no tags/decision/LKG/served publication, and no deferred persistence on the refusal stack. Neutralizing the outcome guard and its remaining-time clamp makes that test alone fail with 79 storage calls instead of refusal.

Error persistence is best-effort, queued outside the transform's SQLite scope and guarded against a newer owner. The UI and display entry do not depend on it. Successful decision attribution is permitted only after a managed result has completed; the resolving pass still supplies its own owner fence and the original outcome expiry remains in force. This preserves ordinary short-latency telemetry without allowing an unfinished old pass to publish.

### Synchronous-stall diagnostic limit

The issue 640 / issue 641 combined review's opt-in `MC_COMBINED_STALL=1` test, `combined review timing: synchronous branch projection stays below OMP's deadline`, is intentionally unchanged. Its 31-second synchronous host branch callback documents the cooperative budget's limit: the callback cannot be interrupted, so the test's `< 30000` duration assertion remains red when opted in. This is fault injection, not a normal branch-read latency claim. The diagnostic now labels the blocked stage `branch projection` before entering the host call instead of retaining `schema/claim`. A deterministic clock-advance regression checks that label without a 31-second stall. No hard real-time guarantee is inferred from the ordinary green suite.

### Real host and compatibility results

| Built-extension probe | Actual provider observation |
|---|---|
| `fast --fixed` | One managed request; every captured managed text block is present in the HTTP body |
| `slow --fixed` (32s before the MC callback) | Zero requests; visible dispatch refusal; late callback discarded |
| `refuse --fixed` (60s writer) | Zero requests; visible bounded refusal |
| `late-mc --fixed` (32s stall inside MC) | Zero requests; visible refusal; no late managed publication |
| `fenced --fixed` (32s delay plus another payload hook throwing) | Zero requests; MC's real fence refuses after the other hook fails |
| `ephemeral --fixed` | Two overlapping side/main requests; no abort; latch activation counted once |
| `outcome --fixed` (60s writer, 25.1s internal stall) | Zero requests; 4ms fallback; 25.745s handler duration |

The fixed `fenced` mode no longer installs the investigation's synthetic boolean fence: it tests the product hook itself. The stall uses `getLeafId`, which the real branch reader invokes, and records its start/end; the original WIP's `getBranch` injection did not execute on OMP's fast branch-reader path and was corrected rather than counted as evidence. Collection checks the **real HTTP body**, not an LKG's own digest. Replacing that body with unmanaged text makes collection fail. Refused host receipts contain no LKG, served body/ledger, decision or dropped-tag publication.

The original issue-640 task-child reproduction was rerun, not just a direct handler or main-turn stand-in. Independent Python writers held the same disposable shared store for 2.2s, 10s and 60s. Actual task children completed with managed §-tagged HTTP requests **2.896s, 11.052s and 60.439s after lock acquisition**. The 60s child made no request while the writer remained held and recovered through OMP's real reminder ladder. This retains the earlier 18.8.5 outcomes (2.840s, 10.964s, 60.242s), with small instrumentation/version variation; no speedup is claimed. Full child/parent captures and host/locker descriptor receipts are preserved in `subagent-hold-*`.

An independent three-turn differential archives `ff8d438a16ebbc3eae82acd29ea572731b086971` inside this worktree and verifies its core-import resolution before executing each revision's real handler. The complete managed arrays are byte-identical (**SHA-256 `4a6cd42cb4ec7b5e9c10bd9dfbd92a8ab1afd746a06f64c048952be9a568ec27`**), as are selected tag/source rows (`7b2ed501f344379577144e006b16e9605158cc38398e51755cced5885fd7f5a6`). This is array/row equality, not a claim that session IDs, timestamps and OMP's rotating HTTP metadata are identical across independent host sessions.

### Acceptance regressions, mutations and gates

Five behavioral controls run **red on the archived baseline and green here**: no emergency historian join; expired deferred publication; serialization past deadline; missing/in-progress/expired dispatch receipts; and the native whole-pass deadline. Base publication tests use the new budget module only as a test clock; no baseline product module imports it. The selected missing-receipt test never calls session cleanup, so only its unavailable cleanup import is replaced by a test-only no-op. Missing imports or setup errors are not counted as behavioral reds. Existing Pi tests also cover fitting LKG before writer waits, invalid/oversize replay, stale generations, model changes and host aborts.

`mutation.json` records stage-before-mutate / non-empty working diff / named red / checkout-and-touch restore / empty working diff for each control. The four implementation controls all redden their matching test alone. Additional controls prove the final outcome guard, actual-provider-body comparison, and the two signal-order source guards. The source guards' pipeline matcher was updated to recognize `budget.waitMandatory`; their properties and assertions were not weakened. Premature signal drain and premature note nudges each fail exactly their own guard while the other 24 tests pass. One early publication mutant did not reach product code because of a fixture-helper return-type mistake; it is explicitly recorded as not reached, repaired, and rerun with the correct named red.

Verification uses throwaway HOME for package suites, with `OPENCODE_DB` unset. Every host run also redirects all required XDG/config/state/runtime/storage roots and records nonempty lsof `.db` lists confined to its disposable root. No live store was accessed or copied. Evidence is outside build/cache directories; native timing and descriptor files are mirrored outside the auto-cleaned fixture roots.

* Root `bun run test` on Linux: **7,336 pass / 7 skip / 1 unrelated failure**, stopping before Pi because the unchanged Node WASM fixture's temporary bundle cannot resolve `onnxruntime-web/webgpu`. Remote Git ownership failures from the initial isolated-HOME attempt were resolved with command-local `safe.directory`, not global Git configuration.
* Complete Pi suite was run. Before the mandatory-wait rename it had **1,689 pass / 4 skip / exactly the three intentionally retained r2 failures**. After the rename it additionally exposed the two source-matchers above; their corrected 25-test file passes and is independently mutation-proved. The imported r2 collision, literal-marker and reload failures remain untouched for the later worker.
* Final targeted mandatory/deadline/dispatch/publication/context-handler gate: **167 pass, 0 fail**; source-order gate: **25 pass, 0 fail**; final restored deadline/source-contract gate: **39 pass, 0 fail**. The native deadline is separately enabled on macOS and passes its unchanged assertion.
* Root typecheck and the strict nine-probe typecheck passed with **TypeScript 5.9.3**. Root lint passed with **Biome 2.5.1** (1,678 files, existing warnings only). Package builds passed; Pi was built locally for the real host runs, root build also passed on Linux. No cargo was needed.
* Comment review covered all 13 changed code files (52 generated data files were skipped); genuinely unclear comments were rewritten. Earlier research/review calls were interrupted or unavailable and a final review succeeded. Editor inspection was partial; explicit compiler/lint gates are authoritative.

Remaining limits are the explicit side-session latch degradation, one provider adapter/version in real host probes, no production frequency sample, no Windows worst-case latency bound, and no host applied-result acknowledgment. The original acceptance requirement covering **every** provider adapter, every payload-hook failure and arbitrary event-loop stalls is not a mathematical host guarantee: the late-publication and receipt controls reduce the demonstrated hole but cannot repair a host that skips the hook entirely.

## 6. Combined review repairs and fresh verification

The combined issue 640 / issue 641 review is preserved in `issue-640-641-combined-review.md` as the original failing evidence. The OpenCode 2 repair measures saved-message replays against the current draft's tool definitions and system prompt even after every database writer-admission attempt fails; the Pi repairs retain a completed context result across delayed dispatch/retries, fence auto-search's process-local no-hint cache with the same originating-pass guard as its durable append, and label synchronous branch projection correctly. The session-wide side latch remains unchanged for the source-backed safety reason above. Its required-property assertions remain intact under `test.failing`, rather than being reversed into an assertion that unmanaged main dispatch is desirable. The legacy completed-receipt expiry expectation was deliberately changed: the preparation deadline is not an expiry date for a result already completed before that deadline.

### Fresh native-host receipts

Commands: `bun docs/reports/probes/issue-641/host.ts MODE --fixed`, for `MODE=fast slow outcome ephemeral`, against a locally rebuilt extension and the disposable pinned OMP **18.8.6** package. Bun **1.4.2**, macOS arm64, loopback mock provider; no production-provider retry distribution is claimed. The pinned setup installed **112 packages** with two blocked dependency postinstalls; no repository manifests or lockfiles changed. The local `packages/pi-plugin` build was necessary because the Mac probes load its bundled JavaScript from `packages/pi-plugin/dist`; Linux build artifacts remain on the remote builder.

| Probe | Fresh result |
|---|---|
| `fast --fixed` | One managed HTTP request, first request **2,636ms** after prompt; all three independently captured served text blocks occur in the actual HTTP body, including `§1§ MC641_ORIGINAL`. |
| `slow --fixed` | **Zero** HTTP requests; visible `stage=provider dispatch` refusal and one payload abort after the host stopped waiting for its 32-second callback. |
| `outcome --fixed` | **Zero** HTTP requests while an independent SQLite writer was held for 60 seconds. Synchronous branch projection crossed the 25-second outcome cutoff measured from context entry; refusal now says `stage=branch projection`. Callback returned **8ms** after the stall ended, **25,418ms** after entry; prompt elapsed **31,469ms** includes host work before callback entry. |
| `ephemeral --fixed` | **Two** overlapping requests, no abort/refusal. Main HTTP text contains all three served blocks, including `§2§ MC641_ORIGINAL`. The side response was still open when main dispatch began (**299ms** after side dispatch); side response completed **2,001ms** after side dispatch. |

`issue-640-641-combined-fixes-host-receipts.json` preserves the four PIDs, roots, raw database descriptor lines from `lsof -p <host pid>`, request timings, refusals and independent served/HTTP text blocks. Each host had **24 database descriptors**, all under its own throwaway root; the outcome locker had **four** under that same root. Raw provider captures, start/end lsof and audits remain beneath `$TMPDIR/magic-context/bg_a8d0ddf6a161ffcd/magic-context/issue-641/`. The probe's legacy `transformedOnWire` field looks only for the non-product `MC641_TRANSFORMED` marker and is false on built-extension runs; the independently observed `§N§`-prefixed user text and two history blocks, not that flag, establish that the extension's transformed messages reached the provider.

Live-store isolation rule, verbatim: never open/read/write/migrate the live stores (`~/.local/share/opencode/*.db`, `~/.local/share/cortexkit/magic-context/{context,store}.db`, `~/.config/opencode/*`, `~/.config/cortexkit/*`); every host run goes through a throwaway root (`XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR`, `OPENCODE_DB`, `MAGIC_CONTEXT_STORAGE_DIR` under `$TMPDIR/magic-context/<task>/`), proven by `lsof -p <host pid>` listing only throwaway `.db` paths; a single live-store write is a rejected delivery.

Every probe redirected HOME, CFFIXED_USER_HOME, all XDG roots, OMP's agent directory, OPENCODE_DB and MAGIC_CONTEXT_STORAGE_DIR before launch. No live store/config was opened, read, copied, migrated or written. The receipts are plain fixture data, not database snapshots, and are outside regenerable build directories.

### Mutation controls

Each mutation first staged the exact working implementation in Git's index, so restoring from that index would preserve the fix rather than lose it. A non-empty `git diff --stat` proved the unsafe change was applied; `git checkout -- <path> && touch <path>` restored that implementation, and the subsequent empty unstaged diff proved restoration. Each deliberately unsafe change was restored; none remains in the delivered source.

| Control | Sole red test | Other tests that stayed green |
|---|---|---|
| Omit the current-draft fit callback from exhausted-admission recovery | `combined review: v2 exhausted admission still fits replay against current tools` | `v2 outer admission serves validated LKG before writer backoff` |
| Restore preparation-age rejection for completed receipts | `combined review: a completed managed receipt survives delayed provider retries` | `combined review control: an unfinished receipt is refused at dispatch` |
| Remove both in-memory skip-publication assertions | `combined review: expired cold auto-search must not freeze an unserved skip` | The unfinished-receipt control above |
| Replace the branch diagnostic stage label with the stale `schema/claim` label | `branch projection expiry identifies the synchronous host stage` | All four `pi-context-budget.test.ts` cases |
| Unsafely disable the side latch | `combined review: a previous side context must not authorize a later unmanaged main request` (unexpected pass of a `test.failing` case makes the runner red) | The completed-receipt and unfinished-receipt controls above |

Disabling the side latch makes the required-property assertions unexpectedly succeed; `test.failing` then turns the runner red. This control proves that future behavioral success will force review of the retained limitation, not that the host's missing main/side request identifiers were repaired. The opt-in `MC_COMBINED_STALL` test remains unmodified and was not counted as an ordinary passing gate.

### Linux gates and baseline comparison

All authoritative gates requested execution on the isolated Linux builder (`runon: "linux"`), asserted Linux, ran as background jobs and awaited completion with `bash_watch`. Tools: Bun **1.4.2 (744846f84)**, TypeScript **5.9.3**, Biome **2.5.1**. Suite shells unset `OPENCODE_DB` and used separate throwaway HOME/XDG/storage roots. Master **`5292c42f030202a77dfc7ec8080158166acfc17c`** was archived from this worktree's Git objects; both revisions were built in the same isolated job before full-suite comparison. No parent checkout was used.

| Gate | Fresh result |
|---|---|
| `bun run build` | Passed plugin, OpenCode 2 server, Pi extension and CLI builds; TUI generator checked nine files, all unchanged. |
| `bun run typecheck` | Passed all four package configurations and the plugin script configuration with TypeScript 5.9.3 (`tsc` is silent on success). |
| `bun run lint` | Passed **1,732 files** across plugin/Pi/CLI/local-fs. Existing warnings/infos remain; no lint errors. |
| Issue 641 safety subset plus combined review and branch-stage regression | **19 pass / 2 opt-in skips / 0 fail**, 69 assertions, six files. The previous-side required-property case is an expected failure, not a repaired property. |
| Strict test compiler | Two explicit `tsc --noEmit -p tsconfig.combined-fixes.tmp.json` checks passed, covering four Pi test roots and one plugin test root plus imports. Temporary configs were removed. |
| Combined differential | **3 pass / 0 fail / 8 assertions per revision**, then **three independent `cmp` checks passed**. Each harness made 32 real invocations per revision (two warmups + 30 defer samples). |
| Final edited-source finding checks (`MC_COMBINED_TIMING=1`) | Pi **6 pass / 1 opt-in stall skip / 0 fail**, 20 assertions; plugin **1 pass / 0 fail**, seven assertions. Final root typecheck, both strict test configs and installed Biome checks on **4 plugin + 6 Pi files** passed. The actual 6,000-message / 20-second SQLite writer refused after **16,556.91ms**, with no managed prefix; the test's 20.37-second runner duration includes waiting for the locker during cleanup. |
| Full plugin suites, master → repaired tree | **7,458 → 7,471 pass**, nine skips and **one same failure** at each revision; 7,468 → 7,481 tests across 732 → 737 files. Failure-name sets are identical. |
| Full Pi suites, master → repaired tree | **1,684 → 1,758 pass**, three → nine skips, **zero failures** at both revisions; 1,687 → 1,767 tests across 166 → 182 files. Failure-name sets are identical. |

The only full-suite baseline failure is `Node WASM Transformers fixture > builds with real fs and persists a model for offline reuse`, present at both master and the repaired tree; it is outside these context/dispatch fixes. [`issue-640-641-combined-fixes-suite-receipts.json`](issue-640-641-combined-fixes-suite-receipts.json), alongside this report in `docs/reports/`, preserves exact commands, assertion/test/file counts and both failure-name sets. Full suites are not described as universally green merely because the comparison is green.

Differential bytes/hashes remain identical to the combined review's fixtures: Pi **129,157 bytes**, SHA-256 `04ea978c77f9f929db807d4111e1f49655f78db70f78174b62899899dc560d85`; OpenCode 1 **599 bytes**, `1858cb22d26467847a365974827421103ac1dcc30479b294fdcdc7bf4b4ff80c`; OpenCode 2 **26,200 bytes**, `779093172a17dcedff761e5127a879627f41e7679775fad93491c1c324dd1c98`. Warm median master → repaired tree was **8.261 → 9.575ms** (Pi), **0.900 → 0.982ms** (OpenCode 1), **2.403 → 2.387ms** (OpenCode 2). These are shared-runner fixture measurements, not production latency percentiles. Bun's nonfatal tsconfig directory-mismatch warning appeared in both differential arms; source-resolution assertions and independent byte comparisons passed.

Setup failures are not hidden gate findings: an archived workspace's local node_modules symlinks were rejected by remote setup, so the archive was instead transferred as a tar and dependency links created only inside the isolated job. The first full-suite comparison omitted Git's worktree trust override and a same-job head build, causing shared Git-identity failures and head worker-bundle failures; that setup-tainted run was replaced by the correctly isolated, fully built comparison above. Initial lint found only the new replay helper's formatting and skip helper's import ordering; package-local formatting corrected them before the final lint pass. Remote requests refused during workspace queuing and the Linux executor service's planned software replacement (a temporary pause in accepting jobs) were rerun after the service returned; no local authoritative-gate fallback was used. Frozen suite installs checked **1,010 installs across 1,251 packages with no changes**. Editor inspection was partial (Biome/callgraph unavailable), so explicit compiler/lint/test gates supply the authoritative evidence.
