# Retrieval input store contract

`memory_tool::hybrid::RetrievalInputStore` is the storage boundary for memory and
semantic compartment ranking. Implement it in mc-store (or in a module adapter
calling mc-store); do not reconstruct an FTS index from the returned memories.
Every method returns `CapabilityResult`, so an absent table, unsupported identity,
or missing producer can be unavailable/degraded rather than an empty success.
An available empty vector set means the corpus was read successfully and has no
matching stored vectors. It does not mean vector persistence is installed.

All methods receive the authenticated `StoreScope`. Resolve canonical project
identity, legacy aliases, workspace membership and shared-category policy once
per read snapshot. Own memories are readable regardless of classification;
foreign memories require shared categories and, where present, `shareable=1` and
`scope IN ('project','ecosystem','universe')`. Only memory broadens to workspaces.
The adapter must maintain a consistent snapshot across the synchronous reads.

## Methods and SQL

### `read_search_memories(scope, dates)`

Return all eligible rows, not a recency-capped pool: id, category, content,
created_at and optional foreign-project display name. Apply visibility/read-scope
policy, active/permanent status, expiry and inclusive created_at bounds.
The visibility *suppression* set is applied later, after scoring.

```sql
SELECT id, project_path, category, content, created_at
FROM memories
WHERE <project/alias/workspace read policy>
  AND status IN ('active','permanent')
  AND (expires_at IS NULL OR expires_at > :now_ms)
  AND created_at BETWEEN :from_ms AND :to_ms;
```

### `search_memory_fts(scope, query, dates, limit)`

Return ordered `MemoryFtsHit { memory_id, bm25 }`. The ranker requests 50 rows;
it uses `1/(rank+1)`, not the magnitude of BM25. Scope/status/expiry/date filters
precede LIMIT, but BM25's corpus is the original `memories_fts` table, including
rows outside the caller's read scope. There are no explicit column weights.

```sql
SELECT memories.id, bm25(memories_fts)
FROM memories_fts JOIN memories ON memories.id = memories_fts.rowid
WHERE <project/alias/workspace read policy>
  AND memories.status IN ('active','permanent')
  AND (memories.expires_at IS NULL OR memories.expires_at > :now_ms)
  AND memories.created_at BETWEEN :from_ms AND :to_ms
  AND memories_fts MATCH :sanitized_query
ORDER BY bm25(memories_fts), memories.updated_at DESC, memories.id ASC
LIMIT :limit;
```

Sanitize NUL to space, split on ECMAScript whitespace, double quotes inside each
token, quote each token and join with spaces. If no rows are found, retry with
unique Unicode letter/number/underscore tokens (in first-occurrence order),
keeping tokens longer than two UTF-16 code units or containing an ASCII digit,
maximum 16, quoted and joined with ` OR `. An FTS failure must not be converted
into an available empty result. See `memory/storage-memory-fts.ts` for both
single-project and workspace variants.

### `read_memory_vectors(scope, memory_ids, identity)`

Return model-matching float32 vectors keyed by memory id. This should call the
wave-2 vector store's `RetrievalVectorStore::read(VectorReadRequest)` with source
ids identifying the memory rows, then attach the numeric row id. Filter the full
`EmbeddingIdentity` (provider/model/dimensions/recipes/fingerprint/epoch), not
only a model display name. The existing context.db model key needs an explicit
identity-to-model-key mapping in that adapter. Do not relabel an old vector as
the current identity. The fixture identity maps directly to `fixture:model`.

```sql
SELECT e.memory_id, e.embedding, e.model_id
FROM memory_embeddings e JOIN memories m ON m.id=e.memory_id
WHERE <authorized memory ids and project identity aliases>
  AND e.model_id=:persisted_model_key
ORDER BY e.memory_id;
```

Backfill, content-hash fencing and publication belong to the vector producer,
not this ranker. The ranker operates on stored vectors only and diagnoses a
missing provider/store while retaining lexical recall.

### `read_compartment_chunks(scope, dates, identity)`

Return ordered chunks joined to the current compartment title and **whole
compartment** ordinal bounds. Include authoritative first/last-message times;
summary creation time is not the search date. Multiple embedding windows in one
compartment compete by maximum cosine; the first window wins exact ties.
Never expand compartment search to another session or workspace project.

```sql
SELECT e.compartment_id, e.session_id, e.project_path,
       c.title, c.start_message, c.end_message,
       start_map.message_time_ms, end_map.message_time_ms,
       e.model_id, e.dims, e.vector
FROM compartment_chunk_embeddings e
JOIN compartments c ON c.id=e.compartment_id
LEFT JOIN message_fts_rowid_map start_map
  ON start_map.session_id=c.session_id
 AND start_map.message_ordinal=c.start_message
LEFT JOIN message_fts_rowid_map end_map
  ON end_map.session_id=c.session_id
 AND end_map.message_ordinal=c.end_message
WHERE e.session_id=:session AND e.project_path=:project
  AND e.model_id=:persisted_model_key
ORDER BY e.compartment_id, e.window_index;
```

When dates are present, use inner joins and require
`start_map.message_time_ms <= :to_ms AND end_map.message_time_ms >= :from_ms`.
The ranker defensively repeats this interval-overlap rule and excludes missing
endpoint mappings for dated queries. The ordinal cutoff compares the whole
compartment end; 0 excludes all 1-based history, negative/absent is unbounded.
Map chunk and query model keys to the same certified vector identity; their
storage keys may differ, but unrelated recipes must never be mixed.

### `read_visible_memory_ids(scope)`

Use the existing applied-projection/current-served-pair visibility producer,
not all memory candidates or a stale ID list. It includes full current text in
m[0] and m[1] (including full committed agent fragments); cues and stale markers
are not visible. A memory whose canonical content changed after being served is
searchable again. `McStore::fully_visible_memory_ids` is the production starting
point. The fixture's projection contains baseline text and a fold-time delta,
plus an edited old baseline row that must remain discoverable. If visibility
cannot be read, the new boundary fails closed for memory output and diagnoses
that component; it does not silently claim complete hidden recall.

## Indexes and consistency

Use the migrated `memories_fts` FTS5 index and its real triggers. Helpful existing
keys are `(memory_id, model_id)` on memory_embeddings, session/sequence on
compartments, compartment/window/model on chunk embeddings, and
`(session_id, message_ordinal)` on message_fts_rowid_map. Workspace-member project
identity lookup and applied-projection session/harness keys must remain indexed.
Do not add per-request temporary indexes or rank after a recency cap.

## Root activation

Owned modules are compiled under `memory_tool::{hybrid,compartments}` without
root edits. The accompanying patch re-exports them under `retrieval`, fixes the
legacy execution default to 10, and surfaces legacy degradation diagnostics.
It does **not** install a store adapter or transport that is absent at this base.
Once this trait is implemented and a certified provider is installed, the root
facade calls:

```rust
let outcome = memory_tool::search_retrieval_inputs_with_provider(
    &adapter, &provider, &context, query, &options, &identity,
).await;
```

Build `SupportedSearchOptions` from resolved sources/date bounds/config and set
`max_message_ordinal` to the last compacted end, or 0 before any compaction. Keep
ID shortcuts on the existing visibility-aware path. Pass the same certified
query identity to the vector adapters, preserve f64 scores while ordering, and
use `SearchHit::reported_score()` for two-decimal rendering. Render memory
`match_type`, foreign `source_name`, and actual compartment id/range/title rather
than the legacy sequence/custom-score representation. Append diagnostics for
unavailable raw messages, git, primers, notes, query embeddings and vector stores.
Notes remain the legacy lane's responsibility until the separate archive-query
owner composes lanes; the new two-lane boundary explicitly reports them absent.
Do not round scores before ordering or add raw-message RRF/probes/reranking here.
