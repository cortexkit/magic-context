import { sessionLog } from "./logger";
import type { ModelLimit } from "./models-dev-cache";

export const PROMPT_WALL_MARGIN = 4_096;
export const PI_OUTPUT_FLOOR = 4_096;
export const OPENCODE_OUTPUT_CAP = 32_000;

/**
 * Smallest context window any served model can plausibly have. Reported or
 * inferred limits below this are placeholders (0, 1) or corrupt state, never a
 * real window, so every denominator check shares this one floor.
 */
export const MIN_PLAUSIBLE_CONTEXT_LIMIT = 1_024;
export const OUTPUT_RESERVE_CAP_RATIO = 0.25;

/** Catalog output ceilings are not requested output; reserve at most a quarter of a shared window. */
export function catalogOutputReserve(window: number, output: number | undefined): number {
    return Math.min(output ?? 0, Math.floor(window * OUTPUT_RESERVE_CAP_RATIO));
}

export type WindowGeometry = "shared_upfront" | "shared_truncating" | "separate";
export type WindowReserveSource = "output_catalog" | "output_config" | "wall_margin" | "none";
export type WindowLimitSource = "catalog" | "provider" | "detected";

export interface WindowDerivation {
    window: number;
    reserve: number;
    reserveSource: WindowReserveSource;
    geometry: WindowGeometry;
    windowSource: WindowLimitSource;
    absoluteWall: number;
    /** Accepted provider input used to raise the usable denominator above metadata. */
    provenInputTokens?: number;
    /**
     * The usable hard limit before a declared input limit lowered it, present
     * only when it did.
     */
    hardWithoutInputCap?: number;
}

export interface WindowGeometryResult {
    usableSoft: number;
    usableHard: number;
    geometry: WindowGeometry;
    derivation: WindowDerivation;
}

export interface DeriveWindowGeometryOptions {
    /** Live provider limits override potentially stale catalog metadata, field by field. */
    providerLimit?: ModelLimit;
    /** Resolved user override; higher precedence than catalog metadata and geometry defaults. */
    outputReserveOverride?: number;
    harness?: "opencode" | "pi";
    /** Detected overflow remains the final downward cap regardless of other sources. */
    contextCap?: number;
    log?: (message: string) => void;
}

const PROVIDER_GEOMETRY: Readonly<Record<string, WindowGeometry>> = {
    anthropic: "shared_truncating",
    xai: "shared_truncating",
    google: "separate",
    "google-antigravity": "separate",
};

const geometryClampLogSeen = new Set<string>();

function isFinitePositive(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Placeholder filtering is deliberately per output field, never a row-level rejection. */
export function placeholderFilteredOutput(
    output: number | undefined,
    context: number | undefined,
): number | undefined {
    if (!isFinitePositive(output)) return undefined;
    if (isFinitePositive(context) && output >= context) return undefined;
    return output;
}

function mergePositive(
    catalogValue: number | undefined,
    providerValue: number | undefined,
): number | undefined {
    return isFinitePositive(providerValue) ? providerValue : catalogValue;
}

function logGeometryClampOnce(key: string, message: string, log?: (message: string) => void): void {
    if (geometryClampLogSeen.has(key)) return;
    geometryClampLogSeen.add(key);
    (log ?? ((entry) => sessionLog("global", `window-geometry: ${entry}`)))(message);
}

export function clearWindowGeometryLogForTest(): void {
    geometryClampLogSeen.clear();
}

export function deriveWindowGeometry(
    providerID: string,
    modelID: string,
    catalogLimit: ModelLimit | undefined,
    options: DeriveWindowGeometryOptions = {},
): WindowGeometryResult | undefined {
    if (!catalogLimit && !options.providerLimit) return undefined;
    const providerLimit = options.providerLimit;
    const catalogContext = isFinitePositive(catalogLimit?.context)
        ? catalogLimit.context
        : undefined;
    const providerContext = isFinitePositive(providerLimit?.context)
        ? providerLimit.context
        : undefined;
    let softContext = mergePositive(catalogContext, providerContext);
    let hardContext = mergePositive(softContext, providerContext);
    const contextCap = isFinitePositive(options.contextCap) ? options.contextCap : undefined;
    const hasContextCap = contextCap !== undefined;
    if (contextCap !== undefined) {
        softContext = isFinitePositive(softContext)
            ? Math.min(softContext, contextCap)
            : contextCap;
        hardContext = isFinitePositive(hardContext)
            ? Math.min(hardContext, contextCap)
            : contextCap;
    }
    const input = mergePositive(
        isFinitePositive(catalogLimit?.input) ? catalogLimit.input : undefined,
        providerLimit?.input,
    );
    if (!isFinitePositive(softContext) && !isFinitePositive(input)) return undefined;

    const catalogOutput =
        options.providerLimit === undefined
            ? isFinitePositive(catalogLimit?.output)
                ? catalogLimit.output
                : undefined
            : placeholderFilteredOutput(catalogLimit?.output, softContext);
    const providerOutput = placeholderFilteredOutput(providerLimit?.output, softContext);
    const output = providerOutput ?? catalogOutput;
    const geometry = PROVIDER_GEOMETRY[providerID] ?? "shared_upfront";

    const preCarvedInput =
        isFinitePositive(input) && (!isFinitePositive(softContext) || input < softContext);
    const outputReserveOverride =
        typeof options.outputReserveOverride === "number" &&
        Number.isFinite(options.outputReserveOverride) &&
        options.outputReserveOverride >= 0
            ? options.outputReserveOverride
            : undefined;
    let derivationWindow = softContext ?? input;
    let usableSoft: number;
    let softReserve = 0;
    let reserveSource: WindowReserveSource = "none";
    if (outputReserveOverride !== undefined) {
        // An explicit user reserve owns the usable-window carve. When the
        // provider also publishes a smaller input cap, use that cap as the
        // window; treating the cap as final would silently ignore the config.
        const reserveWindow = preCarvedInput ? input : (softContext ?? input);
        if (!isFinitePositive(reserveWindow)) return undefined;
        derivationWindow = reserveWindow;
        softReserve = outputReserveOverride;
        reserveSource = "output_config";
        const floor = Math.max(MIN_PLAUSIBLE_CONTEXT_LIMIT, reserveWindow * 0.5);
        const flooredReserve = Math.min(softReserve, Math.max(0, reserveWindow - floor));
        if (flooredReserve < softReserve) {
            logGeometryClampOnce(
                `soft-floor|${providerID}/${modelID}|${softReserve}|${flooredReserve}`,
                `output reserve clamped by the half-window floor for ${providerID}/${modelID}: reserve ${softReserve} → ${flooredReserve}`,
                options.log,
            );
        }
        softReserve = flooredReserve;
        usableSoft = Math.floor(reserveWindow - softReserve);
    } else if (preCarvedInput) {
        usableSoft = input;
        if (isFinitePositive(softContext)) {
            softReserve = Math.max(0, softContext - input);
            reserveSource = "output_catalog";
        }
    } else if (isFinitePositive(softContext)) {
        if (geometry === "separate") {
            softReserve = 0;
            reserveSource = "none";
        } else {
            softReserve = output ?? 0;
            reserveSource = output === undefined ? "none" : "output_catalog";
            const cap = softContext * OUTPUT_RESERVE_CAP_RATIO;
            softReserve = Math.min(softReserve, cap);
        }
        const floor = Math.max(MIN_PLAUSIBLE_CONTEXT_LIMIT, softContext * 0.5);
        const flooredReserve = Math.min(softReserve, Math.max(0, softContext - floor));
        if (flooredReserve < softReserve) {
            // A reserve large enough to hit the half-window floor means the
            // catalog's context/output pair contradicts itself (93 live rows
            // publish output > context — fusiform's negative-window detector).
            // The floor keeps the window functional; the log keeps the
            // degradation visible instead of silently halving the window.
            logGeometryClampOnce(
                `soft-floor|${providerID}/${modelID}|${softReserve}|${flooredReserve}`,
                `output reserve clamped by the half-window floor for ${providerID}/${modelID}: reserve ${softReserve} → ${flooredReserve} (catalog context/output pair is contradictory)`,
                options.log,
            );
        }
        softReserve = flooredReserve;
        usableSoft = Math.floor(softContext - softReserve);
    } else {
        usableSoft = input as number;
    }

    const hardWindow = hardContext ?? softContext ?? input;
    if (!isFinitePositive(hardWindow)) return undefined;
    const windowSource: WindowLimitSource = hasContextCap
        ? "detected"
        : providerContext !== undefined
          ? "provider"
          : "catalog";
    let usableHard: number;
    if (geometry === "separate") {
        usableHard = hardWindow;
    } else if (geometry === "shared_truncating") {
        usableHard = hardWindow - PROMPT_WALL_MARGIN;
    } else if (options.harness === "pi" && providerID !== "openai-codex") {
        usableHard = hardWindow - PI_OUTPUT_FLOOR;
    } else if (options.harness === "pi") {
        usableHard = hardWindow - (output ?? OPENCODE_OUTPUT_CAP);
    } else {
        const requestedOutput = Math.min(output ?? OPENCODE_OUTPUT_CAP, OPENCODE_OUTPUT_CAP);
        usableHard = hardWindow - requestedOutput;
    }
    // A declared input limit is the largest prompt the provider accepts, however
    // much of the context window the output leaves free. Without this cap a model
    // whose input limit is 302,222 inside a 1,000,000-token context would put its
    // hard wall at 968,000, and the 95% lines that read it would sit past every
    // prompt the provider accepts. The wall it replaces is kept for the case where
    // an accepted request proves the declared limit wrong (applyProvenInputFloor).
    let hardWithoutInputCap: number | undefined;
    if (isFinitePositive(input) && input < usableHard) {
        hardWithoutInputCap = Math.max(MIN_PLAUSIBLE_CONTEXT_LIMIT, Math.floor(usableHard));
        usableHard = input;
    }
    usableHard = Math.max(MIN_PLAUSIBLE_CONTEXT_LIMIT, Math.floor(usableHard));
    if (usableHard < usableSoft) {
        logGeometryClampOnce(
            `${providerID}/${modelID}|${usableSoft}|${usableHard}`,
            `usable hard limit clamped for ${providerID}/${modelID}: ${usableHard} → ${usableSoft} (window limit inversion)`,
            options.log,
        );
        usableHard = usableSoft;
    }

    const resolvedWindow = derivationWindow ?? usableSoft;
    return {
        usableSoft,
        usableHard,
        geometry,
        derivation: {
            window: Math.floor(resolvedWindow),
            reserve: Math.floor(Math.max(0, resolvedWindow - usableSoft)),
            reserveSource,
            geometry,
            windowSource,
            absoluteWall: Math.floor(hardWindow),
            ...(hardWithoutInputCap !== undefined ? { hardWithoutInputCap } : {}),
        },
    };
}

export interface ProvenInputFloorResult {
    geometry: WindowGeometryResult;
    refused?: { reading: number; absoluteWall: number };
}

export function hasTrustedAbsoluteWall(geometry: WindowGeometryResult): boolean {
    return geometry.derivation.windowSource !== "catalog";
}

/**
 * Successful requests can disprove static catalog metadata, but do not widen a
 * provider or observed-overflow wall here. A provider wall is the configured
 * limit: a reading beyond it is real pressure against that limit (the usage
 * handlers count it in full), not proof that the geometry should grow. An
 * observed-overflow wall that a larger accepted request disproves is cleared by
 * the usage handlers instead.
 */
export function applyProvenInputFloor(
    geometry: WindowGeometryResult,
    provenInputTokens: number | undefined,
): ProvenInputFloorResult {
    if (
        !isFinitePositive(provenInputTokens) ||
        provenInputTokens < MIN_PLAUSIBLE_CONTEXT_LIMIT ||
        provenInputTokens <= geometry.usableSoft
    ) {
        return { geometry };
    }
    if (hasTrustedAbsoluteWall(geometry) && provenInputTokens > geometry.derivation.absoluteWall) {
        return {
            geometry,
            refused: {
                reading: provenInputTokens,
                absoluteWall: geometry.derivation.absoluteWall,
            },
        };
    }

    const trustedAbsoluteWall = hasTrustedAbsoluteWall(geometry);
    const window = trustedAbsoluteWall
        ? geometry.derivation.window
        : Math.max(geometry.derivation.window, provenInputTokens);
    // An accepted request larger than a declared input limit proves that limit
    // wrong, so the hard limit it capped no longer applies. Without this the
    // capped hard limit would rise to each new high reading, and every such
    // reading would sit at 100% of it, past both 95% lines.
    const inputCapDisproved =
        geometry.derivation.hardWithoutInputCap !== undefined &&
        provenInputTokens > geometry.usableHard;
    const hardBeforeFloor = inputCapDisproved
        ? (geometry.derivation.hardWithoutInputCap as number)
        : geometry.usableHard;
    return {
        geometry: {
            ...geometry,
            usableSoft: provenInputTokens,
            usableHard: trustedAbsoluteWall
                ? hardBeforeFloor
                : Math.max(hardBeforeFloor, provenInputTokens),
            derivation: {
                ...geometry.derivation,
                window,
                reserve: Math.max(0, window - provenInputTokens),
                absoluteWall: trustedAbsoluteWall
                    ? geometry.derivation.absoluteWall
                    : Math.max(geometry.derivation.absoluteWall, provenInputTokens),
                provenInputTokens,
            },
        },
    };
}

export function formatWindowDerivationLine(
    inputTokens: number,
    result: WindowGeometryResult,
): string {
    const reserveLabel =
        result.derivation.reserveSource === "wall_margin"
            ? "wall margin"
            : result.derivation.reserveSource === "none"
              ? "reserve"
              : "output reserve";
    // One line at the dialog's narrowest width, and no geometry vocabulary: the
    // bracketed derivation tag (`[shared_truncating]`) names an internal
    // window-geometry mode, and the percentage is already on the headline row
    // above this one. The `Context:` prefix is dropped for the same reason — it
    // pushed the line past the narrowest dialog's content width, where it
    // wrapped onto a second row.
    return `${formatCompactTokens(inputTokens)} / ${formatCompactTokens(result.usableSoft)} usable · window ${formatCompactTokens(result.derivation.window)} · ${formatCompactTokens(result.derivation.reserve)} ${reserveLabel}`;
}

/** Distinguish metadata from a denominator raised by an accepted input measurement. */
export function formatWindowSource(result: WindowGeometryResult | undefined): string {
    return result?.derivation.provenInputTokens
        ? `provider-measured floor (${result.derivation.windowSource})`
        : (result?.derivation.windowSource ?? "unknown");
}

export function formatCompactTokens(value: number): string {
    if (Math.abs(value) >= 1_000_000) {
        return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
    }
    if (Math.abs(value) >= 1_000) {
        return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
    }
    return Math.round(value).toLocaleString();
}
