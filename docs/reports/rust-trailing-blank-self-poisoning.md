# Rust trailing-blank self-poisoning parity report

Date: 2026-08-29

## Outcome

The Rust transform now matches the TypeScript trailing-blank contract on the active OpenCode/Anthropic path:

1. Decisions are classified from an immutable ingress snapshot taken before projection, structural-noise replacement, merged-reasoning composition, or synthetic output construction. Candidate minting intersects that snapshot with assistants still present in the served projection.
2. A frozen `keep` or counted keep canonicalizes only an existing trailing blank suffix. It does not append a blank when the suffix is absent, and an empty assistant remains empty.
3. On provider-prefix mutation passes only, a historical poisoned keep whose source shape is `strip` is demoted before final output. The assistant must still be visible in that pass, and the newest assistant is excluded.

The repair does not move a persistence fence. Rust continues to store decisions as `trailing_blank_keep` / `trailing_blank_strip` frozen units in the existing `CoreState`, and the complete state is committed through `McStore::commit_transform` under the existing cache-row compare-and-swap row version. There is no schema change or migration.

## Source-only capture

`apply_once` snapshots every ingress assistant's trailing-blank classification immediately after request normalization/rebasing and before projection or rendering. `refresh_trailing_blank_decisions` no longer counts trailing sentinel-visible blocks in `ServedMessage`; it reads only the snapshot and uses served messages as a visibility intersection.

The regression constructs a raw assistant with no trailing blank and a composed representation with a terminal canonical sentinel. The persisted decision is `strip`. Re-enabling rendered-suffix observation changes it to `keep` and fails the source-capture test.

## Keep cannot manufacture

`apply_frozen_trailing_blank_decision` now returns without mutation when a keep sees zero trailing blanks. Empty content also returns unchanged. Existing nonempty blank suffixes retain their prior canonicalization behavior, including counted keeps and wholly blank nonempty messages.

This accepts one already-priced bust if a previously present suffix disappears rather than making Magic Context the source of bytes that a later pass can observe and freeze.

## Poison heal and marker windows

After the first output build, Rust scans source decisions only on a provider-prefix mutation pass. A keep demotes when all of these hold:

- the immutable source decision is `strip`;
- the assistant is historical, not newest;
- the assistant is still present in the served projection; and
- the durable decision is currently a keep.

All matching frozen units change in the same `CoreState` update and ride the normal row-version CAS. The output is rebuilt before serving, so first application occurs on that bust. Successful demotions are logged after the CAS succeeds, once per message and accepted pass. Defer passes neither demote nor first-apply a marker-absent heal.

The TypeScript healer now applies the same visibility intersection. A source-present assistant removed by a marker window retains its keep on that bust; when it returns on defer, its prior bytes remain stable; a later bust with the assistant visible performs and applies the demotion.

## Decision-less bounded window

Both lanes now pin the previously untested historical no-decision sequence:

1. a historical assistant with no frozen decision acquires a late store blank;
2. defer serves preserve those bytes and do not mint a historical decision;
3. the next independent bust mints keep from the source blank and canonicalizes it once; and
4. later defers replay the canonical bytes identically.

This records the bounded one-bust exposure without introducing a decision-less strip arm that would mutate a nominal defer.

## Differential golden

DG-6 adds the incident topology to the TS-generated/Rust-consumed corpus: consecutive assistants form a merged composite, the target contains step-start, reasoning, tool-call, and step-finish parts, the frozen decision is keep, and the source has zero trailing text blanks. The expected wire does not gain a canonical blank. The generator provenance was advanced to `dg-reference-v4`.

## Mutation evidence

Each deliberate source mutation used the exact `NON-VACUITY BREAK` marker and was restored immediately after the red run.

| Deliberate mutation | Command | Observed red evidence |
| --- | --- | --- |
| Re-enabled rendered-suffix decision minting | `cargo test -p mc-module trailing_blank_decisions_mint_from_ingress_instead_of_rendered_sentinels --lib` | `transform.rs:18971` failed: source-only expected `(1, false)`, rendered observation produced `(1, true)` and a keep. |
| Restored keep-with-zero-suffix insertion | `cargo test -p mc-module frozen_trailing_blank_decisions_cover_both_races_and_provider_shapes --lib` | `transform.rs:18764` failed: expected zero mutations, received one manufactured blank. |
| Opened poison healing on defer | `cargo test -p mc-module poisoned_trailing_blank_keep_heals_only_on_a_visible_bust_and_replays_stably --lib` | `transform.rs:19509` failed: the pre-bust defer lost its terminal canonical blank and served the meaningful text as the suffix. |

No `NON-VACUITY BREAK` mutation remains in source or tests.

## Verification

- Frozen workspace dependency install: `bun install --frozen-lockfile` — passed; no lockfile or manifest changes.
- Focused Rust trailing-blank suite: `cargo test -p mc-module trailing_blank --lib` — 6 passed, 0 failed.
- Decision-less Rust boundedness pin: `cargo test -p mc-module decisionless_historical_late_blank_is_bounded_by_the_next_bust --lib` — passed.
- Differential corpus: `cargo test -p mc-module differential_goldens --lib` — 4 passed, 0 failed.
- TypeScript postprocess suite: `bun test src/hooks/magic-context/transform-postprocess-phase.test.ts --timeout 30000` — 81 passed, 0 failed.
- Restored mutation guards: the three focused Rust tests — 3 passed, 0 failed.
- Full `mc-module` gate: `cargo test -p mc-module` — 1,000 passed across unit/integration/doc targets, 4 ignored, 0 failed.
- Full `mc-store` gate: `cargo test -p mc-store` — 128 passed, 0 failed.
- Rust formatting and all-target check: `cargo fmt --all -- --check && cargo check -p mc-module -p mc-store --all-targets` — passed; only the two pre-existing `usable_window_tokens` dead-code warnings were emitted.
- Plugin TypeScript gate: `bun run typecheck` — passed.
- Full plugin suite: `bun run test` — 4,180 passed across 379 files, 0 failed.
- Changed TypeScript/generator/golden Biome check — passed.
