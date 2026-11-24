import { expect, spyOn, test } from "bun:test";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import {
    getActiveTagsBySession,
    getOrCreateSessionMeta,
    getPendingOps,
    getTagsBySession,
    queuePendingOp,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import { adaptPayload } from "../../v2/hooks/payload";
import type { SessionContext } from "../../v2/hooks/types";
import { createAutoSearchReplayFixture } from "./auto-search-replay.fixture";
import { type CompartmentTriggerResult, checkCompartmentTrigger } from "./compartment-trigger";
import * as injection from "./inject-compartments";
import { opencode1ToModelMessages } from "./opencode1-to-model-messages.fixture";
import {
    hasPendingMaterializationOrigin,
    requestPendingMaterialization,
} from "./pending-materialization";
import { resolveOpenCodeProtectedTailBoundary } from "./protected-tail-boundary";
import { setRawMessageProvider } from "./read-session-chunk";
import { buildInMemoryTailRawMessages } from "./read-session-raw";
import { type MessageLike, tagMessages } from "./tag-messages";
import { applyFlushedStatuses } from "./transform-operations";
import { runPostTransformPhase } from "./transform-postprocess-phase";

export function openCodeRideHarness(
    host: "opencode" | "opencode2",
    legacy = false,
    scenario?: "floor" | "small",
) {
    const fixture = createAutoSearchReplayFixture(host, "deferred-ride");
    let db = fixture.db;
    const id = fixture.sessionId;
    const pending = new Set<string>();
    const history = new Set<string>();
    const deferred = new Set<string>();
    let previous: MessageLike[] | null = null;
    let lastPass: Awaited<ReturnType<typeof runPostTransformPhase>> | undefined;
    let legacyBlock = "Baseline legacy history";
    const source: MessageLike[] = Array.from({ length: 18 }, (_, i) => ({
        info: {
            id: `msg_${String(i).padStart(4, "0")}`,
            role: i % 2 ? "assistant" : "user",
            sessionID: id,
        },
        parts: [
            {
                id: `part_${i}`,
                type: "text",
                text: `Message ${i}: independent historical content.`,
            },
        ],
    }));
    if (scenario === "floor") {
        for (let i = 2; i < source.length; i++) {
            source[i]!.parts[0]!.text =
                i === 2
                    ? "Implement the long autonomous task"
                    : i % 2 === 0
                      ? "<system-reminder>Continue working</system-reminder>"
                      : `Work phase ${i}: inspected code and verified the next change. `.repeat(
                            700,
                        );
        }
    }
    let lastTrigger: CompartmentTriggerResult | undefined;
    let rebuilds = 0;
    let protectQueued = false;
    let memoryEnabled = !!scenario;
    let publicationSequence = 1;
    let systemRevision = 0;
    let boundaryLimit = 96_000;
    appendCompartments(db, id, [
        {
            sequence: 0,
            startMessage: 1,
            endMessage: 2,
            startMessageId: "msg_0000",
            endMessageId: "msg_0001",
            title: "Baseline",
            content: "Existing history facts.\n".repeat(500),
            p1: "Existing history facts.\n".repeat(500),
        },
    ]);
    return {
        get db() {
            return db;
        },
        id,
        source,
        reopen() {
            fixture.reopen();
            db = fixture.db;
        },
        get lastTrigger() {
            return lastTrigger;
        },
        get rebuilds() {
            return rebuilds;
        },
        get lastPass() {
            return lastPass;
        },
        get wrapupPending() {
            return hasPendingMaterializationOrigin(pending, id, "user_wrapup");
        },
        setBoundaryLimit(limit: number) {
            boundaryLimit = limit;
        },
        inspectUnflooredBoundary() {
            const raw = buildInMemoryTailRawMessages({
                messages: source.map((m) => ({
                    id: m.info.id!,
                    role: m.info.role!,
                    parts: m.parts,
                })),
                lastCompartmentEnd: 0,
                anchorMessageId: null,
            })!;
            const unregister = setRawMessageProvider(id, { readMessages: () => raw.messages });
            try {
                return resolveOpenCodeProtectedTailBoundary({
                    db,
                    sessionId: id,
                    mode: "trigger",
                    contextLimit: boundaryLimit,
                    executeThresholdPercentage: 75,
                    usage: { percentage: 76, inputTokens: 72_960 },
                    liftLivePromptFloor: true,
                });
            } finally {
                unregister();
            }
        },
        protectQueue(value: boolean) {
            protectQueued = value;
        },
        setMemoryEnabled(value: boolean) {
            memoryEnabled = value;
        },
        fold() {
            systemRevision++;
        },
        appendTurn(meaningful: boolean) {
            const i = source.length;
            source.push(
                {
                    info: { id: `msg_${String(i).padStart(4, "0")}`, role: "user", sessionID: id },
                    parts: [
                        {
                            type: "text",
                            text: meaningful
                                ? `New human instruction ${i}`
                                : "<system-reminder>Continue working</system-reminder>",
                        },
                    ],
                },
                {
                    info: {
                        id: `msg_${String(i + 1).padStart(4, "0")}`,
                        role: "assistant",
                        sessionID: id,
                    },
                    parts: [{ type: "text", text: `Work continuation ${i}` }],
                },
            );
        },
        signal() {
            history.add(id);
            deferred.add(id);
        },
        flush() {
            requestPendingMaterialization(pending, id, "user_flush");
        },
        wrapup() {
            requestPendingMaterialization(pending, id, "user_wrapup");
        },
        publish({ endMessageId = "msg_0003", summaryLines = 20 } = {}) {
            updateSessionMeta(db, id, { compartmentInProgress: false });
            legacyBlock = "Fresh legacy history";
            appendCompartments(db, id, [
                {
                    sequence: publicationSequence++,
                    startMessage:
                        scenario === "floor" ? (lastTrigger?.boundarySnapshot?.offset ?? 3) : 3,
                    endMessage:
                        scenario === "floor"
                            ? (lastTrigger?.boundarySnapshot?.eligibleEndOrdinal ?? 5) - 1
                            : 4,
                    startMessageId:
                        scenario === "floor"
                            ? source[(lastTrigger?.boundarySnapshot?.offset ?? 3) - 1]!.info.id
                            : "msg_0002",
                    endMessageId:
                        scenario === "floor"
                            ? source[(lastTrigger?.boundarySnapshot?.eligibleEndOrdinal ?? 5) - 2]!
                                  .info.id
                            : endMessageId,
                    title: "Fresh publication",
                    content: "New history facts.\n".repeat(summaryLines),
                    p1: "New history facts.\n".repeat(summaryLines),
                },
            ]);
            history.add(id);
            deferred.add(id);
        },
        queue() {
            const tag = getTagsBySession(db, id).find((tag) =>
                tag.messageId.startsWith("msg_0007"),
            );
            if (!tag) throw new Error("missing queued target");
            queuePendingOp(db, id, tag.tagNumber, "drop");
        },
        async pass(percentage = 66) {
            const draft: SessionContext = {
                sessionID: id,
                model: { providerID: "openai", id: "gpt-test" },
                agent: "build",
                system: ["Fixed system prompt."],
                tools: {},
                options: {},
                messages: source.map((message) => ({
                    id: message.info.id,
                    role: message.info.role,
                    content: [{ type: "text", text: message.parts[0]!.text as string }],
                })) as SessionContext["messages"],
            };
            const mapped = host === "opencode2" ? adaptPayload(draft) : null;
            const messages = mapped ? (mapped.messages as MessageLike[]) : structuredClone(source);
            const tagger = createTagger();
            tagger.initFromDb(id, db);
            const tagged = tagMessages(id, messages, tagger, db);
            const tags = getActiveTagsBySession(db, id);
            applyFlushedStatuses(id, db, tagged.targets, getTagsBySession(db, id));
            if (scenario) {
                const raw = buildInMemoryTailRawMessages({
                    messages: source.map((m) => ({
                        id: m.info.id!,
                        role: m.info.role!,
                        parts: m.parts,
                    })),
                    lastCompartmentEnd: 0,
                    anchorMessageId: null,
                })!;
                const unregister = setRawMessageProvider(id, { readMessages: () => raw.messages });
                const previousEnv = process.env.NODE_ENV;
                try {
                    process.env.NODE_ENV = "production";
                    lastTrigger = checkCompartmentTrigger(
                        db,
                        id,
                        getOrCreateSessionMeta(db, id),
                        { percentage, inputTokens: percentage * 960 },
                        0,
                        75,
                        10_000,
                        undefined,
                        undefined,
                        undefined,
                        boundaryLimit,
                        raw,
                        undefined,
                        undefined,
                        undefined,
                        undefined,
                        percentage >= 75,
                    );
                    if (lastTrigger.shouldFire)
                        updateSessionMeta(db, id, { compartmentInProgress: true });
                } finally {
                    if (previousEnv === undefined) delete process.env.NODE_ENV;
                    else process.env.NODE_ENV = previousEnv;
                    unregister();
                }
            }
            const result = await runPostTransformPhase({
                sessionId: id,
                db,
                messages,
                tags,
                ...tagged,
                tagger,
                ctxReduceAvailability: { callable: true, frozen: true },
                todowriteAvailability: { callable: false, frozen: true },
                batch: null,
                contextUsage: { percentage, inputTokens: percentage * 1000 },
                usableWindow: 96_000,
                schedulerDecision: percentage >= (scenario ? 75 : 65) ? "execute" : "defer",
                fullFeatureMode: true,
                canRunCompartments: false,
                awaitedCompartmentRun: false,
                phaseJustAwaitedPublication: false,
                compartmentInProgress: false,
                historyRefreshExplicitBeforePrepare: false,
                deferredHistoryWasPendingAtPassStart: history.has(id),
                compartmentInjectionRebuiltFromDb: false,
                rebuiltHistoryFromInitialPrepare: false,
                historyRebuiltThisPass: history.has(id),
                canConsumeDeferredLate: percentage >= 65,
                sessionMeta: getOrCreateSessionMeta(db, id),
                currentTurnId: null,
                pendingMaterializationSessions: pending,
                deferredHistoryRefreshSessions: history,
                deferredMaterializationSessions: deferred,
                lastHeuristicsTurnId: new Map(),
                protectedTagIds: new Set(
                    protectQueued ? getPendingOps(db, id).map((op) => op.tagId) : [],
                ),
                protectedTagNumbers: new Set(
                    protectQueued ? getPendingOps(db, id).map((op) => op.tagId) : [],
                ),
                protectedCutoff: null,
                protectedCount: 0,
                pendingCompartmentInjection: legacy
                    ? {
                          block: legacyBlock,
                          compartmentEndMessage: 0,
                          compartmentEndMessageId: null,
                          compartmentCount: 1,
                          skippedVisibleMessages: 0,
                          factCount: 0,
                          memoryCount: 0,
                          rebuiltFromDb: history.has(id),
                      }
                    : null,
                didMutateFromFlushedStatuses: false,
                watermark: 0,
                forceMaterializationPercentage: 85,
                hasRecentReduceCall: false,
                readLastServedMessages: () => previous,
                m0M1: legacy
                    ? undefined
                    : {
                          ...fixture.renderOptions("openai/gpt-test"),
                          hardSignals: {
                              ...fixture.renderOptions("openai/gpt-test").hardSignals,
                              systemHash: systemRevision ? `system-${systemRevision}` : "system",
                          },
                          memoryEnabled,
                          temporalAwareness: false,
                      },
            });
            lastPass = result;
            if (result.bustedThisPass) rebuilds++;
            previous = structuredClone(messages);
            if (mapped) {
                mapped.commit();
                return structuredClone(draft.messages);
            }
            return opencode1ToModelMessages(messages, {
                providerID: "openai",
                id: "gpt-test",
                api: { npm: "@ai-sdk/openai", id: "gpt-test" },
            });
        },
        close() {
            fixture.close();
        },
    };
}

function firstDifference(previous: unknown[], next: unknown[]) {
    const index = previous.findIndex(
        (message, i) => JSON.stringify(message) !== JSON.stringify(next[i]),
    );
    return index < 0 && previous.length === next.length
        ? null
        : index < 0
          ? previous.length
          : index;
}

for (const host of ["opencode", "opencode2"] as const) {
    test(`${host} wrapup keeps its grant when a soft refresh serves the old history head`, async () => {
        const h = openCodeRideHarness(host);
        const injectM0M1 = injection.injectM0M1;
        let writes = 0;
        const inject = spyOn(injection, "injectM0M1");
        try {
            h.setMemoryEnabled(true);
            const before = await h.pass(40);
            h.publish();
            h.wrapup();
            inject.mockImplementation((options) =>
                injectM0M1({
                    ...options,
                    beforeCacheCommitForTest: () => {
                        if (writes++ !== 0) return;
                        h.db
                            .prepare(
                                "UPDATE session_meta SET cached_m0_materialized_at = cached_m0_materialized_at + 1 WHERE session_id = ?",
                            )
                            .run(h.id);
                    },
                }),
            );
            expect(await h.pass(40)).toEqual(before);
            expect(writes).toBe(1);
            expect(h.wrapupPending).toBe(true);
            const after = await h.pass(40);
            expect(JSON.stringify(after)).toContain("New history facts.");
            expect(h.wrapupPending).toBe(false);
            expect(await h.pass(40)).toEqual(after);
        } finally {
            inject.mockRestore();
            h.close();
        }
    });

    test(`${host} wrapup spends the grant when it safely refuses the trim`, async () => {
        const h = openCodeRideHarness(host);
        try {
            h.setMemoryEnabled(true);
            await h.pass(40);
            h.publish({ endMessageId: "msg_missing" });
            h.wrapup();
            const after = await h.pass(40);
            expect(h.lastPass?.prefixTrimStatus).toBe("refused");
            expect(JSON.stringify(after)).toContain("New history facts.");
            expect(JSON.stringify(after)).toContain("Message 3: independent historical content");
            expect(h.wrapupPending).toBe(false);

            h.queue();
            expect(await h.pass(40)).toEqual(after);
            expect(h.lastPass?.bustedThisPass).toBe(false);
            expect(h.lastPass?.explicitMaterializedSuccessfully).toBe(false);
            expect(getPendingOps(h.db, h.id)).toHaveLength(1);
        } finally {
            h.close();
        }
    });

    test(`${host} wrapup skips the size backstop only while applying the grant`, async () => {
        const h = openCodeRideHarness(host);
        try {
            h.setMemoryEnabled(true);
            await h.pass(40);
            const baseline = getOrCreateSessionMeta(h.db, h.id).cachedM0Bytes;
            expect(baseline).not.toBeNull();
            h.publish({ summaryLines: 200 });
            h.wrapup();
            const after = await h.pass(40);
            expect(h.lastPass?.prefixTrimStatus).toBe("applied");
            expect(JSON.stringify(after)).toContain("New history facts.");
            expect(
                getOrCreateSessionMeta(h.db, h.id).cachedM0Bytes?.equals(baseline!) === true,
                `m[0] changed on the wrapup pass (cause=${h.lastPass?.materializeReason})`,
            ).toBe(true);
            expect(h.wrapupPending).toBe(false);
            expect(await h.pass(40)).toEqual(after);

            await h.pass(85);
            expect(getOrCreateSessionMeta(h.db, h.id).cachedM0Bytes?.equals(baseline!)).toBe(false);
        } finally {
            h.close();
        }
    });
    test(`${host} legacy history admits drops only when the served history block changes`, async () => {
        const h = openCodeRideHarness(host, true);
        try {
            const previous = await h.pass(40);
            h.queue();
            h.signal();
            expect(await h.pass()).toEqual(previous);
            expect(getPendingOps(h.db, h.id)).toHaveLength(1);
            h.publish();
            const next = await h.pass();
            expect(next).not.toEqual(previous);
            expect(getPendingOps(h.db, h.id)).toHaveLength(0);
            expect(await h.pass()).toEqual(next);
        } finally {
            h.close();
        }
    });
    for (const kind of ["publication", "noop", "flush"] as const) {
        test(`${host} ${kind} uses served bytes or a real user flush for drop admission`, async () => {
            const run = async (queue: boolean) => {
                const h = openCodeRideHarness(host);
                try {
                    const previous = await h.pass(40);
                    if (kind === "publication") h.publish();
                    else if (kind === "flush") h.flush();
                    else h.signal();
                    if (queue) h.queue();
                    const next = await h.pass();
                    const pending = getPendingOps(h.db, h.id).length;
                    const warm = await h.pass();
                    if (kind === "noop") {
                        h.publish();
                        await h.pass();
                        expect(getPendingOps(h.db, h.id)).toHaveLength(0);
                    }
                    return { previous, next, warm, pending };
                } finally {
                    h.close();
                }
            };
            const withheld = await run(false);
            const applied = await run(true);
            expect(applied.previous).toEqual(withheld.previous);
            expect(applied.warm).toEqual(applied.next);
            expect(withheld.warm).toEqual(withheld.next);
            if (kind === "noop") {
                expect(applied.next).toEqual(applied.previous);
                expect(applied.pending).toBe(1);
            } else {
                expect(applied.pending).toBe(0);
                expect(applied.next).not.toEqual(withheld.next);
                if (kind === "publication") {
                    // Both host projections merge the adjacent synthetic user slots.
                    expect(firstDifference(withheld.previous, withheld.next)).toBe(0);
                    expect(firstDifference(applied.previous, applied.next)).toBe(0);
                } else {
                    expect(withheld.next).toEqual(withheld.previous);
                    expect(applied.next.slice(0, 2)).toEqual(applied.previous.slice(0, 2));
                }
            }
        });
    }
}
