# Architecture

## Key-files v6 architecture

Key files are project-scoped, not session-scoped. The Dreamer aggregates primary-session read history, asks an AFT-enabled subagent to produce one stitched content block per chosen file, validates the single-file contract, then commits rows into `project_key_files`. The plugin computes each row's `content_hash` from disk at commit time; unreadable files use the `"<missing>"` sentinel and start with `stale_reason = 'missing'`.

Every replacement commit runs under `BEGIN IMMEDIATE`, verifies the Dreamer lease with a pure read, deletes/reinserts the project's rows, and bumps `project_key_files_version` in the same transaction. System-prompt injection caches `{value, version}` per session and recomputes only on first access, cache-bust, or version mismatch, preserving prompt-cache byte stability while allowing OpenCode and Pi to invalidate each other through the shared SQLite version row.

Injection renders only stored DB content. Disk drift queues a CAS-protected stale update and never changes the bytes already being rendered; stale writes do not bump the version because they do not affect `<key-files>` output. Subagent sessions skip before the version lookup so subagents never poison or consume key-files context.

> All `src/` paths below are relative to `packages/plugin/` — the published npm package.

## Pattern Overview

**Overall:** Use a plugin-driven orchestration pattern centered on `@opencode-ai/plugin` entrypoints in `src/index.ts`.

**Key Characteristics:**
- Route all OpenCode integration through thin adapters in `src/plugin/` and keep feature logic in `src/hooks/`, `src/features/`, and `src/tools/`.
- Use SQLite-backed durable state from `src/features/magic-context/storage*.ts` for tags, pending ops, compartments, memories, dreamer queue state, message-history index (FTS-backed), git-commit index, key-file pinning state, todo-state snapshots, and per-session cache-stability watermarks (`cleared_reasoning_through_tag`, `stripped_placeholder_ids`, `todo_synthetic_*`).
- Use hidden subagents from `src/agents/*.ts` (`historian`, `historian-editor`, `dreamer`, `sidekick`) plus prompt builders in `src/features/magic-context/dreamer/task-prompts.ts`, `src/features/magic-context/sidekick/agent.ts`, `src/features/magic-context/sidekick/core.ts`, and `src/hooks/magic-context/compartment-prompt.ts`.
- Replay all persistent message mutations (reasoning clearing, structural-noise stripping, placeholder stripping, merged-assistant reasoning stripping, processed-image stripping, system-injected stripping, caveman compression, synthetic-todowrite injection) on every transform pass — including defer passes — so the wire shape stays byte-identical and Anthropic prompt cache survives.
- Select the SQLite backend at runtime in `src/shared/sqlite.ts` — `bun:sqlite` under Bun, `better-sqlite3` under Node (Pi) and Electron (Desktop). Electron uses `nativeBinding` via `src/shared/native-binding.ts` to load the matching ABI prebuild from the per-session cache directory.

## Layers

**Plugin bootstrap:**
- Purpose: Register the plugin, load config, wire agents, hooks, commands, tools, and the RPC server.
- Location: `src/index.ts`
- Contains: Plugin factory, config-warning surface, hidden agent registration, conflict detection (DCP/OMO/auto-compaction), auto-update checker startup, RPC server start, dream-schedule timer start.
- Depends on: `src/config/index.ts`, `src/plugin/`, `src/features/builtin-commands/commands.ts`, `src/shared/model-requirements.ts`, `src/shared/rpc-server.ts`, `src/shared/conflict-detector.ts`, `src/hooks/auto-update-checker/`.
- Used by: Bun build output at `dist/index.js` and OpenCode plugin loading.

**Plugin adapters:**
- Purpose: Keep OpenCode-facing handlers small and delegate real work.
- Location: `src/plugin/event.ts`, `src/plugin/messages-transform.ts`, `src/plugin/tool-registry.ts`, `src/plugin/hooks/create-session-hooks.ts`, `src/plugin/rpc-handlers.ts`, `src/plugin/dream-timer.ts`, `src/plugin/conflict-warning-hook.ts`
- Contains: Hook wrappers, tool registration, per-session hook construction, RPC endpoint handlers, dream-timer lifecycle, conflict-warning delivery.
- Depends on: `src/hooks/magic-context/`, `src/tools/`, `src/features/magic-context/`, `src/shared/rpc-*`.
- Used by: `src/index.ts`.

**Magic-context runtime:**
- Purpose: Execute message transforms, lifecycle hooks, nudging, compaction reactions, command handling, historian/compressor coordination, auto-search, and todo-state synthesis.
- Location: `src/hooks/magic-context/`
- Contains: Transform pipeline (`transform.ts`), postprocess phase (`transform-postprocess-phase.ts`), event handlers, command handlers, system-prompt hashing & adjunct injection, compartment runners (incremental / recomp / partial-recomp / compressor), strip-and-replay logic, nudge generation & placement, note nudges & visibility tracking, auto-search hint runner, synthetic-todowrite injection (B7 in postprocess), historian-state temp-file offload.
- Depends on: `src/features/magic-context/`, `src/shared/`, `src/agents/magic-context-prompt.ts`.
- Used by: `src/plugin/hooks/create-session-hooks.ts` and `src/plugin/event.ts`.

**Core feature services:**
- Purpose: Encapsulate reusable stateful services behind pure or narrow APIs.
- Location: `src/features/magic-context/`
- Contains: Storage access (`storage*.ts`), scheduler (`scheduler.ts`), tagger (legacy entrypoint via `tagger.ts`; shared logic in `src/shared/tag-transcript.ts`), compaction detection (`compaction.ts`), compaction-marker writer (`compaction-marker.ts`), memory system (`memory/`), dreamer runtime (`dreamer/`), sidekick support (`sidekick/`), key-files pinning (`key-files/`), git-commit indexer (`git-commits/`), message-index FTS pipeline (`message-index.ts`, `message-index-async.ts`), unified search (`search.ts`), overflow detection (`overflow-detection.ts`), schema migrations (`migrations.ts`), tool-definition tokens measurement (`tool-definition-tokens.ts`), user-memory pipeline (`user-memory/`).
- Depends on: `src/shared/` (sqlite, harness, logger, jsonc-parser, model-requirements, embedding helpers).
- Used by: `src/hooks/magic-context/`, `src/plugin/tool-registry.ts`, and `src/index.ts`.

**Tool surface:**
- Purpose: Expose agent tools with validated schemas and storage-backed execution.
- Location: `src/tools/ctx-reduce/`, `src/tools/ctx-expand/`, `src/tools/ctx-note/`, `src/tools/ctx-memory/`, `src/tools/ctx-search/`
- Contains: Tool definitions, argument schemas, action gating (incl. dreamer-only actions in `ctx_memory`), user-facing result formatting.
- Depends on: `src/features/magic-context/` and `src/hooks/magic-context/read-session-chunk.ts`.
- Used by: `src/plugin/tool-registry.ts`.

**Configuration and shared utilities:**
- Purpose: Centralize config parsing, defaults, path resolution, logging, SDK normalization, RPC transport, runtime SQLite selection, native-binding resolution for Electron, conflict detection, fallback-chain resolution, and harness-aware behavior.
- Location: `src/config/` and `src/shared/`
- Contains: Zod schemas, config merging with field-level fallback (`src/config/index.ts`), data-path helpers (`src/shared/data-path.ts`), buffered file logger (`src/shared/logger.ts`), JSONC parser (`src/shared/jsonc-parser.ts`), models.dev cache (`src/shared/models-dev-cache.ts`), embedding provider plumbing under `src/features/magic-context/memory/`, RPC server/client/utils/notifications (`src/shared/rpc-*`), SQLite backend selector (`src/shared/sqlite.ts`), Electron native-binding resolver (`src/shared/native-binding.ts`), harness identifier (`src/shared/harness.ts`), tag-transcript primitive shared with Pi (`src/shared/tag-transcript.ts`), model-fallback chain resolver (`src/shared/resolve-fallbacks.ts`), subagent runner (`src/shared/subagent-runner.ts`, Pi-only), OpenCode-compaction detector (`src/shared/opencode-compaction-detector.ts`), conflict detector/fixer (`src/shared/conflict-detector.ts`, `src/shared/conflict-fixer.ts`), bounded-session-map (`src/shared/bounded-session-map.ts`).
- Depends on: Node built-ins and Zod.
- Used by: All other layers.

**TUI plugin entry:**
- Purpose: Render Magic Context sidebar and `/ctx-status` / `/ctx-recomp` dialogs inside OpenCode's TUI.
- Location: `src/tui/index.tsx`, `src/tui/slots/`, `src/tui/data/`, `src/tui/types/`
- Contains: TUI command-palette registrations (with dual-path support for `api.keymap.registerLayer` and legacy `api.command.register`), sidebar slot composition, RPC-backed data layer reading from the server plugin.
- Depends on: `src/shared/rpc-client.ts`, `src/shared/rpc-types.ts`, `src/shared/rpc-notifications.ts`.
- Used by: OpenCode TUI loads `./tui` via `package.json` `exports`; ships raw TypeScript source (not bundled into `dist/index.js`).

**CLI (separate package):**
- Purpose: Provide a unified, harness-aware interactive setup/doctor wizard runnable via `npx` outside of OpenCode/Pi, plus session migration between harnesses.
- Location: `packages/cli/src/` (NOT in `packages/plugin/`; the per-plugin CLI bins were collapsed into one shared package in v0.16.1).
- Contains: Setup/doctor/migrate commands (`packages/cli/src/commands/`), harness adapters for OpenCode and Pi (`packages/cli/src/adapters/`), shared prompt/path utilities (`packages/cli/src/lib/`).
- Depends on: `@clack/prompts`, Node built-ins; no dependency on plugin runtime layers.
- Used by: Published as `@cortexkit/magic-context` on npm; invoked as `npx @cortexkit/magic-context@latest <subcommand>`.

## Data Flow

**Plugin startup:**
1. Load and merge config from `src/config/index.ts` — prefer project-root `magic-context.jsonc`, then `.opencode/magic-context.*`, then user config. Invalid leaf fields fall back to defaults with collected warnings rather than disabling the whole plugin.
2. Detect conflicts via `detectConflicts()` (DCP, OMO context-management hooks, OpenCode auto-compaction/prune). When any conflict is active, disable the full Magic Context runtime and send an ignored startup-warning message to the user's active session via `sendConflictWarning()`.
3. Start the RPC server (`MagicContextRpcServer` on localhost; ephemeral port published to `session_meta` for TUI plugin discovery).
4. Start the auto-update checker hook (`src/hooks/auto-update-checker/`) — fires once per plugin process from `chat.message`, with on-disk cross-process dedup via `getMagicContextStorageDir()/last-update-check.json`.
5. Start the dream-schedule timer (`src/plugin/dream-timer.ts`) — singleton per process; immediate startup tick + 15-minute interval; iterates every registered project directory.
6. Build session hooks in `src/plugin/hooks/create-session-hooks.ts` — create the tagger, scheduler, and compaction handler.
7. Register tools in `src/plugin/tool-registry.ts` — open the SQLite database (runtime-selected backend), initialize embeddings (lazy), and expose `ctx_reduce` (gated by `ctx_reduce_enabled`), `ctx_expand`, `ctx_note`, `ctx_memory` (with full action set; dreamer-only actions enforced at runtime by inspecting `toolContext.agent`), and `ctx_search`.
8. Register OpenCode entrypoints in `src/index.ts` — bind message transforms, system-prompt transform, event hooks, command hooks, and hidden agents (`historian`, `historian-editor`, `dreamer`, `sidekick`).

**Session transform pipeline:**
1. Enter `createMagicContextHook()` in `src/hooks/magic-context/hook.ts` — open persistent storage, set up in-memory maps (`injectionCache`, `liveSessionState`, etc.), and create the transform.
2. The outer wrapper in `src/plugin/messages-transform.ts` catches `SQLITE_BUSY`/`SQLITE_LOCKED` transient errors and other failures, persisting a short summary to `session_meta.last_transform_error` and returning unmodified messages on failure so OpenCode's prompt loop always proceeds (issue #23).
3. Run the transform from `src/hooks/magic-context/transform.ts` — tag messages, load session state, prepare compartment injection, and schedule deferred work. On every pass (including defer), replay persisted reasoning clearing using `replayClearedReasoning()` and `replayStrippedInlineThinking()` from `src/hooks/magic-context/strip-content.ts`; replay caveman compression via `replayCavemanCompression()` and `stripReasoningFromMergedAssistants()` (Anthropic-only); replay stripped placeholders and structural noise. The merged-assistant reasoning strip and the empty-content sentinel handling are provider-aware (Anthropic-specific vs. generic).
4. Run postprocessing in `src/hooks/magic-context/transform-postprocess-phase.ts` — apply pending ops, heuristic cleanup, reasoning cleanup, stale reduce-call cleanup, compartment rendering, nudge placement, deferred-note nudges, **synthetic-todowrite injection (B7)**, and auto-search hint generation. Stripped placeholder message IDs are read from `stripped_placeholder_ids` in `session_meta` (via `src/features/magic-context/storage-meta-persisted.ts`) and replayed on every pass; the persisted set is updated when new empty shells are detected on cache-busting passes only.
5. Persist session state through storage helpers exported by `src/features/magic-context/storage.ts`.

**Boundary execution:**
- Scheduler `execute` decisions are deferred when the latest assistant turn is still mid-tool-use, unless a bypass applies. The gate lives in `src/hooks/magic-context/boundary-execution.ts`: base `defer` always stays `defer`; base `execute` with no bypass becomes `defer` + a CAS-protected `session_meta.deferred_execute_state` flag when mid-turn.
- The goal is cache stability: avoid mutating tool/history/reasoning state in the middle of a multi-step assistant turn, because that would rebuild message bytes and bust provider prompt-cache writes while the turn is still accumulating tool calls.
- Bypass reasons are deliberately narrow: `force-materialize` at ≥85% usage (including overflow recovery already folded into percentage), `explicit-bust` when `historyRefreshSessions` is set (paired-producer invariant: every producer also signals pending materialization), and `subagent` (one parent-turn lifetime). No config knob controls this behavior.
- Draining uses a re-peek-and-drain pattern. The early gate may set a durable flag with `setDeferredExecutePendingIfAbsent`; the end of postprocess only re-peeks and CAS-clears with `clearDeferredExecutePendingIfMatches` after execute-gated work completed successfully on that pass. Success means the shared execute try-block reached its success point, not that any mutation count was non-zero.
- Pi mirrors OpenCode semantics in `packages/pi-plugin/src/context-handler.ts`: it uses the same decision module, `isMidTurnPi`, the same `deferred_execute_state` CAS helpers, and drains after dropped-placeholder stripping but before token accounting. For the same scheduler/base/bypass/mid-turn input, OpenCode and Pi must produce the same effective execute/defer decision.

**System-prompt adjunct injection:**
- The `experimental.chat.system.transform` hook in `src/hooks/magic-context/system-prompt-hash.ts` injects four adjunct blocks into the system prompt array: `<project-docs>` (root `ARCHITECTURE.md` + `STRUCTURE.md` when `dreamer.inject_docs=true`), `<user-profile>` (active user memories when `dreamer.user_memories.enabled=true`), `<key-files>` (session-scoped pinned files when `dreamer.pin_key_files.enabled=true`), and Magic Context agent guidance text (when `system_prompt_injection.enabled=true` and the active agent isn't matched by `skip_signatures`).
- Adjunct content is cached in memory and only re-read on cache-busting passes, so doc edits don't trigger mid-session cache busts.
- The `Today's date:` line is frozen per session via `stickyDateBySession` and updated only on cache-busting passes — prevents midnight date flips from causing spurious rebuilds.
- The reasoning-clearing watermark (`cleared_reasoning_through_tag` column in `session_meta`) is a persisted integer so clearing survives across OpenCode message rebuilds.
- Magic Context skips system-prompt injection entirely for OpenCode's internal `title`, `summary`, and `compaction` agent prompts (signature-detected) so small-model utility calls don't get the full Magic Context prompt.

**Note nudge trigger gating:**
- Three triggers can fire a note-nudge: historian publication, commit detection (text-based heuristic in `tag-messages.ts`), and `todowrite` calls where ALL todo items have a terminal status (`completed` or `cancelled`). Intermediate todowrite calls during active work do not trigger the nudge.
- The `tool.execute.after` handler in `src/hooks/magic-context/hook-handlers.ts` captures the current todo state into `session_meta.last_todo_state` on EVERY todowrite call (independent of the nudge trigger) — this snapshot drives synthetic-todowrite injection (see below).
- A 15-minute cooldown plus visibility-aware suppression prevents the same note from re-surfacing too aggressively. Suppression releases as soon as a prior `ctx_note(read)` result is no longer visible in transformed messages.

**Synthetic-todowrite (todo retention across cache busts):**
1. `tool.execute.after` captures normalized todo state into `session_meta.last_todo_state` on every real `todowrite` call (capture is pure DB write — no message mutation, cache-safe).
2. On a cache-busting transform pass, B7 in `transform-postprocess-phase.ts` reads `last_todo_state`, computes `mc_synthetic_todo_${sha256(stateJson)[:16]}`, and either idempotently re-injects (when the call_id matches the persisted one) or fresh-injects a synthetic `tool_use`/`tool_result` pair into the latest assistant message. The injection point is AFTER tagging and applyPendingOperations so the synthetic part is never tagged or targeted by `ctx_reduce` / heuristic cleanup.
3. On defer passes, B7 rebuilds from the PERSISTED snapshot (`todo_synthetic_state_json` column), NOT from the current `last_todo_state`. This keeps wire bytes identical to the prior cache-bust pass even when the agent has called `todowrite` since — preserving Anthropic prompt cache.
4. The persisted triple `(call_id, anchor_message_id, state_json)` lives in `session_meta`. Legacy rows from pre-stateJson builds (call_id and anchor populated, state_json empty) self-heal on the next idempotent re-inject by backfilling state_json from the current `last_todo_state` under sha256 collision-resistance guarantees.

**Memory and search flow:**
1. Create, update, merge, archive, or list memories through `src/tools/ctx-memory/tools.ts`. The action schema exposes the full set (`write/delete/list/update/merge/archive`); primary-agent calls are runtime-gated to `write` and `delete` only by inspecting `toolContext.agent`.
2. Store canonical records in `src/features/magic-context/memory/storage-memory.ts` and sync full-text search through the FTS triggers created in `src/features/magic-context/storage-db.ts`.
3. Generate and store embeddings through `src/features/magic-context/memory/embedding.ts` and `src/features/magic-context/memory/storage-memory-embeddings.ts`. Three embedding paths: immediate best-effort write on `ctx_memory` mutations; periodic batch sweep via the dream timer (every 15 min, drains projects in descending recency); lazy fallback inside `ctx_search`. Local embeddings use `Xenova/all-MiniLM-L6-v2` via `@huggingface/transformers` runtime-loaded with a cross-process model-load lock and heartbeat (`embedding-local.ts`).
4. `ctx_search` (`src/tools/ctx-search/`) provides a unified search surface over project memories, raw user/assistant message history (FTS-backed via `src/features/magic-context/message-index.ts`), and indexed git commits (via `src/features/magic-context/git-commits/`). Session facts are NOT a `ctx_search` source — they're always injected into `<session-history>`. Raw-message hits are filtered to ordinals strictly before the last compartment boundary so the live tail (already in context) isn't returned.
5. Inject cached project memories into `<session-history>` through `src/hooks/magic-context/inject-compartments.ts`. Memories already visible in the rendered `<session-history>` are hard-filtered from `ctx_search` results via persisted `session_meta.memory_block_ids`.

**Message-history indexing:**
- `src/features/magic-context/message-index.ts` maintains an FTS5-backed index of raw user/assistant messages keyed by `(session_id, ordinal, message_id, role, text)`.
- Index maintenance runs OUTSIDE the search hot path: async startup reconciliation processes ordinals above the `last_indexed_ordinal` watermark; live event indexing fires from `message.updated` events; `searchMessages()` is a pure FTS query with no freshness check.
- The reconciliation watermark is per-session; revert-aware cleanup runs on `message.removed` events.

**Git-commit indexing:**
- `src/features/magic-context/git-commits/indexer.ts` reads HEAD-only non-merge commits via `git log` (NUL-byte-free format separator `\x1f`), bounded by `experimental.git_commit_indexing.{since_days, max_commits}`.
- Embeddings are generated through the same embedding provider chain as memories.
- Indexing fires from the dream-timer startup tick and periodic interval; manual `/ctx-dream` does NOT trigger commit indexing.

**Dreamer flow:**
1. Detect eligible projects during `message.updated` handling in `src/hooks/magic-context/hook.ts` (debounced per-project, 12-hour cooldown).
2. Enqueue projects on a schedule through `src/features/magic-context/dreamer/scheduler.ts` and `src/features/magic-context/dreamer/queue.ts`. Queue rows are project-scoped — each host (OpenCode or Pi instance) only dequeues work for projects it has loaded.
3. Serialize dream runs with the lease in `src/features/magic-context/dreamer/lease.ts` (2-minute TTL with periodic renewal during long tasks).
4. Spawn one child session per task from `src/features/magic-context/dreamer/runner.ts` using prompts from `src/features/magic-context/dreamer/task-prompts.ts`. Each successful run also writes a row to `dream_runs` for dashboard visibility.
5. Tasks include the configured maintenance suite (consolidate, verify, archive-stale, improve, maintain-docs) plus optional post-task phases: user-memory candidate review (when `dreamer.user_memories.enabled`), smart-note evaluation (when pending smart notes exist), and key-file identification (when `dreamer.pin_key_files.enabled`).
6. A circuit breaker aborts remaining tasks and post-task phases after 3 consecutive identical-error failures, surfacing as a synthetic `circuit-breaker` task entry. Skips on AbortError and lease-loss errors.
7. Each subagent prompt call iterates the resolved model fallback chain (`dreamer.fallback_models` → builtin chain) via `promptSyncWithModelSuggestionRetry`. Abort/timeout/context-overflow short-circuits the chain so caller emergency-recovery still fires.

**Command augmentation flow:**
1. Register `/ctx-status`, `/ctx-flush`, `/ctx-recomp`, `/ctx-aug`, and `/ctx-dream` in `src/features/builtin-commands/commands.ts`.
2. Intercept command execution in `src/hooks/magic-context/command-handler.ts`.
3. `/ctx-status` and `/ctx-recomp` route through the RPC server when TUI is connected (showing native TUI dialogs) and through ignored-message notifications otherwise (Desktop/Web).
4. `/ctx-recomp` accepts an optional `<start>-<end>` range — partial recomp snaps the requested range to enclosing compartment boundaries and only rebuilds that span.
5. `/ctx-aug` runs sidekick augmentation from `src/features/magic-context/sidekick/agent.ts`; the augmentation result is appended to the user's prompt (not injected at `message[0]`) before submission.
6. `/ctx-dream` enqueues an immediate-runtime dream request, force-clearing stale started rows past the lease TTL window.

## Key Abstractions

**Magic Context hook:**
- Purpose: Own the runtime state for one plugin instance.
- Location: `src/hooks/magic-context/hook.ts`, `src/hooks/magic-context/index.ts`
- Pattern: Composition root that returns OpenCode hook handlers.

**Tool registry:**
- Purpose: Gate tool availability by config and persistent-storage readiness.
- Location: `src/plugin/tool-registry.ts`
- Pattern: Registry builder with conditional feature exposure.

**Memory store:**
- Purpose: Keep project-scoped durable knowledge searchable and mergeable.
- Location: `src/features/magic-context/memory/storage-memory.ts`, `src/features/magic-context/memory/storage-memory-fts.ts`, `src/features/magic-context/memory/storage-memory-embeddings.ts`
- Pattern: SQLite repository plus FTS and embedding side tables.

**Unified search:**
- Purpose: Cross-source retrieval over memories, raw message history, and git commits with deterministic source ranking and embedding dedup across paths.
- Location: `src/features/magic-context/search.ts`
- Pattern: Single embedding-per-query dispatched across all enabled sources; visible-memory hard-filter; sources opt-in via tool argument.

**Message-history index:**
- Purpose: FTS-backed raw user/assistant message search outside the transform hot path.
- Location: `src/features/magic-context/message-index.ts`, `src/features/magic-context/message-index-async.ts`
- Pattern: Async reconciliation + live event indexing + pure-query reads.

**Git-commit index:**
- Purpose: Per-project HEAD-only commit corpus for `ctx_search` integration.
- Location: `src/features/magic-context/git-commits/`
- Pattern: NUL-free git log reader + FTS index + embedding side table; populated by dream timer.

**Dream queue and lease:**
- Purpose: Run at most one dream worker at a time and survive restarts.
- Location: `src/features/magic-context/dreamer/queue.ts`, `src/features/magic-context/dreamer/lease.ts`, `src/features/magic-context/dreamer/storage-dream-state.ts`, `src/features/magic-context/dreamer/storage-dream-runs.ts`
- Pattern: SQLite-backed queue plus cooperative lease lock plus durable run-history table.

**Key-files pinning:**
- Purpose: Inject up to N project files into the system prompt as `<key-files>` content for the active session.
- Location: `src/features/magic-context/key-files/identify-key-files.ts`, `src/features/magic-context/key-files/read-stats.ts`, `src/features/magic-context/key-files/storage-key-files.ts`
- Pattern: Per-session selection by Dreamer; budget-bound rendering; symlink-safe realpath check.

**User memory pipeline:**
- Purpose: Extract user behavioral observations from historian output, collect candidates, and promote recurring patterns to stable user memories.
- Location: `src/features/magic-context/user-memory/storage-user-memory.ts`, `src/features/magic-context/user-memory/review-user-memories.ts`
- Pattern: Historian extracts candidates, dreamer reviews and promotes, system prompt injects stable memories.

**TUI ↔ server RPC:**
- Purpose: Localhost RPC for sidebar data, status/recomp dialogs, and TUI-action consumption.
- Location: `src/shared/rpc-server.ts`, `src/shared/rpc-client.ts`, `src/shared/rpc-utils.ts`, `src/shared/rpc-types.ts`, `src/shared/rpc-notifications.ts`, `src/plugin/rpc-handlers.ts`
- Pattern: Server publishes ephemeral port; TUI plugin polls for state and pushes notifications via the message queue.

**Plugin message bus (legacy):**
- Purpose: Historical SQLite-backed TUI ↔ server bus, retained for migration compatibility.
- Location: `src/features/magic-context/plugin-messages.ts`
- Pattern: Vestigial — superseded by RPC. Module remains for forward-compat with older TUI plugin versions that may still poll it; no active runtime callers in current code.

**Compaction markers (deferred drain, plan v6):**
- Purpose: Inject OpenCode-compatible compaction boundaries into the message table so `filterCompacted` stops at historian's last compartment boundary, shrinking the transform-input array. Marker movement is deferred from historian publish into the next materializing transform pass so a single cache-bust cycle covers both the `<session-history>` rebuild AND the marker boundary advance.
- Location: `src/features/magic-context/compaction-marker.ts`, `src/hooks/magic-context/compaction-marker-manager.ts`, `src/features/magic-context/storage-meta-persisted.ts` (pending blob helpers).
- Pattern: Historian / compressor incremental runners write the prospective new boundary (`{ordinal, endMessageId, publishedAt}`) into `session_meta.pending_compaction_marker_state` in the same transaction that publishes new compartments. The next consuming transform pass that drains `deferredHistoryRefreshSessions` calls `applyDeferredCompactionMarker(...)`, which validates the pending target against the latest stored compartment via `getCompartmentsByEndMessageId(...)` plus an OpenCode-message existence check via `getOpenCodeMessageById(...)`, then sequences `removeCompactionMarker` → `injectCompactionMarker`. Returns a tagged `MarkerUpdateOutcome` (`applied` | `already-current` | `stale-skip` | `retryable-failure`); only `retryable-failure` preserves the deferred-history signal so the next pass retries. CAS-clear (`clearPendingCompactionMarkerStateIf`) on success guards against publish/drain races within and across processes. Eager paths (`/ctx-flush`, `/ctx-recomp`) call the marker manager directly and CAS-clear any stale pending blob. Restart-safe: hook init calls `getSessionsWithPendingMarker(...)` to rehydrate deferred sets so the next pass after restart still drains. `event-handler` CAS-clears pending state on `session.compacted` (provider already advanced the boundary) and on `session.deleted` via cascade. Raw-history readers strip `summary=true` / `finish="stop"` rows to preserve original ordinals. Stable feature, default `compaction_markers: true` since v0.16.x; deferred drain since v0.19 (plan v6).

**Auto-update checker:**
- Purpose: Self-update the cached `@latest` plugin install once per plugin process — OpenCode's plugin cache no longer auto-updates.
- Location: `src/hooks/auto-update-checker/checker.ts`, `src/hooks/auto-update-checker/cache.ts`, `src/hooks/auto-update-checker/constants.ts`
- Pattern: Fires from plugin init with on-disk cross-process dedup; rewrites the install-directory dependency entry + `bun.lock` (or runs `npm install` under OpenCode's npm-managed cache).

**Native-binding resolver (Electron):**
- Purpose: Fetch and cache the matching Electron ABI prebuild of `better-sqlite3` for OpenCode Desktop.
- Location: `src/shared/native-binding.ts`
- Pattern: Detect Electron via `process.versions.electron`; download via `nanotar` to `~/.cache/cortexkit/native-bindings/`; pass the resolved `.node` path to the SQLite constructor via `nativeBinding` option. Bun and plain-Node code paths use their native runtimes unmodified.

**Agent prompt pack:**
- Purpose: Keep hidden-agent identities and prompt text isolated from runtime wiring.
- Location: `src/agents/dreamer.ts`, `src/agents/historian.ts` (declares `HISTORIAN_AGENT` and `HISTORIAN_EDITOR_AGENT`), `src/agents/sidekick.ts`, `src/agents/magic-context-prompt.ts`
- Pattern: Constants plus prompt builders.

**Content stripping and replay:**
- Purpose: Strip reasoning, inline thinking, placeholder shells, structural noise, processed images, merged-assistant reasoning, system-injected stripping, and caveman compression from messages, and replay those operations on every transform pass to maintain stable message content across OpenCode's message rebuilds.
- Location: `src/hooks/magic-context/strip-content.ts`, `src/hooks/magic-context/caveman.ts`, `src/hooks/magic-context/caveman-cleanup.ts`, `src/hooks/magic-context/sentinel.ts`
- Pattern: Stateless strip functions plus deterministic in-place sentinel replacement (preserves message-part array shape across passes); paired with persisted watermarks (`cleared_reasoning_through_tag`, `stripped_placeholder_ids`, `tags.caveman_depth`) read from `session_meta` and `tags`. Several strips are provider-aware: `stripReasoningFromMergedAssistants` runs only for `anthropic`; whole-message empty-sentinel writes a `[dropped]` placeholder for non-Anthropic providers so openai-compatible providers don't see empty assistant messages.

**Caveman text compression (experimental):**
- Purpose: Apply oldest-first age-tier text compression to user/assistant text outside the protected tail when `ctx_reduce_enabled=false`.
- Location: `src/hooks/magic-context/caveman.ts`
- Pattern: Four tiers (ultra/full/lite/untouched) keyed by raw-ordinal age within the non-protected region. Persisted per-tag `caveman_depth` enables byte-identical replay; depth escalation always recomputes from `source_contents` to avoid lossy double compression.

**Synthetic todowrite injection:**
- Purpose: Inject a deterministic `tool_use`/`tool_result` pair so the agent sees current todo state through its native todowrite mental model, even when real todowrite tool calls have been dropped from the prefix.
- Location: `src/hooks/magic-context/todo-view.ts` (renderer + hash), `src/hooks/magic-context/transform-postprocess-phase.ts` (B7 logic), `src/features/magic-context/storage-meta-persisted.ts` (state persistence)
- Pattern: Capture-path is pure DB write; cache-busting-pass injects fresh and persists `(call_id, anchor_message_id, state_json)`; defer-pass replays from persisted state_json for byte-identical wire bytes.

**Persisted session meta:**
- Purpose: Store per-session scalars and JSON blobs that must survive across transform passes and OpenCode restarts.
- Location: `src/features/magic-context/storage-meta-shared.ts`, `src/features/magic-context/storage-meta-persisted.ts`, `src/features/magic-context/storage-meta-session.ts`, `src/features/magic-context/storage-meta.ts`
- Pattern: `session_meta` SQLite table with `ensureColumn()` and versioned migrations; typed row interfaces with runtime guards; NULL coercion in `isSessionMetaRow()` so legacy rows don't trigger fallback-to-defaults on every read.

**Cache-busting signals (plan v6):**
- Purpose: Surface durable per-pass facts the postprocess phase uses to decide whether the v12 deferred-history drain, the deferred-marker drain, and the deferred-materialization drain are eligible to fire — without re-reading transform state.
- Location: `src/hooks/magic-context/cache-busting-signals.ts`, threaded into `RunPostTransformPhaseArgs` (`historyRebuiltThisPass`, `historyRefreshExplicitBeforePrepare`, `compartmentInjectionRebuiltFromDb`, `canConsumeDeferredLate`, `phaseJustAwaitedPublication`, etc.).
- Pattern: Captured at well-defined points in `transform.ts` (e.g. `historyRefreshExplicitBeforePrepare` is read immediately before `prepareCompartmentInjection`, not later) so concurrent transform passes don't clobber each other's signals. The drain decision (`historyWasConsumedThisPass`) combines `historyRebuiltThisPass && (canConsumeDeferredLate || phaseJustAwaitedPublication || explicitRebuildHappened) && materializationSatisfied`. Degraded-cache state (null-boundary rebuild) is tracked by `degradedCacheCountBySession` in postprocess; entry logs in `inject-compartments.ts` and a warning at `DEGRADE_CACHE_WARNING_THRESHOLD=10` consecutive degraded rebuilds.

## Entry Points

**CLI entry:**
- Location: `packages/cli/src/index.ts` (separate `@cortexkit/magic-context` package).
- Triggers: Executed as the unified `magic-context` bin target via `npx @cortexkit/magic-context@latest <subcommand>`.
- Responsibilities: Detect installed harnesses (OpenCode, Pi) and dispatch `setup` / `doctor` / `migrate` flows; print usage on unknown commands.

**Plugin entry:**
- Location: `src/index.ts`
- Triggers: OpenCode loads the package entry declared in `package.json`.
- Responsibilities: Load config; surface config-warning toasts/ignored-messages; disable the plugin when conflicting plugins are detected (DCP, OMO context-management, OpenCode auto-compaction); register hidden agents (`historian`, `historian-editor`, `dreamer`, `sidekick`); start RPC server; start auto-update checker; start dream-schedule timer; wire hooks, commands, and tools.

**TUI plugin entry:**
- Location: `src/tui/index.tsx` (separate `./tui` export from `package.json`).
- Triggers: OpenCode TUI loads the entry declared in `tui.json`.
- Responsibilities: Register Magic Context command-palette entries (with dual-path fallback for `api.keymap.registerLayer` vs legacy `api.command.register`); register sidebar slot; mount RPC-backed data layer.

**Message transform entry:**
- Location: `src/plugin/messages-transform.ts`
- Triggers: `experimental.chat.messages.transform`
- Responsibilities: Defensive wrapper around the magic-context hook's transform — catches transient `SQLITE_BUSY`/`SQLITE_LOCKED` errors and other failures, persists summary to `session_meta.last_transform_error`, and falls back to unmodified messages so OpenCode's prompt loop always proceeds.

**System-prompt transform entry:**
- Location: `src/hooks/magic-context/system-prompt-hash.ts`
- Triggers: `experimental.chat.system.transform`
- Responsibilities: Inject `<project-docs>`, `<user-profile>`, `<key-files>` adjunct blocks and Magic Context guidance text; persist `system_prompt_hash` for cache-stability decisions; skip injection for OpenCode's internal `title`/`summary`/`compaction` agents and any agents matched by user-configured `system_prompt_injection.skip_signatures`.

**Event entry:**
- Location: `src/plugin/event.ts`
- Triggers: OpenCode session and message lifecycle events.
- Responsibilities: Forward lifecycle events to the runtime event handler — `message.updated` (usage tracking, model drift detection, message-index live updates), `message.removed` (tag/index cleanup, sticky-reminder cleanup), `session.deleted` (full-session cleanup).

**Tool entry:**
- Location: `src/plugin/tool-registry.ts`
- Triggers: Plugin initialization.
- Responsibilities: Open storage, normalize arg schemas, and expose the supported tool set.

**Tool definition entry:**
- Location: `src/index.ts` (`tool.definition` hook calls `recordToolDefinition`)
- Triggers: OpenCode `tool.definition` hook (per tool per flight).
- Responsibilities: Record tool description and parameter token counts per `(provider, model, agent, tool_id)` for sidebar token attribution, with content-fingerprint short-circuit to avoid re-measuring stable definitions.

**RPC server entry:**
- Location: `src/shared/rpc-server.ts` (started from `src/index.ts`)
- Triggers: Plugin initialization.
- Responsibilities: Bind localhost RPC server on ephemeral port; publish port via `session_meta` for TUI discovery; serve sidebar/status/recomp/notification endpoints registered by `src/plugin/rpc-handlers.ts`.

## Session Modes

Magic Context runs in three effective modes depending on `ctx_reduce_enabled` and whether the session is a subagent. The mode decides which of the heavier features (historian, nudges, prompt-adjunct injections) run for that session, while tag/drop/heuristic plumbing stays on everywhere so any subsequent manual or automated reduction still works.

| Feature | Primary + `ctx_reduce_enabled: true` | Primary + `ctx_reduce_enabled: false` | Subagents (any `ctx_reduce_enabled`) |
|---|---|---|---|
| Tag DB records | ✓ | ✓ | ✓ |
| `§N§` tag prefix injection in message text | ✓ | ✗ | ✗ |
| `ctx_reduce` tool | ✓ | ✗ | ✗ |
| Historian / compartments / compressor | ✓ | ✓ | ✗ |
| Compartment injection (`<session-history>`) | ✓ | ✓ | ✗ |
| `<project-docs>`, `<user-profile>`, `<key-files>` system-prompt blocks | ✓ | ✓ | ✗ |
| Rolling / tool-heavy / sticky / deferred-note nudges | ✓ | ✗ | ✗ |
| Synthetic-todowrite injection | ✓ | ✓ | ✗ |
| Auto-search hint | ✓ | ✓ | ✗ |
| Heuristic tool drops at execute threshold | ✓ (once per user turn) | ✓ (once per user turn) | ✓ (every execute pass — no once-per-turn guard) |
| Heuristic reasoning clearing | ✓ | ✓ | ✓ |
| 85 % force-materialization | ✓ | ✓ | ✗ |
| 95 % block + emergency recovery | ✓ | ✓ | ✗ (overflow handled via `overflow-detection.ts` only; no recovery flag persisted) |
| Experimental age-tier caveman text compression | ✗ | opt-in via `experimental.caveman_text_compression.enabled` | ✗ |

**Subagent rationale:** subagents are driven by a parent agent, have bounded lifetimes, and often run in parallel (council, historian, sidekick, dreamer child sessions). They still benefit from automatic heuristic drops on their own context at execute passes (running on EVERY execute pass, not once-per-turn — long-running subagents are effectively one parent turn, and they'd starve under the parent's once-per-turn gate), but turning on historian, nudges, or prompt-adjunct injections in each subagent would create redundant work and per-agent cache churn. Subagents that run into overflow fall back to the existing `overflow-detection.ts` path; the detected limit is recorded so future passes use the lower value, but no emergency-recovery flag is persisted because subagents don't consume that path.

**`ctx_reduce_enabled: false` rationale:** removes agent-facing reduction machinery (the tool itself, nudges asking the agent to use it, and `§N§` prefix injection the agent can't act on) while keeping the deterministic parts (historian, heuristic drops, compartment injection, memory, synthetic-todowrite). Users who want a fully automatic pipeline can opt in and optionally enable caveman age-tier compression to recover most of the win that manual `ctx_reduce` gives for long user / assistant text parts.

## Error Handling

**Strategy:** Fail closed when persistent storage is unavailable in `src/plugin/tool-registry.ts` and `src/hooks/magic-context/hook.ts` — the plugin disables itself rather than running with ephemeral state that would silently grow the prompt past provider limits. Fail open inside per-turn handlers by logging and skipping unsafe mutations. Wrap the outer message transform in `src/plugin/messages-transform.ts` so transient `SQLITE_BUSY`/`SQLITE_LOCKED` errors and other failures don't crash OpenCode's prompt loop (issue #23). Stop OpenCode command fallthrough with sentinel errors from `src/hooks/magic-context/command-handler.ts`.

**Provider error parsing:** `src/features/magic-context/overflow-detection.ts` parses provider-specific context-overflow errors (Anthropic, OpenAI, GitHub Copilot) and persists the detected limit to `session_meta.detected_context_limit` so subsequent passes use the lower value. `needs_emergency_recovery` is set for primary sessions; subagents skip emergency-recovery state because they don't consume that path.

**Subagent model fallback:** `promptSyncWithModelSuggestionRetry` in `src/shared/model-suggestion-retry.ts` iterates the resolved fallback chain (user-configured `fallback_models` or builtin chain) on retryable failures. Abort, timeout, and context-overflow errors short-circuit the chain — those won't succeed on a different model and the caller's emergency-recovery path handles them. Suggestion retry ("did you mean X?") runs inside each attempt.

## Cross-Cutting Concerns

**Logging:** Use buffered file logging from `src/shared/logger.ts` and write to the temp-file path returned by `getLogFilePath()`. Per-session logs use `sessionLog(sessionId, message)`; module-level logs use `log(message)`. Heavy logging batches to disk to avoid blocking the transform path.

**Caching:** Use deferred reductions, cached memory-block injection, per-session TTL tracking, anchored nudge placement, persisted reminder-replay state, per-session live injection cache, persisted system-prompt hash, and persisted todo-snapshot replay state — all coordinated through `src/hooks/magic-context/` and `src/features/magic-context/storage-meta-*.ts`.

**Storage:** Use the SQLite database created by `src/features/magic-context/storage-db.ts` under the cortexkit data directory resolved by `src/shared/data-path.ts` (`~/.local/share/cortexkit/magic-context/context.db` on Linux/macOS, XDG-equivalent on Windows). Legacy OpenCode-plugin-folder DBs are migrated forward on first boot. The same DB is shared cross-harness between OpenCode and Pi; session-scoped tables include a `harness` discriminator (`'opencode'` / `'pi'`) while project-scoped tables (memories, git commits) are shared.

**Schema migrations:** `src/features/magic-context/migrations.ts` declares versioned migrations v1–v13 (v10 added `tool_owner_message_id` for composite tool-tag identity; v11 added `todo_synthetic_*` columns for synthetic-todowrite; v12 cleaned orphan `memory_embeddings` rows and verified embedding cascade behavior; v13 added `pending_compaction_marker_state` for the plan-v6 deferred-marker drain). Migration runner uses `schema_migrations` table with version-ordered execution and sibling-startup race protection (duplicate-insert is tolerated).

**Harness-aware behavior:** `src/shared/harness.ts` exposes `setHarness()`/`getHarness()` for the runtime to identify itself; production INSERTs into session-scoped tables tag rows with the current harness. Pi-specific session-resolution paths are skipped on OpenCode and vice versa.

## Tag Identity (v3.3.1+)

**Tag types:** `message`, `file`, `tool`. Each row in the `tags` table represents one source-content unit that can be tagged with `§N§` and dropped/truncated/replayed by the runtime.

**Identity composition by type:**

- **`message` and `file` tags:** identified by `(session_id, message_id)`. The `message_id` for these is a synthetic content id (`<msgId>:p<partIndex>` for text, `<msgId>:fileN` for files). These ids are globally unique within a session.

- **`tool` tags:** identified by `(session_id, message_id, tool_owner_message_id)` — a *composite* identity. For tool tags, `message_id` is the OpenCode-generated callID (e.g. `read:32`). Pre-v3.3.1 the runtime keyed tool tags by callID alone, but OpenCode reuses a callID counter per assistant turn — so two assistant turns that each invoke `read:32` produced the SAME callID for different invocations. The fix: include the *owning assistant message id* in the key so each invocation gets its own row.

**Schema enforcement:** schema migration v10 (`src/features/magic-context/migrations.ts`) adds `tool_owner_message_id` (`TEXT NULL`), a partial UNIQUE index `idx_tags_tool_composite` on `(session_id, message_id, tool_owner_message_id) WHERE type='tool' AND tool_owner_message_id IS NOT NULL`, and a partial lookup index `idx_tags_tool_null_owner` on `(session_id, message_id) WHERE type='tool' AND tool_owner_message_id IS NULL` to back lazy adoption.

**Helper API surface (`src/features/magic-context/storage-tags.ts`):**

- `getToolTagNumberByOwner(db, sessionId, callId, ownerMsgId)`: composite-identity lookup.
- `getNullOwnerToolTag(db, sessionId, callId)`: find a legacy NULL-owner orphan to lazily adopt.
- `adoptNullOwnerToolTag(db, tagId, ownerMsgId)`: attempt to claim a NULL-owner row (NULL guard ensures first claim wins).
- `getPersistedToolOwnerNearestPrior(db, sessionId, callId, beforeMessageId)`: derive the most recent prior owner for a tool result whose invocation isn't in the visible window.
- `deleteToolTagsByOwner(db, sessionId, ownerMsgId)`: cascade delete on `message.removed`.

**Owner derivation (`src/hooks/magic-context/tag-messages.ts`):**

For each tool observation in a transform pass:

1. **Invocation parts** (`tool-invocation` / `tool_use`): owner = the message hosting the part.
2. **Result parts** (`tool` with output / `tool_result`): pop the FIFO queue of unpaired invocations for that callId; owner = the popped invocation's message id.
3. **Result-only window** (invocation compacted away): fall back to `getPersistedToolOwnerNearestPrior` for the most recent prior persisted owner; if none found, last-resort owner = the result's own message id.

The same logic mirrors in `src/hooks/magic-context/read-session-chunk.ts: getRawSessionTagKeysThrough` so the drop queue produces composite keys that match what the tagger persisted.

**Cleanup paths:**

- `deleteTagsByMessageId(db, sessionId, messageId)` (called from `event-handler.ts` on `message.removed`) deletes BOTH content-id-scoped tags (text/file on the removed message) AND owner-scoped tool tags (`tool_owner_message_id == messageId`).
- `applyHeuristicCleanup` keys both the tag-side index and fingerprint-side map by composite `<ownerMsgId>\x00<callId>`. The fingerprint VALUE includes ownerMsgId too, so cross-owner pairs with same `(toolName, args)` produce DISTINCT fingerprints and are NOT merged.

**Legacy NULL-owner handling:** rows written by pre-v3.3.1 plugin versions have `tool_owner_message_id = NULL`. The Layer B backfill (`src/features/magic-context/tool-owner-backfill.ts`) populates those rows from OpenCode's session DB on plugin upgrade (lease-based concurrency, batched commits). When backfill is skipped (no OpenCode DB attached) lazy adoption converts orphans to non-NULL on the next observation. Drop queue and heuristic cleanup gracefully fall back to bare-callId match for unbackfilled NULL-owner rows.
