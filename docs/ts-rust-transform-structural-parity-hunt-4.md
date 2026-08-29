# TS ↔ Rust transform structural parity hunt #4

## Method and denominator

Served provider bytes and durable decision/store rows remain the only production ground truth. A project name or session label is not lane evidence. `scripts/audit-transform-wire-parity.py` now reads `<project>/.cortexkit/magic-context.jsonc` for every project root extracted from served system bytes before admitting a dump to either denominator. An absent `transform_mode` means the TypeScript default; an unreadable config excludes the dump. The built-in expected-Rust assertions contain ASTROCYTE and ENGRAM only. SUBCONSCIOUS is not in that set: its intentionally empty config resolves to TypeScript.

The differ also now emits:

- matched `ctx_expand` / `ctx_note` / `ctx_search` request classes, output hashes and unexplained byte classes;
- compartments born in the selected window, tier completeness, importance, durable date fields and samples;
- promoted historian facts and side-effect/outbox rows;
- every live table with an exact `session_id` column, which is the lifecycle-delete coverage domain; and
- configured-versus-observed authority alongside the existing decision, geometry, reminder and wire-shape evidence.

Reproduce the production audit on the host that owns the dumps and databases:

```sh
python3 scripts/audit-transform-wire-parity.py \
  "$TMPDIR/opencode-anthropic-auth-dumps" \
  --date 2026-08-27 --per-session 1000 \
  --context-db "$HOME/.local/share/cortexkit/magic-context/context.db" \
  --store-db "$HOME/.local/share/cortexkit/magic-context/store.db"
```

No production dumps or user databases are versioned in this repository. Therefore this change does not invent “this week” row counts. `scripts/audit-transform-wire-parity.test.py` executes the same lane, facade, historian-row and lifecycle inventory paths against two synthetic served wires and two real SQLite files; production counts remain an explicit post-deploy evidence step.

## Findings and fixes

### F1 — fixed: Rust `ctx_expand` did not render the TypeScript tool facade

A completed OpenCode tool is one TypeScript part containing input and output. The CK encoder represents it as adjacent `tool_call` and `tool_result` blocks. Rust rendered those as two tool sections in full recovery and two bullets in verbose recovery; it also exposed `step-start` and called file parts `media`. The served tool result therefore differed despite carrying the same underlying message.

The TypeScript-authority generator `crates/mc-module/gen/gen-ctx-facade-golden.ts` now records production CK encoder output and the exact TypeScript full/verbose renderer bytes in `crates/mc-module/testdata/ctx-facade-golden.json`. `ctx_expand_renderers_match_typescript_facade_golden` consumes that fixture in Rust. Rust now coalesces an adjacent matching call/result, suppresses structural step markers, and renders both opaque OpenCode files and CK media as `[file]` (`crates/mc-module/src/lib.rs`, `render_cached_message_expand` and `render_verbose_expand_message`).

The Rust facade also accepted ordinal zero. TypeScript’s own error copy documented “positive integers”, but its provider schema accepted any number and range execution accepted fractions. That was a TypeScript violation of its documented invariant, so both seams were corrected: TypeScript now advertises integer/minimum-1 arguments and explicitly rejects zero/fractions; Rust uses the same minimum and errors. The prior Rust test’s contract changed deliberately: `ctx_expand_accepts_native_ordinal_zero_in_message_and_range_forms` became `ctx_expand_rejects_ordinal_zero_like_the_typescript_facade`, with TypeScript validation cases in `packages/plugin/src/tools/ctx-expand/tools.test.ts`. Native zero-based history remains valid inside boundary machinery; this change is only the public `ctx_expand` contract.

### F2 — fixed where the module has a corpus; missing corpora remain explicit

The TypeScript tool searches and ranks memories, hidden raw messages, compartments, notes, Primers and optional git commits, supports a `sources` filter and direct memory-id lookup, and renders prose with scores, ordinals/ranges and expansion hints (`packages/plugin/src/tools/ctx-search/tools.ts`, `formatResult` / `formatSearchResults`; result variants in `packages/plugin/src/features/magic-context/search.ts`, `UnifiedSearchResult`).

The module owns searchable memories, durable compartment title/body rows and notes. Those rows now use the TypeScript result vocabulary and prose renderer shape: memories render as `[memory]`, compartments as `[message]` with their real ordinal range, notes carry status/age and same-session `@msg` anchors, and all rows carry an honest score/match label. The facade honors the unadvertised compatibility `sources` argument, preserves explicit-empty filtering, short-circuits whole-query memory ids, filters the memory ids already frozen in m0, uses deterministic recency/id ties, and returns the exact TypeScript no-results and expansion-hint copy (`crates/mc-module/src/lib.rs`, `handle_ctx_search_facade` / `render_facade_search_results`; `crates/mc-module/src/memory_tool.rs`). The advertised module schema is unchanged.

The module still has no raw-message FTS index, Primer corpus, or git-commit index. A `sources` request selecting only those corpora returns no results; it does not relabel compartment summaries as raw messages or fabricate candidates. `ctx_search_matches_typescript_shape_for_available_module_corpora` pins every available source, source filtering, numeric-id lookup, m0 exclusion, equal-rank ties, real compartment ranges, the no-results copy and hints. Adding the three absent indexes remains a separate corpus/storage brief, not a facade-parity pretext.

### F3 — fixed: completed-tool descriptions survive cached and durable recovery

TypeScript full recovery includes `state.title` / `state.metadata.title` as a `description:` line. The OpenCode CK encoder now copies only non-empty completed-tool titles into `ck.provider_extras.opencode.ctx_expand_tool_titles`, keyed by call id (`packages/plugin/src/hooks/magic-context/module-wire.ts`, `encodeOpenCodeMessagesToCk`). This is a message-level recovery sidecar: projected block serialization and `block_identity_by_mid` remain title-free, so the title cannot change selection, historian fences or decision fingerprints.

The Rust full renderer reads that sidecar when it coalesces a matching call/result and emits the same `description:` line. The TypeScript-owned golden now contains a metadata-title completed tool. `ctx_expand_preserves_typescript_tool_titles_immediately_and_after_snapshot_loss` serves the exact TypeScript bytes first from the bounded request snapshot, then after snapshot eviction from the durable historian `raw_messages_json`. Verbose output remains unchanged because the TypeScript verbose renderer does not serve titles. No facade schema bytes changed.

### F4 — fixed: historian side channels use the TypeScript best-effort contract

Both lanes atomically publish compartments, coverage and marker-deferral state. Both gate fact promotion on memory plus auto-promote; Rust’s end-to-end gate is pinned by `publish_gates_facts_when_memory_or_auto_promote_is_off`, while TypeScript applies the two gates and promotion in its publish transaction (`compartment-runner-incremental.ts`, publication block).

Events, Primers and user observations are now best-effort/re-derivable on both legs. Rust attempts each side-channel kind inside the same accepted publication transaction as compartments, transcripts, promoted facts, publication floor and historian state, but ignores a side-channel write failure so core progress still commits. A failed kind is lost while successful sibling kinds remain durable; no new outbox row is enqueued and restart does not retry the failed item (`crates/mc-store/src/lib.rs`, `publish_historian_chunk`). The migration-40 outbox table and schema fence remain in place solely to drain rows accepted by older binaries during rolling upgrade; there is no fence movement.

`historian_side_channel_fault_matrix_is_best_effort_and_lossy_after_restart` injects each of the three failures in turn, then reopens the store and compares compartment plus every side-channel disposition. `historian_new_publications_leave_the_legacy_outbox_empty` and `status_diagnostics_do_not_advertise_lossy_historian_side_channels_as_pending` pin the no-new-retry policy.

Date storage differs without establishing a served-byte bug: Rust compartments durably store `start_date`/`end_date`; TypeScript derives date ranges from raw message timestamps when rendering and has no date columns. The differ reports that distinction explicitly instead of treating absent TypeScript columns as missing rows.

## Per-axis verdicts

### A. Historian trigger, prompt and publication

**Trigger and prompt verdict: pass on matched fixtures.** `boundary-golden.json` is generated from TypeScript and pins constants, protected-tail resolution, true raw eligible tokens, oversize atomic units and trigger fire/reason/coverage. Rust checks are `boundary_constants_match_ts_sources`, `boundary_golden_matches_ts_resolution` and `trigger_golden_matches_ts_decision_core` (`crates/mc-module/src/boundary.rs:2175-2355`). Chunk formatting/budget behavior is independently generated from production TypeScript (`gen-historian-chunk-golden.ts:59-330`) and consumed by `historian_chunk_golden_fixture_matches_builder`. Producer prompt bytes, seed selection, session references, memory-on/off and extraction-free shape are exact in `historian_prompt_golden_matches_typescript_reference` (`historian_prompt.rs:483-584`).

**Publication verdict: compartments/facts/coverage pass; side-channel durability is aligned to TypeScript as F4.** Live-week row counts are an evidence gap until the host command above runs.

### B. Wrapup and lifecycle operations

**Wrapup verdict: fixed/shared state matrix.** TypeScript outcomes map as follows: no runnable window → done/nothing; existing run or lease owner → skipped; any stop after admission → partial with “run again”; full drain → done (`wrapup-orchestrator.ts`, `runManagedWrapup`). Module dispositions are `nothing_to_compact`, `already_in_progress`, `retryable` and `completed`; the host maps them to the same four user outcomes (`command-handler.ts`, `formatRustOperationMessage`). `maps every shared wrapup state cell to the TypeScript outcome contract` table-drives empty, active, lease timeout, zero progress, partial progress, producer failure, ownership loss and success through that production host mapper. The corresponding TypeScript orchestrator cells remain production-path tests in `wrapup-orchestrator.test.ts`; module progress, keep watermark and terminal command replay remain production-path tests in `crates/mc-module/src/lib.rs` (`session_wrapup_*`, `terminal_wrapup_command_replays_verbatim_without_a_second_drive`). Headings/summary prose are intentionally normalized by outcome rather than claimed byte-identical.

**Lifecycle verdict: pass.** TypeScript’s `SESSION_SCOPED_TABLES` is checked against every live schema table containing exact `session_id`, then `clearSession` is tested to empty all of them (`storage-db.test.ts:333-390`). Rust `session.delete` discovers that same ownership shape dynamically and deletes every table with exact `session_id`, preserving project-owned smart notes (`crates/mc-store/src/lib.rs:6841-6887,17183-17253`). The extended differ prints both live inventories.

The shared matrix is behavioral rather than a second synthetic wrapup engine: each leg drives its real store/runner, and the production host mapping is table-driven for all eight cells.

### C. `ctx_*` facades

- `ctx_expand`: **fixed/pass** for deterministic full and verbose fixtures, including immediate and durable completed-tool titles (F3). Default historian transcript slicing remains covered by module tests.
- `ctx_note`: **source-shape pass, cross-language golden gap**. Plain write/read/update/dismiss and smart-note capability gating exist in module facade tests, but no shared TypeScript-rendered byte corpus exists. Add it when note copy changes.
- `ctx_search`: **fixed for module-owned corpora; explicit corpus gap** for raw messages, Primers and git commits (F2).

The differ now hashes actual served outputs for matched facade inputs after removing only the leading transform tag and temporal carrier. Different output sets land in `unexplained_byte_classes`; lane-only calls remain evidence gaps rather than false failures.

### D. LKG and failure recovery

**Verdict: fixed and matrix-pinned.** On module failure below the trusted emergency wall, Rust validates and serves LKG, otherwise bounded raw input; raw input that exceeds a known wall is refused. At or above 95% or under provider-proven overflow recovery, it fails closed before LKG (`rust-mode-transform.ts`, `replayLastGood` / `serveRawFallback` / failure catch). A TypeScript session-meta storage read failure intentionally returns the untouched raw array; later thrown transform failures use the shared outer LKG seam. Thus “storage unavailable before state exists” is raw fail-open in both lanes, while “Rust authority unavailable with valid state” gains an LKG rung that has no TS-authority analogue.

The matrix exposed one actual fail-open hole: Rust caught the overflow-state read failure but then read persisted TodoWrite permission outside the main recovery `try`, so a missing `session_meta` table escaped before raw fallback. That read is now folded into `preflightError`; `keeps the raw array untouched when overflow-state storage is unreadable` proves the module is not called and the exact input array is returned. `keeps the raw array untouched when session metadata is unreadable` pins the TypeScript entry cell. Existing production-path tests pin transform/module failure, invalid LKG seam, oversized LKG plus oversized raw, fitting raw, 94%, 95%, provider-overflow proof and unknown-limit first/repeated arms. Every cell asserts returned bytes or the typed thrown error, not log copy.

### E. Channel-1 `{U,T}` math

**Verdict: exact pass.** The TypeScript-generated `nudge-hygiene-golden.json` covers tagged text, full call/result arcs, queued drops, protected exemplars, synthetic rows, reasoning exclusions, media and band edges. Rust previously allowed a 3%/12-token tolerance even though the shared tokenizer now produces identical values. The test now requires exact U and T for every case and still requires exact band selection (`tail_hygiene.rs:1234-1331`). Existing mutant checks prove reasoning changes neither term while tagged visible text changes the measurement.

### F. Boundary and geometry

**Verdict: pass.** Boundary constants and matched outcomes are exact in the TypeScript-generated boundary golden cited above. The host derives geometry once and transports `usable_soft`/`usable_hard` unchanged; tests pin 255,616/368,000 shared-upfront and 128,000/168,000 separate-window cases (`rust-mode-transform.test.ts:358-397`). Rust uses soft for scheduler/historian denominators and hard for emergency walls (`transform.rs:5792-5835`); first-pass historian fallback to soft is pinned in `lib.rs:14854-14887`.

### G. Differ unexplained-byte classes

**Verdict: machinery classes added; production bucket pending host artifacts.** The hermetic differ test produces one byte-equal matched `ctx_expand` class and no unexplained class while proving config-derived lane correction, historian tier/date/fact rows and both lifecycle inventories. Production output is deliberately not asserted without production files.

## Honest-empty declaration

Hunt #4 follow-up closes the four structural briefs without changing advertised facade-schema bytes or moving a storage fence: available-corpus `ctx_search` rendering, non-decision-bearing tool-title recovery, TypeScript-aligned lossy historian side channels, and the shared wrapup/LKG matrices. Raw-message, Primer and git-commit module search indexes remain an explicit corpus brief rather than fabricated parity. No master push is part of this work.

## Post-delivery correction (review): ctx_expand ordinal domains deliberately differ

The delivered unification of the ctx_expand ordinal domain to positive integers
(schema minimum 1 + runtime <=0 rejects, both legs) was reverted at merge. The
missing evidence: Claude Code chunk transcripts store 0-BASED ordinals (the D5
drive sessions pinned `ordinals 0..17` in the module store), so a minimum of 1
makes a CC session's first message permanently unexpandable. The correct
contract, now pinned by `ctx_expand_accepts_ordinal_zero_because_cc_transcripts_are_zero_based`:
the module facade accepts ordinal 0 (CC's space), the TypeScript facade keeps
rejecting it (OpenCode/Pi transcripts are 1-based) — same-schema-everywhere is
false parity when the underlying ordinal spaces differ. The advertised-schema
byte changes were additionally release-window material (cache surface on both
legs) and are dropped rather than deferred: the runtime integer tightening on
the TS side (Number.isInteger checks, no wire bytes) is kept.

## Follow-up non-vacuity evidence

Each load-bearing correction was deliberately broken, run red, and restored before the final gates:

- `ctx_search`: admitting an m0-visible memory failed `ctx_search_matches_typescript_shape_for_available_module_corpora` at `Found 5 results for "needle"` (the contract expected four).
- `ctx_expand`: discarding the title sidecar failed `ctx_expand_preserves_typescript_tool_titles_immediately_and_after_snapshot_loss`; the left-hand full render omitted `description: Read the runtime configuration`.
- Historian durability: ignoring each injected write fault failed `historian_side_channel_fault_matrix_is_best_effort_and_lossy_after_restart` with `left: 1`, `right: 0` for the faulted kind.
- Wrapup matrix: mapping retryable progress to failure failed `maps every shared wrapup state cell to the TypeScript outcome contract` for `lease_timeout`: expected `## Magic Wrapup — Partial`, received `## Magic Wrapup — Failed`.
- LKG/storage matrix: letting the persisted TodoWrite read escape the recovery try failed `keeps the raw array untouched when overflow-state storage is unreadable` with `SQLiteError: no such table: session_meta`.
