import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";

import { createSmartNoteCapabilities, type SmartNoteCapabilityApi } from "./capabilities";
import { runCompiledSmartNoteCheck } from "./sandbox-runner";
import { SmartNoteNetworkError } from "./types";

const fakeCap: SmartNoteCapabilityApi = {
    readFile: async (path) => (path === "ready.txt" ? "ready" : null),
    gitHeadSha: async () => "abc123",
    gitTag: async () => "v1.2.3",
    gitLog: async () => [{ sha: "abc", subject: "initial", authorDate: "2026-01-01T00:00:00Z" }],
    httpGet: async () => ({ status: 200, body: "ok" }),
};

async function withinTestDeadline<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error("sandbox did not settle or release its lock")),
                    800,
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

describe("compiled smart-note QuickJS runner", () => {
    test("runs a check with injected capabilities", async () => {
        const result = await runCompiledSmartNoteCheck({
            compiledCheck: `function check(cap) { return { met: cap.readFile("ready.txt") === "ready" }; }`,
            capabilities: fakeCap,
        });
        expect(result).toEqual({ ok: true, result: { met: true } });
    });

    test("rejects malformed return values", async () => {
        const result = await runCompiledSmartNoteCheck({
            compiledCheck: `function check() { return { reason: "nope" }; }`,
            capabilities: fakeCap,
        });
        expect(result.ok).toBe(false);
    });

    test("interrupts infinite loops as execution failures", async () => {
        const result = await runCompiledSmartNoteCheck({
            compiledCheck: `function check() { while (true) {} }`,
            capabilities: fakeCap,
            timeoutMs: 50,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.cancelled).toBe(false);
    });

    test("returns a typed cancelled result for a pre-aborted run", async () => {
        const controller = new AbortController();
        controller.abort(new Error("sweep deadline"));

        const result = await runCompiledSmartNoteCheck({
            compiledCheck: `function check() { return { met: true }; }`,
            capabilities: fakeCap,
            signal: controller.signal,
        });

        expect(result).toEqual({
            ok: false,
            cancelled: true,
            error: "sweep deadline",
            network: false,
        });
    });

    test("aborts host capabilities on the run timeout and frees the shared lock", async () => {
        await runCompiledSmartNoteCheck({
            compiledCheck: `function check() { return { met: true }; }`,
            capabilities: fakeCap,
        });

        const startedAt = Date.now();
        const timedOut = (await Promise.race([
            runCompiledSmartNoteCheck({
                compiledCheck: `function check(cap) { cap.httpGet("https://example.test/"); return { met: false }; }`,
                capabilityFactory: (signal) => ({
                    ...fakeCap,
                    httpGet: () =>
                        new Promise((_resolve, reject) => {
                            const abort = () =>
                                reject(new SmartNoteNetworkError("SMART_NOTE_NETWORK: aborted"));
                            if (signal.aborted) {
                                abort();
                                return;
                            }
                            signal.addEventListener("abort", abort, { once: true });
                        }),
                }),
                timeoutMs: 100,
            }),
            new Promise<never>((_, reject) =>
                setTimeout(
                    () => reject(new Error("sandbox timeout did not abort the host capability")),
                    1_000,
                ),
            ),
        ])) as Awaited<ReturnType<typeof runCompiledSmartNoteCheck>>;
        const elapsed = Date.now() - startedAt;

        expect(timedOut.ok).toBe(false);
        if (!timedOut.ok) {
            expect(timedOut.network).toBe(true);
        }
        expect(elapsed).toBeGreaterThanOrEqual(50);
        expect(elapsed).toBeLessThan(1_000);

        const followup = (await Promise.race([
            runCompiledSmartNoteCheck({
                compiledCheck: `function check() { return { met: true }; }`,
                capabilities: fakeCap,
            }),
            new Promise<never>((_, reject) =>
                setTimeout(
                    () =>
                        reject(
                            new Error(
                                "follow-up sandbox run stayed blocked behind the timed-out host call",
                            ),
                        ),
                    500,
                ),
            ),
        ])) as Awaited<ReturnType<typeof runCompiledSmartNoteCheck>>;
        expect(followup).toEqual({ ok: true, result: { met: true } });
    });

    test.each([
        "httpGet",
        "readFile",
        "gitHeadSha",
        "gitTag",
        "gitLog",
    ] as const)("settles by its deadline and releases the lock when %s ignores abort forever", async (method) => {
        // Load the shared module before measuring the execution deadline.
        await runCompiledSmartNoteCheck({
            compiledCheck: "function check() { return {met:false}; }",
            capabilities: fakeCap,
        });
        let entered!: () => void;
        const suspended = new Promise<void>((resolve) => {
            entered = resolve;
        });
        let runSignal!: AbortSignal;
        const startedAt = performance.now();
        const owner = runCompiledSmartNoteCheck({
            compiledCheck: `function check(cap) { cap.${method}("https://api.github.com/never"); return {met:true}; }`,
            capabilityFactory: (signal) => {
                runSignal = signal;
                return {
                    ...fakeCap,
                    [method]: () => {
                        entered();
                        // Deliberately ignore the signal: the VM bridge, not
                        // a cooperative transport, must enforce the deadline.
                        return new Promise<never>(() => {});
                    },
                };
            },
            timeoutMs: 100,
        });
        await withinTestDeadline(suspended);
        // Queue while the owner holds the shared asyncify suspension stack.
        const followup = runCompiledSmartNoteCheck({
            compiledCheck:
                'function check(cap) { return {met:cap.readFile("ready.txt") === "ready"}; }',
            capabilities: fakeCap,
        });
        const result = await withinTestDeadline(owner);
        const elapsed = performance.now() - startedAt;
        expect(result).toMatchObject({
            ok: false,
            cancelled: false,
            network: method === "httpGet",
            persistent: false,
        });
        expect(runSignal.aborted).toBe(true);
        expect(elapsed).toBeGreaterThanOrEqual(75);
        expect(elapsed).toBeLessThan(750);
        if (result.ok || result.cancelled) throw new Error("expected deadline failure");
        if (method === "httpGet") {
            expect(result.error).toContain("timed out waiting on HTTP");
            expect(result.retryAt).toBeGreaterThan(Date.now());
        } else {
            expect(result.error).toContain("timed out");
            expect(result.retryAt).toBeUndefined();
        }
        expect(await withinTestDeadline(followup)).toEqual({ ok: true, result: { met: true } });
    });

    test.each([
        "resolve",
        "reject",
    ] as const)("a capability's late %s cannot resume a disposed VM or corrupt the next check", async (settlement) => {
        let settle!: () => void;
        const result = await withinTestDeadline(
            runCompiledSmartNoteCheck({
                compiledCheck:
                    'function check(cap) { cap.httpGet("https://example.test/"); return {met:true}; }',
                capabilities: {
                    ...fakeCap,
                    httpGet: () =>
                        new Promise((resolve, reject) => {
                            settle = () =>
                                settlement === "resolve"
                                    ? resolve({ status: 200, body: "late" })
                                    : reject(new Error("late transport error"));
                        }),
                },
                timeoutMs: 75,
            }),
        );
        expect(result).toMatchObject({ ok: false, cancelled: false, network: true });
        const followup = runCompiledSmartNoteCheck({
            compiledCheck:
                'function check(cap) { return {met:cap.readFile("ready.txt") === "ready"}; }',
            capabilities: {
                ...fakeCap,
                readFile: async () => {
                    // Resolve/reject the old transport while a different VM
                    // is using the same module's asyncify stack.
                    settle();
                    await new Promise((resolve) => setTimeout(resolve, 5));
                    return "ready";
                },
            },
        });
        expect(await withinTestDeadline(followup)).toEqual({ ok: true, result: { met: true } });
    });

    test("rejects a project FIFO without wedging the shared sandbox lock", async () => {
        const dir = await createTestTempDirFromPath(path.join(tmpdir(), "mc-smart-note-fifo-"));
        try {
            const fifo = path.join(dir, "events.fifo");
            const created = spawnSync("mkfifo", [fifo], { windowsHide: true });
            if (created.error || created.status !== 0) return;

            const controller = new AbortController();
            const abortTimer = setTimeout(
                () => controller.abort(new Error("sweep budget exhausted")),
                50,
            );
            const startedAt = Date.now();
            const result = await runCompiledSmartNoteCheck({
                compiledCheck: `function check(cap) { cap.readFile("events.fifo"); cap.httpGet("https://example.test/"); return { met: false }; }`,
                capabilityFactory: (signal) => ({
                    ...createSmartNoteCapabilities({ projectRoot: dir, signal }),
                    httpGet: () =>
                        new Promise((_resolve, reject) => {
                            const abort = () =>
                                reject(new SmartNoteNetworkError("SMART_NOTE_NETWORK: aborted"));
                            if (signal.aborted) abort();
                            else signal.addEventListener("abort", abort, { once: true });
                        }),
                }),
                signal: controller.signal,
                timeoutMs: 500,
            });
            clearTimeout(abortTimer);
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.cancelled).toBe(true);
            expect(Date.now() - startedAt).toBeLessThan(500);

            const followup = await runCompiledSmartNoteCheck({
                compiledCheck: `function check() { return { met: true }; }`,
                capabilities: fakeCap,
            });
            expect(followup).toEqual({ ok: true, result: { met: true } });
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("serializes concurrent checks whose host calls suspend (shared-module asyncify safety)", async () => {
        // Regression for QuickJSUseAfterFree: the asyncify module has ONE
        // suspension stack; before serialization, two checks suspended in host
        // awaits at once corrupted it and resumed against a disposed context.
        // Each check here suspends in an async host call (readFile) that waits a
        // tick, maximizing overlap. With the lock, all must succeed.
        const slowCap: SmartNoteCapabilityApi = {
            ...fakeCap,
            readFile: async (path) => {
                await new Promise((r) => setTimeout(r, 5));
                return path === "ready.txt" ? "ready" : null;
            },
        };
        const check = `function check(cap) { return { met: cap.readFile("ready.txt") === "ready" }; }`;
        const results = await Promise.all(
            Array.from({ length: 8 }, () =>
                runCompiledSmartNoteCheck({ compiledCheck: check, capabilities: slowCap }),
            ),
        );
        for (const result of results) {
            expect(result).toEqual({ ok: true, result: { met: true } });
        }
    });

    test("returns a queued run promptly when its sweep is cancelled", async () => {
        let hostCallStarted!: () => void;
        const hostCallStartedPromise = new Promise<void>((resolve) => {
            hostCallStarted = resolve;
        });
        let releaseOwner!: () => void;
        const owner = runCompiledSmartNoteCheck({
            compiledCheck: `async function check(cap) { await cap.httpGet("https://example.test/"); return { met: false }; }`,
            capabilityFactory: () => ({
                ...fakeCap,
                httpGet: () => {
                    hostCallStarted();
                    return new Promise((resolve) => {
                        releaseOwner = () => resolve({ status: 200, body: "ok" });
                    });
                },
            }),
            timeoutMs: 1_000,
        });
        await hostCallStartedPromise;

        const controller = new AbortController();
        const releaseTimer = setTimeout(releaseOwner, 500);
        const abortTimer = setTimeout(() => controller.abort(new Error("sweep deadline")), 25);
        const startedAt = Date.now();
        const queued = await runCompiledSmartNoteCheck({
            compiledCheck: `function check() { return { met: true }; }`,
            capabilities: fakeCap,
            signal: controller.signal,
        });
        const elapsed = Date.now() - startedAt;
        clearTimeout(abortTimer);
        clearTimeout(releaseTimer);
        releaseOwner();
        await owner;

        expect(queued).toEqual({
            ok: false,
            cancelled: true,
            error: "sweep deadline",
            network: false,
        });
        expect(elapsed).toBeLessThan(250);
    });
});
