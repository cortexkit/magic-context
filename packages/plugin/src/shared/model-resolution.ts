export type ModelHarness = "opencode" | "pi";

export interface ResolvedModelEntry {
    /** Canonical provider/model reference used for identity and model selection. */
    model: string;
    /** OpenCode variant or Pi thinking level, selected for the active entry only. */
    qualifier?: string;
}

export type ModelInput = string | ResolvedModelEntry;

type ConfigRecord = Record<string, unknown>;

function asRecord(value: unknown): ConfigRecord | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as ConfigRecord)
        : undefined;
}

function readString(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function hasOwn(record: ConfigRecord, key: string): boolean {
    return Object.hasOwn(record, key);
}

/**
 * Collapses the string and object spellings of a harness model entry into the
 * same model identity. Qualifiers stay separate because they alter an attempt,
 * not the configured model identity.
 */
export function normalizeModelEntry(
    entry: unknown,
    harness: ModelHarness,
): ResolvedModelEntry | undefined {
    if (typeof entry === "string") {
        const model = readString(entry);
        return model ? { model } : undefined;
    }

    const objectEntry = asRecord(entry);
    if (!objectEntry) return undefined;
    const model = readString(objectEntry.model);
    if (!model) return undefined;

    const qualifier = readString(
        objectEntry[harness === "opencode" ? "variant" : "thinking_level"],
    );
    return qualifier ? { model, qualifier } : { model };
}

function isValidModelReference(entry: ResolvedModelEntry): boolean {
    const slash = entry.model.indexOf("/");
    return slash > 0 && slash < entry.model.length - 1;
}

function sameAttempt(a: ResolvedModelEntry, b: ResolvedModelEntry): boolean {
    return a.model === b.model && a.qualifier === b.qualifier;
}

/**
 * Resolves a configured fallback list in declaration order. Attempts are
 * deduplicated by model plus qualifier: the same model with distinct
 * qualifiers remains two intentional attempts.
 */
export function resolveFallbackEntries(
    value: unknown,
    harness: ModelHarness,
): ResolvedModelEntry[] {
    const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
    const resolved: ResolvedModelEntry[] = [];
    for (const value of values) {
        const entry = normalizeModelEntry(value, harness);
        if (!entry || !isValidModelReference(entry)) continue;
        if (resolved.some((candidate) => sameAttempt(candidate, entry))) continue;
        resolved.push(entry);
    }
    return resolved;
}

function resolvePrimaryEntry(args: {
    entry: unknown;
    defaultQualifier: unknown;
    harness: ModelHarness;
}): ResolvedModelEntry | undefined {
    const entry = normalizeModelEntry(args.entry, args.harness);
    if (!entry) return undefined;
    const qualifier = entry.qualifier ?? readString(args.defaultQualifier);
    return qualifier ? { ...entry, qualifier } : entry;
}

export interface ResolvedHistorianModel {
    primary?: ResolvedModelEntry;
    fallbacks: ResolvedModelEntry[];
}

/**
 * Resolve historian model attempts from exactly one harness block. Flat keys
 * and the other harness are deliberately never consulted after cutover.
 */
export function resolveHistorianModel(
    config: unknown,
    harness: ModelHarness,
): ResolvedHistorianModel {
    const historian = asRecord(asRecord(config)?.historian);
    const block = asRecord(historian?.[harness]);
    if (!block) return { fallbacks: [] };

    return {
        primary: resolvePrimaryEntry({
            entry: block.model,
            defaultQualifier: block[harness === "opencode" ? "variant" : "thinking_level"],
            harness,
        }),
        fallbacks: resolveFallbackEntries(block.fallback_models, harness),
    };
}

export interface ResolvedDreamerTaskModel {
    primary?: ResolvedModelEntry;
    fallbacks: ResolvedModelEntry[];
    schedule?: string;
    timeoutMinutes?: number;
    promotionThreshold?: number;
}

/**
 * Resolve a dreamer task from one harness subtree. Model selection is task →
 * harness default, except compress-cues inserts its harness-independent mural
 * string between those two rungs. Scheduling remains at dreamer.tasks.<task>.
 */
export function resolveDreamerTaskModel(args: {
    config: unknown;
    harness: ModelHarness;
    task: string;
    muralModel?: unknown;
}): ResolvedDreamerTaskModel {
    const dreamer = asRecord(asRecord(args.config)?.dreamer);
    const harnessBlock = asRecord(dreamer?.[args.harness]);
    const taskBlock = asRecord(asRecord(harnessBlock?.tasks)?.[args.task]);
    const schedulingTask = asRecord(asRecord(dreamer?.tasks)?.[args.task]);
    if (!harnessBlock) {
        return {
            fallbacks: [],
            schedule: readString(schedulingTask?.schedule),
            timeoutMinutes:
                typeof taskBlock?.timeout_minutes === "number"
                    ? taskBlock.timeout_minutes
                    : undefined,
            promotionThreshold:
                typeof schedulingTask?.promotion_threshold === "number"
                    ? schedulingTask.promotion_threshold
                    : undefined,
        };
    }

    const taskQualifier = taskBlock?.[args.harness === "opencode" ? "variant" : "thinking_level"];
    // A mural string borrows the harness default's qualifier whether that
    // qualifier is written beside `model` or inside the default entry object.
    const harnessQualifier =
        harnessBlock[args.harness === "opencode" ? "variant" : "thinking_level"] ??
        normalizeModelEntry(harnessBlock.model, args.harness)?.qualifier;
    const taskHasModel = taskBlock !== undefined && hasOwn(taskBlock, "model");
    const usesMuralModel =
        !taskHasModel && args.task === "compress-cues" && Boolean(readString(args.muralModel));
    const primarySource = taskHasModel
        ? taskBlock?.model
        : usesMuralModel
          ? args.muralModel
          : harnessBlock.model;
    const fallbackSource =
        taskBlock !== undefined && hasOwn(taskBlock, "fallback_models")
            ? taskBlock.fallback_models
            : harnessBlock.fallback_models;

    return {
        primary: resolvePrimaryEntry({
            entry: primarySource,
            // mural.model is a plain string, so its qualifier is always the
            // executing harness default rather than a task-local default.
            defaultQualifier: usesMuralModel
                ? harnessQualifier
                : (taskQualifier ?? harnessQualifier),
            harness: args.harness,
        }),
        fallbacks: resolveFallbackEntries(fallbackSource, args.harness),
        schedule: readString(schedulingTask?.schedule),
        timeoutMinutes:
            typeof taskBlock?.timeout_minutes === "number" ? taskBlock.timeout_minutes : undefined,
        promotionThreshold:
            typeof schedulingTask?.promotion_threshold === "number"
                ? schedulingTask.promotion_threshold
                : undefined,
    };
}

/**
 * Keep non-model agent settings at their original level while replacing only
 * OpenCode's model-resolution fields with the executing harness's primary.
 */
export function resolveOpenCodeAgentOverrides(agent: unknown): Record<string, unknown> {
    const source = asRecord(agent);
    if (!source) return {};
    const {
        model: _model,
        fallback_models: _fallbackModels,
        variant: _variant,
        thinking_level: _thinking,
        opencode,
        pi,
        tasks,
        ...rest
    } = source;
    const primary = resolvePrimaryEntry({
        entry: asRecord(opencode)?.model,
        defaultQualifier: asRecord(opencode)?.variant,
        harness: "opencode",
    });
    return {
        ...rest,
        ...(primary ? { model: primary.model } : {}),
        ...(primary?.qualifier ? { variant: primary.qualifier } : {}),
    };
}

export function resolveHistorianAgentOverrides(agent: unknown): Record<string, unknown> {
    return {
        temperature: 0.1,
        maxTokens: 32_000,
        ...resolveOpenCodeAgentOverrides(agent),
    };
}
