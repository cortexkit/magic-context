---
title: Memory
description: How project memory captures durable knowledge across sessions, and how the agent and historian write, recall, and maintain it.
---

Project memory is durable cross-session knowledge that Magic Context injects into every turn. It captures the decisions, constraints, and conventions that matter long after the conversation that produced them has been compressed away.

## The 5 categories

Every memory belongs to one of five categories:

| Category | What it captures | Example |
|----------|-----------------|---------|
| **PROJECT_RULES** | Process and workflow rules for this repo | "All PRs require at least one approval before merge." |
| **ARCHITECTURE** | Load-bearing design decisions and why they hold | "Event sourcing for orders because audit trail is a hard requirement." |
| **CONSTRAINTS** | Hard limits imposed by external systems | "GitHub API rate limit is 5000 requests/hour for authenticated calls." |
| **CONFIG_VALUES** | Stable configuration keys, values, and conventions | "execute_threshold_percentage defaults to 65 and accepts per-model overrides." |
| **NAMING** | Naming conventions and canonical names | "Use kebab-case for all CLI command names." |

## How memories get written

Memories come from two sources:

**Agent writes.** Your agent calls `ctx_memory` to record a fact directly:

```text
ctx_memory(action="write", category="ARCHITECTURE", content="Event sourcing for orders.")
```

The agent can write and delete memories. Other actions (update, merge, archive) are available to the dreamer and the dashboard.

**Historian promotion.** When the [historian](/concepts/historian/) compresses a chunk of conversation, it extracts durable facts in the same 5-category taxonomy. Promotable facts are deduplicated against existing memories and inserted automatically. Most memories in a mature project come from historian promotion — the memory builds itself from work you're already doing.

## Memory statuses

Each memory has one of three statuses:

- **active** — the normal state. Active memories inject into the prompt.
- **permanent** — pinned. Permanent memories are protected from archival by the dreamer.
- **archived** — soft-deleted. Archived memories don't inject but remain in the database with provenance.

You can set a memory to permanent through the dashboard or the desktop app. The dreamer uses archive to retire stale memories.

## How memories inject

Active memories render into a `<project-memory>` block that the agent sees every turn. The injection has a token budget (default: 4,000 tokens, configurable via `memory.injection_budget_tokens`, enough for roughly 150 memories). When the budget is tight, lower-priority memories are trimmed. Memories render as compact `#id: fact` lines grouped under one category tag, so the block stays small even on mature projects with large memory pools. Memory ids stay visible so `ctx_memory` actions keep working unchanged.

Memories are ordered by category priority, then by recency within each category. Memories already visible in the rendered session history are filtered from search results to avoid duplication.

When the text budget trims memories away, the optional [memory mural](/concepts/mural/) can attach a single image of those overflow memories to the cached context baseline (vision models only).

## Retrieval-count promotion

Each memory tracks how many times the agent has retrieved it via `ctx_search`. Memories with higher retrieval counts are more likely to be kept during dreamer maintenance — they've proven useful. Memories with zero retrievals and low seen counts are candidates for archival.

## Importance classification

The dreamer's **classify-memories** task scores each memory on importance, scope, and shareability. Importance orders which memories survive the injection budget; scope keeps recall focused on what this project actually needs; and shareability controls whether a memory is safe to pool across workspace members. Scoring moves off the wire entirely (it only orders what survives the budget), so background re-classification never busts the prompt cache.

## Workspaces

A **workspace** groups multiple project repos so their project memories pool across member sessions — useful for multi-repo microservice setups where the same constraints and architecture decisions apply across services. Create a workspace in the [dashboard](/reference/dashboard/), add member projects, and choose which memory categories are shared (CONSTRAINTS only, by default). Shared visibility is read-only: member projects can read shared categories from neighbors, but only the owning project can update, archive, or merge its own memories. A malformed `share_categories` list fails closed to sharing nothing rather than accidentally sharing everything.

## Editing memories

The desktop app and dashboard provide a memory browser where you can search, filter, and edit project memories by category and project. Changes made outside the session signal running sessions to refresh their memory injection on the next cache-safe pass.

## Project-scoped and shared

Memories are scoped to a **project identity** derived from the repository, not a filesystem path. This means memories follow a project across worktrees, clones, and forks. The same SQLite database is shared by OpenCode, Pi, and OMP — write a memory in one harness, retrieve it in another.

## How it connects

The [historian](/concepts/historian/) is the primary memory writer. The [dreamer](/concepts/dreamer/) maintains memory quality overnight — consolidating duplicates, verifying against code, archiving stale entries, and improving wording. [Context reduction](/concepts/context-reduction/) keeps the live window small so memories carry the durable knowledge forward.
