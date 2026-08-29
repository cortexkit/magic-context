# TS ↔ Rust ↔ Pi transform structural parity hunt #7

## Method and denominators

This hunt starts from the operator-facing read surface. TypeScript remains the behavioral specification, while each leg is adjudicated in its own value space: OpenCode session identity and provider events remain host-owned; `context.db` is the shared TypeScript read model; Rust transform authority additionally owns canonical transform state in `store.db`; Pi and OMP own Pi-compatible JSONL source identity. Counts from unlike sessions are inventory, never parity evidence.

`scripts/audit-transform-wire-parity.py` retains every hunt 1–6 wire, facade, Pi, telemetry, and engine-adjacent axis. Hunt 7 adds `operator_read_state`, privacy-preserving Rust reject-error fingerprints, independent context/module storage versions, host/module mural hashes, module-versus-host status fields, `--window-report-ledger`, and `--omp-session-dir`. The built-in expected Rust set remains ASTROCYTE plus ENGRAM only. SUBCONSCIOUS remains deliberately TypeScript because its live project config is empty.

The hermetic differ test executes the real script with config-verified TS/Rust bodies, a Pi rendered capture, Pi and OMP JSONL sources, a provider-overflow ledger row, and synthetic context/module databases. It proves that Rust operator truth selects module usage/compartment/tag/mural fields, TypeScript operator truth selects context fields, both storage-version lanes remain visible, the mural hashes match, and all unexplained buckets are empty. No production dump, session, ledger, or user database is versioned; live counts remain a post-deploy step.

## Axis verdicts

### A. Doctor/CLI versus Rust engine truth — one unsafe migration fixed; doctor remains structurally partial

**Fence and version verdict: no false healthy fence, but no unified doctor verdict.** OpenCode doctor reads and reports durable `authority_managed` markers before normal checks (`packages/cli/src/commands/doctor-opencode.ts:665-680`) and applies the context schema fence before integrity/count probes (`doctor-opencode.ts:1264-1379`). Rust separately reports its live module-store version and binary ceiling (`crates/mc-module/src/lib.rs:14573-14588`). Neither value substitutes for the other. The regular doctor therefore proves `context.db` health, not `mc-store` health; its row counts are host/shared-read-model inventory, not Rust canonical compartment/tag totals.

`doctor repair-db` deliberately salvages only `context.db` (`packages/cli/src/commands/doctor-repair-db.ts:434-641`). That is the right ownership boundary, but support copy must not imply it repairs `store.db`. Module-store repair/reachability remains a separate structural brief below.

**`migrate-session`: pass.** It checks source and target authority domains, refuses an unreachable module while markers exist, and rejects any surviving module session cache before writing either database (`packages/cli/src/commands/migrate-session.ts:162-219`). Its later context transaction runs only after that proof.

**Fixed: `doctor migrate` could export stale host mirrors from a Rust-authority session.** The OpenCode→Pi/OMP migrator copied OpenCode raw messages plus `context.db` compartments/facts but did not inspect authority at all (`packages/cli/src/commands/migrate.ts:migrateOpenCodeSessionToPi`). A module-managed source could therefore produce a plausible JSONL and stale/empty context state while canonical tags and compartments remained in `mc-store`. `moduleManagedProjectForSession` now joins `session_projects` to `authority_managed` (`migrate.ts:299-322`) and refuses before journal claim or staged-file write. The regression proves zero file writes and zero journal rows.

**Structural brief — unified doctor engine projection.** Add a read-only doctor projection that resolves every recent OpenCode session's live config authority, reads `session.status` and module `storage_versions` only for Rust sessions, and labels context/module repair domains separately. Acceptance: corrupt/missing/newer `context.db` and `store.db` are independently classified; Rust compartment/tag/usage verdicts never come from host mirrors; TS sessions explicitly show no module authority; an unreachable marked module fails unknown/fenced rather than healthy; repair commands name exactly one store; and no doctor probe mutates either database.

### B. TUI/RPC/sidebar read parity — two Rust truth defects fixed; one lifecycle breakdown remains unavailable by design

**Usage and compartment totals: pass after source selection.** `session.status` returns module `last_usage`, compartment count/tokens, pending drops, and tag total from one store snapshot (`crates/mc-module/src/lib.rs:5955-6216`; `crates/mc-store/src/lib.rs:7063-7188`). The sidebar merges those fields for Rust and retains context values for TS (`packages/plugin/src/plugin/rpc-handlers.ts:196-567`). The standalone `compartment-count` RPC now uses the same module count in Rust mode instead of always querying `context.db` (`rpc-handlers.ts:868-886`, `registerRpcHandlers`). If module status is unreachable, all three RPC reads return an explicit error; the sidebar retains its last known snapshot and the status dialog warns instead of rendering an authoritative-looking empty host mirror. Non-TUI `/ctx-status` likewise omits mirror values and reports module status unavailable (`packages/plugin/src/hooks/magic-context/command-handler.ts:765-855`).

**Fixed: `/ctx-status` displayed zero/stale host tag totals for Rust sessions.** `buildStatusDetail` now uses `moduleStatus.tag_count` as the total. `mc-store` does not persist context.db's `active`/`dropped` classification, so the response sets `tagCountsAuthoritative=false`; the TUI displays both breakdown rows as `n/a (module total only)` rather than fabricating zeroes, while retaining the exact total. Tests pin module total 9 against empty host mirrors.

**Cache-lane TTL: pass by host ownership.** Cache TTL config, `last_response_time`, and provider completion events are host-owned before the transform-authority split. Both lanes use the same `safeParseTtl` derivation. `never` becomes `cacheTtlMs=-1` and `cacheRemainingMs=-1`, not JSON-invalid Infinity or ambiguous zero (`rpc-handlers.ts:783-809`; regression at `rpc-handlers.test.ts:cacheNeverExpires`).

**Structural brief — Rust tag lifecycle projection.** If Active/Dropped byte attribution is required, add lifecycle fields to the module status snapshot rather than inferring them from pending drops or stale host rows. Acceptance: a matched TS/Rust sequence covering mint, queued drop, applied drop, expand, and restart yields exact `(counter, active, dropped, total, active_bytes)` semantics; all values come from one snapshot; and the TUI can remove the explicit unavailable label.

### C. Mural on Rust — compose pass; stale status config fixed

OpenCode TS and Rust call the same host `resolveMuralWire`, including cue-coverage gate, overflow-pool selection, deterministic render, model vision gate, content hash, PNG geometry, and memory budget (`packages/plugin/src/features/magic-context/mural/resolve-mural.ts:33-102`; `render-trigger.ts:45-176`). Rust transports the already-rendered data URL/hash (`packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:1213-1230,1947-1957`), stores it under `mc_project_mural_artifacts`, and composes the same `<memory-mural>` text iff enabled, vision-capable, non-empty data exists, and memory is enabled (`crates/mc-module/src/lib.rs:172-208,7988-8012`; `crates/mc-module/src/m0_compose.rs:138-158,454-478`). No second cue selection or geometry implementation exists in Rust. The differ now alarms on host/module content-hash mismatch without emitting image bytes.

**Fixed:** status detail still read retired `config.experimental.mural`; resolved runtime config exposes graduated top-level `config.mural`. The sidebar therefore omitted a valid mural even though transform composition included it. `buildStatusDetail` now reads the top-level field and a regression inserts a real manifest and observes `present=true` (`packages/plugin/src/plugin/rpc-handlers.ts:666-674`).

### D. Overflow-report ledger and geometry — pass; same host event and same geometry resolver

The provider error reaches the lane-neutral OpenCode event handler, which detects overflow and writes the ledger before any TS/Rust transform branch (`packages/plugin/src/hooks/magic-context/event-handler.ts:293-387,429-518`). The row builder preserves only observed facts and per-model largest success (`window-report-ledger.ts:302-365`), so identical provider events have identical row shapes regardless of transform authority. Session-error rows may lack provider/model fields when OpenCode did not supply them; that is an event-shape distinction, not a lane distinction.

Both authorities call `resolveContextWindowGeometry`. TypeScript computes emergency hard-wall pressure from `usableHard` (`packages/plugin/src/hooks/magic-context/transform.ts:1273-1283`); Rust serializes the exact host `usable_soft`, `usable_hard`, and derivation and uses the same hard denominator (`rust-mode-transform.ts:814-843,1658-1697`). The module prefers transported `usable_soft` for scheduler budget (`crates/mc-module/src/transform.rs:5814-5827`). The new ledger differ inventories key shapes, geometry, status, and parse errors without storing provider error text.

### E. Redaction — two shared-surface defects fixed; module parity remains structural

**Fixed: plugin logs had no redaction.** `shared/logger.ts` serialized messages, error stacks, and arbitrary objects directly. All TS and Rust-host adapter logs now pass prose through `sanitizeDiagnosticText`, objects through `sanitizeConfigValue`, and swallowed-write diagnostics through the same redactor (`packages/plugin/src/shared/logger.ts:23-85`). Numeric usage fields remain readable while API keys, authorization values, paths, and token-shaped values are masked. The regression writes secret and numeric fixtures through the real production logger and reads the file.

**Fixed: Pi issue diagnostics used a bespoke, broader key classifier.** It redacted benign object keys such as `execute_threshold_tokens` and emitted different secret markers/path forms from OpenCode. `diagnostics-pi.ts:sanitizeString/sanitizeValue` now delegates to the shared redactor (`packages/cli/src/lib/diagnostics-pi.ts:156-162`). Tests pin numeric/budget preservation and the same access-token/API-key classes.

**Structural brief — generated module redaction contract.** Rust `session.status.pass_trace.last_reject_error` remains raw structured error text, and module `eprintln!` paths do not share the TypeScript secret classifier. Generate provider-neutral redaction vectors and one Rust implementation from the shared contract. Acceptance: every secret/key fixture in `shared/redaction.test.ts`, numeric scalar, path form, provider error, status envelope, stderr line, and support-bundle serialization produces equivalent masked classes; malformed values fail closed; no raw provider body is persisted merely to redact it later. The differ fingerprints reject errors instead of copying their bytes.

### F. OMP sessions on shared surfaces — dashboard pass; doctor issue flow remains partial

The dashboard's Pi-compatible scanner resolves Pi and positively-detected OMP roots, profiles, XDG layouts, and duplicate logical sessions (`packages/dashboard/src-tauri/src/pi_sessions.rs:314-522`). Session listings and cache-event reads both consume `scan_pi_compatible_session_dir` (`packages/dashboard/src-tauri/src/db.rs:1032-1089,4653-4685`), so OMP JSONL receives the same read/parser/title/cache treatment as Pi. Existing Rust tests cover OMP installation evidence, profiles, title-slot sessions, eventless listing, and multi-root deduplication.

OMP doctor reports the resolved sessions root but has no recent-session picker or issue-bundle scanner (`packages/cli/src/commands/doctor-omp.ts:303-315`), unlike Pi diagnostics. This is read-only but not a one-line change because OMP flat/profile/XDG discovery and positive installation evidence must match the dashboard scanner. Brief: extract one harness-neutral Pi-compatible session scanner consumed by CLI and dashboard; preserve source harness attribution so UI filters can distinguish Pi from OMP; acceptance includes all dashboard OMP discovery fixtures plus doctor issue selection and no OMP installation false positives.

### G. Differ unexplained-byte bucket — hermetic empty

The pre-existing TS↔Pi unexplained shape-space bucket and TS↔Rust facade byte bucket are unchanged. Hunt 7 adds only operator-read invariants: matched host/module mural hashes, independent storage versions, and privacy-preserving reject-error fingerprints. The hermetic run reports no wire/facade/operator unexplained class and no parse error. This is an honest narrow empty for the bucket only; a live capture must still adjudicate every lane-only shape against `packages/pi-plugin/PARITY.md`.

## Verification and mutation evidence

The delivery runs the hermetic differ, focused logger/RPC/migration/diagnostic regressions, plugin and CLI typechecks, generated-TUI consistency, and the full plugin/Pi/Rust suite gates. Deliberate `NON-VACUITY BREAK` mutations neutralize the migration authority refusal, logger redaction, and Rust module tag-total selection; each targeted regression reddens before restoration. Exact commands and outcomes are recorded in the task result.

## Honest-empty declaration

Hunt #7 is **not empty**. It prevents unsafe Pi/OMP migration from Rust-authority mirrors, fixes Rust status tag/compartment and graduated mural reads, unifies plugin/Pi diagnostic redaction, extends the differ across operator read surfaces, and records four structural briefs (unified doctor/store health, Rust tag lifecycle, generated module redaction, and shared OMP doctor scanning). The standing honest-empty counter remains **0/3**. No master push is part of this work.
