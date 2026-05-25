/// <reference types="bun-types" />

/**
 * Synthetic-todowrite injection tests covering all 7 branches of the
 * todo state placement logic in transform-postprocess-phase.ts.
 *
 * Cache-safety invariant under test: defer-pass replays produce
 * byte-identical message shape to the previous defer pass on the same
 * data. We verify by:
 *   1. Snapshotting the synthetic part after a cache-busting pass.
 *   2. Running multiple defer passes in sequence.
 *   3. Asserting each defer pass leaves the message array structurally
 *      identical (same tool callID, same anchor message, same input).
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    clearPersistedTodoSyntheticAnchor,
    closeDatabase,
    getOrCreateSessionMeta,
    getPersistedTodoSyntheticAnchor,
    openDatabase,
    setPersistedTodoSyntheticAnchor,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { buildSyntheticTodoPart, computeSyntheticCallId, isSyntheticTodoPart } from "./todo-view";
import {
    injectToolPartIntoAssistantById,
    injectToolPartIntoLatestAssistant,
} from "./transform-message-helpers";
import type { MessageLike } from "./transform-operations";

const tempDirs: string[] = [];

function useTempDataHome(prefix: string): void {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

afterEach(() => {
    closeDatabase();
    for (const dir of tempDirs)
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* Ignore EBUSY on Windows */
        }
    tempDirs.length = 0;
    process.env.XDG_DATA_HOME = undefined;
});

const ACTIVE_TODOS_JSON = JSON.stringify([
    { content: "Build feature", status: "in_progress", priority: "high" },
    { content: "Write tests", status: "pending", priority: "medium" },
]);

const TERMINAL_TODOS_JSON = JSON.stringify([
    { content: "All done", status: "completed", priority: "high" },
]);

function buildMessages(): MessageLike[] {
    return [
        {
            info: { id: "msg-user-1", role: "user", sessionID: "ses-1" },
            parts: [{ type: "text", text: "Please help me" }],
        },
        {
            info: { id: "msg-asst-1", role: "assistant", sessionID: "ses-1" },
            parts: [{ type: "text", text: "On it" }],
        },
        {
            info: { id: "msg-user-2", role: "user", sessionID: "ses-1" },
            parts: [{ type: "text", text: "Now please add tests" }],
        },
        {
            info: { id: "msg-asst-2", role: "assistant", sessionID: "ses-1" },
            parts: [{ type: "text", text: "Working on it" }],
        },
    ];
}

/**
 * Mirrors the production logic at transform-postprocess-phase.ts:712-790.
 * Pulled out into a helper so we can drive it with explicit inputs from
 * tests without booting the full transform pipeline. Must stay in sync
 * with the production code.
 */
function runTodoSynthesis(args: {
    db: ReturnType<typeof openDatabase>;
    sessionId: string;
    messages: MessageLike[];
    isCacheBustingPass: boolean;
    fullFeatureMode: boolean;
}): void {
    if (!args.fullFeatureMode) return;
    const { db, sessionId, messages, isCacheBustingPass } = args;
    const sessionMeta = getOrCreateSessionMeta(db, sessionId);
    const persistedAnchor = getPersistedTodoSyntheticAnchor(db, sessionId);

    if (isCacheBustingPass) {
        const part = buildSyntheticTodoPart(sessionMeta.lastTodoState);
        if (part === null) {
            if (persistedAnchor) clearPersistedTodoSyntheticAnchor(db, sessionId);
            return;
        }
        if (
            persistedAnchor &&
            persistedAnchor.callId === part.callID &&
            injectToolPartIntoAssistantById(messages, persistedAnchor.messageId, part)
        ) {
            // Mirror production: backfill stateJson if it's empty (legacy upgrade row).
            if (persistedAnchor.stateJson.length === 0) {
                setPersistedTodoSyntheticAnchor(
                    db,
                    sessionId,
                    persistedAnchor.callId,
                    persistedAnchor.messageId,
                    sessionMeta.lastTodoState,
                );
            }
            return;
        }
        const anchoredMessageId = injectToolPartIntoLatestAssistant(messages, part);
        if (anchoredMessageId) {
            setPersistedTodoSyntheticAnchor(
                db,
                sessionId,
                part.callID,
                anchoredMessageId,
                sessionMeta.lastTodoState,
            );
        } else if (persistedAnchor) {
            clearPersistedTodoSyntheticAnchor(db, sessionId);
        }
    } else if (persistedAnchor && persistedAnchor.stateJson.length > 0) {
        // Defer pass — replay rebuilds from PERSISTED stateJson, NOT from
        // sessionMeta.lastTodoState. Council Finding #1 fix.
        const part = buildSyntheticTodoPart(persistedAnchor.stateJson);
        if (part !== null && part.callID === persistedAnchor.callId) {
            injectToolPartIntoAssistantById(messages, persistedAnchor.messageId, part);
        }
    }
}

function findSyntheticPart(messages: MessageLike[]): { messageId: string; part: unknown } | null {
    for (const msg of messages) {
        for (const part of msg.parts) {
            if (isSyntheticTodoPart(part)) {
                return { messageId: msg.info.id ?? "", part };
            }
        }
    }
    return null;
}

function countSyntheticParts(messages: MessageLike[]): number {
    let n = 0;
    for (const msg of messages) {
        for (const part of msg.parts) {
            if (isSyntheticTodoPart(part)) n += 1;
        }
    }
    return n;
}

describe("todo state synthesis — cache-busting branches", () => {
    it("Branch 1: cache-bust + render null + no sticky → no-op", () => {
        useTempDataHome("todo-b1-");
        const db = openDatabase();
        getOrCreateSessionMeta(db, "ses-1"); // ensure row
        const messages = buildMessages();
        runTodoSynthesis({
            db,
            sessionId: "ses-1",
            messages,
            isCacheBustingPass: true,
            fullFeatureMode: true,
        });
        expect(countSyntheticParts(messages)).toBe(0);
        expect(getPersistedTodoSyntheticAnchor(db, "ses-1")).toBeNull();
    });

    it("Branch 2: cache-bust + render null + sticky exists → DB clear, no message mutation", () => {
        useTempDataHome("todo-b2-");
        const db = openDatabase();
        // Set sticky
        // Sticky carries an old active state JSON; current snapshot is terminal-only.
        setPersistedTodoSyntheticAnchor(
            db,
            "ses-1",
            "mc_synthetic_todo_old",
            "msg-asst-1",
            ACTIVE_TODOS_JSON,
        );
        updateSessionMeta(db, "ses-1", { lastTodoState: TERMINAL_TODOS_JSON });

        const messages = buildMessages();
        runTodoSynthesis({
            db,
            sessionId: "ses-1",
            messages,
            isCacheBustingPass: true,
            fullFeatureMode: true,
        });

        expect(countSyntheticParts(messages)).toBe(0);
        expect(getPersistedTodoSyntheticAnchor(db, "ses-1")).toBeNull();
    });

    it("Branch 3: cache-bust + render same as sticky + anchor present → idempotent re-inject", () => {
        useTempDataHome("todo-b3-");
        const db = openDatabase();
        const expectedCallId = computeSyntheticCallId(ACTIVE_TODOS_JSON);
        updateSessionMeta(db, "ses-1", { lastTodoState: ACTIVE_TODOS_JSON });
        setPersistedTodoSyntheticAnchor(
            db,
            "ses-1",
            expectedCallId,
            "msg-asst-2",
            ACTIVE_TODOS_JSON,
        );

        const messages = buildMessages();
        // Pre-seed: pretend the part is already in messages (simulates state
        // already injected on a prior pass that's now persisted).
        const part = buildSyntheticTodoPart(ACTIVE_TODOS_JSON);
        if (!part) throw new Error("part null");
        const asst2 = messages.find((m) => m.info.id === "msg-asst-2");
        if (!asst2) throw new Error("asst-2 missing");
        asst2.parts.push(part);

        runTodoSynthesis({
            db,
            sessionId: "ses-1",
            messages,
            isCacheBustingPass: true,
            fullFeatureMode: true,
        });

        // Idempotent: still exactly one synthetic part on msg-asst-2.
        expect(countSyntheticParts(messages)).toBe(1);
        const found = findSyntheticPart(messages);
        expect(found?.messageId).toBe("msg-asst-2");
        expect(getPersistedTodoSyntheticAnchor(db, "ses-1")).toEqual({
            callId: expectedCallId,
            messageId: "msg-asst-2",
            stateJson: ACTIVE_TODOS_JSON,
        });
    });

    it("Branch 3 (fresh-message variant): cache-bust + matching anchor + no pre-seeded synthetic → injection lands at persisted anchor", () => {
        // Realistic Branch 3: OpenCode rebuilds messages from its DB every
        // pass (no synthetic part survives), but our persisted anchor still
        // matches. Injection should land at the persisted anchor message,
        // not at the LATEST assistant. Closes Council Finding #8.
        useTempDataHome("todo-b3-fresh-");
        const db = openDatabase();
        const callId = computeSyntheticCallId(ACTIVE_TODOS_JSON);
        updateSessionMeta(db, "ses-1", { lastTodoState: ACTIVE_TODOS_JSON });
        // Anchor at msg-asst-1, NOT the latest assistant.
        setPersistedTodoSyntheticAnchor(db, "ses-1", callId, "msg-asst-1", ACTIVE_TODOS_JSON);

        const messages = buildMessages(); // fresh, no synthetic seeded

        runTodoSynthesis({
            db,
            sessionId: "ses-1",
            messages,
            isCacheBustingPass: true,
            fullFeatureMode: true,
        });

        expect(countSyntheticParts(messages)).toBe(1);
        const found = findSyntheticPart(messages);
        // Lands at the PERSISTED anchor (asst-1), not the latest (asst-2).
        // injectToolPartIntoAssistantById succeeded → no fall-through to fresh.
        expect(found?.messageId).toBe("msg-asst-1");
        // Anchor unchanged.
        expect(getPersistedTodoSyntheticAnchor(db, "ses-1")).toEqual({
            callId,
            messageId: "msg-asst-1",
            stateJson: ACTIVE_TODOS_JSON,
        });
    });

    it("Branch 4: cache-bust + sticky callId matches but anchor missing → re-anchor + persist", () => {
        useTempDataHome("todo-b4-");
        const db = openDatabase();
        const callId = computeSyntheticCallId(ACTIVE_TODOS_JSON);
        updateSessionMeta(db, "ses-1", { lastTodoState: ACTIVE_TODOS_JSON });
        setPersistedTodoSyntheticAnchor(db, "ses-1", callId, "msg-gone", ACTIVE_TODOS_JSON);

        const messages = buildMessages(); // no msg-gone

        runTodoSynthesis({
            db,
            sessionId: "ses-1",
            messages,
            isCacheBustingPass: true,
            fullFeatureMode: true,
        });

        expect(countSyntheticParts(messages)).toBe(1);
        const found = findSyntheticPart(messages);
        expect(found?.messageId).toBe("msg-asst-2"); // latest assistant
        const anchor = getPersistedTodoSyntheticAnchor(db, "ses-1");
        expect(anchor?.callId).toBe(callId);
        expect(anchor?.messageId).toBe("msg-asst-2"); // re-anchored
    });

    it("Branch 5: cache-bust + render different from sticky → fresh inject + persist new callId", () => {
        useTempDataHome("todo-b5-");
        const db = openDatabase();
        const oldCallId = "mc_synthetic_todo_oldoldoldoldold0";
        const newCallId = computeSyntheticCallId(ACTIVE_TODOS_JSON);
        updateSessionMeta(db, "ses-1", { lastTodoState: ACTIVE_TODOS_JSON });
        // Old persisted state was terminal-shaped (different content) → different callId.
        setPersistedTodoSyntheticAnchor(db, "ses-1", oldCallId, "msg-asst-1", TERMINAL_TODOS_JSON);

        const messages = buildMessages();
        runTodoSynthesis({
            db,
            sessionId: "ses-1",
            messages,
            isCacheBustingPass: true,
            fullFeatureMode: true,
        });

        expect(countSyntheticParts(messages)).toBe(1);
        const anchor = getPersistedTodoSyntheticAnchor(db, "ses-1");
        expect(anchor?.callId).toBe(newCallId);
        expect(anchor?.callId).not.toBe(oldCallId);
        expect(anchor?.messageId).toBe("msg-asst-2");
    });

    it("Branch 5b: cache-bust + render and no assistant message in window → clears stale anchor", () => {
        useTempDataHome("todo-b5b-");
        const db = openDatabase();
        const oldCallId = "mc_synthetic_todo_stalestale00000a";
        updateSessionMeta(db, "ses-1", { lastTodoState: ACTIVE_TODOS_JSON });
        setPersistedTodoSyntheticAnchor(db, "ses-1", oldCallId, "msg-prior", ACTIVE_TODOS_JSON);

        // No assistant messages in this window
        const messages: MessageLike[] = [
            {
                info: { id: "msg-user-only", role: "user", sessionID: "ses-1" },
                parts: [{ type: "text", text: "hi" }],
            },
        ];

        runTodoSynthesis({
            db,
            sessionId: "ses-1",
            messages,
            isCacheBustingPass: true,
            fullFeatureMode: true,
        });

        expect(countSyntheticParts(messages)).toBe(0);
        expect(getPersistedTodoSyntheticAnchor(db, "ses-1")).toBeNull();
    });
});

describe("todo state synthesis — defer branches and byte stability", () => {
    it("Branch 6: defer + sticky exists → byte-identical replay only", () => {
        useTempDataHome("todo-b6-");
        const db = openDatabase();
        const callId = computeSyntheticCallId(ACTIVE_TODOS_JSON);
        updateSessionMeta(db, "ses-1", { lastTodoState: ACTIVE_TODOS_JSON });
        setPersistedTodoSyntheticAnchor(db, "ses-1", callId, "msg-asst-2", ACTIVE_TODOS_JSON);

        const messages = buildMessages();
        runTodoSynthesis({
            db,
            sessionId: "ses-1",
            messages,
            isCacheBustingPass: false,
            fullFeatureMode: true,
        });

        expect(countSyntheticParts(messages)).toBe(1);
        const found = findSyntheticPart(messages);
        expect(found?.messageId).toBe("msg-asst-2");
        // Anchor unchanged
        expect(getPersistedTodoSyntheticAnchor(db, "ses-1")).toEqual({
            callId,
            messageId: "msg-asst-2",
            stateJson: ACTIVE_TODOS_JSON,
        });
    });

    it("Branch 7: defer + no sticky → no-op", () => {
        useTempDataHome("todo-b7-");
        const db = openDatabase();
        updateSessionMeta(db, "ses-1", { lastTodoState: ACTIVE_TODOS_JSON });

        const messages = buildMessages();
        runTodoSynthesis({
            db,
            sessionId: "ses-1",
            messages,
            isCacheBustingPass: false,
            fullFeatureMode: true,
        });

        expect(countSyntheticParts(messages)).toBe(0);
        expect(getPersistedTodoSyntheticAnchor(db, "ses-1")).toBeNull();
    });

    it("CACHE STABILITY: 5 consecutive defer passes produce byte-identical message arrays", () => {
        useTempDataHome("todo-stable-");
        const db = openDatabase();
        const callId = computeSyntheticCallId(ACTIVE_TODOS_JSON);
        updateSessionMeta(db, "ses-1", { lastTodoState: ACTIVE_TODOS_JSON });
        setPersistedTodoSyntheticAnchor(db, "ses-1", callId, "msg-asst-2", ACTIVE_TODOS_JSON);

        // Snapshot after first defer pass
        const initialMessages = buildMessages();
        runTodoSynthesis({
            db,
            sessionId: "ses-1",
            messages: initialMessages,
            isCacheBustingPass: false,
            fullFeatureMode: true,
        });
        const baseline = JSON.stringify(initialMessages);

        // Run 5 more defer passes from FRESH messages each time (simulates
        // OpenCode rebuilding the message array from its DB on every pass).
        for (let i = 0; i < 5; i += 1) {
            const messages = buildMessages();
            runTodoSynthesis({
                db,
                sessionId: "ses-1",
                messages,
                isCacheBustingPass: false,
                fullFeatureMode: true,
            });
            expect(JSON.stringify(messages)).toBe(baseline);
        }
    });

    it("CACHE STABILITY: defer replays PERSISTED state JSON, not last_todo_state (Council Finding #1)", () => {
        // The critical scenario: between cache-bust T0 and defer T1, a real
        // todowrite mutates last_todo_state. The defer pass MUST replay the
        // OLD state at the OLD anchor (what T0 emitted) so prefix bytes stay
        // identical. Without this, T1 diverges from T0 at the anchor and
        // breaks Anthropic prompt cache.
        useTempDataHome("todo-finding1-");
        const db = openDatabase();
        // T0 injected ACTIVE_TODOS_JSON at msg-asst-2 with the matching callId.
        const oldCallId = computeSyntheticCallId(ACTIVE_TODOS_JSON);
        setPersistedTodoSyntheticAnchor(db, "ses-1", oldCallId, "msg-asst-2", ACTIVE_TODOS_JSON);
        // Then the agent called real todowrite that updated last_todo_state.
        const newState = JSON.stringify([
            { content: "Brand new todo", status: "pending", priority: "low" },
        ]);
        updateSessionMeta(db, "ses-1", { lastTodoState: newState });

        const messages = buildMessages();
        runTodoSynthesis({
            db,
            sessionId: "ses-1",
            messages,
            isCacheBustingPass: false,
            fullFeatureMode: true,
        });

        // Defer replays the OLD state — still exactly one synthetic part,
        // with the OLD callId (matching what T0 sent on the wire).
        expect(countSyntheticParts(messages)).toBe(1);
        const found = findSyntheticPart(messages);
        expect(found?.messageId).toBe("msg-asst-2");
        const part = found?.part as { callID?: string };
        expect(part?.callID).toBe(oldCallId);
        // Anchor unchanged — next cache-bust will pick up newState.
        expect(getPersistedTodoSyntheticAnchor(db, "ses-1")).toEqual({
            callId: oldCallId,
            messageId: "msg-asst-2",
            stateJson: ACTIVE_TODOS_JSON,
        });
    });

    it("CACHE STABILITY: T0 cache-bust → T1 defer with fresh messages → byte-identical (Council Finding #3)", () => {
        // The end-to-end T0→T1 stability test: cache-bust pass at T0 from
        // fresh messages, snapshot stringified output, rebuild messages from
        // scratch (simulates OpenCode reloading from its DB), run defer pass
        // at T1, assert identical bytes.
        useTempDataHome("todo-t0-t1-");
        const db = openDatabase();
        updateSessionMeta(db, "ses-1", { lastTodoState: ACTIVE_TODOS_JSON });

        // T0: cache-bust pass injects + persists.
        const t0Messages = buildMessages();
        runTodoSynthesis({
            db,
            sessionId: "ses-1",
            messages: t0Messages,
            isCacheBustingPass: true,
            fullFeatureMode: true,
        });
        const t0Bytes = JSON.stringify(t0Messages);
        // Sanity: synthetic landed.
        expect(countSyntheticParts(t0Messages)).toBe(1);

        // T1: defer pass starts from fresh messages (OpenCode rebuilds from DB).
        const t1Messages = buildMessages();
        runTodoSynthesis({
            db,
            sessionId: "ses-1",
            messages: t1Messages,
            isCacheBustingPass: false,
            fullFeatureMode: true,
        });
        const t1Bytes = JSON.stringify(t1Messages);

        expect(t1Bytes).toBe(t0Bytes);
    });

    it("CACHE STABILITY: T0 cache-bust → real todowrite → T1 defer → still byte-identical (Council Finding #1 e2e)", () => {
        // The exact T0-state-changed-T1 scenario as an integration test.
        // T0 injects ACTIVE_TODOS_JSON; then the agent's real todowrite
        // updates last_todo_state; then T1 runs as a defer pass. T1 bytes
        // must equal T0 bytes.
        useTempDataHome("todo-t0-t1-changed-");
        const db = openDatabase();
        updateSessionMeta(db, "ses-1", { lastTodoState: ACTIVE_TODOS_JSON });

        const t0Messages = buildMessages();
        runTodoSynthesis({
            db,
            sessionId: "ses-1",
            messages: t0Messages,
            isCacheBustingPass: true,
            fullFeatureMode: true,
        });
        const t0Bytes = JSON.stringify(t0Messages);

        // Real todowrite fires between T0 and T1, updating last_todo_state.
        const newState = JSON.stringify([
            { content: "different", status: "in_progress", priority: "high" },
        ]);
        updateSessionMeta(db, "ses-1", { lastTodoState: newState });

        const t1Messages = buildMessages();
        runTodoSynthesis({
            db,
            sessionId: "ses-1",
            messages: t1Messages,
            isCacheBustingPass: false,
            fullFeatureMode: true,
        });
        const t1Bytes = JSON.stringify(t1Messages);

        // T1 must equal T0 byte-for-byte even though last_todo_state changed.
        expect(t1Bytes).toBe(t0Bytes);
    });

    it("CACHE STABILITY: legacy row with empty stateJson self-heals on cache-bust + replays on next defer (Oracle final audit)", () => {
        // The exact upgrade scenario Oracle's final audit flagged:
        // a user on the original v0.17 build had `(callId, messageId, stateJson='')`
        // persisted because that build only stored callId+messageId. The v11
        // migration's DEFAULT '' added the column, but existing rows have
        // stateJson=''. Without self-heal, the next defer pass would skip
        // replay (line 770 gate fails on length===0) and the synthetic would
        // vanish from T1 — exactly the regression we're guarding against.
        useTempDataHome("todo-legacy-stateJson-");
        const db = openDatabase();
        updateSessionMeta(db, "ses-1", { lastTodoState: ACTIVE_TODOS_JSON });
        // Seed a legacy row: callId matches current snapshot, but stateJson is empty.
        const callId = computeSyntheticCallId(ACTIVE_TODOS_JSON);
        setPersistedTodoSyntheticAnchor(db, "ses-1", callId, "msg-asst-2", "");

        // Pre-seed a synthetic part on the anchor message (simulates state
        // already injected on a previous pass before this build was loaded).
        const part = buildSyntheticTodoPart(ACTIVE_TODOS_JSON);
        if (!part) throw new Error("part null");
        const asst2 = buildMessages().find((m) => m.info.id === "msg-asst-2");
        if (!asst2) throw new Error("asst-2 missing");

        // T0: cache-bust pass on a legacy row.
        const t0Messages = buildMessages();
        const t0Asst2 = t0Messages.find((m) => m.info.id === "msg-asst-2");
        if (!t0Asst2) throw new Error("t0 asst-2 missing");
        t0Asst2.parts.push(part);
        runTodoSynthesis({
            db,
            sessionId: "ses-1",
            messages: t0Messages,
            isCacheBustingPass: true,
            fullFeatureMode: true,
        });
        const t0Bytes = JSON.stringify(t0Messages);

        // Backfill must have happened — anchor row now has stateJson.
        const after = getPersistedTodoSyntheticAnchor(db, "ses-1");
        expect(after?.callId).toBe(callId);
        expect(after?.messageId).toBe("msg-asst-2");
        expect(after?.stateJson).toBe(ACTIVE_TODOS_JSON);

        // T1: defer pass from fresh messages (OpenCode rebuild). Without the
        // backfill, this would skip injection and produce different bytes.
        const t1Messages = buildMessages();
        runTodoSynthesis({
            db,
            sessionId: "ses-1",
            messages: t1Messages,
            isCacheBustingPass: false,
            fullFeatureMode: true,
        });
        const t1Bytes = JSON.stringify(t1Messages);

        expect(t1Bytes).toBe(t0Bytes);
    });
});

describe("todo state synthesis — feature gates", () => {
    it("subagent sessions skip synthesis (fullFeatureMode=false)", () => {
        useTempDataHome("todo-subagent-");
        const db = openDatabase();
        updateSessionMeta(db, "ses-1", { lastTodoState: ACTIVE_TODOS_JSON });

        const messages = buildMessages();
        runTodoSynthesis({
            db,
            sessionId: "ses-1",
            messages,
            isCacheBustingPass: true,
            fullFeatureMode: false,
        });

        expect(countSyntheticParts(messages)).toBe(0);
        expect(getPersistedTodoSyntheticAnchor(db, "ses-1")).toBeNull();
    });
});

describe("todo state synthesis — wire shape", () => {
    it("injected part matches OpenCode's todowrite tool part shape exactly", () => {
        useTempDataHome("todo-wire-");
        const db = openDatabase();
        updateSessionMeta(db, "ses-1", { lastTodoState: ACTIVE_TODOS_JSON });

        const messages = buildMessages();
        runTodoSynthesis({
            db,
            sessionId: "ses-1",
            messages,
            isCacheBustingPass: true,
            fullFeatureMode: true,
        });

        const found = findSyntheticPart(messages);
        if (!found) throw new Error("synthetic part missing");
        const part = found.part as Record<string, unknown>;

        // These five fields are the OpenCode tool-part contract that the
        // serializer expects. Any drift here breaks Anthropic / OpenAI
        // serialization downstream.
        expect(part.type).toBe("tool");
        expect(part.tool).toBe("todowrite");
        expect(typeof part.callID).toBe("string");
        expect(part.state).toBeDefined();
        const state = part.state as Record<string, unknown>;
        expect(state.status).toBe("completed");
        expect((state.input as { todos: unknown[] }).todos).toBeDefined();
        expect(typeof state.output).toBe("string");
        expect(state.metadata).toBeDefined();
        expect(state.time).toBeDefined();
    });
});
