import { expect, mock, spyOn, test } from "bun:test";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { createScheduler } from "../../features/magic-context/scheduler";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    openDatabase,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import type { PluginContext } from "../../plugin/types";
import * as logger from "../../shared/logger";
import { clearModelsDevCache, refreshModelLimitsFromApi } from "../../shared/models-dev-cache";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { persistV2UsageReading } from "../../v2/hooks/usage-persist";
import type { UsageReading } from "../../v2/hooks/usage-reading";
import { getActiveCompartmentRun, registerActiveCompartmentRun } from "./compartment-runner";
import { clearInjectionCache } from "./inject-compartments";
import { requestPendingMaterialization } from "./pending-materialization";
import type { MessageLike } from "./tag-messages";
import { createTransform, type TransformDeps } from "./transform";

for (const generation of ["v2", "v1"] as const) {
    test(`${generation} escapes repeated untrusted historian timeouts after publication and accepts fresh pressure`, async () => {
        const home = createTestTempDir("stale-usage-publication-");
        const db = openDatabase(`${home.dir}/context.db`)!;
        const sessionId = `stale-usage-${generation}`;
        const route = { providerID: "stale-usage-provider", modelID: "100k" };
        const clock = spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
        const logs = spyOn(logger, "sessionLog").mockImplementation(() => {});
        const usage: TransformDeps["contextUsageMap"] = new Map();
        const scheduler = createScheduler({ executeThresholdPercentage: 65 });
        const schedule = spyOn(scheduler, "shouldExecute");
        const deferred = new Set<string>();
        const pending = new Set<string>();
        let reading: UsageReading | undefined;
        const finishes: Array<() => void> = [];
        let providerCalls = 0;
        const source = (): MessageLike[] =>
            Array.from({ length: 9 }, (_, index) => ({
                info: {
                    id: `m${index + 1}`,
                    role: index % 2 ? "assistant" : "user",
                    sessionID: sessionId,
                    ...(index % 2 ? route : {}),
                },
                parts: [{ type: "text", text: index === 8 ? "Continue" : "Earlier work" }],
            }));
        const startSlowHistorian = () => {
            updateSessionMeta(db, sessionId, { compartmentInProgress: true });
            return registerActiveCompartmentRun(
                sessionId,
                new Promise<void>((resolve) => finishes.push(resolve)),
            );
        };
        const acceptReading = (percentage: number) => {
            clock.mockReturnValue(Date.now() + 100);
            reading = {
                inputTokens: percentage * 1000,
                limit: 100_000,
                admissionLimit: 100_000,
                modelKey: `${route.providerID}/${route.modelID}`,
                completed: Date.now(),
                finish: "stop",
            };
            if (generation === "v2") {
                persistV2UsageReading({
                    db,
                    sessionID: sessionId,
                    draftModel: { providerID: route.providerID, id: route.modelID },
                    reading,
                    contextUsageMap: usage,
                });
            } else {
                updateSessionMeta(db, sessionId, {
                    lastResponseTime: Date.now(),
                    lastContextPercentage: percentage,
                    lastInputTokens: percentage * 1000,
                    lastUsageContextLimit: 100_000,
                    lastObservedModelKey: reading.modelKey,
                });
                usage.set(sessionId, {
                    usage: { percentage, inputTokens: percentage * 1000 },
                    updatedAt: Date.now(),
                    hasUsageTokens: true,
                });
            }
        };
        try {
            await refreshModelLimitsFromApi({
                config: {
                    providers: async () => ({
                        data: {
                            providers: [
                                {
                                    id: route.providerID,
                                    models: { [route.modelID]: { limit: { input: 100_000 } } },
                                },
                            ],
                        },
                    }),
                },
            });
            getOrCreateSessionMeta(db, sessionId);
            updateSessionMeta(db, sessionId, { cacheTtl: "never" });
            const transform = createTransform({
                db,
                tagger: createTagger(),
                scheduler,
                storeGeneration: generation,
                contextUsageMap: usage,
                liveModelBySession: new Map([[sessionId, route]]),
                getModelKey: () => `${route.providerID}/${route.modelID}`,
                historyRefreshSessions: new Set(),
                deferredHistoryRefreshSessions: deferred,
                pendingMaterializationSessions: pending,
                lastHeuristicsTurnId: new Map(),
                directory: home.dir,
                protectedTokens: 0,
                historianTimeoutMs: 5,
                injectDocs: false,
                memoryConfig: { enabled: false },
                client: {
                    session: {
                        get: mock(async () => ({ data: { directory: home.dir, title: "Usage" } })),
                        prompt: mock(async () => ({})),
                    },
                } as unknown as PluginContext["client"],
                hostRawMessages: () => [],
            });
            const attempt = async () => {
                try {
                    if (generation === "v2" && reading)
                        persistV2UsageReading({
                            db,
                            sessionID: sessionId,
                            draftModel: { providerID: route.providerID, id: route.modelID },
                            reading,
                            contextUsageMap: usage,
                        });
                    await transform({}, { messages: source() });
                    providerCalls++;
                    return "provider";
                } catch (error) {
                    expect(error).toMatchObject({ name: "EmergencyFailClosedError" });
                    return "refused";
                }
            };
            // Warm the process so the restart reset cannot hide the stale-reading loop.
            expect(await attempt()).toBe("provider");
            providerCalls = 0;
            acceptReading(97);
            startSlowHistorian();
            expect(await attempt()).toBe("refused");
            expect(providerCalls).toBe(0);
            expect(schedule.mock.calls.at(-1)?.[1].percentage).toBe(97);
            expect(schedule.mock.results.at(-1)?.value).toBe("execute");
            expect(
                logs.mock.calls.some(([, line]) => String(line).includes("estimateTrusted=false")),
            ).toBe(true);

            const laterTurns: string[] = [];
            for (let sequence = 0; sequence < 3; sequence++) {
                clock.mockReturnValue(Date.now() + 100);
                appendCompartments(db, sessionId, [
                    {
                        sequence,
                        startMessage: sequence * 2 + 1,
                        endMessage: sequence * 2 + 2,
                        startMessageId: `m${sequence * 2 + 1}`,
                        endMessageId: `m${sequence * 2 + 2}`,
                        title: `Summary ${sequence}`,
                        content: "Earlier work was summarized.",
                    },
                ]);
                const active = getActiveCompartmentRun(sessionId)!;
                active.published = true;
                deferred.add(sessionId);
                finishes.at(-1)!();
                await active.promise;
                updateSessionMeta(db, sessionId, { compartmentInProgress: false });
                // A deliberate flush makes the pass estimate the outgoing request;
                // publishing alone still does not allow changing the cached prefix.
                requestPendingMaterialization(pending, sessionId, "user_flush");
                // Another background run must not make the old reading block again.
                startSlowHistorian();
                laterTurns.push(await attempt());
            }
            console.log(
                `${generation} post-publication turns: ${laterTurns.join(", ")}; provider calls=${providerCalls}`,
            );
            expect(laterTurns).toEqual(["provider", "provider", "provider"]);
            expect(providerCalls).toBe(3);
            expect(schedule.mock.calls.at(-1)?.[1].percentage).toBeLessThan(85);
            expect(getOrCreateSessionMeta(db, sessionId).lastInputTokens).toBe(0);
            expect(
                logs.mock.calls.some(([, line]) =>
                    String(line).includes("unknown provider usage; using wire estimate"),
                ),
            ).toBe(true);
            if (generation === "v2")
                expect(
                    logs.mock.calls.some(([, line]) =>
                        String(line).includes("skipped stale reading"),
                    ),
                ).toBe(true);

            acceptReading(97);
            expect(await attempt()).toBe("refused");
            expect(schedule.mock.calls.at(-1)?.[1].percentage).toBe(97);
        } finally {
            for (const finish of finishes) finish();
            await getActiveCompartmentRun(sessionId)?.promise;
            schedule.mockRestore();
            logs.mockRestore();
            clock.mockRestore();
            clearInjectionCache(sessionId);
            clearModelsDevCache();
            closeDatabase();
            home.cleanup();
        }
    });
}
