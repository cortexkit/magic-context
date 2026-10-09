import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTagger } from "../../features/magic-context/tagger";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    getTagsBySession,
    openDatabase,
    queuePendingOp,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import type { MessageLike } from "./types";
import { createTransform, type TransformDeps } from "./transform";

import { StrictBindingMock, PREFIX_ERROR, type Block, type Wire } from "./__tests__/strict-binding-mock";
function wire(messages: MessageLike[]): Wire {
    const result: Wire = [];
    for (const m of messages) {
        const content: Block[] = [];
        const results: Block[] = [];
        for (const raw of m.parts) {
            const p = raw as Record<string, any>;
            if (p.ignored === true) continue;
            if (p.type === "text") content.push({ type: "text", text: p.text });
            else if (p.type === "reasoning" && p.text && p.text !== "[cleared]") content.push({ type: "thinking", thinking: p.text, signature: p.metadata?.anthropic?.signature });
            else if (p.type === "thinking") content.push({ type: "thinking", thinking: p.thinking, signature: p.signature });
            else if (p.type === "tool") {
                content.push({ type: "tool_use", id: p.callID, name: p.tool, input: p.state.input ?? {} });
                results.push({ type: "tool_result", tool_use_id: p.callID, content: p.state.output });
            } else if (p.type === "file") content.push({ type: "image", source: { url: p.url, mime: p.mime } });
        }
        if (content.length) result.push({ role: m.info.role, content });
        if (results.length) result.push({ role: "user", content: results });
    }
    return result;
}

const oldData = process.env.XDG_DATA_HOME;
const oldCache = process.env.XDG_CACHE_HOME;
const dirs: string[] = [];
afterEach(() => {
    closeDatabase();
    if (oldData === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = oldData;
    if (oldCache === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = oldCache;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function fixture(subagent: boolean, generation: "v1" | "v2", lane: string = "", extra: Partial<TransformDeps> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "signed-prefix-audit-"));
    dirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    process.env.XDG_CACHE_HOME = dir;
    const db = openDatabase()!;
    const sessionId = `audit-${generation}-${subagent}`;
    getOrCreateSessionMeta(db, sessionId);
    updateSessionMeta(db, sessionId, { isSubagent: subagent, ...(lane === "todo" ? { lastTodoState: JSON.stringify([{ content: "Inspect parser", status: "in_progress", priority: "high" }]) } : {}) });
    const model = { providerID: "anthropic", modelID: "claude-opus-5-5" };
    const pendingMaterializationSessions = new Set<string>();
    const historyRefreshSessions = new Set<string>();
    const usage: TransformDeps["contextUsageMap"] = new Map();
    let decision: "execute" | "defer" = "defer";
    const transform = createTransform({
        db, storeGeneration: generation, tagger: createTagger(),
        scheduler: { shouldExecute: () => decision },
        liveModelBySession: new Map([[sessionId, model]]),
        contextUsageMap: usage, protectedTokens: 0, historianRunnable: false,
        historyRefreshSessions, pendingMaterializationSessions,
        lastHeuristicsTurnId: new Map(), keepReasoningTokens: 1_000_000,
        ...extra,
    });
    const raw: MessageLike[] = [{ info: { id: "prompt", role: "user", sessionID: sessionId }, parts: [{ type: "text", text: "Inspect the project and repair the parser; keep using tools until done." }] }];
    if (lane === "image") raw[0]!.parts.push({ type: "file", mime: "image/png", url: `data:image/png;base64,${"a".repeat(220)}` });
    raw.push({ info: { id: "unsigned-spent", role: "assistant", sessionID: sessionId, ...model }, parts: [
        ...(lane === "sentinel" ? [{ type: "text", text: "[dropped §999§]" }] : []),
        { type: "tool", tool: lane === "stale-reduce" ? "ctx_reduce" : "read", callID: "unsigned-call", state: { status: "completed", input: { filePath: lane === "ctx_reduce full" ? "p".repeat(5000) : "/project/parser.ts" }, output: "The parser source has been inspected. ".repeat(300) } },
    ] });
    if (lane === "sentinel") raw.push({ info: { id: "placeholder-only", role: "assistant", sessionID: sessionId, ...model }, parts: [{ type: "text", text: "[dropped §999§]" }] });
    if (lane === "stale-reduce") for (let n = 1; n <= 4; n++) raw.push({ info: { id: `old-reduce-${n}`, role: "assistant", sessionID: sessionId, ...model }, parts: [{ type: "tool", tool: "ctx_reduce", callID: `old-reduce-call-${n}`, state: { status: "completed", input: { drop: "999" }, output: "Queued" } }] });
    const mock = new StrictBindingMock();
    mock.newUserTurn();
    const pass = async () => {
        const messages = structuredClone(raw);
        await transform({}, { messages });
        return messages;
    };
    if (lane === "todo") { decision = "execute"; pendingMaterializationSessions.add(sessionId); }
    let served = await pass();
    decision = "defer";
    for (let n = 1; n <= 6; n++) {
        expect(mock.check(wire(served))).toBeNull();
        const block = mock.emit(wire(served));
        raw.push({ info: { id: `step-${n}`, role: "assistant", sessionID: sessionId, ...model }, parts: [
            { type: "reasoning", text: block.thinking, metadata: { anthropic: { signature: block.signature } } },
            { type: "tool", tool: "read", callID: `call-${n}`, state: { status: "completed", input: { filePath: `/project/parser-${n}.ts` }, output: `export const value${n} = 1;\n`.repeat(300) } },
        ] });
        served = await pass();
    }
    expect(mock.check(wire(served))).toBeNull();
    const bust = (percentage = 76) => {
        decision = "execute";
        usage.set(sessionId, { usage: { percentage, inputTokens: percentage * 1000 }, updatedAt: Date.now(), hasUsageTokens: true });
        pendingMaterializationSessions.add(sessionId);
    };
    return { db, sessionId, raw, mock, pass, bust, served, historyRefreshSessions, pendingMaterializationSessions };
}

const requireValid = process.env.MC_AUDIT_EXPECT_VALID === "1";
function diagnose(actual: string | null, expected: string | null) {
    expect(actual).toBe(requireValid ? null : expected);
}

describe("signed prefix audit: real OpenCode transform", () => {
    for (const generation of ["v1", "v2"] as const) for (const subagent of [false, true]) {
        const scope = `${generation} ${subagent ? "subagent" : "primary mid-loop"}`;
        for (const lane of ["ctx_reduce full", "ctx_reduce skeleton", "force85", "wall95", "flush", "todo", "reasoning-budget", "caveman", "image", "sentinel", "stale-reduce"] as const) {
            it(`${scope}: ${lane}`, async () => {
                const f = await fixture(subagent, generation, lane, lane === "caveman" ? { cavemanTextCompression: { enabled: true, minChars: 20 } } : lane === "reasoning-budget" ? { keepReasoningTokens: 0 } : {});
                const tool = getTagsBySession(f.db, f.sessionId).find(t => t.type === "tool" && t.messageId.includes("unsigned-call"))!;
                expect(tool).toBeDefined();
                if (lane.startsWith("ctx_reduce")) queuePendingOp(f.db, f.sessionId, tool.tagNumber, "drop");
                if (lane === "todo") updateSessionMeta(f.db, f.sessionId, { lastTodoState: JSON.stringify([{ content: "Repair parser", status: "pending", priority: "high" }]) });
                if (lane === "image") {
                    // The unsigned trailing arc can be reduced without changing any
                    // thinking prefix. Its dropped tag advances the image watermark.
                    for (let n = 1; n <= 4; n++) f.raw.push({ info: { id: `unsigned-tail-${n}`, role: "assistant", sessionID: f.sessionId, providerID: "anthropic", modelID: "claude-opus-5-5" }, parts: [{ type: "tool", tool: "read", callID: n === 1 ? "tail-call" : `tail-new-${n}`, state: { status: "completed", input: { filePath: `/project/final-${n}.ts` }, output: "Already inspected. ".repeat(300) } }] });
                    await f.pass();
                    const tail = getTagsBySession(f.db, f.sessionId).find(t => t.type === "tool" && t.messageId.includes("tail-call"))!;
                    queuePendingOp(f.db, f.sessionId, tail.tagNumber, "drop");
                    f.bust(95);
                    const tailReduced = await f.pass();
                    expect(f.mock.check(wire(tailReduced))).toBeNull();
                    expect(getTagsBySession(f.db, f.sessionId).find(t => t.tagNumber === tail.tagNumber)?.status).toBe("dropped");
                }
                f.bust(lane === "force85" ? 85 : lane === "wall95" ? 95 : 76);
                const next = await f.pass();
                const error = f.mock.check(wire(next));
                console.log(`AUDIT ${scope} ${lane}: ${error ?? "accepted"}; changed=${JSON.stringify(next) !== JSON.stringify(f.served)}; pending=${f.pendingMaterializationSessions.has(f.sessionId)}`);
                const exposed = lane === "sentinel" || lane === "stale-reduce" || lane === "image" || (lane === "todo" && !subagent);
                diagnose(error, exposed ? "400: Invalid signature in thinking block: bound to a different conversation" : null);
            });
        }
    }
});
