# Memory and compressed-history parity fixture

`context.db` and `golden.json` are captured by `capture.ts`, which imports the
production TypeScript schema/migrations, memory insertion/embedding APIs,
compartment/chunk publication, prompt materialization and `unifiedSearch`.
Nothing reads a live store. All construction happens in a temporary directory;
the Rust tests copy the captured database into their own temporary directory and
open it read-only. Embeddings are fixed float32 test vectors, not live inference.

Regenerate from the repository root with the pinned Bun version:

```sh
bun --version
bun crates/mc-module/testdata/parity_retrieval/capture.ts
```

The capture uses a fixed source timestamp (`2026-01-10T00:00:00Z`) and reports the
number of cases. The committed capture was generated with Bun 1.4.2 against the
TypeScript sources on base `fbd290171e7db1ecc9d33a0a71e951a00bb1412a`.
The full migrated database is intentional: BM25 uses document frequencies from
the original corpus, including expired, archived and foreign hidden rows.
Rebuilding only the eligible memories is not an equivalent fixture.

The production HARD-fold test hook inserts one memory after the fold's input
snapshot, producing actual m[1] `<new-memories>` text. `injectM0M1` then replays the
committed pair. The visible set is captured by the same `getVisibleMemoryIds`
producer that `ctx_search` calls; editing another baseline memory afterwards
proves stale canonical text is searchable rather than suppressed. A SOFT pass
alone deliberately does not discover new historian memories.

The 20 differential cases cover hybrid, FTS-only and semantic-only candidates;
model mismatch; zero/negative cosine; expired/archived/hidden workspace memories;
classified shared-category workspace rows; m[0]/m[1] suppression and stale text;
FTS punctuation/relaxed fallback; inclusive memory timestamps; overlapping
compartment date intervals and absent endpoint maps; multiple chunks per
compartment and score ties; the compacted ordinal cutoff (including 0 and -1);
embedding failure/off; memory off; source selection; the 50-hit FTS cap; date
filtering before the cap; default/fractional/min/max result limits; UTF-16
previews; and whitespace-only queries. Golden results preserve the original
f64 scores and independently capture TypeScript `score.toFixed(2)` strings.

Run on Linux:

```sh
cargo test -p mc-module --test parity_retrieval -- --nocapture
cargo test -p mc-module --lib memory_tool:: -- --nocapture
```

`typescript_memory_and_compartment_parity` compares item identity, order, preview,
match type, metadata, raw score (1e-12 tolerance for floating-point square roots),
reported score and suppressed IDs. The other tests check honest unsupported
source/legacy diagnostics, limits and single-query provider use with failed,
stale and cancelled embeddings. Query configuration generation intentionally
differs from archive generation in the provider test.

`store-contract.md` specifies the production adapter needed from mc-store and
the parallel vector producer. `integration.patch` is an **unapplied** root-owner
patch: exports, legacy default and surfaced diagnostics. The new boundary is
callable through `memory_tool`, but is not automatically installed in the
existing facade: no store/vector provider is fabricated to conceal that gap.
The patch does not change tool schemas or descriptions. Final provider-backed
activation follows the explicit call and rendering contract in the store spec.

Mutation controls are the visibility predicate in `hybrid::rank_memories` and
the FTS lane weight in the same file. Either must redden
`typescript_memory_and_compartment_parity`, while the four independent
integration controls remain green. Mutation output and restore evidence are in
the worker delivery record, not stored in regenerable build directories.
