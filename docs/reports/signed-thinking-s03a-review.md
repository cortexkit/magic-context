# Correctness review: signed-thinking hold, placeholder/system strips (s03a)

Reviewed range: `cc8617ece9f2fa51c8fb34eb542b570e7400877c..2c6a14548ef6aef44563b363f340c4a0b66aaa20`.
Here **base** is the first revision and **head** is the second. A **thinking
boundary** is the last kept signed-thinking block in the current real user's
turn: an earlier history edit would invalidate that signature. A **refresh
signal** requests permission to rebuild the cached history head; a held edit is
not applied until a pass can do so without invalidating kept thinking.
This delivery changes only this report and opt-in review tests, not product code,
existing test expectations, manifests, `ARCHITECTURE.md`, or `STRUCTURE.md`.

## Summary and rollout consequence

The ordinary discovery paths exercised here correctly hold placeholder/system
strips, leave no new frozen removal, and release them on an already-authorized
safe pass. The Pi history signal parks and releases once in an uninterrupted
process. No wire-byte or bust-verdict regression was observed in the exercised
non-prefix-bound or never-thinking differential corpus.

**Do not certify the stronger claim that every placeholder/system edit now passes
admission.** Pi's stable-ID rediscovery exemption can remove a placeholder that
was actually sent before kept thinking. The reminder-strip persistence issue
also exists on both revisions. These are pre-existing defects, not evidence of a
new non-Claude regression. The Rust profile premise in the brief is false: the
system strip planner is not OpenCode-only, on either revision.

There is no rollout setting for this behavior. **It reaches Claude users as soon
as the migration branch ships. Any edit kind not yet routed through admission
(for example trailing-blank cleanup) is visible to those users then.** The
remaining design steps cannot be treated as dormant code behind an opt-in flag.
The findings below distinguish this slice's improvements from the complete
signed-prefix guarantee, which this review does not establish.

## 1. Unchanged behavior: differential and consumer probes

### Five-host audit request corpus

Complete baseline sources were exported with `git archive`, not assembled from
selected old files. Both trees used the same installed dependencies; manifests
and lockfiles are unchanged. All builds/tests ran on Linux with `runon:
"linux,8c"`. Rust used distinct absolute target directories ending in
`.s03a-review/target-base` and `.s03a-review/target-head`; each source tree was
compiled separately. There was no shared-target stale-binary comparison.
Throwaway `HOME`, in-memory SQLite, and temporary Rust stores were used. No live
database/config or real provider was accessed.

I captured every pass of the existing `signed-thinking-prefix-audit` suites in
default and strict **capture** modes at both revisions. Hosts were TS v1, TS v2,
Pi/OMP, Rust `opencode-aisdk`, and Rust `claude-code-anthropic`. Capture mode mints
independent provider receipts but deliberately bypasses audit assertions; its
exit status is not a validity verdict. The comparison was of **all common
`wireBytes` and `bustedThisPass` values**, without the existing comparator's
identity-eligibility skip or exception allowlist.

| Model/driver | Base captures | Head captures | Common | Missing base passes | Changed wires | Changed bust verdicts |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `claude-opus-4-6` (not prefix-bound) | 7,086 | 7,442 | 7,086 | 0 | 0 | 0 |
| `claude-opus-5-5`, no thinking minted | 7,086 | 7,442 | 7,086 | 0 | 0 | 0 |
| `claude-opus-5-5`, thinking minted | 7,086 | 7,442 | 7,086 | 0 | 70 | 12 |

The 356 additional files per driver are added fixtures, not baseline equivalence
evidence. Default/strict capture files count separately. For the never-thinking
variant, temporary **test driver** copies call the TS/Pi mock with `false` and
filter reasoning from Rust fixture ingress; no engine code is modified. All
7,442 head no-thinking captures report no thinking boundary.

Every common prefix-bound wire difference is in the placeholder mid-loop lane:
TS v1 18, TS v2 18, Pi 10, Rust OpenCode 12, Rust Claude Code 12. The changed bust
verdicts are the all-held placeholder opportunity/release cases: four per Rust
profile and two per TS generation. There are no common differences in unrelated
lanes. These counts include both audit modes; they are not 70 independent
production incidents. The requested defer, execute/pressure, flush, historian
fold, model-switch and restart scenarios are included in the audit pass inventory.
The added targeted release tests below cover Pi history specifically.

This is a finite fixture comparison, not exhaustive enumeration of every model
or proof of the full transport envelope. The audit wire projection omits host
fields that the provider serializer does not send; it is not the live host's
HTTP body capture. The newly added system lane is not a common baseline fixture,
so its strict controls, rather than the common-file count, establish its exercised
hold/release behavior.

### The actual sanitized captured-session corpus: gate incomplete

The repository's captured-session fixture is
`packages/e2e-tests/fixtures/parity-hunt-14-session-shape.json`, distinct from the
synthetic audit corpus. I attempted:

```sh
# Linux, throwaway HOME, OPENCODE_DB unset
bun run --cwd packages/e2e-tests replay:transform-wire-parity
```

It failed before serving any request: `RustTestHarness prerequisites unmet:
sibling subconscious source not found ... needed to build the ck-subc daemon`.
The existing runner requires that separate daemon source checkout and only
provides TS/Rust lanes, not Pi. **No successful differential on that captured live
session structure is claimed.** Running the five-host golden corpus is not a
substitute for this missing gate. The next action is to provision the lock-pinned
hermetic daemon source for the existing runner, then capture both revisions with
separate target directories and compare their served requests. No compatibility
shim or edit to the runner was invented.

### Five Pi consumers, no hold

Five separately named runtime tests in
`packages/pi-plugin/src/signed-thinking-s03a-review.test.ts` pass on **base and
head**, each exercising raw refresh `false` then `true` after warmup, with no kept
thinking and no parked trigger:

| Test prefix (`... preserves the raw refresh signal without a hold`) | Observed seam | Product location |
| --- | --- | --- |
| `note nudges` | `observeNoteNudgeServe.isCacheBustingPass` | `context-handler.ts:3934-3951` |
| `synthetic todo` | `injectSyntheticTodowriteForPi.isCacheBusting` | `context-handler.ts:4045-4056` |
| `historian publishedHistoryRide` | `checkCompartmentTrigger` reclaim ride's `publishedHistory` | `context-handler.ts:3881,5519` |
| `proactive thinking strip` | `applyPiProactiveThinkingStrip.cacheBustingPass` | `context-handler.ts:4139-4143` |
| `last-good envelope` | outgoing `estimatePiOutgoingInputTokens` invocation | `context-handler.ts:4384-4407` |

The historian trigger is stubbed to return `shouldFire:false`; the supplied
runner throws if called. Other spies call the real functions. The fit-envelope
probe asserts absence of an outgoing estimate on the unheld low-pressure defer
and presence on refresh; there is no boolean argument at that seam. The first
four observe the actual boolean received, not a source-text regex. Result: 5
passes on each tree. The permission helper also returns the raw signal unless
that signal has previously been parked under a boundary (`trigger-parking.ts:25-35`).

## 2. Kept Pi signal: once-only release and restart

Four added tests pass:

- `history refresh releases once at new user`
- `history fold releases once at new user`
- `history refresh releases once at model change`
- `history fold releases once at model change`

Each starts with a served placeholder and independently minted thinking, offers
a refresh, then runs three more boundary-bearing passes. The signal remains
kept; none of those later passes busts or discovers the placeholder. The first
boundary-free pass removes the placeholder and drains the signal/parking bit.
Its immediate repeat and a subsequent user turn do not bust again. The model
switch is to non-prefix-bound Opus 4.6; a switch between prefix-bound models is
not treated as a safe release. A separate passing test, `history fold without a
hold consumes the raw refresh once`, exercises publication with no hold.

`context-handler.ts:6453-6496` computes permission to rebuild the history head;
`:7802-7813` parks or drains
a successfully handled refresh, and `:8238-8245` settles its mask. The first
held pass can see the raw permission; **later** boundary passes cannot reuse it.
On release it rides the ordinary injection/fold pass, not a separate additional
rebuild. Existing strict parking tests also pass with the longer tool-loop fixture.

### P2 limitation, planned durability gap: restart loses a pure kept refresh

Location: `packages/pi-plugin/src/context-handler.ts:8827-8865`
(`clearContextHandlerSession` deletes the history signal and parking map).
Failing test: **`a kept history refresh survives restart until safe release`**.

The test clears process-local session state and registers a new handler while
retaining the same database and raw history. At the next user, the placeholder
is still present: `[dropped §998§]`. A later explicit refresh can rediscover and
remove it on one permitted pass; its repeat does not rebuild again. Restart
therefore loses a refresh whose only pending cause is the in-memory signal,
not the stored cached
head, and does not create two release rebuilds. This is the expected limit of
in-memory parking in this slice, not a newly introduced durable-storage
regression. Base drains history on the initial held pass rather than preserving
it; it does not provide durable release either. The head-only failing test
expresses the later design's durability requirement. It is not counted as a
base/head regression reproducer. This fixture resets the owning session module
state; it is not a separate OS-process crash/JSONL reopen experiment.

## 3. Holding/releasing strips and the two exemptions

Strict checks with audit assertions enabled (not capture mode) pass on head:
16 TS/Pi tests selected by
`frozen-sentinel first application`, `system-injected neutralization`, and the
history-parking names. They assert the lane did not land mid-loop and did land
at the next user; the provider mock accepts both held and release requests.
Rust's `SystemInjected` strict run passes all 17 selected-suite tests, including
actual OpenCode primary/subagent hold and new-user release controls. Its Claude
Code lane loops exclude `SystemInjected`, so those three Claude Code test names
are **not** evidence of coverage of that lane.

Added TS tests vary the edited message's position relative to kept thinking,
for both placeholder and system text:
whole-message edits before thinking hold without first-application callbacks;
tail edits admit; a real user admits the previously held coordinate; repeating
the strip makes no additional discovery. This tests the same frame/callback
combination used at `transform-postprocess-phase.ts:2020-2063,3361-3394`.

### Compaction seam: valid only for actually hidden messages

The added TS hidden-message control passes: stripping the hidden collection
leaves the visible collection byte-identical. Source checks supply the important
caller condition, rather than assuming every supplied hidden collection is safe:
`transform.ts:1786-1808` excludes both initial refresh inputs under `freezeM0M1`,
so `:2184-2215` assembles no hidden-seam list on a frozen signed-prefix pass.
`:2301-2323` selects a broader **tagging** input, not restoration into the served
array. `selectHiddenMessagesAtCompactionSeam` (`inject-compartments.ts:407-420`)
selects references from the skipped prefix; it is not itself an admission check.
The exemption is justified for messages absent from the served request, not for
arbitrary references relabeled "hidden". No seam-specific failing case was found;
this is not a claim that recomputing the visible raw-history cut after a
compartment rewrite is safe; that can expose or hide already-signed prefix text.

### P1 finding: Pi stable-ID rediscovery is not necessarily replay

Locations: `packages/pi-plugin/src/strip-placeholders-pi.ts:148-161,194-225`;
caller `packages/pi-plugin/src/context-handler.ts:3443-3475,7834-7867`.
Failing tests, on **base and head**:

- **`stable-id cutover must not remove a placeholder that was previously sent`**
- **`handler stable-id migration preserves a sent placeholder under thinking`**

The cutover scans every current message; `forceDiscovery` short-circuits the
`admit(...)` permission callback rather than limiting discovery to messages
proved to have been omitted under an old ID. The narrow test
seeds one legacy omission, but a different placeholder was actually in the
request that minted the kept signature. Cutover removes both, despite an
admission frame explicitly denying the fresh coordinate. Its wire-prefix
assertion fails: expected user plus `[dropped §3§]`, received user alone.

The full-handler reproducer starts with the session manager's lookup of
branch-entry IDs temporarily unavailable,
serves the marker, mints thinking from that served request, and later makes real
entry IDs available. The real context handler's cutover removes the marker while
keeping thinking. The mock then reports:

```text
400: Invalid `signature` in `thinking` block: bound to a different conversation
```

The pre-cutover request is accepted. Thus this is not just an uncalled helper
callback or a fabricated setter. The exemption's comment claims prior omission
without checking it. It is a carried-forward safety hole in the changed strip,
not a new regression against base. A future fix must translate only known old
omissions as replay and apply admission to newly discovered occurrences; this
review deliberately does not change product code.

## 4. P1 finding outside the diff: rejected reminder strips leak frozen state

Locations: `packages/pi-plugin/src/heuristic-cleanup-pi.ts:593-613`;
`packages/plugin/src/hooks/magic-context/latest-assistant-turn.ts:95-118`;
`packages/pi-plugin/src/context-handler.ts:7593-7610`;
`packages/pi-plugin/src/reminder-strip-pi.ts:63-100`.
Failing test, on **base and head**:
**`a rejected reminder strip must not freeze a replay decision`**.

The fixture uses the real Pi transcript adapter, tagger, database, and thinking
protection wrapper, not a made-up setter. A user text contains ordinary words
plus a reminder, before current-turn signed thinking. The wrapper is rewrite
protected; cleanup reports zero stripped injections and leaves its target's
text unchanged. Nevertheless it first records `reminder-strip`, then calls the
setter, which returns false. The recorded `reminder-strip` decision is not rolled
back after that rejection.

Reminder replay subsequently receives the original, unguarded targets, before
commit. It strips the reminder in the same pipeline ordering and again on a
fresh next-pass adapter over the original raw messages. The diagnostic is
`persisted=true served="words" next="words"`; the thinking/signature is unchanged
on both outputs. The assertion requiring the reminder to remain fails. Thus the
answer to the brief's question is **yes**, and it can leak even earlier than a
later pass. This is adapter/guard/cleanup/replay integration evidence, not a claim
that every scheduler/pressure configuration selects that cleanup. The reminder-
only branch has a different guard and is not this reproducer. No base expectation
was rewritten to make this failure disappear.

## 5. Rust profiles and issue-630 guard

### P3 scope finding: system stripping is not `opencode-aisdk`-only

Location: `crates/mc-module/src/transform.rs:14942-15040`.
Failing test, on **base and head**:
**`system_message_strip_is_opencode_profile_only`**, in
`crates/mc-module/tests/signed_thinking_s03a_review.rs`.

A positive OpenCode control reaches the surgical system-strip lane. The same
boundary-free request under `claude-code-anthropic` mints
`strip:system_injected_block:notification#0`; the assertion requiring an empty
Claude Code system-unit list fails. The profile check above it selects reasoning
behavior, not system-strip eligibility. The audit fixture's `on_profile`
(`signed_thinking_prefix_audit.rs:941-946`) excludes a Claude Code **test lane**;
it is not a production profile guard. This disproves the premise that system
stripping is limited to the OpenCode profile,
but is not a newly added Claude Code system-strip feature.

The complete Claude Code profile is also not byte-unchanged in this range:
its common prefix-bound placeholder cases have 12 changed wires and 4 changed
bust verdicts. Those are the intentional placeholder hold/release effects. The
non-prefix-bound and never-thinking Claude Code common captures are unchanged.

The added enabled control
`issue630_guard_holds_system_units_before_current_turn_thinking_on_both_profiles`
passes on base and head: no system unit is minted before current-turn kept
thinking, the notification's reminder text is intact, and the signature remains
`"signed"`. The existing three `review_issue630` Rust tests also pass on head.
The pre-existing unsafe-content guard at `transform.rs:14999-15003,15028-15029`
is still present; new admission does not replace it. Therefore the incorrect
profile premise must not be confused with loss of issue-630 protection.

## Verification and reproduction ledger

Tools: Bun `1.4.2 (744846f84)`, TypeScript `5.9.3`, Biome `2.5.1`, Cargo
`1.99.0 (5f94df478 2026-08-27)`. All executable gates below ran on Linux with eight
requested vCPUs. Local commands only exported sources with `git archive` or
formatted new files.

- `bun run build`: head and complete baseline — passed, plugin/Pi/CLI packages.
  The first baseline setup lacked package-level `.bin` links (exit 127); linking
  each unchanged installed workspace dependency directory corrected that setup,
  after which the complete baseline build passed.
- `CARGO_TARGET_DIR=<distinct-tree-target> cargo build -p mc-module`: base/head
  — passed separately.
- `bun run --cwd packages/plugin typecheck` and
  `bun run --cwd packages/pi-plugin typecheck` — passed (silent `tsc` success).
- `cargo fmt --check` — passed.
- Relevant existing TS/Pi strip, reminder, signal and trigger tests plus new
  files with the flag unset: **106 passed, 18 skipped**, 7 files. The skips are the
  opt-in review probes, not missing existing strip tests.
- `MC_S03A_REVIEW=1 bun test packages/plugin/src/hooks/magic-context/signed-thinking-s03a-review.test.ts`
  — **3 passed**.
- Strict non-capture TS/Pi affected lanes — **16 passed**, 163 filtered out.
- `cargo test -p mc-module review_issue630` — **3 passed**; other targets filtered.
- `MC_AUDIT_STRICT=1 MC_AUDIT_LANE=SystemInjected cargo test -p mc-module --test signed_thinking_prefix_audit -- --nocapture`
  — **17 passed**, with the lane-loop coverage qualification above.
- Five-host captures at each revision/driver/mode: TS/Pi **171 base / 179 head
  test invocations**, Rust **17 per invocation**. Capture assertions are disabled;
  differential outcomes are recorded in §1, not inferred from these green runs.
- Enabled review file on head: Pi **11 passed, 4 failed**; Rust **1 passed,
  1 failed**. These are intentional red contract reproducers, not failed builds.
  Base Pi selected probes: **5 passed, 3 failed**; base Rust **1 passed, 1 failed**.
  The failing names are exactly those listed in the findings.
- Default Rust review target exits successfully with its two environment-gated
  test bodies disabled; it is only a gating smoke check, not two coverage passes.
- Package-scoped Biome checks of the new TS files exit 0; the Pi test file has
  non-null-assertion style warnings, not errors. No broad lint fix was applied.
- `aft_inspect` reported partial call-graph coverage and no reported diagnostics;
  package `tsc` and compiled Rust tests are the authoritative checks.
- Captured-session live-structure replay — **incomplete**, prerequisite failure
  described in §1. No full workspace suite or real-provider validation is claimed.

Opt-in failing suites are reproducible with:

```sh
MC_S03A_REVIEW=1 BUN_JSC_useOMGJIT=0 bun test \
  packages/pi-plugin/src/signed-thinking-s03a-review.test.ts --timeout 30000
MC_S03A_REVIEW=1 CARGO_TARGET_DIR=/absolute/separate/head-target \
  cargo test -p mc-module --test signed_thinking_s03a_review -- --nocapture
```

For baseline defect attribution, export `cc8617ece9f2fa51c8fb34eb542b570e7400877c`,
copy only those two new review test files into the matching package paths, and
reuse/install the unchanged dependencies. The Pi selection used was
`--test-name-pattern 'cutover must|rejected reminder|handler stable-id|unheld Pi'`;
use a different absolute Rust target directory. The new ordinary-placeholder
hold and parked-history tests rely on the head's intended contract and are not
baseline regression tests.

To reproduce the audit-byte comparison, run the existing TS/Pi and Rust audit
commands at each complete revision with `MC_AUDIT_GOLDEN` pointing at separate
capture directories, `MC_AUDIT_MODEL=claude-opus-4-6` then `claude-opus-5-5`, and
both settings of `MC_AUDIT_STRICT`. Join captures by relative filename and compare
`wireBytes` and `bustedThisPass` directly, including ineligible passes. The
never-thinking test-driver variants described in §1 provide the third comparison.
No product mutation, provider call, live database access, or compatibility shim
is needed for those comparisons. All durable findings and counts are in this
report; transient build/capture directories are not the delivery evidence.
