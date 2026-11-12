import { afterEach, expect, test } from "bun:test";
import { runMigrations } from "../../features/magic-context/migrations";
import { detectLatestTurnThinkingMismatch } from "../../features/magic-context/overflow-detection";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    addMergedReasoningStrippedIds,
    getMergedReasoningStrippedIds,
} from "../../features/magic-context/storage-meta-persisted";
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

test("a rejected turn restores original thinking and its envelope durably while it is the provider's latest turn", () => {
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
    // The provider checks the last assistant turn even when a real user message
    // follows it, so a new user message keeps the restore.
    messages.push({
        info: { id: "next", role: "user" },
        parts: [{ type: "text", text: "new turn" }],
    });
    expect(prepare()).toEqual({ restore: true, ended: false });
    // A newer assistant turn proves a later request was accepted: the restore ends.
    messages.push({
        info: { id: "next-a", role: "assistant" },
        parts: [{ type: "text", text: "newer answer" }],
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

test("a rejected turn Magic Context never edited has its thinking removed, not resent", () => {
    const { db, messages, prepare } = fixture();
    // The only frozen decision names a message outside the turn: the turn was
    // served with all its original thinking, so restoring would change nothing.
    addMergedReasoningStrippedIds(db, "session", ["binding_mismatch:missing"]);
    expect(prepare()).toEqual({ restore: false, ended: false });
    armLatestThinkingRecovery(db, "session");
    expect(prepare()).toEqual({
        restore: false,
        ended: false,
        removedThisPass: true,
        removedIds: ["a"],
    });
    expect(getMergedReasoningStrippedIds(db, "session").has("binding_mismatch:a")).toBe(true);
    // Later passes replay the persisted removal; a real user message changes
    // nothing. The recovery still names the turn's removed ids.
    messages.push({
        info: { id: "next", role: "user" },
        parts: [{ type: "text", text: "new turn" }],
    });
    expect(prepare()).toEqual({ restore: false, ended: false, removedIds: ["a"] });
});

test("missing thinking originals with nothing left to remove refuse locally rather than resend a rejected turn", () => {
    const { db, messages, prepare } = fixture();
    // The turn's thinking is already omitted, and the originals cannot be
    // restored because another frozen decision names a message that is gone.
    addMergedReasoningStrippedIds(db, "session", [
        "binding_mismatch:a",
        "binding_mismatch:missing",
    ]);
    expect(prepare()).toEqual({ restore: false, ended: false });
    armLatestThinkingRecovery(db, "session");
    expect(prepare).toThrow("ANTHROPIC_LATEST_TURN_EDIT_UNSAFE");
    // A new user message does not end the provider's check of the turn.
    messages.push({
        info: { id: "next", role: "user" },
        parts: [{ type: "text", text: "new turn" }],
    });
    expect(prepare).toThrow("ANTHROPIC_LATEST_TURN_EDIT_UNSAFE");
    // A newer assistant turn proves a later request was accepted.
    messages.push({
        info: { id: "next-a", role: "assistant" },
        parts: [{ type: "text", text: "newer answer" }],
    });
    expect(prepare()).toEqual({ restore: false, ended: false });
});

test("a host failure event arms recovery only for Anthropic-family rejections", () => {
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
    // The turn carries all its original thinking, so the recovery removes it.
    expect(prepare()).toEqual({
        restore: false,
        ended: false,
        removedThisPass: true,
        removedIds: ["a"],
    });
});

test("a rejected restoration removes the turn's thinking, and only a third rejection refuses", () => {
    const { db, prepare } = fixture();
    // A saved reasoning-strip decision (a bare message id) edited the open
    // turn's thinking, so the first rejection restores the originals.
    addMergedReasoningStrippedIds(db, "session", ["a"]);
    expect(prepare().restore).toBe(false);
    armLatestThinkingRecovery(db, "session");
    expect(prepare().restore).toBe(true);
    armLatestThinkingRecovery(db, "session");
    expect(prepare()).toEqual({
        restore: false,
        ended: false,
        removedThisPass: true,
        removedIds: ["a"],
    });
    armLatestThinkingRecovery(db, "session");
    expect(prepare).toThrow("ANTHROPIC_LATEST_TURN_EDIT_UNSAFE");
});

test("entry-order metadata is not a missing thinking original", () => {
    const { db, messages, prepare } = fixture();
    addMergedReasoningStrippedIds(db, "session", [
        "binding_mismatch:a",
        "binding_mismatch_entry_order:end:a",
    ]);
    const before = JSON.stringify(messages);
    expect(prepare()).toEqual({ restore: false, ended: false });
    armLatestThinkingRecovery(db, "session");
    expect(prepare()).toEqual({ restore: true, ended: false });
    expect(JSON.stringify(messages)).toBe(before);
});
