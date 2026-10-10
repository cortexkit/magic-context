# Master / agent-move merge

Parents: migration `325b5769edcaf9a4638ce6c4ef1715af19e65ee8` and master
`691725deaa173eb4ddd2d9474efe554f96056d3e` (0.47.0).

## Conflict resolutions, line by line

The ranges below identify the original conflict regions, before removal of the
markers. Shared arguments and surrounding logic remain unchanged.

| File / original hunk | Resolved lines and their intent |
| --- | --- |
| `packages/pi-plugin/src/context-handler.ts`, 4427–4431 | `certify: !lkgCompactionOff` retains migration's move certification policy; `assertCurrentPass: budget.assertOutcome` retains master's deadline/ownership check on synchronous and deferred LKG publication. Both arguments are passed to the same capture. |
| `packages/pi-plugin/src/context-handler.ts`, 4479–4484 | `budget.assertOutcome()` and `publishTransformDecision?.()` retain master's completed-pass diagnostic publication; `options.onPostprocess?.({ bustedThisPass: result.bustedThisPass })` retains migration's signed-thinking observer. The observer runs after successful mandatory publication; the guarded context wrapper still checks the outcome budget before issuing a dispatch receipt. |
| `packages/pi-plugin/src/pi-lkg.ts`, serialization error catch | `args.assertCurrentPass?.()` is master's ownership/deadline fence, before any invalidation. `dropSlot(snapshot.sessionId, "lkg_snapshot_serialize_failed", args.certify !== false)` retains migration's third argument: an uncertified/native-compaction capture must not rewrite move certification. The pre-existing rerere result was inspected against all three Git stages and independently reproduced conflict text; it already combines these intents. |
| `packages/plugin/src/plugin/messages-transform.ts`, 513–545 | `provider` and `providerAtEntry` retain migration's durable runner ownership. `captureEntry()` retains master's repeatable pre-transform snapshot, but its provider-at-entry/current-provider exclusions retain migration's prohibition on legacy slot reads and replay for provider sessions. `let entry` and `admissionRetried` retain master's refresh after yielded writer waits. The retry callback applies the same provider exclusions before legacy replay. |
| `packages/plugin/src/plugin/messages-transform.ts`, 608–624 | `LkgAdmissionReplay` returns master's validated early legacy replay. The separate provider branch retains migration's durable-only recovery, emergency/schema refusal exclusions, and loud refusal when no provider record can recover. Early legacy replay cannot be reached for a provider-owned pass. |
| `packages/plugin/src/v2/hooks/context.ts`, 2053–2071 | The `nativeMessages && !checkpoint` block retains master's opt-in native row capture and optional-cache error/invalidation handling. The `capturedSlot` provider ternary retains migration's exclusion from legacy LKG/system snapshot capture. Native host-fold rows and runner recovery records are distinct caches. |

The non-conflicting OpenCode 2 outer writer retry was also reconciled: its
`providerAtEntry || transform?.isProviderSession(...)` return prevents an earlier
pipeline's legacy slot being consulted before durable runner admission. The
ordinary TypeScript path still tries a fitting saved request before backoff.

## Combination coverage

- `uncertified serialization failure preserves the prior served marker` covers
  a live deadline guard together with native-compaction certification exclusion.
- `expired serialization failure preserves the certified last-good move identity`
  covers a serializer that fails after expiring the pass; stale failure cleanup
  cannot invalidate the already served prefix or its durable certification.
- `postprocess observer participates in the outcome budget and leaves dispatch refused`
  checks that the observer sees completed work, while a stalled observer cannot
  produce a managed dispatch receipt. The existing mandatory-overrun test also
  asserts that the observer does not run on a failed pass.
- `writer retry leaves a provider session's stale legacy slot untouched` exercises
  shared-wrapper BUSY admission followed by provider-only recovery.
- `v2 outer admission never tries a legacy slot for an active provider session`
  exercises the earlier host callback; the paired unchanged legacy test continues
  to require saved replay before a writer retry.

## Non-conflicting merge checks

No schema downgrade or migration rewrite was taken from master: the TypeScript
ceiling, Rust built context lane and move inventory remain context v100; the
store inventory remains v67 (inventory protocol v4). Rust per-table fingerprints
remain the authority for writes, rather than replacing them with a blanket lane
comparison. The module library's fingerprint and signed-thinking tests and the
store's inventory tests are included in the gates.

The mode validator checks all 185 live e2e files exactly once and derives 68 TS
and 59 Rust invocations, including master's new OpenCode 2 dreamer route test.
The OpenCode 2 SHA pin for `packages/plugin/src/index.ts` includes master's
host-stall profiler import/startup. The repository has no `entry-pins.test.ts`;
the corresponding existing gate is `packages/e2e-tests/tests/opencode2/pins.test.ts`.
It verifies the actual entry bytes with only its three exact v2-loader
normalizations. The schema, manifest and pin selection passed 16 tests.

`ARCHITECTURE.md` was automatically merged by Git; no manual changes were made
to it or `STRUCTURE.md`. Incoming `.cortexkit` release notes are merge content,
not edits to worker context.

## Verification receipts

All requested test/build gates use Linux, an unset `OPENCODE_DB`, and a throwaway
`HOME`. Exact counts and parent failure-name comparisons are recorded below once
the gates finish. Audit default and strict results are compared to the migration
parent; master does not contain these signed-thinking audit fixtures.

### Master merge results (before step 2b)

Bun 1.4.2 (744846f84), TypeScript 5.9.3; Cargo/rustc 1.99.0,
rustfmt 1.10.0-stable. `bun install --frozen-lockfile` checked 1,010 installs
across 1,251 packages with no lockfile change on each revision. Parent snapshots
were archived inside this worktree and received independent copies of the
already hydrated Linux dependencies (preserving symlinks), since a fresh parent
install with an empty HOME cache could not reach npm DNS. Their frozen installs
then succeeded. No parent source, dependency manifest or lockfile was modified.

| Suite | Migration parent | Master parent | First merged run |
| --- | --- | --- | --- |
| Plugin | 8,079 pass / 33 fail / 9 skip | 7,511 pass / 33 fail / 19 skip | 8,165 pass / 36 fail / 19 skip |
| Pi | 1,588 pass / 144 fail / 3 skip | 1,621 pass / 144 fail / 9 skip | 1,673 pass / 144 fail / 9 skip |
| CLI | 613 pass / 2 skip, plus 9 pass / 1 fail repair-db subprocess | same | same |
| Dashboard | 162 pass | 162 pass | 162 pass |

The parents' failure-name sets are identical for all four suites. Exactly three
new plugin failures were incompatible test doubles in master's newly imported
v2 admission tests: they omitted migration's `isProviderSession` method. The
doubles now explicitly answer false; their assertions and behavior contracts
are unchanged. All three recovered in a 30-test, six-file focused run, together
with the new combination tests. Exact names, original counts and comparison
receipts are in `docs/evidence/master-migration-failure-names.json`.

- `bun run build`: passed on both parents and the merge (plugin v1/v2 bundles,
  Pi bundle and CLI bundle, plus declaration/TUI builds).
- `bun run typecheck` and dashboard `typecheck`: passed (eight TypeScript compiler
  invocations, including retina prerequisites and plugin scripts).
- `cargo test -p mc-module --lib`: 1,856 passed, 25 ignored.
- `cargo test -p mc-store`: 314 passed, five ignored; zero doc tests.
- `cargo clippy --workspace --all-targets -- -D warnings` and `cargo fmt --check`:
  passed. The first store-test request was refused while another task owned the
  workspace; it was retried on Linux after that task completed, not locally.
- Signed audit default: TS 96 passed, Pi 46 passed, Rust 17 passed. Strict: TS
  72 passed / 24 failed, Pi 40 passed / six failed; the exact names equal the
  migration parent. Rust 14 passed / three failed, exactly the documented
  `claude_code::control_at_new_user_turn`, `claude_code::primary_mid_loop`, and
  `opencode_rust_mode::primary_mid_loop` names.
- Removing Pi's serialization-error ownership check reddened only
  `expired serialization failure preserves the certified last-good move identity`;
  the uncertified marker preservation control stayed green. Removing v2's
  provider retry exclusion reddened only `v2 outer admission never tries a legacy
  slot for an active provider session`; legacy early replay stayed green. Each
  mutant had a non-empty working diff and was restored to an empty diff from the
  staged implementation before continuing.

The Linux fixture failures are not declared green: the parent comparison
establishes they are not introduced by this merge. Examples include pre-existing
sidebar/historian/Pi tool fixtures, the temp-directory Node WASM dependency
resolution failure, the `git rev-list` probe in the remote snapshot, and the
CLI corrupted-page salvage fixture.

## Subsequent signed-thinking step 2b merge

The second merge parent is `210cd45941f363b66fa54742d43dda984a0df86b`, based on
the same migration revision. It is merged after the master merge commit
`9787c592bdb5cdfad2ce3fcc20aad2a84c98c624`, not squashed into that merge.
`trigger-parking.ts` is the reviewed new module at
`packages/plugin/src/hooks/magic-context/trigger-parking.ts`; no compatibility
shim was added.

There is one conflict, in `packages/pi-plugin/src/context-handler.ts` just before
the pipeline result:

- Master's `visibleCallIds` loop and `servedTagNumbers` calculation retain only
  tag identities represented in the returned structured messages. A removed
  call/result pair cannot certify its number merely because raw text quotes a
  marker. Every line of that block is retained from the master merge.
- Step 2b's `parkedTriggers.settle(pending-or-deferred-materialization,
  emergency-eligible-and-unspent)` call and conditional map deletion retain
  process-local parked permission while its underlying work is still pending.
  Every line of that block is retained from the step-2b parent, after the tag
  calculation and before returning the same result.
- The result retains master's `servedTagNumbers`, migration's postprocess fields,
  and step 2b's bust verdict: a pending materialization signal alone no longer
  claims an edit unless `isCacheBustingPass` permits it.

All other step-2b changes merged without conflict: the parked materialization /
force permission masks; first-render-held and execute-held parking; the two Pi
materialization drain guards; the OpenCode drift-watcher `!freezeM0M1` guard; and
the empty-subagent drain condition
`!(freezeM0M1 && m0M1EnabledForFold)` before consuming a materialization signal.
The latter deliberately allows an empty subagent flush to finish because there
is no synthetic history head or protected queued drop left to rebuild. The live
95% force wall remains outside the parked 85% permission mask.

The step-2b delta also imports golden-capture-compatible Rust audit assertions;
it changes no Rust production source, schema constant, fingerprint or inventory.
The Rust audit, Clippy and fmt are rerun for that fixture delta. TS and Pi full
suites, typechecks, parking unit tests, and the v1/v2/Pi signed audits (including
all `step2b_review_...` tests) are rerun for the final combined tree. Their
failure names are compared against the independently executed parent receipts,
not declared passing merely because their scripts exited nonzero on known
fixtures.

### Final combined receipts

On Linux with Bun 1.4.2, the full final plugin suite reports 8,191 pass / 33
baseline failures / 19 skip (8,243 tests, 779 files). Pi reports 1,682 pass / 144
baseline failures / nine skip (1,835 tests, 184 files), plus its successful nested
pure-replay test. CLI again reports 613 pass / two skip and the separate nine
pass / one baseline repair-db failure; dashboard reports 162 pass. A name-set
comparison against both parent runs is exact for every suite: no introduced or
silently resolved failures. In particular, all three master admission-test
names repaired by the explicit TypeScript-only mock method are now green in
the complete suite, not only the focused rerun.

The final default TS audit plus parking unit selection passes 119 tests; Pi
passes 55. Strict mode reports 95 pass / the same 24 known TS failures and 49
pass / the same six known Pi failures. All signed-prefix-parking and step-2b
review tests, including both OpenCode generations' empty-subagent tests, pass
in both modes. `bun run build`, the eight typecheck invocations and the final
Rust audit/Clippy/fmt fixture gates pass or retain precisely the three documented
Rust strict failures. The mc-module library and mc-store production code did
not change in the second merge, so their earlier 1,856-test and 314-test passes
remain applicable without repeating the expensive library parity run.

AFT inspection remains partial because its checkout graph and Biome producer
are unavailable. Its Rust analyzer reports a missing `injected_reductions`
field in the integration fixture, but that field is `#[cfg(test)]` on the
library-only build: both Cargo audit compilations and all-targets Clippy pass.
No source change was made to satisfy that non-authoritative cfg diagnostic.
Package-local Biome 2.5.1 checks supplement the authoritative compiler gates;
the two warnings in the earlier Pi LKG check are pre-existing non-null assertions.
The comment review found no unclear newly merged source comment; inherited
historical review prose is retained rather than rewritten as part of a merge.

The final-tree non-vacuity controls also restore the old empty-subagent drain
predicate and remove the frozen-prefix drift-watcher guard independently. Each
mutation fails exactly its selected named v1 audit test:
`step2b review: v1 empty subagent flush leaves no standing signal under thinking`
and `signed prefix parking: v1 > m0 drift watcher does not signal under kept thinking`.
No other selected test fails (115 other audit tests are filtered out in each
single-test control). Both changes are restored from the staged implementation
with `touch` and an empty working diff before the final positive parking/review
selection. None of the `NON-VACUITY BREAK` mutations is committed.

After restoring both step-2b mutants, the focused `signed prefix parking|step2b
review` selection passes 29 tests across the TS v1/v2 and Pi files (3,776
expectations). Final Biome checks pass on five TS files and two Pi files, with
one inherited unused `contextRefusalError` import warning in the postprocess
module; no out-of-scope cleanup was applied.
