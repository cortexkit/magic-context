import { expect, mock, test } from "bun:test";
import { join } from "node:path";
import type { HiddenCompletion } from "../hooks/magic-context/compartment-runner-types";
import { Database } from "../shared/sqlite";
import { createTestTempDir } from "../shared/test-temp-dir";
import { createV2HiddenCompletionExecutor, type HiddenChildHost } from "./hidden-completion";
import { HiddenChildHook } from "./hooks/hidden-child";
import { type MessageType, V2StoreReader } from "./store-reader";

const continuationText =
    "Your last response hit the output token limit (stop reason: length). Do not apologize, recap, or repeat yourself. Break the remaining work into smaller pieces.";
const outputLimit = {
    type: "output-limit",
    message: "Response still truncated after two output token limit continuations",
};

type Row = readonly [seq: number, type: MessageType, data: Record<string, unknown>];

function answer(seq: number, overrides: Record<string, unknown> = {}): Row {
    return [
        seq,
        "assistant",
        {
            finish: "length",
            rawFinish: "max_output_tokens",
            content: [{ type: "reasoning", text: "budget spent reasoning" }],
            tokens: { input: 101, output: 64, reasoning: 0, cache: { read: 0, write: 0 } },
            ...overrides,
        },
    ];
}

const synthetic = (seq: number, text = continuationText): Row => [seq, "synthetic", { text }];
const idle = (seq: number): Row => [seq, "idle", { outcome: "failed", error: outputLimit }];

// OpenCode 2.4.2 records a user prompt at seq 4, assistant replies at 5/12/19,
// synthetic continuation instructions at 11/18, and the terminal idle at 25.
const cappedHistory = [answer(5), synthetic(11), answer(12), synthetic(18), answer(19), idle(25)];

async function withCarrier(
    check: (attempt: (rows: Row[]) => Promise<HiddenCompletion>) => Promise<void>,
) {
    const { dir, cleanup } = createTestTempDir("oc2-output-limit-store-");
    const path = join(dir, "fixture.db");
    const store = new Database(path);
    const db = new Database(":memory:");
    store.exec(`CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT,
        seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)`);
    db.exec("CREATE TABLE schema_migrations_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const insert = store.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?,?)");
    const hook = new HiddenChildHook();
    let children = 0;
    const create = mock(async () => ({ id: `child-${++children}` }));
    let attemptRows: Row[] = [];
    let baseline = 0;
    const host: HiddenChildHost = {
        create,
        async get() {
            return { model: { providerID: "mock", id: "cheap" } };
        },
        async switchModel() {},
        async prompt({ sessionID, text }) {
            hook.apply({
                sessionID,
                model: { providerID: "mock", id: "cheap" },
                agent: "historian",
                system: [],
                tools: {},
                options: {},
                messages: [{ role: "user", content: [{ type: "text", text }] }],
            });
            for (const [offset, type, data] of [[4, "user", { text }] as Row, ...attemptRows]) {
                const seq = baseline + offset;
                insert.run(
                    `m-${seq}`,
                    sessionID,
                    type,
                    seq,
                    seq,
                    seq,
                    JSON.stringify({
                        ...data,
                        time: { created: seq, ...(type === "assistant" ? { completed: seq } : {}) },
                    }),
                );
            }
            baseline += attemptRows.at(-1)?.[0] ?? 4;
        },
        async wait() {},
        async interrupt() {
            return { interrupted: true };
        },
        async update() {},
        async removeSession() {},
    };
    const executor = await createV2HiddenCompletionExecutor(host, {
        db,
        projectIdentity: dir,
        directory: dir,
        hook,
        openReader: () => new V2StoreReader(path),
        log() {},
    });
    const handle = await executor.open({
        parentSessionId: "parent",
        agent: "historian",
        kind: "historian",
        system: "historian system",
        model: "mock/cheap",
        timeoutMs: 1000,
        title: "ignored",
        directory: dir,
    });
    let promptSettled = false;
    try {
        await check(async (rows) => {
            promptSettled = false;
            attemptRows = rows;
            await executor.attempt(handle, {
                path: { id: handle.id },
                body: {
                    model: { providerID: "mock", modelID: "cheap" },
                    parts: [{ type: "text", text: "chunk", synthetic: true }],
                },
            });
            promptSettled = true;
            return executor.collect(handle, 50);
        });
        expect(create).toHaveBeenCalledTimes(1);
    } finally {
        await executor.close(handle, {
            promptSettled,
            privacySensitive: false,
            context: "test",
            log() {},
        });
        db.close();
        store.close();
        cleanup();
    }
}

test("output-limit store: real row order with a user prompt and host sequence gaps", async () => {
    await withCarrier(async (attempt) => {
        expect(await attempt(cappedHistory)).toMatchObject({
            lengthCapped: true,
            text: null,
            usage: { output: 64 },
        });
    });
});

test("output-limit store: a reused carrier cannot return an earlier assistant", async () => {
    await withCarrier(async (attempt) => {
        expect((await attempt(cappedHistory)).lengthCapped).toBe(true);
        await expect(attempt([idle(10)])).rejects.toThrow(
            "Hidden completion failed: outcome=failed",
        );
    });
});

test.each([
    {
        label: "a capped reply with a tool call ends the continuation chain",
        rows: [
            answer(5, { content: [{ type: "tool-call", id: "c", name: "read", input: {} }] }),
            synthetic(11),
            answer(12),
            idle(18),
        ],
        expected: 128,
    },
    {
        label: "changed synthetic instruction text leaves all repeats counted",
        rows: [
            answer(5),
            synthetic(11, "Please proceed."),
            answer(12),
            synthetic(18, "Please proceed."),
            answer(19),
            idle(25),
        ],
        expected: 192,
    },
    {
        label: "a real user row with the exact instruction text ends the chain",
        rows: [answer(5), [11, "user", { text: continuationText }] as Row, answer(12), idle(18)],
        expected: 128,
    },
])("output-limit store: $label", async ({ rows, expected }) => {
    await withCarrier(async (attempt) => {
        expect(await attempt(rows)).toMatchObject({
            lengthCapped: true,
            usage: { output: expected },
        });
    });
});

test("output-limit store: an errored final assistant remains a generic failure with its own error", async () => {
    const assistantError = { message: "boom" };
    await withCarrier(async (attempt) => {
        const result = attempt([
            answer(5),
            synthetic(11),
            answer(12),
            synthetic(18),
            answer(19, { finish: "error", error: assistantError }),
            idle(25),
        ]);
        await expect(result).rejects.toThrow("Hidden completion failed: outcome=failed");
        await expect(result).rejects.toMatchObject({ cause: assistantError });
    });
});
