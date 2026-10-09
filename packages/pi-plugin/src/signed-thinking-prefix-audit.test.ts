import { describe, expect, it } from "bun:test";
import { getOrCreateSessionMeta, getTagsBySession, queuePendingOp, updateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { StrictBindingMock, PREFIX_ERROR, type Block, type Wire } from "../../plugin/src/hooks/magic-context/__tests__/strict-binding-mock";
import { clearContextHandlerSession, registerPiContextHandler, signalPiPendingMaterialization } from "./context-handler";
import { assistantMessage, createFakePi, createTestDb, fakeContext, toolResultMessage, userMessage, type PiMessage } from "./test-utils.test";

function wire(messages: unknown[]): Wire {
    return messages.flatMap(raw => {
        const m = raw as { role: string; content: string | Record<string, any>[]; toolCallId?: string };
        const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
        if (m.role === "toolResult") return [{ role: "user", content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: parts }] }];
        const content: Block[] = parts.flatMap(p => {
            if (p.type === "thinking") return [{ type: "thinking", thinking: p.thinking, signature: p.thinkingSignature }];
            if (p.type === "toolCall") return [{ type: "tool_use", id: p.id, name: p.name, input: p.arguments }];
            if (p.type === "text") return [{ type: "text", text: p.text }];
            if (p.type === "image") return [{ type: "image", data: p.data, mimeType: p.mimeType }];
            return [];
        });
        return content.length ? [{ role: m.role, content }] : [];
    });
}

for (const subagent of [false, true]) for (const lane of ["image", "todo", "ctx_reduce", "force85", "wall95"] as const) {
    it(`Pi/OMP ${subagent ? "subagent" : "primary mid-loop"}: ${lane}`, async () => {
        const db = createTestDb();
        const sessionId = `pi-prefix-audit-${subagent}-${lane}`;
        getOrCreateSessionMeta(db, sessionId);
        updateSessionMeta(db, sessionId, { isSubagent: subagent, cacheTtl: "59m", lastResponseTime: Date.now() });
        const fake = createFakePi();
        registerPiContextHandler(fake.pi as never, { db, tagger: createTagger(), protectedTokens: 0, heuristics: { clearReasoningAge: 1000 } });
        const handler = fake.handlers.get("context") as (event: { messages: PiMessage[] }, ctx: never) => Promise<{ messages: unknown[] }>;
        const messages: PiMessage[] = [userMessage(lane === "image" ? [{ type: "text", text: "Inspect image and repair the parser." }, { type: "image", data: "a".repeat(220), mimeType: "image/png" }] : "Inspect files and repair parser.", 1)];
        const ids = ["prompt"];
        let tokens = 20_000;
        const pass = async () => {
            const source = structuredClone(messages);
            const ctx = { ...fakeContext(sessionId, process.cwd(), ids, source), model: { provider: "anthropic", id: "claude-opus-5-5", api: "anthropic-messages", contextWindow: 100_000 }, getContextUsage: () => ({ tokens, percent: tokens / 1000, contextWindow: 100_000 }) };
            return (await handler({ messages: source }, ctx as never)).messages;
        };
        const oracle = new StrictBindingMock();
        oracle.newUserTurn();
        try {
            let served = await pass();
            // A synthetic todo is rendered before any receipt binds to its anchor.
            if (lane === "todo") {
                updateSessionMeta(db, sessionId, { lastTodoState: JSON.stringify([{ content: "Inspect parser", status: "in_progress", priority: "high" }]) });
                signalPiPendingMaterialization(sessionId);
                served = await pass();
            }
            for (let n = 1; n <= 6; n++) {
                const thinking = oracle.emit(wire(served));
                messages.push(assistantMessage("", n * 2, { api: "anthropic-messages", provider: "anthropic", model: "claude-opus-5-5", stopReason: "toolUse", content: [{ type: "thinking", thinking: thinking.thinking, thinkingSignature: thinking.signature }, { type: "toolCall", id: `call-${n}`, name: "read", arguments: { path: `parser-${n}.ts` } }] }));
                ids.push(`step-${n}`);
                messages.push(toolResultMessage(`call-${n}`, "export const parsed = true;\n".repeat(300), n * 2 + 1));
                ids.push(`result-${n}`);
                served = await pass();
                expect(oracle.check(wire(served))).toBeNull();
            }
            if (lane === "todo") updateSessionMeta(db, sessionId, { lastTodoState: JSON.stringify([{ content: "Repair parser", status: "pending", priority: "high" }]) });
            if (lane === "ctx_reduce") {
                const tool = getTagsBySession(db, sessionId).find(t => t.type === "tool")!;
                queuePendingOp(db, sessionId, tool.tagNumber, "drop");
            }
            tokens = lane === "wall95" ? 95_000 : lane === "force85" ? 85_000 : 76_000;
            signalPiPendingMaterialization(sessionId);
            const edited = await pass();
            const error = oracle.check(wire(edited));
            console.log(`AUDIT Pi/OMP subagent=${subagent} ${lane}: ${error ?? "accepted"}; changed=${JSON.stringify(edited) !== JSON.stringify(served)}`);
            const exposed = lane === "image" || (lane === "todo" && !subagent);
            expect(error).toBe(process.env.MC_AUDIT_EXPECT_VALID === "1" ? null : exposed ? PREFIX_ERROR : null);
        } finally { clearContextHandlerSession(sessionId); closeQuietly(db); }
    });
}
