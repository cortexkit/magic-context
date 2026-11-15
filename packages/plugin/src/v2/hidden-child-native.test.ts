import { describe, expect, test } from "bun:test";
import type { HiddenRunIdentity } from "../hooks/magic-context/compartment-runner-types";
import { Database } from "../shared/sqlite";
import { cleanupLegacyHiddenChildren } from "./hidden-child-cleanup";
import {
    createNativeHiddenChildren,
    isLiveHiddenChild,
    isSessionNotFound,
    nativeSessionRemove,
} from "./hidden-child-native";
import { HIDDEN_CHILD_MAX_AGE_MS, sweepHiddenChildren } from "./hidden-child-sweep";
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
    options: { removeError?: unknown; keepSubagents?: boolean; stuck?: boolean } = {},
) {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE schema_migrations_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const hook = new HiddenChildHook();
    const creates: Array<Parameters<HiddenChildHost["create"]>[0]> = [];
    const reads: string[] = [];
    const removed: string[] = [];
    const legacyRemovals: string[] = [];
    const logs: string[] = [];
    const lifecycleLogs: string[] = [];
    const rows = new Map<string, StoreRow<"assistant">[]>();
    let seq = 0;
    let nextID = 0;
    let failNext = false;
    const host: HiddenChildHost = {
        async create(input) {
            creates.push(structuredClone(input));
            return { id: `child-${++nextID}` };
        },
        async get(input) {
            reads.push(input.sessionID);
            return { model: { providerID: "mock", id: "user" } };
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
        log: (message) => {
            // Keep the existing warning assertions separate from lifecycle diagnostics.
            if (
                /hidden child \S+ (created |removing$|removed$|kept \(keep_subagents\)$)/.test(
                    message,
                )
            )
                lifecycleLogs.push(message);
            else logs.push(message);
        },
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
        lifecycleLogs,
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
    for (const keepSubagents of [false, true]) {
        test(`logs creation and finish decisions once per child with keep_subagents=${keepSubagents}`, async () => {
            const state = await setup({ keepSubagents });
            try {
                await state.runOnce(historian);
                await state.runOnce(dreamer);
                expect(state.lifecycleLogs).toEqual([
                    `[magic-context] hidden child child-1 created role=historian keep_subagents=${keepSubagents}`,
                    ...(keepSubagents
                        ? ["[magic-context] hidden child child-1 kept (keep_subagents)"]
                        : [
                              "[magic-context] hidden child child-1 removing",
                              "[magic-context] hidden child child-1 removed",
                          ]),
                    `[magic-context] hidden child child-2 created role=dreamer keep_subagents=${keepSubagents}`,
                    ...(keepSubagents
                        ? ["[magic-context] hidden child child-2 kept (keep_subagents)"]
                        : [
                              "[magic-context] hidden child child-2 removing",
                              "[magic-context] hidden child child-2 removed",
                          ]),
                ]);
            } finally {
                state.db.close();
            }
        });
    }

    test("a failed removal logs its decision but not a successful removal", async () => {
        const state = await setup({ removeError: new Error("host unavailable") });
        try {
            await state.runOnce(historian);
            expect(state.lifecycleLogs).toEqual([
                "[magic-context] hidden child child-1 created role=historian keep_subagents=false",
                "[magic-context] hidden child child-1 removing",
            ]);
        } finally {
            state.db.close();
        }
    });

    test("legacy startup cleanup logs each removal once and does not log drained ids again", async () => {
        const state = await setup();
        const logs: string[] = [];
        const removed: string[] = [];
        try {
            state.db.prepare("INSERT INTO schema_migrations_meta (key, value) VALUES (?, ?)").run(
                "opencode2_hidden_children:legacy",
                JSON.stringify({
                    active: { historian: { id: "legacy-active" } },
                    retired_children: [{ id: "legacy-retired" }],
                }),
            );
            const remove = async ({ sessionID }: { sessionID: string }) => {
                removed.push(sessionID);
            };
            await cleanupLegacyHiddenChildren(state.db, remove, (line) => logs.push(line));
            await cleanupLegacyHiddenChildren(state.db, remove, (line) => logs.push(line));
            expect(removed).toEqual(["legacy-active", "legacy-retired"]);
            expect(logs).toEqual([
                "[magic-context] legacy hidden child legacy-active removed",
                "[magic-context] legacy hidden child legacy-retired removed",
            ]);
        } finally {
            state.db.close();
        }
    });

    // OpenCode 2.3 reports every idle of a parented session to its parent and wakes it, so a
    // child under the user's session would start a turn there after each run (issue 913).
    test("each historian and dreamer run gets a root child in the run's directory, removed when it ends", async () => {
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
            expect(
                state.creates.map((input) => [
                    "parentID" in input,
                    input.location?.directory,
                    input.metadata.role,
                ]),
            ).toEqual([
                [false, "/project", "historian"],
                [false, "/project", "historian"],
                [false, "/project", "dreamer"],
            ]);
            // Removal has finished by the time close() returns.
            expect(state.removed).toEqual(["child-1", "child-2", "child-3"]);
            expect(state.legacyRemovals).toEqual([]);
            expect(state.logs).toEqual([]);
            // Successful removal drains the durable retry records.
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
                "[magic-context] hidden child child-1 could not be removed: host is shutting down",
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

    test("keep_subagents keeps a settled child", async () => {
        const state = await setup({ keepSubagents: true });
        try {
            await state.runOnce(historian);
            expect(state.removed).toEqual([]);
        } finally {
            state.db.close();
        }
    });
});

describe("durable native hidden-child cleanup", () => {
    function fixture(
        options: { keepSubagents?: boolean; removeError?: unknown; storeFails?: boolean } = {},
    ) {
        const db = new Database(":memory:");
        db.exec("CREATE TABLE schema_migrations_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
        if (options.storeFails)
            db.exec(
                "CREATE TRIGGER reject_record BEFORE INSERT ON schema_migrations_meta BEGIN SELECT RAISE(FAIL, 'store unavailable'); END",
            );
        const removals: string[] = [];
        const logs: string[] = [];
        const hook = new HiddenChildHook();
        const lifecycle = createNativeHiddenChildren(
            { create: async () => ({ id: "durable-child" }) } as HiddenChildHost,
            async ({ sessionID }) => {
                removals.push(sessionID);
                if (options.removeError) throw options.removeError;
            },
            {
                db,
                hook,
                generation: "test",
                keepSubagents: options.keepSubagents === true,
                log: (line) => logs.push(line),
            },
        );
        const open = () =>
            lifecycle.open(historian, "historian", { providerID: "mock", modelID: "cheap" });
        const records = () =>
            db.prepare("SELECT key, value FROM schema_migrations_meta").all() as Array<{
                key: string;
                value: string;
            }>;
        return { db, lifecycle, open, records, removals, logs, hook };
    }

    test("records a child before handing it to the run", async () => {
        const state = fixture();
        try {
            const child = await state.open();
            expect(state.records()).toEqual([
                {
                    key: "hidden_child:durable-child",
                    value: JSON.stringify({
                        id: child.id,
                        directory: "/project",
                        created_at: child.created_at,
                        deadline_at: child.created_at + historian.timeoutMs,
                    }),
                },
            ]);
            expect(state.removals).toEqual([]);
        } finally {
            state.db.close();
        }
    });

    test("the sweep skips a live in-process child even after its recorded deadline", async () => {
        const state = fixture();
        const child = await state.open();
        try {
            const removed: string[] = [];
            expect(isLiveHiddenChild(child.id)).toBe(true);
            await sweepHiddenChildren(
                state.db,
                async ({ sessionID }) => {
                    removed.push(sessionID);
                },
                () => {},
                {
                    now: child.created_at + 2 * HIDDEN_CHILD_MAX_AGE_MS,
                    isLive: isLiveHiddenChild,
                },
            );
            expect(removed).toEqual([]);
            expect(state.records()).toHaveLength(1);
        } finally {
            await state.lifecycle.finish(child, false);
            expect(isLiveHiddenChild(child.id)).toBe(false);
            state.db.close();
        }
    });

    test("a failed removal releases live ownership so the same process can sweep it later", async () => {
        const state = fixture({ removeError: new Error("host unavailable") });
        try {
            const child = await state.open();
            await state.lifecycle.finish(child, false);
            expect(isLiveHiddenChild(child.id)).toBe(false);
            const removed: string[] = [];
            await sweepHiddenChildren(
                state.db,
                async ({ sessionID }) => {
                    removed.push(sessionID);
                },
                () => {},
                {
                    now: child.created_at + 2 * HIDDEN_CHILD_MAX_AGE_MS,
                    isLive: isLiveHiddenChild,
                },
            );
            expect(removed).toEqual([child.id]);
            expect(state.records()).toEqual([]);
        } finally {
            state.db.close();
        }
    });

    for (const missing of [false, true]) {
        test(`clears the durable record after ${missing ? "not-found" : "successful removal"}`, async () => {
            const state = fixture({ removeError: missing ? { status: 404 } : undefined });
            try {
                const child = await state.open();
                expect(state.records()).toHaveLength(1);
                await state.lifecycle.finish(child, false);
                expect(state.removals).toEqual([child.id]);
                expect(state.records()).toEqual([]);
            } finally {
                state.db.close();
            }
        });
    }

    test("failed removal keeps the durable record for a later sweep", async () => {
        const state = fixture({ removeError: new Error("host unavailable") });
        try {
            const child = await state.open();
            await state.lifecycle.finish(child, false);
            expect(state.records()).toHaveLength(1);
            expect(state.logs.at(-1)).toContain("could not be removed");
        } finally {
            state.db.close();
        }
    });

    test("keep_subagents records nothing even while the child is running", async () => {
        const state = fixture({ keepSubagents: true });
        try {
            const child = await state.open();
            expect(state.records()).toEqual([]);
            await state.lifecycle.finish(child, false);
            expect(state.removals).toEqual([]);
        } finally {
            state.db.close();
        }
    });

    test("a store failure refuses only the hidden run and removes its unrecorded child", async () => {
        const state = fixture({ storeFails: true });
        try {
            await expect(state.open()).rejects.toThrow("store unavailable");
            expect(state.removals).toEqual(["durable-child"]);
            expect(state.records()).toEqual([]);
            expect(state.hook.agentFor("durable-child")).toBeUndefined();
            expect(state.logs).toEqual([
                "[magic-context] hidden child durable-child record failed; removed=true: store unavailable",
            ]);
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
