/**
 * Review witness: the pass mutation gates extracted from `runPostTransformPhase`
 * into `pass-mutation-decision.ts`, `decideExecuteReclaim` and
 * `emergencyEpisodeLatched` must behave exactly like the inline code they
 * replaced (commit f2ec1c94). Each `old*` function below is the f2ec1c94 inline
 * code copied verbatim, with the surrounding locals turned into an explicit
 * environment; each `new*` function is the ac7b8c0b call site copied verbatim.
 * Both run over the same environment, and every output, every persisted write
 * and every live read (with its order) is compared.
 */
import { describe, expect, test } from "bun:test";
import { reclaimRidePermitted } from "./cache-busting-signals";
import { emergencyEpisodeLatched } from "./emergency-drop";
import { decideExecuteReclaim } from "./execute-reclaim";
import {
    decidePassMutation,
    emergencyEpisodeRearms,
    emergencyRewriteAlreadyPriced,
    routineCleanupAdmitted,
} from "./pass-mutation-decision";

/** Deterministic PRNG so a reported divergence is reproducible. */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

interface Env {
    fullFeatureMode: boolean;
    compactionOff: boolean;
    schedulerDecision: "execute" | "defer";
    percentage: number;
    forceMaterializationPercentage: number;
    contextUsageFromEstimate: boolean | undefined;
    triggerForce: boolean;
    needsRebuild: boolean;
    rewritingSignedPrefix: boolean;
    foldBustsServedPrefixThisPass: boolean;
    firstRenderBust: boolean;
    idleExpiryRebuild: boolean;
    heldIdleExpiryRebuild: boolean;
    isExplicitFlush: boolean;
    hasUserFlushOrigin: boolean;
    prefixPreflightFailed: boolean;
    publishedM1RefreshedThisPass: boolean;
    m0M1EnabledForFold: boolean;
    pendingCompartmentCount: number;
    legacyHeadChanged: boolean;
    historyRebuiltThisPass: boolean;
    materializationRequested: boolean;
    alreadyRanThisTurn: boolean;
    activeThinkingPrefixHold: boolean;
    compartmentRunning: boolean;
    compartmentInProgress: boolean;
    freezeM0M1: boolean;
    deferredHistoryRefresh: boolean;
    deferredMaterialization: boolean;
    historyRefresh: boolean;
    floorOrdinal: number | null;
    emergencySample: number;
    heldPasses: number;
    reclaimableTokens: number;
    usableWindow: number;
    failedWrite: boolean;
    writeSucceeds: boolean;
}

/** In-memory stand-ins for the DB-backed reads and writes, logging every call. */
function makeWorld(env: Env) {
    const log: string[] = [];
    const state = { heldPasses: env.heldPasses, floorOrdinal: env.floorOrdinal };
    const failed = { value: env.failedWrite };
    let sample = env.emergencySample;
    return {
        log,
        state,
        sampleNow: () => sample,
        getEmergencyInputSample: (_db: unknown, _s: string) => {
            log.push("getEmergencyInputSample");
            return sample;
        },
        clearEmergencyDropSample: (_db: unknown, _s: string) => {
            log.push("clearEmergencyDropSample");
            sample = 0;
        },
        hasPendingMaterializationOrigin: (_set: unknown, _s: string, _o: string) => {
            log.push("hasPendingMaterializationOrigin");
            return env.hasUserFlushOrigin;
        },
        legacyPublishedHeadChanged: (_args: unknown) => {
            log.push("legacyPublishedHeadChanged");
            return env.legacyHeadChanged;
        },
        protectedToolTagNumbers: (_t: unknown, _p: unknown) => {
            log.push("protectedToolTagNumbers");
            return new Set<number>();
        },
        readExecuteReclaimState: (_db: unknown, _s: string) => {
            log.push("readExecuteReclaimState");
            return {
                heldPasses: state.heldPasses,
                floorOrdinal: state.floorOrdinal,
                floorPromptId: null,
            };
        },
        estimateExecuteReclaimTokens: (_a: unknown) => {
            log.push("estimateExecuteReclaimTokens");
            return env.reclaimableTokens;
        },
        writeExecuteReclaimState: (_db: unknown, _s: string, patch: { heldPasses: number }) => {
            log.push(`writeExecuteReclaimState(${patch.heldPasses})`);
            if (!env.writeSucceeds) {
                failed.value = true;
                return false;
            }
            state.heldPasses = patch.heldPasses;
            return true;
        },
        failedWrites: {
            get: (_db: unknown) => ({ has: (_s: string) => failed.value }),
        },
    };
}

type World = ReturnType<typeof makeWorld>;

function buildArgs(env: Env) {
    return {
        db: {},
        sessionId: "ses",
        fullFeatureMode: env.fullFeatureMode,
        schedulerDecision: env.schedulerDecision,
        contextUsage: { percentage: env.percentage, inputTokens: 1 },
        contextUsageFromEstimate: env.contextUsageFromEstimate,
        forceMaterializationPercentage: env.forceMaterializationPercentage,
        pendingMaterializationSessions: new Set<string>(),
        pendingCompartmentInjection:
            env.pendingCompartmentCount > 0
                ? { compartmentCount: env.pendingCompartmentCount }
                : undefined,
        historyRebuiltThisPass: env.historyRebuiltThisPass,
        sessionMeta: { compartmentInProgress: env.compartmentInProgress },
        deferredHistoryRefreshSessions: new Set(env.deferredHistoryRefresh ? ["ses"] : []),
        deferredMaterializationSessions: new Set(env.deferredMaterialization ? ["ses"] : []),
        historyRefreshSessions: new Set(env.historyRefresh ? ["ses"] : []),
        tags: [],
        protectedTools: {},
        protectedTagIds: new Set<number>(),
        usableWindow: env.usableWindow,
    };
}

/** f2ec1c94 execute-reclaim.ts `originateExecuteReclaim`, verbatim body. */
function oldOriginateExecuteReclaim(
    w: World,
    args: {
        db: unknown;
        sessionId: string;
        primaryExecute: boolean;
        summaryCanCome: boolean;
        alreadyBusting: boolean;
        reclaimableTokens: number;
        usableWindow: number;
    },
): boolean {
    const failedWrites = w.failedWrites;
    const readExecuteReclaimState = w.readExecuteReclaimState;
    const writeExecuteReclaimState = w.writeExecuteReclaimState;
    if (failedWrites.get(args.db)?.has(args.sessionId)) return false;
    const state = readExecuteReclaimState(args.db, args.sessionId);
    const heldPasses =
        args.primaryExecute && args.reclaimableTokens > 0 && !args.alreadyBusting
            ? state.heldPasses + 1
            : 0;
    if (!writeExecuteReclaimState(args.db, args.sessionId, { heldPasses })) return false;
    return (
        args.primaryExecute &&
        !args.alreadyBusting &&
        !args.summaryCanCome &&
        args.reclaimableTokens > 0 &&
        ((args.usableWindow > 0 && args.reclaimableTokens >= args.usableWindow * 0.02) ||
            heldPasses >= 3)
    );
}

/** ac7b8c0b execute-reclaim.ts `originateExecuteReclaim`, verbatim body. */
function newOriginateExecuteReclaim(
    w: World,
    args: {
        db: unknown;
        sessionId: string;
        primaryExecute: boolean;
        summaryCanCome: boolean;
        alreadyBusting: boolean;
        reclaimableTokens: number;
        usableWindow: number;
    },
): boolean {
    const failedWrites = w.failedWrites;
    const readExecuteReclaimState = w.readExecuteReclaimState;
    const writeExecuteReclaimState = w.writeExecuteReclaimState;
    if (failedWrites.get(args.db)?.has(args.sessionId)) return false;
    const state = readExecuteReclaimState(args.db, args.sessionId);
    const decision = decideExecuteReclaim({ ...args, heldPasses: state.heldPasses });
    if (!writeExecuteReclaimState(args.db, args.sessionId, { heldPasses: decision.heldPasses }))
        return false;
    return decision.admitted;
}

/** The unchanged locals computed before the gate (f2ec1c94 and ac7b8c0b alike). */
function prelude(env: Env) {
    const args = buildArgs(env);
    const compactionOff = env.compactionOff;
    const forceMaterialization =
        args.fullFeatureMode &&
        !compactionOff &&
        args.contextUsage.percentage >= args.forceMaterializationPercentage;
    const emergencyDropEligible =
        !compactionOff && args.contextUsage.percentage >= args.forceMaterializationPercentage;
    return { args, compactionOff, forceMaterialization, emergencyDropEligible };
}

/** f2ec1c94 transform-postprocess-phase.ts:2981-3081 and :4010, verbatim. */
function oldGate(env: Env, w: World) {
    const { args, compactionOff, forceMaterialization, emergencyDropEligible } = prelude(env);
    const servedShapeRepair = { needsRebuild: env.needsRebuild };
    const rewritingSignedPrefix = env.rewritingSignedPrefix;
    const foldBustsServedPrefixThisPass = env.foldBustsServedPrefixThisPass;
    const firstRenderBust = env.firstRenderBust;
    const idleExpiryRebuild = env.idleExpiryRebuild;
    const heldIdleExpiryRebuild = env.heldIdleExpiryRebuild;
    const triggerPermissions = { force: env.triggerForce };
    const isExplicitFlush = env.isExplicitFlush;
    const prefixPreflightFailed = env.prefixPreflightFailed;
    const publishedM1RefreshedThisPass = env.publishedM1RefreshedThisPass;
    const m0M1EnabledForFold = env.m0M1EnabledForFold;
    const materializationRequested = env.materializationRequested;
    const alreadyRanThisTurn = env.alreadyRanThisTurn;
    const activeThinkingPrefixHold = env.activeThinkingPrefixHold;
    const compartmentRunning = env.compartmentRunning;
    const freezeM0M1 = env.freezeM0M1;
    const pendingOps: never[] = [];
    const newTargets = new Map();
    const getEmergencyInputSample = w.getEmergencyInputSample;
    const hasPendingMaterializationOrigin = w.hasPendingMaterializationOrigin;
    const legacyPublishedHeadChanged = w.legacyPublishedHeadChanged;
    const protectedToolTagNumbers = w.protectedToolTagNumbers;
    const readExecuteReclaimState = w.readExecuteReclaimState;
    const estimateExecuteReclaimTokens = w.estimateExecuteReclaimTokens;
    const originateExecuteReclaim = (a: Parameters<typeof oldOriginateExecuteReclaim>[1]) =>
        oldOriginateExecuteReclaim(w, a);
    // ---- verbatim f2ec1c94 ----
    const rideSignals = {
        servedShapeRepair: servedShapeRepair.needsRebuild,
        executeReclaim: false,
        subagentExecute: !args.fullFeatureMode && args.schedulerDecision === "execute",
        hardFold:
            rewritingSignedPrefix ||
            foldBustsServedPrefixThisPass ||
            firstRenderBust ||
            idleExpiryRebuild,
        force:
            emergencyDropEligible &&
            (args.contextUsage.percentage >= 95 ||
                (triggerPermissions.force &&
                    args.contextUsageFromEstimate !== true &&
                    getEmergencyInputSample(args.db, args.sessionId) === 0)),
        explicitFlush:
            isExplicitFlush &&
            hasPendingMaterializationOrigin(
                args.pendingMaterializationSessions,
                args.sessionId,
                "user_flush",
            ),
        publishedHistory:
            !prefixPreflightFailed &&
            (publishedM1RefreshedThisPass ||
                (!m0M1EnabledForFold &&
                    (args.pendingCompartmentInjection?.compartmentCount ?? 0) > 0 &&
                    legacyPublishedHeadChanged(args))),
    };
    const protectedToolTags = protectedToolTagNumbers(args.tags, args.protectedTools);
    rideSignals.executeReclaim =
        !compactionOff &&
        originateExecuteReclaim({
            db: args.db,
            sessionId: args.sessionId,
            primaryExecute:
                args.fullFeatureMode &&
                args.schedulerDecision === "execute" &&
                args.contextUsage.percentage < args.forceMaterializationPercentage,
            alreadyBusting: Object.values(rideSignals).some(Boolean) || args.historyRebuiltThisPass,
            summaryCanCome:
                compartmentRunning ||
                args.sessionMeta.compartmentInProgress ||
                ((prefixPreflightFailed || freezeM0M1 || activeThinkingPrefixHold) &&
                    (args.deferredHistoryRefreshSessions.has(args.sessionId) ||
                        args.deferredMaterializationSessions.has(args.sessionId) ||
                        args.historyRefreshSessions?.has(args.sessionId) === true)) ||
                readExecuteReclaimState(args.db, args.sessionId).floorOrdinal !== null,
            reclaimableTokens: estimateExecuteReclaimTokens({
                db: args.db,
                sessionId: args.sessionId,
                pendingOps,
                tags: args.tags,
                targets: newTargets,
                protectedTagIds: new Set([...args.protectedTagIds, ...protectedToolTags]),
            }),
            usableWindow: args.usableWindow,
        });
    const publishedWorkDrainAllowed =
        (!compactionOff || servedShapeRepair.needsRebuild) &&
        reclaimRidePermitted(rideSignals, {
            signedThinkingHold: activeThinkingPrefixHold,
            firstRender: firstRenderBust,
            idleExpiry: idleExpiryRebuild,
            emergency: emergencyDropEligible,
        });
    const shouldApplyPendingOps = !compactionOff && publishedWorkDrainAllowed;
    const shouldRunHeuristics =
        !compactionOff &&
        publishedWorkDrainAllowed &&
        (rideSignals.publishedHistory ||
            rideSignals.executeReclaim ||
            rideSignals.servedShapeRepair ||
            materializationRequested ||
            forceMaterialization ||
            foldBustsServedPrefixThisPass ||
            firstRenderBust ||
            heldIdleExpiryRebuild ||
            emergencyDropEligible ||
            (args.schedulerDecision === "execute" &&
                (!alreadyRanThisTurn || !args.fullFeatureMode)));
    const isCacheBustingPass = publishedWorkDrainAllowed;
    // f2ec1c94:4007-4010
    const toolReclaimApplicationOpportunity = isCacheBustingPass;
    const toolReclaimAdmitted = toolReclaimApplicationOpportunity && !emergencyDropEligible;
    // ---- end verbatim ----
    return {
        rideSignals,
        publishedWorkDrainAllowed,
        shouldApplyPendingOps,
        shouldRunHeuristics,
        isCacheBustingPass,
        toolReclaimAdmitted,
        forceMaterialization,
        emergencyDropEligible,
    };
}

/** ac7b8c0b transform-postprocess-phase.ts:2988-3055 and :3989, verbatim. */
function newGate(env: Env, w: World) {
    const { args, compactionOff, forceMaterialization, emergencyDropEligible } = prelude(env);
    const servedShapeRepair = { needsRebuild: env.needsRebuild };
    const rewritingSignedPrefix = env.rewritingSignedPrefix;
    const foldBustsServedPrefixThisPass = env.foldBustsServedPrefixThisPass;
    const firstRenderBust = env.firstRenderBust;
    const idleExpiryRebuild = env.idleExpiryRebuild;
    const heldIdleExpiryRebuild = env.heldIdleExpiryRebuild;
    const triggerPermissions = { force: env.triggerForce };
    const isExplicitFlush = env.isExplicitFlush;
    const prefixPreflightFailed = env.prefixPreflightFailed;
    const publishedM1RefreshedThisPass = env.publishedM1RefreshedThisPass;
    const m0M1EnabledForFold = env.m0M1EnabledForFold;
    const materializationRequested = env.materializationRequested;
    const alreadyRanThisTurn = env.alreadyRanThisTurn;
    const activeThinkingPrefixHold = env.activeThinkingPrefixHold;
    const compartmentRunning = env.compartmentRunning;
    const freezeM0M1 = env.freezeM0M1;
    const pendingOps: never[] = [];
    const newTargets = new Map();
    const getEmergencyInputSample = w.getEmergencyInputSample;
    const hasPendingMaterializationOrigin = w.hasPendingMaterializationOrigin;
    const legacyPublishedHeadChanged = w.legacyPublishedHeadChanged;
    const protectedToolTagNumbers = w.protectedToolTagNumbers;
    const readExecuteReclaimState = w.readExecuteReclaimState;
    const estimateExecuteReclaimTokens = w.estimateExecuteReclaimTokens;
    const originateExecuteReclaim = (a: Parameters<typeof newOriginateExecuteReclaim>[1]) =>
        newOriginateExecuteReclaim(w, a);
    // ---- verbatim ac7b8c0b ----
    const protectedToolTags = protectedToolTagNumbers(args.tags, args.protectedTools);
    const passDecision = decidePassMutation(
        {
            fullFeatureMode: args.fullFeatureMode,
            compactionOff,
            schedulerDecision: args.schedulerDecision,
            contextPercentage: args.contextUsage.percentage,
            forceMaterializationPercentage: args.forceMaterializationPercentage,
            contextUsageFromEstimate: args.contextUsageFromEstimate === true,
            emergencyInputSample: () => getEmergencyInputSample(args.db, args.sessionId),
            forceTriggerPermitted: triggerPermissions.force,
            servedShapeRepair: servedShapeRepair.needsRebuild,
            rewritingSignedPrefix,
            foldBustsServedPrefix: foldBustsServedPrefixThisPass,
            firstRenderBust,
            idleExpiryRebuild,
            heldIdleExpiryRebuild,
            explicitFlush:
                isExplicitFlush &&
                hasPendingMaterializationOrigin(
                    args.pendingMaterializationSessions,
                    args.sessionId,
                    "user_flush",
                ),
            publishedHistory:
                !prefixPreflightFailed &&
                (publishedM1RefreshedThisPass ||
                    (!m0M1EnabledForFold &&
                        (args.pendingCompartmentInjection?.compartmentCount ?? 0) > 0 &&
                        legacyPublishedHeadChanged(args))),
            historyRebuiltThisPass: args.historyRebuiltThisPass === true,
            materializationRequested,
            alreadyRanThisTurn,
            signedThinkingHold: activeThinkingPrefixHold,
        },
        ({ primaryExecute, alreadyBusting }) =>
            originateExecuteReclaim({
                db: args.db,
                sessionId: args.sessionId,
                primaryExecute,
                alreadyBusting,
                summaryCanCome:
                    compartmentRunning ||
                    args.sessionMeta.compartmentInProgress ||
                    ((prefixPreflightFailed || freezeM0M1 || activeThinkingPrefixHold) &&
                        (args.deferredHistoryRefreshSessions.has(args.sessionId) ||
                            args.deferredMaterializationSessions.has(args.sessionId) ||
                            args.historyRefreshSessions?.has(args.sessionId) === true)) ||
                    readExecuteReclaimState(args.db, args.sessionId).floorOrdinal !== null,
                reclaimableTokens: estimateExecuteReclaimTokens({
                    db: args.db,
                    sessionId: args.sessionId,
                    pendingOps,
                    tags: args.tags,
                    targets: newTargets,
                    protectedTagIds: new Set([...args.protectedTagIds, ...protectedToolTags]),
                }),
                usableWindow: args.usableWindow,
            }),
    );
    const { rideSignals, publishedWorkDrainAllowed, shouldApplyPendingOps, shouldRunHeuristics } =
        passDecision;
    const isCacheBustingPass = passDecision.isCacheBustingPass;
    const toolReclaimAdmitted = passDecision.toolReclaimAdmitted;
    // ---- end verbatim ----
    return {
        rideSignals,
        publishedWorkDrainAllowed,
        shouldApplyPendingOps,
        shouldRunHeuristics,
        isCacheBustingPass,
        toolReclaimAdmitted,
        // The live phase keeps its inline locals; the decision recomputes them.
        forceMaterialization,
        emergencyDropEligible,
        decisionForceMaterialization: passDecision.forceMaterialization,
        decisionEmergencyDropEligible: passDecision.emergencyDropEligible,
    };
}

interface CleanupEnv {
    pendingOpsDidMutate: boolean;
    foldBustsServedPrefixThisPass: boolean;
    firstRenderBust: boolean;
    heldIdleExpiryRebuild: boolean;
    historyRebuiltThisPass: boolean;
    compartmentInjectionRebuiltFromDb: boolean;
    rebuiltHistoryFromInitialPrepare: boolean;
    routinePressureAlreadyApplied: boolean;
    materializationRequested: boolean;
}

/** f2ec1c94 transform-postprocess-phase.ts:3662-3689 (and :3708-3712), verbatim. */
function oldCleanupGate(env: Env, c: CleanupEnv, w: World) {
    const { args, emergencyDropEligible } = prelude(env);
    const getEmergencyInputSample = w.getEmergencyInputSample;
    const clearEmergencyDropSample = w.clearEmergencyDropSample;
    const {
        pendingOpsDidMutate,
        foldBustsServedPrefixThisPass,
        firstRenderBust,
        heldIdleExpiryRebuild,
        routinePressureAlreadyApplied,
        materializationRequested,
    } = c;
    const a = {
        ...args,
        historyRebuiltThisPass: c.historyRebuiltThisPass,
        compartmentInjectionRebuiltFromDb: c.compartmentInjectionRebuiltFromDb,
        rebuiltHistoryFromInitialPrepare: c.rebuiltHistoryFromInitialPrepare,
    };
    {
        const args = a;
        // ---- verbatim f2ec1c94 ----
        const emergencyRewriteAlreadyPriced =
            pendingOpsDidMutate ||
            foldBustsServedPrefixThisPass ||
            firstRenderBust ||
            heldIdleExpiryRebuild ||
            args.historyRebuiltThisPass ||
            args.compartmentInjectionRebuiltFromDb ||
            args.rebuiltHistoryFromInitialPrepare;
        if (
            emergencyDropEligible &&
            emergencyRewriteAlreadyPriced &&
            getEmergencyInputSample(args.db, args.sessionId) > 0
        ) {
            clearEmergencyDropSample(args.db, args.sessionId);
        }
        const routineCleanupApplied =
            (emergencyDropEligible
                ? args.contextUsage.percentage >= 95 ||
                  getEmergencyInputSample(args.db, args.sessionId) === 0
                : !args.fullFeatureMode || !routinePressureAlreadyApplied) ||
            materializationRequested ||
            emergencyRewriteAlreadyPriced;
        // ---- end verbatim ----
        return { priced: emergencyRewriteAlreadyPriced, routineCleanupApplied };
    }
}

/** ac7b8c0b transform-postprocess-phase.ts:3636-3668 (and :3694), verbatim. */
function newCleanupGate(env: Env, c: CleanupEnv, w: World) {
    const { args, emergencyDropEligible } = prelude(env);
    const getEmergencyInputSample = w.getEmergencyInputSample;
    const clearEmergencyDropSample = w.clearEmergencyDropSample;
    const {
        pendingOpsDidMutate,
        foldBustsServedPrefixThisPass,
        firstRenderBust,
        heldIdleExpiryRebuild,
        routinePressureAlreadyApplied,
        materializationRequested,
    } = c;
    const a = {
        ...args,
        historyRebuiltThisPass: c.historyRebuiltThisPass,
        compartmentInjectionRebuiltFromDb: c.compartmentInjectionRebuiltFromDb,
        rebuiltHistoryFromInitialPrepare: c.rebuiltHistoryFromInitialPrepare,
    };
    {
        const args = a;
        // ---- verbatim ac7b8c0b ----
        const rewriteAlreadyPriced = emergencyRewriteAlreadyPriced({
            pendingOpsDidMutate,
            foldBustsServedPrefix: foldBustsServedPrefixThisPass,
            firstRenderBust,
            heldIdleExpiryRebuild,
            historyRebuiltThisPass: args.historyRebuiltThisPass === true,
            compartmentInjectionRebuiltFromDb: args.compartmentInjectionRebuiltFromDb === true,
            rebuiltHistoryFromInitialPrepare: args.rebuiltHistoryFromInitialPrepare === true,
        });
        if (
            emergencyEpisodeRearms({
                emergencyDropEligible,
                rewriteAlreadyPriced,
                emergencyInputSample: () => getEmergencyInputSample(args.db, args.sessionId),
            })
        ) {
            clearEmergencyDropSample(args.db, args.sessionId);
        }
        const routineCleanupApplied = routineCleanupAdmitted({
            emergencyDropEligible,
            contextPercentage: args.contextUsage.percentage,
            emergencyInputSample: () => getEmergencyInputSample(args.db, args.sessionId),
            fullFeatureMode: args.fullFeatureMode,
            routinePressureAlreadyApplied,
            materializationRequested,
            rewriteAlreadyPriced,
        });
        // ---- end verbatim ----
        return { priced: rewriteAlreadyPriced, routineCleanupApplied };
    }
}

/** f2ec1c94 emergency-drop.ts latch, verbatim. */
function oldLatched(hasPriorDrop: boolean, usagePercentage: number | undefined): boolean {
    const absoluteEmergency = (usagePercentage ?? 0) >= 95;
    return hasPriorDrop && !absoluteEmergency;
}

const BOOL_KEYS = [
    "fullFeatureMode",
    "compactionOff",
    "triggerForce",
    "needsRebuild",
    "rewritingSignedPrefix",
    "foldBustsServedPrefixThisPass",
    "firstRenderBust",
    "idleExpiryRebuild",
    "heldIdleExpiryRebuild",
    "isExplicitFlush",
    "hasUserFlushOrigin",
    "prefixPreflightFailed",
    "publishedM1RefreshedThisPass",
    "m0M1EnabledForFold",
    "legacyHeadChanged",
    "historyRebuiltThisPass",
    "materializationRequested",
    "alreadyRanThisTurn",
    "activeThinkingPrefixHold",
    "compartmentRunning",
    "compartmentInProgress",
    "freezeM0M1",
    "deferredHistoryRefresh",
    "deferredMaterialization",
    "historyRefresh",
    "failedWrite",
    "writeSucceeds",
] as const;

/** Percentages around the force band (randomized threshold), 95 and the execute threshold. */
function pickPercent(rand: () => number, threshold: number): number {
    const anchors = [threshold, 95, threshold - 5, threshold - 2, 0, 100];
    const r = rand();
    if (r < 0.7) {
        const anchor = anchors[Math.floor(rand() * anchors.length)];
        const jitter = [-0.001, 0, 0.001, -0.5, 0.5][Math.floor(rand() * 5)];
        return anchor + jitter;
    }
    return rand() * 110;
}

function pickThreshold(rand: () => number): number {
    // `forceMaterializationPercentage` is max(85, executeThreshold + 2).
    const executeThreshold = [50, 65, 80, 83, 85, 90, 92.5][Math.floor(rand() * 7)];
    return Math.max(85, executeThreshold + 2);
}

function randomEnv(rand: () => number, bools?: number): Env {
    const env = {} as Env;
    BOOL_KEYS.forEach((key, index) => {
        (env as Record<string, unknown>)[key] =
            bools === undefined ? rand() < 0.5 : ((bools >> index) & 1) === 1;
    });
    env.schedulerDecision = rand() < 0.5 ? "execute" : "defer";
    env.forceMaterializationPercentage = pickThreshold(rand);
    env.percentage = pickPercent(rand, env.forceMaterializationPercentage);
    const est = rand();
    env.contextUsageFromEstimate = est < 0.33 ? undefined : est < 0.66;
    env.pendingCompartmentCount = rand() < 0.5 ? 0 : 2;
    env.floorOrdinal = rand() < 0.3 ? 7 : null;
    env.emergencySample = rand() < 0.5 ? 0 : 12_345;
    env.heldPasses = Math.floor(rand() * 5);
    env.usableWindow = [0, 128_000, 200_000][Math.floor(rand() * 3)];
    const window = env.usableWindow || 128_000;
    env.reclaimableTokens = [0, 1, window * 0.02 - 0.5, window * 0.02, window * 0.02 + 1, 5_000][
        Math.floor(rand() * 6)
    ];
    // Mostly writable state, so the admission branch is exercised.
    if (rand() < 0.8) {
        env.failedWrite = false;
        env.writeSucceeds = true;
    }
    return env;
}

function compareGate(env: Env): string | null {
    const wOld = makeWorld(env);
    const wNew = makeWorld(env);
    const o = oldGate(env, wOld);
    const n = newGate(env, wNew);
    const out = (x: typeof o) => ({
        rideSignals: { ...x.rideSignals },
        publishedWorkDrainAllowed: x.publishedWorkDrainAllowed,
        shouldApplyPendingOps: x.shouldApplyPendingOps,
        shouldRunHeuristics: x.shouldRunHeuristics,
        isCacheBustingPass: x.isCacheBustingPass,
        toolReclaimAdmitted: x.toolReclaimAdmitted,
    });
    const diffs: string[] = [];
    if (JSON.stringify(out(o)) !== JSON.stringify(out(n)))
        diffs.push(`outputs old=${JSON.stringify(out(o))} new=${JSON.stringify(out(n))}`);
    if (
        n.decisionForceMaterialization !== n.forceMaterialization ||
        n.decisionEmergencyDropEligible !== n.emergencyDropEligible
    )
        diffs.push("pressure bands differ from the live locals");
    if (JSON.stringify(wOld.state) !== JSON.stringify(wNew.state))
        diffs.push(`state old=${JSON.stringify(wOld.state)} new=${JSON.stringify(wNew.state)}`);
    const writes = (log: string[]) => log.filter((e) => e.startsWith("write")).join(",");
    if (writes(wOld.log) !== writes(wNew.log))
        diffs.push(`writes old=${writes(wOld.log)} new=${writes(wNew.log)}`);
    const sorted = (log: string[]) => [...log].sort().join(",");
    if (sorted(wOld.log) !== sorted(wNew.log))
        diffs.push(`reads old=${wOld.log.join(",")} new=${wNew.log.join(",")}`);
    return diffs.length === 0 ? null : `${JSON.stringify(env)}: ${diffs.join("; ")}`;
}

/** Reorders of pure reads only; reported, not failed. */
function readOrderDiffers(env: Env): boolean {
    const wOld = makeWorld(env);
    const wNew = makeWorld(env);
    oldGate(env, wOld);
    newGate(env, wNew);
    return wOld.log.join(",") !== wNew.log.join(",");
}

describe("pass mutation gate extraction is behaviour-preserving (review witness)", () => {
    test("exhaustive over the core boolean inputs, randomized percentages", () => {
        // The 18 inputs that reach decidePassMutation directly are enumerated
        // exhaustively; sub-expression inputs are held to values that make each
        // derived input pass straight through.
        const CORE = [
            "fullFeatureMode",
            "compactionOff",
            "triggerForce",
            "needsRebuild",
            "rewritingSignedPrefix",
            "foldBustsServedPrefixThisPass",
            "firstRenderBust",
            "idleExpiryRebuild",
            "heldIdleExpiryRebuild",
            "isExplicitFlush",
            "publishedM1RefreshedThisPass",
            "historyRebuiltThisPass",
            "materializationRequested",
            "alreadyRanThisTurn",
            "activeThinkingPrefixHold",
            "compartmentRunning",
        ] as const;
        const rand = mulberry32(0xc0ffee);
        const failures: string[] = [];
        let cases = 0;
        let reorders = 0;
        for (let bits = 0; bits < 1 << CORE.length; bits++) {
            for (const scheduler of ["execute", "defer"] as const) {
                for (const sample of [0, 9]) {
                    const env = randomEnv(rand);
                    CORE.forEach((key, index) => {
                        (env as Record<string, unknown>)[key] = ((bits >> index) & 1) === 1;
                    });
                    env.schedulerDecision = scheduler;
                    env.emergencySample = sample;
                    env.hasUserFlushOrigin = true;
                    env.prefixPreflightFailed = false;
                    cases++;
                    const failure = compareGate(env);
                    if (failure && failures.length < 5) failures.push(failure);
                    if (readOrderDiffers(env)) reorders++;
                }
            }
        }
        console.log(`exhaustive gate cases=${cases} read-order-differences=${reorders}`);
        expect(failures).toEqual([]);
    });

    test("randomized over every input, including sub-expression inputs", () => {
        const rand = mulberry32(0xbeef);
        const failures: string[] = [];
        const N = 400_000;
        for (let i = 0; i < N; i++) {
            const failure = compareGate(randomEnv(rand));
            if (failure && failures.length < 5) failures.push(failure);
        }
        console.log(`randomized gate cases=${N}`);
        expect(failures).toEqual([]);
    });

    test("emergency re-arm and routine cleanup admission, exhaustive booleans", () => {
        const KEYS = [
            "pendingOpsDidMutate",
            "foldBustsServedPrefixThisPass",
            "firstRenderBust",
            "heldIdleExpiryRebuild",
            "historyRebuiltThisPass",
            "compartmentInjectionRebuiltFromDb",
            "rebuiltHistoryFromInitialPrepare",
            "routinePressureAlreadyApplied",
            "materializationRequested",
        ] as const;
        const rand = mulberry32(0x5eed);
        const failures: string[] = [];
        let cases = 0;
        for (let bits = 0; bits < 1 << KEYS.length; bits++) {
            for (const fullFeatureMode of [true, false]) {
                for (const compactionOff of [true, false]) {
                    for (const sample of [0, 9]) {
                        for (let p = 0; p < 12; p++) {
                            const env = randomEnv(rand);
                            env.fullFeatureMode = fullFeatureMode;
                            env.compactionOff = compactionOff;
                            env.emergencySample = sample;
                            const c = {} as CleanupEnv;
                            KEYS.forEach((key, index) => {
                                (c as unknown as Record<string, boolean>)[key] =
                                    ((bits >> index) & 1) === 1;
                            });
                            const wOld = makeWorld(env);
                            const wNew = makeWorld(env);
                            const o = oldCleanupGate(env, c, wOld);
                            const n = newCleanupGate(env, c, wNew);
                            cases++;
                            if (
                                JSON.stringify(o) !== JSON.stringify(n) ||
                                wOld.log.join(",") !== wNew.log.join(",") ||
                                wOld.sampleNow() !== wNew.sampleNow()
                            ) {
                                if (failures.length < 5)
                                    failures.push(
                                        `${JSON.stringify({ env, c })}: old=${JSON.stringify(o)} ${wOld.log.join(",")} new=${JSON.stringify(n)} ${wNew.log.join(",")}`,
                                    );
                            }
                        }
                    }
                }
            }
        }
        console.log(`cleanup gate cases=${cases}`);
        expect(failures).toEqual([]);
    });

    test("decideExecuteReclaim equals the old originateExecuteReclaim arithmetic", () => {
        const rand = mulberry32(0xabc);
        const failures: string[] = [];
        for (let i = 0; i < 200_000; i++) {
            const env = randomEnv(rand);
            env.failedWrite = false;
            env.writeSucceeds = true;
            env.reclaimableTokens = rand() < 0.5 ? env.reclaimableTokens : rand() * 6_000;
            const args = {
                db: {},
                sessionId: "ses",
                primaryExecute: rand() < 0.5,
                summaryCanCome: rand() < 0.5,
                alreadyBusting: rand() < 0.5,
                reclaimableTokens: env.reclaimableTokens,
                usableWindow: env.usableWindow,
            };
            const wOld = makeWorld(env);
            const wNew = makeWorld(env);
            const o = oldOriginateExecuteReclaim(wOld, args);
            const n = newOriginateExecuteReclaim(wNew, args);
            if (o !== n || wOld.log.join(",") !== wNew.log.join(","))
                if (failures.length < 5) failures.push(JSON.stringify({ args, env, o, n }));
        }
        expect(failures).toEqual([]);
    });

    test("emergencyEpisodeLatched equals the old inline latch", () => {
        const rand = mulberry32(0x95);
        const values: Array<number | undefined> = [undefined, Number.NaN, 94.999, 95, 95.001, 0];
        for (let i = 0; i < 10_000; i++) values.push(rand() * 110);
        for (const usage of values)
            for (const prior of [true, false])
                expect(emergencyEpisodeLatched(prior, usage ?? 0)).toBe(oldLatched(prior, usage));
    });
});
