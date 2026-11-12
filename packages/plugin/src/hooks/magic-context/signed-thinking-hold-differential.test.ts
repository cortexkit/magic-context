/// <reference types="bun-types" />
// Randomized served-byte differential of the bounded signed-thinking hold
// against a base revision, for OpenCode 1 and OpenCode 2 (TypeScript mode).
//
// It needs two source snapshots next to this checkout and is skipped without
// them:
//   MC_HOLD_DIFF_BASE  a checkout of the base revision (node_modules linked)
//   MC_HOLD_DIFF_HEAD  a checkout of this revision (node_modules linked)
// Each snapshot is imported as its own module graph, so its process-local state
// (last-known-good slots, caches) is separate from this file's. Neither may be
// the checkout running this file: the snapshot's graph would then be this
// file's own, and closing its copy's database closes the warm session's too.
// Optional:
//   MC_HOLD_DIFF_EXPECT     "identical" (default): no pass may differ; or
//                           "differing": at least one pass must differ (a change
//                           that is meant to bust where base held)
//   MC_HOLD_DIFF_THRESHOLD  the execute threshold percentage (default 65)
//   MC_HOLD_DIFF_PASSES, MC_HOLD_DIFF_SEED
//
// One seeded session runs here, warm, through this checkout's transform. Before
// every pass the session database is copied twice, and the same input runs
// through a fresh base transform and a fresh head transform on those copies:
// both see identical state and differ only by code. Each pass checks:
// - D1: a warm defer pass serves its predecessor byte for byte (new messages
//   only at the end);
// - D2: a pass where head and base serve different bytes is a pass base held
//   for recent signed thinking (base's log shows the hold froze the turn's
//   thinking, or granted a rewrite while the hold was on) and
//   head busted, and head serves no
//   signed reasoning block while keeping every other part of the turn's steps;
// - D3: the warm pass serves what the fresh head transform served on the same
//   state (restart determinism), counted and reported;
// - D4: a signed block the warm session serves on two consecutive passes has
//   identical provider-visible bytes in front of it on both.
import { afterAll, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, realpathSync, rmSync } from "node:fs";
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
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import { resetLkgSlotsForTest } from "./lkg-slot";
import { requestPendingMaterialization } from "./pending-materialization";
import { providerVisiblePart } from "./provider-visible-parts";
import { createTransform } from "./transform";

const BASE = process.env.MC_HOLD_DIFF_BASE;
const HEAD = process.env.MC_HOLD_DIFF_HEAD;
const PASSES = Number(process.env.MC_HOLD_DIFF_PASSES ?? 420);
const SEED = Number(process.env.MC_HOLD_DIFF_SEED ?? 729);
const EXPECT = process.env.MC_HOLD_DIFF_EXPECT ?? "identical";
const THRESHOLD = Number(process.env.MC_HOLD_DIFF_THRESHOLD ?? 65);
// This file's own checkout (packages/plugin/src/hooks/magic-context -> root).
const RUNNING_CHECKOUT = join(import.meta.dir, "../../../../..");

function snapshotRoot(name: string, root: string): string {
    const resolved = realpathSync(root);
    if (resolved === realpathSync(RUNNING_CHECKOUT))
        throw new Error(
            `${name} is the checkout running this test; point it at a separate snapshot (for example a git archive of the revision with node_modules linked)`,
        );
    return resolved;
}

type Message = { info: Record<string, unknown>; parts: Array<Record<string, unknown>> };
type Graph = {
    createTransform: typeof createTransform;
    openDatabase: typeof openDatabase;
    closeDatabase: () => Promise<void>;
    createTagger: typeof createTagger;
    createScheduler: typeof createScheduler;
    requestPendingMaterialization: typeof requestPendingMaterialization;
    resetLkgSlotsForTest: typeof resetLkgSlotsForTest;
    logger: typeof loggerModule;
};

async function loadGraph(root: string): Promise<Graph> {
    const src = join(root, "packages/plugin/src");
    const [transform, storage, tagger, scheduler, pending, lkg, logger] = await Promise.all([
        import(join(src, "hooks/magic-context/transform.ts")),
        import(join(src, "features/magic-context/storage.ts")),
        import(join(src, "features/magic-context/tagger.ts")),
        import(join(src, "features/magic-context/scheduler.ts")),
        import(join(src, "hooks/magic-context/pending-materialization.ts")),
        import(join(src, "hooks/magic-context/lkg-slot.ts")),
        import(join(src, "shared/logger.ts")),
    ]);
    return {
        createTransform: transform.createTransform,
        openDatabase: storage.openDatabase,
        closeDatabase: storage.closeDatabase,
        createTagger: tagger.createTagger,
        createScheduler: scheduler.createScheduler,
        requestPendingMaterialization: pending.requestPendingMaterialization,
        resetLkgSlotsForTest: lkg.resetLkgSlotsForTest,
        logger,
    };
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

function isSignedReasoning(part: Record<string, unknown>): boolean {
    return (
        part.type === "reasoning" &&
        typeof part.text === "string" &&
        part.text !== "" &&
        (part.metadata as { anthropic?: unknown } | undefined)?.anthropic !== undefined
    );
}

/** The provider-visible bytes of one message, without empty text or reasoning. */
function providerKey(message: Message | undefined): string {
    if (!message) return "missing";
    return JSON.stringify({
        id: message.info.id,
        role: message.info.role,
        parts: message.parts
            .filter((p) => !((p.type === "text" || p.type === "reasoning") && p.text === ""))
            .map(providerVisiblePart),
    });
}

/** For each signed reasoning text, a hash of the provider-visible bytes in front of it. */
function signedPrefixes(messages: Message[]): Map<string, string> {
    const out = new Map<string, string>();
    const before: string[] = [];
    for (const message of messages) {
        const parts: Array<Record<string, unknown>> = [];
        for (const part of message.parts) {
            if (isSignedReasoning(part))
                out.set(
                    String(part.text),
                    createHash("sha256")
                        .update(`${before.join("\n")}\n${providerKey({ ...message, parts })}`)
                        .digest("hex"),
                );
            parts.push(part);
        }
        before.push(providerKey(message));
    }
    return out;
}

const digest = (messages: Message[]) =>
    createHash("sha256").update(messages.map(providerKey).join("\n")).digest("hex");

/** Part kinds of a step other than its reasoning, in order. */
const unsignedShape = (message: Message) =>
    message.parts
        .filter((p) => p.type !== "reasoning" && !(p.type === "text" && p.text === ""))
        .map((p) => (p.type === "tool" ? `tool:${String(p.callID)}` : String(p.type)));

const report: string[] = [];
afterAll(() => {
    if (report.length > 0) console.log(report.join("\n"));
});

for (const host of ["opencode1", "opencode2"] as const) {
    it.skipIf(!BASE || !HEAD)(
        `${host}: bounded hold differential against base over ${PASSES} passes`,
        async () => {
            if (EXPECT !== "identical" && EXPECT !== "differing")
                throw new Error(
                    `MC_HOLD_DIFF_EXPECT must be identical or differing, not ${EXPECT}`,
                );
            const base = await loadGraph(snapshotRoot("MC_HOLD_DIFF_BASE", BASE!));
            const headCold = await loadGraph(snapshotRoot("MC_HOLD_DIFF_HEAD", HEAD!));
            const logs = spyOn(loggerModule, "sessionLog").mockImplementation(() => {});
            const baseLines: string[] = [];
            const headLines: string[] = [];
            const warmLines: string[] = [];
            const baseLog = spyOn(base.logger, "sessionLog").mockImplementation((...a) => {
                baseLines.push(a.slice(1).map(String).join(" "));
            });
            const headLog = spyOn(headCold.logger, "sessionLog").mockImplementation((...a) => {
                headLines.push(a.slice(1).map(String).join(" "));
            });
            logs.mockImplementation((...a) => {
                warmLines.push(a.slice(1).map(String).join(" "));
            });
            const random = rng(SEED + (host === "opencode2" ? 1 : 0));
            const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
            const sessionId = `hold-diff-${host}`;
            const root = createTestTempDir("mc-hold-diff-").dir;
            const sessionDirectory = join(root, "project");
            mkdirSync(sessionDirectory, { recursive: true });
            const db = openDatabase(join(root, "warm.db"))!;
            const model = { providerID: "anthropic", modelID: "claude-opus-5-5" };
            const counts = {
                passes: 0,
                identical: 0,
                differing: 0,
                differingBaseHeld: 0,
                differingHeadStrippedAll: 0,
                differingUnsignedKept: 0,
                warmDefer: 0,
                warmKeptBlocksChecked: 0,
                warmDeferStable: 0,
                warmMatchesCold: 0,
                heavySteps: 0,
                lightSteps: 0,
                continuations: 0,
                users: 0,
                drops: 0,
                flushes: 0,
                compartments: 0,
                restarts: 0,
                firstRenders: 0,
                idle: 0,
                executePasses: 0,
                foldPasses: 0,
            };
            const failures: string[] = [];
            try {
                getOrCreateSessionMeta(db, sessionId);
                updateSessionMeta(db, sessionId, {
                    cacheTtl: "13h",
                    lastResponseTime: Date.now(),
                });
                let percent = 30;
                const usageEntry = () => ({
                    usage: { percentage: percent, inputTokens: percent * 1000 },
                    updatedAt: Date.now(),
                    hasUsageTokens: true,
                });
                const historyRefresh = new Set<string>();
                const pendingOrigins: Array<"user_flush"> = [];
                const lastHeuristics = new Map<string, string | null>();
                const hostDeps = (graph?: Graph) =>
                    host === "opencode2"
                        ? {
                              storeGeneration: "v2" as const,
                              hostCleanupCompactionMarkers: () => ({
                                  verified: true,
                                  removedLineages: 0,
                                  removedRows: 0,
                                  retainedLineages: 0,
                              }),
                              ...(graph ? {} : {}),
                          }
                        : {};
                const build = (
                    graph: Graph | null,
                    database: unknown,
                    sets: {
                        history: Set<string>;
                        pending: Set<string>;
                        heuristics: Map<string, string | null>;
                    },
                ) => {
                    const g = graph ?? {
                        createTransform,
                        createTagger,
                        createScheduler,
                    };
                    return g.createTransform({
                        db: database as never,
                        tagger: g.createTagger(),
                        executeThresholdPercentage: THRESHOLD,
                        scheduler: g.createScheduler({ executeThresholdPercentage: THRESHOLD }),
                        contextUsageMap: new Map([[sessionId, usageEntry()]]),
                        historyRefreshSessions: sets.history,
                        pendingMaterializationSessions: sets.pending,
                        lastHeuristicsTurnId: sets.heuristics,
                        liveModelBySession: new Map([[sessionId, model]]),
                        protectedTokens: 2000,
                        protectedTools: { read: 0 },
                        historianRunnable: false,
                        directory: sessionDirectory,
                        sessionDirectoryBySession: new Map([[sessionId, sessionDirectory]]),
                        ...hostDeps(graph ?? undefined),
                    } as never);
                };
                const warmHistory = historyRefresh;
                const warmPending = new Set<string>();
                let warmUsage = new Map([[sessionId, usageEntry()]]);
                const buildWarm = () => {
                    warmUsage = new Map([[sessionId, usageEntry()]]);
                    return createTransform({
                        db,
                        tagger: createTagger(),
                        executeThresholdPercentage: THRESHOLD,
                        scheduler: createScheduler({ executeThresholdPercentage: THRESHOLD }),
                        contextUsageMap: warmUsage,
                        historyRefreshSessions: warmHistory,
                        pendingMaterializationSessions: warmPending,
                        lastHeuristicsTurnId: lastHeuristics,
                        liveModelBySession: new Map([[sessionId, model]]),
                        protectedTokens: 2000,
                        protectedTools: { read: 0 },
                        historianRunnable: false,
                        directory: sessionDirectory,
                        sessionDirectoryBySession: new Map([[sessionId, sessionDirectory]]),
                        ...hostDeps(),
                    });
                };
                let warm = buildWarm();
                const source: Message[] = [];
                let clock = 1;
                let call = 0;
                let compartmentEnd = -1;
                let compartmentSequence = 0;
                const isRealUser = (m: Message) =>
                    m.info.role === "user" && !m.parts.every((p) => p.synthetic === true);
                const user = (synthetic = false) => {
                    source.push({
                        info: {
                            id: `${synthetic ? "continue" : "user"}-${clock}`,
                            role: "user",
                            sessionID: sessionId,
                            time: { created: clock++ },
                        },
                        parts: [
                            {
                                type: "text",
                                text: synthetic ? "Continue with the todo list." : `task ${clock}`,
                                ...(synthetic ? { synthetic: true } : {}),
                            },
                        ],
                    });
                };
                const toolStep = () => {
                    const callID = `call-${++call}`;
                    const heavy = random() < 0.15;
                    const recorded = random() < 0.5;
                    if (heavy) counts.heavySteps++;
                    else counts.lightSteps++;
                    source.push({
                        info: {
                            id: `assistant-${callID}`,
                            role: "assistant",
                            sessionID: sessionId,
                            time: { created: clock++ },
                            finish: "tool-calls",
                            ...model,
                            tokens: {
                                input: 0,
                                output: 0,
                                reasoning:
                                    heavy && recorded ? 1_600 + Math.floor(random() * 2_000) : 0,
                            },
                        },
                        parts: [
                            {
                                type: "reasoning",
                                text:
                                    heavy && !recorded
                                        ? `thought ${call} ${"weighing the next step carefully ".repeat(400)}`
                                        : `thought ${call}`,
                                metadata: { anthropic: { signature: `sig-${call}` } },
                            },
                            {
                                type: "tool",
                                callID,
                                tool: "read",
                                state: {
                                    status: "completed",
                                    input: { path: `${call}.ts` },
                                    output: `${callID} ${"const value = compute(input); // line\n".repeat(60)}`,
                                },
                            },
                        ],
                    });
                };
                user();
                toolStep();
                let previous: Message[] | null = null;
                for (let pass = 0; pass < PASSES; pass++) {
                    if (pass > 1) {
                        if (random() < 0.08) {
                            user();
                            counts.users++;
                        } else if (random() < 0.1) {
                            user(true);
                            counts.continuations++;
                        }
                        toolStep();
                        if (random() < 0.25) {
                            const tools = getTagsBySession(db, sessionId).filter(
                                (tag) => tag.type === "tool" && tag.status === "active",
                            );
                            if (tools.length > 0) {
                                queuePendingOp(db, sessionId, pick(tools).tagNumber, "drop");
                                counts.drops++;
                            }
                        }
                        if (random() < 0.25)
                            percent = pick([20, 40, 60, 66, 70, 74, 76, 80, 84, 86, 90, 96]);
                        if (random() < 0.08) {
                            pendingOrigins.push("user_flush");
                            counts.flushes++;
                        }
                        if (random() < 0.06) {
                            // A historian compartment, sometimes ending inside the
                            // current turn, with its history-refresh signal.
                            const ends: number[] = [];
                            const midTurn = random() < 0.5;
                            for (let i = compartmentEnd + 2; i < source.length - 6; i++) {
                                const next = source[i + 1]!;
                                if (midTurn ? next.info.role === "user" : isRealUser(next))
                                    ends.push(i);
                            }
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
                                lastResponseTime: Date.now() - 14 * 60 * 60 * 1000,
                            });
                            counts.idle++;
                        }
                        if (random() < 0.03) {
                            clearCachedM0M1(db, sessionId);
                            counts.firstRenders++;
                        }
                        if (random() < 0.03) {
                            resetLkgSlotsForTest();
                            warm = buildWarm();
                            counts.restarts++;
                        }
                    }
                    for (const origin of pendingOrigins.splice(0))
                        requestPendingMaterialization(warmPending, sessionId, origin);
                    warmUsage.set(sessionId, usageEntry());

                    // Fresh base and head transforms on identical copies of the state.
                    // One snapshot of the state, copied for both runs, so a write that
                    // lands between two snapshots (an asynchronous last-known-good
                    // persistence, for example) cannot give them different states.
                    const snapshot = join(root, `snapshot-${pass}.db`);
                    db.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);
                    const run = async (graph: Graph, name: string) => {
                        const path = join(root, `${name}-${pass}.db`);
                        copyFileSync(snapshot, path);
                        graph.resetLkgSlotsForTest();
                        const copy = graph.openDatabase(path);
                        const pending = new Set<string>();
                        if (warmPending.has(sessionId))
                            graph.requestPendingMaterialization(pending, sessionId, "user_flush");
                        const transform = build(graph, copy, {
                            history: new Set(historyRefresh),
                            pending,
                            heuristics: new Map(lastHeuristics),
                        });
                        const messages = structuredClone(source);
                        try {
                            await transform({}, { messages } as never);
                        } finally {
                            await graph.closeDatabase();
                            for (const suffix of ["", "-wal", "-shm"])
                                rmSync(`${path}${suffix}`, { force: true });
                        }
                        return messages;
                    };
                    baseLines.length = 0;
                    headLines.length = 0;
                    warmLines.length = 0;
                    const baseServed = await run(base, "base");
                    const baseHeld = baseLines.some(
                        (line) =>
                            line.includes("m[0]/m[1] frozen: active thinking turn") ||
                            (line.startsWith("rewrite permission:") &&
                                line.includes("thinking_hold=true")),
                    );
                    const headServed = await run(headCold, "head");
                    rmSync(snapshot, { force: true });
                    const headBusted = headLines.some(
                        (line) =>
                            /WILL APPLY|WILL RUN|executed=true|proactive thinking strip/.test(
                                line,
                            ) && !/WILL NOT/.test(line),
                    );
                    const warmServed = structuredClone(source);
                    await warm({}, { messages: warmServed } as never);
                    updateSessionMeta(db, sessionId, { lastResponseTime: Date.now() });
                    counts.passes++;
                    if (warmLines.some((line) => line.includes("decision=execute")))
                        counts.executePasses++;
                    if (warmLines.some((line) => /HARD fold decision: .*executed=true/.test(line)))
                        counts.foldPasses++;

                    if (digest(headServed) === digest(baseServed)) counts.identical++;
                    else {
                        counts.differing++;
                        if (baseHeld) counts.differingBaseHeld++;
                        const signed = headServed.flatMap((m) => m.parts.filter(isSignedReasoning));
                        if (signed.length === 0) counts.differingHeadStrippedAll++;
                        const input = new Map(source.map((m) => [m.info.id, m]));
                        const unsignedKept = headServed.every((m) => {
                            const original = input.get(m.info.id);
                            if (!original || original.info.role !== "assistant") return true;
                            return (
                                JSON.stringify(unsignedShape(m)) ===
                                JSON.stringify(unsignedShape(original))
                            );
                        });
                        if (unsignedKept) counts.differingUnsignedKept++;
                        if (!baseHeld || !headBusted || signed.length > 0 || !unsignedKept)
                            failures.push(
                                `pass ${pass}: head differs from base (baseHeld=${baseHeld} headBusted=${headBusted} signedServed=${signed.length} unsignedKept=${unsignedKept} usage=${percent}%)`,
                            );
                    }
                    if (digest(warmServed) === digest(headServed)) counts.warmMatchesCold++;
                    const warmDefer =
                        warmLines.some((line) => line.includes("pending ops WILL NOT APPLY")) &&
                        !warmLines.some((line) =>
                            /executed=true|m1Refreshed=true|proactive thinking strip/.test(line),
                        );
                    if (warmDefer && previous) {
                        counts.warmDefer++;
                        const stable = previous.every(
                            (message, index) =>
                                providerKey(warmServed[index]) === providerKey(message),
                        );
                        if (stable) counts.warmDeferStable++;
                        else
                            failures.push(
                                `pass ${pass}: defer pass changed its predecessor's bytes`,
                            );
                    }
                    if (previous) {
                        // D4: a signed block the warm session serves on two
                        // consecutive passes has identical bytes in front of it.
                        const before = signedPrefixes(previous);
                        for (const [text, prefix] of signedPrefixes(warmServed)) {
                            const old = before.get(text);
                            if (old === undefined) continue;
                            counts.warmKeptBlocksChecked++;
                            if (old !== prefix)
                                failures.push(
                                    `pass ${pass}: kept signed block "${text.slice(0, 20)}" behind changed bytes`,
                                );
                        }
                    }
                    previous = warmServed;
                }
                report.push(
                    `${host} differential (seed ${SEED}, threshold ${THRESHOLD}%, expect ${EXPECT}): ${JSON.stringify(counts)}`,
                );
                expect(failures).toEqual([]);
                expect(counts.passes).toBe(PASSES);
                if (EXPECT === "differing") expect(counts.differing).toBeGreaterThan(0);
                else expect(counts.differing).toBe(0);
                expect(counts.warmDefer).toBeGreaterThan(0);
            } finally {
                logs.mockRestore();
                baseLog.mockRestore();
                headLog.mockRestore();
                resetLkgSlotsForTest();
                cleanupTestTempDir(root);
                rmSync(root, { recursive: true, force: true });
            }
        },
        1_800_000,
    );
}
