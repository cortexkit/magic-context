import { beforeEach, describe, expect, test } from "bun:test";
import type { HiddenRunIdentity } from "../hooks/magic-context/compartment-runner-types";
import { Database } from "../shared/sqlite";
import {
    __resetParentDroppedNotice,
    isSessionNotFound,
    nativeSessionRemove,
} from "./hidden-child-native";
import { createV2HiddenCompletionExecutor, type HiddenChildHost } from "./hidden-completion";
import { HIDDEN_DREAMER_AGENT, HiddenChildHook } from "./hooks/hidden-child";
import type { SessionContext } from "./hooks/types";
import type { StoreRow } from "./store-reader";

const historian: HiddenRunIdentity = {
    parentSessionId: "user-session",
    agent: "historian",
    kind: "historian",
    system: "historian system",
    model: "mock/cheap",
    configuredModels: ["mock/cheap"],
    timeoutMs: 1200,
    title: "ignored",
    directory: "/project",
};

const dreamer: HiddenRunIdentity = {
    ...historian,
    agent: HIDDEN_DREAMER_AGENT,
    kind: "dreamer-task",
    system: "dreamer system",
};

const request = () => ({
    path: { id: "child" },
    body: {
        model: { providerID: "mock", modelID: "cheap" },
        parts: [{ type: "text", text: "chunk", synthetic: true }],
    },
});

async function setup(
    options: {
        keepsParent?: boolean;
        removeError?: unknown;
        keepSubagents?: boolean;
        stuck?: boolean;
        /** The directory the host reports for a parented child; it inherits its parent's. */
        parentLocation?: string;
    } = {},
) {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE schema_migrations_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const hook = new HiddenChildHook();
    const creates: Array<Parameters<HiddenChildHost["create"]>[0]> = [];
    const reads: string[] = [];
    const removed: string[] = [];
    const legacyRemovals: string[] = [];
    const logs: string[] = [];
    const parents = new Map<string, string | undefined>();
    const rows = new Map<string, StoreRow<"assistant">[]>();
    let seq = 0;
    let nextID = 0;
    let failNext = false;
    const host: HiddenChildHost = {
        async create(input) {
            creates.push(structuredClone(input));
            const id = `child-${++nextID}`;
            parents.set(id, options.keepsParent === false ? undefined : input.parentID);
            return { id };
        },
        async get(input) {
            reads.push(input.sessionID);
            const parentID = parents.get(input.sessionID);
            return {
                model: { providerID: "mock", id: "user" },
                ...(parentID === undefined ? {} : { parentID }),
                ...(options.parentLocation === undefined
                    ? {}
                    : { location: { directory: options.parentLocation } }),
            };
        },
        async switchModel() {},
        async prompt(input) {
            const draft: SessionContext = {
                sessionID: input.sessionID,
                model: { providerID: "mock", id: "cheap" },
                agent: "historian",
                system: [],
                tools: {},
                options: {},
                messages: [{ role: "user", content: [{ type: "text", text: input.text }] }],
            };
            hook.apply(draft);
            const failed = failNext;
            failNext = false;
            const row: StoreRow<"assistant"> = {
                id: `message-${++seq}`,
                session_id: input.sessionID,
                type: "assistant",
                seq,
                data: failed
                    ? {
                          content: [{ type: "text", text: "" }],
                          finish: "error",
                          error: { message: "provider refused" },
                          time: { created: Date.now(), completed: Date.now() },
                      }
                    : {
                          content: [{ type: "text", text: `reply ${seq}` }],
                          finish: "stop",
                          tokens: {
                              input: 10,
                              output: 2,
                              reasoning: 0,
                              cache: { read: 0, write: 0 },
                          },
                          time: { created: Date.now(), completed: Date.now() },
                      },
            };
            rows.set(input.sessionID, [...(rows.get(input.sessionID) ?? []), row]);
        },
        async wait() {},
        async interrupt() {
            return { interrupted: true };
        },
        async update() {},
        async removeSession(input) {
            if (options.stuck) await new Promise(() => {});
            if (options.removeError !== undefined) throw options.removeError;
            removed.push(input.sessionID);
        },
    };
    const executor = await createV2HiddenCompletionExecutor(host, {
        db,
        projectIdentity: "/project",
        directory: "/project",
        hook,
        openReader: () => ({
            latestSequence: (id) => rows.get(id)?.at(-1)?.seq ?? -1,
            latestAssistant: (id) => rows.get(id)?.at(-1),
            latestIdle: () => undefined,
        }),
        generation: "native-generation",
        removalTimeoutMs: 20,
        ...(options.keepSubagents ? { keepSubagents: true } : {}),
        log: (message) => logs.push(message),
    });
    let prompts = 0;
    const prompt = host.prompt.bind(host);
    host.prompt = async (input) => {
        prompts++;
        return prompt(input);
    };
    const runOnce = async (identity: HiddenRunIdentity) => {
        const handle = await executor.open(identity);
        let settled = false;
        try {
            await executor.attempt(handle, request());
            await executor.collect(handle, 50);
            settled = true;
        } catch {
            // Failures are part of the scenarios below.
        } finally {
            await executor.close(handle, {
                promptSettled: settled,
                privacySensitive: false,
                context: "native",
                log() {},
            });
        }
        return { childID: handle.id, settled };
    };
    return {
        db,
        hook,
        creates,
        reads,
        removed,
        legacyRemovals,
        logs,
        runOnce,
        executor,
        prompts: () => prompts,
        failNextPrompt: () => {
            failNext = true;
        },
        metaRows: () =>
            (
                db.prepare("SELECT COUNT(*) AS count FROM schema_migrations_meta").get() as {
                    count: number;
                }
            ).count,
    };
}

describe("OpenCode 2 hidden children on a host with session.remove", () => {
    beforeEach(() => __resetParentDroppedNotice());

    test("each historian and dreamer run gets a child under the user's session, removed when it ends", async () => {
        const state = await setup();
        try {
            const first = await state.runOnce(historian);
            const second = await state.runOnce(historian);
            const dream = await state.runOnce(dreamer);
            expect([first.settled, second.settled, dream.settled]).toEqual([true, true, true]);
            // No reuse: a child lives for exactly one run.
            expect([first.childID, second.childID, dream.childID]).toEqual([
                "child-1",
                "child-2",
                "child-3",
            ]);
            expect(state.creates.every((input) => !("location" in input))).toBe(true);
            expect(state.creates.map((input) => [input.parentID, input.metadata.role])).toEqual([
                ["user-session", "historian"],
                ["user-session", "historian"],
                ["user-session", "dreamer"],
            ]);
            // Every child is read back once to confirm the host kept its parent.
            expect(state.reads).toEqual(["child-1", "child-2", "child-3"]);
            // Removal has finished by the time close() returns.
            expect(state.removed).toEqual(["child-1", "child-2", "child-3"]);
            expect(state.legacyRemovals).toEqual([]);
            expect(state.logs).toEqual([]);
            // Nothing about these children is recorded in context.db.
            expect(state.metaRows()).toBe(0);
        } finally {
            state.db.close();
        }
    });

    test("a provider failure removes the failed child and the next run starts on a new one", async () => {
        const state = await setup();
        try {
            state.failNextPrompt();
            const failed = await state.runOnce(historian);
            expect(failed.settled).toBe(false);
            expect(state.removed).toEqual([failed.childID]);
            const next = await state.runOnce(historian);
            expect(next.settled).toBe(true);
            expect(next.childID).not.toBe(failed.childID);
            // Removed once each, never twice.
            expect(state.removed).toEqual([failed.childID, next.childID]);
        } finally {
            state.db.close();
        }
    });

    test("a host that drops the parent is reported once per process and its children are still removed", async () => {
        const state = await setup({ keepsParent: false });
        try {
            await state.runOnce(historian);
            await state.runOnce(dreamer);
            expect(state.removed).toEqual(["child-1", "child-2"]);
            expect(state.logs).toHaveLength(1);
            expect(state.logs[0]).toContain("does not keep the parent of hidden-run sessions");
            expect(state.logs[0]).toContain("asked for user-session, read back none");
        } finally {
            state.db.close();
        }
    });

    // OpenCode 2 runs a session's hooks in the plugin instance of the session's
    // location, and a child takes its parent's location. A child placed under a
    // session of another directory would be shaped by an instance with no record
    // of the run, so it is refused and removed before anything is prompted.
    test("a child the host bound to another directory is removed before any prompt", async () => {
        const state = await setup({ parentLocation: "/somewhere-else" });
        try {
            let caught: unknown;
            try {
                await state.executor.open(historian);
            } catch (error) {
                caught = error;
            }
            expect(String(caught)).toContain("hidden_prompt_unrecognized");
            expect(String(caught)).toContain("bound to /somewhere-else");
            expect(state.prompts()).toBe(0);
            expect(state.removed).toEqual(["child-1"]);
        } finally {
            state.db.close();
        }
    });

    test("a child bound to this instance's own directory runs normally", async () => {
        const state = await setup({ parentLocation: "/project" });
        try {
            const run = await state.runOnce(historian);
            expect(run.settled).toBe(true);
            expect(state.prompts()).toBe(1);
        } finally {
            state.db.close();
        }
    });

    test("a run with no user session creates a root child without a parent and removes it", async () => {
        const state = await setup();
        try {
            const { parentSessionId: _unused, ...withoutParent } = dreamer;
            await state.runOnce(withoutParent);
            expect("parentID" in (state.creates[0] ?? {})).toBe(false);
            expect(state.reads).toEqual([]);
            expect(state.removed).toEqual(["child-1"]);
        } finally {
            state.db.close();
        }
    });

    test("a child the host no longer has counts as removed", async () => {
        const notFound = Object.assign(new Error("Session not found: child-1"), { status: 404 });
        const state = await setup({ removeError: notFound });
        try {
            const run = await state.runOnce(historian);
            expect(run.settled).toBe(true);
            expect(state.logs).toEqual([]);
        } finally {
            state.db.close();
        }
    });

    test("a failed removal is logged and never fails the run", async () => {
        const state = await setup({ removeError: new Error("host is shutting down") });
        try {
            const run = await state.runOnce(historian);
            expect(run.settled).toBe(true);
            expect(state.logs).toEqual([
                "[magic-context] hidden child child-1 could not be removed; it goes when its parent session is deleted: host is shutting down",
            ]);
        } finally {
            state.db.close();
        }
    });

    test("a stuck removal times out without hanging close", async () => {
        const state = await setup({ stuck: true });
        try {
            const run = await Promise.race([
                state.runOnce(historian),
                Bun.sleep(100).then(() => {
                    throw new Error("close did not honor its removal timeout");
                }),
            ]);
            expect(run.settled).toBe(true);
            expect(state.logs).toHaveLength(1);
            expect(state.logs[0]).toContain("session.remove timed out");
        } finally {
            state.db.close();
        }
    });

    test("keep_subagents keeps a settled child under the user's session", async () => {
        const state = await setup({ keepSubagents: true });
        try {
            await state.runOnce(historian);
            expect(state.removed).toEqual([]);
        } finally {
            state.db.close();
        }
    });
});

describe("nativeSessionRemove", () => {
    test("is absent on a session API without remove", () => {
        expect(nativeSessionRemove({ create() {} })).toBeUndefined();
        expect(nativeSessionRemove({ remove: "not a function" })).toBeUndefined();
    });

    test("calls the host's remove on its own session API with only the session id", async () => {
        const calls: unknown[] = [];
        const session = {
            name: "session-api",
            remove(this: { name: string }, input: unknown) {
                calls.push([this.name, input]);
                return Promise.resolve();
            },
        };
        const remove = nativeSessionRemove(session);
        await remove?.({ sessionID: "child-9" });
        expect(calls).toEqual([["session-api", { sessionID: "child-9" }]]);
    });
});

describe("isSessionNotFound", () => {
    test.each([
        ["an HTTP 404", { status: 404 }, true],
        ["a not-found message", new Error("Session not found"), true],
        ["a not-found tag", { _tag: "SessionNotFoundError" }, true],
        ["another error", new Error("connection reset"), false],
        ["another status", { status: 500 }, false],
        ["a bare string", "not found", false],
    ] as const)("%s -> %p", (_label, error, expected) => {
        expect(isSessionNotFound(error)).toBe(expected);
    });
});
