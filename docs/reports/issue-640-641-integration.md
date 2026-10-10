# Combined issue 640 / issue 641 integration

The merge brings `9f3e42e5a668e8f772cbf2a23a31b69ece0cc7a7` onto master `5292c42f030202a77dfc7ec8080158166acfc17c`. It resolves the three Pi conflicts without replacing master's pipeline with the older branch's pipeline.

## Preserved contracts

- Pi keeps issue 634's measured input floors and issue 636's rejection of aggregate billing usage. Historian scheduling receives the same admitted request-pressure snapshot as reclaim, rather than recomputing pressure from the rejected aggregate.
- The pipeline retains `keepReasoningTokens`, provider/model identity, the protected mutation view used by issue 630, and the reasoning-budget status capture. Issue 637's task-child terminal-result latch and the historian input template remain unchanged from master.
- Issue 640 retains LKG-first recovery, bounded writer admission, atomic fallback-ID adoption, durable evidence of actually served tag numbers, and visible refusal rather than unmanaged raw fallback.
- Issue 641's one clock still provides a 25-second outcome deadline and a 21-second optional cutoff. Required tagging/reclaim, serialization and managed-result publication share the outcome clock; dispatch receipts, side-session classification/latch, ownership checks and late-publication fences remain in place.
- Auto-search retains master's pure-reader worker, registered snapshot, concurrent-turn coalescing, cold/timeout skip decisions, and deferred registration/backfill. Both the worker continuation and a joining caller's replay are fenced by that caller's optional budget. SQLite waiting in this stage is also clamped to the optional cutoff, not the mandatory outcome margin.
- Historian trigger evaluation, including the spent-drain gate, uses the optional SQLite guard. Deferred startup rechecks the originating pass's optional cutoff. A successfully completed pass has already admitted its background run, so an immediately following context pass does not cancel that admission. Once started, the historian's own lease controls its independent publication; foreground context work never joins it.

The side-session latch's documented limitation is retained: once an attributed OMP side context has engaged the session latch, the independent provider-dispatch backstop is disabled for that session because the host erases operation attribution and exposes only session-wide abort. Internal budgets and publication guards remain active. This merge does not claim an operation-scoped host guarantee.

## Test expectations and fixture adaptation

No pre-existing assertion was changed while resolving the merge. The two incoming r2 auto-search cancellation fixtures now pause `searchAutoHint` at master's worker-client seam and provide a registered embedding snapshot. Pausing the removed foreground `unifiedSearch` call left them waiting forever; their cancellation, persisted-decision and LKG assertions are unchanged.

The imported stack already changes several master-era fixtures as part of the requested behavior. They are retained, not silently introduced by conflict resolution:

| Fixture | Existing incoming change and reason |
|---|---|
| `context-handler.test.ts` fallback collision | Adds explicit served-number evidence before testing preservation of tag 71; marker-looking text alone is no longer proof that an identity was served. |
| `context-handler.test.ts` tool-owner cheap gate | Changes resolver calls from zero to one and asserts preparation occurs outside a transaction. A sibling writer can add an owner before admission; discovery is no longer a safe reason to skip identity preparation. |
| `context-handler.test.ts` refused-transform diagnostic | Waits one immediate turn before checking the same diagnostic value; refusal is synchronous, but diagnostic persistence is deliberately deferred. |
| `context-handler-lkg.test.ts` | Raises the individual test timeout to 40 seconds without changing its assertions, accommodating bounded writer retries. |
| `issue-601-pi-admission-review.test.ts` | Keeps fast fitting-LKG replay, but first admission without a fitting LKG gets the shared yielding writer budget. A 3.2-second writer now releases before a managed first turn instead of forcing immediate refusal; held-writer/no-LKG cases assert the 16.5-second admission bound. |
| `pi-context-host.test.ts` | Keeps the refusal message prefix and adds required stage/elapsed/recovery diagnostics instead of requiring the old exact diagnostic-free string. |
| `signal-peek-drain.test.ts` | Recognizes `budget.waitMandatory(runPipeline(...))` as well as a direct await. The signal-retention and post-pipeline ordering assertions are unchanged. |

New regressions cover a worker result after the 21-second cutoff, an expired caller joining a coalesced hint, and deferred historian startup crossing the cutoff after scheduling. The startup fixture observes synchronous registration, not the recovery notification, because that notification belongs to the deferred boundary preparation. Named-red mutation controls and final verification are recorded with the external receipts.

`docs/reports/issue-640-review-r2.md` is absent at the supplied tip and was not found by the path/history research. The available review, review-resolution, round-three resolution, imported r2 tests, and issue 641 report supply the round-two contracts; no replacement report or compatibility shim was invented.

## Evidence location and isolation

All 86 generated files formerly under `docs/reports/probes/issue-641/evidence/` were copied with SHA-256 equality checks to `~/.local/share/cortexkit/magic-context/specimens/issue-641/evidence/`, preserving every relative path, then removed from the merge tree. The copy totals 3,804,558 bytes. Evidence files are mode `0600`; evidence directories are `0700`. Probe scripts remain in Git.

This merge's new receipts are under `~/.local/share/cortexkit/magic-context/specimens/issue-641/evidence/merge-bg_5a376fad/`. Host installation uses the exact disposable OMP 18.8.6 recipe, without changing repository manifests or lockfiles. Bun installed 112 packages and blocked two dependency postinstalls.

Every Mac host invocation uses a separate root beneath `$TMPDIR/magic-context/bg_5a376fad/`, with HOME, CFFIXED_USER_HOME, all XDG data/config/state/runtime/cache roots, OPENCODE_DB and MAGIC_CONTEXT_STORAGE_DIR redirected there. Host, task-child and independent writer `lsof` receipts contain nonempty database descriptor lists restricted to their disposable roots. No live store or live configuration was opened, copied or migrated. The collector validates real captured provider text and the absence of served/LKG/decision/drop publication after refusal.

## Mac host reruns

Built locally solely to run the native host probes: Bun 1.4.2, OMP 18.8.6, macOS arm64, loopback Anthropic mock. These are observations, not Windows or production-provider latency guarantees.

| Probe | Result |
|---|---|
| `host.ts fast --fixed` | One managed HTTP request at 1,009 ms. The collector confirms captured managed text appears in the actual provider body. |
| `host.ts slow --fixed` | Zero HTTP requests; visible dispatch refusal; no late managed publication. |
| `host.ts outcome --fixed` | Zero HTTP requests with a 60-second writer and 25.1-second internal stall. Expiry fallback: 9 ms; handler duration: 25,439 ms; prompt-to-return: 30,958 ms. The handler remains below OMP's 30-second callback deadline. |
| `subagent.ts 2.2` | One managed, tagged task-child HTTP request 2,888 ms after lock acquisition; actual async task result completed. |
| `subagent.ts 60` | One managed, tagged task-child HTTP request 60,650 ms after lock acquisition, none while the long writer remained held; actual async task result completed through the host's retry/reminder path. |

All five probes exit zero. `collect.ts --implementation` preserves three host receipts and verifies real-provider-body inclusion and refused-turn publication invariants. Subagent scripts preserve their own full captures and descriptor receipts.

## Linux verification

All authoritative build/test/typecheck/lint gates requested `runon: "linux"`, asserted `uname -s = Linux`, ran as background jobs, and were collected with `bash_watch`. Bun is 1.4.2, TypeScript 5.9.3, Biome 2.5.1; the builder reports Linux x86_64. Full package suites use throwaway HOME and XDG/storage roots with `OPENCODE_DB` unset. Frozen-lockfile installs report 1,010 checked installs across 1,251 packages, with no manifest or lockfile changes.

| Final gate | Result |
|---|---|
| `bun run build` | Pass: seven bundling steps, TUI generation check (9 unchanged files), local-fs compilation and declaration generation; plugin, Pi and CLI builds completed. |
| Master plugin suite | 7,458 pass / 9 skip / 1 fail; 7,468 tests across 732 files. |
| Merged `bun run --cwd packages/plugin test` | 7,470 pass / 9 skip / 1 fail; 7,480 tests across 736 files. |
| Master Pi suite | 1,684 pass / 3 skip / 0 fail; 1,687 tests across 166 files. |
| Merged `bun run --cwd packages/pi-plugin test` | 1,753 pass / 4 skip / 0 fail; 1,757 tests across 179 files. |
| `bun run --cwd packages/plugin typecheck` | Pass; local-fs build configuration, plugin `tsc --noEmit`, script configuration. |
| `bun run --cwd packages/pi-plugin typecheck` | Pass; local-fs build configuration and Pi `tsc --noEmit`. |
| `bun packages/pi-plugin/node_modules/typescript/bin/tsc -p docs/reports/probes/issue-641/tsconfig.json` | Pass; nine probe roots and their imported sources. |
| `bun run lint` | Pass; 1,728 files (1,311 plugin / 274 Pi / 137 CLI / 6 local-fs), warnings/infos only. |

The plugin failure-name sets are identical, with no head-only or master-only failures. The sole failure is `Node WASM Transformers fixture > builds with real fs and persists a model for offline reuse`, whose temporary bundle cannot resolve `onnxruntime-web/webgpu`. Pi has no failure names at either revision.

Initial verification attempts are not treated as final passes: isolated HOME initially exposed Git's remote ownership check; command-local `safe.directory` fixed it without global Git changes. Baseline tests initially lacked built distribution workers; subsequent gates build the relevant revision before testing. One remote build request was refused before execution with `queue_wait_exceeded` while the same workspace's test job owned its slot; it was retried remotely only after that job ended. Intermediate packed-bundle failures at both revisions and one slow-embedding timing failure disappeared in the final isolated npm-cache run; the nine runnable bundle controls also pass independently (two unavailable CLI runtimes skipped). The r2 cancellation fixtures' obsolete search seam and the new startup fixture's premature notification observation were corrected as described above, without changing existing behavioral assertions.

Editor inspection was partial because this worktree lacks authoritative Biome/callgraph analysis. The explicit compiler, package suites and lint are authoritative. Sidekick comment review examined the six critical runtime/guard files; the stale process-local auto-search cache description and genuinely unclear merge budget comments were rewritten.

Three non-vacuity controls use stage-before-mutate, a captured nonempty working diff, named red, checkout-and-touch restoration, and an empty working diff after restore:

- Omitting the deferred startup check fails only `deferred historian startup respects the originating pass optional cutoff` (runner called once instead of zero; the unrelated outcome test filtered out).
- Neutralizing auto-search's pass assertions and waits fails `runAutoSearchHintForPi > does not publish a worker hint beyond the pass optional cutoff` (promise resolves instead of rejecting; 19 unrelated tests filtered out).
- Omitting only the joining caller's replay assertion fails only `runAutoSearchHintForPi > does not replay a coalesced hint into an expired joining pass`; the other 19 auto-search tests pass, including the worker-result cutoff control.

After restoring all three mutations, `bun run --cwd packages/pi-plugin test:serial src/auto-search-pi.test.ts src/issue-641-outcome.test.ts` passes **22 tests across 2 files**, 66 assertions, with Bun 1.4.2 on Linux. No mutation marker remains in the delivered code. Full final-suite/typecheck/lint receipts and the named-red transcripts are preserved outside the repository alongside the Mac captures.
