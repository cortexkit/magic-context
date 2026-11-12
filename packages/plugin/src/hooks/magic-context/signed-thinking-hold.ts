import { isRecord } from "../../shared/record-type-guard";
import { latestAssistantTurnStart } from "./latest-assistant-turn";
import { reasoningStepCost } from "./reasoning-budget";

/**
 * Bounded hold for prefix-bound thinking models (Fable 5.1, Opus 5.5, Sonnet
 * 5.5, Haiku 5.5).
 *
 * On those models a signed thinking block stays valid only while every byte
 * before it is unchanged, so a pass that changes earlier bytes must strip every
 * signed block it keeps (see freezeReasoningOnBustingPass). Holding prefix
 * changes for a whole turn kept that reasoning, but synthetic continuations
 * never end a turn, so an autonomous session could sit in the force band for
 * hours with its published history never reaching the prompt.
 *
 * The hold is therefore bounded. A pass of an active thinking turn is held only
 * while ALL are true:
 *  1. one of the turn's last HEAVY_REASONING_WINDOW_STEPS assistant steps spent
 *     more than HEAVY_REASONING_TOKENS reasoning tokens,
 *  2. context usage is below the execute threshold plus HOLD_CAP_POINTS, and
 *  3. the pass is not in force-band pressure (`forceBandConfirmed`).
 * Otherwise the pass busts mid-turn exactly as on any other model, and a bust
 * strips the turn's signed thinking.
 *
 * The third condition matters only when the execute threshold sits so high that
 * the cap lies above the force band. Force-band pressure already lets a held
 * pass rewrite its prefix, but a held pass still protects everything in front
 * of the turn's kept thinking. A single-turn session (a subagent) then lands
 * none of its queued drops and its emergency drop finds nothing to drop, until
 * usage passes the cap. Ending the hold where that pressure begins keeps the
 * rewrite permission and the hold in agreement.
 *
 * The decision reads only the messages, the usage the host recorded on them,
 * and the pass's usage reading, so every replay of the same input decides the
 * same way. It stores nothing.
 */
export const HEAVY_REASONING_TOKENS = 1_500;
export const HEAVY_REASONING_WINDOW_STEPS = 15;
export const HOLD_CAP_POINTS = 10;

const REASONING_TYPES = new Set(["reasoning", "thinking"]);

export interface SignedThinkingHoldDecision {
    held: boolean;
    reason: "heavy_reasoning" | "no_recent_heavy_reasoning" | "above_cap" | "force_band";
    /** 1 for the newest assistant step of the turn; null when no heavy step is in the window. */
    heavyStepsBack: number | null;
    /** Reasoning tokens of the newest heavy step in the window, or 0. */
    heavyStepTokens: number;
    /** Usage percentage at and above which the hold always ends. */
    capPercentage: number;
}

function role(message: unknown): unknown {
    if (!isRecord(message)) return undefined;
    return isRecord(message.info) ? message.info.role : message.role;
}

function parts(message: unknown): unknown[] {
    if (!isRecord(message)) return [];
    if (Array.isArray(message.parts)) return message.parts;
    return Array.isArray(message.content) ? message.content : [];
}

/**
 * The reasoning-token count the host recorded for one assistant step, if any.
 * OpenCode stores it on `info.tokens.reasoning`; Pi (pi-ai) on
 * `usage.reasoning`; Oh My Pi on `usage.reasoningTokens`. Zero counts as not
 * recorded: OpenCode writes 0 when the provider reports no breakdown.
 */
export function recordedReasoningTokens(message: unknown): number | undefined {
    if (!isRecord(message)) return undefined;
    const info = isRecord(message.info) ? message.info : undefined;
    const candidates: unknown[] = [];
    if (info && isRecord(info.tokens)) candidates.push(info.tokens.reasoning);
    if (isRecord(message.usage)) {
        candidates.push(message.usage.reasoning, message.usage.reasoningTokens);
    }
    for (const value of candidates) {
        if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    }
    return undefined;
}

/**
 * Reasoning tokens of one assistant step: the host's recorded count when it has
 * one, otherwise an estimate from the step's stored thinking text.
 */
export function stepReasoningTokens(
    message: unknown,
    estimateTextTokens: (text: string) => number,
): number {
    let text = "";
    let opaque = false;
    for (const part of parts(message)) {
        if (!isRecord(part)) continue;
        const type = String(part.type ?? part.kind);
        if (type === "redacted_thinking" || part.redacted === true) {
            opaque = true;
            continue;
        }
        if (!REASONING_TYPES.has(type)) continue;
        const body =
            typeof part.thinking === "string"
                ? part.thinking
                : typeof part.text === "string"
                  ? part.text
                  : "";
        if (body.length > 0) text += body;
        else opaque = true;
    }
    if (!text && !opaque) return 0;
    return reasoningStepCost(
        recordedReasoningTokens(message),
        text ? estimateTextTokens(text) : 0,
        opaque,
    );
}

/**
 * Decide whether this pass of an active thinking turn is held. The caller
 * applies it only on a prefix-bound model with signed thinking in the turn.
 */
export function decideSignedThinkingHold(args: {
    messages: readonly unknown[];
    usagePercentage: number;
    executeThresholdPercentage: number;
    /**
     * The pass's reading is force-band pressure, by the same predicate the
     * rewrite permission uses to lift a hold (`forceBandConfirmed` on OpenCode,
     * the emergency gate on Pi).
     */
    forceBandPressure: boolean;
    estimateTextTokens: (text: string) => number;
}): SignedThinkingHoldDecision {
    const capPercentage = args.executeThresholdPercentage + HOLD_CAP_POINTS;
    let heavyStepsBack: number | null = null;
    let heavyStepTokens = 0;
    const start = latestAssistantTurnStart(args.messages);
    let stepsBack = 0;
    for (let index = args.messages.length - 1; index >= start; index--) {
        const message = args.messages[index];
        // An assistant with no parts yet (a step still being created) has not
        // run, so it does not take a slot in the window.
        if (role(message) !== "assistant" || parts(message).length === 0) continue;
        stepsBack++;
        if (stepsBack > HEAVY_REASONING_WINDOW_STEPS) break;
        const tokens = stepReasoningTokens(message, args.estimateTextTokens);
        if (tokens > HEAVY_REASONING_TOKENS) {
            heavyStepsBack = stepsBack;
            heavyStepTokens = tokens;
            break;
        }
    }
    if (heavyStepsBack === null)
        return {
            held: false,
            reason: "no_recent_heavy_reasoning",
            heavyStepsBack,
            heavyStepTokens,
            capPercentage,
        };
    if (!(args.usagePercentage < capPercentage))
        return { held: false, reason: "above_cap", heavyStepsBack, heavyStepTokens, capPercentage };
    if (args.forceBandPressure)
        return {
            held: false,
            reason: "force_band",
            heavyStepsBack,
            heavyStepTokens,
            capPercentage,
        };
    return {
        held: true,
        reason: "heavy_reasoning",
        heavyStepsBack,
        heavyStepTokens,
        capPercentage,
    };
}
