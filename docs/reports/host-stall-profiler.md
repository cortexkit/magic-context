# Host stall profiler

An off-by-default diagnostic in the Magic Context OpenCode plugin (OpenCode 1
entry only) that names the JavaScript blocking OpenCode's main thread during
multi-second host stalls. It was built to follow up the stalls described in
`docs/reports/ckmc-silent-stalls.md`: native `sample` stacks show synchronous
work on the main thread but not which in-process plugin (Magic Context,
Prefrontal, AFT, anthropic-auth, …) made the call.

Code: `packages/plugin/src/plugin/host-stall-profiler.ts` (switch, watchdog,
report writer) and `host-stall-profiler-report.ts` (owner mapping and
aggregation). There is no config key; the file switch is the only control.

## How it works

- **File switch.** Every 30 s the plugin checks for
  `<storage>/host-profiler/enable`, where `<storage>` is the Magic Context
  storage directory (`~/.local/share/cortexkit/magic-context` by default;
  `MAGIC_CONTEXT_STORAGE_DIR` or `XDG_DATA_HOME` move it). Creating the file
  starts the profiler and deleting it stops it, with no restart. While the file
  is absent the only work is that `existsSync`: `bun:jsc` is not imported and
  no watchdog runs.
- **Sampler.** `bun:jsc`'s `startSamplingProfiler()` samples the main thread
  from its own thread, so it records stacks *during* a block. The sampling
  interval is set (and sampling paused on disable) through `bun:jsc`'s
  `profile(fn, intervalMicros)`, which leaves the sampler paused when it
  returns; `bun:jsc` has no separate stop call.
- **Watchdog.** A 250 ms interval measures the real gap between ticks. A gap
  over the threshold (default 3000 ms) is a stall. Every tick drains the
  sampler, so samples never pile up between ticks; on a stall the drained
  samples are filtered to the stall window by timestamp (the sampler's clock is
  calibrated against `performance.now()` when the profiler starts). If the
  calibration is unavailable or matches nothing, the report keeps every sample
  since the previous tick and says so in `sampling.window_filter`.
- **Report.** One JSON file per stall, `host-profiler/stall-<ISO time>.json`
  (colons replaced by `-`), mode 0600 in a 0700 directory, newest 50 kept.
  At most 20 000 samples are aggregated per stall (a longer stall is thinned
  evenly).
- **Fail-open.** Each failure is logged once to the Magic Context log and never
  reaches a turn. If `bun:jsc` cannot be loaded, the profiler turns itself off
  for the life of the process.

## Turning it on

```sh
dir="${MAGIC_CONTEXT_STORAGE_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/cortexkit/magic-context}/host-profiler"
mkdir -p -m 700 "$dir"
# Empty file = defaults. Optional JSON: threshold_ms (500-600000, default
# 3000) and sample_interval_ms (1-100, default 10).
echo '{"threshold_ms": 3000}' > "$dir/enable"
```

Within 30 s the Magic Context log shows
`host stall profiler enabled: threshold 3000ms, sample interval 10ms, clock calibration ok, …`.
Each stall logs one line naming the top owner and the report path. Edits to
the enable file are picked up on the next 30 s check. To turn it off:
`rm "$dir/enable"` (log: `host stall profiler disabled: enable file removed`).

## Reading a report

| Field | Meaning |
| --- | --- |
| `window.start`, `window.end`, `duration_ms` | Wall-clock bounds of the gap between two watchdog ticks. |
| `window.lag_ms` | `duration_ms` minus the 250 ms tick interval: how late the event loop was. |
| `sampling` | Interval, samples collected / in the window / aggregated, and how the window was cut (`timestamp` or `since-last-collection`). A `note` appears when the window has no samples. |
| `memory.before`, `memory.after` | `heapSize()`, `bun:jsc` `memoryUsage()`, RSS and `percentAvailableMemoryInUse()` (null on macOS) from just before (at most ~1 s old) and just after the stall. The full `heapStats()` is not taken: it cost ~70 ms on a 2-million-object heap. |
| `owners` | Samples attributed to an owner, with percentages. **Start here.** |
| `top_frames` | The innermost frame of each sample, native host functions included (`get [native]` for a SQLite step). |
| `top_js_frames` | The innermost frame that has JavaScript source, i.e. the JS caller of any native frame. |
| `top_stacks` | The 30 most frequent full stacks, innermost frame first, each frame tagged with its owner. |

Owners come from each frame's source URL:

- `native`: a host function without JavaScript source (SQLite `get`, `readFileSync`, …)
- `runtime`: Bun/Node builtins (`node:events`, `internal:streams/…`, `bun:sqlite`)
- `opencode`: the compiled OpenCode binary (`/$bunfs/root/chunk-*.js`; `~BUN` on Windows)
- `npm:<pkg>`: anything under `node_modules/<pkg>` (the innermost package)
- `plugin:<file>`: a file in an OpenCode `plugin/` or `plugins/` directory
- `pkg:<name>`: any other file, by its nearest `package.json` (a plugin loaded
  from a local checkout, such as Magic Context's own `dist/index.js`)

A sample is attributed to its innermost frame that is not `native`, `runtime`
or `opencode`: a plugin calling a blocking native API is blamed, not the API
and not the host code that invoked the plugin hook. Only when no such frame
exists does the sample count for `opencode`, then `native`.

A report with no samples means the main thread was not executing inside the
JavaScript VM during the gap (idle wait, process suspension, or native work
not reached from any JavaScript call). That is itself evidence: it points away
from plugin JavaScript.

## Verification on a real OpenCode host

Host: installed `opencode` **1.18.35** (`/global/health` →
`{"healthy":true,"version":"1.18.35"}`), its embedded Bun reports
`process.versions.bun` **1.4.2**, macOS arm64. Plugin built from this branch
(`bun run build`), loaded as `file://…/packages/plugin/dist/index.js`.

Isolation: `opencode serve --port 19561` ran from a throwaway root under
`$TMPDIR/magic-context/bg_4beb8d9bf19d7578/` with `HOME`, `TMPDIR`,
`XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME`,
`XDG_RUNTIME_DIR`, `OPENCODE_DB`, `MAGIC_CONTEXT_STORAGE_DIR` and
`MAGIC_CONTEXT_LOG_PATH` all inside it, default plugins and autoupdate off.
`lsof -p <host pid>` on both runs listed only throwaway databases
(`…/bg_4beb8d9bf19d7578/data/opencode-throwaway.db{,-wal,-shm}` and
`…/bg_4beb8d9bf19d7578/storage/context.db{,-wal,-shm}`), and no path under
`~/.local` or `~/.config`.

A test-only plugin, `stall-injector.ts`, lived only in the throwaway
`config/opencode/plugin/` directory. It imported `bun:jsc` itself and blocked
the main thread on timers and inside an `event` hook. With the enable file
present at boot (threshold 3000 ms, then 2000 ms):

| Injected block | Measured | Report | Top owner | Top JS frame |
| --- | --- | --- | --- | --- |
| 6 s synchronous busy loop (timer) | 6000 ms | 6094 ms, 493 samples, `timestamp` filter | `plugin:stall-injector.ts` 100% | `deliberateStallInjectorBusyLoop …/plugin/stall-injector.ts:13` |
| 6 s synchronous `bun:sqlite` query loop (recursive CTE, `query.get()` 189 times) | 6027 ms | 6220 ms, 502 samples | `plugin:stall-injector.ts` 100% | `deliberateStallInjectorSqliteLoop …/stall-injector.ts:25` (501 samples) under innermost `get [native]` |
| 4 s busy loop inside the plugin's `event` hook on `session.created` | 4000 ms | 4248 ms, 326 samples | `plugin:stall-injector.ts` 99.4%, `opencode` 0.6% | `deliberateStallInjectorBusyLoop`, then `event` hook, then OpenCode frames `/$bunfs/root/chunk-*.js` (`runLoop`, `~effect/Effect/evaluate`) and `node:events` `emit` |

So the JavaScript caller of a synchronous SQLite step **does** show up: the
innermost frame is the native `get`, and the next frame is the plugin function
that called it. OpenCode's own code appears as `/$bunfs/root/chunk-*.js`
frames (minified chunk names, so attribute by owner, not by OpenCode function
name).

`import("bun:jsc")` works from a plugin inside OpenCode's compiled binary: the
injector's own import succeeded and listed `startSamplingProfiler`,
`samplingProfilerStackTraces`, `profile`, `heapStats`, `memoryUsage`,
`heapSize` and `percentAvailableMemoryInUse`; the Magic Context profiler's
import succeeded in the same process.

The live switch was also exercised without a restart: deleting the enable file
logged `disabled: enable file removed` 20 s later (next 30 s poll), and
recreating it logged `enabled` again on the following poll. On the first build
that re-enable logged `clock calibration unavailable` (reports then fall back
to `since-last-collection`): a sampler restarted after a pause can take one old
interval to wake, so a single 5 ms calibration spin caught no sample.
Calibration now repeats short 3 ms spins until it sees samples (at most 30).
Re-checked on a fresh host with the fixed build: the boot enable, a 6 s
busy-loop report (6128 ms, 498 samples, `plugin:stall-injector.ts` 100%), the
removal, and the re-enable (`clock calibration ok`, setup 17 ms) all behaved.
A standalone Bun loop of four enable/disable cycles alternating 10 ms and
100 ms intervals also calibrated every time (setup 3-83 ms; the slowest
followed a 100 ms-interval pause).

Final build (reports written through the shared owner-only storage helpers):
a fresh host run reproduced both results, the busy loop at 6252 ms / 502
samples (`plugin:stall-injector.ts` 100%) and the SQLite loop at 6236 ms / 501
samples (`plugin:stall-injector.ts` 99.8%, innermost `get [native]`, JS caller
`stall-injector.ts:25`), both reports mode 0600, and `lsof` again listed only
the throwaway databases.

## Overhead

`bun packages/plugin/scripts/host-stall-profiler-overhead.ts` runs each mode in
a fresh process: a fixed synchronous busy loop (60 M iterations of a small
allocate-and-reduce body) and 10 s of idle time, with the profiler off, on at
the default 10 ms interval, and on at JavaScriptCore's 1 ms default. Medians of
5 interleaved rounds (`OVERHEAD_ROUNDS=5`) on a shared, busy macOS arm64 machine
(Bun 1.4.2):

| Mode | Busy loop wall | Busy loop CPU time | Busy loop CPU % | Idle CPU % |
| --- | --- | --- | --- | --- |
| off | 4364 ms | 5319 ms | 129.3% | 0.22% |
| on, 10 ms | 4356 ms | 5793 ms | 132.2% | 0.40% |
| on, 1 ms | 5265 ms | 6086 ms | 124.2% | 1.26% |

CPU % is process CPU time over wall time; above 100% because garbage
collection runs on other threads. On macOS, at the default 10 ms interval the
busy loop's wall time is unchanged within noise, its CPU time rises ~9% (the
sampler thread), and an idle process goes from 0.22% to 0.40% CPU. At 1 ms the
busy loop slows ~21% and idle CPU is ~1.3%.

Same script on the Linux build server (`linux-x64`, 32 cores, shared, Bun
1.4.2), medians of 5 interleaved rounds:

| Mode | Busy loop wall | Busy loop CPU time | Busy loop CPU % | Idle CPU % |
| --- | --- | --- | --- | --- |
| off | 3226 ms | 4872 ms | 142.0% | 0.51% |
| on, 10 ms | 3544 ms | 5284 ms | 148.2% | 0.95% |
| on, 1 ms | 3338 ms | 4794 ms | 142.9% | 1.11% |

On both machines single busy-loop runs varied far more than the differences
between modes (Linux `off` ranged 2862-5862 ms, macOS `off` 3815-6923 ms),
because other jobs shared them. The defensible conclusion is an upper bound:
at 10 ms the busy-loop cost is at most ~10% CPU time and not measurable in
wall time above that noise, and the steady idle cost is about +0.2 to +0.45
percentage points of one core. The idle column is the stable signal and grows
with the sampling rate.

## Limits

- The watchdog measures lag only after the stall ends; a stall that never ends
  produces no report.
- `bun:jsc` cannot stop its sampler thread; disabling pauses it (no samples are
  taken or held), and the thread itself remains until the process exits.
- Frames from minified OpenCode chunks name chunk files, not OpenCode source
  files.
