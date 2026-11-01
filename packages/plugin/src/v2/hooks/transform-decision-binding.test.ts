import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configLoader from "../../config";
import { MagicContextConfigSchema } from "../../config/schema/magic-context";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage-db";
import {
    clearOpenCodePendingTransformDecision,
    __test as decisionLog,
    noteOpenCodeUnbustedPass,
    type PendingTransformDecision,
    recordPendingTransformDecision,
    writeRustTransformDecision,
} from "../../features/magic-context/transform-decision-log";
import {
    clearCtxReduceAvailability,
    resetCtxReduceRegisteredGloballyForTest,
} from "../../hooks/magic-context/ctx-reduce-availability";
import { resetLkgSlotsForTest } from "../../hooks/magic-context/lkg-slot";
import * as transformModule from "../../hooks/magic-context/transform";
import type { MessageLike } from "../../hooks/magic-context/transform-operations";
import { Database } from "../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { registerContext } from "./context";
import * as storageGate from "./storage-gate";
import type { SessionContext, V2Context } from "./types";

// OpenCode 2 has no per-message completion event, so a pass's transform
// decision is bound when the next context pass starts, to the first assistant
// row written after the store sequence captured before that request was sent.
// These tests drive the real OpenCode 2 context hook (system stage, staging,
// binding) with a scripted messages transform that stages decisions exactly as
// the shared transform does at the end of a pass.

const SESSION = "ses_v2_decision_rows";

function decision(busted: boolean): PendingTransformDecision {
    return {
        tsMs: Date.now(),
        decision: busted ? "execute" : "defer",
        materialized: busted,
        materializeReason: busted ? "pressure_refold" : null,
        systemHashPrev: null,
        systemHashNew: null,
        m0ModelKeyPrev: null,
        m0ModelKeyNew: null,
        emergency: false,
        droppedTokens: 0,
        droppedCount: 0,
        inputTokens: 10_000,
        bustedThisPass: busted,
    };
}

interface Fixture {
    pass(args: { busted: boolean; prompt?: string; rust?: boolean }): Promise<void>;
    reply(finish?: string): string;
    rows(): Array<{
        harness: string;
        message_id: string;
        decision: string;
        materialize_reason: string | null;
    }>;
    dispose(): Promise<void>;
}

let dir = "";
let fixture: Fixture | undefined;
const oldDataHome = process.env.XDG_DATA_HOME;
const oldOpenCodeDb = process.env.OPENCODE_DB;

beforeEach(() => {
    const parent = join(tmpdir(), "magic-context", "issue-713");
    mkdirSync(parent, { recursive: true });
    dir = createTestTempDirFromPath(join(parent, "v2-decision-rows-"));
});

afterEach(async () => {
    await fixture?.dispose();
    fixture = undefined;
    decisionLog.reset();
    closeDatabase();
    resetLkgSlotsForTest();
    resetCtxReduceRegisteredGloballyForTest();
    clearCtxReduceAvailability(SESSION);
    cleanupTestTempDir(dir);
    if (oldDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = oldDataHome;
    if (oldOpenCodeDb === undefined) delete process.env.OPENCODE_DB;
    else process.env.OPENCODE_DB = oldOpenCodeDb;
});

async function createFixture(): Promise<Fixture> {
    process.env.XDG_DATA_HOME = dir;
    process.env.OPENCODE_DB = join(dir, "opencode", "opencode.db");
    mkdirSync(join(dir, "opencode"), { recursive: true });
    const store = new Database(process.env.OPENCODE_DB);
    store.exec(
        "CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT, time_updated INTEGER); CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT NOT NULL);",
    );
    // The context hook's storage gate opens the default store under
    // XDG_DATA_HOME; the boot probe must hand back that same database.
    const db = openDatabase();
    if (!db) throw new Error("throwaway test store unavailable");
    const config = MagicContextConfigSchema.parse({
        historian: { disable: true },
        dreamer: { disable: true },
        memory: { enabled: false },
    });
    const load = spyOn(configLoader, "loadPluginConfigDetailed").mockReturnValue({
        config,
    } as ReturnType<typeof configLoader.loadPluginConfigDetailed>);
    const probe = spyOn(storageGate, "probeV2StorageAtBoot").mockResolvedValue(db);
    // Whether the scripted transform stages a busting decision on the next pass,
    // and whether it stages it the way the Rust adapter does.
    let nextBusted = false;
    let nextRust = false;
    const scriptedTransform = Object.assign(
        async (_input: unknown, output: { messages: MessageLike[] }) => {
            const sessionId = output.messages[0]?.info.sessionID ?? SESSION;
            // Like the shared transform (transform.ts): clear the staged decision
            // when a pass starts, then stage a busting decision for binding, or
            // remember a non-busting one in case the system prompt changed.
            clearOpenCodePendingTransformDecision(sessionId, output.messages);
            // The Rust adapter stages every served pass, deferred ones included.
            if (nextRust)
                writeRustTransformDecision({
                    sessionId,
                    decision: nextBusted ? "HARD" : "SOFT+",
                    materializeReason: nextBusted ? "first_render" : null,
                    inputTokens: 10_000,
                });
            else if (nextBusted) recordPendingTransformDecision(sessionId, decision(true));
            else noteOpenCodeUnbustedPass(sessionId, decision(false));
        },
        { getRustReplayParticipant: () => null, disposeRust: () => {} },
    );
    const transform = spyOn(transformModule, "createTransform").mockReturnValue(
        scriptedTransform as unknown as ReturnType<typeof transformModule.createTransform>,
    );
    let hook: ((draft: SessionContext) => Promise<void>) | undefined;
    const host = {
        location: { directory: dir },
        agent: { transform: async () => {}, reload: async () => {} },
        model: { list: () => [] },
        storage: { get: async () => undefined, set: async () => {} },
        event: { subscribe: async function* () {} },
        tool: { hook: async () => {} },
        session: {
            remove: async () => {},
            compact: async () => {},
            interrupt: mock(async () => ({ interrupted: true })),
            hook: async (name: string, callback: (draft: SessionContext) => Promise<void>) => {
                if (name === "context") hook = callback;
            },
            get: async () => ({ location: { directory: dir } }),
        },
    } as unknown as V2Context;
    resetLkgSlotsForTest();
    const duties = await registerContext(host);
    if (!hook) throw new Error("context hook was not registered");
    let seq = 0;
    let replies = 0;
    const messages: SessionContext["messages"] = [
        { id: "msg_user_1", role: "user", content: [{ type: "text", text: "start" }] },
    ];
    store
        .prepare(
            "INSERT INTO session_message (id, session_id, type, seq, time_created, data) VALUES (?, ?, 'user', ?, ?, ?)",
        )
        .run("msg_user_1", SESSION, ++seq, Date.now(), JSON.stringify({ role: "user" }));
    return {
        async pass({ busted, prompt = "Host prompt, version one.", rust = false }) {
            nextBusted = busted;
            nextRust = rust;
            await hook!({
                sessionID: SESSION,
                model: { providerID: "openai", id: "gpt-4.1", limit: { context: 1_000_000 } },
                agent: "build",
                system: [{ type: "text", text: prompt }],
                options: {},
                tools: {
                    ctx_reduce: { description: "reduce", input: { type: "object" } },
                    read: { description: "read file", input: { type: "object" } },
                },
                messages: structuredClone(messages),
            } as SessionContext);
            await new Promise((resolve) => setTimeout(resolve, 10));
        },
        reply(finish = "tool-calls") {
            const id = `msg_reply_${String(++replies).padStart(3, "0")}`;
            const now = Date.now();
            const failed = finish === "aborted" || finish === "error";
            store
                .prepare(
                    "INSERT INTO session_message (id, session_id, type, seq, time_created, data) VALUES (?, ?, 'assistant', ?, ?, ?)",
                )
                .run(
                    id,
                    SESSION,
                    ++seq,
                    now,
                    JSON.stringify({
                        time: { created: now, completed: failed ? undefined : now },
                        finish,
                        ...(failed ? { error: { name: "AbortError" } } : {}),
                        model: { providerID: "openai", id: "gpt-4.1" },
                        tokens: { input: 1000, output: 10, cache: { read: 9000, write: 0 } },
                    }),
                );
            messages.push({ id, role: "assistant", content: [{ type: "text", text: id }] });
            return id;
        },
        rows() {
            return db
                .prepare(
                    "SELECT harness, message_id, decision, materialize_reason FROM transform_decisions WHERE session_id = ? ORDER BY rowid",
                )
                .all(SESSION) as ReturnType<Fixture["rows"]>;
        },
        async dispose() {
            await duties.dispose();
            probe.mockRestore();
            transform.mockRestore();
            load.mockRestore();
            store.close();
        },
    };
}

describe("OpenCode 2 transform decision rows", () => {
    test("a tool loop with no busts writes no row", async () => {
        fixture = await createFixture();
        for (let step = 0; step < 6; step++) {
            await fixture.pass({ busted: false });
            fixture.reply();
        }
        await fixture.pass({ busted: false });
        expect(fixture.rows()).toEqual([]);
    });

    test("Rust-adapter decisions on deferred passes write no row; its busting pass writes one", async () => {
        fixture = await createFixture();
        const replies: string[] = [];
        for (let step = 0; step < 6; step++) {
            await fixture.pass({ busted: step === 4, rust: true });
            replies.push(fixture.reply());
        }
        await fixture.pass({ busted: false, rust: true });
        expect(fixture.rows()).toEqual([
            {
                harness: "opencode2",
                message_id: replies[4]!,
                decision: "execute",
                materialize_reason: "first_render",
            },
        ]);
    });

    test("a tool loop with one bust writes exactly one row, on that request's reply", async () => {
        fixture = await createFixture();
        const replies: string[] = [];
        for (let step = 0; step < 6; step++) {
            await fixture.pass({ busted: step === 2 });
            replies.push(fixture.reply());
        }
        await fixture.pass({ busted: false });
        expect(fixture.rows()).toEqual([
            {
                harness: "opencode2",
                message_id: replies[2]!,
                decision: "execute",
                materialize_reason: "pressure_refold",
            },
        ]);
    });

    test("the non-busting pass that carries a system prompt change records system_hash", async () => {
        fixture = await createFixture();
        const replies: string[] = [];
        await fixture.pass({ busted: false });
        replies.push(fixture.reply());
        await fixture.pass({ busted: false });
        replies.push(fixture.reply());
        await fixture.pass({ busted: false, prompt: "Host prompt, version two." });
        replies.push(fixture.reply());
        await fixture.pass({ busted: false, prompt: "Host prompt, version two." });
        replies.push(fixture.reply());
        await fixture.pass({ busted: false, prompt: "Host prompt, version two." });
        expect(fixture.rows()).toEqual([
            {
                harness: "opencode2",
                message_id: replies[2]!,
                decision: "defer",
                materialize_reason: "system_hash",
            },
        ]);
    });

    for (const finish of ["aborted", "error", "none"] as const) {
        test(`a busting request whose reply ${finish === "none" ? "never arrives" : `is ${finish}`} drops its row instead of binding a later reply`, async () => {
            fixture = await createFixture();
            await fixture.pass({ busted: false });
            fixture.reply();
            await fixture.pass({ busted: true });
            if (finish !== "none") fixture.reply(finish);
            // Later passes do not bust, so any row would be the dropped one
            // bound to the wrong reply.
            await fixture.pass({ busted: false });
            fixture.reply();
            await fixture.pass({ busted: false });
            fixture.reply();
            await fixture.pass({ busted: false });
            expect(fixture.rows()).toEqual([]);
        });
    }
});
