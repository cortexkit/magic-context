import { DEFAULT_COMPARTMENT_TOKEN_BUDGET } from "../../config/schema/magic-context";
import { buildMemoryInjectionBlock } from "../../features/magic-context/memory";
import { resolveProjectIdentity } from "../../features/magic-context/memory/project-identity";
import type { Scheduler } from "../../features/magic-context/scheduler";
import {
    type ContextDatabase,
    getOrCreateSessionMeta,
    getTagsBySession,
    type getTopNBySize,
} from "../../features/magic-context/storage";
import type { Tagger } from "../../features/magic-context/tagger";
import type { ContextUsage, TagEntry } from "../../features/magic-context/types";
import type { PluginContext } from "../../plugin/types";
import { log } from "../../shared/logger";
import { FORCE_MATERIALIZE_PERCENTAGE } from "./compartment-trigger";
import {
    type PreparedCompartmentInjection,
    prepareCompartmentInjection,
} from "./inject-compartments";
import type { NudgePlacementStore } from "./nudge-placement-store";
import type { ContextNudge } from "./nudger";
import { stripClearedReasoning } from "./strip-content";
import { runCompartmentPhase } from "./transform-compartment-phase";
import { loadContextUsage, resolveSchedulerDecision } from "./transform-context-state";
import { findLastUserMessageId, findSessionId } from "./transform-message-helpers";
import {
    applyFlushedStatuses,
    type MessageLike,
    stripStructuralNoise,
    tagMessages,
} from "./transform-operations";
import { runPostTransformPhase } from "./transform-postprocess-phase";
import { logTransformTiming } from "./transform-stage-logger";

export { createNudgePlacementStore, type NudgePlacementStore } from "./nudge-placement-store";

export interface TransformDeps {
    tagger: Tagger;
    scheduler: Scheduler;
    contextUsageMap: Map<string, { usage: ContextUsage; updatedAt: number }>;
    nudger: (
        sessionId: string,
        contextUsage: ContextUsage,
        db: ContextDatabase,
        topNFn: typeof getTopNBySize,
        preloadedTags?: TagEntry[],
        messagesSinceLastUser?: number,
        preloadedSessionMeta?: import("../../features/magic-context/types").SessionMeta,
    ) => ContextNudge | null;
    db: ContextDatabase;
    nudgePlacements: NudgePlacementStore;
    protectedTags: number;
    autoDropToolAge: number;
    clearReasoningAge: number;
    flushedSessions: Set<string>;
    lastHeuristicsTurnId: Map<string, string>;
    client?: PluginContext["client"];
    directory?: string;
    memoryConfig?: {
        enabled: boolean;
        injectionBudgetTokens: number;
    };
    compartmentTokenBudget?: number;
    historianTimeoutMs?: number;
    getNotificationParams?: (
        sessionId: string,
    ) => import("./send-session-notification").NotificationParams;
}

function findFirstTextPart(parts: unknown[]): { type: string; text: string } | null {
    for (const part of parts) {
        if (part === null || typeof part !== "object") continue;
        const candidate = part as Record<string, unknown>;
        if (candidate.type === "text" && typeof candidate.text === "string") {
            return candidate as { type: string; text: string };
        }
    }

    return null;
}

function isDroppedPlaceholder(text: string): boolean {
    return /^\[dropped §\d+§\]$/.test(text.trim());
}

function renderMemoryInjection(sessionId: string, messages: MessageLike[], block: string): void {
    const firstMessage = messages[0];
    const textPart = firstMessage ? findFirstTextPart(firstMessage.parts) : null;

    if (!firstMessage || !textPart || isDroppedPlaceholder(textPart.text)) {
        messages.unshift({
            info: { role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: block }],
        });
        return;
    }

    textPart.text = `${block}\n\n${textPart.text}`;
}

export function createTransform(deps: TransformDeps) {
    return async (
        _input: Record<string, never>,
        output: { messages: unknown[] },
    ): Promise<void> => {
        const startTime = performance.now();
        const messages = output.messages as MessageLike[];
        const sessionId = findSessionId(messages);
        if (!sessionId) {
            return;
        }
        const resolvedSessionId = sessionId;

        const db = deps.db;
        const currentTurnId = findLastUserMessageId(messages);

        let sessionMeta: import("../../features/magic-context/types").SessionMeta | undefined;
        try {
            // Intentional fail-open: magic-context should not block live chat if session state read fails.
            sessionMeta = getOrCreateSessionMeta(db, sessionId);
        } catch (error) {
            log("[magic-context] transform failed reading session meta:", error);
            return;
        }

        // System prompt change detection is handled in experimental.chat.system.transform
        // (see system-prompt-hash.ts), not here. The messages transform only receives
        // user/assistant messages, not the system prompt.

        const reducedMode = sessionMeta.isSubagent;
        const fullFeatureMode = !reducedMode;
        const compartmentDirectory = deps.directory ?? "";
        const canRunCompartments =
            fullFeatureMode && deps.client !== undefined && compartmentDirectory.length > 0;

        if (fullFeatureMode && deps.memoryConfig?.enabled && sessionMeta.counter === 0) {
            const injectionBlock = buildMemoryInjectionBlock(
                db,
                resolveProjectIdentity(deps.directory ?? process.cwd()),
                deps.memoryConfig.injectionBudgetTokens,
            );
            if (injectionBlock) {
                renderMemoryInjection(sessionId, messages, injectionBlock);
                log(
                    `[magic-context] injected project-memory block (${injectionBlock.length} chars)`,
                );
            }
        }

        let pendingCompartmentInjection: PreparedCompartmentInjection | null = null;
        if (fullFeatureMode) {
            pendingCompartmentInjection = prepareCompartmentInjection(db, sessionId, messages);
        }

        let targets = new Map<number, { setContent: (content: string) => boolean }>();
        // ──────────────────────────────────────────────────────────────────────

        let reasoningByMessage = new Map<
            MessageLike,
            { type: string; thinking?: string; text?: string }[]
        >();
        let messageTagNumbers = new Map<MessageLike, number>();
        let batch: { finalize: () => void } | null = null;
        try {
            const t0 = performance.now();
            deps.tagger.initFromDb(sessionId, db);
            const result = tagMessages(sessionId, messages, deps.tagger, db);
            targets = result.targets;
            reasoningByMessage = result.reasoningByMessage;
            messageTagNumbers = result.messageTagNumbers;
            batch = result.batch;
            logTransformTiming(sessionId, "tagMessages", t0);
        } catch (error) {
            log(
                "[magic-context] transform tag persistence failed; continuing without tagging:",
                error,
            );
        }

        const t1 = performance.now();
        const tags = getTagsBySession(db, sessionId);
        logTransformTiming(sessionId, "getTagsBySession", t1, `count=${tags.length}`);

        let didMutateFromFlushedStatuses = false;
        try {
            const t2 = performance.now();
            didMutateFromFlushedStatuses = applyFlushedStatuses(sessionId, db, targets, tags);
            logTransformTiming(sessionId, "applyFlushedStatuses", t2);
            batch?.finalize();
            logTransformTiming(sessionId, "batchFinalize:flushed", t2);
        } catch (error) {
            log("[magic-context] transform failed applying flushed statuses:", error);
            deps.nudgePlacements.clear(sessionId);
        }
        if (didMutateFromFlushedStatuses) {
            deps.nudgePlacements.clear(sessionId);
        }

        const t3 = performance.now();
        const strippedStructuralNoise = stripStructuralNoise(messages);
        logTransformTiming(
            sessionId,
            "stripStructuralNoise",
            t3,
            `strippedParts=${strippedStructuralNoise}`,
        );

        const t4 = performance.now();
        const strippedClearedReasoning = stripClearedReasoning(messages);
        logTransformTiming(
            sessionId,
            "stripClearedReasoning",
            t4,
            `strippedParts=${strippedClearedReasoning}`,
        );

        let watermark = 0;
        for (const tag of tags) {
            if (tag.status === "dropped" && tag.tagNumber > watermark) {
                watermark = tag.tagNumber;
            }
        }

        const contextUsage = loadContextUsage(deps.contextUsageMap, db, sessionId);
        const schedulerDecision = resolveSchedulerDecision(
            deps.scheduler,
            sessionMeta,
            contextUsage,
            sessionId,
        );
        const compartmentPhase = await runCompartmentPhase({
            canRunCompartments,
            fullFeatureMode,
            sessionMeta,
            contextUsage,
            client: deps.client,
            db,
            sessionId,
            resolvedSessionId,
            compartmentTokenBudget: deps.compartmentTokenBudget ?? DEFAULT_COMPARTMENT_TOKEN_BUDGET,
            historianTimeoutMs: deps.historianTimeoutMs,
            compartmentDirectory,
            messages,
            pendingCompartmentInjection,
            getNotificationParams: deps.getNotificationParams
                ? () => deps.getNotificationParams!(sessionId)
                : undefined,
        });
        pendingCompartmentInjection = compartmentPhase.pendingCompartmentInjection;
        const awaitedCompartmentRun = compartmentPhase.awaitedCompartmentRun;
        const compartmentInProgress = compartmentPhase.compartmentInProgress;
        sessionMeta = { ...sessionMeta, compartmentInProgress };

        runPostTransformPhase({
            sessionId,
            db,
            messages,
            tags,
            targets,
            reasoningByMessage,
            messageTagNumbers,
            batch,
            contextUsage,
            schedulerDecision,
            fullFeatureMode,
            canRunCompartments,
            awaitedCompartmentRun,
            compartmentInProgress,
            sessionMeta,
            currentTurnId,
            flushedSessions: deps.flushedSessions,
            lastHeuristicsTurnId: deps.lastHeuristicsTurnId,
            autoDropToolAge: deps.autoDropToolAge,
            clearReasoningAge: deps.clearReasoningAge,
            protectedTags: deps.protectedTags,
            nudgePlacements: deps.nudgePlacements,
            nudger: deps.nudger,
            pendingCompartmentInjection,
            didMutateFromFlushedStatuses,
            watermark,
            forceMaterializationPercentage: FORCE_MATERIALIZE_PERCENTAGE,
        });

        const elapsed = (performance.now() - startTime).toFixed(1);
        log(
            `[magic-context] transform completed in ${elapsed}ms (${messages.length} messages, ${targets.size} targets, watermark: ${watermark})`,
        );
    };
}
