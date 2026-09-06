# Claude Code cache investigation: cadence fixes and wire contract

## Athena review resolution — bounded repair, refuted wildcard pin

### BLOCK resolved: three coherent observations per unchanged compartment revision

The review correctly identified that the first mid-turn fix could suppress repair indefinitely. `mid_turn=true` is no longer an active-publication-window exemption. The existing **BOUNDARY_DIVERGENCE_PENDING_PASS_LIMIT = 3** stays unchanged (`crates/mc-module/src/transform.rs:85`). Host mid-turn passes now participate in unequal-revision escalation; a wedged host with an unchanged stale revision triggers `boundary_divergence_recut` on **pass 3**, satisfying the requested by-pass-4 bound without relying on time.

To preserve healthy coalescing, `ModuleMeta.boundary_divergence_observed_compartment_seq` records the last compartment sequence counted by the repair detector (`mc-store/src/lib.rs:3708–3711`). A strictly advancing sequence proves a new publication and restarts the observation count at 1 (`transform.rs:3874–3898`). An unchanged sequence increments the count; the host flag, fresh response timestamps, and unrelated memory/notes changes do not reset it. A missing observation watermark on older metadata does not erase an already accumulated count. Existing active-historian and wrapup windows retain their prior behavior and are separate from the removed host-flag exemption.

The new observation watermark is optional serde-defaulted blob metadata, omitted when absent; no SQLite schema migration is required. It commits with the counter under the same transform CAS (`transform.rs:4337–4341`) and clears when the counter clears after convergence/repair (`:5165`). The existing store CAS/reopen test now verifies that a losing write cannot replace the winner's observed sequence and that the winner's value survives reopening (`mc-store/src/lib.rs:17709–17750`).

**Red-first executable reproduction:** `transform::tests::wedged_mid_turn_with_unchanged_stale_revision_recuts_within_pending_pass_limit` starts from the existing ASTRO stale-component damaged fixture. Every pass has `mid_turn=true`, 70% usage below force, a fresh response observation, no refresh, no active historian/wrapup, and a scheduler Defer. On the prior implementation it completed four attempts without repair and failed `left: None, right: Some(3)` (exit 101). After the fix it recuts on pass 3 with reason `boundary_divergence_recut` and coverage 2400, rather than passing because of TTL, pressure, or another HARD arm.

**Healthy arm preserved:** `cc_mid_turn_publications_coalesce_until_boundary_with_force_and_flush_escape` still supplies six distinct tiny publications and observes byte-identical m1/m0 until one boundary application. It now also asserts counter **1** and the newly observed sequence after every publish. Six publishes therefore do not mean six observations of one stalled revision. The parent explicitly chose this progress-sensitive interpretation after confirming that the constant is 3, not greater than 6. Force/Emergency/flush escapes and below-threshold boundary consumption remain green.

### PIN refuted against this branch; no wildcard behavior added

The panel's claim that TS threshold lookup appends `provider/*` candidates does not match the checked-in oracle:

- `packages/plugin/src/hooks/magic-context/event-resolvers.ts:242–257` yields provider spellings and bare names at each dash-stripped specificity level, then **ends**. There is no provider-wildcard append.
- `packages/plugin/src/shared/harness-provider-map.ts:110–120` has four input *slots* (canonical, raw, Pi, OMP), but deduplicates them. Its current maps at `:39–59` give at most two distinct provider spellings: openai/openai-codex, google/google-antigravity, or opencode/opencode-zen. Unknown providers stay identities. There is no currently reachable missing fourth provider spelling for Rust to port.
- Rust's existing canonical/raw/native order covers those current sets. It is unchanged by this review fix.

Parent ruling: **do not add wildcard support to either leg**; document the pin as refuted and pin the present behavior through the actual TS oracle. `gen-scheduler-golden.ts:104–115` now generates two cases by calling production `resolveExecuteThreshold`:

| Case | Configuration / model | TS result and Rust expected result |
|---|---|---:|
| Provider wildcard is not a threshold candidate | `{default:75, "openai/*":30}`, model `openai/gpt-6-astra` | **75**, not 30 |
| OMP-spelled override is accepted | `{default:75, "opencode-zen/test-model":70}`, model `opencode/test-model` | **70** |

`bun crates/mc-module/gen/gen-scheduler-golden.ts` generated these values; the golden diff contains only these two added cases. Both the scheduler's differential test and the config-reader differential test pass. Any future wildcard support must change the TS/Rust contract explicitly, not silently add Rust-only resolution. Direct generator typechecking also exposed stale local type assertions for the existing overflow oracle; replacing that duplicated declaration with `typeof import(...)` fixes the annotations without changing generated values or overflow behavior.

### Review mutation evidence

Every control used `git add -A` before the labeled mutation, captured a non-empty index-relative `git diff --stat`, ran the named two-test command, then restored with `git checkout -- <path> && touch <path>` and captured an **empty** index-relative diff. All controls were restored before final gates.

| Control | Applied diff / restored diff | Exact red test and unaffected control | Actual failure |
|---|---|---|---|
| Restore unbounded `req.mid_turn` publication exemption | `transform.rs`: 2 insertions, 1 deletion / empty | `wedged_mid_turn_with_unchanged_stale_revision_recuts_within_pending_pass_limit` FAILED; `permanently_unequal_compartment_revision_escalates_on_third_pass` passed | `left: None, right: Some(3)`; 1 passed / 1 failed; exit 101 |
| Ignore actual compartment-sequence progress | `transform.rs`: 1 insertion, 2 deletions / empty | `cc_mid_turn_publications_coalesce_until_boundary_with_force_and_flush_escape` FAILED; wedged-turn regression passed | observation counter `left: 2, right: 1`; 1 passed / 1 failed; exit 101 |
| Add unsupported provider wildcard candidates to Rust | `scheduler.rs`: 2 insertions / empty | `execute_threshold_config_matches_typescript_percentage_goldens` FAILED; `execute_threshold_object_lookup_and_project_floor_preserve_model_identity` passed | case `provider wildcard keys are not threshold candidates`: `left: 30.0, right: 75.0`; 1 passed / 1 failed; exit 101 |

### Review final gates

- `cargo test -p mc-module -- --test-threads=2` — **exit 0**, 1058 library tests passed, 4 ignored; binary golden and both integration tests passed; doc-tests passed. Unpiped, bounded concurrency as in the prior gate.
- `cargo test -p mc-store` — **exit 0**, 135 tests passed; doc-tests passed.
- `cargo clippy -p mc-module -p mc-store --all-targets -- -D warnings` — **exit 0**.
- `cargo fmt --all -- --check` — **exit 0**.
- `bun crates/mc-module/gen/gen-scheduler-golden.ts` — **exit 0**; actual TS oracle produced the negative wildcard and positive OMP cases.
- `bun run --cwd packages/plugin typecheck` — **exit 0** using the repository's tsc script.
- `bun run --cwd packages/plugin tsc --noEmit --skipLibCheck --target esnext --module preserve --moduleResolution bundler --types bun-types ../../crates/mc-module/gen/gen-scheduler-golden.ts` — **exit 0** for the changed generator itself. Initial direct checking found stale pre-existing overflow return annotations, now corrected as described above. An initial root `node_modules/.bin/tsc` path was absent; the package-local compiler is the successful gate.
- Golden generation initially could not load zod; `bun install --frozen-lockfile` inside this worktree restored the locked workspace dependencies. No package manifest or Bun lockfile changed. Generated Cargo path-dependency lockfile churn is excluded/restored before commit.
- `aft_inspect` completed fresh but had no authoritative reports for the scoped Rust/generator files; Cargo/tsc are the verification authority.
- Sidekick reviewed the two changed comments and flagged none.

The bounded observation rule in this section supersedes the initial host-flag exemption described in the earlier follow-up narrative below. No module bounce, live store mutation, or master push was performed.

## Follow-up finding (1): mid-turn coalescing was missing at both ends

**The six m1 changes were genuine publications but their immediate application was an economic cadence defect.** Native forwarded requests 12967/12969/12972/12974/12978/12979 all end in `user` messages containing `tool_result`, preceded by assistant `tool_use` (sometimes text plus tool_use). Tool results complete a tool *arc*, not the assistant's multi-step *turn*.

The six exact module-request dumps are copied into `module-requests/` (stems `7806ca56f600f253`, `790ec5474d110332`, `ac6a161b6a97288c`, `7abe84edcbe86b31`, `2ba035ffb1a0a9cf`, `bf5fd4b408955d46`). **Every dump omits `mid_turn` and `effective_execute_threshold`.** The parent additionally confirmed that THALAMUS's `crates/thalamus-module/src/subc_transform.rs:143–190` request type has no mid_turn field; that external source finding is attributed to the parent, not presented as a worktree source inspection.

Consumer default: `TransformRequestWire.mid_turn` is `#[serde(default)] bool`, not Option (`crates/mc-module/src/transform.rs:973–974`), and decode copies it to the transform input (`:1061`). Missing therefore means **false**. Previously it controlled provisional assistant identity/strip exemptions, but neither scheduler input used it: both called `tail_state_from_live(&live)`, whose paired-result logic considered these tool arcs closed. Even adding the missing wire flag alone would therefore not have fixed the old module.

**Implemented:** both the compaction-enabled and additive-only scheduler calls now supply `req.mid_turn` (`transform.rs:2740,3948`). `tail_state_from_live` honors true before its legacy unpaired-arc fallback. With no host continuation assertion, a newer real user content block also closes an interrupted assistant turn even if an old tool never answered; user-role tool-result blocks alone do not. The shared scheduler's existing boundary deferral (`scheduler.rs:559–579,792–805`) then returns Defer with `mid_turn_boundary`, preserving a durable deferred Execute intent. `apply_scheduler_meta` persists the intent on Defer and clears it on a successful non-Defer commit; normal transform CAS means failed work does not commit the clear. Every request re-evaluates the current host flag and live tail rather than treating the old deferred flag as proof the turn ended.

The red-first test exposed a second interaction: after three withheld publishes, the existing boundary-divergence detector would interpret deliberately unapplied coverage as damage and force an m0 HARD. The initial follow-up made **host mid-turn plus an unapplied compartment revision** a legitimate-publication window. Athena correctly identified that as unbounded; the review resolution above replaces it with progress-sensitive three-pass observations. Already-acknowledged revisions keep the repair path, and real new publications reset the count so healthy coalescing does not simply move repeated loss from m1 to m0.

TS twins: OpenCode `read-session-db.ts:135–200` retains mid-turn for newest-assistant `finish === "tool-calls"` or a non-provider-executed tool part, absent a newer real user message. Pi `read-session-pi.ts:146–222` retains it for `stopReason === "toolUse"` or an unpaired tool call, absent a newer real user message. Shared `boundary-execution.ts:13–21,38–67` applies the same force/explicit-bust/subagent exceptions and `mid_turn_boundary` vocabulary. These predicates do not equate user-role tool-result carriers with user-authored turn boundaries.

**Proof:** `cc_mid_turn_publications_coalesce_until_boundary_with_force_and_flush_escape` supplies six tiny two-ordinal publications across six `mid_turn=true` requests at 75%. m1 and m0 remain byte-identical throughout; all six compartments apply together in one SOFT at the boundary. It separately verifies a boundary at 10% still consumes the durable deferred intent, and 85%, 95%, and explicit flush still escape while mid-turn. A separate test proves host true reaches CC/OpenCode/Pi scheduling; another proves acknowledged coverage damage still repairs. The pre-fix test failed on pass one (`execute` instead of `defer`); honoring only the flag failed again at the third publication's unintended m0 HARD. Both failures were fixed, not hidden by changing expectations.

**Deployment dependency:** absence is a proven missing input, but not the sole old cause: the module also ignored true. The module fix requires THALAMUS to emit the contract below; it does not infer an assistant turn solely from CK roles. Existing explicit HARD and emergency/drain opportunities remain intentional exceptions, not a blanket promise of one rewrite per turn under all pressure conditions.

## Follow-up finding (2): no CC-only substance-floor bypass is active

The suspected verbatim-tail premise is obsolete for this baseline. `lib.rs:5060` computes `fold_is_only_reclaim = !tail_reclaim(profile)`; all shipping profiles, including CC, have full-array tail reclaim (`healing::tail_reclaim` and its profile-table test). Therefore this value is **false for CC**. The assembler bypass exists at `historian_chunk.rs:671–688`, but is inactive for CC's current profile. Furthermore `DEFAULT_HISTORIAN_MIN_CHUNK_TOKENS` is deliberately **0 for every profile** (`lib.rs:685–687`), matching the TS runner's lack of an extra post-trigger token minimum. The 8k historian chunk minimum is a **budget/cap derivation**, not a requirement to accumulate 8k before running.

The normal CC trigger already uses TC-formatted chunk tokens for `triggerBudget × 3`: `boundary.rs:783–805,863–866`; TS `compartment-trigger.ts:383–386,721–724` has the same predicate. Separate arms exist: commit clusters require at least triggerBudget (`boundary.rs:856–860`); proactive projected-headroom uses a meaningful-content test, which can be satisfied by **6k raw eligible tokens**, 6k formatted tokens, chunk overflow, or 12 messages (`:809–812,869–889`). A small ordinal count does not prove this token floor was bypassed. Tool-heavy raw text can qualify while narratable TC output is small.

**No floor change included:** deleting a fold-only bypass would do nothing here, and raising the zero default is a new shared policy rather than a one-line CC parity restoration. The corrected threshold below also raises the proactive floor from 67% to 77%, excluding this 75–76% window from the cheap proactive arm (while leaving sufficiently large tail-size/commit-cluster arms available). That and turn-boundary consumption address cadence without waiting for a tiny-summary floor that could starve a tool-dominated marathon turn.

Future economics brief: if producer cost remains excessive, batch nonemergency narratable chunks or pending publication consumption by a measured token/cost floor, with explicit Force/Emergency and requested-flush escape. Do not globally require a completed user turn before historian production: ongoing tool-heavy turns still need raw-history reclamation before the wall. Preserve completed-arc fences and force-band liveness from the existing #423/#424 regressions. A numeric new floor requires cross-lane calibration; it is not inferred from the number of ordinals.

## Follow-up finding (3): deployed object-form threshold was silently ignored

The parent staged `threshold-config-evidence.md`: the user-tier `execute_threshold_percentage` is an object with `default: 75`, OpenAI overrides up to 90, and `openai/gpt-6-astra: 85`; **no Claude override** exists. gpui-todo has no project-tier config. The copied store attributes the session route to gpui-todo. All six module requests carry `model_key: "anthropic/claude-sonnet-5"` but omit a host-resolved threshold.

**Before:** bind config used `number_at` only for both tiers (baseline `config.rs:451,537`); an object failed `as_f64`, leaving built-in **65**. Transform and historian preparation then used that scalar. Thus T=65 was the actual erroneous fallback, not the user's intended default. **After:** config retains scalar/object input until model identity is available, resolves model-specific keys before `default`, and applies project overrides only as a per-model floor (`config.rs:207`, `:512–513`, `:597`, `:712`). Scalar 65 remains 65; the supplied object resolves Claude to **75**, with provenance `object.default`.

The resolver reuses `scheduler::resolve_execute_threshold` for TS-equivalent fallback/capping: non-finite/negative values fall back, zero remains valid at this resolver layer, and results cap at 90. Model lookup preserves exact → bare → progressively dash-stripped specificity and canonical-before-Pi/OMP provider aliases (`scheduler::model_key_lookup_order`; TS `event-resolvers.ts:242–256,318–354`). Unknown providers are not remapped. User maps and project maps are retained separately so a project default cannot overwrite a more specific lower project override before the user-floor comparison. Transform, historian preparation, and wrapup all use the model-aware fallback. `effective_execute_threshold` still wins when sent by a host; the TS adapter path is unchanged.

**Important arithmetic:** 75.1–76.0% is still above **T=75**, so correcting T alone does **not** make those requests scheduler Defer. Mid-turn deferral is the missing boundary gate. The proactive historian floor, however, changes from T+2=67 to **77**. Also the drain exit changes from T−10=55 to **65**: a 63% descent now releases naturally under the user's real configuration, without adding a descent-specific latch policy. A regression pins this combination.

Provenance is logged once per route binding, on its first transform (bind frames have no model identity): `mc-module: execute_threshold channel=7 model=anthropic/claude-sonnet-5 configured=75 provenance=object.default effective=75 source=config`. Allowed config provenance values are `scalar`, `object.default`, `object.model`, and `builtin`; a host override is separately reported as `source=host`. The route latch resets on bind/unbind, so logging does not repeat every tool-loop request. The real-dispatch test observed this line and verifies host override precedence and model-derived resolution, not just a standalone resolver.

## Exact THALAMUS wire contract

Add a top-level **`mid_turn: boolean`** to every normal conversation `transform` v2 request. Emit it explicitly rather than relying on the backward-compatible absent=false default. It is a host assertion about continuation of the current assistant turn, not an assertion that any individual tool remains unfinished.

Derive it from the **original native conversation and host finish/stop metadata before MC rewriting**:

1. Identify the newest conversational assistant step and any later *real user-authored* message. Tool-result carriers are not real user turns, even when their native role is `user`. Ignore synthetic/transport-only reminders using trusted host provenance, not merely an arbitrary user-authored text prefix.
2. If a newer real user message interrupts a tool loop, emit **false**. This is a turn boundary even if old tool calls never received results.
3. Otherwise emit **true** when the newest assistant ended in `tool_use`/tool-calls (including text+tool_use) and the continuation supplies its tool_result(s), or some tool results remain pending. Pair IDs to that assistant's calls; unrelated old results do not close or identify its turn. Receiving the final result of a batch does not make the assistant turn complete.
4. Emit **false** when the newest assistant completed with `end_turn`/final text and no current tool continuation exists. Do not classify text+tool_use as final text. Prefer the host's explicit stop reason over role-only inference.
5. A trailing system reminder appended after tool_result is transparent to this decision: the underlying request remains **true**. A real user text following tool_use is not transparent and remains **false**.
6. Title/summary/other side requests must not inherit the parent's ongoing-turn state or publish into its conversation key. Bypass the conversation transform for such purpose-classified requests or use their existing isolated side/subagent route. Model name alone (for example Haiku) is not a reliable side-request classifier. If transformed as an isolated subagent, emit its own truthful mid_turn and `is_subagent: true`; never mark the main conversation as a subagent to bypass scheduling.
7. Treat an internal native compaction/summarization request as a side operation, not a fabricated user boundary on the parent key. After actual lineage rotation, retain the existing D5 protocol and derive mid_turn from the successor conversation; an assistant-tool/result continuation after the summary is still true. Descent's required HARD remains separate. Do not use mid_turn=false as a substitute for an explicit compaction/bust operation.
8. Explicitly requested refresh/flush must use the existing module operation that sets durable `soft_refresh_pending`; no new `explicit_bust` wire field is invented here.

Module exceptions remain: Force at **soft usage ≥ max(85,min(T,90)+2)**, absolute Emergency at **hard usage ≥95%** (soft fallback if hard geometry is absent), explicit refresh, and subagents; mandatory bootstrap/epoch/system-absorption/repair HARDs and the existing emergency drain opportunity remain independent authorities. The deferred flag is not a new host-owned wire state: MC persists it by CAS, re-peeks the latest mid_turn/tail at each pass, and clears it only with successful work. A marathon turn can still recover through force/emergency rather than waiting indefinitely for a user boundary.

## Follow-up regression and mutation output

New test names: `cc_mid_turn_publications_coalesce_until_boundary_with_force_and_flush_escape`, `mid_turn_wire_defaults_false_and_explicit_true_reaches_all_profile_schedulers`, `mid_turn_does_not_hide_already_acknowledged_coverage_damage`, `object_execute_threshold_default_is_not_silently_replaced_by_builtin_65`, `execute_threshold_config_matches_typescript_percentage_goldens`, `execute_threshold_object_lookup_and_project_floor_preserve_model_identity`, and `cc_dispatch_resolves_model_threshold_and_keeps_host_override_authoritative`.

Red-first baseline output: cadence test failed `left: Some("execute"), right: Some("defer")`; object test failed `left: 65.0, right: 75.0`. Both exited 101. The intermediate cadence fix additionally failed on third-pass `boundary_divergence_recut`, proving why the pending-publication exemption is needed.

Each executed mutation used `git add -A` before mutation, a non-empty index-relative `git diff --stat`, then the named two-test run, and `git checkout -- <path> && touch <path>` followed by an **empty** index-relative diff. All deliberate breaks were restored.

| Mutation | Applied diff stat | Exact red test / unaffected control | Captured failure |
|---|---|---|---|
| Pass false instead of req.mid_turn to both schedulers | `transform.rs`: 2 insertions, 2 deletions; restore empty | `cc_mid_turn_publications_coalesce_until_boundary_with_force_and_flush_escape` FAILED; `cc_dispatch_resolves_model_threshold_and_keeps_host_override_authoritative` passed | `left: Some("execute"), right: Some("defer")`; 1 pass / 1 fail, exit 101 |
| Remove pending mid-turn publication exemption from coverage repair | `transform.rs`: 1 insertion, 1 deletion; restore empty | cadence test FAILED; `mid_turn_does_not_hide_already_acknowledged_coverage_damage` passed | `boundary_divergence_recut ... old_coverage=1 new_coverage=7`; m0 equality failed; 1 pass / 1 fail, exit 101 |
| Restore scalar-only config loading | `config.rs`: 2 insertions; restore empty | `object_execute_threshold_default_is_not_silently_replaced_by_builtin_65` FAILED; `default_threshold_matches_typescript_schema` passed | `left: 65.0, right: 75.0`; 1 pass / 1 fail, exit 101 |
| Bypass model-aware fallback on real transform dispatch | `lib.rs`: 2 insertions, 6 deletions; restore empty | `cc_dispatch_resolves_model_threshold_and_keeps_host_override_authoritative` FAILED; object-default test passed | `scheduler_decision: "execute"`, expected `"defer"`; 1 pass / 1 fail, exit 101 |

The handler regression initially encountered the independent cold-start TTL Execute arm. It now seeds an actual fresh response observation to isolate threshold behavior; the production TTL rule was not altered.

### Follow-up final verification

- `cargo test -p mc-module -- --test-threads=2`: exit **0**, 1,056 library tests passed, 4 ignored; binary golden and both integrations passed; doc-tests passed. No production module was restarted. The final provider-alias lookup additions were then checked with the affected gates below.
- `cargo test -p mc-store`: exit **0**, 135 tests passed; doc-tests passed.
- `cargo test -p mc-module --lib -- scheduler::tests config::tests cc_dispatch_resolves_model_threshold_and_keeps_host_override_authoritative cc_mid_turn_publications_coalesce_until_boundary_with_force_and_flush_escape`: exit **0**, 47 tests passed after final alias/config edits. This includes the TS-generated percentage goldens and exact Pi-native/canonical precedence twin cases.
- `bun test packages/plugin/src/hooks/magic-context/boundary-execution-integration.test.ts packages/plugin/src/hooks/magic-context/derive-budgets.test.ts packages/plugin/src/hooks/magic-context/compartment-trigger.test.ts packages/plugin/src/hooks/magic-context/event-resolvers.test.ts`: exit **0**, 92 tests / 179 assertions. The TS process warned that optional `ai-tokenizer` was unavailable and used its character-count fallback; token-budget parity also has Rust's independently generated golden checks. No TS source changed, so no TS typecheck was required.
- `cargo clippy -p mc-module -p mc-store --all-targets -- -D warnings`: exit **0** after final implementation/alias edits.
- `cargo fmt --all -- --check`: exit **0**.
- `aft_inspect`: fresh completion but no authoritative Rust LSP report; compilation/test/Clippy results above are the verification authority.
- Sidekick comment review correctly examined the four follow-up source files. Four comments were clarified to name the threshold map, host override, provider aliases, and deliberately pending summaries explicitly.
- Final user-interruption coverage: `cargo test -p mc-module --lib -- real_user_interruption_ends_an_unanswered_tool_turn_unless_host_says_continuation tail_state_requires_a_result_paired_to_the_newest_assistant_call cc_mid_turn_publications_coalesce_until_boundary_with_force_and_flush_escape mid_turn_wire_defaults_false_and_explicit_true_reaches_all_profile_schedulers scheduler::tests`: exit **0**, 23 tests. Strict package Clippy was rerun afterward and exited **0**. This final fallback adjustment ensures the documented real-user interruption boundary is honored even for an unanswered old tool arc.
- Cargo again refreshed sibling path-dependency versions, including `subc-core` 0.17.19, during these checks. Generated lockfile changes are excluded/restored before commit; no package manifests or dependency sources were changed.

## Initial investigation and capture tables (historical baseline)

The sections below preserve the initial investigation against baseline `6868a8e3`. Its statements that no production fix was required and deployed threshold evidence was unavailable describe the **earlier scope/evidence**, superseded by the module-request/config evidence and cadence fixes above. Capture byte differences and the A–E mechanism classifications remain valid; “by-design Execute publication” describes the old implementation, not an endorsement of the discovered cadence.

Session: `15bf744d-5485-492e-b671-b22d5837d4ef␟1788677140353`. Source baseline: `6868a8e3f2ae4934d18e145b3282f6eeec5c6a80`.

## F — six-pass result (priority)

**All six m1 rewrites add real new compartment content. None is a constant-input re-render.** Every diff is inside `<session-history-since><new-compartments>`. There are no changing counters, timestamps, memory updates, notes, or channel-2 directives in these m1 changes. m0, top-level system, and tools remain identical in all six pairs. The repeated 115,710-token cache read is the stable prefix before m1, not evidence that the same m1 inputs were rendered differently.

| Exchange / preceding capture | request_observed_at_ms | Newly visible compartment sequence / raw range | m1 text UTF-8 bytes after change | Cache read / write tokens | Classification |
|---|---:|---|---:|---:|---|
| 12967 / 12966 | 1788679048690 | 21 / 204–211: verified quick-switcher helper signatures | 596 | 115,710 / 8,804 | By-design Execute publication |
| 12969 / 12968 | 1788679059646 | 22 / 212–217: verified quick-switcher wiring and builds | 1,171 | 115,710 / 9,239 | By-design Execute publication |
| 12972 / 12971 | 1788679070068 | 23 / 218–219: grepped text/content helpers | 1,467 | 115,710 / 9,707 | By-design Execute publication |
| 12974 / 12973 | 1788679080573 | 24 / 220–223: identified public text-input accessor | 1,864 | 115,710 / 9,948 | By-design Execute publication |
| 12978 / 12977 | 1788679096208 | 25 / 224–225: repeated text-input accessor grep | 2,171 | 115,710 / 11,097 | By-design Execute publication |
| 12979 / 12978 | 1788679122127 | 26 / 226–229: read source files | 2,624 | 115,710 / 10,153 | By-design Execute publication |

The exact previous m1 body is preserved inside each successor, followed by the listed new heading and narrative (apart from replacing the initial placeholder at 12967). All intervening capture pairs have equal m1 messages: 12967→12968, 12969→12970→12971, 12972→12973, 12974→12975→12976→12977, and 12979→12980→12981→12982→12983. Thus the captures themselves distinguish new-input publication from per-pass drift.

Evidence was copied into `repeated-m1/` before inspection. All **72 manifest SHA-256 entries match** the copied files. `m1-byte-diffs.txt` contains decoded UTF-8 text unified diffs; original forwarded bodies remain available for raw-byte inspection. Response bodies were gzip-decoded where indicated by their magic bytes, then their SSE `message_start.message.usage` values were extracted.

### Why Execute at 75–76% with no drain latch?

- Captures identify model `claude-sonnet-5`; refreshed store records `anthropic/claude-sonnet-5`. All six scheduler observations are `Execute`, `drain_latch_active=false`.
- `crates/mc-module/src/lib.rs:8503–8506` supplies the host's `effective_execute_threshold`, falling back to the route-bound scalar config. `TransformRequest::execute_threshold_or` is at `lib.rs:1937–1942`.
- `transform.rs:6286–6292` wraps that scalar in `ExecuteThresholdConfig::Percentage`, with no second token override. `scheduler.rs:460–491` resolves/caps the threshold; `scheduler.rs:521–523` is a **level predicate**, `usage.percentage >= threshold`, not a rising-edge predicate. Every above-threshold request is eligible, subject to the separate mid-turn boundary deferral (`scheduler.rs:559–579`). There is no CC-specific higher threshold in this predicate.
- The source default is **T=65%** (`scheduler.rs:14–17`, `config.rs:131`), so 75–76% is ordinary Execute, below the 85% force band. **Evidence limitation:** forwarded provider bodies and request metadata do not contain the module request's effective threshold or the historical route-bound config. The numeric deployed override cannot be certified from these artifacts alone. T=65 is the source-default resolution, not an invented observed field. The observed Execute rows are consistent with that resolution.
- Execute is explicitly an independent deferred-work consumption opportunity (`transform.rs:4243–4264`). The in-session revision mismatch alone does not cause a bust on Defer. `mc-core/src/lib.rs:144–155` requires both `boundary_present` and `bust_opportunity`, plus an m1/reduction delta. No delta means frozen replay. An active historian vetoes ordinary Execute (`transform.rs:4039–4050`); Force/Emergency/latch and hard arms bypass that veto.

The July “pending m1 rides a natural bust” rule is implemented with **ordinary Execute included in the opportunity set**. Whether an above-T level on every tool-loop request ought to count as a natural bust is a policy question; it is not a constant-input rendering defect. No scheduler or m1 production behavior was changed.

### Publication cadence and the limits of row-version evidence

The refreshed SQLite snapshot contains six distinct compartment rows, matching the six bodies exactly:

| Sequence | Range | Stored `created_at` (ms) | First observed in forwarded m1 |
|---:|---|---:|---:|
| 21 | 204–211 | 1788679036637 | 12967 |
| 22 | 212–217 | 1788679048710 | 12969 |
| 23 | 218–219 | 1788679059662 | 12972 |
| 24 | 220–223 | 1788679070089 | 12974 |
| 25 | 224–225 | 1788679080591 | 12978 |
| 26 | 226–229 | 1788679096222 | 12979 |

**Do not mistake these timestamps for completion times.** `historian.rs:1540–1556` passes the drive request's `now_ms` as `created_at_ms`; `historian.rs:40–68` stores it on the compartment. They are producer-drive timestamps, not an audited wall-clock finish journal. Their successive values and the actual newly appended text contradict the “no new content six times” premise. Small 2–8-ordinal chunks of short summaries can arrive at this cadence; a presumed minimum model latency is not evidence against the stored output.

Requested complete historical `HistorianRunSuccess`/row-version alignment is **not recoverable from the refreshed retained stderr**. Even `ck module stderr magic-context -n 10000` returned only the current small retained tail. It contains one later success: row_version **356**, firing sequence **52**, producer `mc-historian:gpui-todo:c89cc4dcf39bc35b:52`, model `ollama-cloud/kimi-k2.7-code` (`stderr-refreshed.txt:5` at capture). The current row is also 356; sequence 27 (230–233) exists but m1's acknowledged maximum is still 26. `mc_cache_state` stores a current row version, not historical versions, and scheduler history does not store the publication version. It would be false to assign six invented row versions or finish timestamps. A row-version increment is not uniquely a publish anyway: transforms also commit that row.

To recover exact finishes, obtain the archived module stderr spanning these requests or a durable historian publication journal. This gap does **not** prevent classification of the six changed m1 inputs, because the native bodies and compartment rows directly show those changes.

### F regression

`transform::tests::cc_constant_inputs_keep_m1_byte_identical_across_execute_passes` starts with a folded boundary, publishes a non-empty m1 delta, then runs **six Execute passes at 75% with latch off and advancing wall clock**. It compares the complete serialized m1 message bytes and unchanged m0, and requires replay-shaped `SOFT+`. A subsequent actual compartment publication must change m1 while preserving m0. This passes on existing production code; no red-first production fix is warranted. The deliberate timestamp-leak mutation below proves that the byte comparison fails on the hypothesized defect.

## A–E classification table

| Event | Verdict | Mechanism / evidence |
|---|---|---|
| ex12878 (m0) | **Legitimate HARD under the existing CC system-absorption contract** | A real system-role reminder at ingress position 3 (ordinal 47 after continuation) is crossed by coverage 44→53. `transform.rs:4014–4033` explicitly requests HARD; `:6840–6853` detects the crossing; `:6812–6837` includes covered systems in m0. The byte diff adds `<covered-system-messages>`. This is neither missing-m1 bootstrap nor ignored inheritance. |
| ex12880 (m1) | **By-design Execute publication, under a held latch** | New compartment 54–59 is added to m1. Execute is computed independently; latch grants an opportunity and bypasses the historian veto (`transform.rs:4039–4061`, `:4243–4264`). m0 stays identical. |
| ex12883 / 1788677240052 | **Natural frontier growth; not a bust** | Cache read 132,042 / write 3,203; normalized preceding 12882 body is a prefix (new message starts at index 17). |
| ex12884 / 1788677247302 | **Natural frontier growth; not a bust** | Read 135,245 / write 482; normalized previous messages are a prefix, frontier index 19. |
| ex12886 / 1788677255167 | **Natural frontier growth; not a bust** | Read 137,198 / write 248; normalized previous messages are a prefix, frontier index 23. |
| ex12888 / 1788677268592 | **Natural frontier growth; not a bust** | Read 138,514 / write 847; immediate pair 12887→12888 has normalized frontier index **27**, counts 27→29. The earlier supplied index 25 is not the index in this immediate capture pair. |

Normalization here removes only recursive `cache_control` fields, then compares canonical JSON encoded to UTF-8; it does not remove reasoning, tags, content, timestamps, or other messages. Raw immediate-pair first differences on the four frontier passes are at the prior last message (indices 16/18/22/26), consistent with movable cache-control metadata; after removing it, every old message is retained. No tail-reclaim “trickle” is inferred from these events.

### A — drain latch, descent, and TS parity

- Rust arm: `advance_drain_latch`, `scheduler.rs:601–614`. Force band is `max(85, min(T,90)+2)` for the supported threshold range (`scheduler.rs:186–197`). At default T=65, entry is 85%.
- Release: `scheduler.rs:593–629`, strictly **below max(0,T−10)**; unusable/nonpositive threshold fallback 55%. Expiry is **elapsed > 30 minutes**, not >=. Entry is checked first, so a current force-band reading retains/re-enters rather than self-expiring. Constants are at `scheduler.rs:24–31`.
- Additional trusted final-wire release is at `transform.rs:3958–3979`: only an already-active latch, trusted final-wire usage, and a matching provider-proven model limit with wire usage strictly below 80%. It is not a general low-fill/descent reset.
- D5 store adoption copies source core/meta and reanchors the non-empty boundary to the continuation block (`mc-store/src/lib.rs:10696–10712`). It does not clear the drain latch or restart its clock. Original snapshot has `emergency_drain_entered_at_ms=1788677102278` on both keys. The original successor remains initialized with continuation base 43 and materialized descent.
- TS twin: `packages/plugin/src/features/magic-context/storage-meta-persisted.ts:775–781` computes the **same T−10 exit floor**, and `:835–852` contains the force-entry / strict-below-floor / >30-minute lifecycle. `protected-tail-boundary.ts:741–862` resolves protected/eligible history, not this lifecycle. TS does **not** release at Execute T.
- TS also clears the catch-up latch for tail-exhausted/no-chunk no-ops (`compartment-runner-incremental.ts:306–327,362–378`); the reserve function itself returns early for zero requested tokens (`storage-meta-persisted.ts:794–803`). Therefore threshold parity is not a claim that every surrounding lifecycle path is identical.
- A landing at 63% with T=65 holds by the current shared hysteresis policy. `scheduler::decide` itself can simultaneously return Defer (`scheduler.rs:734–833`); an active latch does **not** force its `pass` field to Execute. The new scheduler regression explicitly tests 63/65/55/54.9% with and without a latch.

### B — inherited boundary versus bootstrap

The store creates a continuation placeholder at prior_last+1 (`mc-store/src/lib.rs:10635–10665`), reanchors core boundary, and preserves initialized state. Descent itself legitimately requires one materialization; the transform forces that descent HARD at `transform.rs:4285–4287`. By ex12877, m0 already includes inherited history and m1 is already present as a placeholder.

The later first-fold arm only applies to an **empty** boundary (`transform.rs:3989–4008`); `cached_m1_missing` is a distinct shape test (`:6379–6402`). Neither explains ex12878. Its first new m0 bytes are the covered system reminder, and the new coverage is 53. `mc-core/src/lib.rs:133–136` honors the requested HARD. `injection.rs` handles synthetic-todo state, not this decision.

Raw byte checks:

| Pair | Full body byte lengths | First differing raw byte | Canonical m0 bytes | Canonical m1 bytes |
|---|---:|---:|---|---|
| 12877→12878 | 365,083→356,914 | 20,967 | 54,328→58,418; common prefix 20,900 bytes | unchanged, 143 bytes |
| 12879→12880 | 374,627→370,670 | 58,578 | unchanged, 58,418 bytes | 143→664 bytes |

SHA-256 witnesses: 12877 `da429f99cb4b1b55ab6a975e564d9f1137fe6b1d22247de26f6d3fc06ea6f338`; 12878 `37334a0de63199e7ab846df35ce663fe1784e1ddbec15f676a7a0fd739af264d`; 12879 `fac4eeeafbf7023a19932baaf14db926d55cc0fea408fe6e1938b94e1442d519`; 12880 `d82f0b52d5b6b5b69cb78b61819ce20608d2de532883312054190d52c1b22b69`.

### C — immediate publication

The latch makes `pass_already_busting` true at `transform.rs:4060–4061` and disables the ordinary historian veto at `:4039–4050`. Independently, Execute contributes to `independent_bust_opportunity` at `:4243–4246`. With a present boundary and a changed compartment revision, the classifier allows SOFT immediately. The new test covers unlatched Execute publication, latched Execute with active historian, and the unlatched active-historian veto control. No inference that “latched implies Execute” is needed or correct.

## Policy briefs (no production changes)

### 1. Defer system absorption to m1 until a natural HARD

**Existing contract:** every coverage crossing of a previously uncovered real CC system message requires m0 recomposition, even on scheduler Defer. Covered system text is retained exactly once in `<covered-system-messages>` in m0, and its standalone tail message is suppressed. One HARD may absorb several reminders; it is not one HARD per reminder when they share a crossing.

**Alternative:** retain the existing m0 bytes and put the newly covered system text, its stable identity/order, and a durable “not folded into m0 yet” marker in m1 alongside the new compartments. Freeze that block through replay. On the next independently required HARD, fold the text into m0 and remove it from m1 atomically. The design must preserve order, deduplication, replay/restart behavior, coverage monotonicity, identity checks, and ensure the text is never lost or duplicated as tail coverage advances.

**Cost:** a crossing currently invalidates cached content from the changed point in m0 through the priced suffix. Here ex12878 reads only 92,500 and writes 33,317 tokens. After this m0 exists, ex12880's m1 rewrite retains 112,667 cached tokens and writes 17,364. Those are different requests/tails, not a controlled savings experiment. For an identical future crossing, deferring m0 absorption would preserve approximately the prefix span between the old m0 change and m1: with cached token span P, cache-write price W, cache-read price R, the immediate avoided rewrite cost is approximately **P × (W−R)**, minus any added m1 payload and later refold costs. With 1h cache creation the price multiplier must use the actual model's 1h tariff, not the 5m rate. Repeated crossings can repeatedly charge the same suffix, making batching valuable.

**Wire contract change:** THALAMUS would receive unchanged m0, modified m1 containing covered-system text, and the covered system removed from the tail. This changes where and when authoritative system-origin text is carried, and the materialize reason/action changes from HARD to deferred/SOFT. Full-array transport makes such a design possible, but does not itself authorize deleting the existing retention contract. Keep it as an explicit future policy change with provider-wire tests.

### 2. Release an inherited catch-up latch when descent lands below T

A descent relieves provider pressure but does not necessarily finish the historian's work: newly uncovered successor raw history, preserved lineage compartments, and a growing protected/tool tail may still need catch-up draining. The T−10 floor protects headroom and keeps the exhausted drain-budget bypass live after leaving the force band; otherwise a partially drained session can fall back to throttling before backlog is consumed.

At 63% and T=65, however, the margin below Execute is only 2 points, and a large irreducible prefix can make 55% unreachable. A descent-specific release below T is a plausible way to end an old pressure episode without changing ordinary force-band hysteresis. It needs an explicit decision about the reliability/denominator of the first post-descent usage sample (persisted predecessor usage is not proof of successor pressure), and what happens when the successor soon climbs above T but below 85%.

It would not prevent CC system-crossing HARD, nor pressure-driven Execute at 75%. It removes the drain-budget bypass and historian-veto bypass until normal re-entry. Recommendation: evaluate with measured successor usage and raw-eligible backlog before changing semantics; preserve current parity pending that decision.

### 3. Frontier-versus-priced-prefix diagnostic

Pure append-only fingerprint sequences **do not** emit `first_divergence`: `crates/mc-module/src/divergence.rs:28–87` deliberately returns None when old is a prefix; `divergence::tests::append_past_old_end_is_not_a_divergence` pins this. A content/metadata change to the old frontier can still emit `content_changed`, even if all provider-priced prefix bytes remain reusable. `transform.rs:2261–2302` fingerprints CK blocks and falls back to positional `served_message:N` identifiers; these are not provider pricing coordinates.

Proposed field on `FirstDivergence`: **`prefix_relation: "inside_priced_prefix" | "at_or_after_prior_frontier" | "unknown"`**. To compute it honestly, retain the prior provider-served frontier/cache breakpoint and normalization identity (or accept a provider-derived priced-prefix coordinate). Also record `prior_frontier_message_index` and, when known, `prior_priced_prefix_token_depth`. Until that evidence exists, use `unknown`, not a guess from CK `approx_token_depth`. Existing `index`, `kind`, and `approx_token_depth` alone cannot establish a paid cache bust. No trace code changed.

### 4. Historian ordinal-validation rejection

Original `stderr.txt:8` records exactly: `Compartment range 54-65 does not map to raw session lines 60-65`. `historian_validate.rs:934–956` requires both returned endpoints to exist in `HistorianChunk.lines`; rejection is correct and prevents advancing coverage with an invalid boundary. The inherited continuation base is **43**, while the bad start is **6** behind the selected chunk start. This is not evidence of a simple inherited-offset arithmetic error. It is compatible with the producer repeating a previous coverage start, but the exact producer prompt/output needed to prove that is absent.

Brief: capture selected chunk ordinal metadata, prompt hash, returned range, prior compartment endpoints, firing sequence and model on validation rejection; test consecutive chunk repair prompts against repeated prior starts. Track repeated validation failures/backoff and lack of coverage progress. Do not loosen endpoint validation to make an invalid producer output publish. One rejection is observed here; recurrence/starvation is a risk, not established fact.

### Additional source-only caveat, outside the corrected tail investigation

`selection.rs:1108–1110` suppresses an emergency drop only when the input sample equals the prior sample, whereas TS `emergency-drop.ts:177–185` holds on any `hasPriorDrop`. This is a separate force/emergency episode-parity question, not evidence that the corrected four tail passes or F's new-compartment publishes lost cache for that reason. No fix was included under the parent's explicit retain-semantics decision.

## Regression and mutation evidence

Added tests:

1. `transform::tests::cc_coverage_crossing_system_reminder_forces_hard_with_existing_boundary`: initialized m0/m1 boundary at 44, system at 47, coverage advances to 53; scheduler remains Defer at 63%, but HARD preserves the system in m0; next replay is stable.
2. `lineage_descent_tests::descent_preserves_initialized_boundary_and_active_drain_episode`: actual store descent preserves initialized state, reanchors boundary, continues ordinals at 44, and carries the original latch/timestamp.
3. `scheduler::tests::inherited_drain_at_63_percent_holds_without_forcing_execute`: 63% holds/Defer, 65% holds/Execute, 55% holds/Defer, 54.9% releases/Defer; latch-free decisions have the same pass class.
4. `transform::tests::cc_publish_on_execute_applies_immediately_and_latch_bypasses_historian_veto`: immediate delta on Execute with/without latch and active-historian control.
5. `transform::tests::cc_constant_inputs_keep_m1_byte_identical_across_execute_passes`: six constant-input Execute replays plus a real-new-publication positive control.

Each mutation used the required sequence: **`git add -A`**, apply a labeled deliberate break, capture non-empty **`git diff --stat` against the index**, run the named tests, then **`git checkout -- <path> && touch <path>`**, capture an **empty `git diff --stat` against the index**. No deliberate break remains in source.

| Control removed / changed | Applied diff stat | Exact red test; other test outcome | Actual failing output / exit |
|---|---|---|---|
| Disable `system_absorb_hard_due` contribution to HARD | `crates/mc-module/src/transform.rs`: 1 insertion, 1 deletion; restored diff empty | `transform::tests::cc_coverage_crossing_system_reminder_forces_hard_with_existing_boundary` FAILED; `cc_publish_on_execute_applies_immediately_and_latch_bypasses_historian_veto` passed | `left: "SOFT+", right: "HARD"`; 1 passed, 1 failed; exit 101 |
| Remove ordinary Execute from independent publication opportunities | `crates/mc-module/src/transform.rs`: 2 insertions, 4 deletions; restored diff empty | `transform::tests::cc_publish_on_execute_applies_immediately_and_latch_bypasses_historian_veto` FAILED; `cc_coverage_crossing_system_reminder_forces_hard_with_existing_boundary` passed | `left: "SOFT+", right: "SOFT"`; 1 passed, 1 failed; exit 101 |
| Clear inherited drain-active flag during descent | `crates/mc-store/src/lib.rs`: 2 insertions; restored diff empty | `lineage_descent_tests::descent_preserves_initialized_boundary_and_active_drain_episode` FAILED; `descent_accepts_a_zero_based_fresh_anchor` passed | `assertion failed: target.meta.emergency_drain_active`; 1 passed, 1 failed; exit 101 |
| Release latch below T instead of T−10 | `crates/mc-module/src/scheduler.rs`: 1 insertion, 1 deletion; restored diff empty | `scheduler::tests::inherited_drain_at_63_percent_holds_without_forcing_execute` FAILED; `cc_publish_on_execute_applies_immediately_and_latch_bypasses_historian_veto` passed | `assertion left == right failed: usage 63; left: false, right: true`; 1 passed, 1 failed; exit 101 |
| Append pass time to frozen m1 on replay | `crates/mc-module/src/transform.rs`: 6 insertions; restored diff empty | `transform::tests::cc_constant_inputs_keep_m1_byte_identical_across_execute_passes` FAILED; `inherited_drain_at_63_percent_holds_without_forcing_execute` passed | `first_divergence ... index:1 ... mc_m1#0 ... content_changed`; serialized m1 byte equality failed (extra `12000` suffix); 1 passed, 1 failed; exit 101 |

Mutation commands used `cargo test -p mc-module --lib -- <red-test-filter> <control-test-filter>` (or `-p mc-store` for descent), without pipes. Restored module regressions: 4 passed, exit 0; the store descent regression also passed before and after its mutation through the full store gate.

## Delivery scope and verification

Parent decision after source/evidence investigation: **retain existing semantics**, add mechanism regressions and policy briefs. F likewise supplies no constant-input defect to fix. Changes are tests plus this report; no module bounce, production restart, or master push occurred. The only additional cleanup is equivalent struct initialization in an existing mc-store test to satisfy strict Clippy's `field_reassign_with_default` lint; the explicit counter value remains zero.

Verification details are appended below after final gates. Original A–E DB state was preserved as `mcstore-original.db`; the current `mcstore-ro.db` was refreshed using SQLite's consistent backup API from the live read-only connection, including committed WAL-visible data. Raw databases/captures and logs are investigation artifacts, not committed user data.

### Executed gates and environment notes

- `cargo test -p mc-module` — **exit 101** on the pre-existing timing assertion `transform::tests::unaffected_transition_golden_is_byte_identical_and_detection_is_constant_time`: measured 51.570 µs/pass; 1,047 passed, 1 failed, 4 ignored. No behavioral regression or new test failed.
- `cargo test -p mc-module --lib unaffected_transition_golden_is_byte_identical_and_detection_is_constant_time -- --nocapture` — **exit 0**, isolated measurement 18.619 µs/pass. The timing assertion was not weakened.
- `cargo test -p mc-module -- --test-threads=2` — **exit 0**, 1,048 library tests passed, 4 ignored; caveman binary golden, boundary durability integration, and isolated real-daemon integration each passed; doc-tests passed. This full rerun preceded the final F test addition; that addition was verified separately below. The daemon integration spawns its own test process, not a bounce of the operator's running module.
- `cargo test -p mc-store` — **exit 0**, 135 passed; doc-tests passed.
- `cargo test -p mc-module --lib -- cc_constant_inputs_keep_m1_byte_identical_across_execute_passes cc_coverage_crossing_system_reminder_forces_hard_with_existing_boundary cc_publish_on_execute_applies_immediately_and_latch_bypasses_historian_veto inherited_drain_at_63_percent_holds_without_forcing_execute` — **exit 0**, all four final module regressions passed after restoration of all mutations.
- `cargo test -p mc-store boundary_divergence_counter_cas_loser_does_not_double_increment_and_survives_reopen` — **exit 0**, verifies the final equivalent initializer cleanup.
- `bun test packages/plugin/src/features/magic-context/emergency-drain-latch.test.ts` — **exit 0**, 14 passed, 109 assertions. Existing TS twin verifies the T−10 floor and raised T+2 arm/hold/exit matrix. No TS implementation or types were changed; TS typecheck is not a changed-code gate for this delivery.
- `cargo clippy -p mc-module -p mc-store --all-targets -- -D warnings` — first **exit 101** on the pre-existing redundant default-field reassignment at `mc-store/src/lib.rs:17693`; after equivalent struct-initializer cleanup, **exit 0** for both packages/all targets.
- `cargo fmt --all -- --check` — **exit 0** after formatting the added tests. The initial formatting check identified only new-test formatting and was corrected.
- `aft_inspect` — completed fresh but reported no authoritative Rust LSP reports for the touched files (plus unavailable unrelated language producers). Cargo tests and Clippy, not the empty diagnostic count, are the authority.
- Sidekick comment review was invoked with the explicit worktree/files. Its response examined unrelated parent e2e files instead. No finding applied to this patch; direct final diff review confirms no added/changed source comments and no deliberate mutation left behind.
- The first attempted exact system-test filter omitted the module path and ran zero tests; it was not counted as verification. The correctly filtered system test and later complete suite both executed it successfully.
- Cargo's path dependencies in the provided sibling dependency checkout advanced during verification (`subc-core`, `subc-client-rs`, `subc-transport`, and `subc-control`), causing generated `Cargo.lock` churn. No dependency upgrade belongs to this task; the lockfile is restored to HEAD before commit. All builds/tests ran from this worktree; no dependency source was edited, no package install was needed, and no generated lockfile change is included.
