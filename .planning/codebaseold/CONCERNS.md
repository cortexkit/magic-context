# Codebase Concerns

**Analysis Date:** 2026-03-23

## Tech Debt

**historyBudgetTokens calculation simplifies to identity multiplication:**
- Issue: In `src/hooks/magic-context/transform.ts` lines 222–228, the calculation `(inputTokens / (percentage / 100)) * (percentage / 100) * historyBudgetPercentage` simplifies algebraically to just `inputTokens * historyBudgetPercentage`. The division and multiplication by `percentage / 100` cancel each other out, making the formula misleading and unnecessarily complex.
- Files: `src/hooks/magic-context/transform.ts`
- Impact: No runtime bug (result is mathematically equivalent), but future maintainers may mistakenly believe the formula accounts for context capacity scaling when it does not
- Fix approach: Replace with `Math.floor(contextUsage.inputTokens * deps.historyBudgetPercentage)`

**Inline raw SQL outside the storage layer in `inject-compartments.ts`:**
- Issue: `src/hooks/magic-context/inject-compartments.ts` lines 117–137 contain two raw `db.prepare()` calls for reading and writing `memory_block_cache` / `memory_block_count` columns on `session_meta`. This bypasses the storage layer and violates the pattern used everywhere else in the codebase.
- Files: `src/hooks/magic-context/inject-compartments.ts`
- Impact: Schema changes to `session_meta` require updating this file as well as storage layer files; fragile when new columns are added
- Fix approach: Move the cache read/write into `src/features/magic-context/storage-meta-persisted.ts` or `storage-meta-session.ts` with named functions (`getMemoryBlockCache`, `setMemoryBlockCache`)

**Duplicate raw SQL for embedding deletion on content update:**
- Issue: `src/features/magic-context/memory/storage-memory.ts` lines 444–449 prepares and runs `DELETE FROM memory_embeddings WHERE memory_id = ?` using a separate prepared-statement WeakMap (`deleteEmbeddingOnContentUpdateStatements`), duplicating the identical query already in `storage-memory-embeddings.ts`.
- Files: `src/features/magic-context/memory/storage-memory.ts`, `src/features/magic-context/memory/storage-memory-embeddings.ts`
- Impact: Two implementations of the same SQL; if the query changes, both files must be updated
- Fix approach: Import and call `deleteEmbedding()` from `storage-memory-embeddings.ts` directly (note: a comment in the file already acknowledges the circular-import concern — reorganize to break the cycle)

**`toMemory` is a no-op identity copy:**
- Issue: `src/features/magic-context/memory/storage-memory.ts` lines 145–169 defines `toMemory(row: Memory): Memory` which simply copies every field verbatim from `row` to a new object. Because the type is already `Memory`, this adds zero type safety and only wastes an allocation per memory retrieval.
- Files: `src/features/magic-context/memory/storage-memory.ts`
- Impact: Minor runtime overhead on every memory read; misleads future devs into thinking it performs a conversion
- Fix approach: Replace calls to `toMemory(result)` with `result` directly, or delete the function

**`embed` is a thin wrapper around `embedText` (dead alias):**
- Issue: `src/features/magic-context/memory/embedding.ts` lines 111–113 exports `embed(text)` as a one-line wrapper that calls `embedText(text)`. `embed` appears to exist as an API alias but has no callers — only `embedText` and `embedBatch` are used.
- Files: `src/features/magic-context/memory/embedding.ts`
- Impact: Dead code; confuses API surface
- Fix approach: Remove `embed` export or merge with `embedText`

**`mock-database.ts` uses double type assertion (`as unknown as Database`):**
- Issue: `src/features/magic-context/mock-database.ts` exposes `toDatabase<T>(db: T): Database` which does `db as unknown as Database`. This completely bypasses type checking and is used in test helpers.
- Files: `src/features/magic-context/mock-database.ts`
- Impact: Type-unsafe test infrastructure; mocks may diverge from the real `Database` interface silently
- Fix approach: Use Bun's `:memory:` database in tests instead (already done in some tests — standardize the pattern)

## Known Bugs / Behavioral Issues

**`resolvedSessionId` is always equal to `sessionId`:**
- Symptoms: In `src/hooks/magic-context/transform.ts` lines 83–84, `resolvedSessionId` is assigned the value of `sessionId` with no transformation. The variable `resolvedSessionId` is then passed to `runCompartmentPhase` as a seemingly separate parameter.
- Files: `src/hooks/magic-context/transform.ts`
- Trigger: Always — every transform invocation
- Workaround: No behavioral impact currently; the two variables always hold identical values

**`heuristic-cleanup.test.ts` uses `as any` for part access:**
- Symptoms: `src/hooks/magic-context/heuristic-cleanup.test.ts` line 51 uses `p as any` to access message parts, indicating the test works around missing type definitions for the internal part shape
- Files: `src/hooks/magic-context/heuristic-cleanup.test.ts`
- Trigger: Tests still pass; risk is false confidence in type correctness of heuristic cleanup
- Workaround: Define a typed interface for `Part` in `tag-part-guards.ts` or `types.ts`

## Security Considerations

**`ensureColumn` uses `PRAGMA table_info({table})` with an inline table name:**
- Risk: SQL injection via `table` and `column` parameters in `src/features/magic-context/storage-db.ts` lines 185–198. The function does validate with regex before executing, but the validation happens in-process without parameterization.
- Files: `src/features/magic-context/storage-db.ts`
- Current mitigation: Regex guards `^[a-z_]+$` for table/column and `^[A-Z0-9_'(),\s]+$/i` for definition; throws on mismatch
- Recommendations: The guards are reasonable for internal use — ensure `ensureColumn` is never called with externally-supplied strings. Add a clear comment that all callers must use literal strings.

**`sidekick.api_key` stored in config (not keychain):**
- Risk: The sidekick API key is a plain string in `magic-context.jsonc`. Anyone with read access to the user's config directory can read it.
- Files: `src/config/schema/magic-context.ts`, `src/hooks/magic-context/hook.ts`
- Current mitigation: Config file lives in `~/.config/opencode/` with default user permissions
- Recommendations: Document that the config file should have `chmod 600`. Optionally support environment variable substitution (e.g., `$MAGIC_CONTEXT_SIDEKICK_KEY`) to avoid storing keys in plain text.

**`dreaming.api_key` stored in config:**
- Risk: Same concern as sidekick — the dreamer LLM API key is a plain string in user config.
- Files: `src/config/schema/magic-context.ts`
- Current mitigation: Same as above
- Recommendations: Same as above

## Performance Bottlenecks

**`execSync` for git root commit detection (blocks event loop):**
- Problem: `src/features/magic-context/memory/project-identity.ts` line 25 calls `execSync("git rev-list --max-parents=0 HEAD")` synchronously with a 5-second timeout. This blocks the Bun event loop on first call.
- Files: `src/features/magic-context/memory/project-identity.ts`
- Cause: Intentional design (audit #19 comment); the author chose synchronous to avoid async threading through all callers
- Improvement path: The result is cached after first call, so impact is limited to the first transform pass per directory. Accept as-is or use `spawnSync` with a shorter timeout if the 5s maximum is unacceptable in CI/slow filesystems.

**`synchronous appendFileSync` for every log call:**
- Problem: `src/shared/logger.ts` uses `fs.appendFileSync` for every log entry, which is a synchronous disk write. Each transform pass can trigger 20–50 log calls.
- Files: `src/shared/logger.ts`
- Cause: Intentional (comment explains ordering and crash-safety rationale)
- Improvement path: Accept as-is for now; if log I/O becomes a bottleneck, switch to a write stream with ordered async writes. The 0.1ms per write on SSD is negligible for current call volumes.

**`loadAllEmbeddings` loads entire embedding table into memory:**
- Problem: `src/features/magic-context/memory/storage-memory-embeddings.ts` `loadAllEmbeddings()` loads ALL embeddings for a project path into a `Map<number, Float32Array>` in a single query. With large memory stores, this becomes a significant allocation.
- Files: `src/features/magic-context/memory/storage-memory-embeddings.ts`, `src/features/magic-context/dreamer/task-consolidate.ts`
- Cause: Simplest approach for batch cosine similarity computation
- Improvement path: For projects with >1000 memories, add pagination or ANN indexing (sqlite-vss or similar). Currently acceptable at typical scales.

**O(n²) consolidation scan in `task-consolidate.ts`:**
- Problem: `src/features/magic-context/dreamer/task-consolidate.ts` performs pairwise cosine similarity comparison across all memories within each category. This is O(n²) per category.
- Files: `src/features/magic-context/dreamer/task-consolidate.ts`
- Cause: Correct implementation for small sets; runs in dreamer background process
- Improvement path: At scale (hundreds of memories per category), switch to ANN with a threshold filter. Fine at current typical scales.

## Fragile Areas

**`compartment-runner-incremental.ts` — tight coupling between compartment boundary detection and message ID handling:**
- Files: `src/hooks/magic-context/compartment-runner-incremental.ts`, `src/hooks/magic-context/inject-compartments.ts`
- Why fragile: The `lastEndMessageId` field on stored compartments is empty for "legacy" compartments (created before the field was added). The code in `inject-compartments.ts` lines 146–163 falls back to ordinal-based trimming when `lastEndMessageId` is empty. This dual-path logic is easy to regress when changing compartment storage format.
- Safe modification: Add a migration that backfills missing `end_message_id` values, or add a well-documented invariant check at the storage layer
- Test coverage: The dual-path logic lacks a dedicated integration test for the legacy no-ID path

**`heuristic-cleanup.ts` — order-dependent transforms in `runPostTransformPhase`:**
- Files: `src/hooks/magic-context/transform-postprocess-phase.ts`, `src/hooks/magic-context/heuristic-cleanup.ts`
- Why fragile: The post-transform pipeline calls `stripDroppedPlaceholderMessages` AFTER `renderCompartmentInjection` with a comment explaining the ordering dependency (line 251). Additional stripping passes (`stripSystemInjectedMessages`, `truncateErroredTools`, `stripProcessedImages`) are similarly order-sensitive. A future refactor that reorders these calls can silently corrupt the message array.
- Safe modification: Document the required ordering as a numbered sequence at the top of `runPostTransformPhase` with an explanation for each constraint
- Test coverage: `compartment-runner.test.ts` covers the end-to-end flow but not the specific ordering invariants

**`inject-compartments.ts` — mutates the `messages` array in place:**
- Files: `src/hooks/magic-context/inject-compartments.ts` lines 165–171
- Why fragile: `prepareCompartmentInjection` calls `messages.splice(0, messages.length, ...remaining)` to trim already-compartmentalized messages. This is a destructive in-place mutation of the shared `messages` array. Callers elsewhere that hold a reference to `messages` will see a reduced array.
- Safe modification: Document that `prepareCompartmentInjection` is destructive, or return the trimmed slice instead of mutating in place
- Test coverage: `transform.test.ts` covers transform end-to-end but the mutation side-effect is implicit

**`read-session-db.ts` — module-level cached read-only DB connection:**
- Files: `src/hooks/magic-context/read-session-db.ts`
- Why fragile: `cachedReadOnlyDb` is module-level mutable state. If the opencode DB path changes mid-process (e.g., in tests), `closeCachedReadOnlyDb` must be called or the stale handle will be used. There is no automatic invalidation.
- Safe modification: Tests must always call `closeReadOnlySessionDb()` in teardown. This is not enforced structurally.
- Test coverage: `read-session-chunk.test.ts` covers the happy path but may not consistently clean up the cached connection

## Scaling Limits

**Single SQLite database file for all sessions and memories:**
- Current capacity: All sessions, tags, compartments, memories, and embeddings share one SQLite WAL file at `~/.local/share/opencode/plugin/magic-context/context.db`
- Limit: SQLite handles concurrent readers well, but write contention can occur at high plugin concurrency (multiple parallel sessions). Large memory stores (tens of thousands of memories with embeddings) will grow the DB file significantly.
- Scaling path: Add periodic VACUUM scheduling; consider per-project databases for large workspaces

## Dependencies at Risk

**`@huggingface/transformers` — large optional dependency for local embeddings:**
- Risk: Pinned to `^3.5.1`. This is a large package (~500MB+ with model downloads). The embedding model (`Xenova/all-MiniLM-L6-v2`) is downloaded on first use via Hugging Face Hub. If Hub is unavailable or the model is removed, local embedding initialization silently falls back to `null`.
- Impact: If local embeddings fail, semantic search degrades to FTS-only with no user notification beyond a log entry
- Migration plan: Consider bundling the model or adding a user-visible warning when the embedding model fails to load after N retries

**`@opencode-ai/plugin` SDK — external API contract:**
- Risk: Pinned to `^1.2.26`. The plugin communicates with opencode via undocumented internal message structures (`MessageLike`, `parts` array, etc.). Any opencode upgrade that changes the message format will break the transform pipeline silently.
- Impact: Critical — the entire context management pipeline depends on this structural contract
- Migration plan: Add runtime shape validation at the entry point of `createTransform` to detect unexpected message formats early and fail visibly

## Missing Critical Features

**Dreamer tasks `mine`, `verify`, `git`, `map` are defined in schema but not implemented:**
- Problem: `DreamingTaskSchema` in `src/config/schema/magic-context.ts` line 13 includes `"mine" | "verify" | "git" | "map"` as valid task names, but `src/features/magic-context/dreamer/runner.ts` line 69 throws `"Dream task is not implemented yet"` for any task other than `"decay"` or `"consolidate"`.
- Blocks: Users who configure these tasks in their `dreaming.tasks` array will get runtime errors during dreamer runs with no user-visible notification
- Files: `src/features/magic-context/dreamer/runner.ts`, `src/config/schema/magic-context.ts`

**No user-visible notification when local embedding model fails to load:**
- Problem: When `LocalEmbeddingProvider.initialize()` fails (e.g., network unavailable, HuggingFace CDN down), the failure is logged to the log file only (`log("[magic-context] embedding model failed to load:", error)`) with no toast or TUI notification.
- Files: `src/features/magic-context/memory/embedding-local.ts`
- Blocks: Users don't know why `ctx_recall` semantic search is degraded; they see FTS-only results without understanding why

## Test Coverage Gaps

**`compartment-runner-timeout.ts` — timeout behavior not fully covered:**
- What's not tested: The `compartment-runner-timeout.test.ts` file exists but the companion implementation file is not present in `src/`. The test file imports from `compartment-runner` but timeout-specific behavior (historian agent exceeding `historianTimeoutMs`) has limited coverage.
- Files: `src/hooks/magic-context/compartment-runner-timeout.test.ts`
- Risk: Timeout edge cases (historian hanging, LLM API stall) could leave `compartmentInProgress=true` indefinitely in `session_meta`, blocking subsequent compartment runs
- Priority: High

**`transform-heuristic-cleanup-persistence.test.ts` and `transform-index-staleness.test.ts` — no implementation file counterparts found:**
- What's not tested: These test files exist as test-only modules with no obvious single implementation file they map to, suggesting they cover cross-cutting behavior across multiple files.
- Files: `src/hooks/magic-context/transform-heuristic-cleanup-persistence.test.ts`, `src/hooks/magic-context/transform-index-staleness.test.ts`
- Risk: If the implementation files are refactored, these tests may become stale without obvious signal
- Priority: Medium

**`system-injection-stripper.ts` — no test file:**
- What's not tested: `src/hooks/magic-context/system-injection-stripper.ts` has no corresponding `.test.ts` file. System-injected message stripping patterns are tested indirectly via `strip-content.test.ts` but the stripper module itself is untested standalone.
- Files: `src/hooks/magic-context/system-injection-stripper.ts`
- Risk: New system injection patterns added to `strip-content.ts` might not be reflected in the stripper if they diverge
- Priority: Low

**`embedding-backfill.ts` — no test file:**
- What's not tested: `src/features/magic-context/memory/embedding-backfill.ts` has no corresponding test. The backfill path (called on `ctx_recall` when embeddings are missing) is tested only as part of `ctx-recall/tools.test.ts` integration tests.
- Files: `src/features/magic-context/memory/embedding-backfill.ts`
- Risk: A bug in the transaction wrapping or error handling during backfill would not be caught by unit tests
- Priority: Medium

---

*Concerns audit: 2026-03-23*
