# Codebase Concerns

**Analysis Date:** 2026-03-25

---

## Tech Debt

**Orphaned `ctx-recall` type declarations in `dist/`:**
- Issue: `dist/tools/ctx-recall/` contains type declaration files (`*.d.ts`, `*.d.ts.map`) but the corresponding source was removed — `src/tools/` has no `ctx-recall` directory.
- Files: `dist/tools/ctx-recall/constants.d.ts`, `dist/tools/ctx-recall/index.d.ts`, `dist/tools/ctx-recall/tools.d.ts`, `dist/tools/ctx-recall/types.d.ts`
- Impact: Consumers or type-checkers relying on the distributed package may surface references to a removed tool; the dreamer task-prompts still mention `ctx_recall` as a known removed tool, which may confuse future memory verification runs.
- Fix approach: Run `bun run clean && bun run build` to flush stale dist artifacts; verify no user-visible docs or prompts reference ctx-recall going forward.

**Schema evolution via `ensureColumn` instead of versioned migrations:**
- Issue: `src/features/magic-context/storage-db.ts` adds columns to existing tables using a custom `ensureColumn()` helper (ALTER TABLE based). There is no schema version table, no migration log, and no rollback path.
- Files: `src/features/magic-context/storage-db.ts` (lines ~195–225)
- Impact: Downgrading the plugin leaves orphan columns; applying `ensureColumn` on every startup adds ~15 PRAGMA `table_info` queries per column even on up-to-date databases.
- Fix approach: Introduce a `schema_version` table; gate each column addition behind a version check.

**No session/tag table pruning:**
- Issue: The `tags`, `source_contents`, `session_meta`, `compartments`, `session_facts`, and `session_notes` tables are cleaned up only when OpenCode triggers a session-delete event (calling `clearSession()`). If OpenCode does not reliably fire this event (e.g., crash, test sessions), rows accumulate indefinitely.
- Files: `src/features/magic-context/storage-meta-session.ts`, `src/features/magic-context/storage-db.ts`
- Impact: The SQLite file grows without bound for long-lived installations. One single-database design means all projects share the file — high-activity users may see multi-GB databases.
- Fix approach: Add a background vacuum job (e.g., on plugin startup or after historian runs) that deletes sessions older than N days from all session-scoped tables.

**`resolveProjectIdentity` uses synchronous `execSync`:**
- Issue: `src/features/magic-context/memory/project-identity.ts` calls `execSync("git rev-list ...")` with a 5-second timeout. While results are cached per process lifetime, this blocks the event loop on first call.
- Files: `src/features/magic-context/memory/project-identity.ts`
- Impact: First message of a session in any new directory blocks the event loop for up to ~50ms (normal) or 5,000ms (worst-case: slow git on network-mounted filesystem).
- Fix approach: Move to `spawnSync` or an async equivalent with an explicit cap of 500ms, or pre-resolve in the plugin bootstrap where async is safe.

**Historian validation dump files accumulate in `/tmp`:**
- Issue: Failed historian XML responses are written to `os.tmpdir()/magic-context-historian/`. Only success paths clean up the file; repair-path and double-failure paths leave files on disk. A comment in the code explicitly notes this is intentional for debugging.
- Files: `src/hooks/magic-context/compartment-runner-historian.ts` (lines ~20–25, ~190–210)
- Impact: Long-running systems or frequent historian failures can accumulate XML files in `/tmp`. The directory is only cleaned by OS pruning.
- Fix approach: Add a startup cleanup pass that deletes dump files older than 7 days.

**Log file grows without rotation:**
- Issue: `src/shared/logger.ts` appends to `os.tmpdir()/magic-context.log` without any rotation, size cap, or pruning.
- Files: `src/shared/logger.ts`
- Impact: On high-activity installations the log file can grow to hundreds of MB over time.
- Fix approach: Cap log file at ~10 MB; rotate to a single `.log.1` backup.

**Token estimation is a rough heuristic:**
- Issue: `src/hooks/magic-context/read-session-formatting.ts` uses `Math.ceil(text.length / 3.5)` to estimate tokens. The `ai-tokenizer` dependency is declared in `package.json` but not actually imported anywhere in `src/`.
- Files: `src/hooks/magic-context/read-session-formatting.ts`, `package.json`
- Impact: Token budgets for the compartment chunk, history-block budget, memory injection budget, and compression triggers can be off by ±30% for code-heavy content (code skews higher token-per-char than prose). Over-budget historian prompts increase API costs; under-budget may leave significant history unprocessed.
- Fix approach: Use `ai-tokenizer` for accurate counting, or document the heuristic clearly and remove the unused dependency.

**`PRAGMA foreign_keys` never enabled:**
- Issue: `src/features/magic-context/storage-db.ts` sets WAL mode and busy timeout but never runs `PRAGMA foreign_keys = ON`. The `memory_embeddings` table declares `REFERENCES memories(id) ON DELETE CASCADE`, but without the pragma this constraint is not enforced.
- Files: `src/features/magic-context/storage-db.ts`
- Impact: Orphaned embedding rows are possible if a memory is deleted without going through the application's `deleteMemory()` path (e.g., direct SQL, future tooling).
- Fix approach: Add `db.run("PRAGMA foreign_keys = ON")` to `initializeDatabase()`.

---

## Known Bugs

**Bun panic in embedding search test (uninvestigated):**
- Symptoms: Running the semantic search code path under certain conditions causes a Bun runtime panic.
- Files: `src/tools/ctx-memory/tools.test.ts` (line 423)
- Trigger: The TODO comment marks the specific test case as dangerous: `// TODO: This causes bun panic, why? investigate`. The test is commented out rather than fixed.
- Impact: Embedding-based memory search may be triggering the same panic in production. The root cause is unknown.
- Workaround: Test is skipped; production path may silently fail and fall back to FTS.

---

## Security Considerations

**API key stored in config file as plain text:**
- Risk: `embedding.api_key` in `magic-context.jsonc` is a plain-text API key for remote embedding providers. The config file is in the project root and could be committed to version control.
- Files: `src/config/schema/magic-context.ts`, `CONFIGURATION.md`
- Current mitigation: README/CONFIGURATION.md documents the field but does not warn about committing the key. No `.gitignore` guidance is provided.
- Recommendations: Add documentation warning to commit `magic-context.jsonc` with API keys to `.gitignore`; consider supporting an environment variable override (e.g., `MAGIC_CONTEXT_EMBEDDING_API_KEY`).

**Memory content injected directly into LLM system prompts:**
- Risk: Memory content written by the historian or dreamer agents is injected verbatim into `<session-history>` on every turn. If a memory record contains adversarial or prompt-injection content, it will be fed back to the main agent on subsequent sessions.
- Files: `src/hooks/magic-context/inject-compartments.ts`, `src/features/magic-context/memory/storage-memory.ts`
- Current mitigation: Memory categories are validated (`MemoryCategory` enum); no content sanitization beyond that.
- Recommendations: Add a sanitization pass that strips XML control characters and limits memory content length before injection.

---

## Performance Bottlenecks

**All embeddings loaded into memory for similarity search:**
- Problem: `src/features/magic-context/memory/storage-memory-embeddings.ts` loads ALL embeddings for a project via `getAllEmbeddings()` to perform cosine-similarity ranking in JavaScript. This runs on every `ctx_memory` search call.
- Files: `src/features/magic-context/memory/storage-memory-embeddings.ts`, `src/tools/ctx-memory/tools.ts`
- Cause: SQLite's FTS5 extension doesn't support vector operations, so the full embedding table must be pulled to userland.
- Improvement path: Use SQLite's `sqlite-vec` extension for approximate nearest-neighbor search, or cap the project embedding set to the most-recent N memories and fall back to FTS for older ones.

**`getTagsBySession` called on every transform pass:**
- Problem: Several heuristic cleanup functions in `src/hooks/magic-context/heuristic-cleanup.ts` and `src/hooks/magic-context/transform-postprocess-phase.ts` call `getTagsBySession(db, sessionId)` which fetches all tags for the session. For sessions with hundreds of turns this becomes O(n) on every message transform.
- Files: `src/hooks/magic-context/heuristic-cleanup.ts`, `src/features/magic-context/storage.ts`
- Cause: No in-memory cache for the current-turn tag set; each transform re-queries SQLite.
- Improvement path: Pass the pre-loaded tag set from the tagger into heuristic cleanup rather than re-fetching.

**`ensureColumn` PRAGMA queries on every database open:**
- Problem: `initializeDatabase()` runs `PRAGMA table_info(table)` for every ensured column on every cold open — approximately 15 queries before the database is usable.
- Files: `src/features/magic-context/storage-db.ts`
- Cause: No schema version tracking; every open must verify each column exists.
- Improvement path: Schema version table (see Tech Debt item above) would replace this with a single version check.

---

## Fragile Areas

**In-memory `databases` map in `storage-db.ts` is module-level global:**
- Files: `src/features/magic-context/storage-db.ts`
- Why fragile: The `Map<string, Database>` is keyed by path string. If the resolved path changes (symlinks, drive letter casing on Windows, or mounting), a second database instance opens for the same file, leading to duplicate SQLite connections to the same WAL-mode database.
- Safe modification: Never call `openDatabase()` with an unresolved path; always pass the canonical resolved path.
- Test coverage: Storage tests use `useTempDataHome` helpers; no symlink-path tests.

**Compartment runner state is in-memory process-global (`activeRuns` map):**
- Files: `src/hooks/magic-context/compartment-runner.ts`
- Why fragile: The `activeRuns: Map<string, Promise<void>>` is module-level. If the plugin is reloaded (hot-reload in development), a prior promise may still be in flight while a new run begins, leading to duplicate historian passes for the same session.
- Safe modification: Guard against reload scenarios; the `getActiveCompartmentRun()` check is the only guard.
- Test coverage: Race conditions between reload and in-flight historian are not tested.

**Dreamer lease is not crash-safe without wait:**
- Files: `src/features/magic-context/dreamer/lease.ts`, `src/features/magic-context/dreamer/runner.ts`
- Why fragile: The lease duration is 2 minutes renewed every 60 seconds. If the Bun process crashes mid-task (e.g., OOM during large embedding batch), the lease remains "held" for up to 2 minutes before expiring. During that window, no other dream run can start.
- Safe modification: The 2-minute expiry means recovery is automatic; this is an acceptable trade-off but should be documented.
- Test coverage: Crash-recovery scenario not tested.

**`normalizeSDKResponse` uses `as TData` casts throughout:**
- Files: `src/shared/normalize-sdk-response.ts`, callers in `src/hooks/magic-context/compartment-runner-historian.ts`, `src/features/magic-context/dreamer/runner.ts`, `src/features/magic-context/sidekick/agent.ts`
- Why fragile: The function returns `response as TData` when the shape is uncertain, bypassing TypeScript safety. If the OpenCode SDK changes its response envelope the cast silently succeeds and downstream code receives wrong-shaped data.
- Safe modification: Add runtime shape validation using Zod or a type guard before casting.

**Config parse silently falls back to empty defaults on invalid input:**
- Files: `src/config/index.ts` (`parsePluginConfig`), `src/config/schema/magic-context.ts`
- Why fragile: If `MagicContextConfigSchema.safeParse(rawConfig)` fails (e.g., user misspells a config key or uses an incompatible value), the function returns `{}` as `MagicContextPluginConfig` with all settings undefined — including `enabled: false`. The user gets no error; the plugin silently does nothing.
- Safe modification: Log the Zod validation errors so the user can diagnose the misconfiguration.

---

## Scaling Limits

**Single SQLite database for all projects and sessions:**
- Current capacity: Unlimited by design; single file at `~/.local/share/opencode/storage/plugin/magic-context/context.db`
- Limit: SQLite WAL mode supports multiple readers and one writer efficiently, but large embedding blobs (384-dimension Float32 = 1,536 bytes each) will inflate the file significantly for users with many memories. 10,000 memories ≈ ~15 MB for embeddings alone, before tag/compartment data.
- Scaling path: Allow per-project database files; add a database size check with a user-visible warning.

**Memory injection budget is fixed regardless of model context window:**
- Current capacity: Default `injection_budget_tokens = 4000` for memories; `history_budget_percentage = 0.15` for compartments.
- Limit: Small-context models (e.g., 8K tokens) waste a disproportionate fraction on memory injection. Large-context models (200K+) could inject far more memories to be useful.
- Scaling path: Make injection budget a percentage of available context rather than a fixed token count.

---

## Dependencies at Risk

**`@opencode-ai/plugin` is an external pre-release API:**
- Risk: The entire plugin integration is built on `experimental.*` hooks (`experimental.chat.messages.transform`, `experimental.chat.system.transform`, `experimental.text.complete`). These are explicitly marked experimental and may change or be removed without semver notice.
- Impact: Breaking OpenCode SDK update silently disables or breaks all transforms; no compile-time warning since hooks are registered by string key.
- Files: `src/index.ts`, `src/plugin/messages-transform.ts`, `src/hooks/magic-context/hook.ts`
- Migration plan: Track OpenCode changelog closely; add integration tests against the live plugin API to catch breakage early.

**`@huggingface/transformers` (~3.5.1) loads a full ML model in-process:**
- Risk: The transformers package downloads and caches `Xenova/all-MiniLM-L6-v2` (~22 MB quantized) on first use. The download is silent, occurs during a user's session, and can fail in air-gapped environments.
- Impact: First-use latency spike; silent embedding failures fall back to FTS-only search with no user notification.
- Files: `src/features/magic-context/memory/embedding-local.ts`
- Migration plan: Detect air-gapped environments; notify the user before downloading; add a `embedding.provider = "off"` default for new installs until they opt in.

**`zod` ^4.1.8 — major version upgrade:**
- Risk: Zod v4 introduced breaking API changes from v3. If any transitive dependency (e.g., `@opencode-ai/plugin`) also depends on Zod but at v3, both versions could be bundled, inflating the plugin size and causing runtime schema mismatches.
- Files: `package.json`
- Migration plan: Verify `@opencode-ai/plugin` Zod dependency version compatibility; ensure bundle output does not include duplicate Zod instances.

---

## Missing Critical Features

**No user-visible config validation errors:**
- Problem: When `magic-context.jsonc` contains invalid values, `parsePluginConfig()` returns empty defaults with no user feedback. The plugin silently loads with defaults (which means `enabled: false`).
- Blocks: Diagnosing misconfiguration requires reading the internal log file at `os.tmpdir()/magic-context.log`.

**No database size or health check:**
- Problem: There is no mechanism to warn users when the SQLite database grows large or when embeddings from a previous embedding model are stale (different model ID).
- Blocks: Silent storage degradation; the embedding model wipe on init (`tool-registry.ts`) deletes embeddings when the model changes, but the user is not informed unless they see the `console.warn` at plugin startup.

**Dreamer child sessions are not always deleted on failure:**
- Problem: In `src/features/magic-context/dreamer/runner.ts` and `src/features/magic-context/sidekick/agent.ts`, child sessions are deleted in `finally` blocks. However, if `client.session.create` succeeds and then the process is interrupted before the `finally` block, the child session leaks.
- Blocks: Orphaned child sessions accumulate in OpenCode's session store.

---

## Test Coverage Gaps

**Embedding-based semantic search skipped in tests:**
- What's not tested: The semantic similarity search path in `src/tools/ctx-memory/tools.ts` is skipped due to a Bun panic (`tools.test.ts` line ~423).
- Files: `src/tools/ctx-memory/tools.test.ts`
- Risk: Regressions in embedding search (scoring, ranking, FTS fusion) can ship undetected.
- Priority: High

**Dreamer runner and scheduler have no unit tests:**
- What's not tested: `src/features/magic-context/dreamer/runner.ts`, `src/features/magic-context/dreamer/scheduler.ts`, `src/features/magic-context/dreamer/lease.ts` — the dreamer execution path is integration-only (requires a live OpenCode server).
- Files: `src/features/magic-context/dreamer/`
- Risk: Scheduling logic bugs (e.g., duplicate enqueues, lease edge cases) go undetected.
- Priority: Medium

**Config loading error paths are not tested:**
- What's not tested: `src/config/index.ts` — behavior when `magic-context.jsonc` contains invalid JSON, invalid Zod schema, or missing required fields.
- Files: `src/config/index.ts`
- Risk: Silent default fallback could mask user misconfiguration in production.
- Priority: Medium

**`normalizeSDKResponse` with unexpected shapes:**
- What's not tested: Edge cases in `src/shared/normalize-sdk-response.ts` where the SDK returns unexpected envelope shapes (e.g., nested `data.data`, null response body, error objects).
- Files: `src/shared/normalize-sdk-response.ts`
- Risk: Silent wrong-type casts in historian, dreamer, and sidekick runners.
- Priority: Low

---

*Concerns audit: 2026-03-25*
