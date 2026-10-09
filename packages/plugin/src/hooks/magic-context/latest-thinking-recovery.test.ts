import { afterEach, expect, test } from "bun:test";
import { runMigrations } from "../../features/magic-context/migrations";
import { detectLatestTurnThinkingMismatch } from "../../features/magic-context/overflow-detection";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { addMergedReasoningStrippedIds } from "../../features/magic-context/storage-meta-persisted";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    armLatestThinkingRecovery,
    armLatestThinkingRecoveryFromError,
    captureLatestTurnOriginals,
    prepareLatestThinkingRecovery,
} from "./latest-thinking-recovery";
import type { MessageLike } from "./tag-messages";

const databases: Database[] = [];
afterEach(() => {
    for (const db of databases.splice(0)) closeQuietly(db);
});
function fixture() {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    databases.push(db);
    const messages: MessageLike[] = [
        { info: { id: "u", role: "user" }, parts: [{ type: "text", text: "task" }] },
        {
            info: { id: "a", role: "assistant" },
            parts: [
                {
                    type: "reasoning",
                    text: "original",
                    metadata: { anthropic: { signature: "signed-original" } },
                },
                { type: "tool", callID: "call", state: { output: "§2§ spent" } },
            ],
        },
    ];
    const prepare = () =>
        prepareLatestThinkingRecovery({
            db,
            sessionId: "session",
            messages,
            id: (m) => (m as MessageLike).info.id,
            parts: (m) => (m as MessageLike).parts,
        });
    return { db, messages, prepare };
}

test("latest-thinking parser recognizes only the provider's immutable-turn error", () => {
    const message =
        "messages.1.content.23: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.";
    expect(detectLatestTurnThinkingMismatch({ statusCode: 400, data: { message } })).toBe(true);
    expect(detectLatestTurnThinkingMismatch({ statusCode: 500, message })).toBe(false);
    expect(
        detectLatestTurnThinkingMismatch("Invalid signature: bound to a different conversation"),
    ).toBe(false);
});

test("accepted legacy thinking never arms restoration or changes replay state", () => {
    const { db, messages, prepare } = fixture();
    addMergedReasoningStrippedIds(db, "session", ["binding_mismatch:a"]);
    const before = JSON.stringify(messages);
    expect(prepare()).toEqual({ restore: false, ended: false });
    expect(JSON.stringify(messages)).toBe(before);
});

test("a rejected turn restores original thinking and its envelope durably until a real user", () => {
    const { db, messages, prepare } = fixture();
    addMergedReasoningStrippedIds(db, "session", ["binding_mismatch:a", "@tool-sweep-scoped"]);
    // The pass that built the rejected request names the turn the rejection binds to.
    expect(prepare()).toEqual({ restore: false, ended: false });
    armLatestThinkingRecovery(db, "session");
    expect(prepare()).toEqual({ restore: true, ended: false });
    const before = JSON.stringify(messages);
    const restore = captureLatestTurnOriginals(messages);
    messages[1]!.parts = [{ type: "text", text: "" }];
    restore();
    expect(JSON.stringify(messages)).toBe(before);
    expect(prepare()).toEqual({ restore: true, ended: false });
    messages.push({
        info: { id: "next", role: "user" },
        parts: [{ type: "text", text: "new turn" }],
    });
    expect(prepare()).toEqual({ restore: false, ended: true });
});

test("a rejection bound to its turn is disarmed by a later real user before any restore", () => {
    const { db, messages, prepare } = fixture();
    expect(prepare()).toEqual({ restore: false, ended: false });
    armLatestThinkingRecovery(db, "session");
    messages.push(
        { info: { id: "next", role: "user" }, parts: [{ type: "text", text: "new turn" }] },
        {
            info: { id: "next-a", role: "assistant" },
            parts: [
                { type: "reasoning", text: "new", metadata: { anthropic: { signature: "s" } } },
            ],
        },
    );
    expect(prepare()).toEqual({ restore: false, ended: false });
    // Disarmed for good: the later turn's own pass never restores either.
    expect(prepare()).toEqual({ restore: false, ended: false });
    expect(
        (
            db
                .prepare(
                    "SELECT thinking_binding_recovery_target AS target FROM session_meta WHERE session_id = 'session'",
                )
                .get() as { target: string }
        ).target,
    ).toBe("");
});

test("missing thinking originals refuse locally rather than resend a rejected turn", () => {
    const { db, messages, prepare } = fixture();
    addMergedReasoningStrippedIds(db, "session", ["binding_mismatch:missing"]);
    expect(prepare()).toEqual({ restore: false, ended: false });
    armLatestThinkingRecovery(db, "session");
    expect(prepare).toThrow("ANTHROPIC_LATEST_TURN_EDIT_UNSAFE");
    messages.push({
        info: { id: "next", role: "user" },
        parts: [{ type: "text", text: "new turn" }],
    });
    expect(prepare()).toEqual({ restore: false, ended: true });
});

test("a host failure event arms restoration only for Anthropic-family active-turn rejections", () => {
    const { db, prepare } = fixture();
    const error = {
        statusCode: 400,
        data: {
            message:
                "messages.3.content.0: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified.",
        },
    };
    const arm = (providerID: string, modelID: string, value: unknown = error) =>
        armLatestThinkingRecoveryFromError({
            db,
            sessionId: "session",
            error: value,
            providerID,
            modelID,
        });
    expect(arm("anthropic", "claude-sonnet-5", { statusCode: 500, message: "overloaded" })).toBe(
        false,
    );
    expect(arm("openai", "gpt-5")).toBe(true);
    expect(prepare()).toEqual({ restore: false, ended: false });
    expect(arm("google-vertex", "claude-sonnet-5")).toBe(true);
    expect(prepare()).toEqual({ restore: true, ended: false });
});

test("a rejected restoration is quarantined instead of entering a 400 loop", () => {
    const { db, prepare } = fixture();
    expect(prepare().restore).toBe(false);
    armLatestThinkingRecovery(db, "session");
    expect(prepare().restore).toBe(true);
    armLatestThinkingRecovery(db, "session");
    expect(prepare).toThrow("ANTHROPIC_LATEST_TURN_EDIT_UNSAFE");
});
