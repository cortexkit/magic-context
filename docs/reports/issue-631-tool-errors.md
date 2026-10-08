# OpenCode 2 tool errors across host compaction

## Reproduction and mechanism

Reproduced with the real OpenCode 2.0.22 and 2.0.24 hosts and the lane's
OpenAI-compatible mock. With the pre-fix 0.45.0 adapter, a missing-file `read`
arrived before `/compact` as `§2§ {"error":{"type":"tool.execution",...},"content":[]}`
and afterwards as `§2§ `. The converted-store arm was also red: OpenCode
1.18.30 created the store, then OpenCode 2 converted it on first boot. No test
writes legacy tables or changes `migration.v1-v2`.

The source references below for the defect use base commit
`f451e48d0740517e80b553ea9671e841f54d68e0`:

1. `packages/plugin/src/v2/hooks/context.ts:1683-1707` restores retained rows
   before the host checkpoint, then `:1725` adapts those messages.
2. `packages/plugin/src/v2/fold/restore.ts:224-242` correctly reconstructs an
   error as `result: { error, content }, resultType: "error"`. Unlike the ordinary
   host context's normalized `{ type: "error", value: { error, content } }`, this
   raw result has no `value`.
3. `packages/plugin/src/v2/hooks/payload.ts:220-239` reads only `result.value`,
   substitutes `""` for the missing value, and marks every settled result
   `completed`. Normalized errors keep their text but incorrectly become successes;
   replayed raw errors lose both their text and status.
4. Tag injection at `packages/plugin/src/hooks/magic-context/tag-messages.ts:1003`
   adds the existing tag to the empty output. The inverse mapping at
   `packages/plugin/src/v2/hooks/payload.ts:456-463` emits a text result whenever
   output changed, producing precisely `§2§ `. This is not heuristic cleanup.

## Other v2 result mappings

| Location (base commit) | Finding / correction |
| --- | --- |
| `hooks/payload.ts:257-269,431-450` | Converted `type: "tool"` parts also ignore `state.error` and emit successes. The shared state-text helper now includes the error envelope, and inverse conversion retains error type. |
| `hooks/payload.ts:349-385` | Unbridged replay/synthetic tools already select error type; they now share the corrected state-text helper. Covered by unit test. |
| `fold/restore.ts:224-242` | Correct error envelope and status; unchanged. The defect is the subsequent adapter, not restoration. |
| `fold/owner.ts:41-114` | Stores checkpoint identity and summary, not tool results; unchanged. |
| `store-reader.ts:274-287` | JSON decode preserves raw error fields; unchanged. |
| `hooks/store.ts:48-65` | The historian/raw-reader projection preserves status but extracts only text content. Error output now includes the host's full error envelope; successful projection is unchanged. |
| `hidden-completion.ts:127-174` | Intentionally exposes **applied success text only** to dreamer operation validation. Detects both error shapes and retains `status: "error"`; not a provider replay path. Unchanged; existing test `never counts a failed call, even when its content reads like success` remains green. |

`v2/tool-result.ts` handles raw and normalized error shapes without changing
successful serialization. Tagged or dropped errors use `{ type: "error", value:
text }`, which the host accepts as an error result and renders as exactly that
text. Unchanged results retain their original object. Tag numbering, ownership,
drop selection, call pairing, dropped input, and marker bytes are not changed.

## Real-host proof

`tests/opencode2/error-result-compaction.test.ts` exercises the issue's missing
read, host `/compact` (no provider request), and next request. It compares UTF-8
bytes, observes error/success status on the **returned context draft**, and checks
the actual completed host checkpoint. The converted arm checks **all ten** failed
reads plus one successful read. Both tests passed on both hosts (51 assertions
per version). They are registered as one TS-only OpenCode 2 manifest entry:
176 total files, 62 TS invocations, 36 OpenCode 2 TS invocations.

`scripts/probes/issue-631.ts` compares pre-fix and fixed adapters on an offline
snapshot of the same error-free session, replayed at the same private paths. It
compares the **entire raw provider request**, not reconstructed tool text:

| Host | Bytes | Identical before/after SHA-256 |
| --- | ---: | --- |
| 2.0.22 | 37,328 | `bb5430b5c06d4e40d3cc62a5b65876e31f051a57b4771d5429506d16888c4628` |
| 2.0.24 | 37,335 | `dc20e85a2761c3fe727b49405f3f659ee94bb19ad0eb7f7b28bedeb28b4fa86d` |

The same probe compacts an errored session on the old adapter, confirms tag-only
output, restarts with the fixed adapter, and confirms recovery of the original
bytes. **Already-compacted sessions recover retained, unarchived errors on the
next request after upgrade**, with their original tags and error status. There is
no store repair or schema migration. This does not undo an intentional drop or
restore verbatim content already replaced by a historian summary.

All hosts ran under `$TMPDIR/magic-context/issue-631/root-*`, with private HOME,
XDG data/config/state/runtime roots, `OPENCODE_DB=opencode2.db` resolved inside the
private XDG data root, and private `MAGIC_CONTEXT_STORAGE_DIR`. The runner and
explicit test calls used `lsof -p <host pid>` to match the private database inode
and reject outside database/config paths. No live stores or configuration were
opened. The task-giver explicitly approved only the host-owned conversion of a
fresh throwaway v1 store. Package suites used a throwaway HOME and no exported
`OPENCODE_DB`.

## Verification and baseline limitations

- Bun 1.4.2: focused adapter/fold/hidden-completion tests plus the two initially
  failing unrelated test files: 124 passed. New adapter tests were run red before
  implementation (wrong status, missing converted error text, wrong drop type).
- Plugin full `bun run test`: 7,301 passed, 6 skipped, 3 failed. The unchanged
  temporary-directory policy flags `e2e-tests/src/rust-runner/hermetic-subc.test.ts`;
  `variable.test.ts` failed because the supplied HOME had a doubled slash (passes
  with canonical HOME); `verify.test.ts` hit a parallel git-commit timeout (passes
  in the focused run). None of those files changed.
- Pi full `bun run test`: 1,621 passed, 3 skipped, no failures.
- Workspace `bun run typecheck` (TypeScript 5.9.3): passed. Workspace `bun run lint`
  (Biome 2.5.1): passed, existing warnings only.
- Manifest validator: 176 entries; validator/prerequisite tests: 7 passed.
- Whole E2E TypeScript program has unrelated existing errors. A narrowed program
  covering the new host test, probe and manifest tests passed, using the workspace's
  installed type roots and Retina source-path mappings. No production compiler
  configuration was changed.
