# Docker E2E tests

Integration tests that prove the published plugin tarballs actually load and work end-to-end inside a clean Linux environment with real OpenCode / Pi binaries plus a mock LLM (aimock).

## What this covers

These tests sit **above** the in-process Bun e2e suite (`packages/e2e-tests/`) which hits the plugin pipeline directly. The docker layer covers the seam the in-process tests can't reach:

- **Real binaries** — the actual `opencode` and `pi` binaries users install, not a Bun-spawned mock harness
- **Real install path** — `bunx --bun ...@latest doctor --force` against an empty home directory, the same command users run after first install
- **Real OS** — Debian bookworm, the most common deployment target after macOS
- **Real native modules** — `better-sqlite3` rebuilt for Linux x64, `@huggingface/transformers` resolution, etc.
- **Cross-harness shared SQLite** — both harnesses point at the same `~/.local/share/cortexkit/magic-context/context.db` and write distinct `harness` rows

What's intentionally **not** covered here (already exercised by `packages/e2e-tests/`): historian compartments, recomp, dreamer scheduling, memory consolidation, complex tool-call patterns, Anthropic-specific cache-token semantics, overflow recovery. Those tests need precise control over message shapes and provider responses which is much faster in-process than through aimock.

## Layout

```
tests/docker/
├── Dockerfile.opencode          # Debian + Node + Bun + OpenCode + aimock
├── Dockerfile.pi                # Debian + Node + Bun + Pi + aimock
├── test-opencode-e2e.sh         # 2-phase test: SETUP_SMOKE + SESSION_SMOKE
├── test-pi-e2e.sh               # 2-phase test: SETUP_SMOKE + SESSION_SMOKE
├── fixtures/
│   ├── aimock-opencode.cjs      # Mock LLM fixture for OpenCode session smoke
│   └── aimock-pi.cjs            # Mock LLM fixture for Pi session smoke
└── run-e2e.sh                   # Local runner: builds + runs both images
```

## Running locally

```bash
# Both harnesses
tests/docker/run-e2e.sh

# Just one
tests/docker/run-e2e.sh opencode
tests/docker/run-e2e.sh pi
```

The runner pre-builds the local plugin dists (the Dockerfiles `COPY` from `packages/*/dist/` rather than building inside the image — keeps iteration fast).

Requires Docker with Linux/amd64 emulation. On Apple Silicon, this means `--platform linux/amd64` (the runner sets it automatically); first run will pull `qemu-user-static` if you haven't built linux/amd64 images before.

## Running in CI

`.github/workflows/e2e-docker.yml` runs both jobs on:
- pushes to `master`
- pull requests touching `packages/plugin/**`, `packages/pi-plugin/**`, or `tests/docker/**`
- `v*` tag pushes (release gate)
- manual `workflow_dispatch`

## Test phases

Each container runs two phases in sequence:

### Phase 1 — `SETUP_SMOKE`

Starts from a clean home directory. Runs the non-interactive `doctor --force` flow, which is what we publish as the "I just installed, fix me up" command. Asserts:

- doctor exits with `Doctor (complete|repair complete)` summary
- the harness-specific config file gets created
- the plugin entry gets registered
- doctor reports `FAIL 0` failures
- (Pi) doctor confirms Pi version meets the `>= 0.71.0` floor

### Phase 2 — `SESSION_SMOKE`

Layers a minimal `magic-context.jsonc` and an aimock-pointed provider config on top, then runs a single agent turn (`opencode run "..."` or `pi --print "..."`). Asserts:

- aimock responds to `/v1/models`
- the agent binary completes within 60s
- the Magic Context plugin log is non-empty
- the shared SQLite DB exists
- at least one `tags` row was written with the matching `harness` value
- at least one `session_meta` row was written with the matching `harness` value

If both phases pass, the container exits 0; otherwise it exits 1 and the script prints which `check` failed.

## Adding a new test

For a new always-on assertion, add a `check` line to the appropriate `test-*-e2e.sh`:

```bash
check "label that names what's being verified" \
    "test -f /path/that/should/exist"
```

For a new mock-LLM behavior, add another `mock.on({...}, {...})` block to the matching `fixtures/aimock-*.cjs`. See [aimock docs](https://www.npmjs.com/package/@copilotkit/aimock) for the response shape.

For deeper scenarios (multi-turn, historian publication, dreamer), prefer adding to `packages/e2e-tests/` instead — the in-process harness is much faster to iterate on and has tighter control over message shapes than aimock does.
