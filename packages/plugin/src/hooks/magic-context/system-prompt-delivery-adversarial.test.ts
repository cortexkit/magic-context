/// <reference types="bun-types" />
import { expect, it, spyOn } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../../features/magic-context/migrations";
import { createScheduler } from "../../features/magic-context/scheduler";
import * as storage from "../../features/magic-context/storage";
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
import { recordDetectedContextLimit } from "../../features/magic-context/storage-meta-persisted";
import { createTagger } from "../../features/magic-context/tagger";
import { recordToolDefinition } from "../../features/magic-context/tool-definition-tokens";
import { createMessagesTransformHandler } from "../../plugin/messages-transform";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { bindV2SystemPromptResponse } from "../../v2/hooks/system-prompt-response";
import type { StoreRow } from "../../v2/store-reader";
import { createEventHandler } from "./event-handler";
import {
    beginV2LkgRequest,
    clearLkgMeasuredRequest,
    currentLkgRequestIdentity,
    type LkgRequestIdentity,
    noteLkgProviderResponse,
} from "./lkg-measured-request";
import { captureLkgSlot } from "./lkg-replay";
import { bindSystemDateRequestIdentity, registerSystemDateRefresh } from "./system-date-refresh";
import { createSystemPromptHashHandler } from "./system-prompt-hash";
import { createTransform, type TransformDeps } from "./transform";
import type { MessageLike } from "./transform-operations";

// Exercise preparation and lifecycle callbacks against isolated stores.
const test = it;
const deliveryPath = "./system-prompt-delivery.ts";
let sequence = 0;
type HostMessage = MessageLike & { info: MessageLike["info"] & Record<string, unknown> };
async function dbFixture() {
    const home = createTestTempDirFromPath(join(tmpdir(), "delivery-review-attack-"));
    const db = openDatabase(join(home, "context.db"))!;
    runMigrations(db);
    const sessionId = `attack-${++sequence}`;
    getOrCreateSessionMeta(db, sessionId);
    updateSessionMeta(db, sessionId, {
        cachedM0SystemHash: "old",
        systemPromptHash: "old",
        cacheTtl: "never",
        lastResponseTime: Date.now(),
    });
    const delivery = await import(deliveryPath);
    const hash = () => getOrCreateSessionMeta(db, sessionId).cachedM0SystemHash;
    return {
        db,
        sessionId,
        delivery,
        hash,
        close: () => {
            clearLkgMeasuredRequest(sessionId);
            delivery.clearSystemPromptDelivery(sessionId);
            db.close();
            cleanupTestTempDir(home);
        },
    };
}

for (const timestamp of [100, 101])
    test(`system delivery: OC2 unrelated completion at ${timestamp} cannot acknowledge undispatched bytes`, async () => {
        const f = await dbFixture();
        const originalNow = Date.now;
        Date.now = () => 100;
        try {
            beginV2LkgRequest(f.sessionId, "anthropic/claude-opus-5-5", "previous");
            // These are the public preparation callbacks used by the real producer
            // and transform. No provider call for this hash has been dispatched.
            const lkgPath = "./lkg-measured-request.ts";
            const lkg = await import(lkgPath);
            const request = lkg.currentLkgRequestIdentity(f.sessionId);
            f.delivery.recordSystemPromptForRequest(f.sessionId, request, "undispatched-new", f.db);
            f.delivery.recordHeldHeadForRequest(f.sessionId, request);
            noteLkgProviderResponse({
                sessionId: f.sessionId,
                responseId: "parallel-old-request",
                modelKey: "anthropic/claude-opus-5-5",
                inputTokens: 1000,
                v2: true,
                createdAt: timestamp,
                finish: "stop",
                completedAt: 200,
            });
            expect(f.hash()).toBe("old");
        } finally {
            Date.now = originalNow;
            f.close();
        }
    });

test("system delivery: OC2 missing timestamp does not acknowledge", async () => {
    const f = await dbFixture();
    try {
        const request: LkgRequestIdentity = {
            kind: "v2",
            startedAt: 100,
            previousResponseId: "previous",
            modelKey: "anthropic/opus",
        };
        f.delivery.recordSystemPromptForRequest(f.sessionId, request, "new", f.db);
        f.delivery.recordHeldHeadForRequest(f.sessionId, request);
        f.delivery.acknowledgeSystemPromptDelivery({
            sessionId: f.sessionId,
            request,
            responseId: "reply",
            modelKey: request.modelKey,
            v2: true,
            finish: "stop",
        });
        expect(f.hash()).toBe("old");
    } finally {
        f.close();
    }
});

test("system delivery: 400 retires the exact request before a later successful update", async () => {
    const f = await dbFixture();
    try {
        const request: LkgRequestIdentity = {
            kind: "v1",
            responseId: "reply",
            modelKey: "anthropic/opus",
        };
        f.delivery.recordSystemPromptForRequest(f.sessionId, request, "new", f.db);
        f.delivery.recordHeldHeadForRequest(f.sessionId, request);
        const response = {
            sessionId: f.sessionId,
            request,
            responseId: "reply",
            modelKey: request.modelKey,
            finish: "stop",
        };
        f.delivery.acknowledgeSystemPromptDelivery({
            ...response,
            error: { statusCode: 400, message: "invalid request" },
        });
        f.delivery.acknowledgeSystemPromptDelivery(response);
        expect(f.hash()).toBe("old");
    } finally {
        f.close();
    }
});

test("system delivery: a differently routed model cannot acknowledge", async () => {
    const f = await dbFixture();
    try {
        const request: LkgRequestIdentity = {
            kind: "v1",
            responseId: "reply",
            modelKey: "anthropic/opus",
        };
        f.delivery.recordSystemPromptForRequest(f.sessionId, request, "new", f.db);
        f.delivery.recordHeldHeadForRequest(f.sessionId, request);
        f.delivery.acknowledgeSystemPromptDelivery({
            sessionId: f.sessionId,
            request,
            responseId: "reply",
            modelKey: "anthropic/other",
            finish: "stop",
        });
        expect(f.hash()).toBe("old");
    } finally {
        f.close();
    }
});

async function heldFixture(generation: "v1" | "v2") {
    const f = await dbFixture();
    updateSessionMeta(f.db, f.sessionId, { cachedM0SystemHash: "", systemPromptHash: "" });
    const model = { providerID: "anthropic", modelID: "claude-opus-5-5" };
    const key = `${model.providerID}/${model.modelID}`;
    recordDetectedContextLimit(f.db, f.sessionId, 200000, key);
    const source: HostMessage[] = [
        {
            info: { id: "old-user", role: "user", sessionID: f.sessionId, model },
            parts: [{ type: "text", text: "earlier task" }],
        },
    ];
    for (let i = 0; i < 12; i++)
        source.push({
            info: {
                id: `old-tool-${i}`,
                role: "assistant",
                sessionID: f.sessionId,
                providerID: model.providerID,
                modelID: model.modelID,
                finish: "stop",
            },
            parts: [
                {
                    type: "tool",
                    tool: "read",
                    callID: `old-call-${i}`,
                    state: {
                        status: "completed",
                        input: { path: `${i}.ts` },
                        output: `historical result ${i} ${"payload ".repeat(2000)}`,
                    },
                },
            ],
        });
    const user = (id: string): HostMessage => ({
        info: { id, role: "user", sessionID: f.sessionId, model },
        parts: [{ type: "text", text: id }],
    });
    source.push(user("current-user"));
    const deps: TransformDeps = {
        db: f.db,
        tagger: createTagger(),
        scheduler: createScheduler({ executeThresholdPercentage: 65 }),
        contextUsageMap: new Map([
            [f.sessionId, { usage: { percentage: 10, inputTokens: 20000 }, updatedAt: Date.now() }],
        ]),
        protectedTokens: 1000,
        clearReasoningAge: 50,
        keepReasoningTokens: 2000,
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        deferredHistoryRefreshSessions: new Set(),
        deferredMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        liveModelBySession: new Map([[f.sessionId, model]]),
        directory: "/nonexistent-review-project",
        projectPath: "/nonexistent-review-project",
        memoryConfig: { enabled: false, injectionBudgetTokens: 1000, autoPromote: false },
        historianRunnable: false,
        protectedTools: { read: 0 },
        client: {
            session: { get: async () => ({ data: { directory: "/nonexistent-review-project" } }) },
        } as unknown as TransformDeps["client"],
    };
    registerSystemDateRefresh(deps.historyRefreshSessions);
    let prepared = false;
    const handler = createSystemPromptHashHandler({
        db: f.db,
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
    let reply = 0;
    const responseRows: StoreRow<"assistant">[] = [];
    async function serve(text: string, order: "system-first" | "messages-first" = "system-first") {
        const responseId = `reply-${++reply}`;
        const key = `${model.providerID}/${model.modelID}`;
        if (generation === "v2")
            beginV2LkgRequest(f.sessionId, key, `reply-${reply - 1}`, responseRows.length);
        else
            noteLkgProviderResponse({
                sessionId: f.sessionId,
                responseId,
                modelKey: key,
                inputTokens: 0,
            });
        const output = { messages: structuredClone(source) };
        const prompt = { system: [text] };
        bindSystemDateRequestIdentity(output, output);
        prepared = false;
        if (order === "system-first")
            await handler.handler(
                { sessionID: f.sessionId, model, dateRefreshRequest: output },
                prompt,
            );
        await transform({}, output as never);
        prepared = true;
        if (order === "messages-first")
            await handler.handler(
                { sessionID: f.sessionId, model, dateRefreshRequest: output },
                prompt,
            );
        return {
            output,
            prompt,
            accept: () => {
                const createdAt = Date.now() + 1;
                if (generation === "v2") {
                    responseRows.push({
                        id: responseId,
                        session_id: f.sessionId,
                        type: "assistant",
                        seq: responseRows.length + 1,
                        data: {
                            model: { providerID: model.providerID, id: model.modelID },
                            time: { created: createdAt },
                            finish: "tool-calls",
                        },
                    });
                    bindV2SystemPromptResponse(f.sessionId, {
                        assistantSince: (_session, after) =>
                            responseRows.filter((row) => row.seq > after),
                    });
                }
                noteLkgProviderResponse({
                    sessionId: f.sessionId,
                    responseId,
                    modelKey: key,
                    inputTokens: 1000,
                    finish: "tool-calls",
                    completedAt: Date.now(),
                    createdAt,
                    v2: generation === "v2",
                });
            },
        };
    }
    (await serve("base instructions")).accept();
    // A heavy signed step (1,600 reasoning tokens): the bounded hold keeps the
    // turn's prefix while usage stays below the cap (65% + 10).
    source.push({
        info: {
            id: "signed",
            role: "assistant",
            sessionID: f.sessionId,
            providerID: model.providerID,
            modelID: model.modelID,
            finish: "tool-calls",
            tokens: { input: 0, output: 1_600, reasoning: 1_600 },
        },
        parts: [
            {
                type: "reasoning",
                text: "active signed plan",
                metadata: { anthropic: { signature: "signed-plan" } },
            },
            {
                type: "tool",
                tool: "read",
                callID: "active-call",
                state: {
                    status: "completed",
                    input: { path: "current.ts" },
                    output: "current result",
                },
            },
        ],
    });
    (await serve("base instructions")).accept();
    const target = getTagsBySession(f.db, f.sessionId).find(
        (tag) => tag.type === "tool" && tag.messageId === "old-call-0",
    );
    if (!target) throw new Error("no historical tag was minted");
    queuePendingOp(f.db, f.sessionId, target.tagNumber, "drop");
    return {
        ...f,
        deps,
        source,
        serve,
        model,
        wake: () => source.push(user("wake")),
        pair: () => {
            const meta = getOrCreateSessionMeta(f.db, f.sessionId);
            return [meta.cachedM0Bytes, meta.cachedM1Bytes];
        },
    };
}

for (const generation of ["v1", "v2"] as const)
    test(`system delivery: ${generation} two held edits retain system-owned history as ride-only work`, async () => {
        const f = await heldFixture(generation);
        try {
            const before = f.pair();
            await f.serve("first edit awaiting response");
            const second = await f.serve("second edit replaces first");
            expect(f.pair()).toEqual(before);
            expect(getPendingOps(f.db, f.sessionId)).toHaveLength(1);
            second.accept();
            expect(f.hash()).toBe(getOrCreateSessionMeta(f.db, f.sessionId).systemPromptHash);
            // Both history refresh signals originated in system edits, never a user
            // flush or historian. A replaced request must transfer that ownership.
            expect(f.deps.historyRefreshSessions.has(f.sessionId)).toBe(false);
            f.wake();
            await f.serve("second edit replaces first");
            expect(getPendingOps(f.db, f.sessionId)).toHaveLength(1);
        } finally {
            f.close();
        }
    });

for (const order of ["system-first", "messages-first"] as const)
    test(`system delivery: accepted ${order} receipt preserves queued drops until an independent flush`, async () => {
        const f = await heldFixture("v1");
        try {
            const before = f.pair();
            const edited = await f.serve("new instructions", order);
            expect(f.pair()).toEqual(before);
            expect(getPendingOps(f.db, f.sessionId)).toHaveLength(1);
            edited.accept();
            expect(f.pair()).toEqual(before);
            f.wake();
            await f.serve("new instructions");
            expect(getPendingOps(f.db, f.sessionId)).toHaveLength(1);
            const pendingPath = "./pending-materialization.ts";
            const pending = await import(pendingPath);
            pending.requestPendingMaterialization(
                f.deps.pendingMaterializationSessions,
                f.sessionId,
                "user_flush",
            );
            await f.serve("new instructions");
            expect(getPendingOps(f.db, f.sessionId)).toHaveLength(0);
            const after = await f.serve("new instructions");
            const stable = await f.serve("new instructions");
            expect(stable.output.messages).toEqual(after.output.messages);
        } finally {
            f.close();
        }
    });

for (const generation of ["v1", "v2"] as const)
    test(`system delivery: ${generation} second accepted held edit does not drain queued drops on wake`, async () => {
        const f = await heldFixture(generation);
        try {
            await f.serve("first edit awaiting response");
            (await f.serve("second edit replaces first")).accept();
            expect(f.hash()).toBe(getOrCreateSessionMeta(f.db, f.sessionId).systemPromptHash);
            expect(getPendingOps(f.db, f.sessionId)).toHaveLength(1);
            f.wake();
            await f.serve("second edit replaces first");
            expect(getPendingOps(f.db, f.sessionId)).toHaveLength(1);
        } finally {
            f.close();
        }
    });

for (const generation of ["v1", "v2"] as const)
    test(`system delivery: ${generation} session deletion must retire delivery before a late reply`, async () => {
        const f = await dbFixture();
        try {
            const key = "anthropic/claude-opus-5-5";
            if (generation === "v2") beginV2LkgRequest(f.sessionId, key, "previous");
            else
                noteLkgProviderResponse({
                    sessionId: f.sessionId,
                    responseId: "reply",
                    modelKey: key,
                    inputTokens: 0,
                });
            const lkgPath = "./lkg-measured-request.ts";
            const lkg = await import(lkgPath);
            const request = lkg.currentLkgRequestIdentity(f.sessionId);
            f.delivery.recordSystemPromptForRequest(
                f.sessionId,
                request,
                "sent-before-delete",
                f.db,
            );
            f.delivery.recordHeldHeadForRequest(f.sessionId, request);
            const createdAt = Date.now() + 1;
            if (generation === "v2")
                f.delivery.bindSystemPromptResponse(f.sessionId, request, {
                    responseId: "reply",
                    modelKey: key,
                    createdAt,
                });
            const system = createSystemPromptHashHandler({
                db: f.db,
                dreamerEnabled: false,
                memoryEnabled: false,
                historyRefreshSessions: new Set(),
                pendingMaterializationSessions: new Set(),
                systemPromptRefreshSessions: new Set(),
                lastHeuristicsTurnId: new Map(),
            });
            const events = createEventHandler({
                db: f.db,
                tagger: createTagger(),
                contextUsageMap: new Map(),
                config: { cache_ttl: "never" },
                compactionHandler: {} as never,
                onSessionDeleted: (sessionId) => system.clearSession(sessionId),
            });
            await events({
                event: { type: "session.deleted", properties: { info: { id: f.sessionId } } },
            } as never);
            const row = () =>
                f.db
                    .prepare("SELECT COUNT(*) AS count FROM session_meta WHERE session_id=?")
                    .get(f.sessionId) as { count: number };
            expect(row().count).toBe(0);
            noteLkgProviderResponse({
                sessionId: f.sessionId,
                responseId: "reply",
                modelKey: key,
                inputTokens: 1000,
                finish: "stop",
                completedAt: Date.now() + 1,
                v2: generation === "v2",
                createdAt,
            });
            expect(row().count).toBe(0);
        } finally {
            f.close();
        }
    });

test("system delivery: real OC2 producer and held transform cannot accept a foreign terminal row", async () => {
    const f = await heldFixture("v2");
    try {
        const before = f.hash();
        await f.serve("prepared new instructions never dispatched");
        expect(f.hash()).toBe(before);
        noteLkgProviderResponse({
            sessionId: f.sessionId,
            responseId: "foreign-terminal-row",
            modelKey: "anthropic/claude-opus-5-5",
            inputTokens: 1000,
            finish: "stop",
            completedAt: Date.now() + 1,
            createdAt: Date.now() + 1,
            v2: true,
        });
        expect(f.hash()).toBe(before);
    } finally {
        f.close();
    }
});

for (const generation of ["v1", "v2"] as const)
    for (const edits of [1, 2] as const)
        test(`system delivery: ${generation} ${edits} held edit(s) then accepted reply do not rebuild on wake`, async () => {
            const f = await heldFixture(generation);
            try {
                const before = f.pair();
                // With two edits the first request's reply is never acknowledged
                // (it failed or was replaced), the second one is accepted.
                if (edits === 2) await f.serve("first edit awaiting response");
                (await f.serve("final edit")).accept();
                expect(f.hash()).toBe(getOrCreateSessionMeta(f.db, f.sessionId).systemPromptHash);
                f.wake();
                await f.serve("final edit");
                // A cache rewrite on wake is the avoidable second rebuild that the
                // acknowledgement is meant to remove.
                expect(f.pair()).toEqual(before);
                expect(getPendingOps(f.db, f.sessionId)).toHaveLength(1);
            } finally {
                f.close();
            }
        });

type IndependentCause = "ttl" | "model" | "force-85" | "emergency-95";
async function independentCause(edited: boolean, cause: IndependentCause) {
    const f = await heldFixture("v1");
    const realNow = Date.now;
    try {
        const before = f.pair();
        const text = edited ? "new instructions" : "base instructions";
        if (edited) (await f.serve(text)).accept();
        f.wake();
        (await f.serve(text)).accept();
        expect(f.pair()).toEqual(before);
        expect(getPendingOps(f.db, f.sessionId)).toHaveLength(1);
        if (cause === "ttl") {
            // Idle expiry needs a response newer than the last m[0] rebuild, then more
            // than the five-minute TTL of silence: record a response now, advance ten minutes.
            updateSessionMeta(f.db, f.sessionId, { cacheTtl: "5m", lastResponseTime: realNow() });
            Date.now = () => realNow() + 600_000;
        } else if (cause === "force-85" || cause === "emergency-95") {
            const percentage = cause === "force-85" ? 86 : 96;
            f.deps.contextUsageMap.set(f.sessionId, {
                usage: { percentage, inputTokens: percentage * 2000 },
                updatedAt: Date.now(),
            });
        } else {
            f.model.modelID = "claude-sonnet-4-6";
            recordDetectedContextLimit(f.db, f.sessionId, 200000, "anthropic/claude-sonnet-4-6");
        }
        f.source.push({
            info: {
                id: "after-cause",
                role: "user",
                sessionID: f.sessionId,
                model: { ...f.model },
            },
            parts: [{ type: "text", text: "after cause" }],
        });
        const served = await f.serve(text);
        served.accept();
        const pending = getPendingOps(f.db, f.sessionId).length;
        f.deps.contextUsageMap.set(f.sessionId, {
            usage: { percentage: 10, inputTokens: 20000 },
            updatedAt: Date.now(),
        });
        const rebuilt = f.pair();
        const next = await f.serve(text);
        const stable = await f.serve(text);
        expect(f.pair()).toEqual(rebuilt);
        expect(stable.output.messages).toEqual(next.output.messages);
        return { pending, messages: served.output.messages };
    } finally {
        Date.now = realNow;
        f.close();
    }
}

for (const edited of [false, true] as const)
    test(`system delivery: v1 ${edited ? "accepted held edit" : "no edit"} leaves queued drop for one independent model rebuild`, async () => {
        // A model change is a rebuild cause unrelated to the system edit, so the
        // queued drop must be applied on this pass.
        expect((await independentCause(edited, "model")).pending).toBe(0);
    });

for (const edited of [false, true] as const)
    test(`system delivery: v1 ${edited ? "accepted held edit" : "no edit"} keeps the queued drop through an idle expiry`, async () => {
        // An idle expiry only means the provider forgot the cache. The request
        // replays byte-identically, so the queued drop waits for a real rebuild.
        expect((await independentCause(edited, "ttl")).pending).toBe(1);
    });

// This fixture's pressure passes do not drain the queued drop even without an
// edit, so the claim checked here is equivalence with that baseline. The one
// difference is the thinking signed under the old system prompt: once that turn
// is complete, the changed system prompt carries the removal of that thinking,
// while the unedited session keeps it.
const isThinkingPart = (part: unknown) =>
    ["reasoning", "thinking", "redacted_thinking"].includes(
        String((part as { type?: unknown }).type),
    );
const withoutThinking = (messages: { parts: unknown[] }[]) =>
    messages.map((m) =>
        m.parts.filter(
            (part) =>
                !isThinkingPart(part) &&
                // A removed reasoning part is served as an empty text sentinel.
                !(
                    (part as { type?: unknown }).type === "text" &&
                    (part as { text?: unknown }).text === ""
                ),
        ),
    );
for (const cause of ["force-85", "emergency-95"] as const)
    test(`system delivery: v1 accepted held edit leaves the ${cause} pass identical to the no-edit baseline except for its thinking removal`, async () => {
        const baseline = await independentCause(false, cause);
        const edited = await independentCause(true, cause);
        expect(edited.pending).toBe(baseline.pending);
        expect(withoutThinking(edited.messages)).toEqual(withoutThinking(baseline.messages));
        expect(baseline.messages.some((m) => m.parts.some(isThinkingPart))).toBe(true);
        expect(edited.messages.some((m) => m.parts.some(isThinkingPart))).toBe(false);
    });

test("system delivery: a conflicting producer hash under a held identity cannot replace its delivery", async () => {
    const f = await dbFixture();
    try {
        const request: LkgRequestIdentity = {
            kind: "v1",
            responseId: "reply-r",
            modelKey: "anthropic/opus",
        };
        // Request R sent system hash h1 while signed thinking kept m[0]/m[1] unchanged.
        f.delivery.recordSystemPromptForRequest(f.sessionId, request, "h1-sent-by-r", f.db);
        f.delivery.recordHeldHeadForRequest(f.sessionId, request);
        // The next producer call ran before R's successor identity was observed,
        // so it is filed under the same identity with a different hash.
        f.delivery.recordSystemPromptForRequest(f.sessionId, request, "h2-not-sent-by-r", f.db);
        f.delivery.acknowledgeSystemPromptDelivery({
            sessionId: f.sessionId,
            request,
            responseId: "reply-r",
            modelKey: "anthropic/opus",
            finish: "stop",
        });
        // R's reply proves the provider received h1 only. The cached system marker may
        // stay at its previous value ("old") or become h1, never the unsent h2.
        expect(["old", "h1-sent-by-r"]).toContain(f.hash() ?? "");
    } finally {
        f.close();
    }
});

it("system delivery: replay after held preparation cannot acknowledge replaced instructions", async () => {
    const f = await heldFixture("v2");
    const database = spyOn(storage, "openDatabase").mockReturnValue(f.db);
    recordToolDefinition("anthropic", "claude-opus-5-5", undefined, "read", "Read", {
        type: "object",
    });
    f.source.forEach((message, index) => {
        message.info.time = { created: index + 1 };
    });
    const signed = f.source.pop();
    if (!signed) throw new Error("missing signed tool-loop message");
    const baseline = await f.serve("base instructions");
    baseline.accept();
    expect(
        captureLkgSlot({
            sessionId: f.sessionId,
            input: f.source,
            output: baseline.output.messages,
            modelKey: "anthropic/claude-opus-5-5",
            providerKey: "anthropic",
            systemPromptTokens: getOrCreateSessionMeta(f.db, f.sessionId).systemPromptTokens,
        }),
    ).toBe(true);
    f.source.push(signed);
    const oldHash = f.hash();
    const record = f.delivery.recordHeldHeadForRequest;
    const failure = spyOn(f.delivery, "recordHeldHeadForRequest").mockImplementation(
        (...args: Parameters<typeof record>) => {
            record(...args);
            throw new Error("failure after held head preparation");
        },
    );
    let replayed = false;
    try {
        const wrapper = createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": async () => {
                    await f.serve("prepared instructions never sent");
                },
            },
            replayFits: () => true,
            onLkgReplay: () => {
                replayed = true;
            },
        });
        await wrapper({}, { messages: structuredClone(f.source) } as never);
        expect(replayed).toBe(true);
        const request = currentLkgRequestIdentity(f.sessionId);
        const createdAt = Date.now() + 1;
        f.delivery.bindSystemPromptResponse(f.sessionId, request, {
            responseId: "replayed-response",
            createdAt,
            modelKey: "anthropic/claude-opus-5-5",
        });
        noteLkgProviderResponse({
            sessionId: f.sessionId,
            responseId: "replayed-response",
            modelKey: "anthropic/claude-opus-5-5",
            inputTokens: 1000,
            createdAt,
            completedAt: createdAt + 1,
            finish: "stop",
            v2: true,
        });
        expect(f.hash()).toBe(oldHash);
        expect(getPendingOps(f.db, f.sessionId)).toHaveLength(1);
    } finally {
        failure.mockRestore();
        database.mockRestore();
        f.close();
    }
}, 120_000);

it("system delivery: OC2 latest foreign row cannot own the first response", async () => {
    const f = await dbFixture();
    const now = Date.now;
    Date.now = () => 100;
    try {
        const modelKey = "anthropic/claude-opus-5-5";
        beginV2LkgRequest(f.sessionId, modelKey, "previous", 10);
        const request = currentLkgRequestIdentity(f.sessionId);
        f.delivery.recordSystemPromptForRequest(f.sessionId, request, "new", f.db);
        f.delivery.recordHeldHeadForRequest(f.sessionId, request);
        const rows: StoreRow<"assistant">[] = [
            {
                id: "primary",
                session_id: f.sessionId,
                type: "assistant",
                seq: 11,
                data: {
                    model: { providerID: "anthropic", id: "claude-opus-5-5" },
                    time: { created: 101 },
                },
            },
            {
                id: "foreign-latest",
                session_id: f.sessionId,
                type: "assistant",
                seq: 12,
                data: {
                    model: { providerID: "anthropic", id: "claude-opus-5-5" },
                    time: { created: 102 },
                },
            },
        ];
        bindV2SystemPromptResponse(f.sessionId, {
            assistantSince: (_session, after) => rows.filter((row) => row.seq > after),
        });
        noteLkgProviderResponse({
            sessionId: f.sessionId,
            responseId: "foreign-latest",
            modelKey,
            inputTokens: 1000,
            createdAt: 102,
            completedAt: 200,
            finish: "stop",
            v2: true,
        });
        expect(f.hash()).toBe("old");
        noteLkgProviderResponse({
            sessionId: f.sessionId,
            responseId: "primary",
            modelKey,
            inputTokens: 1000,
            createdAt: 101,
            completedAt: 200,
            finish: "stop",
            v2: true,
        });
        expect(f.hash()).toBe("new");
    } finally {
        Date.now = now;
        f.close();
    }
});

it("system delivery: OC2 equal-millisecond first response cannot acknowledge", async () => {
    const f = await dbFixture();
    const now = Date.now;
    Date.now = () => 100;
    try {
        const modelKey = "anthropic/claude-opus-5-5";
        beginV2LkgRequest(f.sessionId, modelKey, "previous", 10);
        const request = currentLkgRequestIdentity(f.sessionId);
        f.delivery.recordSystemPromptForRequest(f.sessionId, request, "new", f.db);
        f.delivery.recordHeldHeadForRequest(f.sessionId, request);
        bindV2SystemPromptResponse(f.sessionId, {
            assistantSince: () => [
                {
                    id: "primary",
                    session_id: f.sessionId,
                    type: "assistant",
                    seq: 11,
                    data: {
                        model: { providerID: "anthropic", id: "claude-opus-5-5" },
                        time: { created: 100 },
                    },
                },
            ],
        });
        noteLkgProviderResponse({
            sessionId: f.sessionId,
            responseId: "primary",
            modelKey,
            inputTokens: 1000,
            createdAt: 100,
            completedAt: 200,
            finish: "stop",
            v2: true,
        });
        expect(f.hash()).toBe("old");
    } finally {
        Date.now = now;
        f.close();
    }
});
