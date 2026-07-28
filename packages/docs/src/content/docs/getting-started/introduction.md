---
title: Introduction
description: What Magic Context is, why it exists, and what changes for your coding agent when you install it.
---

Every coding agent session starts from zero. No memory of last week's decisions, no recall of why you chose a particular architecture, no awareness of what happened before the current context window. When the window fills up, the agent pauses for compaction — a lossy operation that discards detail and breaks your flow. Then you start another session and it starts from zero again.

Magic Context supports [OpenCode](https://opencode.ai), [Pi](https://github.com/earendil-works/pi-mono), and [Oh My Pi](https://github.com/can1357/oh-my-pi). It gives your agent persistent memory and a context window that manages itself — silently, in the background, without ever stopping the session.

## What changes

**Sessions can run for weeks.** A background historian agent reads the older part of your conversation, compresses it into tiered compartments, and promotes durable knowledge (decisions, constraints, conventions) into project memory — all while you keep working. The raw history is never thrown away; the agent can expand any compartment back to the original transcript on demand via `ctx_expand`.

**The next session already knows your project.** Project memories persist across sessions and all three harnesses. Start a new OpenCode, Pi, or OMP session on the same project and those memories are injected automatically. Your agent remembers what was decided, and why.

**Full recall is always available.** The agent can search across memories, compressed session history, and indexed git commits in one call with `ctx_search`. Nothing is lost — it is compressed and indexed, not discarded.

**Context management runs on its own schedule.** Drops are queued and applied only when it is safe to do so without invalidating the provider's prompt cache. There are no compaction pauses, no manual intervention, and no broken flow.

## Who it is for

Magic Context is designed for developers using **OpenCode** (CLI, TUI, or Desktop), **Pi** (>= 0.74.0), or **OMP** (>= 17.1.7). If you run long or recurring sessions on a project — debugging a codebase for weeks, building a feature over many sessions — it is especially useful.

## What it is not

Magic Context is not a RAG indexer. It does not crawl your repository or build a vector index of your source files. The memories it creates come from your actual conversation history. It also does not provide or replace a language model — it runs background agents using whichever models you configure, separate from your primary coding session.

## Part of CortexKit

Magic Context is one of three CortexKit plugins, each modeled on a region of the brain. It covers memory and context (hippocampus). [AFT](https://github.com/cortexkit/aft) covers code perception and action (sensorimotor cortex). They share one store, so memory and tool use pool across harnesses.

---

Next: [Installation](/getting-started/installation/)
