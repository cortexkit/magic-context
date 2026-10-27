#!/usr/bin/env bun
/**
 * generate-pass-decision-vectors.ts — write the shared per-pass rebuild decision
 * vectors from the TypeScript reference implementation.
 *
 * Each vector names one pass's inputs (session preset, scheduler decision, usage
 * against the force band, queued agent-drop work, summary state, rebuild causes,
 * and which automatic lanes have work waiting). Its expected outputs (whether the
 * pass changes the provider prefix, what permitted the change, which lanes first
 * apply, and the persisted held-execute-pass count) are computed here by calling
 * the same gate functions the OpenCode postprocess phase calls:
 * `decidePassMutation`, `decideExecuteReclaim`, `emergencyRewriteAlreadyPriced`,
 * `emergencyEpisodeRearms`, `routineCleanupAdmitted` and `emergencyEpisodeLatched`.
 * The Rust module's `pass_decision_vectors` test feeds the same inputs to ck-mc's
 * decision code and must produce the same outputs.
 *
 * Usage:
 *   bun scripts/generate-pass-decision-vectors.ts          # rewrite the JSON
 *   bun scripts/generate-pass-decision-vectors.ts --check  # fail if it is stale
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { emergencyEpisodeLatched } from "../src/hooks/magic-context/emergency-drop";
import { decideExecuteReclaim } from "../src/hooks/magic-context/execute-reclaim";
import {
    decidePassMutation,
    emergencyEpisodeRearms,
    emergencyRewriteAlreadyPriced,
    routineCleanupAdmitted,
} from "../src/hooks/magic-context/pass-mutation-decision";

const VECTOR_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    "../src/hooks/magic-context/pass-decision-vectors.json",
);

/** Lanes in the fixed order every vector reports them. */
const LANES = ["queuedDrops", "emergencyDrop", "dedup", "ageSweep", "supersession"] as const;
type Lane = (typeof LANES)[number];

/**
 * What permitted a prefix change, in the priority order used when several hold:
 * - `cacheLoss`: a first render or an expired provider cache rebuilds the head anyway;
 * - `executedFold`: a fold changed the served prefix;
 * - `signedPrefixRewrite`: signed thinking was released so the prefix can be rewritten;
 * - `servedShapeRepair`: a previously served array shape must be repaired;
 * - `publishedHistory`: freshly published history changed the served m[1];
 * - `flush`: a user `/ctx-flush`;
 * - `force`: the force band's emergency arm (or the absolute 95% arm);
 * - `primaryExecuteNoSummary`: a primary execute pass on which no summary can come,
 *   with enough queued work (2% of the usable window, or the third held pass);
 * - `subagentExecute`: a subagent's execute pass.
 * Queued `ctx_reduce` drops are never an origin: they land on the pass, they do
 * not cause it.
 */
const ORIGINS = [
    "cacheLoss",
    "executedFold",
    "signedPrefixRewrite",
    "servedShapeRepair",
    "publishedHistory",
    "flush",
    "force",
    "primaryExecuteNoSummary",
    "subagentExecute",
] as const;
type Origin = (typeof ORIGINS)[number];

interface VectorInputs {
    /** ck-mc preset. `head` is a primary session; every other preset is a subagent. */
    preset: "head" | "worker" | "reader";
    /** `compaction.enabled: false`: memories and docs only, no context management. */
    compactionOff: boolean;
    scheduler: "execute" | "defer";
    usagePercent: number;
    /** The derived force band, `max(85, executeThreshold + 2)`. */
    forcePercent: number;
    usableWindow: number;
    /** The usage reading is a local count, not a provider measurement. */
    usageFromEstimate: boolean;
    /** A historian run is in flight. */
    historianInFlight: boolean;
    /** A published summary waits to render, or a one-pass floor mark is set. */
    summaryPending: boolean;
    queuedDrops: {
        /** Calibrated tokens of queued drops the drain could remove now (outside protection). */
        eligibleTokens: number;
        /** Persisted consecutive held execute passes before this pass. */
        heldPassesBefore: number;
    };
    /** The force episode already spent its one emergency batch. */
    emergencyEpisodeSpent: boolean;
    /** An executed fold changes the served prefix on this pass (primary or compaction off). */
    executedFold: boolean;
    /** A user `/ctx-flush` is pending. */
    flush: boolean;
    /** Freshly published history changes the served m[1] on this pass. */
    publishedHistory: boolean;
    /** Why the provider cache is already lost on this pass, if it is. */
    cacheLoss: "none" | "idleExpiry" | "firstRender";
    /** A fold ran but reproduced the served prefix byte for byte (no rewrite). */
    refoldKeepsPrefix: boolean;
    /** The pass is held for recent signed thinking on a prefix-bound model (strict hold). */
    signedThinkingHold: boolean;
    /** Trigger parking still lets the force band ride (false: a parked force trigger). */
    forceTriggerPermitted: boolean;
    /** Signed thinking is released so the pass rewrites the prefix (fit, mode switch). */
    signedPrefixRewrite: boolean;
    /** A previously served empty text slot must be repaired on this pass. */
    servedShapeRepair: boolean;
    /** Heuristics already ran for the current user turn. */
    alreadyRanThisTurn: boolean;
    /** A primary already applied routine cleanup in this execute-pressure stretch. */
    routinePressureAlreadyApplied: boolean;
    /** Automatic lanes with eligible candidates waiting. */
    pendingWork: Record<Exclude<Lane, "queuedDrops">, boolean>;
}

interface VectorExpected {
    busts: boolean;
    origin: Origin | null;
    lanes: Lane[];
    heldPassesAfter: number;
}

interface Vector {
    name: string;
    note: string;
    inputs: VectorInputs;
    expected: VectorExpected;
}

const NO_WORK: VectorInputs["pendingWork"] = {
    emergencyDrop: false,
    dedup: false,
    ageSweep: false,
    supersession: false,
};

function base(overrides: Partial<VectorInputs>): VectorInputs {
    return {
        preset: "head",
        compactionOff: false,
        scheduler: "execute",
        usagePercent: 70,
        forcePercent: 85,
        usableWindow: 128_000,
        usageFromEstimate: false,
        historianInFlight: false,
        summaryPending: false,
        queuedDrops: { eligibleTokens: 0, heldPassesBefore: 0 },
        emergencyEpisodeSpent: false,
        executedFold: false,
        flush: false,
        publishedHistory: false,
        cacheLoss: "none",
        refoldKeepsPrefix: false,
        signedThinkingHold: false,
        forceTriggerPermitted: true,
        signedPrefixRewrite: false,
        servedShapeRepair: false,
        alreadyRanThisTurn: false,
        routinePressureAlreadyApplied: false,
        pendingWork: NO_WORK,
        ...overrides,
    };
}

const QUEUED_WORTH_IT = { eligibleTokens: 3505, heldPassesBefore: 0 };
const QUEUED_SMALL = { eligibleTokens: 1000, heldPassesBefore: 0 };
const ALL_ROUTINE = { ...NO_WORK, dedup: true, ageSweep: true, supersession: true };
const ALL_WORK = { ...ALL_ROUTINE, emergencyDrop: true };

const CASES: Array<{ name: string; note: string; inputs: VectorInputs }> = [
    // Subagent sessions (every preset except `head`).
    {
        name: "subagent-defer-holds-queued-drop",
        note: "A subagent defer pass replays its bytes; the queued drop waits.",
        inputs: base({ preset: "worker", scheduler: "defer", queuedDrops: QUEUED_WORTH_IT }),
    },
    {
        name: "broca-pass13-subagent-first-execute-applies-released-drop",
        note: "Broca run 1115b pass 13: the first execute after `ctx_reduce drop=2,5`; tag 2 is outside the protection window and applies.",
        inputs: base({ preset: "worker", queuedDrops: QUEUED_WORTH_IT }),
    },
    {
        name: "broca-pass14-subagent-execute-protected-drop-only",
        note: "Broca pass 14: tag 5 is still inside the protection window, so no queued work is eligible and nothing else waits.",
        inputs: base({ preset: "worker" }),
    },
    {
        name: "broca-pass15-subagent-execute-drop-leaves-window",
        note: "Broca pass 15: newer output pushed tag 5 out of the window; the execute pass applies it on its own.",
        inputs: base({ preset: "worker", queuedDrops: QUEUED_WORTH_IT }),
    },
    {
        name: "broca-pass17-subagent-execute-age-sweep-alone",
        note: "Broca pass 17: no queued drop; an aged output passed the distance bookmark and the execute pass applies the age sweep on its own.",
        inputs: base({ preset: "worker", pendingWork: { ...NO_WORK, ageSweep: true } }),
    },
    {
        name: "subagent-execute-with-nothing-eligible",
        note: "Permission alone rewrites no bytes.",
        inputs: base({ preset: "reader" }),
    },
    {
        name: "subagent-execute-routine-cleanup",
        note: "Subagents run every cleanup lane on every execute pass.",
        inputs: base({ preset: "worker", pendingWork: ALL_ROUTINE }),
    },
    {
        name: "subagent-defer-routine-cleanup-waits",
        note: "Automatic lanes never originate a rebuild on a defer pass.",
        inputs: base({ preset: "worker", scheduler: "defer", pendingWork: ALL_ROUTINE }),
    },
    {
        name: "subagent-execute-small-queued-drop",
        note: "The 2% bound is primary-only: a subagent execute pass applies any eligible queued drop.",
        inputs: base({ preset: "worker", queuedDrops: QUEUED_SMALL }),
    },
    {
        name: "subagent-force-band-armed",
        note: "At the force band the emergency selector owns tool reclaim; age sweep and supersession wait.",
        inputs: base({ preset: "worker", usagePercent: 88, pendingWork: ALL_WORK }),
    },
    {
        name: "subagent-force-band-spent-episode",
        note: "A spent force episode keeps emergency and routine cleanup latched; the subagent execute permission alone does not re-arm it.",
        inputs: base({
            preset: "worker",
            usagePercent: 88,
            emergencyEpisodeSpent: true,
            pendingWork: ALL_WORK,
        }),
    },
    {
        name: "subagent-force-band-spent-episode-queued-drop",
        note: "Applied queued drops price the pass, which re-arms the spent episode for every lane.",
        inputs: base({
            preset: "worker",
            usagePercent: 88,
            emergencyEpisodeSpent: true,
            queuedDrops: QUEUED_WORTH_IT,
            pendingWork: ALL_WORK,
        }),
    },
    {
        name: "subagent-absolute-emergency-spent-episode",
        note: "At 95% the latch yields.",
        inputs: base({
            preset: "worker",
            usagePercent: 96,
            emergencyEpisodeSpent: true,
            pendingWork: ALL_WORK,
        }),
    },
    {
        name: "subagent-force-band-estimate-only",
        note: "An estimate-only force reading takes no force ride, but the subagent execute pass still admits its lanes.",
        inputs: base({
            preset: "worker",
            usagePercent: 88,
            usageFromEstimate: true,
            pendingWork: ALL_WORK,
        }),
    },
    // Primary sessions (`head`).
    {
        name: "primary-defer-holds-queued-drop",
        note: "A defer pass replays its bytes; the held count resets.",
        inputs: base({
            scheduler: "defer",
            queuedDrops: { eligibleTokens: 3505, heldPassesBefore: 1 },
        }),
    },
    {
        name: "primary-execute-no-summary-queued-worth-it",
        note: "No summary can come and the queued work is 2.7% of the window: the execute pass rebuilds now.",
        inputs: base({ queuedDrops: QUEUED_WORTH_IT }),
    },
    {
        name: "primary-execute-no-summary-small-queue-first-hold",
        note: "Below 2% the execute pass holds and counts.",
        inputs: base({ queuedDrops: QUEUED_SMALL }),
    },
    {
        name: "primary-execute-no-summary-small-queue-second-hold",
        note: "Second consecutive held execute pass.",
        inputs: base({ queuedDrops: { eligibleTokens: 1000, heldPassesBefore: 1 } }),
    },
    {
        name: "primary-execute-no-summary-small-queue-third-pass",
        note: "The third consecutive held execute pass rebuilds.",
        inputs: base({ queuedDrops: { eligibleTokens: 1000, heldPassesBefore: 2 } }),
    },
    {
        name: "primary-execute-historian-in-flight-holds",
        note: "A summary can come, so queued drops wait for its rebuild.",
        inputs: base({ historianInFlight: true, queuedDrops: QUEUED_WORTH_IT }),
    },
    {
        name: "primary-execute-summary-pending-holds",
        note: "A published summary waits to render (or a floor mark is set), so queued drops wait for it.",
        inputs: base({ summaryPending: true, queuedDrops: QUEUED_WORTH_IT }),
    },
    {
        name: "primary-execute-published-history-carries-drops",
        note: "Freshly published history rebuilds the head; queued drops and cleanup ride it.",
        inputs: base({
            publishedHistory: true,
            queuedDrops: QUEUED_WORTH_IT,
            pendingWork: ALL_ROUTINE,
        }),
    },
    {
        name: "primary-execute-age-sweep-alone",
        note: "Automatic lanes never originate a primary rebuild.",
        inputs: base({ pendingWork: ALL_ROUTINE }),
    },
    {
        name: "primary-execute-no-summary-carries-cleanup",
        note: "The execute pass that rebuilds for queued work applies the usual cleanup with it.",
        inputs: base({ queuedDrops: QUEUED_WORTH_IT, pendingWork: ALL_ROUTINE }),
    },
    {
        name: "primary-defer-executed-fold",
        note: "An executed fold rebuilds the prefix; everything eligible drains into it.",
        inputs: base({
            scheduler: "defer",
            executedFold: true,
            queuedDrops: QUEUED_SMALL,
            pendingWork: ALL_ROUTINE,
        }),
    },
    {
        name: "primary-executed-fold-with-historian-in-flight",
        note: "The historian veto yields to an executed fold.",
        inputs: base({
            scheduler: "defer",
            executedFold: true,
            historianInFlight: true,
            queuedDrops: QUEUED_WORTH_IT,
        }),
    },
    {
        name: "primary-flush-with-nothing-queued",
        note: "A flush is permission; with nothing eligible it rewrites no bytes.",
        inputs: base({ scheduler: "defer", flush: true }),
    },
    {
        name: "primary-flush-applies-queued-drop",
        note: "A user flush applies queued drops and cleanup in one rebuild.",
        inputs: base({
            scheduler: "defer",
            flush: true,
            queuedDrops: QUEUED_SMALL,
            pendingWork: ALL_ROUTINE,
        }),
    },
    {
        name: "primary-idle-expiry",
        note: "The provider cache expired: the idle fold rebuilds the head anyway and eligible work rides it.",
        inputs: base({ cacheLoss: "idleExpiry", executedFold: true, pendingWork: ALL_ROUTINE }),
    },
    {
        name: "primary-first-render",
        note: "No cached m[0]/m[1] pair exists, so the head renders for the first time.",
        inputs: base({ scheduler: "defer", cacheLoss: "firstRender" }),
    },
    {
        name: "primary-force-band-armed",
        note: "The force band's first batch drops by need; age sweep and supersession wait.",
        inputs: base({ usagePercent: 88, pendingWork: ALL_WORK }),
    },
    {
        name: "primary-force-band-armed-queued-drop",
        note: "At the force band the execute pass does not count queued work; the force ride applies it.",
        inputs: base({ usagePercent: 88, queuedDrops: QUEUED_SMALL, pendingWork: ALL_WORK }),
    },
    {
        name: "primary-force-band-spent-episode",
        note: "One emergency batch per force episode; nothing else rebuilds.",
        inputs: base({ usagePercent: 88, emergencyEpisodeSpent: true, pendingWork: ALL_WORK }),
    },
    {
        name: "primary-force-band-spent-episode-flush",
        note: "A flush rebuilds the history injection, which prices the pass and re-arms the spent episode.",
        inputs: base({
            scheduler: "defer",
            usagePercent: 88,
            emergencyEpisodeSpent: true,
            flush: true,
            pendingWork: ALL_WORK,
        }),
    },
    {
        name: "primary-force-band-spent-episode-executed-fold",
        note: "An executed fold prices the pass and re-arms the spent episode.",
        inputs: base({
            scheduler: "defer",
            usagePercent: 88,
            emergencyEpisodeSpent: true,
            executedFold: true,
            pendingWork: ALL_WORK,
        }),
    },
    {
        name: "primary-force-band-estimate-only",
        note: "A local count alone never puts a primary pass in the force band below 95%.",
        inputs: base({ usagePercent: 88, usageFromEstimate: true, pendingWork: ALL_WORK }),
    },
    {
        name: "primary-absolute-emergency-spent-episode",
        note: "At 95% the force ride and the emergency latch both yield.",
        inputs: base({ usagePercent: 96, emergencyEpisodeSpent: true, pendingWork: ALL_WORK }),
    },
    // Inputs the first round pinned to constants, and the review's extra cases.
    {
        name: "primary-signed-hold-execute-queued-worth-it",
        note: "A pass held for recent signed thinking may not change its prefix: the execute pass is admitted and counted, but nothing applies.",
        inputs: base({ signedThinkingHold: true, queuedDrops: QUEUED_WORTH_IT, pendingWork: ALL_ROUTINE }),
    },
    {
        name: "subagent-signed-hold-execute",
        note: "A held subagent execute pass replays its bytes.",
        inputs: base({ preset: "worker", signedThinkingHold: true, queuedDrops: QUEUED_WORTH_IT, pendingWork: ALL_ROUTINE }),
    },
    {
        name: "primary-signed-hold-force-band-armed",
        note: "The force band lifts the hold: the emergency arm rides.",
        inputs: base({ signedThinkingHold: true, usagePercent: 88, pendingWork: ALL_WORK }),
    },
    {
        name: "primary-signed-hold-parked-force-trigger",
        note: "A force trigger parked behind kept signed thinking takes no ride.",
        inputs: base({ signedThinkingHold: true, forceTriggerPermitted: false, usagePercent: 88, pendingWork: ALL_WORK }),
    },
    {
        name: "primary-held-idle-expiry",
        note: "An expired cache on a held pass is a priced rebuild: queued work and cleanup ride it.",
        inputs: base({ signedThinkingHold: true, cacheLoss: "idleExpiry", queuedDrops: QUEUED_SMALL, pendingWork: ALL_ROUTINE }),
    },
    {
        name: "primary-held-idle-expiry-spent-force-episode",
        note: "A held idle expiry prices the pass, so it re-arms a spent force episode.",
        inputs: base({ signedThinkingHold: true, cacheLoss: "idleExpiry", usagePercent: 88, emergencyEpisodeSpent: true, pendingWork: ALL_WORK }),
    },
    {
        name: "primary-signed-prefix-rewrite",
        note: "Releasing signed thinking for a rewrite rebuilds the prefix; everything eligible rides it.",
        inputs: base({ scheduler: "defer", signedPrefixRewrite: true, queuedDrops: QUEUED_SMALL, pendingWork: ALL_ROUTINE }),
    },
    {
        name: "primary-served-shape-repair",
        note: "Repairing a served empty text slot rebuilds the prefix (TypeScript only).",
        inputs: base({ scheduler: "defer", servedShapeRepair: true, queuedDrops: QUEUED_SMALL, pendingWork: ALL_ROUTINE }),
    },
    {
        name: "primary-refold-keeps-served-prefix",
        note: "A fold that reproduces the served prefix is no ride.",
        inputs: base({ scheduler: "defer", refoldKeepsPrefix: true, queuedDrops: QUEUED_SMALL, pendingWork: ALL_ROUTINE }),
    },
    {
        name: "primary-idle-expiry-without-fold",
        note: "An expired cache whose refold keeps the bytes is still a ride below the force band.",
        inputs: base({ cacheLoss: "idleExpiry", queuedDrops: QUEUED_SMALL, pendingWork: ALL_ROUTINE }),
    },
    {
        name: "primary-idle-expiry-routine-already-applied",
        note: "Routine cleanup runs once per execute-pressure stretch on a primary; an idle expiry later in the stretch carries only the tool lanes.",
        inputs: base({ cacheLoss: "idleExpiry", alreadyRanThisTurn: true, routinePressureAlreadyApplied: true, pendingWork: ALL_ROUTINE }),
    },
    {
        name: "primary-execute-no-summary-routine-already-applied",
        note: "Queued drops landing price the pass, so routine cleanup rides even later in the stretch.",
        inputs: base({ alreadyRanThisTurn: true, routinePressureAlreadyApplied: true, queuedDrops: QUEUED_WORTH_IT, pendingWork: ALL_ROUTINE }),
    },
    {
        name: "subagent-first-render",
        note: "Subagents never render m[0]/m[1], so they have no first render.",
        inputs: base({ preset: "worker", scheduler: "defer", cacheLoss: "firstRender", pendingWork: ALL_ROUTINE }),
    },
    {
        name: "subagent-idle-expiry",
        note: "An expired cache on a subagent execute pass: the cache is rewritten anyway and every lane rides.",
        inputs: base({ preset: "worker", cacheLoss: "idleExpiry", queuedDrops: QUEUED_SMALL, pendingWork: ALL_ROUTINE }),
    },
    {
        name: "primary-non-default-force-band-execute",
        note: "Execute threshold 88: the force band is 90%, so 88% is an ordinary execute pass.",
        inputs: base({ usagePercent: 88, forcePercent: 90, queuedDrops: QUEUED_WORTH_IT, pendingWork: ALL_WORK }),
    },
    {
        name: "primary-non-default-force-band-armed",
        note: "Execute threshold 88: at 91% the force band rides.",
        inputs: base({ usagePercent: 91, forcePercent: 90, pendingWork: ALL_WORK }),
    },
    {
        name: "primary-historian-in-flight-force-band",
        note: "A running historian does not veto the force band.",
        inputs: base({ usagePercent: 88, historianInFlight: true, queuedDrops: QUEUED_SMALL, pendingWork: ALL_WORK }),
    },
    {
        name: "primary-historian-in-flight-published-history",
        note: "Rendering already-published history is not vetoed by a running historian; queued drops ride it.",
        inputs: base({ historianInFlight: true, publishedHistory: true, queuedDrops: QUEUED_SMALL, pendingWork: ALL_ROUTINE }),
    },
    // Compaction off.
    {
        name: "compaction-off-execute-never-reduces",
        note: "Compaction off leaves context management to the host.",
        inputs: base({
            compactionOff: true,
            queuedDrops: QUEUED_WORTH_IT,
            pendingWork: ALL_ROUTINE,
        }),
    },
    {
        name: "compaction-off-subagent-execute-never-reduces",
        note: "The subagent execute permission does not apply with compaction off.",
        inputs: base({
            preset: "worker",
            compactionOff: true,
            queuedDrops: QUEUED_WORTH_IT,
            pendingWork: ALL_ROUTINE,
        }),
    },
    {
        name: "compaction-off-force-band-never-reduces",
        note: "Compaction off has no force band.",
        inputs: base({ compactionOff: true, usagePercent: 96, pendingWork: ALL_WORK }),
    },
    {
        name: "compaction-off-additive-fold",
        note: "An additive m[0]/m[1] fold rebuilds the head; no lane may ride it.",
        inputs: base({
            compactionOff: true,
            scheduler: "defer",
            executedFold: true,
            pendingWork: ALL_ROUTINE,
        }),
    },
];

/** Feed one vector's inputs to the TypeScript gates, composed as `runPostTransformPhase` composes them. */
export function decideVector(inputs: VectorInputs): VectorExpected {
    const primary = inputs.preset === "head";
    let emergencySample = inputs.emergencyEpisodeSpent ? 1 : 0;
    let heldPassesAfter = inputs.queuedDrops.heldPassesBefore;
    // Host facts the phase derives before its gates, as `runPostTransformPhase` derives
    // them. A pass held for recent signed thinking freezes the m[0]/m[1] head
    // (`freezeM0M1`), so it cannot fold, refresh m[1] or take a parked flush
    // (`isExplicitFlush` and `materializationRequested` are cleared). Only primary and
    // compaction-off sessions render m[0]/m[1] (`m0M1EnabledForFold`), so only they can
    // first-render; the strict hold parks that render too. Every session sees an expired
    // cache (`idleExpiryRebuild`); while the hold is on it is the held expiry.
    const hold = inputs.signedThinkingHold;
    const rendersHead = primary || inputs.compactionOff;
    const firstRenderBust = inputs.cacheLoss === "firstRender" && rendersHead && !hold;
    const idleExpiryRebuild = inputs.cacheLoss === "idleExpiry";
    const heldIdleExpiryRebuild = hold && idleExpiryRebuild;
    const foldBustsServedPrefix = inputs.executedFold && !hold;
    const flush = inputs.flush && !hold;
    const publishedHistory = inputs.publishedHistory && !hold;
    // `/ctx-flush` also requests a history rebuild (`onFlush` in hook.ts), so a flush
    // pass rebuilds the history injection.
    const historyRebuiltThisPass = publishedHistory || flush;
    const decision = decidePassMutation(
        {
            fullFeatureMode: primary,
            compactionOff: inputs.compactionOff,
            schedulerDecision: inputs.scheduler,
            contextPercentage: inputs.usagePercent,
            forceMaterializationPercentage: inputs.forcePercent,
            contextUsageFromEstimate: inputs.usageFromEstimate,
            emergencyInputSample: () => emergencySample,
            forceTriggerPermitted: inputs.forceTriggerPermitted,
            servedShapeRepair: inputs.servedShapeRepair,
            rewritingSignedPrefix: inputs.signedPrefixRewrite,
            foldBustsServedPrefix,
            firstRenderBust,
            idleExpiryRebuild,
            heldIdleExpiryRebuild,
            explicitFlush: flush,
            publishedHistory,
            historyRebuiltThisPass,
            materializationRequested: flush,
            alreadyRanThisTurn: inputs.alreadyRanThisTurn,
            signedThinkingHold: hold,
        },
        ({ primaryExecute, alreadyBusting }) => {
            const outcome = decideExecuteReclaim({
                heldPasses: inputs.queuedDrops.heldPassesBefore,
                primaryExecute,
                alreadyBusting,
                summaryCanCome: inputs.historianInFlight || inputs.summaryPending,
                reclaimableTokens: inputs.queuedDrops.eligibleTokens,
                usableWindow: inputs.usableWindow,
            });
            heldPassesAfter = outcome.heldPasses;
            return outcome.admitted;
        },
    );
    const lanes = new Set<Lane>();
    if (decision.shouldApplyPendingOps && inputs.queuedDrops.eligibleTokens > 0)
        lanes.add("queuedDrops");
    if (decision.shouldRunHeuristics) {
        const rewriteAlreadyPriced = emergencyRewriteAlreadyPriced({
            pendingOpsDidMutate: lanes.has("queuedDrops"),
            foldBustsServedPrefix,
            firstRenderBust,
            heldIdleExpiryRebuild,
            historyRebuiltThisPass,
            compartmentInjectionRebuiltFromDb: false,
            rebuiltHistoryFromInitialPrepare: false,
        });
        if (
            emergencyEpisodeRearms({
                emergencyDropEligible: decision.emergencyDropEligible,
                rewriteAlreadyPriced,
                emergencyInputSample: () => emergencySample,
            })
        )
            emergencySample = 0;
        const emergencyDrops =
            decision.emergencyDropEligible &&
            inputs.pendingWork.emergencyDrop &&
            !emergencyEpisodeLatched(emergencySample > 0, inputs.usagePercent);
        // A batch the emergency selector applies is the episode's one pressure
        // rebuild; routine cleanup drains into that same pass.
        const routine =
            routineCleanupAdmitted({
                emergencyDropEligible: decision.emergencyDropEligible,
                contextPercentage: inputs.usagePercent,
                emergencyInputSample: () => emergencySample,
                fullFeatureMode: primary,
                routinePressureAlreadyApplied: inputs.routinePressureAlreadyApplied,
                materializationRequested: flush,
                rewriteAlreadyPriced,
            }) || emergencyDrops;
        if (emergencyDrops) lanes.add("emergencyDrop");
        if (routine && inputs.pendingWork.dedup) lanes.add("dedup");
    }
    if (decision.toolReclaimAdmitted) {
        if (inputs.pendingWork.ageSweep) lanes.add("ageSweep");
        if (inputs.pendingWork.supersession) lanes.add("supersession");
    }
    const { rideSignals } = decision;
    const active: Record<Origin, boolean> = {
        cacheLoss: rideSignals.hardFold && (firstRenderBust || idleExpiryRebuild),
        executedFold: rideSignals.hardFold && foldBustsServedPrefix,
        signedPrefixRewrite: rideSignals.hardFold && inputs.signedPrefixRewrite,
        servedShapeRepair: rideSignals.servedShapeRepair,
        publishedHistory: rideSignals.publishedHistory,
        flush: rideSignals.explicitFlush,
        force: rideSignals.force,
        primaryExecuteNoSummary: rideSignals.executeReclaim,
        subagentExecute: rideSignals.subagentExecute,
    };
    // A fold, a signed-prefix rewrite, a served-shape repair, a published m[1] refresh
    // and a lost cache rewrite the prefix by themselves; every other ride only permits
    // lanes that find work.
    const rewritesByItself =
        rideSignals.hardFold || rideSignals.publishedHistory || rideSignals.servedShapeRepair;
    const busts = rewritesByItself || lanes.size > 0;
    return {
        busts,
        origin: busts ? (ORIGINS.find((origin) => active[origin]) ?? null) : null,
        lanes: LANES.filter((lane) => lanes.has(lane)),
        // `runPostTransformPhase` clears the held-pass count on every pass that
        // changed bytes (`clearExecuteReclaimState` when `bustedThisPass`).
        heldPassesAfter: busts ? 0 : heldPassesAfter,
    };
}

function render(): string {
    const vectors: Vector[] = CASES.map((entry) => ({
        ...entry,
        expected: decideVector(entry.inputs),
    }));
    return `${JSON.stringify(
        {
            description:
                "Per-pass rebuild decisions generated from the TypeScript plugin's gates by packages/plugin/scripts/generate-pass-decision-vectors.ts. Do not edit by hand; regenerate with `bun scripts/generate-pass-decision-vectors.ts` from packages/plugin.",
            lanes: LANES,
            origins: ORIGINS,
            vectors,
        },
        null,
        2,
    )}\n`;
}

if (import.meta.main) {
    const next = render();
    if (process.argv.includes("--check")) {
        let current = "";
        try {
            current = readFileSync(VECTOR_PATH, "utf8");
        } catch {}
        if (current !== next) {
            console.error(
                `pass decision vectors are stale: ${VECTOR_PATH}\nRegenerate with: bun scripts/generate-pass-decision-vectors.ts`,
            );
            process.exit(1);
        }
        console.log(`pass decision vectors are current (${CASES.length} vectors)`);
    } else {
        writeFileSync(VECTOR_PATH, next);
        console.log(`wrote ${CASES.length} pass decision vectors to ${VECTOR_PATH}`);
    }
}
