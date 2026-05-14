# Configuration Reference

All settings are flat top-level keys in `magic-context.jsonc`. The schema is **shared between the OpenCode plugin and the Pi extension** — every setting documented here applies to both unless explicitly marked **Pi only** or **OpenCode only**.

### Key files (`dreamer.pin_key_files`)

`dreamer.pin_key_files.enabled: true` requires AFT to be registered in the active harness. OpenCode checks `~/.config/opencode/opencode.json[c]` for an AFT plugin entry; Pi checks `~/.pi/agent/settings.json` for `@cortexkit/aft-pi` in `packages` or `extensions`. If AFT is missing, key-files generation and injection soft-disable: Magic Context logs a warning, `doctor` reports the missing AFT configuration, and no `<key-files>` block is emitted.

Key files are project-scoped in SQLite. `project_key_files` stores one row per file, with LLM-stitched content and a plugin-computed `content_hash`; `project_key_files_version` stores the per-project version counter used to invalidate per-session prompt caches after Dreamer commits.

### Configuration locations

**OpenCode** reads (in priority order, project overrides user):

| Path | Scope |
|---|---|
| `<project>/magic-context.jsonc` | Project root |
| `<project>/.opencode/magic-context.jsonc` | Project, alternate location |
| `~/.config/opencode/magic-context.jsonc` | User-wide defaults |

**Pi** reads (in priority order, project overrides user):

| Path | Scope |
|---|---|
| `<project>/.pi/magic-context.jsonc` | Project root |
| `~/.pi/agent/magic-context.jsonc` | User-wide defaults |

Project config always merges on top of user config in both harnesses. The unified setup wizard (`npx @cortexkit/magic-context@latest setup`) auto-detects which harnesses you have installed and writes the user-level file for each with sensible defaults; pass `--harness opencode` or `--harness pi` to target one.

### Cross-harness scoping

Both plugins write to the same SQLite database at `~/.local/share/cortexkit/magic-context/context.db`. Tables are scoped by:

- `harness` column (`'opencode'` or `'pi'`) for **session-scoped** data — tags, compartments, session facts, notes
- `project_path` (resolved git root) for **project-scoped** data — memories, embeddings, dreamer runs, key-file pins, smart notes

So memories you write in OpenCode appear in Pi sessions for the same project (and vice versa), while per-session compartments and tags stay correctly attributed to their originating harness.

For semantic search to work cross-harness, both plugins **must use the same embedding model**. Magic Context detects mismatch on startup and logs a warning; the easiest fix is to keep the `embedding` block identical in both config files.

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

### Electron native-binding cache

When OpenCode Desktop (Electron) loads Magic Context for the first time, the plugin downloads an Electron-compatible `better-sqlite3` binary (~1 MB) from the upstream `WiseLibs/better-sqlite3` GitHub release and caches it under `~/.cache/cortexkit/native-bindings/`.

This is needed because `better-sqlite3`'s shipped npm prebuilds target Node's `NODE_MODULE_VERSION` (137 for Node 22), but Electron 41 uses ABI 145 — so the bundled `.node` file is rejected with "compiled against a different Node.js version". The cache is keyed by `<pkgVersion>/electron-v<abi>-<platform>-<arch>` and self-heals across Electron upgrades. The OpenCode TUI (Bun) and Pi (Node CLI) paths are unaffected.

**First-launch network requirement.** If GitHub is unreachable on the very first Electron Desktop launch (corp firewall, offline laptop), Magic Context will fail closed and disable itself for that run, with a clear log message. After one successful launch the cache is populated and offline use is fine. `doctor --force` clears the cache to force a re-fetch on the next launch.

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
| `ctx_reduce_enabled` | `boolean` | `true` | When `false`, hides `ctx_reduce` tool, disables all nudges/reminders, and strips reduction guidance from prompts. Heuristic cleanup, compartments, memory, and search still work. Useful for testing whether automatic cleanup alone is sufficient. |
| `cache_ttl` | `string` or `object` | `"5m"` | Time after a response before applying pending ops. String or per-model map. |
| `protected_tags` | `number` (1–100) | `20` | Last N active tags immune from immediate dropping. |
| `nudge_interval_tokens` | `number` | `10000` | Minimum token growth between rolling nudges. |
| `execute_threshold_percentage` | `number` (20–80) or `object` | `65` | Context usage that forces queued ops to execute. Capped at 80% max for cache safety. Supports per-model map. |
| `execute_threshold_tokens` | `object` (per-model map) | — | **Optional absolute-tokens variant of `execute_threshold_percentage`.** Per-model map (e.g. `{ "default": 150000, "github-copilot/gpt-5.2-codex": 40000 }`). When set for a model, overrides the percentage-based threshold for that model. Clamped to `80% × context_limit` with a warn log. Requires a resolvable context limit — falls through to percentage if unavailable. See below. |
| `auto_drop_tool_age` | `number` | `100` | Auto-drop tool outputs older than N tags during execution. |
| `drop_tool_structure` | `boolean` | `true` | When `true`, dropped tool parts are fully removed from the transformed prompt. When `false`, tool call structure is preserved: tool name kept, tool inputs truncated to 5 chars + `...[truncated]`, tool output replaced with `[truncated]`. Preserving structure keeps the agent aware that prior tools ran (preventing hallucinated re-calls) at the cost of ~4K additional tokens per ~60 dropped tools. |
| `clear_reasoning_age` | `number` | `50` | Clear thinking/reasoning blocks older than N tags. |
| `iteration_nudge_threshold` | `number` | `15` | Consecutive assistant turns without user input before an iteration nudge. |
| `historian_timeout_ms` | `number` | `300000` | Timeout per historian call (ms). |
| `history_budget_percentage` | `number` (0.05–0.5) | `0.15` | Fraction of usable context (`context_limit × execute_threshold`) reserved for the history block. Triggers compression when exceeded. |
| `compaction_markers` | `boolean` | `true` | Inject compaction boundaries into OpenCode's DB after historian publishes. Reduces transform input size for long sessions. |
| `commit_cluster_trigger` | `object` | See below | Controls the commit-cluster historian trigger. |
| `compressor` | `object` | See below | Controls the background compressor that merges older compartments when the history block exceeds its budget. |

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

### `compressor`

Compressor is a background pass that runs when the rendered `<session-history>` block exceeds its budget. It merges older compartments using progressively aggressive **caveman-style** compression at each depth level, enforcing style consistency via a deterministic post-process after the historian LLM call. Each compartment range can be compressed at most `max_merge_depth` times.

**Depth tiers** (applied progressively as compartments are re-compressed):

| Depth | Style | What happens |
|---|---|---|
| 1 | **Merge only** | Preserve narrative and all U: lines. Drop only duplicates spanning compartments. |
| 2 | **Lite caveman** | Drop filler words (just, really, basically) and hedging. Keep grammar. |
| 3 | **Full caveman** | Drop articles (the, a, an), weak auxiliaries. Fragments OK. Single paragraph per compartment. |
| 4 | **Ultra caveman** | Telegraphic. Symbol connectives (`→`, `+`, `//`, `\|`). Pattern: `[thing] [action] [reason]`. |
| 5 | **Title-only collapse** | Content cleared (no LLM call). Raw messages recoverable via `ctx_expand`. |

Inspired by the [caveman Claude Code skill](https://github.com/JuliusBrussee/caveman) which validated telegraph-style compression as LLM-friendly (and saves tokens without tokenizer fallback issues that character-dropping causes).

```jsonc
{
  "compressor": {
    "enabled": true,                  // default: true
    "min_compartment_ratio": 1000,     // default: 1000 (floor = ceil(total_raw_messages / ratio))
    "max_merge_depth": 5,             // default: 5 (1-5, deeper = more aggressive)
    "cooldown_ms": 600000,            // default: 600000 (10 min between background runs)
    "max_compartments_per_pass": 15,  // default: 15 (LLM batch cap)
    "grace_compartments": 10          // default: 10 (newest N compartments never compressed)
  }
}
```

**Merge ratios per depth** (applied per LLM pass — small ratios preserve more narrative):

| Depth transition | Ratio | Shape |
|---|---|---|
| 0 → 1 | 1.33× (4:3) | Narrative merge; preserve all `U:` lines |
| 1 → 2 | 1.5× (3:2) | Drop filler, keep grammar (caveman-lite) |
| 2 → 3 | 2× (2:1) | Paragraph, fragments OK (caveman-full) |
| 3 → 4 | 2× (2:1) | Telegraph + symbol connectives (caveman-ultra) |
| 4 → 5 | — | Title-only collapse (no LLM, recoverable via `ctx_expand`) |

**Selection strategy:** The compressor picks the oldest contiguous run of compartments that share the SAME rounded compression depth (up to `max_compartments_per_pass`). This progresses naturally: depth-0 bands get compressed first → depth-1 bands compressed next → and so on. Each run goes through one LLM call.

**Floor protection:** The compressor never reduces your session's compartment count below `ceil(total_raw_messages / min_compartment_ratio)`. For a 20K-message session with the default ratio, that's a floor of 20 compartments.

**Grace period:** The newest `grace_compartments` compartments are always excluded from compression. This protects freshly-published historian output from being re-compressed before it has been used. Default is 10, which works well even for long autonomous runs that publish many compartments per hour.

**Ordinal snap:** When the LLM drifts by ±1-2 ordinals on merged boundaries (e.g. outputs `start=8161` when the actual input boundary is `8160`), the runtime snaps those values to the enclosing input compartment's canonical boundary rather than rejecting the whole pass. Snaps are logged for observability.

**Disable entirely:** Set `compressor.enabled: false` to skip all background compression. Older sessions will simply carry a larger history footprint.


| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable commit-cluster based historian triggering. |
| `min_clusters` | `number` | `3` | Minimum number of commit clusters in the unsummarized tail before historian fires. The tail must also contain at least one `trigger_budget` worth of tokens, where `trigger_budget = main_context × execute_threshold × 5%` clamped to `[5K, 50K]`. |

Set `enabled: false` to disable this trigger entirely and rely only on pressure-based and tail-size triggers for historian.

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

Each agent has a built-in fallback chain tried in order when no model is explicitly configured. If you have a GitHub Copilot subscription, Copilot-routed models are preferred for historian and dreamer since they use request-based pricing — ideal for single-prompt background work.

| Agent | Fallback Chain (first available wins) |
|-------|---------------------------------------|
| **Historian** | `github-copilot/claude-sonnet-4-6` → `anthropic/claude-sonnet-4-6` → `opencode-go/minimax-m2.7` → `zai-coding-plan/glm-5` → `openai/gpt-5.4` → `google/gemini-3.1-pro` |
| **Dreamer** | `github-copilot/claude-sonnet-4-6` → `anthropic/claude-sonnet-4-6` → `google/gemini-3-flash` → `zai-coding-plan/glm-5` → `opencode-go/minimax-m2.7` → `openai/gpt-5.4-mini` |
| **Sidekick** | `cerebras/qwen-3-235b-a22b-instruct-2507` → `opencode/gpt-5-nano` → `google/gemini-3-flash` → `openai/gpt-5.4-mini` |

Setting `model` in any agent config overrides the fallback chain entirely. Setting `fallback_models` replaces the built-in chain with your custom list.

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
| `two_pass` | `boolean` | Default `false`. When `true`, runs a second editor pass after each successful historian output. The editor (a separate hidden `historian-editor` agent using the same fallback chain) re-reads the draft and removes low-signal `U:` lines, redundant paraphrases, and cross-compartment duplicates, producing cleaner narrative-first summaries. Falls back to the draft if the editor call or its validation fails, so it can never regress behavior. Adds one extra historian-scale call per compartment publication. Recommended for non-reasoning models and open-weight local models where the single-pass draft is noisier. For models with extended thinking/reasoning enabled in OpenCode (Claude 4+, GPT-5.x reasoning variants), the single-pass output is usually already clean and `two_pass` can stay `false`. |

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
| `variant` | `string` | **OpenCode only.** Agent variant — selects a thinking/reasoning preset. Pi uses `thinking_level` instead. |
| `thinking_level` | `string` | **Pi only.** Explicit reasoning level (`off`/`low`/`medium`/`high`) passed to Pi for dreamer subagent runs. See `historian.thinking_level`. |
| `prompt` | `string` | Custom system prompt override. |

### Operational fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Enable scheduled dreaming. |
| `schedule` | `string` | `"02:00-06:00"` | Time window for overnight runs (24h, supports overnight like `"23:00-05:00"`). |
| `max_runtime_minutes` | `number` | `120` | Max total runtime per dream session. |
| `task_timeout_minutes` | `number` | `20` | Minutes allocated per individual task. |
| `tasks` | `string[]` | `["consolidate", "verify", "archive-stale", "improve"]` | Tasks to run, in order. |
| `inject_docs` | `boolean` | `true` | Inject ARCHITECTURE.md and STRUCTURE.md into the agent system prompt. Content is cached per-session and refreshed on cache-busting passes. |

### Available tasks

| Task | What it does |
|------|-------------|
| `consolidate` | Find semantically duplicate memories and merge each cluster into one canonical fact. |
| `verify` | Check CONFIG_DEFAULTS, ARCHITECTURE_DECISIONS, and ENVIRONMENT memories against actual code. |
| `archive-stale` | Archive memories that reference removed features, old paths, or discontinued workflows. |
| `improve` | Rewrite verbose or narrative memories into terse operational statements. |
| `maintain-docs` | Keep `ARCHITECTURE.md` and `STRUCTURE.md` at project root synchronized with the codebase. |

### How scheduling works

An independent 15-minute timer checks the schedule regardless of user activity, so overnight dreaming triggers even when the user isn't chatting. When the current time falls inside the configured window:

1. The scheduler scans the memory store for projects with activity since the last dream.
2. Eligible projects are enqueued into a SQLite-backed dream queue.
3. The queue consumer processes one project at a time, creating a child session per task.
4. `/ctx-dream` also uses the same queue — it enqueues the current project and immediately processes.

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

Two sub-features used to live under `experimental` and graduated to `dreamer.*` in v0.14. The `doctor` command migrates existing configs automatically and preserves any user-set `enabled` state.

### `dreamer.user_memories`

| Key | Type | Default |
|-----|------|---------|
| `dreamer.user_memories.enabled` | `boolean` | `true` |
| `dreamer.user_memories.promotion_threshold` | `number` | `3` |

When enabled, historian extracts behavioral observations about the user alongside compartments. These are stored as candidates and reviewed by dreamer during scheduled runs. Recurring patterns that appear across multiple historian runs are promoted to stable user memories, injected into all sessions via `<user-profile>` in the system prompt.

**Requires dreamer to be enabled.** Without dreamer, candidates accumulate but are never promoted to stable memories. The `doctor` command warns about this misconfiguration.

- `promotion_threshold`: minimum number of semantically similar candidate observations before dreamer considers promoting to a stable memory (2–20, default 3).

### `dreamer.pin_key_files`

| Key | Type | Default |
|-----|------|---------|
| `dreamer.pin_key_files.enabled` | `boolean` | `false` |
| `dreamer.pin_key_files.token_budget` | `number` | `10000` |
| `dreamer.pin_key_files.min_reads` | `number` | `4` |

When enabled, dreamer analyzes which files each session's agent reads most frequently (full reads only, not partial line ranges). Core orientation files — architecture, config, types — that are repeatedly re-read after context drops are pinned into the system prompt as a `<key-files>` block. Files are read fresh from disk on each cache-busting pass.

**Requires dreamer to be enabled.** Without dreamer, no key files are identified. The dreamer runs the analysis as a post-task step, inspecting all active non-subagent sessions for the project.

- `token_budget`: maximum total tokens for all pinned files combined (2000–30000, default 10000). Files are selected by a knapsack solver to fit within this budget.
- `min_reads`: minimum number of full-file reads before a file is considered for pinning (2–20, default 4). Lower values are more aggressive but risk pinning task-specific files.

## Experimental Features

### `experimental.temporal_awareness`

| Key | Type | Default |
|-----|------|---------|
| `experimental.temporal_awareness` | `boolean` | `false` |

When enabled, Magic Context surfaces wall-clock time to the agent in two cache-safe ways:

1. **User-message gap markers.** Each user message is prefixed with an HTML comment like `<!-- +5m -->`, `<!-- +2h 15m -->`, or `<!-- +3d 4h -->` indicating time elapsed since the previous message's completion. Only shown when the gap exceeds 5 minutes. Derived from immutable `message.time.completed ?? message.time.created` timestamps.
2. **Compartment date ranges.** Each `<compartment>` element in `<session-history>` carries `start-date="YYYY-MM-DD"` and `end-date="YYYY-MM-DD"` attributes showing real-time boundaries.

Lets agents reason correctly about workflow pacing, log durations, build times, "how long ago" references, and session age. Without this flag the agent has no sense of time at all.

**Cache safety.** Markers are idempotent by regex detection and derive from static message timestamps — re-running the injector on any transform pass produces the same output, so enabling the flag busts cache once (on the first pass after flip) and then stays stable. Historian input is untouched.

### `experimental.git_commit_indexing`

| Key | Type | Default |
|-----|------|---------|
| `experimental.git_commit_indexing.enabled` | `boolean` | `false` |
| `experimental.git_commit_indexing.since_days` | `number` | `365` |
| `experimental.git_commit_indexing.max_commits` | `number` | `2000` |

When enabled, Magic Context indexes HEAD git commits (skipping merges) from the project and makes them searchable through `ctx_search`. Commits are embedded using the configured embedding provider, so semantic search surfaces "when did we change the X pattern" or "why did we pick Y over Z" queries.

- **HEAD only, no merges.** Abandoned experiments on feature branches don't pollute search; merged work becomes reachable from HEAD anyway.
- **Windowed.** Only commits from the last `since_days` days are indexed (default 365). Older commits exit the window and are evicted when the project cap is exceeded.
- **Project-scoped.** Commits are stored per project identity (git root commit) so worktrees and clones share the same index.
- **Capped per project.** `max_commits` is a hard upper bound (default 2000). Oldest commits are evicted first when the cap is exceeded.
- **Non-blocking.** Initial sweep runs at startup; incremental tick runs every 15 minutes from the dream timer. The sweep skips already-indexed SHAs.
- **ctx_search integration.** Results appear as a `git_commit` source alongside `memory`, `session_fact`, and `message_history`. Each result carries the SHA, short SHA, author, and commit timestamp.

### `experimental.auto_search`

| Key | Type | Default |
|-----|------|---------|
| `experimental.auto_search.enabled` | `boolean` | `false` |
| `experimental.auto_search.score_threshold` | `number` | `0.55` |
| `experimental.auto_search.min_prompt_chars` | `number` | `20` |

When enabled, Magic Context runs a background `ctx_search` on each new user message and, when a strong match is found, appends a compact "vague recall" hint to that user message. The hint surfaces highly compressed fragments from the best matches so the agent can decide whether to run `ctx_search` for the full content.

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

- `score_threshold`: minimum top-hit cosine score for the hint to fire (0.3–0.95, default 0.55). More permissive than direct injection because false-positive cost is small — the agent ignores irrelevant hints. Lowered from 0.65 → 0.55 in v0.14 after the v0.14 visible-memory hard filter removed the biggest noise source.
- `min_prompt_chars`: minimum user message length to trigger auto-search (default 20). Short prompts like "yes" or "ok" don't get a hint.

**Suppression rules.** The hint is not appended when:

1. `<ctx-search-hint>`, `<sidekick-augmentation>`, or `<ctx-search-auto>` is already present on the user message (avoids double-nudging when `/ctx-aug` was invoked).
2. The user message is shorter than `min_prompt_chars`.
3. No result clears the threshold.
4. An earlier pass already appended a hint for this message id (replayed verbatim on defer passes for cache safety).

**Cache safety.** The hint is appended to the current user message during the first transform pass of that turn — this message has not been cached by the provider yet because it just arrived. On subsequent defer passes the same hint text is replayed exactly (from a deterministic per-message cache), so the append is idempotent and never rewrites cached content.

**Tokens.** Hints are hard-capped at ~200 tokens (3 fragments × ~20-40 tokens each plus framing). Well under the cost of full-content injection (~500+ tokens), while still giving the agent enough signal to decide whether to search.

### `experimental.caveman_text_compression`

| Key | Type | Default |
|-----|------|---------|
| `experimental.caveman_text_compression.enabled` | `boolean` | `false` |
| `experimental.caveman_text_compression.min_chars` | `number` | `500` |

**Only active when `ctx_reduce_enabled: false`.** This is the opt-in successor to agent-driven text dropping for users who run without the `ctx_reduce` tool. When the flag is on, each execute-threshold heuristic pass caveman-compresses long user and assistant text parts in place based on their position in the eligible tag window.

**Age-tier partitioning.** Eligible tags (active, message-type, outside protected tail, text part ≥ `min_chars`) are sorted oldest-first and bucketed:

| Position (oldest → newest) | Target caveman level |
|---|---|
| Oldest 20 % | **Ultra** — symbol connectives (`→`, `+`, `//`, `\|`), common-term abbreviations |
| Next 20 % | **Full** — drop articles and most auxiliaries; fragments OK |
| Next 20 % | **Lite** — drop filler and hedging; keep grammar |
| Newest 40 % | Untouched |

Tier boundaries are hardcoded to keep behavior predictable and prevent cache-busting storms from user tweaking.

**Always compressed from the original.** The pristine pre-caveman text is persisted in `source_contents` per tag. When a tag shifts deeper (lite → full → ultra), caveman compresses the ORIGINAL text at the new target depth rather than the already-cavemaned intermediate, so repeated tier shifts converge to exactly the same output as direct compression at the final depth.

**Cache safety.** Runs only on execute-threshold heuristic passes (same gate as automatic tool drops), so the single cache-busting pass materializes both tool drops and caveman compression together. Defer passes don't run caveman, and tier assignments are persisted in `tags.caveman_depth` so the next pass re-compresses only the tags that have shifted tiers.

**What it replaces.** With `ctx_reduce` on, agents can manually drop user/assistant text parts when they judge the content is no longer needed. With `ctx_reduce: false`, agents can't do that — this heuristic fills the gap by automatically aging long text toward ever-denser caveman compression. Tool drops and reasoning clearing still handle their own content regardless.

**When to enable.** Enable alongside `ctx_reduce_enabled: false` if you find historian/heuristics insufficient for your workload — typically sessions with very long pasted content or verbose agent explanations that the automatic pipeline doesn't reach. Leaves `ctx_reduce_enabled: true` sessions untouched.

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
  "auto_drop_tool_age": 50,
  "drop_tool_structure": true,
  "history_budget_percentage": 0.15,
  "compaction_markers": true,
  "compressor": {
    "enabled": true,
    "min_compartment_ratio": 1000,
    "max_merge_depth": 5,
    "cooldown_ms": 600000
  },

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
    "model": "github-copilot/gpt-5.4",
    "fallback_models": ["anthropic/claude-sonnet-4-6"],
    "timeout_ms": 30000
  },

  "experimental": {
    "user_memories": {
      "enabled": false,
      "promotion_threshold": 3
    },
    "pin_key_files": {
      "enabled": false,
      "token_budget": 10000,
      "min_reads": 4
    }
  }
}
```
