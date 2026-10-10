# Pi/OMP emergency pressure and checkout refusal regressions

## Scope and isolation

Both regressions reproduce across merge `735bb3bcffa17a296001cbddf5705e89090fd754` (issue 640 and issue 641). The comparison used its first parent, `e5b5bc670c679fad3a6b92a81295dac29719408a`, with the same E2E tests and freshly built plugin distributions. No external CI checkout was needed.

All host processes used throwaway HOME, XDG data/config/state/runtime roots, OPENCODE_DB and MAGIC_CONTEXT_STORAGE_DIR below a dedicated `TMPDIR/magic-context/` root. A process-tree observer captured `lsof -p <pid>` database descriptors during host execution and rejected paths outside that root. The checkout scenario and pinned OMP probes also perform their own PID/inode containment assertions. No live store was opened. Raw logs, JSONL descriptor captures, and comparison receipts are retained outside build directories in the isolated run's `evidence/` directory.

The workspace E2E runner resolved Pi 0.87.1 and OMP 18.2.6. The deadline probes used a separate, ignored installation of OMP 18.8.6, matching the issue 641 probes. Bun was 1.4.2; TypeScript was 5.9.3; Biome was 2.5.1.

## Bisect

| Revision | Pi overflow peak / dropped tags | OMP overflow peak / dropped tags | Checkout claim Pi / OMP |
| --- | --- | --- | --- |
| First parent `e5b5bc670c` | 88.6% / 19, pass | 92.8% / 25, pass | pass / pass |
| Merge `735bb3bcff` | 124.5% / 0, fail | 100.8% / 0, fail | `answered`, fail / `answered`, fail |
| Fixed emergency path | 88.6% / 23, pass | 92.8% / 23, pass | See checkout verification below |

The original checkout manifest declared only OpenCode and Pi. For the OMP bisect, only the scenario's host registration was temporarily expanded; the test body and plugin code remained at each historical revision. OMP is now permanently registered for this scenario, with its validator count updated from 21 to 22 files.

## Emergency mechanism and correction

The force-band bypass itself was intact: emergency cleanup ran at 86%, 90%, 94%, and 98% while the historian was running. The failing trace reported `activeTools=0`, `visibleCompleteTools=0`, and `emergency tiered drop skipped: no-candidates`.

This E2E contains large assistant prose, not tool results. `heuristic-cleanup-pi.ts:391-395` restricts emergency candidates to droppable tool tags; the shared planner in `packages/plugin/src/hooks/magic-context/emergency-drop.ts:277` also selects tools only. Prose drops become available when the historian publishes its summary. The first parent waited at the emergency band for that publication; the merge removed the join in `context-handler.ts` entirely. All 30 fast turns could then finish before the 3-second historian published. Neither the stale-pass guard nor the late-write fence discarded an emergency drop batch: no batch existed yet.

The corrected handler at `packages/pi-plugin/src/context-handler.ts:3515-3566` conditionally joins an already-running historian at the 95% emergency band when no visible active/new complete tool pair or pending/published-history work is available. It uses `budget.wait(historian)`, sharing the existing 21-second optional-work clock, including preparation and writer-admission time already spent. There is no fresh timeout and no 30-second join. On publication it refreshes session metadata and the history snapshot before applying queued drops on the same pass. A join timeout enters the existing provider-measured LKG replay-or-refusal path, leaving the 25-second outcome reserve intact. Ordinary emergency tool/pending-drop work still bypasses the join.

No new unsummarized prose-dropping policy was introduced. The former universal no-join unit fixture is now explicitly a tool-reclaim fixture. The opt-in native writer-plus-historian fixture now requires visible refusal when a 15.5-second writer wait plus the remaining historian work cannot fit the 21-second optional clock; its no-writer case still requires a transformed result. This preserves the deadline guarantee rather than requiring a late successful result.

### Accepted usage versus provider-proven overflow

The mock accepts requests even beyond the configured window. `outgoingContextRefusal` in `packages/plugin/src/hooks/magic-context/emergency-fail-closed.ts:46-68` deliberately does not refuse accepted pressure alone: protected tools must themselves exceed the limit. Catalog-derived geometry can also widen after accepted provider usage. This is a pre-existing contract, not introduced by the emergency fix, and was not changed here. Actual provider-overflow recovery remains fail closed. `assertPiRawFallbackFits` in `pi-raw-fallback.ts:323-433` still prefers correlated provider input plus the appended tail and rejects an over-limit replay; focused measured-basis tests cover that distinction.

## Checkout mechanism and correction

The exact failed assertion is `packages/e2e-tests/tests/checkout-claim.test.ts:141`, not part of the overflow scenario.

The definite held-elsewhere check still threw before the pipeline. The regression was a later write: `pi-context-refusal.ts` called `options.onRefusal` after aborting; the callback installed by `context-handler.ts:4628-4650` scheduled diagnostic persistence with `setImmediate`. `persistLastTransformErrorIfChanged` (`context-handler.ts:1116-1129`) calls `getOrCreateSessionMeta`, creating the refused session's metadata row. That violated the no-write checkout guarantee. `PiTestHarness.sendPrompt` (`pi-harness.ts:454-466,516-523`) treats that row as evidence of processing, so the test reported `answered` even though the context hook had refused. That string alone is not proof of provider dispatch.

The guard now excludes only typed `CheckoutClaimRefusalError` from diagnostic persistence, both for real host contexts and abort-less unit fixtures. It retains the user notice, display-only refusal entry, abort, and OMP receipt fence. The core claim checker is unchanged: unreachable, timed-out, malformed, and incomplete checks still admit unchecked. New unit tests drain the next event-loop tick before checking that session metadata and tags remain absent, on both Pi and OMP.

## Verification receipts

- Unchanged 30-turn overflow E2E: Pi peak 88.6%, OMP peak 92.8%, 23 dropped tags each, all turns successful.
- Native writer-plus-historian deadline control: no writer returned a transformed result in 17.045 seconds; 15.5-second writer wait refused in 21.003 seconds. Both remained below 30 seconds.
- Long-historian real OMP control: 35-second mock historian; emergency turn refused in 21.023 seconds with zero main-provider requests for that turn.
- Original issue 641 OMP 18.8.6 probes: fast sent one managed request; slow and outcome sent none; side/main requests overlapped without unsafe abort. Outcome fallback took 6 ms, handler 25.254 seconds. Total RPC prompt time was 30.621 seconds, distinct from the context callback's deadline.
- Linux package build and Pi typecheck passed. Full Linux package suites retained exactly the master failure-name sets: plugin 7,451 pass / 33 fail / 9 skip; Pi 1,620 pass / 144 fail / 9 skip (master Pi: 1,616 pass). There were no new failure names. These are not clean-suite claims.
- Core checkout policy, delayed-write regressions, and manifest validator: 37 tests passed before mutation; admitted and unchecked controls remained green.
- Emergency join mutation: bypassing the historian join failed `emergency prose pass applies historian drops published inside the shared budget` (publication remained false).
- Optional-clock mutation: substituting `waitMandatory` failed only `emergency historian exceeding remaining optional budget refuses before provider dispatch`; the successful-publication control stayed green.
- Checkout mutation: allowing the deferred diagnostic failed `held-elsewhere refusal never schedules diagnostic storage writes [pi]`, with session_meta 1 instead of 0. The mutant was restored before subsequent gates.

Full CI manifest lanes with both fixes: Pi 51 pass / 253 skip / 1 pre-existing failure across 29 files; OMP 42 pass / 229 skip / 0 fail across 22 files. Both checkout scenarios now verify refusal, no provider turn, zero session metadata, and admission after the claim moves back. The only remaining Pi failure is `long-running OpenCode Magic Context session [pi] > exercises execute, notes, reduce, historian, todo synthesis, and auto-search over one realistic session`, also present on master. There are no new host-lane failure names.

The final focused run enabled combined timing, synchronous-stall and differential controls: 133 pass / 1 Darwin-only skip / 3 baseline failures across 23 files. A separate master-handler comparison reproduced the exact same three failures: `independent OpenCode1 defer bytes and per-pass cost` (synthetic-head expectation), `independent OpenCode2 defer bytes and per-pass cost` (missing REVIEW_CWD), and `combined review timing: synchronous branch projection stays below OMP's deadline` (its synchronous 31-second stall cannot complete within 30 seconds). The Pi differential control passed on both versions with identical 129,157-byte wire SHA-256 `04ea978c77f9f929db807d4111e1f49655f78db70f78174b62899899dc560d85`. All ordinary issue 640/641 safety cases passed. The Darwin-only writer/historian control was run separately and passed as described above.
