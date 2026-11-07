import {
    type ContextDatabase,
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import type { TransformDeps } from "../../hooks/magic-context/transform";
import { sessionLog } from "../../shared/logger";
import {
    isSuccessfulProviderCompletion,
    providerResponseFailed,
} from "../../shared/provider-response-completion";
import { type UsageReading, usageReadingMatchesDraft } from "./usage-reading";

export interface PersistV2UsageReadingArgs {
    db: ContextDatabase;
    sessionID: string;
    draftModel: { providerID: string; id: string };
    reading: UsageReading;
    contextUsageMap: TransformDeps["contextUsageMap"];
}

/**
 * Record the usage OpenCode stored for the latest completed reply.
 *
 * The reading is the prompt size of a request the provider accepted, so it is
 * real pressure at any size. It is never compared with the configured window:
 * that window can be smaller than what the model actually serves, and a reading
 * past it is real overflow of the user's limit for the scheduler to handle.
 *
 * A reading never refuses the next request by itself. However high it is, the
 * next transform pass has to run, because that pass is the only thing that can
 * shrink the session (the force band's queued drops and emergency reclaim, the
 * historian, a fold). Refusing on the reading would leave it unchanged and
 * refuse again on every later turn. The transform refuses only after its own
 * pass, and only when the provider has rejected the request as too large and
 * that pass folded nothing, the same rule OpenCode 1 and Pi follow.
 */
export function persistV2UsageReading(args: PersistV2UsageReadingArgs): void {
    const { db, sessionID, draftModel, reading } = args;
    const currentMeta = getOrCreateSessionMeta(db, sessionID);
    // Persist a reading only when it is newer than what is already recorded.
    // A context pass runs on every turn and on recovery passes following provider
    // rejection; resolving the latest assistant message from the store gives the
    // previous accepted reply, which must not overwrite newer rejection-derived
    // pressure (or re-persist the exact same reading).
    if (
        reading.completed !== undefined &&
        currentMeta.lastResponseTime > 0 &&
        reading.completed <= currentMeta.lastResponseTime
    ) {
        sessionLog(
            sessionID,
            `v2 usage: skipped stale reading completed=${reading.completed} <= lastResponseTime=${currentMeta.lastResponseTime}`,
        );
        return;
    }

    const draftModelKey = `${draftModel.providerID}/${draftModel.id}`;
    const readingMatchesDraft = usageReadingMatchesDraft(reading, draftModel);
    // A non-failed completion refreshes the provider cache even without usage.
    // Preserve the last real pressure reading instead of fabricating zero usage.
    const completion = {
        completedAt: reading.completed,
        finish: reading.finish,
        error: reading.error,
    };
    const served =
        !providerResponseFailed(completion) &&
        (reading.inputTokens > 0 || isSuccessfulProviderCompletion(completion));
    const responseTime = served && reading.completed;
    if (reading.inputTokens <= 0 || !Number.isFinite(reading.limit) || reading.limit <= 0) {
        if (responseTime) updateSessionMeta(db, sessionID, { lastResponseTime: responseTime });
        return;
    }
    const percentage = (reading.inputTokens / reading.limit) * 100;
    const updates: Parameters<typeof updateSessionMeta>[2] = {
        lastContextPercentage: percentage,
        lastInputTokens: reading.inputTokens,
        lastUsageContextLimit: reading.limit,
        lastObservedModelKey: reading.modelKey ?? draftModelKey,
    };
    if (responseTime) updates.lastResponseTime = responseTime;
    updateSessionMeta(db, sessionID, updates);
    sessionLog(
        sessionID,
        `v2 usage: inputTokens=${reading.inputTokens} contextLimit=${reading.limit} percentage=${percentage} responseModel=${reading.modelKey ?? "legacy"} draftContextLimit=${reading.admissionLimit} pressure=${readingMatchesDraft ? "current" : "stale-model-ignored"}`,
    );
    if (readingMatchesDraft) {
        args.contextUsageMap.set(sessionID, {
            usage: { inputTokens: reading.inputTokens, percentage },
            hasUsageTokens: true,
            // The reply can be loaded after a later history publication. Date
            // its usage by completion, not this pass's delayed read from the store.
            updatedAt: reading.completed || Date.now(),
        });
    } else {
        args.contextUsageMap.delete(sessionID);
    }
}
