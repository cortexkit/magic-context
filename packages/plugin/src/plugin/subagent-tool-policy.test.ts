import { afterEach, beforeEach, expect, test } from "bun:test";
import { tool } from "@opencode-ai/plugin";
import {
    type ContextDatabase,
    closeDatabase,
    openDatabase,
    updateSessionMeta,
} from "../features/magic-context/storage";
import { createTestTempDir } from "../shared/test-temp-dir";
import { registerTools } from "../v2/hooks/tools";
import type { V2Context } from "../v2/hooks/types";
import { resetSubagentPolicy, setSubagentPolicy } from "./subagent-policy";
import {
    guardSubagentTools,
    hideSubagentTools,
    primaryOnlyToolIds,
    subagentToolRefusal,
} from "./subagent-tool-policy";
import { createToolRegistry } from "./tool-registry";
import type { PluginContext } from "./types";

let db: ContextDatabase;
let temp: ReturnType<typeof createTestTempDir>;
const previousStorage = process.env.MAGIC_CONTEXT_STORAGE_DIR;
beforeEach(() => {
    temp = createTestTempDir("mc-subagent-tool-policy-");
    process.env.MAGIC_CONTEXT_STORAGE_DIR = temp.dir;
    db = openDatabase()!;
    updateSessionMeta(db, "child", { isSubagent: true });
    updateSessionMeta(db, "primary", { isSubagent: false });
});
afterEach(() => {
    resetSubagentPolicy();
    closeDatabase();
    if (previousStorage === undefined) delete process.env.MAGIC_CONTEXT_STORAGE_DIR;
    else process.env.MAGIC_CONTEXT_STORAGE_DIR = previousStorage;
    temp.cleanup();
});

const call = (sessionID: string, agent = "build") => ({
    sessionID,
    agent,
    messageID: "message",
    directory: process.cwd(),
    worktree: process.cwd(),
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
});

test("OC1 child permission configuration preserves existing primary-only tools", () => {
    expect(primaryOnlyToolIds(["edit", "ctx_memory"])).toEqual(["edit", "ctx_memory", "ctx_note"]);
});

test("persisted reduced mode refuses both tools independent of agent identity", () => {
    for (const id of ["ctx_memory", "ctx_note"]) {
        expect(subagentToolRefusal(db, id, "child")).toContain(
            `${id} is unavailable in subagent sessions`,
        );
        expect(subagentToolRefusal(db, id, "primary")).toBeUndefined();
    }
    for (const id of ["ctx_search", "ctx_expand", "ctx_reduce", "ctx_memory_list"])
        expect(subagentToolRefusal(db, id, "child")).toBeUndefined();
});

test("OC1 registration refuses child writes before any memory or note side effects", async () => {
    const registry = createToolRegistry({
        ctx: { directory: process.cwd() } as PluginContext,
        pluginConfig: { enabled: true } as Parameters<typeof createToolRegistry>[0]["pluginConfig"],
    });
    for (const agent of ["build", "dreamer", "unknown-worker"]) {
        expect(
            await registry.ctx_memory!.execute(
                { action: "write", category: "PROJECT_RULES", content: "must not persist" },
                call("child", agent),
            ),
        ).toContain("ctx_memory is unavailable");
        expect(
            await registry.ctx_note!.execute(
                { action: "write", content: "must not persist" },
                call("child", agent),
            ),
        ).toContain("ctx_note is unavailable");
    }
    expect(db.prepare("SELECT count(*) AS n FROM memories").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM notes").get()).toEqual({ n: 0 });
});

test("execution guard preserves definition bytes and explicit internal child access", async () => {
    const executed: string[] = [];
    const definition = tool({
        description: "stable definition",
        args: { content: tool.schema.string() },
        async execute(_args, context) {
            executed.push(context.sessionID);
            return "written";
        },
    });
    const original = { ctx_memory: definition, ctx_note: definition, ctx_search: definition };
    const guarded = guardSubagentTools(original, db, (id) => id === "child");
    for (const id of ["ctx_memory", "ctx_note"]) {
        expect(guarded[id]!.description).toBe(definition.description);
        expect(guarded[id]!.args).toBe(definition.args);
        expect(await guarded[id]!.execute({ content: "fact" }, call("child", "dreamer"))).toBe(
            "written",
        );
        expect(await guarded[id]!.execute({ content: "fact" }, call("primary"))).toBe("written");
    }
    expect(executed).toEqual(["child", "primary", "child", "primary"]);
    expect(guarded.ctx_search).toBe(definition);
});

test("OC2 hides only memory and note on a child request without mutating primary definitions", () => {
    const tools = Object.fromEntries(
        ["ctx_memory", "ctx_note", "ctx_expand", "ctx_reduce", "ctx_search"].map((id) => [
            id,
            { description: id },
        ]),
    );
    const bytes = JSON.stringify(tools);
    const childDraft = { sessionID: "child", tools: { ...tools } };
    hideSubagentTools(childDraft, db);
    expect(Object.keys(childDraft.tools)).toEqual(["ctx_expand", "ctx_reduce", "ctx_search"]);
    hideSubagentTools({ sessionID: "primary", tools }, db);
    expect(JSON.stringify(tools)).toBe(bytes);
});

test("OC2 execution refuses forged child calls before entering a module backend", async () => {
    const registered: Array<{
        name: string;
        execute: (args: unknown, call: unknown) => Promise<{ content: string }>;
    }> = [];
    const context = {
        location: { directory: process.cwd() },
        tool: {
            async transform(callback: (editor: unknown) => void) {
                callback({
                    add: (definition: (typeof registered)[number]) => registered.push(definition),
                });
            },
        },
    } as unknown as V2Context;
    const { parsePluginConfig } = await import("../config");
    let backendCalls = 0;
    await registerTools(context, db, parsePluginConfig({ memory: { enabled: true } }), {
        authorityState: async () => "MODULE",
        note: async () => {
            backendCalls++;
            return "written";
        },
        memory: async () => {
            backendCalls++;
            return "written";
        },
    } as unknown as Parameters<typeof registerTools>[3]);
    for (const id of ["ctx_memory", "ctx_note"]) {
        const result = await registered
            .find((t) => t.name === id)!
            .execute(
                { action: "write", category: "PROJECT_RULES", content: "fact" },
                { sessionID: "child", agent: "build" },
            );
        expect(result.content).toContain(`${id} is unavailable`);
    }
    expect(backendCalls).toBe(0);
});

test("primary_tools denies the memory tools only while memory_write is off", () => {
    // OC1's host denies these to task children from its own list, so the list has
    // to follow subagent.memory_write or the switch cannot work there.
    expect(primaryOnlyToolIds().sort()).toEqual(["ctx_memory", "ctx_note"]);
    expect(primaryOnlyToolIds(["selftest_run"]).sort()).toEqual([
        "ctx_memory",
        "ctx_note",
        "selftest_run",
    ]);
    setSubagentPolicy({ compress: false, memoryWrite: true });
    expect(primaryOnlyToolIds()).toEqual([]);
    // A user-supplied entry is not ours to drop.
    expect(primaryOnlyToolIds(["selftest_run"])).toEqual(["selftest_run"]);
});
