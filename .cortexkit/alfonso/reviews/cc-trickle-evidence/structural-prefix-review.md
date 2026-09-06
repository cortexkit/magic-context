# Structural rendered-prefix review — replacement for counter discrimination

This is the current evidence-package delta. It supersedes the host-flag and publication-progress discriminators described in the older sections of `report.md`. The existing ASTRO damaged fixture was preserved; no metadata-only substitute or fixture weakening was used.

## Decision and exact discriminator

The parent selected a **rendered-prefix proof**, not metadata-only comparison. A fixture with boundary/coverage 425 and applied/folded/component sequence 1 can look like a valid store prefix while its frozen m0 actually contains the summaries through sequence 47 / ordinal 2400. Comparing that metadata only with the store would misclassify the real split-brain as pending publication. Composition-time evidence distinguishes it from its healthy twin.

Two optional fields were added to the existing `ModuleMeta` JSON:

- `rendered_m0_coverage: Option<RenderedCompartmentCoverage>`
- `rendered_m1_coverage: Option<RenderedCompartmentCoverage>`

`RenderedCompartmentCoverage` contains `max_sequence: Option<i64>` and `boundary_ordinal: Option<u64>` (`crates/mc-store/src/lib.rs:3614–3629`; metadata fields at `:3738–3743`). An absent field means **unknown legacy bytes**. A present proof with both inner values absent means **known to contain no compartments**, as with a placeholder/notes-only m1 after HARD. Half-present inner values are incoherent, not a legacy escape.

The proof records the compartment coverage of the actual composition emitted into each frozen unit. It is not reconstructed from the mutable applied metadata during a replay, and it does not parse human-readable m0 prose. It is a structural composition witness, not a cryptographic integrity check for arbitrary external edits to the text and proof together.

### Proof minting and durability

- Ordinary HARD/MigrateHard (`transform.rs:4758–4762`): m0 proof is taken from the `M0Composition.folded_compartment_seq` and `coverage_ordinal` that produced the new m0 bytes; m1 proof is known-empty because only placeholder/claimed notes survive that fold.
- Pressure refold (`transform.rs:4986–4990`): the same rule applies to the actual recomposed m0 and notes-only m1.
- Ordinary SOFT (`transform.rs:5043`): `M1Composition.rendered_coverage` is derived from the actual `new_comps` partition composed into m1, independently of the later applied metadata updates (`m1_compose.rs:230–232,328–335,506`). The old m0 proof is retained verbatim.
- Additive/compaction-off rendering records that its prefix units contain no compartment history. Its separate scheduler path does not run the compartment repair detector.
- Proofs are fields on the same speculative metadata value committed with `core.frozen_units` by the existing `TransformCommit` CAS. There is no separate proof write and no proof update on DEFER. The store CAS/reopen regression checks that a losing write cannot substitute a different proof and that both known-covered m0 and known-empty m1 proofs survive reopening.

No SQLite migration is required: old JSON lacks the optional fields and decodes with `None`.

## Classifier inputs and rules

`classify_boundary_divergence` at `crates/mc-module/src/transform.rs:6737` (invoked by detection at `:6880`) reads exactly:

1. **Rendered evidence:** `meta.rendered_m0_coverage` and `meta.rendered_m1_coverage`, including each unit's maximum compartment sequence and terminal covered ordinal.
2. **Applied metadata:** `meta.coverage_ordinal`, `meta.coverage_start_ordinal`, `meta.coverage_compartment_seq`, `meta.folded_compartment_seq`, and `meta.m1_compartment_seq`.
3. **Applied anchor:** `core.boundary_id`.
4. **Current store structure:** ordered `CompartmentBoundary` rows containing only `sequence`, `start_message`, `end_message`, and `end_message_id`. `McStore::load_compartment_boundaries` reads these four columns from one SQLite snapshot without loading titles or summary bodies (`mc-store/src/lib.rs:10105`).

The classifier does **not** use `mid_turn`, elapsed time, the divergence count, publication progress, or `boundary_divergence_observed_compartment_seq` to decide whether a proven prefix is healthy. The existing max-end read/revision revalidation and CAS retry machinery still prevents mixing an observation with a concurrently advanced publication revision. Legacy rows keep the old max-end/tail-allowance detection path.

Checks for a proven prefix:

- Store rows must have valid ranges, strictly increasing sequences and non-overlapping ordinal ranges. Sparse coordinate gaps remain legal as before; the existing live-message coverage validation still protects coverage advances.
- Each nonempty rendered proof must identify a store row with the same sequence and endpoint ordinal.
- If m1 contains compartments, its terminal sequence/ordinal must extend beyond m0's; the aggregate rendered endpoint is m1's endpoint, otherwise m0's.
- Aggregate rendered endpoint must equal applied `coverage_ordinal`; any present applied component sequence must equal the aggregate rendered sequence. `folded_compartment_seq` must agree with m0's own proof.
- `core.boundary_id` must equal the store endpoint ID of that aggregate prefix. A present `coverage_start_ordinal` must agree with the store's leading range.

Outcomes:

| Class | Meaning | Repair behavior |
|---|---|---|
| `Aligned` | Rendered evidence, applied metadata and store terminal prefix agree | No divergence candidate; no count |
| `Consumable` | Rendered evidence and applied metadata agree on a consistent store prefix, and the store has a later suffix | Never counts or requests a repair HARD. It can wait through any number of mid-turn observations, with or without additional publications, then ride the existing SOFT opportunity |
| `Incoherent` | Rendered evidence contradicts applied metadata or the current store prefix, including a rewind below rendered coverage | Count each coherent observation, regardless of host mid-turn or publication progress; repair on observation 3 for a pending unequal component revision |
| `Legacy` | Either unit lacks composition evidence | Retain the previous count/progress behavior until enough actual materialization has established both proofs |

The parent explicitly required retaining the **existing immediate-recut arm** when the compartment revision is already acknowledged (or the existing digest fallback proves that equality). There is no pending publication to wait for in that case. The existing immediate ASTRO repair test and its mid-turn counterpart remain unchanged and pass.

A proven incoherent prefix cannot borrow an active historian or wrapup's publication window either: a future publication cannot repair already-wrong frozen m0 coverage. Legacy rows retain that old active-window compatibility behavior. The former generic active-wrapup counter test was explicitly renamed/scoped to legacy metadata; a new proven-damage test covers both active historian and active wrapup cases. This is an intentional contract qualification, not a test weakened to hide the ASTRO fixture.

SOFT activity does not reset a still-incoherent prefix's count merely because it moved the applied boundary. HARD reconstruction can clear the count; a newly aligned/consumable structural observation also clears it.

### Existing counters retained

`boundary_divergence_pending_count` remains the escalation bound for incoherent and legacy observations. `boundary_divergence_observed_compartment_seq` is retained for **legacy compatibility only**: progress may still reset legacy counting, but cannot reset structurally incoherent counting. Proven consumable rows keep both the count and the old observed-sequence state clear.

## Legacy transition — explicit limitation

A replay cannot truthfully infer the history span in old frozen m0 bytes from mutable metadata. Therefore:

- An old row with missing proofs keeps the current count-based/progress-sensitive behavior, including its existing limitations, until materialization supplies real evidence.
- A legacy SOFT establishes only the m1 proof. It does **not** manufacture an m0 proof from applied metadata.
- The next actual m0 rebuild (ordinary HARD, migration HARD, or pressure refold) establishes both proofs. There is no forced one-time deployment bust or offline migration.

`legacy_prefix_keeps_counting_until_hard_mints_rendered_proof` proves the requested transition: a legacy pending publication retains the existing three-pass behavior; the resulting HARD mints both proofs; a later publication then waits through ten mid-turn observations without a recut. `legacy_soft_mints_only_m1_proof_without_guessing_frozen_m0_coverage` separately pins partial SOFT transition. Thus this delivery does not claim to have structurally certified pre-existing bytes without rebuilding them.

## Requested executable matrix

All requested cases run with `mid_turn=true`; damaging cases use below-force usage, fresh response observations, no refresh and no independent HARD trigger.

| Requested case | Exact test | Result |
|---|---|---|
| One healthy publication followed by ten unchanged mid-turn passes | `healthy_single_publication_waits_ten_mid_turn_passes_then_applies_one_soft` | m0/m1 identical on all ten; no repair; one SOFT at the boundary |
| Six healthy publications | `cc_mid_turn_publications_coalesce_until_boundary_with_force_and_flush_escape` | All six coalesce; now asserts count 0 / observed-seq None, rather than the superseded progress-counter value 1; force/emergency/flush and below-threshold boundary cases still pass |
| Damaged rendered prefix plus a new publication every pass | `incoherent_rendered_prefix_recuts_despite_a_new_publication_every_pass` | Recut on pass 3; original ASTRO fixture unchanged |
| Damaged rendered prefix without new publications | `wedged_mid_turn_with_unchanged_stale_revision_recuts_within_pending_pass_limit` | Recut on pass 3; existing test unchanged |
| Consumable through pass 3, store rewind on pass 4 | `consumable_prefix_rewound_on_pass_four_recuts_on_pass_six` | Counting begins at pass 4; repair on pass 6, coverage shrinks to the valid store boundary |

Additional proof tests:

- `rendered_prefix_classifier_distinguishes_consumable_damage_and_legacy` (`transform.rs:23887`): 21 table-driven cases. It includes the side-by-side identical-applied-metadata twin: proof covering only the applied prefix is consumable; proof covering later frozen summaries is incoherent. Also covers equal sequences, equal sequences with wrong rendered ordinal, m0 behind metadata, m1 ahead, applied sequence beyond store max, stale/missing component markers, missing observed sequence, absent/partial proofs, endpoint ID drift, leading coverage loss, overlapping ranges, store rewind, and a valid m0+m1 aggregate.
- `rendered_proof_tracks_hard_soft_and_pressure_refold_compositions`: actual stored proofs follow initial HARD, preserve m0 across SOFT while advancing m1, then move all history into m0 and mark m1 known-empty on pressure refold.
- `rendered_prefix_damage_counts_through_active_historian_and_wrapup`: neither producer state suppresses proven damage; both recut on the third coherent observation.
- Existing store CAS/reopen test now includes both proof fields; `compartment_boundary_projection_keeps_structural_fields_and_session_scope` pins the narrow structural store read.

## Red-first and mutation output

Before implementation, the four new primary/transition tests all failed on the current branch:

- Healthy stall: `left: "HARD", right: "SOFT+"` on the third observation.
- Progressing damage: `left: None, right: Some(3)` after four publications.
- Rewind transition: already HARD at pass 3, before the intended rewind at pass 4.
- Legacy transition: the third-pass HARD had no `rendered_m0_coverage` object to establish proof.

The additional active-producer structural test also failed before narrowing the publication-window exemption: no recut at observation 3. Those failures were fixed in production code. The original ASTRO fixture's core, metadata corruption and frozen content were not weakened.

Each deliberate mutation followed the exact safe sequence: **`git add -A`**, apply a `NON-VACUITY BREAK`, capture non-empty **index-relative `git diff --stat`**, run the named two-test command, then **`git checkout -- <path> && touch <path>`** and capture an **empty index-relative diff**. All mutations were restored before final verification.

| Mutation / applied diff | Exact red test | Unaffected control | Captured failure |
|---|---|---|---|
| Ignore complete rendered proofs and use legacy counting; `transform.rs` 1 insertion / 1 deletion; restored empty | `healthy_single_publication_waits_ten_mid_turn_passes_then_applies_one_soft` | `mid_turn_does_not_hide_already_acknowledged_coverage_damage` passed | `boundary_divergence_recut ... old_coverage=2 new_coverage=3`; `left: "HARD", right: "SOFT+"`; 1 pass / 1 fail; exit 101 |
| Fabricate rendered proofs from mutable applied metadata; `transform.rs` 5 insertions; restored empty | `incoherent_rendered_prefix_recuts_despite_a_new_publication_every_pass` | healthy ten-pass test passed | `left: None, right: Some(3)`; 1 pass / 1 fail; exit 101 |
| Let publication progress reset incoherent observations; `transform.rs` 2 insertions / 2 deletions; restored empty | `incoherent_rendered_prefix_recuts_despite_a_new_publication_every_pass` | healthy ten-pass test passed | `left: None, right: Some(3)`; 1 pass / 1 fail; exit 101 |
| Omit m0 proof from serialized metadata; `mc-store/src/lib.rs` 2 insertions / 1 deletion; restored empty | `rendered_proof_tracks_hard_soft_and_pressure_refold_compositions` | classifier table passed | `left: None, right: Some(RenderedCompartmentCoverage { max_sequence: Some(2), boundary_ordinal: Some(2) })`; 1 pass / 1 fail; exit 101 |
| Let active producer/wrapup mask proven damage; `transform.rs` 1 insertion / 1 deletion; restored empty | `rendered_prefix_damage_counts_through_active_historian_and_wrapup` | legacy active-wrapup test passed | `left: None, right: Some("boundary_divergence_recut")`; 1 pass / 1 fail; exit 101 |

## Verification and evidence-package delta

- `cargo test -p mc-module -- --test-threads=2` initially passed the complete structural implementation: 1065 library tests, 4 ignored, binary golden and both integrations passed. After adding the active-producer case, the final full invocation had **1065 passed, 1 failed, 4 ignored**, exit 101, solely on the pre-existing wall-clock timing assertion `unaffected_transition_golden_is_byte_identical_and_detection_is_constant_time` (54.123 µs/pass). No structural regression failed.
- `cargo test -p mc-module --lib unaffected_transition_golden_is_byte_identical_and_detection_is_constant_time -- --nocapture`: **exit 0**, 17.952 µs/pass in isolation. The timing assertion was not weakened. This is the same unrelated load-sensitive gate observed earlier in the task.
- The nine structural/proof regressions passed together after the first four mutations were restored. The later active-producer case and legacy-window counterpart passed together, and both also passed in the final full run.
- `cargo test -p mc-store`: **exit 0**, 136 tests passed; doc-tests passed. Includes proof CAS/reopen and boundary projection tests.
- `cargo clippy -p mc-module -p mc-store --all-targets -- -D warnings`: **exit 0** after the final production changes.
- `cargo fmt --all -- --check`: **exit 0**.
- `aft_inspect`: fresh completion, but no authoritative scoped Rust reports; Cargo checks are the authority.
- Final Sidekick comment review examined ten changed comments and flagged none.

No TS code or generated threshold golden changed in this revision. The prior wildcard-negative/OMP-positive parity evidence remains intact. Cargo generated path-dependency lockfile churn is restored before commit; no manifest or dependency upgrade is delivered. No production module bounce, live-store mutation, or master push occurred.

Package delta: this document plus a current summary/link at the top of `report.md`; production and tests in `mc-module/src/transform.rs`, `mc-module/src/m1_compose.rs`, and `mc-store/src/lib.rs`. Prior capture files and historical reports remain available unchanged below the current summary.
