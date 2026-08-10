---
title: FAQ
description: Answers to common questions about Magic Context, privacy, data storage, and configuration.
---

## Does Magic Context send my code anywhere?

No. All durable state — messages, compartments, memories — is stored in a local SQLite database at `~/.local/share/cortexkit/magic-context/context.db`. Nothing is sent to any Magic Context server.

The background historian and dreamer agents run as subagents using **your configured model providers**. When they run, your session content is sent to those providers (the same way your primary coding session already sends to them). Magic Context does not introduce any new data recipients beyond the model providers you have already chosen.

Semantic embeddings use the `embedding.provider` setting. The default is `"local"` — the embedding model runs in-process using `Xenova/all-MiniLM-L6-v2`, which never sends data anywhere. If you configure an `openai-compatible` endpoint, embedding queries go to that endpoint only.

## What does it cost to run?

Magic Context is prompt-cache-aware — all context mutations are timed to not invalidate your provider's cached prefix. In practice this means less re-billing of your cached history across turns.

The historian and dreamer agents make their own model calls using whichever models you configure. They have no per-token cost when idle — the historian only runs on a compression event, not every turn. For background work that bills per request rather than per token (e.g. a GitHub Copilot subscription), pointing these agents at such a model keeps their cost flat.

For most sessions, historian costs are modest: it processes a batch of messages once per compression event, not on every turn.

## Can I turn things off?

Yes. Most features have explicit toggles. See the [configuration reference](/reference/configuration/) for all keys.

| Feature | Config key | Default |
|---|---|---|
| Memory (cross-session) | `memory.enabled` | `true` |
| Auto-search hints | `memory.auto_search.enabled` | `true` |
| Temporal markers | `temporal_awareness` | `true` |
| Dreamer scheduling | `dreamer.disable`, `dreamer.tasks.<task>.schedule` | enabled; task schedules vary |
| Embeddings | `embedding.provider` | `"local"` |

To hide agent-driven reduction for a specific agent, deny or omit `ctx_reduce` in that agent's tool allow-list. The historian and heuristic cleanup still run.

## Where is my data stored?

All Magic Context state lives in one place:

```
~/.local/share/cortexkit/magic-context/context.db
```

On Windows, this resolves to the XDG-equivalent path. The database is shared by OpenCode, Pi, and OMP — memories and compartments are scoped by harness and project, not by which terminal you use.

The local embedding model cache (if using `embedding.provider: "local"`) is stored at:

```
~/.local/share/cortexkit/magic-context/models/
```

This is about 90 MB and is downloaded on first use. It can be safely deleted — it will be re-downloaded the next time an embedding is needed.

## Can I edit or delete memories?

Yes.

- **Via the agent:** Ask the agent to call `ctx_memory` with `action="write"` (add) or `action="archive"` (retire). This works in any session.
- **Via the dashboard:** The [desktop app](https://github.com/cortexkit/magic-context/releases) has a memory browser that lets you search, filter, edit, and bulk-delete memories.

Memories are scoped to a project (identified by git root commit hash). Deleting a memory removes it from all future sessions on that project.

## Why doesn't my token count drop after I cross the execute threshold?

This is usually working as intended. The execute threshold is not a "compact to a lower number" button — it triggers the historian to compress **older conversation** and applies any drops the agent already queued. It does **not** drop **tool outputs** (file reads, search results, command output) on its own.

Tool outputs are reclaimed two ways: the agent calling `ctx_reduce` to mark spent ones (the normal path), or the **tiered emergency drop at 85%** (the safety net). Between 65% and 85% there is no automatic tool-output reduction. So a session whose bulk is tool calls — and whose model isn't actively calling `ctx_reduce` — will see the historian run while the percentage parks in the 65–85% range.

Check the token breakdown in the TUI sidebar or `/ctx-status`: if **Tool Calls** dominates, the lever is `ctx_reduce` (or waiting for 85%), not the threshold. The full model is documented in [Context reduction → Why your token count can stay high](/concepts/context-reduction/#why-your-token-count-can-stay-high-after-the-threshold).

## What happens when context hits 85% or 95%?

Magic Context's execute threshold is configurable from 20% through **90%** (default: 65% of the model's usable context window). When usage crosses it, the system runs heuristic cleanup and applies any queued `ctx_reduce` drops, and the historian compresses settled conversation into compartments. The usable window is resolved from the active harness's model/provider metadata and can be narrowed by a smaller observed limit or by `output_reserve`.

At **85%**, a tiered emergency drop sheds tool outputs oldest-first (this is the automatic backstop for tool output that `ctx_reduce` didn't reach). At **95%**, the session blocks new messages and runs emergency recovery — a last resort that normal operation rarely reaches.
You can check the current state with `/ctx-status` and force a flush with `/ctx-flush`.

## How does it work with subagents?

When your primary agent spawns a subagent, Magic Context gives the subagent lighter treatment: memories are still injected, but the subagent does not have the full `ctx_reduce` guidance and does not trigger historian runs. This is intentional — subagents are short-lived and do not accumulate the kind of history that benefits from compartmenting.

The historian and dreamer themselves run as subagents. They are configured separately and do not see the `ctx_reduce` tooling — they have their own focused prompts.

## Can I use Magic Context across multiple machines?

Not currently. The database is local to one machine. Memories, compartments, and session history do not sync between machines.

If you work across machines, you can manually copy `~/.local/share/cortexkit/magic-context/context.db` between them — they share the same schema and project identity (git root hash), so memories written on one machine will appear on the other after a copy. There is no automatic sync.

## Can I move a session from OpenCode to Pi or OMP?

Yes. `doctor migrate` converts an existing OpenCode session into a Pi-compatible session file, carrying messages, compartments, and session facts with it. Project memories are already shared (same database, no migration needed).

```bash
npx @cortexkit/magic-context@latest doctor migrate \
  --from opencode --to pi --session <session-id>
```

Use `--to omp` for OMP. Add `--dry-run` to preview without writing, or `--max-messages N` to migrate only the most recent N messages. See [Migrating between harnesses](/getting-started/migrating-between-harnesses/) for the full walkthrough. Reverse migration is not yet supported.

## The dashboard shows no models / I'm on OpenCode Desktop only

The dashboard's model pickers merge cached provider model lists refreshed in the background. Discovery is never exhaustive — you can always type a model id directly even when a discovered list is present. On OpenCode Desktop-only installs (no CLI alongside), the model list may be empty until you run a session once; type the model id (e.g. `claude-sonnet-4-6`) directly into the picker.

## Do memories from OpenCode appear in Pi?

Yes. Project memories are stored in the shared database scoped by project identity (git root commit hash), not by harness. A memory written in an OpenCode session appears in the next Pi session for the same project, and vice versa.

Per-session state (compartments, tags, session facts) is scoped to the originating harness and session.

## What is the database format?

SQLite. The schema is managed by Magic Context's migration system and is upgraded automatically when you update the plugin. You can open and inspect it with any SQLite tool, but do not write to it directly — the schema may change between versions.

The [desktop dashboard](https://github.com/cortexkit/magic-context/releases) provides a UI for viewing and editing the data that is safe to use.
