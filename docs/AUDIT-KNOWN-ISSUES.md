# Audit Known Issues

This document records findings that recurring audits (Oracle, Athena council,
blind review) tend to surface but that are **accepted as-is** — either correct
by design, a deliberate tradeoff, or a bounded/negligible cost we have chosen
not to pay down yet.

**For auditors (human, Oracle, or council):** the items below are NOT bugs to
re-report. Each one has been investigated against source and a deliberate
decision was made. If you believe one is genuinely wrong, argue against the
**reasoning** recorded here — don't just re-flag "X looks suspicious."

Pi↔OpenCode mechanism differences live in `packages/pi-plugin/PARITY.md`. This
file is for cross-cutting / OpenCode-core / dashboard items.

---

## Accepted by design (not bugs)

### A1. `trimMemoriesToBudgetV2` uses `continue`, not `break`

`inject-compartments.ts` — when a memory doesn't fit the remaining budget the
loop `continue`s instead of `break`ing. This is a **greedy knapsack fill**, and
it is correct: memories are pre-sorted `permanent → importance DESC → id ASC`,
so the highest-value memories are placed first. `continue` only lets a *smaller,
lower-ranked* memory drop into leftover budget that a larger one couldn't use —
it can never displace a higher-ranked memory. `break` would waste that leftover
budget. Do not change to `break`.

### A2. `memories.importance` exists but is not yet populated

The `importance` column (migration v22, nullable `INTEGER`) is read by
`trimMemoriesToBudgetV2`'s sort, but no current write path sets it — promotion
and `ctx_memory write` leave it NULL (treated as the default 50). The sort is
therefore currently inert (it collapses to `id` order). This is intended: the
column is in place for a future historian/promotion change that scores memory
importance. A NULL/50 default is harmless until then. Do not flag the column as
"unused" or the sort as "dead."

### A3. Decay budget-guard demotes oldest-first, one step at a time

`decay-render.ts` — after the decay curve assigns tiers, a guard loop demotes
compartments until the rendered block fits the budget. It demotes the *oldest*
eligible compartment first, fully, before touching newer ones. This is a
**rarely-fired safety net** (the curve already targets the budget; the guard
only corrects estimate drift or an unusually tight budget), and oldest-first
demotion *aligns* with the decay philosophy (older history is the first to lose
fidelity). A round-robin / even-distribution demotion would add complexity for a
path that seldom runs and whose bias is already the desired one. Accepted.

### A4. `ctx_memory merge` ownership is split by caller: primary-gated, dreamer cross-identity

`tools.ts` — `merge` is in the primary action set, so a **primary** caller is
held to the same visibility gate as `update`/`archive`: every source memory must
pass `memoryVisibleToTool` (own project in any category, or a foreign workspace
member only in a shared category). A primary agent cannot consolidate a memory it
cannot see. The **dreamer** keeps the cross-identity path **outside a workspace** —
its merge loop supersedes each source under **its own** project identity and queues
a per-project supersede-delta row, so every affected project's m[1] reconciles
(see the "merging across identities" test). The gate is the same one
update/archive use; do not weaken `merge` back to a bare project-ownership check —
that reintroduces the foreign-non-shared-category mutation hole.

**Workspace refinement (D1):** *inside* a workspace, the dreamer ALSO honors the
per-category sharing policy — a foreign member's memory in a non-shared category is
off-limits even to the dreamer, because the policy is the user's explicit privacy
boundary that the system's own consolidation worker must respect. Outside a
workspace the dreamer's cross-project power is unchanged (#5971). The gate is
`agent === DREAMER && workspaceIdentitySet.identities.length > 1 →
memoryVisibleToTool(source)`. Mirrored in Pi `ctx-memory.ts`.

### A5. Re-observing a fact does not revive an archived memory

`getMemoryByHash` does not filter by status, so when a fact whose prior instance
was archived is re-observed, it matches the archived row, bumps its `seen_count`
(recurrence is still recorded), and does **not** re-insert or un-archive it.
Archiving is a deliberate dreamer/user suppression; a recurring mention must not
silently override curation. Revival happens only through an explicit restore
(which bumps the project epoch). Accepted; locked by a characterization test in
`promotion.test.ts`.

### A6b. `ctx_memory delete` archives rather than hard-deletes

`tools.ts` — the `delete` action calls `archiveMemory` (soft delete: sets
`status='archived'`) and queues a `delete` mutation-log row, then returns
`"Archived memory [ID: N]."`. This is a deliberate data-safety choice: a memory
the agent "deletes" is recoverable via restore, and hard-deletion is reserved
for explicit dashboard bulk-delete. The return text honestly says "Archived,"
not "Deleted," so there is no misleading success semantic. The mutation-type is
`delete` (vs `archive`) only to distinguish agent-intent in the log; both render
as "removed" in m[1]. Do not change `delete` to a hard `DELETE`.

### A6. Deferred publications ride genuine bust opportunities (both harnesses) — RESOLVED

A background historian or recomp publication does not authorize its own cache
bust. OpenCode's `canConsumeDeferredOnThisPass(...)` and Pi's
`canConsumeDeferredLate` admit deferred state when the scheduler is already
executing, force materialization is active, or the same pass has another explicit
bust opportunity. This rule applies equally during long tool-using turns; the
scheduler is no longer delayed until a turn boundary. Explicit flush
(`hasPendingMaterialization`) remains a separate, always-eligible trigger on both
harnesses.

---

### A7. Legacy `trimMemoriesToBudget` (`break`) and `renderMemoryBlock` (v1) are dead in v2

`inject-compartments.ts` still defines `trimMemoriesToBudget` (which uses `break`,
not the V2 `continue`) and `renderMemoryBlock`, reached via
`prepareCompartmentInjection` → the postprocess `else if (pendingCompartmentInjection)`
branch. In v2 that branch is **unreachable**: `m0M1Enabled` gates on
`projectPath || projectDirectory`, and `projectDirectory` (the session directory)
is always present, so the m[0]/m[1] path always runs and owns the wire. The v1
`memory_block_cache` it would populate is not injected. Auditors flag the `break`
as under-filling vs A1's V2 `continue` — true in isolation, but the function does
not reach the wire. (`renderMemoryBlock` is still used by the historian reference
block, where it is cosmetic — dedup is content-based.) Do not "fix" the legacy
`break`; if anything, the dead v1 path is a future deletion candidate.

### A8. m[1] TTL-expiry has no `mustMaterialize` trigger (accepted cache tradeoff)

`materializeM0` snapshots active memories (some with `expires_at`) and pins the
expiry cutoff to `materializedAt`; `mustMaterialize` has no `expires_at`-based
trigger. A memory can therefore stay rendered briefly past its TTL until the next
natural materialization. This is the deliberate cache-stability tradeoff: a live
`Date.now()` expiry check would mutate m[1] bytes between defer passes and bust
the prompt cache (the exact bug fixed by freezing the cutoff). TTL precision is
sacrificed for byte-stable replay; the memory drops on the next cache-busting
pass. Do not add an expiry trigger to `mustMaterialize`.

### A9. Key-files render last-known-good content for one pass when disk drifts

`key-files-block.ts` — the render loop emits every stored `project_key_files`
row regardless of its `staleReason` (or a freshness check that just detected
drift); the freshness check only skips re-*checking* an already-stale row, never
re-*rendering* it, and the stale flag is flushed AFTER the render. So a file that
was deleted or content-drifted on disk still renders its last-known-good stored
content for one pass, then corrects on the next key-file refresh. This is the
documented design (ARCHITECTURE.md: "Injection renders only stored DB content.
Disk drift queues a CAS-protected stale update and never changes the bytes
already being rendered; stale writes do not bump the version because they do not
affect `<key-files>` output."). Skipping stale rows at render time would change
the rendered bytes every time a pinned file changed mid-session — the exact m[0]
cache bust the design avoids. Accepted.

### A10. ctx_memory non-additive mutations don't reselect or reorder m[0]

`tools.ts` — `delete`/`update`/`archive`/`merge` route through
`queueMemoryMutation` (supersede-delta m[1] rows), NOT a `project_memory_epoch`
bump, so they deliberately do not re-materialize m[0]. Two consequences are
within this accepted tradeoff:
- **Freed budget isn't reclaimed immediately.** After an archive/delete frees
  injection budget, a memory that was previously trimmed out of m[0] is not
  pulled back in until the next natural m[0] materialization. Reclaiming it
  would require re-materializing m[0] = a cache bust on a routine mutation.
- **Status-promotion reordering lags.** `merge` can promote the canonical to
  `permanent` (if any source was permanent); since selection is permanent-first
  only under budget pressure, the reorder doesn't take effect in m[0] until the
  next materialization. The canonical stays present throughout; only its
  trim-priority is briefly stale, and only under budget pressure.
Both self-heal on the next hard bust. This is the supersede-delta design: m[1]
deltas express add/remove/update, not reselection/reordering, precisely so
routine memory edits don't bust the m[0] prefix. (The dashboard differs — it
bumps the epoch on status changes — because an external editor cannot otherwise
signal a running session; see the dashboard's own path.) Accepted.

> **A8 addendum (materialize-boundary cutoff):** within a single `materializeM0`,
> the m[0] baseline memories are read with a `Date.now()` expiry cutoff a sub-ms
> before `materializedAt` is stamped, so a memory expiring in that window can
> render in m[0] one cycle past its TTL. This is the same TTL-precision-at-the-
> boundary tradeoff A8 already accepts (m[0] stays internally consistent and the
> memory drops on the next materialization); m[1]'s `id > maxMemoryId` filter
> prevents any double-render. Not a separate bug.

### A11. Key-files pickup after a Dreamer commit is lazy (next natural cache-bust), not eager

When the Dreamer commits new/updated key-files mid-session, OpenCode does NOT
force a refresh — the new `<key-files>` content is picked up on the next natural
cache-busting pass (`buildKeyFilesBlock` is re-read fresh whenever m[1] is
recomputed). This is **deliberate**: key-files live in m[1], so any pickup
necessarily rewrites the m[1] cache prefix; forcing that on every Dreamer commit
would bust the Anthropic cache for a low-urgency content change. Lazy pickup is
the chosen behavior (cache-stability over freshness for an infrequently-changing
block).

**Not a Pi divergence in v2** (the audit's "Pi eager vs OpenCode lazy" framing
predates the v2 layout): in v1, key-files lived in the system prompt and Pi's
Dreamer fired `onAdjunctsRefreshNeeded → systemPromptRefreshSessions` to refresh
it. In v2 the system block is guidance-only (`system-prompt.ts` explicitly never
emits `<key-files>`/`<project-docs>`/`<user-profile>`), and that signal targets
the **system-prompt** refresh set, NOT `historyRefreshSessions` (which drives
m[1]). So Pi also picks up key-files lazily via m[1]'s natural busts — same
effective behavior as OpenCode. Pi's lingering system-prompt refresh on Dreamer
commit is a near-no-op in v2 (guidance text doesn't change), not an extra m[1]
bust. Accepted on both harnesses.

### A12. Contention fresh-fallback renders m[0] with `materializedAt = 0`

When `materializeM0` loses the lock AND there is no cached baseline to reuse,
`renderFreshM0NonPersisted` renders a fresh, non-persisted m[0]/m[1] pair with
`materializedAt = state.cachedM0MaterializedAt ?? 0` (i.e. 0 on a true cold
fallback). A `materializedAt` of 0 disables m[1] expiry-cutoff filtering for
that one pass, so an un-cached fallback pass can render a slightly different
memory set than the eventually-persisted baseline — a single-pass prompt-cache
discontinuity at the exact moment of cross-process contention. It is
deterministic and cache-stable *across consecutive* fallback passes (the value
is frozen, not live `Date.now()` — that was a real round-5 bug, since fixed) and
self-heals on the next pass that wins the lock. The cost is one cache miss under
a rare race, not corruption. Accepted; mirrors Pi.

### A13. `computeBudgetPressureTwoPass` is exported but only used in tests

`decay-curve.ts` exports `computeBudgetPressureTwoPass` (two-pass pressure for
very tight <8K budgets). Production rendering uses the single-pass
`computeBudgetPressure`; the two-pass variant currently has only test callers.
It is kept (not deleted) because it is the documented, council-validated
tight-budget path and the decay curve's tier-cost math may need it if history
budgets shrink. Not dead code to prune reflexively — it is a validated reserve
helper with locked invariant tests.

> **Dead-surface note (v1 render path / `session_facts` / `plugin-messages.ts`):**
> the v1 `prepareCompartmentInjection` / `renderCompartmentInjection` path,
> vestigial `session_facts`, and `plugin-messages.ts` are documented dead in v2
> but still present. They are mutually gated against the v2 m[0]/m[1] path and
> not a live bug. Removing them is a deliberate standalone cleanup PR (with its
> own audit), NOT an opportunistic mid-batch delete — the v1 path still writes
> `memory_block_ids`, so deleting it carelessly could change behavior if the
> gating ever regressed. Tracked for a focused removal.

> **Coverage note (missing co-located migration tests):** migrations v14
> (project_key_files), v19 (compartment_state_lease), v23 (compartment_events), and
> v24 (historian_runs) lack the co-located `migrations-v<N>.test.ts` that
> STRUCTURE.md mandates. The schema is exercised indirectly (fresh-DB shape +
> feature tests), so this is a coverage gap, not a known defect. Migration v15's
> `deferred_execute_state` column is retired and remains only for schema continuity.

## Growing-data factors (bounded or slow; future cleanup)

These are intentionally listed so a future cleanup/maintenance task can address
them as a batch, and so audits stop re-flagging them as "leaks."

### G1. `memory_mutation_log` and `m0_mutation_log` have no GC

Both tables grow append-only over a project's lifetime; nothing prunes old rows.
Growth is slow (one row per non-additive memory mutation / m[0]-affecting
compartment op) and the render-time reads are cursor-bounded (`id >` watermark)
and target-id-filtered, so query cost does not grow with table size — only disk
does. A future maintenance task should prune rows older than the oldest live
session's m[0] materialization cursor. Low priority.

### G2. `docsCache` (`project-docs-hash.ts`) is an unbounded `Map`

Keyed by canonical project directory → `{directoryMtimeMs, files[], cachedHash,
cachedRendered}` (the rendered `<project-docs>` block + hash + file
fingerprints). One entry per project directory the process ever rendered, each a
few KB. Bounded by the number of distinct projects in a single long-lived
process (a handful in practice), **not** by sessions or time. Negligible; not a
real leak. Documented for completeness.

---

## Deferred low-priority fixes (tracked, not yet done)

These are genuine (small) fixes that are accepted as worth doing but not yet
scheduled. They are listed here so audits know they're already triaged; an
auditor re-finding one adds no new information.

- **Pi non-UI `/ctx-status`** uses the shared `executeStatus` text and does not
  render the m[0] Docs/User-Profile/Compartments breakdown the TUI dialog shows.
  Display-only; the dialog path (the common case) is correct.
- **Dashboard bulk-restore epoch TOCTOU** (`db.rs bulk_update_memory_status`):
  `is_restore`/`is_archive` are latched from Phase-A status outside the
  transaction, and bulk restore bumps every affected identity's epoch regardless
  of each row's prior status. Worst case is a redundant epoch bump (an extra m[0]
  re-materialization), not data loss.
- **Dashboard work-metrics carry** has no invalidation on message removal (stale
  warm-start value until restart; the lazy RPC recompute self-heals on cold
  read).
- **Dashboard token breakdown** is still v1-shaped (no Docs/User-Profile buckets;
  reads the legacy `memory_block_cache`) — a display divergence from the TUI
  sidebar's v2 breakdown.

### A14. Vestigial `session_facts` / `plugin_messages` / `user_memory_candidates` tables

These are documented as retired/latent (facts are promoted memories; the
plugin-message bus is superseded by RPC; `user_memories` defaults off) but are
still created on every DB, migrated, and deleted in `clearSession`.
`getSessionFactsVersion` returns a hard-coded `0` and the `sessionFactsVersion`
branch in `mustMaterialize` is kept inert-safe but never fires; no module imports
`plugin-messages.ts` at runtime. Dropping the truly-dead ones is a schema
migration that should be gated on the minimum supported TUI version no longer
polling the old bus — deferred to avoid a migration during active dogfooding. No
correctness impact; the inert branch is a no-op.

**Audit clarification — these ARE created on fresh installs.** They are created
by **migrations** (`plugin_messages` v2; `user_memory_candidates` + `user_memories`
v3; `session_facts` via `initializeDatabase`), NOT all by `initializeDatabase`.
`openDatabase` runs `initializeDatabase(db)` **then `runMigrations(db)`** on every
open, and a fresh DB has `getCurrentVersion()===0` so it applies ALL v1–v26
migrations. So `clearSession`'s DELETEs against these tables never throw on a
fresh install — verified empirically and locked by the
`clearSession runs on a fresh DB` regression test in `storage-db.test.ts` (asserts
every one of the ~16 tables `clearSession` touches exists fresh). A repeated audit
claim that "`clearSession` rolls back on fresh DBs because table X is never
created" is a **false positive**: it assumes fresh installs build schema from
`initializeDatabase` alone and skip migrations, which is not how `openDatabase`
works.

### A15. In-session memory mutations have no dedicated cache-bust signal

A non-additive `ctx_memory` mutation (delete/update/archive/merge) queues a
`memory_mutation_log` row but does not itself schedule a cache-busting pass — the
`<memory-updates>` delta recomputes on the next cache-bust triggered by other
work. This is the intended supersede-delta eventual-consistency tradeoff (the
whole point is to NOT hard-bust m[0] on every memory edit). Delete visibility is
therefore delayed until the next natural bust. Accepted by design; see the m[1]
memory-mutation note in ARCHITECTURE.md.

### A16. Session-scoped queries don't include the `harness` discriminator

`harness` columns exist on session-scoped tables, but session-scoped reads key on
`session_id` alone — the code relies on OpenCode and Pi session IDs never
colliding in practice (different id formats). If they ever did collide,
session-scoped state could alias across harnesses. Accepted as latent; revisit
only if a shared ID scheme is introduced.

### A17. `materializeM0` runs two over-budget guards for the same budget

`renderM0` escalates `decayPressureMultiplier` (up to 3×, re-rendering m[0] each
iteration) while `renderDecayedCompartments` independently demotes oldest-first.
Both use the same unified estimator and converge deterministically, so there is
no cache-stability risk — only redundant compute on very large histories. An
observation, not a defect; consolidate only if materialize latency becomes a
concern.

### A18. Legacy V5 key-files path ships alongside active V6

The old per-session `session_meta.key_files` storage + candidate/heuristic
selection remains while the live Dreamer path uses V6 `runKeyFilesTask` +
project-scoped `project_key_files`. Drift-prone duplication in a path-containment
subsystem. Removing/hard-isolating V5 is worthwhile but risky to do casually in a
security-sensitive area; deferred to a focused change. (The V6 validator's
candidate-set + doc-exclusion enforcement was added this round — see the
key-files trust fix.)

### A19. No byte-equivalence parity test for Pi's `inject-compartments-pi`

Pi re-implements parts of m[0]/m[1] rendering (`resolvePiStableId`,
`SYNTH_USER_ID_PREFIX`) while sharing hash/mutation/trim helpers from
`@magic-context/core`. `mustMaterialize` must produce byte-identical m[0]
decisions across harnesses or caches diverge. Parity is currently enforced by
PARITY.md discipline + nine rounds of cross-harness audits rather than an
automated equivalence test. A test feeding identical DB state through both paths
and asserting byte-identical m[0] is a worthwhile future addition; the divergence
risk is documented, not unguarded.

### A20. m[1] memory-mutation surfacing uses the memory-mutation cursor, not the compartment cursor (by design)

A repeated audit claim is that the m[1] drift/refold watcher compares
`maxMutationId` (`m0_mutation_log`, compartment ops) instead of
`maxMemoryMutationId` (`memory_mutation_log`), so in-session memory edits never
surface. **False positive.** Two independent mechanisms exist and both are
correct: (1) `mustMaterialize` deliberately EXCLUDES `maxMemoryMutationId` from
its trigger set (an m[0] hard-bust on every memory edit would defeat the
supersede-delta design); (2) on every cache-busting pass `softRefreshCachedM1` →
`renderM1WithMetadata` reads `memory_mutation_log` via
`getMemoryMutationsForRender(afterId = markers.maxMemoryMutationId)` and renders
the `<memory-updates>` block, AND the +15% drift refold has a size-independent
`memoryUpdateCount > 40` trigger. So a non-additive memory mutation surfaces on
the next cache-busting pass — exactly the A15 "next natural bust" window, not an
unbounded-staleness bug. The two watermarks track different things on purpose.

### A21. `softRefreshCachedM1` post-ROLLBACK fallback read is intentionally un-transactioned

`readCachedM0M1Row` is a SINGLE atomic SELECT, so SQLite guarantees all
m0/m1/marker columns come from the same committed row — a torn cross-column read
is impossible. The post-ROLLBACK fallback adopts whichever sibling committed most
recently (newer and still self-consistent), which is correct. Wrapping a single
SELECT in `BEGIN/COMMIT` would add write-lock contention on a hot path (every
cache-busting pass) for zero consistency gain. Inline-commented at the call site.

### A22. Pi `trimPiMessagesToBoundary` worst-case O(N²) orphan sweep

The `while(changed)` re-scan with per-result owner lookup is O(N²) worst-case,
but bounded (the removal set grows monotonically) and the cascade depth is tiny
in practice (tool-call/result pairs are adjacent). This is carefully-audited
cross-turn pairing logic (nine Pi rounds); a single-pass rewrite carries more
correctness risk than the Low perf payoff on the realistic input sizes. Deferred.

### A23. `flushStaleUpdates` map growth + `ctx_memory merge` tier visibility — both false positives

(1) `flushStaleUpdates` calls `staleUpdates.clear()` **before** the write loop,
so a SQLITE_BUSY write failure does NOT re-queue the entry — the map cannot grow;
it also already logs on failure. (2) `ctx_memory merge` runs `insertMemory`
(active) → `mergeMemoryStats` (final tier) → `supersededMemory` inside ONE
`deps.db.transaction()`, so SQLite isolation makes the intermediate `active` tier
invisible to concurrent autocommit readers (they see pre-tx or fully-committed
state only). Neither is a real race.

### A24. The message-transform wrapper fails OPEN (catch → unmodified messages) on purpose

`messages-transform.ts` catches every transform error and returns the messages
**unmodified** rather than rethrowing. Auditors flag this as contradicting the
"fail-closed" goal (raw, untrimmed history could reach the provider and overflow
context). The catch is **load-bearing and cannot be removed**: OpenCode runs the
hook via `Effect.promise(async () => fn(...))` (`plugin/index.ts`), and
`Effect.promise` treats a rejection as an unrecoverable **defect (die)** that
propagates out of the prompt fiber with no catch around the call site — so a
thrown hook **hard-fails the whole user request**, and would do so on *every*
pass for a persistent error (e.g. the transient `SQLITE_BUSY` that motivated
issue #23). Fail-open degrades one pass (no injection / no drops) instead of
bricking the session. The genuinely risky sub-case — a throw *between*
`prepareCompartmentInjection`'s tail-trim and `injectM0M1`'s prepend, which would
drop history for that one pass — is bounded (the next pass replays correctly) and
the content strips are idempotent. A future hardening would stage trim+inject
atomically so a throw leaves the array fully transformed or fully untouched; that
is a core-path refactor, not a quick fix, and is deferred. Do not "fix" this by
rethrowing. (Pi mirrors the same fail-open philosophy in `context-handler.ts`.)

### A25. Key-files stores LLM-provided `content`, not content re-derived from disk

`identify-key-files.ts` validates the chosen *path* (candidate-set membership,
traversal guards, doc/lockfile exclusion — the membership + exclusion checks were
added this round) and computes the stored `content_hash` from disk, but the
stored `content` block itself is the LLM's stitched output, not re-read from the
file at commit time. A prompt-injected/hallucinating Dreamer could in principle
store text that doesn't match the file, which then injects as trusted
`<key-files>` context. Accepted for now because: the path allow-set + doc
exclusion close the worst vector (arbitrary off-repo file selection), the Dreamer
runs the user's own model on the user's own repo, and re-deriving content from
disk (or AFT outline+zoom) at commit time is a larger change to the key-files
pipeline. Tracked as a hardening candidate, not an open hole. The inline comment
at the commit site documents that semantic content-provenance is not enforced.

### A26. `materializeM0` Phase-1→3 contention can fail all retries (fragility, not corruption)

`materializeM0` reads a snapshot under a plain `BEGIN` (Phase 1), renders m[0]
outside any transaction (Phase 2), then re-checks markers under `BEGIN IMMEDIATE`
(Phase 3) and aborts with `MaterializeContentionError` if any marker drifted —
including a sibling-process historian publish advancing `maxCompartmentSeq`
(which `mustMaterialize` correctly treats as *soft*). Under sustained
cross-process contention all 3 retries can lose, falling back to a fresh
non-persisted render (correct, just uncached for that pass). This is an
availability/fragility cost, not a correctness bug — the fallback always renders
*something* valid and the next pass retries. Treating compartment-seq drift as a
soft merge (don't roll back the whole materialize for it) is a possible future
refinement; the retry+fallback path is safe today. Accepted.

### A27. Compartment historian lease uses a single-statement UPSERT (not `BEGIN IMMEDIATE`)

`compartment-lease.ts` acquires/renews via one `INSERT … ON CONFLICT DO UPDATE`,
which is atomic *per statement* — sufficient for the acquire decision — whereas
the dreamer lease wraps its read-then-write in `BEGIN IMMEDIATE`. The compartment
lease's renewal/expiry checks are therefore slightly less guarded against a
pathological interleave, but a duplicate historian run is itself defended by the
per-process `activeRuns` check and the publish transaction's own lease
re-verification. No duplicate-run has been observed in multi-process dogfood.
Aligning it to `runImmediate` is a low-value hardening; deferred until/unless a
duplicate run is actually seen.

### A28. Historian failure dumps may contain session content (debug aid, opt-in cleanup)

On a failed historian run, `compartment-runner-historian.ts` writes the full
model response under `<project>/.opencode/magic-context/historian/` for
debugging (this is why failed subagent sessions are now *retained*, not deleted —
a deliberate debuggability choice). In a shared repo / CI these dumps could
contain session content. Accepted as a debug tradeoff: the path is project-local
(not a shared tmp), failed-run retention is the whole point, and a future
enhancement could TTL-GC the dumps or gate them behind a flag. Not exfiltration —
it's local disk the user already controls.

### A29. `ctx_memory` schema advertises the full dreamer action enum to primary agents

The `ctx_memory` tool schema lists the full action enum (incl.
`merge`/`archive`/`update`/`list`) to all agents, while runtime gating correctly
restricts primary agents to `write`/`delete` (fail-closed — a disallowed action
returns an error). So the only cost is a primary agent occasionally *attempting* a
gated action and getting rejected (a wasted turn), never an actual capability
leak. Per-agent dynamic schema registration would remove the wasted attempt but
adds tool-definition complexity for a cosmetic UX gain. Accepted; the security
boundary is the runtime gate, which is correct.

> **A14 update — `session_facts` is now fully retired (no live reader):** an
> earlier correction here noted `session_facts` still had ONE live reader
> (`compartment-runner-partial-recomp.ts` snapshotting facts to "carry through
> staging"). That reader was removed: partial recomp snapshotted facts and
> reported "Facts unchanged (N)", but the recomp promote path
> (`promoteRecompStagingWithM0Mutation`) unconditionally `DELETE`s `session_facts`
> and never re-inserts, so the snapshot was dead work and the message was
> misleading. Partial recomp now stages an empty fact list and drops the claim.
> `session_facts` is therefore vestigial in v2: written by nothing on the live
> path, read by nothing, rendered by nothing. The table + `getSessionFacts` are
> kept only for schema stability / legacy rows; safe to treat as dead.

### A30. Pi `upgrade_state` m[0] marker is dynamic (parity with OpenCode) — superseded

**Superseded — no longer a divergence.** Earlier this entry described Pi pinning
`PI_M0_UPGRADE_STATE` to a static constant while OpenCode used a dynamic
`getUpgradeState`. Pi's marker is now **dynamic**: `inject-compartments-pi.ts`
computes `${PI_M0_UPGRADE_STATE}:${legacy|ready}` from the presence of legacy
compartments and the materialize stale-check compares it
(`current.upgradeState !== snapshotMarkers.upgradeState`), so a session crossing
from legacy → upgraded HARD-refolds m[0] via the marker — matching OpenCode. (The
shared `clearCachedM0M1` cache-clear in the upgrade path is still a belt-and-
suspenders backstop.) See PARITY.md §12, now also marked parity.

### A31. Dreamer-v2 deferred items (telemetry, session lifecycle, maintenance cadence)

These surfaced in a focused dreamer audit and are **intentionally deferred to the
planned dreamer-v2 overhaul** (where the dreamer becomes a cron-style per-task
runner). They are quality/observability gaps, not correctness or safety bugs:

- **DREAMER#4 — Pi dream telemetry has no parent-session attribution.** OpenCode
  resolves a parent session id so child dream sessions can be grouped in the
  dashboard; Pi passes none. Cosmetic dashboard grouping only.
- **DREAMER#5 — successful dream child sessions are deleted, failed ones kept.**
  Intentional (keep failures for debugging), but means a successful run's
  transcript isn't inspectable. Revisit when dreamer-v2 adds per-task run records
  with persisted changed-memory ids (see note #221).
- **DREAMER#6 — `maintain-docs` has no code-change trigger.** It runs on the
  dream cadence regardless of whether the repo actually changed, so it can rewrite
  ARCHITECTURE/STRUCTURE on a quiet repo. Low-cost; dreamer-v2 will gate tasks on
  real change signals.
- **DREAMER#7 — scheduled drains can fire slightly outside the configured
  window.** The schedule gates *enqueue*; a drain already in flight at the window
  edge can complete just after. Bounded and harmless (one extra run), not a
  contamination bug (that was DREAMER#1, fixed).

### A32. Embedding/index freshness is id/watermark-based, not content-hash based

- **EMBED#3 / EMBED#5 / MEM#3 (same family) — memory embeddings refresh by
  `memory.id` / mutation, not by a content hash.** If a memory's *content* is
  edited in place without a new row, a stale embedding can linger until the next
  full re-embed sweep. Accepted: in-session edits go through delete+reinsert (new
  id) or bump the mutation cursor, and the periodic dream-timer sweep re-embeds;
  a content-hash column is a dreamer-v2 nicety, not a correctness gate.
- **EMBED#4 — git-commit indexing has no incremental per-commit watermark.** It
  re-reads HEAD's bounded window each sweep and dedups by commit sha, so it's
  correct but does redundant work on large repos. Bounded by `since_days` /
  `max_commits`; optimize later if it ever shows in profiles.

### A33. RPC `/ctx-dream` drain is dedup-guarded, not lease-locked (RPC#2)

`/ctx-dream`'s immediate drain relies on `processDreamQueue`'s own
`hasActiveDreamLease` check plus the queue dedup, not a separate caller-side lock.
Two near-simultaneous `/ctx-dream` invocations both enqueue-then-drain, but the
lease inside `processDreamQueue` ensures only one actually runs (the other returns
"another worker is already processing"). The window is benign — no double-run, no
data race — so a caller-side lock would add coordination for no behavioral gain.
Accepted.

### A34. Emergency tiered drop latches on the usage sample, not on reclaim sufficiency (by design)

`planEmergencyDrop` (`emergency-drop.ts`) drops oldest-first across tiers until
the reclaim target is met OR all active candidates are exhausted. When the active
tail is genuinely too small to hit the target, it drops everything droppable and
the apply path latches `last_emergency_input_sample` to the current usage reading
— so the NEXT ≥85% pass on the same (not-yet-remeasured) sample no-ops instead of
re-walking the already-shrunken tail and re-busting the cache. An audit may read
this as "under-reclaim": the drop didn't reach the target, yet the pass latches
and stops. That's intentional — re-evaluating on the same stale sample can only
over-drop the remainder (the floor recomputes from a smaller tail), thrashing the
prefix for zero new headroom. The ≥95% emergency block is the correct backstop for
"nothing left to drop." A fresh provider sample (the reading changes) releases the
latch and the next pass re-evaluates. Accepted; do not "fix" by dropping the
sample latch.

### A35. node:sqlite `.transaction()` shim relies on the native `isTransaction` getter (verified, not a bug)

The non-Bun SQLite branch (`shared/sqlite.ts`) subclasses `DatabaseSync` and adds
a `.transaction()` shim that picks `BEGIN` at top level vs `SAVEPOINT` when
nested, keyed off `db.isTransaction`. An audit may flag "the shim never sets
`isTransaction`, so nested savepoint detection is broken." It is NOT broken:
`isTransaction` is a NATIVE node:sqlite getter that the runtime flips on
`BEGIN`/`COMMIT`/`ROLLBACK` — the shim reads it, never sets it. Verified by
running the real shim under Node 24.15 (nested savepoint: inner rolls back, outer
commits → final rows `a,c`; `b` correctly discarded). Accepted as correct.

### A36. `channel2_nudge_state` reads `''` (not NULL) for rows predating migration v31 (verified safe)

Migration v31 adds `channel2_nudge_state TEXT DEFAULT ''`. An audit may worry that
pre-v31 rows read `NULL` and break the CAS (`WHERE channel2_nudge_state = ''`).
SQLite `ALTER TABLE ADD COLUMN ... DEFAULT ''` physically backfills existing rows
with the default, so they read `''` (verified `IS NULL → 0`), and the
trigger/delivery CAS matches.

A wedged `'claimed'` lease (crash mid-delivery) is still healed by
`healWedgedChannel2Claims` (`storage-db.ts`), and `openDatabase()` now reruns that
TTL-scoped heal on cached-handle reuse too so long-lived processes eventually
unwind stale claims without a restart. The lease uses
`channel2_nudge_claimed_at` as its liveness boundary: fresh claims are left alone
so a sibling process boot cannot steal a live in-flight delivery; stale/legacy
claims rewind to `'pending'`. If a send fails and the `claimed→pending` restore is
locked, the row stays `claimed` with its timestamp intact and later TTL-heals back
to `'pending'`.

One rare duplicate window remains accepted by design: if a process is suspended or
otherwise hangs for longer than the TTL after sending but before confirming, a
sibling can heal that stale claim, redeliver the same reminder, and mark
`'delivered'` first. The original sender now preserves an already-`'delivered'`
row and logs that stolen-lease path distinctly for diagnosis, but it cannot
unsend its already-queued reminder. The cost is one duplicate synthetic message,
not extra cap consumption.

### A37. `NORMAL_HYSTERESIS_TOKENS` (256) eligible-head snap is deliberate (boundary-straddle wobble accepted)

`protected-tail-boundary.ts` snaps `protectedTailStart` to `offset` when the
eligible head is ≤256 tokens. An audit may flag that a session whose eligible
head straddles ~256 tokens can flip `eligibleEndOrdinal` between passes (a
defer-pass fingerprint change → one cache bust). Accepted: the clamp IS the
cache-stabilizing mechanism (pins sub-256 heads to offset so tiny heads never
produce a 1-message historian arc), the straddle case requires the head to sit
exactly at the threshold while ALSO being below every size trigger, and the cost
is one bust on the pass where it flips — not a recurring drift. Widening the
threshold only moves the straddle point; hysteresizing boundary identity would
add cross-pass state to a deliberately stateless resolver. Re-evaluate only with
live evidence of repeated flip-flop busts on a real session.

### A38. `protectedTailStart` has no `priorBoundaryOrdinal` floor on non-migration passes (deliberately stateless)

An audit may suggest persisting the previous pass's boundary as a monotonic
floor to prevent "backward drift under multi-process races". Deliberate
non-goal: the v3 boundary is a pure function of (messages, usage, budget) — the
anchor-based offset (`lastCompartmentEnd+1`) already provides the durable floor
that matters (never re-eligible below the last compartment), backward relaxation
of the USER-TURN component is a designed feature (#132 sparse-session deadlock),
and a persisted high-watermark would reintroduce the ratchet-starvation class
the redesign removed. Cross-process boundary skew is bounded by the shared
compartment anchor and resolves on the next publish.

### A39. Tool-tag token_count is computed once (no growth bump on OpenCode) — verified unreachable, intentional

Audits flag that `assignToolTag` returns early on the existing-tag fast path
without re-measuring `token_count`, so a tool output that "grows on a later
pass" would keep a stale count and skew boundary math. On OpenCode this growth
is UNREACHABLE: tags are only created once `state.output` is a string — i.e.
after the tool COMPLETED — and OpenCode writes tool output exactly once
(Channel-1 reminder appends happen in `tool.execute.after`, before persistence
and before any transform observes the part). Verified empirically across
100,670 tool tags on the two largest live sessions: zero byte_size drift vs the
current opencode.db output. Pi DOES bump (tag-transcript.ts) because it tags
the invocation occurrence first (byte_size=0) and must update when the result
lands — that asymmetry is structural, documented at the OpenCode call site
(tag-messages.ts). Adding a per-part size compare to OpenCode's hot path would
cost every pass to defend a case that cannot occur.

### A40. `estimateTokens` counts embedded special-token literals as ordinary text (accepted accuracy tradeoff)

Content containing literal special-token strings (e.g. `<EOT>` inside tokenizer
source code) is encoded as plain text — the provider may count such literals
differently, so boundary sizes can be off by tens of tokens for files dense in
them. This replaced a production CRASH (encode threw on special tokens) and the
residual error is far below the boundary's natural estimator-vs-provider delta.
Accepted; do not re-introduce special-token parsing.

### A41. Dashboard memory archive does NOT bump workspace member epochs (by design — supersede-delta)

Audits flag that a dashboard archive (`active/permanent -> archived`) only
queues a `memory_mutation_log` row and does not bump the project (or workspace
member) epoch, so a running session's cached m[0] is not hard-invalidated. This
is the deliberate supersede-delta contract: non-additive memory mutations ride
the m[1] `<memory-updates>` delta (`getMemoryMutationsForRenderByProjects` reads
the union `WHERE project_path IN (members)`), and reconcile into m[0] on the
next NATURAL hard bust — bumping the epoch on every archive would force a hard
m[0] re-fold in every workspaced sibling session, the exact cache-thrash the
supersede-delta was built to eliminate. Only RESTORE (`archived -> active/
permanent`) bumps, because a re-appearing memory has no delta row to surface it.

### A42. Workspace semantic search does not backfill FOREIGN members' embeddings (by design)

`ensureMemoryEmbeddings` runs only for the session's OWN project; foreign
workspace members are scored from their already-stored embeddings (and skipped
when their stored `model_id` differs from the query model). Backfilling every
member's missing embeddings from a member session would re-introduce the
cross-project re-embed loop the per-project embedding ownership was designed to
prevent (each project embeds its own corpus via its own publish/sweep). Foreign
members surface via FTS regardless; semantic recall over them catches up once
their own host embeds them. Accepted v1 workspace behavior.

### A43. Workspaced m[1] `<new-memories>` delta uses the flat budget trim, not per-member floors (by design)

The per-member fairness floor (`trimWorkspaceMemoriesToBudgetV2`) applies to the
m[0] baseline only. The m[1] new-memories delta is a small, recency-driven
slice (25% of the memory budget) reconciled into m[0] on the next hard bust, so
it intentionally uses `trimMemoriesToBudgetV2` — applying floors to a tiny delta
adds determinism cost for no fairness benefit. Matches the v2.2 workspace spec.

### A45. Dashboard workspace epoch fan-out does not consult the v22 identity-rekey map (self-heals)

`workspace_member_identities_for_project` resolves a session's project to the
union of its workspace siblings' identities, but does not expand pre-v22 path
aliases via `v22_identity_rekey_map`. A memory stored under a legacy raw path
(not yet rekeyed to its `git:`/`dir:` identity) could miss an epoch fan-out on a
membership mutation. Self-heals: the v22 backfill rekeys those rows to their
canonical identity, after which the fan-out matches. The window is narrow
(pre-v22 rows on a workspaced project, before backfill drains) and the only
symptom is a delayed m[0] refold, not data loss. Post-ship hardening.

### A46. `computeWorkspaceEpochFingerprint` treats a missing project_state row as epoch 0 (out-of-band only)

A member project with no `project_state` row hashes as epoch 0, colliding with a
member genuinely at epoch 0. Only reachable if membership is added OUTSIDE the
normal CRUD path (which seeds `project_state`); the dashboard/plugin mutation
paths always create the row. Post-ship defense-in-depth: include the sorted
member-identity list in the fingerprint hash so absent-vs-zero can't collide.

### A44. `ctx_search` cross-source rank uses linear-band remap, not raw IDF magnitude (parked — message embeddings supersede)

A common-literal probe-only message can still reach the top of the message list
and, after the `linearDecayScore(rank, n)` remap, present as a strong score that
can edge out a single-source memory hit. The linear-band remap was ADDED to stop
message hits from crowding memories (note #235); retaining full IDF magnitude
post-fusion is a finer tuning. Parked deliberately: the lexical ctx_search
ranking is being replaced by compartment/message embedding recall, which changes
this surface wholesale — re-tuning the RRF band now is wasted churn.

### A47. Dreamer agentic memory tasks can commit a `ctx_memory` write in the ≤60s window between a lost lease and the abort (pre-existing, not a v2 regression)

The verify/curate agentic tasks mutate memories by driving the dreamer child
session, which calls the `ctx_memory` tool.
Those tool writes commit DURING the child run. The agentic path guards the lease
with a 60s `renewLease` tick that, on failure, aborts the child and then throws
`"Dream lease lost during task"` after the run — but a lease lost between ticks
leaves a window (≤60s) where a `ctx_memory` write can commit before the abort
lands. The three SPECIALIZED runners (review-user-memories, key-files,
evaluate-smart-notes) do NOT have this gap: they do their own
`peekLeaseHolderAndExpiry` check inside the commit transaction (lease-held-before-
commit).

Further hardened (v0.26 release audit, council B#2): `startLeaseHeartbeat` now
confirms ownership SYNCHRONOUSLY at t=0 (declares-lost-before-returning if a
different holder owns it — no pre-first-beat window), and `runDomainGroup`
re-peeks the lease before each task in the group. The residual window is now a
single in-flight `ctx_memory` write racing the abort. Decided NOT to thread
lease state into the shared `ctx_memory` tool (also used by primary agents +
sidekick): both racing runs operate on the SAME project pool (that is why they
share the lease) and the mutations are self-healing — archive idempotent, merge
supersedes, write dedups by hash — so a stray write is redundant curation of the
same pool, never corruption. Not worth the risk surface on a primary-agent path.

This is a **pre-existing property carried verbatim from v1** (v1's agentic tasks
used the same renew-tick + post-run-throw shape under a single serial lease), NOT
introduced or worsened by the v2 A+B cutover: v2's per-domain `memory:<project>`
lease keeps the four memory tasks serial within a project exactly as v1's single
global drain did. Closing it properly requires threading the dreamer lease
context (`holderId`/`leaseKey`) into the child session's `ctx_memory` tool calls
so each memory mutation re-verifies the lease at its own write site — a
tool-surface change that applies equally to shipped v1 and is out of scope for
this cutover. Tracked as Dreamer-v2 post-ship hardening.

### A48. Dreamer V2 audit (v0.27.0) — accepted/deferred non-gating findings

The three blind councils for v0.27.0 Dreamer V2 returned a SHIP-conditional read
once the gating set was fixed (B#1 watermark loss, A#1/A#2 migration gap, B#2
full-source overlap, B#4 gate parser, C#1/C#2 shareable invalidation, B#3 orphan
sweep — all fixed in this release). The remaining items are accepted as-is or
deferred:

**Two SOLO Council-A P1 watermark claims — DISMISSED (verified at source, not
corroborated by the other 8 members):**
- "sentinel `files=[]` / new-memory writes advance the verify watermark past
  degraded verification state." False: `verify` intentionally SKIPS sentinel
  (file-independent) memories — they are re-verified by `verify-broad`, which
  runs the full pool. A newly-written memory has no `memory_verifications` row,
  so it is always in-scope on the next run (`!verification → inScope`). Nothing
  is silently marked verified.
- "git-diff computed against the worktree, not the captured `startHead`, lets a
  masked committed change advance the watermark unverified." False: `git diff
  <rev>` is ALWAYS against the working tree by definition, so any worktree
  difference re-surfaces the file on the next run. At worst redundant, never
  lost.

**Deferred (non-gating, post-ship):**
- **B#3 residual** — the orphan sweep is OpenCode-only and periodic (next dream
  tick), so a retrospective child orphaned by a hard crash persists until the
  next sweep cycle, not instantly. Acceptable: the sweep is age-gated and the
  window is bounded; Pi children die with their subprocess.
- **B#6** — the overlap reader is a fixed `readUserMessagesBefore(count)` per
  session, not paged until N user rows accumulate. The bounded count is the
  intended cap; the idempotence key prevents re-extraction regardless.
- **B#7** — observation candidates are not deduped at insert (the source-window
  key already prevents the same friction window from being deepened twice).
- **B#8** — a malformed-vs-empty deepen output is treated the same (no learning,
  watermark still advances). Fail-safe by design.
- **B#9** — the cheap activity pre-gate keys off `session_projects.updated_at`,
  which can be stale relative to the content watermark; the executor's precise
  scan is the real gate and bails before any child session when empty.
- **C#3** — classify has no empty-pool early-exit / per-ID coverage gate; the
  task bails cheaply on an empty pool and per-ID errors abort the batch.
- **C#4** — a classify batch is not wrapped in a single transaction, so a
  mid-batch error can leave earlier-ID column writes committed. Harmless
  (column-only, cache-neutral, re-runnable); a future hardening can pre-validate
  all ids + wrap.
- **C#5 / nits** — `scope`/`shareable` absent from the startup `ensureColumn`
  heal-list (the v44 migration adds them; heal-list is belt-and-suspenders);
  stale dashboard `MemoryCategory` TS union; `RAW_QUOTE_REGEX` misses curly
  single quotes; dedup key collapses same-ms messages (1-message boundary
  re-read is covered by idempotence). All cosmetic / self-healing.

### A49. Embedding untrusted-load latch is process-local (not persisted)
The per-model embedding GC consults an in-memory `untrustedLoadProjects` Set to
skip GC for a project whose latest config load was degraded/untrusted. An audit
recurringly flags this as cross-process-unsafe on the shared OpenCode+Pi DB ("a
sibling process could GC a project another process latched untrusted"). Verified
not reachable: `sweepStaleEmbeddingIdentitiesForProject` has exactly ONE caller
(`dream-timer.ts` `sweepProject`), and the line immediately before it
(`await reg.ensureRegistered(...)` → `ensureProjectRegisteredFromOpenCodeDirectory`)
re-reads the on-disk config and re-derives `isConfigLoadUntrusted` → re-latches
in the SAME process before that process's GC runs. So a process only ever GCs
when its own fresh read of the same on-disk config was trusted; there is no
window where it GCs off a stale trusted registration. Pi never calls the GC at
all. Persisting the latch (a migration + cross-process write coordination) would
add complexity for a window that does not exist given this ordering. If the
ensureRegistered-before-GC pairing is ever broken, revisit this.

### A50. Smart-note compiled checks expose readFile + httpGet in one sandbox (egress is the accepted v1 design)
Compiled smart-note checks run in a QuickJS WASM sandbox with BOTH a `readFile`
capability (repo-relative, denylist-guarded) and an `httpGet` capability
(SSRF-guarded, public hosts). An audit recurringly flags this as an exfiltration
P0: a prompt-injected `surface_condition` could author a check that reads a repo
file and POSTs it to an attacker host, and the capability manifest is advisory
(not a runtime allowlist). This is the DELIBERATE v1 decision (see
`.alfonso/plans/smart-notes-compiled-checks-spec.md`): v1 allows all external
egress, the manifest is an audit artifact not a security boundary, and the actual
boundaries are the fail-closed SSRF guard (blocks loopback/RFC1918/link-local/
metadata, pins the socket to the validated IP) and the secret denylist
(`.env*`, `.npmrc`, `.git`, `secrets/`). Rationale: the host agent that authored
the note already reads files and hits the network with FAR fewer limits than the
sandbox, so the marginal risk of sanctioned in-sandbox egress is small, and
per-note user-approved egress was judged not worth the v1 friction. Per-note
egress approval remains the planned hardening if real-world misuse appears. Not a
regression; do not re-flag without new evidence of exploitation.

### A51. Content edits do not invalidate a smart-note's compiled check (correct — the check keys on the trigger, not the body)
An audit flagged that editing a smart note's `content` leaves its compiled check
stale. Verified a FALSE POSITIVE: the compiled check evaluates the
`surface_condition` (the trigger), never the note body. `updateNote` resets the
whole compiled-check lifecycle ONLY when `surface_condition` changes
(`smartConditionChanged` in `storage-notes.ts`), which is correct — a body edit
doesn't change what the check tests, so re-compiling would be wasted work.

### A52. Config loader trusts a PRESENT shared CortexKit config (legacy-read fallback is absent-only) — correct by construction
An audit flagged that `loadPluginConfigDetailed` only reads the running harness's
legacy config when the shared CortexKit base is **absent**, so a shared config
that is "present but conflicted" would be trusted (GC not suppressed) and could
drive a destructive embedding sweep under a cross-harness conflict. Traced as a
FALSE POSITIVE grounded in the migrator's invariant: a *present* shared config is
NEVER a conflicted merge. `migrateConfigFile` (`migrate-config-location.ts`)
**refuses on conflict** — when the OpenCode/Pi legacy pair differs, or a present
target differs from legacy, it returns `conflict: true` and writes **nothing**,
leaving the shared base absent → the absent-path legacy-read fallback handles it.
The migrator only ever writes the shared file from a single source (or matching
sources). So "shared present" means "the user's authoritative, conflict-free
config" — trusting it (and letting GC run against the model it names) is correct,
not a data-safety hole. The destructive-sweep scenario requires a conflicted
shared file to exist, which the migrator structurally never produces. If a user
hand-authors a shared config, that IS their authoritative intent by definition.

### A53. Dashboard embedding "Test Connection": token expansion + http/loopback/LAN allowed ONLY for user-scope; project-scope is refused at the backend
The dashboard `test_embedding_endpoint` probe (`embedding_probe.rs`) expands
`{env:}`/`{file:}` tokens and allows `http://` + loopback/LAN, because the two
most common legitimate setups need it: a `{file:~/...key}` api_key (the pattern
we document) and a self-hosted `http://localhost` embedding server. For
**user-level** config this is correct and safe: the values are the user's own,
and expanding them to test is exactly what the plugin does at runtime.

**CORRECTION (was a P0 I shipped, then fixed):** an earlier version of this entry
claimed the probe is "user-config-only" and therefore the relaxation was
unconditionally safe. That was WRONG. The config editor renders the SAME
`ConfigForm` (embedding fields + Test Connection) for **project** configs
(`ProjectConfigDetail`), so a malicious repo committing
`.cortexkit/magic-context.jsonc` with `api_key: "{env:GITHUB_TOKEN}"` + an
attacker endpoint could exfiltrate the secret on one Test Connection click. The
Oracle review of the v0.28 delta caught this.

**Enforced fix (the actual current behavior):**
- `test_embedding_endpoint` takes a `source` ("user" | "project"); anything but
  `"user"` is REFUSED before any token expansion or network call
  (`ScopeNotAllowed`). Absent source defaults to user for the single existing
  user-config caller. This is the backend trust boundary.
- The frontend hides the entire embedding column (provider/endpoint/api_key +
  Test Connection) for project scope and sends `source` explicitly. (Project
  embedding endpoint/provider are runtime-stripped anyway, so the column was also
  misleading there.)
- `{file:}` tokens are lexically normalized AND canonicalized before the
  sensitive-dir check, so `~/.config/../.ssh/id_rsa` and symlinks-into-credential
  dirs are blocked (P1).

Retained IP guards (cheap, no legit cost): cloud instance-metadata (IPv4
169.254.169.254 + AWS IPv6 `fd00:ec2::254`, incl. IPv4-mapped) always blocked;
IPv4/IPv6 link-local + unspecified blocked; URL userinfo (`user:pass@`) rejected;
DNS pinned via `resolve_to_addrs`. The user-scope relaxation mirrors `doctor`
(Node). Do not extend token expansion / endpoint contact to any non-user scope
without a new threat model.

## A54: ctx_search returns pending smart notes (accepted by design)

A release audit flagged that `ctx_search` matches smart notes whose surface
condition has not been met yet (`pending` status), reading this as a bypass of
the hidden-until-ready contract. Accepted as designed: hidden-until-ready
governs UNPROMPTED surfacing (the dreamer's evaluation loop deciding when to
inject a note), while `ctx_search` is explicit recall invoked by the same agent
that wrote the note ("did we park a follow-up about X?"). Hiding pending notes
from search would make parked work unfindable precisely when the agent asks for
it. Results carry `status=pending` so the caller can see the condition has not
fired. The same reasoning covers restricted children that carry `ctx_search`
(retrospective): notes are the same sensitivity class as project memories,
which those children already search.

## A55: the Anthropic-wire empty-sentinel capability is TS-mode only (Rust parity deferred)

`modelAcceptsEmptyContent` resolves the empty-sentinel capability from the
adapter OpenCode actually uses (`api.npm === "@ai-sdk/anthropic"`), so a custom
provider fronting Claude — a Bedrock or Vertex gateway under any provider id —
now gets the merged-reasoning strip that its wire requires. See
`hooks/magic-context/anthropic-wire.ts`.

The `mc-module` Rust transform decides the same fact from the provider id, in one
shared predicate — `request_accepts_empty_content`
(`crates/mc-module/src/transform.rs:13753`) — plus about eight inline
`provider_id != Some("anthropic")` comparisons in the neighbouring trailing-blank,
user-terminated-tail, and reasoning-cutoff lanes. Rust mode
(`transform_mode: "rust"`) therefore stays canonical-Anthropic only, and
`rust-mode-transform.ts` passes `modelAcceptsEmptyContent(providerID)` without a
model id on purpose: widening the host lane alone would let the two lanes
disagree about the served bytes, which is worse than the narrow gate.

The parity work is smaller than the comparison count suggests. The module already
folds this capability into its pass digest (`transform.rs:12229`), so it would
handle a change correctly once the resolved boolean rides `TransformRequest`
instead of being re-derived from `provider_id`.

Pi is unaffected. Pi resolves its own capability from `ctx.model.provider` and
never calls the OpenCode strip functions, so there is nothing to widen there
until Pi exposes a comparable adapter fact.

`resolveEmptySentinelCapability` resolves five states per pass. "Folds?" is whether
a change of this component alone can materialize m[0]:

| Pass state | Capability | Recorded as widened | Folds? |
|---|---|---|---|
| Registry resolved, canonical `anthropic` | on | no | never — component absent both sides |
| Registry resolved, custom provider on `@ai-sdk/anthropic` | on | yes | once, when it first differs |
| Registry resolved, any other adapter | off | no | never |
| Registry unresolved, live model matches the cached m[0] model | carried forward | carried forward | never — nothing changed |
| Registry unresolved, live model differs or is unobservable | off | no | never — `model_change` owns that fold |

Two operational consequences. A gateway added to `opencode.json` mid-session needs
an OpenCode restart, because the adapter snapshot is read once per process. And a
failed lookup does not narrow a session that already served widened bytes: it keeps
the carried answer until a retry succeeds, because narrowing would stop replaying
persisted merged-reasoning strips and reinstate the 400.

Closing the gap means carrying one resolved boolean in the transform request and
replacing the module's provider comparisons with it, plus Rust-side coverage. Do
not re-flag the TS/Rust asymmetry as a bug until that work is scheduled.
