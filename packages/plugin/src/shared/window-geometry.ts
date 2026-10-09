import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "./data-path";
import { modelRefLookupOrder } from "./harness-provider-map";
import { sessionLog } from "./logger";
import type { ModelLimit } from "./models-dev-cache";

export const WINDOW_OVERLAY_SCHEMA = "fusiform-window-overlay/v1";
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
export type WindowOverlayGrade =
    | "provider_asserted_runtime"
    | "measured"
    | "provider_asserted_doc"
    | "catalog"
    | "unknown";
export type WindowOverlayUnits = "provider" | "estimate";
export type WindowOverlayBoundary = "Observed" | "Asserted" | "Corrected";
export type WindowOverlayUnknownWhy =
    | "placeholder_output_equals_context"
    | "placeholder_zero"
    | "never_measured"
    // Asserts the KEY cannot hold one fact (e.g. a router samples heterogeneous
    // backends per request), so measurement cannot settle it and measured
    // reports must not be promoted into stated/bracket cells at this key.
    // Ratified terminal at fusiform 080e70208aad713d (2026-08-13), added without a schema bump: an
    // additive vocabulary value degrades per-cell for ignorant consumers,
    // whereas a version bump would trigger the file-level refusal rule.
    | "not_single_valued_at_key"
    | "retracted";

export type WindowOverlayFactValue =
    | { kind: "stated"; value: number | string }
    | { kind: "bracket"; at_least?: number; below?: number }
    | { kind: "unknown"; why: WindowOverlayUnknownWhy };

export interface WindowOverlayFact {
    value: WindowOverlayFactValue;
    grade: WindowOverlayGrade;
    units: WindowOverlayUnits;
    boundary: WindowOverlayBoundary;
    source_ref: string;
    observed_at: string;
    [unknownField: string]: unknown;
}

export interface WindowOverlayCell {
    provider_id: string;
    model_id: string;
    /** Unknown fact keys are retained so a newer producer can coexist with this v1 consumer. */
    facts: Record<string, WindowOverlayFact>;
}

export interface WindowOverlay {
    schema: typeof WINDOW_OVERLAY_SCHEMA;
    generated_at: string;
    minted_provider_ids: string[];
    cells: WindowOverlayCell[];
}

export interface ResolvedWindowOverlayFacts {
    /** Includes facts whose tagged value is explicitly unknown. */
    facts: Record<string, WindowOverlayFact>;
}

export type WindowLimitSource = "catalog" | "overlay" | "provider" | "detected";

export interface WindowDerivation {
    window: number;
    reserve: number;
    reserveSource: WindowReserveSource;
    geometry: WindowGeometry;
    windowSource: WindowLimitSource;
    absoluteWall: number;
    /** Accepted provider input used to raise the usable denominator above metadata. */
    provenInputTokens?: number;
}

export interface WindowGeometryResult {
    usableSoft: number;
    usableHard: number;
    geometry: WindowGeometry;
    derivation: WindowDerivation;
}

export interface DeriveWindowGeometryOptions {
    overlay?: ResolvedWindowOverlayFacts;
    /** A provider/auth hook has higher precedence than the overlay, field by field. */
    providerLimit?: ModelLimit;
    /** Resolved user override; higher precedence than catalog, overlay, and geometry defaults. */
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

const GRADES = new Set<WindowOverlayGrade>([
    "provider_asserted_runtime",
    "measured",
    "provider_asserted_doc",
    "catalog",
    "unknown",
]);
const UNITS = new Set<WindowOverlayUnits>(["provider", "estimate"]);
const BOUNDARIES = new Set<WindowOverlayBoundary>(["Observed", "Asserted", "Corrected"]);
const UNKNOWN_REASONS = new Set<WindowOverlayUnknownWhy>([
    "placeholder_output_equals_context",
    "placeholder_zero",
    "never_measured",
    "not_single_valued_at_key",
    "retracted",
]);
const NUMERIC_FACT_KEYS = new Set([
    "window.advertised",
    "window.enforced",
    "output.advertised",
    "output.enforced",
    "output.default",
]);

let configuredOverlayPath: string | undefined;
let loadedOverlayPath: string | undefined;
let loadedOverlay: WindowOverlay | null | undefined;
const geometryClampLogSeen = new Set<string>();

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFinitePositive(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Convert the ratified tagged numeric union into the conservative scalar used by derivation. */
export function scalarizeFact(value: WindowOverlayFactValue): number | undefined {
    if (value.kind === "stated") return isFinitePositive(value.value) ? value.value : undefined;
    if (value.kind === "bracket") {
        return isFinitePositive(value.at_least) ? value.at_least : undefined;
    }
    return undefined;
}

function parseFactValue(value: unknown): WindowOverlayFactValue | undefined {
    if (!isRecord(value) || typeof value.kind !== "string") return undefined;
    if (value.kind === "stated") {
        if (
            (typeof value.value !== "number" || !Number.isFinite(value.value)) &&
            typeof value.value !== "string"
        ) {
            return undefined;
        }
        return { kind: "stated", value: value.value };
    }
    if (value.kind === "bracket") {
        const atLeast = value.at_least;
        const below = value.below;
        if (atLeast === undefined && below === undefined) return { kind: "bracket" };
        if (atLeast !== undefined && !isFinitePositive(atLeast)) return undefined;
        if (below !== undefined && !isFinitePositive(below)) return undefined;
        if (isFinitePositive(atLeast) && isFinitePositive(below) && below <= atLeast) {
            return undefined;
        }
        return {
            kind: "bracket",
            ...(isFinitePositive(atLeast) ? { at_least: atLeast } : {}),
            ...(isFinitePositive(below) ? { below } : {}),
        };
    }
    if (value.kind === "unknown" && UNKNOWN_REASONS.has(value.why as WindowOverlayUnknownWhy)) {
        return { kind: "unknown", why: value.why as WindowOverlayUnknownWhy };
    }
    return undefined;
}

function parseFact(key: string, value: unknown): WindowOverlayFact | undefined {
    if (!isRecord(value)) return undefined;
    const parsedValue = parseFactValue(value.value);
    if (
        !parsedValue ||
        !GRADES.has(value.grade as WindowOverlayGrade) ||
        !UNITS.has(value.units as WindowOverlayUnits) ||
        !BOUNDARIES.has(value.boundary as WindowOverlayBoundary) ||
        typeof value.source_ref !== "string" ||
        value.source_ref.length === 0 ||
        typeof value.observed_at !== "string" ||
        value.observed_at.length === 0
    ) {
        return undefined;
    }
    if (
        NUMERIC_FACT_KEYS.has(key) &&
        parsedValue.kind === "stated" &&
        !isFinitePositive(parsedValue.value)
    ) {
        return undefined;
    }
    if (
        key === "geometry" &&
        parsedValue.kind === "stated" &&
        !["shared_upfront", "shared_truncating", "separate"].includes(String(parsedValue.value))
    ) {
        return undefined;
    }
    return {
        ...value,
        value: parsedValue,
        grade: value.grade as WindowOverlayGrade,
        units: value.units as WindowOverlayUnits,
        boundary: value.boundary as WindowOverlayBoundary,
        source_ref: value.source_ref,
        observed_at: value.observed_at,
    } as WindowOverlayFact;
}

export function parseWindowOverlay(value: unknown): {
    overlay?: WindowOverlay;
    badCells: number;
    refusal?: string;
} {
    if (!isRecord(value)) {
        return { badCells: 0, refusal: "overlay root is not an object" };
    }
    if (value.schema !== WINDOW_OVERLAY_SCHEMA) {
        return {
            badCells: 0,
            refusal: `unrecognized schema ${JSON.stringify(value.schema)}`,
        };
    }
    if (
        typeof value.generated_at !== "string" ||
        !Array.isArray(value.minted_provider_ids) ||
        !value.minted_provider_ids.every((id) => typeof id === "string" && id.length > 0) ||
        !Array.isArray(value.cells)
    ) {
        return { badCells: 0, refusal: "invalid v1 envelope" };
    }

    const cells: WindowOverlayCell[] = [];
    let badCells = 0;
    for (const rawCell of value.cells) {
        if (
            !isRecord(rawCell) ||
            typeof rawCell.provider_id !== "string" ||
            rawCell.provider_id.length === 0 ||
            typeof rawCell.model_id !== "string" ||
            rawCell.model_id.length === 0 ||
            !isRecord(rawCell.facts)
        ) {
            badCells++;
            continue;
        }
        const facts: Record<string, WindowOverlayFact> = {};
        let valid = true;
        for (const [key, rawFact] of Object.entries(rawCell.facts)) {
            const fact = parseFact(key, rawFact);
            if (!fact) {
                valid = false;
                break;
            }
            facts[key] = fact;
        }
        if (!valid) {
            badCells++;
            continue;
        }
        cells.push({
            provider_id: rawCell.provider_id,
            model_id: rawCell.model_id,
            facts,
        });
    }

    return {
        overlay: {
            schema: WINDOW_OVERLAY_SCHEMA,
            generated_at: value.generated_at,
            minted_provider_ids: [...value.minted_provider_ids],
            cells,
        },
        badCells,
    };
}

export function defaultWindowOverlayPath(): string {
    return join(getDataDir(), "fusiform", "window-overlay.json");
}

export function readWindowOverlayFile(
    path: string,
    log: (message: string) => void = (message) => sessionLog("global", message),
): WindowOverlay | undefined {
    let raw: string;
    try {
        raw = readFileSync(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        log(`window-overlay: unable to read ${path}; overlay ignored`);
        return undefined;
    }
    let decoded: unknown;
    try {
        decoded = JSON.parse(raw);
    } catch {
        log(`window-overlay: invalid JSON in ${path}; overlay ignored`);
        return undefined;
    }
    const parsed = parseWindowOverlay(decoded);
    if (parsed.refusal) {
        log(`window-overlay: ${parsed.refusal} in ${path}; entire overlay ignored`);
        return undefined;
    }
    if (parsed.badCells > 0) {
        log(`window-overlay: skipped ${parsed.badCells} invalid cell(s) from ${path}`);
    }
    return parsed.overlay;
}

/** Set the user-tier overlay path. Undefined restores the Fusiform data-dir default. */
export function setWindowOverlayPath(path: string | undefined): void {
    // Runtime hooks may resolve unchanged config more than once. Preserve the
    // process snapshot unless the configured path actually changes, so an
    // external same-path rewrite cannot alter geometry between turns.
    if (configuredOverlayPath === path) return;
    reloadWindowOverlay(path);
}

/** Start a new overlay snapshot at an explicit plugin/extension reload boundary. */
export function reloadWindowOverlay(path: string | undefined): void {
    configuredOverlayPath = path;
    loadedOverlayPath = undefined;
    loadedOverlay = undefined;
}

export function clearWindowOverlayCacheForTest(): void {
    loadedOverlayPath = undefined;
    loadedOverlay = undefined;
    geometryClampLogSeen.clear();
}

export function getWindowOverlay(): WindowOverlay | undefined {
    const path = configuredOverlayPath ?? defaultWindowOverlayPath();
    if (loadedOverlayPath === path && loadedOverlay !== undefined) {
        return loadedOverlay ?? undefined;
    }
    loadedOverlayPath = path;
    loadedOverlay = readWindowOverlayFile(path) ?? null;
    return loadedOverlay ?? undefined;
}

export function resolveWindowOverlayFacts(
    providerID: string,
    modelID: string,
    overlay: WindowOverlay | undefined = getWindowOverlay(),
): ResolvedWindowOverlayFacts | undefined {
    if (!overlay) return undefined;
    const modelRefs = modelRefLookupOrder(`${providerID}/${modelID}`);
    const providerCandidates = new Set(modelRefs.map((ref) => ref.slice(0, ref.indexOf("/"))));
    const modelCandidates = new Set([
        modelID,
        ...modelRefs.map((ref) => ref.slice(ref.indexOf("/") + 1)),
    ]);
    const colon = modelID.lastIndexOf(":");
    if (colon > 0) modelCandidates.add(modelID.slice(0, colon));

    const wildcardFacts: Record<string, WindowOverlayFact> = {};
    const specificFacts: Record<string, WindowOverlayFact> = {};
    for (const cell of overlay.cells) {
        if (!providerCandidates.has(cell.provider_id)) continue;
        if (cell.model_id === "*") Object.assign(wildcardFacts, cell.facts);
        else if (modelCandidates.has(cell.model_id)) Object.assign(specificFacts, cell.facts);
    }
    const facts = { ...wildcardFacts, ...specificFacts };
    return Object.keys(facts).length > 0 ? { facts } : undefined;
}

function numericOverlayFact(
    overlay: ResolvedWindowOverlayFacts | undefined,
    key: string,
): number | undefined {
    const fact = overlay?.facts[key];
    return fact ? scalarizeFact(fact.value) : undefined;
}

/**
 * Three-state geometry resolution from the overlay. The absent-vs-unknown
 * distinction is ratified contract semantics: a fact ABSENT from the cell was
 * never considered (our static provider table still applies), while a fact
 * present with kind "unknown" was considered and has no answer — the dataset
 * owner checked the primary source and found the usual inference unsupported
 * (e.g. Google's own docs contradict the separate-quota reading), so the
 * static assumption built on that same inference must NOT apply either.
 */
function overlayGeometry(
    overlay: ResolvedWindowOverlayFacts | undefined,
): { kind: "stated"; value: WindowGeometry } | { kind: "unknown" } | undefined {
    const fact = overlay?.facts.geometry;
    if (fact === undefined) return undefined;
    if (fact.value.kind === "unknown") return { kind: "unknown" };
    if (fact.value.kind !== "stated") return undefined;
    const value = fact.value.value;
    return value === "shared_upfront" || value === "shared_truncating" || value === "separate"
        ? { kind: "stated", value }
        : undefined;
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
    overlayValue: number | undefined,
    providerValue: number | undefined,
): number | undefined {
    return isFinitePositive(providerValue) ? providerValue : overlayValue;
}

function logGeometryClampOnce(key: string, message: string, log?: (message: string) => void): void {
    if (geometryClampLogSeen.has(key)) return;
    geometryClampLogSeen.add(key);
    (log ?? ((entry) => sessionLog("global", `window-geometry: ${entry}`)))(message);
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
    const advertised = numericOverlayFact(options.overlay, "window.advertised");
    const enforced = numericOverlayFact(options.overlay, "window.enforced");
    let softContext = mergePositive(enforced ?? advertised ?? catalogContext, providerContext);
    let hardContext = mergePositive(enforced ?? softContext, providerContext);
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
        options.overlay === undefined && options.providerLimit === undefined
            ? isFinitePositive(catalogLimit?.output)
                ? catalogLimit.output
                : undefined
            : placeholderFilteredOutput(catalogLimit?.output, softContext);
    const overlayOutput = placeholderFilteredOutput(
        numericOverlayFact(options.overlay, "output.enforced") ??
            numericOverlayFact(options.overlay, "output.default") ??
            numericOverlayFact(options.overlay, "output.advertised"),
        softContext,
    );
    const providerOutput = placeholderFilteredOutput(providerLimit?.output, softContext);
    const output = providerOutput ?? overlayOutput ?? catalogOutput;
    const geometryFact = overlayGeometry(options.overlay);
    // Considered-unknown demotes to shared_upfront — the conservative geometry
    // in both directions (largest soft reserve, lowest hard wall) — until a
    // measurement settles the cell. Absence falls through to the static table.
    const geometry =
        geometryFact?.kind === "stated"
            ? geometryFact.value
            : geometryFact?.kind === "unknown"
              ? "shared_upfront"
              : (PROVIDER_GEOMETRY[providerID] ?? "shared_upfront");
    const geometryOverride = geometryFact?.kind === "stated" ? geometryFact.value : undefined;

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
        if (
            geometry === "separate" &&
            (options.overlay === undefined ||
                options.harness === "pi" ||
                geometryOverride !== undefined)
        ) {
            softReserve = 0;
            reserveSource = "none";
        } else {
            softReserve = output ?? 0;
            reserveSource = output === undefined ? "none" : "output_catalog";
            const cap = softContext * OUTPUT_RESERVE_CAP_RATIO;
            softReserve = Math.min(
                softReserve,
                options.harness === "pi" || options.overlay === undefined
                    ? cap
                    : Math.min(cap, OPENCODE_OUTPUT_CAP),
            );
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
          : enforced !== undefined || advertised !== undefined
            ? "overlay"
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
    usableHard = Math.max(MIN_PLAUSIBLE_CONTEXT_LIMIT, Math.floor(usableHard));
    if (usableHard < usableSoft) {
        logGeometryClampOnce(
            `${providerID}/${modelID}|${usableSoft}|${usableHard}`,
            `usable hard limit clamped for ${providerID}/${modelID}: ${usableHard} → ${usableSoft} (overlay/provider inversion)`,
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
 * provider, overlay, or observed-overflow wall here. A provider or overlay wall
 * is the configured limit: a reading beyond it is real pressure against that
 * limit (the usage handlers count it in full), not proof that the geometry
 * should grow. An observed-overflow wall that a larger accepted request
 * disproves is cleared by the usage handlers instead.
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
    return {
        geometry: {
            ...geometry,
            usableSoft: provenInputTokens,
            usableHard: trustedAbsoluteWall
                ? geometry.usableHard
                : Math.max(geometry.usableHard, provenInputTokens),
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
