# Auto-search turn deadline diagnosis

## Evidence and scope

Only the allowed plugin log was read; no live SQLite store or host configuration was opened, copied, or migrated. The real log path was resolved with `getconf DARWIN_USER_TEMP_DIR`, not treated as a repository filename. The log's 2026-10-07 18:42:00.920Z records confirm a 3,000 ms timeout and a **5,612.8 ms** `pp.autoSearchHint` stage, followed by `lkg_capture_declined degradations=auto-search-timeout`. The 17:36:24.327Z stage reached 7,228.3 ms. The log does not break down query/provider/SQL timings or identify the provider for those searches, so an exact allocation of those live milliseconds cannot honestly be inferred from the log alone.

All measurement stores were generated from scratch under `$TMPDIR/magic-context/auto-search-deadline/`. The reproducible driver is `packages/plugin/scripts/experiments/profile-auto-search-fixture.ts`; it accepts no live-store path and uses only a loopback OpenAI-compatible embedding server. Run it with a throwaway HOME, for example:

```sh
mkdir -p "${TMPDIR%/}/magic-context/auto-search-deadline/home"
env -u OPENCODE_DB HOME="${TMPDIR%/}/magic-context/auto-search-deadline/home" \
  bun packages/plugin/scripts/experiments/profile-auto-search-fixture.ts
```

The fixture contains 200,000 tags, 60,000 indexed messages (~1.6 KB each), 1,300 memories, 500 commits, and 500 history chunks, with 4,096-dimensional stored vectors. The query is `historian cache wiring`, intentionally common in the corpus. This is a sized synthetic fixture, not a claim to reconstruct private session content or its exact selectivity.

## Where the time goes (file:line)

- `packages/plugin/src/features/magic-context/search.ts:2089`: the query embedding is started once. `project-embedding-registry.ts:2533` dispatches to the registered provider. For the measured OpenAI-compatible provider, `memory/embedding-openai.ts:313-343` connects the caller's abort signal to the POST `/embeddings` fetch. Provider selection in a real session is configuration-dependent; no real endpoint was contacted.
- `search.ts:2105` is **only a microtask yield** (`await Promise.resolve()`), not an event-loop/I/O yield. The synchronous message SELECT at `search.ts:2115`, implemented at `search.ts:1037`, can still delay both fetch progress and the deadline timer. `Promise.race` cannot preempt it. Checking elapsed time afterward discards a late result but cannot give the waiting turn its time back.
- `features/magic-context/message-fts-session-filter.ts:37-41,86`: the session-first coverage proof scans docsize/map rowids with `EXCEPT`; its cache is invalidated by local/external writes. The selected FTS query still does global-corpus bm25 ranking and content reads for qualifying rows. The sidecar is a correctness-preserving filter, not an execution deadline.
- `search.ts:906,683`: memory FTS, candidate loading, and vector scoring. Missing memory vectors can also invoke passage embedding backfill (`memory/embedding-backfill.ts:31`), which previously had no auto-search signal. It must share the budget too.
- `search.ts:1600` and `search.ts:1808`: history chunk and commit vector/FTS work. These remain synchronous SQL/vector scans.
- `packages/plugin/src/plugin/embedding-bootstrap.ts:60` and `packages/pi-plugin/src/embedding-bootstrap.ts:70-158`: registration/config loading can do synchronous work, including cached-path identity maintenance in Pi at lines 86–89. Auto-search no longer awaits these callbacks. It reads its current owner snapshot at `auto-search-runner.ts:266`; cold turns skip immediately and queue registration through `auto-search-worker-client.ts:100`. The deliberately 3,600 ms synchronous preparation test failed before this change with a 3,619 ms stage, and now proves that preparation runs only after the stage has returned.
- Tags are not scanned by `unifiedSearch`: the instrumented searches made **zero tag-table reads**. Tag count alone is not the search cost driver.
- `storage-meta-persisted.ts:1705`: decision persistence can also checkpoint a large WAL. An intermediate fixture run with synchronous timeout persistence returned after 4,284.8 ms despite off-thread search. Moving only the SELECTs was insufficient; decision writes now share the remaining deadline, and timeout-skip persistence is off the served path.

## Measurements

Bun 1.4.2, final contained-log synthetic run (`profile-zZrr42/profile.json`). Wall-clock timings vary with the shared host's load/cache; SQL lane times are not additive with an embedding call that overlaps them.

| Measured lane | 250 ms provider stub | 6,000 ms slow stub |
| --- | ---: | ---: |
| Original `unifiedSearch` inside its existing deadline wrapper | 1,512.3 ms | 3,003.4 ms, skipped |
| Query embedding wall time (including delayed I/O dispatch) | 1,360.1 ms | 3,003.3 ms, aborted |
| Session-first map proof SQL | 10.6 ms | 10.9 ms |
| Message FTS SELECT | 663.2 ms | 591.7 ms |
| Memory FTS SQL | 5.8 ms | not reached before abort |
| Memory pool/vector SQL | 58.3 ms | not reached |
| History vector SQL | 9.7 ms | not reached |
| Commit FTS SQL | 1.3 ms | not reached |
| Commit pool/vector SQL | 5.3 ms | not reached |
| Fixed off-thread search | 1,157.8 ms | 3,003.8 ms, skipped |
| Fixed entire runner, including decision persistence | 930.1 ms, hint | 3,002.7 ms, no hint |
| Same-turn retry | 0.963 ms | 0.029 ms |

Source-only warm searches with a precomputed vector took 13.6 ms for memories, 834.6 ms for messages + history vectors, and 49.1 ms for commits. This includes JS scoring/ranking, not only SQL. Earlier fixture samples ranged from 267.6 to 1,042.4 ms for message FTS versus 6.4–11.7 ms for the coverage proof. In this fixture the main synchronous cost is message FTS, not the map proof or memory/commit vectors. A separate deliberately slow synchronous SQLite recursive SELECT proves the timer/turn bound independently of corpus selectivity.

The worker is not an optimization of ranking SQL: it protects the turn's latency under arbitrary slow SELECTs. Worker startup adds overhead on fast searches. Original ranking, source filters, stored model identities, and the hint builder remain the authority for successful hints.

## Deadline, bytes, and retries

Both runners use the shared `auto-search-worker-client.ts` path. They use an already-established registration snapshot and never await registration, configuration loading, or embedding-identity maintenance on the hint stage. A cold/unregistered turn is frozen as no-hint and queues one deduplicated background registration; it never gets a recovered hint on a later pass of the same turn. A subsequent user turn can hint once registration is ready. Startup registration is unchanged (including Pi's `index.ts:1488` startup call).

The intentional configuration behavior change, approved by the parent: **a config edit reaches automatic hints when bootstrap or an explicit tool refreshes the snapshot**, rather than auto-search itself loading the edited config. Cold background preparation uses the existing registration callback, without awaiting it; the callback's maintenance is not itself redesigned as off-thread work.

SQL, vector scoring, and backfill transactions run on a worker-owned connection with no migration/bootstrap. Provider RPCs run on the owner using its real project registration and the same deadline signal, including passage backfill. At the deadline the owner aborts provider requests and terminates search workers without waiting for their synchronous SQL to acknowledge cancellation. A provider ignoring cancellation cannot send its late response into a terminated worker or another turn.

Decision persistence also uses the remaining original budget, not a second three seconds. A write worker that misses the deadline is allowed to retire its exact unserved hint after COMMIT instead of being killed mid-commit. Connection-local read fences suppress provisional hints in both direct decision reads and replay snapshots; those fences survive ordinary skip-cache cleanup until acceptance or durable retirement. Concurrent same-turn passes join one owner and replay into their own message arrays. Even a timely commit with a late IPC acknowledgement is retired, with cheap bounded background lock retries. A failed retirement keeps the in-process read fence closed; this is not a crash-recovery protocol.

`transform-postprocess-phase.ts:3538-3578` also gates the persisted-hint count delta on a successful runner outcome. A provisional row must not be treated as an actual served prefix edit: without this gate, a skipped hint could trigger proactive removal of older signed thinking. A whole-request regression test compares the real served role/part bytes against the old no-row skip path; its mutation control removed eight signed reasoning blocks and failed that named test.

Timeout no-hint persistence is best-effort and off-thread: a writer lock/checkpoint cannot extend the skipped turn. The latch keeps same-turn retries cheap even when that durable write loses a lock race. A process restart after a failed durable skip write remains subject to the existing live-tail gate; this change does not add a crash-recovery guarantee for a skip whose persistence failed.

Previously a timed-out operation's own promise could finish late, but `Promise.race` did not itself append that late result. The real cache hazard was a **fresh retry on the same still-tail user message**, which could add a recovered hint after an earlier pass had already served the turn without it. Timeout is now a sticky no-hint decision for that user turn. New user turns still get fresh searches with a bounded budget. Search errors retain the existing retry behavior, but their searches are now off-thread/bounded.

Provider RPCs also preserve the owner's harness identity and busy-host backfill gate (refreshed on embedding continuation), rather than using empty worker-local activity state. A parity test checks the original search against the worker while the owner is busy; a Pi test checks newly persisted session rows retain `harness=pi`.

No hint-format changes were made. A golden literal test compares the original search/builder output with the actual worker-backed served payload; the loopback sized benchmark also compares successful hint bytes. Timeout/late-result tests compare complete serialized messages, including a late decision-write acknowledgement, and assert cheap retries. Pi has real shared-worker slow-embedding and slow-SQL stage tests, not only source-string checks.

## Last-known-good capture

Declining LKG capture solely because an optional fresh-tail hint timed out was incorrect. The request is complete and actually served: existing managed history and persisted earlier hints have already been replayed, and the new turn simply has no hint. The size guard already classifies this as a `served` degradation. Capturing the served no-hint request is safer than retaining an older snapshot that omits this turn.

`pass-outcome.ts:105-123` now permits capture after finalization when all recorded degradations are nonfatal `auto-search-timeout` skips. Fatal and other degradation sites remain ineligible. The dedicated capture-policy test exercises both accessors, mixed failures, and fatal timeout. Existing fail-closed / LKG replay behavior is not relaxed for failures that can change managed bytes.

## Verification contract changes

The old tests explicitly claimed that a timeout remained retryable for the same message. Their assertions were intentionally changed to sticky timeout skips, because the old behavior both repeated expensive work and could rewrite already-served bytes. Existing auto-search spies now target the worker executor seam and provide an explicit registered test snapshot; explicit `ctx_search` tests still target `unifiedSearch`. Preparation tests were changed from awaiting a timed registration to freezing cold-turn skips and establishing the next turn's snapshot, following the approved snapshot-only boundary. No schema migration, package dependency, or hint-text change was introduced.


## Verification and containment disclosure

- Required package commands were run with a throwaway HOME and without `OPENCODE_DB`. The latest full plugin run reported 7,310 passed, 6 skipped, and one pre-existing repository-wide temp-policy failure: unchanged `packages/e2e-tests/src/rust-runner/hermetic-subc.test.ts` still imports the raw temp-directory API. No unrelated file was fixed. The final affected plugin families (including all postprocess and sticky-CAS cases) passed **332 tests across 9 files**.
- Pi's full suite passed once (1,623 passed, 3 skipped); a later full run had only the existing 1,500 ms first-turn lock-wait timing test fail under host load. That unchanged test passed its narrow rerun. The final affected Pi families passed **174 tests across 3 files**. An earlier plugin `git init` ten-second timeout also passed its narrow rerun and the final full run.
- Both package typechecks passed with TypeScript 5.9.3. Biome 2.5.1 lint passed (plugin: 1,275 files, six existing warnings/two infos; Pi: 246 files, six existing warnings). Final builds include the worker in OpenCode, OpenCode 2, and Pi distributions. Node 24.16.0 exercised all three built workers: nine checks covered ranking bytes, correct `opencode`/`opencode2`/`pi` attribution, and durable retirement.
- Failing-first checks captured the original synchronous-search overrun (3,605 ms), synchronous-preparation overrun (3,619 ms), worker-local harness mismatch, missing busy-host backfill gating, and provisional-hint concurrency race. Safe staged mutations proved the cancellation, retirement, LKG capture, replay-read fence, served-prefix strip guard, and driver-log containment checks can fail.
- **Containment incident:** the initial host fixture runs had a throwaway HOME/store but omitted `MAGIC_CONTEXT_LOG_PATH`; the normal buffered logger therefore appended 13 confirmed `synthetic-session` diagnostics to the allowed live plugin log. No prohibited live database/configuration path was opened or modified. The parent approved continuing with disclosure, leaving those lines untouched, and correcting the driver. The driver now sets its log path inside its generated fixture root and refuses any resolved path outside that root before opening a fixture database or starting its server. Positive/negative child-process tests and a mutation control verify that guard. The final benchmark's diagnostics are in `profile-zZrr42/plugin.log`, not the live log.
