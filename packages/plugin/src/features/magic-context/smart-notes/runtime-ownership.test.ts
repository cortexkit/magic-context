import { afterEach, expect, test } from "bun:test";
import type { SmartNoteCapabilityApi } from "./capabilities";
import { __sandboxRunnerTest, runCompiledSmartNoteCheck } from "./sandbox-runner";

const capabilities: SmartNoteCapabilityApi = {
    readFile: async () => "ready",
    gitHeadSha: async () => "abc",
    gitTag: async () => "v1",
    gitLog: async () => [],
    httpGet: async () => ({ status: 200, body: "ok" }),
};
afterEach(() => __sandboxRunnerTest.reset());

test("successful async capabilities release every HostRef, context and runtime", async () => {
    const disposed: Array<{ contextAlive: boolean; runtimeAlive: boolean }> = [];
    __sandboxRunnerTest.setAfterContextDisposal((context) => {
        disposed.push({ contextAlive: context.alive, runtimeAlive: context.runtime.alive });
    });
    expect(
        await runCompiledSmartNoteCheck({
            compiledCheck:
                "function check(cap) { return {met:cap.readFile('ready') === 'ready'}; }",
            capabilities,
        }),
    ).toEqual({ ok: true, result: { met: true } });
    expect(disposed).toEqual([{ contextAlive: false, runtimeAlive: false }]);
});

test("retained guest wrappers cannot keep native HostRefs alive during disposal", async () => {
    const disposed: Array<{ contextAlive: boolean; runtimeAlive: boolean }> = [];
    __sandboxRunnerTest.setAfterContextDisposal((context) => {
        disposed.push({ contextAlive: context.alive, runtimeAlive: context.runtime.alive });
    });
    expect(
        await runCompiledSmartNoteCheck({
            compiledCheck:
                "function check(cap) { globalThis.saved=cap.readFile; Object.prototype.saved=cap.gitTag; return {met:true}; }",
            capabilities,
        }),
    ).toEqual({ ok: true, result: { met: true } });
    expect(disposed).toEqual([{ contextAlive: false, runtimeAlive: false }]);
});

test.each([
    "function check(cap) { cap.gitHeadSha(); cap.gitTag(); cap.gitLog(); cap.httpGet('https://example.test/'); return {met:true}; }",
    "function check(cap) { Promise.resolve().then(() => cap.gitTag()); return {met:true}; }",
])("context and runtime are fully disposed after successful HostRef use: %s", async (compiledCheck) => {
    const disposed: Array<{ contextAlive: boolean; runtimeAlive: boolean }> = [];
    __sandboxRunnerTest.setAfterContextDisposal((context) => {
        disposed.push({ contextAlive: context.alive, runtimeAlive: context.runtime.alive });
    });
    expect(await runCompiledSmartNoteCheck({ compiledCheck, capabilities })).toEqual({
        ok: true,
        result: { met: true },
    });
    expect(disposed).toEqual([{ contextAlive: false, runtimeAlive: false }]);
});

test("an exhausted guest heap cannot prevent HostRef and runtime cleanup", async () => {
    const disposed: Array<{ contextAlive: boolean; runtimeAlive: boolean }> = [];
    __sandboxRunnerTest.setAfterContextDisposal((context) => {
        disposed.push({ contextAlive: context.alive, runtimeAlive: context.runtime.alive });
    });
    const result = await runCompiledSmartNoteCheck({
        compiledCheck:
            "function check(cap) { cap.readFile('ready'); const held=[]; while(true) held.push(new Array(1000).fill('large')); }",
        capabilities,
        heapLimitBytes: 128 * 1024,
        timeoutMs: 200,
    });
    expect(result).toMatchObject({ ok: false, cancelled: false });
    expect(disposed).toEqual([{ contextAlive: false, runtimeAlive: false }]);
});

test.each([
    "function check(cap) { cap.readFile('ready'); throw new Error('guest failure'); }",
    "function check(cap) { cap.readFile('ready'); return {wrong:true}; }",
    "function check(cap) { cap.readFile('ready'); while (true) {} }",
])("context and runtime are fully disposed after failed HostRef use: %s", async (compiledCheck) => {
    const disposed: Array<{ contextAlive: boolean; runtimeAlive: boolean }> = [];
    __sandboxRunnerTest.setAfterContextDisposal((context) => {
        disposed.push({ contextAlive: context.alive, runtimeAlive: context.runtime.alive });
    });
    expect(
        await runCompiledSmartNoteCheck({ compiledCheck, capabilities, timeoutMs: 50 }),
    ).toMatchObject({ ok: false, cancelled: false });
    expect(disposed).toEqual([{ contextAlive: false, runtimeAlive: false }]);
});
