# FENCE-MOVER: migration v82 for issue #370

## Schema change

**FENCE-MOVER:** this change adds context-database migration v82 and raises
`LATEST_SUPPORTED_VERSION` from 81 to 82. The migration adds
`memory_verifications.mapping_origin TEXT NOT NULL DEFAULT 'mapper'`.

The column distinguishes a mapper-authored file-independent sentinel from the
host's `host_rejected_fallback` sentinel written after every mapper-supplied
path fails containment or tracked-file validation. Existing rows retain the
conservative `mapper` default.

The Rust module-store twin advances to migration v51 and persists the same
origin in `mc_memory_mappings`. This is necessary when the Rust module owns the
memory authority: `memory.set_mapping`, changefeed snapshots, authority seeds,
and the TypeScript mirror must preserve the disposition rather than collapsing
both sentinel forms into an indistinguishable null mapping.

## Verification evidence

- `bun test --parallel --timeout 30000`: 4,133 passed, 0 failed.
- `bun run typecheck`: passed.
- `bunx biome check` over all changed TypeScript files: passed.
- `cargo fmt --all --check`: passed.
- `cargo check -p mc-store -p mc-module`: passed (two existing dead-code warnings).
- Focused module/store mapping-origin tests: passed.
- Executed mutation: removed the fallback `planned.push` write under
  `NON-VACUITY BREAK`; the all-rejected convergence test failed at
  `map-memories.test.ts:486`, receiving `remaining: 1` and `complete: false`
  instead of the expected converged result. The fallback write was restored
  before commit and the test passed.

## Ready-to-post issue reply

Confirmed: the host previously dropped mappings when every proposed path failed
normalization, leaving those memories permanently unmapped and repeatedly
failing `map-memories`. The fix records a file-independent sentinel with a
`host_rejected_fallback` origin, so runs converge while preserving the
distinction from mapper-authored independence; content updates reopen mapping
scope. This is slated for v0.40.2, the patch following v0.40.1.
