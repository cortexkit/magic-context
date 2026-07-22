# Configuration Reference

All settings are flat top-level keys in `magic-context.jsonc`. The schema is **shared between the OpenCode plugin and the Pi extension** — every setting documented here applies to both unless explicitly marked **Pi only** or **OpenCode only**.

### Configuration locations

Magic Context reads config from **one shared CortexKit location**, the same for both harnesses (project overrides user):

| Path | Scope |
|---|---|
| `<project>/.cortexkit/magic-context.jsonc` | Project |
| `~/.config/cortexkit/magic-context.jsonc` | User-wide defaults |

Project config always merges on top of user config. The unified setup wizard (`npx @cortexkit/magic-context@latest setup`) writes the user-level file with sensible defaults.

> **Migrating from an earlier version?** Config used to live in per-harness paths (`~/.config/opencode/`, `~/.pi/agent/`, `<project>/.opencode/`, `<project>/.pi/`, or the project root). On first run after upgrading, Magic Context moves your existing config to the CortexKit location automatically and leaves a `<old-name>.MOVED_READPLEASE` breadcrumb (preserving your original settings) at each old path. If two old locations held *different* settings it won't guess — it leaves both in place and warns you to consolidate by hand.

### Cross-harness scoping

Both plugins write to the same SQLite database at `~/.local/share/cortexkit/magic-context/context.db`. Tables are scoped by:

- `harness` column (`'opencode'` or `'pi'`) for **session-scoped** data — tags, compartments, session facts, notes
- `project_path` (resolved git root) for **project-scoped** data — memories, embeddings, dreamer runs, key-file pins, smart notes

So memories you write in OpenCode appear in Pi sessions for the same project (and vice versa), while per-session compartments and tags stay correctly attributed to their originating harness.

For semantic search to work cross-harness, both plugins resolve embedding config per project identity on every retrieval path. OpenCode and Pi can run in the same process against different projects without sharing one process-global embedding provider. For one project, keep the effective `embedding` block consistent across the OpenCode and Pi config stack; Magic Context tags stored vectors with the resolved model identity and clears stale vectors for that project when the provider/model changes.

### JSON Schema

Add `$schema` to your config file for autocomplete and validation in VS Code and other editors:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/cortexkit/magic-context/master/assets/magic-context.schema.json"
}
```

Both setup wizards add this automatically.

### Doctor

If something isn't working, run the unified doctor to auto-detect installed harnesses and fix common issues:

```bash
# Auto-detect installed harnesses; if both, picks the first or asks
npx @cortexkit/magic-context@latest doctor

# Target a specific harness explicitly
npx @cortexkit/magic-context@latest doctor --harness opencode
npx @cortexkit/magic-context@latest doctor --harness pi
```

The OpenCode doctor checks: installation, CLI version vs npm latest, plugin registration (preserves local dev paths), `magic-context.jsonc` parses + loads through the schema, conflicts (compaction, DCP, OMO hooks), TUI sidebar configuration, embedding endpoint, shared-DB existence + `PRAGMA integrity_check` + row counts, plugin npm cache, and historian debug dumps.

The Pi doctor checks: Pi binary + version (requires `>= 0.71.0`), CLI version vs npm latest, settings registration, config validity, embedding endpoint reachability, shared-DB integrity, stale Pi extension caches, and historian debug dumps.

Both report `PASS X / WARN Y / FAIL Z` summary counts. Use `--force` to auto-fix what doctor can (clears stale plugin cache, repairs config) and `--issue` to produce a sanitized issue report.

### SQLite backend

Magic Context uses the runtime's built-in SQLite: `bun:sqlite` under Bun (OpenCode CLI/TUI) and `node:sqlite` under Node and Electron (Pi, OpenCode Desktop — Electron 41 embeds Node 24.14.1, which ships `node:sqlite` flag-free). There is no native module to install, no per-ABI prebuild, and nothing downloaded at runtime — the store works offline on first launch on every platform.

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
| `enabled` | `boolean` | `true` | Master toggle. |
| `auto_update` | `boolean` | `true` | User-config-only plugin self-update toggle; project configs cannot disable it. |
| `language` | `string` | unset | User-config-only output language for Magic Context generated prose and primary guidance, as a 2-letter ISO 639-1 code, for example `"tr"`, `"es"`, or `"pt"`. Structural tokens stay in English. |
| `cache_ttl` | `string` or `object` | `"5m"` | Time after a response before applying pending ops. String or per-model map. |
| `protected_tags` | `number` (1–100) | `20` | Last N active tags immune from immediate dropping. |
| `toast_duration_ms` | `number` (0–60000) | `5000` | TUI toast lifetime for Magic Context notifications in milliseconds. Increase this if toasts disappear too quickly, or set to `0` to disable Magic Context toasts entirely. |
| `execute_threshold_percentage` | `number` (20–80) or `object` | `65` | Context usage that forces queued ops to execute. Capped at 80% max for cache safety. Supports per-model map. |
| `execute_threshold_tokens` | `object` (per-model map) | — | **Optional absolute-tokens variant of `execute_threshold_percentage`.** Per-model map (e.g. `{ "default": 150000, "github-copilot/gpt-5.2-codex": 40000 }`). When set for a model, overrides the percentage-based threshold for that model. Clamped to `80% × context_limit` with a warn log. Requires a resolvable context limit — falls through to percentage if unavailable. See below. |
| `clear_reasoning_age` | `number` | `50` | Clear thinking/reasoning blocks older than N tags. |
| `historian_timeout_ms` | `number` | `300000` | Timeout per historian call (ms). |
| `history_budget_percentage` | `number` (0.05–0.5) | `0.15` | Fraction of usable context (`context_limit × execute_threshold`) reserved for the history block. Triggers compression when exceeded. |
| `commit_cluster_trigger` | `object` | See below | Controls the commit-cluster historian trigger. |
| `system_prompt_injection` | `object` | See below | Controls whether and where Magic Context augments the system prompt; lets you opt specific agents out. |
| `keep_subagents` | `boolean` | `false` | Debug: keep the child sessions Magic Context spawns for its own subagents (historian, dreamer, sidekick, memory-migration) instead of deleting them on success, so their full transcript stays in the host session store for inspection. Kept sessions accumulate until cleared manually — leave `false` for normal use. |
| `todowrite` | `object` | See below | **Pi only.** Controls Magic Context's built-in `todowrite` tool and persistent task overlay. OpenCode has its own built-in `todowrite`, so this setting has no effect there. |
| `sqlite` | `object` | See below | Per-connection SQLite tuning for Magic Context's own `context.db`. |

### `language`

Set `language` in your **user config** when you want Magic Context generated prose to consistently use a language instead of relying on model auto-mirroring. The value is a 2-letter ISO 639-1 code (for example `tr`, `es`, `de`, `ja`, `pt`):

```jsonc
{
  "language": "tr"
}
```

This affects historian summaries, dreamer content, sidekick output, and the Magic Context guidance block. It does not translate schemas, XML tags, memory category names, code identifiers, file paths, commands, logs, or quoted text. Project configs cannot set this field for security, since it is injected into hidden-agent system prompts.

Changing `language` does not rewrite existing compartments or memories. A project can temporarily have a mixed-language pool after a mid-project switch; older stored entries keep their original language until they are naturally rewritten or superseded.

### `commit_cluster_trigger`

A **commit cluster** is a distinct work phase where the agent made one or more git commits, separated from other commit clusters by meaningful user turns. For example, if the agent commits a fix, then the user asks a new question, and the agent commits another change — that's 2 commit clusters. This heuristic detects natural work-unit boundaries and fires historian to compartmentalize them, even when context pressure is low.

```jsonc
{
  "commit_cluster_trigger": {
    "enabled": true,    // default: true
    "min_clusters": 3   // default: 3, minimum: 1
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable commit-cluster based historian triggering. |
| `min_clusters` | `number` | `3` | Minimum number of commit clusters in the unsummarized tail before historian fires. The tail must also contain at least one `trigger_budget` worth of tokens, where `trigger_budget = main_context × execute_threshold × 5%` clamped to `[5K, 50K]`. |

Set `enabled: false` to disable this trigger entirely and rely only on pressure-based and tail-size triggers for historian.

### `system_prompt_injection`

Controls whether and where Magic Context augments the system prompt (its guidance block plus the surrounding project-docs and user-profile blocks). OpenCode's internal hidden agents — `title`, `summary`, and `compaction` — are always skipped automatically; this section lets you opt out additional agents, or disable injection globally.

```jsonc
{
  "system_prompt_injection": {
    "enabled": true,                               // default: true
    "skip_signatures": ["<!-- magic-context: skip -->"]  // default
  }
}
```

- **`enabled`** — when `false`, NO injection happens for ANY agent. Global escape hatch; Magic Context's transform and compaction still run, but nothing is added to the system prompt.
- **`skip_signatures`** — substring opt-out list. If an agent's system prompt contains any of these strings, Magic Context skips ALL injection for that call. Use it to exempt a specific custom agent by putting the signature (e.g. the default `<!-- magic-context: skip -->`) in that agent's prompt.

### `todowrite` (Pi only)

Pi does not ship a built-in `todowrite` tool, so Magic Context registers an OpenCode-parity task-list tool by default. Disable it if another Pi extension already provides todo UX:

```jsonc
{
  "todowrite": {
    "enabled": true,  // default: true
    "overlay": true   // default: true
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Register Magic Context's Pi `todowrite` tool and `/todos` command. Set `false` when using another todo extension. |
| `overlay` | `boolean` | `true` | Show the persistent todo overlay above the editor while tasks are active. |

Pi registers tools, slash commands, and widgets once at extension boot. If you `/cd` into a project with a different `todowrite.enabled` value, run `/reload` or restart Pi for the tool surface to change.

### `sqlite`

Per-connection PRAGMAs applied to Magic Context's own `context.db` at open. These tune SQLite's runtime behaviour only — they do not change the schema or what is stored, and they do not touch OpenCode's or Pi's databases.

```jsonc
{
  "sqlite": {
    "cache_size_mb": 64,   // default: 64, min: 2, max: 2048 — page-cache size per connection
    "mmap_size_mb": 0      // default: 0 (disabled), min: 0, max: 8192 — memory-mapped I/O size
  }
}
```

- **`cache_size_mb`** — how much page cache each connection keeps resident (`PRAGMA cache_size`). The DB grows large on long-lived projects, and several hot paths do repeated full-table scans; a larger cache keeps those pages in memory instead of re-reading from disk. Raised from SQLite's ~2 MB default to **64 MB**.
- **`mmap_size_mb`** — memory-maps the database file (`PRAGMA mmap_size`) so reads avoid a copy through the page cache. Can reduce read overhead on large DBs at the cost of address space. **Disabled by default (`0`)**, matching SQLite's default; raise it (e.g. `256`) only if you want to experiment with read performance.

Separately, Magic Context runs `PRAGMA optimize` (bounded by `PRAGMA analysis_limit=400`) on its 15-minute maintenance tick. This is self-gating — it re-analyses a table only when its row count has drifted enough to matter — so the query planner keeps choosing good indexes as the database grows. There is no config knob for it.

### `execute_threshold_tokens`

An absolute-tokens alternative to `execute_threshold_percentage`. Useful when you want a hard cap expressed in tokens rather than a percentage — for example, when a provider limits effective prompt size below its advertised context window.

```jsonc
{
  "execute_threshold_tokens": {
    "default": 150000,                          // fires at 150K for any model without an explicit entry
    "github-copilot/gpt-5.2-codex": 40000       // fires at 40K specifically for gpt-5.2-codex
  }
}
```

**Behavior:**

- Per-model map only — no bare-number form. All sessions are assumed to have different context limits, so the `default` key acts as a fallback inside the map.
- **Tokens wins:** when a matching entry exists for the current model, it overrides the percentage-based threshold for that model. Other models continue to use `execute_threshold_percentage`.
- **Progressive key lookup** just like percentage config — `openai/gpt-5.4-fast` matches `openai/gpt-5.4` if the derived key is absent.
- **Clamped at 80% × context_limit** for the same cache-safety reason as percentage. If the clamp fires, a `log.warn` records the original and capped value.
- Requires a **resolvable context limit** at runtime. On brand-new sessions before any response arrives, the context limit is unknown — in that case, resolution falls through to `execute_threshold_percentage`. Once the first response lands, the correct tokens-based threshold is applied on the following turn.

**When to prefer tokens over percentage:**

- You hit a provider-side prompt cap (like GitHub Copilot's `max_prompt_tokens` ignoring user config overrides — see the github-copilot interaction in the project KNOWN_ISSUES).
- You want consistent compaction behavior across models with very different context window sizes.

**When to prefer percentage:**

- You want the threshold to scale proportionally with the model's window (bigger window → compacts later in absolute terms).
- You're not targeting a specific provider cap.

---

## Model Resolution

Each hidden agent (historian, dreamer, sidekick) uses the `model` you configure for it. There is **no built-in fallback chain** — Magic Context never silently tries models you haven't configured (a hardcoded chain inevitably names providers you don't have, producing confusing `Model not found` errors).

If the configured primary fails (auth, transient, or returns unusable output), the fallback order is:

1. Your explicit `fallback_models` for that agent, in order.
2. **Historian only:** your active session model, as a last resort (a model you're already using). The dreamer and sidekick use only their configured `fallback_models`.

If you set no `fallback_models`, a failing primary simply retries — it never jumps to an unconfigured model. Set `fallback_models` to add alternates of your own (each `"provider/model-id"`).

> **Tip — Dreamer with local models:** Since the dreamer runs during idle time (typically overnight), it works well with local models. Even slower ones like `ollama/mlx-qwen3.5-27b-claude-4.6-opus-reasoning-distilled` are fine — there's no user waiting.

### Advanced agent fields

All three agents (`historian`, `dreamer`, `sidekick`) accept these additional fields beyond the common `model`, `fallback_models`, `temperature`, `variant`, `prompt`. Most map directly to OpenCode's `AgentConfig` and pass through unchanged.

| Field | Type | Description |
|-------|------|-------------|
| `tools` | `{ [toolName: string]: boolean }` | Restrict which tools the agent can use. `{ "bash": false, "write": false }` disables those tools for this agent only. |
| `permission` | `object` | Per-agent permission overrides. Sub-fields: `edit`, `bash`, `webfetch`, `doom_loop`, `external_directory`. Each accepts `"ask"`, `"allow"`, or `"deny"`. `bash` additionally accepts a record form for per-command rules. |
| `disable` | `boolean` | Disable the agent without removing its config. Useful for toggling on/off during testing. |
| `description` | `string` | Agent description shown in OpenCode UI. |
| `mode` | `"subagent"` \| `"primary"` \| `"all"` | OpenCode agent mode. Magic Context internal agents run as `subagent`. |
| `top_p` | `number` (0–1) | Nucleus sampling. |
| `maxSteps` | `number` | Max reasoning steps per agent call. |
| `maxTokens` | `number` | Max output tokens. ⚠️ OpenCode does not currently consume this field for plugin-registered agents — setting it has no effect. Tracked in the project as a known limitation. |
| `color` | `string` (`#RRGGBB`) | Display color in OpenCode UI. |

Example — restricting historian to read-only tools and denying bash:

```jsonc
{
  "historian": {
    "model": "github-copilot/gpt-5.4",
    "tools": { "bash": false, "write": false, "edit": false },
    "permission": { "bash": "deny", "webfetch": "deny" }
  }
}
```

---

## `historian`

Configures the background historian agent that compresses session history into compartments.

```jsonc
{
  "historian": {
    "model": "github-copilot/gpt-5.4",
    "fallback_models": [
      "anthropic/claude-sonnet-4-6",
      "bailian-coding-plan/kimi-k2.5"
    ],
    "two_pass": false
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `model` | `string` | Primary model. |
| `fallback_models` | `string` or `string[]` | Models to try if the primary fails or is rate-limited. |
| `temperature` | `number` (0–2) | Sampling temperature. |
| `variant` | `string` | **OpenCode only.** Agent variant — selects a thinking/reasoning preset configured in OpenCode itself. Pi uses `thinking_level` instead. |
| `thinking_level` | `string` | **Pi only.** Explicit reasoning level passed to Pi when spawning the historian subagent (`off`, `low`, `medium`, `high`). Required for GitHub Copilot reasoning models on Pi — without it, Copilot injects `"minimal"` as a default and then rejects it (HTTP 400). The Pi setup wizard prompts for this when you pick a `github-copilot/*` model. |
| `prompt` | `string` | Custom system prompt override. |
| `two_pass` | `boolean` | Default `false`. When `true`, runs a second editor pass after each successful historian output. The editor (a separate hidden `historian-editor` agent using the same model resolution as the historian) re-reads the draft and removes low-signal `U:` lines, redundant paraphrases, and cross-compartment duplicates, producing cleaner narrative-first summaries. Falls back to the draft if the editor call or its validation fails, so it can never regress behavior. Adds one extra historian-scale call per compartment publication. Recommended for non-reasoning models and open-weight local models where the single-pass draft is noisier. For models with extended thinking/reasoning enabled in OpenCode (Claude 4+, GPT-5.x reasoning variants), the single-pass output is usually already clean and `two_pass` can stay `false`. |

---

## `dreamer`

Configures the dreamer agent — both the model it uses and the maintenance tasks it runs. Dreamer creates ephemeral child sessions inside OpenCode for each task.

Each dreamer task is **independently scheduled** with its own cron expression. There is no single dreamer "run" or time window — a process-wide timer runs whichever tasks are due.

```jsonc
{
  "dreamer": {
    "model": "github-copilot/gpt-5.4",
    "fallback_models": ["anthropic/claude-sonnet-4-6"],
    "tasks": {
      "map-memories": { "schedule": "0 2 * * *" },
      "verify": { "schedule": "0 3 * * *" },
      "verify-broad": { "schedule": "0 4 * * 0" },
      "curate": { "schedule": "0 4 * * 0" },
      "classify-memories": { "schedule": "0 6 * * *" },
      "retrospective": { "schedule": "0 5 * * *" },
      "maintain-docs": { "schedule": "" },
      "promote-primers": { "schedule": "0 3 * * *", "promotion_threshold": 2 },
      "refresh-primers": { "schedule": "0 3 * * *" },
      "evaluate-smart-notes": { "schedule": "0 3 * * *" },
      "review-user-memories": { "schedule": "0 3 * * *", "promotion_threshold": 3 }
    }
  }
}
```

To disable the dreamer entirely, set `dreamer.disable: true`. To disable a single task, set its `schedule` to `""` (it can still be run on demand via `/ctx-dream <task>`).

### Agent fields

| Field | Type | Description |
|-------|------|-------------|
| `model` | `string` | Default model for all tasks (each task may override). |
| `fallback_models` | `string` or `string[]` | Default fallback chain (each task may override). |
| `temperature` | `number` (0–2) | Sampling temperature. |
| `variant` | `string` | **OpenCode only.** Agent variant — selects a thinking/reasoning preset. Pi uses `thinking_level` instead. |
| `thinking_level` | `string` | **Pi only.** Explicit reasoning level (`off`/`low`/`medium`/`high`) passed to Pi for dreamer subagent runs. See `historian.thinking_level`. |
| `prompt` | `string` | Custom system prompt override. |
| `disable` | `boolean` | Set `true` to disable the dreamer agent entirely. |
| `inject_docs` | `boolean` (default `true`) | Inject ARCHITECTURE.md and STRUCTURE.md into the agent system prompt. Cached per-session and refreshed on cache-busting passes. |

### Per-task fields (`dreamer.tasks.<task>`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `schedule` | `string` | per task (below) | 5-field cron expression, or `""` to disable. |
| `model` | `string` | inherits `dreamer.model` | Per-task model override. |
| `fallback_models` | `string` or `string[]` | inherits `dreamer.fallback_models` | Per-task fallback chain. |
| `timeout_minutes` | `number` | `20` | Minutes allowed before the task is aborted. |
| `promotion_threshold` | `number` (2–20) | `3` (review-user-memories) / `2` (promote-primers) | Min recurrences before promotion. **review-user-memories** and **promote-primers** only. |

### The tasks

| Task | Default schedule | What it does |
|------|------------------|-------------|
| `map-memories` | `0 2 * * *` | Map each memory to its backing files (or mark it file-independent) so verify has a per-memory gate target. Mostly a one-time backfill, then a cheap trickle. |
| `verify` | `0 3 * * *` | Re-verify only memories whose mapped files changed since *that memory* was last checked, and fix or remove stale facts. |
| `verify-broad` | `0 4 * * 0` | Re-verify the whole file-mapped pool against code, ignoring the change gate. |
| `curate` | `0 4 * * 0` | Curate the whole active memory pool: consolidate duplicates, tighten wording, and archive low-value or redundant entries. |
| `classify-memories` | `0 6 * * *` | Score memory importance, scope, and shareability so recall stays focused. |
| `retrospective` | `0 5 * * *` | Learn from moments you had to correct or re-explain, and record the durable lesson. |
| `maintain-docs` | `""` (off) | Keep `ARCHITECTURE.md` and `STRUCTURE.md` at project root synchronized with the codebase. |
| `promote-primers` | `0 3 * * *` | Promote recurring standing questions the historian noticed into durable primers. |
| `refresh-primers` | `0 3 * * *` | Re-investigate stale primers against current code and refresh their answers. |
| `evaluate-smart-notes` | `0 3 * * *` | Surface smart notes whose `ctx_note` conditions have come true. |
| `review-user-memories` | `0 3 * * *` | Promote recurring behavioral observations into the `<user-profile>` block (privacy-sensitive). |

### Retrospective privacy

`retrospective` is default-on but cheap. It scans only new typed user messages since its last successful run; if there is no correction/re-explanation signal, it exits without a child session. On a signal, a ctx_search-only child emits XML learnings and the host validates/applies them. Project learnings become normal project memories; observation learnings are dropped unless `review-user-memories` is scheduled.

### How scheduling works

A process-wide 15-minute timer checks every task's `next_due_at` regardless of user activity, so scheduled tasks trigger even when you aren't chatting:

1. The timer evaluates each task's cron schedule and collects the tasks that are due.
2. Due tasks pass their activity gate (e.g. memory tasks only run when there are memories to maintain), then run grouped by lease domain. The memory-maintenance tasks (`map-memories`, `verify`, `verify-broad`, `curate`, `classify-memories`, `retrospective`, and the primer tasks) share the memory lease so they never collide; docs, smart notes, and user-memory review use their own domains.
3. Each task runs in its own ephemeral child session and advances its own `next_due_at`.
4. `/ctx-dream` runs every enabled task now (honoring gates); `/ctx-dream <task>` force-runs one task immediately, ignoring its gate.

A freshly-configured task first runs at its next scheduled time, not immediately on startup.

---

## `embedding`

Controls semantic search for cross-session memories.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `provider` | `"local"` \| `"openai-compatible"` \| `"off"` | `"local"` | `"local"` runs `Xenova/all-MiniLM-L6-v2` in-process. `"off"` disables semantic ranking entirely — see below. |
| `model` | `string` | `"Xenova/all-MiniLM-L6-v2"` | Embedding model. |
| `endpoint` | `string` | — | Required for `"openai-compatible"`. |
| `api_key` | `string` | — | Optional API key for remote endpoints. |

When `provider: "off"`:

- No embeddings are generated. `ctx_memory(write)` skips embedding inline and the background embedding sweep becomes a no-op.
- `ctx_search` and memory injection fall back to FTS5 (BM25) ranking only. Keyword matches still work; semantic similarity does not.
- Session-start memory injection still happens when `memory.enabled` is `true` — memories are ordered by utility tier plus `seen_count` rather than semantic similarity to the current turn.
- Memories written while `off` is active will have no embedding row; if you later re-enable `"local"` or `"openai-compatible"`, the background sweep embeds them on the next 15-minute tick.

```jsonc
{
  "embedding": {
    "provider": "openai-compatible",
    "model": "text-embedding-3-small",
    "endpoint": "https://api.openai.com/v1",
    "api_key": "{env:OPENAI_API_KEY}"
  }
}
```

> **Note:** Any string in `magic-context.jsonc` can use `{env:VAR}` to reference an environment variable, or `{file:path}` to inline the contents of an external file (matching OpenCode's own config substitution). Paths are resolved relative to the config file's directory; `~/` expands to the home directory. Use `doctor` after editing — it probes the configured embedding endpoint and reports missing env vars, wrong URLs, auth failures, or providers that don't implement the embeddings API.

> **Not every provider offers embeddings.** OpenRouter and Anthropic's public API do not expose `/embeddings`; use OpenAI, Voyage, Together, LM Studio, or the bundled `"local"` provider instead. `doctor` will flag 404/405 responses and show the actual error.

---

## `memory`

Cross-session memory settings. All memories are scoped to the current project (identified by git root commit hash, with directory-hash fallback for non-git projects).

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable cross-session memory. When `false`, the `ctx_memory` tool is hidden, no `<project-memory>` block is injected, and historian/recomp do not promote any session facts to project memories. The `ctx_search` tool stays available but its memory source returns no results. |
| `injection_budget_tokens` | `number` (500–20000) | `4000` | Token budget for memory injection into `<session-history>`. |
| `auto_promote` | `boolean` | `true` | Promote eligible session facts to project memories automatically after historian or `/ctx-recomp` runs. When `false`, historian and recomp do not write any new memories — agents can still create memories explicitly via `ctx_memory write`, and existing memories continue to be injected and searched normally. |
| `retrieval_count_promotion_threshold` | `number` | `3` | Retrievals needed before a memory is auto-promoted to permanent. |

---

## `sidekick`

Optional prompt augmenter that runs on `/ctx-aug`. Sidekick is a hidden OpenCode subagent that creates an ephemeral child session, searches memories with `ctx_memory`, and returns a focused context briefing. 
It is useful when starting a new session. It's better to choose a fast and cheap model, even small local models.

```jsonc
{
  "sidekick": {
    "enabled": true,
    "model": "github-copilot/grok-code-fast-1",
    "fallback_models": ["cerebras/qwen-3-235b-a22b-instruct-2507"],
    "timeout_ms": 30000
  }
}
```

### Agent fields

| Field | Type | Description |
|-------|------|-------------|
| `model` | `string` | Primary model. |
| `fallback_models` | `string` or `string[]` | Fallback models. |
| `temperature` | `number` (0–2) | Sampling temperature. |
| `variant` | `string` | **OpenCode only.** Agent variant — selects a thinking/reasoning preset. Pi uses `thinking_level` instead. |
| `thinking_level` | `string` | **Pi only.** Explicit reasoning level (`off`/`low`/`medium`/`high`) passed to Pi for sidekick subagent runs. See `historian.thinking_level`. |
| `prompt` | `string` | Persistent agent-level system prompt override. Applies to every sidekick run. |

### Operational fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Enable sidekick. |
| `timeout_ms` | `number` | `30000` | Timeout per run (ms). |
| `system_prompt` | `string` | — | Per-invocation system prompt prepended to the sidekick child session for this `/ctx-aug` call only. Layered on top of `prompt` if both are set. |

> **`prompt` vs `system_prompt`:** `prompt` is the persistent agent definition applied to every sidekick run. `system_prompt` is a per-call override injected into that specific child session — useful when a single `/ctx-aug` invocation needs different guidance than the default.

---

## Dreamer Sub-Features

In Dreamer v2 the former `user_memories` sub-feature block became a first-class scheduled task: **`review-user-memories`** (see the `dreamer.tasks` table above). The `doctor` command migrates a legacy `dreamer.user_memories` config to the equivalent task entry automatically, preserving your enable/disable state and tuning values. (A legacy `dreamer.pin_key_files` block is dropped — key-files pinning has moved out of Magic Context.)

- **`review-user-memories`** (was `user_memories`): set its `schedule` to enable, `""` to disable. Carries `promotion_threshold` (2–20, default 3). When scheduled, the historian extracts behavioral observations and this task promotes recurring patterns to stable user memories injected via `<user-profile>`. Privacy-sensitive — only runs when scheduled.

## History & Recall Features

> These four features graduated out of the old `experimental.*` namespace. `temporal_awareness` and `caveman_text_compression` are now top-level keys; `auto_search` and `git_commit_indexing` moved under `memory.*`. The `doctor` command relocates legacy `experimental.*` configs automatically and preserves any user-set values. **`temporal_awareness` and `memory.auto_search` are now ON by default** — set them `false` to opt out.

### `temporal_awareness`

| Key | Type | Default |
|-----|------|---------|
| `temporal_awareness` | `boolean` | `true` |

When enabled, Magic Context surfaces wall-clock time to the agent in two cache-safe ways:

1. **User-message gap markers.** Each user message is prefixed with an HTML comment like `<!-- +5m -->`, `<!-- +2h 15m -->`, or `<!-- +3d 4h -->` indicating time elapsed since the previous message's completion. Only shown when the gap exceeds 5 minutes. Derived from immutable `message.time.completed ?? message.time.created` timestamps.
2. **Compartment date ranges.** Each `<compartment>` element in `<session-history>` carries `start-date="YYYY-MM-DD"` and `end-date="YYYY-MM-DD"` attributes showing real-time boundaries.

Lets agents reason correctly about workflow pacing, log durations, build times, "how long ago" references, and session age. Without this flag the agent has no sense of time at all.

**Cache safety.** Markers are idempotent by regex detection and derive from static message timestamps — re-running the injector on any transform pass produces the same output, so enabling the flag busts cache once (on the first pass after flip) and then stays stable. Historian input is untouched.

### `memory.git_commit_indexing`

| Key | Type | Default |
|-----|------|---------|
| `memory.git_commit_indexing.enabled` | `boolean` | `false` |
| `memory.git_commit_indexing.since_days` | `number` | `365` |
| `memory.git_commit_indexing.max_commits` | `number` | `2000` |

Opt-in (default off; independent of `memory.enabled`). When enabled, Magic Context indexes HEAD git commits (skipping merges) from the project and makes them searchable through `ctx_search`. Commits are embedded using the configured embedding provider, so semantic search surfaces "when did we change the X pattern" or "why did we pick Y over Z" queries.

- **HEAD only, no merges.** Abandoned experiments on feature branches don't pollute search; merged work becomes reachable from HEAD anyway.
- **Windowed.** Only commits from the last `since_days` days are indexed (default 365). Older commits exit the window and are evicted when the project cap is exceeded.
- **Project-scoped.** Commits are stored per project identity (git root commit) so worktrees and clones share the same index.
- **Capped per project.** `max_commits` is a hard upper bound (default 2000). Oldest commits are evicted first when the cap is exceeded.
- **Non-blocking.** Initial sweep runs at startup; incremental tick runs every 15 minutes from the dream timer. The sweep skips already-indexed SHAs.
- **ctx_search integration.** Results appear as a `git_commit` source alongside `memory`, `session_fact`, and `message_history`. Each result carries the SHA, short SHA, author, and commit timestamp.

### `memory.auto_search`

| Key | Type | Default |
|-----|------|---------|
| `memory.auto_search.enabled` | `boolean` | `true` |
| `memory.auto_search.score_threshold` | `number` | `0.6` |
| `memory.auto_search.min_prompt_chars` | `number` | `20` |

On by default (independent of `memory.enabled` — it can still surface conversation/git hints with the memory store off; set `enabled: false` to opt out). Magic Context runs a background `ctx_search` on each new user message and, when a strong match is found, appends a compact "vague recall" hint to that user message. The hint surfaces highly compressed fragments from the best matches so the agent can decide whether to run `ctx_search` for the full content.

The hint looks like:

```xml
<ctx-search-hint>
Your memory may contain related context (3 related fragments):
- install.sh bunx --bun node stdin redirection
- magic-context fail closed durable storage unavailable
- commit abcd123 5d ago: install: force bun runtime in bunx invocation
Run ctx_search to retrieve full context if relevant.
</ctx-search-hint>
```

- **Memory fragments** are caveman-ultra compressed (stop words stripped, common verbs replaced) — dense keywords that mirror vague human recall.
- **Commit fragments** are the raw commit message (truncated, prefixed with `sha + relative age`) — commit messages are already compressed.
- **Session facts** use the same caveman-ultra compression as memories.

**Parameters:**

- `score_threshold`: minimum top-hit cosine score for the hint to fire (0.3–0.95, default 0.6). More permissive than direct injection because false-positive cost is small — the agent ignores irrelevant hints.
- `min_prompt_chars`: minimum user message length to trigger auto-search (default 20). Short prompts like "yes" or "ok" don't get a hint.

**Suppression rules.** The hint is not appended when:

1. `<ctx-search-hint>`, `<sidekick-augmentation>`, or `<ctx-search-auto>` is already present on the user message (avoids double-nudging when `/ctx-aug` was invoked).
2. The user message is shorter than `min_prompt_chars`.
3. No result clears the threshold.
4. An earlier pass already appended a hint for this message id (replayed verbatim on defer passes for cache safety).

**Cache safety.** The hint is appended to the current user message during the first transform pass of that turn — this message has not been cached by the provider yet because it just arrived. On subsequent defer passes the same hint text is replayed exactly (from a deterministic per-message cache), so the append is idempotent and never rewrites cached content.

**Tokens.** Hints are hard-capped at ~200 tokens (3 fragments × ~20-40 tokens each plus framing). Well under the cost of full-content injection (~500+ tokens), while still giving the agent enough signal to decide whether to search.

### `caveman_text_compression`

| Key | Type | Default |
|-----|------|---------|
| `caveman_text_compression.enabled` | `boolean` | `false` |
| `caveman_text_compression.min_chars` | `number` | `500` |

**Primary-session opt-in.** When enabled, each execute-threshold heuristic pass caveman-compresses long user and assistant text parts in primary sessions based on their position in the eligible tag window. Subagents are never caveman-compressed because their context is curated by the parent and they have no `ctx_expand` recovery path.

**Age-tier partitioning.** Eligible tags (active, message-type, outside protected tail, text part ≥ `min_chars`) are sorted oldest-first and bucketed:

| Position (oldest → newest) | Target caveman level |
|---|---|
| Oldest 20 % | **Ultra** — symbol connectives (`→`, `+`, `//`, `\|`), common-term abbreviations |
| Next 20 % | **Full** — drop articles and most auxiliaries; fragments OK |
| Next 20 % | **Lite** — drop filler and hedging; keep grammar |
| Newest 40 % | Untouched |

Tier boundaries are hardcoded to keep behavior predictable and prevent cache-busting storms from user tweaking.

**Always compressed from the original.** The pristine pre-caveman text is persisted in `source_contents` per tag. When a tag shifts deeper (lite → full → ultra), caveman compresses the ORIGINAL text at the new target depth rather than the already-cavemaned intermediate, so repeated tier shifts converge to exactly the same output as direct compression at the final depth.

**Cache safety.** Runs only on execute-threshold heuristic passes, so a cache-busting pass can materialize queued tool drops and caveman compression together. Defer passes don't run caveman, and tier assignments are persisted in `tags.caveman_depth` so the next pass re-compresses only the tags that have shifted tiers.

**Relationship to `ctx_reduce`.** Caveman compression is independent of the agent-driven `ctx_reduce` tool. `ctx_reduce` is still best for tool outputs the agent knows are spent; caveman targets old prose only, and dropped tags always win over caveman rewriting. To hide the reduce surface for a particular agent, remove or deny `ctx_reduce` in that agent's tool allow-list; Magic Context then omits `§N§` prefixes, nudges, and reduce guidance for that session.

**When to enable.** Enable if you find historian/heuristics insufficient for your workload — typically sessions with very long pasted content or verbose agent explanations that the automatic pipeline doesn't reach.

### `smart_drops`

| Key | Type | Default |
|-----|------|---------|
| `smart_drops` | `boolean` | `false` |

**Experimental, opt-in.** Content-aware reclaim of tool output that a later call has made obsolete. This is separate from agent-controlled `ctx_reduce`: smart-drops targets outputs that are dead by *supersession*, never merely because they are old:

| Class | Behavior |
|---|---|
| `todowrite` | Keep the newest snapshot, drop older ones (the live plan is re-injected every pass; older snapshots are stale). |
| `ctx_reduce` | Keep the newest 5 calls, drop older ones (preserves the visible reduce rhythm). |
| Zero-value meta (`bash_status`, `bash_kill`, `ctx_note` read/dismiss) | Drop all (worthless once the call ran; `ctx_note` write/update carry intent and are never dropped). |
| Superseded edits | When a file is edited more than once, the newest edit stays in full and each older edit is compressed to a marker that keeps its `filePath` and a short region hint of the diff, so the agent still sees which file and region it edited. This is the largest source of reclaimable bytes. |

**Cache safety.** Selection is age-independent, but smart-drops only *acts* during a transform pass that is already rewriting the message array, so it never causes a prompt-cache miss on its own. Every drop resolves to the same deterministic placeholder as an explicit drop, so defer passes replay byte-for-byte identically. **When `smart_drops` is off, the entire supersession feature is inert:** routine tool outputs are reclaimed only when the agent explicitly queues them with `ctx_reduce`, or by the emergency safety valve.

**Cross-version note.** Once you enable `smart_drops`, all binaries that share your Magic Context database (e.g. multiple OpenCode instances, or OpenCode + Pi) should be on the release that introduced it. If a stale older binary co-runs with the feature on, the worst case is a one-time cache bust (the older binary fully drops what the newer one compressed); it never corrupts data.

**When to enable.** Turn it on if you run very long, edit-heavy sessions and want to reclaim more context without losing the agent's record of what it did. The default stays off while cache stability is being validated in the wild. Requires a restart to take effect.

## Commands

| Command | Description |
|---------|-------------|
| `/ctx-status` | Show current context usage, tag counts, pending queue, nudge state, and history compression info. |
| `/ctx-flush` | Force-execute all pending operations and heuristic cleanup immediately. |
| `/ctx-recomp` | Rebuild all compartments and facts from raw session history. Resumable across restarts. |
| `/ctx-recomp <start>-<end>` | Partial rebuild of a message range (e.g. `/ctx-recomp 1-11322`). Snaps to enclosing compartment boundaries, rebuilds only those compartments using current historian rules, and leaves prior/tail compartments and all session facts untouched. Useful after upgrading historian prompt versions or model quality. Resumable across restarts; running with a different range while partial-recomp staging exists is rejected. Currently Desktop/Web-only (TUI falls back to full-recomp dialog; ranged TUI dialog is planned). |
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
  "toast_duration_ms": 12000,
  "history_budget_percentage": 0.15,
  "temporal_awareness": true,

  "historian": {
    "model": "github-copilot/gpt-5.4",
    "fallback_models": ["anthropic/claude-sonnet-4-6"]
  },

  "dreamer": {
    "model": "github-copilot/gpt-5.4",
    "fallback_models": ["anthropic/claude-sonnet-4-6"],
    "tasks": {
      "map-memories": { "schedule": "0 2 * * *" },
      "verify": { "schedule": "0 3 * * *" },
      "verify-broad": { "schedule": "0 4 * * 0" },
      "curate": { "schedule": "0 4 * * 0" },
      "classify-memories": { "schedule": "0 6 * * *" },
      "retrospective": { "schedule": "0 5 * * *" },
      "maintain-docs": { "schedule": "" },
      "promote-primers": { "schedule": "0 3 * * *", "promotion_threshold": 2 },
      "refresh-primers": { "schedule": "0 3 * * *" },
      "evaluate-smart-notes": { "schedule": "0 3 * * *" },
      "review-user-memories": { "schedule": "0 3 * * *", "promotion_threshold": 3 }
    }
  },

  "embedding": {
    "provider": "local"
  },

  "memory": {
    "enabled": true,
    "injection_budget_tokens": 4000,
    "auto_promote": true,
    "auto_search": { "enabled": true, "score_threshold": 0.6, "min_prompt_chars": 20 },
    "git_commit_indexing": { "enabled": false, "since_days": 365, "max_commits": 2000 }
  },

  "sidekick": {
    "model": "github-copilot/gpt-5.4",
    "fallback_models": ["anthropic/claude-sonnet-4-6"],
    "timeout_ms": 30000
  }
}
```
