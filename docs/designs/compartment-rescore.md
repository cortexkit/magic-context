# Rescore existing compartments without recompacting history

Status: proposed, not implemented. Code references below are to `2b57304c` (the trial's base). Trial results: [compartment-rescore-trial.md](../reports/compartment-rescore-trial.md).

## Decision

Ship an explicit **`/ctx-rescore` command with current-session and project-wide scopes**, sharing a durable, resumable scoring job implementation across OpenCode, Pi and ck-mc. Default to a preview, require confirmation before paid work, and disclose that new decay choices appear at the **next independently required HARD fold**, not immediately.

Use title + episode type + P1, the revised recall rubric, and three rotating scored cross-project seeds, with about 20 shuffled candidates per call. Do not send existing importance, sequence, dates or adjacent session scores. No raw messages, new compartments, new facts, embeddings or boundary reconstruction. This is a score repair, not `/ctx-recomp`.

**Do not ship it as `UPDATE compartments SET importance = ...`.** Keep score revisions in a sidecar and apply validated overrides only in the HARD decay materializer. Otherwise Rust detects external UPDATEs and can rebuild the frozen prefix immediately. A trigger exemption alone also fails to protect Rust's full-row boundary fingerprints.

## What importance actually changes

* The score changes half-life: `F = 2 ** ((importance - 50) / 25)`, `H = 24 * F / pressure`, then age/half-life selects P1–P5 (`packages/plugin/src/hooks/magic-context/decay-curve.ts:27-41,57-70`). It is not a displayed importance label in the primary prompt: compartment headings are range/date/title only (`packages/plugin/src/hooks/magic-context/decay-render.ts:63-67`).
* The HARD renderer consumes importance for every non-legacy row and computes shared budget pressure (`packages/plugin/src/hooks/magic-context/decay-render.ts:148-181`). Thus changing one score can change other compartments' tiers as well; archive membership, body lengths and the archived placeholder can change. The stored P1–P4 strings and raw coverage should not change.
* SOFT m[1] renders new compartments at **explicit P1**, not decayed tiers (`packages/plugin/src/hooks/magic-context/inject-compartments.ts:2928-2941`; Pi: `packages/pi-plugin/src/inject-compartments-pi.ts:2054-2066`). Importance alone does not change that body or heading. A rescore must not advance coverage, max sequence or a memory epoch.
* Historian calibration is a separate prompt consumer: scored examples/session references may show importance (`packages/plugin/src/hooks/magic-context/reference-retrieval.ts:143-191`). Future scoring-only jobs should use seeds, not previously rescored session labels. A production change must explicitly decide whether general historian references see effective override scores; recommend yes on their next ordinary construction, without refreshing the primary-agent prefix.
* The seeds are the checked-in 60-unit cross-project corpus, generated from `reference-seeds.source.xml` (`packages/plugin/src/hooks/magic-context/reference-seeds.generated.ts:1-16`; generator: `packages/plugin/scripts/build-reference-seeds.ts`). The production selector rotates across distinct bands (`packages/plugin/src/hooks/magic-context/reference-retrieval.ts:98-141`). The revised band-and-position procedure is `packages/plugin/src/hooks/magic-context/historian-prompt.source.md:121-165`.

## Cache safety: trace both implementations

### The UPDATE trigger is not just a harmless revision counter

Migration v93 installs the history revision machinery at `packages/plugin/src/features/magic-context/migrations.ts:3185-3190`. Its actual SQL now lives in `packages/plugin/src/features/magic-context/storage-compartment-history-version.ts`, not inline in `migrations.ts`:

1. `compartment_history_versions` holds a random `generation`, `version`, `rewrite_version` and `seeded` (`:23-29`). Migration seeds existing sessions (`:99-100`).
2. INSERT/DELETE bump `version` (`:33-45`). **Every UPDATE**, including importance-only or even no-op SQL, bumps `version`. External UPDATEs also bump `rewrite_version` (`:49-55`). The external predicate is `context_privilege_state.enabled != 1`, with absent privilege table treated as external (`:13-18`). Moving a row bumps both old/new sessions.
3. The privilege flag is an internal module-writer transaction policy, **not a general backfill opt-out**. Do not set it from a slash command, doctor or ad hoc SQL to suppress invalidation. That would hide unrelated repairs too.

### TypeScript OpenCode and Pi

There is no TypeScript read of this history-version table driving prompt rendering at this base. Its TypeScript references install/clean the schema; the renderer reads max sequence, mutation-log head and other snapshot markers instead.

* `mustMaterialize` keeps cached m[0] and only fires for HARD reasons (`packages/plugin/src/hooks/magic-context/inject-compartments.ts:1748-1945`). Model/system identity changes and idle TTL are explicit HARD reasons (`:1828-1873`). Max compartment sequence deliberately is **not** a HARD reason; structural mutation-log changes are (`:1926-1942`). An ordinary importance-only SQL UPDATE, absent another signal, therefore leaves m[0] frozen until an independently required fold.
* On a non-busting pass the code replays m[1]; on an already cache-busting pass it may soft-refresh it (`:4055-4084`). The SOFT render rereads post-baseline compartments but displays fixed P1; it does not re-tier m[0]. A pressure backstop can later refold a large delta (`:4086` onward). “Next natural HARD” includes this normal pressure/coverage fold, first render, a missing cache, and other normal HARD reasons, not only TTL expiry.
* Pi has the same mutation-log/sequence distinction (`packages/pi-plugin/src/inject-compartments-pi.ts:1244-1272`) and fixed-P1 m[1]. Do not emulate recomp's explicit invalidation callbacks: OpenCode recomp adds both `historyRefreshSessions` and `pendingMaterializationSessions` (`packages/plugin/src/hooks/magic-context/recomp-orchestrator.ts:213-216`). Those are intentionally absent from the proposed score job.
* The mutation log is an explicit write API, not this history trigger (`packages/plugin/src/features/magic-context/storage-m0-mutation-log.ts:48-67`). A rescore must not enqueue a structural m0 mutation or clear cached byte buffers.

### ck-mc: two distinct paths consume the revision

**Boundary validation/cache path:** `crates/mc-store/src/context_boundaries.rs:184-201` reads the full tuple `(generation, version, rewrite_version, seeded)`. Cached host-to-module boundary validation keys include that tuple, the boundary-section digest and the bound context domain (`:251-279`). Every importance UPDATE therefore misses this cache and rereads compartment bodies. Worse, boundary identity is SHA-256 of the **entire serialized `StoredCompartment`**, not just coordinates (`:44-49,95-103`). Importance is in that struct (`crates/mc-store/src/lib.rs:5320-5337`). An importance-only change can invalidate previously valid resolved boundaries even though raw ranges did not move; do not treat this as only a cheap counter read.

**Prompt revision path:**

1. `McStore::load_m1_revision_snapshot` takes the revision in the same snapshot and selects only `(generation, rewrite_version)` when rewritten or migration-seeded. Normal publication `version` is intentionally ignored here (`crates/mc-store/src/lib.rs:12523-12532`).
2. `m1_compose` hashes this pair into **external_revision** and **history_revision**, separate from the ordinary additive m[1] revision (`crates/mc-module/src/m1_compose.rs:276-313`). Comments explicitly name external SQL repairs bypassing `m0_mutation_log`.
3. Transform compares the persisted external signal (`crates/mc-module/src/transform.rs:4421-4424`) and includes its change in `hard_fold_requested` (`:4597-4604`). A marker-only HARD still runs; it may avoid pricing unrelated reductions when a freshly composed head is byte-identical (`:4626-4660`). A score change can alter tier/body/archival bytes, so byte identity is **not** guaranteed. The HARD reason is attributed as `compartment_history_revision` (`:5011-5013`; classification branch `:16063-16064`). The no-live-head branch also considers external revision changes (`:3050-3053,3130-3131`).
4. Applied revision markers are persisted with rendered state (`:5718,5938`). Merely calling it an “m[1] signal” does **not** mean it is a safe SOFT refresh: external/history changes deliberately request a HARD m[0] rebuild.

**Conclusion:** in TS, a bare importance-only UPDATE generally waits for a natural fold; in Rust, an external UPDATE requests an early HARD on the next transform and invalidates boundary validation. The fleet-wide “scores only take effect next natural fold” claim is false for naive SQL. Cache preservation requires a different write/read design.

## Proposed score sidecar: no invalidation on publication

Add schema-owned `compartment_score_revisions` and job tables. The score table is an overlay; the legacy `compartments.importance` column remains the original historian score. The public **effective importance** is overlay-or-original, while cached primary prompts retain the importance used when materialized. Make this distinction explicit in APIs/dashboard, not a hidden discrepancy.

Suggested revision fields:

* compartment id + session id + a source identity hash (canonical title, episode type, P1–P4/legacy content, sequence, raw endpoints and block indices, creation identity). Include original importance in the snapshot hash to reject conflicting manual score edits. Define one cross-language canonical serialization and golden vectors; do not reuse host-resolved/date-enriched `StoredCompartment` serialization.
* old importance, new importance (CHECK integer 1–100), rubric version and prompt hash, model/qualifier/actual fallback, seed selection ids/hash, job id, batch/attempt id, completion time and a short rationale.
* Unique `(compartment_id, source_identity, rubric_version)`; historical revisions retained for audit/undo, with one active revision selected by an explicit policy. Never let a retry silently replace a previously accepted score.

Publication writes only the sidecar and job progress in one short transaction. It does **not** UPDATE `compartments`, `compartment_history_versions`, `m0_mutation_log`, max sequence, cached m[0]/m[1], boundary sections, project epochs, or refresh/force flags. Add the table to normal session cleanup/export/migration handling; no private shadow file database.

Read separation is essential:

* Raw compartment loaders and Rust boundary fingerprints continue to receive unchanged base rows. Do **not** globally modify `load_compartments` or overwrite importance on objects later used for `ResolvedContextBoundary::identifies`.
* Only after an independent HARD is selected, take a consistent read snapshot of base rows and applicable score revisions, validate source identities, and project effective importance into **render-only** compartment copies. TS integration is at the frozen M0 input acquisition/materializer (`packages/plugin/src/hooks/magic-context/inject-compartments.ts:2619-2710`); Pi has its own frozen-input acquisition (`packages/pi-plugin/src/inject-compartments-pi.ts:1481-1574`).
* Rust integration belongs at the `M0Source`/render projection boundary (`crates/mc-module/src/m0_compose.rs:431-447,484-492`), not the raw context-domain loader (`crates/mc-store/src/lib.rs:11552-11582`). Coverage/date/boundary resolution uses original rows; only decay sees effective scores. Golden render parity must include budget pressure effects.
* A pending revision must **not** leak into Rust's speculative `compose_hard_fold_m0` byte-comparison probe (`crates/mc-module/src/transform.rs:4650-4660`) on an unrelated marker-only HARD. Pin that probe to the last applied score revision set. Advance to the latest score snapshot only when a fold already loses provider cache or normal content/pressure work independently requires a changed head. Otherwise score repair itself could turn a byte-identical marker fold into a new cache bust. Persist the applied score watermark with m[0] atomically; never compare latest-to-applied to request a fold.
* SOFT/DEFER only replay their existing primary prefix, and m[1] retains fixed P1. No importance-based m[1] revision or score-driven SOFT refresh. A genuine natural HARD includes pending overrides and folds m[1] normally.
* Status/search/calibration can show effective scores independently of prompt adoption. Expose “rescored, pending natural fold” separately from “included in last baseline.” A dormant session gets effective scores on its next already-cold initial/TTL render; no need to open its raw transcript first.

This is more explicit than editing the trigger to exempt `importance`: that alternative also needs changes to full-row fingerprints, Rust revision semantics, applied score snapshot semantics, and m[1] behavior. It is viable but riskier because external content repairs must retain every existing invalidation guarantee. Do not weaken the generic UPDATE trigger in the first implementation.

## Surface comparison

| Surface | Existing access and necessary changes | Many old sessions | Recommendation |
|---|---|---|---|
| `/ctx-rescore` | OpenCode builtin metadata beside recomp (`packages/plugin/src/shared/builtin-commands.ts:18-23`), argument validator (`packages/plugin/src/hooks/magic-context/command-handler.ts:148-159`), handler/RPC/TUI progress. Sample historian runtime configuration like `hook.ts:459-490`, but use a score-only completion request and a distinct publisher. Pi registers commands and resolves current deps (`packages/pi-plugin/src/commands/ctx-recomp.ts:65-119`), then uses its historian runner/model/thinking/timeout adapter (`:199-216`). | `--project` selects eligible sessions through canonical project registration, with a confirmed count/cost envelope, durable queue, status/pause/resume. User need not visit every old session. The originating live session supplies a pinned historian profile for the job; show all target sessions and require explicit choice for mixed-harness projects. | **First shipping surface.** User initiated, economical, model access already exists. Use the configured historian model and runner, not the foreground agent or dreamer model. |
| One-time dreamer backfill per project | Add a canonical single-shot task/capability (`packages/plugin/src/features/magic-context/dreamer/task-registry.ts:13-28,47-58,72-113`), config/backlog/lease integration and once-per-rubric completion state. Current dreamer model resolution inherits dreamer/task overrides, not historian (`packages/plugin/src/features/magic-context/dreamer/task-config.ts:16-41`). Explicit historian profile resolution would be required. | Best unattended coverage when enabled, but silently spending on thousands of old compartments at upgrade is undesirable. Interrupted jobs and projects rarely dreamed still need a discoverable resume path. | Optional later opt-in executor for the **same jobs**, not an automatic migration or a second independent rescoring algorithm. Completion is per-item, never a project boolean set before all items finish. |
| `doctor rescore` | Doctor dispatches diagnostics/repairs, and shared DB backfills once across harness adapters (`packages/cli/src/commands/doctor.ts:42-83,128-167`). It has no general scoring completion executor. Some per-harness checks connect to subc to diagnose service readiness; that is not model inference access. | CLI is convenient for fleet/project selections and idle sessions. | Initially support read-only eligibility/distribution/job status. Execution needs a broker into an authenticated active harness **or** a full Broca model/credential/config/accounting/cancellation layer, harness-specific historian profile resolution, project-bound routing and the shared score job API. Do not graft ad hoc provider auth or call recomp from doctor. |

Rust-mode needs a project-bound score job management API and the same host/module historian runner selection. The existing host-runner lane distinguishes model completion from module publication (`packages/plugin/src/hooks/magic-context/historian-host-runner.ts:17-34`); reuse transport abstractions, not its fold/publish endpoints. A rescore has no compartment-boundary work to claim. In host mode the harness completes the score prompt; in module mode Broca completes it. Both publish the same validated score revision rows. Fail clearly when no historian is configured. Log actual fallback use and do not switch models silently mid-job.

## Mechanics and rollout

1. **Eligibility/cutoff.** Only content-bearing tiered compartments created before the scoring fix are candidates. Exclude boundary-only markers, legacy/empty P1 rows and already completed revisions for the target rubric. Do not pick only 70–74: scores outside that interval may also be wrong. The base commit time is `2026-10-06T10:13:16Z`, but a Git timestamp is **not** each installation's upgrade boundary. Ship a rubric epoch; record the first activation time per installation/session, stamp future compartments with scoring rubric provenance, and snapshot pre-activation candidates for the backfill. For old rows without provenance, the recorded local activation cutoff is conservative; never assume that a dormant session ran the fix just because the release exists. A project job freezes both cutoff and eligible ids at confirmation. New summaries produced under the new rubric are not swept in on resume.
2. **Batching.** Default 20, reduced by actual input-token allowance for unusually long P1s; never truncate P1 silently. Randomized, reproducible non-neighbour batches across eligible sessions; retain stable batch membership, seed choices and prompt/rubric hashes for retries. Select three production seeds from different bands. Retain no old importance in model-facing JSON. Output must have exactly the requested ids, integer scores 1–100 and a one-line reason; reject extra/duplicate/missing ids. No enforced histogram and no copying score labels from same-session neighbours. Use the P1-only arm unless quality evidence warrants extra context.
3. **Durable jobs.** Persist pending/running/completed/failed/cancelled/stale item states, frozen model profile, project identity, batch ids/prompts hashes, provider run ids and lease heartbeat. Begin with one provider call per project; bounded parallelism can be added later. Never hold a SQLite write transaction during inference. Reattach an admitted run after a disconnect; if terminal state cannot be recovered, explicitly abandon the attempt before issuing a new one and retain its spend. Completed batches commit scores + per-item completion atomically. Resume only missing/failed items; rehash source rows and mark changed/deleted/recompacted ones stale rather than applying an answer to a different memory.
4. **Concurrency.** Coordinate source validation/publication with the compartment lease used by recomp (`packages/plugin/src/hooks/magic-context/compartment-runner.ts:269-292`) or equivalent module CAS. Lease acquisition should be short at snapshot/publish, not block normal historian production throughout hundreds of calls. The source identity CAS is authoritative even when a lease expires. A structural rewrite between completion and a later HARD also invalidates the sidecar's applicability.
5. **Audit/undo.** Record original and effective score, why/model/rubric, and completed time even if the score is unchanged. Avoid no-op base UPDATEs. Undo selects an earlier score revision (or base score) and waits for the next natural fold too; do not rebuild compartments. Store model reasons privately with normal memory access controls, not in public reports or logs containing summaries.
6. **Visibility/cost.** Preview session/item counts, projected calls/tokens and cutoff; explain that there is no immediate prefix change. Status reports scored/failed/stale/pending-adoption counts and last job error. Project identity must be canonical, respecting worktrees/aliases and ownership; no “all sessions” default across unrelated projects. Config reload cannot change a running job's model/rubric unnoticed. Budget/cancellation apply between batches and to active requests.
7. **Rust parity.** Add sidecar schema/domain reads to TS and Rust together; score tables remain host-owned and are not added to Rust's write/fingerprint list. Do not change raw `StoredCompartment` identities. Share JSON score validation, source-hash goldens and numeric rubric epoch. Route OpenCode/Pi commands to the same job service in Rust mode rather than editing a local mirror while ck-mc keeps another view. Test legacy sidecar absence and the store-open fence that refuses older writers to protect the applied-score watermark; merely accepting an unknown metadata key does not make a downgrade safe.

### Rust applied-score rollback fence

Rust stores the applied score-selection sequence beside its frozen m[0] bytes in
`mc_cache_state.meta`. Missing or zero means the base-score view only for a head
that has not adopted scores. An older decoder can ignore an unknown key and then
discard it on a metadata-only rewrite while preserving already rescored bytes.
That would make a later marker-only rebuild compare the wrong score view and
could let pending scores originate a provider-prefix bust.

The release therefore pairs watermark support with the branch's **existing
store.db fence v67** (`SCORE_SELECTION_WATERMARK_STORE_FENCE`), not a new migration.
The v98 score tables are in **context.db**; their version is not the module's
store.db ceiling. The placed pre-rescore ck-mc `77f54a691090a8927c3686735e912e46789e25c4`
has a store.db ceiling of 63 and cannot rewrite a store migrated by this branch.
A copied executable run against an isolated, branch-migrated v67 store refused:

```text
reason_code=store_ahead_of_binary db_version=67 binary_max=63
store.db schema is v67 but this ck-mc build only knows up to v63
```

This refusal comes from the store.db opener, before serving or rewriting cache
state. The context.db checks that tolerate newer lane versions or compatible
table shapes do not override the store.db opener's refusal.
The scratch cache row, applied W=1 and complete migration ledger stayed unchanged.
The real-executable probe and its isolation evidence are recorded in
`docs/reports/rescore-s3-rust-cache-review.md`.

`supported_store_fences_round_trip_applied_score_watermark_with_frozen_head`
pins every bundled ceiling from v67 onward: a nonzero watermark survives a
metadata-only commit and reopen alongside identical head bytes. Shorter v63–v66
openers are refused without changing the database. The downgrade regression
tests that refusal before replaying the applied view and an unchanged marker
HARD; it does not simulate an otherwise unreachable rewrite by deleting W.

Supported rollback restores the older ck-mc **and both context.db and store.db
from the same backup**. Replacing only the executable is refused. Intermediate
development binaries carrying the same schema ceiling but lacking watermark
support are not supported rollback artifacts; a fence cannot distinguish them.
All released writers admitted by this fence must retain the watermark, and the
round-trip guard must remain when the schema ceiling advances. Never recover a
missing watermark by selecting Latest or forcing an upgrade HARD.

## Required shipping tests

The trial proves feasibility of model input, not these product invariants. Before release, require:

* Live frozen m[0]/m[1]/boundary-section hashes, materialization timestamp, revision signals and `mustMaterialize`/Rust plan remain unchanged after publishing a score-only batch. Assert zero raw-body boundary revalidation, no force/refresh flag, no m0 mutation and no score-driven DEFER→HARD/SOFT, including migration-seeded histories and a nonzero pre-existing rewrite counter.
* A naturally cold TTL/model/pressure fold consumes overrides, changes the expected tier for a deliberately threshold-crossing score, and advances the applied score watermark atomically. Tests must use independent expected tiers, not compare a renderer against itself. A byte-identical marker-only HARD must **not** consume pending overrides.
* Score update does not move ranges or touch P1–P4, facts, search embeddings or count/max sequence. m[1] remains P1 until fold. Other rows' budget-pressure effects match across TS/Pi/Rust.
* Recomp/delete/move/source change races reject stale revisions; content-changing external UPDATE still produces Rust history-revision HARD and invalidates boundary identities. No broad trigger exemption.
* Crash before admission, after admission, after completion, and mid-publication each resumes without duplicate accepted scores or lost billing records. Pause/cancel/missing credentials/model failures are observable. Candidate JSON never includes old importance; test with unmistakable sentinels.
* Many dormant sessions under `--project`, mixed-harness confirmation, compaction-off/memory-off policy, no-P1 skips, and id reuse/clone/migration cleanup are covered. The feature may inspect/rescore stored history with compaction disabled, but must not turn compaction on or force history injection; advertise that distinction explicitly.

Use deliberate mutations for the silent cache invariants (score publication forced into base UPDATE, revision accidentally added to HARD classification, global effective-score loader leaking into boundary identity). A test that only checks a sidecar row was inserted does not establish cache safety.
