/// <reference types="bun-types" />
// Randomized served-byte differential of the tool-definition totals against a
// base revision, for OpenCode 1 and OpenCode 2 (TypeScript mode).
//
// It needs two source snapshots next to this checkout and is skipped without
// them:
//   MC_797_DIFF_BASE  a checkout of the base revision (node_modules linked)
//   MC_797_DIFF_HEAD  a checkout of this revision (node_modules linked)
// Each snapshot is imported as its own module graph, so each has its own
// tool-definition store, model-limit cache and last-known-good slots.
//
// One seeded session runs here, warm, through this checkout's transform; it
// only drives the session's stored state. Before every pass the session
// database is snapshotted once and copied twice, and the same input runs
// through a fresh base transform and a fresh head transform on those copies.
// The two tool-definition stores live across passes and receive the same tool
// flights: the route's offered tools change over time, another session on the
// same route sometimes flies a different set, and restarts reload each store
// from its own tool table, which starts with rows of tools the route no longer
// offers (what versions before stored-set pruning left behind). Some passes
// have no live provider reading (a restart or a model switch), so the pass
// sizes itself from the local count, which includes the tool-definition total.
//
// Each pass checks:
// - a pass base serves without rebuilding the cache (a defer pass) is served
//   byte for byte by head too;
// - head never rebuilds the cache on a pass base did not (no new rebuilds);
// - every other difference is a pass whose decision read the tool-definition
//   total (the unknown-usage sizing, or a size refusal), and is listed.
import { afterAll, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { createScheduler } from "../../features/magic-context/scheduler";
import {
    getOrCreateSessionMeta,
    getTagsBySession,
    openDatabase,
    queuePendingOp,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { clearCachedM0M1 } from "../../features/magic-context/storage-meta-shared";
import { createTagger } from "../../features/magic-context/tagger";
import * as loggerModule from "../../shared/logger";
import { refreshModelLimitsFromApi } from "../../shared/models-dev-cache";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import { resolveContextLimit } from "./event-resolvers";
import { resetLkgSlotsForTest } from "./lkg-slot";
import { requestPendingMaterialization } from "./pending-materialization";
import { providerVisiblePart } from "./provider-visible-parts";
import { createTransform } from "./transform";

const BASE = process.env.MC_797_DIFF_BASE;
const HEAD = process.env.MC_797_DIFF_HEAD;
const PASSES = Number(process.env.MC_797_DIFF_PASSES ?? 320);
const SEED = Number(process.env.MC_797_DIFF_SEED ?? 797);

const MODEL = { providerID: "anthropic", modelID: "claude-opus-5" };
const WINDOW = { context: 60_000, output: 4_000 };
const POOL = 40;
const RETIRED = 30;
const RETIRED_TOKENS = 300;

type Message = { info: Record<string, unknown>; parts: Array<Record<string, unknown>> };
type Tool = { id: string; description: string; parameters: unknown };
type ToolStore = {
    recordToolDefinition: (...args: unknown[]) => void;
    recordToolDefinitionSet?: (...args: unknown[]) => void;
    loadToolDefinitionMeasurements: (db: unknown) => void;
    setDatabase: (db: unknown) => void;
    __resetToolDefinitionMeasurements: () => void;
    getMeasuredToolDefinitionTokens: (...args: unknown[]) => number | undefined;
};
type Graph = {
    name: string;
    createTransform: typeof createTransform;
    openDatabase: typeof openDatabase;
    closeDatabase: () => Promise<void>;
    createTagger: typeof createTagger;
    createScheduler: typeof createScheduler;
    requestPendingMaterialization: typeof requestPendingMaterialization;
    resetLkgSlotsForTest: typeof resetLkgSlotsForTest;
    refreshModelLimitsFromApi: typeof refreshModelLimitsFromApi;
    tools: ToolStore;
    logger: typeof loggerModule;
    toolDb: { exec: (sql: string) => void; close: () => void } | null;
};

async function loadGraph(root: string, name: string): Promise<Graph> {
    const src = join(root, "packages/plugin/src");
    const [transform, storage, tagger, scheduler, pending, lkg, logger, tools, models] =
        await Promise.all([
            import(join(src, "hooks/magic-context/transform.ts")),
            import(join(src, "features/magic-context/storage.ts")),
            import(join(src, "features/magic-context/tagger.ts")),
            import(join(src, "features/magic-context/scheduler.ts")),
            import(join(src, "hooks/magic-context/pending-materialization.ts")),
            import(join(src, "hooks/magic-context/lkg-slot.ts")),
            import(join(src, "shared/logger.ts")),
            import(join(src, "features/magic-context/tool-definition-tokens.ts")),
            import(join(src, "shared/models-dev-cache.ts")),
        ]);
    return {
        name,
        createTransform: transform.createTransform,
        openDatabase: storage.openDatabase,
        closeDatabase: storage.closeDatabase,
        createTagger: tagger.createTagger,
        createScheduler: scheduler.createScheduler,
        requestPendingMaterialization: pending.requestPendingMaterialization,
        resetLkgSlotsForTest: lkg.resetLkgSlotsForTest,
        refreshModelLimitsFromApi: models.refreshModelLimitsFromApi,
        tools,
        logger,
        toolDb: null,
    };
}

async function openToolDb(root: string, graph: Graph, path: string) {
    const src = join(root, "packages/plugin/src");
    const [{ Database }, { initializeDatabase }, { runMigrations }] = await Promise.all([
        import(join(src, "shared/sqlite.ts")),
        import(join(src, "features/magic-context/storage-db.ts")),
        import(join(src, "features/magic-context/migrations.ts")),
    ]);
    const db = new Database(path);
    initializeDatabase(db);
    runMigrations(db);
    // What a version before stored-set pruning leaves behind: rows for tools
    // the route was offered once and no longer is.
    for (let i = 0; i < RETIRED; i++)
        db.prepare(
            `INSERT OR REPLACE INTO tool_definition_measurements
             (provider_id, model_id, agent_name, tool_id, token_count, recorded_at)
             VALUES (?, ?, 'default', ?, ?, 1)`,
        ).run(MODEL.providerID, MODEL.modelID, `retired_${i}`, RETIRED_TOKENS);
    graph.toolDb = db;
    graph.tools.__resetToolDefinitionMeasurements();
    graph.tools.loadToolDefinitionMeasurements(db);
    graph.tools.setDatabase(db);
}

function rng(seed: number) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function prose(chars: number, seed: number): string {
    const words = ["boundary", "session", "window", "pressure", "replay", "baseline", "ordinal"];
    const out: string[] = [];
    let length = 0;
    for (let i = seed; length < chars; i++) {
        const word = words[i % words.length]!;
        out.push(word);
        length += word.length + 1;
    }
    return out.join(" ");
}

/** The provider-visible bytes of one message, without empty text. */
function providerKey(message: Message | undefined): string {
    if (!message) return "missing";
    return JSON.stringify({
        id: message.info.id,
        role: message.info.role,
        parts: message.parts
            .filter((p) => !(p.type === "text" && p.text === ""))
            .map(providerVisiblePart),
    });
}

const digest = (messages: Message[]) =>
    createHash("sha256").update(messages.map(providerKey).join("\n")).digest("hex");

/** A pass rewrote the cached prefix: queued operations applied, or a fold or refresh ran. */
const rebuilt = (lines: string[]) =>
    lines.some(
        (line) =>
            /pending ops WILL APPLY|executed=true|m1Refreshed=true|emergency tiered drop: /.test(
                line,
            ) && !/WILL NOT/.test(line),
    );

/**
 * The decision a pass made from the tool-definition total when it had no live
 * provider reading: which reading it used and its percentage (the local count
 * itself is left out; it differs whenever the totals differ).
 */
const toolTotalDecision = (lines: string[]) =>
    lines
        .filter((line) => line.includes("unknown provider usage;"))
        .map((line) => {
            const kind = /using ([a-z -]+?) for priced pass/.exec(line)?.[1] ?? "unknown";
            const reading = / percentage=([\d.]+)/.exec(line)?.[1] ?? "?";
            return `${kind} ${reading}%`;
        });

const report: string[] = [];
afterAll(() => {
    if (report.length > 0) console.log(report.join("\n"));
});

for (const host of ["opencode1", "opencode2"] as const) {
    it.skipIf(!BASE || !HEAD)(
        `${host}: tool-definition differential against base over ${PASSES} passes`,
        async () => {
            const root = createTestTempDir("mc-797-diff-").dir;
            const base = await loadGraph(BASE!, "base");
            const head = await loadGraph(HEAD!, "head");
            await openToolDb(BASE!, base, join(root, "base-tools.db"));
            await openToolDb(HEAD!, head, join(root, "head-tools.db"));
            const limits = {
                config: {
                    providers: async () => ({
                        data: {
                            providers: [
                                {
                                    id: MODEL.providerID,
                                    models: { [MODEL.modelID]: { limit: WINDOW } },
                                },
                            ],
                        },
                    }),
                },
            };
            await refreshModelLimitsFromApi(limits);
            await base.refreshModelLimitsFromApi(limits);
            await head.refreshModelLimitsFromApi(limits);
            const lines = { base: [] as string[], head: [] as string[], warm: [] as string[] };
            const spies = [
                spyOn(loggerModule, "sessionLog").mockImplementation((...a) => {
                    lines.warm.push(a.slice(1).map(String).join(" "));
                }),
                spyOn(base.logger, "sessionLog").mockImplementation((...a) => {
                    lines.base.push(a.slice(1).map(String).join(" "));
                }),
                spyOn(head.logger, "sessionLog").mockImplementation((...a) => {
                    lines.head.push(a.slice(1).map(String).join(" "));
                }),
            ];
            const random = rng(SEED + (host === "opencode2" ? 1 : 0));
            const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
            const sessionId = `tool-diff-${host}`;
            const sessionDirectory = join(root, "project");
            mkdirSync(sessionDirectory, { recursive: true });
            const db = openDatabase(join(root, "warm.db"))!;
            const limit = resolveContextLimit(MODEL.providerID, MODEL.modelID, {
                db,
                sessionID: sessionId,
            });
            const pool: Tool[] = Array.from({ length: POOL }, (_, i) => ({
                id: `tool_${i}`,
                description: prose(300 + Math.floor(random() * 1500), i),
                parameters: { type: "object", properties: { [`arg${i}`]: { type: "string" } } },
            }));
            let offered = new Set(pool.slice(0, 25).map((tool) => tool.id));
            const counts = {
                passes: 0,
                identical: 0,
                differing: 0,
                baseDefer: 0,
                baseDeferIdentical: 0,
                unknownUsagePasses: 0,
                restarts: 0,
                foreignFlights: 0,
                toolSetChanges: 0,
                baseRebuilds: 0,
                headRebuilds: 0,
                users: 0,
                drops: 0,
                flushes: 0,
                compartments: 0,
                idle: 0,
                baseThrew: 0,
                headThrew: 0,
                toolTotalsDiffer: 0,
                sizedWithoutReading: 0,
                maxBaseCountPercentage: 0,
                maxHeadCountPercentage: 0,
                maxBaseToolTokens: 0,
                maxHeadToolTokens: 0,
            };
            const failures: string[] = [];
            const decisions: string[] = [];
            const fly = (graph: Graph, tools: Tool[], owner: string) => {
                if (host === "opencode2" && graph.tools.recordToolDefinitionSet)
                    // What head's recordV2ToolDefinitions does with a request draft.
                    graph.tools.recordToolDefinitionSet(
                        MODEL.providerID,
                        MODEL.modelID,
                        undefined,
                        tools,
                        owner,
                    );
                // OpenCode 1's tool.definition fires, and base's
                // recordV2ToolDefinitions, which recorded one tool at a time.
                else
                    for (const tool of tools)
                        graph.tools.recordToolDefinition(
                            MODEL.providerID,
                            MODEL.modelID,
                            undefined,
                            tool.id,
                            tool.description,
                            tool.parameters,
                            owner,
                        );
            };
            try {
                getOrCreateSessionMeta(db, sessionId);
                updateSessionMeta(db, sessionId, {
                    cacheTtl: "1h",
                    lastResponseTime: Date.now(),
                    systemPromptTokens: 1_500,
                });
                let percent = 30;
                const usageEntry = () => ({
                    usage: {
                        percentage: percent,
                        inputTokens: Math.round((limit * percent) / 100),
                    },
                    updatedAt: Date.now(),
                    hasUsageTokens: true,
                });
                const historyRefresh = new Set<string>();
                const pendingOrigins: Array<"user_flush"> = [];
                const lastHeuristics = new Map<string, string | null>();
                const hostDeps =
                    host === "opencode2"
                        ? {
                              storeGeneration: "v2" as const,
                              hostCleanupCompactionMarkers: () => ({
                                  verified: true,
                                  removedLineages: 0,
                                  removedRows: 0,
                                  retainedLineages: 0,
                              }),
                          }
                        : {};
                const warmPending = new Set<string>();
                let warmUsage = new Map([[sessionId, usageEntry()]]);
                const buildWarm = () => {
                    warmUsage = new Map([[sessionId, usageEntry()]]);
                    return createTransform({
                        db,
                        tagger: createTagger(),
                        scheduler: createScheduler({ executeThresholdPercentage: 65 }),
                        contextUsageMap: warmUsage,
                        historyRefreshSessions: historyRefresh,
                        pendingMaterializationSessions: warmPending,
                        lastHeuristicsTurnId: lastHeuristics,
                        liveModelBySession: new Map([[sessionId, MODEL]]),
                        protectedTokens: 2000,
                        historianRunnable: false,
                        directory: sessionDirectory,
                        sessionDirectoryBySession: new Map([[sessionId, sessionDirectory]]),
                        ...hostDeps,
                    });
                };
                let warm = buildWarm();
                const source: Message[] = [];
                let clock = 1;
                let call = 0;
                let compartmentEnd = -1;
                let compartmentSequence = 0;
                const user = () => {
                    source.push({
                        info: {
                            id: `user-${clock}`,
                            role: "user",
                            sessionID: sessionId,
                            time: { created: clock++ },
                        },
                        parts: [{ type: "text", text: `task ${clock}` }],
                    });
                };
                const toolStep = () => {
                    const callID = `call-${++call}`;
                    source.push({
                        info: {
                            id: `assistant-${callID}`,
                            role: "assistant",
                            sessionID: sessionId,
                            time: { created: clock++ },
                            finish: "tool-calls",
                            ...MODEL,
                        },
                        parts: [
                            { type: "text", text: `step ${call}` },
                            {
                                type: "tool",
                                callID,
                                tool: pick([...offered]),
                                state: {
                                    status: "completed",
                                    input: { path: `${call}.ts` },
                                    output: `${callID} ${prose(1_000 + Math.floor(random() * 4_800), call)}`,
                                },
                            },
                        ],
                    });
                };
                user();
                toolStep();
                for (let pass = 0; pass < PASSES; pass++) {
                    let unknownUsage = false;
                    if (pass > 1) {
                        if (random() < 0.1) {
                            user();
                            counts.users++;
                        }
                        toolStep();
                        if (random() < 0.2) {
                            const tools = getTagsBySession(db, sessionId).filter(
                                (tag) => tag.type === "tool" && tag.status === "active",
                            );
                            if (tools.length > 0) {
                                queuePendingOp(db, sessionId, pick(tools).tagNumber, "drop");
                                counts.drops++;
                            }
                        }
                        if (random() < 0.25)
                            percent = pick([20, 40, 55, 62, 66, 70, 74, 78, 82, 86, 90, 94]);
                        if (random() < 0.08) {
                            pendingOrigins.push("user_flush");
                            counts.flushes++;
                        }
                        if (random() < 0.12) {
                            const next = new Set(offered);
                            if (random() < 0.5 && next.size > 10) next.delete(pick([...next]));
                            else next.add(pick(pool).id);
                            offered = next;
                            counts.toolSetChanges++;
                        }
                        if (random() < 0.07) {
                            const ends: number[] = [];
                            for (let i = compartmentEnd + 2; i < source.length - 6; i++)
                                if (source[i + 1]!.info.role === "user") ends.push(i);
                            if (ends.length > 0) {
                                const end = pick(ends);
                                appendCompartments(db, sessionId, [
                                    {
                                        sequence: compartmentSequence++,
                                        startMessage: compartmentEnd + 2,
                                        endMessage: end + 1,
                                        startMessageId: String(source[compartmentEnd + 1]!.info.id),
                                        endMessageId: String(source[end]!.info.id),
                                        title: `history ${pass}`,
                                        content: `U: summarized work up to pass ${pass}`,
                                    },
                                ]);
                                compartmentEnd = end;
                                historyRefresh.add(sessionId);
                                counts.compartments++;
                            }
                        }
                        if (random() < 0.04) {
                            updateSessionMeta(db, sessionId, {
                                lastResponseTime: Date.now() - 2 * 60 * 60 * 1000,
                            });
                            counts.idle++;
                        }
                        if (random() < 0.02) clearCachedM0M1(db, sessionId);
                        if (random() < 0.05) {
                            // Restart: both stores reload from their own tool tables.
                            for (const graph of [base, head]) {
                                graph.tools.__resetToolDefinitionMeasurements();
                                graph.tools.loadToolDefinitionMeasurements(graph.toolDb);
                                graph.tools.setDatabase(graph.toolDb);
                            }
                            resetLkgSlotsForTest();
                            warm = buildWarm();
                            unknownUsage = true;
                            // Half the restarts queue a /ctx-flush, so the first pass after
                            // them may rewrite the cached prefix and size the request.
                            if (random() < 0.5) pendingOrigins.push("user_flush");
                            counts.restarts++;
                        } else if (random() < 0.08) unknownUsage = true;
                        if (random() < 0.15) {
                            // Another session on the same route flies a different set.
                            const foreign = pool.filter((_, i) => (i + pass) % 3 === 0);
                            for (const graph of [base, head]) fly(graph, foreign, "other-session");
                            counts.foreignFlights++;
                        }
                    }
                    const flight = pool.filter((tool) => offered.has(tool.id));
                    for (const graph of [base, head]) fly(graph, flight, sessionId);
                    const totals = [base, head].map(
                        (graph) =>
                            graph.tools.getMeasuredToolDefinitionTokens(
                                MODEL.providerID,
                                MODEL.modelID,
                                undefined,
                                sessionId,
                            ) ?? 0,
                    );
                    if (totals[0] !== totals[1]) counts.toolTotalsDiffer++;
                    counts.maxBaseToolTokens = Math.max(counts.maxBaseToolTokens, totals[0]!);
                    counts.maxHeadToolTokens = Math.max(counts.maxHeadToolTokens, totals[1]!);
                    if (unknownUsage) counts.unknownUsagePasses++;
                    for (const origin of pendingOrigins.splice(0))
                        requestPendingMaterialization(warmPending, sessionId, origin);
                    warmUsage.set(sessionId, usageEntry());
                    // The provider's last reading, as the event handler persists it.
                    updateSessionMeta(db, sessionId, {
                        lastContextPercentage: percent,
                        lastInputTokens: Math.round((limit * percent) / 100),
                        lastUsageContextLimit: limit,
                        lastObservedModelKey: `${MODEL.providerID}/${MODEL.modelID}`,
                    });

                    const snapshot = join(root, `snapshot-${pass}.db`);
                    db.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);
                    const run = async (graph: Graph) => {
                        const path = join(root, `${graph.name}-${pass}.db`);
                        copyFileSync(snapshot, path);
                        graph.resetLkgSlotsForTest();
                        const copy = graph.openDatabase(path);
                        // Opening a store rebinds the tool-definition store to it;
                        // keep this graph's own tool table instead.
                        graph.tools.setDatabase(graph.toolDb);
                        const pending = new Set<string>();
                        if (warmPending.has(sessionId))
                            graph.requestPendingMaterialization(pending, sessionId, "user_flush");
                        const transform = graph.createTransform({
                            db: copy as never,
                            tagger: graph.createTagger(),
                            scheduler: graph.createScheduler({ executeThresholdPercentage: 65 }),
                            contextUsageMap: new Map(
                                unknownUsage ? [] : [[sessionId, usageEntry()]],
                            ),
                            historyRefreshSessions: new Set(historyRefresh),
                            pendingMaterializationSessions: pending,
                            lastHeuristicsTurnId: new Map(lastHeuristics),
                            liveModelBySession: new Map([[sessionId, MODEL]]),
                            protectedTokens: 2000,
                            historianRunnable: false,
                            directory: sessionDirectory,
                            sessionDirectoryBySession: new Map([[sessionId, sessionDirectory]]),
                            ...hostDeps,
                        } as never);
                        const messages = structuredClone(source);
                        let threw: string | undefined;
                        try {
                            await transform({}, { messages } as never);
                        } catch (error) {
                            threw = (error as Error)?.constructor?.name ?? String(error);
                        } finally {
                            await graph.closeDatabase();
                            for (const suffix of ["", "-wal", "-shm"])
                                rmSync(`${path}${suffix}`, { force: true });
                        }
                        return { messages, threw };
                    };
                    lines.base.length = 0;
                    lines.head.length = 0;
                    lines.warm.length = 0;
                    const baseRun = await run(base);
                    const baseLines = [...lines.base];
                    const headRun = await run(head);
                    const headLines = [...lines.head];
                    rmSync(snapshot, { force: true });
                    await warm({}, { messages: structuredClone(source) } as never);
                    updateSessionMeta(db, sessionId, { lastResponseTime: Date.now() });
                    counts.passes++;
                    if (baseRun.threw) counts.baseThrew++;
                    if (headRun.threw) counts.headThrew++;
                    const baseRebuilt = rebuilt(baseLines);
                    const headRebuilt = rebuilt(headLines);
                    if (baseRebuilt) counts.baseRebuilds++;
                    if (headRebuilt) counts.headRebuilds++;
                    const same =
                        baseRun.threw === headRun.threw &&
                        digest(baseRun.messages) === digest(headRun.messages);
                    const baseDefer = !baseRebuilt && !baseRun.threw;
                    if (baseDefer) counts.baseDefer++;
                    const baseDecision = toolTotalDecision(baseLines);
                    const headDecision = toolTotalDecision(headLines);
                    if (baseDecision.length > 0) counts.sizedWithoutReading++;
                    const counted = (lines: string[]) => {
                        // The local count: logged as countPercentage beside a saved
                        // reading, or as the reading itself when the count was used.
                        const line =
                            lines.find((entry) => entry.includes("unknown provider usage;")) ?? "";
                        const match =
                            /countPercentage=([\d.]+)/.exec(line) ??
                            / percentage=([\d.]+)/.exec(line);
                        return Number(match?.[1] ?? 0);
                    };
                    counts.maxBaseCountPercentage = Math.max(
                        counts.maxBaseCountPercentage,
                        counted(baseLines),
                    );
                    counts.maxHeadCountPercentage = Math.max(
                        counts.maxHeadCountPercentage,
                        counted(headLines),
                    );
                    if (same) {
                        counts.identical++;
                        if (baseDefer) counts.baseDeferIdentical++;
                        continue;
                    }
                    counts.differing++;
                    const detail = `pass ${pass} (unknownUsage=${unknownUsage} usage=${percent}% baseRebuilt=${baseRebuilt} headRebuilt=${headRebuilt} baseThrew=${baseRun.threw ?? "-"} headThrew=${headRun.threw ?? "-"}) base: ${baseDecision.join(" | ") || "-"} head: ${headDecision.join(" | ") || "-"}`;
                    if (baseDefer) failures.push(`defer pass not byte-identical: ${detail}`);
                    else if (headRebuilt && !baseRebuilt)
                        failures.push(`new cache rebuild: ${detail}`);
                    else if (
                        JSON.stringify(baseDecision) === JSON.stringify(headDecision) &&
                        baseRun.threw === headRun.threw
                    )
                        failures.push(`difference without a tool-total decision: ${detail}`);
                    else decisions.push(detail);
                }
                report.push(
                    `${host} tool-definition differential (seed ${SEED}): ${JSON.stringify(counts)}`,
                );
                report.push(
                    `${host} decisions that differ (each read the tool-definition total):\n  ${decisions.join("\n  ") || "none"}`,
                );
                if (failures.length > 0)
                    report.push(`${host} failures:\n  ${failures.join("\n  ")}`);
                expect(failures).toEqual([]);
                expect(counts.passes).toBe(PASSES);
                expect(counts.baseDefer).toBeGreaterThan(0);
                expect(counts.unknownUsagePasses).toBeGreaterThan(0);
                // The two stores really disagreed, so equal bytes were not equal inputs.
                expect(counts.toolTotalsDiffer).toBeGreaterThan(0);
            } finally {
                for (const spy of spies) spy.mockRestore();
                for (const graph of [base, head]) {
                    graph.tools.__resetToolDefinitionMeasurements();
                    graph.toolDb?.close();
                }
                resetLkgSlotsForTest();
                cleanupTestTempDir(root);
                rmSync(root, { recursive: true, force: true });
            }
        },
        1_800_000,
    );
}
