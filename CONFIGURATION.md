# Configuration Reference

All settings are flat top-level keys in `magic-context.jsonc`. Create the file in your project root, `.opencode/magic-context.jsonc`, or `~/.config/opencode/magic-context.jsonc` for user-wide defaults. Project config merges on top of user config.

---

## Cache Awareness

LLM providers cache conversation prefixes server-side. The cache window depends on your provider and subscription tier — Claude Pro offers 5 minutes, Max offers 1 hour, and pricing for cached vs. uncached tokens differs between API and subscription usage.

Magic Context defers all mutations until the cached prefix expires. The default `cache_ttl` of `"5m"` matches most providers. You can tune it:

```jsonc
{
  "cache_ttl": "5m"
}
```

Per-model overrides for mixed-model workflows:

```jsonc
{
  "cache_ttl": {
    "default": "5m",
    "anthropic/claude-opus-4-6": "60m"
  }
}
```

Supported formats: `"30s"`, `"5m"`, `"1h"`.

Higher-tier models with longer cache windows benefit from a longer TTL. Setting it too low wastes cache hits. Setting it too high delays reduction on long sessions.

---

## Core

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Master toggle. |
| `cache_ttl` | `string` or `object` | `"5m"` | Time after a response before applying pending ops. String or per-model map. |
| `protected_tags` | `number` (1–20) | `5` | Last N active tags immune from immediate dropping. |
| `nudge_interval_tokens` | `number` | `10000` | Minimum token growth between rolling nudges. |
| `execute_threshold_percentage` | `number` (35–95) or `object` | `65` | Context usage that forces queued ops to execute. Supports per-model map. |
| `auto_drop_tool_age` | `number` | `100` | Auto-drop tool outputs older than N tags during execution. |
| `clear_reasoning_age` | `number` | `50` | Clear thinking/reasoning blocks older than N tags. |
| `iteration_nudge_threshold` | `number` | `15` | Consecutive assistant turns without user input before an iteration nudge. |
| `compartment_token_budget` | `number` | `20000` | Token budget for historian input chunks. |
| `historian_timeout_ms` | `number` | `300000` | Timeout per historian call (ms). |
| `history_budget_percentage` | `number` (0–1) | `0.15` | Fraction of usable context reserved for the history block. Triggers compression when exceeded. |

---

## `historian`

Configures the background historian agent that compresses session history into compartments. Optional — the plugin has a built-in default fallback chain.

```jsonc
{
  "historian": {
    "model": "github-copilot/gpt-5.4",
    "fallback_models": [
      "anthropic/claude-sonnet-4-6",
      "bailian-coding-plan/kimi-k2.5"
    ]
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `model` | `string` | Primary model. |
| `fallback_models` | `string` or `string[]` | Models to try if the primary fails or is rate-limited. |
| `temperature` | `number` (0–2) | Sampling temperature. |
| `variant` | `string` | Agent variant. |
| `prompt` | `string` | Custom system prompt override. |

---

## `dreamer`

Configures the dreamer agent — both the model it uses and the maintenance tasks it runs. Dreamer creates ephemeral child sessions inside OpenCode for each task.

```jsonc
{
  "dreamer": {
    "enabled": true,
    "model": "github-copilot/gpt-5.4",
    "fallback_models": ["anthropic/claude-sonnet-4-6"],
    "schedule": "02:00-06:00",
    "tasks": ["consolidate", "verify", "archive-stale", "improve", "maintain-docs"]
  }
}
```

### Agent fields

| Field | Type | Description |
|-------|------|-------------|
| `model` | `string` | Primary model. |
| `fallback_models` | `string` or `string[]` | Fallback models. |
| `temperature` | `number` (0–2) | Sampling temperature. |
| `variant` | `string` | Agent variant. |
| `prompt` | `string` | Custom system prompt override. |

### Operational fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Enable scheduled dreaming. |
| `schedule` | `string` | `"02:00-06:00"` | Time window for overnight runs (24h, supports overnight like `"23:00-05:00"`). |
| `max_runtime_minutes` | `number` | `120` | Max total runtime per dream session. |
| `task_timeout_minutes` | `number` | `20` | Minutes allocated per individual task. |
| `tasks` | `string[]` | `["consolidate", "verify", "archive-stale", "improve"]` | Tasks to run, in order. |

### Available tasks

| Task | What it does |
|------|-------------|
| `consolidate` | Find semantically duplicate memories and merge each cluster into one canonical fact. |
| `verify` | Check CONFIG_DEFAULTS, ARCHITECTURE_DECISIONS, and ENVIRONMENT memories against actual code. |
| `archive-stale` | Archive memories that reference removed features, old paths, or discontinued workflows. |
| `improve` | Rewrite verbose or narrative memories into terse operational statements. |
| `maintain-docs` | Keep `ARCHITECTURE.md` and `STRUCTURE.md` at project root synchronized with the codebase. |

### How scheduling works

The schedule check piggybacks on `message.updated` events with an hourly debounce. When the current time falls inside the configured window:

1. The scheduler scans the memory store for projects with activity since the last dream.
2. Eligible projects are enqueued into a SQLite-backed dream queue.
3. The queue consumer processes one project at a time, creating a child session per task.
4. `/ctx-dream` also uses the same queue — it enqueues the current project and immediately processes.

---

## `embedding`

Controls semantic search for cross-session memories.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `provider` | `"local"` \| `"openai-compatible"` \| `"off"` | `"local"` | `"local"` runs `Xenova/all-MiniLM-L6-v2` in-process. |
| `model` | `string` | `"Xenova/all-MiniLM-L6-v2"` | Embedding model. |
| `endpoint` | `string` | — | Required for `"openai-compatible"`. |
| `api_key` | `string` | — | Optional API key for remote endpoints. |

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

---

## `memory`

Cross-session memory settings. All memories are scoped to the current project (identified by git root commit hash, with directory-hash fallback for non-git projects).

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable cross-session memory. |
| `injection_budget_tokens` | `number` (500–20000) | `4000` | Token budget for memory injection into `<session-history>`. |
| `auto_promote` | `boolean` | `true` | Promote eligible session facts to memory automatically after historian runs. |
| `retrieval_count_promotion_threshold` | `number` | `3` | Retrievals needed before a memory is auto-promoted to permanent. |

---

## `sidekick`

Optional prompt augmenter that runs on `/ctx-aug`. Uses an OpenAI-compatible endpoint (local or remote) with tool-calling to search memories and produce a context briefing.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Enable sidekick. |
| `endpoint` | `string` | `"http://localhost:1234/v1"` | OpenAI-compatible endpoint. |
| `model` | `string` | `"qwen3.5-9b"` | Model for sidekick queries. |
| `api_key` | `string` | `""` | API key if needed. |
| `max_tool_calls` | `number` | `3` | Max tool calls per retrieval. |
| `timeout_ms` | `number` | `30000` | Timeout per run (ms). |
| `system_prompt` | `string` | — | Custom system prompt override. |

---

## Commands

| Command | Description |
|---------|-------------|
| `/ctx-status` | Show current context usage, tag counts, pending queue, nudge state, and history compression info. |
| `/ctx-flush` | Force-execute all pending operations and heuristic cleanup immediately. |
| `/ctx-recomp` | Rebuild compartments and facts from raw session history. Resumable across restarts. |
| `/ctx-dream` | Enqueue the current project for a dream run and process immediately. |
| `/ctx-aug` | Run sidekick augmentation on the provided prompt. |

---

## Full example

```jsonc
{
  "enabled": true,
  "cache_ttl": {
    "default": "5m",
    "anthropic/claude-opus-4-6": "58m"
  },
  "execute_threshold_percentage": {
    "default": 65,
    "anthropic/claude-opus-4-6": 50
  },
  "protected_tags": 10,
  "auto_drop_tool_age": 50,
  "history_budget_percentage": 0.15,

  "historian": {
    "model": "github-copilot/gpt-5.4",
    "fallback_models": ["anthropic/claude-sonnet-4-6"]
  },

  "dreamer": {
    "enabled": true,
    "model": "github-copilot/gpt-5.4",
    "fallback_models": ["anthropic/claude-sonnet-4-6"],
    "schedule": "02:00-06:00",
    "tasks": ["consolidate", "verify", "archive-stale", "improve", "maintain-docs"]
  },

  "embedding": {
    "provider": "local"
  },

  "memory": {
    "enabled": true,
    "injection_budget_tokens": 4000,
    "auto_promote": true
  },

  "sidekick": {
    "enabled": true,
    "endpoint": "https://api.cerebras.ai/v1",
    "model": "qwen-3-235b-a22b-instruct-2507",
    "api_key": "..."
  }
}
```
