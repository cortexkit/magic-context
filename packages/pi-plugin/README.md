# Magic Context — Pi extension

Cross-session memory and context management for [Pi coding agent](https://github.com/mariozechner/pi-mono). Shares the same SQLite database as the [OpenCode plugin](https://www.npmjs.com/package/@cortexkit/opencode-magic-context), so memories, embeddings, dreamer state, and project knowledge follow you across both harnesses.

> ⚠️ **Beta release.** The Pi extension is newer than the OpenCode plugin and is published as **beta**. Core flows (tagging, historian, memories, dreamer, `/ctx-aug`) are validated end-to-end on interactive `pi` sessions and `pi --print --mode json` subagents. Please [report issues](https://github.com/cortexkit/magic-context/issues) — every Pi-side rough edge is fixable.

Requires `@mariozechner/pi-coding-agent` and `@mariozechner/pi-tui` `>= 0.71.0`.

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

The fastest path is the unified Magic Context CLI — `--harness pi` selects the Pi-specific setup pipeline (registers the extension with Pi, writes a sensible `magic-context.jsonc`, and verifies your model picks):

```bash
bunx --bun @cortexkit/magic-context@latest setup --harness pi
```

This handles everything for you:
1. Adds `npm:@cortexkit/pi-magic-context` to Pi's `packages` array in `~/.pi/agent/settings.json` (the same place `pi install` writes to)
2. Creates `~/.pi/agent/magic-context.jsonc` with defaults
3. Prompts you for historian, dreamer, sidekick, and embedding model choices
4. Warns about provider-specific gotchas (e.g. GitHub Copilot reasoning models need an explicit `thinking_level`)

If you'd rather register the Pi extension package directly with Pi (skipping the wizard), use Pi's own installer:

```bash
pi install npm:@cortexkit/pi-magic-context
```

This adds the extension to `~/.pi/agent/settings.json` but won't write `magic-context.jsonc` for you — you'll need to create it manually (see Configuration below).

To check installation health later:

```bash
bunx --bun @cortexkit/magic-context@latest doctor --harness pi
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

## Architecture & implementation

This package is part of the [magic-context monorepo](https://github.com/cortexkit/magic-context). The Pi extension shares the core implementation with the OpenCode plugin via the `@magic-context/core` workspace dependency, exposing only the Pi-specific adapter layer:

| Pi-specific module | Responsibility |
|---|---|
| `context-handler.ts` | Pi `pi.on("context", ...)` adapter — tags, drops, runs nudges and auto-search |
| `subagent-runner.ts` | Spawns `pi --print --mode json --no-extensions --extension <lean-entry> ...` for historian/sidekick/dreamer subagents, with a 2-second drain after the terminal `message_end` so child processes don't keep the parent waiting |
| `tools/` | Pi `pi.registerTool` wrappers around the shared tool implementations |
| `commands/` | Pi `pi.registerCommand` wrappers for the five `/ctx-*` slash commands |
| `dreamer/` | Pi-side adapter for the shared dreamer scheduler |
| `system-prompt.ts` | Pi `before_agent_start` injector for `<session-history>`, `<project-memory>`, `<project-docs>` |
| `config/` | Pi-convention config loader (`$cwd/.pi/magic-context.jsonc` + `~/.pi/agent/magic-context.jsonc`) |

The CLI lives in the unified [`@cortexkit/magic-context`](https://www.npmjs.com/package/@cortexkit/magic-context) package — `setup --harness pi` and `doctor --harness pi` route to the Pi-specific code paths in `packages/cli/src/commands/`.

For deeper architectural detail, see the main repo's [ARCHITECTURE.md](https://github.com/cortexkit/magic-context/blob/master/ARCHITECTURE.md).

---

## License

MIT — see [LICENSE](https://github.com/cortexkit/magic-context/blob/master/LICENSE).
