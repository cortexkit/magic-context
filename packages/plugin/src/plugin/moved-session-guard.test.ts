import { afterEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hooks, ToolDefinition } from "@opencode-ai/plugin";
import {
    createMovedSessionCheck,
    MODE3_MOVE_RECORD_PREFIX,
    MOVED_SESSION_MESSAGE,
} from "../features/magic-context/mode3-move-record";
import { closeDatabase, openDatabase } from "../features/magic-context/storage";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../shared/test-temp-dir";
import { guardBridgedSessionRpc, standDownForBridgedSessions } from "./bridged-session-guard";

const MOVED = "ses_moved_to_mode3";
const STANDALONE = "ses_still_standalone";
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const dirs: string[] = [];

afterEach(() => {
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of dirs.splice(0)) cleanupTestTempDir(dir);
});

/** A real context.db holding the record ck-mc's offline move writes last. */
function movedSessionCheck() {
    const dir = createTestTempDirFromPath(join(tmpdir(), "moved-session-guard-"));
    dirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    const db = openDatabase();
    if (!db) throw new Error("context.db did not open");
    db.prepare("INSERT INTO schema_migrations_meta (key, value) VALUES (?, ?)").run(
        `${MODE3_MOVE_RECORD_PREFIX}${MOVED}`,
        JSON.stringify({ version: 1, session: MOVED }),
    );
    let reads = 0;
    const check = createMovedSessionCheck(() => {
        reads++;
        return db;
    });
    return { check, reads: () => reads };
}

test("the shared gate refuses a moved session in every hook and fails its transform closed", async () => {
    const { check, reads } = movedSessionCheck();
    const calls: string[] = [];
    const tool: ToolDefinition = {
        description: "ctx_reduce",
        args: {},
        execute: async () => {
            calls.push("tool");
            return "reduced";
        },
    } as unknown as ToolDefinition;
    const hooks = standDownForBridgedSessions(
        {
            "experimental.chat.messages.transform": async () => {
                calls.push("transform");
            },
            "chat.message": async () => {
                calls.push("chat.message");
            },
            "experimental.chat.system.transform": async () => {
                calls.push("system");
            },
            event: async () => {
                calls.push("event");
            },
            tool: { ctx_reduce: tool },
        } as Hooks,
        { isMovedSession: check },
    );
    const transformFor = (session: string) =>
        hooks["experimental.chat.messages.transform"]!({}, {
            messages: [{ info: { id: "m1", sessionID: session, role: "user" }, parts: [] }],
        } as never);

    await expect(transformFor(MOVED)).rejects.toThrow(MOVED_SESSION_MESSAGE);
    await hooks["chat.message"]!({ sessionID: MOVED } as never, {} as never);
    await hooks["experimental.chat.system.transform"]!({ sessionID: MOVED } as never, {
        system: [],
    });
    await hooks.event!({
        event: { type: "message.updated", properties: { info: { sessionID: MOVED } } },
    } as never);
    const refused = await hooks.tool!.ctx_reduce.execute(
        {} as never,
        {
            sessionID: MOVED,
        } as never,
    );
    expect(refused).toBe(`Error: ${MOVED_SESSION_MESSAGE}`);
    expect(calls).toEqual([]);

    // A session that was not moved reaches every hook unchanged.
    await transformFor(STANDALONE);
    await hooks["chat.message"]!({ sessionID: STANDALONE } as never, {} as never);
    await hooks.event!({
        event: { type: "message.updated", properties: { info: { sessionID: STANDALONE } } },
    } as never);
    await hooks.tool!.ctx_reduce.execute({} as never, { sessionID: STANDALONE } as never);
    expect(calls).toEqual(["transform", "chat.message", "event", "tool"]);
    // A moved session is looked up once and cached; a session that wasn't
    // moved is looked up on every call, since it can be moved later.
    expect(reads()).toBe(5);
});

// Moves happen while hosts keep running (2026-11-05: a moved head's old copy
// woke on a cached "not moved" answer and ran turns on its pre-move state).
test("a session moved while the process runs is refused from its next call", () => {
    const dir = createTestTempDirFromPath(join(tmpdir(), "moved-session-guard-"));
    dirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    const db = openDatabase();
    if (!db) throw new Error("context.db did not open");
    const check = createMovedSessionCheck(() => db);
    expect(check(STANDALONE)).toBe(false);
    db.prepare("INSERT INTO schema_migrations_meta (key, value) VALUES (?, ?)").run(
        `${MODE3_MOVE_RECORD_PREFIX}${STANDALONE}`,
        JSON.stringify({ version: 1, session: STANDALONE }),
    );
    expect(check(STANDALONE)).toBe(true);
});

test("per-session RPC requests about a moved session are refused", async () => {
    const { check } = movedSessionCheck();
    const handlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
    const server = {
        handle(method: string, handler: (params: Record<string, unknown>) => Promise<unknown>) {
            handlers.set(method, handler);
        },
    };
    guardBridgedSessionRpc(server as never, check);
    server.handle("status", async () => ({ ok: true }));
    expect(await handlers.get("status")!({ sessionId: MOVED })).toEqual({
        error: MOVED_SESSION_MESSAGE,
    });
    expect(await handlers.get("status")!({ sessionId: STANDALONE })).toEqual({ ok: true });
});
