# Magic Context — Pi extension

Cross-session memory and context management for [Pi coding agent](https://github.com/mariozechner/pi-mono). Shares the same SQLite database as the [OpenCode plugin](https://www.npmjs.com/package/@cortexkit/opencode-magic-context), so memories, embeddings, dreamer state, and project knowledge follow you across both harnesses.

> **Status:** v0.1.0 — first release. Production-ready for interactive Pi sessions; `pi --print` mode has a known limitation (see below).

---

## What it does

Magic Context is a context engine that keeps long Pi sessions productive by:

| Feature | What it does |
|---|---|
| **Tagging + drops** | Tags every assistant/user/tool message with `§N§ ` so you can drop specific turns later via `ctx_reduce` |
| **Historian** | Background subagent compresses old conversation into compartments + facts at threshold pressure or commit boundaries |
| **`<session-history>` injection** | Prepends compressed history into the system prompt every turn so the agent never loses context |
| **Project memories** | Persistent cross-session knowledge store with embedding-based semantic search |
| **Dreamer** | Scheduled background subagent that consolidates, verifies, archives, and improves stored memories |
| **`/ctx-aug`** | On-demand sidekick that augments the next turn with relevant memories |
| **Auto-search hint** | When user prompts mention previously-discussed topics, appends a compact memory hint |
| **Note nudges** | Surface deferred intentions at natural work boundaries (commit, todo completion, historian publication) |
| **Cross-harness sharing** | Memories written from OpenCode appear in Pi (and vice versa) for the same project |

---

## Installation

```bash
# Install via npm
npm install -g @cortexkit/pi-magic-context

# Or via Bun
bun add -g @cortexkit/pi-magic-context
```

Add the extension to your Pi config (`~/.pi/agent/settings.json`):

```jsonc
{
  "extensions": [
    "@cortexkit/pi-magic-context"
  ]
}
```

Then run the interactive setup wizard:

```bash
magic-context-pi setup
```

The wizard will:
1. Create `~/.pi/agent/magic-context.jsonc` with sensible defaults
2. Prompt you for historian, sidekick, and embedding model preferences
3. Verify your model picks resolve correctly via Pi's CLI

To check installation health later:

```bash
magic-context-pi doctor
```

---

## Configuration

Magic Context reads two config files (in this priority order):

1. `$cwd/.pi/magic-context.jsonc` (project-level overrides)
2. `~/.pi/agent/magic-context.jsonc` (user-level defaults)

Both are merged through a Zod schema. Invalid fields fall back to defaults — bad config never disables the plugin entirely.

### Minimal config

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/cortexkit/magic-context/master/assets/magic-context.schema.json",
  "enabled": true,
  "historian": {
    "model": "anthropic/claude-haiku-4-5"
  },
  "embedding": {
    "provider": "local"
  }
}
```

For the full configuration reference (including dreamer, sidekick, auto-search, and experimental features), see [CONFIGURATION.md](https://github.com/cortexkit/magic-context/blob/master/CONFIGURATION.md) in the main repository — the schema is shared between both plugins.

---

## Slash commands

All commands trigger `triggerTurn: false` (never sent to the LLM):

| Command | What it does |
|---|---|
| `/ctx-status` | Live token breakdown + queued ops + cache state |
| `/ctx-flush` | Force-process pending ops queue |
| `/ctx-recomp` | Rebuild compartments from raw history (heavy operation) |
| `/ctx-dream` | Trigger a dream run on demand |
| `/ctx-aug` | Augment your next prompt with sidekick-retrieved memories |

---

## Storage

Magic Context stores everything in a single shared SQLite database at:

```
~/.local/share/cortexkit/magic-context/context.db
```

This is the **same database** the OpenCode plugin uses. Tables are scoped by:
- `harness` column (`'pi'` or `'opencode'`) for session-scoped data (tags, compartments, facts, notes)
- `project_path` (resolved git root) for project-scoped data (memories, embeddings, dreamer runs)

So memories and dreamer state are shared across both harnesses for the same project; per-session tagging stays correctly attributed.

Storage failures are fatal — Magic Context will refuse to register hooks rather than run with ephemeral state, since that would let context grow unbounded across restarts.

---

## Cross-harness coherence

For semantic search to work across harnesses, both plugins must use the **same embedding model**. Magic Context detects mismatch on Pi startup and warns:

```
WARN embedding model mismatch detected for project ...:
stored vectors use "openai-compatible:Qwen/Qwen3-Embedding-8B" but Pi is configured with "local:Xenova/all-MiniLM-L6-v2".
Cross-harness search will return zero results until vectors are re-embedded.
```

Easiest fix: configure `embedding` once in `~/.pi/agent/magic-context.jsonc` (Pi) and `~/.config/opencode/magic-context.jsonc` (OpenCode) with identical settings.

---

## Tools available to the agent

| Tool | Action set | Purpose |
|---|---|---|
| `ctx_search` | n/a | Search memories + raw session history; returns ranked results with previews |
| `ctx_memory` | `write`, `delete` | Manage project memories explicitly (most writes happen via dreamer instead) |
| `ctx_note` | `read`, `write`, `update`, `dismiss` | Defer intentions for later — surfaced via note nudges at work boundaries |

`ctx_expand` and `ctx_reduce` from the OpenCode plugin are **intentionally not exposed on Pi** — they depend on raw OpenCode message ordinals, while Pi has its own message identity model. Drops still happen automatically via threshold-driven historian; you don't need an explicit `ctx_reduce` to trigger reduction.

---

## Known limitation: `pi --print` mode

Pi's `--print` mode is single-turn: the process exits immediately after `agent_end`. Magic Context fires historian as a background subagent (so the LLM call never blocks on summarization), but Pi's `agent_end` event uses synchronous listener fanout — the parent process exits while our async `await` is still pending, killing the spawned historian subprocess mid-run.

**Production users running interactive `pi` are unaffected.** The historian started on turn N completes during turn N+1's user-think time, the same pattern OpenCode uses.

For `--print` mode, the upstream fix is in progress: pi-coding-agent commit `9022a5b5 fix(agent): await subscribed event handlers` (shipped in `^0.70.5`). Once you're on that version, `--print` mode also works end-to-end.

---

## Architecture & implementation

This package is part of the [magic-context monorepo](https://github.com/cortexkit/magic-context). The Pi extension shares the core implementation (~7,500 lines) with the OpenCode plugin via the `@magic-context/core` workspace dependency, exposing only the Pi-specific adapter layer:

| Pi-specific module | Responsibility |
|---|---|
| `context-handler.ts` | Pi `pi.on("context", ...)` adapter — tags, drops, runs nudges and auto-search |
| `subagent-runner.ts` | Spawns `pi --print --mode json --no-extensions ...` for historian/sidekick/dreamer |
| `tools/` | Pi `pi.registerTool` wrappers around the shared tool implementations |
| `commands/` | Pi `pi.registerCommand` wrappers for the five `/ctx-*` slash commands |
| `dreamer/` | Pi-side adapter for the shared dreamer scheduler |
| `system-prompt.ts` | Pi `before_agent_start` injector for `<session-history>`, `<project-memory>`, `<project-docs>` |
| `config/` | Pi-convention config loader (`$cwd/.pi/magic-context.jsonc` + `~/.pi/agent/magic-context.jsonc`) |
| `cli/` | `magic-context-pi setup` and `magic-context-pi doctor` |

For deeper architectural detail, see the main repo's [ARCHITECTURE.md](https://github.com/cortexkit/magic-context/blob/master/ARCHITECTURE.md).

---

## License

MIT — see [LICENSE](https://github.com/cortexkit/magic-context/blob/master/LICENSE).
