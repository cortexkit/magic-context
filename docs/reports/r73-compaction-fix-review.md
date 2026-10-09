# R7.3 compaction fix correctness review

## Scope and result

Reviewed `185d0e7b..0b81ddc1551f80fad4a2ef90c05b327265a18f46`, including
`aa3b016b`, `ca4c9343`, `0109cd19`, and `0b81ddc1`. Read the original and
follow-up results in `crates/mc-module/tests/broca_conformance/REPORT.md`.
Product code is unchanged by this review; temporary mutations were restored.

**One remaining correctness defect:** a non-structurally rejected/lost view can
supersede a subsequent genuine rebuild. It can leave the runner serving old
bytes after the engine has consumed a queued drop and committed newer history.
This is a **pre-existing retry defect**, not evidence that the four fixes
introduced a new TTL or protection regression. The retry branch predates this
range (commit `2075c482d98`, established with `git blame`). Failing regression
tests accompany the report.

The runner TTL override, exact prefix permission, held acknowledgement, and
four-group fixture behaved as intended in the executed controls below. This is
not an unconditional approval of all combinations of compaction and retries.

All product-source line references below refer to reviewed HEAD `0b81ddc1`.

## Finding: an old retry view hides a genuine model rebuild

**Severity: P2 / medium.** Engine state and runner-visible state diverge; a drop
can be recorded as released while its original content remains visible. The
mismatch survives acknowledgement and a following noop. A later independent
rebuild can recover the view, but normal low-pressure defers cannot.

**Input (real host provider handler, not a mocked transform):**

1. Set up an OpenCode host conversation at 1,000 / 100,000 tokens. Admit raw
   messages `m1..m4`, including an observed hook tag 1 for `m4#0` (`raw 4`).
   Publish `BASELINE-HISTORY` covering ordinal 1. Apply the bootstrap view.
2. Publish `SECOND-HISTORY` covering ordinal 2. Signal a cold rebuild. The
   resulting view contains the second history and raw messages 3 and 4, but its
   answer is lost/not applied.
3. Publish `NEWEST-HISTORY` covering ordinal 3 and queue tag 1 for release.
   Report the bootstrap as `last_applied`, the lost view as
   `last_not_applied { reason: "late" }`, and change the model to `new-model`.
   Test both with and without `prefix_rebuilding { reason: "pipeline_switch" }`.

**Expected:** the independently authorized model rebuild returns the current
engine view: history includes `NEWEST-HISTORY`, `raw 4` is released, and the
queue drains only in conjunction with that returned view. Retrying a lost view
unchanged is correct only if that view still represents the engine's output.

**Actual:** a higher-version `compaction_message` reuses the earlier replacement.
The engine records the new model, coverage ordinal 3, the new history in frozen
m0, and empty provider/engine drop queues, but the answer still contains the old
history and `raw 4`. Reporting that stale replacement as `last_applied` on
the next step returns `noop`: the provider leaves the stale runner view in
place rather than sending the engine's newer view.

**Cause:** `crates/mc-module/src/transform.rs:2625-2629` unconditionally allocates
`state.last_produced` for a relevant non-structural rejection, even when the
candidate generated at `:2612-2618` represents a new genuine rebuild. It does
not compare that retry against the current candidate. The host then preserves
the previous native wire view and coverage at
`crates/mc-module/src/providers/compaction.rs:530-539`, because they match the
adapter's stale replacement. The transform has already committed the new engine
state and drop consumption before this transport choice.

**Regression tests:**

- `providers::compaction::compaction_review_tests::r73_late_transport_copy_cannot_hide_independent_model_rebuild`
- `providers::compaction::compaction_review_tests::r73_late_view_without_pipeline_switch_cannot_hide_independent_model_rebuild`

The second is a no-pipeline-switch control for the same defect, distinguishing
it from a regression introduced by `transport_replay`. Both assert the concrete
history marker and actual queue/store state rather than deriving the expected
answer from the adapter's own retry predicate. No product fix or existing
expectation was changed.

## 1. Runner-owned expiry

The new override is inside runner `execute`, at
`crates/mc-module/src/providers/compaction.rs:673-677`. It does not change the
common policy builder at `:390-425`, the configured/returned TTL, or whole-request
plugin transforms. Host `execute_host` already had its separate internal
`never` override at `:465-473`; host expiry remains a host-reported rebuild,
not a scheduler clock synthesized from absent response observations.

Executed checks:

- The original 13 real-route Broca conformance tests passed, including pending
  history at 1% fill, stable defers, the threshold crossing, and held drops.
- A temporary whole-request transform probe exercised `opencode-aisdk`, `pi`,
  and `claude-code-anthropic`. With a trusted recent response, the warm pass
  had false prefix permission. With the same observed response and more than
  one hour elapsed, each selected `HARD` and true permission. Claude Code's
  default one-hour policy was deliberately respected rather than assuming
  that its default is five minutes.
- Pi's seven real-transform idle/queued-drop tests passed, including warm-cache
  retention and failed requests not resetting the response clock.
- Host record tests passed the rule that plain publications and queued drops
  are not rebuild opportunities. The full Rust library also passed the real
  host cold/expiry cases and common TTL policy tests.

**True idle in Broca:** elapsed wall time alone cannot open the runner gate now.
That is the intended runner-owned rule, not starvation if the runner signals
cold. A temporary real-route test,
`compaction::review_runner_low_fill_cold_rebuild_and_older_ack_preserve_held_drop`,
used a two-group protected target, published later history, and kept usage at
1,000 / 100,000. A no-signal pass with `now: 86400000` returned `noop`; the
following `prefix_rebuilding { reason: "cold" }` pass returned a replacement
containing `SECOND HISTORY` while retaining the protected drop. Acknowledging
that view, then reporting the older bootstrap acknowledgement, preserved the
new applied version and pending `[1]`. The route uses the process response
clock, not the request's `now`, so the timestamp is not a fabricated engine
expiry oracle; cold is the actual tested authorization.

The signal path exists: status parsing at `providers/compaction.rs:595-601`
recognizes cold as `prefix_rebuilding`, runner execution calls the adapter at
`:701-703`, and `transform.rs:2564-2569` advances the rebuild epoch independently
of the threshold. The existing conformance held-drop test already signals
cold after displacement, but at 70% fill; it alone would not establish the
low-fill cold case. These are provider/adapter tests: the separate Broca caller
executable was not run, so autonomous cold detection by that caller is not
claimed.

## 2. Frozen host transport copy and exact permission

The new `transport_replay` branch constructs its candidate from **this pass's
engine response** (`transform.rs:2604-2618`). It is not an extra independently
retained served-view cache. Model identity, upgrade identity, module render
epochs, and recomp still reach the engine; the branch does not authorize
queued work on its own. The current engine permission is returned unchanged.

Executed coverage:

- All 14 original compaction adapter tests passed on unmutated HEAD; the exact
  permission case holds an unconsumed pending drop and returns `Noop` when the
  engine denies permission.
- The full library passed the unchanged native host
  `soft_plus_pipeline_switch_preserves_the_full_request_head_bytes` test, and
  the host upgrade/render-epoch comparisons, randomized host/full-engine
  comparison, recomp summary, and restart controls.
- A temporary direct adapter matrix started with a real frozen m1 delta,
  checked byte-identical pipeline adoption with false permission, then tried
  cold rebuild, model change, upgrade change, recomp reset, and store/state
  restart. The first four produced changed views followed by byte-identical
  noops; restart preserved the frozen bytes and returned noop.

Those ordinary paths passed. The finding above is the exception: the older
retry branch can choose a previous view instead of the freshly constructed
candidate. It also fails without a pipeline switch. Thus the preserved
transport copy does not itself originate a bust, but existing retry handling
can serve bytes different from the engine on a genuinely rebuilding pass.

## 3. What changed in the acknowledgement

`providers/step_transform.rs:231-235` still queues exactly the same valid,
not-already-pending tags before forming the reply. The change at `:238-262`
loads persisted tags and the frozen/effective floor and calibration, computes
the shared `ProtectionWindow`, and divides newly queued tags into `Held` and
immediate `Queued` reply sets. Configured protected-tool IDs are also held.
It is a `ctx_reduce` text acknowledgement correction, **not** a change to
`last_applied` version semantics or queue consumption.

The companion test passed a held-only request, retained tag 1 across a genuine
history rebuild, and released it only after displacement plus a new cold
rebuild. The temporary low-fill test also obtained `Held` before its first
compaction step: reduce's transcript scan had already observed/persisted the
tag, so the response did not depend on an earlier step seeding tag rows.

The full library's mixed/free/held and duplicate acknowledgement tests passed.
The temporary older-ack check described above preserved the newer applied
view; version high-water updates use `max` at `transform.rs:2535-2547`, and
promotion requires the current produced version. The remaining finding drains
an eligible, unprotected drop while returning stale bytes; it is not the new
held-reply partition skipping a protected drop.

## 4. Four-group fixture and shared protection

The eligible-drop fixture now has distinct observed tool tag groups 1, 2, 3,
and 4. The newest-three suffix is `{2,3,4}`. Tag 2's newer output alone exceeds
the 4,000-token floor (the fixture asserts that with the tokenizer), and tags
3/4 add more mass. Therefore the token-floor suffix need not reach tag 1;
its union with the newest three still excludes tag 1. The two-group companion
must protect both tags even though tag 2 pays the floor.

This follows the complete-tie-group, reverse persisted-row rule at
`protection_window.rs:72-132`, not a live-message ordinal approximation. The
engine passes that same calibrated member-row set to selection at
`transform.rs:5451-5458,5508-5541`; the new acknowledgement uses its tag-number
projection. No protection policy code changed in the reviewed diff.

Both conformance scenarios passed. The Rust F1-F9 TypeScript-generated golden
passed, and all 20 TypeScript shared-window tests passed, including ties,
structural minimum, short histories, floor snapshots, and calibrated tool mass.
The companion's retention assertion was independently mutation-tested at the
selection predicate, as detailed next.

## Independent mutation evidence

These are new executions for this review, not repetitions of claims from the
worker's report. Before each mutation, the current source files were added to
the Git index so restoration would recover the tested implementation, not an
older checkout. Each mutation
was marked `NON-VACUITY BREAK`, and was restored with
`git checkout -- <path> && touch <path>`. `git diff --stat` was empty before
mutation and after restoration. The applied stat for each control below was
one file, **2 insertions / 1 deletion**.

- Runner `execute`: restore configured TTL instead of internal `never`.
  `compaction::pending_history_below_threshold_preserves_last_view` **failed**,
  `compaction_message` versus `noop` at 1% fill.
  `compaction::fresh_setup_ready_with_initial_view` passed.
- Adapter: restore `engine.response.prefix_bust_permitted ||
  status.prefix_rebuilding`, letting a status signal grant permission even when
  the engine denies it.
  `transform::tests::compaction_adapter_tests::pipeline_switch_does_not_override_exact_engine_prefix_permission`
  **failed**, true versus false. The other 13 adapter tests passed.
- Selector: neutralize the token/newest-three part of
  `SelectionContext::block_is_protected` at every caller.
  `compaction::protected_drop_is_held_across_rebuild_until_newer_groups_displace_it`
  **failed at the served-content retention assertion**, line 330; the Held
  reply itself still passed. `compaction::fresh_setup_ready_with_initial_view`
  passed.

Two earlier mutation attempts did not fail their selected tests. They qualify
which code the successful mutation checks actually exercise:

- Removing **only** the early `select_agent_drops` protection check at
  `selection.rs:1177` did not redden the held-drop test; both it and fresh Setup
  passed. This does not mean the retention test cannot observe protection:
  the final shared protection filter at `selection.rs:1880-1905` remained.
  Neutralizing the shared predicate above reached the same source/target and
  did redden retention. The single-guard mutation is recorded as **undefended**
  (neither selected test failed),
  not as proof of a product defect or of bypassing all protection.
- A TTL override mutation first matched **host** `execute_host`, not runner
  `execute`. The runner publication and fresh-Setup cases both passed because
  that branch was not reached. It was restored, the diff was inspected to
  confirm the runner hunk, and the correct runner mutation then failed only
  the intended publication test. The wrong-lane attempt is **not reached**,
  not positive runner-expiry evidence.

All five mutations listed above (runner TTL, permission OR, shared protection
predicate, early protection guard, and wrong-lane host TTL) had a nonempty diff
while applied and an empty diff after restoration. This confirms that each
control was actually applied and removed; passing tests for an ineffective
control are not positive behavioral evidence. No mutation or temporary passing
probe is committed.

## Verification record and limits

Every Cargo and Bun execution used `runon: "linux"`, the guard
`test "$(uname -s)" = Linux || exit 90`, and a background task awaited with
`bash_watch`. No Cargo command ran on the Mac. Versions: Cargo
`1.99.0 (5f94df478 2026-08-27)`, rustc
`1.99.0 (b940084d7 2026-09-28)`, rustfmt
`1.10.0-stable (b940084d7e 2026-09-28)`, Bun `1.4.2 (744846f84)`.

Commands are relative to the repository root, following the guard above:

```sh
cargo test --locked -p mc-module --lib --features drive-fault
cargo test --locked -p mc-module --test broca_conformance --features drive-fault
cargo test --locked -p mc-module --test protection_window_golden
cargo test --locked -p mc-module --lib --features drive-fault providers::compaction::compaction_review_tests::r73_ -- --nocapture
rustfmt --check --edition 2021 crates/mc-module/src/providers/compaction_review_tests.rs
bun test packages/plugin/src/features/magic-context/protection-window.test.ts packages/pi-plugin/src/idle-ttl-pending-drops-pi.test.ts packages/plugin/src/hooks/magic-context/host-runner/record.test.ts packages/plugin/src/hooks/magic-context/host-runner/record-review.test.ts
```

- Unmodified HEAD library baseline: **1748 passed, 0 failed, 22 ignored**, 1770
  tests. The ignored tests include private/performance fixture requirements.
- Final restored library run: **1748 passed, 2 failed, 22 ignored**, 1772 tests.
  The only failures were the two added stale-view regressions named above;
  all original tests remained green. The test target compiled successfully.
- Original and final restored executable conformance runs: **13 passed, 0 failed**.
- Rust shared ProtectionWindow golden: **1 passed**.
- Formatting check on `compaction_review_tests.rs`: passed (one Rust file).
- Bun runtime/protection controls: **70 passed, 0 failed**, 99,702 assertions
  across four files (20 shared-window, seven Pi TTL, 43 host record tests).
- Temporary direct adapter/whole-request controls passed the three-profile TTL
  and five-event lifecycle matrices. The first simple retry fixture lacked an
  observable newer payload and also passed; adding a new history publication
  made the stale retry visible. The committed handler regressions use that
  observable payload and actual queued-drop consumption.
- Temporary real-route low-fill cold / older acknowledgement probe: **1 passed**.
  It and the temporary integration file were removed to keep delivery to the
  requested report and failing tests.
- Both committed handler regressions expect the returned replacement to
  contain the newest published summary marker, `NEWEST-HISTORY`. They fail
  because that marker is absent, after verifying new engine coverage/model/history,
  empty queues, and noop following acknowledgement. This is an intentional red
  delivery, not a claim that the final library suite is green.

The Rust test compilation is the authoritative type gate. Scoped IDE inspection
was partial because local rust-analyzer was still indexing/proc-macro warming;
its reports were not treated as compiler findings. Fault-enabled runs emit the
existing atomic `fetch_update` deprecation warnings. No manifests or lockfiles
changed; no package install was needed. Product build/lint and live host E2E
suites were not repeated for a report/tests-only change. In particular, these
checks establish that the provider honors a cold signal and shares the runtime
cache rules. They do not establish that a live Broca caller notices actual
provider-cache expiry and sends that signal without external intervention.
