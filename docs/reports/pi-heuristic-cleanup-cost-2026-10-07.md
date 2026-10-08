# Pi heuristic cleanup: repeated native replay envelope writes

## Read-only evidence and reproduction

The requested log exists at `$(getconf DARWIN_USER_TEMP_DIR)pi/magic-context/magic-context.log`.
For session `019de471-4fdc-762d-9286-624dfad0b5fe`, the 15:07:41–49Z pass reported:

- 50,752 session tags, 2,391 active tags, 965 wire targets.
- Three `tool arc removal persistence failed; retaining pair` writer-acquisition failures during cleanup, **before** the emergency-candidate log at 15:07:49.049Z.
- Emergency planning/application completed by 15:07:49.072Z; injection cleanup completed by 15:07:49.079Z.
- Cleanup took 7,289.6 ms; the pipeline took 8,931.4 ms. The preceding full tag snapshot took 155.5 ms, outside the cleanup timer.

No live database, session directory, or configuration was opened. The log does not expose the native replay envelope's size, so the reproduction uses synthetic data rather than claiming to copy that envelope.

Run from `packages/pi-plugin`:

```sh
mkdir -p "$TMPDIR/magic-context/heuristic-cost/home"
env -u OPENCODE_DB HOME="$(realpath "$TMPDIR/magic-context/heuristic-cost/home")" \
  bun scripts/benchmark-heuristic-cleanup.ts
```

The runner creates its database and output files under `$TMPDIR/magic-context/heuristic-cost/fixture-*`. The fixture has 1,000 input wire messages, 50,870 persisted tags (2,370 active), 130 visible tool arcs, 10 injection-only messages, and 10,000 synthetic historical native tool inputs. One emergency execute pass drops exactly 48 tools and 10 injections, with no deduplication or caveman compression. Newer tool tags are explicitly protected to make the 48-drop selection deterministic.

## Dominant cost

The shared aggregate target's `measureReclaim()` calls each invocation's `canRemove()`. Pi's implementation invokes `authorizePiToolRemoval()`, which freezes the removal marker via `saveNativeToolInputs()`. That function validates, parses, merges, serializes and CAS-updates the **whole replay envelope**, not one tool row. Thus measuring 130 live arcs did 130 envelope writes, before selecting the 48 drops. This is also where the live log's writer-acquisition failures occurred.

The fix prepares precisely the active wire-tool IDs that measurement will visit, in tag order. The Pi transcript walks its working messages once and applies the existing native-envelope removability predicate. Eligible, not-yet-frozen markers are merged in one immediate transaction. In-memory authorization is published only after commit. Subsequent measurement and drop calls retain their existing authorization checks but find the same durable markers already recorded. Failed preparation leaves the original per-call fail-closed/retry path intact.

Selection, protected windows/tools, skeleton decisions, injection decisions, and scheduler mutation gates are unchanged. In particular, measurement previously froze eligible calls even when the planner did not select them; preparation intentionally preserves those decisions, rather than freezing only the 48 selected calls.

## Before/after measurements

Bun 1.4.2, file-backed synthetic databases on the same machine. These are single-pass measurements under variable machine load, not a claim to reproduce the live contention schedule. Timers nest; do not add all rows together.

| Step | Before (ms) | After (ms) | Calls before → after |
| --- | ---: | ---: | ---: |
| Shared full tag snapshot | 25.824 | 250.497 | 1 → 1 |
| Tag SQL within that snapshot | 16.479 | 29.018 | 1 → 1; 50,870 rows each |
| Native authorization, inclusive of old envelope merging | 2,134.599 | 0.273 | 226 → 226 |
| Bulk native-marker preparation | — | 122.129 | 0 → 1 |
| Replay-envelope SQL updates (nested in authorization/preparation) | 747.123 | 17.965 | 130 → 1 |
| Tool reclaim measurement (old native writes included) | 2,154.777 | 4.836 | 130 → 130 |
| Structural tool-drop target calls | 0.736 | 0.985 | 48 → 48 |
| Tag status/drop-mode SQL updates | 16.434 | 202.153 | 106 → 106 |
| Complete heuristic cleanup | **2,187.188** | **499.717** | 1 → 1 |
| Transcript commit/finalization | 0.644 | 0.579 | 1 → 1 |

The final after run includes the new runtime stage logging. An earlier after run took 201.156 ms (102.223 ms preparation, 25.801 ms tag writes); unchanged tag work and the shared snapshot varied substantially with machine load. The deterministic improvement is eliminating 129 whole-envelope writes, independent of those scheduling fluctuations.

Before: 130 autocommit envelope writes plus two phase transactions. After: zero autocommit envelope writes and three phase transactions (one envelope merge, one tool-drop batch, one injection batch). Tag writes were already batched by phase; combining those phases would change their existing partial-progress behavior and was unnecessary.

The old measurement time minus native authorization is approximately 20 ms: tokenization/target reads are not the dominant cost. Drop target calls account for less than 1 ms in either fixture. Pi already precomputes its conversation-end guard and records removed occurrences; it does not scan all messages for each drop. The new preparation uses a set of requested IDs and one working-array walk, not one message walk per requested call.

Heuristics reuse the caller's active projection and perform **no additional tag query** in this fixture. The caller's full snapshot remains necessary for Channel-1 baseline/protection accounting; removing historical rows would change that state. The standalone cleanup fallback already uses the partial-index-backed active-only query. Caveman's active population must also remain intact: it defines compression age tiers and frozen rules membership even for absent targets. No full-session load was introduced inside a writer transaction, and no per-drop tag loads were added.

New runtime stage timers separate `tagLoad`, `prepareNativeRemovals`, `measureEmergencyTags`, `planEmergencyDrop`, and `applyEmergencyDrops` so a later live event can distinguish preparation, measurement and mutation costs.

## Byte differential and regression control

The benchmark was run against the unoptimized implementation before production edits, then against the optimized implementation. Binary comparisons of `served.json`, `tags.json` (every tag field), and `replay.json` (the raw persisted replay envelope) were equal. SHA-256 values, also asserted as independent baseline constants by `heuristic-cleanup-cost.test.ts`:

| Output | SHA-256 |
| --- | --- |
| Served wire | `dababe9fb0e5588781555ed7f6728e316572d12fc4edb9867b86fa16adb066b4` |
| Every tag row | `cdbc566f2e0f69db95dfa9b78f45d7b8e49298bb31936497ee27515a3efff284` |
| Frozen replay envelope | `51977c05a45a936d134559ddf733eb3af8c09ee9c9a07e2dafb6e2bdd767b03c` |

For non-vacuity, disabling the bulk preparation made only `merges native removal markers once before measuring 130 visible tool arcs` fail (`Expected: 1; Received: 130`). The byte-differential and fail-closed tests remained green. The mutation was restored before the passing verification run. A second control omitted the preparation callback from the actual Pi context hook: only `wires bulk marker preparation into the Pi context execute pass` failed (one expected preparation call, zero received), while the other three tests passed. This checks the production wiring rather than just the standalone fixture. The failure test also checks that a rejected persistence transaction publishes no in-memory markers and that a non-busting pass cannot prepare new decisions.

## OpenCode applicability

OpenCode's `heuristic-cleanup.ts` already batches tool status/drop-mode writes and injection writes in phase transactions. Its `createToolDropTarget().measureReclaim()` estimates indexed occurrences directly; it does **not** call Pi's native-removal authorization or rewrite the native replay envelope. Composite-key occurrence lookup is already indexed, and finalization filters affected messages then sweeps the message array once. Its conversation-end guard can walk a trailing empty suffix, but this is not the repeated whole-envelope persistence cost demonstrated here. No OpenCode production change is warranted for this cost shape; its complete package tests, typecheck and lint remain verification gates.

## Verification environment

All package suites ran with `OPENCODE_DB` unset and a throwaway `HOME`. The initial noncanonical `/var/...` HOME caused the existing home-directory tests in both packages to disagree with macOS's canonical `/private/var/...` home path. Their targeted reruns passed with `realpath` HOME; the complete suites were rerun in that environment. No test contract was rewritten to accommodate this environment issue. Package lint reports existing warnings outside the edited files.

- Pi `bun run test`: 1,614 passed, 3 skipped, 0 failed (153 files, Bun 1.4.2).
- OpenCode `bun run test`: 7,291 passed, 6 skipped, 0 failed (708 files, Bun 1.4.2).
- Both package `bun run typecheck` commands passed (TypeScript 5.9.3).
- Both package `bun run lint` commands passed (Biome 2.5.1; Pi 244 files, OpenCode 1,265 files).
- Pi `bun run build` passed (22 browser modules and 981 plugin modules bundled).
- Restored cost/differential/failure/context-wiring tests: 4 passed, 0 failed. Their setup timeout is explicitly 30 seconds so the deliberately slow unbatched mutation reaches the named assertion even under load.
- AFT inspection was partial because its Biome/call-graph producers were unavailable; the authoritative TypeScript and package lint gates above passed.
