# Issues #379 and #380: mirror-reference and audit-timestamp evidence

## Scope and outcome

This report records the source review and executed evidence for the fixes in commit
`c3511905e38c1977301e2f47bd849142cec7985c`. The root `REPORT.md` was not used: it is a
stale hydration artifact for unrelated multi-frame delta transport work.

No authority fence, migration, or authority-direction change was made.

## Rendering and directionality review

The timestamp changes are cache-neutral:

- TypeScript `renderMemoryLineV2` renders only a memory id, optional source name, and content.
  It does not read `updated_at`. Its selection order is permanent status, importance, then id.
- Rust `render_memory_line` likewise renders only id, optional source name, and content. Rust
  memory selection is importance then id.
- TypeScript m0 snapshot markers use project epoch, maximum memory id, maximum mutation id, and
  other explicit markers; they do not use `memories.updated_at`. m1 memory updates are derived
  from `memory_mutation_log`, not row timestamps.
- The Rust m1 revision uses maximum memory id and mutation cursor, not `mc_memories.updated_at`.

The TypeScript mirror-apply timestamp writes cannot create a synchronization loop. They are
privileged, inbound projections from the module changefeed into `context.db`; TypeScript does not
publish those projection writes back into the module changefeed. While module authority is active,
the authority guards reject ordinary TypeScript memory/note writes. The privileged writer is the
one-way application mechanism for inbound module state, not a second authority path.

## #380 per-site adjudication

| Finding | Site and state changed | Severity | Adjudication | Cache-neutrality and directionality |
| --- | --- | --- | --- | --- |
| F1 | `context-authority.ts`: deferred supersede translation (`updateSuperseded` and the pending-reference batch translation) changes `memories.superseded_by_memory_id`. | HIGH | **Fixed with `updated_at` bump.** | The pointer is used as state for corrections, but `updated_at` itself is absent from m0/m1/wire rendering. This is an inbound Rust-to-TS projection, so the privileged timestamp write cannot feed back into the module. |
| F2 | `context-authority.ts`: `repairMemory` restores `source_type` and `importance`. | MED | **Fixed with `updated_at` bump.** | The restored classification fields can affect later selection, but the timestamp is not rendered or used as an m0/m1 marker. It is the same one-way inbound projection path. |
| F3 | `context-authority.ts`: `applyMirroredNoteCompileFields` changes note compilation provider/config/time/status. | MED | **Fixed with `updated_at` bump.** | Compile state is meaningful durable note state; the timestamp itself is not rendered into memory m0/m1/wire output. This write applies module-originated state locally and has no outbound mirror producer. |
| F4 | `storage-identity-merge.ts`: collision survivor receives newer `importance`, `scope`, `shareable`, and `classified_at`. | MED | **Fixed with `updated_at` bump.** | m0 selection may use importance, but does not read the timestamp; m1 reads mutation rows. This TS-only post-drain identity merge does not publish into the module. |
| F5 | `storage-identity-merge.ts`: collision survivor receives `mural_cue`, hash, timestamp, and rejection count. | MED | **Fixed with `updated_at` bump.** | The cue fields have their own render handling; `updated_at` is not a rendered input or marker. This TS-only post-drain identity merge has no module feedback path. |
| F6 | `storage-identity-merge.ts`: collision survivor receives a larger `seen_count` or is restored to active status. | MED | **Fixed with `updated_at` bump when that state actually changes.** | The timestamp is not rendered or queried for m0/m1 decisions. The write remains TS-only after authority drain, so it cannot loop into the module. |
| F7 | `storage-identity-merge.ts`: a non-collision memory changes `project_path`. | MED | **Fixed with `updated_at` bump.** | Project membership affects retrieval, but `updated_at` is not m0/m1/wire data. Identity merge refuses module-managed pools, so there is no Rust feedback loop. |
| F8 | `crates/mc-store/src/lib.rs`: `set_memory_classification` changes `importance`, `scope`, `shareable`, and `classified_at`. | MED | **Fixed with `updated_at` bump.** | The Rust renderer and TS renderer omit the timestamp; Rust m0 ordering is importance/id and m1 uses its mutation cursor. The added timestamp does not add a mutation-log entry or wire bytes. |
| F9 | `crates/mc-store/src/lib.rs`: verified branch changes `verification_status` and `verified_at`. | LOW | **Fixed with `updated_at` bump.** | Verification state is durable audit data, but the timestamp is not a rendered m0/m1/wire field. The Rust changefeed remains the sole source for projection to TypeScript. |

All nine reported sites were fixed; none was deliberately left without a bump.

## Executed mutation evidence

### #379: drain with pending references

The regression test creates two pending supersede references, makes one target identity available
before drain completion, and leaves the other target unavailable. With the final drain translation
call intentionally removed, the test failed as expected:

```text
context-authority.test.ts:2420:24
error: expect(received).toEqual(expected)
-   "superseded_by_memory_id": 3,
+   "superseded_by_memory_id": null,
(fail) memory authority protocol > drain translates pending superseded references and preserves unresolved records
0 pass
1 fail
```

The call was restored. The regression then passed and verified that the resolvable pointer is
translated while the unresolved source/target module ids remain in `mirror_pending_references`.

### #380: representative timestamp write

The F7 rekey test is an executed timestamp mutation representative. With `updated_at = ?` removed
from the rekey SQL, it failed as expected:

```text
storage-identity-merge.test.ts:338:11
error: expect(received).toEqual(expected)
  {
    "project_path": "git:new",
-   "updated_at": 10,
+   "updated_at": 1,
  }
(fail) project identity merge > rekeys a memory with an audit timestamp
0 pass
1 fail
```

The bump was restored. Grouped regression coverage also exercises F1--F6 and F8--F9 without nine
copy-pasted tests.

## Executed gates

| Command | Result |
| --- | --- |
| `bun run test` in `packages/plugin` | **4170 passed, 0 failed, 21038 expectations, 379 files** (14.20s) |
| `bun run typecheck` in `packages/plugin` | **Passed**: retina-local-fs build config, plugin `tsc --noEmit`, and script config |
| `cargo test -p mc-store` | **128 passed, 0 failed** (11.09s) |
| `cargo fmt --check` | **Passed** |
| Changed TypeScript files: `bunx biome check ...` | **Passed** |

The workspace-wide plugin lint command still reports pre-existing formatting/import diagnostics in
unrelated files. The changed TypeScript files pass their targeted Biome check.

## Ready-to-post contributor replies

### Issue #379

Confirmed and fixed. Pending supersede translation was only driven by `applyMirrorPage`, so a
completed authority drain could return TypeScript ownership with a resolvable pending reference
still queued. The drain now performs one final translation pass before ownership returns; references
whose target still lacks an identity remain durably recorded in `mirror_pending_references` rather
than being silently discarded. The regression covers both outcomes, and removing the final
translation call makes the pointer assertion fail.

### Issue #380

Confirmed and fixed all nine reported durable-row writes. Each meaningful state change now advances
`updated_at`, including mirror supersede translation, metadata repair, mirrored note compilation,
all four identity-merge writes, Rust classification, and Rust verification. The render paths do not
serialize `updated_at`, m0/m1 markers use ids and mutation cursors rather than row timestamps, and
the TypeScript mirror applies are one-way inbound projections, so the audit stamps do not change
wire bytes or create a sync loop. Representative mutation tests prove both the drain pointer and a
timestamp bump go red when their corresponding change is removed.
