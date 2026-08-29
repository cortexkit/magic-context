# TS ↔ Rust ↔ Pi transform structural parity hunt #5

## Method and denominators

Serialized provider requests remain the OpenCode ground truth. Pi adds two distinct evidence surfaces: its durable JSONL source entries and the exact `AgentMessage[]` returned by the Magic Context `context` handler. The two must not be conflated: JSONL proves what Pi can replay, while only rendered captures prove synthetic m[0]/m[1], drops, marker trims, and model-visible custom messages.

`scripts/audit-transform-wire-parity.py` therefore preserves every hunt 1–4 OpenCode/Rust axis and adds:

- `--pi-session-dir`, which inventories real `~/.pi/agent/sessions/**/*.jsonl` entries, stable entry IDs, clone headers, persisted tags/reminders, compaction entries, and parse failures without admitting source rows as served bytes;
- `--pi-render-dir`, which reads dated `*.pi-render.json` captures containing `session_id`, `project_root`, and the plugin-returned `messages`; and
- a first-class `pi` lane plus TS(OpenCode) ↔ TS(Pi) shape-space adjudication for tags, m[0]/m[1], rendered markers, nudge templates/carriers, and caveman/drop vocabulary.

A capture host can run:

```sh
python3 scripts/audit-transform-wire-parity.py \
  "$TMPDIR/opencode-anthropic-auth-dumps" \
  --date 2026-08-27 --per-session 1000 \
  --context-db "$HOME/.local/share/cortexkit/magic-context/context.db" \
  --store-db "$HOME/.local/share/cortexkit/magic-context/store.db" \
  --pi-session-dir "$HOME/.pi/agent/sessions" \
  --pi-render-dir "$TMPDIR/pi-context-dumps"
```

Every OpenCode denominator still requires a readable live project config. The built-in expected-Rust set remains ASTROCYTE plus ENGRAM only. SUBCONSCIOUS remains deliberately TypeScript because its project config is empty. Pi remains a separate TypeScript harness lane even when the same project's `transform_mode` describes its OpenCode route. No production dumps, Pi sessions, or user databases are versioned, so live counts and live unexplained-byte classes remain a post-deploy evidence step rather than invented evidence.

The hermetic differ test drives two OpenCode served bodies, one Pi rendered capture, one Pi JSONL file, and two SQLite stores. It proves that config verification admits all three lanes, JSONL never substitutes for rendered output, the TS/Pi tag shape space matches, and the synthetic unexplained bucket is empty.

## Findings and fixes

### F1a — fixed: profile-resolved historian models stopped at the Rust authority boundary

The shared loaders resolve `user base → selected user profile → project config` before hook construction. TypeScript historian calls consume `resolveHistorianModel(config, "opencode")`, so a project selecting a profile receives the overlay's primary and fallback entries. Rust authority requests did not transport that result. `TransformRequest` had no historian model field, and module preparation always used `ConfigCache.model_chain`, which re-read the raw files independently and has no profile resolution. A Rust project could therefore select `profile: "work"` and still dispatch Broca with the base model (or no model).

`rust-mode-transform.ts` now serializes the trusted, profile-resolved model identities as `historian_model_chain`. `TransformRequest` preserves absence versus an explicit empty list: absence keeps autonomous Claude Code's module-config fallback, while an OpenCode empty list means the resolved route configured no historian. Organic transform historian preparation prefers the request chain, and the eventual Broca `start` call receives that same primary/fallback order.

The regression fixture gives module config `anthropic/base-historian`, sends an OpenCode transform with `anthropic/profile-historian`, and observes the model captured by the producer driver. The dispatch uses the profile model. Under an explicit `NON-VACUITY BREAK` that ignored the request field, the fixture failed with base versus profile; the mutation was restored and the test passed.

The trust boundary survives the wire: the chain is built from `TransformDeps.historianModel` / `fallbackModels`, which come from the already-resolved `MagicContextConfig`. Project-defined `profiles` and project attempts to replace `historian.opencode` are stripped before those values exist (`project-security.ts` and its hostile matrix). The module never receives raw repository profile definitions.

### F1b — fixed: module Dreamer classification reused historian base models

When memories authority is MODULE, `runClassifyThroughModule` sends `dreamer.run_task` and Rust dispatches the classifier through Broca. The request previously omitted its already-resolved `ClassifyArgs.model` / `fallbackModels`; Rust then iterated `binding.config.model_chain`, which is the module's raw historian chain. A profile could therefore select a Dreamer model while module classification ran the base historian model.

The management request now carries `model_chain` only when the trusted TypeScript resolver produced configured Dreamer attempts. Rust validates a maximum of 16 non-empty model IDs, deduplicates them in order, and prefers them to module config. Absence preserves old autonomous/config fallback. The TypeScript test observes the profile primary/fallback on `dreamer.run_task`; the Rust producer test starts both profile attempts after a simulated outage and proves the base model is never dispatched.

Sidekick has no corresponding module/Broca inference route: in Rust transform mode it remains host-owned (module search facades do not start a Sidekick model). Its profile resolution therefore stays on the existing TypeScript path rather than acquiring a meaningless `TransformRequest` field.

### F1c — exclusion addendum: explicit Rust wrapup still rereads base historian models

`prepare_wrapup_fire` receives the same `TransformRequest` but still assembles with `ConfigCache.model_chain`. Consequently the F1a fix covers organic transform firing, while an explicit Rust wrapup can still ignore the selected profile. This is a clear profile parity finding, but the concurrent hunt #4 owner is changing the wrapup/LKG matrix, so no fix was landed here.

**Addendum to the hunt #4 wrapup brief:** make wrapup prefer the trusted request chain with the same absent-versus-empty semantics as organic preparation, then assert the producer's exact attempt order under a profile overlay and a hostile repository model override.

### F2 — structural: OpenCode variants have no Broca attempt vocabulary

A profile entry may be `{model, variant}`. TypeScript treats model plus variant as one attempt identity and intentionally permits the same model with different variants. Broca's current `start(session, system, prompt, model)` wire accepts only a model string. The new historian and Dreamer transports therefore deduplicate model identities and cannot reproduce a profile whose fallback ladder changes only the OpenCode variant.

**Brief:** extend the Broca run-start contract with an optional provider-neutral inference qualifier, or define an explicit module-side profile block whose accepted qualifiers Broca owns. Do not silently encode OpenCode variant names into model IDs. Acceptance is a profile with one model at two variants where TS OpenCode and Rust/Broca execute the same ordered attempt semantics, plus an unsupported-qualifier case that warns and fails closed to a documented fallback.

### F3 — structural: effective config has two resolvers and no shared full-field golden

The hostile and benign source walk gives this effective ownership matrix:

| Field family | TS/OpenCode effective source | Rust transform effective source | Verdict |
| --- | --- | --- | --- |
| Historian model attempts | trusted loader + active profile | host-resolved `historian_model_chain` for organic firing | fixed/pass for organic model identities; F1c wrapup gap; F2 variants |
| Dreamer classifier models | trusted loader + active profile | trusted `dreamer.run_task.model_chain` | fixed/pass for model identities; F2 variants |
| Sidekick models | trusted loader + active profile | host-owned; module facades perform no Sidekick inference | pass by ownership |
| Execute threshold | trusted loader and per-model resolution | host `effective_execute_threshold` | pass |
| Auto-search and caveman | trusted loader | host request fields | pass |
| History budget and cache TTL | trusted per-model resolution | host request fields, config fallback only when absent | pass |
| Memory enable/auto-promote and memory budgets | trusted user/project merge | module `ConfigCache` reread | source-aligned, no shared golden |
| Compaction, docs, temporal, smart drops | trusted user/project merge | module `ConfigCache` reread | source-aligned, no shared golden |
| Prompt guidance | trusted USER text/path resolution | immutable host bytes on request, module USER fallback | pass |
| Project hidden-agent model injection | stripped before schema merge | absent from request; module ignores project model keys | pass |

This is not a demonstrated served-byte failure after F1, but it is a structural regression seam: TypeScript uses schema validation, substitution policy, profile resolution, and project-security normalization, while `config.rs` implements a hand-maintained subset over raw JSONC. A newly added render-affecting field can silently reach only one authority.

**Brief:** generate benign and hostile effective-config vectors from the TypeScript resolver and consume the render-relevant projection in Rust. Include every row above, profile selection precedence, unknown/invalid profiles, project-defined profiles, repository model injection, threshold lowering/raising, project secret substitutions, absent versus explicit defaults, and per-model values. Assert the exact `TransformRequest` projection as well as `ConfigCache` fallback behavior.

### F4 — structural addendum only: the emergency/overflow ladder lacks one shared served-byte matrix

The individual rungs are implemented and locally covered:

1. At the derived force band (normally 85%), OpenCode, Pi, and the module run tiered oldest-first emergency tool reclaim toward the same target-headroom planner while protecting recent tags and ctx_reduce exemplars.
2. At the absolute 95% wall, OpenCode Rust authority refuses LKG/raw fallback when the module call itself fails and throws the exact calm `ENGINE_RECONNECTING_USER_MESSAGE`. A successful module response serves its reduced bytes.
3. Provider-proven overflow arms the durable recovery path and keeps fail-closed/LKG admission stricter than a proactive estimate.
4. Pi performs the historian wait and emergency drops but cannot abort a turn because its extension API has no abort primitive; PARITY.md §9c documents that intentional control-surface difference.
5. Boot/storage fail-closed uses the shared actionable doctor copy, while Rust emergency transport failure uses the reconnect-and-retry copy; those are different failure classes, not copy drift.

There is still no single matched-state fixture that walks TS authority, Rust authority, and Pi through 85%, 95%, each emergency drop tier, provider-overflow arming, module failure, invalid/oversized LKG, oversized raw, and terminal refusal while comparing both decision and served bytes. This is the same LKG/fault-matrix area owned by the concurrent hunt #4 brief. No implementation or fixture was landed in that exclusion-fenced area.

**Addendum to the hunt #4 LKG brief:** add Pi's no-abort disposition and require each row to assert `(decision, served source, exact bytes or exact thrown copy)`. A percentage-only assertion is insufficient because soft versus hard geometry can differ per leg; adjudicate each leg in its own value space, following hunt #4's ordinal precedent.

### F5 — fixed ledger drift: Pi Channel 2 now uses `nextTurn`

PARITY.md §9 still claimed Pi delivered Channel 2 with `deliverAs: "steer"` and an idle `"followUp"` fallback. Production code and its regression test use `nextTurn` at both `tool_result` and clean-stop `agent_end`: the hidden custom message joins the next real user turn and neither steers the active turn nor starts an autonomous continuation. The ledger now records the live mechanism. The shared reminder copy, hidden display, token-bound lease, and model visibility remain unchanged.

## Pi first-class lane verdicts

### A. Tagging and fallback-tag adoption

**Verdict: pass in source/integration fixtures; live render capture pending.** Pi uses real JSONL `SessionEntry.id` when available, then atomically adopts an in-flight `pi-msg-*` fallback by raw-message fingerprint. Tool tags adopt by unique `(assistant timestamp, call id)` owner. Collision folds retain the surviving tag/drop state, maxima, source content, pending operations, and tagger aliases. The tests cover stable prefix reuse, stale-negative re-probe, ambiguous duplicates, tool-owner migration, and racing real-id collision folds. The differ's synthetic TS/Pi rendered capture has an equal tag shape space and zero unexplained classes.

### B. Marker drain shapes

**Verdict: pass; mechanism divergence remains accurately ledgered.** `marker-drain-wire-stability.test.ts` runs the physical `SessionManager` JSONL path. A deferred publication consumes pending drops, renders the new m[0], writes one native compaction entry, and serves the trimmed tail in one pass. The next pass plus legitimate tail growth preserves the entire previous served prefix byte-for-byte. OpenCode uses its deferred marker mechanism; Pi owns `session_before_compact`, as PARITY.md §4 permits.

### C. m[0]/m[1] rendering

**Verdict: same effective text producer, with ledgered envelope exceptions.** Pi's m[0] uses the shared memory renderers, decay curve, profile budget, workspace visibility, and the exact sibling order `project-docs → user-profile → session-history → project-memory → memory-mural`, joined with two newlines. Pi's m[1] uses the same update ordering and single-newline section join. OpenCode timestamp-derived compartment date attributes remain absent on Pi (PARITY.md date-attribute entry), and mural image envelopes are host-native (§26). The new differ removes neither difference silently: it compares section shape and reports lane-only keys for adjudication.

### D. Nudges

**Verdict: reminder math/copy pass; carrier/timing intentionally differ.** Channel 1 shares `{U,T}`, cadence, templates, and persisted lease state; OpenCode appends to an output string while Pi appends one `TextContent` block to the tool result. Channel 2 shares the reminder builder and token-bound pending/claimed/delivered lifecycle. OpenCode uses a hidden synthetic queued part; Pi uses a hidden custom message with `deliverAs: "nextTurn"`. The differ compares normalized templates separately from carrier vectors so an expected carrier difference cannot mask copy drift.

### E. Clone inheritance

**Verdict: intentional divergence spot-verified.** Pi fork handling reads the source JSONL header, filters state to IDs/ordinals in the cloned branch prefix, copies compartments/tags/reduction/caveman/image-strip/note/fact state transactionally, and migrates only a still-applicable deferred marker. Destination-not-empty and mid-copy failures are atomic. OpenCode still does not inherit because `/fork` re-mints message IDs; PARITY.md §25 remains true.

### F. Caveman and stripping

**Verdict: effective-content pass; placeholder array shape intentionally differs.** Pi persists pristine `source_contents`, replays deterministic caveman depth on every JSONL rebuild, and uses the shared reducer/drop vocabulary. Pi splices placeholder-only non-user messages on a later history-refresh boundary, while OpenCode retains an empty sentinel for array/cache shape; PARITY.md §2 remains true. The differ compares reduction/drop vocabulary and reports physical shape separately rather than requiring equal array lengths.

## Unexplained-byte-class investigation

The hermetic three-lane run produces no unexplained TS/Pi class. That result is intentionally narrow: it proves the new bucket and denominator machinery are non-vacuous, not that live Pi is empty. A live run must investigate every lane-only shape against PARITY.md and either attach it to the exact ledger rationale or open a concrete finding; merely appending a new class name to a catalogue is not an adjudication.

No implementation was landed in the exclusion-fenced `ctx_search` corpus, historian publication durability, `ctx_expand` titles, or wrapup/LKG matrix. F1c and F4 are recorded only as addenda for the owning lane.

## Honest-empty declaration

Hunt #5 is **not empty**. It fixes profile-resolved organic historian and Dreamer delivery into Rust/Broca, corrects stale Pi nudge documentation, adds a first-class Pi dump/render lane, and records four structural follow-ups (wrapup profile delivery, qualifier transport, effective-config goldens, and the exclusion-fenced emergency served-byte matrix). The standing honest-empty counter therefore remains **0/3**. No master push is part of this work.
