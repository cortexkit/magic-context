# OpenCode 2 wrapup/recomp store access (issue 629)

## Reproduction and the actual fault

Reproduced with real OpenCode **2.0.22** (workspace pin) and **2.0.24** (installed in a disposable directory, without changing workspace dependencies), using Bun **1.4.2**. The converted-store leg used real OpenCode **1.18.30** to create a session and its history before OpenCode 2's first open. Six further user/assistant turns were written by OpenCode 2. All model traffic went to the wire-level mock provider, not a billed provider.

The fresh OpenCode 2 host already creates a **pure-v2** store: `session_message` exists and `message`/`part` do not. The tests assert that fact; they do not manufacture the schema by deleting tables. The converted store retains its real v1 rows and completed conversion sentinel.

The missing step in the old tests was **reopening the host and invoking a command before the session's first context pass**. The old wrapup/recomp tests passed on a fresh active session, despite the store being pure-v2. The raw-message provider was installed by the context hook and retained in process memory; reopening lost it. The commands only received the v2 hidden-completion executor, not the v2 history source.

Exact failure excerpts from the 2.0.24 run:

```text
[2026-10-07T15:44:52.615Z] [magic-context][ses_ee8f611e4ffe0ssaClq0buOWy6] recomp failed code=MC-R01 reason="OpenCode store generation mismatch at /private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/issue-629/tmp/magic-context/issue-629-pure-v2/root-QRSeKL/XDG_DATA_HOME/opencode/opencode2.db: expected v1, found v2; refusing generation-specific database access"
[2026-10-07T15:46:20.816Z] [rpc] wrapup requested for session ses_ee8f4cf55ffeZFWhaUmMgRENIM (keep 2)
[2026-10-07T15:46:20.820Z] [magic-context][ses_ee8f4cf55ffeZFWhaUmMgRENIM] protected-tail migration seed fell back to ordinal 1: OpenCode store generation mismatch at /private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/issue-629/tmp/magic-context/issue-629-pure-v2/root-cosm77/XDG_DATA_HOME/opencode/opencode2.db: expected v1, found v2; refusing generation-specific database access
[2026-10-07T15:46:20.822Z] [rpc] wrapup failed: OpenCode store generation mismatch at /private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/issue-629/tmp/magic-context/issue-629-pure-v2/root-cosm77/XDG_DATA_HOME/opencode/opencode2.db: expected v1, found v2; refusing generation-specific database access
```

The full logs retain the stack, including `getReadOnlySessionDb` and `withReadOnlySessionDb`. The reporter's proposed writable-accessor diagnosis is **not the abort observed on this checkout**:

* `/ctx-wrapup`: `packages/plugin/src/v2/hooks/commands.ts:215` dispatches `wrapup`; `plugin/rpc-handlers.ts:1771` calls `runManagedWrapup`; `hooks/magic-context/wrapup-orchestrator.ts:325` builds the initial plan; `protected-tail-boundary.ts:862` attempts the legacy seed and catches its failure; `protected-tail-boundary.ts:936` then asks for the raw ordinal count without a provider; `read-session-chunk.ts:432` falls through to `read-session-db.ts:91`, whose **read-only v1 assertion** throws uncaught. The stack identifies that second read as the abort.
* `/ctx-recomp`: `v2/hooks/commands.ts:143` dispatches `recomp`; `plugin/rpc-handlers.ts:1670` calls `runManagedRecomp`; `hooks/magic-context/recomp-orchestrator.ts:253` invokes the runner; `compartment-runner-recomp.ts:202` asks for the raw count; `read-session-chunk.ts:932` falls through to the same v1-only reader. The runner records MC-R01 and `published=false`.
* On a **converted store**, that v1 read does not throw, because legacy tables still exist. Wrapup can silently report nothing to do, reading only the two legacy messages rather than the fourteen current messages. Recomp's old publication-only test can pass while rebuilding only the legacy history. The revised tests independently require a literal OpenCode-2-only source turn in the captured historian request, not merely a fabricated summary in the response.
* A second wiring omission affected active-session wrapup: its deferred incremental publication used the default `setPendingCompactionMarkerState` instead of the v2 inert marker strategy. The new assertion on the actual pending-marker column fails on the old implementation. The existing direct publication helper already excludes `opencode2` at `compaction-marker-manager.ts:476`; this explains why active-session recomp was green before the fix.

Line references above are to the delivered source.

## Fix and ownership

`v2/hooks/context.ts:920` installs the existing SQL-bounded v2 provider for command sessions as well as context passes. The registration uses the same `rawProviders` ownership map, session-removal cleanup, and plugin disposal as before; background historian work cannot outlive its source. RPC invokes this preparation before launching either command (`rpc-handlers.ts:1698,1809`).

The v2 RPC boundary also supplies `v2CompactionMarkerStrategy` (`context.ts:1947`). Both managed orchestrators forward it, and full/partial recomp publication honors the same strategy as incremental publication. OpenCode 2 owns checkpoint rows through its existing compaction hook and fold owner; manual commands publish only Magic Context compartments and request their existing materialization path. They do not need to synthesize OpenCode 1 `message`/`part` rows. Wrapup retains deferred cache behavior: the test uses `/ctx-flush` to explicitly request rendering on the next pass.

The generation assertions, including `features/magic-context/compaction-marker.ts:249`, are unchanged. No error is swallowed to make a command appear successful. No migration code changed, no conversion sentinel was cleared, and no host rows were deleted. Memories 20121 and 20125 were supplied by the parent and observed: clearing `migration.v1-v2` destroys post-conversion history by rebuilding from the legacy tables.

## Durable tests and mode lanes

The two existing command files now each run three real-host cases:

1. pure-v2, active session;
2. pure-v2, reopened session before its first context pass;
3. a real v1-converted session, with subsequent v2 history, reopened before its first context pass.

They prove historian execution, current v2 history in the captured request, durable compartment publication, and rendering in an actual subsequent provider request. Wrapup additionally proves no v1 pending-marker publication. Both compare the actual legacy rows and conversion sentinel before/after, and assert legacy tables remain absent in the pure-v2 case.

The prior manifest exclusions were stale descriptions of a separately invoked v2 lane, not a semantic incompatibility with the current mode-selected OpenCode 2 harness. Both files are now `ts-only` with `hosts: ["opencode2"]`. The existing OpenCode 2 CI job already installs OpenCode 1 for conversion coverage (`.github/workflows/ci.yml:466`), so these converted-store cases require no new CI prerequisite. Total files remain **175**, TS invocations **59 → 61**, OpenCode 2 TS invocations **33 → 35**, Rust **58**, OpenCode 1 **43**, Pi **28**, OMP **20** unchanged.

## Isolation and logs

Every host uses a throwaway root under `$TMPDIR/magic-context/issue-629/`, with private HOME, all XDG directories, `OPENCODE_DB`, and `MAGIC_CONTEXT_STORAGE_DIR`. Startup/shutdown and explicit in-test `lsof -p <pid>` inventories require every database/config descriptor to be inside that root, with the host database inode checked. Tests emit the database inventory. No live database or configuration file was opened or read; the host runner uses directory metadata rather than live-store contents for its write fence. Package suites used a disposable HOME and **no exported OPENCODE_DB**.

Full local evidence is retained under:

```text
/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/issue-629/
  failing-first-2.0.22.log
  failing-first-active-2.0.22.log
  failing-first-2.0.24.log
  final-2.0.22.log
  final-2.0.24.log
  mutation-legacy-snapshot.log
  mutation-raw-source.log
  plugin-test-canonical-home.log
  pi-test-canonical-home.log
  opencode1-commands.log
  final-build.log
  lint.log
  e2e-typecheck.log
```

Both final OpenCode 2 runs: **6 pass, 0 fail**. Exact successful 2.0.24 reopened-recomp log:

```text
[2026-10-07T16:16:38.184Z] [rpc] recomp requested for session ses_ee8d8fd48ffex2SIX6IaA5TBZh
[2026-10-07T16:16:38.394Z] [magic-context][ses_ee8d8fd48ffex2SIX6IaA5TBZh] recomp finished (published=true): ## Magic Recomp — Complete Rebuilt 1 compartment across 1 historian pass. Covered raw history 1-12 out of 12 total messages, stopping before protected tail at 13.
```

Non-vacuity controls:

* One real legacy row was changed **offline**, only in the disposable converted fixture, after taking the reference snapshot. Only the converted-wrapup test ran and failed on the real-row comparison. No conversion sentinel was changed and no OpenCode 2 process wrote v1 rows.
* Removing the RPC history-preparation seam, rebuilding, and running only converted recomp failed specifically on the captured request's missing OpenCode-2-only source turn, despite historian publication succeeding. This catches the false-green legacy-history rebuild.
* Each control staged the live state first, captured a non-empty mutation diff, restored from the index with `git checkout -- <path> && touch <path>`, and captured an empty working diff. Neither mutation remains in source or build output.

Other gates: plugin **7292 pass / 6 skip / 0 fail**, Pi **1610 pass / 3 skip / 0 fail**, OpenCode 1 command carrier **3 pass**, manifest validator **7 pass**, workspace typecheck, build, and lint passed. Initial unit runs failed two HOME comparisons because the supplied TMPDIR ended in `/` and produced a doubled separator; normalized disposable HOME reruns passed without code changes. The broad e2e typecheck has unrelated baseline errors (including stale SDK/sqlite typings); changed e2e files pass a scoped TypeScript 5.9.3 check using the plugin's ESNext target and retina path mapping.
