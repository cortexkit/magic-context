# Magic Context — Pi / OMP extension

Cross-session memory and context management for [Pi coding agent](https://github.com/earendil-works/pi-mono) and [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi). The same extension package runs on both hosts and shares its SQLite database with the [OpenCode plugin](https://www.npmjs.com/package/@cortexkit/opencode-magic-context).

Requires Pi `>= 0.74.0` or OMP `>= 17.1.7`.

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
npx @cortexkit/magic-context@latest setup --harness pi
```

This handles everything for you:
1. Adds `npm:@cortexkit/pi-magic-context` to Pi's `packages` array in `~/.pi/agent/settings.json` (the same place `pi install` writes to)
2. Creates `~/.config/cortexkit/magic-context.jsonc` with defaults
3. Prompts you for historian, dreamer, sidekick, and embedding model choices
4. Warns about provider-specific gotchas (e.g. GitHub Copilot reasoning models need an explicit `thinking_level`)

If you'd rather register the Pi extension package directly with Pi (skipping the wizard), use Pi's own installer:

```bash
pi install npm:@cortexkit/pi-magic-context
```

This adds the extension to `~/.pi/agent/settings.json` but won't write `magic-context.jsonc` for you — create the shared config manually at `~/.config/cortexkit/magic-context.jsonc` (see Configuration below).

To check installation health later:

```bash
npx @cortexkit/magic-context@latest doctor --harness pi
```

### Oh My Pi (OMP)

Use the OMP-specific setup path. It installs the package through OMP's plugin manager, disables OMP native compaction and automatic memory to prevent duplicate context managers, and verifies the effective project plugin state:

```bash
npx @cortexkit/magic-context@latest setup --harness omp
```

Manual installation is also supported:

```bash
omp plugin install @cortexkit/pi-magic-context
omp config set compaction.enabled false
omp config set memory.backend off
```

Verify with:

```bash
npx @cortexkit/magic-context@latest doctor --harness omp
```

OMP's legacy Pi loader maps `@earendil-works/*` imports to its bundled `@oh-my-pi/*` runtime. Magic Context also re-invokes the current host executable for historian, dreamer, and sidekick children, so OMP children remain OMP processes.

---

## Configuration

Magic Context reads the shared CortexKit config (project overrides user):

1. `$cwd/.cortexkit/magic-context.jsonc`
2. `~/.config/cortexkit/magic-context.jsonc`

Session discovery follows the active host. Relative `pi.subagent_extensions` are deliberately isolated by host: plain Pi resolves them from `~/.pi/agent`, while a positively identified OMP process uses `PI_CODING_AGENT_DIR` when set and otherwise derives the active `~/.omp` config/profile agent directory.

### Minimal config

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/cortexkit/magic-context/master/assets/magic-context.schema.json",
  "enabled": true,
  "historian": {
    "pi": {
      "model": "anthropic/claude-haiku-4-5"
    }
  },
  "embedding": {
    "provider": "local"
  }
}
```

For the full configuration reference (including dreamer, sidekick, auto-search, and experimental features), see [CONFIGURATION.md](https://github.com/cortexkit/magic-context/blob/master/CONFIGURATION.md) in the main repository — OpenCode, Pi, and OMP share the same schema.

---

## Slash commands

All commands trigger `triggerTurn: false` (never sent to the LLM):

| Command | What it does |
|---|---|
| `/ctx-status` | Live token breakdown + queued ops + cache state |
| `/ctx-flush` | Force-process pending ops queue |
| `/ctx-recomp` | Rebuild compartments from raw history (heavy operation) |
| `/ctx-wrapup [messages_to_keep]` | Compact older live history while keeping the newest N messages raw |
| `/ctx-dream` | Trigger a dream run on demand |
| `/ctx-aug` | Augment your next prompt with sidekick-retrieved memories |

---

## Storage

Magic Context stores everything in a single shared SQLite database at:

```
~/.local/share/cortexkit/magic-context/context.db
```

When a host isolates `XDG_DATA_HOME` per process, set
`MC_SHARE_STORAGE_DIR` to the complete shared Magic Context storage directory.
The explicit path takes precedence over the XDG-derived path and does not
change Pi's own configuration or session directories.

This is the **same database** the OpenCode plugin and OMP extension use. Tables are scoped by:
- `harness` column (`'pi'` or `'opencode'`) for session-scoped data; OMP intentionally uses `'pi'`
- `project_path` (resolved git root) for project-scoped data (memories, embeddings, dreamer runs)

Memories and dreamer state are shared across all three harnesses for the same project; per-session tagging stays correctly attributed.

Storage failures are fatal — Magic Context will refuse to register hooks rather than run with ephemeral state, since that would let context grow unbounded across restarts.

---

## Cross-harness coherence

For semantic search to work across harnesses, every host must use the **same embedding model**. Magic Context detects a mismatch on Pi or OMP startup and warns:

```
WARN embedding model mismatch detected for project ...:
stored vectors use "openai-compatible:Qwen/Qwen3-Embedding-8B" but Pi is configured with "local:Xenova/all-MiniLM-L6-v2".
Cross-harness search will return zero results until vectors are re-embedded.
```

Configure `embedding` once in the shared `~/.config/cortexkit/magic-context.jsonc`; OpenCode, Pi, and OMP all read it. Use `$cwd/.cortexkit/magic-context.jsonc` only when that project intentionally needs an override.

---

## Tools available to the agent

| Tool | Action set | Purpose |
|---|---|---|
| `ctx_search` | n/a | Search memories + raw session history; returns ranked results with previews |
| `ctx_memory` | `write`, `delete` | Manage project memories explicitly (most writes happen via dreamer instead) |
| `ctx_note` | `read`, `write`, `update`, `dismiss` | Defer intentions for later — surfaced via note nudges at work boundaries |
| `ctx_expand` | `start`/`end`, `message`, `verbose` | Recover complete messages or expand a compressed conversation range |
| `ctx_reduce` | `drop` | Queue tagged turns for cache-safe removal from the live context |

`ctx_note`, `ctx_expand`, and `ctx_reduce` are session-scoped and are exposed in primary Pi/OMP sessions. Magic Context omits them from ephemeral `--no-session` child processes, where they would otherwise target the hidden child session; `ctx_reduce` is additionally omitted when compaction is disabled.

---

## Architecture & implementation

This package is part of the [magic-context monorepo](https://github.com/cortexkit/magic-context). Pi and OMP share the same adapter layer and core implementation:

| Pi-specific module | Responsibility |
|---|---|
| `context-handler.ts` | Pi `pi.on("context", ...)` adapter — tags, drops, runs nudges and auto-search |
| `subagent-runner.ts` | Re-invokes the current Pi/OMP host with `--print --mode json --no-session`; resolves relative allowlisted extensions from plain Pi's `~/.pi/agent` or an identified OMP host's active agent directory; and applies per-agent tool isolation |
| `tools/` | Pi `pi.registerTool` wrappers around the shared tool implementations |
| `commands/` | Pi `pi.registerCommand` wrappers for the five `/ctx-*` slash commands |
| `dreamer/` | Pi-side adapter for the shared dreamer scheduler |
| `system-prompt.ts` | Pi `before_agent_start` injector for `<session-history>`, `<project-memory>`, `<project-docs>` |
| `config/` | Shared CortexKit config loader with legacy Pi migration fallback |

The unified [`@cortexkit/magic-context`](https://www.npmjs.com/package/@cortexkit/magic-context) CLI exposes separate `pi` and `omp` setup/doctor pipelines while both use this runtime adapter.

For deeper architectural detail, see the main repo's [ARCHITECTURE.md](https://github.com/cortexkit/magic-context/blob/master/ARCHITECTURE.md).

---

## License

MIT — see [LICENSE](https://github.com/cortexkit/magic-context/blob/master/LICENSE).
