# Pinned commit-search differential fixture

`generate.ts` extracts its TypeScript inputs with `git show` at
`282d9c08bce490346583a3b8c145c402499f980f`, into ignored
`.cortexkit/internal-docs/git-search-evidence/`. It does not import the working
tree's TypeScript. Run from the repository root:

```sh
bun crates/mc-store/src/git_archive/fixtures/generate.ts
cargo test --locked -p mc-store --lib git_archive::tests
```

The generator calls the actual pinned `indexCommitsForProject` and
`searchGitCommitsSync`, including `sanitizeFtsQuery`, cosine similarity and
model-scoped vector loading. Only logging, the external embedding service, and
the unused memory-search dependencies are mocked; unexpected use of the latter
two throws. Git schema SQL is extracted from the pinned git-table migration.
The original single-model schema is sufficient because the fixture stores only
one model's vector per SHA; it matches the Rust ingestion schema. Search also
works with the later composite
`(sha, model_id)` embedding primary key without changing schema.

`history.bundle` contains a synthetic repository, including the main branch tip
before its message was amended, the pre-merge tip, merged older history, a capped final branch
and an unrelated project branch. Rust tests clone it into a temporary directory
and replay all six ingestion sweeps, checking their rows against the TS snapshot
after every sweep. Messages include file paths, identifiers, Unicode, literal
wildcards, operators and a long body. Git author identities use reserved
`.invalid` domains. No real repository history or store is in either fixture.

`search.json.gz` is compressed JSON to avoid repeating long messages verbatim in
the repository. It contains the ingestion snapshots, synthetic Float32 vectors,
query options, full expected hits, scores, match types, independent lexical and
vector lanes, and sanitizer cases. Search expectations are TS output, not a
second implementation of the Rust algorithm. Rust compares all metadata, hit
order, and scores (absolute tolerance `1e-14` for native cosine rounding).

Lexical scores are reciprocal BM25/LIKE ranks times the single-source penalty;
BM25 values themselves are not returned by TS. Equal BM25 values retain FTS row
order, so tests replay ingestion rather than rebuilding FTS in SHA order.
Semantic-only metadata follows SQLite's `IN (json_each(...))` order. Stable final
sorting uses score descending, then commit date descending. Independent lanes
are capped at 25; merged results use the caller's limit.

`SqliteGitArchive` projects these results onto the existing `GitArchiveStore`
trait, preserving rank through list order. The shared record has no author,
short SHA, score or match-type fields; callers needing those fields or optional
query vectors use the raw API exported by `git_archive`. Parents are empty
because ingestion does not persist them. Provenance uses the commit SHA for
source identity/revision, SHA-256 of the stored message for content identity,
the request's generation, and the persisted indexing time. The transcript
ordinal cutoff has no meaning for commits and is not applied. The unavailable
sentinel stays unavailable, and the connection-backed implementation does not
provide a new ingestion/write path.
