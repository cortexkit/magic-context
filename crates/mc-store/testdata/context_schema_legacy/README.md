# Historical context.db parity fixtures

## Coverage and integration

`migrations_legacy::upgrade(&mut Connection, now_ms)` upgrades initialized stores
at upstream versions **87–104** to fence **104**. The caller provides an already
opened connection; no host-store discovery or live-holder probing happens here.
The supplied `integration.patch` exports the module from `mc_store::context_schema`.
This module does not replace the fresh bootstrap provider or wire a startup endpoint.

The TypeScript chain still accepts version **0** (no ledger) and runs migrations
1–104. The serial follow-up must port starting versions **0–86**, including the
v87 host-evidence harness repair, earlier authority-trigger postconditions,
identity repairs, embedding rebuilds, and legacy compartment data heals. Older
versions are explicitly refused, rather than silently skipping those repairs.
Sparse or manually damaged schemas are not certified by these initialized-store
fixtures. Host live-holder/old-writer refusal remains an integration responsibility.

Transactions match the TypeScript runner: **each step** and its ledger insert
commit together. A failed step rolls back, but earlier steps remain committed.
`BEGIN IMMEDIATE` and an in-lock version read serialize concurrent starters,
preventing the ledger primary-key race. A current database takes no write lock.
Upstream versions above 104 are refused before changing bytes; downstream rows
at or above the reserved fork floor of 10000 do not mask the upstream version.

## Independent comparison

The fixture base is the `initializeDatabase` function (only trailing whitespace
removed) from
`ceeed793b5bf873d94768de20358bc84a44d3fad` (the last fence-87 initializer).
`storage-db-v87.source.txt` preserves that function; the generator supplies only
its schema helper and connection timeout and omits cache/mmap tuning. Today's
initializer cannot substitute for it: it already installs post-87 schema.

`generate.ts` executes that initializer and the **real current TypeScript
migration runner**, temporarily bounding its exported migration list at each
starting fence. Public `insertTag`, `insertMemory`, `addNote`, and
`writeReplayDocument` paths populate the v87 store, then real migrations advance
those populated rows to every starting version. Additional raw inserts provide
historical LKG/compartment layouts that current public writers no longer accept,
Git FTS content, embedding blob bytes, and invalid/prerelease replay cases.
Each starting file is copied unchanged: one copy goes through the real TypeScript
upgrade, the other through Rust. Neither expected output nor fixture schema comes
from the Rust migration assets.

Comparisons use the complete bootstrap schema snapshot/fingerprint from
`context_schema::fingerprints`, including FTS
shadow-table definitions, columns, indexes, foreign keys, triggers, and migration
identities. Data comparisons include every ordinary table and virtual-table
content, plus exact blob bytes. Physical FTS shadow data is SQLite-implementation
specific and excluded. Migration application timestamps are normalized; freshly
generated v93 random generation tokens are checked for 32 lowercase hex digits
then normalized only for starts below 93. Already-persisted tokens are compared
exactly. The clock is fixed for both engines; activation times and LKG expiry
cutoffs are therefore compared exactly. Integral REAL values use the same JSON
number representation as JavaScript.

Cases exercise the 24-hour LKG retention boundary, an expired slot, an empty
prefix, Unicode across a 65536 UTF-16-unit chunk boundary, strict/invalid replay
documents, duplicate JSON keys, temporal duplicate IDs, retained unknown entries,
object key ordering, IEEE-754 number formatting, and unpaired Unicode surrogates.
Additional tests cover per-step rollback/retry, three concurrent starters,
initializer-added columns, prerelease Git map validation, newer-version refusal,
and a current open while another connection holds the writer lock.

`steps.json` and the two LKG DDL assets are captured from actual TypeScript
migration/helper execution on an empty historical base. They preserve SQLite
creation text rather than approximate it. Rust independently implements LKG
chunking/hashing and temporal JSON conversion. Runtime uses compiled-in assets
and requires no TypeScript or Bun. Regenerate SQL assets locally with:

```sh
mkdir -p "$TMPDIR/magic-context/context-schema-legacy"
root=$(mktemp -d "$TMPDIR/magic-context/context-schema-legacy/assets.XXXXXX")
bun crates/mc-store/testdata/context_schema_legacy/generate.ts "$root" --assets
```

Run authoritative gates on Linux:

```sh
cargo test -p mc-store --test context_schema_legacy -- --nocapture
bun run --cwd packages/plugin typecheck
bun packages/plugin/node_modules/typescript/bin/tsc -p crates/mc-store/testdata/context_schema_legacy/tsconfig.json
```

All fixture files and incidental configuration/logger activity live under a
throwaway `$TMPDIR/magic-context/` root. No live context.db or host store is used.
