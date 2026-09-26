---
title: Commands
description: Slash commands to inspect Magic Context, flush queues, rebuild or wrap up history, and run dreamer.
---

You run these slash commands in your harness chat or command box. They execute in the plugin, not in the model. Names are registered as `ctx-status`, `ctx-flush`, `ctx-recomp`, `ctx-wrapup`, `ctx-dream`, and `ctx-embed` (type them with a leading `/`).

## Is something stuck?

1. **`/ctx-status`** — Pending queue, cache TTL, tags, historian state. Start here.
2. **`/ctx-flush`** — Apply queued context operations now (usually pending drops).
3. **`/ctx-recomp`** — Rebuild compartments from raw history with the historian model; slow on long sessions. Use `/ctx-recomp <start>-<end>` for a partial range when only part of the timeline is wrong.
4. **`/ctx-wrapup [messages_to_keep]`** — Deliberately compact older live history while keeping the newest N messages raw.

Use **`/ctx-recomp`** to rebuild compartments left in an older history layout; the `/ctx-recomp --upgrade` flag is deprecated and does nothing on its own. If `compaction.enabled` is `false`, `/ctx-recomp`, `/ctx-wrapup`, and `/ctx-flush` refuse instead of changing compacted history; status, recall, and embedding commands remain available.

## /ctx-status

**What it does.** Session status: context pressure and its breakdown by category, tags, reductions, pending queue, cache TTL, history compression, and memory. It takes no arguments — there is one view, the same on every harness.

**When to use it.** Whenever you need a snapshot of Magic Context health.

**What you'll see.**

- **OpenCode TUI (1 and 2):** Opens a **native status dialog** (full report is not pasted into chat).
- **OpenCode Desktop:** `## Magic Status` message in chat.
- **Pi:** **Status overlay** when UI is available; otherwise a `/ctx-status` chat message.

## /ctx-flush

**What it does.** Force-processes pending Magic Context operations for this session and refreshes injection caches. Changes apply on the **next** model message.

**When to use it.** `/ctx-status` shows pending drops that have not applied, or you do not want to wait for TTL/threshold.

**What you'll see.** `Flushed: N dropped. Changes take effect on next message.` or `No pending operations to flush.` On Pi, a `/ctx-flush` message (requires an active session).

## /ctx-recomp

**What it does.** Rebuilds compartments from raw history — structure only. Recomp never writes memories or facts, so your curated project memory is untouched. Partial runs snap your range to compartment boundaries.

**When to use it.** Wrong or missing summaries/facts, or deliberate rebuild after historian config changes.

| Argument | Meaning |
| --- | --- |
| (none) | Full rebuild to the protected tail. |
| `<start>-<end>` | Partial rebuild, e.g. `/ctx-recomp 1-11322`. |
| `--upgrade` | Deprecated — run `/ctx-recomp` with no arguments. |

:::caution
Uses historian-model tokens; full recomp on long sessions can take a long time.
:::

**What you'll see.**

- **OpenCode TUI:** Confirmation **dialog** for `/ctx-recomp` (typed range args are not wired through the dialog yet).
- **OpenCode Desktop:** **Double-tap** — warning first, same command within **60 seconds** confirms. Partial recomp previews the snapped range.
- **Pi:** Same double-tap confirmation; recomp runs **in the background** with `/ctx-recomp` progress messages. Partial ranges work on the command line.

## /ctx-wrapup

**What it does.** Runs the historian forward over older live history now. By default it keeps the newest **20 messages** raw (counting every message: yours, the assistant's, and tool results) and wraps everything older into compartments; pass a positive integer to keep a different number, e.g. `/ctx-wrapup 40`. The cut never splits an in-flight tool exchange and prefers to land on one of your messages, so the actual kept count can be slightly higher.

**When to use it.** Before switching from a large-context model to a smaller one, or when a long session has grown and you want to compact it on purpose instead of waiting for pressure triggers. A model switch already creates the cache-busting pass that materializes queued wrapup compartments, so you do **not** need `/ctx-flush` before switching models.

**What you'll see.** It reports how many messages and compartments were wrapped. The compacted history is queued and materializes on the next model message that busts context. If there is no natural bust pending and you want the queued compacted history applied on the very next message, run `/ctx-flush` first; `/ctx-flush` marks the next pass as busting, it does not reduce the current context synchronously. OpenCode TUI shows a **Wrapup** progress bar; Pi shows per-chunk status messages.


## /ctx-dream

**What it does.** Runs **dreamer** tasks for this project immediately. `/ctx-dream` (no argument) runs every enabled task whose activity gate passes; `/ctx-dream <task>` force-runs one task (e.g. `/ctx-dream verify` or `/ctx-dream curate`), ignoring its gate and schedule.

**When to use it.** A manual run instead of waiting for a task's cron schedule, or to force a single task on demand.

**What you'll see.** `Starting dream run...` (or `Running dream task "<task>"...`), followed by a backlog snapshot with pending/total counts. The final `## /ctx-dream` report lists tasks that ran, were skipped (no work), failed, or were busy, plus backlog at run start and run end when available.

## /ctx-embed

**What it does.** Shows embedding coverage, or controls the background embedding of this session's history compartments for semantic search.

- `/ctx-embed` — status: the active embedding model, and how many of this session's compartments, the project's memories, and git commits are embedded.
- `/ctx-embed start` — embed all of this session's still-missing history compartments in one pass (idempotent and resumable; retries transient provider failures and skips past ones it can't embed).
- `/ctx-embed pause` — pause an in-progress run.

Magic Context also auto-embeds the active session's missing compartments in the background, so you usually only need this to check status or to drive a backfill manually. Requires an embedding provider (or the built-in local model) that is not `off`; it does not depend on `memory.enabled`. The background auto-embed is silent: it posts nothing into the timeline.

**When to use it.** After changing your embedding model (which re-embeds under the new model), or to check whether `/ctx-search` semantic recall covers this session's older history.

**What you'll see.** On OpenCode TUI, a status dialog (and a live **Embed** progress bar in the sidebar while a run is active); on Desktop/Web, a text status. On Pi, a status message.
