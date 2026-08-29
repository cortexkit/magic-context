# TS ↔ Rust ↔ Pi producer and maintenance parity hunt #11

## Method, denominators, and deployment fence

TypeScript remains the OpenCode specification, while comparisons stay inside each harness/profile value space. Rust-lane admission remains ASTROCYTE plus ENGRAM only. `scripts/audit-transform-wire-parity.py` retains the hunt 1–10 axes and adds merged-source producer, mural, and wrapup contracts plus an aggregate unexplained bucket; `--live` adds durable Rust recomp, wrapup, and Dreamer-applier inventories. The source contracts are explicitly labeled `merged_source_contract_not_deployed_runtime`: they are merged-code expectations, not claims about a long-running TypeScript process that predates the merge.

The live probe ran on 2026-08-28. An all-directory inventory covered 1,375 provider captures, and the final date-bounded rerun covered 202. Its maintenance cutoff was `1787875200000` (2026-08-28 00:00 UTC). A second all-history inventory used cutoff 0. Both SQLite paths remained read-only/query-only. No provider request prose, prompt bytes, paths, full session ids, memory text, or database rows were copied into the repository.

This hunt has findings and fixes, so it is **not** an honest empty. The standing counter remains **0/3**.

## Axis A — historian producer request

### Finding and fixes

The prompt vendoring guard was red at the starting revision. The generated TypeScript v8.7.4 system prompt was 63,470 bytes (`c2aa67bd77a89d28b8f52752e7694932ab7304f6e9462e22fac0f2148083e0c8`), while Rust's committed `historian-system-prompt.txt` was 63,377 bytes (`dbc00a2c857c747f0ebcd57ff9e2a92ff8c5868871d25a547798a6b3f50cfd30`). Re-vendoring through `crates/mc-module/gen/gen-historian-system-prompt.ts` restores an exact 63,470-byte match.

Rust also made the flash calibration explicit in its real producer request: temperature 0.1 and `max_output_tokens=32000` (`crates/mc-module/src/historian_producer.rs:33-45,575-641`). OpenCode and Pi left one or both values absent unless the user configured them, despite using the same calibrated prompt. `resolveHistorianAgentOverrides` now defaults OpenCode's historian, historian-recomp, and historian-editor agents to temperature 0.1 and `maxTokens=32000`, while explicit user overrides still win (`packages/plugin/src/shared/model-resolution.ts`; registration at `packages/plugin/src/index.ts`). Pi now loads `historian-calibration-extension.ts`, which rewrites the serialized output-budget shape for Anthropic/OpenAI/Mistral, Gemini, and Bedrock requests. First, repair, fallback, and editor passes all carry the same values. All three legs retain the 600,000 ms await budget.

### Request shape and reference selection

The producer contract now verifies a clean role split on all three legs: OpenCode loads the registered system prompt and sends one synthetic user part (`compartment-runner-historian.ts:385-416`); Pi replaces the system prompt with `--system-prompt` and sends one positional/stdin user message (`subagent-runner.ts::buildArgs`); Rust sends `SendParams.system` plus `prompt`, never concatenating the system text into the user message (`historian_producer.rs:607-645`). The differ reports `[system,user]` for OpenCode, Pi, and Rust.

Reference selection is matched: four deterministic rotating seeds, FNV-1a over JavaScript UTF-16 code units, last-six session compartments, and a category-grouped project-memory block for dedup (`reference-retrieval.ts:44-47,88-149,198-233`; `historian_prompt.rs:12-15,128-222,285-357`). Prompt assembly order and separators match (`compartment-prompt.ts:126-148`; `historian_prompt.rs:360-382`). Model ids/qualifiers are intentionally compared per harness/profile value space: OpenCode resolves `historian.opencode` entries and per-entry variants; the module consumes the host wire chain or a module-catalog `module_model`/`module_fallback_models` replacement (`model-resolution.ts:35-119`; `crates/mc-module/src/config.rs:380-428`; `crates/mc-module/src/lib.rs:4857-4860`).

**Residual evidence brief — actual provider-side producer dump.** The new contract proves the production constructors and byte assets at merged HEAD, and Rust's fake Broca server captures its real `session.send` request. No privacy-safe trace currently joins an OpenCode/Pi serialized provider request to the Broca request. Acceptance: one matched chunk fixture per OpenCode TS/Rust lane; hashes for system and user bytes; role count/order; temperature/output/await triple; selected seed ids, recency ordinals, and memory revision; resolved model plus qualifier/fallback ordinal; no prose; and a deployed-build coordinate. This avoids confusing the known stale long-running TS deployment with merged behavior.

**Residual behavior brief — explicit content language.** OpenCode and Pi append `withContentLanguageDirective(..., { preserveUserQuotes: true })` when `language` is configured. Rust sends the base vendored prompt and has no historian-language field in `McModuleConfig`. Default/unset language is byte-identical; explicit language is not. Acceptance: add a module config/wire field and a Rust renderer golden against `agents/language-directive.ts` rather than locally guessing at concatenation.

## Axis B — recomp and session upgrade under Rust authority

**Fixed:** the command path already sent full `/ctx-recomp` to `session.recomp`, but silently discarded typed partial ranges and ran `/ctx-session-upgrade` through the TypeScript recomp/memory-migration orchestrator against module-owned state (`command-handler.ts:906-1038`). The TUI RPC path was worse: both `recomp` and `upgrade` always selected the TypeScript orchestrator (`rpc-handlers.ts:1020-1115`).

Full Rust recomp now routes module-side from both command and RPC surfaces with a replay-safe command id. Partial Rust recomp refuses clearly because the module has no range contract. Rust session-upgrade also refuses clearly and names the authority drain requirement; neither refusal touches context or module state (`maintenance-authority.ts`; `command-handler.ts:906-1038`; `rpc-handlers.ts:1061-1119`). Focused regressions prove no module call for partial/upgrade refusal, no TS `runUpgrade`, and a real `session.recomp` RPC envelope.

## Axis C — wrapup full loop

The implementations match on the requested decisions. TypeScript resolves the protected-tail boundary, computes token-capped expected chunks, acquires/renews both the wrapup marker and compartment lease, runs sequential historian chunks, requires boundary advance, and drains until the keep watermark (`wrapup-orchestrator.ts:103-267,269-527`). Rust resolves the same geometry-sensitive boundary, honors the positive keep value without a 5/100 clamp, runs sequential producer rounds until the watermark or request budget, fences snapshot/revert generations, and emits `completed`, `nothing_to_compact`, `already_in_progress`, `retryable`, or terminal `failed` (`crates/mc-module/src/lib.rs:6218-6915`).

Matched regressions cover empty, active, lease timeout, zero progress, partial progress, producer failure, ownership loss, and success at the command facade (`command-handler.test.ts:1102-1209`). Module tests prove multi-round drain, drain beyond five rounds, keep=1 and keep=250, geometry-sensitive user snapping, retryable snapshots, and terminal replay (`crates/mc-module/src/lib.rs:26831-27240`).

**P11-LIVE-WRAPUP-COVERAGE — evidence finding.** Both the post-midnight and all-history live module-store inventories contain zero `mc_wrapup_commands` rows. Therefore no live matched fixture state or round-count comparison is claimed. Acceptance: execute quiescent TS and Rust wrapups over matched raw-message/token geometry, then compare target boundary, rounds, coverage advance, created compartments, and terminal vocabulary. This is coverage absence, not an observed behavior divergence.

## Axis D — mural compose bytes

The host remains the only image/cue producer. TypeScript stores the host artifact in `mural_manifest`; the Rust adapter transports the same data URL/hash into `mc_project_mural_artifacts`. Composition gates match on memory enabled, mural enabled, vision support, and non-empty data URL (`inject-compartments.ts:2024-2082`; `crates/mc-module/src/m0_compose.rs:22-23,138-158,454-474`). Both append the exact 70-byte block with the same two-newline separator:

`sha256:201ca8b209e9081422b4f75c8955f3e3fe2b85a9eefcd786dc9444e98f9668b6`

The differ's `mural_compose_contract` is empty. Cue-facade write coverage remains in the module-backed Dreamer tests, while live operator inventory continues to alarm on host/module artifact-hash disagreement.

## Axis E — Dreamer non-classify writes and ctx_memory refusal

`resolveDreamerModuleRoute` resolves durable memory authority before every map/verify applier; `DRAINING` is transient and `MODULE` produces a generation-fenced route (`dreamer/module-apply.ts:36-76`; task selection at `task-executor.ts:273-295`). `map-memories` sends mirrored module ids/content hashes through `memory.set_mapping`; `verify` sends the same identity fence through `memory.set_verification`. Only the non-module leg enters the lease-guarded TypeScript write transaction (`map-memories.ts:435-558`; `verify.ts:362-526`). New tests assert accepted module writes and prove the context mirror remains unchanged. The Rust handler already pins hash/generation/idempotency behavior (`crates/mc-module/src/lib.rs:10025-10124`, regression `verification_and_mapping_facades_are_fenced_hash_guarded_and_idempotent`).

The `ctx_memory` surface remains fail-closed: MODULE routes through the facade, DRAINING returns resend/refusal copy, and a missing module protocol never falls back to TypeScript (`packages/plugin/src/tools/ctx-memory/tools.test.ts:430-490`; module draining matrix at `crates/mc-module/src/lib.rs:24068-24165`).

Live maintenance observed two post-midnight and 64 all-history `mc_dream_task_commands`, closing non-empty module Dreamer-applier coverage without exposing response JSON.

## Axis F — unexplained buckets and delivery

The historian producer, mural compose, wrapup, provider wire, facade, Pi, telemetry, engine-adjacent, and operator-read buckets remain. Producer, mural, wrapup, and observed maintenance unexplained buckets are empty after the fixes. `zero_live_rust_recomp_commands` and `zero_live_rust_wrapup_commands` now live under `coverage_gaps`, and leg 8 reports `GAP` rather than treating absence as either a finding or a closed/empty axis; all-history inventory proves those are genuine zero-coverage classes, not a too-recent cutoff artifact. There are also zero live Rust recomp rows, so the corrected RPC/command routing remains a post-deploy exercise.

Landed clear fixes:

1. re-vendor the exact v8.7.4 Rust system prompt;
2. apply the calibrated 0.1/32k defaults to OpenCode historian agents;
3. enforce the same calibration on Pi's serialized historian provider requests;
4. route Rust TUI recomp through `session.recomp`;
5. refuse unsupported Rust partial recomp and session upgrade instead of crossing authority; and
6. extend the differ/live helper with producer, mural, wrapup, maintenance, coverage-gap, aggregate unexplained, and non-vacuity contracts.

No master push is part of this work.
