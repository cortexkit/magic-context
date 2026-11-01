---
title: Dreamer
description: The off-hours maintenance agent that verifies memory against code, curates the memory pool, and keeps project documentation current.
---

The dreamer is an optional background agent that runs during idle time to maintain memory quality and project documentation. It spins up ephemeral child sessions, each focused on one maintenance task.

## When it runs

Each dreamer task runs on its **own cron schedule** — there is no single dreamer "run." A process-wide timer checks every task's schedule and runs the ones that are due. You can also trigger a run manually at any time with `/ctx-dream` (all enabled tasks) or `/ctx-dream <task>` (one specific task, run immediately).

Schedules are standard 5-field cron expressions, or `""` to disable a task:

| Cron | Meaning |
|------|---------|
| `0 3 * * *` | Every day at 3:00 AM (the default for verification) |
| `0 4 * * 0` | Every Sunday at 4:00 AM (the default for curation) |
| `0 */6 * * *` | Every 6 hours |
| `0 * * * *` | Every hour |
| `""` | Disabled (still runnable manually via `/ctx-dream <task>`) |

:::tip
The dreamer pairs well with local or inexpensive models. Nobody is waiting — it runs while you sleep or work on something else.
:::

## The tasks

The dreamer has these tasks, each independently scheduled:

| Task | Default | What it does |
|------|---------|-------------|
| **map-memories** | nightly | Map each memory to the project files that back it (or mark it file-independent), so verify knows what to re-check. Mostly a one-time backfill, then a cheap trickle for new memories. |
| **verify** | nightly | Re-verify only the memories whose mapped files changed since *that memory* was last checked, and fix or remove stale facts. |
| **verify-broad** | weekly | Re-verify the entire mapped pool against code, ignoring the change gate, to catch drift the incremental pass cannot see. It opens a persisted verification cycle and drains it across scheduled runs, so a timeout keeps the remaining memories for the next run. |
| **curate** | weekly | Curate the whole active memory pool: consolidate duplicates, tighten wording, and archive low-value or redundant entries. |
| **compress-cues** | nightly when mural enabled | Compress each project memory into a short mural cue (content-hash cached). Feeds the [memory mural](/concepts/mural/). |
| **classify-memories** | daily | Score memory importance, scope, and shareability so recall stays focused. |
| **retrospective** | daily | Learn from moments you had to correct or re-explain, and record the durable lesson. |
| **maintain-docs** | off | Keep `ARCHITECTURE.md` and `STRUCTURE.md` at the project root synchronized with codebase changes. |
| **evaluate-smart-notes** | nightly | Check whether any smart-note conditions (`ctx_note` with a surface condition) have come true and surface the ready ones. |
| **review-user-memories** | nightly | Promote recurring behavioral observations into your `<user-profile>` (privacy-sensitive — see below). |
| **promote-primers** | nightly | Promote recurring standing questions the historian noticed into durable primers. |
| **refresh-primers** | nightly | Re-investigate stale primers against current code and refresh their answers. |

Each task has its own schedule, an optional per-task model override (falling back to the dreamer-level model), and a timeout (default: 20 minutes). `map-memories`, `verify`, `verify-broad`, `curate`, `classify-memories`, `retrospective`, and the primer tasks share the per-project memory lease so they never collide; the others run independently. `verify-broad` records its open cycle and resumes from the remaining backlog after a timeout or partial run. `compress-cues` is gated by `mural.enabled`, writes cues per memory, and resumes from missing or stale cues; the mural image itself is rendered on demand at a context fold, not by a scheduled `render-mural` task.

`verify` and `verify-broad` use their configured `timeout_minutes` as the run deadline in OpenCode, Pi, and Oh My Pi. Each batch gets the larger of four minutes or an equal share of the time remaining across the batches left, always capped by the time remaining. A new batch needs at least 30 seconds left to start.

Configure all of this under `dreamer.tasks` in `magic-context.jsonc`, or visually in the dashboard config editor.

## Privacy: retrospective learning

The **retrospective** task is default-on but cheap: it first scans only new typed user messages since its last successful run for correction/re-explanation patterns. If there is no friction signal, it records a clean run without starting a child session. On a hit, a ctx_search-only child agent analyzes the host-rendered window and emits XML learnings; the host validates and applies them. Project lessons become normal project memories, and user-behavior observations are only collected when `review-user-memories` is scheduled.

## Privacy: user-memory review

The **review-user-memories** task is privacy-sensitive. When scheduled, the historian extracts behavioral observations about how you work — communication style, review focus, working patterns — and this task reviews those candidates with a multi-session recurrence gate, promoting recurring patterns to stable user memories that inject into every session as a `<user-profile>` block.

:::caution
This task captures observations about your behavior. It only runs when you explicitly schedule it (set its schedule to `""` to turn it off, which is honored across upgrades).
:::

## Documentation maintenance

The maintain-docs task reads your codebase and writes or updates two files at the project root:

- **`ARCHITECTURE.md`** — layers, data flows, entry points, and key abstractions.
- **`STRUCTURE.md`** — directory layout, naming conventions, and where to add new code.

When `dreamer.inject_docs` is true (the default), these files inject into the conversation so the agent always has current architectural context. The dreamer checks `git log` since the last run to focus on what changed.

## Cost and model selection

The dreamer uses your configured dreamer model (and any `fallback_models` you set) and reads your codebase during verification and doc maintenance. Each task spawns a child session with its own context window. Budget accordingly — when several tasks come due together, each is a separate run.

Because it runs during idle time, the dreamer is a good fit for local models, even slow ones. Configure the default model in `magic-context.jsonc` under `dreamer.model`, or override it per task with `dreamer.tasks.<task>.model`.

## Circuit breaker

The dreamer aborts remaining tasks after three consecutive identical-error failures, surfacing a circuit-breaker entry in the run history. This prevents a misconfigured model or broken environment from burning through the full task suite.

## How it connects

The dreamer maintains the [project memory](/concepts/memory/) that the [historian](/concepts/historian/) builds. It runs on a schedule independent of your sessions. Its output feeds back into the [context pipeline](/concepts/overview/) — better memories mean better recall, and maintained docs mean the agent always has current architecture context.
