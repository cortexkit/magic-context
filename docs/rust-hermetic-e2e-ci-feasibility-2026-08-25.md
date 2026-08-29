# Rust hermetic E2E CI feasibility adjudication (2026-08-25)

## Decision

Adopt **A: GitHub-hosted Linux runners with two repository-scoped read-only
deploy keys** for the tag-triggered release gate and scheduled nightly drift
gate. `cortexkit/commons` and `cortexkit/subconscious` are checked out beside
Magic Context, then the shared harness script builds and tests the current source
pair. Missing credentials produce a named GitHub Actions warning and a visibly
skipped Rust job, not a silent green pass. See [the operator
runbook](../.github/RUST_E2E_CI.md).

This replaces option B because its `m1bench` runner is retired and no longer
exists. The pivot does not mint secrets, alter sibling infrastructure, or make
a broad token available to the workflow.

## Source findings

`packages/e2e-tests/src/rust-runner/hermetic-subc.ts` defines the executable
contract:

- `buildHermeticBinaries()` runs `cargo build --release -p mc-module` in this
  checkout, then hard-links or copies the result to `ckdev-mc-e2e`.
- The same function runs `cargo build --release -p subc-core --bins` in the
  sibling `subconscious` checkout and starts the resulting `ck-subc` daemon.
- The daemon runs with a temporary `XDG_RUNTIME_DIR`, writes a connection file,
  and the module is started as an external provider. The harness then starts a
  deterministic Broca producer and `opencode serve` against the same XDG data
  directory.
- Its only platform rejection is `win32`. The remaining APIs are portable Unix
  facilities (`spawn`, `SIGKILL`, `ps -o lstart`, XDG directories, and the
  daemon's TCP/Unix-socket transport); there is no macOS-only branch. Linux is
  therefore source-feasible. The owner-reported prior Linux ARM64 `ck-mc`
  compilation is consistent with this inspection, but was not re-run while the
  box-gate lock is held.

The required source is broader than the daemon checkout. Root `Cargo.toml`
points `cortexkit-*` dependencies at `../commons` and all `subc-*` dependencies
at `../subconscious`. The existing prerequisite detector enforces both siblings.
A daemon binary alone cannot compile current `ck-mc`, and the harness
intentionally avoids pairing `ck-mc` with a stale prebuilt component.

The group contains 31 manifest-derived Rust tests and executes serially with a
600-second Bun timeout. The shared script checks its manifest selection and
requires a positive pass summary, so a crash, timeout, or zero-test run fails.

## Options

| Shape | Feasibility now | Planning duration* | Cost class | Security posture |
| --- | --- | --- | --- | --- |
| A. GitHub-hosted runner + private source credentials | Technically feasible on Linux; requires two sibling checkouts and credentials | Cold 25–45 min; cached 12–25 min | Medium recurring hosted minutes and cache storage | Read-only private-source credentials are injected only into protected tag/scheduled workflow code |
| B. `m1bench` self-hosted runner | **RETIRED:** the machine no longer exists | N/A | N/A | N/A |
| C. Prebuilt daemon artifact | Not sufficient as stated; needs an artifact-and-private-crate/source contract | Once upstream work exists: cold 10–25 min; warm 5–15 min | Upfront SUBC/registry/release work; low per-run cost | Best steady-state boundary if signed, pinned, and short-lived authenticated, but unavailable now |

\*These are conservative planning estimates, not measurements. Evidence for
scope is the two release Cargo builds, serial 31-file suite, and 600-second
per-test timeout above. Record cold and cached workflow durations after the
first two enabled runs before making a service-level claim. The repository has
no comparable CI timing trace to justify a more precise number.

### A — hosted runner + deploy keys

**Pros:** ephemeral worker, Linux execution is source-feasible, and
`actions/cache` retains the e2e-owned Cargo target directory.

**Controls/cost:** the jobs use independent read-only deploy keys for `commons`
and `subconscious`; no personal access token is used. They cache only
`packages/e2e-tests/.cache/rust-e2e-cargo-target`, keyed from all three Cargo
lockfiles plus OS and architecture. The release job remains tag-only and the
nightly drift job is schedule-only, so neither can run against pull-request
code. This retains the hosted-minute and cache-storage cost described above.

**Disposition:** selected and implemented. The jobs emit a summary line with
both checked-out sibling SHAs so the first secret-backed run is immediately
auditable.

### B — m1bench runner — RETIRED

**Disposition:** retired because `m1bench` no longer exists. No self-hosted
runner label, enable variable, or persistent source checkout remains in the
workflows. It is not a fallback for the hosted leg.

### C — prebuilt artifact

**Pros:** it is the cleanest eventual CI boundary: the public job fetches a
pinned, signed daemon contract rather than cloning private source trees.

**Blocker:** publishing only `ck-subc` does not solve `ck-mc`'s current private
path dependencies or the harness's same-revision coherence guarantee. SUBC and
commons must publish either compatible private Rust crates or a signed source
bundle alongside a platform binary and compatibility manifest.

**Disposition:** scoped to the owning teams; not implemented in this repository.

## Implemented behavior

`release.yml` uses a hosted credential preflight and `E2E (Rust hermetic)` job.
`ci.yml` has the same hosted job behind its nightly schedule. Both jobs wait for
the host E2E jobs, clone both private siblings with the two deploy keys,
restore/save the isolated Cargo target cache using all three Cargo lockfiles,
build the plugin, install OpenCode, and invoke
`scripts/run-rust-hermetic-e2e.sh`. The release publish jobs explicitly accept a
Rust job's `skipped` result only after the preflight emits the visible missing-
credential warning; a credential-backed Rust failure blocks publishing.
