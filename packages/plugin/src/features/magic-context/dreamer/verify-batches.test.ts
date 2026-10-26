import { afterEach, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "../../../shared/sqlite";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import { insertMemory } from "../memory";
import {
    getMemoryVerifications,
    recordMemoryVerifications,
} from "../memory/storage-memory-verifications";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { acquireLease } from "./lease";
import { createDreamTokenBudget, DreamTokenBudgetExceeded } from "./token-budget";
import {
    runVerify,
    VERIFY_BATCH_SIZE,
    VERIFY_IN_FLIGHT_GRACE_MS,
    VERIFY_RUN_SLICE_MS,
    VERIFY_TOKENS_PER_MEMORY,
    verifyBatchTokenBudget,
} from "./verify";
import { parsePartialVerifyManifest, seedVerifyCandidates } from "./verify-prompt";

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(count: number) {
    const directory = createTestTempDirFromPath(path.join(tmpdir(), "mc-verify-batches-"));
    dirs.push(directory);
    mkdirSync(path.join(directory, "src"));
    writeFileSync(path.join(directory, "src/fact.ts"), "export const currentFact = 1;\n");
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    const ids = Array.from(
        { length: count },
        (_, i) =>
            insertMemory(db, {
                projectPath: "git:batch-fixture",
                category: "ARCHITECTURE",
                content: `currentFact backs fact ${i}`,
            }).id,
    );
    for (const id of ids) recordMemoryVerifications(db, id, ["src/fact.ts"], 1_000);
    expect(acquireLease(db, "holder", "batch-test")).toBe(true);
    return {
        db,
        directory,
        ids,
        args: {
            db,
            projectIdentity: "git:batch-fixture",
            sessionDirectory: directory,
            holderId: "holder",
            leaseKey: "batch-test",
            deadline: Date.now() + 900_000,
            forceBroad: true,
        },
    };
}

function message(text: string, input = 0) {
    return {
        info: {
            role: "assistant",
            finish: "stop",
            tokens: { input },
            time: { created: Date.now() },
        },
        parts: [{ type: "text", text }],
    };
}

function toolOnlyHistory(whitespace = false) {
    return Array.from({ length: 8 }, (_, index) => ({
        info: { role: "assistant", id: `tool-${index}`, finish: "tool-calls" },
        parts: [
            { type: "tool", state: { status: "completed" } },
            ...(whitespace ? [{ type: "text", text: " \n\t " }] : []),
        ],
    }));
}

test("verify allocates at most 100k prompt tokens per input including a short batch", () => {
    expect(VERIFY_BATCH_SIZE).toBe(10);
    expect(VERIFY_TOKENS_PER_MEMORY).toBe(100_000);
    expect(verifyBatchTokenBudget(10, 2_500_000)).toBe(1_000_000);
    expect(verifyBatchTokenBudget(1)).toBe(100_000);
    expect(verifyBatchTokenBudget(10, 40_000)).toBe(40_000);
    const guard = createDreamTokenBudget(verifyBatchTokenBudget(1));
    expect(guard.charge(80_000, 0, 0)).toBe("finalize");
    expect(guard.charge(20_000, 0, 0)).toBe("stop");
});

test("verify recovers only closed non-conflicting expected verdicts", () => {
    expect(
        parsePartialVerifyManifest('<verify><verified id="1"/><update id="2">cut', new Set([1, 2])),
    ).toMatchObject({ verified: [{ id: 1 }], updated: [] });
    expect(
        parsePartialVerifyManifest(
            '<verify><verified id="1"/><archive id="1"/><verified id="9"/>',
            new Set([1]),
        ),
    ).toMatchObject({ verified: [], archived: [] });
});

test("verify candidate lookup leaves backing mappings intact outside git", async () => {
    const f = fixture(1);
    try {
        const memories = [
            {
                id: 1,
                category: "ARCHITECTURE",
                content: "currentFact",
                mappedFiles: ["src/fact.ts"],
            },
        ];
        expect((await seedVerifyCandidates(memories, f.directory))[0].mappedFiles).toEqual([
            "src/fact.ts",
        ]);
    } finally {
        f.db.close();
    }
});

test("verify prefilters identifier candidates asynchronously without replacing backing mappings", async () => {
    const f = fixture(1);
    try {
        execFileSync("git", ["init", "--quiet"], { cwd: f.directory, windowsHide: true });
        execFileSync("git", ["add", "src/fact.ts"], { cwd: f.directory, windowsHide: true });
        const [memory] = await seedVerifyCandidates(
            [
                {
                    id: 1,
                    category: "ARCHITECTURE",
                    content: "currentFact is one",
                    mappedFiles: ["src/old.ts"],
                },
            ],
            f.directory,
        );
        expect(memory.candidates).toEqual(["src/fact.ts"]);
        expect(memory.mappedFiles).toEqual(["src/old.ts"]);
    } finally {
        f.db.close();
    }
});

test("fake provider emits ten-memory progress and banks an interrupted verdict at the wall slice", async () => {
    const f = fixture(12);
    const sizes: number[] = [];
    const budgets: number[] = [];
    const progress: number[] = [];
    let text = "";
    let child = 0;
    let calls = 0;
    const realTimeout = globalThis.setTimeout;
    let sliceFiredAt = 0;
    // Speed up the real wall timer without replacing the retry or abort machinery.
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
        fn: TimerHandler,
        ms?: number,
        ...args: unknown[]
    ) =>
        realTimeout(
            ms && ms >= 30_000
                ? (...values: unknown[]) => {
                      sliceFiredAt ||= Date.now();
                      (fn as (...a: unknown[]) => void)(...values);
                  }
                : fn,
            ms && ms >= 30_000 ? 120 : ms,
            ...args,
        )) as typeof setTimeout);
    try {
        const result = await runVerify({
            ...f.args,
            onProgress: (n) => progress.push(n),
            fallbackModels: ["fixture/fallback"],
            hiddenCompletionExecutor: {
                capabilities: { tools: true },
                open: async (spec) => {
                    budgets.push(spec.metadata?.tokenBudget as number);
                    return { id: `child-${++child}` };
                },
                attempt: async (_handle, request) => {
                    calls++;
                    const ids = [
                        ...(request.body.parts?.[0] as { text: string }).text.matchAll(
                            /^\[(\d+)\]/gm,
                        ),
                    ].map((m) => Number(m[1]));
                    sizes.push(ids.length);
                    text = `<verify>${ids
                        .slice(0, child === 1 ? 10 : 1)
                        .map((id) => `<verified id="${id}" files="src/fact.ts"/>`)
                        .join("")}${child === 1 ? "</verify>" : ""}`;
                    if (child > 1) await new Promise(() => {});
                },
                collect: async () => ({
                    text,
                    messages: [message(text)],
                    usage: { input: 10, output: 10 },
                }),
                close: async () => {},
            } as never,
        });
        expect(sizes).toEqual([10, 2]);
        expect(budgets).toEqual([1_000_000, 200_000]);
        expect(calls).toBe(2);
        expect(progress).toEqual([10, 11]);
        expect(result).toMatchObject({
            verified: 11,
            remaining: 1,
            complete: false,
            stopReason: "batch-timeout",
        });
        const stored = getMemoryVerifications(f.db, f.ids);
        expect([...stored.values()].filter((m) => m.verifiedAt > 1_000)).toHaveLength(11);
        console.log(
            `FAKE VERIFY: batch sizes=${sizes}; progress=${progress}; stop=${result.stopReason}; durable=11; fallback not started; settlement_tail_ms=${Date.now() - sliceFiredAt}`,
        );
    } finally {
        timer.mockRestore();
        f.db.close();
    }
});

/** Fixed provider trace: three 1,000-token code reads per memory, replayed each turn. */
/**
 * Run verify against a fake clock. Each scripted child "takes" its duration by
 * moving Date.now forward, and timers of 30 s or more (the batch slice timers)
 * fire once the fake clock has passed their due time instead of on the wall
 * clock. A duration of Infinity is a runaway child that only stops when its
 * slice timer aborts it.
 */
async function runOnFakeClock(count: number, durations: number[]) {
    const f = fixture(count);
    const realNow = Date.now.bind(Date);
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const start = realNow();
    let offset = 0;
    const fakeTimers = new Map<object, { fire: () => void; dueAt: number; done: boolean }>();
    const opened: number[] = [];
    const abortedAt: number[] = [];
    let text = "";
    // Moves the fake clock and fires every slice timer whose due time is now in
    // the past. Returns true when one fired, meaning the running child was aborted.
    const advance = (ms: number): boolean => {
        offset += ms;
        // Stand in for the lease heartbeat, which runs on the real clock and so
        // never fires while the fake clock jumps ahead.
        expect(acquireLease(f.db, "holder", "batch-test")).toBe(true);
        let fired = false;
        for (const timer of fakeTimers.values()) {
            if (timer.done || timer.dueAt >= start + offset) continue;
            timer.done = true;
            fired = true;
            timer.fire();
        }
        return fired;
    };
    const now = spyOn(Date, "now").mockImplementation(() => start + offset);
    const setTimer = spyOn(globalThis, "setTimeout").mockImplementation(((
        fn: (...values: unknown[]) => void,
        ms?: number,
        ...args: unknown[]
    ) => {
        if (!ms || ms < 30_000) return realSetTimeout(fn, ms, ...args);
        const handle = {
            ref: () => handle,
            unref: () => handle,
            hasRef: () => false,
            refresh: () => handle,
        };
        fakeTimers.set(handle, {
            fire: () => fn(...args),
            dueAt: start + offset + ms,
            done: false,
        });
        return handle;
    }) as unknown as typeof setTimeout);
    const clearTimer = spyOn(globalThis, "clearTimeout").mockImplementation(((handle: unknown) => {
        const fake = fakeTimers.get(handle as object);
        if (fake) fake.done = true;
        else realClearTimeout(handle as never);
    }) as typeof clearTimeout);
    try {
        const result = await runVerify({
            ...f.args,
            deadline: start + 900_000,
            hiddenCompletionExecutor: {
                capabilities: { tools: true },
                open: async () => {
                    opened.push(offset);
                    return { id: `clock-${opened.length}` };
                },
                attempt: async (_handle, request) => {
                    const ids = [
                        ...(request.body.parts?.[0] as { text: string }).text.matchAll(
                            /^\[(\d+)\]/gm,
                        ),
                    ].map((m) => Number(m[1]));
                    const duration = durations[opened.length - 1] ?? 10_000;
                    text = "";
                    let aborted = false;
                    if (duration === Number.POSITIVE_INFINITY) {
                        for (let step = 0; step < 100 && !aborted; step++)
                            aborted = advance(10_000);
                    } else {
                        aborted = advance(duration);
                    }
                    if (aborted) {
                        abortedAt.push(offset);
                        await new Promise(() => {});
                    }
                    text = `<verify>${ids.map((id) => `<verified id="${id}" files="src/fact.ts"/>`).join("")}</verify>`;
                },
                collect: async () => ({
                    text,
                    messages: [message(text)],
                    usage: { input: 10, output: 10 },
                }),
                close: async () => {},
            } as never,
        });
        return { result, opened, abortedAt, db: f.db, ids: f.ids };
    } finally {
        clearTimer.mockRestore();
        setTimer.mockRestore();
        now.mockRestore();
        f.db.close();
    }
}

test("verify lets a batch in flight at the run deadline finish and bank its verdicts", async () => {
    // The second batch starts 200 s into the run and needs 90 s, so it is still
    // running when the 240 s run deadline passes.
    const run = await runOnFakeClock(20, [200_000, 90_000]);
    expect(run.opened).toEqual([0, 200_000]);
    expect(run.abortedAt).toEqual([]);
    expect(run.result).toMatchObject({ verified: 20, remaining: 0, complete: true, batches: 2 });
    expect(run.result.stopReason).toBeUndefined();
});

test("verify does not start a batch once the run deadline has passed", async () => {
    // The second batch ends exactly at the run deadline; plenty of in-flight
    // grace remains, but that grace is only for batches already running.
    const run = await runOnFakeClock(25, [120_000, VERIFY_RUN_SLICE_MS - 120_000]);
    expect(run.opened).toEqual([0, 120_000]);
    expect(run.result).toMatchObject({
        verified: 20,
        remaining: 5,
        complete: false,
        batches: 2,
        stopReason: "deadline",
    });
});

test("verify still aborts a runaway batch at the hard stop after the run deadline", async () => {
    const run = await runOnFakeClock(20, [200_000, Number.POSITIVE_INFINITY]);
    const hardStop = VERIFY_RUN_SLICE_MS + VERIFY_IN_FLIGHT_GRACE_MS;
    expect(run.opened).toEqual([0, 200_000]);
    // The runaway child moves the clock in 10 s steps, so the slice timer fires
    // on the first step past the hard stop.
    expect(run.abortedAt).toHaveLength(1);
    expect(run.abortedAt[0]).toBeLessThanOrEqual(hardStop + 10_000);
    expect(run.result).toMatchObject({
        verified: 10,
        remaining: 10,
        complete: false,
        stopReason: "batch-timeout",
    });
});

function replayCost(batchSize: number, count: number) {
    let tokens = 0;
    for (let start = 0; start < count; start += batchSize) {
        let context = 2_000;
        for (let memory = start; memory < Math.min(count, start + batchSize); memory++) {
            for (let read = 0; read < 3; read++) {
                tokens += context;
                context += 1_000;
            }
        }
        tokens += context;
    }
    return tokens;
}

test("fixed replay fixture compares provider-reported tokens per verified memory", async () => {
    const f = fixture(20);
    let text = "";
    let spent = 0;
    const sizes: number[] = [];
    try {
        const result = await runVerify({
            ...f.args,
            hiddenCompletionExecutor: {
                capabilities: { tools: true },
                open: async () => ({ id: `fixture-${sizes.length}` }),
                attempt: async (_h, request) => {
                    const ids = [
                        ...(request.body.parts?.[0] as { text: string }).text.matchAll(
                            /^\[(\d+)\]/gm,
                        ),
                    ].map((m) => Number(m[1]));
                    sizes.push(ids.length);
                    spent += replayCost(ids.length, ids.length);
                    text = `<verify>${ids.map((id) => `<verified id="${id}" files="src/fact.ts"/>`).join("")}</verify>`;
                },
                collect: async () => ({
                    text,
                    messages: [message(text, spent)],
                    usage: { input: spent, output: 0 },
                }),
                close: async () => {},
            } as never,
        });
        const before = replayCost(20, 20);
        expect(sizes).toEqual([10, 10]);
        expect(result.verified).toBe(20);
        expect(before).toBe(1_952_000);
        expect(spent).toBe(1_054_000);
        console.log(
            `FIXED TRACE: before=${before / 20} tokens/verified memory; after=${spent / result.verified}; verified=20/20 (synthetic usage, not live quota)`,
        );
    } finally {
        f.db.close();
    }
});

test("verify shares the run token ceiling across batches and records each child's spend", async () => {
    const f = fixture(60);
    const budgets: number[] = [];
    const updates: Array<{ sessionId?: string; spent: number }> = [];
    let text = "";
    let update: (s: { spent: number; finalizeFired: boolean; sessionId: string }) => void;
    try {
        const result = await runVerify({
            ...f.args,
            onBudgetUpdate: (s) => updates.push(s),
            hiddenCompletionExecutor: {
                capabilities: { tools: true },
                open: async (spec) => {
                    budgets.push(spec.metadata.tokenBudget);
                    update = spec.metadata.onBudgetUpdate;
                    return { id: `budget-${budgets.length}` };
                },
                attempt: async (_h, request) => {
                    const ids = [...request.body.parts[0].text.matchAll(/^\[(\d+)\]/gm)].map((m) =>
                        Number(m[1]),
                    );
                    text = `<verify>${ids.map((id) => `<verified id="${id}" files="src/fact.ts"/>`).join("")}</verify>`;
                    update({
                        spent: 500_000,
                        finalizeFired: false,
                        sessionId: `budget-${budgets.length}`,
                    });
                },
                collect: async () => ({
                    text,
                    messages: [message(text, 500_000)],
                    usage: { input: 500_000, output: 10 },
                }),
                close: async () => {},
            } as never,
        });
        expect(budgets).toEqual([1_000_000, 1_000_000, 1_000_000, 1_000_000, 500_000]);
        expect(result).toMatchObject({ verified: 50, remaining: 10, stopReason: "token-budget" });
        expect(new Set(updates.map((s) => s.sessionId)).size).toBe(5);
        console.log(
            "FAKE RUN CAP: five 500000-token spends = 2500000 prompt tokens; no sixth batch; 50 durable verdicts",
        );
    } finally {
        f.db.close();
    }
});

test("a failing fake provider exhausts one 500k envelope without retrying and banks its verdict", async () => {
    const f = fixture(20);
    let guard: ReturnType<typeof createDreamTokenBudget>;
    let update: (state: { spent: number; finalizeFired: boolean; sessionId: string }) => void;
    let calls = 0;
    let text = "";
    try {
        const result = await runVerify({
            ...f.args,
            tokenBudget: 500_000,
            fallbackModels: ["fixture/fallback"],
            hiddenCompletionExecutor: {
                capabilities: { tools: true },
                open: async (spec) => {
                    guard = createDreamTokenBudget(spec.metadata.tokenBudget);
                    update = spec.metadata.onBudgetUpdate;
                    return { id: "failing-child" };
                },
                attempt: async (_h, request) => {
                    calls++;
                    const id = request.body.parts[0].text.match(/^\[(\d+)\]/m)[1];
                    text = `<verify><verified id="${id}" files="src/fact.ts"/>`;
                    for (let step = 0; step < 5; step++) {
                        const action = guard.charge(100_000, 0, 0);
                        update({ ...guard.snapshot(), sessionId: "failing-child" });
                        if (action === "stop")
                            throw new DreamTokenBudgetExceeded(
                                "failing-child",
                                guard.snapshot().spent,
                            );
                    }
                },
                collect: async () => ({
                    text,
                    messages: [message(text, guard.snapshot().spent)],
                    usage: { input: guard.snapshot().spent, output: 10 },
                }),
                close: async () => {},
            } as never,
        });
        expect(calls).toBe(1);
        expect(guard!.snapshot().spent).toBe(500_000);
        expect(result).toMatchObject({ verified: 1, remaining: 19, stopReason: "token-budget" });
        console.log(
            "FAKE FAILING CAP: child spent=500000; calls=1; fallback=0; durable=1; stopped cleanly",
        );
    } finally {
        f.db.close();
    }
});

test("verify run slice is shared across batches, not renewed after progress", async () => {
    const f = fixture(25);
    let clock = Date.now();
    const now = spyOn(Date, "now").mockImplementation(() => clock);
    let text = "";
    let children = 0;
    try {
        const result = await runVerify({
            ...f.args,
            onProgress: () => {
                clock += 240_000;
            },
            hiddenCompletionExecutor: {
                capabilities: { tools: true },
                open: async () => ({ id: `slice-${++children}` }),
                attempt: async (_h, request) => {
                    const ids = [...request.body.parts[0].text.matchAll(/^\[(\d+)\]/gm)].map((m) =>
                        Number(m[1]),
                    );
                    text = `<verify>${ids.map((id) => `<verified id="${id}" files="src/fact.ts"/>`).join("")}</verify>`;
                },
                collect: async () => ({
                    text,
                    messages: [message(text)],
                    usage: { input: 10, output: 10 },
                }),
                close: async () => {},
            } as never,
        });
        expect(children).toBe(1);
        expect(result).toMatchObject({ verified: 10, remaining: 15, stopReason: "deadline" });
    } finally {
        now.mockRestore();
        f.db.close();
    }
});

for (const forceBroad of [false, true]) {
    for (const whitespace of [false, true]) {
        test(`${forceBroad ? "verify-broad" : "verify"} hidden host falls back from ${whitespace ? "whitespace-only" : "tool-only"} history to completion text`, async () => {
            const f = fixture(1);
            let attempts = 0;
            const text = `<verify><verified id="${f.ids[0]}" files="src/fact.ts"/></verify>`;
            try {
                const result = await runVerify({
                    ...f.args,
                    forceBroad,
                    hiddenCompletionExecutor: {
                        capabilities: { tools: true },
                        open: async () => ({ id: "separate-text-child" }),
                        attempt: async () => {
                            attempts++;
                        },
                        collect: async () => ({
                            text,
                            messages: toolOnlyHistory(whitespace),
                            usage: { input: 100, output: 10 },
                        }),
                        close: async () => {},
                    } as never,
                });
                expect(result).toMatchObject({ verified: 1, remaining: 0, complete: true });
                expect(attempts).toBe(1);
                expect(
                    getMemoryVerifications(f.db, f.ids).get(f.ids[0])?.verifiedAt,
                ).toBeGreaterThan(1_000);
            } finally {
                f.db.close();
            }
        });
    }
}

test("verify interrupted hidden host recovers completion text behind tool-only history", async () => {
    const f = fixture(2);
    const text = `<verify><verified id="${f.ids[0]}" files="src/fact.ts"/>`;
    try {
        const result = await runVerify({
            ...f.args,
            hiddenCompletionExecutor: {
                capabilities: { tools: true },
                open: async () => ({ id: "interrupted-separate-text" }),
                attempt: async () => {
                    throw new DreamTokenBudgetExceeded("interrupted-separate-text", 200_000);
                },
                collect: async () => ({
                    text,
                    messages: toolOnlyHistory(),
                    usage: { input: 200_000, output: 10 },
                }),
                close: async () => {},
            } as never,
        });
        expect(result).toMatchObject({
            verified: 1,
            remaining: 1,
            complete: false,
            stopReason: "token-budget",
        });
        const stored = getMemoryVerifications(f.db, f.ids);
        expect(stored.get(f.ids[0])?.verifiedAt).toBeGreaterThan(1_000);
        expect(stored.get(f.ids[1])?.verifiedAt).toBe(1_000);
    } finally {
        f.db.close();
    }
});

for (const host of ["hidden", "sdk"] as const) {
    test(`verify ${host} host reports no output when only whitespace remains`, async () => {
        const f = fixture(1);
        const messages = toolOnlyHistory(true);
        const transport =
            host === "hidden"
                ? {
                      hiddenCompletionExecutor: {
                          capabilities: { tools: true },
                          open: async () => ({ id: "empty-hidden" }),
                          attempt: async () => {},
                          collect: async () => ({
                              text: " \n\t ",
                              messages,
                              usage: { input: 10, output: 0 },
                          }),
                          close: async () => {},
                      },
                  }
                : {
                      client: {
                          session: {
                              create: async () => ({ data: { id: "empty-sdk" } }),
                              prompt: async () => ({}),
                              messages: async () => ({ data: messages }),
                              delete: async () => ({}),
                          },
                      },
                  };
        try {
            await expect(
                runVerify({ ...f.args, parentSessionId: "fixture-parent", ...transport } as never),
            ).rejects.toThrow("verify returned no output");
            expect(getMemoryVerifications(f.db, f.ids).get(f.ids[0])?.verifiedAt).toBe(1_000);
        } finally {
            f.db.close();
        }
    });
}

test("fixed navigation fixture measures exact replay bytes for whole reads versus outline and zoom", async () => {
    async function measure(strategy: "whole-file" | "navigation") {
        const f = fixture(20);
        const padding = `${"// unrelated implementation detail".padEnd(54, ".")}\n`;
        const source = `${padding.repeat(65)}export const currentFact = 1;\n${padding.repeat(65)}`;
        writeFileSync(path.join(f.directory, "src/fact.ts"), source);
        const traces: Array<{
            systemBytes: number;
            userBytes: number;
            toolCalls: string[];
            promptBytes: number[];
            promptTokens: number;
        }> = [];
        let system = "";
        let text = "";
        let batchTokens = 0;
        const schemas = ["read", "aft_outline", "aft_zoom"].map((name) => ({
            name,
            description: "Read-only fixture source inspection",
            input: { path: "string", symbol: "string?" },
        }));
        try {
            const result = await runVerify({
                ...f.args,
                hiddenCompletionExecutor: {
                    capabilities: { tools: true },
                    open: async (spec) => {
                        system = spec.system;
                        return { id: `${strategy}-${traces.length}` };
                    },
                    attempt: async (_handle, request) => {
                        const prompt = request.body.parts[0].text;
                        const ids = [...prompt.matchAll(/^\[(\d+)\]/gm)].map((match) =>
                            Number(match[1]),
                        );
                        const messages: Array<Record<string, unknown>> = [
                            { role: "system", content: system },
                            { role: "user", content: prompt },
                        ];
                        const trace = {
                            systemBytes: Buffer.byteLength(system),
                            userBytes: Buffer.byteLength(prompt),
                            toolCalls: [] as string[],
                            promptBytes: [] as number[],
                            promptTokens: 0,
                        };
                        batchTokens = 0;
                        const charge = () => {
                            const wire = JSON.stringify({
                                model: "fixture/navigation",
                                tools: schemas,
                                messages,
                            });
                            const bytes = Buffer.byteLength(wire);
                            trace.promptBytes.push(bytes);
                            // Synthetic accounting only: one token per four UTF-8 bytes, rounded per request.
                            batchTokens += Math.ceil(bytes / 4);
                        };
                        const call = (tool: string, content: string) => {
                            charge();
                            const id = `call-${trace.toolCalls.length}`;
                            trace.toolCalls.push(tool);
                            messages.push({
                                role: "assistant",
                                tool_calls: [
                                    {
                                        id,
                                        name: tool,
                                        arguments: { path: "src/fact.ts", symbol: "currentFact" },
                                    },
                                ],
                            });
                            messages.push({ role: "tool", tool_call_id: id, content });
                        };
                        const contents = readFileSync(
                            path.join(f.directory, "src/fact.ts"),
                            "utf8",
                        );
                        const lines = contents.split("\n");
                        const line = lines.findIndex((value) =>
                            value.startsWith("export const currentFact"),
                        );
                        if (strategy === "whole-file") call("read", contents);
                        else {
                            call(
                                "aft_outline",
                                `src/fact.ts: currentFact [variable] line ${line + 1}`,
                            );
                            call("aft_zoom", `${line + 1}: ${lines[line]}`);
                            expect(lines[line]).toBe("export const currentFact = 1;");
                        }
                        charge();
                        trace.promptTokens = batchTokens;
                        traces.push(trace);
                        text = `<verify>${ids.map((id) => `<verified id="${id}" files="src/fact.ts"/>`).join("")}</verify>`;
                    },
                    collect: async () => ({
                        text,
                        messages: [message(text, batchTokens)],
                        usage: { input: batchTokens, output: 10 },
                    }),
                    close: async () => {},
                } as never,
            });
            expect(result).toMatchObject({ verified: 20, complete: true, batches: 2 });
            return {
                traces,
                sourceBytes: Buffer.byteLength(source),
                totalBytes: traces.reduce(
                    (sum, trace) => sum + trace.promptBytes.reduce((a, b) => a + b, 0),
                    0,
                ),
                tokens: traces.reduce((sum, trace) => sum + trace.promptTokens, 0),
                verified: result.verified,
            };
        } finally {
            f.db.close();
        }
    }
    const whole = await measure("whole-file");
    const navigation = await measure("navigation");
    expect(whole.traces.map((trace) => trace.toolCalls)).toEqual(
        Array.from({ length: 2 }, () => ["read"]),
    );
    expect(navigation.traces.map((trace) => trace.toolCalls)).toEqual(
        Array.from({ length: 2 }, () => ["aft_outline", "aft_zoom"]),
    );
    expect(navigation.traces.map((trace) => [trace.systemBytes, trace.userBytes])).toEqual(
        whole.traces.map((trace) => [trace.systemBytes, trace.userBytes]),
    );
    expect(whole.totalBytes).toBe(36_666);
    expect(navigation.totalBytes).toBe(33_871);
    expect(whole.tokens).toBe(9_168);
    expect(navigation.tokens).toBe(8_470);
    expect(whole.traces.map((trace) => trace.systemBytes)).toEqual([3_448, 3_448]);
    expect(whole.traces.map((trace) => trace.userBytes)).toEqual([1_398, 1_417]);
    expect(navigation.tokens).toBeLessThan(whole.tokens);
    console.log(
        `NAVIGATION FIXTURE: ${JSON.stringify({ whole, navigation, tokensPerVerdict: { whole: whole.tokens / whole.verified, navigation: navigation.tokens / navigation.verified } })}`,
    );
});
