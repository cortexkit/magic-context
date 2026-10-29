import { afterEach, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HiddenCompletionExecutor } from "../../../hooks/magic-context/compartment-runner-types";
import * as logger from "../../../shared/logger";
import { Database } from "../../../shared/sqlite";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import { insertMemory } from "../memory";
import { getMemoryVerifications } from "../memory/storage-memory-verifications";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { ensureProjectState, getProjectState } from "../storage-project-state";
import { acquireLease } from "./lease";
import { type MapMemoriesArgs, mapMemories, selectMapMemoryInputs } from "./map-memories";
import { MAP_MEMORIES_SYSTEM_PROMPT } from "./map-memories-prompt";

const cleanup: Array<() => void> = [];
afterEach(() => {
    for (const close of cleanup.splice(0)) close();
});

function fixture(count: number) {
    const dir = createTestTempDirFromPath(path.join(tmpdir(), "mc-map-budget-"));
    const db = new Database(":memory:");
    cleanup.push(() => {
        db.close();
        rmSync(dir, { recursive: true, force: true });
    });
    initializeDatabase(db);
    runMigrations(db);
    mkdirSync(path.join(dir, "src"));
    const memories = Array.from({ length: count }, (_, i) => {
        writeFileSync(path.join(dir, `src/fact${i}.ts`), `export const Fact${i} = ${i};\n`);
        return insertMemory(db, {
            projectPath: "git:budget",
            category: "ARCHITECTURE",
            content: `Fact${i} is implemented in src/fact${i}.ts.`,
            sourceSessionId: "fixture",
        });
    });
    execFileSync("git", ["init", "-q"], { cwd: dir, windowsHide: true });
    execFileSync("git", ["add", "src"], { cwd: dir, windowsHide: true });
    expect(acquireLease(db, "holder", "lease")).toBe(true);
    const args: MapMemoriesArgs = {
        db,
        projectIdentity: "git:budget",
        sessionDirectory: dir,
        parentSessionId: "parent",
        holderId: "holder",
        leaseKey: "lease",
        deadline: Date.now() + 1_200_000,
    };
    return { args, memories };
}

function driver(args: MapMemoriesArgs, fail = false, investigationCalls?: number) {
    let ids: number[] = [];
    let messages: unknown[] = [];
    const batches: Array<{ steps: number; committed: number; wallMs: number }> = [];
    const client = {
        session: {
            create: async () => ({ data: { id: "scripted-child" } }),
            prompt: async (request: {
                body: { system: string; parts: Array<{ text: string }> };
            }) => {
                const prompt = request.body.parts[0]?.text ?? "";
                ids = [...prompt.matchAll(/^\[(\d+)\]/gm)].map((match) => Number(match[1]));
                // Each read-only investigation consumes three steps, followed by one emission.
                const perMemory =
                    investigationCalls !== undefined
                        ? investigationCalls + 1
                        : request.body.system.includes("at most 3 tool calls")
                          ? 4
                          : 11;
                const completed = Math.min(ids.length, Math.floor(60 / perMemory));
                const steps = Math.min(60, ids.length * perMemory);
                const entries = ids.slice(0, fail ? 1 : completed).map((id) => {
                    const memory = selectMapMemoryInputs(
                        args.db,
                        args.projectIdentity,
                        args.sessionDirectory,
                        true,
                    ).find((m) => m.id === id);
                    return `<memory id="${id}" files="${memory?.candidates[0]}"/>`;
                });
                batches.push({ steps, committed: entries.length, wallMs: steps * 3_000 });
                messages = Array.from({ length: steps }, (_, step) => ({
                    info: { role: "assistant", time: { created: step } },
                    parts:
                        step % perMemory === perMemory - 1 && entries[Math.floor(step / perMemory)]
                            ? [
                                  {
                                      type: "text",
                                      text: `${step === perMemory - 1 ? "<mappings>" : ""}${entries[Math.floor(step / perMemory)]}`,
                                  },
                              ]
                            : [{ type: "tool", tool: "read", state: { status: "completed" } }],
                }));
                if (fail || completed < ids.length)
                    throw new Error("prompt timed out after 240000ms");
                const last = messages[messages.length - 1] as { parts: Array<{ text?: string }> };
                if (last.parts[0]) last.parts[0].text += "</mappings>";
            },
            messages: async () => ({ data: messages }),
            abort: async () => ({}),
            delete: async () => ({}),
        },
    };
    args.client = client as never;
    return { batches };
}

test("scripted forty-memory backfill fits the step budget and banks eight batches", async () => {
    const { args, memories } = fixture(40);
    const epoch = ensureProjectState(args.db, args.projectIdentity).projectMemoryEpoch;
    const durable: number[] = [];
    args.onProgress = () =>
        durable.push(
            getMemoryVerifications(
                args.db,
                memories.map((memory) => memory.id),
            ).size,
        );
    const { batches } = driver(args);
    const logs: string[] = [];
    const log = spyOn(logger, "log").mockImplementation((line) => {
        logs.push(line);
    });
    let result: Awaited<ReturnType<typeof mapMemories>>;
    try {
        result = await mapMemories(args);
    } finally {
        log.mockRestore();
    }
    expect(result).toMatchObject({ mapped: 40, remaining: 0, batches: 8 });
    expect(durable).toEqual([5, 10, 15, 20, 25, 30, 35, 40]);
    expect(getProjectState(args.db, args.projectIdentity)?.projectMemoryEpoch).toBe(epoch);
    expect(
        logs.filter((line) => line.includes("steps=20 committed=5 steps_per_memory=4.00")),
    ).toHaveLength(8);
    expect(batches).toEqual(
        Array.from({ length: 8 }, () => ({ steps: 20, committed: 5, wallMs: 60_000 })),
    );
    expect(batches.reduce((sum, batch) => sum + batch.wallMs, 0) / 2).toBe(240_000);
});

test("five-memory batches also fit the observed ten-call investigation cost", async () => {
    const { args, memories } = fixture(40);
    const { batches } = driver(args, false, 10);
    expect(await mapMemories(args)).toMatchObject({ mapped: 40, remaining: 0, batches: 8 });
    expect(
        getMemoryVerifications(
            args.db,
            memories.map((memory) => memory.id),
        ).size,
    ).toBe(40);
    expect(batches).toEqual(
        Array.from({ length: 8 }, () => ({ steps: 55, committed: 5, wallMs: 165_000 })),
    );
    expect(batches.reduce((sum, batch) => sum + batch.wallMs, 0) / 2).toBe(660_000);
});

test("timeout banks complete memory elements before a truncated tail", async () => {
    const { args, memories } = fixture(2);
    driver(args, true);
    const durable: number[] = [];
    args.onProgress = (processed) => durable.push(processed);
    args.deadline = Date.now() + 300_000;
    const result = await mapMemories(args);
    expect(durable).toEqual([1, 2]);
    expect(result.mapped).toBe(2);
    expect(
        getMemoryVerifications(
            args.db,
            memories.map((m) => m.id),
        ).size,
    ).toBe(2);
});

test("progressing timeouts do not trip the no-progress breaker", async () => {
    const { args } = fixture(15);
    const { batches } = driver(args, true);
    const result = await mapMemories(args);
    expect(batches).toHaveLength(15);
    expect(result.mapped).toBe(15);
    expect(result.stopReason).not.toBe("timeout-circuit-breaker");
});

test("two failed attempts defer unmapped memories across runs", async () => {
    const { args } = fixture(5);
    args.client = {
        session: {
            create: async () => ({ data: { id: "failed-child" } }),
            prompt: async () => {
                throw new Error("MessageAbortedError");
            },
            messages: async () => ({ data: [] }),
            delete: async () => ({}),
        },
    } as never;
    const failed = await mapMemories(args);
    expect(failed.failure).toBeInstanceOf(Error);
    expect((failed.failure as Error).message).toContain("MessageAbortedError");
    expect(failed.failureStage).toBe("prompt");
    await mapMemories(args);
    expect((await mapMemories(args)).deferred).toBe(true);
    expect(
        selectMapMemoryInputs(args.db, args.projectIdentity, args.sessionDirectory),
    ).toHaveLength(0);
    const newer = insertMemory(args.db, {
        projectPath: args.projectIdentity,
        category: "ARCHITECTURE",
        content: "New work",
        sourceSessionId: "fixture",
    });
    expect(
        selectMapMemoryInputs(args.db, args.projectIdentity, args.sessionDirectory).map(
            (m) => m.id,
        ),
    ).toEqual([newer.id]);
    const originalNow = Date.now;
    Date.now = () => originalNow() + 3_600_001;
    try {
        expect(
            selectMapMemoryInputs(args.db, args.projectIdentity, args.sessionDirectory),
        ).toHaveLength(6);
    } finally {
        Date.now = originalNow;
    }
});

test("hidden carrier salvages emitted mappings before closing on abort", async () => {
    const { args, memories } = fixture(2);
    let closed = false;
    args.hiddenCompletionExecutor = {
        capabilities: { tools: true, harness: "pi" },
        open: async () => ({ id: "hidden-map" }),
        attempt: async () => {
            throw new Error("MessageAbortedError");
        },
        collect: async () => {
            expect(closed).toBe(false);
            return {
                text: `<mappings><memory id="${memories[0]?.id}" files="src/fact0.ts"/><memory id="`,
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                lengthCapped: false,
            };
        },
        close: async () => {
            closed = true;
        },
    } satisfies HiddenCompletionExecutor;
    const result = await mapMemories(args);
    expect(result.mapped).toBe(1);
    expect(closed).toBe(true);
});

test("mapping instructions bound exploration and emit progress immediately", () => {
    expect(MAP_MEMORIES_SYSTEM_PROMPT).toContain("at most 3 tool calls");
    expect(MAP_MEMORIES_SYSTEM_PROMPT).toContain("Never read the same file twice");
    expect(MAP_MEMORIES_SYSTEM_PROMPT).toContain("Emit each <memory> element as soon as");
    expect(MAP_MEMORIES_SYSTEM_PROMPT).not.toContain("COMPLETE set");
});

test("identifier prepass seeds source candidates without reading file bodies into the prompt", async () => {
    const { args } = fixture(1);
    const symbolOnly = insertMemory(args.db, {
        projectPath: args.projectIdentity,
        category: "ARCHITECTURE",
        content: "Fact0 implements the numeric feature.",
        sourceSessionId: "fixture",
    });
    let prompt = "";
    args.client = {
        session: {
            create: async () => ({ data: { id: "candidates" } }),
            prompt: async (request: { body: { parts: Array<{ text: string }> } }) => {
                prompt ||= request.body.parts[0]?.text ?? "";
            },
            messages: async () => ({
                data: [
                    {
                        info: { role: "assistant" },
                        parts: [
                            {
                                type: "text",
                                text: `<mappings><memory id="${symbolOnly.id}" files="src/fact0.ts"/></mappings>`,
                            },
                        ],
                    },
                ],
            }),
            delete: async () => ({}),
        },
    } as never;
    await mapMemories(args);
    expect(prompt.split(`[${symbolOnly.id}]`)[1]?.split("\n\n")[0]).toContain(
        "Likely files (candidate paths, confirmed to exist): src/fact0.ts",
    );
    expect(prompt).not.toContain("export const Fact0");
});

test("a completed fallback manifest supersedes earlier invalid roots in the session", async () => {
    const { args, memories } = fixture(1);
    const id = memories[0]?.id;
    args.model = "test/primary";
    args.fallbackModels = ["test/fallback"];
    const messages: unknown[] = [];
    args.client = {
        session: {
            create: async () => ({ data: { id: "retry-roots" } }),
            prompt: async () => {
                messages.push({
                    info: { role: "assistant", time: { created: messages.length } },
                    parts: [
                        {
                            type: "text",
                            text:
                                messages.length === 0
                                    ? `<mappings><memory id="${id}" independent="true"/><memory id="${id}" independent="true"/></mappings>`
                                    : `<mappings><memory id="${id}" files="src/fact0.ts"/></mappings>`,
                        },
                    ],
                });
            },
            messages: async () => ({ data: messages }),
            delete: async () => ({}),
        },
    } as never;
    expect(await mapMemories(args)).toMatchObject({ mapped: 1, independent: 0, remaining: 0 });
});
