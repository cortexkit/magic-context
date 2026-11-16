/// <reference types="bun-types" />

/**
 * Witness tests for issues 928 and 929 on OpenCode 2's own usage and error
 * paths. The transform's model-change handling and the limit resolver are
 * shared with OpenCode 1 and are witnessed in
 * hooks/magic-context/issue-928-929-witness.test.ts.
 *
 * A test whose comment says it failed before the fix covers a changed rule;
 * the others pin behaviour that was already correct.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    getOverflowState,
    openDatabase,
    recordOverflowDetected,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { resolveContextLimit } from "../../hooks/magic-context/event-resolvers";
import type { TransformDeps } from "../../hooks/magic-context/transform";
import { clearModelsDevCache, refreshModelLimitsFromApi } from "../../shared/models-dev-cache";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { clearWindowGeometryLogForTest } from "../../shared/window-geometry";
import { V2OverflowRecovery } from "./overflow-recovery";
import { persistV2UsageReading } from "./usage-persist";
import { resolveUsageReading } from "./usage-reading";

const MODEL = { providerID: "gateway", id: "deepseek-v4.1-flash" };
const MODEL_KEY = `${MODEL.providerID}/${MODEL.id}`;
const OTHER_MODEL = { providerID: "gateway", id: "gpt-6-luna" };
const LIMIT_ERROR =
    "This model's maximum context length is 198000 tokens. However, your messages resulted in 205000 tokens.";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    closeDatabase();
    clearModelsDevCache();
    clearWindowGeometryLogForTest();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
});

function useTempDataHome(prefix: string): void {
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

/** 400,000-token catalog windows with no output limit, so usable equals context. */
async function seedCatalog(): Promise<void> {
    await refreshModelLimitsFromApi({
        config: {
            providers: async () => ({
                data: {
                    providers: [
                        {
                            id: MODEL.providerID,
                            models: {
                                [MODEL.id]: { limit: { context: 400_000 } },
                                [OTHER_MODEL.id]: { limit: { context: 400_000 } },
                            },
                        },
                    ],
                },
            }),
        },
    });
}

/** Completion times increase so no reading is skipped as older than the last one. */
let completedAt = 1_000;

/** Persist a reply the way the OpenCode 2 context hook does. */
function persistReply(
    db: ReturnType<typeof openDatabase>,
    sessionID: string,
    input: number,
    options: { model?: typeof MODEL; failed?: boolean } = {},
): TransformDeps["contextUsageMap"] {
    const model = options.model ?? MODEL;
    const contextUsageMap: TransformDeps["contextUsageMap"] = new Map();
    const limitFor = (providerID: string, modelID: string) =>
        resolveContextLimit(providerID, modelID, { db, sessionID });
    const reading = resolveUsageReading({
        rowModel: model,
        draftModel: model,
        tokens: { input, cache: { read: 0, write: 0 } },
        completed: ++completedAt,
        finish: options.failed ? "error" : "stop",
        ...(options.failed ? { error: { message: "upstream failed" } } : {}),
        limitFor,
    });
    if (!reading) throw new Error("expected a usage reading");
    persistV2UsageReading({ db, sessionID, draftModel: model, reading, contextUsageMap, limitFor });
    return contextUsageMap;
}

function narrowLimit(db: ReturnType<typeof openDatabase>, sessionID: string): void {
    recordOverflowDetected(db, sessionID, 198_000, MODEL_KEY, "provider_overflow", "combined");
}

describe("issue 928 on OpenCode 2", () => {
    it("step 1 (confirmed): a provider limit error records a model-keyed limit and zeroes the proven floor", () => {
        useTempDataHome("issue-928-v2-step1-");
        const db = openDatabase();
        const sessionID = "ses-928-v2-step1";
        // A floor can only reach an OpenCode 2 session from an OpenCode 1 run
        // of the same session; it is written directly here.
        updateSessionMeta(db, sessionID, { observedSafeInputTokens: 127_062 });
        const recovery = new V2OverflowRecovery({
            database: () => db,
            compactionOff: false,
            isHidden: () => false,
        });
        recovery.begin({ sessionID, kind: "primary", model: MODEL });

        recovery.observe({ sessionID, model: MODEL, error: { message: LIMIT_ERROR } });

        const raw = getOverflowState(db, sessionID);
        expect(raw.detectedContextLimit).toBe(198_000);
        expect(raw.detectedContextLimitModelKey).toBe(MODEL_KEY);
        expect(raw.needsEmergencyRecovery).toBe(true);
        expect(getOrCreateSessionMeta(db, sessionID).observedSafeInputTokens).toBe(0);
    });

    // Failed before the fix: persistV2UsageReading recorded the reading against
    // the stale limit (128%) and had no counterpart of OpenCode 1's rule.
    it("step 2: an accepted request above the model-keyed detected limit clears the limit and is scored against the catalog window", async () => {
        useTempDataHome("issue-928-v2-step2-");
        await seedCatalog();
        const db = openDatabase();
        const sessionID = "ses-928-v2-step2";
        narrowLimit(db, sessionID);

        const usage = persistReply(db, sessionID, 253_659);

        const overflow = getOverflowState(db, sessionID);
        expect(overflow.detectedContextLimit).toBe(0);
        expect(overflow.detectedContextLimitModelKey).toBeNull();
        // Limit only, as on OpenCode 1 and Pi: recovery ends on the pass whose
        // request fits.
        expect(overflow.needsEmergencyRecovery).toBe(true);
        const meta = getOrCreateSessionMeta(db, sessionID);
        expect(meta.lastUsageContextLimit).toBe(400_000);
        expect(meta.lastContextPercentage).toBeCloseTo((253_659 / 400_000) * 100, 6);
        expect(usage.get(sessionID)?.usage.percentage).toBeCloseTo((253_659 / 400_000) * 100, 6);
    });

    it("keeps the limit for an accepted request at or below it, a failed reply, or a reading from another model", async () => {
        useTempDataHome("issue-928-v2-keep-");
        await seedCatalog();
        const db = openDatabase();
        const sessionID = "ses-928-v2-keep";
        narrowLimit(db, sessionID);

        persistReply(db, sessionID, 198_000);
        expect(getOverflowState(db, sessionID).detectedContextLimit).toBe(198_000);
        expect(getOrCreateSessionMeta(db, sessionID).lastUsageContextLimit).toBe(198_000);

        persistReply(db, sessionID, 253_659, { failed: true });
        expect(getOverflowState(db, sessionID).detectedContextLimit).toBe(198_000);

        persistReply(db, sessionID, 253_659, { model: OTHER_MODEL });
        expect(getOverflowState(db, sessionID).detectedContextLimit).toBe(198_000);
        expect(getOverflowState(db, sessionID).detectedContextLimitModelKey).toBe(MODEL_KEY);
    });
});

describe("issue 929 on OpenCode 2", () => {
    it("does not apply to a native OpenCode 2 session: accepted readings never write a proven floor", async () => {
        useTempDataHome("issue-929-v2-");
        await seedCatalog();
        const db = openDatabase();
        const sessionID = "ses-929-v2";

        persistReply(db, sessionID, 245_165);

        const meta = getOrCreateSessionMeta(db, sessionID);
        expect(meta.lastObservedModelKey).toBe(MODEL_KEY);
        expect(meta.lastInputTokens).toBe(245_165);
        expect(meta.observedSafeInputTokens).toBe(0);
    });
});
