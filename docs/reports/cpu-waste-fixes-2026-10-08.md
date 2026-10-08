# CPU-waste fixes — C1, C2, C5 (2026-10-08)

Source: C1/C2/C5 of `docs/reports/cpu-waste-audit-2026-10-08.md`, read from
`refs/alfonso/accepted/bg_c0bde8c926e47717` (the audit is absent at this task's
base, `45d2d84fb6b9d727ec1825162ac241c2a07bd9ca`). No audit file was fabricated.

Live-store rule, verbatim: never open, read, write or migrate the live stores (`~/.local/share/opencode/*.db`, `~/.local/share/cortexkit/magic-context/{context,store}.db`, `~/.config/opencode/*`, `~/.config/cortexkit/*`).

All package suites used a throwaway `HOME`, with inherited `OPENCODE_DB` unset.
Neither live stores nor user configuration were inspected. No tests, assertion
checks, pack-graph checks, or host-isolation guards were removed.

## C2: cap Pi's file-isolated workers

`test` now uses `--parallel=4`, like the OpenCode plugin. `test:serial` explicitly
uses `--parallel=1` and the same Bun-version guard. Both retain
`BUN_JSC_useOMGJIT=0` and `--timeout 30000`. The existing CI assertion override
(`--parallel=1 --timeout=60000`) still wins over the script defaults.

One before and one after timing run on the same Mac, Bun **1.4.2 (744846f84)**:
`time bun run test` in `packages/pi-plugin`, no pipes. Bash `time` measures the
script and its children, including the nested frozen install.

| Run | Workers reported | Wall seconds | User CPU seconds | System CPU seconds | Total CPU seconds | Suite result |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Before | 18 | 53.126 | 95.343 | 29.357 | 124.700 | 1,624 pass / 3 skip / 1 fail |
| After | 4 | 99.338 | 93.577 | 24.255 | 117.832 | 1,625 pass / 3 skip / 0 fail |

Both ran **1,628 tests / 155 files / 84,540 assertions**. Requested worker
concurrency fell 78%; measured aggregate CPU fell **6.868 s (5.5%)**, while wall
time increased **46.212 s (87%)**. This is not a statistical performance claim
or a prediction of CI billing on a saturated, changing shared host.

The before run's failure was `Pi dreamer wiring > does not register the filesystem
root or home for dreaming` (expected zero registrations, got one). Its throwaway
HOME contained literal `../..`; `resolve(projectDir)` and `homedir()` therefore
did not compare equal. The after run used an absolute normalized throwaway HOME
and passed that test. No product or test change was made to conceal the failure;
the timing pair has this setup difference and must not be described as two green
baseline/optimized runs. No second uncapped full suite was launched.

## C1: coverage inventory before → after

`check-plugin` now names plugin, CLI and retina-local-fs explicitly rather than
calling root fan-out scripts; `check-pi-plugin` exclusively owns Pi. Typecheck,
lint and build are likewise package-scoped, keeping the CLI build and retina's
checks/declaration emission. Root scripts remain useful local aggregate gates.
All CI job IDs, display names, dependencies, triggers and non-unit gates remain.
`gh api repos/cortexkit/magic-context/branches/master/protection` returned **404,
"Branch not protected"**; no job was renamed or removed anyway.

Every affected full-suite/flag combination is listed below. `A=1` means
`MAGIC_CONTEXT_DEBUG_ASSERTIONS=1`; otherwise the flag is unset. Plugin/Pi lanes
also set `BUN_JSC_useOMGJIT=0` through their package scripts. Counts are invocations
per successful CI event, not per-file worker processes.

| Suite | Before: job, flags, count | After: job, flags, count |
| --- | --- | --- |
| Plugin normal | check-plugin; parallel=4, timeout=30000; 1 | same; 1 |
| Plugin assertions | check-plugin; A=1, parallel=4, timeout=30000; 1 | same; 1 |
| Pi normal | check-plugin + check-pi-plugin; uncapped parallel, timeout=30000; 2 | check-pi-plugin; parallel=4, timeout=30000; 1 |
| Pi assertions (root fan-out) | check-plugin; A=1, uncapped parallel, timeout=30000; 1 | removed duplicate; covered by next row |
| Pi assertions (dedicated) | check-pi-plugin; A=1, parallel=1, timeout=60000; 1 | same; 1 |
| CLI normal | check-plugin; CLI's regular + four spawn-isolated groups, Bun default timeout; 1 | same; 1 |
| CLI assertions | check-plugin; A=1, same CLI groups/default timeout; 1 | same; 1 |
| retina-local-fs normal | check-plugin; Bun defaults; 1 | same; 1 |
| retina-local-fs assertions | check-plugin; A=1, timeout=60000; 1 | same; 1 |
| v2 server unit/import smoke | every plugin build: `bun test src/v2/server.test.ts` (Bun defaults), plus both plugin suite lanes | no hidden build invocation; all four tests remain in both plugin suite lanes |

The old root debug command appended `--timeout=60000` only to the final retina
command, not to preceding packages. The explicit replacement preserves those
effective timeout combinations rather than silently relaxing plugin/CLI budgets.
Pi changes from four full suites to **one normal + one assertion suite**; plugin,
CLI and retina retain one of each.

All other CI suite/flag combinations are unchanged (assertion flag unset):

| Suite/gate | Before = after |
| --- | --- |
| Dashboard frontend unit suite | `bun run --cwd packages/dashboard test` |
| Docker install/smoke: OpenCode, Pi, OMP | respective images, `docker run --rm --platform linux/amd64`; OMP's Node argv-renderer export check retained |
| Docker OpenCode 2 | `tests/docker/opencode2/run.sh`, pinned 2.0.22 host |
| Host OpenCode, Pi, OpenCode 2, OMP | mode-manifest lists for `--mode ts --harness opencode/pi/opencode2/omp`; `NODE_ENV=""`, `MC_E2E_MODE=ts`, matching `MC_E2E_HOST`, `bun test --timeout 600000 $files` |
| OpenCode cache oracle | `bun test --timeout 600000 src/cache-analysis.test.ts` |
| OpenCode 2 conversion + marker regressions | two sequential `bun test --timeout 600000` commands for `store-generation-conversion.test.ts` and `marker-s3-runtime.test.ts`; same host/mode environment |
| Rust unit + integration suites | `cargo test -p mc-module`; `cargo test --workspace --exclude mc-module`; fmt and clippy `--workspace --all-targets -- -D warnings` retained |
| Rust hermetic e2e | `scripts/run-rust-hermetic-e2e.sh`, four `MC_E2E_SHARD=N/4` lanes, unchanged plain/drive-fault/daemon prebuilt paths and manifest selection |
| Drift/boundary checks | historian prompt `--check`, Cargo-lock pins `--self-test`, Cargo path boundaries with/without `--self-test`, mode-manifest validation unchanged |
| Plugin boundary smokes | real Node SQLite, bundled smart-note WASM, TUI entry import, packed TUI install, packed tokenizer estimates all retained |

## C5: build once, inspect that output

* `build` remains the TUI producer. `check:tui-compiled` checks tracked drift and
  all porcelain status (including untracked outputs), without generating again.
  Its documented prerequisite is `build` or `build:tui`; both workflows already
  build before checking. `prepublishOnly` is now `build && check:tui-compiled`,
  replacing its second generator with a real drift gate.
* Both packed-install smokes accept `--skip-build` in the CI/release jobs that
  already built and checked freshness. Standalone invocations still build.
  The tarball graph-closure check and all actual installed-runtime probes remain.
  The release change only reuses this build output; its suite orchestration is
  otherwise outside C1's scope.
* The check-plugin build/freshness/two-pack-smoke sequence drops from **four TUI
  generations to one**. Independently provisioned host/Docker/hermetic jobs still
  perform their own single build; no cross-job artifact-sharing change is claimed.
* TS copies and Solid-transformed TSX now compare **bytes**, skip identical writes,
  and update changed files in place. Missing outputs are created; stale outputs
  are still removed. The existing output-directory/inode policy is preserved.
* `build:v2` no longer executes `server.test.ts`. Its four source-import/loader
  tests remain discovered by the normal plugin suite and the assertion lane.

## Verification and limits

* Frozen install after manifest edits: unchanged lockfile; 1,251 packages checked
  (996 installs locally, 1,010 Linux platform installs). No dependencies changed.
* `bun run typecheck` (Linux), TypeScript **5.9.3**: passed all four package scripts
  (including plugin script config and retina declarations); silent tsc success.
* `bun run lint` (Linux), Biome **2.5.1**: passed; plugin/Pi/CLI/retina checked
  **1,269 / 247 / 135 / 6 files**. Existing warnings/info outside changed code remain.
* `bun run build` (Linux), Bun **1.4.2**: passed plugin, Pi and CLI, seven bundle
  groups; one TUI generation, nine checked/zero rewritten; no build-time tests.
* `bun run test` in Pi (Mac): **1,625 pass / 3 skip / 0 fail**. Dedicated assertion
  command `MAGIC_CONTEXT_DEBUG_ASSERTIONS=1 bun run test --parallel=1 --timeout=60000`:
  **1,625 pass / 3 skip / 0 fail**, 155 files, 84,548 assertions, 602.72 s.
* `bun run test` in CLI (Mac): **648 pass / 2 skip / 0 fail**, 60 files across its
  five process groups. Assertion run with `--timeout=60000`: same counts.
  retina normal and assertion (`--timeout=60000`): **27 pass / 0 fail each**.
* `bun run test` in plugin: Linux **7,264 pass / 6 skip / 53 fail**, including missing
  `lsof`/process-probe failures and unrelated historian fixture failures. Mac
  **7,314 pass / 6 skip / 3 fail**, 710 files, 212,920 assertions. The three failures
  were existing home-identity tests: placing throwaway HOME inside this checkout
  made Git discovery resolve the repository rather than a non-repository home.
  With canonical, external throwaway HOME, all **11 project-identity tests passed**;
  write-if-changed's four tests and the four v2 server tests also passed.
  No unrelated identity code/tests were altered. The full plugin invocation is
  not claimed green; the failed file was rechecked rather than repeating 710 files.
* Pack-graph suite: **2 pass / 0 fail** using its package's existing 30s budget.
  An initial narrow command accidentally used Bun's default 5s and timed out in
  npm pack; the correction changed only that verification command, not any gate.
  New writer + v2 server tests with assertions: **8 pass / 0 fail**.
* Real local `build:tui`: **nine outputs preserved both mtime and inode**, wrote
  zero files; subsequent `check:tui-compiled` passed. No compiled output changes.
* Both `--skip-build` packed-install smokes passed locally: **nine TUI checks**,
  **77 reachable packed runtime files**, and two compiled-host tokenizer probes.
  Remote attempts reached packing but could not install registry dependencies
  (`DNSResolveFailed` / `EAI_AGAIN`); local registry access resolved that limit.
* actionlint **1.7.12**: both changed workflow YAML files validated. Inspect reported
  no TS/YAML errors; graph analysis and manifest diagnostics were partial, so the
  real tsc/lint/test gates above are authoritative. `git diff --check` passed.

Mutation controls and their precise failure names are recorded in the delivery
record; all mutants are restored before commit. No live-store, native Rust,
Docker, dashboard, or full host-e2e run was needed for these orchestration edits.
