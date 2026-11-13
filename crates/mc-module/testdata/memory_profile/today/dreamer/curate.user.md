## Task: Curate Project Memory Pool (hygiene)

**Project:** ⟦projectIdentity⟧

This run covers the whole of the `⟦curate.category⟧` category (the other categories run in later windows).

The memories below are assumed ACCURATE (a separate verify task keeps them true). Your job is pool QUALITY: remove duplicates, tighten wording, and consolidate redundant entries that waste the 4000-token injection budget. Explain each action in one line first. Do NOT mint new facts (that is the historian's job).

Work ALL THREE phases below in order (A → B → C) over this category. Do NOT stop after consolidating — a run that only merges and never improves or archives is incomplete.

### Phase A — Consolidate duplicates
Group by category, then merge near-identical / superset-subset / same-fact-different-angle clusters into one canonical memory with `ctx_memory(action="merge", ids=[...], content="...", category="...")`. Preserve every unique detail; terse present tense; paths/keys verbatim. Every id in a merge MUST share the same category — the system rejects cross-category merges. If two similar memories sit in different categories they are NOT duplicates; do not archive either as a consolidation. One fact per memory.

### Phase B — Improve wording
Rewrite narrative/historical → operational present tense ("X uses Y because Z", not "we switched to Y"); drop session-local context and commit hashes (unless the hash is the point); add specifics where vague. A rewrite that removes more than half the content must name the active same-category memory preserving that detail with `superseded_by`. `write` is for SPLITS ONLY (update the original down to its first fact, write the second) — a healthy run is net-neutral or net-shrinking, never net-adds facts.

### Phase C — Archive only into a surviving project memory
Archive a redundant memory only when a better ACTIVE memory in the same project and category preserves its information; name that survivor with `superseded_by`. A bare "redundant" verdict is deletion and will be refused. Leave standalone low-value or stale entries unchanged for a human to review. The global user profile describes the operator and is never a substitute for project knowledge, so it cannot justify an archive.
KEEP (overrides archive): constraint/rule language (must/never/always) · explains WHY (because/so that/to prevent) · EXTERNAL-system limit (CONSTRAINTS: archive only if word-for-word duplicated) · path/config WITH context · retrieval_count>0 · priority/philosophy.

### Cross-chunk duplicate candidates (normalized content matches)
⟦crossChunkCandidateLine⟧

### Category snapshot (do not re-enumerate)
[⟦memory.id⟧] ⟦memory.category⟧ importance=⟦memory.importance⟧ retrieval_count=⟦memory.retrieval_count⟧ seen_count=⟦memory.seen_count⟧
Content: ⟦memory.content⟧
Mapped files: ⟦mappedFile⟧

[⟦memory2.id⟧] ⟦memory2.category⟧ importance=⟦memory2.importance⟧ retrieval_count=⟦memory2.retrieval_count⟧ seen_count=⟦memory2.seen_count⟧
Content: ⟦memory2.content⟧
Mapped files: (none mapped yet) (file-independent)