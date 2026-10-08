# Fold/refresh writer critical sections

## Final decision after adversarial review

The render split from `9cbb1dff3076665ea43660400e0ed0bf08192fb4` is reverted.
Both OpenCode and Pi now read and render m[1] **inside the same `BEGIN IMMEDIATE`
transaction that persists it**, in both HARD folds and soft refreshes. m[0]
retains its original off-lock render and original marker stale check. The added
m[1] snapshot helpers and incomplete delta CASes are removed; no broader CAS,
new revision, schema migration or classification-triggered HARD bust is added.

The independent review was read from
`alfonso/task/bg_21ecce0dbbd1ef0e-adversarial-review-fold-and-soft-refresh-render-`,
path `docs/reports/fold-render-lock-review.md`. It demonstrated real sibling
writes that the split failed to validate: memory importance/reinforcement,
in-place recovered history ranges, indexed OpenCode heading dates, and Pi
expiry eligibility at the baseline cutoff. Extending the CAS to every renderer
input would be a substantial new consistency contract. The measurements did
not justify that risk: rendering accounted for only 6.5 ms of the original
46.8 ms OpenCode fold hold and 52.1 ms of the 314.7 ms refresh hold. The fixture
never reproduced the live 9.3-second hold. Scheduling/host pauses and SQLite
commit latency cannot be fixed by moving a small render across writer admission.

The retained changes are:

* Per-step, best-effort slow-write attribution, including the in-lock
  `m1Render`, `staleCheck`, `persistCachedM0`, `sessionMeta`, `onFoldCommit` and
  `commit`. Fold-only `pre_metadata` and `pre_onFoldPrepare` durations are
  explicitly outside the reported hold. The hold clock starts after writer
  admission, not before any contention wait; the production threshold is still
  one second.
* Legacy-tool wire traversal happens in `onFoldPrepare` before admission. Its
  returned callback receives the **locked** m[1] bytes, does the cheap prefix
  comparison, validates the exact prepared tag projection and writes modes only
  when the fold busts the prefix. Changed tag rows throw
  `MaterializeContentionError` and the existing bounded fold retry applies. The
  callback does not capture LKG or populate wire caches.
* `reason=unknown` is corrected without changing fold policy: a later pressure
  refold after a null SOFT preflight is logged as `drift`; Pi logs the actual
  injection's `m0Reason`; a genuine soft refresh is named `soft_refresh`.
* Each host's fold combines its adjacent memory-count/id and baseline-boundary
  updates into **one** `UPDATE session_meta`, preserving all resulting values.
  The large cached-pair update is still a separate step so its cost is attributed
  separately. Inspection confirmed that OpenCode's soft refresh already writes
  its bytes, boundary and manifest in **one statement**; Pi refresh similarly
  uses one statement. There were no redundant refresh statements to consolidate.
  The earlier 80.7 ms refresh-update sample is not evidence of several writes.

Review findings 5 and 6 (inherited visible-manifest omissions) remain untouched.
Neither host's rendered-id selection or manifest contents are changed. The
original off-lock m[0] limitations and any separate host-DB timestamp changes
are not claimed to be solved by serializing context-store m[1] reads.

## Reproduction and differential

`scripts/fold-lock-fixture.ts` creates two fresh disk-backed WAL stores, each
with 1,352 project memories (~700 characters each), 300 tiered compartments
(~4 KB P1 each), a 2 MiB mural data URL, and 1,200 dropped tool tags. Refresh adds
30 memories and three compartments; defer replays the persisted prefix. The
OpenCode fold executes the real legacy conversion preparation/persist path.
No live host store or configuration is opened. While each store is open, the
script runs `lsof -p <its own pid>`, requires every listed SQLite store to be
under its throwaway root, and prints the evidence.

The checked-in hashes were independently captured from
`77a73237bf2cd6c42fce93d27b98f6ca4af0e19e` with timing instrumentation only.
They were **not regenerated** for either refactor. The restored implementation
matches all six host/phase result hashes, all six complete `session_meta` hashes,
and all six ordered tag-manifest hashes in
`scripts/fold-lock-fixture-baseline.json`. Buffer serialization covers their
actual bytes, including both cached buffers and the frozen mural payload.

The driver additionally examines the actual image-bearing two-message prefix
for each host/phase. Its served m[0] and m[1] text and mural must equal the
persisted payload that is checked against the independent baseline. This closes
the old Pi driver limitation where its result-summary hash alone did not cover
the outgoing array. The actual complete refresh/defer prefix arrays must also
match. These additional checks leave the original golden hashes unchanged.

Run from the repository root, with a fresh root on each invocation:

```sh
mkdir -p "${TMPDIR:-/tmp/}magic-context"
root=$(mktemp -d "${TMPDIR:-/tmp/}magic-context/fold-lock-XXXXXXXX")
mkdir -p "$root"/{home,data,config,state,runtime,storage}
env HOME="$root/home" XDG_DATA_HOME="$root/data" \
  XDG_CONFIG_HOME="$root/config" XDG_STATE_HOME="$root/state" \
  XDG_RUNTIME_DIR="$root/runtime" OPENCODE_DB="$root/opencode-host.db" \
  MAGIC_CONTEXT_STORAGE_DIR="$root/storage" FOLD_FIXTURE_ROOT="$root" \
  NODE_ENV=development \
  bun --tsconfig-override packages/pi-plugin/tsconfig.json scripts/fold-lock-fixture.ts
```

Typecheck the driver with
`packages/plugin/node_modules/.bin/tsc -p scripts/tsconfig.fold-lock-fixture.json --noEmit`.
It always prints writer hold times, including sub-threshold transactions.

## Measured timings (milliseconds)

The table compares the original implementation to the final restored-lock
implementation, **not** the abandoned off-lock split. These are single runs on
a shared machine, with variable scheduling and fsync latency, not a throughput
or absolute-latency guarantee. For sub-threshold per-step measurement only, the
log threshold was temporarily zero in the worktree and then restored; the final
production constant remains one second.

| Site | Version | Held | m[1] render | Stale check | Persist m[0]+mural | session_meta | Fold commit | SQLite commit |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| OpenCode fold | original | 46.8 | 6.5 | 0.4 | 1.7 | 2.0 | 2.8 | 33.4 |
| OpenCode fold | final | 55.2 | 5.0 | 0.6 | 1.7 | 12.7 | 2.9 | 32.2 |
| OpenCode refresh | original | 314.7 | 52.1 | 4.2 | — | 80.7 | — | 177.8 |
| OpenCode refresh | final | 22.7 | 5.0 | 0.9 | — | 1.6 | — | 15.1 |
| Pi fold | original | 69.1 | 12.2 | 2.8 | 1.9 | 2.1 | — | 50.2 |
| Pi fold | final | 51.1 | 9.1 | 5.4 | 1.2 | 0.8 | — | 34.5 |
| Pi refresh | original | 26.1 | 5.5 | 1.2 | — | 2.1 | — | 17.3 |
| Pi refresh | final | 25.1 | 8.0 | 1.2 | — | 2.1 | — | 13.8 |

Final OpenCode fold preparation was 0.1 ms for metadata and 2.0 ms for tag/wire
preparation, both outside the hold. Pi metadata preparation was below 0.1 ms.
Neither defer acquired a writer. All final m[1] render times are inside the
reported hold. The large variation in refresh write/commit times reinforces
that these samples cannot establish a causal performance improvement, nor
attribute the live incident to rendering. The next live slow line will identify
which held step actually consumed time.

## Concurrency regressions and test-contract correction

The previous AST fences asserted rendering occurred *before* admission. They
now assert exactly one m[1] render between admission and commit in each host's
fold and refresh, while keeping wire preparation before admission. Their
contract is deliberately reversed as requested by the review follow-up, not
silently weakened.

The two-connection tests are also deliberately corrected to the original
writer-snapshot policy: an additive memory published before fold admission is
included in locked m[1] without an unnecessary retry, while a compartment
publication invalidates the off-lock m[0] snapshot and still retries. A memory
or compartment published before soft-refresh admission is included in the
locked refresh rather than causing a synthetic post-render rejection.

New real two-connection WAL regressions independently exercise:

* Importance, `last_seen_at` reinforcement and `verified_at` verification in both
  hosts. A budget admits one candidate. Before admission a sibling changes B's
  selection input; stored m[1] must contain B, not the old A selection, and must
  equal an independent render using the same frozen baseline.
* Both hosts' in-place recovery through the real `recoverUnresolvedCompartments`
  helper. The existing history revision advances without changing max sequence
  or end id; persisted headings must show recovered ordinals 3–4, not 1–2.
  Pi reads both its render compartments and advanced boundary under the writer,
  rather than using the pre-admission pass snapshot as render input.
* OpenCode null-to-indexed timestamp backfill through `recordIndexedMessageTime`.
  Persisted m[1] must contain the newly available `2025-01-01` date heading.
* The expiry boundary in both hosts, including the review's Pi counterexample:
  baseline cutoff 1000, publication at 2000 with expiry 2500, admission at 3000.
  The locked renderer still uses the baseline cutoff and includes the memory.

These tests assert the corrected persisted bytes, not the counterexample's stale
behavior, and instrument exactly one writer admission. The legacy-tag callback
retry and pressure-reason logging tests remain. No test for either inherited
manifest defect is inverted or repaired in this revision.

## Verification of the revised tree

Both suites used throwaway HOME, XDG/storage roots and TMPDIR, with `OPENCODE_DB`
unset. The final Pi package run passed 1,602 tests (3 skips). The final OpenCode
package run passed 7,279 tests (6 skips), but did **not** pass its full gate:
`readGitCommits (smoke) > returns empty array for a non-git directory without
throwing` timed out at 30 seconds, and the unchanged startup-map timing test
measured 237 ms against its 200 ms foreground bound. Both files passed all 12
checks when rerun together in isolation. An earlier broad run also timed out the
unchanged AFT warm-inventory fixture; its file and the classification guard
subsequently passed all 26 checks in isolation. No timeout or performance-bound
assertion was relaxed.

The first broad run correctly rejected the new test registrar being named as a
production `.test-support.ts` file. It was moved to the existing repository
convention of a `.test.ts` fixture module, without widening the production-source
guard. Both new regression adapters and that shared fixture are explicitly
included in the diagnostic driver's typecheck configuration. All new regression,
writer-fence, pressure-reason and tag-validation tests passed in the final broad
run. Mutation controls moved rendering outside the writer and demonstrated red
fences and stale candidate-A persistence; neutralizing tag validation also
reddened its production-callback retry test. Every mutation was restored before
verification and commit.
