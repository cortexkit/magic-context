# Magic Context System — Design Specification

**Date:** 2026-03-04
**Status:** Design complete, council-reviewed, ready for implementation
**Branch:** Current feature branch (replaces trial `context-drop` code, which was never pushed)

---

## Background

We analyzed the DCP plugin (`@tarquinen/opencode-dcp` at `/Users/ufukaltinok/work/OSS/opencode-dynamic-context-pruning`) and designed a superior magic context system. This document captures ALL design decisions.

### What exists today (dev branch)
- `context-window-monitor.ts` — single nudge at 70% context usage (STAYS AS-IS)
- Preemptive compaction at 78% (STAYS AS-IS, safety net)
- Limit recovery at 100% (STAYS AS-IS, safety net)
- No context-drop tools on dev (trial branch never pushed)

### What DCP does differently
- Three automatic strategies (dedup, supersede-writes, purge-errors) — zero LLM cost
- `compress` tool for message-range summarization (agent writes summary as tool arg)
- Heavy nudging system (4 tiers: system prompt, context-limit, turn, iteration)
- Message-level `<dcp-message-id>mNNNN</dcp-message-id>` XML tagging
- Model-specific synthetic part injection (Claude/DeepSeek get fake tool parts)

---

## Opt-In Design

The entire system is **opt-in**. When disabled (default), nothing changes — the existing compaction layers work exactly as before.

```jsonc
{
  "magic_context": {
    "enabled": true,                              // default: false
    "compression_model": "anthropic/claude-haiku-4.5",  // REQUIRED when enabled
    "cache_ttl": "5m",                            // default for all providers, configurable per-model
    "protected_turns": 5,                         // last N user/assistant turns un-droppable
    "compression_budget": {
      "ratio": 0.3,                               // summary ≈ 30% of original
      "max_tokens": 4096                           // hard cap
    }
  }
}
```

`cache_ttl` can also be per-model:
```jsonc
{
  "magic_context": {
    "cache_ttl": {
      "default": "5m",
      "anthropic/claude-sonnet-4-5": "5m",
      "anthropic/claude-opus-4-6": "1h"    // Max plan
    }
  }
}
```

When `enabled: true`:
- `context_compress` and `context_recall` tools are registered
- §N§ tagger activates in `messages.transform`
- Cache-aware scheduler activates
- Nudging at 45/55/65% activates
- System prompt instructions are injected
- `context-window-monitor` hook is auto-disabled (our nudging subsumes it)

When `enabled: false` (default):
- No tools registered for magic context
- No §N§ tags injected
- No nudging beyond existing 70% context-window-monitor
- Zero overhead

---

## Design Decisions (ALL AGREED)

### 1. Tagging Format: `§N§`

**Format:** `§1§`, `§42§`, `§187§` — section sign + bare integer + section sign

- **Council validated** (8/8 models agreed on § prefix; we added closing § for safety)
- **Token cost:** 3-4 tokens per tag
- **Collision:** Zero risk — `§N§` never appears in code, terminal output, JSON, XML, YAML, markdown
- **Single unified counter** for both tool outputs AND messages — no separate namespaces
- **Same §N§ persists through state changes** — whether a message is original, summarized, or dropped, its §N§ stays the same
- **Agent references by bare integer** in tool calls: `context_compress({ drop: "3-5" })` not `context_compress({ drop: "§3§-§5§" })`
- **Counter resets on compaction** — after `session.compacted`, counter resets to 0 since the entire conversation context is replaced

### 2. Injection Approach: `messages.transform` ONLY (UI Transparency)

**ALL modifications happen exclusively in `messages.transform`.** Zero `tool.execute.after` usage.

This means:
- **User sees clean conversation** — no §N§ tags, no drop placeholders, no summary replacements, no nudge messages
- **LLM sees modified view** — §N§ tags, drops, summaries, nudges
- **UI is completely transparent** — as if magic context doesn't exist

What gets modified in transform:
- Messages: prepend `§N§` to content
- Tool outputs: prepend `§N§` to output text
- Dropped items: replace content with `[dropped §N§]`
- Summarized items: replace content with the precomputed summary
- Nudges: append to last message when threshold conditions met

**Why:** No model-specific branching, no stored artifacts, no hallucination stripping. The session store is never modified.

### 3. Tool Design: `context_compress`

Single tool with two optional params:

```typescript
context_compress({
  drop: "3-5",        // range or comma-separated: "3-5", "1,2,9", "1-5,8,12-15"
  summarize: "1,2,9"  // same syntax
})
```

- Either param is optional — drop-only, summarize-only, or both
- Returns ACK: "Queued: drop §3§-§5§, summarize §1§,§2§,§9§. Will execute at optimal time."
- **Does NOT execute immediately** — queues operations for cache-aware scheduling

### 4. Per-Message Summaries (NOT range summaries)

`summarize: "1,2,9"` produces 3 independent summaries, not one combined block.

**Why:**
- Granular lifecycle — each summary can be independently dropped/recalled later
- Trivial conflict resolution — dropping §7§ from a summarize list just removes it
- Batching still preserves context — cheap model sees all messages in one call
- Agent mental model stays simple: every §N§ is one atom

### 5. Separate Compression Model (REQUIRED config)

- User MUST configure `compression_model` when enabled
- The working model does NOT write summaries (unlike DCP)
- Agent just specifies what to compress; the cheap model generates summaries
- **Fallback chain (internal):** configured compression model → main working model. No agent involvement — fallback is transparent.

### 6. Precompute Summaries Immediately

When agent queues a summarize operation:
1. Immediately batch-send messages to compression model
2. Store precomputed summaries in SQLite
3. Apply them later when cache-aware scheduler decides

**No staleness concern** — messages being summarized are immutable history.

**Batch for cost efficiency:**
- One API call with all messages vs N individual calls
- System prompt overhead paid once (saves ~500 tokens × N)
- One round-trip vs N round-trips (latency: ~500ms vs N×300ms)

**On compaction:** Invalidate any in-flight precompute operations (simple cancellation, no debounce/retry logic).

### 7. Cache-Aware Deferred Execution (NOVEL)

**Core insight:** Don't execute magic context immediately. Queue operations and execute at the optimal time based on prompt cache TTL.

| Condition | Action |
|-----------|--------|
| Cache expired (time since last response > TTL) | Execute all pending ops — FREE, no cache to break |
| Context > 75% (approaching preemptive compaction at 78%) | Execute regardless — survival trumps cache |
| Context < 75% AND cache still warm | Defer — keep the cache |
| New user message after cache expiry | Perfect moment — execute before processing |
| Model/provider switch detected | Flush immediately — cache is invalidated anyway |

**Cache TTL config:** Default `"5m"` for all providers. Configurable per-model. This is a best-effort heuristic — actual server-side cache state is unverifiable, but the conservative default minimizes cache waste.

Track `lastApiResponseTimestamp` from events.

### 8. Conflict Resolution

Later operations override earlier ones for overlapping items:

```
Agent call 1: context_compress({ summarize: "5-10" })
Agent call 2: context_compress({ drop: "7" })
```

Result: Summarize 5-6, 8-10 (excluding 7). Drop 7 entirely.
If summary was already precomputed including 7, invalidate and re-precompute excluding 7.

### 9. Recall: Messages Only, Not Tools

- **Summarized messages** → can be recalled via `context_recall`
- **Dropped tool outputs** → no recall needed, agent re-runs the tool

**`context_recall` spec:**
```typescript
context_recall({ id: "5" })  // single ID only
```
- Returns original message content from `recalls` table
- **Does NOT restore to original position** — content is injected at the bottom of the conversation (restoring to original position would break prompt cache)
- Only works for summarized messages; returns error for dropped tool outputs
- Summary in transform remains replaced (the recalled content appears as new context at the bottom)

### 10. Protected Content

- Last N **user/assistant turns** are un-droppable (configurable via `protected_turns`, default: 5)
- A "turn" = one user message + one assistant response (including all tool calls/outputs within)
- If agent tries to drop/summarize protected content, return error explaining why

### 11. No Token Size Hints in Nudges

- Do NOT show actual token/byte counts per message in nudges
- Showing sizes would bias agent toward dropping large-but-valuable content
- Instead, hint the 3 largest items by §N§ ID (agent knows they're big, not HOW big)

### 12. Nudging System

Three tiers, each fires **once per session** (max 3 nudges total). Injected in `messages.transform` — invisible to user.

**~45% (Gentle):**
> Context at ~45%. Consider dropping tool outputs you've already acted on. Largest: §5§, §12§, §3§.

**~55% (Moderate):**
> Context at ~55%. Recommend compressing — drop old tool outputs, summarize completed exploration. Largest: §5§, §12§, §3§.

**~65% (Urgent):**
> Context at ~65%. Compress now to avoid automatic compaction. Largest: §5§, §12§, §3§.

Above 65%, the existing compaction layers (preemptive at 78%, limit recovery at 100%) serve as safety nets.

**Note:** When magic_context is enabled, the `context-window-monitor` hook is auto-disabled since our nudging subsumes its 70% reminder.

**Size tracking:** `byte_size` column in `tags` table. Uses raw byte length of content as approximation — no tokenizer needed, sufficient for ranking top 3.

### 13. Subagent Sessions

Skip tagging entirely. Subagents are short-lived, separate sessions — no magic context needed.

**Detection:** Track `parentID` from `session.created` events. If `parentID` exists, the session is a subagent — skip all magic context transforms.

### 14. Compression Token Budget

Auto-calculate: `max_tokens = min(input_tokens * 0.3, 4096)`
- Summary should be ~30% of original, capped at 4K tokens
- Configurable override in config

### 15. System Prompt Injection

**Always inject when `enabled: true`** (~150 tokens). Injected via context injection system.

```
## Magic Context

Messages and tool outputs are tagged with §N§ identifiers (e.g., §1§, §42§).

Use `context_compress` to manage context proactively:
- `drop`: Remove content entirely. Best for tool outputs you've already acted on — re-run if needed later.
- `summarize`: Condense to key points. Best for long research, old exploration, or executed plans.
- Syntax: "3-5", "1,2,9", or "1-5,8,12-15" (bare integers).
- Last 5 turns are protected.

Operations execute at optimal time automatically. Don't wait for warnings — compress early and often.
```

### 16. Tool Description (Simple)

Tool descriptions are kept minimal — the system prompt handles detailed usage guidance.

**context_compress:**
```
Compress context by dropping or summarizing tagged messages/tool outputs.
Use §N§ identifiers visible in conversation. Both params accept ranges: "3-5", "1,2,9", "1-5,8".
```

**context_recall:**
```
Recall original content of a summarized message. Content is injected at the end of conversation.
Only works for summarized messages — dropped tool outputs should be re-run instead.
```

### 17. Context Usage Tracking

To determine nudge thresholds (45/55/65%), we need context usage percentage. Tracked from API response token usage via event handlers (verify exact event name during implementation — likely `message.updated` with `finish: true`).

---

## Storage: SQLite (`.sisyphus/context.db`)

First SQLite usage in the codebase. Uses `bun:sqlite` (built-in, no npm dependency). WAL mode for concurrent reads.

Single database with session-scoped tables:

| Table | Purpose |
|-------|---------|
| `tags` | §N§ → message_id mapping, type (tool/message), status (active/summarized/dropped), `byte_size` for ranking |
| `pending_ops` | Queued drop/summarize operations with timestamps |
| `summaries` | Precomputed summaries keyed by §N§ |
| `recalls` | Original message content for recall (persistent) |
| `session_meta` | last_response_time, cache_ttl, counter state, nudge state per session |

---

## Compaction Integration

### Current oh-my-opencode compaction layers (ALL STAY AS-IS):
1. **Context Window Monitor** (70%) — warns agent (auto-disabled when magic_context enabled)
2. **Preemptive Compaction** (78%) — auto-triggers OpenCode's `client.session.summarize()`
3. **Limit Recovery** (100% / error) — aggressive truncation + summarize retry

### Our system's relationship:
- **Goal:** Prevent reaching layer 2 and 3 entirely
- **Safety:** Keep all existing layers as fallback
- **Flush queue at 75%:** Execute all pending ops before preemptive compaction hits at 78%
- **On `session.compacted` event:** Reset §N§ counter, clear pending queue, clear in-memory state, invalidate in-flight precomputes, keep recall data in SQLite

### Compaction context injection:
- Inject compressed summaries into `experimental.session.compacting` → `output.context`
- So compaction agent's summary preserves info about previously compressed messages

---

## Architecture Overview

```
User UI: Clean conversation (no tags, no drops, no summaries, no nudges)
                    │
                    │ (original messages stored in session)
                    ▼
┌─────────────────────────────────────────────────────┐
│              messages.transform                       │
│                                                       │
│  0. Skip if subagent (parentID check)                │
│  1. Inject §N§ tags (tagger)                         │
│  2. Check scheduler → apply pending drops/summaries  │
│  3. Check thresholds → inject nudge if needed        │
│                                                       │
│  Result: Modified message array sent to LLM          │
└──────────────────────┬────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────┐
│           LLM sees:                   │
│  §1§ user msg → §2§ assistant →      │
│  §3§ [dropped] → §4§ [summary:...]   │
│  + nudge at bottom if threshold met   │
│                                       │
│  Agent calls: context_compress(...)   │
└──────────────────────┬────────────────┘
                       │
                       ▼
┌──────────────────────────────────────┐
│         context_compress tool         │
│                                       │
│  Parses ranges → queues to           │
│  pending_ops → triggers precompute   │
│  for summarize ops → returns ACK     │
└──────────────────────┬────────────────┘
                       │
              ┌────────▼─────────┐
              │  Precompute      │──→ Compression model API
              │  Engine          │    (fallback: main model)
              │  (summaries)     │    (batched, immediate)
              └────────┬─────────┘
                       │
              ┌────────▼─────────┐
              │  Cache-Aware     │
              │  Scheduler       │
              │                  │
              │  Cache expired?  │──→ Execute pending ops
              │  Context > 75%?  │──→ Execute pending ops
              │  Otherwise?      │──→ Defer
              └──────────────────┘
```

---

## File Plan

### New Files (14)

| File | Purpose |
|------|---------|
| `src/config/schema/magic-context.ts` | Zod schema: `MagicContextConfigSchema` |
| `src/features/magic-context/index.ts` | Barrel exports |
| `src/features/magic-context/types.ts` | All type definitions |
| `src/features/magic-context/storage.ts` | SQLite CRUD for all tables (`bun:sqlite`, WAL mode) |
| `src/features/magic-context/tagger.ts` | §N§ counter + tag assignment |
| `src/features/magic-context/precompute.ts` | Batch summarization via compression model (fallback: main model) |
| `src/features/magic-context/scheduler.ts` | Cache-aware execution decisions |
| `src/features/magic-context/compaction.ts` | session.compacted handler + context injection |
| `src/tools/context-compress/index.ts` | Barrel exports |
| `src/tools/context-compress/tools.ts` | `context_compress` + `context_recall` tools |
| `src/tools/context-compress/types.ts` | Tool argument types |
| `src/tools/context-compress/constants.ts` | Tool descriptions, range parsing |
| `src/hooks/magic-context/index.ts` | Barrel exports |
| `src/hooks/magic-context/hook.ts` | Hook factory: messages.transform (tagger + transformer + nudger) + event handler |

### Modified Files (6)

| File | Change |
|------|--------|
| `src/config/schema/oh-my-opencode-config.ts` | Add `magic_context` field |
| `src/config/schema/hooks.ts` | Add `"magic-context"` to HookNameSchema |
| `src/plugin/tool-registry.ts` | Conditionally register context-compress tools when enabled |
| `src/plugin/hooks/create-session-hooks.ts` | Create magic-context hook when enabled; auto-disable context-window-monitor when enabled |
| `src/plugin/messages-transform.ts` | Add magic-context to transform chain |
| `src/index.ts` | Inject compaction context when enabled |

### No Deletions
Context-drop trial code on this branch will be replaced, but since it was never pushed to dev, this is effectively new code from dev's perspective.

---

## Implementation Order

```
1. Config schema
2. Types + Storage (SQLite)
3. Tagger (§N§ counter)
4. Tool (context_compress + context_recall)
5. Precompute engine
6. Scheduler (cache-aware)
7. Hook (messages.transform: tagger + transformer + nudger + events)
8. Compaction integration
9. Wiring (tool registry, hook creation, transform chain, plugin entry)
```

---

## Council Review Summary

Design reviewed by 8-model council (2026-03-04). Key findings and resolutions:

| Finding | Resolution |
|---------|------------|
| §N§ counter reset collision concern | Keep reset — compaction replaces entire context, old IDs are gone |
| "Phantom-drop" (deferred drops confuse agent) | Not a problem — ACK explicitly says "will execute at optimal time" |
| 70% nudge overlaps with context-window-monitor | Changed nudge thresholds to 45/55/65%; auto-disable monitor when enabled |
| SQLite is novel dependency | Accepted — `bun:sqlite` is built-in, no npm dep, better fit for multi-table use |
| Cache TTL unverifiable | 5m default for all providers, configurable per-model |
| Precompute race conditions | Simple invalidation on compaction, no debounce/retry |
| context_recall unspecified | Fully specified: returns original, injects at bottom, summarized messages only |
| byte_size as token proxy | Acceptable for v1 — ranking, not precision |
| Protected messages ambiguous | Defined as user/assistant turns, configurable |
| Subagent detection missing | parentID check from session.created events |
| Event name uncertain | Verify during implementation (likely message.updated) |
| Compression model fallback | Internal chain: compression model → main working model. No agent involvement |

Full council archive: `.sisyphus/athena/council-magic-context-design-audit-5aa28a9a413b1035/`

---

## References
- DCP plugin: `/Users/ufukaltinok/work/OSS/opencode-dynamic-context-pruning/`
- Prompt caching docs: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Current context-window-monitor: `src/hooks/context-window-monitor.ts`
- Current compaction layers: `src/hooks/preemptive-compaction.ts`, `src/hooks/compaction-context-injector/`, `src/hooks/anthropic-context-window-limit-recovery/`
