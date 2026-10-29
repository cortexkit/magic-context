# Working in magic-context

Standing rules for every worker in this repository. A brief can tighten them but never loosens them.

## Build and test remotely

- Run builds and tests on the build server (`runon: "linux"`, more cores for whole suites). Run on this Mac only what needs macOS, at `nice -n 10`.
- macOS release builds of ck-mc strip debug info through Cargo (`CARGO_PROFILE_RELEASE_STRIP=debuginfo`). Don't use objcopy or strip after signing.

## Gate before you deliver

Filtered tests alone are never a gate. Before delivering, run, on Linux:

- **Rust:** `cargo fmt --all -- --check`, `cargo clippy -p <crate> --all-targets --locked -- -D warnings`, and the full test suite of every crate you touched (`cargo test -p <crate> --locked`). The slow campaign tests are excluded only where the brief says so.
- **TypeScript:** the full suite of every package you touched, both typechecks, and the repo's pinned Biome (`./node_modules/.bin/biome`, never `bunx biome`).
- **Pins:** if you changed anything a pin, golden, manifest count or lockfile covers, run that check too. The Preflight job in `.github/workflows/ci.yml` lists them.

Put each command, its pass/fail counts and every failing test name in your report. If a failure isn't yours, show it fails the same way on your base commit.

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
