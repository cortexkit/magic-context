# Cross-Session Memory System — Design Document

**Date:** 2026-03-17
**Status:** Prototyped, validated through experiments, Oracle-reviewed
**Prototype location:** `local-ignore/memory-prototype/`

---

## Problem Statement

AI coding agents forget everything between sessions. Each new session rediscovers the same architecture decisions, user preferences, constraints, and codebase patterns. The magic-context system already manages within-session context, but knowledge dies when the session ends.

## Goals

1. Persist important knowledge across sessions so new sessions start with project context
2. Let agents retrieve relevant memories on demand during sessions
3. Optionally augment the user's first message with intelligent context retrieval
4. Optionally run overnight "dreaming" to maintain, verify, and improve memory quality

## Non-Goals (for now)

- Multi-user shared memory
- Cloud-synced memory across machines
- Real-time collaboration memory

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│                    Magic Context Plugin                    │
│                                                            │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │  Session      │  │  Cross-      │  │  Dreamer       │  │
│  │  Context      │  │  Session     │  │  (Phase 3)     │  │
│  │  (existing)   │  │  Memory      │  │                │  │
│  │              │  │  (Phase 1-2) │  │  Overnight     │  │
│  │  compartments │  │              │  │  processing    │  │
│  │  session_facts│  │  memories    │  │  code verify   │  │
│  │  session_notes│  │  embeddings  │  │  consolidation │  │
│  │  tags         │  │  FTS5 index  │  │  codebase map  │  │
│  └──────────────┘  └──────────────┘  └────────────────┘  │
│         │                  │                  │            │
│         └──────────┬───────┘──────────────────┘            │
│                    │                                       │
│              Single SQLite DB                              │
│          (currently context.db)                             │
└──────────────────────────────────────────────────────────┘
         │                    │                    │
    ┌────┴────┐         ┌────┴────┐         ┌────┴────┐
    │Historian│         │Sidekick │         │Dreamer  │
    │(existing)│        │(Phase 2)│         │(Phase 3)│
    │writes    │        │local or │         │overnight│
    │session   │        │remote   │         │local LLM│
    │facts     │        │LLM      │         │+ fs     │
    └─────────┘        └─────────┘         └─────────┘
```

## Storage Schema

All tables live in the existing magic-context SQLite database (single DB, no split).

### Core Tables (Phase 1)

```sql
-- Cross-session memories promoted from session facts
CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_path TEXT NOT NULL,           -- normalized absolute path, '__global__' for global
  category TEXT NOT NULL,               -- ARCHITECTURE_DECISIONS, CONSTRAINTS, etc.
  content TEXT NOT NULL,                -- the actual memory text
  normalized_hash TEXT NOT NULL,        -- deterministic hash of normalized content for fast dedup
  source_session_id TEXT,               -- which session this was first extracted from
  source_type TEXT DEFAULT 'historian', -- historian | agent | dreamer | user
  seen_count INTEGER DEFAULT 1,        -- incremented when historian re-extracts the same fact
  retrieval_count INTEGER DEFAULT 0,   -- incremented only on agent ctx_memory search lookups
  first_seen_at INTEGER NOT NULL,      -- timestamp of first extraction
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,       -- last time historian re-extracted this fact
  last_retrieved_at INTEGER,           -- last time agent actively retrieved this memory
  status TEXT DEFAULT 'active',        -- active | permanent | archived
  expires_at INTEGER,                  -- NULL = no TTL expiry
  verification_status TEXT DEFAULT 'unverified', -- unverified | verified | stale | flagged
  verified_at INTEGER,                 -- last code-verification timestamp (Phase 3)
  superseded_by_memory_id INTEGER,     -- points to newer memory that replaced this one
  merged_from TEXT,                    -- JSON array of merged memory IDs
  metadata_json TEXT,                  -- extensible JSON for future fields
  UNIQUE(project_path, category, normalized_hash)
);

-- Indexes for common query patterns
CREATE INDEX idx_memories_project_status_category ON memories(project_path, status, category);
CREATE INDEX idx_memories_project_status_expires ON memories(project_path, status, expires_at);
CREATE INDEX idx_memories_project_category_hash ON memories(project_path, category, normalized_hash);

-- FTS5 full-text index (secondary, for keyword search fallback)
-- Custom tokenizer preserves technical tokens: dots, underscores, slashes, hyphens
CREATE VIRTUAL TABLE memories_fts USING fts5(
  content, category,
  content='memories', content_rowid=id,
  tokenize='porter unicode61 categories "L* N* Co"'
);

-- Embedding vectors stored as BLOBs (separate table per Oracle recommendation)
CREATE TABLE memory_embeddings (
  memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL              -- Float32Array as raw bytes (384 dims = 1536 bytes)
);

-- FTS sync triggers
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, category) VALUES (new.id, new.content, new.category);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, category) VALUES ('delete', old.id, old.content, old.category);
END;
CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, category) VALUES ('delete', old.id, old.content, old.category);
  INSERT INTO memories_fts(rowid, content, category) VALUES (new.id, new.content, new.category);
END;
```

### Dream State Table (Phase 3)

```sql
CREATE TABLE dream_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Keys: last_dream_at, last_dream_git_head, last_dream_session_cursor,
--        last_dream_summary, codebase_map_hash, dreaming_lease_holder,
--        dreaming_lease_heartbeat, dreaming_lease_expiry
```

## Memory Categories

### Lifetime Rules

| Category | Default Scope | Lifetime | Auto-Promote |
|---|---|---|---|
| ARCHITECTURE_DECISIONS | project | permanent | yes |
| CONSTRAINTS | project | permanent | yes |
| CONFIG_DEFAULTS | project | permanent | yes |
| NAMING | project | permanent | yes |
| USER_PREFERENCES | global | permanent | yes |
| USER_DIRECTIVES | global | permanent | yes |
| ENVIRONMENT | project | permanent (stable facts) | yes |
| WORKFLOW_RULES | project | 90-day TTL | yes |
| KNOWN_ISSUES | project | 30-day TTL | yes |
| SESSION_NOTES | never promote | never promote | no |

### Promotion Criteria

A session fact is promoted to cross-session memory when:
1. Its category is in the auto-promote list above, AND
2. It doesn't duplicate an existing memory (checked by `normalized_hash`), AND
3. It was extracted by historian during a normal compartment run

Dedup on the write path uses deterministic `normalized_hash` (fast, no embedding inference). Semantic similarity is only used during dreamer consolidation and `ctx_memory search` retrieval.

Agent-initiated writes and deletes: the `ctx_memory` tool allows explicit write/delete/search by the agent or user at any time.

### Seen vs Retrieved Counts (Oracle refinement)

Two counters track different signals:
- **`seen_count`**: incremented when historian re-extracts the same fact in a later session. Indicates the fact is being repeatedly discovered, suggesting durability.
- **`retrieval_count`**: incremented only when the agent actively searches for and retrieves this memory via `ctx_memory(action="search", ...)`. Indicates the fact is actively useful.

Permanence promotion keys off `retrieval_count >= 3`, not `seen_count`. A fact that gets re-extracted 10 times but never retrieved may just be noise. A fact retrieved 3 times is proven useful.

---

## Retrieval Layers

### Layer 1: Auto-Injection (Phase 1, every new session)

On the first transform call for a new session:
1. Load all project-scoped + global memories from the DB (status = active or permanent)
2. Order by category priority: USER_DIRECTIVES > USER_PREFERENCES > NAMING > CONFIG_DEFAULTS > CONSTRAINTS > ARCHITECTURE_DECISIONS > ENVIRONMENT > WORKFLOW_RULES > KNOWN_ISSUES
3. Format as `<project-memory>` XML block with category sections
4. Inject into the message transform, budget-capped (configurable, default ~4000 tokens)
5. Skip for subagent/background sessions

**Deterministic selective injection** (when memory exceeds ~80% of budget):
- Always inject pinned categories: USER_DIRECTIVES, USER_PREFERENCES, NAMING, top CONSTRAINTS
- Fill remaining budget with semantic top-K from the first user message, with per-category caps
- No sidekick LLM needed — deterministic selection using embeddings

At current scale (79 memories = ~2400 tokens), this injects everything. The budget cap and selective injection are safety valves for growth.

### Layer 2: Agent Search Tool — `ctx_memory(action="search", ...)` (Phase 1)

A tool the agent can call mid-session to search memories:
- Input: natural language query string
- Execution: hybrid retrieval — semantic top-N (embedding cosine) plus exact-token bonus from FTS5 overlap
- Output: top N results with category, content, and relevance score
- `retrieval_count` incremented on each result returned (not `seen_count`)

### Layer 3: Sidekick Agent (Phase 2, optional)

A configurable LLM agent that runs at session start to augment the user's first message with targeted memory search. The sidekick has different latency requirements than the dreamer and uses a different model config.

**Flow:**
1. User sends first message
2. Sidekick receives the message + access to `search_memory` tool
3. Sidekick makes 1-3 targeted semantic searches
4. Sidekick writes a context briefing
5. Briefing is injected alongside or instead of raw auto-injection

**Configuration:**
```jsonc
{
  "magic_context": {
    "sidekick": {
      "enabled": false,
      "provider": "local",          // "local" | "lmstudio" | "cerebras" | "openai-compatible"
      "model": "qwen3.5-9b",       // model identifier — needs fast inference
      "endpoint": "http://localhost:1234/v1",
      "api_key": "",
      "max_tool_calls": 3,
      "timeout_ms": 30000
    }
  }
}
```

**Provider options (validated by prototype):**

| Provider | Model | Speed | Quality | Cost |
|---|---|---|---|---|
| Local (LM Studio) | Qwen 3.5 0.8B | ~6s | Poor (hallucinates) | Free |
| Local (LM Studio) | Nemotron 4B | ~15s | Good | Free |
| Local (LM Studio) | Qwen 3.5 9B | ~15-35s | Very good | Free |
| Remote (Cerebras) | Qwen 3 235B | ~2s | Excellent | API cost |

**Minimum recommended:** 4B+ for no-hallucination, 9B+ for reliable structured output.

**Note:** Oracle recommends skipping the sidekick entirely in favor of deterministic selective injection (Layer 1). The sidekick remains in the design as an optional enhancement for users who want LLM-powered augmentation, but Phase 1's deterministic path should be sufficient for most use cases.

### Layer 4: FTS5 Keyword Search (fallback + hybrid component)

Used in two ways:
- **Hybrid retrieval** for `ctx_memory search`: FTS5 exact-token scores are combined with embedding cosine similarity for better precision on technical terms (paths, config keys, symbol names)
- **Standalone fallback**: when embeddings are unavailable (provider = "off")
- **Category browsing**: admin tools and `/ctx-status` display

The FTS5 tokenizer is configured to preserve technical tokens (`.`, `_`, `/`, `-`) that the default tokenizer would split.

---

## Embedding System

### Model

- **Library:** `@huggingface/transformers` (pure JS/WASM, Bun-compatible)
- **Model:** `Xenova/all-MiniLM-L6-v2` (22MB quantized q8)
- **Dimensions:** 384
- **Speed:** 79 memories in 0.1s (cached), ~10ms per query
- **Known weakness:** weaker on exact symbols, file paths, and config keys than on prose — mitigated by hybrid FTS5 retrieval

### Storage

Embeddings stored as raw `Float32Array` BLOBs in separate `memory_embeddings` table.
384 dimensions * 4 bytes = 1,536 bytes per memory.
1000 memories = ~1.5MB of embedding storage.

### Embedding Lifecycle (Oracle refinement: lazy initialization)

- **Do NOT load the embedding model during plugin init.** The plugin has a tight startup budget.
- Lazy-init the model on first semantic use (first `ctx_memory search` call or first selective injection)
- Warm the model in background after first session starts
- New memory inserted → enqueue embedding job (run after historian transaction commits)
- Memory content updated → re-embed
- Memory deleted → cascade deletes embedding row
- All embeddings loaded into memory on first semantic use for fast cosine similarity
- At 1000+ memories, if full-scan latency is noticeable, add ANN index or per-project shard cache

**Critical: never run embedding inference inside the historian write transaction.** Let `replaceAllCompartmentState()` commit first, then enqueue promotion + embedding as a post-commit job.

### Alternative Providers (configurable, future)

Following Memorix's provider pattern:
- `fastembed` (ONNX native, BAAI/bge-small-en-v1.5)
- `api` (remote OpenAI-compatible endpoint)
- `off` (FTS5 only, no embeddings)

Default: `@huggingface/transformers` (zero external deps, works everywhere).

Benchmark `bge-small-en-v1.5` against MiniLM on a fixed eval set if symbol/path lookups stay weak.

---

## Historian Integration (Phase 1)

### Promotion Pipeline (Oracle refinement: decouple from historian transaction)

After `replaceAllCompartmentState()` commits successfully:

1. Read the newly written session facts (post-commit, not inside the transaction)
2. For each fact in an auto-promotable category:
   a. Compute `normalized_hash` from lowercase-trimmed content
   b. Check for existing memory with same `project_path + category + normalized_hash`
   c. If duplicate: update `last_seen_at`, increment `seen_count` (NOT `retrieval_count`)
   d. If new: insert into `memories` with `seen_count=1`, enqueue embedding job
3. Embedding jobs run asynchronously after promotion completes

This is rule-based, not an additional LLM call. Dedup uses deterministic hash matching on the write path, not semantic similarity (which is too expensive for every historian run).

### What Changes in Historian

Nothing. The historian prompt and runner are unchanged. Promotion happens after historian output is validated and persisted, as a post-processing step.

---

## Dreamer System (Phase 3)

### Concept

An overnight background process that maintains and improves memory quality using a local LLM with filesystem access. Runs during a user-configured schedule window (e.g., 02:00-06:00) when no coding sessions are active.

The dreamer has zero latency pressure — it can run large models (35B+) slowly and still process everything overnight. This is fundamentally different from the sidekick, which needs sub-second inference.

### Inspiration

Human memory consolidation during sleep: replay experiences, strengthen important connections, let weak ones decay, integrate new knowledge with existing understanding.

### Schedule & Activation

```jsonc
{
  "magic_context": {
    "dreaming": {
      "enabled": false,
      "schedule": "02:00-06:00",       // time range in local time
      "model": "qwen3.5-32b",          // local model — larger is better, no latency pressure
      "endpoint": "http://localhost:1234/v1",
      "max_runtime_minutes": 120,       // hard stop per run
      "tasks": ["decay", "consolidate", "mine", "verify", "git", "map"]
    }
  }
}
```

### Activation Conditions

- Current time is within `schedule` window
- No active OpenCode sessions (checked via session meta)
- Last dream was >20 hours ago (prevent multiple runs per day)
- LLM endpoint is reachable (for tasks that need it)

### Model Recommendations

The dreamer benefits from larger models because it has hours, not seconds. Documentation should recommend:
- **Minimum:** 9B for basic cleanup, consolidation, and session mining
- **Recommended:** 32B-35B for reliable code verification and git insight generation
- **Ideal:** 70B+ for high-quality codebase map generation and architectural analysis

Users choose their own tradeoff between model quality and overnight compute cost.

### Dream Session Flow

All tasks are independently configurable via the `tasks` array. Users can start with just `["decay", "consolidate"]` (no LLM needed) and progressively enable more as they validate quality.

```
Dream Session (scheduled window)
│
├── 1. ORIENT (no LLM, ~2 min)
│   ├── git log --since="last dream" → commit delta
│   ├── scan opencode.db for new messages since last_dream_session_cursor
│   ├── scan context.db for new compartments/facts since last dream
│   ├── count memories by status and category
│   └── build prioritized work queue
│
├── 2. DECAY & CLEANUP (no LLM, ~2 min)  [task: "decay"]
│   ├── expire memories past their TTL (KNOWN_ISSUES after 30d, WORKFLOW_RULES after 90d)
│   ├── promote memories with retrieval_count >= 3 to permanent status
│   ├── archive memories not retrieved in 180 days (unless permanent)
│   └── update memory stats
│
├── 3. CONSOLIDATE (embeddings only, ~5 min)  [task: "consolidate"]
│   ├── load all memory embeddings
│   ├── find near-duplicate pairs with category-specific thresholds:
│   │   ├── CONFIG_DEFAULTS, NAMING, USER_DIRECTIVES: cosine > 0.95 (near-exact)
│   │   ├── CONSTRAINTS, ARCHITECTURE_DECISIONS: cosine > 0.90
│   │   └── KNOWN_ISSUES, WORKFLOW_RULES: cosine > 0.85
│   ├── for each pair: keep the longer/more precise wording, merge seen_count + retrieval_count
│   ├── record merged_from IDs on surviving memory
│   ├── set superseded_by_memory_id on merged duplicates
│   └── re-embed any updated content
│
├── 4. MINE SESSIONS (local LLM, ~30 min)  [task: "mine"]
│   ├── for each completed session since last dream:
│   │   ├── read session compartments (if available) or raw messages
│   │   ├── run historian-style fact extraction prompt
│   │   ├── deduplicate extracted facts against existing memories (normalized_hash)
│   │   └── insert new memories with source_type='dreamer'
│   └── update last_dream_session_cursor
│
├── 5. VERIFY AGAINST CODE (local LLM + filesystem, ~30 min)  [task: "verify"]
│   ├── DETERMINISTIC CHECKS FIRST (no LLM):
│   │   ├── for memories mentioning file paths: check if file still exists
│   │   ├── for CONFIG_DEFAULTS: read schema source, compare stated defaults
│   │   ├── mark clearly stale memories as verification_status='stale'
│   │   └── mark confirmed memories as verification_status='verified'
│   ├── LLM CLASSIFICATION (ambiguous cases only):
│   │   ├── for memories where deterministic check is inconclusive
│   │   ├── LLM reads memory + current code state
│   │   └── classifies as verified | stale | flagged
│   └── mark all checked memories with verified_at = now
│
├── 6. GIT-AWARE INSIGHTS (local LLM, ~20 min)  [task: "git"]
│   ├── analyze commit messages since last dream
│   ├── group by module/area
│   ├── detect new files/modules not covered by any memory
│   ├── create memories for significant architectural changes
│   ├── update WORKFLOW_RULES if branch/merge patterns changed
│   ├── new LLM-generated memories start as verification_status='unverified'
│   └── note: only create memories for durable patterns, not one-off commits
│
├── 7. CODEBASE MAP (local LLM + filesystem, ~20 min)  [task: "map"]
│   ├── walk source tree, count files per module
│   ├── analyze barrel exports and entry points
│   ├── identify module boundaries and dependencies
│   ├── compare against stored map from last dream
│   ├── generate updated AGENTS.md or equivalent map document
│   ├── store map diff as memory if significant changes detected
│   └── store codebase_map_hash for next comparison
│
└── 8. DREAM LOG & CLEANUP (~2 min)
    ├── write dream summary: what was processed, what changed, what flagged
    ├── store last_dream_at, last_dream_git_head
    ├── if active session started during dreaming: note incomplete tasks
    └── log total runtime and per-task breakdown
```

### Conflict Avoidance (Oracle refinement: lease-based locking)

- Dreamer acquires a **lease** with heartbeat and expiry (not just a flag):
  - `dreaming_lease_holder`: unique dreamer instance ID
  - `dreaming_lease_heartbeat`: updated every 30s during dreaming
  - `dreaming_lease_expiry`: lease expires if heartbeat not updated for 120s
  - Stale leases from crashed dreamers are automatically released on next check
- If an OpenCode session starts during dreaming:
  - Dreamer detects via polling session meta every 60s
  - Current task completes, then dreamer pauses
  - Dreamer resumes after session ends (if still within schedule window)
  - If schedule window expires, dreamer saves progress for next night
- Memory writes during dreaming use transactions to prevent partial state
- Dreamer never modifies session-scoped tables (compartments, session_facts, tags)

### Quality Safeguards

- Session mining uses the same historian prompt that's already validated
- Code verification runs deterministic checks first, LLM only classifies ambiguous cases
- Consolidation uses embedding math (deterministic, not LLM-dependent)
- Category-specific merge thresholds prevent false consolidation of precise facts
- All LLM-generated memories are tagged `source_type='dreamer'` for auditability
- LLM-generated insights start as `verification_status='unverified'` — next session's auto-injection can flag these so the main agent confirms or discards
- Stale memories are flagged, not auto-deleted — user or agent decides
- Dream log provides full transparency into what changed and why

---

## Implementation Phases

### Phase 1: Storage + Promotion + Auto-Injection (MVP)

**Effort:** ~10-12 days

| Task | Description | Deps |
|---|---|---|
| 1.1 Memory storage module | `memories` table, CRUD operations, FTS5 triggers, indexes, normalized_hash | None |
| 1.2 Embedding module | `@huggingface/transformers` lazy-init, embed/search, BLOB storage, background warm | 1.1 |
| 1.3 Historian promotion | Post-commit rule-based fact promotion with hash dedup, async embedding | 1.1, 1.2 |
| 1.4 Auto-injection | `<project-memory>` block on first transform, budget-capped, deterministic selective injection | 1.1 |
| 1.5 `ctx_memory search` action | Hybrid retrieval: semantic + FTS5 token overlap, updates retrieval_count | 1.2 |
| 1.6 `ctx_memory` tool | Agent-initiated write/delete/search for explicit memory management | 1.1, 1.2 |
| 1.7 Config surface | `magic_context.memory.*` schema: enabled, injection_budget, embedding_provider | 1.1 |
| 1.8 Tests | Storage, promotion, injection, hybrid search, tool execution | All above |

**Deliverables:**
- Memories table with FTS5, embeddings, and proper indexes in existing DB
- Historian automatically promotes facts to cross-session memory (post-commit, async)
- New sessions receive `<project-memory>` injection with deterministic selective fallback
- Agent can search (hybrid) and write memories via tools
- Seen/retrieved counters properly separated
- All configurable, disabled by default

### Phase 2: Sidekick Agent (Optional Enhancement)

**Effort:** ~5-7 days

| Task | Description | Deps |
|---|---|---|
| 2.1 Provider abstraction | OpenAI-compatible client for local (LM Studio) and remote (Cerebras, etc.) | None |
| 2.2 Sidekick agent loop | Tool-calling loop with search_memory, max iterations, forced write | 2.1, Phase 1 |
| 2.3 Session-start hook | Intercept first user message, run sidekick, inject result | 2.2 |
| 2.4 Config surface | `magic_context.sidekick.*`: enabled, provider, model, endpoint, api_key | 2.1 |
| 2.5 Fallback behavior | Graceful degradation when LLM unavailable → fall back to Layer 1 auto-injection | 2.3 |

**Deliverables:**
- Optional local/remote LLM augments first message with targeted memory search
- Configurable provider: LM Studio, Cerebras, any OpenAI-compatible endpoint
- Falls back cleanly to auto-injection when sidekick is unavailable
- Uses different model config than dreamer (optimized for speed, not depth)

### Phase 3: Dreamer (Overnight Maintenance)

**Effort:** ~12-15 days

| Task | Description | Deps |
|---|---|---|
| 3.1 Dream scheduler | Time-window activation, lease-based locking, heartbeat, session conflict detection | Phase 1 |
| 3.2 Decay & cleanup | TTL expiry, retrieval-count promotion, archival | Phase 1 |
| 3.3 Consolidation | Category-specific embedding thresholds, merge logic, re-embedding | Phase 1 |
| 3.4 Session mining | Read old sessions, run historian prompt, hash dedup, insert | Phase 1, 2.1 |
| 3.5 Code verification | Deterministic checks first, LLM for ambiguous classification only | Phase 1, 2.1 |
| 3.6 Git-aware insights | Commit analysis, module detection, architectural change extraction | Phase 1, 2.1 |
| 3.7 Codebase map | File tree walk, export analysis, AGENTS.md generation, diff tracking | Phase 1, 2.1 |
| 3.8 Dream log | Summary output, progress tracking, per-task breakdown | 3.1 |
| 3.9 Config surface | `magic_context.dreaming.*`: enabled, schedule, model, tasks, max_runtime | 3.1 |

**Deliverables:**
- Scheduled overnight processing that improves memory quality
- All tasks independently configurable via `tasks` array
- Stale memory detection via deterministic + LLM verification
- Git-aware change tracking and insight extraction
- Automatic AGENTS.md / codebase map maintenance
- Lease-based locking prevents stuck dreamers from crashed processes
- Full dream log for transparency
- Uses separate model config from sidekick (optimized for quality, not speed)

### Phase 4: Memory Lifecycle & Advanced Features (Future)

| Task | Description |
|---|---|
| 4.1 Cross-project global memories | USER_PREFERENCES and patterns shared across all projects |
| 4.2 Memory relationships | Explicit links between memories (this constraint exists because of this decision) |
| 4.3 Memory versioning | Track how a memory evolved over time (original → consolidated → verified) |
| 4.4 Memory provenance table | `memory_sources` for detailed auditability instead of metadata_json |
| 4.5 Alternative embedding providers | fastembed (ONNX), API-based embeddings |
| 4.6 Memory export/import | Portable memory snapshots for team sharing or backup |
| 4.7 Memory visualization | Dashboard showing memory graph, categories, staleness, dream activity |
| 4.8 Memory inspection surface | "Why was this injected?" — let users pin, unpin, or forget memories |

---

## Prototype Artifacts

All prototype scripts are in `local-ignore/memory-prototype/`:

| File | Description |
|---|---|
| `seed-data.ts` | 79 memories extracted from current session's knowledge base |
| `embeddings.ts` | MiniLM-L6-v2 embedding module with SQLite BLOB storage |
| `run.ts` | FTS5-only prototype with interactive REPL |
| `run-semantic.ts` | Embedding search with FTS5 comparison mode |
| `run-augmented.ts` | LLM-picks-from-candidates approach (abandoned — selection not useful) |
| `run-agent.ts` | Local LLM with tool calling (LM Studio) |
| `run-remote-agent.ts` | Remote LLM with tool calling (Cerebras) |

### Key Prototype Findings

1. **FTS5 alone is insufficient** — "where is magic context database" returns 0 results because keyword matching can't bridge the semantic gap between user language and technical memory content.

2. **Semantic embeddings work well** — MiniLM-L6-v2 (22MB, 384d) handles natural language queries against technical memories with high relevance scores. Model loads in 0.1s (cached), embeds 79 memories in 0.1s.

3. **Auto-injection is the primary path** — At 79 memories (~2400 tokens), dumping everything budget-capped is simpler and equally effective. Search-based selection only matters at 500+ memories.

4. **Local LLM quality varies dramatically by model size:**
   - 0.8B: hallucinates freely, fabricates causal connections
   - 4B (Nemotron): honest but leaks thinking tokens, reasonable quality
   - 9B (Qwen 3.5): no hallucination, good structured output, explicitly honest about gaps
   - 9B (unsloth): best local honesty, slightly slower, leaks `<think>` blocks
   - 235B (Cerebras Qwen 3): best quality AND fastest (~2s total), but requires API

5. **The sidekick's best role is targeted search + faithful quoting** — not synthesis. Small models fabricate when synthesizing; large models are reliable but expensive. The simplest reliable pattern is: LLM generates 2-3 search queries → embedding search returns results → LLM quotes results without paraphrasing.

6. **Dreaming is the highest-value use of local LLMs** — overnight batch processing has no latency constraints, can use larger models (35B+), and filesystem access enables code verification that cloud models can't do.

---

## Configuration Summary

```jsonc
{
  "magic_context": {
    // Phase 1: Core memory system
    "memory": {
      "enabled": true,
      "injection_budget_tokens": 4000,
      "embedding_provider": "transformers",   // "transformers" | "fastembed" | "api" | "off"
      "auto_promote": true,                   // historian → memory promotion
      "retrieval_count_promotion_threshold": 3 // retrievals needed for permanent status
    },

    // Phase 2: Sidekick agent (fast model, latency-sensitive)
    "sidekick": {
      "enabled": false,
      "provider": "local",                    // "local" | "lmstudio" | "cerebras" | "openai-compatible"
      "model": "qwen3.5-9b",                 // needs fast inference — 9B+ recommended
      "endpoint": "http://localhost:1234/v1",
      "api_key": "",
      "max_tool_calls": 3,
      "timeout_ms": 30000
    },

    // Phase 3: Dreamer (large model, no latency pressure)
    "dreaming": {
      "enabled": false,
      "schedule": "02:00-06:00",
      "model": "qwen3.5-32b",                // bigger is better — 32B+ recommended
      "endpoint": "http://localhost:1234/v1",
      "max_runtime_minutes": 120,
      "tasks": ["decay", "consolidate", "mine", "verify", "git", "map"]
    }
  }
}
```

---

## Design Decisions Log

| Decision | Rationale | Source |
|---|---|---|
| Single DB, no split | One connection pool, atomic cross-table transactions, simpler lifecycle | Design discussion |
| `normalized_hash` for write-path dedup | Deterministic, fast, no embedding inference needed on hot path | Oracle review |
| Separate `seen_count` and `retrieval_count` | Prevents noisy repeated facts from earning permanence without active use | Oracle review |
| Lazy embedding model init | Plugin startup budget is tight; model download and load must not block session | Oracle review |
| Embeddings in separate table | Cleaner schema, CASCADE delete, future provider swap without touching main table | Oracle review |
| Hybrid retrieval (semantic + FTS5) | MiniLM is weak on exact symbols/paths; FTS5 token overlap compensates | Oracle review |
| FTS5 tokenizer preserves technical chars | Default tokenizer splits `execute_threshold_percentage` into fragments | Oracle review |
| Post-commit promotion, not in-transaction | Long embedding work inside historian transaction risks lock contention | Oracle review |
| Category-specific merge thresholds | 0.85 is too loose for CONFIG_DEFAULTS and NAMING; near-exact match required | Oracle review |
| Lease-based dreamer locking | Simple flag can't recover from crashes; lease with heartbeat auto-expires | Oracle review |
| Deterministic verification before LLM | File-exists and schema-compare are reliable; LLM only for ambiguous cases | Oracle review |
| Dreamer uses separate model config | Zero latency pressure allows 35B+ models for higher quality overnight | Design discussion |
| All dreamer tasks independently configurable | Users start with decay+consolidate (no LLM) and progressively enable | Design discussion |
| LLM-generated insights start unverified | Next session's injection flags these so main agent can confirm or discard | Design discussion |
| Deterministic selective injection over sidekick | Pinned categories + semantic top-K is cheaper and more reliable than LLM selection | Oracle review |

## Open Questions

1. **Standalone plugin extraction:** Magic-context may become a standalone plugin. Memory tables should be in the same DB but the storage path will change to `~/.local/share/opencode/storage/plugin/magic-context/database.db`. Design the DB module so the path is configurable.

2. **Embedding model choice:** MiniLM-L6-v2 is proven but weaker on exact symbols and paths. Benchmark `bge-small-en-v1.5` (what Memorix uses) against MiniLM on a fixed eval set if hybrid retrieval isn't sufficient.

3. **Memory content format:** Currently plain text sentences. Should we add structured fields (e.g., `related_files`, `tags`, `confidence_score`) or keep it simple? Oracle suggests `metadata_json` for extensibility, with a `memory_sources` provenance table in Phase 4.

4. **Dreamer and active sessions:** If a user works late and the dreamer's window overlaps with an active session, the dreamer pauses. Should it reschedule to the next available idle period, or just skip? Current design: saves progress, picks up next night.

5. **Memory size growth:** At what point does the memory store become too large for full auto-injection? Prototype shows ~30 tokens per memory, so the 4000-token budget holds ~130 memories. Beyond that, deterministic selective injection kicks in automatically.

6. **ANN index:** At 1000+ memories, full-scan cosine similarity may become noticeable. Monitor retrieval latency and add an approximate nearest neighbor index if needed.
