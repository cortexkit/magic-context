# Memory and search

Magic Context keeps a durable knowledge layer beside the context window: project memories, workspaces that share them across repositories, embeddings, and indexes over raw messages and git commits. `ctx_search` queries all of it in one call, and the transform surfaces new memories through `m[1]` without busting the cached prefix.

Paths are relative to `packages/plugin/`.

## Where the code is

- `src/features/magic-context/memory/storage-memory.ts`, `storage-memory-fts.ts`, `storage-memory-embeddings.ts`: memory rows and their indexes.
- `src/features/magic-context/memory/constants.ts`: categories.
- `src/features/magic-context/memory/project-identity.ts`, `storage-identity-merge.ts`: project identity.
- `src/features/magic-context/memory/memory-visibility.ts`, `src/features/magic-context/workspaces.ts`: who can see and change which memories.
- `src/features/magic-context/storage-memory-mutation-log.ts`: the cache-neutral change log behind `<memory-updates>`.
- `src/tools/ctx-memory/`, `src/tools/ctx-search/`, `src/tools/ctx-note/`, `src/tools/ctx-expand/`: the agent tools.
- `src/features/magic-context/memory/embedding*.ts`, `src/features/magic-context/project-embedding-registry.ts`, `compartment-chunk-embedding.ts`: embeddings.
- `src/features/magic-context/search.ts`: unified search.
- `src/features/magic-context/message-index.ts`, `message-fts-rowid-map.ts`, `message-time-backfill.ts`: the raw-message index.
- `src/features/magic-context/git-commits/`: the git-commit index.
- `src/hooks/magic-context/auto-search-runner.ts`, `auto-search-hint.ts`: search hints on new user prompts.

## Memories

A memory is a short project-scoped fact. New writes use five categories: `PROJECT_RULES`, `ARCHITECTURE`, `CONSTRAINTS`, `CONFIG_VALUES` and `NAMING`. Older rows may carry legacy categories, which stay readable and are mapped to the current set as the dreamer's curate task touches them. Rows carry a normalised-content hash for exact deduplication, an importance and scope classification, retrieval counts, and verification state maintained by the dreamer.

A project is identified by `git:<root commit sha>` when the directory is a git repository and `dir:<hash>` otherwise (`project-identity.ts`). Transient git errors get a cooldown instead of flipping identity; `storage-identity-merge.ts` merges rows when two identities turn out to be the same project, with an audit log, and the CLI exposes it as `doctor merge-identity`.

Memories come from three writers: the historian's fact promotion (when `memory.auto_promote` is on), the agent through `ctx_memory`, and the dreamer. `ctx_memory` offers `write`, `update` (optionally with a new category), `archive`, `merge` and `get` to primary agents; `list` is reserved for dreamer tasks. Primary agents can only mutate their own project's memories. Duplicate detection on `update` is scoped to the target project, category and hash inside one immediate transaction. When `memory.enabled` is false, `ctx_memory` is not registered on OpenCode (Pi registers it but refuses for memory-off projects), memory guidance is removed from the system prompt, and every memory-derived prompt surface is suppressed.

### How memories reach the prompt without a bust

The baseline memory block lives in `m[0]`. Changes made during a session go through `m[1]`:

- Additions surface through a `maxMemoryId` watermark: anything newer than what `m[0]` rendered is shown in `m[1]`.
- `update`, `archive` and `merge` write a row to `memory_mutation_log`, rendered in `m[1]` as a `<memory-updates>` delta.

Both are folded into `m[0]` on the next natural HARD fold. Only changes made from outside a running session (the dashboard) bump `project_memory_epoch`, which does force a fold, because an external editor has no other way to signal a live session. `ARCHITECTURE.md` (the protected `m[0]`/`m[1]` section) is the authority on this contract.

## Workspaces

A project belongs to at most one workspace (`workspaces`, `workspace_members`). Member sessions read the union of all members' memories, labelled with their repository, but only for the categories the workspace shares (`share_categories`, default `["CONSTRAINTS"]`). Sharing is read-only: an agent can never mutate another project's memory. A workspace fingerprint (sorted member identities, epochs and shared categories) is cached with `m[0]` (`cached_m0_workspace_fingerprint`), so a membership or policy change causes one HARD fold.

## Embeddings

Vectors are stored as plain SQLite blobs and compared in memory with `Float32Array` cosine similarity. There is no vector extension because `bun:sqlite` cannot load extensions. `saveEmbeddingIfHashMatches` stores a vector only if the memory's content has not changed while the provider call was in flight.

Providers (`embedding.provider`):

- **`local`** (default): Transformers.js with ONNX. `embedding.local_runtime` chooses the runtime: `auto` uses the native `onnxruntime-node` under Node and on Bun 1.4.0 or later, and WASM on older Bun, where native teardown can crash on quit. If native loading fails the plugin falls back to WASM; the WASM runtime is pinned to one thread so idle worker threads cannot starve the host event loop. If both fail, local embeddings are disabled for the rest of the process with a warning that points at `doctor`.
- **`openai-compatible`**: any endpoint with that API; requires `endpoint` and `model`.
- **`synapse`**: the certified local embedding service in the subc daemon, reached over RPC (`embed.batch`, `models.list`), with batching, polling and restart handling. It requires a `fallback_provider` (`local`, `openai-compatible` or `off`) for when it cannot initialise, and records batches in `synapse_batch_ledger`.
- **`off`**.

The provider is resolved per project (`project-embedding-registry.ts`). A substitution guard rejects a response from a model other than the one requested, and a registration retired mid-embed discards the vectors it produced. Provider failures are classified (substitution, HTTP, envelope, transport, empty result, certification refusal, missing credential) so `/ctx-embed` can say what to fix. In tests, constructing a network-capable provider without an explicit test factory fails closed.

Memories and git commits are embedded as they are written. Compartment-chunk embeddings (windows of compartment transcripts used by search) are embedded on demand: `/ctx-embed start` drains the backlog, `/ctx-embed pause` stops it, and the active session is drained once per process automatically. Chunk-window settings are part of each chunk's identity, so changing them does not invalidate memory or commit vectors. Backfill selection prefers missing windows over stale ones, and a persistent latch stops the same stalled batch being resubmitted for an hour.

## Unified search (`ctx_search`)

`search.ts` runs one query across up to five sources: memories, raw message history, indexed git commits, compartment summaries (through chunk embeddings) and notes. It combines full-text and embedding scores, and only explicit tool calls use multi-probe message search (extracting literal symbols, commands and paths from the query and fusing their results).

Results the agent can already see are hidden: memories already rendered in `<session-history>`, and message hits newer than the last compartment boundary (still in the live tail). The tool reports how many were suppressed. `from` and `to` bound every source by date (`YYYY-MM-DD` or full ISO; `src/tools/ctx-search/date-range.ts`), backed by a per-message timestamp in the message index. Explicit tool calls increment memory retrieval counts; automatic surfacing does not, so it cannot skew promotion.

**Auto-search.** When a new user message arrives, `auto-search-runner.ts` may run a search for it and append a short, compressed "vague recall" hint to that same user message, nudging the agent to call `ctx_search` rather than injecting content. It attaches only to the triggering user message and is idempotent across passes, so it never changes the cached prefix. The hint fires only when the top score exceeds `auto_search.score_threshold`.

## The raw-message index

`message-index.ts` keeps an FTS5 index of raw message text, maintained outside the search path: live `message.updated` events write incrementally, and an asynchronous reconciler fills gaps. A failed incremental write lowers a per-session dirty floor (`dirty_floor_ordinal`) so the reconciler rewinds and covers it. A session missing from the local OpenCode store is not evidence of deletion: other OpenCode instances can share the Magic Context store. Its data is retained unless explicitly deleted.

## The git-commit index

With `memory.git_commit_indexing.enabled` (opt-in, independent of `memory.enabled`), the dream timer indexes commits reachable from `HEAD`, skipping merges, up to a configured age and count (defaults 365 days and 2,000 commits), and embeds their messages for `ctx_search`. Directories that are not git repositories, or have no commits yet, are parked on a 24-hour re-probe cooldown instead of logging an error every tick.

## Notes and expand

`ctx_note` stores session notes and smart notes. A smart note carries a condition that the dreamer's `evaluate-smart-notes` task compiles into a check and evaluates in a sandbox; when the condition holds, the note is surfaced to the session. Reads without ids return a one-line summary per note; reads with `note_ids` return full bodies.

`ctx_expand` recovers original content from `source_contents` and raw history, for a single tag or a range, which is why no drop or compression on the reclaim page ever loses information.
