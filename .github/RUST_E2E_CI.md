# Rust hermetic E2E CI gates

The Rust hermetic E2E gate exercises the production-shaped path:

```text
opencode serve → Magic Context plugin → ck-subc → ckdev-mc-e2e
```

[`scripts/run-rust-hermetic-e2e.sh`](../scripts/run-rust-hermetic-e2e.sh) is the
single invocation for the local release script and both CI jobs. It derives test
files from `packages/e2e-tests/mode-manifest.json`, verifies the private Rust
source workspaces, builds the current `ck-subc` and `ckdev-mc-e2e` pair into its
e2e-owned Cargo target directory, and requires a real positive Bun pass summary.
A missing prerequisite, crash, or zero-test run is never treated as a pass.

## Active design: GitHub-hosted Ubuntu runners

The release workflow runs `E2E (Rust hermetic)` on `ubuntu-latest` for `v*` tags.
The nightly drift job in `ci.yml` runs the same hosted leg at 03:17 UTC from the
default branch. The release leg is tag-only and the drift leg is schedule-only;
private-source credentials are never made available to untrusted branch code.

Ubuntu is the correct hosted OS for this stack. The harness rejects only Windows
and otherwise uses portable Unix facilities (process spawning, signals, XDG
directories, and daemon sockets); it has no macOS-only branch. GitHub-hosted
Linux is therefore source-feasible. The cost class is **medium recurring hosted
minutes and cache storage**: plan 25–45 minutes from a cold cache and 12–25
minutes from a warm cache. Those are planning estimates; record the first cold
and warm run durations before making a service-level claim.

Each job checks out `cortexkit/commons` and `cortexkit/subconscious` beside
`$GITHUB_WORKSPACE`, matching this repository's `../commons` and
`../subconscious` Cargo path dependencies. It restores/saves only
`packages/e2e-tests/.cache/rust-e2e-cargo-target`, keyed by this repository's
`Cargo.lock`, both sibling lockfiles, runner OS, and architecture. The shared
script performs the authoritative builds into that cache and runs the suite.

## Active credential flow: cortexkit-ci GitHub App

The active jobs consume these **repository** Actions secrets on
`cortexkit/magic-context`:

| Secret | Use |
| --- | --- |
| `CK_CI_APP_ID` | App ID supplied to `actions/create-github-app-token@v1` |
| `CK_CI_APP_PRIVATE_KEY` | Private key supplied to `actions/create-github-app-token@v1` |

Both secrets are already provisioned. This runbook documents consumption of the
existing secrets; it does not require operator key-minting or secret creation.

Each private-source job follows the same flow:

1. `actions/create-github-app-token@v1` creates a short-lived installation token
   using `CK_CI_APP_ID` and `CK_CI_APP_PRIVATE_KEY`.
2. The action sets `owner: cortexkit` and
   `repositories: subconscious,commons` **explicitly**. The explicit repository
   list scopes the one-hour installation token to exactly the two sibling
   repositories rather than granting the App's all-repositories reach.
3. Each `actions/checkout@v5` sibling checkout uses
   `${{ steps.cortexkit-ci-token.outputs.token }}` and sets
   `persist-credentials: false`. The checkout still authenticates the clone, but
   does not leave a live token in the repository's local Git configuration for
   later build or test steps.

Both private-source jobs declare `permissions: contents: read`. The release
workflow's broader top-level permissions do not widen those job-level floors.
The jobs remain protected by their tag-only or schedule-only reachability; do not
copy either private-source job to a pull-request or other unprotected trigger.

## Missing-secret degradation

The credential-preflight job checks both `CK_CI_APP_ID` and
`CK_CI_APP_PRIVATE_KEY` without printing their values. If either is absent, the
job emits a warning naming the exact missing secret, writes a `SKIPPED` entry to
the job summary, and exposes `enabled=false`. The Rust job is visibly skipped,
not reported as passed. Release publishing accepts only that explicit skipped
state; an enabled Rust job that fails blocks publishing.

## First hosted-run check

After the first run, inspect the **E2E (Rust hermetic)** job summary. Its first
line has this exact shape, with the two 40-character commit IDs:

```text
Rust hermetic sibling checkouts: commons=<sha>; subconscious=<sha>
```

Confirm both SHAs are the intended sibling revisions, then confirm the shared
script's `Build ck-subc and ckdev-mc-e2e, then run Rust hermetic e2e` step passed.
The nightly drift job writes the same line. This makes the first secret-backed
run verifiable at a glance without revealing either secret.

## Security and maintenance

The short-lived App installation token can read only the explicitly listed
private sibling repositories for this job. Protect release tags and workflow
changes, restrict who can modify the default branch, and rotate or revoke the
App credential immediately if a secret may have been exposed. Keep the release
job tag-only and the CI Rust job schedule-only; do not add either private-source
job to a pull-request, fork-triggered, or manual unprotected workflow.

## Fallback appendix — deploy-key checkout (NOT ACTIVE)

> **NOT ACTIVE:** The current release and nightly jobs use the scoped
> `cortexkit-ci` GitHub App flow above. No deploy-key secret or operator key
> minting is required for the active lane. This appendix preserves the former
> checkout's names and repository-scoped shape only as a fallback reference; do
> not configure it unless the workflow is deliberately changed and reviewed.

The former checkout used two independent read-only repository Actions secrets:

| Secret | Former repository access |
| --- | --- |
| `COMMONS_READ_DEPLOY_KEY` | `cortexkit/commons` only |
| `SUBCONSCIOUS_READ_DEPLOY_KEY` | `cortexkit/subconscious` only |

That inactive shape wrote the keys to a temporary `0700` directory, loaded them
into an `ssh-agent` only long enough to clone the siblings, then stopped the
agent and removed the temporary key files. It used separate keys because deploy
keys are repository-scoped. These names may remain here for historical fallback
reference only; they must not appear in either workflow's active path.

## Option B: m1bench self-hosted runner — RETIRED

> **RETIRED:** `m1bench` no longer exists. No workflow targets a self-hosted
> `m1bench` label or relies on a persistent runner checkout.

The former option used a dedicated Mac runner with pre-provisioned sibling
source. Do not recreate its repository variable, runner label, or persistent
sibling checkout path; the hosted App-token design above is the active release
and nightly gate.

## Alternative C: prebuilt daemon artifact (not wired)

A prebuilt `ck-subc` binary alone does not make the current harness portable.
`buildHermeticBinaries()` deliberately builds current-tree `ck-mc`, which
compiles against private `commons` and `subconscious` path dependencies. A future
artifact design needs signed, versioned binaries plus a compatibility tuple and
either private published crates or an immutable signed source bundle for both
siblings. Until then, the hosted source checkouts remain the safe current design.
