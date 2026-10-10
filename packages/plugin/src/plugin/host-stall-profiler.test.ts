import { afterEach, describe, expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { createTestTempDir } from "../shared/test-temp-dir";
import {
    createHostStallProfiler,
    HOST_PROFILER_ENABLE_FILENAME,
    type HostStallProfilerDeps,
    type HostStallProfilerHandle,
    MAX_REPORT_FILES,
    parseEnableFile,
    SWITCH_POLL_MS,
    WATCHDOG_INTERVAL_MS,
} from "./host-stall-profiler";
import {
    aggregateTraces,
    attributeSample,
    type JscSampleFrame,
    sourceOwner,
} from "./host-stall-profiler-report";

const IDLE_STACK: JscSampleFrame[] = [
    { name: "processTicksAndRejections", sourceURL: "/$bunfs/root/opencode", line: 10 },
];
const BUSY_STACK: JscSampleFrame[] = [
    { name: "get", category: "Unknown Executable" },
    {
        name: "deliberateBusyLoop",
        sourceURL: "/home/u/.config/opencode/plugin/stall-injector.ts",
        line: 7,
    },
    { name: "trigger", sourceURL: "/$bunfs/root/opencode", line: 99 },
];

/**
 * A stand-in for `bun:jsc` that behaves like the real sampler: while running
 * it yields one sample per interval of simulated time with whatever stack is
 * current, timestamped on a clock whose origin differs from `now()`.
 */
function createSimulatedHost(root: string) {
    const JSC_CLOCK_OFFSET_MS = 987_654;
    let clock = 1_000;
    let running = false;
    let intervalMs = 1;
    let lastSampleAt = 0;
    let stack: JscSampleFrame[] = IDLE_STACK;
    const extraSamples: Array<{ timestamp: number; frames: JscSampleFrame[] }> = [];
    const intervals = new Map<number, { callback: () => void; ms: number }>();
    let nextHandle = 1;
    const calls = { loadJsc: 0, start: 0, profile: 0, drain: 0 };
    const logs: string[] = [];

    const jsc = {
        startSamplingProfiler() {
            calls.start += 1;
            running = true;
            lastSampleAt = clock;
        },
        samplingProfilerStackTraces() {
            calls.drain += 1;
            const traces: Array<{ timestamp: number; frames: JscSampleFrame[] }> = [
                ...extraSamples.splice(0),
            ];
            if (running) {
                for (let at = lastSampleAt + intervalMs; at <= clock; at += intervalMs) {
                    traces.push({ timestamp: (at + JSC_CLOCK_OFFSET_MS) / 1000, frames: stack });
                }
                lastSampleAt = clock;
            }
            return { interval: intervalMs / 1000, traces, sources: [] };
        },
        profile(callback: () => unknown, micros?: number) {
            calls.profile += 1;
            callback();
            if (typeof micros === "number") intervalMs = micros / 1000;
            running = false;
            return {};
        },
        heapSize: () => 123,
        memoryUsage: () => ({ current: 1 }),
        percentAvailableMemoryInUse: () => null,
    };

    const deps: HostStallProfilerDeps = {
        profilerDir: () => root,
        loadJsc: async () => {
            calls.loadJsc += 1;
            return jsc;
        },
        // Every reading advances the clock a little so the calibration
        // busy-wait terminates, as it does on a real clock.
        now: () => (clock += 0.25),
        wallNow: () => Date.UTC(2026, 9, 9, 12, 0, 0) + clock,
        setInterval: (callback, ms) => {
            const handle = nextHandle++;
            intervals.set(handle, { callback, ms });
            return handle;
        },
        clearInterval: (handle) => {
            intervals.delete(handle as number);
        },
        rss: () => 456,
        log: (message) => logs.push(message),
        pid: 4242,
        bunVersion: "test",
    };

    const fire = (ms: number) => {
        for (const timer of intervals.values()) if (timer.ms === ms) timer.callback();
    };

    return {
        deps,
        jsc,
        calls,
        logs,
        intervals,
        setStack(next: JscSampleFrame[]) {
            stack = next;
        },
        /** Let simulated time pass, then fire the watchdog once (as after a block). */
        advanceAndTick(ms: number) {
            clock += ms;
            fire(WATCHDOG_INTERVAL_MS);
        },
        injectSample(ageMs: number, frames: JscSampleFrame[]) {
            extraSamples.push({ timestamp: (clock - ageMs + JSC_CLOCK_OFFSET_MS) / 1000, frames });
        },
        firePoll() {
            fire(SWITCH_POLL_MS);
        },
        intervalDelays: () => [...intervals.values()].map((timer) => timer.ms),
    };
}

function stallReports(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .filter((name) => /^stall-.*\.json$/.test(name))
        .sort();
}

let handles: HostStallProfilerHandle[] = [];
afterEach(() => {
    for (const handle of handles) handle.stop();
    handles = [];
});

function setup() {
    const { dir } = createTestTempDir("mc-host-stall-profiler-");
    const root = path.join(dir, "host-profiler");
    const host = createSimulatedHost(root);
    const handle = createHostStallProfiler(host.deps);
    handles.push(handle);
    return { root, host, handle, enablePath: path.join(root, HOST_PROFILER_ENABLE_FILENAME) };
}

describe("host stall profiler switch", () => {
    test("nothing runs while the enable file is absent", async () => {
        const { root, host, handle } = setup();
        handle.start();
        await handle.checkNow();
        host.firePoll();
        await handle.checkNow();
        host.advanceAndTick(10_000);

        expect(host.calls).toEqual({ loadJsc: 0, start: 0, profile: 0, drain: 0 });
        // Only the 30 s enable-file poll exists: no watchdog was ever created.
        expect(host.intervalDelays()).toEqual([SWITCH_POLL_MS]);
        expect(handle.isActive()).toBe(false);
        // Not even the profiler directory is created.
        expect(existsSync(root)).toBe(false);
        expect(host.logs).toEqual([]);
    });

    test("starts when the file appears, reports the stalled caller, stops when it is removed", async () => {
        const { root, host, handle, enablePath } = setup();
        handle.start();
        await handle.checkNow();
        expect(handle.isActive()).toBe(false);

        mkdirSync(root, { recursive: true });
        writeFileSync(enablePath, "");
        host.firePoll();
        await handle.checkNow();
        expect(handle.isActive()).toBe(true);
        expect(host.calls.loadJsc).toBe(1);
        expect(host.intervalDelays().sort((a, b) => a - b)).toEqual([
            WATCHDOG_INTERVAL_MS,
            SWITCH_POLL_MS,
        ]);

        // Normal ticks never produce a report.
        host.advanceAndTick(WATCHDOG_INTERVAL_MS);
        host.advanceAndTick(WATCHDOG_INTERVAL_MS);
        expect(stallReports(root)).toEqual([]);

        // A sample from well before the stall must be excluded by timestamp.
        host.injectSample(60_000, IDLE_STACK);
        host.setStack(BUSY_STACK);
        host.advanceAndTick(6_000);
        host.setStack(IDLE_STACK);

        const reports = stallReports(root);
        expect(reports).toHaveLength(1);
        const file = path.join(root, reports[0]);
        expect(statSync(file).mode & 0o777).toBe(0o600);
        expect(statSync(root).mode & 0o777).toBe(0o700);
        const report = JSON.parse(readFileSync(file, "utf8"));
        expect(report.window.duration_ms).toBeGreaterThanOrEqual(6_000);
        expect(report.sampling.window_filter).toBe("timestamp");
        expect(report.sampling.samples_collected).toBe(report.sampling.samples_in_window + 1);
        expect(report.sampling.samples_in_window).toBeGreaterThan(500);
        expect(report.owners[0].owner).toBe("plugin:stall-injector.ts");
        expect(report.owners[0].percent).toBe(100);
        expect(report.top_frames[0].frame).toBe("get [native]");
        expect(report.top_js_frames[0].frame).toContain("deliberateBusyLoop");
        expect(report.top_stacks[0].frames[1]).toContain("stall-injector.ts:7");
        expect(report.memory.before.rss_bytes).toBe(456);
        expect(report.memory.after.heap_size_bytes).toBe(123);

        rmSync(enablePath);
        host.firePoll();
        await handle.checkNow();
        expect(handle.isActive()).toBe(false);
        expect(host.intervalDelays()).toEqual([SWITCH_POLL_MS]);
        // The sampler was paused, so it no longer accumulates samples.
        host.setStack(BUSY_STACK);
        host.advanceAndTick(5_000);
        expect(host.jsc.samplingProfilerStackTraces().traces).toEqual([]);
        expect(stallReports(root)).toHaveLength(1);
    });

    test("honors threshold_ms from the enable file", async () => {
        const { root, host, handle, enablePath } = setup();
        mkdirSync(root, { recursive: true });
        writeFileSync(enablePath, JSON.stringify({ threshold_ms: 8_000 }));
        handle.start();
        await handle.checkNow();
        host.advanceAndTick(6_000);
        expect(stallReports(root)).toEqual([]);
        host.advanceAndTick(9_000);
        expect(stallReports(root)).toHaveLength(1);
    });

    test("keeps only the newest report files", async () => {
        const { root, host, handle, enablePath } = setup();
        mkdirSync(root, { recursive: true });
        for (let i = 0; i < MAX_REPORT_FILES + 5; i++) {
            writeFileSync(
                path.join(root, `stall-2000-01-01T00-00-${String(i).padStart(2, "0")}.json`),
                "{}",
            );
        }
        writeFileSync(enablePath, "");
        handle.start();
        await handle.checkNow();
        host.advanceAndTick(4_000);
        const reports = stallReports(root);
        expect(reports).toHaveLength(MAX_REPORT_FILES);
        expect(reports[0]).toBe("stall-2000-01-01T00-00-06.json");
        expect(reports.at(-1)).toStartWith("stall-2026-");
    });

    test("disables itself and logs once when bun:jsc cannot load", async () => {
        const { root, host, enablePath } = setup();
        let loads = 0;
        const handle = createHostStallProfiler({
            ...host.deps,
            loadJsc: async () => {
                loads += 1;
                throw new Error("Cannot find module 'bun:jsc'");
            },
        });
        handles.push(handle);
        mkdirSync(root, { recursive: true });
        writeFileSync(enablePath, "");
        handle.start();
        await handle.checkNow();
        await handle.checkNow();
        expect(handle.isUnavailable()).toBe(true);
        expect(handle.isActive()).toBe(false);
        expect(loads).toBe(1);
        expect(host.intervals.size).toBe(0);
        expect(host.logs).toHaveLength(1);
        expect(host.logs[0]).toContain("bun:jsc is unavailable");
    });

    test("a failing sampler fails open and logs once", async () => {
        const { root, host, handle, enablePath } = setup();
        mkdirSync(root, { recursive: true });
        writeFileSync(enablePath, "");
        handle.start();
        await handle.checkNow();
        host.jsc.samplingProfilerStackTraces = () => {
            throw new Error("sampler exploded");
        };
        expect(() => host.advanceAndTick(5_000)).not.toThrow();
        expect(() => host.advanceAndTick(5_000)).not.toThrow();
        expect(host.logs.filter((line) => line.includes("sampler exploded"))).toHaveLength(1);
    });
});

describe("enable file options", () => {
    test("empty file means defaults, JSON overrides are clamped, bad JSON is reported", () => {
        expect(parseEnableFile("").options).toEqual({ thresholdMs: 3_000, sampleIntervalMs: 10 });
        expect(parseEnableFile('{"threshold_ms": 5000}').options.thresholdMs).toBe(5_000);
        expect(parseEnableFile('{"threshold_ms": 1}').options.thresholdMs).toBe(500);
        expect(parseEnableFile('{"sample_interval_ms": 1000}').options.sampleIntervalMs).toBe(100);
        const bad = parseEnableFile("{nope");
        expect(bad.error).toContain("not valid JSON");
        expect(bad.options.thresholdMs).toBe(3_000);
    });
});

describe("frame ownership", () => {
    test("maps source URLs to the code that owns them", () => {
        expect(sourceOwner(undefined)).toBe("native");
        expect(sourceOwner("node:fs")).toBe("runtime");
        expect(sourceOwner("/$bunfs/root/opencode")).toBe("opencode");
        expect(sourceOwner("B:/~BUN/root/opencode.exe")).toBe("opencode");
        expect(
            sourceOwner("/home/u/.cache/opencode/node_modules/@scope/plugin-a/dist/index.js"),
        ).toBe("npm:@scope/plugin-a");
        expect(sourceOwner("/x/node_modules/outer/node_modules/inner/lib.js")).toBe("npm:inner");
        expect(sourceOwner("file:///home/u/.config/opencode/plugins/my%20plugin.ts")).toBe(
            "plugin:my plugin.ts",
        );
        expect(sourceOwner("/repo/project/.opencode/plugin/local.js")).toBe("plugin:local.js");
        expect(sourceOwner(path.join(import.meta.dir, "host-stall-profiler.ts"))).toBe(
            "pkg:@cortexkit/opencode-magic-context",
        );
    });

    test("blames the innermost plugin frame, not native or host frames", () => {
        expect(
            attributeSample([
                { label: "get [native]", owner: "native" },
                { label: "query", owner: "npm:plugin-b" },
                { label: "hook", owner: "opencode" },
            ]),
        ).toBe("npm:plugin-b");
        expect(
            attributeSample([
                { label: "x [native]", owner: "native" },
                { label: "loop", owner: "opencode" },
            ]),
        ).toBe("opencode");
        expect(attributeSample([{ label: "x [native]", owner: "native" }])).toBe("native");
    });

    test("ranks stacks and frames by sample count", () => {
        const aggregate = aggregateTraces([
            { frames: BUSY_STACK },
            { frames: BUSY_STACK },
            { frames: IDLE_STACK },
            { frames: [] },
        ]);
        expect(aggregate.samples).toBe(3);
        expect(aggregate.owners).toEqual([
            { owner: "plugin:stall-injector.ts", samples: 2, percent: 66.7 },
            { owner: "opencode", samples: 1, percent: 33.3 },
        ]);
        expect(aggregate.top_stacks[0].samples).toBe(2);
        expect(aggregate.top_stacks[0].frames).toHaveLength(3);
    });
});

/** Named so the real-sampler test can find it in the report. */
function deliberateHostStallBusyLoop(ms: number): number {
    const end = performance.now() + ms;
    let x = 0;
    while (performance.now() < end) x += Math.sqrt(x + 1);
    return x;
}

describe("host stall profiler on the real bun:jsc sampler", () => {
    test("names the function that blocked the event loop", async () => {
        const { dir } = createTestTempDir("mc-host-stall-profiler-real-");
        const root = path.join(dir, "host-profiler");
        mkdirSync(root, { recursive: true });
        writeFileSync(path.join(root, HOST_PROFILER_ENABLE_FILENAME), '{"threshold_ms": 500}');
        const logs: string[] = [];
        const handle = createHostStallProfiler({
            profilerDir: () => root,
            loadJsc: () => import("bun:jsc"),
            now: () => performance.now(),
            wallNow: () => Date.now(),
            setInterval: (callback, ms) => setInterval(callback, ms),
            clearInterval: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
            rss: () => process.memoryUsage.rss(),
            log: (message) => logs.push(message),
            pid: process.pid,
            bunVersion: process.versions.bun ?? null,
        });
        handles.push(handle);
        handle.start();
        await handle.checkNow();
        expect(handle.isActive()).toBe(true);
        await Bun.sleep(WATCHDOG_INTERVAL_MS * 2);

        deliberateHostStallBusyLoop(1_200);
        await Bun.sleep(WATCHDOG_INTERVAL_MS * 2);
        handle.stop();

        const reports = stallReports(root);
        expect(reports.length).toBeGreaterThanOrEqual(1);
        const report = JSON.parse(readFileSync(path.join(root, reports.at(-1) as string), "utf8"));
        expect(report.window.duration_ms).toBeGreaterThanOrEqual(1_000);
        expect(report.sampling.samples_aggregated).toBeGreaterThan(20);
        expect(report.top_js_frames[0].frame).toContain("deliberateHostStallBusyLoop");
        expect(report.owners[0].owner).toBe("pkg:@cortexkit/opencode-magic-context");
    });
});
