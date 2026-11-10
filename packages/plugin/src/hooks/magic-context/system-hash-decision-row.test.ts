/// <reference types="bun-types" />

/**
 * A changed system prompt rewrites the provider's whole prompt cache on the
 * first request that carries it. The `transform_decisions` row bound to that
 * request's assistant must name `system_hash`, even when Magic Context's own
 * pass changed no message bytes (a deferred pass in the middle of a signed tool
 * loop) or busted for another reason. These tests drive the real system hook,
 * the real messages transform and the OpenCode 1 completion binder in both
 * host hook orders, and also pin that unchanged-prompt passes add no row.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import { __resetToolDefinitionMeasurements } from "../../features/magic-context/tool-definition-tokens";
import {
    __test as decisionLog,
    scheduleOpenCodeTransformDecisionWrite,
} from "../../features/magic-context/transform-decision-log";
import type { ContextUsage } from "../../features/magic-context/types";
import { openTestDatabase } from "../../shared/test-db";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import {
    clearCtxReduceAvailability,
    resolveCtxReduceAvailabilityFromMessages,
} from "./ctx-reduce-availability";
import { clearInjectionCache } from "./inject-compartments";
import { closeReadOnlySessionDb } from "./read-session-db";
import { createSystemPromptHashHandler } from "./system-prompt-hash";
import type { MessageLike } from "./tag-messages";
import { createTransform } from "./transform";

const model = { providerID: "anthropic", modelID: "claude-opus-5-5" };
const originalDataHome = process.env.XDG_DATA_HOME;
const roots: string[] = [];
const sessions: string[] = [];

afterEach(() => {
    __resetToolDefinitionMeasurements();
    for (const sessionId of sessions.splice(0)) {
        clearInjectionCache(sessionId);
        clearCtxReduceAvailability(sessionId);
    }
    decisionLog.reset();
    closeReadOnlySessionDb();
    closeDatabase();
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalDataHome;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Order = "system-first" | "messages-first";

interface DecisionRow {
    message_id: string;
    decision: string;
    materialize_reason: string | null;
}

async function harness(order: Order, label: string) {
    const parent = join(tmpdir(), "magic-context", "issue-713");
    mkdirSync(parent, { recursive: true });
    const root = createTestTempDirFromPath(join(parent, `${label}-`));
    roots.push(root);
    process.env.XDG_DATA_HOME = root;
    const sessionId = `ses-system-hash-row-${label}-${order}`;
    sessions.push(sessionId);
    const db = await openTestDatabase();
    getOrCreateSessionMeta(db, sessionId);
    updateSessionMeta(db, sessionId, { cacheTtl: "never", lastResponseTime: Date.now() });
    const historyRefreshSessions = new Set<string>();
    const pendingMaterializationSessions = new Set<string>();
    const systemPromptRefreshSessions = new Set<string>();
    const lastHeuristicsTurnId = new Map<string, string>();
    let schedule: "execute" | "defer" = "execute";
    // The messages transform reads the live model; the system hook keeps the
    // fixed route, so a model switch alone does not change the prompt hash.
    const liveModelBySession = new Map([[sessionId, model]]);
    const transform = createTransform({
        tagger: createTagger(),
        scheduler: { shouldExecute: () => schedule },
        contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
            [sessionId, { usage: { percentage: 40, inputTokens: 40_000 }, updatedAt: Date.now() }],
        ]),
        db,
        historyRefreshSessions,
        pendingMaterializationSessions,
        lastHeuristicsTurnId,
        clearReasoningAge: 50,
        protectedTokens: 0,
        directory: root,
        sessionDirectoryBySession: new Map([[sessionId, root]]),
        liveModelBySession,
    });
    const system = createSystemPromptHashHandler({
        db,
        dreamerEnabled: false,
        resolveModel: () => model,
        historyRefreshSessions,
        systemPromptRefreshSessions,
        pendingMaterializationSessions,
        lastHeuristicsTurnId,
        consumeMessagesPrepared: () => order === "messages-first",
    });
    const text = (id: string, role: "user" | "assistant"): MessageLike =>
        ({
            info: {
                id,
                role,
                sessionID: sessionId,
                finish: role === "assistant" ? "stop" : undefined,
            },
            parts: [{ type: "text", text: `${role} ${id}` }],
        }) as unknown as MessageLike;
    // An assistant step of an Anthropic tool loop: signed reasoning plus a
    // completed tool call. The next request continues the same turn.
    const toolStep = (id: string): MessageLike =>
        ({
            info: { id, role: "assistant", sessionID: sessionId, finish: "tool-calls" },
            parts: [
                {
                    type: "reasoning",
                    text: `thinking ${id}`,
                    metadata: { anthropic: { signature: `signature-${id}` } },
                },
                {
                    type: "tool",
                    callID: `call-${id}`,
                    tool: "read",
                    state: { status: "completed", input: {}, output: `result ${id}` },
                },
            ],
        }) as unknown as MessageLike;
    resolveCtxReduceAvailabilityFromMessages(sessionId, [text("msg_0001", "user")] as never);
    /** One provider request: both hooks in host order, then the reply completes. */
    const serve = async (args: {
        messages: MessageLike[];
        prompt: string;
        reply: string;
        schedule: "execute" | "defer";
    }) => {
        schedule = args.schedule;
        const output = { messages: structuredClone(args.messages) as unknown[] };
        const systemOutput = { system: [args.prompt] };
        if (order === "system-first") await system.handler({ sessionID: sessionId }, systemOutput);
        await transform({}, output);
        if (order === "messages-first")
            await system.handler({ sessionID: sessionId }, systemOutput);
        scheduleOpenCodeTransformDecisionWrite({
            db,
            sessionId,
            messageId: args.reply,
            inputTokens: 40_000,
        });
        await decisionLog.waitForWrites(sessionId);
        return { messages: output.messages, system: systemOutput.system };
    };
    const rows = (): DecisionRow[] =>
        db
            .prepare(
                `SELECT message_id, decision, materialize_reason FROM transform_decisions
                  WHERE session_id = ? ORDER BY rowid`,
            )
            .all(sessionId) as DecisionRow[];
    const switchModel = (modelID: string) =>
        liveModelBySession.set(sessionId, { providerID: model.providerID, modelID });
    return { db, sessionId, serve, rows, text, toolStep, switchModel };
}

describe("system prompt change names system_hash on its request's decision row", () => {
    for (const order of ["system-first", "messages-first"] as const) {
        it(`TS mid tool loop: the deferred pass that carries the change records system_hash (${order})`, async () => {
            const h = await harness(order, "mid-loop");
            const user = h.text("msg_0001", "user");
            await h.serve({
                messages: [user],
                prompt: "Base instructions, version one.",
                reply: "msg_0002",
                schedule: "execute",
            });
            const afterFirst = h.rows();
            // Ordinary tool-loop steps with an unchanged prompt add no row.
            await h.serve({
                messages: [user, h.toolStep("msg_0002")],
                prompt: "Base instructions, version one.",
                reply: "msg_0003",
                schedule: "defer",
            });
            await h.serve({
                messages: [user, h.toolStep("msg_0002"), h.toolStep("msg_0003")],
                prompt: "Base instructions, version one.",
                reply: "msg_0004",
                schedule: "defer",
            });
            expect(h.rows()).toEqual(afterFirst);

            // Step four of the loop: the user's global instructions changed.
            await h.serve({
                messages: [
                    user,
                    h.toolStep("msg_0002"),
                    h.toolStep("msg_0003"),
                    h.toolStep("msg_0004"),
                ],
                prompt: "Base instructions, version two.",
                reply: "msg_0005",
                schedule: "defer",
            });
            const added = h.rows().slice(afterFirst.length);
            expect(added).toHaveLength(1);
            expect(added[0]).toMatchObject({
                message_id: "msg_0005",
                materialize_reason: "system_hash",
            });

            // The next step carries no change and adds no row.
            const settled = h.rows();
            await h.serve({
                messages: [
                    user,
                    h.toolStep("msg_0002"),
                    h.toolStep("msg_0003"),
                    h.toolStep("msg_0004"),
                    h.toolStep("msg_0005"),
                ],
                prompt: "Base instructions, version two.",
                reply: "msg_0006",
                schedule: "defer",
            });
            const after = h.rows();
            expect(after.filter((row) => row.materialize_reason === "system_hash")).toHaveLength(1);
            expect(after.slice(settled.length).every((row) => row.message_id !== "msg_0005")).toBe(
                true,
            );
        });

        it(`TS normal: a busting pass that carries the change records system_hash, not its own reason (${order})`, async () => {
            const h = await harness(order, "normal");
            const user = h.text("msg_0001", "user");
            await h.serve({
                messages: [user],
                prompt: "Base instructions, version one.",
                reply: "msg_0002",
                schedule: "execute",
            });

            // Control: a model switch with an unchanged prompt busts and records
            // its own reason.
            h.switchModel("claude-opus-5-6");
            const before = h.rows().length;
            await h.serve({
                messages: [user, h.text("msg_0002", "assistant"), h.text("msg_0003", "user")],
                prompt: "Base instructions, version one.",
                reply: "msg_0004",
                schedule: "execute",
            });
            expect(h.rows().slice(before)).toEqual([
                { message_id: "msg_0004", decision: "execute", materialize_reason: "model_change" },
            ]);

            // The same kind of busting pass on the request that carries a new prompt.
            h.switchModel("claude-opus-5-7");
            const beforeChange = h.rows().length;
            await h.serve({
                messages: [
                    user,
                    h.text("msg_0002", "assistant"),
                    h.text("msg_0003", "user"),
                    h.text("msg_0004", "assistant"),
                    h.text("msg_0005", "user"),
                ],
                prompt: "Base instructions, version two.",
                reply: "msg_0006",
                schedule: "execute",
            });
            expect(h.rows().slice(beforeChange)).toEqual([
                { message_id: "msg_0006", decision: "execute", materialize_reason: "system_hash" },
            ]);
        });
    }

    it("a late completion event for an earlier reply does not take the change", async () => {
        const h = await harness("messages-first", "late-event");
        const user = h.text("msg_0001", "user");
        await h.serve({
            messages: [user],
            prompt: "Base instructions, version one.",
            reply: "msg_0002",
            schedule: "execute",
        });
        const before = h.rows().length;
        await h.serve({
            messages: [user, h.toolStep("msg_0002")],
            prompt: "Base instructions, version two.",
            // The first completion event is a repeat for msg_0002. This request's
            // messages pass already had msg_0002 in its input, so that reply
            // answers the earlier request and must not take the change.
            reply: "msg_0002",
            schedule: "defer",
        });
        expect(h.rows().slice(before)).toEqual([]);
        expect(
            scheduleOpenCodeTransformDecisionWrite({
                db: h.db,
                sessionId: h.sessionId,
                messageId: "msg_0003",
                inputTokens: 1,
            }),
        ).toBe(true);
        await decisionLog.waitForWrites(h.sessionId);
        expect(h.rows().slice(before)).toEqual([
            expect.objectContaining({ message_id: "msg_0003", materialize_reason: "system_hash" }),
        ]);
    });
});
