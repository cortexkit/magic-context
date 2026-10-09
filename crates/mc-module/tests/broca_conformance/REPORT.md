# Broca provider conformance delivery

## S4 baseline result (before repair)

The new target compiled and ran **11 tests: 9 passed, 2 failed**. Both failures
are retained as product-behavior regressions, as required; no product files were
changed. The shared fixture generation and replay tests passed. The two failures
mean that the complete conformance acceptance is **not yet green**.

All Cargo gates ran through the Linux runner with
`test "$(uname -s)" = Linux || exit 90`. Tool versions: Cargo
`1.99.0 (5f94df478 2026-08-27)`; rustfmt
`1.10.0-stable (b940084d7e 2026-09-28)`.

## Acceptance results

| Item | Test name | Result |
| --- | --- | --- |
| Fresh Setup answers ready with an initial view; repeat Setup remains well formed | `compaction::fresh_setup_ready_with_initial_view` | Passed |
| Ordinary below-threshold steps are noop with byte-identical rendered prompts | `compaction::below_threshold_noops_crossing_once_history_drops_and_stable_prompts` | These assertions passed; the test later failed on the drop assertion |
| A pending historian publication does not change the prefix below threshold | `compaction::pending_history_below_threshold_preserves_last_view` | **Failed:** at 1% fill, the second publication returned `compaction_message`, not `noop` |
| Crossing threshold produces one full-working-range replacement carrying history and drops | `compaction::below_threshold_noops_crossing_once_history_drops_and_stable_prompts` | One replacement, range `[0,7)`, both history compartments and protected tail passed; **failed:** queued tool output was still served, with pending tag `[1]` retained |
| Following steps are noop and render byte-identically again | `compaction::below_threshold_noops_crossing_once_history_drops_and_stable_prompts` | Both following-step assertions passed before the final drop failure |
| Real default target broca reached; runner session joins only its project/session; broca-bound route does not join | `compaction::runner_join_is_project_and_session_bound_not_broca_bound` and the threshold test's callback assertions | Passed; no Thalamus-call assertion |
| Kill/restart, same request ID retried logically idempotently, allocated version skipped, contiguous cursor retained, stale answers rejected | `compaction::kill_mid_request_retry_skips_reserved_version_preserves_cursor_and_fences_stale` | Passed, at the real executable's `AnswerRecorded` marker; frozen compacting catalog also survived restart |
| Step failure keeps the applied view, not Setup-only compaction_unavailable | `compaction::failed_step_keeps_last_view_and_is_not_setup_compaction_unavailable` | Passed |
| post_assistant replaces only addressed text; reasoning, signatures, images and tool calls unchanged | `hooks::post_assistant_strips_only_addressed_text_preserves_signed_and_nontext_bytes` | Passed |
| pre_user/post_tool append to last text block of new content only; disallowed answers unavailable | `hooks::pre_user_post_tool_append_only_new_content_and_disallowed_answer_is_unavailable` | Passed; advisory declaration checked; caller rejection uses commons validation |
| Three role versions, transcript-read runner group, existing tool-provider surface | `role_describe_and_existing_tool_provider_surface` | Passed |
| Committed joint bytes match encoder generation | `fixture::joint_fixture_committed_bytes_match_real_encoder` | Passed without the write flag |
| Joint exchanges replay through real routes; unknown refusal decodes and is not retried | `fixture::joint_fixture_replays_real_routes_and_unknown_refusal_decodes_without_retry` | Passed |
| Existing module/Claude Code behavior | Existing `mc-module --lib --features drive-fault` tests | 1746 passed, 1 baseline failure, 22 ignored out of 1769; see below |

The threshold scenario starts with an imported message already summarized by
one compartment. This avoids conflating threshold behavior with the independent
first-boundary repair after an empty Setup. It then queues an older tool result,
retains a newer tool result exceeding the 4000-token protection floor, and
publishes a second compartment. Crossing uses disjoint measured input/cache
reads/cache writes (40000 + 20000 + 6000), above the configured 65% threshold.

## Product behavior requiring follow-up

1. **Later history publication changes the served prefix below threshold.**
   `pending_history_below_threshold_preserves_last_view` establishes the initial
   folded history boundary, gets a low-usage noop, appends a second compartment,
   then calls again at 1000/100000 tokens with no requested prefix rebuild. The
   answer is `compaction_message`. Relevant product paths:
   `crates/mc-module/src/providers/compaction.rs:1457` executes the adapter and
   `:1467-1470` emits the view;
   `crates/mc-module/src/transform.rs:2604-2629` permits and allocates replacement
   output based on the engine's prefix-bust permission. This identifies the
   execution/permission boundary, not a proven root cause inside classification.

2. **Queued tool output is not released on the rebuilding pass.**
   The threshold test observes `ctx_reduce`'s successful queue acknowledgment,
   verifies tag 1 belongs to ordinal 3 and is pending, and supplies a distinct
   newer tagged result larger than the configured protection floor. The crossing
   answer folds both history compartments, but still contains `RELEASABLE OUTPUT`;
   after the following noops the durable pending tags remain `[1]`. Relevant
   product paths: `crates/mc-module/src/providers/compaction.rs:674-683` maps tags
   to pending engine targets, `:695-700` runs compaction, and `:701-708` retains
   targets left pending by the engine. The precise selection/protection cause
    had not been localized in S4. Follow-up found that the two-group input was
    inside the deliberate newest-three protection window, not eligible for
    release. The input is corrected below without weakening that policy.

3. **Pre-existing fence-ceiling assertion is stale.** The unchanged library test
   `tests::supported_fences_report_plugin_and_store_ceilings`, at
   `crates/mc-module/src/lib.rs:20741-20744`, expects
   `context.db=96 store.db=66`, but production reports
   `context.db=97 store.db=66`. The full library run failed only this test.
   No integration-test source participates in that library test target.

## Fixture and scope qualifications

Fixture path:
`crates/mc-module/tests/broca_conformance/fixtures/compaction-provider-v1/joint/`.
It contains `transcript.json`, the seven ordered `exchanges.json` cases, and a
one-line-per-case `README.md`. All files use LF and contain no machine paths.
The suite README documents the exact generation command and the `runner` bind
deviation from the original `broca` assumption.

Actual executable responses supply every normal case. Only opaque compaction
IDs are normalized to `mc-joint-v1`, since MC hashes the temporary project root
into the ID; replay remaps that ID to the real session's ID. The unknown refusal
is explicitly a synthetic caller-decoder case using the same pinned serialized
answer type as MC, because MC has no unknown-code emission path. The oversized
text is 9020 bytes against a selected 256-byte paging cap; a real subc call to
the scripted runner verifies it is returned alone. This is not a 4 MiB default-cap
load test. Broca's own caller executable is not run; admission/unavailability
and stale-answer controls use commons at `85c105df`.

## Additional verification

- `rustfmt --check --edition 2021` on the five named Rust files: passed.
- Final restored suite command:
  `cargo test -p mc-module --test broca_conformance --features drive-fault -- --test-threads=2 --nocapture`:
  9 passed, the two product regressions above failed.
- Library command `cargo test -p mc-module --lib --features drive-fault`:
  1746 passed, 1 baseline failure, 22 ignored.
- Sidekick comment review covered all six requested source/README files;
  flagged jargon was rewritten with concrete reasons.
- Scoped IDE inspection was partial: the local analyzer treats Linux-only tests
  as inactive/unlinked. Linux Cargo compilation is the authoritative type gate.
- No package manifests or lockfiles changed; no install was needed.

Two temporary mutation controls were applied and restored from the
staged live snapshots. Corrupting the fixture replacement's block index failed
only `fixture::joint_fixture_committed_bytes_match_real_encoder` while
`role_describe_and_existing_tool_provider_surface` passed. Neutralizing the
caller's answer fence failed only
`compaction::kill_mid_request_retry_skips_reserved_version_preserves_cursor_and_fences_stale`
while `compaction::failed_step_keeps_last_view_and_is_not_setup_compaction_unavailable`
passed. Each mutation had a non-empty diff while applied and an empty diff after
`git checkout -- <path> && touch <path>`. No mutation remains in the tree.

## Follow-up resolution

The final executable conformance suite passes **13/13**: the original eleven
scenarios plus runner Setup admission and protected-drop displacement cases.
No committed joint fixture bytes or original noop/history/drop expectations
were relaxed. The crossing input now spans `[0,12)` instead of `[0,7)` because
it contains two additional tool-call/result pairs and a final user turn.

### Root causes and changes

1. **Unobserved response time opened the history gate.**
   `crates/mc-module/src/providers/compaction.rs:673-677` used a producer context
   with no prior-response timestamp and a finite configured TTL. The scheduler
   substitutes zero for that missing timestamp, measuring idle time from the
   Unix epoch and selecting Execute even at 1% fill. New history then legitimately
   selected Soft inside the engine, but the adapter had supplied a false execute
   opportunity. Runner execution now uses internal `cache_ttl = "never"`, like
   host execution: the runner reports actual cache expiry with `prefix_rebuilding`.
   The configured TTL and transcript-reading wait bound remain unchanged.

2. **The original queued target was protected, not eligible.**
   `crates/mc-module/src/protection_window.rs:72-132` deliberately unions the
   token-floor suffix with the newest three tool-tag groups. The original
   two-group fixture put tag 1 inside that window even though tag 2 alone paid
   the 4,000-token floor. At the parent's explicit direction, the fixture was
   corrected to four groups rather than changing the protection policy. The
   crossing pass now releases tag 1 and empties the queue with no production
   selection/drop change. The companion test keeps the original two-group
   situation, verifies a held reply and retention through a rebuild, then adds
   newer groups and verifies release on the next genuine rebuild.
   This exposed a separate acknowledgement defect in
   `crates/mc-module/src/providers/step_transform.rs:236-262`: every valid target
   previously received `Queued`, including protected targets. Replies now use
   the canonical calibrated protection window and protected-tool set to report
   `Held` while preserving the same durable queue and execution policy.

3. **One exact-plan permission; frozen host transport copies are not busts.**
   `crates/mc-module/src/transform.rs:2604-2611` now reports only the engine's
   `prefix_bust_permitted`, without OR-ing a status signal into that permission.
   A host pipeline switch may still copy the already-served frozen engine view
   into the new transport envelope without granting mutation permission. The
   existing host byte-equivalence tests remain unchanged, and the new adapter
   test pins false permission and an unconsumed queued target on that defer.

4. **Fence and runner admission.** The stale assertion at
   `crates/mc-module/src/lib.rs:20743` now expects context ceiling 97. A source
   scan found no other context/schema ceiling hard-coded to 96. Runner Setup
   already refuses the host-only plan settings through `host_plan`
   (`crates/mc-module/src/providers/compaction.rs:21-51`); the new real-route case
   checks each setting separately, both together, and plain Setup succeeding.
   No admission change was necessary.

### Final Linux gates

Every Cargo command used `test "$(uname -s)" = Linux || exit 90` through the
remote Linux runner. Cargo: `1.99.0 (5f94df478 2026-08-27)`; rustc:
`1.99.0 (b940084d7 2026-09-28)`; Clippy: `0.1.99 (b940084d7e 2026-09-28)`.

- `cargo test -p mc-module --test broca_conformance --features drive-fault`:
  **13 passed**, none failed.
- `cargo test -p mc-module --lib --features drive-fault`:
  **1748 passed**, none failed, 22 ignored (1770 total).
- `cargo test --locked -p mc-store`:
  **287 passed**, none failed, 4 ignored (291 total); zero doctests.
- `cargo clippy --locked -p mc-module -p mc-store --all-targets -- -D warnings`:
  **passed** for both requested packages and their targets. The first run found
  three baseline feature-off warnings in the new S4 suite; imports and the
  `wait_fault` helper are now gated by `drive-fault`, matching their only caller.
- The first library run after removing the permission OR failed four host
  transport-bootstrap tests. Preserving frozen transport replay separately from
  mutation permission fixed all four without changing those tests.

The runner temporarily refused jobs with `runner_draining`. Verified fixes were
committed, then the parent requested a WIP checkpoint of the remaining work.
All gates above ran after recovery; no Cargo command ran locally. Fault-enabled
builds still report pre-existing Rust 1.99 deprecation warnings for atomic
`fetch_update`; the required feature-off Clippy gate is clean.

### Mutation controls

Each control temporarily reintroduced a known wrong behavior to prove its
named test actually detects the regression. The change was marked
`NON-VACUITY BREAK` and made from an explicit staged live snapshot, with a
non-empty `git diff --stat` while applied, and
`git checkout -- <path> && touch <path>` followed by an empty diff after restore.
No mutation remains. Names below are exact Rust test names; no other test failed.

- Restore the configured time-to-live in runner execution instead of internal
  `cache_ttl = "never"`: only
  `compaction::pending_history_below_threshold_preserves_last_view` failed
  (`compaction_message` instead of `noop`; 1 failed, 11 filtered at execution).
- Restore the independent permission OR: only
  `transform::tests::compaction_adapter_tests::pipeline_switch_does_not_override_exact_engine_prefix_permission`
  failed (`true` versus `false`); the other 13 adapter tests passed.
- Remove observed tags from the two added displacement groups while preserving
  transcript length: only
  `compaction::below_threshold_noops_crossing_once_history_drops_and_stable_prompts`
  failed (pending tags `[1]` instead of `[]`; 12 filtered).
- Restore the unconditional `Queued` acknowledgement: only
  `compaction::protected_drop_is_held_across_rebuild_until_newer_groups_displace_it`
  failed on the missing `Held` reply (12 filtered).
- Restore the stale context-ceiling expectation: only
  `tests::supported_fences_report_plugin_and_store_ceilings` failed
  (`context.db=97 store.db=66` versus `context.db=96 store.db=66`; 1769 filtered).
