# Issue 640: completion of the six independent review findings

On Pi and Oh My Pi (OMP), refusing a provider turn during SQLite writer contention can strand a subagent because the host does not reliably resend that turn. The repair must try a validated last-known-good (LKG) saved request before bounded writer retries, then visibly refuse instead of sending unreduced history. Magic Context's `§N§` markers identify message/tool tags; a number already present in a returned provider context must not change merely because a stored row later acquires a real host id.

This completes the six findings in `issue-640-review.md`. Four repairs had been committed before the earlier editing run was interrupted, at `85946232c574f719b9e7e065d7a74f4b4b2be9c0`; this run independently retested them, repaired the remaining collision/order findings, and finished package/host verification. The worktree was clean at entry. None of the independent review's test expectations or test names was changed.

## Findings and commits

| Finding | Repair commit | Implementation / evidence |
| --- | --- | --- |
| 1. Wire-visible bookkeeping | `d08ef6f2c38a370306cc27639f1e6cd977859797` (inherited) | Normalize only the five proved direct API constructors cited in `pi-lkg.ts`; transport overrides and unknown APIs retain the complete fence. Both Pi `pi-messages` root-field assertions and the pinned OMP pi-native serializer control pass. |
| 2. Stale admitted continuations | `9dabd949dc95ba64e714195427a22ece32b43d35` (inherited) | A shared guard checks that the context pass still owns its session's generation before checking its signal, preventing an abandoned pass from resuming after a successor or cancellation. It surrounds historian/pipeline/auto-search waits and adoption, tagging, publication, return and queued LKG capture. Both late-adoption review assertions pass. |
| 3. Superseded + aborted waiter | `30332f5cc882eef33501a8d739add25c28f5d0e1` (inherited) | Generation is checked before the signal, including the catch guard. The old waiter does not abort the replacement session. |
| 4. Historical discovery | `85946232c574f719b9e7e065d7a74f4b4b2be9c0` (inherited) | Carry the revision from before the negative preflight. Rebuild pristine fingerprints including reusable/served ids when revision changed; unchanged revisions retain the fast path. The racing historical-drop review and discovery controls pass. |
| 5. Actually served collision number | `98eb716ba0b16dbb80a9aa9b2bb6f302c20b1183` | Accumulate numbers from actual returned-array records, including detached LKG bytes. Feed that evidence to message and tool-owner adoption. The served fallback or real number wins regardless of allocation order; metadata, MAX accounting, aliases and pending operations still fold. If multiple collision identities were already served, refuse adoption before any fold; otherwise choosing either row could change a served message's number. When neither was served, retain the canonical real key. |
| 6. OpenCode LKG-first order | `e40ce8c4f5e5190835fc41096ba3b06fe7e1559e` | Extract the existing validated, fit-checked replay logic and call it from both writer `beforeRetry` hooks: the shared messages wrapper and OpenCode 2's earlier context admission. Successful replay stops admission without running the transform. No admissible LKG retains the acquisition policy; both-host uncontended-byte controls pass. |

Finding 5 also preserves the existing real-row-wins regression. That fixture now supplies an actual served-array record for its claimed served real row; its expectations are unchanged. Four new controls cover served fallback and real rows for both message and tool-owner collisions; two additional controls require conflicting already-served rows to throw without changing either row. The in-memory session record retains numbers actually seen in returned provider arrays until session cleanup. It introduces no store migration and does not treat a newly allocated/committed row as proof of a provider send.

Finding 6 has an additional actual OpenCode 2 outer-hook regression. Its first successful wrapper pass captures a managed prefix and the real system replay tracker; the second pass injects one failed BEGIN. It asserts a complete fit envelope, exactly one acquisition, no second transform callback, identical served messages/system, and no host interrupt. The fixture transform is deliberately simple, like the independent wrapper review; the hook, writer helper, saved-request validator, fit check and system restoration are real.

## Every review assertion: before and after

“Reviewed” below means the failing tests against the implementation before these six repairs, as recorded by the independent reviewer. Red means failed; green means passed. “Incoming” is the focused run actually performed at `85946232`: **14 passed, 2 failed**, 77 assertions across the two review files, Bun 1.4.2. It independently confirmed all four inherited repairs.

| Exact test name | Reviewed | Incoming | Final |
| --- | --- | --- | --- |
| `review: Pi pi-messages wire-visible root completedAt invalidates LKG` | red | green | green |
| `review: Pi pi-messages wire-visible root contextSnapshot invalidates LKG` | red | green | green |
| `review: successor fences an admitted Pi pass before late adoption` | red | green | green |
| `review: signal fences an admitted Pi pass before late adoption` | red | green | green |
| `review: an aborted superseded waiter must not abort its replacement` | red | green | green |
| `review: adoption discovers a racing drop for an already-served historical message` | red | green | green |
| `review: a racing real-id row must not renumber the already-served fallback message` | red | red (`§9§` instead of `§1§`) | green |
| `review: OpenCode tries a valid saved request before backed-off writer retry` | red | red (3 acquisitions, 1 callback) | green (1 acquisition, 0 callbacks) |

Final focused gate with the pinned **OMP 18.8.5** installation: **72 passed, 0 failed, 337 assertions across seven files**. It includes both unchanged review files, real Pi and OMP converter/schema controls, historical discovery controls, served-array/collision tests, and signal peek/drain source fences. The optional controls loaded the actual OMP 18.8.5 converters/schema export; a normal unpinned suite runs only the installed Pi converter controls.

## Real OMP 18.8.5 lock-holder rerun

The appendix recipe in `issue-640-subagent-busy-refusal.md` was recreated with the current locally built extension, real OMP `task`/`yield`, a local Anthropic mock, and an independent Python SQLite writer. A probe before Magic Context takes the lock on the first child context. No credentials or external provider were used.

| Holder | Disposable root suffix | Child result | Visible storage refusals | Child HTTP while held | Managed child HTTP after lock observation |
| --- | --- | --- | ---: | ---: | --- |
| 2.2 s | `omp-e2e-7m7Ojv` | completed in 3.3 s | 0 | 0 | one, +2,640 ms |
| 10 s | `omp-e2e-e0pEsY` | completed in 10.7 s | 0 | 0 | one, +10,137 ms |
| 60 s | `omp-e2e-zLnzkR` | two refused turns while held; later reminder completed after release, 60.9 s total | 2 | 0 | one, +60,528 ms |

All three captured child requests contain managed § tags. The 60 s case has actual visible `PiStorageBusyError` refusals, not raw sends. As in the prior implementation appendix, the finite holder does **not** terminally cancel the child: OMP's real reminder ladder tries again, and a later reminder succeeds after release. The reproduction therefore proves refusal/no-send during contention, not permanent child cancellation. The first refusal in this run spent 19.1 s of writer acquisition (the run overlapped package verification); the next spent 16.5 s. No timing expectation was weakened to accommodate that observation.

### Live-store isolation

**Never open, read, write or migrate the live stores (`~/.local/share/opencode/*.db`, `~/.local/share/cortexkit/magic-context/{context,store}.db`, `~/.config/opencode/*`, `~/.config/cortexkit/*`).**

Every host invocation, including `--version`, received `createPiIsolatedEnv`/`childEnv` before launch: HOME, CFFIXED_USER_HOME, XDG data/config/cache/state/runtime, OMP agent directory, OPENCODE_DB and MAGIC_CONTEXT_STORAGE_DIR all point below the disposable root. TMPDIR was redirected below the system temporary directory's `magic-context/bg_d6389048597f0f97/hosts/`; no live store was copied. The host working directory is disposable too.

`lsof -p` was captured at start/end, on every host context, and for the independent held-locker PID. Across **26 descriptor snapshots / 532 database descriptor rows**, every `.db`, `.db-wal` and `.db-shm` descriptor is below its own throwaway root; zero outside-root matches. These are positive descriptor snapshots, not a historical syscall audit of already-closed files.

Reproduction roots are under `/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/bg_d6389048597f0f97/hosts/`. Each retains `audit.jsonl` (full lsof and timestamps), `lsof-start.txt`, `lsof-end.txt`, `magic-context.log`, `events.jsonl`, `provider-requests.json`, `result.json`, and the real OMP child transcript. The worktree's `.cache/issue-640-final/evidence/reproduction-summary.json` asserts managed tags, no request during each held interval, visible refusal on the long hold, and no outside-root database descriptor.

## Gates and retained evidence

Versions: **Bun 1.4.2 (744846f84)**, **TypeScript 5.9.3**, **Biome 2.5.1**, pinned **OMP 18.8.5**.

- `bun run test`, `packages/pi-plugin` on delivery code: **1,665 passed, 3 skipped, 0 failed**, 84,759 assertions, 1,668 tests across 161 files (240.15 s).
- `bun run test`, `packages/plugin` on delivery code: **7,330 passed, 7 skipped, 7 failed**, 214,108 assertions, 7,344 tests across 714 files (151.68 s). The migration guard reported concurrent Pi processes **79685** and **86408** against disposable upstream-v0 fixtures, refusing migration before the intended test behavior. Affected tests: two storage-db async-open assertions, two migration-worker host-boot assertions, the V2 boot-timeout assertion, the existing V2 checkout-claim admission test, and the new V2 outer-admission test. Missing `session.wait` on those fake hosts was a secondary error after the unexpected guard refusal. No migration guard was disabled and no expectation changed. `ps` afterward confirmed both named PIDs had exited; the five impacted files then passed in isolation: **75 passed, 0 failed, 448 assertions** (24.76 s), including the new V2 outer-admission assertion.
- Prior normalized-HOME plugin suite: **7,336 passed, 7 skipped, 1 unrelated timing failure**, 214,130 assertions, 7,344 tests across 714 files (209.97 s). The sole failure was unchanged `tool-style transaction outside a pass waits for a brief lock`: measured wait 160 ms versus its 250 ms floor. Its complete file (`sqlite-pass-scope.test.ts`) then passed in isolation on native macOS: **6 passed, 18 assertions** (the brief-lock test took 330 ms total); it also passed on Linux. No timing test or production timeout was changed. All review and new collision/order tests passed in that complete run.
- Both package `bun run typecheck` scripts: passed, exit 0 (TypeScript 5.9.3).
- Pi `bun run lint`: passed, 254 files checked, zero errors, 10 existing warnings.
- Plugin `bun run lint`: passed, 1,274 files checked, zero errors, 6 existing warnings and 2 informational diagnostics.
- Pi build: passed locally for the real host run and again on Linux for the delivery files (984 extension modules, plus 22 browser-worker modules).
- Plugin build: passed locally, then again on Linux for the delivery files (680 OpenCode 1 modules, 727 OpenCode 2 modules, two 22-module browser-worker bundles; TUI generation checked 9 files with zero changes and declaration emit succeeded).
- Both-host storage-busy policy plus wrapper/V2 outer-hook focused gate: 52 passed, 148 assertions; unchanged no-LKG retry and byte-identical uncontended paths are included.
- AFT inspection is partial because Biome/callgraph producers are unavailable, and the final inspection did not receive TypeScript diagnostics for the wrapper/V2 context files within its budget. Published diagnostics show no errors; the explicit package typechecks/lints are authoritative.

Build/test/typecheck/lint commands requested Linux wherever possible. The first focused gates ran there. Later requests were refused as `runner_draining` and the tool automatically ran them on macOS; no local retry loop was used. The Linux runner recovered for the final delivery typechecks, lints, both builds and the isolated timing-file run. One delivery command initially failed before any check ran because its log redirection targeted an ignored directory absent on Linux; the corrected command emitted output inline and passed. Its version lines and counts were copied into `linux-delivery-gates.txt`. The isolated remote timing-file command passed six tests, but its HOME canonicalization failed because that temporary directory was absent, so the correctly canonicalized native rerun above is the claimed HOME-isolated timing verification. Pinned host/converter execution and the built native-host reproduction intentionally run locally. The complete suites ran locally because they include macOS-native lsof and SQLite-close checks that the Linux environment cannot support reliably (as recorded by the independent review). Full suites unset OPENCODE_DB and use a throwaway HOME. Their unchanged scripts run frozen installs; no product manifest/lockfile changed. The ignored pinned host install added 112 packages and blocked two postinstalls.

The first complete suites exposed two inherited source-text tests looking only for literal `await runPipeline(`; the new `guardAwait` syntax made their anchors miss. The source-fence tests now recognize direct or guarded awaits, explicitly require a matching anchor, and preserve the no-eager-drain/after-pipeline claims. This changes their syntax recognition, **not** their behavioral expectations; both fences were separately mutation-proved. An initial unnormalized HOME contained a doubled slash, causing unrelated home-root equality/tilde tests to fail. The HOME was canonicalized for the final rerun; no unrelated test or product code was changed. Initial Pi lint found five unformatted files from the interrupted findings 1–4. Only those files were formatted; this accounts for the formatting-only follow-up diff.

The remaining follow-up commit formats those inherited files, adapts the two source anchors without weakening their expectations, moves the new V2 error class below the imports, and adds the conservative conflicting-served-row refusal. It does not change any review expectation.

Evidence is retained outside regenerable build directories, in `.cache/issue-640-final/evidence/`: `pi-suite.log`, `plugin-suite.log` (initial failures), `pi-suite-final.log`, `plugin-suite-final.log` (normalized-HOME run), `pi-suite-delivery.log`, `plugin-suite-delivery.log` (final code), `review-final.log`, `review-delivery.log`, earlier package type/lint logs, `plugin-build-final.log`, `linux-delivery-gates.txt` (captured final Linux gate summary), `guard-isolated-rerun.log`, three OMP run logs, and `reproduction-summary.json`. The reproduction driver is `.cache/issue-640-final/recreate.ts`; the pinned installation is `.cache/issue-640-final/host/`.

## Mutation controls (all restored before live checks/commits)

Each control staged its live files first, confirmed an empty working diff, introduced the deliberate invariant-breaking change listed below (marked `NON-VACUITY BREAK`), recorded a nonempty diff, ran the named test, restored from the staged index and touched the path, then confirmed an empty working diff again. No mutant is committed.

| Control | Exact test that alone went red | Other tests / applied evidence |
| --- | --- | --- |
| Discard served-number evidence | `review: a racing real-id row must not renumber the already-served fallback message` | `served-array-ledger.ts`: 1 file, 1 insertion / 1 deletion during mutation; empty after restore. Targeted run: 0 pass, 11 filtered, 1 fail; received `§9§`, expected `§1§`. |
| Suppress validated replay | `review: OpenCode tries a valid saved request before backed-off writer retry` | `messages-transform.ts`: 1 file, 1 insertion during mutation; empty after restore. Targeted run: 0 pass, 3 filtered, 1 fail; 4 acquisitions / 1 callback instead of 1 / 0. |
| Same replay suppression, V2 outer hook | `v2 outer admission serves validated LKG before writer backoff` | Same applied/restore diff pair. Separate run: only this test fails; 6 acquisitions instead of 1. |
| Drain history signal before pipeline | `source contract: peek-then-drain in runPipeline (history) > runPipeline does NOT eager-delete historyRefreshSessions before work` | `context-handler.ts`: 1 file, 1 insertion during mutation; empty after restore. 24 other source/signal tests pass, including note ordering. |
| Run note nudges before pipeline | `source contract: peek-then-drain in runPipeline (history) > note nudges are wired after runPipeline` | Same path/diff pair. 24 other source/signal tests pass, including no eager drain. |
