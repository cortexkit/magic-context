/**
 * Host stall profiler: an off-by-default diagnostic that names the JavaScript
 * blocking OpenCode's main thread during multi-second host stalls.
 *
 * Why it exists: OpenCode runs every plugin in one Bun runtime. When that
 * runtime stops processing for seconds, native stack samples show only the
 * native side (for example a synchronous SQLite step) and never which plugin's
 * JavaScript made the call. JavaScriptCore's sampling profiler samples the
 * main thread from its own thread, so it records stacks *during* the block,
 * while a main-thread timer can only measure the lag afterwards. This module
 * pairs the two: a 250 ms watchdog measures the lag, and when a gap exceeds
 * the threshold it drains the sampler, keeps the samples inside the stall
 * window, attributes each one to the plugin whose code owns it, and writes one
 * JSON report per stall.
 *
 * Control is a file switch, not a config key: the profiler runs only while
 * `<magic-context storage>/host-profiler/enable` exists. The switch is checked
 * every 30 s, so creating or deleting the file turns the profiler on or off
 * without restarting OpenCode. With the file absent the only work is one
 * `existsSync` per 30 s: `bun:jsc` is never imported and no watchdog runs.
 *
 * Every path fails open: a failure is logged once and never reaches a turn.
 * If `bun:jsc` cannot be loaded (not running under Bun), the profiler
 * disables itself for the rest of the process.
 */

import { chmodSync, existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import * as path from "node:path";
import { getMagicContextStorageDir } from "../shared/data-path";
import { log } from "../shared/logger";
import {
    ensureStorageDirectorySync,
    writeStorageFileAtomicSync,
} from "../shared/storage-permissions";
import { aggregateTraces, type JscSampleTrace } from "./host-stall-profiler-report";

export const HOST_PROFILER_DIRNAME = "host-profiler";
export const HOST_PROFILER_ENABLE_FILENAME = "enable";
export const SWITCH_POLL_MS = 30_000;
export const WATCHDOG_INTERVAL_MS = 250;
export const DEFAULT_STALL_THRESHOLD_MS = 3_000;
/**
 * 10 ms (100 Hz) keeps a 6 s stall at ~600 samples, plenty to rank stacks,
 * while costing far less than JavaScriptCore's 1 ms default; the overhead
 * measurement in docs/reports/host-stall-profiler.md compares the two.
 */
export const DEFAULT_SAMPLE_INTERVAL_MS = 10;
export const MAX_REPORT_FILES = 50;
/** Samples aggregated per stall; a longer stall is thinned evenly to this many. */
export const MAX_SAMPLES_PER_WINDOW = 20_000;
/** Refresh the "heap before" snapshot every fourth tick (about once a second). */
const MEMORY_SNAPSHOT_EVERY_TICKS = 4;
/**
 * Busy-wait chunks used once per enable to relate sample timestamps to
 * `performance.now()`: at most 30 x 3 ms, usually one or two chunks.
 */
const CALIBRATION_CHUNK_MS = 3;
const CALIBRATION_MAX_CHUNKS = 30;

/** The subset of `bun:jsc` the profiler uses. */
export interface JscProfilerApi {
    startSamplingProfiler(directory?: string): void;
    samplingProfilerStackTraces(): unknown;
    /**
     * Runs a callback under the sampler at the given interval (microseconds)
     * and leaves the sampler PAUSED afterwards. `bun:jsc` exposes no stop or
     * interval setter, so this is how the profiler sets its sampling interval
     * and how it stops sampling when the switch is turned off.
     */
    profile(callback: () => unknown, sampleIntervalMicros?: number): unknown;
    heapSize?(): number;
    memoryUsage?(): unknown;
    percentAvailableMemoryInUse?(): number | null;
}

export interface HostStallProfilerDeps {
    /** Directory holding the enable file and the reports. */
    profilerDir(): string;
    loadJsc(): Promise<unknown>;
    /** Monotonic milliseconds, `performance.now()` in production. */
    now(): number;
    /** Wall-clock epoch milliseconds, for report timestamps. */
    wallNow(): number;
    setInterval(callback: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
    rss(): number;
    log(message: string): void;
    pid: number;
    bunVersion: string | null;
}

export interface HostStallProfilerOptions {
    thresholdMs: number;
    sampleIntervalMs: number;
}

export interface HostStallProfilerHandle {
    /** Start polling the enable file (and check it once immediately). */
    start(): void;
    /** Re-read the enable file now instead of waiting for the next poll. */
    checkNow(): Promise<void>;
    /** Stop polling and turn the profiler off. */
    stop(): void;
    isActive(): boolean;
    /** True once `bun:jsc` failed to load; the profiler then stays off. */
    isUnavailable(): boolean;
}

interface MemorySnapshot {
    at: string;
    heap_size_bytes: number | null;
    jsc_memory: unknown;
    rss_bytes: number | null;
    percent_available_memory_in_use: number | null;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

/**
 * Options from the enable file. An empty file means defaults; otherwise it is
 * JSON such as `{"threshold_ms": 5000, "sample_interval_ms": 10}`.
 */
export function parseEnableFile(content: string): {
    options: HostStallProfilerOptions;
    error: string | null;
} {
    const options: HostStallProfilerOptions = {
        thresholdMs: DEFAULT_STALL_THRESHOLD_MS,
        sampleIntervalMs: DEFAULT_SAMPLE_INTERVAL_MS,
    };
    const trimmed = content.trim();
    if (trimmed === "") return { options, error: null };
    try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            return { options, error: "enable file is not a JSON object" };
        }
        if (typeof parsed.threshold_ms === "number" && Number.isFinite(parsed.threshold_ms)) {
            options.thresholdMs = clamp(parsed.threshold_ms, 500, 600_000);
        }
        if (
            typeof parsed.sample_interval_ms === "number" &&
            Number.isFinite(parsed.sample_interval_ms)
        ) {
            options.sampleIntervalMs = clamp(parsed.sample_interval_ms, 1, 100);
        }
        return { options, error: null };
    } catch (error) {
        return {
            options,
            error: `enable file is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
        };
    }
}

function asJscApi(module: unknown): JscProfilerApi | null {
    const candidate = (module as { default?: unknown } | null) ?? null;
    for (const value of [candidate, candidate?.default]) {
        const api = value as Partial<JscProfilerApi> | null | undefined;
        if (
            api &&
            typeof api.startSamplingProfiler === "function" &&
            typeof api.samplingProfilerStackTraces === "function" &&
            typeof api.profile === "function"
        ) {
            return api as JscProfilerApi;
        }
    }
    return null;
}

/** Evenly thin a sample list to at most `limit` entries, keeping its time spread. */
function thin<T>(items: T[], limit: number): T[] {
    if (items.length <= limit) return items;
    const stride = items.length / limit;
    const out: T[] = [];
    for (let i = 0; i < limit; i++) out.push(items[Math.floor(i * stride)]);
    return out;
}

function reportFileStamp(epochMs: number): string {
    // Colons are not valid in Windows file names; the result still sorts by time.
    return new Date(epochMs).toISOString().replaceAll(":", "-");
}

export function createHostStallProfiler(deps: HostStallProfilerDeps): HostStallProfilerHandle {
    let jsc: JscProfilerApi | null = null;
    let unavailable = false;
    let pollTimer: unknown = null;
    let watchdog: unknown = null;
    let options: HostStallProfilerOptions = {
        thresholdMs: DEFAULT_STALL_THRESHOLD_MS,
        sampleIntervalMs: DEFAULT_SAMPLE_INTERVAL_MS,
    };
    let lastTickAt = 0;
    let tickCount = 0;
    let memoryBefore: MemorySnapshot | null = null;
    /** JSC sample timestamp (ms) minus `deps.now()` for the same instant; null when unknown. */
    let clockOffsetMs: number | null = null;
    let checking: Promise<void> | null = null;
    const loggedOnce = new Set<string>();

    const safeLog = (message: string): void => {
        try {
            deps.log(message);
        } catch {
            // Logging must never take the profiler, or a turn, down with it.
        }
    };
    const logOnce = (key: string, message: string, error?: unknown): void => {
        if (loggedOnce.has(key)) return;
        loggedOnce.add(key);
        const detail =
            error === undefined
                ? ""
                : `: ${error instanceof Error ? error.message : String(error)}`;
        safeLog(`[magic-context] host stall profiler: ${message}${detail}`);
    };

    const drain = (api: JscProfilerApi): JscSampleTrace[] => {
        const raw = api.samplingProfilerStackTraces() as { traces?: unknown } | null;
        return Array.isArray(raw?.traces) ? (raw.traces as JscSampleTrace[]) : [];
    };

    /** Pause the sampler (see `JscProfilerApi.profile`), discarding what it held. */
    const pauseSampler = (api: JscProfilerApi, intervalMs: number): void => {
        // Drain first so `profile` has little to process. Before the sampler
        // has ever run, `samplingProfilerStackTraces` throws ("never
        // started"); `profile` itself creates the sampler, so that is benign.
        try {
            drain(api);
        } catch {
            // Nothing buffered yet.
        }
        api.profile(() => undefined, Math.round(intervalMs * 1000));
        drain(api);
    };

    /**
     * Relate JSC's sample clock to `deps.now()`. Sample timestamps come from
     * JavaScriptCore's monotonic clock, whose origin differs from
     * `performance.now()`. Short busy-waits at a 1 ms interval bracket a
     * handful of samples between two known `now()` readings; the midpoint of
     * the feasible offsets is accurate to a few milliseconds, far below any
     * stall threshold. A restarted sampler thread can take one old interval
     * to wake, so the busy-wait repeats in short chunks until a chunk yields
     * samples, bounded by `CALIBRATION_MAX_CHUNKS`.
     */
    const calibrate = (api: JscProfilerApi): number | null => {
        pauseSampler(api, 1);
        api.startSamplingProfiler();
        let offset: number | null = null;
        for (let chunk = 0; chunk < CALIBRATION_MAX_CHUNKS && offset === null; chunk++) {
            const start = deps.now();
            let end = start;
            for (let i = 0; i < 50_000_000 && end - start < CALIBRATION_CHUNK_MS; i++) {
                end = deps.now();
            }
            const stamps = drain(api)
                .map((trace) => trace.timestamp)
                .filter(
                    (value): value is number => typeof value === "number" && Number.isFinite(value),
                )
                .map((seconds) => seconds * 1000);
            if (stamps.length >= 2) {
                offset = (Math.max(...stamps) - end + (Math.min(...stamps) - start)) / 2;
            }
        }
        pauseSampler(api, 1);
        return offset;
    };

    const snapshot = (api: JscProfilerApi): MemorySnapshot => {
        const read = <T>(fn: () => T): T | null => {
            try {
                return fn();
            } catch {
                return null;
            }
        };
        return {
            at: new Date(deps.wallNow()).toISOString(),
            heap_size_bytes: read(() => api.heapSize?.() ?? null),
            jsc_memory: read(() => api.memoryUsage?.() ?? null),
            rss_bytes: read(() => deps.rss()),
            percent_available_memory_in_use: read(
                () => api.percentAvailableMemoryInUse?.() ?? null,
            ),
        };
    };

    const writeReport = (report: unknown, endWallMs: number): string => {
        const dir = deps.profilerDir();
        // Reports are always owner-only, whatever the storage permission policy says.
        ensureStorageDirectorySync(dir, true);
        chmodSync(dir, 0o700);
        const stamp = reportFileStamp(endWallMs);
        let name = `stall-${stamp}.json`;
        for (let n = 1; existsSync(path.join(dir, name)); n++) name = `stall-${stamp}-${n}.json`;
        const finalPath = path.join(dir, name);
        writeStorageFileAtomicSync(finalPath, `${JSON.stringify(report, null, 2)}\n`, true);
        const reports = readdirSync(dir)
            .filter((entry) => /^stall-.*\.json$/.test(entry))
            .sort();
        for (const stale of reports.slice(0, Math.max(0, reports.length - MAX_REPORT_FILES))) {
            try {
                unlinkSync(path.join(dir, stale));
            } catch (error) {
                logOnce("prune", "could not prune an old report", error);
            }
        }
        return finalPath;
    };

    const recordStall = (
        api: JscProfilerApi,
        startMs: number,
        endMs: number,
        traces: JscSampleTrace[],
    ): void => {
        const after = snapshot(api);
        const gapMs = endMs - startMs;
        let windowed = traces;
        let windowFilter = "since-last-collection";
        if (clockOffsetMs !== null) {
            const slackMs = 2 * options.sampleIntervalMs + 20;
            const lo = startMs + clockOffsetMs - slackMs;
            const hi = endMs + clockOffsetMs + slackMs;
            const inWindow = traces.filter((trace) => {
                const at =
                    typeof trace.timestamp === "number" ? trace.timestamp * 1000 : Number.NaN;
                return at >= lo && at <= hi;
            });
            if (inWindow.length > 0 || traces.length === 0) {
                windowed = inWindow;
                windowFilter = "timestamp";
            } else {
                // A calibration that no longer matches (for example after the
                // machine slept) must not silently empty the report.
                windowFilter = "since-last-collection (timestamp filter matched no sample)";
            }
        }
        const kept = thin(windowed, MAX_SAMPLES_PER_WINDOW);
        const aggregate = aggregateTraces(kept);
        const endWallMs = deps.wallNow();
        const startWallMs = endWallMs - gapMs;
        const report = {
            kind: "magic-context-host-stall",
            schema_version: 1,
            pid: deps.pid,
            bun_version: deps.bunVersion,
            platform: process.platform,
            window: {
                start: new Date(startWallMs).toISOString(),
                end: new Date(endWallMs).toISOString(),
                duration_ms: Math.round(gapMs),
                lag_ms: Math.round(gapMs - WATCHDOG_INTERVAL_MS),
                threshold_ms: options.thresholdMs,
            },
            sampling: {
                interval_ms: options.sampleIntervalMs,
                samples_collected: traces.length,
                samples_in_window: windowed.length,
                samples_aggregated: kept.length,
                window_filter: windowFilter,
                note:
                    aggregate.samples === 0
                        ? "No JavaScript samples in the window: the main thread was not executing inside the JavaScript VM (idle wait, process suspension, or native work outside any JS call)."
                        : undefined,
            },
            memory: { before: memoryBefore, after },
            owners: aggregate.owners,
            top_frames: aggregate.top_frames,
            top_js_frames: aggregate.top_js_frames,
            top_stacks: aggregate.top_stacks,
        };
        const file = writeReport(report, endWallMs);
        const top = aggregate.owners[0];
        safeLog(
            `[magic-context] host stall profiler: ${Math.round(gapMs)}ms main-thread stall, ${aggregate.samples} samples, top owner ${top ? `${top.owner} (${top.percent}%)` : "none"} → ${file}`,
        );
        memoryBefore = after;
    };

    const tick = (): void => {
        const api = jsc;
        if (!api || watchdog === null) return;
        try {
            const now = deps.now();
            const startMs = lastTickAt;
            lastTickAt = now;
            const traces = drain(api);
            if (now - startMs > options.thresholdMs) {
                try {
                    recordStall(api, startMs, now, traces);
                } catch (error) {
                    logOnce("report", "could not write a stall report", error);
                }
            }
            tickCount += 1;
            if (tickCount % MEMORY_SNAPSHOT_EVERY_TICKS === 0) memoryBefore = snapshot(api);
        } catch (error) {
            logOnce("tick", "watchdog tick failed", error);
        }
    };

    const enable = (api: JscProfilerApi, next: HostStallProfilerOptions): void => {
        const startedAt = deps.now();
        try {
            options = next;
            clockOffsetMs = calibrate(api);
            pauseSampler(api, options.sampleIntervalMs);
            api.startSamplingProfiler();
            lastTickAt = deps.now();
            tickCount = 0;
            memoryBefore = snapshot(api);
            watchdog = deps.setInterval(tick, WATCHDOG_INTERVAL_MS);
            safeLog(
                `[magic-context] host stall profiler enabled: threshold ${options.thresholdMs}ms, sample interval ${options.sampleIntervalMs}ms, clock calibration ${clockOffsetMs === null ? "unavailable" : "ok"}, setup ${Math.round(deps.now() - startedAt)}ms, reports in ${deps.profilerDir()}`,
            );
        } catch (error) {
            watchdog = null;
            try {
                pauseSampler(api, options.sampleIntervalMs);
            } catch {
                // Already failing open; the enable error below is the one worth logging.
            }
            logOnce("enable", "could not start", error);
        }
    };

    const disable = (reason: string): void => {
        if (watchdog !== null) deps.clearInterval(watchdog);
        watchdog = null;
        memoryBefore = null;
        if (jsc) {
            try {
                pauseSampler(jsc, options.sampleIntervalMs);
            } catch (error) {
                logOnce("disable", "could not pause the sampler", error);
            }
        }
        safeLog(`[magic-context] host stall profiler disabled: ${reason}`);
    };

    const ensureJsc = async (): Promise<JscProfilerApi | null> => {
        if (jsc) return jsc;
        try {
            const api = asJscApi(await deps.loadJsc());
            if (!api) throw new Error("bun:jsc lacks the sampling profiler API");
            jsc = api;
            return api;
        } catch (error) {
            unavailable = true;
            if (pollTimer !== null) deps.clearInterval(pollTimer);
            pollTimer = null;
            logOnce("jsc", "bun:jsc is unavailable, profiler disabled for this process", error);
            return null;
        }
    };

    const runCheck = async (): Promise<void> => {
        if (unavailable) return;
        try {
            const enablePath = path.join(deps.profilerDir(), HOST_PROFILER_ENABLE_FILENAME);
            if (!existsSync(enablePath)) {
                if (watchdog !== null) disable("enable file removed");
                return;
            }
            const parsed = parseEnableFile(readFileSync(enablePath, "utf8"));
            if (parsed.error) logOnce(`options:${parsed.error}`, parsed.error);
            if (watchdog !== null) {
                if (jsc && parsed.options.sampleIntervalMs !== options.sampleIntervalMs) {
                    pauseSampler(jsc, parsed.options.sampleIntervalMs);
                    jsc.startSamplingProfiler();
                }
                options = parsed.options;
                return;
            }
            const api = await ensureJsc();
            if (!api || watchdog !== null || !existsSync(enablePath)) return;
            enable(api, parsed.options);
        } catch (error) {
            logOnce("check", "enable-file check failed", error);
        }
    };

    const checkNow = (): Promise<void> => {
        if (!checking) {
            checking = runCheck().finally(() => {
                checking = null;
            });
        }
        return checking;
    };

    return {
        start() {
            if (pollTimer !== null || unavailable) return;
            pollTimer = deps.setInterval(() => void checkNow(), SWITCH_POLL_MS);
            void checkNow();
        },
        checkNow,
        stop() {
            if (pollTimer !== null) deps.clearInterval(pollTimer);
            pollTimer = null;
            if (watchdog !== null) disable("stopped");
        },
        isActive: () => watchdog !== null,
        isUnavailable: () => unavailable,
    };
}

export function hostStallProfilerDir(): string {
    return path.join(getMagicContextStorageDir(), HOST_PROFILER_DIRNAME);
}

function defaultDeps(): HostStallProfilerDeps {
    return {
        profilerDir: hostStallProfilerDir,
        loadJsc: () => import("bun:jsc"),
        now: () => performance.now(),
        wallNow: () => Date.now(),
        setInterval: (callback, ms) => {
            const handle = setInterval(callback, ms);
            // Diagnostics must never keep the host process alive.
            (handle as { unref?: () => void }).unref?.();
            return handle;
        },
        clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
        rss: () => process.memoryUsage.rss(),
        log,
        pid: process.pid,
        bunVersion: process.versions.bun ?? null,
    };
}

/**
 * One profiler per process: OpenCode Desktop runs one plugin instance per
 * project in the same runtime, and the sampler and the event loop being
 * watched are process-wide. Keyed on a global symbol so two copies of this
 * module (a stale and a fresh build) still share one profiler.
 */
const PROCESS_PROFILER_KEY = Symbol.for("cortexkit.magic-context.host-stall-profiler");

export function startHostStallProfilerSwitch(): void {
    try {
        const holder = globalThis as unknown as Record<symbol, HostStallProfilerHandle | undefined>;
        if (holder[PROCESS_PROFILER_KEY]) return;
        const handle = createHostStallProfiler(defaultDeps());
        holder[PROCESS_PROFILER_KEY] = handle;
        handle.start();
    } catch (error) {
        log("[magic-context] host stall profiler: could not start the enable-file switch", error);
    }
}
