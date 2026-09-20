/**
 * Turn the last assistant store row into a usage reading.
 *
 * The reading is attributed to the model that produced the response (the row's
 * own model), while the admission check — "will the next request fit?" — must
 * use the OUTGOING draft model's window: on a model switch, refusing on the old
 * model's ratio would loop forever because the refused turn never lets the
 * transform observe the switch.
 */
export interface UsageReadingInput {
    rowModel?: { providerID?: unknown; id?: unknown };
    draftModel: { providerID: string; id: string };
    tokens?: {
        input?: number;
        output?: number;
        cache?: { read?: number; write?: number };
    };
    completed?: number;
    /** Resolve the output-reserved usable window for a model. */
    limitFor: (providerID: string, modelID: string) => number;
}

export interface UsageReading {
    inputTokens: number;
    /** Window of the model that produced the reading (persisted attribution). */
    limit: number;
    /** Window the next request will hit (admission check denominator). */
    admissionLimit: number;
    /** Absent when the row carries no model metadata (legacy rows). */
    modelKey?: string;
    completed?: number;
}

export function resolveUsageReading(input: UsageReadingInput): UsageReading | undefined {
    const { tokens } = input;
    if (!tokens) return undefined;
    const numeric = (value: unknown): number =>
        typeof value === "number" && Number.isFinite(value) ? value : 0;
    const rowProviderID =
        typeof input.rowModel?.providerID === "string" ? input.rowModel.providerID : undefined;
    const rowModelID = typeof input.rowModel?.id === "string" ? input.rowModel.id : undefined;
    const measuredProviderID = rowProviderID ?? input.draftModel.providerID;
    const measuredModelID = rowModelID ?? input.draftModel.id;
    const inputTokens =
        numeric(tokens.input) + numeric(tokens.cache?.read) + numeric(tokens.cache?.write);
    const limit = input.limitFor(measuredProviderID, measuredModelID);
    if (!Number.isFinite(limit) || limit <= 0) return undefined;
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
    };
}
