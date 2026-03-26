<h1 align="center">Magic Context</h1>

<p align="center">
  <strong>Cache-aware infinite context, cross-session memory, and background history compression for AI coding agents.</strong><br>
  An <a href="https://github.com/anomalyco/opencode">OpenCode</a> plugin that keeps your agent's memory intact — no matter how long the session runs.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@cortexkit/magic-context-opencode"><img src="https://img.shields.io/npm/v/@cortexkit/magic-context-opencode?color=blue&style=flat-square" alt="npm"></a>
  <a href="https://github.com/ualtinok/opencode-magic-context/blob/master/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT License"></a>
</p>

<p align="center">
  <img src="docs/animation/out/optimized2.gif" alt="Magic Context in action" width="720">
</p>

<p align="center">
  <a href="#get-started">Get Started</a> ·
  <a href="#what-is-magic-context">What is Magic Context?</a> ·
  <a href="#what-your-agent-gets">What Your Agent Gets</a> ·
  <a href="#how-it-works">How It Works</a> ·
  <a href="#commands">Commands</a> ·
  <a href="#configuration">Configuration</a>
</p>

---

## Get Started

Add to your OpenCode config (`opencode.json` or `opencode.jsonc`):

```jsonc
{
  "plugins": ["@cortexkit/magic-context-opencode@latest"]
}
```

Magic Context conflicts with OpenCode's built-in compaction — the two cannot run together. To disable it:

```jsonc
{
  "compaction": {
    "auto": false,
    "prune": false
  }
}
```

Create `magic-context.jsonc` in your project root, `.opencode/`, or `~/.config/opencode/`:

```jsonc
{
  "enabled": true,

  // Which model the historian uses for background compression, 
  // Prefer providers that charge by request instead of tokens
  "historian": {
    "model": "github-copilot/gpt-5.4",
    "fallback_models": ["opencode-go/glm-5"]
  }
}
```

That's it. Everything else has sensible defaults. Project config merges on top of user-wide settings.

---

## What is Magic Context?

AI coding agents forget everything the moment a conversation gets long enough. Context windows fill up, old messages get dropped, and the agent loses track of decisions it made twenty minutes ago.

Magic Context fixes this with a background historian — a separate, lightweight model that compresses older conversation into structured summaries and durable facts while the main agent keeps working. The agent never stops to summarize its own history. It never notices the rewriting happening beneath it.

Every mutation is **cache-aware**. Drops and rewrites are queued until the provider's cached prefix expires, so you're not paying to throw away work that's already cached.

Across sessions, architecture decisions, constraints, and preferences persist in a **cross-session memory** system. A new conversation starts with everything the previous one learned, without replaying old transcripts.

And overnight, a **dreamer** agent consolidates, verifies, and improves memories — checking them against the actual codebase and merging duplicates into clean canonical facts.

---

## What Your Agent Gets

Magic Context injects structured context automatically and gives the agent four tools.

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

### `ctx_memory` — Persistent cross-session knowledge

Architecture decisions, naming conventions, user preferences — anything that should survive across conversations. Memories are project-scoped and automatically promoted from session facts by the historian.

```
ctx_memory(action="write", category="ARCHITECTURE_DECISIONS", content="Event sourcing for orders.")
ctx_memory(action="search", query="authentication approach")
ctx_memory(action="delete", id=42)
```

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

Memories are searchable via `ctx_memory(action="search", ...)` using semantic embeddings (local by default) with full-text search as fallback.

### Dreamer

An optional background agent that maintains memory quality overnight:

- **Consolidate** — merge semantically similar memories into canonical facts
- **Verify** — check memories against current codebase (configs, paths, code patterns)
- **Archive stale** — retire memories referencing removed features or old paths
- **Improve** — rewrite verbose memories into terse operational form
- **Maintain docs** — update ARCHITECTURE.md and STRUCTURE.md from codebase changes

The dreamer runs during a configurable schedule window and creates ephemeral OpenCode child sessions for each task.

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
| `session_notes` | Session-scoped `ctx_note` content |
| `session_meta` | Per-session state — usage, nudge flags, anchors |
| `memories` | Cross-session persistent memories |
| `memory_embeddings` | Embedding vectors for semantic search |
| `dream_state` | Dreamer lease locking and task progress |
| `dream_queue` | Queued projects awaiting dream processing |
| `recomp_compartments` | Staging for `/ctx-recomp` partial progress |
| `recomp_facts` | Staging for `/ctx-recomp` partial progress |

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
bun scripts/tail-view.ts             # Show post-compartment message tail
bun scripts/context-dump.ts          # Dump full context state for a session
bun scripts/backfill-embeddings.ts   # Backfill missing memory embeddings
```

Dream execution requires a live OpenCode server — the dreamer creates ephemeral child sessions. Use `/ctx-dream` inside OpenCode for on-demand maintenance.

---

## Contributing

Bug reports and pull requests are welcome. For larger changes, open an issue first to discuss the approach.

Run `bun run format` before submitting — CI rejects unformatted code.

---

## License

[MIT](LICENSE)
