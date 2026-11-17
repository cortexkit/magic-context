/// <reference types="bun-types" />

import { expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as piContext from "../../../../pi-plugin/src/context-handler";
import { persistPiPressureFromMessageEnd } from "../../../../pi-plugin/src/index";
import {
    clearPiSystemPromptSession,
    processSystemPromptForCache,
} from "../../../../pi-plugin/src/system-prompt";
import {
    assistantMessage,
    createFakePi,
    fakeContext,
    type PiMessage,
    toolResultMessage,
    userMessage,
} from "../../../../pi-plugin/src/test-utils.test";
import { runMigrations } from "../../features/magic-context/migrations";
import { createScheduler } from "../../features/magic-context/scheduler";
import {
    getPendingOps,
    getTagsBySession,
    queuePendingOp,
} from "../../features/magic-context/storage";
import { openDatabase } from "../../features/magic-context/storage-db";
import {
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage-meta";
import { createTagger } from "../../features/magic-context/tagger";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../shared/test-temp-dir";
import type { StoreRow } from "../../v2/store-reader";
import goldenDigests from "./fixtures/system-delivery-unheld-digests.json";
import {
    beginV2LkgRequest,
    clearLkgMeasuredRequest,
    noteLkgProviderResponse,
} from "./lkg-measured-request";
import { requestPendingMaterialization } from "./pending-materialization";
import { bindSystemDateRequestIdentity, registerSystemDateRefresh } from "./system-date-refresh";
import { createSystemPromptHashHandler } from "./system-prompt-hash";
import { createTransform, type TransformDeps } from "./transform";
import type { MessageLike } from "./transform-operations";

// Hash the outgoing system instructions, messages, tool calls and results in
// both revisions, not stored cache markers or the source files being compared.
const seeds = [19, 773, 20261014, 0xdeadbeef];
const passes = Number(process.env.REVIEW_PASSES ?? 80);
const fixedClock = 1_800_000_000_000;
const realNow = Date.now;
type HostMessage = MessageLike & { info: MessageLike["info"] & Record<string, unknown> };
let now = fixedClock;
const summaries: {
    host: string;
    signed: boolean;
    active: boolean;
    seed: number;
    ackAt: number;
    acks: number;
    counts?: Record<string, number>;
    pending: number;
    bodies: string[];
}[] = [];
function random(seed: number) {
    let state = seed >>> 0;
    return () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) / 0x100000000;
    };
}
function stable(value: unknown): string {
    if (value === undefined) return "null";
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.entries(value)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
}
function digest(value: unknown) {
    return createHash("sha256").update(stable(value)).digest("hex");
}
function eventsFor(seed: number) {
    const rng = random(seed);
    return Array.from({ length: passes }, (_, pass) => ({
        pass,
        edit: rng() < 0.26,
        flush: rng() < 0.12,
        history: rng() < 0.09,
        drop: rng() < 0.3,
        expiry: rng() < 0.09,
        model: rng() < 0.11,
        percent: [18, 40, 66, 84, 86, 96][Math.floor(rng() * 6)]!,
        tool: rng() < 0.65,
        order: rng() < 0.5 ? "system-first" : "messages-first",
    }));
}

async function openCode(host: "oc1" | "oc2", signed: boolean, seed: number, active = false) {
    const bindV2 = existsSync(join(import.meta.dir, "system-prompt-delivery.ts"))
        ? (await import("../../v2/hooks/system-prompt-response.ts")).bindV2SystemPromptResponse
        : undefined;
    const responseRows: StoreRow<"assistant">[] = [];
    const sessionId = `review-${host}-${signed}-${active ? "active-" : ""}${seed}`;
    const home = createTestTempDirFromPath(join(tmpdir(), "delivery-review-"));
    const db = openDatabase(join(home, "context.db"))!;
    runMigrations(db);
    getOrCreateSessionMeta(db, sessionId);
    updateSessionMeta(db, sessionId, { cacheTtl: "5m", lastResponseTime: fixedClock });
    const model = { providerID: "anthropic", modelID: "claude-opus-5-5" };
    const project = "/nonexistent-system-delivery-review-project";
    const deps: TransformDeps = {
        db,
        tagger: createTagger(),
        scheduler: createScheduler({ executeThresholdPercentage: 65 }),
        contextUsageMap: new Map(),
        protectedTokens: 1000,
        clearReasoningAge: 50,
        keepReasoningTokens: 2000,
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        deferredHistoryRefreshSessions: new Set(),
        deferredMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        liveModelBySession: new Map([[sessionId, model]]),
        sessionDirectoryBySession: new Map([[sessionId, project]]),
        directory: project,
        projectPath: project,
        historianRunnable: false,
        hostRawMessages: () => [],
        hostMessageReconciliationSource: () => [],
        hostPrepareRawOrdinals: async () => true,
        hostModelFallback: () => null,
        protectedTools: { read: 0 },
        memoryConfig: { enabled: false, injectionBudgetTokens: 1000, autoPromote: false },
        client: {
            session: { get: async () => ({ data: { directory: project } }) },
        } as unknown as TransformDeps["client"],
        ...(host === "oc2"
            ? {
                  storeGeneration: "v2",
                  hostCleanupCompactionMarkers: () => ({
                      verified: true,
                      removedLineages: 0,
                      removedRows: 0,
                      retainedLineages: 0,
                  }),
              }
            : {}),
    };
    registerSystemDateRefresh(deps.historyRefreshSessions);
    let prepared = false;
    const system = createSystemPromptHashHandler({
        db,
        dreamerEnabled: false,
        memoryEnabled: false,
        resolveModel: () => model,
        historyRefreshSessions: deps.historyRefreshSessions,
        pendingMaterializationSessions: deps.pendingMaterializationSessions,
        systemPromptRefreshSessions: new Set(),
        lastHeuristicsTurnId: deps.lastHeuristicsTurnId,
        consumeMessagesPrepared: () => prepared,
    });
    const transform = createTransform(deps);
    const source: HostMessage[] = [];
    let ordinal = 0;
    const user = () =>
        source.push({
            info: {
                id: `user-${ordinal}`,
                role: "user",
                sessionID: sessionId,
                time: { created: ++ordinal },
                model: { ...model },
            },
            parts: [{ type: "text", text: `task ${ordinal}` }],
        });
    const assistant = (tool: boolean) => {
        const id = `assistant-${++ordinal}`;
        source.push({
            info: {
                id,
                role: "assistant",
                sessionID: sessionId,
                time: { created: ordinal },
                providerID: model.providerID,
                modelID: model.modelID,
                finish: tool ? "tool-calls" : "stop",
            },
            parts: [
                ...((active || !tool) && signed
                    ? [
                          {
                              type: "reasoning",
                              text: `closed thought ${ordinal}`,
                              metadata: { anthropic: { signature: `sig-${ordinal}` } },
                          },
                      ]
                    : []),
                ...(tool
                    ? [
                          {
                              type: "tool",
                              tool: "read",
                              callID: `call-${ordinal}`,
                              state: {
                                  status: "completed",
                                  input: { path: `${ordinal}.ts` },
                                  output: `result ${ordinal} ${"payload ".repeat(200)}`,
                              },
                          },
                      ]
                    : [{ type: "text", text: `answer ${ordinal}` }]),
            ] as MessageLike["parts"],
        });
    };
    user();
    assistant(true);
    user();
    let instruction = "base instructions";
    const bodies: string[] = [];
    const errors: string[] = [];
    let ackAt = -1;
    let acks = 0;
    const counts: Record<string, number> = {};
    try {
        for (const e of eventsFor(seed)) {
            now = fixedClock + e.pass * 1000;
            if (e.pass > 0) {
                if (e.tool) assistant(true);
                if (active) {
                    // An open signed tool loop: no user closes the turn until a
                    // non-tool reply arrives, so the transform must hold the head.
                    if (!e.tool) {
                        assistant(false);
                        user();
                    }
                } else if (signed) {
                    assistant(false);
                    user();
                } else if (!e.tool) user();
                if (e.edit) instruction = `genuine instructions ${e.pass}`;
                if (e.flush)
                    requestPendingMaterialization(
                        deps.pendingMaterializationSessions,
                        sessionId,
                        "user_flush",
                    );
                if (e.history) deps.historyRefreshSessions.add(sessionId);
                if (e.model)
                    model.modelID =
                        model.modelID === "claude-opus-5-5"
                            ? "claude-sonnet-4-6"
                            : "claude-opus-5-5";
                if (e.drop) {
                    const target = getTagsBySession(db, sessionId).find(
                        (tag) => tag.type === "tool" && tag.status === "active",
                    );
                    if (target) queuePendingOp(db, sessionId, target.tagNumber, "drop");
                }
            }
            updateSessionMeta(db, sessionId, { lastResponseTime: e.expiry ? now - 600_000 : now });
            deps.contextUsageMap.set(sessionId, {
                usage: { percentage: e.percent, inputTokens: e.percent * 2000 },
                updatedAt: now,
            });
            const key = `${model.providerID}/${model.modelID}`;
            if (host === "oc2")
                beginV2LkgRequest(sessionId, key, `response-${e.pass - 1}`, responseRows.length);
            else
                noteLkgProviderResponse({
                    sessionId,
                    responseId: `response-${e.pass}`,
                    modelKey: key,
                    inputTokens: 0,
                });
            prepared = false;
            const output = { messages: structuredClone(source) };
            bindSystemDateRequestIdentity(output, output);
            const prompt = {
                system: [`${instruction}\n<plugin-env>\n Date: 2026-10-14\n</plugin-env>`],
            };
            try {
                if (e.order === "system-first")
                    await system.handler(
                        { sessionID: sessionId, model, dateRefreshRequest: output },
                        prompt,
                    );
                await transform({}, output as never);
                prepared = true;
                if (e.order === "messages-first")
                    await system.handler(
                        { sessionID: sessionId, model, dateRefreshRequest: output },
                        prompt,
                    );
                bodies.push(
                    digest({
                        system: prompt.system,
                        messages: output.messages.map((m) => ({
                            role: m.info.role,
                            parts: m.parts,
                        })),
                    }),
                );
                const markerBefore = getOrCreateSessionMeta(db, sessionId).cachedM0SystemHash;
                if (host === "oc2") {
                    responseRows.push({
                        id: `response-${e.pass}`,
                        session_id: sessionId,
                        type: "assistant",
                        seq: responseRows.length + 1,
                        data: {
                            model: { providerID: model.providerID, id: model.modelID },
                            time: { created: now + 1 },
                        },
                    });
                    bindV2?.(sessionId, {
                        assistantSince: (_session, after) =>
                            responseRows.filter((row) => row.seq > after),
                    });
                }
                noteLkgProviderResponse({
                    sessionId,
                    responseId: `response-${e.pass}`,
                    modelKey: key,
                    inputTokens: 2000,
                    finish: e.tool ? "tool-calls" : "stop",
                    completedAt: now + 1,
                    createdAt: now + 1,
                    v2: host === "oc2",
                });
                // The base revision (9382158d) never writes cachedM0SystemHash from a
                // provider response. The first pass whose reply changes it is the last
                // pass on which both revisions must still serve identical bytes.
                if (getOrCreateSessionMeta(db, sessionId).cachedM0SystemHash !== markerBefore) {
                    acks++;
                    if (ackAt < 0) ackAt = e.pass;
                }
            } catch (error) {
                errors.push(`${e.pass}:${String(error)}`);
                bodies.push(`ERROR:${String(error)}`);
            }
            for (const event of [
                "edit",
                "flush",
                "history",
                "drop",
                "expiry",
                "model",
                "tool",
            ] as const)
                if (e[event]) counts[event] = (counts[event] ?? 0) + 1;
        }
        expect(errors).toEqual([]);
        expect(bodies).toHaveLength(passes);
        summaries.push({
            host,
            signed,
            active,
            seed,
            ackAt,
            acks,
            counts,
            pending: getPendingOps(db, sessionId).length,
            bodies,
        });
    } finally {
        clearLkgMeasuredRequest(sessionId);
        db.close();
        cleanupTestTempDir(home);
    }
}

async function pi(signed: boolean, seed: number, active = false) {
    const sessionId = `review-pi-${signed}-${active ? "active-" : ""}${seed}`;
    const home = createTestTempDirFromPath(join(tmpdir(), "delivery-review-pi-"));
    const db = openDatabase(join(home, "context.db"))!;
    runMigrations(db);
    getOrCreateSessionMeta(db, sessionId);
    updateSessionMeta(db, sessionId, {
        piStableIdScheme: 1,
        cacheTtl: "5m",
        lastResponseTime: fixedClock,
    });
    const fake = createFakePi();
    // An ordinary Magic Context session: it can call ctx_reduce, so its
    // requests carry tag prefixes.
    Object.assign(fake.pi, {
        getAllTools: () => [
            { name: "read", description: "Read", parameters: { type: "object" } },
            { name: "ctx_reduce", description: "Reduce", parameters: { type: "object" } },
        ],
        getActiveTools: () => ["read", "ctx_reduce"],
    });
    piContext.registerPiContextHandler(fake.pi as never, {
        db,
        protectedTokens: 1000,
        injection: { injectionBudgetTokens: 1000, memoryEnabled: false, injectDocs: false },
        protectedTools: { read: 0 },
        heuristics: { keepReasoningTokens: 2000 },
        scheduler: { executeThresholdPercentage: 65 },
    });
    let model = "claude-opus-5-5";
    let ordinal = 0;
    const source: PiMessage[] = [];
    const ids: string[] = [];
    const push = (message: PiMessage) => {
        source.push(message);
        ids.push(`row-${++ordinal}`);
    };
    const user = () => push(userMessage(`task ${ordinal}`, ordinal + 1));
    const assistant = (tool: boolean) => {
        const id = `call-${ordinal}`;
        push(
            assistantMessage("", ordinal + 1, {
                provider: "anthropic",
                model,
                api: "anthropic-messages",
                stopReason: tool ? "toolUse" : "stop",
                content: [
                    ...((active || !tool) && signed
                        ? [
                              {
                                  type: "thinking",
                                  thinking: `closed thought ${ordinal}`,
                                  thinkingSignature: `sig-${ordinal}`,
                              },
                          ]
                        : []),
                    ...(tool
                        ? [
                              {
                                  type: "toolCall",
                                  id,
                                  name: "read",
                                  arguments: { path: `${ordinal}.ts` },
                              },
                          ]
                        : [{ type: "text", text: `answer ${ordinal}` }]),
                ],
            }),
        );
        if (tool)
            push(toolResultMessage(id, `result ${ordinal} ${"payload ".repeat(200)}`, ordinal + 1));
    };
    user();
    assistant(true);
    user();
    let instruction = "base instructions";
    const bodies: string[] = [];
    const errors: string[] = [];
    let ackAt = -1;
    let acks = 0;
    try {
        for (const e of eventsFor(seed)) {
            now = fixedClock + e.pass * 1000;
            if (e.pass > 0) {
                if (e.tool) assistant(true);
                if (active) {
                    // An open signed tool loop: no user closes the turn until a
                    // non-tool reply arrives, so the transform must hold the head.
                    if (!e.tool) {
                        assistant(false);
                        user();
                    }
                } else if (signed) {
                    assistant(false);
                    user();
                } else if (!e.tool) user();
                if (e.edit) instruction = `genuine instructions ${e.pass}`;
                if (e.flush) piContext.signalPiPendingMaterialization(sessionId, "user_flush");
                if (e.history) piContext.signalPiHistoryRefresh(sessionId);
                if (e.model)
                    model = model === "claude-opus-5-5" ? "claude-sonnet-4-6" : "claude-opus-5-5";
                if (e.drop) {
                    const target = getTagsBySession(db, sessionId).find(
                        (tag) => tag.type === "tool" && tag.status === "active",
                    );
                    if (target) queuePendingOp(db, sessionId, target.tagNumber, "drop");
                }
            }
            updateSessionMeta(db, sessionId, { lastResponseTime: e.expiry ? now - 600_000 : now });
            const prompt = processSystemPromptForCache({
                db,
                sessionId,
                systemPrompt: instruction,
                isCacheBusting: false,
            });
            if (prompt.hashChanged) {
                const signal = (
                    piContext as unknown as {
                        signalPiSystemHashChange?: (session: string, hash: string) => void;
                    }
                ).signalPiSystemHashChange;
                if (signal) signal(sessionId, prompt.currentHash);
                else {
                    piContext.signalPiHistoryRefresh(sessionId);
                    piContext.signalPiSystemPromptRefresh(sessionId);
                    piContext.signalPiPendingMaterialization(sessionId, "system_hash");
                }
            }
            const messages = structuredClone(source);
            const parentId = ids.at(-1) ?? null;
            const branch: unknown[] = ids.map((id, index) => ({
                type: "message",
                id,
                message: messages[index],
            }));
            const ctx = {
                ...fakeContext(
                    sessionId,
                    "/nonexistent-system-delivery-review-project",
                    [...ids],
                    messages,
                ),
                sessionManager: {
                    getSessionId: () => sessionId,
                    getLeafId: () => parentId,
                    getBranch: () => branch,
                },
                getSystemPrompt: () => prompt.systemPrompt,
                model: {
                    provider: "anthropic",
                    id: model,
                    api: "anthropic-messages",
                    contextWindow: 200000,
                },
                getContextUsage: () => ({
                    tokens: e.percent * 2000,
                    percent: e.percent,
                    contextWindow: 200000,
                }),
            };
            try {
                const served = (await fake.handlers.get("context")!(
                    { messages } as never,
                    ctx as never,
                )) as { messages: PiMessage[] };
                bodies.push(
                    digest({
                        system: prompt.systemPrompt,
                        messages: served.messages.map((m) => {
                            const {
                                timestamp: _timestamp,
                                usage: _usage,
                                ...wire
                            } = m as unknown as Record<string, unknown>;
                            return wire;
                        }),
                    }),
                );
                const markerBefore = getOrCreateSessionMeta(db, sessionId).cachedM0SystemHash;
                const response = {
                    role: "assistant",
                    timestamp: now + 1,
                    provider: "anthropic",
                    model,
                    stopReason: e.tool ? "toolUse" : "stop",
                    usage: { input: 2000, output: 10, cacheRead: 2000, cacheWrite: 0 },
                };
                branch.push({
                    type: "message",
                    id: `response-${e.pass}`,
                    parentId,
                    message: response,
                });
                await persistPiPressureFromMessageEnd({
                    db,
                    sessionId,
                    piContextWindow: 200000,
                    message: response,
                });
                if (getOrCreateSessionMeta(db, sessionId).cachedM0SystemHash !== markerBefore) {
                    acks++;
                    if (ackAt < 0) ackAt = e.pass;
                }
            } catch (error) {
                errors.push(`${e.pass}:${String(error)}`);
                bodies.push(`ERROR:${String(error)}`);
            }
        }
        expect(errors).toEqual([]);
        expect(bodies).toHaveLength(passes);
        summaries.push({
            host: "pi",
            signed,
            active,
            seed,
            ackAt,
            acks,
            pending: getPendingOps(db, sessionId).length,
            bodies,
        });
    } finally {
        piContext.clearContextHandlerSession(sessionId);
        clearPiSystemPromptSession(sessionId);
        db.close();
        cleanupTestTempDir(home);
    }
}

const modes = [
    { signed: false, active: false, label: "no-signed" },
    { signed: true, active: false, label: "closed-signed" },
    { signed: true, active: true, label: "active-signed" },
] as const;
for (const host of ["oc1", "oc2", "pi"] as const)
    for (const { signed, active, label } of modes)
        for (const seed of seeds) {
            it(`independent randomized provider bytes ${host} ${label} seed=${seed}`, async () => {
                Date.now = () => now;
                try {
                    if (host === "pi") await pi(signed, seed, active);
                    else await openCode(host, signed, seed, active);
                } finally {
                    Date.now = realNow;
                }
            }, 120_000);
        }
it("independent differential matches unheld provider bodies to master", () => {
    console.log(
        `REVIEW_DIFFERENTIAL ${JSON.stringify(process.env.REVIEW_DUMP === "1" ? summaries : summaries.map(({ bodies, ...row }) => ({ ...row, passes: bodies.length, sha256: createHash("sha256").update(bodies.join("\n")).digest("hex") })))}`,
    );
    if (process.env.REVIEW_OUT)
        require("node:fs").writeFileSync(process.env.REVIEW_OUT, JSON.stringify(summaries));
    expect(summaries).toHaveLength(seeds.length * 9);
    if (passes === 80 && !process.env.REVIEW_OUT)
        for (const row of summaries.filter((row) => !row.active)) {
            const key = `${row.host}-${row.signed}-${row.seed}` as keyof typeof goldenDigests;
            const hash = createHash("sha256").update(row.bodies.join("\n")).digest("hex");
            expect({ key, hash }).toEqual({ key, hash: goldenDigests[key] });
        }
});
