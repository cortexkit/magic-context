# Byte-invisible OpenCode 2 host folds (prototype)

## Current design: process-local row cache

OpenCode 2 history hidden by a host compaction checkpoint is recovered through a
process-local row cache. This issue 632 implementation starts directly from master
and adds no migration or OC2 cache table; master's v95 schema and fence are unchanged. This section
supersedes the persisted-cache revisions and measurements below, which are retained
as historical investigation records.

Each plugin instance owns a per-session cache keyed by the OpenCode row id. It
stores immutable encoded strings and gives each draft freshly decoded copies,
including nested tool arguments, message metadata and native media assets. Id-less
system and tool carriers retain their owning row id outside the model payload.
No captured messages or queue-admission records are written to context.db or the
host store. The existing context.db baseline boundary is read to select a bounded
memory range; a pending shared HARD mutation widens it to retain raw history.

Restarting the plugin or host starts with an empty row cache. The first post-checkpoint pass reads the
missing host rows once and renders them through `v2/fold/restore.ts`; later passes
reuse memory until new ids, model/source changes or host revert/update signals
require a restore read. Visible same-id changes replace the stored native bytes.
Reverts invalidate the hidden range and remove rows absent from the host's current
projection. A cache error never interrupts an already servable transform: capture
is optional, and replay falls back to the read-only restore path.

Freshness follows the existing message-identity contract: incoming drafts and host
revert/update events are authoritative. Out-of-band direct database edits are
unsupported; there is no full-history polling to discover them. Queued idle folds,
mid-loop steer folds, row-type checkpoint/recent-context removal and suppression
of an optimization-only m[0] render remain intact. Automatic host folding remains
experimental and is enabled only with `MC_OC2_INVISIBLE_FOLD=1`.

See `docs/reports/issue-632-memory-cache.md` for regression disposition, mutation
controls, real-host byte comparisons, isolation evidence and final gate results.

## Historical revision after adversarial review (context v97)

This historical revision proposed storing captured host rows in context.db only. Tables are session-scoped and keyed by
host-store identity, session id and the authoritative admission/checkpoint id.
Every write uses BEGIN IMMEDIATE and compare-and-swap; provisional admissions are
independent records, never a shared replaceable pending slot. The flag stays opt-in.

### Raw-history recovery mechanism (proposed before implementation)

A served-output trim is not a raw-history deletion. Retain the native input rows,
including rows that the output trimmed, with their host sequence coordinates and
row stamps. On the bounded steady path, select only the range needed by the frozen
baseline/module boundary. Before a legitimate HARD rebuild or a changed coverage
boundary, widen that selection to the live required raw range; obtain any missing
native rows from the read-only host reader. Never use the previous served-id set
as permanent eligibility to omit a row. A raw-cache miss renders with the host
representation contract and is compared against an independent no-cut control.

Hidden-row identity/stamp checks run before replay. OpenCode's row stamps expose
sequence, id and time_updated (not a global history revision). The revised lane
also hashes the raw JSON without schema-decoding it: same-size/same-ms updates
cannot cancel out or masquerade as an unchanged row. This is a stronger fence
than the old restoration cache's updated-time/data-size pair. A missing
or changed row invalidates its cached representation. Recover current store rows
and flag source divergence for the ordinary shared rebuild permission, rather
than sending an obsolete cached tail on a defer. No off-wire materializeM0 call
is added. Id-less systems/results are associated with source sequences, never
with a preceding message-id watermark.

Review fixtures will use real context.db-backed state and explicit source-store
identities/readers. Assertions and expected contents remain unchanged; their DB
readouts test the same deletion/ownership facts more strictly than file listings.

Revision status: the accepted review's 17 specifications/controls are green with
unchanged expected values. Context v97, schema/deletion and agent-move inventory
checks pass. Fresh rich-history byte-identity matrices on 2.0.22 and 2.0.24 pass
all three conditions (24 complete-body comparisons total). See
`docs/reports/oc2-host-fold-revision.md` for every fixture/readout adaptation,
commands, new capture roots and explicitly skipped rollout/performance gates.

Revision work order: persistence/migration and inventory; sequence/full-source
replay and media/integrity; transactional admission; review contracts and real-host
matrix. The original measurements below remain historical prototype evidence.

## Contract and work plan

A host checkpoint is a storage/read-window optimization, **not** a Magic Context
HARD fold. It must not materialize m[0], adopt m[1], drain pending operations or
freeze a new strip. The ordinary transform retains the single bust permission.
The comparison is the full raw provider body from two executions of the same
private state, one with a host cut and one without; comparing consecutive calls
with new conversation rows would not be a byte-identity proof.

Work order:
1. Capture the current idle/queue, tool-loop/steer and restart differences on real
   2.0.22 and 2.0.24 hosts.
2. Prototype native-rendered message replay, structural checkpoint removal and
    restart recovery; retain the module's own boundary in Rust mode.
3. Add idempotent queue admission only where the preservation preconditions hold.
4. Run raw-body counterfactual tests and measure the remaining host cost.

No live stores may be opened, even read-only. Runs use private HOME and all XDG
roots under `$TMPDIR/magic-context/oc2-host-fold/`, a private OPENCODE_DB and
MAGIC_CONTEXT_STORAGE_DIR, with lsof evidence for every host incarnation. Magic
Context remains a read-only consumer of OpenCode tables. Fixtures must be made by
host APIs, not SQL writes; no migration or migration-marker manipulation.

## Starting observation

The previous verification is `docs/reports/issue-632-oc2-host-history.md`.
The current adapter has three independent sources of visible rewrite:

* `FoldOwner.supply` invokes `materializeM0` in the compaction hook, changing the
  persisted transform baseline off-wire.
* Hidden native rows are re-rendered with `restoreRow`; this is not necessarily
  the native renderer's original representation (including provider bindings,
  attachments and id-less result/system carriers).
* After the shared transform, the adapter replaces m[0] with a host checkpoint
  wrapper and leaves the host's `<recent-context>` block in that wrapper.

The host supplies no cut point, no decline and no effective `recent` override.
`session.compact({sessionID,id,delivery:"queue"})` is native admission, not completion;
`steer` may land within a tool loop. A row threshold alone never authorizes a
provider-visible rewrite. A checkpoint must be recognized by its store row type,
completed status and local kind, matched to its draft id, never by delimiter text.

## Implementation and measurements

The prototype below is **opt-in**, via `MC_OC2_INVISIBLE_FOLD=1`. It changes no
configuration schema or production default. Inside that lane,
`MC_OC2_HOST_FOLD_ROWS` defaults to **1,000**; `0` disables dispatch while retaining
manual native-fold replay. This is a proof prototype for adversarial review, not a
claim of universal cache safety for every host/plugin feature combination.

### What changed on the wire before the prototype

Exact hosts: **2.0.22 and 2.0.24**, Bun **1.4.2**. A saved copy of the base
checkout's built `dist/v2` supplied the baseline, not a separately downloaded Magic
Context release. Both hosts used the same local OpenAI Responses mock. The fixture
contains successful registered tool loops, an actual built-in `read` error, a user
PNG attachment, provider-bound reasoning and user-owned `<recent-context>` text.
Historian, dreamer, memory, embeddings and temporal awareness are disabled;
`cache_ttl: "never"` deliberately denies the optimization any expiry permission.

Each comparison restores an offline snapshot of **private** state to the same
paths. One execution has no new host cut, the other has the cut, with identical
prompts, tool outputs and model-call scripts. The test compares the complete raw
provider **JSON entity body**, not a renderer-derived expectation, normalized
message IDs, a hash of m[0] alone, or consecutive requests containing different
conversation turns. HTTP transport headers/connection bytes and provider billing
are not asserted. All non-input request settings are included in the body check.

| Baseline condition, both hosts | First-body difference | Following three model calls |
|---|---|---|
| Idle native `queue` | +325 UTF-8 bytes | Same +325-byte difference |
| Native `steer` admitted inside the first successful tool | No difference on call 1 | +398 bytes on calls 2–4 |
| Native cut, host restart, then prompt | +325 bytes | Same +325-byte difference |

The structural diff finds **only `input[0].content[0].text` different** in these
fixtures. Exhaustive sources/observations:

* **Checkpoint wrapper:** `context.ts` replaces synthetic m[0] with the host's
  `<conversation-checkpoint>` message after the ordinary transform. The fixed
  historical-context preface and `<summary>` delimiters are new wire bytes.
* **Recent block:** the host's `to-llm-message.ts:303–321` adds the separately
  serialized recent exchange. The idle/restart fixture's newest exchange differs
  from the active tool-loop exchange, explaining the different overhead. The
  compaction result cannot override `recent`; no invented field is used here.
* **m[0]/m[1]:** m[0]'s actual summary text is unchanged in the small fixture;
  m[1]'s placeholder is identical. Nevertheless the old compaction hook calls
  `materializeM0`, so it can change/re-tier a nonempty baseline and its clock.
  That is an independent *code-level* rewrite source, not an additional measured
  text difference in this fixture. The prototype removes that off-wire render.
* **Native rows versus restored rows:** successful tools, the error's text/status,
  user media and reasoning bindings match the native rendering in this baseline
  fixture. No additional body differences were hidden by the comparison.
* **Tags, tool pairing, metadata, settings:** no additional measured differences.
  Draft m[0]'s id changes from the synthetic head id to the checkpoint id, but the
  provider's user-message encoding does not send that id. A non-text m[0] part can
  also be moved into m[1] by the old wrapper substitution; an m[0] mural was not
  tested and must not be inferred from the user-attachment test.

### Replay prototype

`fold/native-replay.ts` retains an ordered native-rendered tail, selected and
merged by message id. ID-less tool-result carriers remain next to their assistant;
ID-less system updates remain in order. It caches the **pre-transform native
representation used by a served pass**, not a second historian projection or a
fully serialized HTTP request. The shared transform then replays its existing
frozen m[0]/m[1], tag/drop/strip state over the same representation. Only ids that
survive the served output are retained. In-memory session caches are bounded to
16 entries.

The final prototype persists those native representations and the already-served
m[0] text under `MAGIC_CONTEXT_STORAGE_DIR/oc2-native-fold/`. Atomic JSON replacement,
700 directories and 600 files avoid a database migration. Keys are SHA-256 filenames
and cannot escape the directory. Neither snapshots nor automatic nominations use
OpenCode KV: **the prototype writes no OpenCode table**. OpenCode's store reader
remains read-only; the supported `session.compact` API lets the host write its own
checkpoint.

A fold stages a provisional snapshot **before** answering the hook. A completed
local checkpoint binds its actual sequence/id and promotes the staged snapshot.
The previous completed snapshot stays usable if a later cut fails, even if a
second admission comes before the first primary replay. Promotion retires the
provisional record with a version-zero tombstone. Summary and snapshot-digest
mismatches refuse rather than silently passing a changed prompt. No sequence is
predicted, and no host row is edited.

The local-kind discriminator is the exact host structural contract:
`type === "compaction"`, `data.status === "completed"`, and absent
`data.providerContext`. The checkpoint draft id must match the stored row. No
string scanning/deletion of checkpoint, summary or recent delimiters occurs. For
an owned fold, restore the saved native tail, remove **that entire checkpoint
message**, and run the ordinary transform. Do not call `FoldOwner.observe`'s HARD
callback and do not run the old post-transform m[0]-to-checkpoint substitution.
Thus the outgoing m[0]/m[1] shape remains the original shape, and literal user
checkpoint/recent text is untouched. Unknown/preexisting/provider checkpoints
retain the legacy path; the prototype does not silently adopt them while warm.

**A real cache miss exists even without a restart.** The compaction hook receives
only the *before-split* messages, not the recent exchange. Also, the latest model
response has not yet appeared in a primary context callback. The first attempt to
cache only `draft.messages` lost that exchange; the counterfactual went red. The
final implementation starts from the persisted native tail's last anchor and
reads/render only unseen rows after it with `restoreRow`. For a primary replay
of an owned checkpoint, hidden rows come from the snapshot without decoding the
store range. Metadata/usage/boundary checks still read the store; this is **not** a
claim of zero SQL on a normal pass.

The measured store-rendered miss (terminal response and the just-completed
mid-turn tool row) matches the native host body on both versions. A general
store-rendered fallback for all host row kinds is **not** proven. Cached media is
rebuilt through the host's own Asset class; unknown media sources fail closed,
never change into a note in a proven owned replay. A full final served-request
snapshot would be a stronger recovery source for LKG/error/retry paths than this
pre-transform representation plus frozen transform state. That remains an
adversarial-review target.

### Trigger and lifecycle

`fold/policy.ts` nominates after a successfully served primary session reports
`session.execution.succeeded`. It requires a served native baseline, counts stored
projection rows after the latest completed checkpoint (not tags/model messages),
and capability-checks `session.compact`. Threshold **1,000** is proposed from the
previous 1k/5k/25k scaling measurements and the new equal-body 25k control below:
fold before the linear scan reaches the multi-second range, rather than wait for
provider-cache expiry. Counting uses one `COUNT(*)` query at idle, not a full
history fetch on every model step.

Dispatch is `session.compact({sessionID, id, delivery: "queue"})`. The `msg_` id
is deterministic from session, last-checkpoint sequence and persisted retry
attempt; wall clocks do not participate. One in-process attempt per session is
allowed, and a pending durable nomination reuses its id after restart. The host's
already-pending result is accepted/coalesced, not interpreted as completion. Await
native settlement and require a strictly newer completed checkpoint. On failure,
persist a failed attempt and retry on a later successful idle with a new
attempt-derived id. Persistence failures log and do not become unhandled detached
rejections. Restart after completion reconciles a stale pending nomination; an
interrupted/failed nomination with no new cut is reconciled on the next admission
attempt before a later retry. There is no tight retry timer.

Each automatic attempt emits one line with true stored rows before/after, duration,
id, `reason=row_threshold` and completed/failed status. Admission alone never logs
success. Failure without a completed row says `rows_after=unknown`. The real-host
automatic control uses threshold 10, observes exactly one queue fold, one completion
line and **zero extra provider calls**. The production proposal remains 1,000;
threshold 10 is only a small deterministic test fixture.

`steer` is byte-invisible in the proven tool-loop controls. Still retain `queue`:
the step that absorbs a fold can pay seconds of host work, even if it pays no cache
rewrite. Queue prevents that latency from interrupting a user's active tool loop.
Its cost is bounded-history work being postponed until idle. There is no cache-TTL
lease or new bust permission: the host cut does not create a priced mutation, and
ordinary transform work keeps the one existing mutation gate.

### Real-host proof and 25k-row timing

Final named gate:
`real OC2 host folds preserve the full provider body for queue, steer and restart`.
Both versions pass all **12 complete-body comparisons per fixture**, with no
normalization, for both a small rich-history fixture and a ~25k-row fixture.
`queue` and restart compare all four calls; `steer` additionally verifies the actual
completed checkpoint id between calls 1 and 2. All registered tool executions are
successful; a deliberately missing built-in read is separately checked as a real
error, not an unavailable-tool stand-in. Small final bodies are 42,896–43,529 bytes
on .22 and 42,903–43,536 on .24. Large bodies are 163,922–164,564 and
164,337–164,979 respectively. Every paired body's raw bytes are equal.

The large histories were generated exclusively by **25,000 native synthetic
admissions inside a registered tool**, not writes to OpenCode projection tables.
The stopped host's Magic Context database received one fixture compartment covering
all but approximately 500 raw rows, then a primary pass primed the baseline. Thus
wire size is held equal across the host cut. Printed pre-prime row counts are
25,034 / 25,030; normal priming/comparison turns add a few more rows. This is a
synthetic-heavy native fixture, not a migrated V1/tool-heavy workload. The earlier
report is the stronger characterization of mixed row populations.

The .24 fresh seeding run exceeded its 600-second setup deadline after all 25k
rows had been projected; its first cold tagging phase alone took 473 seconds on
this shared machine. That is **not** a reported steady-step timing. The retained
private fixture was resumed, interrupted through the host API, given its fixture
compartment while stopped, and primed before the final successful matrix. No SQL
repair of OpenCode rows, migration or cross-version store reuse was performed.

“Step” is prior mock-response completion to receipt of the next request. “Host
residual” subtracts the timed Magic Context callback from that interval: it still
includes tool/mock/instrumentation overhead, not isolated host CPU. Each median is
three continuations of one controlled four-call turn. Independent medians are not
necessarily additive; do not generalize absolute numbers on this shared machine.

| Host / condition | Step median before → after, ms | Host residual median before → after, ms | After-step range, ms |
|---|---:|---:|---:|
| .22 queue | 3,611 → 432 | 521 → 190 | 422–490 |
| .22 steer | 2,736 → 659 | 460 → 350 | 657–3,869 |
| .22 restart | 3,199 → 523 | 787 → 174 | 448–571 |
| .24 queue | 2,184 → 292 | 424 → 95 | 225–389 |
| .24 steer | 1,628 → 275 | 246 → 99 | 266–699 |
| .24 restart | 1,286 → 309 | 274 → 134 | 282–395 |

The .22 steer transition itself costs 3,869 ms (host residual 3,262); its next two
steps are 659/657 ms. This is exactly why queue is useful despite wire invisibility.
The host window after a measured queue/restart turn is seven rows; after the
steered turn it is four. The checkpoint bounds future reads; it does not delete
old database history. Plugin time also improves because the raw array reaching
it is bounded and hidden content comes from the retained native snapshot.

### Other modes and remaining review targets

* **OpenCode 1 and Pi/OMP:** no changes. Their existing native marker/first-kept-entry
  carriers already bound the host window; no OC2 API policy belongs there.
* **Rust on OpenCode 2:** not exempt from host loading/conversion. The prototype
  caches/restores the native array **after `trimToRecordedBoundary`**, keeps the
  module's boundary message and persists its served m[0] text. It never materializes
  a second TS baseline for a known module baseline. The new unit contract combines
  marker coverage, native replay, restart and a second boundary trim, proving the
  module's input array and baseline stay identical. The existing partial/gap guards
  remain intact. **No real Rust-engine provider-byte or performance run is claimed.**
* Before enabling by default: real module-engine coverage; eligible pending-op and
  historian publication controls; LKG/generate/retry paths; m[0] mural and unusual
  media/provider-native checkpoints; hidden-row edits/reverts; safe activation on
  an already-warm legacy checkpoint; and stronger persisted final-served-prefix
  validation. Filesystem snapshots are a prototype representation, not a completed
  retention/GC policy. These are review targets, not properties silently inferred
  from the current passing fixtures.

### Reproduction, evidence and gates

Run the built plugin through the named gate (no package-test `OPENCODE_DB` export):

```sh
HOME="$PRIVATE_TEST_HOME" bun test packages/e2e-tests/tests/opencode2/host-fold-byte-identity.test.ts --timeout 900000
HOME="$PRIVATE_TEST_HOME" MC_E2E_FOLD_ROWS=25000 bun test packages/e2e-tests/tests/opencode2/host-fold-byte-identity.test.ts --timeout 900000
```

Set `MC_E2E_OPENCODE2_CLI` to the exact installed .24 binary for that matrix.
`MC_E2E_FOLD_BASELINE_PLUGIN` points the probe at a saved base `dist/v2` directory
for the pre-prototype control. For an already-projected private failed setup only,
`MC_E2E_FOLD_RESUME_ROOT` selects an existing `capture-*` under this probe's task root;
it reuses the same host version and native rows, never patches them. Do not copy
just the serve command into an ambient environment.

All evidence is retained under this root:
`/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/oc2-host-fold/`.

| Capture directory | Meaning |
|---|---|
| `capture-1791403033760` | .22 rich-history baseline |
| `capture-1791403086069` | .24 rich-history baseline |
| `capture-1791403716144` | final .22 rich-history proof + automatic fold |
| `capture-1791405714208` | final .24 rich-history proof + automatic fold |
| `capture-1791403775083` | final .22 native 25k proof/timing + automatic fold |
| `capture-1791404337233` | .24 native 25k setup, then resumed final proof/timing + automatic fold |

Each successful matrix has raw `{queue,steer,restart}-{before,after}-{0..3}.json`,
`results.json`, timed `work/trace.jsonl`, private configs/stores and per-incarnation
lsof inventories. Every host is allowlisted under private HOME/TMPDIR/XDG roots;
`inspectOpenFiles` samples its lsof descriptors before/after execution and rejects
outside database/config paths. The prototype creates no OpenCode SQL fixture
writes, no V1 tables and no migration-marker operation. A short-lived tool-plane
outage during the long setup recovered; no result depends on a detached unobserved
host command.

Verification: package typecheck and full plugin build pass; targeted replay/policy,
module-boundary, payload/error and restore suites pass; own-file snapshot tests
prove reopening and private permissions; both real-host named matrices pass.
The whole E2E tsconfig has unrelated baseline failures; a scoped configuration
including the new probe and named test passes TypeScript 5.9.3. Scoped Biome 2.5.1
checks are used because package-root configuration is required. Three silent
fences also have staged, safely restored mutation controls: neutralizing the local
provider-context discriminator reddens only its named structural test; neutralizing
owned-summary integrity reddens only the named tamper-refusal test; neutralizing
the saved-byte digest reddens only the persisted-corruption test (other tests were
filtered out). Final restored tests pass. No manifests or lockfiles changed.
