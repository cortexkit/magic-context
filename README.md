<h1 align="center">Magic Context</h1>

<p align="center">
  <strong>Unbounded context. Memory that manages itself. One session, for life.</strong><br>
  The hippocampus for coding agents, part of CortexKit.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@cortexkit/magic-context"><img src="https://img.shields.io/npm/v/@cortexkit/magic-context?label=cli&color=orange&style=flat-square" alt="npm @cortexkit/magic-context"></a>
  <a href="https://www.npmjs.com/package/@cortexkit/opencode-magic-context"><img src="https://img.shields.io/npm/v/@cortexkit/opencode-magic-context?label=opencode&color=blue&style=flat-square" alt="npm @cortexkit/opencode-magic-context"></a>
  <a href="https://www.npmjs.com/package/@cortexkit/pi-magic-context"><img src="https://img.shields.io/npm/v/@cortexkit/pi-magic-context?label=pi&color=purple&style=flat-square" alt="npm @cortexkit/pi-magic-context"></a>
  <a href="https://discord.gg/DSa65w8wuf"><img src="https://img.shields.io/discord/1488852091056295957?style=flat-square&logo=discord&logoColor=white&label=Discord&color=5865F2" alt="Discord"></a>
  <a href="https://github.com/cortexkit/magic-context/stargazers"><img src="https://img.shields.io/github/stars/cortexkit/magic-context?style=flat-square&color=yellow" alt="stars"></a>
  <a href="https://github.com/cortexkit/magic-context/blob/master/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT License"></a>
</p>

<p align="center">
  <em>You don't hire a developer for one task and fire them when they ship.<br>Stop doing it to your agent.</em>
</p>

<p align="center">
  <a href="#what-is-magic-context">What is Magic Context?</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#part-of-cortexkit">CortexKit</a> ·
  <a href="#-context-management">Context</a> ·
  <a href="#-capture">Capture</a> ·
  <a href="#-consolidate">Consolidate</a> ·
  <a href="#-recall">Recall</a> ·
  <a href="https://discord.gg/DSa65w8wuf">💬 Discord</a>
</p>

---

## What is Magic Context?

You don't hire a developer to fix one bug and fire them the moment it ships. You keep the good ones. They learn the codebase, remember why decisions were made, and get sharper every week.

Coding agents work the opposite way. Every task is a fresh hire with no memory of your project, and at the end of each session you fire them and start from zero. Mid-task they even hit "compaction" pauses that break the flow and quietly drop what they knew. It is anterograde amnesia, the same thing that happens when the hippocampus is damaged.

Magic Context gives them one. It is the **hippocampus** for coding agents, the part of the brain that forms memories, consolidates them, and recalls them, entirely in the background. One session stops being a disposable contractor and becomes a long-term teammate who was there for the whole project:

- **Capture.** As the historian compresses your history, it lifts the durable knowledge (decisions, constraints, conventions) into project memory. You get a memory system for free, from work you are already doing.
- **Consolidate.** Overnight, a dreamer agent does what sleep does for you: it merges duplicates, verifies memories against the codebase, retires the stale, and promotes what recurs.
- **Recall.** The right memories surface automatically every turn, and the agent can search across memories, past conversations, and git history on demand. Across sessions, and across OpenCode and Pi.

Two promises: your agent **never stops to manage its context** (no compaction pauses, no broken flow) and it **never forgets**.

Run one session per project and keep it going for weeks, months, or years. It remembers everything you've built together.

---

## Quick start

Run the interactive setup wizard. It detects your models, configures everything, and handles compatibility.

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.ps1 | iex
```

**Or run directly (any OS):**
```bash
npx @cortexkit/magic-context@latest setup
```

The wizard auto-detects which harnesses you have (OpenCode, Pi, or both), adds the plugin, disables built-in compaction, helps you pick models for the historian, dreamer, and sidekick, and resolves conflicts with other context-management plugins. Target a specific harness with `--harness opencode` or `--harness pi`.

> **Why disable built-in compaction?** Magic Context manages context itself. The host's compaction would interfere with its cache-aware deferred operations and double-compress.

**Manual setup** (OpenCode): add the plugin and turn compaction off in `opencode.json`, then drop a `magic-context.jsonc` in your project root. See the [configuration reference](./CONFIGURATION.md).

```jsonc
{
  "plugin": ["@cortexkit/opencode-magic-context"],
  "compaction": { "auto": false, "prune": false }
}
```

**Pi:** `npx @cortexkit/magic-context@latest setup --harness pi` (requires Pi `>= 0.74.0`). The Pi extension shares the same database as OpenCode; project memories and embeddings pool across both.

**Troubleshooting:** `npx @cortexkit/magic-context@latest doctor` auto-detects your harnesses, checks for conflicts (compaction, OMO hooks, DCP), verifies the plugin and TUI sidebar, runs an integrity check on the database, and fixes what it can. Add `--issue` to file a ready-to-submit bug report.

### Adding Magic Context to an existing project

Magic Context is not limited to greenfield work. Run the setup wizard from the root of the project you already use with OpenCode or Pi, then restart the harness in that same directory so the plugin can attach to the existing project identity. From that point forward, new turns are captured automatically and the historian compartmentalizes the active session as it grows.

Magic Context does **not** retroactively import or reprocess OpenCode or Pi sessions that happened before it was installed. Those past conversations are not backfilled into compartments. What builds up across an existing project from day one includes project memories, dreamer-maintained docs, key files, and other context captured after installation.

If you want to seed knowledge from older work, add the important facts explicitly with `ctx_memory`, write a short project note in the repo, or keep working in the project and let the historian and dreamer promote recurring facts over time. Use `/ctx-recomp` when you need to rebuild Magic Context compartments from raw message history that Magic Context has captured in that session, such as after upgrading historian rules; it is not an importer for unrelated pre-install OpenCode or Pi sessions. The dashboard can also inspect the shared CortexKit database, memories, compartments, and dreamer runs without starting a coding session.

<details>
<summary><strong>Compatibility with other context-management plugins</strong></summary>

<br>

Magic Context owns context management end to end, so it **disables itself** if another plugin is already doing that job. Running two context managers at once would double-compress your history and thrash the prompt cache. On startup it checks for the following; setup and `doctor` help you resolve each, and until they're resolved Magic Context stays off (fail-safe) and tells you why:

- **OpenCode built-in compaction** (`compaction.auto` / `compaction.prune`) — Magic Context replaces it. Setup turns it off.
- **DCP** (`opencode-dcp`) — a separate context-pruning plugin. The two cannot run together; remove it from your `plugin` list.
- **oh-my-opencode (OMO)** — setup offers to disable the three hooks that overlap:
  - `preemptive-compaction` — triggers compaction that conflicts with the historian.
  - `context-window-monitor` — injects usage warnings that overlap with Magic Context's nudges.
  - `anthropic-context-window-limit-recovery` — triggers emergency compaction that bypasses the historian.

Run `npx @cortexkit/magic-context@latest doctor` any time to re-check and auto-fix.

</details>

---

## Part of CortexKit

A brain isn't one organ. Neither is a capable coding agent.

**CortexKit** is a family of plugins, each modeled on a different region of the brain. Install one and your agent gets sharper. Install all three and it has a brain.

| Plugin | Region | What it does |
|---|---|---|
| **Magic Context** *(you are here)* | Hippocampus & medial temporal lobe | Self-managing context and long-term memory. Keeps sessions running with no compaction pauses while it forms, consolidates, and recalls project knowledge across them. |
| **[AFT](https://github.com/cortexkit/aft)** | Sensorimotor cortex | Perceives code structure and acts on it precisely. A proper IDE and OS for your agent. |
| **Alfonso** *(coming soon)* | Prefrontal cortex | Executive control. Plans, decomposes work, chooses agents and models, and decides when to ask, verify, and commit. |

Magic Context is **1 of the 3 plugins you'll ever need.** It remembers; AFT perceives and acts; Alfonso decides. They share one CortexKit store, so memory pools across harnesses and tools.

---

## ⚡ Context management

*An unbounded session that manages itself.* The context window fills up as you work, and the usual fix, compaction, stops the agent cold to re-read everything. Magic Context handles it continuously in the background, so the session just keeps going.

- **Historian compartmentalization**: a background historian compresses old raw history into **tiered compartments**, chronological summaries that stand in for older messages. Each carries an importance score, so the live window stays small without losing the thread. Summarizing doesn't need your primary's coding muscle, so you can run the historian on a cheap or even fully local model while your main agent stays top-tier.
- **Decay rendering**: compartments render at the right fidelity for the moment, by a deterministic, no-LLM rule that self-tunes to the model's context window. Old history fades gracefully instead of dropping off a cliff, and because it is deterministic, the same history always renders the same way.
- **The agent hints what to drop, or it doesn't**: with agent-driven reduction on, the agent calls `ctx_reduce` to mark stale tool outputs or long messages for removal. Drops are **queued and cache-aware**, applied only at cache-safe moments so reduction never thrashes the cache. Switch it off and the agent stays out of context management entirely: stale output is shed automatically by age, with optional caveman compression of the oldest text.
- **Cache-stable layout**: all of this is structured so background work never invalidates the cached prefix of your prompt. Your cache survives the whole session.

The result: one session runs for months, with no compaction pauses and low cost on cache-priced providers. You can watch it happen in OpenCode's TUI, where a live sidebar shows the context breakdown by source, historian status, and memory counts, updating after every message.

> *Optional (off by default):* **caveman text compression** progressively compresses the oldest user and assistant text by a deterministic age-tiered rule, for sessions that run with agent-driven reduction off.

---

## 🧠 Capture

*Memory, for free.* To compress your history, the historian has to read all of it. So in the same pass it lifts out the knowledge worth keeping forever, decisions, constraints, conventions, config values, and promotes it into **project memory**, categorized and carried into every future session. Your memory builds itself from the work you are already doing.

The agent can also record memories explicitly, though most are captured automatically for it:

- **`ctx_memory`**: write or delete cross-session knowledge directly, in a small category taxonomy (`PROJECT_RULES`, `ARCHITECTURE`, `CONSTRAINTS`, `CONFIG_VALUES`, `NAMING`).

```
ctx_memory(action="write", category="ARCHITECTURE", content="Event sourcing for orders.")
```

> **Temporal awareness** *(on by default)* gives the agent a sense of time, with gap markers like `+2h 15m` between messages and dated compartments, so it can reason about how long ago something happened. Set `temporal_awareness: false` to turn it off.

---

## 🌙 Consolidate

*What sleep does for memory.* An optional **dreamer** agent runs overnight to keep memory quality high, spinning up ephemeral child sessions for each task:

- **Consolidate**: merge semantically similar memories into canonical facts.
- **Verify**: check memories against the current codebase (paths, configs, patterns).
- **Archive stale**: retire memories about removed features or old paths.
- **Improve**: rewrite verbose memories into terse, operational form.
- **Maintain docs**: keep `ARCHITECTURE.md` and `STRUCTURE.md` current from codebase changes.
- **User memories**: promote recurring observations about how you work (communication style, review focus, working patterns) into a `<user-profile>` that travels with every session.
- **Smart notes**: evaluate deferred notes whose `surface_condition` has come true and surface the ready ones.

Because it runs during idle time, the dreamer pairs well with local models, even slow ones. Nobody is waiting. Trigger a run any time with `/ctx-dream`.

---

## 🔎 Recall

*The right memory at the right moment.* Every turn, active project memories and the compacted session history are injected automatically and cache-stably. On demand, the agent reaches for:

- **`ctx_search`**: one query across three layers at once: project **memories**, raw **conversation** history, and indexed **git commits**. Semantic embeddings with full-text fallback.

  ```
  ctx_search(query="why did we pick event sourcing for orders")
  ```

- **`ctx_expand`**: pull a compressed history range back to the original `U:`/`A:` transcript when the agent needs the exact details.
- **`ctx_note`**: a scratchpad for deferred intentions. Notes resurface at natural boundaries (after commits, after historian runs, when todos finish). **Smart notes** carry an open-ended condition the dreamer watches for.

Recall works **across sessions** (a new session inherits everything) and **across harnesses** (write a memory in OpenCode, retrieve it in Pi).

> **Auto search hints** *(on by default)* run a background `ctx_search` each turn and whisper a "vague recall" when something relevant exists — like almost remembering a note you took. It appends only compact fragments, never full content; set `memory.auto_search.enabled: false` to turn it off. **Git commit indexing** *(opt-in)* makes your project history semantically searchable as a fourth `ctx_search` source — enable with `memory.git_commit_indexing.enabled: true`.

### Agent tools at a glance

| Tool | Section | What it does |
|------|-------|-------------|
| `ctx_reduce` | Context | Queue stale tagged content for removal, cache-aware |
| `ctx_memory` | Capture | Write or delete durable cross-session memories |
| `ctx_search` | Recall | Search memories, conversation history, and git commits |
| `ctx_expand` | Recall | Decompress a history range back to the transcript |
| `ctx_note` | Recall | Deferred intentions and dreamer-evaluated smart notes |

---

## Commands

| Command | Description |
|---------|-------------|
| `/ctx-status` | Debug view: tags, pending drops, cache TTL, nudge state, historian progress, compartment coverage, history budget |
| `/ctx-flush` | Force all queued operations immediately, bypassing cache TTL |
| `/ctx-recomp` | Rebuild compartments from raw history (accepts a `start-end` range). Use when stored state seems wrong |
| `/ctx-session-upgrade` | Upgrade this session to the latest history format: rebuild compartments and migrate project memories |
| `/ctx-aug` | Run sidekick augmentation on a prompt: retrieve relevant memories via a separate model |
| `/ctx-dream` | Run dreamer maintenance on demand: consolidate, verify, archive, improve |

---

## Desktop app

A companion desktop app for browsing and managing Magic Context state outside the terminal.

<p align="center">
  <a href="https://github.com/cortexkit/magic-context/releases"><strong>⬇️ Download for macOS · Windows · Linux</strong></a>
</p>

- **Memory browser**: search, filter, and edit project memories by category and project.
- **Session history**: browse compartments and notes for any session with timeline navigation.
- **Cache diagnostics**: real-time cache hit/miss timeline and bust-cause detection.
- **Dreamer management**: view dream-run history, trigger runs, inspect task results.
- **Configuration editor**: form-based editing for every setting, including model fallback chains.
- **Log viewer**: live-tailing logs with search.

It reads directly from Magic Context's SQLite database. No extra server, no API. Auto-updates built in.

---

## Configuration

Settings live in `magic-context.jsonc`. Everything has sensible defaults; project config merges on top of user-wide settings. See **[CONFIGURATION.md](./CONFIGURATION.md)** for the full reference: cache TTL tuning, per-model execute thresholds, historian and dreamer model selection, embedding providers, and memory settings.

**Config locations** (merged in order, project overrides user):
1. `<project-root>/magic-context.jsonc`
2. `<project-root>/.opencode/magic-context.jsonc`
3. `~/.config/opencode/magic-context.jsonc`

---

## Storage

All durable state lives in a local SQLite database under the shared CortexKit store (`~/.local/share/cortexkit/magic-context/context.db`, XDG-equivalent on Windows; legacy OpenCode-folder databases are migrated forward on first boot). If the database can't be opened, Magic Context disables itself and notifies you. Memories are keyed to a **stable project identity** derived from the repo, so they follow a project across worktrees, clones, and forks rather than being tied to a directory path.

Magic Context also writes to a few other locations:

| Path | What | Persistence |
|---|---|---|
| `~/.local/share/cortexkit/magic-context/context.db` | SQLite database — tags, compartments, memories, all durable state (XDG-equivalent on Windows) | **Must persist.** Losing it loses your memory/history. |
| `~/.local/share/cortexkit/magic-context/models/` | Local embedding model cache (~90 MB `Xenova/all-MiniLM-L6-v2` ONNX), downloaded on first use when local embeddings are enabled | Should persist, else re-downloaded each run. Not used when `memory.enabled: false` or an `openai_compatible`/`ollama` embedding backend is configured. |
| `${TMPDIR}/opencode/magic-context/magic-context.log` (`pi/` for Pi) | Diagnostic log | Disposable. |

**Sandboxed / ephemeral environments (Docker, CI, disposable containers):** mount the `~/.local/share/cortexkit/magic-context/` directory on a persistent volume so the database and model cache survive between runs. If only the model cache is ephemeral, the model is simply re-downloaded; if the database is ephemeral, memory and history don't accumulate. To avoid the ~90 MB model download entirely, set `memory.enabled: false` or point `embedding` at a remote `openai_compatible`/`ollama` backend.

---

## Star History

<a href="https://www.star-history.com/?repos=cortexkit%2Fmagic-context&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&legend=top-left" />
 </picture>
</a>

---

## Development

**Requirements:** [Bun](https://bun.sh) ≥ 1.0

```sh
bun install         # Install dependencies
bun run build       # Build the plugin
bun run typecheck   # Type-check without emitting
bun test            # Run tests
bun run lint        # Lint (Biome)
bun run format      # Format (Biome)
```

Dream execution requires a live OpenCode server (the dreamer creates ephemeral child sessions). Use `/ctx-dream` inside OpenCode for on-demand maintenance.

---

## Contributing

Bug reports and pull requests are welcome. For larger changes, open an issue first to discuss the approach. Run `bun run format` before submitting; CI rejects unformatted code.

---

## License

[MIT](LICENSE)
