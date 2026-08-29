# Release-gate optimization audit

**Scope:** `scripts/release.sh`, `scripts/run-rust-hermetic-e2e.sh`,
`release-e2e-docker.sh`, and `.github/workflows/{ci,release}.yml` at
`b5dfd09c`. This is an evidence-only audit: no release gate was run.

## Evidence and limits

- `/tmp/mc-r9.log` contains a plugin-unit failure, not a completed release.
  Its 4,106-test plugin run took **31.19 s** and failed the two load-sensitive
  performance tests.
- `/tmp/mc-r10.log` contains a run through all three package unit suites and
  into the first OpenCode host-e2e group. It failed before Pi host e2e, Rust,
  generation, tag, push, or CI watch. The two requested AFT task-I/O paths did
  not exist when this audit ran, so they supply no additional timing evidence.
- Neither supplied log contains Docker output (`CACHED` or layer timings),
  Cargo output, a healthy host-e2e completion, Pi host e2e, Rust e2e, or CI job
  timestamps. Estimates below are explicitly labelled; the scripts currently
  do not print per-leg elapsed wall time.

## Timing map

| Gate / leg | What actually ran | Wall time | Evidence / interpretation |
|---|---|---:|---|
| Plugin lint | r10 | **0.152 s** (tool-reported) | `biome` says “Checked 768 files in 152ms.” This is not material. |
| Pi lint | r10 | **0.041 s** (tool-reported) | `biome` says 41ms. |
| CLI lint | r10 | **0.017 s** (tool-reported) | `biome` says 17ms. |
| Plugin typecheck | r10 | **not emitted; est. 0.25–1.5 min** | The release script invokes three `tsc` programs, but `tsc` printed no elapsed time. Instrument before trusting the estimate. |
| Pi typecheck | r10 | **not emitted; est. 0.25–1.0 min** | Same limitation. Both plugin and Pi typechecks also build `../retina-local-fs`. |
| CLI typecheck | r10 | **not emitted; est. 0.1–0.5 min** | Same limitation. |
| Plugin unit suite | r10 | **14.11 s / 0.24 min** | 4,106 pass, 376 files. r9’s equivalent run was 31.19 s under load and failed the 30ms p95 and 100ms adapter-budget guards. |
| Pi unit suite | r10 | **25.91 s / 0.43 min** | 812 pass, 73 files. |
| CLI unit suite | r10 | **10.52 s / 0.18 min** | Its runner printed 7.36s + 0.579s + 0.029s + 2.41s + 0.139s for its five serial Bun invocations. |
| Local TS host e2e, OpenCode | r10 | **25.72 min, failed** | 39 tests/19 files. Three readiness failures consumed 324.57s, 305.38s, and 307.71s of the 300s server-readiness cap. Removing only those timeouts leaves **10.10 min** of observed successful-test work; that is a lower-bound healthy-run estimate, not a measured clean completion. |
| Local TS host e2e, Pi | not in supplied logs | **est. 10–20 min** | `pi-long-running-session.test.ts` alone states a 10–15 minute budget; it is one of 22 Pi host files. CI allows 40 minutes for the whole Pi host job. |
| Docker fresh-install e2e (OpenCode/Pi) | not in local release; not logged in CI | **est. 8–20 min cold per job; parallel in CI** | Each CI job has a 25-minute cap and builds a Debian/Node/Bun/agent image. There is no observed cold/warm timing. |
| Local containerized TS host e2e setup | not in r10 (Docker unavailable) | **est. 1–5 min before tests** | The local Docker path builds `mc-e2e-host`, stages the checkout, then performs a fresh 938-package `bun install` into tmpfs. No timing is printed. |
| Rust hermetic e2e | not in supplied logs | **est. 12–35 min warm/cold** | One serial Bun invocation selects 31 Rust-mode files, builds `ck-mc` and `ck-subc`, then starts real daemon/module/OpenCode stacks. CI permits 120 minutes. This range needs real clean-run measurements. |
| Dist, pack, generated-artifact checks | not completed in supplied logs | **est. 1–4 min** | Bundler-only messages are 21–34ms, but TypeScript declaration/build time and two pack/install smokes are un-timed. |
| CI watch after tag | not observed | **est. 35–60+ min clean release** | The current release critical path is unit → Docker → host → Rust → publish/release. r10 already spent 25.7 minutes in just the first TS host group; a clean run replaces ~15.6 timeout minutes with remaining Pi/Rust work. |

### What r10 proves about the long tail

The 25.72-minute OpenCode host-e2e leg was mostly not test logic: the three
readiness failures alone cost **15.63 minutes**. `spawnOpencode()` waits up to
300,000ms for readiness. That makes readiness failures consume a release-sized
slice of wall time before a useful failure result. The healthy work observed in
that same leg is about **10.10 minutes**. Fixing or fail-fast diagnosing
readiness is therefore both a reliability improvement and the largest
log-proven local time recovery.

## Critical-path serialization

### Local `release.sh`

The release script performs, in order: plugin lint/typecheck/test/build; Pi
lint/typecheck/test/build; CLI lint/typecheck/test/build; OpenCode host e2e;
Pi host e2e; Rust e2e; generation; a second plugin lint; then tag/push/watch.
The three unit suites are serial even though the observed test summaries total
only **~0.85 minutes**. They are not where the 35–60 minutes go.

The package processes can technically run concurrently:

- Each package wires a test preload that creates a process-specific temporary
  `MAGIC_CONTEXT_TEST_DATA_DIR`; the plugin’s explicit probe verifies two Bun
  parallel workers have distinct PIDs, data homes, and database paths, and
  deliberately proves a shared home causes `SQLITE_BUSY`
  (`packages/plugin/scripts/verify-parallel-db-isolation.ts`).
- Plugin, Pi, and CLI tests are separate processes/package trees and share only
  read-mostly source/dependencies. No same-process global is required by the
  release script.
- **Do not blindly parallelize them on a loaded host.** The plugin has a 30ms
  p95 guard and 100ms adapter budget; Pi has a 15ms p95 guard. r9 demonstrates
  these can fail under load. First split or isolate those benchmarks, then run
  the remaining unit suites concurrently. Expected saving is at most **~0.4–0.8
  minutes**, so this is a small win, not the primary fix.

The host groups are intentionally serial in the host fallback
(`--max-concurrency=1`) because each file starts real daemons/servers. The
container script calls OpenCode then Pi sequentially as well. Separate
containers with independent tmpfs/data/ports could provide stronger isolation,
but CPU contention would still invalidate the load-sensitive files; this is a
restructure, not a safe shell-only speedup.

### CI and tag release

The release workflow serializes independent jobs:

```
unit jobs (parallel)
  → Docker OpenCode/Pi jobs (parallel)
  → host OpenCode/Pi jobs (parallel)
  → Rust hermetic
  → publish jobs (parallel)
```

`needs:` establishes that chain in `.github/workflows/release.yml`. The Docker,
host, and Rust jobs each check out and build their own isolated workspace; none
consumes an artifact produced by its predecessor. Docker is a useful
short-circuit, but it is not a data dependency for host behavior. Rust likewise
does not require either Docker or host output.

**Selection/concurrency drift:** local `release.sh` derives TS lists from the
committed mode manifest and serializes each host file in its non-Docker path.
Normal `ci.yml` also validates the manifest. Tag `release.yml`, however, still
uses legacy `tests/*.test.ts` globs for its host jobs and does not set
`MC_E2E_MODE` or `--max-concurrency=1`. Its OpenCode glob can discover
Rust-named tests before their prerequisite guards skip them. This means the
local, ordinary-CI, and tag-CI host gates do not execute with one demonstrably
identical contract. Restore manifest selection before using cross-environment
numbers as an optimization baseline.

**High-leverage change:** start Docker, host, and Rust after the relevant unit
jobs (keeping the Rust credential/tag guard unchanged), and make publish depend
on all of them. This changes the critical path from their **sum** to their
**maximum**. It does not remove any coverage; it trades the current
“don’t spend host resources after a Docker failure” policy for substantially
earlier verdicts and more concurrent CI capacity.

## Redundant work and caching

### Builds and installs

| Work | Local release count | Tag-release CI count | Finding |
|---|---:|---:|---|
| Plugin explicit build | 1 | 6 explicit jobs, plus one internal full build in tokenizer pack smoke | CI builds it in `test`, Docker OpenCode, host OpenCode, host Pi, Rust, and publish. `smoke-tokenizer-pack-install.ts` calls `bun run build` again. |
| Pi plugin explicit build | 1 | 4 | CI builds it in Pi unit, Docker Pi, host Pi, and publish. |
| CLI explicit build | 1 | 4 | CI builds it in CLI unit, both Docker jobs, and publish. |
| `retina-local-fs` TypeScript build | 4 invocations | repeated through root and package typechecks/builds | Both plugin and Pi `typecheck` and `build` run its `tsc -p` first. |
| `bun install` | 3 package-test installs, then one fresh container install when Docker is used | at least 8 independent job installs | The package test scripts each run frozen install. The local container forces a new tmpfs cache. CI jobs start on fresh runners. |

The local container runner does avoid an **additional dist build** when outer
`release.sh` already built the artifacts: it stages `dist/` and rebuilds only if
it is absent. That part is correctly deduplicated.

### Docker cache reality

The local runner says “cached layers reused,” so Docker’s *daemon-local* layer
cache can help a repeat run. However r10 explicitly fell back because Docker
was unavailable, so the supplied logs do **not** prove a cache hit. The release
workflow uses ordinary `docker build` with no `cache-from`, cache export, or
`actions/cache` setup. Hosted runners therefore have no cross-run Docker layer
cache established by this repository. The inner local host-e2e runner also
sets `BUN_CACHE_DIR` under a new tmpfs, guaranteeing a fresh workspace install
for every invocation.

Before optimizing this, emit `--progress=plain` and record cache-hit/miss
counts. The first concrete cache target is the stable host-e2e image and Bun
package cache; do not claim Docker is cached merely because the Dockerfile
comment says so.

### Re-verification versus independent assurance

- Local release performs full unit/build/host/Rust preflight and then blocks on
  CI, which repeats those categories on clean Linux runners. The local host
  container differs from CI host behavior and CI’s fresh-install Docker smoke,
  so it is not byte-for-byte duplicate coverage, but the unit and broadly
  overlapping host/Rust checks overlap heavily. Tag `release.yml`'s legacy glob
  selection must be normalized to the manifest before calling the host coverage
  identical.
- Tag CI’s root `test` job runs root typecheck/lint/test; the root scripts
  already include Pi and CLI. `test-pi` and `test-cli` then repeat Pi/CLI
  typecheck, lint, build, and test in their dedicated jobs.
- The plugin package smoke checks are not all redundant: Node SQLite, bundled
  WASM, raw TUI import, packed TUI install, and packed tokenizer resolution
  cover different publish seams. The *builds inside them* are candidates for
  artifact reuse, not for deleting the assertions.
- Local schema/reference generation followed by a second lint is intentionally
  a generated-output check, but rerunning whole-package lint is not where time
  is spent (r10’s first lint was 152ms).

## Load-class taxonomy

### E2E behavior files: load-affected

Every manifest-selected behavior file below is **load-affected at the file
level**: it drives a real OpenCode, Pi, or Rust harness, or has readiness,
background-historian, process, network, or timing-sensitive assertions. The
harnesses create real subprocesses; OpenCode readiness alone has a 300-second
cap. A test file may contain a pure assertion, but it cannot be safely moved to
a load-free lane without extracting that assertion.

**OpenCode TS (19):**

- `packages/e2e-tests/tests/cache-invariants.test.ts`
- `packages/e2e-tests/tests/cache-stability.test.ts`
- `packages/e2e-tests/tests/compaction-off.test.ts`
- `packages/e2e-tests/tests/conflict-disable.test.ts`
- `packages/e2e-tests/tests/context-limits.test.ts`
- `packages/e2e-tests/tests/deferred-compaction-marker.test.ts`
- `packages/e2e-tests/tests/emergency-blocking.test.ts`
- `packages/e2e-tests/tests/historian-success.test.ts`
- `packages/e2e-tests/tests/long-running-session.test.ts`
- `packages/e2e-tests/tests/memory-injection.test.ts`
- `packages/e2e-tests/tests/overflow-recovery.test.ts`
- `packages/e2e-tests/tests/session-isolation.test.ts`
- `packages/e2e-tests/tests/short-context-overflow.test.ts`
- `packages/e2e-tests/tests/slow-historian.test.ts`
- `packages/e2e-tests/tests/smoke.test.ts`
- `packages/e2e-tests/tests/subagent-behavior.test.ts`
- `packages/e2e-tests/tests/tag-owner-collision.test.ts`
- `packages/e2e-tests/tests/thinking-block-safety.test.ts`
- `packages/e2e-tests/tests/todo-synthesis.test.ts`

**Pi TS (22):**

- `packages/e2e-tests/tests/pi-cache-invariants.test.ts`
- `packages/e2e-tests/tests/pi-cache-stability.test.ts`
- `packages/e2e-tests/tests/pi-compaction-off.test.ts`
- `packages/e2e-tests/tests/pi-conflict-disable.test.ts`
- `packages/e2e-tests/tests/pi-context-limits.test.ts`
- `packages/e2e-tests/tests/pi-cross-harness.test.ts`
- `packages/e2e-tests/tests/pi-deferred-compaction-marker.test.ts`
- `packages/e2e-tests/tests/pi-drops.test.ts`
- `packages/e2e-tests/tests/pi-emergency-blocking.test.ts`
- `packages/e2e-tests/tests/pi-historian-success.test.ts`
- `packages/e2e-tests/tests/pi-long-running-session.test.ts`
- `packages/e2e-tests/tests/pi-memory-injection.test.ts`
- `packages/e2e-tests/tests/pi-overflow-recovery.test.ts`
- `packages/e2e-tests/tests/pi-session-isolation.test.ts`
- `packages/e2e-tests/tests/pi-short-context-overflow.test.ts`
- `packages/e2e-tests/tests/pi-slow-historian.test.ts`
- `packages/e2e-tests/tests/pi-smoke.test.ts`
- `packages/e2e-tests/tests/pi-subagent-behavior.test.ts`
- `packages/e2e-tests/tests/pi-tag-owner-collision.test.ts`
- `packages/e2e-tests/tests/pi-tagging.test.ts`
- `packages/e2e-tests/tests/pi-thinking-block-safety.test.ts`
- `packages/e2e-tests/tests/pi-todo-synthesis.test.ts`

**Rust-only additions (19; shared files are listed above):**

- `packages/e2e-tests/tests/pi-rust-degradation-arc-1.test.ts`
- `packages/e2e-tests/tests/pi-rust-degradation-arc-4.test.ts`
- `packages/e2e-tests/tests/rust-cold-start-drop-seed.test.ts`
- `packages/e2e-tests/tests/rust-ctx-reduce-roundtrip.test.ts`
- `packages/e2e-tests/tests/rust-duplicate-tool-use-id.test.ts`
- `packages/e2e-tests/tests/rust-fold-under-pressure.test.ts`
- `packages/e2e-tests/tests/rust-historian-producer.test.ts`
- `packages/e2e-tests/tests/rust-multi-frame-delta-perf.test.ts`
- `packages/e2e-tests/tests/rust-park-self-heal.test.ts`
- `packages/e2e-tests/tests/rust-removal-self-heal.test.ts`
- `packages/e2e-tests/tests/rust-smoke.test.ts`
- `packages/e2e-tests/tests/rust-steady-state-byte-identity.test.ts`
- `packages/e2e-tests/tests/rust-tail-mutation-readopt.test.ts`
- `packages/e2e-tests/tests/rust-fm-oc-1.test.ts`
- `packages/e2e-tests/tests/rust-fm-oc-2.test.ts`
- `packages/e2e-tests/tests/rust-fm-oc-3.test.ts`
- `packages/e2e-tests/tests/rust-fm-oc-4.test.ts`
- `packages/e2e-tests/tests/rust-fm-oc-5.test.ts`
- `packages/e2e-tests/tests/rust-fm-oc-6.test.ts`

The Rust invocation also includes these 12 shared files in Rust mode:
`cache-invariants`, `cache-stability`, `context-limits`, `emergency-blocking`,
`historian-success`, `long-running-session`, `memory-injection`,
`overflow-recovery`, `slow-historian`, `tag-owner-collision`,
`thinking-block-safety`, and `todo-synthesis`.

### Load-immune E2E file

- `packages/e2e-tests/src/cache-analysis.test.ts` — hand-built wire objects and
  the cache-analysis oracle only; no harness/process/readiness/wall-clock
  assertion. It is outside the manifest but is appended to the OpenCode host
  CI command. It can run with ordinary unit checks.

### Performance and wall-clock guards (all found)

These are the guards that should not share an overloaded local parallel lane.
Structural size/percentage comparisons are intentionally excluded.

| File | Guard |
|---|---|
| `packages/plugin/src/hooks/magic-context/tail-hygiene-walk.test.ts` | 250k-token walk p95 **<30ms** |
| `packages/pi-plugin/src/tail-hygiene-walk-pi.test.ts` | memoized 250k-token walk p95 **<15ms** |
| `packages/plugin/src/hooks/magic-context/rust-mode-transform.test.ts` | 1,000-message steady adapter pass **<100ms**; 1,400-message prefix median sample **<10ms** |
| `packages/e2e-tests/tests/rust-multi-frame-delta-perf.test.ts` | prefix guard **<10ms**, state sync **<15ms**, wire build **<10ms**; under `MC_RUST_E2E_STRICT_PERF=1`, transport **<30ms** and adapter **<100ms** |
| `packages/e2e-tests/tests/pi-slow-historian.test.ts` | main request must arrive at least 2s before the configured historian delay expires |
| `packages/plugin/src/hooks/magic-context/module-transport.test.ts` | mocked timeout/backoff cases bounded at **<1,000ms** (including sibling-session wall **<900ms**) |
| `packages/plugin/src/hooks/magic-context/auto-search-runner.test.ts` | mocked hung search finishes **<4,000ms** |
| `packages/pi-plugin/src/auto-search-pi.test.ts` | mocked hung search finishes **<4,000ms** |
| `packages/plugin/src/features/magic-context/smart-notes/sandbox-runner.test.ts` | sandbox execution bounds **<1,000ms**, **<500ms**, and **<250ms** |
| `packages/plugin/src/features/magic-context/smart-notes/compiler.test.ts` | compile fast path **<50ms** |
| `packages/cli/src/lib/opencode-helpers.test.ts` | hanging version probe completes before `OPENCODE_VERSION_PROBE_TIMEOUT_MS + 1,500ms` |

The r9 failure specifically names the first plugin p95 guard and the plugin
100ms adapter guard. This validates the concurrency caveat with actual release
log evidence rather than theory.

## Ranked recommendations

| Rank | Change | Estimated critical-path saving | Risk | Why / guardrail |
|---:|---|---:|---|---|
| 1 | Remove CI stage-only dependencies: run Docker, host behavior, and Rust after their unit prerequisites; publish still waits for every result. | **Docker + host overlap; plausibly 10–25+ min** | Low–medium | No job consumes a predecessor artifact. Preserve required checks and Rust tag/credential condition. This is the largest structural gain. |
| 2 | Make the default local release preflight cheap and deterministic; retain full local host/Rust as an explicit `--full` confidence run while CI remains the publish authority. | **20–45 min of operator wait** | Medium | CI already repeats all release-critical categories on clean hosted Linux. Keep local build/package sanity checks and fail-fast readiness diagnostics. |
| 3 | Fix/fail-fast OpenCode readiness before optimizing test execution. Capture stage timing and terminate after a smaller diagnostic cap once the server socket is listening but API readiness stalls. | **up to 15.63 min per three failures (proven)** | Medium | r10 spent 15.63 minutes in three known failed starts. Do not silently lower correctness timeouts; emit stage/attempt timings and preserve a separately configurable full cap. |
| 4 | Persist Docker/Bun caches honestly: BuildKit cache export/import for CI, a durable dependency layer/cache for local host e2e, and plain progress/cache-hit telemetry. | **cold setup 1–10+ min; unmeasured** | Medium | Current CI has no configured cross-run Docker cache and local inner Bun cache is tmpfs. Measure cache hit rate before maintaining a cache strategy. |
| 5 | Make tag CI use the committed mode manifest and an explicit host-e2e concurrency policy, matching local/ordinary CI intent. | **unmeasured; prevents accidental extra/skip work** | Low | The tag workflow currently uses legacy globs while local and ordinary CI use the validator. Normalize correctness before comparing or moving legs. |
| 6 | Build each package once per CI release and distribute immutable artifacts to Docker/host/publish jobs, with checksum/provenance verification. | **several build/install minutes and queue time** | Medium–high | Eliminates plugin 6+ builds, Pi 4, CLI 4. Package/host checks must consume the exact artifact that is later published; avoid an artifact-trust regression. |
| 7 | De-duplicate root Pi/CLI unit checks from `test` versus dedicated Pi/CLI jobs, or replace root job with plugin+retina only. | **~0.6–2 min plus runners** | Medium | Today root scripts already include Pi/CLI and dedicated jobs repeat them. Preserve retina coverage and package-specific build/smokes. |
| 8 | Run plugin, Pi, and CLI unit suites concurrently only after extracting/isolation-running the wall-clock guards above. | **~0.4–0.8 min** | Medium | DB isolation is proven. CPU-load-sensitive p95/adapter guards are not. This is a small win with real flake risk if done first. |
| 9 | Keep generated-output verification but lint only regenerated files (or verify exact generated diffs) after generation. | **seconds, not minutes** | Low | r10 reports all three lints below 0.2s. This is cleanup, not an optimization priority. |

## Measurement plan before changing gates

Add a monotonic `start/end/duration_ms` line around every release-script leg and
inside `release-e2e-docker.sh`; print Docker plain-progress cache status and
Cargo “fresh/compiled” counts. Upload a compact timing JSON from each CI job
(including queue-independent step durations). Collect at least three clean
warm/cold runs and report p50/p95 by leg. This turns the Pi, Rust, Docker,
typecheck, dist, and CI-watch estimates above into an actionable budget without
running an extra release gate on the busy box.
