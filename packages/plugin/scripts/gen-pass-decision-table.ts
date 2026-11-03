#!/usr/bin/env bun
/**
 * Generate ck-mc's pass contract from the plugin's production gates.
 * Run from the repository root, with --check to reject a stale committed table.
 * Lane booleans are admission, not a promise that a selector finds an edit.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");
const output = join(root, "crates/mc-module/testdata/pass-decisions.json");
const scratch = join(root, "target/scratch");
mkdirSync(scratch, { recursive: true });
const home = mkdtempSync(join(scratch, "pass-decisions-"));
// Imports can initialize logging and storage paths. Never inherit a developer's stores.
for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "MAGIC_CONTEXT_TEST_DATA_DIR"])
    process.env[key] = home;

const { createScheduler } = await import("../src/features/magic-context/scheduler");
const { escalationBands } = await import("../src/shared/escalation-bands");
const { resolveExecuteThreshold } = await import("../src/hooks/magic-context/event-resolvers");
const { decideSignedThinkingHold } = await import("../src/hooks/magic-context/signed-thinking-hold");
const { prefixMutationPermitted } = await import("../src/hooks/magic-context/cache-busting-signals");
const { decideExecuteReclaim, readExecuteReclaimState } = await import("../src/hooks/magic-context/execute-reclaim");
const { decidePassMutation, emergencyEpisodeRearms, emergencyRewriteAlreadyPriced, routineCleanupAdmitted } =
    await import("../src/hooks/magic-context/pass-mutation-decision");
const { emergencyEpisodeLatched } = await import("../src/hooks/magic-context/emergency-drop");
const { checkCompartmentTrigger } = await import("../src/hooks/magic-context/compartment-trigger");
const { deriveTriggerBudget } = await import("../src/hooks/magic-context/derive-budgets");
const { withRawMessageProvider } = await import("../src/hooks/magic-context/read-session-chunk");
const { openDatabase, closeDatabase, getOrCreateSessionMeta, insertTag, markProtectedTailPolicyV3Seeded } =
    await import("../src/features/magic-context/storage");

type Threshold = number | { default: number; [model: string]: number };
interface Input {
    model: string;
    percentage: Threshold;
    tokens: Record<string, number> | null;
    usage: number;
    primary: boolean;
    cache_expired: boolean;
    summary: "unavailable" | "ready" | "running" | "waiting" | "floor";
    floor_passes: number;
    floor_shrink: boolean;
    queued_tokens: number;
    held_passes: number;
    prefix_bound: boolean;
    reasoning_tokens: number;
    heavy_steps_back: number;
    person: boolean;
    routine_already_applied: boolean;
    emergency_latched: boolean;
}
const usable = 100_000;
const base: Input = {
    model: "anthropic/claude-opus-4-1", percentage: 65, tokens: null, usage: 70,
    primary: true, cache_expired: false, summary: "unavailable", floor_passes: 1, floor_shrink: false, queued_tokens: 2_000,
    held_passes: 0, prefix_bound: false, reasoning_tokens: 0, heavy_steps_back: 1,
    person: true, routine_already_applied: false, emergency_latched: false,
};
const rows: Array<{ id: string; input: Input }> = [];
function add(id: string, input: Partial<Input> = {}) {
    rows.push({ id, input: { ...base, ...input } });
}

// Sample each execute/force boundary for both primary and subagent sessions.
const configs: Array<{ id: string; percentage: Threshold; tokens: Input["tokens"]; threshold: number }> = [
    { id: "pct20", percentage: 20, tokens: null, threshold: 20 },
    { id: "pct65", percentage: 65, tokens: null, threshold: 65 },
    { id: "pct80", percentage: 80, tokens: null, threshold: 80 },
    { id: "pct90", percentage: 90, tokens: null, threshold: 90 },
    { id: "model-pct", percentage: { default: 65, "claude-opus-4-1": 80 }, tokens: null, threshold: 80 },
    { id: "model-tokens", percentage: 80, tokens: { default: 60_000, "claude-opus-4-1": 50_000 }, threshold: 50 },
    { id: "capped-tokens", percentage: 65, tokens: { default: 120_000 }, threshold: 90 },
];
for (const config of configs) {
    const force = escalationBands(config.threshold).forceMaterializationPercentage;
    const samples = [config.threshold - 0.1, config.threshold, (config.threshold + force) / 2, force, 95];
    for (const [sample, usage] of samples.entries()) {
        for (const primary of [true, false]) {
            for (const summary of ["unavailable", "ready", "running", "waiting"] as const) {
                add(`${config.id}-${sample}-${primary ? "primary" : "subagent"}-${summary}`, {
                    percentage: config.percentage, tokens: config.tokens, usage, primary, summary,
                });
            }
        }
    }
}
for (const queued_tokens of [0, 1_999, 2_000, 2_001]) {
    for (const held_passes of [0, 1, 2]) add(`queue-${queued_tokens}-${held_passes}`, { queued_tokens, held_passes });
}
for (const percentage of [65, 80, 90]) {
    for (const [sample, usage] of [percentage + 5, percentage + 9.9, percentage + 10, Math.max(85, percentage + 2)].entries()) {
        for (const prefix_bound of [false, true]) {
            add(`thinking-${percentage}-${sample}-${usage}-${prefix_bound}`, { percentage, usage, prefix_bound, reasoning_tokens: 1_501 });
        }
    }
}
for (const reasoning_tokens of [1_500, 1_501]) {
    for (const heavy_steps_back of [1, 15, 16]) {
        for (const person of [false, true]) add(`thinking-window-${reasoning_tokens}-${heavy_steps_back}-${person}`, {
            prefix_bound: true, reasoning_tokens, heavy_steps_back, person,
        });
    }
}
for (const primary of [true, false]) {
    for (const cache_expired of [false, true]) {
        for (const prefix_bound of [false, true]) add(`cache-${primary}-${cache_expired}-${prefix_bound}`, {
            usage: 40, primary, cache_expired, prefix_bound, reasoning_tokens: 1_600,
        });
    }
    for (const usage of [85, 94.9, 95]) {
        for (const queued_tokens of [0, 2_000]) add(`latch-${primary}-${usage}-${queued_tokens}`, {
            primary, usage, queued_tokens, emergency_latched: true,
        });
    }
    add(`routine-${primary}`, { primary, queued_tokens: 0, cache_expired: primary, routine_already_applied: true });
}

for (const floor_passes of [1, 2, 3]) add(`floor-pass-${floor_passes}`, { summary: "floor", floor_passes });
add("floor-consumed-without-head", { summary: "floor", floor_passes: 2, floor_shrink: true });

function messages(input: Input) {
    const result: Array<{ ordinal: number; id: string; role: string; parts: Array<{ type: string; text: string }>; version: null; info: Record<string, unknown> }> = [];
    const push = (role: string, text: string, reasoning = 0) => {
        const ordinal = result.length + 1;
        result.push({ ordinal, id: `m${ordinal}`, role, version: null,
            info: { role, tokens: { reasoning } },
            parts: [{ type: reasoning ? "reasoning" : "text", text }],
        });
    };
    if (input.summary === "floor") {
        push("user", "Implement the long autonomous task");
        for (let step = 0; step < 16; step++) {
            push("assistant", "history ".repeat(1_000));
            push("user", "<system-reminder>Continue working</system-reminder>");
        }
        return result;
    }
    if (input.summary === "ready") {
        for (let i = 0; i < 16; i++) push(i % 2 ? "assistant" : "user", "history ".repeat(1_000));
    }
    if (input.person) push("user", "task");
    for (let step = input.heavy_steps_back; step > 0; step--)
        push("assistant", "step", step === input.heavy_steps_back ? input.reasoning_tokens : 1);
    return result;
}

function evaluate(id: string, input: Input) {
    const db = openDatabase(join(home, "context.db"));
    if (!db) throw new Error("could not open isolated decision database");
    try {
        const meta = getOrCreateSessionMeta(db, id);
        meta.lastResponseTime = 1_000_000;
        meta.cacheTtl = "5m";
        meta.compartmentInProgress = input.summary === "running" || input.summary === "waiting";
        const usage = { percentage: input.usage, inputTokens: Math.round(input.usage * usable / 100) };
        const threshold = resolveExecuteThreshold(input.percentage, input.model, 65, {
            tokensConfig: input.tokens ?? undefined, contextLimit: usable,
        });
        const scheduler = createScheduler({ executeThresholdPercentage: input.percentage,
            executeThresholdTokens: input.tokens ?? undefined });
        const execute = scheduler.shouldExecute(meta, usage, meta.lastResponseTime + (input.cache_expired ? 300_001 : 1),
            undefined, input.model, usable) === "execute";
        const force = escalationBands(threshold).forceMaterializationPercentage;
        const transcript = messages(input);
        const signed = input.prefix_bound && decideSignedThinkingHold({ messages: transcript,
            usagePercentage: input.usage, executeThresholdPercentage: threshold,
            estimateTextTokens: text => Math.ceil(text.length / 4),
        }).held;
        markProtectedTailPolicyV3Seeded(db, id, 1);
        for (const message of transcript) insertTag(db, id, message.id, "message", message.parts[0].text.length,
            message.ordinal, 0, null, 0, null, null, { tokenCount: Math.ceil(message.parts[0].text.length / 4), inputTokenCount: 0, reasoningTokenCount: 0 });
        let summary_may_start = false;
        for (let pass = 0; pass < input.floor_passes; pass++) {
            if (pass > 0 && input.floor_shrink) transcript.splice(2);
            summary_may_start = input.primary && withRawMessageProvider(id, { readMessages: () => transcript }, () =>
            checkCompartmentTrigger(db, id, meta, usage, input.usage, threshold, deriveTriggerBudget(usable, threshold), 10_000,
                { enabled: false, min_clusters: 3 }, undefined, usable,
                { messages: transcript, absoluteMessageCount: transcript.length }, 0,
                { providerID: "anthropic", budgetCutoff: 0 },
                { hardFold: false, force: input.usage >= force && (input.usage >= 95 || !input.emergency_latched),
                    explicitFlush: false, publishedHistory: false,
                    permission: { signedThinkingHold: signed, firstRender: false, idleExpiry: false, emergency: input.usage >= force } },
                undefined, execute).shouldFire);
            if (summary_may_start) meta.compartmentInProgress = true;
        }
        let sample = input.emergency_latched ? 1 : 0;
        const decision = decidePassMutation({ fullFeatureMode: input.primary, compactionOff: false,
            schedulerDecision: execute ? "execute" : "defer", contextPercentage: input.usage,
            forceMaterializationPercentage: force, contextUsageFromEstimate: false,
            emergencyInputSample: () => sample, forceTriggerPermitted: true, servedShapeRepair: false,
            rewritingSignedPrefix: false, foldBustsServedPrefix: false, firstRenderBust: false,
            idleExpiryRebuild: input.cache_expired, heldIdleExpiryRebuild: signed && input.cache_expired,
            explicitFlush: false, publishedHistory: false, historyRebuiltThisPass: false,
            materializationRequested: false, alreadyRanThisTurn: input.routine_already_applied,
            signedThinkingHold: signed,
        }, ({ primaryExecute, alreadyBusting }) => decideExecuteReclaim({ primaryExecute, alreadyBusting,
            heldPasses: input.held_passes, summaryCanCome: meta.compartmentInProgress || summary_may_start || readExecuteReclaimState(db, id).floorOrdinal !== null,
            reclaimableTokens: input.queued_tokens, usableWindow: usable }).admitted);
        const priced = emergencyRewriteAlreadyPriced({ pendingOpsDidMutate: decision.shouldApplyPendingOps && input.queued_tokens > 0,
            foldBustsServedPrefix: false, firstRenderBust: false, heldIdleExpiryRebuild: signed && input.cache_expired,
            historyRebuiltThisPass: false, compartmentInjectionRebuiltFromDb: false, rebuiltHistoryFromInitialPrepare: false });
        if (emergencyEpisodeRearms({ emergencyDropEligible: decision.emergencyDropEligible, rewriteAlreadyPriced: priced,
            emergencyInputSample: () => sample })) sample = 0;
        const emergency_drop = decision.shouldRunHeuristics && decision.emergencyDropEligible && !emergencyEpisodeLatched(sample > 0, input.usage);
        const routine = decision.shouldRunHeuristics && (emergency_drop || routineCleanupAdmitted({
            emergencyDropEligible: decision.emergencyDropEligible, contextPercentage: input.usage, emergencyInputSample: () => sample,
            fullFeatureMode: input.primary, routinePressureAlreadyApplied: input.routine_already_applied,
            materializationRequested: false, rewriteAlreadyPriced: priced }));
        return { threshold, execute, force: decision.emergencyDropEligible,
            hold: !prefixMutationPermitted({ signedThinkingHold: signed, firstRender: false,
                idleExpiry: input.cache_expired, emergency: decision.emergencyDropEligible }),
            rebuild: decision.publishedWorkDrainAllowed, floor_marked: readExecuteReclaimState(db, id).floorOrdinal !== null, queued_drops: decision.shouldApplyPendingOps,
            heuristics: routine, reasoning: routine && !input.prefix_bound, emergency_drop, summary_may_start };
    } finally { closeDatabase(); }
}

try {
    if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error("duplicate pass decision row id");
    const table = { description: "Generated by packages/plugin/scripts/gen-pass-decision-table.ts from production TypeScript gates; lane booleans describe admission with eligible work, not selection or publication.",
        context_window: 110_000, output_reserve: 10_000, usable_window: usable, rows: rows.map(row => ({ ...row, expected: evaluate(row.id, row.input) })) };
    const rendered = `${JSON.stringify(table, null, 2)}\n`;
    if (process.argv.includes("--check")) {
        if (!existsSync(output) || readFileSync(output, "utf8") !== rendered) {
            console.error("pass decision table drifted; run bun packages/plugin/scripts/gen-pass-decision-table.ts");
            process.exitCode = 1;
        } else console.log(`pass decision table current: ${rows.length} rows`);
    } else {
        writeFileSync(output, rendered);
        console.log(`wrote ${rows.length} pass decision rows: ${output}`);
    }
} finally { rmSync(home, { recursive: true, force: true }); }
