/// <reference types="bun-types" />

import { afterEach, describe, expect, mock, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hooks, ToolDefinition } from "@opencode-ai/plugin";
import { closeDatabase, openDatabase } from "../features/magic-context/storage";
import { createTagger } from "../features/magic-context/tagger";
import type { ContextUsage } from "../features/magic-context/types";
import { createTransform } from "../hooks/magic-context/transform";
import { BRIDGED_SESSIONS_KEY } from "../shared/bridged-sessions";
import { drainNotifications } from "../shared/rpc-notifications";
import { MagicContextRpcServer } from "../shared/rpc-server";
import { scaleTest, slowLane } from "../shared/slow-test";
import { createTestTempDirFromPath } from "../shared/test-temp-dir";
import {
    BRIDGED_SESSION_RPC_ERROR,
    eventConcernsBridgedSession,
    guardBridgedSessionRpc,
    SESSION_INPUT_HOOKS,
    standDownForBridgedSessions,
} from "./bridged-session-guard";
import { __conflictWarningTest, sendStartupAnnouncement } from "./conflict-warning-hook";
import { createMessagesTransformHandler } from "./messages-transform";

const slot = globalThis as unknown as Record<symbol, unknown>;

function enroll(...sessionIds: string[]): Map<string, { product: string; version: string }> {
    const sessions = new Map(
        sessionIds.map((id) => [id, { product: "thalamus", version: "0.0.0-test" }]),
    );
    slot[BRIDGED_SESSIONS_KEY] = sessions;
    return sessions;
}

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;

function useTempDataHome(prefix: string): string {
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    process.env.XDG_CACHE_HOME = dir;
    return dir;
}

afterEach(() => {
    Reflect.deleteProperty(slot, BRIDGED_SESSIONS_KEY);
    __conflictWarningTest.reset();
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* best-effort temp cleanup */
        }
    }
    tempDirs.length = 0;
});

// ---------------------------------------------------------------------------
// Recording stand-in for the OpenCode 1 hooks object. Every callback logs what
// it received, mutates its output the way a real hook would (tags text, appends
// to arrays, sets fields) and returns a promise it remembers, so a test can
// compare a wrapped and an unwrapped copy call for call.
// ---------------------------------------------------------------------------

type CallLog = string[];

type Recorder = {
    hooks: Hooks;
    log: CallLog;
    /** The promise the most recent inner callback returned. */
    lastReturned: { value: Promise<unknown> | undefined };
};

function makeRecorder(): Recorder {
    const log: CallLog = [];
    const lastReturned: { value: Promise<unknown> | undefined } = { value: undefined };
    let counter = 0;
    const remember = <T>(promise: Promise<T>): Promise<T> => {
        lastReturned.value = promise;
        return promise;
    };
    const sessionHook =
        (key: string) =>
        (input: unknown, output: Record<string, unknown>): Promise<void> => {
            counter += 1;
            log.push(`${key}:${JSON.stringify(input)}`);
            if (output && typeof output === "object") output.touchedBy = `${key}#${counter}`;
            return remember(Promise.resolve());
        };
    const hooks: Hooks = {
        event: (input) => {
            counter += 1;
            log.push(`event#${counter}:${JSON.stringify(input)}`);
            return remember(Promise.resolve());
        },
        "tool.definition": (input, output) => {
            counter += 1;
            log.push(`tool.definition#${counter}:${input.toolID}`);
            output.description = `${output.description} [measured #${counter}]`;
            return remember(Promise.resolve());
        },
        tool: {
            ctx_reduce: {
                description: "reduce",
                args: {},
                execute: (args, context) => {
                    counter += 1;
                    log.push(`ctx_reduce#${counter}:${context.sessionID}:${JSON.stringify(args)}`);
                    return remember(Promise.resolve(`reduced #${counter}`));
                },
            } as ToolDefinition,
            ctx_search: {
                description: "search",
                args: {},
                execute: (args, context) => {
                    counter += 1;
                    log.push(`ctx_search#${counter}:${context.sessionID}:${JSON.stringify(args)}`);
                    return remember(Promise.resolve(`found #${counter}`));
                },
            } as ToolDefinition,
        },
    };
    const slots = hooks as Record<string, unknown>;
    for (const key of SESSION_INPUT_HOOKS) slots[key] = sessionHook(key);
    slots["experimental.chat.messages.transform"] = (
        input: unknown,
        output: { messages: Array<{ info: unknown; parts: Array<{ text?: string }> }> },
    ) => {
        counter += 1;
        log.push(`transform#${counter}:${JSON.stringify(input)}`);
        for (const message of output.messages) {
            for (const part of message.parts) {
                if (typeof part.text === "string") part.text = `§${counter}§ ${part.text}`;
            }
        }
        output.messages.push({ info: { role: "user", id: `injected-${counter}` }, parts: [] });
        return remember(Promise.resolve(output.messages));
    };
    return { hooks, log, lastReturned };
}

// Deterministic PRNG so a failing differential pass can be replayed by seed.
function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

type HookCall = { key: string; input: unknown; output: unknown };

function randomCall(random: () => number, sessionId: string): HookCall {
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
    const word = () => pick(["alpha", "beta", "§7§ tagged", "", "ünïcødé", "x".repeat(40)]);
    const kinds = [
        ...SESSION_INPUT_HOOKS,
        "experimental.chat.messages.transform",
        "event",
        "tool.definition",
        "tool:ctx_reduce",
        "tool:ctx_search",
    ] as const;
    const key = pick(kinds);
    switch (key) {
        case "experimental.chat.messages.transform": {
            const count = 1 + Math.floor(random() * 4);
            const messages = Array.from({ length: count }, (_, index) => ({
                info: {
                    id: `m-${index}`,
                    role: index % 2 === 0 ? "user" : "assistant",
                    ...(index === 0 && random() < 0.2 ? {} : { sessionID: sessionId }),
                },
                parts: [{ type: "text", text: word() }],
            }));
            return { key, input: {}, output: { messages } };
        }
        case "event": {
            const shapes = [
                { type: "session.idle", properties: { sessionID: sessionId } },
                { type: "session.created", properties: { info: { id: sessionId, parentID: "" } } },
                { type: "session.deleted", properties: { info: { id: sessionId } } },
                {
                    type: "message.updated",
                    properties: { info: { id: "msg-1", role: "assistant", sessionID: sessionId } },
                },
                {
                    type: "message.part.updated",
                    properties: { part: { id: "prt-1", sessionID: sessionId, type: "text" } },
                },
                { type: "server.instance.disposed", properties: { directory: "/tmp/project" } },
                { type: "installation.updated", properties: { version: "1.2.3" } },
            ];
            return { key, input: { event: pick(shapes) }, output: undefined };
        }
        case "tool.definition":
            return {
                key,
                input: { toolID: pick(["ctx_reduce", "read", "bash"]) },
                output: { description: word(), parameters: { type: "object" } },
            };
        case "tool:ctx_reduce":
        case "tool:ctx_search":
            return {
                key,
                input: { drop: word() },
                output: { sessionID: sessionId, messageID: "msg-1", agent: "build" },
            };
        default:
            return {
                key,
                input: { sessionID: sessionId, word: word() },
                output: { parts: [{ type: "text", text: word() }], system: [word()] },
            };
    }
}

function invoke(hooks: Hooks, call: HookCall): Promise<unknown> | undefined {
    if (call.key.startsWith("tool:")) {
        const tool = hooks.tool?.[call.key.slice("tool:".length)];
        return tool?.execute(
            call.input as never,
            call.output as Parameters<ToolDefinition["execute"]>[1],
        );
    }
    const hook = (hooks as Record<string, unknown>)[call.key] as
        | ((input: unknown, output: unknown) => Promise<unknown>)
        | undefined;
    return hook?.(call.input, call.output);
}

describe("standDownForBridgedSessions: sessions not in the map", () => {
    test("randomized differential: 300 passes are byte-identical to the unwrapped hooks", async () => {
        const seed = 0x5eed_b1d6;
        const random = mulberry32(seed);
        const base = makeRecorder();
        const wrappedInner = makeRecorder();
        const wrapped = standDownForBridgedSessions(wrappedInner.hooks);

        for (let pass = 0; pass < 300; pass += 1) {
            // The map's state varies per pass: no bridge, a junk value in the
            // slot, or a live map that enrolls other sessions only.
            const sessionId = `ses-unenrolled-${Math.floor(random() * 5)}`;
            const mapState = Math.floor(random() * 3);
            if (mapState === 0) Reflect.deleteProperty(slot, BRIDGED_SESSIONS_KEY);
            else if (mapState === 1) slot[BRIDGED_SESSIONS_KEY] = { [sessionId]: true };
            else enroll(`ses-bridged-${pass}`, "ses-bridged-fixed");

            const call = randomCall(random, sessionId);
            const baseCall = structuredClone(call);
            const wrappedCall = structuredClone(call);

            const baseResult = await invoke(base.hooks, baseCall);
            const wrappedPromise = invoke(wrapped, wrappedCall);
            // Not just an equal value: the very promise the inner hook returned.
            expect(wrappedPromise, `seed=${seed} pass=${pass} key=${call.key}`).toBe(
                wrappedInner.lastReturned.value as Promise<unknown>,
            );
            const wrappedResult = await wrappedPromise;

            const context = `seed=${seed} pass=${pass} key=${call.key}`;
            expect(JSON.stringify(wrappedResult), context).toBe(JSON.stringify(baseResult));
            expect(JSON.stringify(wrappedCall), context).toBe(JSON.stringify(baseCall));
            expect(wrappedInner.log, context).toEqual(base.log);
        }
        expect(base.log.length).toBe(300);
    });

    test("an unwrapped key set and a wrapped one expose the same hook names", () => {
        const recorder = makeRecorder();
        const wrapped = standDownForBridgedSessions(recorder.hooks);
        expect(Object.keys(wrapped).sort()).toEqual(Object.keys(recorder.hooks).sort());
        expect(Object.keys(wrapped.tool ?? {}).sort()).toEqual(
            Object.keys(recorder.hooks.tool ?? {}).sort(),
        );
    });
});

describe("standDownForBridgedSessions: enrolled sessions", () => {
    test("every per-session hook returns without calling Magic Context or touching output", async () => {
        enroll("ses-bridged");
        const recorder = makeRecorder();
        const wrapped = standDownForBridgedSessions(recorder.hooks);
        const random = mulberry32(42);
        const keys = new Set<string>();
        for (let pass = 0; pass < 200; pass += 1) {
            const call = randomCall(random, "ses-bridged");
            const isSessionlessEvent =
                call.key === "event" &&
                ["server.instance.disposed", "installation.updated"].includes(
                    (call.input as { event: { type: string } }).event.type,
                );
            // A transform pass whose messages name no session cannot be
            // attributed to anyone, so it is delegated as before.
            const isSessionlessTransform =
                call.key === "experimental.chat.messages.transform" &&
                !JSON.stringify(call.output).includes('"sessionID"');
            // tool.definition carries no session; it is covered separately.
            if (isSessionlessEvent || isSessionlessTransform || call.key === "tool.definition") {
                continue;
            }
            keys.add(call.key);
            const before = JSON.stringify(call);
            const result = await invoke(wrapped, call);
            expect(JSON.stringify(call), call.key).toBe(before);
            if (call.key === "experimental.chat.messages.transform") {
                expect(result).toBe((call.output as { messages: unknown }).messages);
            } else if (call.key.startsWith("tool:")) {
                expect(String(result)).toContain("served by the bridge (thalamus)");
            } else {
                expect(result).toBeUndefined();
            }
        }
        expect(recorder.log).toEqual([]);
        // The sample really covered every session-bearing hook.
        expect(keys.size).toBe(SESSION_INPUT_HOOKS.length + 4);
    });

    test("events with no session still reach Magic Context while a bridge is running", async () => {
        enroll("ses-bridged");
        const recorder = makeRecorder();
        const wrapped = standDownForBridgedSessions(recorder.hooks);
        await wrapped.event?.({
            event: { type: "server.instance.disposed", properties: { directory: "/x" } } as never,
        });
        expect(recorder.log).toHaveLength(1);
    });

    test("tool.definition after an enrolled session's chat.message is not measured", async () => {
        enroll("ses-bridged");
        const recorder = makeRecorder();
        const wrapped = standDownForBridgedSessions(recorder.hooks);
        const definition = () => ({ description: "d", parameters: {} });

        await wrapped["chat.message"]?.({ sessionID: "ses-bridged" }, {} as never);
        await wrapped["tool.definition"]?.({ toolID: "ctx_reduce" }, definition());
        expect(recorder.log).toEqual([]);

        await wrapped["chat.message"]?.({ sessionID: "ses-plain" }, {} as never);
        await wrapped["tool.definition"]?.({ toolID: "ctx_reduce" }, definition());
        expect(recorder.log.map((line) => line.split(":")[0])).toEqual([
            "chat.message",
            "tool.definition#2",
        ]);
    });

    test("event payload shapes resolve the session they belong to", () => {
        enroll("ses-b");
        const concerns = (event: unknown) => eventConcernsBridgedSession(event);
        expect(concerns({ type: "session.idle", properties: { sessionID: "ses-b" } })).toBe(true);
        expect(concerns({ type: "session.updated", properties: { info: { id: "ses-b" } } })).toBe(
            true,
        );
        expect(
            concerns({ type: "message.updated", properties: { info: { sessionID: "ses-b" } } }),
        ).toBe(true);
        expect(
            concerns({
                type: "message.part.updated",
                properties: { part: { sessionID: "ses-b" } },
            }),
        ).toBe(true);
        // A message's own id is not a session id, even if it happened to match.
        expect(concerns({ type: "message.updated", properties: { info: { id: "ses-b" } } })).toBe(
            false,
        );
        expect(concerns({ type: "session.idle", properties: { sessionID: "ses-other" } })).toBe(
            false,
        );
        expect(concerns({ type: "session.idle" })).toBe(false);
        expect(concerns(null)).toBe(false);
    });
});

describe("guardBridgedSessionRpc", () => {
    test("per-session RPC methods refuse enrolled sessions and pass others through", async () => {
        const dir = useTempDataHome("bridged-rpc-");
        const server = new MagicContextRpcServer(dir, dir);
        guardBridgedSessionRpc(server);
        const handler = mock(async (params: Record<string, unknown>) => ({ ok: true, params }));
        server.handle("sidebar-snapshot", handler);
        enroll("ses-bridged");

        expect(await server.dispatch("sidebar-snapshot", { sessionId: "ses-bridged" })).toEqual({
            error: BRIDGED_SESSION_RPC_ERROR,
        });
        expect(handler).not.toHaveBeenCalled();

        const params = { sessionId: "ses-plain", directory: dir };
        expect(await server.dispatch("sidebar-snapshot", params)).toEqual({ ok: true, params });
        expect(await server.dispatch("sidebar-snapshot", {})).toEqual({ ok: true, params: {} });
        expect(handler).toHaveBeenCalledTimes(2);
    });
});

describe("Desktop notices", () => {
    test("startup notices skip a Desktop session the bridge serves and still reach others", async () => {
        const directory = useTempDataHome("bridged-desktop-");
        const markSeen = mock(() => {});
        const announce = (sessionId: string) => {
            __conflictWarningTest.setDesktopState(directory, { sessionId, sidecarUrl: null });
            return sendStartupAnnouncement(
                { session: { get: mock(async () => ({})), prompt: mock(async () => ({})) } },
                directory,
                "9.9.9",
                ["A release feature"],
                "",
                markSeen,
            );
        };
        enroll("ses-desktop-bridged");

        await announce("ses-desktop-bridged");
        expect(drainNotifications(0, "ses-desktop-bridged", { sessionOnly: true })).toEqual([]);
        expect(markSeen).not.toHaveBeenCalled();

        // Control: the same announcement reaches a session Magic Context serves.
        await announce("ses-desktop-plain");
        expect(markSeen).toHaveBeenCalledWith("9.9.9");
    });
});

// ---------------------------------------------------------------------------
// Tests against the real OpenCode 1 messages-transform pipeline:
// createTransform behind createMessagesTransformHandler, wired the way
// src/index.ts wires it, over a real context database. They check that an
// enrolled session gets no tag prefixes and no database rows from the very
// code that would otherwise produce them.
// ---------------------------------------------------------------------------

type TestMessage = {
    info: { id: string; role: string; sessionID?: string };
    parts: Array<{ type: string; text?: string; callID?: string; state?: { output: string } }>;
};

function sessionMessages(sessionId: string): TestMessage[] {
    return [
        {
            info: { id: `${sessionId}-u1`, role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: "Plan this change" }],
        },
        {
            info: { id: `${sessionId}-a1`, role: "assistant", sessionID: sessionId },
            parts: [
                { type: "text", text: "Implemented" },
                { type: "tool", callID: `${sessionId}-call`, state: { output: "tool output" } },
            ],
        },
    ];
}

function realPipeline(sessionIds: string[]) {
    const db = openDatabase();
    const transform = createTransform({
        tagger: createTagger(),
        scheduler: { shouldExecute: mock(() => "defer" as const) },
        contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>(
            sessionIds.map((id) => [
                id,
                { usage: { percentage: 40, inputTokens: 80_000 }, updatedAt: Date.now() },
            ]),
        ),
        db,
        historyRefreshSessions: new Set<string>(),
        pendingMaterializationSessions: new Set<string>(),
        lastHeuristicsTurnId: new Map<string, string>(),
        clearReasoningAge: 50,
        protectedTokens: 0,
    });
    const handler = createMessagesTransformHandler({
        magicContext: { "experimental.chat.messages.transform": transform } as never,
    });
    const hooks = standDownForBridgedSessions({
        "experimental.chat.messages.transform": handler as unknown as NonNullable<
            Hooks["experimental.chat.messages.transform"]
        >,
    });
    const run = (messages: TestMessage[]) =>
        (
            hooks["experimental.chat.messages.transform"] as unknown as (
                input: Record<string, never>,
                output: { messages: TestMessage[] },
            ) => Promise<unknown>
        )({}, { messages });
    const rawRun = (messages: TestMessage[]) => handler({}, { messages } as never);
    return { db, run, rawRun };
}

/** Counts rows, across every context-database table with a `session_id` column, whose `session_id` equals the given ID. */
function rowsForSession(db: ReturnType<typeof openDatabase>, sessionId: string): number {
    const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
    let total = 0;
    for (const { name } of tables) {
        const columns = db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{
            name: string;
        }>;
        for (const column of columns) {
            if (column.name !== "session_id") continue;
            const row = db
                .prepare(`SELECT COUNT(*) AS n FROM "${name}" WHERE session_id = ?`)
                .get(sessionId) as { n: number };
            total += row.n;
        }
    }
    return total;
}

describe("standDownForBridgedSessions: real messages transform", () => {
    test("an enrolled session's messages pass through the real transform untouched with no tags or rows", async () => {
        useTempDataHome("bridged-real-enrolled-");
        enroll("ses-bridged");
        const { db, run } = realPipeline(["ses-bridged"]);
        const messages = sessionMessages("ses-bridged");
        const before = JSON.stringify(messages);

        for (let pass = 0; pass < 3; pass += 1) {
            const result = await run(messages);
            expect(result).toBe(messages);
        }

        expect(JSON.stringify(messages)).toBe(before);
        expect(JSON.stringify(messages)).not.toContain("§");
        expect(rowsForSession(db, "ses-bridged")).toBe(0);
    });

    test("two sessions in one process: the enrolled one is untouched, the other is managed", async () => {
        useTempDataHome("bridged-real-mixed-");
        enroll("ses-bridged");
        const { db, run } = realPipeline(["ses-bridged", "ses-plain"]);
        const bridged = sessionMessages("ses-bridged");
        const plain = sessionMessages("ses-plain");
        const bridgedBefore = JSON.stringify(bridged);

        for (let pass = 0; pass < 3; pass += 1) {
            await run(plain);
            await run(bridged);
        }

        expect(JSON.stringify(bridged)).toBe(bridgedBefore);
        expect(rowsForSession(db, "ses-bridged")).toBe(0);
        // Control: the same pipeline tags and stores rows for the unenrolled
        // session, so the enrolled session's zero rows come from the guard,
        // not from a pipeline that writes nothing.
        expect(plain[0].parts[0].text).toStartWith("§1§ ");
        expect(rowsForSession(db, "ses-plain")).toBeGreaterThan(0);
    });
});

describe("standDownForBridgedSessions: real transform differential", () => {
    // Each pass is a fresh session's first transform, so 200 passes sit near a
    // minute on CI's 2-core runners. The unit lane runs the same oracle on the
    // seed's first 40 passes; the scheduled slow lane runs all 200.
    scaleTest(
        "randomized passes of unenrolled sessions match the unwrapped real pipeline byte for byte",
        async (slow) => {
            useTempDataHome("bridged-real-differential-");
            const seed = 0xd1ff_0001;
            const random = mulberry32(seed);
            const passes = slow ? 200 : 40;
            const ids = Array.from({ length: passes }, (_, pass) => [
                `ses-diff-${pass}-base`,
                `ses-diff-${pass}-wrap`,
            ]).flat();
            const { rawRun, run } = realPipeline(ids);
            const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
            const words = [
                "Plan this",
                "Implemented",
                "§9§ looks tagged",
                "ünïcødé",
                "x".repeat(300),
            ];

            for (let pass = 0; pass < passes; pass += 1) {
                // Half the passes publish a bridged-sessions map that enrolls some
                // other session; the rest remove the map entirely.
                if (random() < 0.5) enroll(`ses-elsewhere-${pass}`);
                else Reflect.deleteProperty(slot, BRIDGED_SESSIONS_KEY);

                const make = (sessionId: string): TestMessage[] => {
                    const count = 1 + Math.floor(random() * 3);
                    return Array.from({ length: count }, (_, index) => ({
                        info: {
                            id: `${sessionId}-m${index}`,
                            role: index % 2 === 0 ? "user" : "assistant",
                            sessionID: sessionId,
                        },
                        parts:
                            index % 2 === 0
                                ? [{ type: "text", text: pick(words) }]
                                : [
                                      { type: "text", text: pick(words) },
                                      {
                                          type: "tool",
                                          callID: `${sessionId}-c${index}`,
                                          state: { output: pick(words) },
                                      },
                                  ],
                    }));
                };
                const baseId = `ses-diff-${pass}-base`;
                const wrapId = `ses-diff-${pass}-wrap`;
                // Same random draws for both copies: build once, then rename.
                const template = make("SESSION");
                const rename = (id: string): TestMessage[] =>
                    JSON.parse(JSON.stringify(template).replaceAll("SESSION", id));
                const baseMessages = rename(baseId);
                const wrapMessages = rename(wrapId);

                await rawRun(baseMessages);
                await run(wrapMessages);
                // The base really was managed, so equality is not two untouched copies.
                expect(baseMessages[0].parts[0].text).toStartWith("§1§ ");
                expect(
                    JSON.stringify(wrapMessages).replaceAll(wrapId, "SESSION"),
                    `seed=${seed} pass=${pass}`,
                ).toBe(JSON.stringify(baseMessages).replaceAll(baseId, "SESSION"));
            }
        },
        slowLane ? 180_000 : 60_000,
    );
});

describe("plugin entry wiring", () => {
    const entry = readFileSync(join(import.meta.dir, "..", "index.ts"), "utf8");

    test("the hooks object OpenCode receives is wrapped by the stand-down guard", () => {
        expect(entry).toMatch(/const entryHooks: Hooks = \{\n\s{8}tool: tools,/);
        expect(entry).toMatch(/return standDownForBridgedSessions\(entryHooks, \{/);
        // The guard also refuses sessions the offline move handed to mode 3.
        expect(entry).toMatch(
            /return standDownForBridgedSessions\(entryHooks, \{\n\s*isMovedSession,/,
        );
        // Nothing else is returned to the host.
        expect([...entry.matchAll(/^ {4}return /gm)]).toHaveLength(1);
    });

    test("every RPC registration on the entry is guarded first", () => {
        const registrations = [...entry.matchAll(/registerRpcHandlers\(rpcServer,/g)].length;
        const guards = [
            // The same guard also refuses sessions moved to mode 3.
            ...entry.matchAll(
                /guardBridgedSessionRpc\(rpcServer, isMovedSession\);\n\s*registerRpcHandlers\(/g,
            ),
        ].length;
        expect(registrations).toBeGreaterThan(0);
        expect(guards).toBe(registrations);
    });

    test("every session-bearing hook the entry returns is one the guard covers", () => {
        const start = entry.indexOf("const entryHooks: Hooks = {");
        const end = entry.indexOf("\n    };\n", start);
        const returned = entry.slice(start, end);
        const keys = [...returned.matchAll(/^\s{8}(?:"([a-z.]+)"|([a-zA-Z]+)):/gm)].map(
            (match) => match[1] ?? match[2],
        );
        // Hook keys whose input has no session ID. `tool` and `event` are
        // guarded separately (per tool call and per event payload),
        // `tool.definition` follows the last chat.message, and `config` is
        // process-wide, so none of them belongs in the session-input list.
        const sessionless = new Set(["tool", "event", "config", "tool.definition"]);
        const covered = new Set<string>([
            ...SESSION_INPUT_HOOKS,
            "experimental.chat.messages.transform",
        ]);
        expect(keys.length).toBeGreaterThanOrEqual(10);
        for (const key of keys) {
            if (sessionless.has(key)) continue;
            expect(covered.has(key), `entry hook "${key}" bypasses the bridged-session guard`).toBe(
                true,
            );
        }
    });
});

test("THALAMUS trace stands down through deadline and abort recovery without inferring enrollment from main", async () => {
    enroll("S0", "S1", "S2");
    const recorder = makeRecorder();
    const hooks = standDownForBridgedSessions(recorder.hooks);
    const trace = readFileSync(
        new URL("../hooks/magic-context/fixtures/thalamus-hook-order.jsonl", import.meta.url),
        "utf8",
    )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    const recovery: string[] = [];
    const calls: string[] = [];
    for (const event of trace) {
        if (event.probe) {
            recovery.push(event.mode);
            continue;
        }
        calls.push(`${event.s}:${event.at}`);
        if (event.at === "system") {
            const output = { system: [event.sys0] };
            await hooks["experimental.chat.system.transform"]!(
                { sessionID: event.s } as never,
                output,
            );
            expect(output).toEqual({ system: [event.sys0] });
        } else if (event.at === "messages") {
            const output = {
                messages: [{ info: { sessionID: event.s }, parts: [{ text: event.last }] }],
            };
            const before = structuredClone(output);
            await hooks["experimental.chat.messages.transform"]!({}, output as never);
            expect(output).toEqual(before);
        } else {
            const output = {};
            await hooks["chat.params"]!({ sessionID: event.s } as never, output as never);
            expect(output).toEqual({});
        }
    }
    expect(recovery).toEqual(["deadline", "abort"]);
    expect(calls).toEqual([
        "S0:system",
        "S0:messages",
        "S0:params",
        "S0:system",
        "S0:messages",
        "S0:params",
        "S0:system",
        "S0:messages",
        "S0:params",
        "S0:system",
        "S0:messages",
        "S0:system",
        "S0:messages",
        "S0:system",
        "S0:messages",
        "S0:system",
        "S0:messages",
        "S0:params",
        "S1:system",
        "S1:messages",
        "S1:params",
        "S2:system",
        "S2:messages",
        "S2:params",
    ]);
    expect(recorder.log).toEqual([]);
});
