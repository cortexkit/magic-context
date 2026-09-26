import { type ContextDatabase, updateSessionMeta } from "../../features/magic-context/storage";
import type { TransformDeps } from "../../hooks/magic-context/transform";
import { sessionLog } from "../../shared/logger";
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
    const draftModelKey = `${draftModel.providerID}/${draftModel.id}`;
    const readingMatchesDraft = usageReadingMatchesDraft(reading, draftModel);
    // last_response_time is the idle clock for the provider cache. A reply with
    // no tokens (a request the provider refused) refreshed no cache, so it does
    // not move the clock; the same rule OpenCode 1 and Pi apply.
    if (reading.completed !== undefined && reading.inputTokens > 0)
        updateSessionMeta(db, sessionID, { lastResponseTime: reading.completed });
    const percentage = (reading.inputTokens / reading.limit) * 100;
    updateSessionMeta(db, sessionID, {
        lastContextPercentage: percentage,
        lastInputTokens: reading.inputTokens,
        lastUsageContextLimit: reading.limit,
        lastObservedModelKey: reading.modelKey ?? draftModelKey,
    });
    sessionLog(
        sessionID,
        `v2 usage: inputTokens=${reading.inputTokens} contextLimit=${reading.limit} percentage=${percentage} responseModel=${reading.modelKey ?? "legacy"} draftContextLimit=${reading.admissionLimit} pressure=${readingMatchesDraft ? "current" : "stale-model-ignored"}`,
    );
    if (readingMatchesDraft) {
        args.contextUsageMap.set(sessionID, {
            usage: { inputTokens: reading.inputTokens, percentage },
            hasUsageTokens: true,
            updatedAt: Date.now(),
        });
    } else {
        args.contextUsageMap.delete(sessionID);
    }
}
