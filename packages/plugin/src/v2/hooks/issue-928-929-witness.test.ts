/// <reference types="bun-types" />

/**
 * Witness tests for issues 928 and 929 on OpenCode 2's own usage and error
 * paths. The transform's model-change branch and the limit resolver are shared
 * with OpenCode 1 and are witnessed in
 * hooks/magic-context/issue-928-929-witness.test.ts.
 *
 * A passing test pins the behaviour the code has today. A skipped test asserts
 * the behaviour the issue expects (and OpenCode 1 already has); it fails on the
 * current code, and its comment names the mechanism that makes it fail.
 * Set MC_ISSUE_928_EXPECTED=1 to run the skipped tests.
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
const LIMIT_ERROR =
    "This model's maximum context length is 198000 tokens. However, your messages resulted in 205000 tokens.";

/** Runs a test for expected behaviour only on request; see the file comment. */
const itExpected = process.env.MC_ISSUE_928_EXPECTED === "1" ? it : it.skip;

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

/** A 400,000-token catalog window with no output limit, so usable equals context. */
async function seedCatalog(): Promise<void> {
    await refreshModelLimitsFromApi({
        config: {
            providers: async () => ({
                data: {
                    providers: [
                        {
                            id: MODEL.providerID,
                            models: { [MODEL.id]: { limit: { context: 400_000 } } },
                        },
                    ],
                },
            }),
        },
    });
}

/** Persist an accepted reply the way the OpenCode 2 context hook does. */
function persistAcceptedReply(
    db: ReturnType<typeof openDatabase>,
    sessionID: string,
    input: number,
    completed: number,
): void {
    const contextUsageMap: TransformDeps["contextUsageMap"] = new Map();
    const reading = resolveUsageReading({
        rowModel: { providerID: MODEL.providerID, id: MODEL.id },
        draftModel: MODEL,
        tokens: { input, cache: { read: 0, write: 0 } },
        completed,
        finish: "stop",
        limitFor: (providerID, modelID) =>
            resolveContextLimit(providerID, modelID, { db, sessionID }),
    });
    if (!reading) throw new Error("expected a usage reading");
    persistV2UsageReading({ db, sessionID, draftModel: MODEL, reading, contextUsageMap });
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

    it("step 2 (confirmed on OpenCode 2, current behaviour): an accepted request above the detected limit keeps the limit and is scored above 100% of it", async () => {
        useTempDataHome("issue-928-v2-step2-current-");
        await seedCatalog();
        const db = openDatabase();
        const sessionID = "ses-928-v2-step2-current";
        recordOverflowDetected(db, sessionID, 198_000, MODEL_KEY, "provider_overflow", "combined");

        persistAcceptedReply(db, sessionID, 253_659, 1_000);

        expect(getOverflowState(db, sessionID, MODEL_KEY).detectedContextLimit).toBe(198_000);
        const meta = getOrCreateSessionMeta(db, sessionID);
        expect(meta.lastUsageContextLimit).toBe(198_000);
        expect(meta.lastContextPercentage).toBeCloseTo((253_659 / 198_000) * 100, 6);
    });

    // Fails today: persistV2UsageReading (usage-persist.ts) records the reading
    // but has no counterpart of OpenCode 1's rule in event-handler.ts that
    // clears a detected limit an accepted larger request disproves.
    itExpected(
        "expected by issue 928 and OpenCode 1 parity: an accepted request above the detected limit clears it",
        async () => {
            useTempDataHome("issue-928-v2-step2-expected-");
            await seedCatalog();
            const db = openDatabase();
            const sessionID = "ses-928-v2-step2-expected";
            recordOverflowDetected(
                db,
                sessionID,
                198_000,
                MODEL_KEY,
                "provider_overflow",
                "combined",
            );

            persistAcceptedReply(db, sessionID, 253_659, 1_000);

            expect(getOverflowState(db, sessionID).detectedContextLimit).toBe(0);
        },
    );
});

describe("issue 929 on OpenCode 2", () => {
    it("does not apply to a native OpenCode 2 session: accepted readings never write a proven floor", async () => {
        useTempDataHome("issue-929-v2-");
        await seedCatalog();
        const db = openDatabase();
        const sessionID = "ses-929-v2";

        persistAcceptedReply(db, sessionID, 245_165, 1_000);

        const meta = getOrCreateSessionMeta(db, sessionID);
        expect(meta.lastObservedModelKey).toBe(MODEL_KEY);
        expect(meta.lastInputTokens).toBe(245_165);
        expect(meta.observedSafeInputTokens).toBe(0);
    });
});
