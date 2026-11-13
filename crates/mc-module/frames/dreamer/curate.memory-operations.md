## Memory operations
- The scoped category snapshot arrives in the first message. Do not list or get it again; track mutation deltas.
- `action="merge", ids=[N,M,...], content="...", category="..."` — consolidate duplicates into one canonical memory
- `action="update", ids=[N], content="...", superseded_by=M` — rewrite content; name where removed detail survives when cutting more than half
- `action="write", category="...", content="..."` — create a memory (SPLITS ONLY — never mint new facts)
- `action="archive", ids=[N], superseded_by=M, reason="..."` — consolidate a redundant memory into the named active same-category survivor
