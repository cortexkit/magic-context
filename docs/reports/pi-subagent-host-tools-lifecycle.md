# Pi subagent host-tool registry lifecycle

## Mechanism

The regression is the eager **registry supplier evaluation**, not Pi replacing an
extension's API object after loading. At the 0.45.0 baseline:

- `packages/pi-plugin/src/index.ts:1178-1184` publishes a process-local supplier
  capturing the factory's `pi`, for **both** Pi and OMP.
- `packages/pi-plugin/src/subagent-runner.ts:1340` invokes that supplier before
  spawning every child, including the zero-tool historian and recomp.
- `packages/pi-plugin/src/subagent-runner.ts:2546-2549` actually uses the snapshot
  only for OMP. Plain Pi never needed the action call in the first place.

In the npm **Pi 1.0.4** package (paths relative to the package root):

- `dist/core/extensions/loader.js:106-125` creates the shared runtime with the
  throwing `getAllTools` stub (`notInitialized` is at line 108).
- `loader.js:189,211,334-336` creates the API object whose `getAllTools` method
  delegates to that particular runtime. `initializeExtension` passes the same
  API to the factory at `loader.js:510-515`; `commit` changes registration state
  at `loader.js:433-444`, **not** the action implementations.
- `dist/core/extensions/runner.js:208-217` binds real actions onto that same
  runtime. `dist/core/agent-session.js:2911-2922` uses the resource loader's
  extensions/runtime to create its runner and bind core actions.
- A separate `loadExtensionsCached` call without a supplied runtime allocates
  another runtime (`loader.js:550-557`). Its cached factory can execute again
  without ever having a serving runner. Publishing a singleton supplier there
  overwrites the serving session's supplier with this permanently unbound API.

Thus the stack does **not** establish that the historian ran during extension
loading. It establishes that the callback reached a runtime which had not been
bound. Pi does not hand a new API to a serving extension or copy actions onto a
replacement API. A second loader-only evaluation is a reproducible way to get
exactly this persistent failure; the issue's logs alone cannot establish which
extra initialization path in `pi-web` left its runtime unbound.

Pi **0.83.0**, the pi-plugin's dev/test dependency, has the same mechanism:
`loader.js:131-150,186,271-273` and `runner.js:158-167`. This is not a new Pi 1.0
throwing-stub contract. A normal Pi 1.0.4 RPC historian run passed even on the
baseline; the separate-loader reproduction failed on **both** host versions.

## Fix

- `index.ts:1178` registers the lifecycle wiring rather than publishing a
  factory-phase supplier.
- `subagent-host-tools.ts:10-25` does nothing on plain Pi. On OMP it publishes
  only at `session_start`, using the API whose runtime the host initialized.
  Loader-only evaluations cannot replace it. Shutdown invalidates only that
  supplier (`:26-29`), not an independent newer session's supplier.
- `subagent-runner.ts:1139-1151,1353` bypasses **all** registry suppliers on plain
  Pi and catches unavailable/throwing OMP suppliers. Missing metadata means the
  normal tool list, not an empty list. The OMP alias and disabled-built-in
  intersection itself is unchanged, including fallback child invocations.

## Other captured action calls audited

No other production action call executes at factory/module load. Registration
methods (`on`, `registerTool`, `registerCommand`, `registerFlag`, renderer and
bus registration) are valid during loading. The following captured actions were
inspected; no unrelated behavior was changed:

| Call site | Timing / disposition |
| --- | --- |
| `tools/index.ts:45,49` — `getActiveTools`, `setActiveTools` | Called by the serving `session_start` handler at `index.ts:1886`; keeps memory policy in sync. Retained. |
| `pi-lkg-fit-envelope.ts:26,105` — `getAllTools`, `getActiveTools` | Context-time LKG fit/admission metadata. Both throwing APIs already have safe incomplete-metadata fallbacks (`:115-118,146-149`). Retained. |
| `dropped-input-guard-pi.ts:45` — `getAllTools` | Schema lookup only from the `tool_call` guard, not when registering it. Shared guard catches schema lookup exceptions at `packages/plugin/src/hooks/magic-context/dropped-input-guard.ts:227-232`. Retained. |
| `dialogs/status-dialog.ts:798` — `getAllTools` | Command/dialog-time estimate with best-effort catch (`:804-806`). Retained. |
| `pi-context-refusal.ts:57` — `appendEntry` | Context error/refusal callback. Display failure is caught; `ctx.abort()` still runs (`:58-64`). Retained. |
| `commands/pi-command-utils.ts:243` — `appendEntry` | Runtime command progress/status delivery, never factory registration. Retained. |
| `ctx-reduce-nudge-pi.ts:305` — `sendMessage` | Runtime nudge delivery after a claim; catches send errors and restores the pending claim (`:309-322`). Retained. |
| `subagent-entry.ts:118` — `getFlag` | Serving child `session_start`; flag lookup is registration-safe even before bind in Pi's loader (`loader.js:294-299`). Retained. |

The checkout-claim API proxy also retains the original target, binding methods to
it (`checkout-claim-pi.ts:68-73`); it does not substitute a loading-phase API.
There are no production calls to the other Pi action methods (`getCommands`,
`setModel`, thinking-level actions, session-name/label actions, `sendUserMessage`)
in pi-plugin source.

## Reproduction and verification

`packages/e2e-tests/tests/pi-historian-runtime.test.ts` uses real installed hosts
and the local mock Anthropic provider. Its Pi fixture calls the real cached
loader a second time, verifies that the resulting runtime still throws while
the serving API sees `ctx_reduce`, then triggers the production historian.
On the original bundle this issued no successful historian request and logged:

```
historian failure: subagent run failed (model_failed): Error message="Extension runtime not initialized. Action methods cannot be called during extension loading."
```

Both Pi 1.0.4 and 0.83.0 failed this reproduction before the fix. Afterwards,
each published one compartment from one real historian request with no tool
definitions. OMP 18.2.6 also published one compartment and ran a real mapper
child with `grep.enabled=false` and `glob.enabled=false`: its captured provider
tool list was exactly `['_read']`. The mapper test feeds a registry snapshot
obtained from a real initialized OMP API into the production runner; the unit
lifecycle tests independently cover the main entry's supplier publication.
The existing Docker OMP lane tests subagent argv, not historian publication;
the deeper OMP acceptance here ran directly against the real npm OMP host.

Host roots and agent directories were under
`$TMPDIR/magic-context/issue-633/runs/`; the final Pi 1.0.4 control with no TMPDIR
override self-created `/private/tmp/magic-context/pi-historian-runtime/`.
The test creates this isolated task root automatically in the normal CI lane.
Tests verify every host HOME/XDG/storage
and Pi-agent override, and `lsof -Fn -p <pid>` checks the primary hosts and their
historian/mapper children at the mock-provider boundary. Final primary/child
PIDs were Pi 1.0.4 **48539/48875**, Pi 0.83.0 **49209/49555**, and OMP
**49651/49980/51363**. No live store was opened, read, written, or migrated.
Package suites ran with `OPENCODE_DB` unset. Only throwaway databases were
created using the normal test harness.

The manifest registers the new test for Pi and OMP. Validator counts are **177**
files, **63** TS entries, **58** Rust entries, **29** Pi and **21** OMP TS entries.

Gates used Bun 1.4.2, TypeScript 5.9.3 and Biome 2.5.1:

- Pi package test suite: **1625 passed, 3 skipped, 0 failed** (155 files).
- Shared plugin test suite: **7303 passed, 6 skipped, 1 failed** (709 files).
  The unrelated pre-existing `source tests allocate temporary directories only
  through the registered helper` failure names the unchanged
  `e2e-tests/src/rust-runner/hermetic-subc.test.ts`. It was not edited.
- Both package typecheck scripts passed; both lint scripts passed (existing
  warnings only). Manifest validator/prerequisite tests: **7 passed**.
- The optional full E2E TypeScript project has 21 pre-existing diagnostics in
  unrelated fixtures/transitive shared code; none names the changed files.
  Scoped inspection remained partial (Biome unavailable and the E2E server
  did not finish publishing diagnostics within its budget). The successful
  package typechecks are authoritative for the production fix; the full E2E
  compiler run emitted no diagnostic for the changed test or harness.
