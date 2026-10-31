# Working in magic-context

Standing rules for every worker in this repository. A brief can tighten them but never loosens them.

## Read first

Read `ARCHITECTURE.md` and `STRUCTURE.md` at the repository root before changing any code. They describe how a transform pass works, the cache rules every change must keep, and where code belongs. Don't edit either file.

## Build and test remotely

- Run builds and tests on the build server (`runon: "linux"`, more cores for whole suites). Run on this Mac only what needs macOS, at `nice -n 10`.
- macOS release builds of ck-mc strip debug info through Cargo (`CARGO_PROFILE_RELEASE_STRIP=debuginfo`). Don't use objcopy or strip after signing.

## Gate before you deliver

A worker's gate covers what it touched, run on Linux:

- `bash scripts/gate.sh preflight`, always. It takes about a minute and catches pin, golden, lockfile and format drift anywhere.
- The full test suite of every package or crate you changed: for example `cargo test -p mc-module --lib --locked -- --skip final_hundreds` plus clippy with `-D warnings` for ck-mc, or `bun test` in each touched package. Add the shared guards (`cd packages/plugin && bun test src/shared/`) whenever you add a test or a subprocess.
- A test that fails without your fix, for every bug fix.

`bash scripts/gate.sh full` is the head's integration gate. The head runs it once over several merged deliveries, not per worker delivery. Run it yourself only when your brief asks for it. The details below describe both scripts.

- **Cheap checks:** `bash scripts/gate.sh preflight` runs all pins, goldens, lockfiles, layout and shard contracts, compiled contracts, Rust format, package typechecks and the pinned Biome. It reports every independent failure.
- **Preflight ordering:** workflow-marked independent layout/format groups overlap dist production. Generated-output readers follow the build, then package typechecks run concurrently after the shared composite declarations are prepared. Package typecheck script payloads remain authoritative.
- **Delivery gate:** `bash scripts/gate.sh full` runs preflight and every locally available CI lane, including both slow-unit modes, Rust partitions, host E2E and raw replay. It reads CI's workflow matrices and invokes the same `scripts/ci/` commands. Budget 8 CPUs by default; supply Node 24, Bun, stable Rust with Clippy/rustfmt, nextest 0.9.138 and network access. The four Docker lanes are explicitly GitHub-CI-only until the build servers have a safe container engine; their single exclusion list is in `scripts/gate.ts`. Other missing tools fail rather than silently skip checks.
- **Selection:** `bash scripts/gate.sh full --changed <base>` may omit runtime lanes for a public-prose-only diff; other changes conservatively retain the full graph. Preflight is never narrowed. Use `--plan` to inspect the exact lanes without running them. `<base>` means a real commit/ref supplied by the caller.
- **Sizing:** `GATE_CPUS=4 bash scripts/gate.sh preflight` fits a `linux,4c,net` job. Full defaults to an 8-CPU budget and at most four concurrent lanes. Run `full --part unit`, `full --part native`, and `full --part host` sequentially in separate `linux,8c,net` jobs when a single job would exceed two hours; their union is full, and each still runs all preflight checks. Use `GATE_CPUS=16` with an explicitly requested `linux,16c,net` slot when capacity is available; do not require a 16-core slot for routine gating.
- **Native dependencies:** the daemon workspace first probes the shared Cargo home with `cargo fetch --locked --offline`. A miss uses a fresh job-local Cargo home and `cargo fetch --locked` with network access; it never copies or writes to the shared cache. The module graph retains its original Cargo home, and both selections are printed.
- **Shared workspace setup:** local lanes serialize frozen workspace installs and package wrappers that install dependencies. CI jobs have separate checkouts; concurrent installs into one local `node_modules` can otherwise fail while linking bins.
- **Workflow budgets and guards:** each lane shares its workflow job's `timeout-minutes` budget across all setup/check commands (GitHub's 360-minute default when omitted). Dist consumers require both producer steps, `Build complete dists` and `Check compiled contracts`, to pass; the latter verifies generated plugin terminal-interface files, the historian-prompt golden and the dist-restoration test. Unrelated static groups do not affect dist readiness. Supported YAML `needs` are enforced; new job-level conditions or dependency expressions that the executor cannot interpret fail loudly before execution.
- **Default OC2 host:** Rust hermetic lanes verify the cached pinned host. An unrun-postinstall command triggers the same exact-host install and version verification used by the CI matrix, in job-local storage; the selected source is printed. Other invalid host binaries fail rather than being substituted.
- **Git baseline transport:** baseline objects are fetched into scratch Git metadata, leaving the source checkout unchanged. If a hosted snapshot's local mirror path is not mounted, the fetch uses the versioned plugin package's declared repository URL; `GATE_GIT_REMOTE` can explicitly select another reachable transport for the same pinned commit.
- **OS prerequisites:** the gate checks the selected lanes' executable tools before tests. Missing Linux x64 `lsof` is supplied from the SHA-256-pinned Debian 4.95.0-1 package under `target/scratch/lsof`; its runtime libraries are checked, and only runtime child commands receive the added bin path. Other missing tools fail by name; offline jobs without `lsof` fail rather than bypassing database safety guards.
- **Runtime homes:** each lane gets a fresh home under the job's `tmpdir()`, rejected if its physical path has an ancestor with a `.git` entry. A home inside a checkout would resolve to that project instead of an independent directory in identity tests. Live user stores are never reused.
- **Independent Smoke:** `bash scripts/gate.sh smoke` runs the same two-hostname HTTP diagnostic as the Smoke workflow. GitHub's artifact transport, cache/status services and scheduled upstream-HEAD drift remain CI-only; local full uses same-checkout producer outputs and the locked daemon revision.

Put each command, elapsed time, pass/fail counts and every failing test name in your report. Gate logs/results are under `target/gate/`; copy evidence cited by a report into `.cortexkit/internal-docs/` before delivery. If a failure isn't yours, show it fails the same way on your base commit.

## Pre-approved, so don't ask

- Regenerating a pinned hash, golden or fixture when the new output differs only by the cause you state (a version bump or your intended change). Say so in the commit message.
- Updating a test that your intended change breaks, keeping what the test checks.
- Moving tests into their own file to satisfy a source scan.

## Never

- Change production code outside your file fence without asking.
- Loosen a threshold, an assertion or a timeout to get green. Find the cause.
- Open, copy or write the live stores under `~/.local/share/cortexkit/`. Work on copies you were given.
- Commit generated archives, base64 blobs or any file over 1 MB into tracked files.
- Force-add ignored `.cortexkit/` files.
- Remove a route, role, op, hook or code path without listing in your report every feature that used it, and where each one lives afterwards. A removal that leaves a feature with nowhere to run is a regression, even when every test passes.

## Ask when

A decision changes behaviour, a contract, what the model sees, or a cache rebuild. Otherwise decide, and record the decision in your report.
