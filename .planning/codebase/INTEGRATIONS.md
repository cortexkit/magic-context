# External Integrations

**Analysis Date:** 2026-03-25

## OpenCode Plugin System

**Integration Type:** Core dependency — this entire codebase IS an OpenCode plugin.

**SDK Package:** `@opencode-ai/plugin` ^1.2.26 (and `@opencode-ai/sdk` for type imports)

**Plugin Entry Point:** `src/index.ts` — exports a default `Plugin` async function that receives a `ctx` object from OpenCode.

**Plugin API Surface Used:**

| Hook / Field | Location | Purpose |
|---|---|---|
| `tool` | `src/plugin/tool-registry.ts` | Registers `ctx_reduce`, `ctx_expand`, `ctx_note`, `ctx_memory` tools with OpenCode |
| `event` | `src/plugin/event.ts` | Handles OpenCode events (e.g., `message.updated` for dreamer scheduler) |
| `experimental.chat.messages.transform` | `src/plugin/messages-transform.ts` | Rewrites message list — applies queued drops, injects `<session-history>` block |
| `experimental.chat.system.transform` | `src/index.ts` | Injects memory + compartment data into system prompt |
| `command.execute.before` | `src/index.ts` | Intercepts slash commands (`/ctx-*`) before execution |
| `chat.message` | `src/index.ts` | Triggers per-message processing (tagging, nudge evaluation) |
| `tool.execute.after` | `src/index.ts` | Post-tool hook for tracking tool output sizes |
| `experimental.text.complete` | `src/index.ts` | Access to completed AI responses for context usage tracking |
| `config` | `src/index.ts` | Injects agent definitions (historian, dreamer, sidekick) and slash commands into OpenCode config |

**PluginContext (`ctx`):**
- `ctx.directory` — project root path, used for config loading and project identity
- Type defined in `src/plugin/types.ts`

**Agent Registration:**
The plugin registers three hidden sub-agents into OpenCode's `config.agent` map:
- `historian` (agent ID: `src/agents/historian.ts`) — runs compartment compression
- `dreamer` (agent ID: `src/agents/dreamer.ts`) — runs overnight memory maintenance
- `sidekick` (agent ID: `src/agents/sidekick.ts`) — runs prompt augmentation

Each hidden agent has `mode: "subagent"` and `hidden: true`.

**Slash Commands Injected:**
- `/ctx-status`, `/ctx-flush`, `/ctx-recomp`, `/ctx-aug`, `/ctx-dream`
- Defined in `src/features/builtin-commands/commands.ts`, registered via `config.command`

**Compaction Detection:**
- `src/shared/opencode-compaction-detector.ts` checks if OpenCode's built-in auto-compaction is enabled
- If detected, the plugin disables itself to avoid conflict

---

## OpenCode SDK (`@opencode-ai/sdk`)

**Used as type-only imports** (no runtime dependency directly on this package):
- `Message`, `Part` — message/content types for transform hooks (`src/plugin/messages-transform.ts`)
- `Event` — event type for the event handler (`src/plugin/event.ts`)
- `AgentConfig` — agent configuration type extended by `AgentOverrideConfig` (`src/config/schema/agent-overrides.ts`)

---

## HuggingFace Transformers (Local Embedding)

**Package:** `@huggingface/transformers` ^3.5.1

**Purpose:** Local ML inference for semantic search over cross-session memories.

**Default Model:** `Xenova/all-MiniLM-L6-v2` (quantized, 384-dimension embeddings)

**Implementation:** `src/features/magic-context/memory/embedding-local.ts`
- `LocalEmbeddingProvider` class wraps the `pipeline()` API with lazy initialization
- Model is loaded on first embed call via dynamic `import("@huggingface/transformers")`
- Supports both single `embed()` and batch `embedBatch()` operations
- Model files are downloaded from HuggingFace Hub on first use (cached locally by the transformers library)

**Build Note:** Marked `--external` in the Bun build command — not bundled into `dist/index.js`. Users must have the package installed.

**Config Toggle:** Disabled when `embedding.provider` is set to `"off"` in `magic-context.jsonc`.

---

## OpenAI-Compatible Embedding API (Optional Remote Embedding)

**Purpose:** Alternative to local HuggingFace embeddings for users who prefer hosted models.

**Implementation:** `src/features/magic-context/memory/embedding-openai.ts`
- `OpenAICompatibleEmbeddingProvider` class calls `/embeddings` endpoint via `fetch()`
- Supports Bearer token authentication
- Accepts any OpenAI-compatible endpoint (OpenAI, Azure, Ollama, local proxies, etc.)

**Configuration in `magic-context.jsonc`:**
```jsonc
{
  "embedding": {
    "provider": "openai-compatible",
    "model": "text-embedding-3-small",
    "endpoint": "https://api.openai.com/v1",
    "api_key": "sk-..."
  }
}
```

**Auth:** Optional `api_key` — sent as `Authorization: Bearer <key>` header if present.

---

## LLM Providers (via OpenCode Agent System)

The plugin does NOT call LLM providers directly. All model inference is delegated to OpenCode's agent execution system. The plugin configures which models to use via agent override config.

**Models referenced in configs and defaults:**
- `anthropic/claude-sonnet-4-6` — default historian and dreamer model
- `anthropic/claude-3-5-haiku` — default fallback for historian
- `anthropic/claude-opus-4-6` — mentioned in config examples for long-cache-window tuning

**Model config path:** `src/config/schema/magic-context.ts` (`AgentOverrideConfigSchema`) and `src/shared/model-requirements.ts`

**Per-agent model override:** Users can specify `historian.model`, `dreamer.model`, `sidekick.model` in `magic-context.jsonc`; fallback chains supported.

---

## Local SQLite Database (via Bun)

**Integration:** `bun:sqlite` — Bun's built-in SQLite binding (no npm package).

**Implementation:** `src/features/magic-context/storage-db.ts`

**Database Path:** `~/.local/share/opencode/storage/plugin/magic-context/context.db`
- Respects `XDG_DATA_HOME` environment variable
- Directory created automatically on first use

**Fallback:** If the file database cannot be opened, an in-memory `:memory:` database is used and the plugin warns the user via `console.warn`.

**Schema Tables:**

| Table | Purpose |
|-------|---------|
| `tags` | Tag assignments — maps message IDs to `§N§` tag numbers |
| `pending_ops` | Queued drop operations awaiting cache expiry |
| `source_contents` | Raw content snapshots for content-replacing drops |
| `compartments` | Historian-produced structured history summaries |
| `session_facts` | Categorized facts extracted by the historian |
| `session_notes` | `ctx_note` content scoped per session |
| `session_meta` | Per-session state: last response time, cache TTL, nudge flags, context % |
| `memories` | Cross-session persistent project memories |
| `memory_embeddings` | Embedding vectors (BLOB) for semantic search |
| `memories_fts` | FTS5 virtual table for full-text memory search (Porter stemmer) |
| `dream_state` | Dreamer lease locking key-value store |
| `dream_queue` | Projects queued for dream processing |
| `recomp_compartments` | Staging for `/ctx-recomp` partial runs |
| `recomp_facts` | Staging for `/ctx-recomp` partial runs |

**WAL mode** enabled; `busy_timeout` set to 5000ms.

---

## NPM Registry

**Package Name:** `@cortexkit/magic-context-opencode`
**Version:** 0.1.0
**Registry:** npmjs.com (public)
**Publish:** `prepublishOnly` runs `bun run build`; only `dist/` and `README.md` are published

---

## Configuration File System

**Config file:** `magic-context.jsonc` (JSONC format with comment support)

**Config search path** (first match wins):
1. `<project-root>/magic-context.jsonc`
2. `<project-root>/.opencode/magic-context.jsonc`
3. `~/.config/opencode/magic-context.jsonc`

**Loading:** `src/config/index.ts` via `loadPluginConfig(ctx.directory)`
**Parsing:** `src/shared/jsonc-parser.ts` — strips `//` and `/* */` comments before JSON.parse
**Validation:** Zod schema in `src/config/schema/magic-context.ts` with all defaults applied

---

## No Webhooks, No External APIs (beyond embeddings)

- No outgoing webhooks
- No incoming HTTP server
- No analytics or telemetry
- No authentication providers (relies entirely on OpenCode's auth for LLM calls)
- No cloud storage (all state is local SQLite)

---

*Integration audit: 2026-03-25*
