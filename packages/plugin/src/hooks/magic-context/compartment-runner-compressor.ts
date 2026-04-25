import {
    COMPRESSOR_MERGE_RATIO_BY_DEPTH,
    DEFAULT_COMPRESSOR_GRACE_COMPARTMENTS,
    DEFAULT_COMPRESSOR_MAX_COMPARTMENTS_PER_PASS,
    DEFAULT_COMPRESSOR_MAX_MERGE_DEPTH,
    DEFAULT_COMPRESSOR_MIN_COMPARTMENT_RATIO,
    DEFAULT_HISTORIAN_TIMEOUT_MS,
} from "../../config/schema/magic-context";
import type { Compartment } from "../../features/magic-context/compartment-storage";
import {
    getAverageCompressionDepth,
    getCompartments,
    getSessionFacts,
    incrementCompressionDepth,
    replaceAllCompartmentState,
} from "../../features/magic-context/storage";
import type { PluginContext } from "../../plugin/types";
import { normalizeSDKResponse, promptSyncWithModelSuggestionRetry } from "../../shared";
import { extractLatestAssistantText } from "../../shared/assistant-message-extractor";
import { getErrorMessage } from "../../shared/error-message";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import type { CavemanLevel } from "./caveman";
import { cavemanCompress } from "./caveman";
import { parseCompartmentOutput } from "./compartment-parser";
import { buildCompressorPrompt } from "./compartment-prompt";
import { estimateTokens } from "./read-session-formatting";

const HISTORIAN_AGENT = "historian";

/** Per-session cache of the last depth histogram string we logged.
 *  Used to suppress repeat log lines when the histogram hasn't changed
 *  between scheduler passes (most passes don't alter compartment depth). */
const lastDepthHistogramBySession = new Map<string, string>();

export interface CompressorDeps {
    client: PluginContext["client"];
    db: Database;
    sessionId: string;
    directory: string;
    historyBudgetTokens: number;
    historianTimeoutMs?: number;
    /** Floor = ceil(lastEndMessage / minCompartmentRatio). Default 1000. */
    minCompartmentRatio?: number;
    /** Maximum depth any compartment range can be compressed to. Default 5. */
    maxMergeDepth?: number;
    /** Cap on compartments sent to the LLM in one pass. Default 15. */
    maxCompartmentsPerPass?: number;
    /** Newest compartments always excluded from compression. Default 10. */
    graceCompartments?: number;
}

/** Depth → caveman level mapping. Depth 1 = merge only (no caveman post-process).
 *  Depths 2-4 apply caveman lite/full/ultra. Depth 5 short-circuits (title only). */
function cavemanLevelForDepth(outputDepth: number): CavemanLevel | null {
    if (outputDepth <= 1) return null;
    if (outputDepth === 2) return "lite";
    if (outputDepth === 3) return "full";
    if (outputDepth === 4) return "ultra";
    // depth 5 handled separately (title-only short-circuit)
    return null;
}

interface ScoredCompartment {
    compartment: Compartment;
    index: number;
    tokenEstimate: number;
    averageDepth: number;
}

/**
 * Check if the compartment block exceeds the history budget and run a compression pass if needed.
 * Returns true if compression ran successfully, false otherwise.
 */
export async function runCompressionPassIfNeeded(deps: CompressorDeps): Promise<boolean> {
    const { db, sessionId, historyBudgetTokens } = deps;
    const minCompartmentRatio =
        deps.minCompartmentRatio ?? DEFAULT_COMPRESSOR_MIN_COMPARTMENT_RATIO;
    const maxMergeDepth = deps.maxMergeDepth ?? DEFAULT_COMPRESSOR_MAX_MERGE_DEPTH;

    const compartments = getCompartments(db, sessionId);
    if (compartments.length <= 1) return false;

    const facts = getSessionFacts(db, sessionId);

    // Estimate the current block size (compartments + facts, excluding memory block which is cached separately)
    let totalTokens = 0;
    for (const c of compartments) {
        totalTokens += estimateTokens(
            `<compartment start="${c.startMessage}" end="${c.endMessage}" title="${c.title}">\n${c.content}\n</compartment>\n`,
        );
    }
    for (const f of facts) {
        totalTokens += estimateTokens(`* ${f.content}\n`);
    }

    if (totalTokens <= historyBudgetTokens) {
        sessionLog(
            sessionId,
            `compressor: history block ~${totalTokens} tokens within budget ${historyBudgetTokens}, skipping`,
        );
        return false;
    }

    // Compute floor from total raw message coverage (ceil to round up).
    const lastEndMessage = compartments[compartments.length - 1].endMessage;
    const floor = Math.max(1, Math.ceil(lastEndMessage / minCompartmentRatio));
    if (compartments.length <= floor) {
        sessionLog(
            sessionId,
            `compressor: at floor (${compartments.length} compartments, floor=${floor} from ${lastEndMessage} msgs), skipping`,
        );
        return false;
    }

    const overage = totalTokens - historyBudgetTokens;
    sessionLog(
        sessionId,
        `compressor: history block ~${totalTokens} tokens exceeds budget ${historyBudgetTokens} by ~${overage} tokens`,
    );

    const maxCompartmentsPerPass =
        deps.maxCompartmentsPerPass ?? DEFAULT_COMPRESSOR_MAX_COMPARTMENTS_PER_PASS;
    const graceCompartments = deps.graceCompartments ?? DEFAULT_COMPRESSOR_GRACE_COMPARTMENTS;

    // Enrich compartments with current depth + token estimates for selection.
    const scored = scoreCompartments(db, sessionId, compartments);

    // Debug: emit the depth histogram across all eligible scope so forensics on
    // bad compressor runs (e.g. runaway cascades) can be done from logs alone.
    const depthHistogram = new Map<number, number>();
    for (const s of scored) {
        const bucket = Math.round(s.averageDepth);
        depthHistogram.set(bucket, (depthHistogram.get(bucket) ?? 0) + 1);
    }
    const histText = [...depthHistogram.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([d, n]) => `d${d}=${n}`)
        .join(" ");
    // Suppress repeat logs on unchanged histograms — most scheduler passes
    // don't actually alter compartment depth, and emitting the same line
    // every pass is pure noise.
    const histKey = `${scored.length}|${histText}`;
    if (lastDepthHistogramBySession.get(sessionId) !== histKey) {
        lastDepthHistogramBySession.set(sessionId, histKey);
        sessionLog(sessionId, `compressor: depth histogram (${scored.length} total) ${histText}`);
    }

    // Cap how many compartments we can afford to pick without violating the floor.
    // The compressor produces fewer output compartments than input; the difference
    // reduces total compartment count, so we must leave enough headroom above floor.
    const floorHeadroom = compartments.length - floor;
    if (floorHeadroom < 1) {
        sessionLog(
            sessionId,
            `compressor: no floor headroom (${compartments.length} compartments, floor=${floor}), skipping`,
        );
        return false;
    }

    const contiguous = selectCompressionBand(scored, {
        maxPickable: maxCompartmentsPerPass,
        maxMergeDepth,
        graceCompartments,
        floorHeadroom,
    });

    if (contiguous.length < 2) {
        sessionLog(
            sessionId,
            `compressor: no eligible same-depth band found (floor=${floor}, maxDepth=${maxMergeDepth}, grace=${graceCompartments}, maxPerPass=${maxCompartmentsPerPass}), skipping`,
        );
        return false;
    }

    const firstIndex = contiguous[0].index;
    const lastIndex = contiguous[contiguous.length - 1].index;
    const selectedCompartments = contiguous.map((s) => s.compartment);
    const selectedTokens = contiguous.reduce((t, s) => t + s.tokenEstimate, 0);
    const overallAverageDepth =
        contiguous.reduce((sum, s) => sum + s.averageDepth, 0) / contiguous.length;
    // Output depth is the average-before-increment rounded, plus 1 (incrementCompressionDepth
    // adds exactly 1 to every ordinal). Clamped to [1, 5] because depths outside that
    // aren't defined in the pipeline.
    const outputDepth = Math.min(5, Math.max(1, Math.round(overallAverageDepth) + 1));
    const mergeRatio = COMPRESSOR_MERGE_RATIO_BY_DEPTH[outputDepth] ?? 2.0;
    const outputCount = mergeRatio > 0 ? Math.max(1, Math.ceil(contiguous.length / mergeRatio)) : 1;

    sessionLog(
        sessionId,
        `compressor: scored ${compartments.length}, picked ${contiguous.length} contiguous (${selectedCompartments[0].startMessage}-${selectedCompartments[selectedCompartments.length - 1].endMessage}, ~${selectedTokens} tokens), avg_depth=${overallAverageDepth.toFixed(1)} → output_depth=${outputDepth} (ratio=${mergeRatio}, target=${outputCount} compartments)`,
    );

    // Depth 5 short-circuit: collapse to title-only. No LLM call needed.
    if (outputDepth === 5) {
        return finalizeCompression({
            db,
            sessionId,
            compartments,
            leadingCount: firstIndex,
            trailingIndex: lastIndex + 1,
            selectedCompartments,
            compressed: selectedCompartments.map((c) => ({
                startMessage: c.startMessage,
                endMessage: c.endMessage,
                startMessageId: c.startMessageId,
                endMessageId: c.endMessageId,
                title: c.title,
                content: "",
            })),
            originalStart: selectedCompartments[0].startMessage,
            originalEnd: selectedCompartments[selectedCompartments.length - 1].endMessage,
            facts,
            logLabel: `depth-5 title-only collapse (${selectedCompartments.length} → ${selectedCompartments.length})`,
        });
    }

    // Depths 1-4: run LLM compressor with a depth-specific prompt.
    try {
        // Target output size scales with the per-depth merge ratio. At depth 1
        // (1.33x) content is preserved; at deeper depths it compresses more.
        const targetTokens = Math.max(200, Math.floor(selectedTokens / mergeRatio));
        const llmCompressed = await runCompressorPass({
            ...deps,
            compartments: selectedCompartments,
            currentTokens: selectedTokens,
            targetTokens,
            outputCount,
            outputDepth,
        });

        if (!llmCompressed) {
            sessionLog(sessionId, "compressor: LLM pass failed, keeping existing compartments");
            return false;
        }

        // Apply caveman post-processing to enforce depth-specific style.
        const level = cavemanLevelForDepth(outputDepth);
        const finalCompressed = level
            ? llmCompressed.map((c) => ({ ...c, content: cavemanCompress(c.content, level) }))
            : llmCompressed;

        return finalizeCompression({
            db,
            sessionId,
            compartments,
            leadingCount: firstIndex,
            trailingIndex: lastIndex + 1,
            selectedCompartments,
            compressed: finalCompressed,
            originalStart: selectedCompartments[0].startMessage,
            originalEnd: selectedCompartments[selectedCompartments.length - 1].endMessage,
            facts,
            logLabel: `depth-${outputDepth} (${selectedCompartments.length} → ${finalCompressed.length})`,
        });
    } catch (error: unknown) {
        sessionLog(sessionId, "compressor: unexpected error:", getErrorMessage(error));
        return false;
    }
}

// ---------------------------------------------------------------------------
// Selection helpers.
// ---------------------------------------------------------------------------

/**
 * Enrich each compartment with its current token estimate and average
 * compression depth. The previous revision computed a weighted age+depth
 * score here, but the score was never consulted — selection was oldest-first
 * regardless. With the new `selectCompressionBand` (lowest-depth-first,
 * oldest-within-depth) we don't need an aggregate score at all, so this
 * function just attaches the two fields selection actually reads.
 */
function scoreCompartments(
    db: Database,
    sessionId: string,
    compartments: Compartment[],
): ScoredCompartment[] {
    return compartments.map((compartment, index) => {
        const tokenEstimate = estimateTokens(
            `<compartment start="${compartment.startMessage}" end="${compartment.endMessage}" title="${compartment.title}">\n${compartment.content}\n</compartment>\n`,
        );
        const averageDepth = getAverageCompressionDepth(
            db,
            sessionId,
            compartment.startMessage,
            compartment.endMessage,
        );
        return { compartment, index, tokenEstimate, averageDepth };
    });
}

interface SelectionConstraints {
    /** Max compartments to pick per pass (LLM batch cap). */
    maxPickable: number;
    /** Max compression depth a compartment range can reach. */
    maxMergeDepth: number;
    /** Number of newest compartments always excluded (grace period). */
    graceCompartments: number;
    /** compartments.length - floor; we can't reduce below this without violating floor. */
    floorHeadroom: number;
}

/**
 * Pick a contiguous same-depth band of compartments to compress next.
 *
 * Strategy (depth-first, oldest-within-tier):
 *   1. Eligible scope = [0, scored.length - graceCompartments).
 *      Newest `graceCompartments` are never compressed (protects just-published
 *      historian output).
 *   2. Within eligible scope, ignore compartments whose rounded depth is
 *      already at `maxMergeDepth` — they're done.
 *   3. Find the **minimum** depth tier that still exists in scope.
 *   4. Anchor on the **oldest** compartment at that minimum depth (lowest
 *      index). Extend forward while the next compartment has the same rounded
 *      depth, stopping at maxPickable / floorHeadroom / scope end.
 *   5. Require runLen ≥ 2. If the oldest minimum-depth compartment can't form
 *      a run (neighbor has a different depth), the algorithm would stall —
 *      so fall back to finding the *next* oldest compartment at minDepth and
 *      retry. This preserves the old "skip singleton and move on" safety
 *      without abandoning the min-depth invariant.
 *
 * Why this shape:
 *   The previous algorithm was oldest-first regardless of depth. After the
 *   first pass compressed seq 0-14 to depth 1, the next pass picked seq 0-X
 *   AGAIN because they were still the oldest. The cascade ran depth 0→1→2→
 *   3→4→5 on the same range within hours, crushing early compartments to
 *   empty title-only shells while the rest of history stayed at depth 0.
 *
 *   Depth-first selection means: once seq 0-14 reach depth 1, the next pass
 *   prefers any depth-0 band elsewhere (seq 15+) before touching seq 0-14
 *   again. Old→new gets pushed down one tier at a time, producing a smooth
 *   depth gradient (old = deeper, recent = shallower) like memory decay.
 *
 *   Grace window still protects the newest N from compression entirely so
 *   freshly-published historian output has time to settle.
 */
export function selectCompressionBand(
    scored: ScoredCompartment[],
    constraints: SelectionConstraints,
): ScoredCompartment[] {
    const { maxPickable, maxMergeDepth, graceCompartments, floorHeadroom } = constraints;
    const hardMaxPick = Math.max(0, Math.min(maxPickable, floorHeadroom));
    if (hardMaxPick < 2) return [];

    const scanEnd = Math.max(0, scored.length - graceCompartments);
    if (scanEnd < 2) return [];

    // Collect every distinct depth tier present in eligible scope, ascending.
    // We'll try tiers in this order: if the lowest tier can't form a run of 2,
    // fall back to the next tier up, etc. This keeps the depth-first
    // preference (old history compresses first, stays deeper) while avoiding
    // a stall when the lowest tier happens to be a lone compartment.
    const tiers = new Set<number>();
    for (let i = 0; i < scanEnd; i++) {
        const entry = scored[i];
        if (!entry) continue;
        if (entry.averageDepth >= maxMergeDepth) continue;
        tiers.add(Math.round(entry.averageDepth));
    }
    if (tiers.size === 0) return [];
    const orderedTiers = [...tiers].sort((a, b) => a - b);

    for (const targetDepth of orderedTiers) {
        // Scan oldest→newest at this tier. Return the first contiguous run of
        // 2+ compartments whose rounded avgDepth equals `targetDepth`.
        let i = 0;
        while (i < scanEnd) {
            const anchor = scored[i];
            if (!anchor) {
                i++;
                continue;
            }
            if (
                anchor.averageDepth >= maxMergeDepth ||
                Math.round(anchor.averageDepth) !== targetDepth
            ) {
                i++;
                continue;
            }
            let j = i;
            while (j < scanEnd) {
                const entry = scored[j];
                if (!entry) break;
                if (entry.averageDepth >= maxMergeDepth) break;
                if (Math.round(entry.averageDepth) !== targetDepth) break;
                if (j - i >= hardMaxPick) break;
                j++;
            }
            const runLen = j - i;
            if (runLen >= 2) {
                return scored.slice(i, j);
            }
            // Singleton at this tier here — advance past it and keep scanning
            // the same tier for another anchor.
            i = Math.max(j, i + 1);
        }
    }

    return [];
}

/**
 * @deprecated Use {@link selectCompressionBand}. Kept as an export for the
 * existing test suite that targets the older naming; semantics are identical.
 */
export const findOldestContiguousSameDepthBand = selectCompressionBand;

/**
 * Snap LLM-output ordinals to enclosing input compartment boundaries.
 *
 * LLMs drift by ±1-2 ordinals when merging compartment ranges (e.g. outputting
 * start=8161 when the actual input boundary is 8160). Exact-match lookup rejects
 * these as "messageId missing" and fails the whole pass. Instead, interpret each
 * LLM output range as "I merged these input compartments together" and find the
 * input compartment whose [startMessage, endMessage] range contains the LLM's
 * start / end. Use that input compartment's canonical startMessage+startMessageId
 * (or endMessage+endMessageId).
 *
 * Returns null if any LLM ordinal falls outside every input compartment's range
 * (indicates a hallucinated boundary, not drift). Contiguity/coverage are
 * validated downstream by `finalizeCompression`.
 */
function snapLLMOutputToInputBoundaries(
    llmOutput: Array<{
        startMessage: number;
        endMessage: number;
        title: string;
        content: string;
    }>,
    inputCompartments: Compartment[],
): {
    result: Array<{
        startMessage: number;
        endMessage: number;
        startMessageId: string;
        endMessageId: string;
        title: string;
        content: string;
    }>;
    snapCount: number;
} | null {
    // Input compartments are already sorted by startMessage (DB order). Binary search to find
    // the compartment whose range [start, end] contains a given ordinal.
    const sorted = [...inputCompartments].sort((a, b) => a.startMessage - b.startMessage);
    const containing = (ord: number): Compartment | null => {
        let lo = 0;
        let hi = sorted.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const c = sorted[mid];
            if (!c) return null;
            if (ord < c.startMessage) hi = mid - 1;
            else if (ord > c.endMessage) lo = mid + 1;
            else return c;
        }
        return null;
    };

    const result: Array<{
        startMessage: number;
        endMessage: number;
        startMessageId: string;
        endMessageId: string;
        title: string;
        content: string;
    }> = [];
    let snapCount = 0;

    for (const pc of llmOutput) {
        const startOwner = containing(pc.startMessage);
        const endOwner = containing(pc.endMessage);
        if (!startOwner || !endOwner) {
            // LLM invented an ordinal outside the input range — can't recover.
            return null;
        }
        if (startOwner.startMessage !== pc.startMessage) snapCount++;
        if (endOwner.endMessage !== pc.endMessage) snapCount++;
        result.push({
            startMessage: startOwner.startMessage,
            endMessage: endOwner.endMessage,
            startMessageId: startOwner.startMessageId,
            endMessageId: endOwner.endMessageId,
            title: pc.title,
            content: pc.content,
        });
    }

    return { result, snapCount };
}

// ---------------------------------------------------------------------------
// Persistence.
// ---------------------------------------------------------------------------

interface FinalizeArgs {
    db: Database;
    sessionId: string;
    compartments: Compartment[];
    leadingCount: number;
    trailingIndex: number;
    selectedCompartments: Compartment[];
    compressed: Array<{
        startMessage: number;
        endMessage: number;
        startMessageId: string;
        endMessageId: string;
        title: string;
        content: string;
    }>;
    originalStart: number;
    originalEnd: number;
    facts: Array<{ category: string; content: string }>;
    logLabel: string;
}

function finalizeCompression(args: FinalizeArgs): boolean {
    const {
        db,
        sessionId,
        compartments,
        leadingCount,
        trailingIndex,
        selectedCompartments: _selectedCompartments,
        compressed,
        originalStart,
        originalEnd,
        facts,
        logLabel,
    } = args;

    const compressedStart = compressed[0].startMessage;
    const compressedEnd = compressed[compressed.length - 1].endMessage;

    if (compressedStart !== originalStart || compressedEnd !== originalEnd) {
        sessionLog(
            sessionId,
            `compressor: compressed range ${compressedStart}-${compressedEnd} doesn't match original ${originalStart}-${originalEnd}, aborting`,
        );
        return false;
    }

    // Validate internal contiguity
    for (let i = 1; i < compressed.length; i++) {
        const prev = compressed[i - 1];
        const curr = compressed[i];
        if (curr.startMessage <= prev.endMessage) {
            sessionLog(sessionId, `compressor: overlap at compartment ${i}, aborting`);
            return false;
        }
        if (curr.startMessage > prev.endMessage + 1) {
            sessionLog(sessionId, `compressor: gap at compartment ${i}, aborting`);
            return false;
        }
    }

    const leading = compartments.slice(0, leadingCount);
    const trailing = compartments.slice(trailingIndex);

    const allCompartments = [
        ...leading.map((c, i) => ({
            sequence: i,
            startMessage: c.startMessage,
            endMessage: c.endMessage,
            startMessageId: c.startMessageId,
            endMessageId: c.endMessageId,
            title: c.title,
            content: c.content,
        })),
        ...compressed.map((c, i) => ({
            sequence: leading.length + i,
            startMessage: c.startMessage,
            endMessage: c.endMessage,
            startMessageId: c.startMessageId,
            endMessageId: c.endMessageId,
            title: c.title,
            content: c.content,
        })),
        ...trailing.map((c, i) => ({
            sequence: leading.length + compressed.length + i,
            startMessage: c.startMessage,
            endMessage: c.endMessage,
            startMessageId: c.startMessageId,
            endMessageId: c.endMessageId,
            title: c.title,
            content: c.content,
        })),
    ];

    replaceAllCompartmentState(
        db,
        sessionId,
        allCompartments,
        facts.map((f) => ({ category: f.category, content: f.content })),
    );
    // Do NOT call clearInjectionCache here. See runCompressionPassIfNeeded call
    // sites — background compressor must not bust cache. Next cache-busting
    // pass (isCacheBusting=true) picks up the new state from DB.
    incrementCompressionDepth(db, sessionId, originalStart, originalEnd);

    sessionLog(sessionId, `compressor: completed ${logLabel}`);
    return true;
}

// ---------------------------------------------------------------------------
// LLM compressor pass.
// ---------------------------------------------------------------------------

interface CompressorPassArgs {
    client: PluginContext["client"];
    sessionId: string;
    directory: string;
    compartments: Compartment[];
    currentTokens: number;
    targetTokens: number;
    /** Target output compartment count (passed to prompt to guide LLM). */
    outputCount: number;
    outputDepth: number;
    historianTimeoutMs?: number;
}

async function runCompressorPass(args: CompressorPassArgs): Promise<Array<{
    startMessage: number;
    endMessage: number;
    startMessageId: string;
    endMessageId: string;
    title: string;
    content: string;
}> | null> {
    const {
        client,
        sessionId,
        directory,
        compartments,
        currentTokens,
        targetTokens,
        outputCount,
        outputDepth,
        historianTimeoutMs,
    } = args;

    const prompt = buildCompressorPrompt(
        compartments,
        currentTokens,
        targetTokens,
        outputDepth,
        outputCount,
    );

    let agentSessionId: string | null = null;
    try {
        const createResponse = await client.session.create({
            body: { parentID: sessionId, title: "magic-context-compressor" },
            query: { directory },
        });

        const createdSession = normalizeSDKResponse(
            createResponse,
            null as { id?: string } | null,
            { preferResponseOnMissingData: true },
        );
        agentSessionId = typeof createdSession?.id === "string" ? createdSession.id : null;

        if (!agentSessionId) {
            sessionLog(sessionId, "compressor: could not create child session");
            return null;
        }

        await promptSyncWithModelSuggestionRetry(
            client,
            {
                path: { id: agentSessionId },
                query: { directory },
                body: {
                    agent: HISTORIAN_AGENT,
                    parts: [{ type: "text", text: prompt }],
                },
            },
            { timeoutMs: historianTimeoutMs ?? DEFAULT_HISTORIAN_TIMEOUT_MS },
        );

        const messagesResponse = await client.session.messages({
            path: { id: agentSessionId },
            query: { directory },
        });
        const messages = normalizeSDKResponse(messagesResponse, [] as unknown[], {
            preferResponseOnMissingData: true,
        });
        const result = extractLatestAssistantText(messages);
        if (!result) {
            sessionLog(sessionId, "compressor: historian returned no output");
            return null;
        }

        const parsed = parseCompartmentOutput(result);
        if (parsed.compartments.length === 0) {
            sessionLog(sessionId, "compressor: historian returned no compartments");
            return null;
        }

        // Snap LLM's ordinal boundaries to the enclosing input compartment boundaries.
        // LLMs drift by ±1-2 ordinals when merging; rejecting on exact-match is too strict.
        // Interpret LLM output as "I merged these compartments together" and snap the
        // reported start/end ordinals to the boundaries of whichever input compartment
        // contains them. Contiguity/coverage validation still runs after the snap.
        const snapped = snapLLMOutputToInputBoundaries(parsed.compartments, compartments);
        if (!snapped) {
            sessionLog(
                sessionId,
                "compressor: rejecting — LLM output contains ordinal(s) outside input range",
            );
            return null;
        }
        if (snapped.snapCount > 0) {
            sessionLog(
                sessionId,
                `compressor: snapped ${snapped.snapCount} LLM boundary value(s) to input compartment boundaries`,
            );
        }
        return snapped.result;
    } catch (error: unknown) {
        sessionLog(sessionId, "compressor: historian call failed:", getErrorMessage(error));
        return null;
    } finally {
        if (agentSessionId) {
            await client.session
                .delete({ path: { id: agentSessionId }, query: { directory } })
                .catch((e: unknown) => {
                    sessionLog(
                        sessionId,
                        "compressor: session cleanup failed:",
                        getErrorMessage(e),
                    );
                });
        }
    }
}
