# Issue 632: master-only memory cache port

## Decision and implementation

This delivery starts directly at `origin/master` =
`d55b44bcc713fe69f28ab98fe3396a7b74a4cf17`, on
`alfonso/task/bg_39d03984b017eb78-issue-632-master-only`. The earlier delivery
`1be35dbb135ccd37fde2d05bb922cf56d9d4cf3e` was not suitable for master because
its ancestry included context schema v96, durable LKG certification and agent-move
changes awaiting the coordinated restart window. No commit from that ancestry is merged
or cherry-picked here. Only the issue 632 files and review specifications were
ported as source changes onto the fresh master base.

* This port introduces **no migration and no new table**. Master's schema and
  fence remain **v95**, and its LKG, agent-move, Rust code and lockfiles are untouched.
  Master has no `snapshot-storage.ts`, so no deletion of that file is required.
  The old v97-only tests and installers are not present on this branch.
* Existing boundary-test database cleanup retains master's own API call. The
  obsolete full-JSON `replayRowStamps` polling method is not ported; current replay
  uses incoming drafts and host change signals instead.
* `NativeFoldCache` owns per-session maps keyed by the OpenCode row id. Its values
  contain immutable encoded strings. Cache accessors return record copies; replay
  revives fresh message, metadata, argument and media objects for each draft.
  Id-less system and tool carriers retain their owning row id outside the payload.
* A new plugin instance has an empty cache. Its first post-checkpoint restoration
  reads the missing span once through the read-only reader and `fold/restore.ts`.
  Subsequent warm restores do not read host rows. A new id may require coordinate
  metadata or newly stored rows; the existing usage/boundary reads elsewhere in
  the plugin are not claimed to disappear.
* Incoming same-id assistant changes replace their cached bytes. Host revert
  events invalidate the hidden span; reloading that span replaces its membership
  rather than merely upserting, so removed rows cannot return. Reader identity is
  pinned to its acquired connection, not recomputed from a replaced pathname.
* Optional capture cannot reject a transformed, servable turn. A replay cache
  failure falls back to the authoritative restore read. A native asset without a
  lossless replay codec inhibits automatic nomination, not the current turn.
* Queue-at-idle admission, mid-loop steer handling, structural checkpoint and
  recent-context removal, and the absence of an optimization-only m[0] render
  remain. The flag remains opt-in; no default-on or new configuration decision
  was made.

### Freshness boundary

The existing message-identity contract (issue 578) says a message id names one
message for its session lifetime. The incoming draft provides the current content
of an in-progress assistant, and host revert/update events notify the plugin when
previously retained history changes. **Out-of-band direct
database edits are unsupported.** Polling all hidden raw JSON on every pass would
contradict the required zero-read warm-cache path. Completed-message content updates
are replay-only on the tested OC2 schema, not a public user-row editing signal.
Accordingly, direct hidden-user SQL edit fixtures are explicitly unsupported, not
reported as passing freshness proofs. Supported newest-assistant edits and actual
tail reverts have separate positive regressions.

## Disposition of every review regression

The exact test names from the first adversarial review (0eec7b34) and second review
(d186fdbd) are retained so their regression specifications remain searchable. “Inapplicable”
means the named persisted-cache surface no longer exists; “unsupported” means the
fixture performs an unobservable direct database edit outside the host contract.
No expected conversation was reversed to bless a stale replay.

### First review: 13 originally failing tests

| Exact test name | Disposition |
|---|---|
| `review: a trailing id-less system update is replayed exactly once` | Pass; the id-less system message is associated with its source row, so it is replayed once. |
| `review: a HARD fold after deleting a compartment recovers the same raw history with or without a host cut` | Pass; raw input remains recoverable independently of the previously served ids. |
| `review: an unbound pending snapshot does not adopt another local checkpoint` | Pass; checks absence of admission ownership. A local checkpoint can still restore authoritative raw rows without claiming nomination ownership. |
| `review: corruption of the persisted tail cannot be blessed by a new snapshot digest` | Inapplicable; no file/table persists captured messages. |
| `review: two processes cannot overwrite the sole recovery record of an admitted cut` | Inapplicable; independent plugin instances do not share a recovery record. Cold restart recovery is independently tested. |
| `review: a native bytes-backed attachment remains replayable after a cut` | Pass; real OC2 Asset codec and JSON equality retained. |
| `review: replay retains native media provider bindings and info` | Pass; native options and provider bindings retained. |
| `review: the same session id in a different host store cannot inherit another host's bytes` | Pass; independent memory caches cannot inherit another instance's captured bytes. |
| `review: session deletion forgets durable native conversation bytes` | Pass for the remaining memory state; no durable native bytes exist to leave behind. |
| `review: capture freezes message-level metadata as well as content` | Pass; original binding remains after caller mutation. |
| `review: a hidden row edit is not silently replayed from obsolete bytes` | Unsupported fixture: direct hidden-user database editing has no public host update signal. Incoming newest-assistant replacement is tested separately. |
| `review: a foreign provider checkpoint does not settle an owned automatic nomination` | Pass; local checkpoint kind, returned id and supplied summary are checked. |
| `review: two policy instances log one settled nomination rather than two completions` | Pass for the shared in-process admission map; cross-process durable leases no longer exist. |

### Second review: seven originally failing tests

| Exact test name | Disposition |
|---|---|
| `re-review: a busy fold capture after successful transform never interrupts that turn` | Pass through the real registered context hook: transform produced m[0], the separate SQLite handle acquired its writer, capture completed, zero interrupts. |
| `re-review: busy optional capture does not reject an already servable draft` | Pass with the real second-handle writer lock; capture makes no cache database write. |
| `re-review: a hidden edit between capture and admission cannot be blessed by fresh stamps` | Unsupported fixture: direct hidden-user SQL editing has no public host update signal. There are no persisted admission stamps to bless it, and no polling is claimed. |
| `re-review: reverting a hidden row stays reverted on the second replay` | Pass. Fixture orders the removed row as the tail, emits `session.revert.committed`, and checks another warm replay and an empty-cache restart against the same remaining user. |
| `re-review: another capture cannot replace an admitted cut's native bytes` | Pass with independent plugin-instance caches, even when both use the same context database. No shared persisted row references remain. |
| `re-review: an open reader's identity cannot switch to a replacement file` | Pass with actual old and replacement read leases. |
| `re-review: bounded replay does not load covered raw cache blobs` | Pass; the cache accessor receives the frozen boundary before decoding any native row strings. |

Additional historical controls for persisted corruption, durable pending ids,
owner leases, and promotion/tombstones are explicitly skipped with reasons.
The historical control for repairing v97 cache-table columns is not ported because
master has neither that migration nor those tables. The equal-time /
equal-size hidden SQL edit control is unsupported for the same public-signal reason.
Native checkpoint recognition still excludes provider-owned checkpoints and leaves
literal user `<recent-context>` delimiters alone. Historical names referring to
“files” do not establish a file-backed cache or an eviction policy.

The restart regression `restart restores byte-identical native history once and
hot passes perform no restore reads` creates a fresh cache and asserts exactly one
restore-span read, unchanged JSON bytes, defensive replay copies and no additional
reads on later passes. The counter measures one request to restore the complete missing row range. That
range can use multiple SQL pages; the test does not claim one physical SQL query.

## Mutation controls

All mutations used the staged live implementation, recorded a non-empty working
diff, and were restored with `git checkout -- <path> && touch <path>` followed by
an empty working diff. No deliberate mutant remains in source.

| Deliberate mutation in `fold/native-replay.ts` | Exact test that failed | Unaffected selected control |
|---|---|---|
| Force every restore through the cold range read | `restart restores byte-identical native history once and hot passes perform no restore reads` (expected 1 read, received 3) | `native checkpoint recognition is structural and leaves literal user delimiters alone` |
| Return caller-owned input objects instead of detached copies | `native input copies detach nested tool arguments and message metadata before later passes` (binding became `changed`) | Same checkpoint-recognition control |
| Ignore host revert notifications | `a host revert truncates the memory tail and never revives it on later passes` (removed tail returned) | Same checkpoint-recognition control |

Each selected run had **one named failure and one passing control**, Bun 1.4.2.

## Master-only verification and real-host rerun

The following records are from the fresh master-only branch, not the earlier
migration-train delivery. The complete allowed-path inventory and forbidden-path
hash checks are retained under the evidence root.

### Port fence and exact file list

`git diff d55b44bc HEAD` is restricted to the following 18 paths. No migration,
fence, LKG, agent-move, Rust or lockfile path is changed. Independent Git blob hashes
match master for the migration runner, storage fence, Rust transform, Pi LKG,
move inventory, both lockfiles, ARCHITECTURE.md and STRUCTURE.md. The migration-only
`lkg-served-marker.ts` and `move-inputs.ts` are absent on both master and this branch.
The machine-readable list and hash evidence are in `master-only/scope-proof.json`.

```
docs/designs/oc2-host-fold.md
docs/reports/issue-632-memory-cache.md
packages/plugin/src/v2/fold/boundary.test.ts
packages/plugin/src/v2/fold/host-media.ts
packages/plugin/src/v2/fold/memory-cache.ts
packages/plugin/src/v2/fold/mutation-review.test.ts
packages/plugin/src/v2/fold/native-codec.ts
packages/plugin/src/v2/fold/native-replay-review.test.ts
packages/plugin/src/v2/fold/native-replay.test.ts
packages/plugin/src/v2/fold/native-replay.ts
packages/plugin/src/v2/fold/policy-review.test.ts
packages/plugin/src/v2/fold/policy.test.ts
packages/plugin/src/v2/fold/policy.ts
packages/plugin/src/v2/fold/re-review.test.ts
packages/plugin/src/v2/hooks/context.ts
packages/plugin/src/v2/hooks/fold-contention-review.test.ts
packages/plugin/src/v2/hooks/types.ts
packages/plugin/src/v2/store-reader.ts
```

### Linux gates on the fresh branch

All requested Linux commands ran in the background and were awaited with
`bash_watch`; none fell back to macOS.

* Fold tests plus the actual hook-contention and registered-root-policy tests:
  **72 pass, 10 reasoned skips, 0 fail; 82 tests / 12 files**, Bun 1.4.2.
  The empty-cache restart test asserts byte-identical output and one restore-span
  read, then no further reads on warm passes.
* `bun run typecheck`: pass, TypeScript 5.9.3; plugin, Pi, CLI and retina packages.
* `bun run lint`: pass, Biome 2.5.1; **1,326 + 277 + 137 + 6 files**, no errors;
  existing warnings/info remain.
* `bun run build`: pass on Linux. A separate local plugin build produced the
  actual union/V2 bundle executed by the macOS native host.
* Full plugin suite with `OPENCODE_DB` unset and throwaway HOME/XDG roots:
  **7,486 pass, 19 skip, 33 fail; 7,538 tests / 745 files**.
* Pristine fetched-master baseline, built before testing with the same toolchain,
  lock-identical prepared dependencies and isolated roots:
  **7,447 pass, 9 skip, 37 fail; 7,493 tests / 738 files**.
  The package's frozen install checked 1,010 installs across 1,251 packages without
  changes. **All 33 port failures match master by exact test name; zero port-only
  failures.** Four additional baseline-only failures concern frame attribution,
  JSC profiling, a slow-embedding deadline, and writer-wait timing. The suite is
  not claimed wholly green. The exact name sets are retained in
  `master-only/gates/failure-name-comparison.json`.

The three mutation controls in the table above were rerun on this master-only
branch. Each produced the named single failure and a passing checkpoint-recognition
control; each was restored from the staged live state and left an empty working diff.

### OpenCode 2.0.24 rerun, including restart

The native binary separately reported `opencode v2.0.24`. The probe code was copied
from the earlier fixture into the throwaway evidence root with imports redirected
to this worktree; no e2e or manifest file was added to the port. It used the newly
built master-only plugin bundle, `MC_OC2_INVISIBLE_FOLD=1`,
`MC_E2E_FOLD_ROWS=25000`, and `MC_E2E_FOLD_EXPECT_IDENTITY=1`.

The host generated **25,034 stored rows** through `session.synthetic`, not projection
SQL. A compartment covered 24,527 raw rows and kept roughly 500 tail messages.
Rich history included an errored tool result, a PNG Asset, reasoning bindings and
a literal user recent-context block. Three counterfactuals used the same cloned,
stopped-host private state: idle queue, mid-loop steer and queued fold followed by
restart. **All 12 complete raw provider-body comparisons passed**, four per scenario,
without normalizing ids or deriving expected bytes from the replay renderer. The
restart comparisons used a new process with an empty row cache. Automatic threshold
folding also completed once with zero fold provider requests and one settled log.

Time between successive model calls, from previous mock-response completion to receipt of
next provider request, with the median over three continuations:

| Scenario | Before, ms (median) | After, ms (median) |
|---|---|---|
| idle queue | 822, 879, 802 (822) | 168, 153, 155 (155) |
| mid-loop steer | 914, 1111, 940 (940) | 339, 241, 157 (241) |
| restart | 945, 949, 841 (945) | 172, 175, 177 (175) |

Requests were 164,249–164,891 bytes, not the historical approximately 0.75 MB fixture.
The first post-restart plugin callback took 372 ms; fixture seeding took 142 s.
These are mock-provider host/plugin measurements on a shared macOS machine, not
model/network latency or a claim to reproduce earlier absolute timings.

Every driver/host root was disposable: HOME, all XDG roots, TMPDIR,
CFFIXED_USER_HOME, the OPENCODE_DB selection and MAGIC_CONTEXT_STORAGE_DIR. The
runner requires `OPENCODE_DB=opencode2.db`, physically under each capture's private
`XDG_DATA_HOME/opencode/`. **Ten host PID lsof inventories contain only private
`.db`/WAL/SHM paths**; the runner checks paths at shutdown as well. An independent
saved-file validator rechecked all 12 raw-body pairs and all ten inventories.
A read-only inspection of the real-host context database confirmed **v95 and zero
OC2 cache tables**. No live store/config was opened, no OpenCode projection was
written by Magic Context, and no migration marker was manipulated.

Evidence is kept outside target, dist and dependency-cache directories so build
cleanup cannot remove it:

* Root: `/tmp/magic-context/bg_39d03984b017eb78/master-only/`
* Native captures: `host24/tmp/magic-context/oc2-host-fold/capture-1791573907983/`
* Private probe: `host-fold-probe.ts`
* Independent body/lsof validation: `host-proof-summary.json`
* Allowed 18-file diff and unchanged protected master blob hashes: `scope-proof.json`
* Linux logs and exact baseline comparison: `gates/`
