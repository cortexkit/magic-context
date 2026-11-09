import { expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RustPassLine, RustTestHarness } from "./rust-harness";

export const FOLD_CONFIG = {
    execute_threshold_tokens: { default: 20_000 },
    protected_tokens: 4_000,
    cache_ttl: "0",
    compressor: { enabled: false },
};

/** Logged by a Rust pass whose marker move waits for summary discovery. */
export const MARKER_DISCOVERY_DEFERRAL_LOG =
    "rust compaction-marker drain: candidate preparation deferred; pending target retained";

/** How many Rust passes of this session deferred a marker move for discovery. */
export function markerDiscoveryDeferrals(h: RustTestHarness, sessionId: string): number {
    return h
        .diagnosticLog()
        .split("\n")
        .filter(line => line.includes(`[${sessionId}]`) && line.includes(MARKER_DISCOVERY_DEFERRAL_LOG)).length;
}

/** Run /ctx-flush through OpenCode 1's command route, as a user would. */
export async function requestRustCtxFlush(h: RustTestHarness, sessionId: string): Promise<void> {
    const command = await fetch(`${h.opencode.url}/session/${sessionId}/command`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "ctx-flush", arguments: "" }),
    });
    expect(command.status).toBe(204);
}

/**
 * Ask for a rebuild with /ctx-flush and send one prompt, which makes that
 * prompt's Rust pass a cache-busting pass. Returns the pass.
 */
export async function sendAfterCtxFlush(h: RustTestHarness, sessionId: string, prompt: string): Promise<RustPassLine> {
    await requestRustCtxFlush(h, sessionId);
    const before = h.readRustPasses().length;
    await h.sendPrompt(sessionId, prompt);
    return (await h.waitForRustPasses(before + 1)).at(-1)!;
}

/**
 * Drive a marker move that an earlier pass deferred, and return the passes used.
 *
 * The plugin finds the summary rows a marker move must replace on a background
 * worker, and a transform pass never waits for it. When a cache-busting pass
 * needs a move before that discovery is ready, the pass serves its rebuilt
 * history, keeps the marker where it was, records the target as pending and logs
 * MARKER_DISCOVERY_DEFERRAL_LOG. The move then happens on a later cache-busting
 * pass. Discovery results live in the plugin process's memory, so the first
 * busting pass after the plugin starts usually defers: discovery starts on the
 * pass where the module first reports the new boundary, often that same pass.
 *
 * SOFT+ passes never move a marker, so each attempt here asks for a rebuild with
 * /ctx-flush. Discovery of a test-sized session finishes long before the next
 * prompt, so one attempt is the normal case. Another attempt is made only when
 * the previous pass logged that discovery was still not ready; any other reason
 * for the marker staying put fails the test.
 */
export async function driveDeferredMarkerMove(
    h: RustTestHarness,
    sessionId: string,
    moved: () => boolean,
    prompt: string,
    maxAttempts = 3,
): Promise<RustPassLine[]> {
    const passes: RustPassLine[] = [];
    for (let attempt = 1; attempt <= maxAttempts && !moved(); attempt += 1) {
        const deferralsBefore = markerDiscoveryDeferrals(h, sessionId);
        const pass = await sendAfterCtxFlush(h, sessionId, `${prompt} (attempt ${attempt})`);
        passes.push(pass);
        expect(pass.applied).toBe(true);
        expect(pass.servedFrom).toBe("transform");
        expect(pass.raw).toContain("prefix_bust_permitted=true");
        if (!moved()) expect(markerDiscoveryDeferrals(h, sessionId)).toBe(deferralsBefore + 1);
    }
    expect(moved()).toBe(true);
    console.log(`deferred marker moved after ${passes.length} flush pass(es): ${JSON.stringify(passes.map(pass => `${pass.decision}/${pass.reason}`))}`);
    return passes;
}

export function assertHermeticStores(h: RustTestHarness): void {
    const pidFile = JSON.parse(readFileSync(join(h.env.dataDir, "cortexkit", "rust-e2e-pids.json"), "utf8")) as { pids: Array<{ pid: number }> };
    const roots = [h.opencode.pid, ...pidFile.pids.map(row => row.pid)];
    const pids = [...roots];
    const tree = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
    expect(tree.status).toBe(0);
    const rows = tree.stdout.trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
    for (let previous = -1; previous !== pids.length;) {
        previous = pids.length;
        for (const [pid, parent] of rows) if (pids.includes(parent!) && !pids.includes(pid!)) pids.push(pid!);
    }
    const files = spawnSync("timeout", ["20s", "lsof", "-p", pids.join(","), "-Fn"], { encoding: "utf8" });
    const observed = new Set(files.stdout.split("\n").filter(line => /^p\d+$/.test(line)).map(line => Number(line.slice(1))));
    // A short-lived host child can exit between ps and lsof. lsof may return 1
    // even though it inspected all fixture processes that were still running.
    expect(roots.every(pid => observed.has(pid))).toBe(true);
    expect(files.status === 0 || (files.status === 1 && pids.some(pid => !observed.has(pid)))).toBe(true);
    const stores = [...new Set(files.stdout.split("\n").filter(line => /^n.*\.db(?:$|-)/.test(line)).map(line => line.slice(1)))];
    console.log(`lsof pids=${pids.join(",")} fixture=${h.env.dataDir} stores=${JSON.stringify(stores)}`);
    expect(stores.length).toBeGreaterThan(0);
    // Native inference may open its telemetry DB under the fixture HOME, beside
    // data/. All stores must remain inside this same generated throwaway root.
    expect(stores.every(path => path.startsWith(`${dirname(h.env.dataDir)}/`))).toBe(true);
    expect(stores.some(path => path.endsWith("opencode.db"))).toBe(true);
    expect(stores.some(path => path.endsWith("store.db"))).toBe(true);
    console.log(`lsof pids=${pids.join(",")} isolated stores=${JSON.stringify(stores.filter(path => path.endsWith(".db")))}`);
}
