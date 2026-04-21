<h1 align="center">Magic Context</h1>

<p align="center">
  <strong>Cache-aware infinite context, cross-session memory, and background history compression for AI coding agents.</strong><br>
  An <a href="https://github.com/anomalyco/opencode">OpenCode</a> plugin that keeps your agent's memory intact — no matter how long the session runs.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@cortexkit/opencode-magic-context"><img src="https://img.shields.io/npm/v/@cortexkit/opencode-magic-context?color=blue&style=flat-square" alt="npm"></a>
  <a href="https://github.com/cortexkit/opencode-magic-context/stargazers"><img src="https://img.shields.io/github/stars/cortexkit/opencode-magic-context?style=flat-square&color=yellow" alt="stars"></a>
  <a href="https://github.com/cortexkit/opencode-magic-context/commits"><img src="https://img.shields.io/github/last-commit/cortexkit/opencode-magic-context?style=flat-square&color=green" alt="last commit"></a>
  <a href="https://github.com/cortexkit/opencode-magic-context/blob/master/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT License"></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/cortexkit/opencode-magic-context/master/packages/plugin/docs/animation/out/optimized2.gif" alt="Magic Context in action" width="720">
</p>

<p align="center">
  <a href="#get-started">Get Started</a> ·
  <a href="#what-is-magic-context">What is Magic Context?</a> ·
  <a href="#what-your-agent-gets">What Your Agent Gets</a> ·
  <a href="#how-it-works">How It Works</a> ·
  <a href="#magic-context-app">🖥️ Desktop App <sup>(NEW)</sup></a> ·
  <a href="#commands">Commands</a> ·
  <a href="#configuration">Configuration</a>
</p>

---

## What is Magic Context?

Your agent should never stop working to manage its own context. Magic Context is an OpenCode plugin that handles context and memory management entirely in the background:

**1.** Transparent context compaction via a background historian — the main agent keeps working while a separate model compresses older conversation. All operations are **cache-aware** and deferred to avoid wasting cached prefixes.

**2.** Cross-session project memory — architecture decisions, constraints, and preferences persist across conversations.

**3.** Overnight dreamer agent that consolidates, deduplicates, and promotes memories into canonical facts, plus maintains codebase documentation.

**4.** On-demand sidekick that augments prompts with relevant project context.

**5.** TUI sidebar with live context breakdown, token usage, historian status, and memory counts — right inside the terminal.

### 🧪 New Experimental Features

**Compaction Markers** — after historian compresses older messages, Magic Context injects a boundary into OpenCode's message table. OpenCode's built-in message loader stops at the boundary, so the transform processes only the live tail instead of the full session history. Dramatically reduces per-turn overhead on long sessions. Enable with `experimental.compaction_markers: true`.

**User Memories** — historian extracts behavioral observations about you alongside its normal compartment output (communication style, expertise level, review focus, working patterns). Recurring observations are promoted by the dreamer to stable user memories that appear in all sessions via `<user-profile>`. Enable with `experimental.user_memories.enabled: true` (requires dreamer).

**Key File Pinning** — dreamer analyzes which files your agent reads most frequently across the session. Core orientation files (architecture, config, types) that get re-read after every context drop are pinned into the system prompt as `<key-files>`, so the agent always has them without needing to re-read from disk. Files are read fresh on each cache-busting pass. Enable with `experimental.pin_key_files.enabled: true` (requires dreamer).

**Temporal Awareness** — gives the agent real-time perception. Each user message gets a small `<!-- +5m -->`/`<!-- +2h 15m -->`/`<!-- +3d 4h -->` gap marker showing time since the previous message, and every compartment in `<session-history>` carries `start-date`/`end-date` attributes. Lets the agent reason correctly about how long a build ran, when a decision was made, or how stale a prior session is. Cache-safe — markers derive from immutable timestamps. Enable with `experimental.temporal_awareness: true`.

---

## Get Started

### Quick Setup (Recommended)

Run the interactive setup wizard — it detects your models, configures everything, and handles compatibility:

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/cortexkit/opencode-magic-context/master/scripts/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/cortexkit/opencode-magic-context/master/scripts/install.ps1 | iex
```

**Or run directly (any OS):**
```bash
bunx --bun @cortexkit/opencode-magic-context@latest setup
```

The wizard will:
1. Check your OpenCode installation and available models
2. Add the plugin and disable built-in compaction
3. Help you pick models for historian, dreamer, and sidekick
4. Handle oh-my-opencode compatibility if needed

### Manual Setup

Add to your OpenCode config (`opencode.json` or `opencode.jsonc`):

```jsonc
{
  "plugin": ["@cortexkit/opencode-magic-context"],
  "compaction": {
    "auto": false,
    "prune": false
  }
}
```

> **Why disable compaction?** Magic Context manages context itself — built-in compaction interferes with its cache-aware deferred operations and would cause duplicate compression.

Create `magic-context.jsonc` in your project root, `.opencode/`, or `~/.config/opencode/`:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/cortexkit/opencode-magic-context/master/assets/magic-context.schema.json",
  "enabled": true,

  // Which model the historian uses for background compression, 
  // Prefer providers that charge by request instead of tokens
  "historian": {
    "model": "github-copilot/gpt-5.4",
    "fallback_models": ["opencode-go/glm-5"]
  }
}
```

> **Tip:** The `$schema` key enables autocomplete and validation in VS Code and other editors.

That's it. Everything else has sensible defaults. Project config merges on top of user-wide settings.

### Oh-My-OpenCode / Oh-My-OpenAgent Users

If you use [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) (formerly oh-my-opencode), disable the hooks that conflict with Magic Context in your `oh-my-openagent.json`:

```json
{
  "disabled_hooks": [
    "context-window-monitor",
    "preemptive-compaction",
    "anthropic-context-window-limit-recovery"
  ]
}
```

The setup wizard handles this automatically if it detects an oh-my-openagent or oh-my-opencode config.

### Doctor (Troubleshooting)

Already installed but something isn't working? Run the doctor to check and auto-fix configuration issues:

```bash
bunx --bun @cortexkit/opencode-magic-context@latest doctor
```

Doctor checks for conflicts (compaction, DCP, OMO hooks), ensures the TUI sidebar is configured, verifies the plugin is registered, and checks the npm cache — fixing what it can automatically.

Use `--force` to force-clear the plugin cache even when versions match (fixes broken transitive dependencies):

```bash
bunx --bun @cortexkit/opencode-magic-context@latest doctor --force
```

Hit a real bug? Use `--issue` to collect environment, sanitized config, and the last 200 log lines into a ready-to-submit report. It can also open the issue directly via `gh` if you have it installed:

```bash
bunx --bun @cortexkit/opencode-magic-context@latest doctor --issue
```

---

## What Your Agent Gets

Magic Context injects structured context automatically and gives the agent five tools.

### `ctx_reduce` — Shed weight

After tool-heavy turns (large grep results, file reads, bash output), the agent calls `ctx_reduce` to mark stale content for removal. Drops are queued — not applied immediately — until the cache expires or context pressure forces it.

```
ctx_reduce(drop="3-5,12")     // Drop tags 3, 4, 5, and 12
```

Recent tags (last 20 by default) are protected. Drops targeting them stay queued until they age out.

### `ctx_expand` — Decompress history

When the agent needs to recall details from a compressed history range, it can expand specific compartment ranges back to the original conversation transcript.

```
ctx_expand(start=100, end=200)   // Expand raw messages 100-200
```

Returns the same compact `U:`/`A:` transcript format the historian sees, capped at ~15K tokens per request. Use `start`/`end` from compartment attributes visible in `<session-history>`.

### `ctx_note` — Deferred intentions

Session notes are the agent's scratchpad for things to tackle later — not task tracking (that's what todos are for), but deferred work and reminders that should surface at the right time.

```
ctx_note(action="write", content="After this fix, check if the compressor budget formula is correct")
ctx_note(action="read")
```

Notes surface automatically at natural work boundaries: after commits, after historian runs, and after all todos complete.

**Smart notes** are project-scoped notes with an open-ended `surface_condition` that the dreamer evaluates nightly. When the condition is met, the note surfaces in the next session:

```
ctx_note(action="write", content="Implement X because Y", surface_condition="When PR #42 is merged in this repo")
ctx_note(action="dismiss", note_id=1)
```

Smart notes require dreamer enabled. Pending notes are invisible until the dreamer marks them ready. Use `dismiss` to clear a surfaced note.

### `ctx_memory` — Persistent cross-session knowledge

Architecture decisions, naming conventions, user preferences — anything that should survive across conversations. Memories are project-scoped and automatically promoted from session facts by the historian.

```
ctx_memory(action="write", category="ARCHITECTURE_DECISIONS", content="Event sourcing for orders.")
ctx_memory(action="delete", id=42)
```

### `ctx_search` — Unified search

Search across all data layers with a single query — project memories, session facts, and raw conversation history. Results are ranked by source (memories first, then facts, then message hits).

```
ctx_search(query="authentication approach")
```

Message results include ordinal numbers the agent can pass to `ctx_expand` to retrieve the surrounding conversation context.

### Automatic context injection

Every turn, Magic Context injects a `<session-history>` block containing:

- **Project memories** — cross-session decisions, constraints, and preferences
- **Compartments** — structured summaries replacing older raw history
- **Session facts** — durable categorized facts from the current session

This block is stable between historian runs. Memory writes persist immediately for search but don't change the injected block until the next historian run — so writes never bust the cache mid-conversation.

---

## How It Works

### Tagging

Every message, tool output, and file attachment gets a monotonically increasing `§N§` tag. The agent sees these inline and uses them to reference specific content when calling `ctx_reduce`. Tags persist in the database and resume across restarts.

### Queued reductions

When the agent calls `ctx_reduce`, drops go into a pending queue — not applied immediately. Two conditions trigger execution:

- **Cache expired** — enough time has passed that the cached prefix is likely stale (configurable per model, default 5 minutes)
- **Threshold reached** — context usage hits `execute_threshold_percentage` (default 65%)

Between triggers, the conversation continues unchanged. The agent doesn't need to think about timing.

### Background historian

When local drops aren't buying enough headroom, Magic Context starts a historian — a separate lightweight model that reads an eligible prefix of raw history and produces:

- **Compartments** — chronological blocks that replace older raw messages
- **Facts** — durable decisions, constraints, and preferences (categorized)

The historian runs asynchronously. The main agent never waits for it. When the historian finishes, its output is materialized on the next transform pass.

A **separate compressor** pass fires when the rendered history block exceeds the configured history budget, merging the oldest compartments to keep the injected context lean.

### Nudging

As context usage grows, Magic Context sends rolling reminders suggesting the agent reduce. Cadence tightens as usage approaches the threshold — from gentle reminders to urgent warnings. If the agent recently called `ctx_reduce`, reminders are suppressed. An emergency nudge at 80% always fires.

### Cross-session memory

After each historian run, qualifying facts are promoted to the persistent memory store. On every subsequent turn, active memories are injected in `<session-history>`. New sessions inherit all project memories from previous sessions.

Memories are searchable via `ctx_search` alongside session facts and raw conversation history, using semantic embeddings (local by default) with full-text search as fallback.

### Dreamer

An optional background agent that maintains memory quality overnight:

- **Consolidate** — merge semantically similar memories into canonical facts
- **Verify** — check memories against current codebase (configs, paths, code patterns)
- **Archive stale** — retire memories referencing removed features or old paths
- **Improve** — rewrite verbose memories into terse operational form
- **Maintain docs** — update ARCHITECTURE.md and STRUCTURE.md from codebase changes
- **Evaluate smart notes** — check pending smart note conditions and surface ready notes
- **Review user memories** (experimental) — promote recurring user behavior observations to stable memories

The dreamer runs during a configurable schedule window and creates ephemeral OpenCode child sessions for each task. Since it runs during idle time (typically overnight), it works well with local models — even slower ones like `ollama/mlx-qwen3.5-27b-claude-4.6-opus-reasoning-distilled` are fine since there's no user waiting.

When dreamer is enabled, ARCHITECTURE.md and STRUCTURE.md are automatically injected into the agent's system prompt (configurable via `inject_docs`). Content is cached per-session and refreshed on cache-busting passes.

### User Memories (Experimental)

When `experimental.user_memories.enabled` is set, historian extracts behavioral observations about the user alongside its normal compartment output — things like communication style, expertise level, review focus, and working patterns. These go into a candidate pool.

During dreamer runs, a dedicated review pass checks candidates for recurring patterns across sessions. Observations that appear at least `promotion_threshold` times (default 3) are promoted to stable user memories and injected into all sessions via `<user-profile>` in the system prompt.

Stable user memories are visible and manageable in the dashboard's User Memories page. Requires dreamer to be enabled for the promotion step.

### TUI Sidebar

When running in OpenCode's terminal UI, Magic Context shows a live sidebar panel with:

- **Context breakdown bar** — visual token split across System Prompt, Compartments, Facts, Memories, and Conversation
- **Historian status** — idle, running, or compartment/fact counts
- **Memory counts** — total project memories and how many are injected
- **Dreamer status** — last run time
- **Queue status** — pending operations count

The sidebar updates after every message. Commands (`/ctx-status`, `/ctx-flush`, `/ctx-aug`) also work directly in TUI mode via dialogs and toasts.

The TUI plugin is configured automatically by the setup wizard and the `doctor` command. If you installed manually, add to your `tui.json` or `tui.jsonc`:

```jsonc
{
  "plugin": ["@cortexkit/opencode-magic-context"]
}
```

### Startup conflict detection

On startup, Magic Context checks for common configuration problems — OpenCode's built-in compaction being enabled, DCP plugin being active alongside Magic Context, or conflicting oh-my-openagent hooks. When conflicts are detected, it warns the active session with a fix suggestion pointing to `bunx --bun @cortexkit/opencode-magic-context@latest doctor`.

---

## Commands

| Command | Description |
|---------|-------------|
| `/ctx-status` | Debug view: tags, pending drops, cache TTL, nudge state, historian progress, compartment coverage, history compression budget |
| `/ctx-flush` | Force all queued operations immediately, bypassing cache TTL |
| `/ctx-recomp` | Rebuild compartments and facts from raw history — use when stored state seems wrong |
| `/ctx-aug` | Run sidekick augmentation on a prompt — retrieves relevant memories via a separate model |
| `/ctx-dream` | Run dreamer maintenance on demand — consolidate, verify, archive, improve memories |

---

## Magic Context App

A companion desktop app for browsing and managing Magic Context state outside of OpenCode.

<p align="center">
   <a href="https://github.com/cortexkit/opencode-magic-context/releases/tag/dashboard-v0.3.0"><strong>⬇️ Download for macOS · Windows · Linux</strong></a></p>

**Features:**
- **Memory Browser** — search, filter, and edit project memories with category and project filtering
- **Session History** — browse compartments, facts, and notes for any session with timeline navigation
- **Cache Diagnostics** — real-time cache hit/miss timeline, bust cause detection, per-session stats
- **Dreamer Management** — view dream run history per project, trigger runs, inspect task results
- **Configuration Editor** — form-based editing for all settings including model selection with fallback chains
- **Log Viewer** — live-tailing log viewer with search
- **System Tray** — quick access to dreamer status and controls

The app reads directly from Magic Context's SQLite database — no additional server or API required. Auto-updates are built in.

---

## Configuration

All settings live in `magic-context.jsonc` as flat top-level keys. See **[CONFIGURATION.md](./CONFIGURATION.md)** for the full reference — cache TTL tuning, per-model execute thresholds, historian model selection, embedding providers, memory settings, sidekick, and dreamer.

**Config locations** (merged in order, project overrides user):
1. `<project-root>/magic-context.jsonc`
2. `<project-root>/.opencode/magic-context.jsonc`
3. `~/.config/opencode/magic-context.jsonc`

---

## Storage

All durable states live in a local SQLite database. If the database can't be opened, Magic Context disables itself and notifies the user.

```
~/.local/share/opencode/storage/plugin/magic-context/context.db
```

| Table | Purpose |
|-------|---------|
| `tags` | Tag assignments — message ID, tag number, session, status |
| `pending_ops` | Queued drop operations |
| `source_contents` | Raw content snapshots for persisted reductions |
| `compartments` | Historian-produced structured history blocks |
| `session_facts` | Categorized durable facts from historian runs |
| `notes` | Unified session notes and project-scoped smart notes |
| `session_meta` | Per-session state — usage, nudge flags, anchors |
| `memories` | Cross-session persistent memories |
| `memory_embeddings` | Embedding vectors for semantic search |
| `dream_state` | Dreamer lease locking and task progress |
| `dream_queue` | Queued projects awaiting dream processing |
| `dream_runs` | Per-project dream run history — task names, durations, memory changes |
| `compression_depth` | Per-message compression depth for weighted compressor selection |
| `message_history_fts` | FTS5 index of user/assistant message text for `ctx_search` |
| `message_history_index` | Tracks last indexed ordinal per session for incremental FTS population |
| `recomp_compartments` | Staging for `/ctx-recomp` partial progress |
| `recomp_facts` | Staging for `/ctx-recomp` partial progress |
| `user_memory_candidates` | User behavior observations from historian (experimental) |
| `user_memories` | Promoted stable user memories injected into all sessions (experimental) |

---

## Star History

<a href="https://www.star-history.com/?repos=cortexkit%2Fopencode-magic-context&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=cortexkit/opencode-magic-context&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=cortexkit/opencode-magic-context&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=cortexkit/opencode-magic-context&type=date&legend=top-left" />
 </picture>
</a>

---

## Development

**Requirements:** [Bun](https://bun.sh) ≥ 1.0

```sh
bun install              # Install dependencies
bun run build            # Build the plugin
bun run typecheck        # Type-check without emitting
bun test                 # Run tests
bun run lint             # Lint (Biome)
bun run lint:fix         # Lint with auto-fix
bun run format           # Format (Biome)
```

**Utility scripts:**

```sh
bun packages/plugin/scripts/tail-view.ts             # Show post-compartment message tail
bun packages/plugin/scripts/context-dump/index.ts     # Dump full context state for a session
bun packages/plugin/scripts/backfill-embeddings.ts   # Backfill missing memory embeddings
```

Dream execution requires a live OpenCode server — the dreamer creates ephemeral child sessions. Use `/ctx-dream` inside OpenCode for on-demand maintenance.

---

## Contributing

Bug reports and pull requests are welcome. For larger changes, open an issue first to discuss the approach.

Run `bun run format` before submitting — CI rejects unformatted code.

---

## License

[MIT](LICENSE)
