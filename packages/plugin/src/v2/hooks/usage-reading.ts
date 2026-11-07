import {
    hasServerFallbackUsage,
    isSuccessfulProviderCompletion,
} from "../../shared/provider-response-completion";

export interface UsageReadingInput {
    rowModel?: { providerID?: unknown; id?: unknown };
    draftModel: { providerID: string; id: string };
    tokens?: {
        input?: number;
        output?: number;
        cache?: { read?: number; write?: number };
    };
    completed?: number;
    finish?: string;
    error?: unknown;
    content?: unknown;
    /** Resolve the output-reserved usable window for a model. */
    limitFor: (providerID: string, modelID: string) => number;
}

export interface UsageReading {
    inputTokens: number;
    /** Window of the model that produced the persisted reading. */
    limit: number;
    /** Window the outgoing draft will use for admission. */
    admissionLimit: number;
    /** Absent when a legacy row carries no model metadata. */
    modelKey?: string;
    serverFallback?: boolean;
    completed?: number;
    finish?: string;
    error?: unknown;
}

export function usageReadingMatchesDraft(
    reading: UsageReading,
    draftModel: { providerID: string; id: string },
): boolean {
    return (
        reading.modelKey === undefined ||
        reading.modelKey === `${draftModel.providerID}/${draftModel.id}`
    );
}

/**
 * Attribute stored usage to the model that produced it while measuring the next
 * request against the outgoing draft model. Partial or non-finite token fields
 * contribute zero rather than poisoning persisted percentages.
 */
export function resolveUsageReading(input: UsageReadingInput): UsageReading | undefined {
    const { tokens } = input;
    const successfulCompletion = isSuccessfulProviderCompletion({
        completedAt: input.completed,
        finish: input.finish,
        error: input.error,
    });
    if (!tokens && !successfulCompletion) return undefined;
    const numeric = (value: unknown): number =>
        typeof value === "number" && Number.isFinite(value) ? value : 0;
    const rowProviderID =
        typeof input.rowModel?.providerID === "string" ? input.rowModel.providerID : undefined;
    const rowModelID = typeof input.rowModel?.id === "string" ? input.rowModel.id : undefined;
    const measuredProviderID = rowProviderID ?? input.draftModel.providerID;
    const measuredModelID = rowModelID ?? input.draftModel.id;
    const inputTokens =
        numeric(tokens?.input) + numeric(tokens?.cache?.read) + numeric(tokens?.cache?.write);
    const limit = input.limitFor(measuredProviderID, measuredModelID);
    if ((!Number.isFinite(limit) || limit <= 0) && !successfulCompletion) return undefined;
    const sameModel =
        measuredProviderID === input.draftModel.providerID &&
        measuredModelID === input.draftModel.id;
    const draftLimit = sameModel
        ? limit
        : input.limitFor(input.draftModel.providerID, input.draftModel.id);
    return {
        inputTokens,
        limit,
        admissionLimit: Number.isFinite(draftLimit) && draftLimit > 0 ? draftLimit : limit,
        ...(rowProviderID !== undefined && rowModelID !== undefined
            ? { modelKey: `${measuredProviderID}/${measuredModelID}` }
            : {}),
        ...(typeof input.completed === "number" && Number.isFinite(input.completed)
            ? { completed: input.completed }
            : {}),
        ...(input.finish !== undefined ? { finish: input.finish } : {}),
        ...(input.error !== undefined ? { error: input.error } : {}),
        ...(hasServerFallbackUsage(input.content) ? { serverFallback: true } : {}),
    };
}
