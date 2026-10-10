/**
 * Measures the host stall profiler's CPU overhead on synthetic workloads.
 *
 * Each mode runs in a fresh child process (so JIT warm-up and sampler state do
 * not leak between modes) and reports, for the same fixed workloads:
 *   - busy: a synchronous busy loop doing a fixed amount of JavaScript work
 *     (about 3 s with the profiler off): wall time, process CPU time, and
 *     process CPU% (CPU time / wall time; above 100% means another thread,
 *     such as the sampler, burned CPU too)
 *   - idle: process CPU% over 10 s with nothing to do but the timers
 *
 * Usage: bun scripts/host-stall-profiler-overhead.ts
 * Prints one JSON line per mode and a summary table. Writes nothing outside
 * a throwaway temp directory.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
    createHostStallProfiler,
    HOST_PROFILER_ENABLE_FILENAME,
} from "../src/plugin/host-stall-profiler";

type Mode = "off" | "on-10ms" | "on-1ms";
const MODES: Mode[] = ["off", "on-10ms", "on-1ms"];

function work(iterations: number): number {
    let acc = 0;
    for (let i = 0; i < iterations; i++) {
        const items = [i, i + 1, i + 2].map((v) => ({ v, s: `${v}` }));
        acc += items.reduce((sum, item) => sum + item.v + item.s.length, 0);
    }
    return acc;
}

function cpuPercent(fromCpu: NodeJS.CpuUsage, fromWall: number): number {
    const used = process.cpuUsage(fromCpu);
    const wallMs = performance.now() - fromWall;
    return ((used.user + used.system) / 1000 / wallMs) * 100;
}

async function runMode(mode: Mode): Promise<void> {
    const root = mkdtempSync(path.join(tmpdir(), "mc-host-profiler-overhead-"));
    const handle = createHostStallProfiler({
        profilerDir: () => root,
        loadJsc: () => import("bun:jsc"),
        now: () => performance.now(),
        wallNow: () => Date.now(),
        setInterval: (callback, ms) => setInterval(callback, ms),
        clearInterval: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
        rss: () => process.memoryUsage.rss(),
        log: () => {},
        pid: process.pid,
        bunVersion: process.versions.bun ?? null,
    });
    if (mode !== "off") {
        mkdirSync(root, { recursive: true });
        writeFileSync(
            path.join(root, HOST_PROFILER_ENABLE_FILENAME),
            JSON.stringify({
                // High enough that no report is written: this measures steady-state cost.
                threshold_ms: 600_000,
                sample_interval_ms: mode === "on-1ms" ? 1 : 10,
            }),
        );
    }
    handle.start();
    await handle.checkNow();
    if (mode !== "off" && !handle.isActive()) throw new Error("profiler did not start");

    work(200_000); // warm-up
    let cpu = process.cpuUsage();
    let t = performance.now();
    work(60_000_000);
    const busyMs = performance.now() - t;
    const busyCpuMs = (() => {
        const used = process.cpuUsage(cpu);
        return (used.user + used.system) / 1000;
    })();
    const busyCpu = cpuPercent(cpu, t);

    cpu = process.cpuUsage();
    t = performance.now();
    await Bun.sleep(10_000);
    const idleCpu = cpuPercent(cpu, t);

    handle.stop();
    rmSync(root, { recursive: true, force: true });
    console.log(
        JSON.stringify({
            mode,
            bun: process.versions.bun,
            platform: `${process.platform}-${process.arch}`,
            busy_wall_ms: Math.round(busyMs),
            busy_cpu_ms: Math.round(busyCpuMs),
            busy_cpu_percent: Math.round(busyCpu * 10) / 10,
            idle_cpu_percent: Math.round(idleCpu * 100) / 100,
        }),
    );
}

const requested = process.argv[2] as Mode | undefined;
if (requested && MODES.includes(requested)) {
    await runMode(requested);
} else {
    // Interleave modes across rounds so machine-wide noise (other processes)
    // hits every mode alike, then report the per-mode median.
    const rounds = Math.max(1, Number(process.env.OVERHEAD_ROUNDS ?? 3));
    const runs = new Map<Mode, Array<Record<string, number>>>();
    for (let round = 0; round < rounds; round++) {
        for (const mode of MODES) {
            const child = spawnSync(process.execPath, [import.meta.path, mode], {
                encoding: "utf8",
            });
            if (child.status !== 0) throw new Error(`mode ${mode} failed: ${child.stderr}`);
            const line = child.stdout.trim().split("\n").at(-1) ?? "{}";
            console.log(line);
            const list = runs.get(mode) ?? [];
            list.push(JSON.parse(line));
            runs.set(mode, list);
        }
    }
    const median = (values: number[]): number => {
        const sorted = [...values].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)];
    };
    const keys = ["busy_wall_ms", "busy_cpu_ms", "busy_cpu_percent", "idle_cpu_percent"];
    const rows = MODES.map((mode) => {
        const list = runs.get(mode) ?? [];
        const row: Record<string, unknown> = { mode, rounds: list.length };
        for (const key of keys) row[`median_${key}`] = median(list.map((run) => run[key]));
        return row;
    });
    for (const row of rows) console.log(JSON.stringify(row));
    console.table(rows);
}
