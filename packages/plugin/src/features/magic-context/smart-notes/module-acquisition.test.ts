import { afterEach, expect, test } from "bun:test";
import type { SmartNoteCapabilityApi } from "./capabilities";
import {
    __sandboxRunnerTest,
    getQuickJsNativeMemoryStats,
    runCompiledSmartNoteCheck,
} from "./sandbox-runner";

const capabilities: SmartNoteCapabilityApi = {
    readFile: async () => "ready",
    gitHeadSha: async () => null,
    gitTag: async () => null,
    gitLog: async () => [],
    httpGet: async () => ({ status: 200, body: "ok" }),
};
const check = 'function check(cap) { return { met: cap.readFile("ready.txt") === "ready" }; }';

afterEach(() => __sandboxRunnerTest.reset());

test("a stalled module load is not run and a later check retries a fresh acquisition", async () => {
    let factories = 0;
    __sandboxRunnerTest.setBeforeModuleLoad(() => new Promise<void>(() => {}), 50);
    const result = await runCompiledSmartNoteCheck({
        compiledCheck: check,
        capabilityFactory: () => {
            factories++;
            return capabilities;
        },
    });
    expect(result).toMatchObject({ ok: false, cancelled: true, network: false });
    if (result.ok || !result.cancelled) throw new Error("expected infrastructure cancellation");
    expect(result.error).toContain("module load timed out; check was not run");
    expect(factories).toBe(0);
    expect(getQuickJsNativeMemoryStats()).toEqual({ loadAttempted: true, loaded: false });

    // Removing the artificial stall must not require a process restart. The
    // failed cached attempt has to be evicted, not replayed to this caller.
    __sandboxRunnerTest.reset();
    expect(await runCompiledSmartNoteCheck({ compiledCheck: check, capabilities })).toEqual({
        ok: true,
        result: { met: true },
    });
    expect(getQuickJsNativeMemoryStats().loaded).toBe(true);
});

test("a late rejected module load cannot evict its successful replacement", async () => {
    let rejectOld!: (error: Error) => void;
    const old = new Promise<void>((_resolve, reject) => {
        rejectOld = reject;
    });
    __sandboxRunnerTest.setBeforeModuleLoad(() => old, 50);
    expect(await runCompiledSmartNoteCheck({ compiledCheck: check, capabilities })).toMatchObject({
        ok: false,
        cancelled: true,
    });

    __sandboxRunnerTest.reset();
    expect(await runCompiledSmartNoteCheck({ compiledCheck: check, capabilities })).toEqual({
        ok: true,
        result: { met: true },
    });
    rejectOld(new Error("late module loader failure"));
    await Promise.resolve();
    await Promise.resolve();
    expect(await runCompiledSmartNoteCheck({ compiledCheck: check, capabilities })).toEqual({
        ok: true,
        result: { met: true },
    });
    expect(getQuickJsNativeMemoryStats().loaded).toBe(true);
});

test("one cancelled caller cannot poison the shared bounded module load for another caller", async () => {
    let loads = 0;
    let factories = 0;
    __sandboxRunnerTest.setBeforeModuleLoad(() => {
        loads++;
        return new Promise<void>(() => {});
    }, 50);
    const controller = new AbortController();
    const options = {
        compiledCheck: check,
        capabilityFactory: () => {
            factories++;
            return capabilities;
        },
    };
    const cancelled = runCompiledSmartNoteCheck({ ...options, signal: controller.signal });
    const waiting = runCompiledSmartNoteCheck(options);
    controller.abort(new Error("lease expired"));
    expect(await cancelled).toMatchObject({ ok: false, cancelled: true, error: "lease expired" });
    expect(await waiting).toMatchObject({ ok: false, cancelled: true, network: false });
    expect(loads).toBe(1);
    expect(factories).toBe(0);
    __sandboxRunnerTest.reset();
    expect(await runCompiledSmartNoteCheck({ compiledCheck: check, capabilities })).toEqual({
        ok: true,
        result: { met: true },
    });
});
