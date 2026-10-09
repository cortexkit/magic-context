# Reasoning retention implementation

## Shipped policy

`keep_reasoning_tokens` replaces the ignored/deprecated tag-age setting, with a fixed
10,000-token fallback, independent of context geometry. Scalar and per-model values use
the cache-TTL lookup order. The cutoff keeps whole steps newest first and stops at the
first non-fitting step. Exempt steps are charged but cannot be selected. Reported counts
win over calibrated plaintext estimates; opaque groups without either cost 1,000 tokens.

No store schema or stored-state migration is introduced. Existing frozen ids and
watermarks remain authoritative. New decisions only ride an already-permitted rebuild.
The canonical sentinel, whole-part, inline, native Pi and Rust lanes retain their own
eligibility and replay shapes.

## Clarifications adopted during implementation

- Whole-step selection does not introduce a new clearing capability. Pi redacted blocks
  remain immutable even when ordinary siblings are cleared. Native snapshots retain their
  separate saved-id replay. An upgrade regression pins byte-identical replay of a mixed
  redacted/ordinary step under an old watermark; cleared signed bytes cannot return.
- Rust's processed-image lane previously borrowed the reasoning-age cutoff. It now uses
  the TS/Pi **highest dropped-tag watermark**, not a fixed age and not the reasoning
  budget. Answered large user images at or below a positive watermark may be selected on
  rebuilds; existing frozen image decisions still replay. This is a one-time selection
  policy change on the next rebuild for affected legacy Rust sessions, including users
  with non-default `clear_reasoning_age`. Shared TS/Rust image selection and replay
  goldens pin the rule. The previous untagged-image integration fixture now supplies a
  real dropped-tag watermark and first proves that an answer alone does not retire it.
- Rust cost selection excludes already-covered history while charging a retained lineage
  anchor and respecting its existing render exemption and signed-prefix stop rule.

## Offline replay

Historical route replay was **not run**. The existing acquisition script reads live
stores, which this task prohibits; its original numeric outputs had been removed. The
parent approved adding a snapshot-only tool and deferring historical replay until an
operator supplies a sanitized dataset. No acquisition command or live-store read ran.

`packages/plugin/scripts/reasoning-resend-cost/replay-budget.ts` accepts only route/model
labels, numeric step order, reported counts or calibrated text estimates, and an encrypted
flag. Its README documents the format and the limitation: checkpoints are hypothetical
rebuilds with one tag per step, not reconstructed actual busts.

The synthetic fixture's final checkpoints at the fixed 10k default are:

| Synthetic trajectory | Budget kept tokens / steps | Age 50 kept tokens / steps |
|---|---:|---:|
| reported OpenAI-like | 5,000 / 2 | 13,000 / 3 |
| plaintext estimate plus unreported opaque | 1,000 / 1 | 10,500 / 2 |

These are test data, not measurements of the design table's routes. They do not justify a
change to the user-selected default.

## Safety and verification evidence

- Real OpenCode 1.18.30 with a thinking-capable loopback mock: an over-budget defer keeps
  provider prefix bytes, an explicit rebuild removes whole old steps and serves at most
  300 kept reasoning tokens (242 tokens in two steps in the final run), and the next
  defer preserves that frozen prefix. Host PID
  `lsof` proves all open databases are below its throwaway root. The scenario is registered
  in the e2e manifest with its validator counts: 176 files/entries, 60 TS invocations,
  58 Rust invocations and 44 TS OpenCode invocations. The final host PID was 78126.
- Prefix-stop and defer-permission mutants each redden only their named guard while the
  reported/fixed-charge control stays green. Mutations were staged safely, diff-captured,
  restored and touched; no mutant is committed. Delivery includes exact mutation records.
- Package suites, typechecks, lint and Rust checks are recorded with counts in the delivery.
  The final broad plugin run encountered one unrelated ten-second git setup timeout;
  the entire affected verification file passed with the repository test runner in isolation.
- `cargo clippy -p mc-module --all-targets -- -D warnings` encounters a pre-existing
  `type_complexity` warning in unchanged `single_store_repair_tests.rs:572`. Production
  `cargo clippy -p mc-module --lib -- -D warnings` passes; no unrelated lint cleanup rides
  this change.
- Rust evidence uses `cargo test`, not a locally launched `ck-mc` or `ckdev-mc`. The AFT
  fleet restart and prior build-copy warning therefore do not invalidate that evidence.
- No live OpenCode/CortexKit stores or configs were opened or migrated. Host runs use
  throwaway XDG roots, `OPENCODE_DB` and `MAGIC_CONTEXT_STORAGE_DIR`; package suites use
  throwaway `HOME` and do not export `OPENCODE_DB`.

## Adversarial follow-up

The accepted review commit `e8571ede97` and its witnesses were imported unchanged before
production edits. The first TS/Pi run reproduced all seven named failures (46 passed,
7 failed). Fixes retain every witness expectation:

- Budget-only first selection protects all assistant steps after the last real Anthropic
  user request, including subagents. Tool-result and synthetic user carriers do not reset
  the boundary. The isolated predicates are `active-anthropic-turn.ts` and Rust's
  `transform/active_anthropic_turn.rs`; neither is a compatibility shim for the parallel
  branch's absent helper. The parent explicitly narrowed coordination scope: fresh merged
  and proactive stripping remain unchanged here and are owned by the parallel turn fix.
- Whole-part and exact merged-part frozen replay no longer restores a block when a host
  subset changes the latest assistant. Bare legacy merged ids have no exact part evidence,
  so replay conservatively keeps those removals absorbing. Rust clear refresh retires the
  old suspension flags rather than restoring signed content; frozen age/merged removals
  take precedence over render exemptions and native keep decisions.
- Legacy tool tags price preceding thinking, not their owner's thought, and repeat it for
  parallel tools. Live selection now estimates the step's own kept plaintext. DB-only
  estimates use deduplicated message-tag evidence, never tool ownership. Exact frozen
  merged-part selections are replayed on a private cost-only parts array before charging;
  a retained sibling still counts. Frozen prose calibration is supplied to fallback and
  inline estimates as well as stored projections.
- Rust uses the existing shared `tool_catalog::model_key_candidates` alias walk instead
  of the literal-provider TTL resolver. Declared reasoning-part presence gives positive
  reported usage precedence even when the body is empty and has no opaque metadata.

Fixture changes are explicit: `toolLoop` itself remains unchanged. The calibration
witness alone uses a new historical context helper so it does not simultaneously demand
active-turn preservation and historical removal. Existing budget prefix fixtures identify
historical context; the pruning/index regression closes its turn with a real follow-up
request. No review expectation was weakened. Existing tests that claimed exemption-based
restoration were changed to the newly required absorbing contract, not silently inverted.

The three requested Rust witness filters were each tried once, sequentially, in background
with five-minute timeouts. The first two never reached tests while all six compile slots
were occupied (exit 124); their runtime results are **not run**. Compilation then completed
for the third filter, which passed the positive-empty-summary witness (one test, exit 0).
There was no local Rust host launch, live-store access or migration.

Final follow-up gates: plugin `bun run test` passed 7,326 tests (six skips) and Pi
`bun run test` passed 1,625 tests (three skips). The seven TS/Pi review witnesses
and all controls are green with unchanged assertions. The isolated LKG child-writer
failure observed in an earlier parallel run was not reproducible in isolation or the
final full Pi run. Final bundles were rebuilt and the OpenCode 1.18.30 thinking-mock
host proof passed again (PID 97768, 22 assertions, throwaway databases proven by lsof).
Fresh merged/proactive selection functions and provider-error recovery are unchanged;
only budget first selection uses the new active-turn predicate. The two existing replay
tests that asserted resurrection now assert absorbing frozen removals, as explicitly
required. Budget prefix fixtures are historical context carriers rather than live
requests, and preserve their cutoff/byte-identity assertions.

## Second adversarial follow-up

Imported `aad04f5253` and its witnesses without changing their expectations. The
initial new TS/Pi run reproduced R2 and R4 (one control passed, two witnesses failed).

- **R1 closed in code:** observed pre-unit legacy clears now bypass current newest,
  active-turn and anchor eligibility because they are replay, not first selection.
  Restoration pricing is removed. Legacy clear mids also suppress conflicting native
  keep decisions. Witness: `re_review_legacy_reexemption_never_restores_an_already_served_signed_block`.
  The old restoration-positive test is renamed to
  `reasoning_clear_legacy_reexemption_preserves_absence_before_unit_adoption` and explicitly
  documents the preserved-thinking contract change.
- **R2 closed:** bare legacy merged ids replay the established partial-layout rule;
  they no longer first-strip the retained first block on defer. Witness
  `re-review: a legacy partial merged strip preserves its already-served first block on upgrade`
  passes unchanged. The original pre-deploy partial-strip regression is restored.
- **R3 closed in code:** `strip:merged_reasoning` is no longer treated as a whole-block
  age removal. Serializer residual replay keeps the first block its planner retained;
  budget costing applies that partial representation rather than treating the whole mid
  as zero. Witness: `re_review_merged_strip_keeps_the_first_thinking_block_on_its_first_priced_pass`.
  Fresh merged selection and proactive lanes remain unchanged; their broader turn policy
  is still owned by the parallel branch.
- **R4 closed:** Pi recognizes declared ordinary thinking even with empty unsigned
  text and lets positive reported usage win before estimates. Witness
  `re-review: Pi charges positive reported reasoning even when its ordinary summary is empty`
  passes unchanged.

Part-level absorption supersedes the earlier bare-id all-removal claim in this report:
blocks explicitly removed stay absent; a previously retained sibling is not newly removed
without budget bust permission. Bare ids lacking evidence replay the established layout.
Both review rounds and exact-sibling/calibration controls pass together: 136 tests across
seven files, 3,792 assertions. No live stores or local Rust binaries are used.

Second-follow-up Rust ledger (Cargo 1.99.0): each of the five filters was attempted
once, sequentially in a background task, with its own 900-second timeout. The original
`review_reasoning_clear_never_restores_a_frozen_block_on_exemption_change` never reached
its test while queued behind six occupied compile slots (exit 124, **not run**). Compilation
completed during the second filter: `review_reasoning_budget_aliases_follow_the_shared_canonical_first_lookup`
passed one test. `review_reasoning_budget_reported_count_survives_an_empty_summary`, R1's
`re_review_legacy_reexemption_never_restores_an_already_served_signed_block`, and R3's
`re_review_merged_strip_keeps_the_first_thinking_block_on_its_first_priced_pass` each passed
one test, exit 0. Therefore R1 and R3 are closed with captured witness passes, not solely
source evidence. The original absorption witness and full mc-module lib suite remain
merge-time gates; no timeout retry was launched.

Final second-follow-up TS gates: Pi full suite passed 1,626 tests (three skips); plugin
full suite passed 7,327 with six skips and one unrelated 30-second visual-memory
experiment timeout. Its full ten-test file passed with the repository runner in isolation.
Both package typechecks pass (TypeScript 5.9.3); Biome checks pass with pre-existing
warnings. Final TS/Pi/CLI bundles build successfully, including four v2 export-contract
tests. No package manifest or lockfile changed. No host was launched for this follow-up;
prior host evidence above is not claimed as a new second-review acceptance run.

A final scoped run of the renamed contract regression,
`reasoning_clear_legacy_reexemption_preserves_absence_before_unit_adoption`, also passed
(one test, exit 0) on the final Rust sources. The final small parity edit restores the
merged serializer's existing exemption input in both render and cost preview; it does
not change fresh selection or broaden a bare merged flag into whole-block removal.

## Final durable-clear contract cleanup

The full-suite failures reported by the parent were obsolete restoration claims.
`reasoning_clear_reexemption_and_native_keep_collision_remain_absorbing` now requires
SOFT+ on re-exemption, no `reasoning_exemption_repair`, identical cleared native bytes,
no suspension flag, and stable keep/clear collision replay across all later defers and
an independently priced render change. `reasoning_clear_lineage_anchor_preserves_absence_without_suspension`
now checks that neither defer nor bust eligibility for a lineage anchor creates a new
clear or changes the already-cleared representation. Both comments explicitly identify
the preserved-thinking contract change.

Removed the obsolete suspension constant, exemption-change detector, reset-rule refresh
and all exemption-repair HARD pricing/attribution. Persisted obsolete flags are no longer
consulted; durable replay remains authoritative without an otherwise unreachable repair
path. The full locked mc-module library gate is run against this cleanup, not merely
against the two renamed tests. No TypeScript, provider, store schema or live-store changes
are included in this final step.

The first full locked cleanup run completed with 1,657 passes, one failure and 22
ignored tests. The anchor contract passed; the remaining byte-identity failure exposed
an additional native boundary issue: a cleared assistant becoming newest still took the
raw-vector shortcut, changing tagged text and sentinel shape even though its thinking
stayed absent. The parent approved excluding durably/legacy-cleared mids from that
shortcut in both reference/full and incremental encoding. The incremental key now uses
that same effective exemption predicate (its mutation/reasoning exemption bits already
participate in the key), preventing stale cached vectors when the path changes.

Added `native_newest_shortcut_preserves_live_signed_bytes_and_keys_clear_transitions`:
it proves that a non-cleared newest assistant still serves its original raw signed bytes
through both encoders, that a cleared newest serves the normal tagged representation,
and that both shortcut/normal transitions force re-encoding rather than stale cache reuse.
The existing re-exemption byte-identity assertion is unchanged.

Filtering the shortcut also exposed a cache-shape dependency: the codec previously
interpreted a missing exempt mid as an unresolved policy and rediscovered reasoning while
encoding suffixes. Added an explicit `reasoning_policy_resolved` flag so full and incremental
encoders use the same established decision even when no raw shortcut is eligible. The
native cache key's effective exemption bits match those passed to the encoder; resolved
policy is stable across these passes, avoiding unrelated sibling shape changes.

Final authoritative gate: `cargo test --locked -p mc-module --lib` passed **1,659 tests,
zero failed, 22 ignored** (1,681 total; Cargo/rustc 1.99.0). It ran in background and
was watched to completion. Both renamed durable-clear contract regressions, all original
and second-review witnesses, and the new full/incremental shortcut/cache-key control
passed in this whole-suite run. Rustfmt 1.10.0 formatting also passes. The unchanged
base's clippy type-complexity issue is not part of this cleanup and was not modified.
