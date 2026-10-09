# Auto-search deadline review follow-up

The accepted review and tests from `e0adb570de` were cherry-picked as `398bf75aa2`. All five counterexamples first failed on the original implementation and subsequently passed without changing their assertions. The bundle test setup adds `windowsHide: true` to its three subprocesses to satisfy the repository's existing Windows-console gate; its expectations are unchanged.

## Earlier repairs (publication protocol superseded below)

1. **Passage identity before persistence.** The RPC now transports vectors together with model id, registration generation, provider identity, runtime fingerprint, and dimensions. The worker compares that contract with its captured registration and query-vector dimensions before returning any passage vector to embedding backfill. Incorrect vector dimensions and non-finite values are also discarded. The original final-generation check remains an additional result fence, not the sole integrity check.

2. **Durable publication.** `auto_search_hint_decisions`, an existing JSON column in `context.db`, carries an internal `publication` object (`token`, `state`). A worker persists a `provisional` hint under `BEGIN IMMEDIATE` and waits on the same port/connection for the owner's timely publication command. A second `BEGIN IMMEDIATE` token-matched update marks it `accepted`. Direct reads, coherent replay snapshots, and Pi's independently loaded sticky projection all reject provisional entries and remove internal publication metadata from public decisions. Old entries without publication metadata remain accepted. No column, table, migration, dependency, or hint-text change is needed.

   A rejected provisional write is retired immediately off the turn path, including while its acknowledgement is delayed. The durable provisional state prevents other connections/processes from treating it as served in the interim. The same-worker handshake avoids an additional worker startup on successful turns. Cross-connection accepted SOFT replay and a separate-process provisional reader are both tested.

3. **Frozen skips.** The per-session/per-connection cache now retains a map of skipped message ids instead of overwriting one id. A durable-write failure on a second turn cannot erase the first turn's only freeze. A skip writer is counted successful only when its returned decision is actually `no-hint`.

4. **Cleanup fencing.** Background skip writers register shared cancellation flags. Session deletion cancels them before acquiring its deletion transaction. Workers check cancellation and the captured session row identity inside an `IMMEDIATE` transaction before appending, and do not recreate a row whose captured session has disappeared. Session cleanup also cancels queued writers. Writer deregistration is idempotent so a late exit callback cannot discard a newer writer's cancellation registration.

5. **Remaining-budget lock policy.** Search workers carry the original absolute deadline and refresh `busy_timeout` from the remaining budget after embedding continuations. Metadata writes and publication use that budget as well; best-effort background skips have a separate bounded 250 ms window. A normal 100 ms sibling writer hold no longer changes hybrid results into FTS-only results or reverses successful hint fragments. The owner still aborts its provider request and stops waiting at its deadline.

## OMP loader verification

The final Pi distribution worker was loaded by **actual OMP 17.0.4 extension initialization**, not merely a Node process with `harness=omp`. The probe used RPC mode, an open stdin pipe, no prompt, no tools/LSP/PTY/rules/skills, an isolated HOME/config/cache/session root, and no inherited credentials. The extension's factory started the real built `packages/pi-plugin/dist/auto-search-worker.js`, received the expected memory result, and exited cleanly. One actual loader/search check passed under Bun 1.4.2 (Node-compatible `process.version` v26.3.0).

Evidence is retained under `$TMPDIR/magic-context/auto-search-followup/omp-loader/omp-loader-evidence.json` and `host-output.txt`. The no-prompt factory is `auto-search-omp-loader.fixture.ts`. An initial EOF-based launch reached host readiness without invoking the extension factory; keeping the RPC input open and allowing isolated extension discovery reached the loader and worker. No model request was sent.

The imported bundle suite additionally tests built and packed entries on Bun and Node 24.16.0, OpenCode/OpenCode 2/Pi/OMP attribution, real independent writer locks, restart, retirement, and shutdown. Its ten variants each perform 18 worker checks, including the actual Pi host. `lsof` verifies all open database handles remain under each generated fixture root.

## Earlier verification

- The five imported red tests pass unchanged; added provider/dimension, accepted two-connection SOFT replay, and separate-process reader tests pass.
- Full Pi gate: 1,625 passed, three skipped, zero failed (1,628 tests across 155 files).
- Latest full plugin gate: 7,336 passed, six skipped, one unchanged baseline failure (7,343 tests across 714 files). The remaining temp-directory policy failure comes from the previously existing raw API import in `packages/e2e-tests/src/rust-runner/hermetic-subc.test.ts`; no unrelated fix was made.
- Initial full-gate Windows spawn and late-commit retirement failures were fixed, not reclassified: Windows subprocess options were corrected, and rejected durable publications now retire promptly. Both pass in the latest full plugin run.
- Both TypeScript gates and lint/build gates were run with isolated logs and throwaway HOME. No live store/config/log was opened or modified during this follow-up.
- Safe staged mutation controls re-exposed provisional entries to a second connection and retagged a new provider batch as the captured generation. Each reddened exactly its named imported counterexample while the other four review tests stayed green; each mutant was restored before delivery.

## Reader-only simplification after round 2

The round-2 report and its tests (`7f235c16feda0245125283a42c5b22dc3f6aea57`, accepted ref `refs/alfonso/accepted/bg_a0f7b373d3df719d`) were already present at this task's base, `09f16a0cf4`. They were inspected, not re-created from a summary. The historical publication protocol above is **removed**, not extended with another acknowledgement.

- The hint worker opens SQLite **read-only** and runs the existing search/ranking code with memory backfill, retrieval counters and shadow measurement writes disabled. It returns search fragments; the owner uses the unchanged hint builder and thresholds. There is no decision/skip/accept/retire command, publication token, provisional/accepted JSON state, reader decoder, or connection-local hint visibility fence. The decision type, append function, direct/replay getters and Pi projection are restored to pinned master's implementations (`41eedb38821d`).
- On a timely search result, the owner calls master's synchronous `appendAutoSearchHintDecision` and serves that same returned decision **without an intervening await**. On expiry it uses that same append path for a no-hint decision and retains the per-message skip map even if the durable append fails. A late search result cannot enter persistence. Same-turn passes still coalesce and replay into each caller's own array. An already committed owner decision is never rejected because of a later IPC acknowledgement: that boundary no longer exists.
- A separate, deduplicated backfill job starts on a timer **after** the owner decides a timely read's hint/no-hint outcome. Timed-out reads do not queue another embedding request. The job selects at most 50 missing vectors for the owning project, preserves the model/generation/provider/fingerprint/dimension checks, and uses a **250 ms** SQLite busy timeout plus a 10 s owner cancellation bound. It never writes session metadata or decisions. Workspace peer projects remain readers; their own registration/drain owns their backfill.
- Session cleanup cancels queued jobs, active provider RPCs and pending read results through a shared owner lifecycle registry. Coalesced readers do not replay a canceled operation. A canceled old operation cannot remove a newer operation's registration. A native SQLite transaction already executing at cancellation may finish a guarded **memory-vector** write; it cannot recreate or contaminate a session decision because no background job has that operation.

### Round-2 disposition and test contracts

All five round-2 tests required a worker operation that has been removed. They are replaced, not marked skipped/expected-red, by five real-worker cases in `auto-search-re-review.test.ts`: `re-review replacement: <trigger> worker writes no decision rows`. Each sends the former hint and skip command fields to the real reader, obtains a real memory result, and asserts no decision rows and no embedding writes, including through the actual pinned-master getter.

| Finding | Replacement trigger | Why the old state is impossible |
| --- | --- | --- |
| 1: old-reader provisional exposure | `older-reader provisional` | The worker cannot write a provisional hint; the owner stores only master's ordinary served decision shape. An added golden JSON/old-getter check pins compatibility. |
| 2: accepted commit / late final ack | `late accepted ack` | No acceptance transaction or final decision acknowledgement. A worker result is disposable until the owner writes and serves synchronously. |
| 3: pending hint writer resurrection | `pending hint cleanup` | No pending hint writer. A separate real runner cleanup test releases a late search result and verifies identical no-hint bytes and no session row. |
| 4: cross-owner skip / reused rowid | `reused skip rowid` | No queued skip writer or rowid fence. A skip append completes/fails before deletion can run on that owner; nothing remains to write into a replacement row later. |
| 5: backfill lease ranking difference | `backfill writer lease` | Search does not acquire the vector writer lock. Backfill runs separately after the hint is decided and cannot change its bytes. A real 400 ms independent lock proves the background job retains the 250 ms lease and writes no session row. |

The older round-1 provider tests now exercise the separate backfill job, retaining their integrity assertions and proving the passage callback actually ran. The short-lock comparison explicitly compares the **stored snapshot**, without inline backfill; the old expectation of two passage calls during ranking is intentionally changed to zero. Late-commit/late-ack fixtures and tests are removed because there is no decision worker. They are replaced by owner/coalescing/no-write/cleanup tests, not an acknowledgement simulation of the deleted protocol.

Golden FTS and hybrid tests compare real `unifiedSearch` with the worker and a literal pre-change hint string. The hybrid case supplies all stored vectors, so master's unmodified default search performs no backfill and observes the same snapshot. Successful bytes equal master **for the same stored-vector snapshot**. This is deliberately not a claim that a pure reader equals a master search that first mutates that snapshot with newly backfilled vectors. Explicit search retains its existing inline-backfill default; automatic hints now use only vectors already stored when ranking. Snapshot-only registration, cold-turn frozen skips, query cancellation/deadline checks, model identity and LKG timeout eligibility remain intact.

The 3 s budget bounds search and rejects an expired result before owner publication. Reverting decision writes to master's owner path also restores master's synchronous metadata-write cost (including its transform-pass foreground writer lease and possible checkpoint I/O). There is no hard native-I/O preemption guarantee for that synchronous append. In exchange there is no durable unserved hint or cross-reader acknowledgement race. The separate background backfill can never hold the served turn on its writer lock.

### Containment

Live-store rule, verbatim: never open, read, write or migrate the live stores (`~/.local/share/opencode/*.db`, `~/.local/share/cortexkit/magic-context/{context,store}.db`, `~/.config/opencode/*`, `~/.config/cortexkit/*`).

All new verification uses `$TMPDIR/magic-context/bg_3184f2a7ee926b68/` with a throwaway HOME, nested TMPDIR, XDG directories, storage and log path. Package tests unset OPENCODE_DB. Built/packed host probes retain explicit throwaway OPENCODE_DB and Pi/OMP configuration roots and their held-query `lsof` checks; the actual OMP loader case remains part of the bundle matrix, not a Node-only attribution substitute.

### Current verification record

Toolchain: Bun 1.4.2, Node v24.16.0, TypeScript 5.9.3, Biome 2.5.1. No manifest/lockfile changes; the package scripts' frozen installs checked 996 installs/1,251 packages without changes.

| Gate | Result |
| --- | --- |
| Full plugin `bun run --cwd packages/plugin test` | 7,337 passed, six skipped, 12 failed, 7,355 tests/715 files. Eleven failures were the bundle suite's remaining expectation of a retired decision/session row after its drivers had succeeded. That assertion was corrected to require **no row** for the reader-only contract; see the successful rerun below. The other failure is the unchanged temp-policy violation in `packages/e2e-tests/src/rust-runner/hermetic-subc.test.ts`. All other plugin families, including the new backfill, five replacements, bounded runner, postprocess/thinking-strip and LKG tests passed. No unrelated baseline fix. |
| Corrected bundle rerun | **11 passed, zero failed**, 56 assertions; 198 real workers (18 per variant) across built/packed OpenCode 1/2, Pi and OMP, Bun/Node, and actual Pi/OMP initialization. Startup failure, restart, reads under an independent writer lock, no-decision writes, repeated-session self-closing shutdown and `lsof` containment pass. |
| Full Pi `bun run --cwd packages/pi-plugin test` | **1,625 passed, three skipped, zero failed**, 1,628 tests/155 files, 84,538 assertions. |
| Final impacted-family rerun | After making the owner helper itself synchronous (no microtask gap between append and wire mutation), **322 plugin tests/eight files** and **174 Pi tests/three files** passed. The 11-case built/packed/Pi/OMP loader matrix ran again against the final rebuilt distributions. |
| Plugin/Pi typechecks | Both repository package scripts passed (TypeScript 5.9.3), including plugin script checking. |
| Plugin/Pi lint | Both package Biome gates passed. Plugin: 1,282 files, six pre-existing warnings/two infos; Pi: 246 files, six pre-existing warnings. |
| `bun run build:dists` | OpenCode 1/2 and Pi workers rebuilt; four v2 server tests passed and `dists LOAD OK`. |
| Scoped AFT inspection | Partial: TypeScript reported zero diagnostics, but Biome producer and checkout callgraph were unavailable. Package typechecks/lint are authoritative. |

Safe staged non-vacuity proofs were restored before delivery. Restoring worker-side hint publication for the old-reader trigger reddened exactly `re-review replacement: older-reader provisional worker writes no decision rows` (the other seven re-review cases passed). Removing the owner cleanup-result fence reddened exactly `session cleanup discards a pending search result without recreating its decision row` (the other seven bounded cases passed). Both mutations were marked `NON-VACUITY BREAK`, had a non-empty working diff during the test, and an empty diff after index restore/touch. These are tests of the removed publication capability and of the remaining owner lifecycle boundary, not a claim of cross-process ownership fencing for ordinary master writes.

Example current actual-OMP `lsof` context handle (the driver also checked its `agent.db` and `models.db` handles under the same fixture root):

```
/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/bg_3184f2a7ee926b68/tmp/magic-context/bg_a8d894f629e2c52f/mc-test-owned-bundle-RTKnlm/context.db
```

The matrix's `evidence.json` files retain versions, harness, execution counts and observed handles. Actual OMP evidence covers a probe extension loading the shipped worker without a model prompt; it is not a full Magic Context turn or Desktop/Electron application run.
