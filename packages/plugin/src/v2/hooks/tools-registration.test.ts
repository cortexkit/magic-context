/// <reference types="bun-types" />

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePluginConfig } from "../../config";
import {
    __resetProjectIdentityForTests,
    __setProjectIdentityTestHooks,
    resolveProjectIdentityForSession,
} from "../../features/magic-context/memory/project-identity";
import { rememberPinnedProjectIdentity } from "../../features/magic-context/memory/project-identity-cache";
import { __resetSessionIdentityDecisionsForTests } from "../../features/magic-context/memory/session-identity-decision";
import {
    getMemoriesByProject,
    insertMemory,
} from "../../features/magic-context/memory/storage-memory";
import {
    getRecordedSessionProjectIdentity,
    recordSessionProjectIdentity,
} from "../../features/magic-context/session-project-storage";
import {
    type ContextDatabase,
    closeDatabase,
    openDatabase,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import * as autoEmbed from "../../hooks/magic-context/auto-embed-session";
import { createTransform } from "../../hooks/magic-context/transform";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import {
    SESSION_ID,
    seedTypeScriptTagHistory,
    TS_TAG_TEXT,
} from "../../tools/ctx-expand/tag-history.test-support";
import { registerTools } from "./tools";
import { createV2AutoEmbedSession } from "./transform-features";
import type { V2Context } from "./types";

let dir: string;
let db: ContextDatabase;
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const cleanups: (() => void)[] = [];

beforeEach(() => {
    dir = createTestTempDirFromPath(join(tmpdir(), "mc-v2-tool-registration-"));
    process.env.XDG_DATA_HOME = dir;
    mkdirSync(join(dir, "cortexkit", "magic-context"), { recursive: true });
    const opened = openDatabase();
    if (!opened) throw new Error("test database unavailable");
    db = opened;
});

afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    __resetSessionIdentityDecisionsForTests();
    __resetProjectIdentityForTests();
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
});

interface RegisteredTool {
    name: string;
    execute: (input: unknown, call: Record<string, unknown>) => Promise<{ content: string }>;
}

/** Stands in for the host's tool editor: `add` populates the map the host would keep. */
function hostContext(registered: RegisteredTool[]): V2Context {
    return {
        location: { directory: dir },
        tool: {
            async transform(callback: (editor: { add: (tool: RegisteredTool) => void }) => void) {
                callback({ add: (tool) => registered.push(tool) });
            },
        },
    } as unknown as V2Context;
}

test("the registered ctx_note tool reads the host store", async () => {
    const registered: RegisteredTool[] = [];
    await registerTools(
        hostContext(registered),
        db,
        parsePluginConfig({ memory: { enabled: true } }),
    );
    const note = registered.find((tool) => tool.name === "ctx_note");
    expect(note).toBeDefined();
    const result = await note!.execute(
        { action: "read" },
        { sessionID: "ses-1", messageID: "msg-1", agent: "build", progress: () => {} },
    );
    expect(typeof result.content).toBe("string");
});

test("registered v2 memory tools and injection use the recorded pj decision after caching git", async () => {
    mkdirSync(join(dir, ".git"));
    __setProjectIdentityTestHooks({ execFileSync: (() => "b".repeat(40)) as never });
    const fallback = resolveProjectIdentityForSession(dir)!;
    expect(fallback).toStartWith("git:");
    const sessionID = "v2-recorded-project";
    const projectPath = "pj-v2-registered";
    recordSessionProjectIdentity(db, sessionID, projectPath);
    const existing = insertMemory(db, {
        projectPath,
        category: "USER_DIRECTIVES",
        content: "v2 registered directive",
    });
    const registered: RegisteredTool[] = [];
    await registerTools(
        hostContext(registered),
        db,
        parsePluginConfig({}),
        undefined,
        async () => {},
    );
    const memory = registered.find((tool) => tool.name === "ctx_memory")!;
    const call = { sessionID, messageID: "msg-1", agent: "build", progress: () => {} };
    expect((await memory.execute({ action: "get", ids: [existing.id] }, call)).content).toContain(
        existing.content,
    );
    expect(
        (
            await memory.execute(
                { action: "write", category: "USER_DIRECTIVES", content: "v2 saved directive" },
                call,
            )
        ).content,
    ).toContain("Saved memory");
    expect(getMemoriesByProject(db, fallback)).toHaveLength(0);
    expect(getMemoriesByProject(db, projectPath).map((memory) => memory.content)).toContain(
        "v2 saved directive",
    );
    const output = {
        messages: [
            {
                info: { id: "msg-1", role: "user", sessionID },
                parts: [{ type: "text", text: "continue" }],
            },
        ],
    };
    await createTransform({
        db,
        tagger: createTagger(),
        scheduler: { shouldExecute: () => "defer" as const },
        contextUsageMap: new Map(),
        historyRefreshSessions: new Set<string>(),
        pendingMaterializationSessions: new Set<string>(),
        lastHeuristicsTurnId: new Map<string, string>(),
        clearReasoningAge: 50,
        protectedTokens: 0,
        historianRunnable: false,
        directory: dir,
        sessionDirectoryBySession: new Map([[sessionID, dir]]),
        memoryConfig: { enabled: true, injectionBudgetTokens: 500, autoPromote: false },
    })({}, output);
    expect(JSON.stringify(output.messages)).toContain("v2 saved directive");
    expect(JSON.stringify(output.messages)).toContain(existing.content);
});

test("v2 tools and auto-embedding follow the served owner through a held move and stale row", async () => {
    const a = join(dir, "owner-a"),
        b = join(dir, "owner-b");
    mkdirSync(a);
    mkdirSync(b);
    rememberPinnedProjectIdentity(a, "pj-V2-OWNER-A");
    rememberPinnedProjectIdentity(b, "pj-V2-OWNER-B");
    const sessionID = "v2-served-owner";
    const alpha = insertMemory(db, {
        projectPath: "pj-V2-OWNER-A",
        category: "USER_DIRECTIVES",
        content: "v2 served alpha directive",
    });
    const beta = insertMemory(db, {
        projectPath: "pj-V2-OWNER-B",
        category: "USER_DIRECTIVES",
        content: "v2 pending beta directive",
    });
    const model = { providerID: "anthropic", modelID: "claude-sonnet-5-5" };
    const scheduled = spyOn(autoEmbed, "maybeAutoEmbedSessionBackfill").mockImplementation(
        () => {},
    );
    cleanups.push(() => scheduled.mockRestore());
    const deps = {
        db,
        tagger: createTagger(),
        scheduler: { shouldExecute: () => "defer" as const },
        contextUsageMap: new Map(),
        historyRefreshSessions: new Set<string>(),
        pendingMaterializationSessions: new Set<string>(),
        lastHeuristicsTurnId: new Map<string, string>(),
        clearReasoningAge: 50,
        protectedTokens: 0,
        historianRunnable: false,
        maybeAutoEmbedSession: createV2AutoEmbedSession(
            { db, resolveDirectory: () => b, recompProgressBySession: new Map() },
            async () => {},
        ),
        directory: a,
        client: {
            session: {
                get: async () => {
                    throw new Error("host unavailable");
                },
            },
        } as never,
        sessionDirectoryBySession: new Map<string, string>(),
        liveModelBySession: new Map([[sessionID, model]]),
        memoryConfig: { enabled: true, injectionBudgetTokens: 500, autoPromote: false },
    };
    const user = {
        info: { id: "owner-user", role: "user", sessionID },
        parts: [{ type: "text", text: "continue" }],
    };
    const first = { messages: [structuredClone(user)] };
    const transform = createTransform(deps);
    await transform({}, first);
    expect(getRecordedSessionProjectIdentity(db, sessionID)).toBeUndefined();
    const head = JSON.stringify(first.messages.slice(0, 2));
    const registered: RegisteredTool[] = [];
    await registerTools(
        hostContext(registered),
        db,
        parsePluginConfig({}),
        undefined,
        async () => {},
        async () => b,
    );
    const memory = registered.find((tool) => tool.name === "ctx_memory")!;
    const call = { sessionID, messageID: "owner-user", agent: "build", progress: () => {} };
    expect(
        (
            await memory.execute(
                { action: "write", category: "USER_DIRECTIVES", content: "v2 held write" },
                call,
            )
        ).content,
    ).toContain("Saved memory");
    expect(getMemoriesByProject(db, "pj-V2-OWNER-A").map((row) => row.content)).toContain(
        "v2 held write",
    );
    const raw = [
        user,
        {
            info: {
                id: "owner-thinking",
                role: "assistant",
                sessionID,
                ...model,
                tokens: { input: 0, output: 1600, reasoning: 1600 },
            },
            parts: [
                { type: "reasoning", text: "signed thought" },
                {
                    type: "tool",
                    tool: "read",
                    callID: "owner-call",
                    state: { status: "completed", output: "contents" },
                },
            ],
        },
    ];
    deps.sessionDirectoryBySession.set(sessionID, b);
    deps.contextUsageMap.set(sessionID, {
        usage: { percentage: 66, inputTokens: 66000 },
        updatedAt: Date.now(),
        hasUsageTokens: true,
    });
    const held = { messages: structuredClone(raw) };
    await transform({}, held);
    expect(JSON.stringify(held.messages.slice(0, 2))).toBe(head);
    expect(scheduled.mock.calls.at(-1)?.[0].projectIdentity).toBe("pj-V2-OWNER-A");
    recordSessionProjectIdentity(db, sessionID, "pj-V2-OWNER-B");
    __resetSessionIdentityDecisionsForTests();
    expect((await memory.execute({ action: "get", ids: [alpha.id] }, call)).content).toContain(
        alpha.content,
    );
    expect(getRecordedSessionProjectIdentity(db, sessionID)).toBe("pj-V2-OWNER-A");
    const released = {
        messages: [
            ...structuredClone(raw),
            {
                info: { id: "owner-next", role: "user", sessionID },
                parts: [{ type: "text", text: "next project" }],
            },
        ],
    };
    await transform({}, released);
    expect(JSON.stringify(released.messages)).toContain(beta.content);
    expect(scheduled.mock.calls.at(-1)?.[0].projectIdentity).toBe("pj-V2-OWNER-B");
    const scheduledCount = scheduled.mock.calls.length;
    deps.maybeAutoEmbedSession(sessionID, { projectIdentity: undefined });
    expect(scheduled).toHaveBeenCalledTimes(scheduledCount);
    expect(getRecordedSessionProjectIdentity(db, sessionID)).toBe("pj-V2-OWNER-B");
    expect((await memory.execute({ action: "get", ids: [beta.id] }, call)).content).toContain(
        beta.content,
    );
});

/** Exercise the host-registered tool, not only its standalone factory. */
async function expandTagOnV2(): Promise<string> {
    const cleanup = seedTypeScriptTagHistory(db);
    try {
        const config = parsePluginConfig({ memory: { enabled: true } });
        const registered: RegisteredTool[] = [];
        await registerTools(hostContext(registered), db, config, undefined);
        const expand = registered.find((tool) => tool.name === "ctx_expand");
        expect(expand).toBeDefined();
        const result = await expand!.execute(
            { tag: "[dropped §75386§]" },
            { sessionID: SESSION_ID, messageID: "msg-1", agent: "build", progress: () => {} },
        );
        return result.content;
    } finally {
        cleanup();
    }
}

test("TypeScript-mode ctx_expand keeps resolving tags from the host", async () => {
    expect(await expandTagOnV2()).toContain(TS_TAG_TEXT);
});
