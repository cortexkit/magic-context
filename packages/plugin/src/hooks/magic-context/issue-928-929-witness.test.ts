/// <reference types="bun-types" />

/**
 * Witness tests for issues 928 and 929 on OpenCode 1, plus the transform and
 * limit resolver that OpenCode 2 shares.
 *
 * Each test names a claim from the issue and what the code does with it.
 * A passing test pins the behaviour the code has today. A skipped test asserts
 * the behaviour the issue (and, where noted, Pi parity) expects; it fails on
 * the current code, and its comment names the mechanism that makes it fail.
 * Set MC_ISSUE_928_EXPECTED=1 to run the skipped tests.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { __resetMessageIndexAsyncForTests } from "../../features/magic-context/message-index-async";
import {
    clearEmergencyRecovery,
    closeDatabase,
    getOrCreateSessionMeta,
    getOverflowState,
    openDatabase,
    recordOverflowDetected,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import {
    clearDetectedContextLimit,
    recordDetectedContextLimit,
} from "../../features/magic-context/storage-meta-persisted";
import { createTagger } from "../../features/magic-context/tagger";
import { __test as transformDecisionTest } from "../../features/magic-context/transform-decision-log";
import type { PluginContext } from "../../plugin/types";
import * as loggerModule from "../../shared/logger";
import { clearModelsDevCache, refreshModelLimitsFromApi } from "../../shared/models-dev-cache";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { clearWindowGeometryLogForTest } from "../../shared/window-geometry";
import { createEventHandler } from "./event-handler";
import {
    resolveContextLimit,
    resolveContextWindowGeometry,
    resolveExecuteThresholdDetail,
    resolveTrustedContextLimit,
} from "./event-resolvers";
import { resetLkgSlotsForTest } from "./lkg-slot";
import { recordOpenCodeProvenInputFloor } from "./opencode-proven-floor";
import { __ignoredNotificationTest } from "./send-session-notification";
import { createTransform } from "./transform";

// One gateway provider serves both models. NARROW is the model id whose route
// refused at 198,000 tokens; OTHER is the model the session switches to.
const PROVIDER = "gateway";
const NARROW = "deepseek-v4.1-flash";
const OTHER = "gpt-6-luna";
const NARROW_KEY = `${PROVIDER}/${NARROW}`;
const OTHER_KEY = `${PROVIDER}/${OTHER}`;
const LIMIT_ERROR =
    "This model's maximum context length is 198000 tokens. However, your messages resulted in 205000 tokens.";

/** Runs a test for expected behaviour only on request; see the file comment. */
const itExpected = process.env.MC_ISSUE_928_EXPECTED === "1" ? it : it.skip;

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;

beforeEach(() => {
    __ignoredNotificationTest.setHoldDetector(() => false);
});

afterEach(() => {
    __ignoredNotificationTest.reset();
    __resetMessageIndexAsyncForTests();
    transformDecisionTest.reset();
    resetLkgSlotsForTest();
    closeDatabase();
    clearModelsDevCache();
    clearWindowGeometryLogForTest();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* Ignore EBUSY on Windows */
        }
    }
    tempDirs.length = 0;
});

function useTempDataHome(prefix: string): void {
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    process.env.XDG_CACHE_HOME = dir;
}

/** Catalog windows with no output limit, so the usable window equals the context. */
function catalog(narrowContext: number) {
    return {
        config: {
            providers: async () => ({
                data: {
                    providers: [
                        {
                            id: PROVIDER,
                            models: {
                                [NARROW]: { limit: { context: narrowContext } },
                                [OTHER]: { limit: { context: 400_000 } },
                            },
                        },
                    ],
                },
            }),
        },
    };
}

async function seedCatalog(narrowContext: number): Promise<void> {
    clearModelsDevCache();
    await refreshModelLimitsFromApi(catalog(narrowContext));
}

function limitFor(db: ReturnType<typeof openDatabase>, sessionID: string, modelID = NARROW) {
    return resolveContextLimit(PROVIDER, modelID, { db, sessionID });
}

function createUsageHandler(narrowContext: number) {
    const db = openDatabase();
    const contextUsageMap = new Map();
    const handler = createEventHandler({
        contextUsageMap,
        compactionHandler: { onCompacted: mock(() => {}) },
        config: { cache_ttl: "5m" },
        tagger: {
            assignTag: mock(() => 0),
            bindTag: mock(() => {}),
            getTag: mock(() => undefined),
            getAssignments: mock(() => new Map()),
            resetCounter: mock(() => {}),
            getCounter: mock(() => 0),
            initFromDb: mock(() => {}),
            cleanup: mock(() => {}),
        },
        db,
        // The handler re-reads model limits through the client after a reading;
        // it must see the same catalog the test seeded.
        client: { ...catalog(narrowContext), session: { prompt: mock(async () => ({})) } },
    } as unknown as Parameters<typeof createEventHandler>[0]);
    return { db, handler, contextUsageMap };
}

let messageSequence = 0;
function nextMessageId(): string {
    messageSequence += 1;
    return `msg-${String(messageSequence).padStart(6, "0")}`;
}

function acceptedReply(sessionID: string, input: number, modelID = NARROW) {
    return {
        event: {
            type: "message.updated",
            properties: {
                info: {
                    id: nextMessageId(),
                    role: "assistant",
                    sessionID,
                    providerID: PROVIDER,
                    modelID,
                    finish: "stop",
                    tokens: { input, cache: { read: 0, write: 0 } },
                },
            },
        },
    };
}

function refusedReply(sessionID: string, modelID = NARROW) {
    return {
        event: {
            type: "message.updated",
            properties: {
                info: {
                    id: nextMessageId(),
                    role: "assistant",
                    sessionID,
                    providerID: PROVIDER,
                    modelID,
                    error: { message: LIMIT_ERROR },
                    tokens: { input: 0, cache: { read: 0, write: 0 } },
                },
            },
        },
    };
}

describe("issue 928, OpenCode 1 usage events", () => {
    it("step 1 (confirmed): a provider limit error records a model-keyed limit and zeroes the proven floor", async () => {
        useTempDataHome("issue-928-step1-oc1-");
        await seedCatalog(400_000);
        const { db, handler } = createUsageHandler(400_000);
        const sessionID = "ses-928-step1";

        await handler(acceptedReply(sessionID, 127_062));
        expect(getOrCreateSessionMeta(db, sessionID).observedSafeInputTokens).toBe(127_062);

        await handler(refusedReply(sessionID));

        const raw = getOverflowState(db, sessionID);
        expect(raw.detectedContextLimit).toBe(198_000);
        expect(raw.detectedContextLimitModelKey).toBe(NARROW_KEY);
        expect(raw.detectedContextLimitProvenance).toBe("combined");
        expect(getOrCreateSessionMeta(db, sessionID).observedSafeInputTokens).toBe(0);
        expect(limitFor(db, sessionID)).toBe(198_000);
    });

    it("step 2 (refuted on OpenCode 1): an accepted request above a model-keyed detected limit clears it and raises the floor", async () => {
        useTempDataHome("issue-928-step2-oc1-");
        await seedCatalog(400_000);
        const { db, handler } = createUsageHandler(400_000);
        const sessionID = "ses-928-step2";
        recordOverflowDetected(db, sessionID, 198_000, NARROW_KEY, "provider_overflow", "combined");
        clearEmergencyRecovery(db, sessionID);
        expect(limitFor(db, sessionID)).toBe(198_000);

        await handler(acceptedReply(sessionID, 253_659));

        expect(getOverflowState(db, sessionID).detectedContextLimit).toBe(0);
        const meta = getOrCreateSessionMeta(db, sessionID);
        expect(meta.observedSafeInputTokens).toBe(253_659);
        expect(meta.lastObservedModelKey).toBe(NARROW_KEY);
        expect(limitFor(db, sessionID)).toBe(400_000);
    });

    it("secondary variant (confirmed, by design): an accepted request below the detected limit leaves it in place", async () => {
        useTempDataHome("issue-928-below-oc1-");
        await seedCatalog(400_000);
        const { db, handler } = createUsageHandler(400_000);
        const sessionID = "ses-928-below";
        recordOverflowDetected(db, sessionID, 198_000, NARROW_KEY, "provider_overflow", "combined");
        clearEmergencyRecovery(db, sessionID);

        await handler(acceptedReply(sessionID, 150_000));

        expect(getOverflowState(db, sessionID, NARROW_KEY).detectedContextLimit).toBe(198_000);
        // The accepted reading is still stored as the floor, but no reader
        // consults the floor while a detected limit applies to the model.
        expect(getOrCreateSessionMeta(db, sessionID).observedSafeInputTokens).toBe(150_000);
        expect(limitFor(db, sessionID)).toBe(198_000);
    });
});

describe("window precedence: detected limit, proven floor and catalog window (OpenCode 1 and 2 share this resolver)", () => {
    it("a model-keyed detected limit caps the catalog window and the floor is not consulted; without it the floor lifts only a smaller catalog window", async () => {
        useTempDataHome("issue-928-precedence-");
        const db = openDatabase();
        const sessionID = "ses-928-precedence";
        await seedCatalog(400_000);
        recordDetectedContextLimit(db, sessionID, 198_000, NARROW_KEY, "combined");
        // A floor above the detected limit cannot arise from the usage handlers
        // (recording a limit zeroes the floor, and an accepted request above the
        // limit clears the limit). It is written directly here to show that the
        // readers ignore the floor whenever a detected limit applies.
        updateSessionMeta(db, sessionID, {
            observedSafeInputTokens: 245_000,
            lastObservedModelKey: NARROW_KEY,
        });
        recordOpenCodeProvenInputFloor(db, sessionID, NARROW_KEY, 245_000);

        expect(limitFor(db, sessionID)).toBe(198_000);
        expect(resolveTrustedContextLimit(PROVIDER, NARROW, { db, sessionID })).toBe(198_000);
        const capped = resolveContextWindowGeometry(PROVIDER, NARROW, { db, sessionID });
        expect(capped?.usableSoft).toBe(198_000);
        expect(capped?.derivation.windowSource).toBe("detected");
        expect(capped?.derivation.provenInputTokens).toBeUndefined();
        // The execute threshold is derived from the same limit: a token
        // threshold above 90% of it is clamped to 90% of 198,000.
        const threshold = resolveExecuteThresholdDetail(65, NARROW_KEY, 65, {
            tokensConfig: { default: 190_000 },
            contextLimit: resolveTrustedContextLimit(PROVIDER, NARROW, { db, sessionID }),
        });
        expect(threshold.absoluteTokens).toBe(178_200);

        // With the detected limit gone, the floor (245,000) is below the
        // 400,000 catalog window and changes nothing.
        clearDetectedContextLimit(db, sessionID);
        expect(limitFor(db, sessionID)).toBe(400_000);

        // A catalog window below the floor is lifted to the floor.
        await seedCatalog(128_000);
        expect(limitFor(db, sessionID)).toBe(245_000);
        expect(
            resolveContextWindowGeometry(PROVIDER, NARROW, { db, sessionID })?.derivation
                .provenInputTokens,
        ).toBe(245_000);

        // A combined-provenance detected limit only lowers the window: above a
        // 128,000 catalog window it leaves 128,000, and recording it zeroed the floor.
        recordDetectedContextLimit(db, sessionID, 198_000, NARROW_KEY, "combined");
        expect(getOrCreateSessionMeta(db, sessionID).observedSafeInputTokens).toBe(0);
        expect(limitFor(db, sessionID)).toBe(128_000);
    });
});

describe("issue 929, OpenCode 1: the proven floor has no route identity", () => {
    it("a floor proven on one route of a model id sizes the window for any route of it, until that route's own limit error replaces it", async () => {
        useTempDataHome("issue-929-oc1-");
        await seedCatalog(128_000);
        const { db, handler } = createUsageHandler(128_000);
        const sessionID = "ses-929";

        // Route A (wide) accepts 245,165 tokens: the floor lifts the window.
        await handler(acceptedReply(sessionID, 245_165));
        expect(getOrCreateSessionMeta(db, sessionID).observedSafeInputTokens).toBe(245_165);
        expect(limitFor(db, sessionID)).toBe(245_165);

        // The gateway moves the same model id to route B (198,000 wall). Its
        // accepted 190,000-token request is scored against route A's floor.
        await handler(acceptedReply(sessionID, 190_000));
        const meta = getOrCreateSessionMeta(db, sessionID);
        expect(meta.lastUsageContextLimit).toBe(245_165);
        expect(meta.lastContextPercentage).toBeCloseTo((190_000 / 245_165) * 100, 6);

        // Route B's limit error zeroes the floor and arms recovery at once; the
        // window falls back to the catalog window capped by the detected limit.
        await handler(refusedReply(sessionID));
        const overflow = getOverflowState(db, sessionID, NARROW_KEY);
        expect(overflow.detectedContextLimit).toBe(198_000);
        expect(overflow.needsEmergencyRecovery).toBe(true);
        expect(getOrCreateSessionMeta(db, sessionID).observedSafeInputTokens).toBe(0);
        expect(limitFor(db, sessionID)).toBe(128_000);
    });
});

function createOpenCodeDb(sessionId: string): void {
    const dbPath = join(process.env.XDG_DATA_HOME!, "opencode", "opencode.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    try {
        db.exec(`
      CREATE TABLE IF NOT EXISTS message (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS part (
        id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
      );
    `);
        db.prepare(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, 1, 1, ?)",
        ).run(
            "m-raw-1",
            sessionId,
            JSON.stringify({ id: "m-raw-1", role: "user", sessionID: sessionId }),
        );
        db.prepare(
            "INSERT INTO part (message_id, session_id, time_created, time_updated, data) VALUES (?, ?, 1, 1, ?)",
        ).run("m-raw-1", sessionId, JSON.stringify({ type: "text", text: "recent" }));
    } finally {
        closeQuietly(db);
    }
}

function makeTransform(db: ReturnType<typeof openDatabase>, generation: "v1" | "v2") {
    const liveModelBySession = new Map<string, { providerID: string; modelID: string }>();
    return createTransform({
        db,
        storeGeneration: generation,
        tagger: createTagger(),
        scheduler: { shouldExecute: mock(() => "defer" as const) },
        contextUsageMap: new Map(),
        historyRefreshSessions: new Set<string>(),
        pendingMaterializationSessions: new Set<string>(),
        lastHeuristicsTurnId: new Map<string, string>(),
        clearReasoningAge: 50,
        protectedTokens: 0,
        liveModelBySession,
        getModelKey: (id: string) => {
            const m = liveModelBySession.get(id);
            return m ? `${m.providerID}/${m.modelID}` : undefined;
        },
        client: {
            session: { abort: mock(async () => ({ data: true })), prompt: mock(async () => ({})) },
        } as unknown as PluginContext["client"],
        directory: "/tmp",
    });
}

/**
 * The request shape on a turn sent to `next` after a reply from `previous`:
 * the last assistant carries the model that produced it, the newest user
 * message carries the selected model, which is what the transform resolves.
 */
function turnMessages(sessionId: string, turn: number, previous: string, next: string) {
    return [
        {
            info: { id: `m-user-${turn}-0`, role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: "earlier" }],
        },
        {
            info: {
                id: `m-assistant-${turn}`,
                role: "assistant",
                sessionID: sessionId,
                providerID: PROVIDER,
                modelID: previous,
            },
            parts: [{ type: "text", text: "reply" }],
        },
        {
            info: {
                id: `m-user-${turn}-1`,
                role: "user",
                sessionID: sessionId,
                model: { providerID: PROVIDER, modelID: next },
            },
            parts: [{ type: "text", text: "continue" }],
        },
    ];
}

/**
 * The narrow model refused at 198,000 tokens. `lastObservedModel` is the model
 * of the last accepted reply: NARROW when the narrow route later answered a
 * smaller request, OTHER when the refused request was the narrow model's only one.
 */
async function narrowLimitAfterRefusal(sessionId: string, lastObservedModel: string) {
    createOpenCodeDb(sessionId);
    await seedCatalog(400_000);
    const db = openDatabase();
    updateSessionMeta(db, sessionId, {
        lastContextPercentage: 30,
        lastInputTokens: 60_000,
        lastObservedModelKey: `${PROVIDER}/${lastObservedModel}`,
        lastUsageContextLimit: 400_000,
    });
    recordOverflowDetected(db, sessionId, 198_000, NARROW_KEY, "provider_overflow", "combined");
    // Emergency recovery ends on the next pass that fits; it keeps the limit.
    clearEmergencyRecovery(db, sessionId);
    return db;
}

for (const generation of ["v1", "v2"] as const) {
    const host = generation === "v1" ? "OpenCode 1" : "OpenCode 2";
    describe(`issue 928, transform model-change branch on ${host}`, () => {
        it("step 4 (refuted when the narrow model answered after its refusal): switching away clears its limit", async () => {
            useTempDataHome(`issue-928-switch-answered-${generation}-`);
            const sessionId = `ses-928-answered-${generation}`;
            const db = await narrowLimitAfterRefusal(sessionId, NARROW);
            const transform = makeTransform(db, generation);

            await transform({}, { messages: turnMessages(sessionId, 1, NARROW, OTHER) });

            expect(getOverflowState(db, sessionId).detectedContextLimit).toBe(0);
            expect(getOverflowState(db, sessionId).detectedContextLimitModelKey).toBeNull();
        });

        it("second way into the same state: while the stored usage reads zero (after a first-pass or refused-turn reset), a model switch is not seen at all", async () => {
            useTempDataHome(`issue-928-switch-zero-usage-${generation}-`);
            const sessionId = `ses-928-zero-usage-${generation}`;
            const db = await narrowLimitAfterRefusal(sessionId, NARROW);
            // The reading the model-change check compares with is ignored when
            // both stored usage fields are zero, which is what the first-pass and
            // refused-turn resets leave behind until the next accepted reply.
            updateSessionMeta(db, sessionId, { lastContextPercentage: 0, lastInputTokens: 0 });
            const transform = makeTransform(db, generation);

            await transform({}, { messages: turnMessages(sessionId, 1, NARROW, OTHER) });

            expect(getOverflowState(db, sessionId).detectedContextLimit).toBe(198_000);
            expect(getOverflowState(db, sessionId).detectedContextLimitModelKey).toBe(NARROW_KEY);
        });

        it("steps 3 and 4 (confirmed when the narrow model's only request was refused): the limit outlives the switch away and a restart, and is preserved on return", async () => {
            useTempDataHome(`issue-928-switch-refused-${generation}-`);
            const sessionId = `ses-928-refused-${generation}`;
            let db = await narrowLimitAfterRefusal(sessionId, OTHER);
            let transform = makeTransform(db, generation);

            // Back on OTHER after NARROW's refused reply: the last accepted
            // reply was OTHER's, so the transform sees no model change and the
            // narrow limit stays stored, hidden from OTHER by the model-key guard.
            await transform({}, { messages: turnMessages(sessionId, 1, NARROW, OTHER) });
            expect(getOverflowState(db, sessionId).detectedContextLimit).toBe(198_000);
            expect(getOverflowState(db, sessionId).detectedContextLimitModelKey).toBe(NARROW_KEY);
            expect(getOverflowState(db, sessionId, OTHER_KEY).detectedContextLimit).toBe(0);

            // OTHER answers that turn, which records its usage again.
            updateSessionMeta(db, sessionId, {
                lastContextPercentage: 31,
                lastInputTokens: 62_000,
                lastObservedModelKey: OTHER_KEY,
            });

            // Restart: the row is durable and nothing resets it at startup.
            closeDatabase();
            db = openDatabase();
            transform = makeTransform(db, generation);
            expect(getOverflowState(db, sessionId).detectedContextLimit).toBe(198_000);

            // Switching to NARROW: the model differs from the last accepted
            // reply's, and the stored limit belongs to NARROW, so it is preserved.
            const log = spyOn(loggerModule, "sessionLog");
            try {
                await transform({}, { messages: turnMessages(sessionId, 2, OTHER, NARROW) });
                const lines = log.mock.calls.map(([, text]) => String(text));
                expect(
                    lines.some((line) =>
                        line.includes(
                            `preserving detected limit 198000 and overflow recovery for outgoing model ${NARROW_KEY}`,
                        ),
                    ),
                ).toBe(true);
            } finally {
                log.mockRestore();
            }
            expect(getOverflowState(db, sessionId, NARROW_KEY).detectedContextLimit).toBe(198_000);
            expect(limitFor(db, sessionId)).toBe(198_000);
        });

        // Fails today: the trigger compares the outgoing model with the model of
        // the last ACCEPTED reply (lastObservedModelKey, transform.ts). The
        // narrow model's only request was refused, so that key never became
        // NARROW and leaving NARROW is not seen as a change. Pi compares with
        // the model of the previous pass and clears on any switch.
        itExpected(
            "expected by issue 928 and Pi parity: leaving the model that owns a detected limit clears it, even when its only request was refused",
            async () => {
                useTempDataHome(`issue-928-switch-expected-${generation}-`);
                const sessionId = `ses-928-expected-${generation}`;
                const db = await narrowLimitAfterRefusal(sessionId, OTHER);
                const transform = makeTransform(db, generation);

                await transform({}, { messages: turnMessages(sessionId, 1, NARROW, OTHER) });

                expect(getOverflowState(db, sessionId).detectedContextLimit).toBe(0);
            },
        );
    });
}
