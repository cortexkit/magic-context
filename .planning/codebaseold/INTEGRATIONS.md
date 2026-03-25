# External Integrations

**Analysis Date:** 2026-03-23

## APIs & External Services

**OpenCode Plugin Host:**
- OpenCode AI — The host application this plugin runs inside
  - SDK/Client: `@opencode-ai/plugin` ^1.2.26 (hooks, tool definitions, event system)
  - SDK types: `@opencode-ai/sdk` (used for type imports: `Event`, `Message`, `Part`, `AgentConfig`, `createOpencodeClient`)
  - Integration points: `src/index.ts` exports a `Plugin` function consumed by OpenCode; hooks registered for `event`, `chat.message`, `tool.execute.after`, `experimental.chat.messages.transform`, `experimental.chat.system.transform`, `command.execute.before`, `experimental.text.complete`
  - Auth: None — runs as a trusted in-process plugin

**Embedding — Remote (optional):**
- Any OpenAI-compatible embedding endpoint (e.g. OpenAI, local LM Studio, Ollama)
  - Client: Custom HTTP fetch in `src/features/magic-context/memory/embedding-openai.ts`
  - Config keys: `embedding.endpoint`, `embedding.model`, `embedding.api_key` (in `magic-context.jsonc`)
  - Auth: Bearer token via `embedding.api_key`
  - Activated when `embedding.provider = "openai-compatible"` in plugin config

**Sidekick Agent — Remote (optional):**
- Any OpenAI-compatible chat completions endpoint (default: `http://localhost:1234/v1`)
  - Client: Uses `@opencode-ai/sdk` `createOpencodeClient`; logic in `src/features/magic-context/sidekick/`
  - Config keys: `sidekick.endpoint`, `sidekick.model`, `sidekick.api_key`
  - Auth: Bearer token via `sidekick.api_key`
  - Disabled by default; optional for session-start memory retrieval augmentation

**Dreaming Agent — Remote (optional):**
- Any OpenAI-compatible endpoint for background memory maintenance (default: `http://localhost:1234/v1`)
  - Config keys: `dreaming.endpoint`, `dreaming.model`, `dreaming.api_key`
  - Auth: Bearer token via `dreaming.api_key`
  - Disabled by default; designed for overnight local LLM use

**Historian Agent — Via OpenCode (optional):**
- An LLM accessed through the OpenCode host (not a direct HTTP call)
  - Config keys: `historian.model`, `historian.fallback_models`, `historian.temperature`, `historian.maxTokens`
  - Default chain: `anthropic/claude-haiku-4` → `anthropic/claude-3-5-haiku`
  - Invoked via `client.session.prompt()` using `@opencode-ai/sdk`; logic in `src/shared/model-suggestion-retry.ts`
  - Auth: Delegated to OpenCode host — no API key in this plugin

## Data Storage

**Databases:**
- SQLite (via `bun:sqlite` built-in)
  - Path: `{opencode_storage_dir}/plugin/magic-context/context.db` (resolved in `src/features/magic-context/storage-db.ts`)
  - Connection: Resolved via `getOpenCodeStorageDir()` → `src/shared/data-path.ts`
  - Client: Bun native `bun:sqlite` — no ORM or query builder
  - Tables: `tags`, `pending_ops`, `source_contents`, `compartments`, `session_facts`, `session_notes`, `memories`, `memory_embeddings`, `dream_state`, `session_meta`
  - Full-text search: SQLite FTS5 virtual table `memories_fts` with porter tokenizer
  - Fallback: In-memory `:memory:` database if disk persistence fails

**File Storage:**
- Local filesystem only
  - Plugin config read from: project root, `.opencode/`, or `~/.config/opencode/` (via `src/shared/opencode-config-dir.ts`)
  - Logs written to filesystem via `src/shared/logger.ts` (`node:fs`, `node:os`, `node:path`)
  - No cloud file storage

**Caching:**
- In-memory caches only (SQLite WAL mode for durability; no Redis or external cache)
- `databases` Map in `src/features/magic-context/storage-db.ts` holds open DB handles
- Session meta caches: `memory_block_cache`, `memory_block_count` columns in `session_meta`

## Authentication & Identity

**Auth Provider:**
- None — this is a plugin; all auth is delegated to the OpenCode host
- API keys for optional services (embedding, sidekick, dreaming) are stored as plaintext strings in `magic-context.jsonc` under `embedding.api_key`, `sidekick.api_key`, `dreaming.api_key`

**Project Identity:**
- Project identified by git root commit hash (not path)
- Logic in `src/features/magic-context/memory/project-identity.ts`
- Used as the `project_path` key for all memories in the `memories` table

## Monitoring & Observability

**Error Tracking:**
- None — no external error tracking service

**Logs:**
- Custom logger in `src/shared/logger.ts` using `node:fs`/`node:os`/`node:path`
- Log files written to disk (path determined by `logger.ts`; likely under OS temp or data dir)
- Structured prefix tagging: `[magic-context]`, `[model-suggestion-retry]`, etc.

## CI/CD & Deployment

**Hosting:**
- npm registry as `@cortexkit/magic-context-opencode`
- `prepublishOnly` script runs `bun run build` before publish

**CI Pipeline:**
- Not detected (no `.github/`, `.gitlab-ci.yml`, or similar CI config found)

## Webhooks & Callbacks

**Incoming:**
- None — plugin operates entirely within the OpenCode in-process plugin lifecycle

**Outgoing:**
- Embedding endpoint: POST `{embedding.endpoint}/embeddings` (only when `embedding.provider = "openai-compatible"`)
- Sidekick/Dreaming: OpenAI-compatible chat completions via `@opencode-ai/sdk` client (when enabled)
- Historian: OpenCode session prompt calls via `client.session.prompt()` (when historian is active)

## Environment Configuration

**Required env vars:**
- None — no environment variables required for operation

**Optional config (in `magic-context.jsonc`):**
- `embedding.api_key` — API key for remote embedding endpoint
- `embedding.endpoint` — URL for remote embedding provider
- `sidekick.api_key` — API key for sidekick agent
- `sidekick.endpoint` — URL for sidekick agent
- `dreaming.api_key` — API key for dreaming agent
- `dreaming.endpoint` — URL for dreaming agent

**Secrets location:**
- `magic-context.jsonc` (project-local or `~/.config/opencode/magic-context.jsonc`)
- No `.env` file pattern used

---

*Integration audit: 2026-03-23*
