import {
    getOrCreateSessionMeta,
    getPendingOps,
    getTagsBySession,
    getTopNBySize,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import type { ContextUsage, SessionMeta, TagEntry } from "../../features/magic-context/types";
import { sessionLog } from "../../shared/logger";
import { resolveExecuteThreshold } from "./event-resolvers";
import { formatBytes } from "./format-bytes";
import {
    formatRollingNudgeBand,
    getRollingNudgeBand,
    getRollingNudgeBandPriority,
    getRollingNudgeIntervalTokens,
    type RollingNudgeBand,
} from "./nudge-bands";

type ContextDatabase = Parameters<typeof getOrCreateSessionMeta>[0];
export type ContextNudge = { type: "assistant"; text: string };
export const RECENT_CTX_REDUCE_WINDOW_MS = 2 * 60 * 1000;

function formatLargestTags(tags: ReturnType<typeof getTopNBySize>): string {
    if (tags.length === 0) {
        return "none";
    }

    return tags.map((tag) => `§${tag.tagNumber}§`).join(", ");
}

function formatOldToolTags(activeTags: TagEntry[], protectedCount: number, count: number): string {
    const sortedByNumber = [...activeTags].sort((a, b) => a.tagNumber - b.tagNumber);
    const protectedThreshold =
        protectedCount > 0 && sortedByNumber.length > protectedCount
            ? sortedByNumber[sortedByNumber.length - protectedCount].tagNumber
            : Infinity;
    const midpoint = Math.floor(sortedByNumber.length / 2);
    const earlyHalf = sortedByNumber.slice(0, midpoint);
    const earlyToolTags = earlyHalf.filter(
        (t) => t.type === "tool" && t.tagNumber < protectedThreshold,
    );
    if (earlyToolTags.length === 0) return "";

    const selected = earlyToolTags.sort((a, b) => b.byteSize - a.byteSize).slice(0, count);
    const formatted = selected
        .sort((a, b) => a.tagNumber - b.tagNumber)
        .map((t) => `§${t.tagNumber}§(${formatBytes(t.byteSize)})`)
        .join(", ");
    return ` Old tool outputs worth dropping: ${formatted}`;
}

export function createNudger(config: {
    protected_tags: number;
    nudge_interval_tokens: number;
    iteration_nudge_threshold: number;
    execute_threshold_percentage: number | { default: number; [modelKey: string]: number };
    now?: () => number;
    recentReduceBySession?: Map<string, number>;
}) {
    const lastReduceAtBySession = config.recentReduceBySession ?? new Map<string, number>();

    return (
        sessionId: string,
        contextUsage: ContextUsage,
        db: ContextDatabase,
        topNFn: typeof getTopNBySize,
        preloadedTags?: TagEntry[],
        messagesSinceLastUser?: number,
        preloadedSessionMeta?: SessionMeta,
    ): ContextNudge | null => {
        const sessionMeta = preloadedSessionMeta ?? getOrCreateSessionMeta(db, sessionId);
        const now = config.now?.() ?? Date.now();
        const lastReduceAt = lastReduceAtBySession.get(sessionId);
        if (lastReduceAt !== undefined && now - lastReduceAt > RECENT_CTX_REDUCE_WINDOW_MS) {
            lastReduceAtBySession.delete(sessionId);
        }

        if (contextUsage.inputTokens < sessionMeta.lastNudgeTokens) {
            sessionMeta.lastNudgeTokens = contextUsage.inputTokens;
            updateSessionMeta(db, sessionId, { lastNudgeTokens: contextUsage.inputTokens });
        }

        if (lastReduceAt !== undefined && now - lastReduceAt <= RECENT_CTX_REDUCE_WINDOW_MS) {
            sessionLog(
                sessionId,
                `nudge: suppressed at ${contextUsage.percentage.toFixed(1)}% because ctx_reduce ran recently (${now - lastReduceAt}ms ago)`,
            );
            return null;
        }

        const projectedPercentage = estimateProjectedPercentage(
            db,
            sessionId,
            contextUsage,
            preloadedTags,
        );
        const executeThreshold = resolveExecuteThreshold(
            config.execute_threshold_percentage,
            undefined,
            65,
        );
        const currentBand = getRollingNudgeBand(contextUsage.percentage, executeThreshold);
        const currentInterval = getRollingNudgeIntervalTokens(
            config.nudge_interval_tokens,
            currentBand,
        );
        const lastBand = sessionMeta.lastNudgeBand;

        if (getRollingNudgeBandPriority(currentBand) < getRollingNudgeBandPriority(lastBand)) {
            sessionMeta.lastNudgeBand = currentBand;
            updateSessionMeta(db, sessionId, { lastNudgeBand: currentBand });
        }

        const largest = formatLargestTags(topNFn(db, sessionId, 3));
        const protectedCount = config.protected_tags;
        const activeTags = (preloadedTags ?? getTagsBySession(db, sessionId)).filter(
            (t) => t.status === "active",
        );
        const highestProtected = activeTags
            .map((t) => t.tagNumber)
            .sort((a, b) => b - a)
            .slice(0, protectedCount)[0];
        const protectedHint = highestProtected
            ? ` Tags §${highestProtected}§ and above are protected (last ${protectedCount}) — You MUST NOT try to reduce those.`
            : "";
        const oldToolHint = formatOldToolTags(activeTags, protectedCount, 5);

        // Iteration nudge: detect long tool chains without user input
        // Fires below the execute threshold when agent has been iterating for N+ messages
        const iterationThreshold = config.iteration_nudge_threshold;
        if (
            messagesSinceLastUser !== undefined &&
            messagesSinceLastUser >= iterationThreshold &&
            contextUsage.percentage >= 35 &&
            contextUsage.percentage < executeThreshold &&
            contextUsage.inputTokens - sessionMeta.lastNudgeTokens >= currentInterval
        ) {
            sessionLog(
                sessionId,
                `nudge fired: iteration_nudge at ${contextUsage.percentage.toFixed(1)}% (${messagesSinceLastUser} messages since user, interval: ${contextUsage.inputTokens - sessionMeta.lastNudgeTokens}/${currentInterval} tokens)`,
            );
            updateSessionMeta(db, sessionId, { lastNudgeTokens: contextUsage.inputTokens });
            return {
                type: "assistant",
                text: [
                    `\n\n<instruction name="context_iteration">`,
                    `CONTEXT ITERATION NOTICE — ~${Math.round(contextUsage.percentage)}%`,
                    `You have been executing ${messagesSinceLastUser}+ tool calls without clearing old context.`,
                    `Consider using \`ctx_reduce\` to drop old tool outputs you have already processed.`,
                    ``,
                    `Largest: ${largest}.${oldToolHint}${protectedHint}`,
                    `Tags are marked with §N§ identifiers (e.g., §1§, §42§).`,
                    ``,
                    `Actions:`,
                    `- drop: Remove content entirely. Best for old tool outputs you already acted on.`,
                    `- Syntax: "3-5", "1,2,9", or "1-5,8,12-15" (bare integers).`,
                    `- Only drop what you have already processed. NEVER drop large ranges blindly.`,
                    `</instruction>`,
                ].join("\n"),
            };
        }

        const intervalReached =
            contextUsage.inputTokens - sessionMeta.lastNudgeTokens >= currentInterval;
        const bandEscalated =
            lastBand !== null &&
            getRollingNudgeBandPriority(currentBand) > getRollingNudgeBandPriority(lastBand);

        if (bandEscalated || intervalReached) {
            const reason = bandEscalated
                ? `band escalation (${formatRollingNudgeBand(lastBand)} -> ${currentBand})`
                : `interval ${contextUsage.inputTokens - sessionMeta.lastNudgeTokens}/${currentInterval} tokens`;
            sessionLog(
                sessionId,
                `nudge fired: rolling_${currentBand} at ${contextUsage.percentage.toFixed(1)}% (${reason})`,
            );
            updateSessionMeta(db, sessionId, {
                lastNudgeTokens: contextUsage.inputTokens,
                lastNudgeBand: currentBand,
            });
            return {
                type: "assistant",
                text: buildRollingNudgeText(
                    currentBand,
                    contextUsage.percentage,
                    largest,
                    oldToolHint,
                    protectedHint,
                ),
            };
        }

        sessionLog(
            sessionId,
            `nudge: none fired at ${contextUsage.percentage.toFixed(1)}% (band=${currentBand} lastBand=${formatRollingNudgeBand(lastBand)} lastNudge=${sessionMeta.lastNudgeTokens} current=${contextUsage.inputTokens} interval=${currentInterval} projected=${projectedPercentage?.toFixed(1) ?? "none"})`,
        );
        return null;
    };
}

function buildRollingNudgeText(
    band: RollingNudgeBand,
    percentage: number,
    largest: string,
    oldToolHint: string,
    protectedHint: string,
): string {
    const titleByBand: Record<RollingNudgeBand, string> = {
        far: "CONTEXT REMINDER",
        near: "CONTEXT WARNING",
        urgent: "CONTEXT URGENT",
        critical: "CONTEXT CRITICAL",
    };
    const instructionByBand: Record<RollingNudgeBand, string> = {
        far: "You should use `ctx_reduce` to drop old tool outputs before continuing.",
        near: "You should call `ctx_reduce` soon to free space before more heavy reads or tool output.",
        urgent: "You should call `ctx_reduce` before doing more reads or tool-heavy work.",
        critical: "You MUST call `ctx_reduce` RIGHT NOW before doing ANYTHING else.",
    };
    const cautionByBand: Record<RollingNudgeBand, string> = {
        far: "- Only drop what you have already processed. NEVER drop large ranges blindly.",
        near: "- Review what each tag contains. Drop processed outputs, keep anything you might need soon.",
        urgent: "- Review each tag before deciding. Avoid broad drops that could remove active context.",
        critical:
            '- NEVER drop large ranges blindly (e.g., "1-50"). Review each tag before deciding.',
    };
    return [
        `\n\n<instruction name="context_${band}">`,
        `${titleByBand[band]} — ~${Math.round(percentage)}%`,
        instructionByBand[band],
        ``,
        `Largest: ${largest}.${oldToolHint}${protectedHint}`,
        `Tags are marked with §N§ identifiers (e.g., §1§, §42§).`,
        ``,
        `Actions:`,
        `- drop: Remove content entirely. Best for old tool outputs you already acted on.`,
        `- Syntax: "3-5", "1,2,9", or "1-5,8,12-15" (bare integers).`,
        cautionByBand[band],
        `</instruction>`,
    ].join("\n");
}

function estimateProjectedPercentage(
    db: ContextDatabase,
    sessionId: string,
    contextUsage: ContextUsage,
    preloadedTags?: TagEntry[],
): number | null {
    const pendingOps = getPendingOps(db, sessionId);
    const pendingDrops = pendingOps.filter((op) => op.operation === "drop");
    if (pendingDrops.length === 0) {
        return null;
    }

    const activeTags = (preloadedTags ?? getTagsBySession(db, sessionId)).filter(
        (t) => t.status === "active",
    );
    const totalActiveBytes = activeTags.reduce((sum, t) => sum + t.byteSize, 0);
    if (totalActiveBytes === 0) {
        return null;
    }

    const pendingDropTagIds = new Set(pendingDrops.map((op) => op.tagId));
    const pendingDropBytes = activeTags
        .filter((t) => pendingDropTagIds.has(t.tagNumber))
        .reduce((sum, t) => sum + t.byteSize, 0);

    const dropRatio = pendingDropBytes / totalActiveBytes;
    return contextUsage.percentage * (1 - dropRatio);
}

export function generateEmergencyNudgeText(
    db: ContextDatabase,
    sessionId: string,
    contextUsage: ContextUsage,
    config: { protected_tags: number },
): string {
    const largest = formatLargestTags(getTopNBySize(db, sessionId, 3));
    const protectedCount = config.protected_tags;
    const activeTags = getTagsBySession(db, sessionId).filter((t) => t.status === "active");
    const highestProtected = activeTags
        .map((t) => t.tagNumber)
        .sort((a, b) => b - a)
        .slice(0, protectedCount)[0];
    const protectedHint = highestProtected
        ? ` Tags \u00a7${highestProtected}\u00a7 and above are protected (last ${protectedCount}) \u2014 You MUST NOT try to reduce those.`
        : "";
    const oldToolHint = formatOldToolTags(activeTags, protectedCount, 5);

    return [
        `<instruction name="context_emergency">`,
        `CONTEXT EMERGENCY — ~${Math.round(contextUsage.percentage)}%. STOP all current work immediately.`,
        ``,
        `You MUST use \`ctx_reduce\` RIGHT NOW to free space. If context overflows, you lose all work.`,
        ``,
        `Steps:`,
        `1. Find OLD tool outputs (grep results, file reads, build logs) you already processed — look at §N§ tags`,
        `2. Drop those specifically: e.g. drop="3,7,12" — NEVER drop large ranges like "1-50"`,
        `3. KEEP anything related to current task, recent errors, or decisions`,
        ``,
        `Largest tags: ${largest}.${oldToolHint}${protectedHint}`,
        `</instruction>`,
    ].join("\n");
}
