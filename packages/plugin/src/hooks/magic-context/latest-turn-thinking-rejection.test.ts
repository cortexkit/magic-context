import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../../features/magic-context/migrations";
import { createScheduler } from "../../features/magic-context/scheduler";
import { getOrCreateSessionMeta, updateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    getMergedReasoningStrippedIds,
    getThinkingBindingRecoveryTarget,
} from "../../features/magic-context/storage-meta-persisted";
import { getPendingOps, queuePendingOp } from "../../features/magic-context/storage-ops";
import { getTagsBySession } from "../../features/magic-context/storage-tags";
import { createTagger } from "../../features/magic-context/tagger";
import { __test as decisionLog } from "../../features/magic-context/transform-decision-log";
import * as logger from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { createEventHandler } from "./event-handler";
import { providerLatestTurn } from "./latest-assistant-turn";
import {
    armBindingRecoverySafely,
    armLatestThinkingRecovery,
    LATEST_THINKING_NOT_SAVED,
    LATEST_TURN_THINKING_REMOVED_REASON,
    prepareLatestThinkingRecovery,
} from "./latest-thinking-recovery";
import type { MessageLike } from "./tag-messages";
import { createTransform } from "./transform";

// Anthropic checks the thinking of the last assistant turn in a request, and a
// real user message after that turn does not end the check. These tests drive
// the recovery from that rejection the way hosts deliver it: the request that
// was refused ends in a new user message, the host leaves an empty errored
// assistant row, and every retry is one more user message.

const MODEL = "claude-opus-5-5";
const LATEST_TURN_400 =
    "messages.89.content.10: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.";
const LATEST_TURN_ERROR = { name: "APIError", statusCode: 400, data: { message: LATEST_TURN_400 } };
const NONE = { restore: false, ended: false };

function database(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function user(id: string, text = `question ${id}`, sessionID = "s"): MessageLike {
    return { info: { id, role: "user", sessionID }, parts: [{ type: "text", text }] };
}

/** A finished assistant step whose reasoning carries the provider's signature. */
function signed(id: string, signature: string, sessionID = "s"): MessageLike {
    return {
        info: {
            id,
            role: "assistant",
            sessionID,
            providerID: "anthropic",
            modelID: MODEL,
            finish: "stop",
        },
        parts: [
            {
                type: "reasoning",
                text: `thinking of ${id}`,
                metadata: { anthropic: { signature } },
            },
            { type: "text", text: `answer of ${id}` },
        ],
    };
}

/** The empty row OpenCode 1 keeps for a request the provider refused. */
function failed(id: string, sessionID = "s"): MessageLike {
    return {
        info: {
            id,
            role: "assistant",
            sessionID,
            providerID: "anthropic",
            modelID: MODEL,
            error: LATEST_TURN_ERROR,
        },
        parts: [],
    };
}

function recoveryState(db: Database, sessionId: string): Record<string, unknown> | null {
    const target = getThinkingBindingRecoveryTarget(db, sessionId);
    if (!target) return null;
    expect(target).toStartWith("latest_thinking_original_turn:");
    return JSON.parse(target.slice("latest_thinking_original_turn:".length));
}

function logged(spy: ReturnType<typeof spyOn>, text: string): boolean {
    return spy.mock.calls.some((args) => args.map(String).join(" ").includes(text));
}

describe("the provider's latest turn", () => {
    test("is the last assistant run, even after new user messages and failed rows", () => {
        const completed = [user("u0"), signed("a1", "s1"), signed("a2", "s2"), user("u1")];
        expect(providerLatestTurn(completed)).toEqual({ start: 1, first: 1, last: 2, end: 3 });
        // OpenCode 1 keeps an errored row; OpenCode 2 hands it over with no content.
        const retried = [...completed, failed("err"), user("u2")];
        expect(providerLatestTurn(retried)).toEqual({ start: 1, first: 1, last: 2, end: 3 });
        const oc2Failed: MessageLike = { info: { id: "err", role: "assistant" }, parts: [] };
        expect(providerLatestTurn([...completed, oc2Failed, user("u2")])).toEqual({
            start: 1,
            first: 1,
            last: 2,
            end: 3,
        });
        // OpenCode 1 still sends an aborted row that holds more than reasoning.
        const aborted: MessageLike = {
            info: { id: "stopped", role: "assistant", error: { name: "MessageAbortedError" } },
            parts: [{ type: "text", text: "partial" }],
        };
        expect(providerLatestTurn([...completed, aborted])).toEqual({
            start: 4,
            first: 4,
            last: 4,
            end: 5,
        });
        // Pi drops rows that stopped on an error or an abort.
        const pi = [
            { role: "user", content: "task" },
            { role: "assistant", content: [{ type: "thinking" }], stopReason: "stop" },
            { role: "user", content: "next" },
            { role: "assistant", content: [{ type: "text" }], stopReason: "error" },
            { role: "assistant", content: [{ type: "text" }], stopReason: "aborted" },
        ];
        expect(providerLatestTurn(pi)).toEqual({ start: 1, first: 1, last: 1, end: 2 });
        // Pi sends extension and bash messages as user messages: each ends a turn.
        const piWithCustom = [
            { role: "user", content: "task" },
            { role: "assistant", content: [{ type: "thinking" }], stopReason: "stop" },
            { role: "custom", customType: "notice", content: "extension note" },
            { role: "assistant", content: [{ type: "thinking" }], stopReason: "stop" },
            { role: "bashExecution", command: "ls", output: "", excludeFromContext: true },
            { role: "toolResult", content: [{ type: "text", text: "done" }] },
            { role: "user", content: "next" },
        ];
        expect(providerLatestTurn(piWithCustom)).toEqual({ start: 3, first: 3, last: 3, end: 6 });
        expect(providerLatestTurn([user("only")])).toBeUndefined();
    });
});

describe("latest-turn thinking recovery state", () => {
    const sessions: Database[] = [];
    let logs: ReturnType<typeof spyOn>;
    beforeEach(() => {
        logs = spyOn(logger, "sessionLog");
    });
    afterEach(() => {
        logs.mockRestore();
        for (const db of sessions.splice(0)) closeQuietly(db);
    });
    function fixture(sessionId: string) {
        const db = database();
        sessions.push(db);
        const messages: MessageLike[] = [
            user("u0"),
            signed("a1", "sig-fable"),
            signed("a2", "sig-fallback"),
            user("u1"),
        ];
        const prepare = (modelID: string = MODEL) =>
            prepareLatestThinkingRecovery({
                db,
                sessionId,
                messages,
                id: (message) => (message as MessageLike).info.id,
                parts: (message) => (message as MessageLike).parts,
                modelID,
            });
        /** OpenCode 1 reports one refusal as `session.error` and `message.updated`. */
        const reject = (n: number) => {
            armLatestThinkingRecovery(db, sessionId, MODEL);
            armLatestThinkingRecovery(db, sessionId, MODEL);
            messages.push(failed(`err-${n}`), user(`retry-${n}`));
        };
        return { db, messages, prepare, reject };
    }

    test("a completed turn followed by a user message loses its thinking on the retry", () => {
        const { db, messages, prepare, reject } = fixture("real-shape");
        // The pass that built the refused request.
        expect(prepare()).toEqual(NONE);
        reject(1);
        expect(recoveryState(db, "real-shape")).toMatchObject({
            stage: "armed",
            first: "a1",
            last: "a2",
            rejections: 1,
            model: MODEL,
        });
        expect(logged(logs, "latest-turn thinking recovery: armed")).toBe(true);
        expect(prepare()).toEqual({
            restore: false,
            ended: false,
            removedThisPass: true,
            removedIds: ["a1", "a2"],
        });
        expect(logged(logs, "removed thinking from the bound turn (parts=2 messages=2")).toBe(true);
        const ledger = getMergedReasoningStrippedIds(db, "real-shape");
        expect(ledger.has("binding_mismatch:a1")).toBe(true);
        expect(ledger.has("binding_mismatch:a2")).toBe(true);
        // Later passes replay the saved removal; nothing new is decided. The
        // recovery still names the turn's removed ids, so a host that runs its
        // pipeline twice in one pass can strip them on the second run too.
        messages.push(user("u3"));
        expect(prepare()).toEqual({ ...NONE, removedIds: ["a1", "a2"] });
        expect(getMergedReasoningStrippedIds(db, "real-shape")).toEqual(ledger);
    });

    test("three retries never resend the turn's thinking and only the third rejection refuses", () => {
        const { db, prepare, reject } = fixture("loop");
        prepare();
        reject(1);
        expect(prepare().removedIds).toEqual(["a1", "a2"]);
        reject(2);
        // The removed request is served once more; its thinking stays omitted.
        expect(prepare()).toEqual({ ...NONE, removedIds: ["a1", "a2"] });
        expect(recoveryState(db, "loop")).toMatchObject({ stage: "removed", rejections: 2 });
        reject(3);
        expect(() => prepare()).toThrow("ANTHROPIC_LATEST_TURN_EDIT_UNSAFE");
        expect(() => prepare()).toThrow("Sending a new message does not help");
        expect(logged(logs, "refused locally")).toBe(true);
        // Switching the model once sends the turn's thinking as text, so the
        // refusal ends.
        expect(prepare("claude-sonnet-5-5")).toEqual(NONE);
        expect(getThinkingBindingRecoveryTarget(db, "loop")).toBeNull();
        expect(logged(logs, "unbound because the request now goes to claude-sonnet-5-5")).toBe(
            true,
        );
    });

    test("an accepted request after the removal unbinds, and a later turn keeps its thinking", () => {
        const { db, messages, prepare, reject } = fixture("accepted");
        prepare();
        reject(1);
        expect(prepare().removedThisPass).toBe(true);
        messages.push(signed("a3", "sig-new"));
        expect(prepare()).toEqual(NONE);
        expect(getThinkingBindingRecoveryTarget(db, "accepted")).toBeNull();
        expect(logged(logs, "unbound because a newer turn was accepted")).toBe(true);
        expect(getMergedReasoningStrippedIds(db, "accepted").has("binding_mismatch:a3")).toBe(
            false,
        );
    });

    test("a turn that went on after its removal has only its new thinking removed when rejected again", () => {
        const { db, messages, prepare } = fixture("continued");
        // An open tool loop: the request ends in the turn's own assistant message.
        messages.pop();
        prepare();
        armLatestThinkingRecovery(db, "continued", MODEL);
        expect(prepare().removedIds).toEqual(["a1", "a2"]);
        messages.push(signed("a3", "sig-later-step"));
        expect(prepare()).toEqual({ ...NONE, removedIds: ["a1", "a2"] });
        expect(recoveryState(db, "continued")).toMatchObject({ stage: "removed", accepted: true });
        armLatestThinkingRecovery(db, "continued", MODEL);
        const again = prepare();
        expect(again.removedThisPass).toBe(true);
        expect(again.removedIds).toEqual(["a1", "a2", "a3"]);
        expect(logged(logs, "removed thinking from the bound turn (parts=1 messages=1")).toBe(true);
    });

    test("the model a failure event names never unbinds a turn bound by the pass's own model", () => {
        const { db, messages, prepare } = fixture("model-alias");
        const pass = (modelID: string, providerID: string) =>
            prepareLatestThinkingRecovery({
                db,
                sessionId: "model-alias",
                messages,
                id: (message) => (message as MessageLike).info.id,
                parts: (message) => (message as MessageLike).parts,
                modelID,
                providerID,
            });
        pass(MODEL, "anthropic");
        // The failure event spells the model the way its provider route does.
        armLatestThinkingRecovery(db, "model-alias", "anthropic/Claude-Opus-5.5");
        expect(recoveryState(db, "model-alias")).toMatchObject({
            model: MODEL,
            provider: "anthropic",
        });
        messages.push(failed("err-1"), user("retry-1"));
        expect(pass(MODEL, "anthropic").removedThisPass).toBe(true);
        // The same model id through another provider is a different route.
        expect(pass(MODEL, "google-vertex-anthropic")).toEqual(NONE);
        expect(getThinkingBindingRecoveryTarget(db, "model-alias")).toBeNull();
        expect(
            logged(logs, "unbound because the request now goes through google-vertex-anthropic"),
        ).toBe(true);
    });

    test("a removal that cannot be saved refuses with its own words and leaves the turn armed", () => {
        const { db, messages, prepare } = fixture("unsaved");
        prepare();
        armLatestThinkingRecovery(db, "unsaved", MODEL);
        messages.push(failed("err-1"), user("retry-1"));
        const busy = () =>
            prepareLatestThinkingRecovery({
                db,
                sessionId: "unsaved",
                messages,
                id: (message) => (message as MessageLike).info.id,
                parts: (message) => (message as MessageLike).parts,
                modelID: MODEL,
                persistRemoval: () => false,
            });
        expect(busy).toThrow(LATEST_THINKING_NOT_SAVED);
        expect(busy).not.toThrow("restored or removed");
        expect(recoveryState(db, "unsaved")).toMatchObject({ stage: "armed", rejections: 1 });
        expect(getMergedReasoningStrippedIds(db, "unsaved").has("binding_mismatch:a1")).toBe(false);
        // The next pass, with the store available again, removes the thinking.
        expect(prepare().removedIds).toEqual(["a1", "a2"]);
    });

    test("a binding 400 after the turn was refused goes to the binding recovery", () => {
        const { db, prepare, reject } = fixture("refused-binding");
        prepare();
        for (const n of [1, 2, 3]) {
            reject(n);
            if (n < 3) prepare();
        }
        expect(recoveryState(db, "refused-binding")).toMatchObject({ stage: "refused" });
        armBindingRecoverySafely(db, "refused-binding");
        expect(getThinkingBindingRecoveryTarget(db, "refused-binding")).toBe(
            "all_reasoning_bearing_assistants",
        );
        expect(
            logged(logs, "binding rejection handed to the binding recovery (stage=refused)"),
        ).toBe(true);
        // The next pass sees no latest-turn state: it neither refuses nor
        // restores, and the turn's removal stays in the ledger.
        expect(prepare()).toEqual(NONE);
        expect(
            getMergedReasoningStrippedIds(db, "refused-binding").has("binding_mismatch:a1"),
        ).toBe(true);
    });
});

describe("OpenCode 1 transform", () => {
    test("the retry removes only the rejected turn's thinking, keeps queued drops and earlier bytes, and replays", async () => {
        decisionLog.reset();
        const db = database();
        const sessionId = "oc1-latest-turn";
        getOrCreateSessionMeta(db, sessionId);
        const transform = createTransform({
            db,
            tagger: createTagger(),
            scheduler: createScheduler({ executeThresholdPercentage: 65 }),
            liveModelBySession: new Map([[sessionId, { providerID: "anthropic", modelID: MODEL }]]),
            contextUsageMap: new Map([
                [
                    sessionId,
                    {
                        usage: { percentage: 30, inputTokens: 30_000 },
                        updatedAt: Date.now(),
                        hasUsageTokens: true,
                    },
                ],
            ]),
            clearReasoningAge: 1000,
            protectedTokens: 4000,
            historyRefreshSessions: new Set(),
            pendingMaterializationSessions: new Set(),
            lastHeuristicsTurnId: new Map(),
        });
        const conversation: MessageLike[] = [
            user("old-u", "old task", sessionId),
            {
                info: { id: "old-a", role: "assistant", sessionID: sessionId },
                parts: [
                    { type: "text", text: "reading" },
                    {
                        type: "tool",
                        tool: "read",
                        callID: "old-call",
                        state: { status: "completed", input: {}, output: "old output" },
                    },
                ],
            },
            user("u0", "task", sessionId),
            signed("a1", "sig-fable", sessionId),
            signed("a2", "sig-fallback", sessionId),
            user("u1", "next question", sessionId),
        ];
        const pass = async (messages: MessageLike[]) => {
            const copy = structuredClone(messages);
            await transform({}, { messages: copy });
            return copy;
        };
        const beforeTurn = (messages: MessageLike[]) =>
            JSON.stringify(
                messages.slice(
                    0,
                    messages.findIndex((message) => message.info.id === "a1"),
                ),
            );
        const logs = spyOn(logger, "sessionLog");
        try {
            await pass(conversation);
            const tool = getTagsBySession(db, sessionId).find((tag) => tag.type === "tool");
            expect(tool).toBeDefined();
            queuePendingOp(db, sessionId, tool!.tagNumber, "drop");
            const rejected = await pass(conversation);
            expect(JSON.stringify(rejected)).toContain("sig-fable");
            expect(JSON.stringify(rejected)).toContain("sig-fallback");
            armLatestThinkingRecovery(db, sessionId, MODEL);
            const retry = [
                ...conversation,
                failed("err-1", sessionId),
                user("u2", "please continue", sessionId),
            ];
            const served = await pass(retry);
            expect(JSON.stringify(served)).not.toContain("sig-fable");
            expect(JSON.stringify(served)).not.toContain("sig-fallback");
            expect(beforeTurn(served)).toBe(beforeTurn(rejected));
            // Not a rebuild: the queued drop below the threshold stays queued.
            expect(getPendingOps(db, sessionId)).toHaveLength(1);
            expect(decisionLog.getPending(sessionId)).toMatchObject({
                materializeReason: LATEST_TURN_THINKING_REMOVED_REASON,
                bustedThisPass: true,
            });
            expect(logged(logs, "removed thinking from the bound turn (parts=2 messages=2")).toBe(
                true,
            );
            // The next pass replays the removal byte for byte.
            expect(JSON.stringify(await pass(retry))).toBe(JSON.stringify(served));
            expect(getPendingOps(db, sessionId)).toHaveLength(1);
        } finally {
            logs.mockRestore();
            closeQuietly(db);
        }
    });

    test("a removal on an idle-expired pass records its own reason, not the idle expiry", async () => {
        decisionLog.reset();
        const db = database();
        const sessionId = "oc1-latest-turn-idle";
        getOrCreateSessionMeta(db, sessionId);
        const transform = createTransform({
            db,
            tagger: createTagger(),
            scheduler: createScheduler({ executeThresholdPercentage: 65 }),
            liveModelBySession: new Map([[sessionId, { providerID: "anthropic", modelID: MODEL }]]),
            contextUsageMap: new Map(),
            clearReasoningAge: 1000,
            protectedTokens: 4000,
            historyRefreshSessions: new Set(),
            pendingMaterializationSessions: new Set(),
            lastHeuristicsTurnId: new Map(),
        });
        const conversation: MessageLike[] = [
            user("u0", "task", sessionId),
            signed("a1", "sig-fable", sessionId),
            signed("a2", "sig-fallback", sessionId),
            user("u1", "next question", sessionId),
        ];
        const pass = async (messages: MessageLike[]) => {
            const copy = structuredClone(messages);
            await transform({}, { messages: copy });
            return copy;
        };
        try {
            await pass(conversation);
            await pass(conversation);
            armLatestThinkingRecovery(db, sessionId, MODEL);
            // The user comes back after the provider cache expired.
            updateSessionMeta(db, sessionId, {
                cacheTtl: "5m",
                lastResponseTime: Date.now() - 60 * 60 * 1000,
            });
            const retry = [
                ...conversation,
                failed("err-1", sessionId),
                user("u2", "please continue", sessionId),
            ];
            expect(JSON.stringify(await pass(retry))).not.toContain("sig-fable");
            expect(decisionLog.getPending(sessionId)).toMatchObject({
                materializeReason: LATEST_TURN_THINKING_REMOVED_REASON,
                bustedThisPass: true,
            });
            // Control: the next pass, still idle-expired but with nothing new to
            // remove, records the idle expiry.
            decisionLog.reset();
            await pass(retry);
            expect(decisionLog.getPending(sessionId)?.materializeReason).toBe("ttl_idle");
        } finally {
            closeQuietly(db);
        }
    });
});

describe("OpenCode 1 arm sites", () => {
    let dataHome: string;
    let previousDataHome: string | undefined;
    beforeEach(() => {
        previousDataHome = process.env.XDG_DATA_HOME;
        dataHome = createTestTempDirFromPath(join(tmpdir(), "latest-turn-arm-"));
        process.env.XDG_DATA_HOME = dataHome;
    });
    afterEach(() => {
        if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = previousDataHome;
        rmSync(dataHome, { recursive: true, force: true });
    });
    const deps = (db: Database, compactionOff = false) => ({
        contextUsageMap: new Map(),
        compactionHandler: { onCompacted: mock(() => {}) },
        config: { cache_ttl: "5m" as string | Record<string, string> },
        tagger: {
            assignTag: mock(() => 0),
            bindTag: mock(() => {}),
            getTag: mock(() => undefined),
            getAssignments: mock(() => new Map()),
            resetCounter: mock(() => {}),
            getCounter: mock(() => 0),
            initFromDb: mock(() => {}),
            cleanup: mock(() => {}),
        },
        db,
        client: {},
        compactionOff,
    });
    /** The pass that built the request the provider then refuses. */
    const servePass = (db: Database, sessionId: string) =>
        prepareLatestThinkingRecovery({
            db,
            sessionId,
            messages: [
                user("u0", "task", sessionId),
                signed("a1", "sig-fable", sessionId),
                signed("a2", "sig-fallback", sessionId),
                user("u1", "next", sessionId),
            ],
            id: (message) => (message as MessageLike).info.id,
            parts: (message) => (message as MessageLike).parts,
            modelID: MODEL,
        });
    const messageUpdated = (sessionID: string, providerID = "anthropic", modelID = MODEL) => ({
        event: {
            type: "message.updated",
            properties: {
                info: {
                    id: "err-1",
                    role: "assistant",
                    sessionID,
                    providerID,
                    modelID,
                    error: LATEST_TURN_ERROR,
                },
            },
        },
    });
    /** OpenCode 1's store, which `session.error` reads the failed request's model from. */
    const seedOpenCodeStore = (sessionId: string) => {
        mkdirSync(join(dataHome, "opencode"), { recursive: true });
        const store = new Database(join(dataHome, "opencode", "opencode.db"));
        store.exec("PRAGMA journal_mode=WAL");
        store.exec(
            "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
        );
        store
            .prepare("INSERT INTO message VALUES (?, ?, 1, 1, ?)")
            .run(
                "err-1",
                sessionId,
                JSON.stringify({ role: "assistant", providerID: "anthropic", modelID: MODEL }),
            );
        store.close();
    };

    test("message.updated and session.error arm the turn of the last pass and count one rejection", async () => {
        const db = database();
        try {
            const sessionId = "oc1-arm";
            seedOpenCodeStore(sessionId);
            servePass(db, sessionId);
            const handler = createEventHandler(deps(db) as never);
            await handler(messageUpdated(sessionId));
            expect(recoveryState(db, sessionId)).toMatchObject({
                stage: "armed",
                first: "a1",
                last: "a2",
                rejections: 1,
                model: MODEL,
            });
            await handler({
                event: {
                    type: "session.error",
                    properties: { sessionID: sessionId, error: LATEST_TURN_ERROR },
                },
            });
            expect(recoveryState(db, sessionId)).toMatchObject({ stage: "armed", rejections: 1 });
        } finally {
            closeQuietly(db);
        }
    });

    test("session.error alone arms the recovery", async () => {
        const db = database();
        try {
            const sessionId = "oc1-arm-session-error";
            seedOpenCodeStore(sessionId);
            servePass(db, sessionId);
            await createEventHandler(deps(db) as never)({
                event: {
                    type: "session.error",
                    properties: { sessionID: sessionId, error: LATEST_TURN_ERROR },
                },
            });
            expect(recoveryState(db, sessionId)).toMatchObject({ stage: "armed", first: "a1" });
        } finally {
            closeQuietly(db);
        }
    });

    test("a non-Anthropic route and compaction-off leave the session untouched", async () => {
        const db = database();
        try {
            servePass(db, "oc1-openai");
            await createEventHandler(deps(db) as never)(
                messageUpdated("oc1-openai", "openai", "gpt-5"),
            );
            expect(getThinkingBindingRecoveryTarget(db, "oc1-openai")).toBeNull();
            servePass(db, "oc1-off");
            await createEventHandler(deps(db, true) as never)(messageUpdated("oc1-off"));
            expect(getThinkingBindingRecoveryTarget(db, "oc1-off")).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });
});
