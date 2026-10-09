# Historian drain gate and deferred-start correctness review

Reviewed revision: `5eb72485826ecc6a724e35dacbf0e97b886fbc89`.
Comparison revision: its immediate parent, `30a84ed473bf21284dc828c825177e1760b681c5`.

## Result

**One introduced defect was reproduced:** a budget-gated low-pressure pass no longer persists the emergency-drain latch's exit. A later rise below the emergency-entry threshold can therefore admit an over-quota historian run that the parent refused.

**One existing contract discrepancy was reproduced on both revisions:** an explicit flush drains pending drops during an active historian, without a fold or force-band crossing. This contradicts the veto described in `ARCHITECTURE.md:68-83`; it is not a regression introduced by this commit.

The pending-run registration prevented duplicate starts in the tested interval. Real-run firing and next-pass served bytes matched the parent in both harnesses. Empty-tail stale-intent timing is intentionally different: the new code holds a pending registration until deferred eligibility finishes, whereas the parent clears the intent synchronously. Startup-error probes did not leave a permanent registration or in-progress flag.

No product code was changed. The new report path is explicitly requested by the review brief; it did not exist at the reviewed revision.

## Method and scope of evidence

All test/build executions below ran through `runon: "linux"`, with this guard and isolation:

```sh
test "$(uname -s)" = Linux || exit 90
unset OPENCODE_DB
export HOME="$(mktemp -d /tmp/historian-review-home.XXXXXX)"
```

The runner used Bun **1.4.2 (744846f84)** on `ck-motor`. Background tasks were joined with `bash_watch`. Parent comparisons temporarily restored only the 14 files changed by the reviewed commit, ran the same probes in the same worktree/build environment, then restored the index's current product files. The final product diff is empty.

Two added test files make the review reproducible:

- `packages/plugin/src/hooks/magic-context/historian-drain-gate-review.test.ts`
- `packages/pi-plugin/src/historian-drain-gate-review.test.ts`

The wire tests execute the real transform/context handler, persisted pending-op application, and prefix materialization. A held historian promise represents an unresolved historian response. The firing probes use the real registration/scheduling code with an injected historian body held at its response await; the OpenCode double honors `onHistorianRunStarted`, which the parent needs to distinguish a real run from a synchronous no-op. Budget probes execute the real trigger followed, only when it fires, by the real atomic drain reservation. They test admission, not successful model-generated publication. This separates quota behavior from producer-model/network availability; it does not claim exhaustive race exploration or a live-model publication proof.

## Findings

### 1. Emergency latch exit is lost when the new admission gate skips the runner

**Severity:** P2 / medium. **Introduced by this commit.** Both harnesses use the affected shared admission helper.

**Input:** A session has eligible history, execute threshold 80%, an already-spent active ten-minute drain window (`protected_tail_drain_tokens = 500000`), and a recently active emergency-drain latch. Usage first falls to **69%**, below the **70% exit threshold**, then rises to **78%**, still below the **85% entry threshold**. No historian failure backoff applies.

**Expected:** The 69% pass ends emergency catch-up. The 78% pass must not bypass the spent quota; only a fresh 85% crossing can rearm it.

**Actual:**

| Revision | 69% pass | Subsequent 78% pass |
|---|---|---|
| Parent | Trigger fires; reservation refuses the spent budget **and clears the persisted latch** | Reservation refuses; no over-quota admission |
| Reviewed | Trigger returns before reservation; the persisted latch remains active | Trigger fires; reservation succeeds with an emergency quota bypass |

**Cause:** `getProtectedTailDrainBudgetSkip` resolves the latch against the current usage but does not persist that resolution (`packages/plugin/src/features/magic-context/storage-meta-persisted.ts:869-885`). The exit write remains exclusively in `reserveProtectedTailDrainTokens` (`:955-970`). The trigger now returns before reaching that reservation (`packages/plugin/src/hooks/magic-context/compartment-trigger.ts:481-490`). Pi also returns early through the same helper (`packages/pi-plugin/src/context-handler.ts:4991-5006`), as do stale-intent phase startup and restart recovery.

The admitted run is not necessarily a no-op: the reproduction has an eligible history window and obtains a positive reservation. Thus suppressing the earlier spent-budget no-op changes future admission semantics, rather than merely removing expensive work. The fix should preserve usage-driven latch lifecycle independently of whether a model run is scheduled; no fix is included in this review.

**Failing regression:**

```text
review regression: a skipped low-pressure pass must end emergency catch-up before pressure rises below force
Expected: false
Received: true
```

This test **passes on the parent** and fails on the reviewed revision at the subsequent reservation's `ok` assertion. The expected result is literal, not calculated from the new gate.

### 2. Explicit flush bypasses the documented historian veto in both harnesses

**Severity:** P2 / medium **relative to the stated contract**. **Pre-existing on the parent; not attributable to deferred startup.** If flush is intended to be another veto exception, that is a contract/documentation decision, not something this review silently assumes.

**Input:** Warm a primary-session prefix at 20% usage, queue a drop for an old unprotected user-message tag, hold a registered historian promise, and request explicit materialization. Keep the model and prefix inputs unchanged: no executed hard fold and no force-band crossing. The scheduler remains defer.

**Expected:** Under `ARCHITECTURE.md:71-77`, flush supplies the bust clause but not the veto exception. The pending drop remains queued while the historian is active, and the previous served bytes remain unchanged.

**Actual on both revisions and both harnesses:** The drop queue goes from one item to zero and served bytes change. The OpenCode historian's active entry and persisted `compartmentInProgress` remain true throughout. In Pi the in-flight promise is installed through the existing test seam, and remains unresolved.

**Cause:** OpenCode derives `compartmentRunning` from the active-run map (`packages/plugin/src/hooks/magic-context/transform-postprocess-phase.ts:1972-1978`), but its actual ride predicate admits `explicitFlush` without consulting that veto (`:2248-2267`); the heuristic gate uses the same ride permission (`:2268-2285`). Pi likewise grants an explicit-flush ride and pending-work permission without an in-flight-historian operand (`packages/pi-plugin/src/context-handler.ts:6033-6053`, `:6070`). Running state is therefore not the mutation veto advertised by the architecture section. These decision sections are unchanged by the reviewed commit.

**Failing regressions:**

```text
review mutation contract: OpenCode flush pass during a registered historian
Expected: 1
Received: 0

review mutation contract: Pi flush pass during a registered historian
Expected: 1
Received: 0
```

Both fail on the parent as well. The tests deliberately retain the brief's veto expectation rather than redefining the contract to match the existing implementation.

## 1. Veto timing and served-byte comparison

The comparison probes use the same raw inputs and queued pending drop on both revisions. They also inspect the actual persisted `cached_m0_model_key`: the fold case must commit the new model key, and the non-fold cases must retain the warmed key. SHA-256 is computed from the actual serialized outgoing message arrays; the old/new hashes below were captured from separate executions, not compared with themselves.

| Probe | Parent and reviewed observation |
|---|---|
| OpenCode real-run firing pass, followed immediately by defer | One active registration; persisted `compartmentInProgress = true` on both passes; one historian body eventually starts; first and second served arrays are identical |
| Pi real-run firing pass, followed immediately by defer | One in-flight run; one historian body eventually starts; first and second served arrays are identical; persisted `compartmentInProgress = false` on both revisions (Pi uses its in-flight map, not that flag, for scheduling) |
| Defer during a registered run | Drop remains pending; served bytes unchanged |
| Model-change hard fold during a registered run | Pending drop drains; served bytes change, as allowed by the fold exception |
| 85% force band during a registered run | Pending drop drains; served bytes change, as allowed by the force exception |
| Explicit flush during a registered run | Pending drop drains and bytes change: finding 2, already present on the parent |

Captured hashes, **equal between parent and reviewed executions**:

| Probe | OpenCode | Pi |
|---|---|---|
| Firing pass | `0f015b1c3e6e417b8b6c0d543118817978acbffbfa85192511d13d2b09149828` | `fd5a5b7ac87d6192909908e7c549864ae1d157a9b024dc29c19deb8a34852358` |
| Defer during run | `f09699e31c5b4e2356a1e556017593ff7cc4f7c147c275d2b05ceb7b5c1f7801` | `ac0a9582ee210c348029e71f3b7cf96310c22d1f7421cd7c4297d266753810eb` |
| Fold during run | `0a62eb068746cd52603bd7012ad83a07005ce2ccd43d286805a9817d676f57a0` | `427f4ba894c9899d83c12f559d8e1d2e819f28071dfe9480069d218a6fb2c805` |
| Force during run | `6c232e06f5552a05c91255bc8b156166f3b0fab6974e3065f6d31a5064ae8eac` | `427f4ba894c9899d83c12f559d8e1d2e819f28071dfe9480069d218a6fb2c805` |
| Flush during run | `0d1bd5adef666302eb2186f0a7c1a7b5a41d9d7e5a1d6c7f8d4356670b57e26a` | `427f4ba894c9899d83c12f559d8e1d2e819f28071dfe9480069d218a6fb2c805` |

Equal Pi fold/force/flush hashes are expected for this fixture: each removes the same old user instruction. They do not assert that the reasons are interchangeable.

**Not exact timing equivalence for no-ops:** The empty-tail stale-intent probe prints `{first:false,next:false,active:false}` on the parent, versus `{first:true,next:true,active:true}` on the reviewed revision before the timer turn. After awaiting deferred cleanup, both have no active entry and a false persisted intent. Ordinary eligibility has moved into the deferred preparation callback (`packages/plugin/src/hooks/magic-context/transform-compartment-phase.ts:369-430`; `compartment-runner.ts:216-225`). A pass can observe scheduled-but-not-yet-eligible work; this is bounded pending state, not a lost start or a permanent veto.

## 2. Budget and reset-boundary probes

With independent sessions containing eligible history, parent and reviewed revisions had the same **positive/negative atomic reservation outcome** for all of these cases:

| State | Admission outcome on both revisions |
|---|---|
| Spent active window, 25% or 78%, no latch | Refused |
| Spent window with five seconds remaining, 78%, no latch | Refused |
| At the exact ten-minute expiry, 78% | Admitted, without emergency bypass |
| Invalid future window start, 78% | Admitted in a fresh window |
| Active emergency latch, 78%, no recent failure | Admitted with bypass |
| 85% or 95%, spent window, no recent failure | Admitted with bypass |
| 85% or 95%, spent window, failure one millisecond ago | Refused on both; this is the existing failure backoff, not a new emergency blockade |
| 95%, backoff exactly sixty seconds old | Admitted with bypass |
| 95%, future failure timestamp | Admitted with bypass |
| 85% or 95%, at drain-window expiry | Admitted without bypass |

The new trigger skips the spent-window cases that the parent started only to refuse during reservation. No new denial of a positive reservation was observed in this table. The important exception to stateless equivalence is **finding 1's two-pass latch transition**: removing a quota-refused runner also removes its latch-exit write, and the next pass has a different admission result.

The explicit wrapup quota bypass was not changed by the diff. It was not independently driven through an external wrapup command in this review; there is no claim that all wrapup interleavings were exercised.

## 3. Deferred-start races and error handling

- **Duplicate local startup:** Two consecutive `startCompartmentAgent` calls before the timer turn retained the same native active-run object and eventually executed exactly one historian body. The OpenCode firing/next-pass probe likewise retained the same object. Pi firing plus immediate next pass invoked its historian body once. This checks the registration interval, not merely a counter on a replaced scheduling function.
- **Lost startup:** The ordinary positive-eligibility probes reached the injected historian body after the timer turn. The empty-tail stale-intent probe reached cleanup instead of a body, intentionally, and both registry and persisted intent cleared after its promise settled. Observing an entry before eligibility is checked does not imply that a model invocation is guaranteed.
- **Deferred boundary exception:** OpenCode's preparation callback throws before the historian body. The body is never called, the active entry disappears, `compartmentInProgress` becomes false, and the `compartment_state_lease` row is removed. Cleanup is handled by `compartment-runner.ts:229-251`.
- **Pi startup exception:** The injected `runPiHistorian` throws. Awaiting the tracked promise settles successfully through the catch/finalizer; a later context pass starts another run, and the persisted in-progress flag is false after each failure. The catch/finalizer is `context-handler.ts:4711-4735`. The same two-attempt error probe also passes on the parent.

These probes cover thrown preparation/runner errors with an available database. They do not promise successful intent cleanup after the database itself becomes unavailable; OpenCode's intent write is expressly best-effort. No duplicate, lost positive-eligibility startup, or permanent in-progress flag was reproduced in the tested cases.

## 4. Rechecking the five claimed OpenCode environment failures

The exact two files were run on both revisions, **after `bun run build` on Linux on each revision**, with separate throwaway HOME directories and no `OPENCODE_DB`:

```sh
bun run --cwd packages/plugin test -- \
  src/features/magic-context/memory/transformers-node-wasm.test.ts \
  src/hooks/magic-context/auto-search-bundle-review.test.ts
```

Both revisions: **5 pass, 2 skip, 5 fail; 12 tests; 34 assertions; exit 1.** The same five names and failure sites were observed:

| Test | Parent | Reviewed |
|---|---|---|
| `Node WASM Transformers fixture > builds with real fs and persists a model for offline reuse` | Cannot resolve `onnxruntime-web/webgpu` from the temporary `transformers-node-wasm.js`; expected verification exit 0, actual 1 | Same |
| `review bundle: packed opencode worker under bun loads, restarts, reads only and shuts down` | Tar extraction expected 0, actual 2, `auto-search-bundle-review.test.ts:135` | Same |
| `review bundle: packed opencode2 worker under node loads, restarts, reads only and shuts down` | Same tar failure | Same |
| `review bundle: packed pi worker under node loads, restarts, reads only and shuts down` | Same tar failure | Same |
| `review bundle: packed omp worker under node loads, restarts, reads only and shuts down` | Same tar failure | Same |

**Conclusion:** All five are baseline/environment failures in this environment, not introduced by the reviewed commit. The tar assertion does not report the subprocess's stderr, so this review establishes baseline parity, not a more specific root cause for tar's exit 2.

Before generating Linux dist artifacts, I also ran the explicitly requested **`bun run test`** on both revisions. The root script stopped at OpenCode:

| Revision | OpenCode result reached by root script |
|---|---|
| Reviewed | 7404 pass, 9 skip, 42 fail; 7455 tests / 731 files; 217984 assertions |
| Parent | 7400 pass, 9 skip, 42 fail; 7451 tests / 731 files; 217924 assertions |

An exact comparison of the 42 failing test-name sets found **no current-only or parent-only failure**. That run also had absent-dist worker failures, sidebar/status failures, and four existing producer-fixture failures. Building first reduced the requested two-file reproduction to precisely the five reported failures above. Because the root script chains packages with `&&`, these root runs did **not** reach the Pi, CLI, or retina suites. They are not a green full-workspace claim.

## Verification record

- Bun 1.4.2; TypeScript 5.9.3; Biome 2.5.1.
- `bun run build` — passed on both source revisions; root builds OpenCode (including v2), Pi, and CLI, and checks nine compiled TUI files. Linux build artifacts were generated on Linux, not assumed from the prepared macOS build.
- `bun run test` — executed on Linux on both revisions; baseline results and early root-chain exit are recorded above.
- The two-file environment reproduction — identical five failures on both revisions after building.
- `bun run --cwd packages/plugin typecheck` — passed (three TypeScript project invocations).
- `bun run --cwd packages/pi-plugin typecheck` — passed (two TypeScript project invocations).
- `bun run --cwd packages/plugin lint` — passed; 1307 files checked; ten existing warnings and six informational diagnostics.
- `bun run --cwd packages/pi-plugin lint` — passed; 257 files checked; ten existing warnings.
- `bun run --cwd packages/plugin test -- src/hooks/magic-context/historian-drain-gate-review.test.ts` — **9 pass, 2 intentional contract failures**, 11 tests. Failures are exactly findings 1 and 2; positive startup, reset, emergency admission, defer, fold, and force controls pass.
- Parent OpenCode comparison, using `--test-name-pattern 'review comparison:|review mutation contract:|review regression:'` — **9 pass, 1 fail, 1 filtered out**. Only the pre-existing flush contract fails; the new deferred-preparation callback test is excluded because that API did not exist on the parent.
- `bun run --cwd packages/pi-plugin test -- src/historian-drain-gate-review.test.ts` — **5 pass, 1 intentional contract failure**, six tests, on both revisions. Only the pre-existing flush contract fails.
- Final matrix-only reruns with the persisted model-key assertions (`--test-name-pattern 'review mutation contract:'`) — **3 pass, 1 expected flush-contract failure** per harness; four tests per harness, on both revisions. Package-local Biome checks of each added test file pass after formatting.
- AFT inspection was partial: its checkout call graph was unavailable and it did not find package Biome, despite the installed package-local Biome commands passing. No clean diagnostics claim is based on that partial result.
- Frozen-lockfile installs performed by the package test scripts reported no dependency changes. No manifests or lockfiles changed.

The retained failing tests are review artifacts, not a product repair. Applying this review commit will deliberately keep these contract claims red until the latch lifecycle is repaired and the flush/veto contract is resolved.

## Emergency-latch repair verification

The admission check now persists the usage-resolved emergency-drain latch before returning, including when a spent quota prevents historian startup. It only writes a changed latch, using the previously observed latch value as a compare-and-set guard; it does not reserve tokens or reset the drain window. The shared helper covers OpenCode and Pi, including their persisted-startup-intent and restart-recovery gates. The runner retains the final atomic reservation.

The admission test in `packages/plugin/src/features/magic-context/protected-tail-drain-budget.test.ts` originally asserted that *all* metadata remained unchanged. That assertion is intentionally narrowed to allow only the latch transition, while preserving the token, window, and other metadata invariants. Its table also covers low-pressure exits at expired and future-dated windows. A Pi context-handler regression complements the original OpenCode regression: 69% must end catch-up without starting a historian, and the subsequent 78% reservation must be refused.

Only the two explicit-flush veto tests are skipped, with their existing expectations preserved, pending maintainer Ufuk's decision on whether flush is another historian-veto exception. No flush behavior was changed.

Repair gates ran on Linux with the `uname` guard, `OPENCODE_DB` unset, and a separate throwaway `HOME`. Versions: Bun 1.4.2, TypeScript 5.9.3, Biome 2.5.1. Frozen-lockfile test installs reported no changes.

- Root `bun run build` passed before the test runs; nine compiled TUI files were unchanged.
- OpenCode and Pi package typechecks passed (three and two TypeScript project invocations respectively).
- OpenCode lint passed: 1307 files, ten existing warnings, six informational diagnostics. Pi lint passed: 257 files, ten existing warnings.
- The OpenCode review plus bounded-auto-search run passed 18 tests, skipped only the flush test, and failed none (19 tests in two files, including the eight bounded-auto-search controls). The final budget-unit plus OpenCode review run passed 19 tests, skipped only the flush test, and failed none (20 tests in two files). The Pi review run passed six tests, skipped only the flush test, and failed none (seven tests).
- Neutralizing only the admission check's persisted exits made exactly the latch regression fail in each review file: OpenCode nine pass / one skip / one fail; Pi five pass / one skip / one fail. Emergency entry, reset/backoff, deferred-start, served-byte, and startup-error controls remained green. The mutation was restored before final verification.

Both complete package suites were also compared against `30a84ed473bf21284dc828c825177e1760b681c5`, temporarily restoring the 14 source/test files changed by gate commit `5eb72485826ecc6a724e35dacbf0e97b886fbc89` and omitting the subsequently added review files, then restoring the fixed index state. Each revision was built before testing:

| Package | Parent baseline | Repaired revision |
|---|---|---|
| OpenCode | 7405 pass, 9 skip, 37 fail; 7451 tests | 7419 pass, 10 skip, 37 fail; 7466 tests |
| Pi | 1531 pass, 3 skip, 144 fail; 1678 tests | 1538 pass, 4 skip, 144 fail; 1686 tests |

The final failure-name sets match exactly within each package: no current-only or parent-only failures. These are not green full-suite claims. The earlier review's 42 OpenCode failures were captured **before** generating Linux distribution artifacts; this build-first comparison reproduced 37, not 42. All five of the separately reported WASM/packed-worker failures remain in that baseline set. Pi's full suite was not reached by the earlier review's root test command; the repair comparison therefore establishes its own 144-failure baseline.

One intervening full OpenCode run also failed `slow embedding aborts at the deadline, freezes skip bytes, and cannot land late`. That unchanged timing test passed in the focused eight-test file run and in the final full-package recheck; the final comparison above uses the latter. A reporting attempt had to be repeated because remote jobs do not retain `/tmp` logs across invocations; the retained evidence copies are outside regenerable build directories. AFT inspection remained partial (unavailable checkout call graph/Biome and no timely TypeScript diagnostic snapshot), so the package typechecks and lint are the authoritative checks.
