---
title: Configuration
description: Every magic-context.jsonc key, with types, defaults, and where to put the file.
---

<!-- GENERATED FILE — do not edit. Source of truth is the Zod schema in
    packages/plugin/src/config/schema/magic-context.ts; regenerate with
    `bun packages/plugin/scripts/build-config-docs.ts`. -->

Magic Context reads `magic-context.jsonc` (or `.json`) from one shared CortexKit location, the same for both harnesses. Project config overrides user config, key by key.

- **Project** — `<project>/.cortexkit/magic-context.jsonc`
- **User-wide** — `~/.config/cortexkit/magic-context.jsonc`

Upgrading from an earlier version moves your existing config here automatically on first run (a `.MOVED_READPLEASE` breadcrumb is left at the old per-harness path).

Add the schema line for editor validation and autocomplete:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/cortexkit/magic-context/master/assets/magic-context.schema.json"
}
```

:::note
Project-level configs cannot use `{env:VAR}` / `{file:path}` expansion. A cloned repository also cannot set `sqlite.*`, hidden-agent prompts/permissions, `historian.model`, or `historian.fallback_models`. Project `execute_threshold_percentage` / `execute_threshold_tokens` may only RAISE thresholds relative to the user's effective settings (a repo may delay compaction, not make it happen earlier). Dreamer model/schedule/task tuning and `memory.enabled` remain allowed project overrides.
:::

## Top-level switches

Global on/off switches for the plugin and its agent-facing surface.

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Enable magic context (default: true) |
| `language` | string | — | Output language for Magic Context's generated content and guidance, as a 2-letter ISO 639-1 code (e.g. "tr", "es", "de", "ja", "pt"). When set, the historian, dreamer, sidekick, and the agent-guidance block instruct the model to write its PROSE in this language while keeping all structural tokens (XML tags, the five memory category names, code identifiers, file paths) in English. USER-LEVEL ONLY (ignored in project config for security). Unset = today's behavior (model mirrors the conversation; English scaffolding). Changing it triggers one cache re-materialization; existing compartments/memories keep their original language until naturally rewritten. |
| `auto_update` | boolean | — | Enable automatic npm self-update checks for the OpenCode plugin. Security: USER-only in config loader, so hostile project configs cannot suppress updates. |
| `keep_subagents` | boolean | `false` | Debug: keep the child sessions Magic Context spawns for its own subagents (historian, dreamer, sidekick, memory-migration) instead of deleting them on success. Useful for short-term inspection/data collection — their full transcript (prompt, tool calls, token usage, output) stays in the host session store. Kept sessions accumulate until manually cleared; leave false for normal use. Requires a restart to take effect. |
| `todowrite` | object | — | Pi-only todowrite tool and overlay controls. Pi registers tools and widgets at extension boot, so changing this after /cd requires /reload or restart. |
| `todowrite.enabled` | boolean | `true` | Pi only: register Magic Context's todowrite task-list tool. Disable if you use your own todo extension. OpenCode ships its own built-in todowrite; this setting has no effect there. |
| `todowrite.overlay` | boolean | `true` | Pi only: show the persistent todo overlay above the editor while tasks are active. |

## Context management

When and how aggressively Magic Context manages the session's context window. Per-model keys accept `provider/model` map form where noted.

| Key | Type | Default | Description |
|---|---|---|---|
| `cache_ttl` | string \\| map<string, string> | `"5m"` | Cache TTL: string (e.g. "5m", "1h", "30s") or per-model object ({ default: "5m", "model-id": "10m" }). Set to "never" for lanes kept warm by an external keepwarm proxy — disables the idle-TTL heuristic so MC never initiates a rebuild based on elapsed time. |
| `execute_threshold_percentage` | number (20–80) \\| map<string, number (20–80)> | `65` | Context percentage that forces queued operations to execute. Number or per-model object ({ default: 65, "provider/model": 45 }). Values above 80 are rejected because the runtime caps at 80% for cache safety (MAX_EXECUTE_THRESHOLD). Default: DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE |
| `execute_threshold_tokens` | object | — | Absolute token thresholds per model. When matched, overrides execute_threshold_percentage for that model. Accepts `default` for all models or per-model keys. Values above 80% × context_limit are clamped with a warning log. Min 5_000, max 2_000_000. |
| `execute_threshold_tokens.default` | number (5000–2000000) | — |  |
| `protected_tags` | number (1–100) | — | Number of recent tags to protect from dropping (min: 1, max: 100, default: 20) |
| `clear_reasoning_age` | number (10–) | `50` | Clear reasoning/thinking blocks older than N tags (default: 50) |
| `history_budget_percentage` | number (0.05–0.5) | `0.15` | Fraction of usable context (context_limit × execute_threshold) reserved for the session history block (default: 0.15) |

## Historian

The background agent that condenses old conversation into compact history.

| Key | Type | Default | Description |
|---|---|---|---|
| `historian` | object | — | Historian agent configuration (model, fallback_models, variant, temperature, maxTokens, permission, two_pass, etc.) |
| `historian.model` | string | — | Primary model ID (e.g. 'claude-sonnet-4-6') |
| `historian.temperature` | number (0–2) | — | Sampling temperature (0-2) |
| `historian.top_p` | number (0–1) | — | Nucleus sampling top_p (0-1) |
| `historian.prompt` | string | — | Additional system prompt text |
| `historian.tools` | map<string, boolean> | — | Tool enable/disable overrides |
| `historian.disable` | boolean | — | Disable this agent |
| `historian.description` | string | — | Agent description |
| `historian.mode` | `"subagent"` \\| `"primary"` \\| `"all"` | — | Agent mode (subagent, primary, or all) |
| `historian.color` | string | — | Hex color for the agent (e.g. '#a1b2c3') |
| `historian.maxSteps` | number | — | Maximum tool-call steps per invocation |
| `historian.permission` | object | — | Per-tool permission overrides |
| `historian.permission.edit` | `"ask"` \\| `"allow"` \\| `"deny"` | — |  |
| `historian.permission.bash` | `"ask"` \\| `"allow"` \\| `"deny"` \\| map<string, `"ask"` \\| `"allow"` \\| `"deny"`> | — |  |
| `historian.permission.webfetch` | `"ask"` \\| `"allow"` \\| `"deny"` | — |  |
| `historian.permission.doom_loop` | `"ask"` \\| `"allow"` \\| `"deny"` | — |  |
| `historian.permission.external_directory` | `"ask"` \\| `"allow"` \\| `"deny"` | — |  |
| `historian.maxTokens` | number | — | Maximum output tokens |
| `historian.variant` | string | — | OpenCode reasoning variant (e.g. for extended thinking) |
| `historian.fallback_models` | string \\| string[] | — | Fallback model IDs if primary is unavailable |
| `historian.two_pass` | boolean | `false` | Run a second editor pass over historian output to clean low-signal U: lines and cross-compartment duplicates. Adds ~1 extra API call and ~1.3x cost per historian run. Useful for models without extended thinking support. (default: false) |
| `historian.thinking_level` | `"off"` \\| `"minimal"` \\| `"low"` \\| `"medium"` \\| `"high"` \\| `"xhigh"` \\| `"max"` | — | Pi only: explicit thinking level passed as --thinking <level> to Pi historian subagent invocations. Required when using reasoning models (e.g. github-copilot/gpt-5.4) because Pi's default thinking-level resolution can pick a value the provider rejects. OpenCode users set variant instead. Valid: off \| minimal \| low \| medium \| high \| xhigh \| max |
| `historian.disallowed_tools` | `"*"` \\| `"read"` \\| `"aft_outline"` \\| `"aft_zoom"` \\| `"aft_search"`[] | `[]` | OpenCode only. Tools to REMOVE from the historian's default allow-list [read, aft_outline, aft_zoom, aft_search]. Applies to both historian and historian-editor agents. Use ["*"] to strip all tool definitions from the model request — this prevents weak instruction-following models (e.g. mistral-small-latest) from entering tool-calling loops. Individual tool names remove just that tool. Note: a user-supplied historian.permission override can re-allow a tool that disallowed_tools removed — disallowed_tools sets the baseline, permission overrides take precedence. (default: []) |
| `historian_timeout_ms` | number (60000–) | `300000` | Timeout for each historian prompt call in milliseconds (default: 300000) |
| `commit_cluster_trigger` | object | — | Commit-cluster trigger: fire historian when enough commit clusters accumulate in the unsummarized tail |
| `commit_cluster_trigger.enabled` | boolean | `true` | Enable commit-cluster based historian triggering (default: true) |
| `commit_cluster_trigger.min_clusters` | number (1–) | `3` | Minimum commit clusters required to trigger historian (min: 1, default: 3) |

## Memory & recall

Durable project memory, semantic search, and recall features.

| Key | Type | Default | Description |
|---|---|---|---|
| `memory` | object | — | Cross-session memory configuration |
| `memory.enabled` | boolean | `true` | Enable cross-session memory (default: true) |
| `memory.injection_budget_tokens` | number (500–20000) | `4000` | Token budget for memory injection on session start (min: 500, max: 20000, default: 4000) |
| `memory.auto_promote` | boolean | `true` | Automatically promote eligible session facts into memory (default: true) |
| `memory.retrieval_count_promotion_threshold` | number (1–) | `3` | retrieval_count threshold for promoting memory to permanent status (min: 1, default: 3) |
| `memory.auto_search` | object | — | Auto-search hint: transform-time ctx_search on each new user message; when the top hit clears the threshold, append a compact <ctx-search-hint> block of vague fragments to that user message. Does NOT inject full content. Graduated from experimental.auto_search; enabled by default (set enabled: false to opt out). Independent of memory.enabled. |
| `memory.auto_search.enabled` | boolean | `true` | Automatically append a compact <ctx-search-hint> to eligible user messages when relevant memories, conversation, or commits are found. Graduated from experimental.auto_search; on by default (set false to opt out). Independent of memory.enabled. |
| `memory.auto_search.score_threshold` | number (0.3–0.95) | `0.6` | Top hit score must exceed this threshold for the hint to fire (min: 0.3, max: 0.95, default: 0.60) |
| `memory.auto_search.min_prompt_chars` | number (5–500) | `20` | Skip hint when user message is shorter than this (min: 5, max: 500, default: 20) |
| `memory.git_commit_indexing` | object | — | Index git commit messages from HEAD into ctx_search. Commits become a 4th searchable source alongside memories and session history. Graduated from experimental.git_commit_indexing; opt-in, default off (per-project embedding cost). Independent of memory.enabled. |
| `memory.git_commit_indexing.enabled` | boolean | `false` | Index HEAD git commits for ctx_search (git_commit source). Graduated from experimental.git_commit_indexing; opt-in, default off. Independent of memory.enabled. |
| `memory.git_commit_indexing.since_days` | number (7–3650) | `365` | Days of HEAD history to index (min: 7, max: 3650, default: 365) |
| `memory.git_commit_indexing.max_commits` | number (100–20000) | `2000` | Max commits kept per project; oldest evicted (min: 100, max: 20000, default: 2000) |
| `embedding` | object | — | Embedding provider configuration |
| `embedding.provider` | `"local"` \\| `"openai-compatible"` \\| `"off"` \\| `"synapse"` | `"local"` | Embedding provider. 'local' uses Xenova/all-MiniLM-L6-v2, 'openai-compatible' requires endpoint and model, 'synapse' uses the certified local Synapse lane with an explicit fallback provider, and 'off' disables embeddings. |
| `embedding.fallback_provider` | `"local"` \\| `"openai-compatible"` \\| `"off"` | — | Fallback provider for the Synapse lane. Required when provider is 'synapse'; local, openai-compatible, and off are valid. |
| `embedding.model` | string | — | Embedding model name. Required for openai-compatible, ignored for local. |
| `embedding.endpoint` | string | — | API endpoint URL. Required when provider is openai-compatible. |
| `embedding.api_key` | string | — | API key for remote embedding provider (optional) |
| `embedding.input_type` | string | — | Default input_type for stored/indexed (passage) embeddings in the request body. Required by some openai-compatible providers (e.g. NVIDIA NIM). Omitted from the request when unset. |
| `embedding.query_input_type` | string | — | Optional input_type for query (search) embeddings on asymmetric models (e.g. NVIDIA NIM 'query'). When unset, query embeddings use embedding.input_type. Passage/stored content always uses embedding.input_type. |
| `embedding.truncate` | string | — | Optional truncate mode sent in the embedding request body (e.g. NVIDIA NIM accepts 'NONE' \| 'START' \| 'END'). Omitted from the request when unset. |
| `embedding.max_input_tokens` | integer (–9007199254740991) | — | Optional maximum input tokens for chunk embeddings. Defaults conservatively to 512 when omitted. |
| `embedding.local_dtype` | `"auto"` \\| `"fp32"` \\| `"fp16"` \\| `"q8"` \\| `"int8"` \\| `"uint8"` \\| `"q4"` \\| `"bnb4"` \\| `"q4f16"` \\| `"q2"` \\| `"q2f16"` \\| `"q1"` \\| `"q1f16"` | — | Local provider only: ONNX model dtype passed to the transformers.js feature-extraction pipeline. Accepts the @huggingface/transformers DataType strings (auto, fp32, fp16, q8, int8, uint8, q4, bnb4, q4f16, q2, q2f16, q1, q1f16). Omitted keeps today's behavior (fp32). A non-default value changes the produced vectors and folds into the embedding model identity, so switching dtype re-embeds rather than mixing vector spaces. Useful for selecting a quantized variant (e.g. q8) of a larger multilingual model to cut memory and CPU cost; see issue #259. |

## Background agents

Off-hours maintenance (Dreamer) and on-demand prompt augmentation (Sidekick).

| Key | Type | Default | Description |
|---|---|---|---|
| `dreamer` | object | — | Dreamer agent + scheduling configuration (model, fallback_models, disable, schedule, tasks, etc.) |
| `dreamer.model` | string | — | Primary model ID (e.g. 'claude-sonnet-4-6') |
| `dreamer.temperature` | number (0–2) | — | Sampling temperature (0-2) |
| `dreamer.top_p` | number (0–1) | — | Nucleus sampling top_p (0-1) |
| `dreamer.prompt` | string | — | Additional system prompt text |
| `dreamer.tools` | map<string, boolean> | — | Tool enable/disable overrides |
| `dreamer.disable` | boolean | — | Disable this agent |
| `dreamer.description` | string | — | Agent description |
| `dreamer.mode` | `"subagent"` \\| `"primary"` \\| `"all"` | — | Agent mode (subagent, primary, or all) |
| `dreamer.color` | string | — | Hex color for the agent (e.g. '#a1b2c3') |
| `dreamer.maxSteps` | number | — | Maximum tool-call steps per invocation |
| `dreamer.permission` | object | — | Per-tool permission overrides |
| `dreamer.permission.edit` | `"ask"` \\| `"allow"` \\| `"deny"` | — |  |
| `dreamer.permission.bash` | `"ask"` \\| `"allow"` \\| `"deny"` \\| map<string, `"ask"` \\| `"allow"` \\| `"deny"`> | — |  |
| `dreamer.permission.webfetch` | `"ask"` \\| `"allow"` \\| `"deny"` | — |  |
| `dreamer.permission.doom_loop` | `"ask"` \\| `"allow"` \\| `"deny"` | — |  |
| `dreamer.permission.external_directory` | `"ask"` \\| `"allow"` \\| `"deny"` | — |  |
| `dreamer.maxTokens` | number | — | Maximum output tokens |
| `dreamer.variant` | string | — | OpenCode reasoning variant (e.g. for extended thinking) |
| `dreamer.fallback_models` | string \\| string[] | — | Fallback model IDs if primary is unavailable |
| `dreamer.tasks` | object | — | Per-task scheduling + model config. Each task has its own cron schedule and may override the dreamer-level model. |
| `dreamer.tasks.map-memories.schedule` | string | `""` | 5-field cron schedule (e.g. "0 3 * * *"), or "" to disable this task. |
| `dreamer.tasks.map-memories.model` | string | — | Per-task model override (inherits dreamer.model) |
| `dreamer.tasks.map-memories.fallback_models` | string \\| string[] | — | Per-task fallback chain (inherits dreamer.fallback_models) |
| `dreamer.tasks.map-memories.thinking_level` | `"off"` \\| `"minimal"` \\| `"low"` \\| `"medium"` \\| `"high"` \\| `"xhigh"` \\| `"max"` | — | Pi only: per-task thinking level |
| `dreamer.tasks.map-memories.timeout_minutes` | number (5–) | `20` | Minutes allowed for this task before it is aborted |
| `dreamer.tasks.verify.schedule` | string | `""` | 5-field cron schedule (e.g. "0 3 * * *"), or "" to disable this task. |
| `dreamer.tasks.verify.model` | string | — | Per-task model override (inherits dreamer.model) |
| `dreamer.tasks.verify.fallback_models` | string \\| string[] | — | Per-task fallback chain (inherits dreamer.fallback_models) |
| `dreamer.tasks.verify.thinking_level` | `"off"` \\| `"minimal"` \\| `"low"` \\| `"medium"` \\| `"high"` \\| `"xhigh"` \\| `"max"` | — | Pi only: per-task thinking level |
| `dreamer.tasks.verify.timeout_minutes` | number (5–) | `20` | Minutes allowed for this task before it is aborted |
| `dreamer.tasks.verify-broad.schedule` | string | `""` | 5-field cron schedule (e.g. "0 3 * * *"), or "" to disable this task. |
| `dreamer.tasks.verify-broad.model` | string | — | Per-task model override (inherits dreamer.model) |
| `dreamer.tasks.verify-broad.fallback_models` | string \\| string[] | — | Per-task fallback chain (inherits dreamer.fallback_models) |
| `dreamer.tasks.verify-broad.thinking_level` | `"off"` \\| `"minimal"` \\| `"low"` \\| `"medium"` \\| `"high"` \\| `"xhigh"` \\| `"max"` | — | Pi only: per-task thinking level |
| `dreamer.tasks.verify-broad.timeout_minutes` | number (5–) | `20` | Minutes allowed for this task before it is aborted |
| `dreamer.tasks.curate.schedule` | string | `""` | 5-field cron schedule (e.g. "0 3 * * *"), or "" to disable this task. |
| `dreamer.tasks.curate.model` | string | — | Per-task model override (inherits dreamer.model) |
| `dreamer.tasks.curate.fallback_models` | string \\| string[] | — | Per-task fallback chain (inherits dreamer.fallback_models) |
| `dreamer.tasks.curate.thinking_level` | `"off"` \\| `"minimal"` \\| `"low"` \\| `"medium"` \\| `"high"` \\| `"xhigh"` \\| `"max"` | — | Pi only: per-task thinking level |
| `dreamer.tasks.curate.timeout_minutes` | number (5–) | `20` | Minutes allowed for this task before it is aborted |
| `dreamer.tasks.compress-cues.schedule` | string | `""` | 5-field cron schedule (e.g. "0 3 * * *"), or "" to disable this task. |
| `dreamer.tasks.compress-cues.model` | string | — | Per-task model override (inherits dreamer.model) |
| `dreamer.tasks.compress-cues.fallback_models` | string \\| string[] | — | Per-task fallback chain (inherits dreamer.fallback_models) |
| `dreamer.tasks.compress-cues.thinking_level` | `"off"` \\| `"minimal"` \\| `"low"` \\| `"medium"` \\| `"high"` \\| `"xhigh"` \\| `"max"` | — | Pi only: per-task thinking level |
| `dreamer.tasks.compress-cues.timeout_minutes` | number (5–) | `20` | Minutes allowed for this task before it is aborted |
| `dreamer.tasks.classify-memories.schedule` | string | `""` | 5-field cron schedule (e.g. "0 3 * * *"), or "" to disable this task. |
| `dreamer.tasks.classify-memories.model` | string | — | Per-task model override (inherits dreamer.model) |
| `dreamer.tasks.classify-memories.fallback_models` | string \\| string[] | — | Per-task fallback chain (inherits dreamer.fallback_models) |
| `dreamer.tasks.classify-memories.thinking_level` | `"off"` \\| `"minimal"` \\| `"low"` \\| `"medium"` \\| `"high"` \\| `"xhigh"` \\| `"max"` | — | Pi only: per-task thinking level |
| `dreamer.tasks.classify-memories.timeout_minutes` | number (5–) | `20` | Minutes allowed for this task before it is aborted |
| `dreamer.tasks.retrospective.schedule` | string | `""` | 5-field cron schedule (e.g. "0 3 * * *"), or "" to disable this task. |
| `dreamer.tasks.retrospective.model` | string | — | Per-task model override (inherits dreamer.model) |
| `dreamer.tasks.retrospective.fallback_models` | string \\| string[] | — | Per-task fallback chain (inherits dreamer.fallback_models) |
| `dreamer.tasks.retrospective.thinking_level` | `"off"` \\| `"minimal"` \\| `"low"` \\| `"medium"` \\| `"high"` \\| `"xhigh"` \\| `"max"` | — | Pi only: per-task thinking level |
| `dreamer.tasks.retrospective.timeout_minutes` | number (5–) | `20` | Minutes allowed for this task before it is aborted |
| `dreamer.tasks.maintain-docs.schedule` | string | `""` | 5-field cron schedule (e.g. "0 3 * * *"), or "" to disable this task. |
| `dreamer.tasks.maintain-docs.model` | string | — | Per-task model override (inherits dreamer.model) |
| `dreamer.tasks.maintain-docs.fallback_models` | string \\| string[] | — | Per-task fallback chain (inherits dreamer.fallback_models) |
| `dreamer.tasks.maintain-docs.thinking_level` | `"off"` \\| `"minimal"` \\| `"low"` \\| `"medium"` \\| `"high"` \\| `"xhigh"` \\| `"max"` | — | Pi only: per-task thinking level |
| `dreamer.tasks.maintain-docs.timeout_minutes` | number (5–) | `20` | Minutes allowed for this task before it is aborted |
| `dreamer.tasks.evaluate-smart-notes.schedule` | string | `""` | 5-field cron schedule (e.g. "0 3 * * *"), or "" to disable this task. |
| `dreamer.tasks.evaluate-smart-notes.model` | string | — | Per-task model override (inherits dreamer.model) |
| `dreamer.tasks.evaluate-smart-notes.fallback_models` | string \\| string[] | — | Per-task fallback chain (inherits dreamer.fallback_models) |
| `dreamer.tasks.evaluate-smart-notes.thinking_level` | `"off"` \\| `"minimal"` \\| `"low"` \\| `"medium"` \\| `"high"` \\| `"xhigh"` \\| `"max"` | — | Pi only: per-task thinking level |
| `dreamer.tasks.evaluate-smart-notes.timeout_minutes` | number (5–) | `20` | Minutes allowed for this task before it is aborted |
| `dreamer.tasks.review-user-memories.schedule` | string | `""` | 5-field cron schedule (e.g. "0 3 * * *"), or "" to disable this task. |
| `dreamer.tasks.review-user-memories.model` | string | — | Per-task model override (inherits dreamer.model) |
| `dreamer.tasks.review-user-memories.fallback_models` | string \\| string[] | — | Per-task fallback chain (inherits dreamer.fallback_models) |
| `dreamer.tasks.review-user-memories.thinking_level` | `"off"` \\| `"minimal"` \\| `"low"` \\| `"medium"` \\| `"high"` \\| `"xhigh"` \\| `"max"` | — | Pi only: per-task thinking level |
| `dreamer.tasks.review-user-memories.timeout_minutes` | number (5–) | `20` | Minutes allowed for this task before it is aborted |
| `dreamer.tasks.review-user-memories.promotion_threshold` | number (2–20) | — | review-user-memories: min candidate observations before promotion is considered (default: 3) |
| `dreamer.tasks.promote-primers.schedule` | string | `""` | 5-field cron schedule (e.g. "0 3 * * *"), or "" to disable this task. |
| `dreamer.tasks.promote-primers.model` | string | — | Per-task model override (inherits dreamer.model) |
| `dreamer.tasks.promote-primers.fallback_models` | string \\| string[] | — | Per-task fallback chain (inherits dreamer.fallback_models) |
| `dreamer.tasks.promote-primers.thinking_level` | `"off"` \\| `"minimal"` \\| `"low"` \\| `"medium"` \\| `"high"` \\| `"xhigh"` \\| `"max"` | — | Pi only: per-task thinking level |
| `dreamer.tasks.promote-primers.timeout_minutes` | number (5–) | `20` | Minutes allowed for this task before it is aborted |
| `dreamer.tasks.promote-primers.promotion_threshold` | number (2–20) | — | promote-primers: min recurring source days before promotion is considered (default: 2) |
| `dreamer.tasks.refresh-primers.schedule` | string | `""` | 5-field cron schedule (e.g. "0 3 * * *"), or "" to disable this task. |
| `dreamer.tasks.refresh-primers.model` | string | — | Per-task model override (inherits dreamer.model) |
| `dreamer.tasks.refresh-primers.fallback_models` | string \\| string[] | — | Per-task fallback chain (inherits dreamer.fallback_models) |
| `dreamer.tasks.refresh-primers.thinking_level` | `"off"` \\| `"minimal"` \\| `"low"` \\| `"medium"` \\| `"high"` \\| `"xhigh"` \\| `"max"` | — | Pi only: per-task thinking level |
| `dreamer.tasks.refresh-primers.timeout_minutes` | number (5–) | `20` | Minutes allowed for this task before it is aborted |
| `dreamer.inject_docs` | boolean | `true` | Inject ARCHITECTURE.md and STRUCTURE.md into the m[0] `<project-docs>` block (default true) |
| `dreamer.thinking_level` | `"off"` \\| `"minimal"` \\| `"low"` \\| `"medium"` \\| `"high"` \\| `"xhigh"` \\| `"max"` | — | Pi only: default thinking level for dreamer subagent invocations. See historian.thinking_level. |
| `sidekick` | object | — | Optional sidekick agent configuration for session-start memory retrieval |
| `sidekick.model` | string | — | Primary model ID (e.g. 'claude-sonnet-4-6') |
| `sidekick.temperature` | number (0–2) | — | Sampling temperature (0-2) |
| `sidekick.top_p` | number (0–1) | — | Nucleus sampling top_p (0-1) |
| `sidekick.prompt` | string | — | Additional system prompt text |
| `sidekick.tools` | map<string, boolean> | — | Tool enable/disable overrides |
| `sidekick.disable` | boolean | — | Disable this agent |
| `sidekick.description` | string | — | Agent description |
| `sidekick.mode` | `"subagent"` \\| `"primary"` \\| `"all"` | — | Agent mode (subagent, primary, or all) |
| `sidekick.color` | string | — | Hex color for the agent (e.g. '#a1b2c3') |
| `sidekick.maxSteps` | number | — | Maximum tool-call steps per invocation |
| `sidekick.permission` | object | — | Per-tool permission overrides |
| `sidekick.permission.edit` | `"ask"` \\| `"allow"` \\| `"deny"` | — |  |
| `sidekick.permission.bash` | `"ask"` \\| `"allow"` \\| `"deny"` \\| map<string, `"ask"` \\| `"allow"` \\| `"deny"`> | — |  |
| `sidekick.permission.webfetch` | `"ask"` \\| `"allow"` \\| `"deny"` | — |  |
| `sidekick.permission.doom_loop` | `"ask"` \\| `"allow"` \\| `"deny"` | — |  |
| `sidekick.permission.external_directory` | `"ask"` \\| `"allow"` \\| `"deny"` | — |  |
| `sidekick.maxTokens` | number | — | Maximum output tokens |
| `sidekick.variant` | string | — | OpenCode reasoning variant (e.g. for extended thinking) |
| `sidekick.fallback_models` | string \\| string[] | — | Fallback model IDs if primary is unavailable |
| `sidekick.timeout_ms` | number | `30000` | Timeout for sidekick calls in milliseconds |
| `sidekick.system_prompt` | string | — | Custom system prompt for sidekick |
| `sidekick.thinking_level` | `"off"` \\| `"minimal"` \\| `"low"` \\| `"medium"` \\| `"high"` \\| `"xhigh"` \\| `"max"` | — | Pi only: explicit thinking level for sidekick subagent invocations. See historian.thinking_level. |

## Advanced

Behavior tuning most installs never need to touch.

| Key | Type | Default | Description |
|---|---|---|---|
| `temporal_awareness` | boolean | `true` | Inject wall-clock gap markers (<!-- +Xm -->) between user messages where > 5 min elapsed since the previous message, and add compact date ranges to compartment headings. Gives the agent a sense of session pacing and "how long ago" across multi-day sessions. Graduated from experimental.temporal_awareness; default: true (set false to opt out). |
| `caveman_text_compression` | object | — | Age-tier caveman compression for long user/assistant text parts. Active for primary sessions when enabled; never for subagents. Oldest 20% of eligible tags (outside protected tail) go to ultra, next 20% to full, next 20% to lite, newest 40% untouched. Graduated from experimental.caveman_text_compression; opt-in, default off (lossy). |
| `caveman_text_compression.enabled` | boolean | `false` | Apply deterministic caveman-style text compression to old conversation text. Active for primary sessions when enabled; never for subagents. Compresses user/assistant text in oldest-first tiers: ultra (oldest 20%), full, lite, untouched (newest 40%). |
| `caveman_text_compression.min_chars` | number (100–10000) | `500` | Text parts shorter than this (characters) stay untouched. Min 100, max 10000. Default: 500. |
| `system_prompt_injection` | object | — | Controls whether and where Magic Context augments the system prompt. Lets users opt specific agents out of the Magic Context guidance and the surrounding project-docs / user-profile blocks. OpenCode's internal hidden agents — title, summary, and compaction — are always skipped automatically. |
| `system_prompt_injection.enabled` | boolean | `true` | When false, NO injection happens for ANY agent — global escape hatch. (default: true) |
| `system_prompt_injection.skip_signatures` | string[] | `["<!-- magic-context: skip -->"]` | Substring opt-out list. If the agent's system prompt contains any of these strings, skip ALL Magic Context injection for that call. Default "<!-- magic-context: skip -->" is meant to be added inside a user's custom agent prompt to opt that agent out. |
| `sqlite` | object | — | SQLite connection tuning for Magic Context's own context.db. These are per-connection PRAGMAs applied at open; they do not change the schema or what is stored. |
| `sqlite.cache_size_mb` | number (2–2048) | `64` | Page-cache size in MiB per connection (PRAGMA cache_size). Larger keeps more hot pages resident, cutting re-reads on repeated full-table scans. (min 2, max 2048, default 64) |
| `sqlite.mmap_size_mb` | number (0–8192) | `0` | Memory-mapped I/O size in MiB (PRAGMA mmap_size). 0 disables mmap (SQLite default). Raising it can cut read overhead on large DBs at the cost of address space. (min 0, max 8192, default 0) |

## Other

| Key | Type | Default | Description |
|---|---|---|---|
| `experimental.mural` | object | — | Experimental mural: a single deterministically-rendered image of project memories that did not fit the context budget. Cues are compressed per-memory by the compress-cues dreamer task. |
| `experimental.mural.enabled` | boolean | `false` |  |
| `experimental.mural.model` | string | — | Model for the compress-cues task that compresses each memory into a mural cue. The mural image itself is rendered deterministically (no author model). |
| `toast_duration_ms` | number (0–60000) | `5000` | TUI toast lifetime in milliseconds for Magic Context notifications. Set to 0 to disable Magic Context toasts entirely (min: 0, max: 60000, default: 5000) |
| `subc.connection_file` | string | — | Path to the owner-only subc connection file. |
| `fail_closed_blocking` | boolean | `true` | When Magic Context cannot operate (schema fence mismatch, storage open/migration failure), block the primary-session prompt with a loud recovery error instead of silently degrading to native compaction. Default true. Set false only to restore the old degrade-silently behavior (not recommended). USER-LEVEL ONLY — ignored in project config for security. Requires a restart. |
| `compaction.enabled` | boolean | `true` | When false, Magic Context stops managing the context window and keeps its knowledge layer: memory and docs/user-profile/key-files injection through additive m[0]/m[1], raw-message FTS indexing, dreamer, notes, ctx_search, ctx_expand, ctx_memory, and /ctx-embed remain available. MC's historian/compartment preparation, tagging, markers, pruning, folding, drops, strips, splicing, synthetic context-management todos, temporal markers, nudges, and fail-closed blocking stop; ctx_expand remains a knowledge-surface tool. fail_closed_blocking is inert: a transform failure passes the input messages through without blocking or cancelling. This setting does not enable native compaction: OpenCode's compaction.auto / compaction.prune or Pi's equivalent owns the window, or nothing does. MC's compaction.enabled in magic-context.jsonc is distinct from OpenCode's compaction.auto / compaction.prune in opencode.jsonc; they are different files and different owners. On the first turn after disabling, a long session may trigger one native compaction cycle; MC removes only its own marker boundary, leaves native boundaries and stored compartments intact, and does no pre-trimming mitigation. Marker cleanup is lazy per session, so an unresumed session is cleaned when it is next resumed. If compaction is enabled again, run /ctx-wrapup when the historian is runnable to catch up. OpenCode peer verification against v1.18.4 confirms native compaction covers child sessions: subagents receive additive memory/docs injection and no MC reclaim in this mode, so keep subagent tasks small or leave compaction.enabled on for long subagent runs. If transform_mode is rust, compaction-off resolves to the TypeScript transform and emits one frozen boot warning because there is no Rust reduced-mode contract. This is boot-resolved and requires a process restart; project-tier compaction.enabled is stripped so a cloned repository cannot disable the user's setting. The sidebar reports raw usage as Context: <pct>% · native compaction or Context: <pct>% · no active compaction and does not show an MC execute-threshold fill. /ctx-wrapup, /ctx-recomp, /ctx-flush, and /ctx-session-upgrade refuse without context-management side effects; /ctx-embed remains functional. Raw content hidden by a native boundary before Magic Context's first pass is not retroactively indexed. |
| `pi.subagent_extensions` | string[] | — | User-only allowlist of Pi extensions for Magic Context subagent children. When set, children use --no-extensions and load only these entries (plus Magic Context's scoped child extension where applicable). Relative paths resolve from ~/.pi/agent, matching Pi's settings.json package location. Unset preserves normal Pi extension discovery. |
| `smart_drops` | boolean | `false` | Content-aware reclaim of provably-superseded tool output, layered on the existing execute-pass auto-drop. When on: superseded todowrite (keep newest 1), spent ctx_reduce (keep newest 5), and zero-value meta (bash_status, bash_kill, ctx_note read/dismiss) outputs are dropped; older edits to a file are compressed to a filePath-preserving marker while the newest edit per file stays full. Only acts on passes already busting the cache, so it never originates a cache bust. Honors the protected-tag reserve. Experimental: opt-in, default off until cache stability is proven; when off the wire is byte-identical to the positional-only reclaim. Requires a restart. |
