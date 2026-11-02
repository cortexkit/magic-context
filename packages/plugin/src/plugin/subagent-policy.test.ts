import { afterEach, expect, test } from "bun:test";
import { tool } from "@opencode-ai/plugin";
import {
    type ContextDatabase,
    closeDatabase,
    getOrCreateSessionMeta,
    openDatabase,
    updateSessionMeta,
} from "../features/magic-context/storage";
import { createTestTempDir } from "../shared/test-temp-dir";
import {
    effectiveSubagent,
    hidesMemoryTools,
    resetSubagentPolicy,
    setSubagentPolicy,
} from "./subagent-policy";
import {
    hideSubagentTools,
    resolveStoredSubagentMode,
    storedSubagentMode,
    subagentToolRefusal,
} from "./subagent-tool-policy";

let db: ContextDatabase;
let temp: ReturnType<typeof createTestTempDir>;

function openFresh(): void {
    temp = createTestTempDir("mc-subagent-policy-");
    process.env.MAGIC_CONTEXT_STORAGE_DIR = temp.dir;
    db = openDatabase()!;
    updateSessionMeta(db, "child", { isSubagent: true });
    updateSessionMeta(db, "primary", { isSubagent: false });
}

afterEach(() => {
    resetSubagentPolicy();
    closeDatabase();
    delete process.env.MAGIC_CONTEXT_STORAGE_DIR;
    temp.cleanup();
});

const tools = () => ({
    ctx_memory: tool({ description: "m", args: {}, async execute() {} }),
    ctx_note: tool({ description: "n", args: {}, async execute() {} }),
    ctx_search: tool({ description: "s", args: {}, async execute() {} }),
});

test("stock policy keeps children reduced and their memory tools hidden", () => {
    openFresh();
    expect(effectiveSubagent(true)).toBe(true);
    expect(hidesMemoryTools(true)).toBe(true);
    expect(getOrCreateSessionMeta(db, "child").isSubagent).toBe(true);
    const draft = { sessionID: "child", tools: tools() };
    hideSubagentTools(draft, db);
    expect(Object.keys(draft.tools)).toEqual(["ctx_search"]);
});

test("compress presents a child as primary without losing the stored flag", () => {
    openFresh();
    setSubagentPolicy({ compress: true });
    expect(getOrCreateSessionMeta(db, "child").isSubagent).toBe(false);
    expect(getOrCreateSessionMeta(db, "primary").isSubagent).toBe(false);
    // The stored fact is untouched, so the switches stay reversible.
    expect(
        db
            .prepare("SELECT is_subagent AS value FROM session_meta WHERE session_id = ?")
            .get("child"),
    ).toEqual({ value: 1 });
    expect(effectiveSubagent(true)).toBe(false);
});

test("compression alone does not hand a child the memory tools", () => {
    openFresh();
    setSubagentPolicy({ compress: true });
    const draft = { sessionID: "child", tools: tools() };
    hideSubagentTools(draft, db);
    expect(Object.keys(draft.tools)).toEqual(["ctx_search"]);
    expect(subagentToolRefusal(db, "ctx_memory", "child")).toContain("unavailable in subagent");
});

test("memory_write keeps the tools even while compression is off", () => {
    openFresh();
    setSubagentPolicy({ memoryWrite: true });
    const draft = { sessionID: "child", tools: tools() };
    hideSubagentTools(draft, db);
    expect(Object.keys(draft.tools)).toContain("ctx_memory");
    expect(subagentToolRefusal(db, "ctx_memory", "child")).toBeUndefined();
    expect(getOrCreateSessionMeta(db, "child").isSubagent).toBe(true);
});

test("primary sessions are unaffected by every switch", () => {
    openFresh();
    setSubagentPolicy({ compress: true, memoryWrite: false });
    const draft = { sessionID: "primary", tools: tools() };
    hideSubagentTools(draft, db);
    expect(Object.keys(draft.tools)).toHaveLength(3);
    expect(subagentToolRefusal(db, "ctx_note", "primary")).toBeUndefined();
});

test("stored-fact gates ignore compress", () => {
    openFresh();
    setSubagentPolicy({ compress: true, memoryWrite: false });
    // What the session is shown follows the policy; the stored fact does not.
    expect(effectiveSubagent(true)).toBe(false);
    expect(storedSubagentMode(db, "child")).toBe(true);
    expect(resolveStoredSubagentMode(db, "child")).toBe(true);
    expect(resolveStoredSubagentMode(db, "primary")).toBe(false);
});
