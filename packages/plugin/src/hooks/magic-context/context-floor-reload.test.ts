import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { createScheduler } from "../../features/magic-context/scheduler";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    loadPersistedUsage,
    openDatabase,
    recordDetectedContextLimit,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import { clearModelsDevCache, refreshModelLimitsFromApi } from "../../shared/models-dev-cache";
import { createTestTempDir } from "../../shared/test-temp-dir";
import {
    resolveContextLimit,
    resolveContextWindowGeometry,
    resolveTrustedContextLimit,
} from "./event-resolvers";
import { clearInjectionCache } from "./inject-compartments";
import { resetLkgSlotsForTest } from "./lkg-slot";
import { recordOpenCodeProvenInputFloor } from "./opencode-proven-floor";
import { createTransform } from "./transform";

const sessionId = "ses-context-floor-reload";
const modelKey = "reload-provider/large-model";
const provenFloor = 935_073;
const originalDataHome = process.env.XDG_DATA_HOME;
const tempDirs: string[] = [];

afterEach(() => {
    clearInjectionCache(sessionId);
    resetLkgSlotsForTest();
    closeDatabase();
    clearModelsDevCache();
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalDataHome;
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
});

async function fixture(generation: "v1" | "v2") {
    const { dir } = createTestTempDir("mc-context-floor-reload-");
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    const db = openDatabase()!;
    await refreshModelLimitsFromApi({
        config: {
            providers: async () => ({
                data: {
                    providers: [
                        {
                            id: "reload-provider",
                            models: {
                                "large-model": { limit: { context: 1_000_000, output: 128_000 } },
                                "small-model": { limit: { context: 200_000, output: 32_000 } },
                            },
                        },
                    ],
                },
            }),
        },
    });
    appendCompartments(db, sessionId, [
        {
            sequence: 1,
            startMessage: 1,
            endMessage: 1,
            startMessageId: "old-user",
            endMessageId: "old-user",
            title: "Recorded history",
            content: "",
            p1: "Keep the frozen history head across plugin reloads.",
        },
    ]);
    let modelID = "large-model";
    const permissions: boolean[] = [];
    const makeTransform = () =>
        createTransform({
            db,
            storeGeneration: generation,
            directory: dir,
            injectDocs: false,
            tagger: createTagger(),
            scheduler: createScheduler({ executeThresholdPercentage: 65 }),
            contextUsageMap: new Map(),
            liveModelBySession: new Map([[sessionId, { providerID: "reload-provider", modelID }]]),
            getModelKey: () => `reload-provider/${modelID}`,
            historyRefreshSessions: new Set(),
            pendingMaterializationSessions: new Set(),
            lastHeuristicsTurnId: new Map(),
            historyBudgetPercentage: 0.15,
            executeThresholdPercentage: 65,
            protectedTokens: 0,
            onPassPermission: (_id, permission) => permissions.push(permission),
        });
    const pass = async (transform: ReturnType<typeof createTransform>) => {
        const messages: Parameters<ReturnType<typeof createTransform>>[1]["messages"] = [
            {
                info: { id: "new-user", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "Continue the work." }],
            },
        ];
        await transform({}, { messages });
        return JSON.stringify(messages);
    };
    const recordUsage = () => {
        updateSessionMeta(db, sessionId, {
            lastContextPercentage: 10,
            lastInputTokens: 93_507,
            lastUsageContextLimit: provenFloor,
            lastObservedModelKey: modelKey,
            observedSafeInputTokens: provenFloor,
            lastResponseTime: Date.now(),
        });
        recordOpenCodeProvenInputFloor(db, sessionId, modelKey, provenFloor);
    };

    const beforeReload = makeTransform();
    await pass(beforeReload);
    recordUsage();
    // A genuine system change establishes the larger rendered baseline before
    // the reload; only the reload itself must avoid another head write.
    updateSessionMeta(db, sessionId, { systemPromptHash: "stable-system" });
    const baseline = await pass(beforeReload);
    const baselineMeta = getOrCreateSessionMeta(db, sessionId);
    expect(baselineMeta.cachedM0UpgradeState).toContain("|rendered-budgets:m8000-h91169");
    expect(baseline).toContain("Keep the frozen history head");
    // A fold can reuse identical normalized payload bytes; its scalar marker
    // still advances once, while a steady-state replay must not write it.
    db.exec(`CREATE TEMP TABLE head_writes (n INTEGER);
        CREATE TEMP TRIGGER count_head AFTER UPDATE OF cached_m0_materialized_at ON session_meta
        BEGIN INSERT INTO head_writes VALUES (1); END`);

    return {
        db,
        baseline,
        baselineMeta,
        permissions,
        pass,
        reload: () => {
            recordUsage();
            clearInjectionCache(sessionId);
            return makeTransform();
        },
        switchModel: () => {
            modelID = "small-model";
        },
        headWrites: () => db.query("SELECT COUNT(*) AS n FROM head_writes").get(),
    };
}

describe("proven context floor across plugin reloads", () => {
    for (const generation of ["v1", "v2"] as const) {
        it(`${generation} first pass after reload keeps the proven window and history budget without rebuilding`, async () => {
            const f = await fixture(generation);
            const context = { db: f.db, sessionID: sessionId };
            expect(resolveContextLimit("reload-provider", "large-model")).toBe(872_000);
            expect(resolveContextLimit("reload-provider", "large-model", context)).toBe(
                provenFloor,
            );

            const reloaded = await f.pass(f.reload());
            expect(loadPersistedUsage(f.db, sessionId)).toBeNull();
            expect(resolveContextLimit("reload-provider", "large-model", context)).toBe(
                provenFloor,
            );
            expect(resolveTrustedContextLimit("reload-provider", "large-model", context)).toBe(
                provenFloor,
            );
            expect(
                resolveContextWindowGeometry("reload-provider", "large-model", context)?.usableSoft,
            ).toBe(provenFloor);
            const after = getOrCreateSessionMeta(f.db, sessionId);
            expect(after.cachedM0UpgradeState).toBe(f.baselineMeta.cachedM0UpgradeState);
            expect(after.cachedM0MaterializedAt).toBe(f.baselineMeta.cachedM0MaterializedAt);
            expect(f.headWrites()).toEqual({ n: 0 });
            expect(f.permissions.at(-1)).toBe(false);
            expect(reloaded).toBe(f.baseline);
        });

        for (const drop of ["model change", "provider limit", "overflow"] as const) {
            it(`${generation} a real ${drop} still lowers the window and rebuilds after reload`, async () => {
                const f = await fixture(generation);
                if (drop === "model change") f.switchModel();
                const reloaded = f.reload();
                if (drop !== "model change") {
                    // Both a provider-reported prompt cap and a combined-window
                    // overflow use the existing model-scoped detected-limit path.
                    recordDetectedContextLimit(
                        f.db,
                        sessionId,
                        200_000,
                        modelKey,
                        drop === "provider limit" ? "prompt_only" : "combined",
                    );
                }
                await f.pass(reloaded);
                const model = drop === "model change" ? "small-model" : "large-model";
                const limit =
                    drop === "provider limit" ? 200_000 : drop === "overflow" ? 150_000 : 168_000;
                const context = { db: f.db, sessionID: sessionId };
                expect(resolveContextLimit("reload-provider", model, context)).toBe(limit);
                expect(resolveTrustedContextLimit("reload-provider", model, context)).toBe(limit);
                expect(
                    resolveContextWindowGeometry("reload-provider", model, context)?.usableSoft,
                ).toBe(limit);
                expect(getOrCreateSessionMeta(f.db, sessionId).cachedM0UpgradeState).toContain(
                    `|rendered-budgets:m8000-h${drop === "provider limit" ? 19500 : drop === "overflow" ? 14625 : 16380}`,
                );
                expect(f.headWrites()).toEqual({ n: 1 });
            });
        }
    }
});
