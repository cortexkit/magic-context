/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { computeSyntheticCallId } from "../../plugin/src/hooks/magic-context/todo-view";
import { PiTestHarness } from "../src/pi-harness";
import type { MockUsage } from "../src/mock-provider/server";

/**
 * Pi parity port of `todo-synthesis.test.ts`.
 *
 * OpenCode implements synthetic todowrite by capturing real `todowrite` args in
 * `tool.execute.after` (`session_meta.last_todo_state`) and injecting a stable
 * synthetic tool_use/tool_result pair on cache-busting transforms. Pi does not
 * have OpenCode's tool hook; the only analogous surface is
 * `tool_execution_start` in `packages/pi-plugin/src/index.ts`.
 *
 * Current production audit: Pi's `tool_execution_start` handler only uses
 * `todowrite` to trigger note nudges when all todos are terminal. It does NOT
 * call `normalizeTodoStateJson`, does NOT persist `last_todo_state`, and the Pi
 * context pipeline has no equivalent of OpenCode's synthetic injection/replay
 * phase. These tests are intentionally failing parity tests until Pi adds:
 *
 *   1. Capture real Pi `todowrite` args into `session_meta.last_todo_state`
 *      for parent sessions only.
 *   2. On the Pi cache-busting/materialization pass, synthesize a Pi assistant
 *      `toolCall` plus matching `toolResult` from the captured snapshot.
 *   3. Persist `todo_synthetic_call_id`, `todo_synthetic_anchor_message_id`,
 *      and `todo_synthetic_state_json` so defer passes replay byte-identically
 *      even if a newer real todowrite changes `last_todo_state`.
 *   4. Clear the persisted synthetic anchor when the captured state is
 *      terminal-only, and keep the feature disabled for subagents.
 *
 * PARITY GAP: Pi synthetic todowrite is currently unimplemented. Do not skip
 * this suite; failures document the release-blocking gap in the e2e surface.
 */

type Todo = { content: string; status: string; priority: string };

type SessionMetaTodoRow = {
    last_todo_state: string | null;
    todo_synthetic_call_id: string | null;
    todo_synthetic_anchor_message_id: string | null;
    todo_synthetic_state_json: string | null;
    is_subagent: number | null;
};

type WireMessage = { role?: string; content?: unknown };

const LOW_USAGE: MockUsage = {
    input_tokens: 1_000,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 1_000,
};

const HIGH_USAGE: MockUsage = {
    input_tokens: 75_000,
    output_tokens: 20,
    cache_creation_input_tokens: 75_000,
    cache_read_input_tokens: 0,
};

const STATE_X_TODOS: Todo[] = [
    { content: "Build Pi feature", status: "in_progress", priority: "high" },
    { content: "Write Pi tests", status: "pending", priority: "medium" },
];

const STATE_Y_TODOS: Todo[] = [
    { content: "Review Pi cache safety", status: "in_progress", priority: "high" },
    { content: "Ship Pi regression", status: "pending", priority: "low" },
];

const TERMINAL_TODOS: Todo[] = [
    { content: "Build Pi feature", status: "completed", priority: "high" },
    { content: "Write Pi tests", status: "cancelled", priority: "medium" },
];

let h: PiTestHarness;

beforeAll(async () => {
    h = await PiTestHarness.create({
        modelContextLimit: 100_000,
        magicContextConfig: {
            execute_threshold_percentage: 20,
            compaction_markers: false,
            dreamer: { enabled: false },
            sidekick: { enabled: false },
        },
    });
});

afterAll(async () => {
    await h.dispose();
});

afterEach(() => {
    h.mock.reset();
});

function normalizedJson(todos: Todo[]): string {
    return JSON.stringify(todos.map(({ content, status, priority }) => ({ content, status, priority })));
}

function isMagicContextRequest(body: Record<string, unknown>): boolean {
    return JSON.stringify(body.system ?? "").includes("## Magic Context");
}

function findTodoToolName(body: Record<string, unknown>): string | null {
    const tools = body.tools;
    if (!Array.isArray(tools)) return null;
    for (const tool of tools) {
        if (!tool || typeof tool !== "object") continue;
        const name = (tool as { name?: unknown }).name;
        if (typeof name === "string" && /todo.*write|write.*todo|todowrite/i.test(name)) return name;
    }
    return null;
}

function mainRequests(): Array<{ body: Record<string, unknown> }> {
    return h.mock.requests().filter((r) => isMagicContextRequest(r.body));
}

function emitTodoOnce(todos: Todo[], usage: MockUsage = LOW_USAGE): void {
    let emitted = false;
    h.mock.addMatcher((body) => {
        if (emitted || !isMagicContextRequest(body)) return null;
        const toolName = findTodoToolName(body);
        if (!toolName) return null;
        emitted = true;
        return {
            content: [
                {
                    type: "tool_use",
                    id: `toolu_pi_todo_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
                    name: toolName,
                    input: { todos },
                },
            ],
            stop_reason: "tool_use",
            usage,
        };
    });
}

function setDefaultText(text: string, usage: MockUsage = LOW_USAGE): void {
    h.mock.setDefault({ text, usage });
}

function readTodoMeta(sessionId: string): SessionMetaTodoRow | null {
    return h
        .contextDb()
        .prepare(
            `SELECT last_todo_state, todo_synthetic_call_id, todo_synthetic_anchor_message_id,
                    todo_synthetic_state_json, is_subagent
               FROM session_meta
              WHERE session_id = ?`,
        )
        .get(sessionId) as SessionMetaTodoRow | null;
}

function updateTodoMeta(sessionId: string, sql: string): void {
    const db = new Database(h.contextDbPath(), { readwrite: true });
    try {
        db.query("PRAGMA busy_timeout = 5000").run();
        db.prepare(sql).run(sessionId);
    } finally {
        db.close();
    }
}

async function waitForLastTodoState(sessionId: string, stateJson: string): Promise<void> {
    await h.waitFor(() => readTodoMeta(sessionId)?.last_todo_state === stateJson, {
        timeoutMs: 2_000,
        label: "PARITY GAP: Pi should capture todowrite into last_todo_state",
    });
}

async function waitForHighPressure(sessionId: string): Promise<void> {
    await h.waitFor(
        () => {
            const row = h
                .contextDb()
                .prepare("SELECT last_context_percentage FROM session_meta WHERE session_id = ?")
                .get(sessionId) as { last_context_percentage: number } | null;
            return (row?.last_context_percentage ?? 0) >= 65;
        },
        { timeoutMs: 10_000, label: "Pi session crosses execute threshold" },
    );
}

async function captureTodoState(sessionId: string, todos: Todo[]): Promise<void> {
    h.mock.reset();
    emitTodoOnce(todos);
    setDefaultText("after Pi todo", LOW_USAGE);
    await h.sendPrompt(`write Pi todos: ${todos.map((t) => t.content).join(", ")}`, {
        timeoutMs: 90_000,
        continueSession: true,
    });
    await waitForLastTodoState(sessionId, normalizedJson(todos));
}

async function primeNextTurnAsCacheBust(sessionId: string): Promise<void> {
    h.mock.reset();
    setDefaultText("Pi pressure", HIGH_USAGE);
    await h.sendPrompt("Pi pressure turn to cross execute threshold", { timeoutMs: 90_000, continueSession: true });
    await waitForHighPressure(sessionId);
}

async function sendAndCaptureMainRequest(prompt: string): Promise<Record<string, unknown>> {
    h.mock.reset();
    setDefaultText("ok", LOW_USAGE);
    await h.sendPrompt(prompt, { timeoutMs: 90_000, continueSession: true });
    const requests = mainRequests();
    expect(requests.length).toBeGreaterThanOrEqual(1);
    return requests[0]!.body;
}

async function prepareCacheBustState(sessionId: string, todos: Todo[] = STATE_X_TODOS) {
    const stateJson = normalizedJson(todos);
    await captureTodoState(sessionId, todos);
    await primeNextTurnAsCacheBust(sessionId);
    const body = await sendAndCaptureMainRequest("Pi cache-bust turn");
    const callId = computeSyntheticCallId(stateJson);
    const pair = findSyntheticPair(body, callId);
    expect(pair, "PARITY GAP: Pi should inject synthetic todowrite pair on cache-bust").not.toBeNull();
    const meta = readTodoMeta(sessionId);
    expect(meta?.todo_synthetic_call_id).toBe(callId);
    expect(meta?.todo_synthetic_state_json).toBe(stateJson);
    return { body, pair: pair!, stateJson, callId };
}

function contentBlocks(content: unknown): unknown[] {
    return Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : [];
}

function findToolUseId(message: WireMessage, expectedCallId?: string): string | null {
    if (message.role !== "assistant") return null;
    for (const block of contentBlocks(message.content)) {
        if (!block || typeof block !== "object") continue;
        const b = block as { type?: unknown; id?: unknown; name?: unknown };
        if (b.type !== "tool_use") continue;
        if (typeof b.name !== "string" || !/todo.*write|write.*todo|todowrite/i.test(b.name)) continue;
        if (typeof b.id !== "string") continue;
        if (expectedCallId && b.id !== expectedCallId) continue;
        return b.id;
    }
    return null;
}

function findSyntheticPair(
    body: Record<string, unknown>,
    expectedCallId?: string,
): { index: number; callId: string; bytes: string } | null {
    const messages = body.messages as WireMessage[] | undefined;
    if (!Array.isArray(messages)) return null;
    for (let i = 0; i < messages.length - 1; i += 1) {
        const callId = findToolUseId(messages[i]!, expectedCallId);
        if (!callId) continue;
        const toolResult = findToolResultBlock(messages[i + 1]!, callId);
        if (!toolResult) continue;
        const toolUse = contentBlocks(messages[i]!.content).find((block) => {
            if (!block || typeof block !== "object") return false;
            const b = block as { type?: unknown; id?: unknown };
            return b.type === "tool_use" && b.id === callId;
        });
        return { index: i, callId, bytes: JSON.stringify([toolUse, toolResult]) };
    }
    return null;
}

function findToolResultBlock(message: WireMessage, callId: string): unknown | null {
    if (message.role !== "user") return null;
    for (const block of contentBlocks(message.content)) {
        if (!block || typeof block !== "object") continue;
        const b = block as { type?: unknown; tool_use_id?: unknown };
        if (b.type === "tool_result" && b.tool_use_id === callId) return block;
    }
    return null;
}

function syntheticPairBytes(body: Record<string, unknown>, callId: string): string {
    const pair = findSyntheticPair(body, callId);
    if (!pair) throw new Error(`PARITY GAP: Pi synthetic pair missing for ${callId}`);
    return pair.bytes;
}

async function newSessionId(): Promise<string> {
    await h.newSession();
    const first = await h.sendPrompt("start Pi todo synthesis parity session", { timeoutMs: 90_000 });
    expect(first.sessionId).toBeTruthy();
    return first.sessionId!;
}

describe("pi synthetic todowrite e2e", () => {
    it("captures todowrite args into last_todo_state", async () => {
        const sessionId = await newSessionId();
        const stateJson = normalizedJson(STATE_X_TODOS);

        await captureTodoState(sessionId, STATE_X_TODOS);

        const meta = readTodoMeta(sessionId);
        expect(meta?.last_todo_state, "PARITY GAP: Pi tool_execution_start must persist normalized todos").toBe(stateJson);
    }, 120_000);

    it("injects a synthetic todowrite pair on a cache-busting pass", async () => {
        const sessionId = await newSessionId();
        const { body, stateJson, callId } = await prepareCacheBustState(sessionId);

        const pair = findSyntheticPair(body, callId);
        expect(pair?.callId).toBe(callId);
        expect(callId).toBe(computeSyntheticCallId(stateJson));

        const meta = readTodoMeta(sessionId);
        expect(meta?.todo_synthetic_call_id).toBe(callId);
        expect(meta?.todo_synthetic_anchor_message_id ?? "").not.toBe("");
        expect(meta?.todo_synthetic_state_json).toBe(stateJson);
        expect(meta?.last_todo_state).toBe(stateJson);
    }, 180_000);

    it("replays the persisted synthetic pair byte-identically on defer passes", async () => {
        const sessionId = await newSessionId();
        const { callId } = await prepareCacheBustState(sessionId);

        const t0Body = await sendAndCaptureMainRequest("Pi defer replay t0");
        const t0Bytes = syntheticPairBytes(t0Body, callId);
        const metaT0 = readTodoMeta(sessionId);

        const t1Body = await sendAndCaptureMainRequest("Pi defer replay t1");
        const t1Bytes = syntheticPairBytes(t1Body, callId);
        const metaT1 = readTodoMeta(sessionId);

        expect(t1Bytes).toBe(t0Bytes);
        expect(metaT1?.todo_synthetic_call_id).toBe(metaT0?.todo_synthetic_call_id);
        expect(metaT1?.todo_synthetic_anchor_message_id).toBe(metaT0?.todo_synthetic_anchor_message_id);
        expect(metaT1?.todo_synthetic_state_json).toBe(metaT0?.todo_synthetic_state_json);
    }, 180_000);

    it("defer replay ignores a newer real todowrite until the next cache-bust", async () => {
        const sessionId = await newSessionId();
        const { callId: oldCallId } = await prepareCacheBustState(sessionId, STATE_X_TODOS);

        const baselineBody = await sendAndCaptureMainRequest("Pi baseline defer");
        const baselineBytes = syntheticPairBytes(baselineBody, oldCallId);

        h.mock.reset();
        emitTodoOnce(STATE_Y_TODOS);
        setDefaultText("after second Pi todo", LOW_USAGE);
        await h.sendPrompt("write a different Pi todo list", { timeoutMs: 90_000, continueSession: true });
        await waitForLastTodoState(sessionId, normalizedJson(STATE_Y_TODOS));

        const deferBody = await sendAndCaptureMainRequest("Pi defer after changed todos");
        const deferPair = findSyntheticPair(deferBody, oldCallId);
        expect(deferPair?.bytes).toBe(baselineBytes);

        const meta = readTodoMeta(sessionId);
        expect(meta?.todo_synthetic_call_id).toBe(oldCallId);
        expect(meta?.todo_synthetic_state_json).toBe(normalizedJson(STATE_X_TODOS));
        expect(meta?.last_todo_state).toBe(normalizedJson(STATE_Y_TODOS));
    }, 180_000);

    it("self-heals legacy anchors with empty stateJson and replays them on defer", async () => {
        const sessionId = await newSessionId();
        const { callId } = await prepareCacheBustState(sessionId, STATE_X_TODOS);

        updateTodoMeta(sessionId, "UPDATE session_meta SET todo_synthetic_state_json = '' WHERE session_id = ?");
        expect(readTodoMeta(sessionId)?.todo_synthetic_state_json).toBe("");

        await primeNextTurnAsCacheBust(sessionId);
        const cacheBustBody = await sendAndCaptureMainRequest("Pi legacy self-heal cache bust");
        const cacheBustBytes = syntheticPairBytes(cacheBustBody, callId);

        const after = readTodoMeta(sessionId);
        expect(after?.todo_synthetic_state_json).toBe(normalizedJson(STATE_X_TODOS));

        const deferBody = await sendAndCaptureMainRequest("Pi legacy self-heal defer");
        const deferBytes = syntheticPairBytes(deferBody, callId);
        expect(deferBytes).toBe(cacheBustBytes);
    }, 180_000);

    it("skips todowrite capture and synthetic injection for subagents", async () => {
        const sessionId = await newSessionId();

        const db = new Database(h.contextDbPath(), { readwrite: true });
        try {
            db.prepare("UPDATE session_meta SET is_subagent = 1 WHERE session_id = ?").run(sessionId);
        } finally {
            db.close();
        }

        h.mock.reset();
        emitTodoOnce(STATE_X_TODOS);
        setDefaultText("Pi child after todo", LOW_USAGE);
        await h.sendPrompt("Pi subagent writes todos", { timeoutMs: 90_000, continueSession: true });

        const meta = readTodoMeta(sessionId);
        expect(meta?.is_subagent).toBe(1);
        expect(meta?.last_todo_state ?? "").toBe("");
        expect(meta?.todo_synthetic_call_id ?? "").toBe("");
        expect(meta?.todo_synthetic_anchor_message_id ?? "").toBe("");
        expect(meta?.todo_synthetic_state_json ?? "").toBe("");
    }, 120_000);

    it("clears the persisted synthetic anchor when the latest todo state is terminal-only", async () => {
        const sessionId = await newSessionId();
        const { callId } = await prepareCacheBustState(sessionId, STATE_X_TODOS);
        expect(readTodoMeta(sessionId)?.todo_synthetic_call_id).toBe(callId);

        await captureTodoState(sessionId, TERMINAL_TODOS);
        await primeNextTurnAsCacheBust(sessionId);
        const body = await sendAndCaptureMainRequest("Pi terminal cache-bust turn");

        expect(findSyntheticPair(body, callId)).toBeNull();
        const meta = readTodoMeta(sessionId);
        expect(meta?.last_todo_state).toBe(normalizedJson(TERMINAL_TODOS));
        expect(meta?.todo_synthetic_call_id ?? "").toBe("");
        expect(meta?.todo_synthetic_anchor_message_id ?? "").toBe("");
        expect(meta?.todo_synthetic_state_json ?? "").toBe("");
    }, 180_000);
});
