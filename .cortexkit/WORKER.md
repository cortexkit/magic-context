# Working in magic-context

Standing rules for every worker in this repository. A brief can tighten them but never loosens them.

## Build and test remotely

- Run builds and tests on the build server (`runon: "linux"`, more cores for whole suites). Run on this Mac only what needs macOS, at `nice -n 10`.
- macOS release builds of ck-mc strip debug info through Cargo (`CARGO_PROFILE_RELEASE_STRIP=debuginfo`). Don't use objcopy or strip after signing.

## Gate before you deliver

Filtered tests alone are never a gate. Run the shared CI gate on Linux (`runon: "linux,16c,net"` for full):

- **Cheap checks:** `bash scripts/gate.sh preflight` runs all pins, goldens, lockfiles, layout and shard contracts, compiled contracts, Rust format, package typechecks and the pinned Biome. It reports every independent failure.
- **Delivery gate:** `bash scripts/gate.sh full` runs preflight and every locally available CI lane, including both slow-unit modes, Rust partitions, host E2E and raw replay. It reads CI's workflow matrices and invokes the same `scripts/ci/` commands. Budget 16 CPUs; supply Node 24, Bun, stable Rust with Clippy/rustfmt, nextest 0.9.138 and network access. The four Docker lanes are explicitly GitHub-CI-only until the build servers have a safe container engine; their single exclusion list is in `scripts/gate.ts`. Other missing tools fail rather than silently skip checks.
- **Selection:** `bash scripts/gate.sh full --changed <base>` may omit runtime lanes for a public-prose-only diff; other changes conservatively retain the full graph. Preflight is never narrowed. Use `--plan` to inspect the exact lanes without running them. `<base>` means a real commit/ref supplied by the caller.
- **Sizing:** `GATE_CPUS=4 bash scripts/gate.sh preflight` fits a `linux,4c,net` job. Full defaults to a 16-CPU budget and at most four concurrent lanes. Run `full --part unit`, `full --part native`, and `full --part host` in separate `linux,16c,net` jobs when a single job would exceed two hours; their union is full, and each still runs all preflight checks.
- **Native dependencies:** the daemon workspace first probes the shared Cargo home with `cargo fetch --locked --offline`. A miss uses a fresh job-local Cargo home and `cargo fetch --locked` with network access; it never copies or writes to the shared cache. The module graph retains its original Cargo home, and both selections are printed.
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

## Ask when

A decision changes behaviour, a contract, what the model sees, or a cache rebuild. Otherwise decide, and record the decision in your report.
