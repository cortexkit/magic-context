import type { CheckKind, ReportedProfile } from "./lifecycle-gates";
import { lifecycleTextHash } from "./lifecycle-text";
import shippedAllowlist from "./turn-two-allowlist.json";

export type TurnTwoLane = "opencode-1" | "opencode-2" | "pi" | "omp";
export type TurnTwoCarrier = "hidden-completion" | "opencode-session" | "pi-historian-rpc";
export interface TurnTwoEntry {
    lane: TurnTwoLane;
    carrier: TurnTwoCarrier;
    provider: string;
    modelId: string;
    variant: string | null;
    temperature: number | null;
    thinkingLevel: string | null;
    historianSystemHash: string;
    combinedSchemaHash: string;
    historianToolHash: string;
    checkSystemHashes: Record<CheckKind, string>;
    checkSchemaHash: string;
    checkToolHash: string;
}

/** In-process evidence from a disposable-root runner, never a configuration value. */
export interface TurnTwoTrialAuthorization {
    candidate: TurnTwoEntry;
    /** Canonical, non-symlinked disposable root whose open handles the runner attested. */
    attestedRoot: string;
}

export interface ValidatedProfile extends ReportedProfile {
    lane: TurnTwoLane;
    carrier: TurnTwoCarrier;
    thinkingLevel: string | null;
    schemaHash: string;
    toolHash: string;
}
export interface TurnTwoAllowlist {
    entries: TurnTwoEntry[];
    validatedProfiles: ValidatedProfile[];
}

const CHECK_KINDS: CheckKind[] = ["disproof", "support", "kept-clause", "compatibility"];
const ENTRY_HASHES = [
    "historianSystemHash",
    "combinedSchemaHash",
    "historianToolHash",
    "checkSchemaHash",
    "checkToolHash",
] as const;
const ROW_KEYS = [
    "lane",
    "carrier",
    "provider",
    "modelId",
    "variant",
    "temperature",
    "thinkingLevel",
    "systemHash",
    "schemaHash",
    "toolHash",
] as const;
function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonempty(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}
function hash(value: unknown): value is string {
    return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function nullableString(value: unknown): boolean {
    return value === null || typeof value === "string";
}
function nullableTemperature(value: unknown): boolean {
    return value === null || (typeof value === "number" && Number.isFinite(value));
}
function hostIdentity(lane: unknown, carrier: unknown): boolean {
    if (lane === "opencode-1")
        return carrier === "hidden-completion" || carrier === "opencode-session";
    if (lane === "opencode-2") return carrier === "hidden-completion";
    if (lane === "pi" || lane === "omp") return carrier === "pi-historian-rpc";
    return false;
}

/** Derive a lane only for a supported host/carrier pair; a runner never inherits its binding. */
export function turnTwoLaneForReport(report: {
    harness?: string | null;
    carrier?: string | null;
}): TurnTwoLane | null {
    const lane =
        report.harness === "opencode"
            ? "opencode-1"
            : report.harness === "opencode2"
              ? "opencode-2"
              : report.harness === "pi" || report.harness === "omp"
                ? report.harness
                : null;
    return hostIdentity(lane, report.carrier) ? lane : null;
}

function selectionIdentity(value: Record<string, unknown>): boolean {
    return (
        hostIdentity(value.lane, value.carrier) &&
        nonempty(value.provider) &&
        nonempty(value.modelId) &&
        nullableString(value.variant)
    );
}
function entryHashes(value: Record<string, unknown>): boolean {
    const systems = value.checkSystemHashes;
    return (
        ENTRY_HASHES.every((key) => hash(value[key])) &&
        record(systems) &&
        CHECK_KINDS.every((kind) => hash(systems[kind]))
    );
}
export function isTurnTwoEntry(value: unknown): value is TurnTwoEntry {
    return (
        record(value) &&
        selectionIdentity(value) &&
        entryHashes(value) &&
        nullableTemperature(value.temperature) &&
        nullableString(value.thinkingLevel)
    );
}
export function isValidatedProfile(value: unknown): value is ValidatedProfile {
    return (
        record(value) &&
        selectionIdentity(value) &&
        nullableTemperature(value.temperature) &&
        nullableString(value.thinkingLevel) &&
        hash(value.systemHash) &&
        hash(value.schemaHash) &&
        hash(value.toolHash)
    );
}

/** Missing keys are not unknown values: only an explicit null can match another null. */
export function matchesReportedProfile(actual: unknown, candidate: unknown): boolean {
    return (
        isValidatedProfile(actual) &&
        isValidatedProfile(candidate) &&
        ROW_KEYS.every((key) => actual[key] === candidate[key])
    );
}

export function expandTurnTwoEntry(entry: TurnTwoEntry): ValidatedProfile[] {
    if (!isTurnTwoEntry(entry)) return [];
    const shared = {
        lane: entry.lane,
        carrier: entry.carrier,
        provider: entry.provider,
        modelId: entry.modelId,
        variant: entry.variant,
        temperature: entry.temperature,
        thinkingLevel: entry.thinkingLevel,
    };
    return [
        {
            ...shared,
            systemHash: entry.historianSystemHash,
            schemaHash: entry.combinedSchemaHash,
            toolHash: entry.historianToolHash,
        },
        ...CHECK_KINDS.map((kind) => ({
            ...shared,
            systemHash: entry.checkSystemHashes[kind],
            schemaHash: entry.checkSchemaHash,
            toolHash: entry.checkToolHash,
        })),
    ];
}

export function loadTurnTwoAllowlist(value: unknown = shippedAllowlist): TurnTwoAllowlist {
    if (!record(value) || value.version !== 1 || !Array.isArray(value.entries))
        return { entries: [], validatedProfiles: [] };
    const entries = value.entries.filter(isTurnTwoEntry);
    return { entries, validatedProfiles: entries.flatMap(expandTurnTwoEntry) };
}

/** Effective temperature and thinking level do not exist until the first reply. */
export function matchesTurnTwoSelection(requested: unknown, candidate: unknown): boolean {
    if (
        !record(requested) ||
        !selectionIdentity(requested) ||
        !entryHashes(requested) ||
        !isTurnTwoEntry(candidate)
    )
        return false;
    return (
        requested.lane === candidate.lane &&
        requested.carrier === candidate.carrier &&
        requested.provider === candidate.provider &&
        requested.modelId === candidate.modelId &&
        requested.variant === candidate.variant &&
        ENTRY_HASHES.every((key) => requested[key] === candidate[key]) &&
        CHECK_KINDS.every(
            (kind) =>
                (requested.checkSystemHashes as Record<CheckKind, string>)[kind] ===
                candidate.checkSystemHashes[kind],
        )
    );
}
export function matchesTurnTwoEntry(actual: unknown, candidate: unknown): boolean {
    return (
        isTurnTwoEntry(actual) &&
        isTurnTwoEntry(candidate) &&
        matchesTurnTwoSelection(actual, candidate) &&
        actual.temperature === candidate.temperature &&
        actual.thinkingLevel === candidate.thinkingLevel
    );
}
export function selectTurnTwoProfile(
    requested: unknown,
    entries: readonly TurnTwoEntry[] = loadTurnTwoAllowlist().entries,
): TurnTwoEntry | undefined {
    return entries.find((entry) => matchesTurnTwoSelection(requested, entry));
}

/** Canonicalize only JSON data, rejecting values that JSON.stringify would silently discard. */
export function canonicalLifecycleJson(value: unknown): string {
    if (
        value === null ||
        typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))
    )
        return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalLifecycleJson).join(",")}]`;
    if (
        record(value) &&
        (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    )
        return `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalLifecycleJson(value[key])}`)
            .join(",")}}`;
    throw new TypeError("Lifecycle identity bytes must be JSON data");
}
export function lifecycleToolHash(toolSurface: unknown): string {
    return lifecycleTextHash(canonicalLifecycleJson(toolSurface));
}

export interface TurnOneFailureKey {
    parentSessionId: string;
    firstMessageId: string;
    profileHash: string;
    renderingHash: string;
    schemaHash: string;
    toolHash: string;
}
export function turnOneFailureProfileHash(
    profile: Pick<
        TurnTwoEntry,
        "lane" | "carrier" | "provider" | "modelId" | "variant" | "temperature" | "thinkingLevel"
    >,
): string {
    const { lane, carrier, provider, modelId, variant, temperature, thinkingLevel } = profile;
    return lifecycleTextHash(
        canonicalLifecycleJson({
            lane,
            carrier,
            provider,
            modelId,
            variant,
            temperature,
            thinkingLevel,
        }),
    );
}
export function turnOneFailurePublicationId(key: TurnOneFailureKey): string {
    const { parentSessionId, firstMessageId, profileHash, renderingHash, schemaHash, toolHash } =
        key;
    return `t1fail:${lifecycleTextHash(canonicalLifecycleJson({ parentSessionId, firstMessageId, profileHash, renderingHash, schemaHash, toolHash }))}`;
}
export interface TurnOneFailureRow {
    publication_id: string;
    stage: string;
    run_attempt: number;
    state: string;
}
export function turnOneFailureCount(
    publicationId: string,
    rows: readonly TurnOneFailureRow[],
): number {
    const attempts = rows.filter(
        (row) => row.publication_id === publicationId && row.stage === "turn_one",
    );
    const reset = Math.max(
        0,
        ...attempts.filter((row) => row.state === "counter_reset").map((row) => row.run_attempt),
    );
    return attempts.filter((row) => row.state === "parse_failed" && row.run_attempt > reset).length;
}
