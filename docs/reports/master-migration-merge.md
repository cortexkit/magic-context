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
