import { afterEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../../features/magic-context/migrations";
import { createScheduler } from "../../features/magic-context/scheduler";
import { getOrCreateSessionMeta, updateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    getMergedReasoningStrippedIds,
    getThinkingBindingRecoveryTarget,
    THINKING_BINDING_RECOVERY_ALL_ASSISTANTS,
} from "../../features/magic-context/storage-meta-persisted";
import { createTagger } from "../../features/magic-context/tagger";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    armLatestThinkingRecovery,
    armThinkingBindingRecoveryFromError,
    prepareLatestThinkingRecovery,
} from "./latest-thinking-recovery";
import type { MessageLike } from "./tag-messages";
import { createTransform } from "./transform";

// Which turn the latest-turn thinking recovery acts on, and which remedy it
// picks: the provider's own turn boundary (a user message the host writes ends
// a turn), a binding rejection after the turn's thinking is gone, and a turn
// Magic Context edited through the cleared-reasoning watermark.

const MODEL = "claude-opus-5-5";
const LATEST_TURN_400 =
    "messages.5.content.0: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.";
const LATEST_TURN_ERROR = { name: "APIError", statusCode: 400, data: { message: LATEST_TURN_400 } };
const BINDING_400 =
    'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block". Content before this block differs from when it was created, first at `messages.0.content.0`.';
const BINDING_ERROR = { name: "APIError", statusCode: 400, data: { message: BINDING_400 } };

function database(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function user(id: string, text = `question ${id}`, sessionID = "s"): MessageLike {
    return { info: { id, role: "user", sessionID }, parts: [{ type: "text", text }] };
}

/**
 * A user message OpenCode writes itself, every part marked synthetic (for
 * example the prompt it adds after a subtask command). OpenCode still sends
 * synthetic text parts to the provider (only `ignored` parts are left out), so
 * on the wire this is an ordinary user text message.
 */
function syntheticUser(id: string): MessageLike {
    return {
        info: { id, role: "user", sessionID: "s" },
        parts: [
            {
                type: "text",
                text: "Summarize the task tool output above and continue with your task.",
                synthetic: true,
            },
        ],
    };
}

function signed(id: string, signature: string, sessionID = "s", modelID = MODEL): MessageLike {
    return {
        info: {
            id,
            role: "assistant",
            sessionID,
            providerID: "anthropic",
            modelID,
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

function failed(id: string, sessionID = "s", modelID = MODEL): MessageLike {
    return {
        info: {
            id,
            role: "assistant",
            sessionID,
            providerID: "anthropic",
            modelID,
            error: LATEST_TURN_ERROR,
        },
        parts: [],
    };
}

describe("latest-turn thinking recovery (review witnesses)", () => {
    const opened: Database[] = [];
    afterEach(() => {
        for (const db of opened.splice(0)) closeQuietly(db);
    });

    function session(sessionId: string, messages: MessageLike[]) {
        const db = database();
        opened.push(db);
        const prepare = () =>
            prepareLatestThinkingRecovery({
                db,
                sessionId,
                messages,
                id: (message) => (message as MessageLike).info.id,
                parts: (message) => (message as MessageLike).parts,
                modelID: MODEL,
            });
        return { db, prepare };
    }

    test("the removal leaves alone an assistant that a synthetic user message puts before the provider's latest turn", () => {
        // On the wire the synthetic message is a user text message, so the
        // provider's latest assistant turn is only a2: Anthropic's turn ends at
        // any user message that is not purely tool results, and the repository's
        // own provider double (`latestRealUserIndex` in the e2e mock provider)
        // models exactly that. a1 belongs to the earlier turn, whose bytes the
        // provider did not reject.
        const messages: MessageLike[] = [
            user("u0", "task"),
            signed("a1", "sig-earlier-turn"),
            syntheticUser("syn"),
            signed("a2", "sig-rejected-turn"),
            user("u1", "next question"),
        ];
        const { db, prepare } = session("synthetic-boundary", messages);
        // The pass that built the request the provider then refused.
        prepare();
        armLatestThinkingRecovery(db, "synthetic-boundary", MODEL);
        messages.push(failed("err-1"), user("retry-1", "please continue"));
        const recovery = prepare();
        expect(recovery.removedThisPass).toBe(true);
        // Removing a1's thinking changes bytes before the rejected turn: the
        // provider cache is rewritten from a1 on, and the earlier turn loses its
        // reasoning for no reason the provider gave.
        expect(recovery.removedIds).toEqual(["a2"]);
        expect(
            getMergedReasoningStrippedIds(db, "synthetic-boundary").has("binding_mismatch:a1"),
        ).toBe(false);
    });

    test("a binding 400 after the turn's thinking was removed arms the binding recovery instead of counting toward the latest-turn refusal", () => {
        // An open tool loop: the request ends in the turn's own assistant message.
        const messages: MessageLike[] = [
            user("u0", "task"),
            signed("a1", "sig-a1"),
            signed("a2", "sig-a2"),
        ];
        const { db, prepare } = session("binding-after-removal", messages);
        prepare();
        armLatestThinkingRecovery(db, "binding-after-removal", MODEL);
        expect(prepare().removedIds).toEqual(["a1", "a2"]);
        // The request without the turn's thinking was accepted and the turn went on.
        messages.push(signed("a3", "sig-a3"));
        prepare();
        // The provider now rejects a block bound to a different prefix. The
        // latest turn's own earlier thinking is already gone, so this is not the
        // latest-turn rejection: it is the binding 400 the binding recovery
        // exists for (strip every remaining signed block). Counted against the
        // latest turn, it would only remove the turn's newest thinking, and two
        // more binding 400s would refuse the session with a message that blames
        // the latest turn and tells the user to switch models.
        armThinkingBindingRecoveryFromError({
            db,
            sessionId: "binding-after-removal",
            error: BINDING_ERROR,
            providerID: "anthropic",
            modelID: MODEL,
            source: "review witness",
        });
        expect(getThinkingBindingRecoveryTarget(db, "binding-after-removal")).toBe(
            THINKING_BINDING_RECOVERY_ALL_ASSISTANTS,
        );
    });
});

describe("latest-turn thinking recovery in the OpenCode 1 transform (review witnesses)", () => {
    test("a turn whose thinking Magic Context replays as [cleared] gets its originals restored, not removed", async () => {
        // A model whose thinking is not bound to the bytes before it: Magic
        // Context clears old reasoning to `[cleared]` on canonical Anthropic
        // (which final representation then leaves off the wire) and replays
        // that on every pass up to a saved tag watermark. Once a new
        // user message ends the turn, nothing protects the turn's reasoning from
        // that replay, and the provider (which still checks that turn) refuses
        // the edited blocks. The recovery's own rule is: when Magic Context's
        // replayed decisions edited the turn's thinking, serve the originals.
        // The cleared watermark is one of those decisions, so the turn's
        // originals come back instead of its reasoning being removed for good.
        const model = "claude-sonnet-4-5";
        const sessionId = "review-cleared-turn";
        const db = database();
        getOrCreateSessionMeta(db, sessionId);
        const transform = createTransform({
            db,
            tagger: createTagger(),
            scheduler: createScheduler({ executeThresholdPercentage: 65 }),
            liveModelBySession: new Map([[sessionId, { providerID: "anthropic", modelID: model }]]),
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
            user("u0", "task", sessionId),
            signed("a1", "sig-a1", sessionId, model),
            signed("a2", "sig-a2", sessionId, model),
            user("u1", "next question", sessionId),
        ];
        const pass = async (messages: MessageLike[]) => {
            const copy = structuredClone(messages);
            await transform({}, { messages: copy });
            return copy;
        };
        try {
            await pass(conversation);
            // An earlier rebuilding pass cleared reasoning through a1's tag (tag 2:
            // u0's text is tag 1 and a1's text tag 2), after u1 ended the turn. On
            // canonical Anthropic the cleared block is then left off the wire,
            // while a2's block stays: the turn's thinking is partly removed, which
            // the provider refuses.
            updateSessionMeta(db, sessionId, { clearedReasoningThroughTag: 2 });
            const rejected = await pass(conversation);
            // Precondition: the request the provider refused carried the turn's
            // thinking edited by Magic Context.
            expect(JSON.stringify(rejected)).not.toContain("thinking of a1");
            expect(JSON.stringify(rejected)).toContain("thinking of a2");
            armLatestThinkingRecovery(db, sessionId, model);
            const retry = [
                ...conversation,
                failed("err-1", sessionId, model),
                user("u2", "please continue", sessionId),
            ];
            const served = await pass(retry);
            expect(getMergedReasoningStrippedIds(db, sessionId).has("binding_mismatch:a1")).toBe(
                false,
            );
            expect(JSON.stringify(served)).toContain("thinking of a1");
        } finally {
            closeQuietly(db);
        }
    });
});
