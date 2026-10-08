/**
 * The one place a `/ctx-status` payload is checked before a status surface
 * draws it.
 *
 * The OpenCode status dialog receives its data over RPC from the Magic Context
 * server, and nothing guarantees that server is the same version as the UI or
 * that it answered with a full status snapshot at all: it answers
 * `{ sessionId, disabled: true }` for a directory it keeps no state for, an
 * error envelope when it cannot read the session, and an older or newer field
 * set when OpenCode was not restarted after an update. The shared view model
 * used to read those fields unguarded, so a payload without `usagePercentage`
 * threw inside the dialog's first render and took the whole TUI down.
 *
 * Every payload therefore passes through here first. Required fields are
 * checked once; a payload missing any of them becomes a named "status
 * unavailable" reason instead of a view. Optional fields with an unexpected
 * shape are dropped (and listed) rather than passed on, so `buildStatusView`
 * only ever sees values it can format. Pi builds its snapshot in process, but
 * its overlay goes through the same check so both hosts draw from one contract.
 */
import type { SidebarSnapshot } from "./rpc-types";
import { type StatusWarningInput, statusWarningsFromDetail } from "./status-summary";
import type { CheckedStatusViewSource, StatusViewSource } from "./status-view";
import { USER_FACING_FAILURES, type UserFacingFailureKey } from "./user-facing-codes";

/** Why a status surface shows "status unavailable" instead of the status view. */
export type StatusUnavailableReason =
    /** The server could not be reached, or it answered with an error. */
    | { readonly kind: "rpc_error"; readonly message: string }
    /**
     * The server answered that it keeps no Magic Context state for this
     * directory: it is the user's home directory, or no project identity could
     * be resolved for it (memory features are paused).
     */
    | { readonly kind: "not_tracked"; readonly cause: "home_directory" | "identity_paused" }
    /** The payload lacks fields the view needs, or carries them with the wrong type. */
    | { readonly kind: "malformed"; readonly fields: readonly string[] }
    /**
     * Building the view from a checked payload still threw. The check is meant
     * to make this impossible; the reason exists so a gap in the check shows up
     * as a named message in the dialog rather than as a crashed TUI.
     */
    | { readonly kind: "view_error"; readonly message: string };

/** Plugin versions on both ends of the status RPC. */
export interface StatusVersions {
    /**
     * Version the Magic Context server reported, or null when it answered
     * without one: servers older than the `pluginVersion` field. A request that
     * got no answer carries no versions at all rather than a null here.
     */
    readonly server: string | null;
    /** Version of the package drawing the status view. */
    readonly ui: string;
}

/**
 * Result of checking one status payload. `extras` carries host-specific values
 * the host draws outside the shared view model (OpenCode's live recomp progress,
 * for example); a host with none uses `undefined`.
 */
export type StatusCheck<Extras = undefined> =
    | {
          readonly state: "ready";
          readonly source: CheckedStatusViewSource;
          /** Optional fields that were present with an unexpected shape and were left out. */
          readonly ignoredFields: readonly string[];
          /** Null on hosts where the status comes from the same process as the view. */
          readonly versions: StatusVersions | null;
          readonly extras: Extras;
      }
    | {
          readonly state: "unavailable";
          readonly reason: StatusUnavailableReason;
          readonly versions: StatusVersions | null;
      };

/** What the OpenCode dialog draws beyond the shared view model. */
export interface OpenCodeStatusExtras {
    readonly recompProgress: NonNullable<SidebarSnapshot["recompProgress"]> | null;
    /** True when Rust authority has rerouted host tool and historian paths to the module. */
    readonly hostBackendsModuleSide: boolean;
    /** Read by OpenCode 2's plain-text status, drawn where no component dialog can be. */
    readonly historianRunning: boolean;
    readonly lastTransformError: string | null;
}

type Fields = Record<string, unknown>;

function isRecord(value: unknown): value is Fields {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Any number except NaN. Pi reports "never expires" as an infinite remaining time. */
function isNumber(value: unknown): value is number {
    return typeof value === "number" && !Number.isNaN(value);
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function isString(value: unknown): value is string {
    return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
    return typeof value === "boolean";
}

function isUserFacingFailureKey(value: unknown): value is UserFacingFailureKey {
    return typeof value === "string" && Object.hasOwn(USER_FACING_FAILURES, value);
}

/** Number fields every status view needs; a payload without one of them has nothing to draw. */
const REQUIRED_NUMBER_FIELDS = [
    "usagePercentage",
    "inputTokens",
    "contextLimit",
    "executeThreshold",
    "systemPromptTokens",
    "docsTokens",
    "compartmentTokens",
    "compartmentCount",
    "factTokens",
    "memoryTokens",
    "memoryBlockCount",
    "profileTokens",
    "conversationTokens",
    "toolCallTokens",
    "toolDefinitionTokens",
    "activeTags",
    "droppedTags",
    "totalTags",
    "activeBytes",
    "lastNudgeTokens",
    "pendingOpsCount",
    "protectedTagCount",
    "lastResponseTime",
    "cacheRemainingMs",
    "historyBlockTokens",
    "memoryCount",
] as const satisfies readonly (keyof StatusViewSource)[];

const REQUIRED_BOOLEAN_FIELDS = [
    "isSubagent",
    "cacheExpired",
] as const satisfies readonly (keyof StatusViewSource)[];

type RequiredNumberField = (typeof REQUIRED_NUMBER_FIELDS)[number];

/**
 * Reads the optional fields, keeping each only when it has the shape the view
 * formats. A field with any other shape is recorded in `ignored` and left out,
 * which the view treats exactly like an absent field.
 */
class OptionalFields {
    readonly ignored: string[] = [];

    constructor(private readonly raw: Fields) {}

    read<T>(field: string, accept: (value: unknown) => value is T): T | undefined {
        const value = this.raw[field];
        if (value === undefined) return undefined;
        if (accept(value)) return value;
        this.ignored.push(field);
        return undefined;
    }

    /** Arrays keep their well-formed entries; the field is listed when any entry was dropped. */
    readArray<T>(field: string, accept: (value: unknown) => value is T): T[] | undefined {
        const value = this.raw[field];
        if (value === undefined) return undefined;
        if (!Array.isArray(value)) {
            this.ignored.push(field);
            return undefined;
        }
        const kept = value.filter(accept);
        if (kept.length !== value.length) this.ignored.push(field);
        return kept;
    }
}

function isWindowGeometry(
    value: unknown,
): value is NonNullable<StatusViewSource["windowGeometry"]> {
    if (!isRecord(value) || !isNumber(value.usableSoft) || !isRecord(value.derivation))
        return false;
    const derivation = value.derivation;
    return (
        isNumber(derivation.window) &&
        isNumber(derivation.reserve) &&
        isString(derivation.reserveSource)
    );
}

function isTailHygiene(value: unknown): value is NonNullable<StatusViewSource["tailHygiene"]> {
    return (
        isRecord(value) &&
        isNumber(value.u) &&
        isNumber(value.t) &&
        isNumber(value.severity) &&
        isBoolean(value.evaluable)
    );
}

function isCompactionMarker(
    value: unknown,
): value is NonNullable<StatusViewSource["compactionMarker"]> {
    return (
        isRecord(value) &&
        (value.code === null || value.code === "MC-C11") &&
        isNumber(value.attempts) &&
        (value.lastError === null || isString(value.lastError))
    );
}

function isTickFailure(
    value: unknown,
): value is NonNullable<StatusViewSource["dreamerTickFailure"]> {
    return isRecord(value) && isString(value.stage) && isNumber(value.at);
}

/**
 * Any object is kept: the parse-failure line only interpolates its fields, so
 * an entry from a server with a different failure shape still prints (with the
 * unknown parts blank) instead of disappearing.
 */
function isConfigParseFailure(
    value: unknown,
): value is NonNullable<StatusViewSource["configParseFailures"]>[number] {
    return isRecord(value);
}

function isConfigReloadFailure(
    value: unknown,
): value is NonNullable<StatusViewSource["configReloadFailure"]> {
    return isRecord(value) && isString(value.path) && isString(value.message);
}

function isUnconfirmedMigrationHolders(
    value: unknown,
): value is NonNullable<StatusViewSource["unconfirmedMigrationHolders"]> {
    return (
        isRecord(value) &&
        Array.isArray(value.pids) &&
        value.pids.every(isNumber) &&
        isNumber(value.fromVersion) &&
        isNumber(value.toVersion)
    );
}

function isNullableNumber(value: unknown): value is number | null {
    return value === null || isNumber(value);
}

function isNullableString(value: unknown): value is string | null {
    return value === null || isString(value);
}

function isCacheTtlSource(
    value: unknown,
): value is NonNullable<StatusViewSource["cacheTtlSource"]> {
    return isString(value);
}

/**
 * Checks a status snapshot against what `buildStatusView` reads and returns a
 * copy holding only those fields. A missing or mistyped required field fails
 * the check with its name; a malformed optional field is dropped and listed.
 */
export function checkStatusViewSource(candidate: unknown):
    | {
          readonly ok: true;
          readonly source: CheckedStatusViewSource;
          readonly ignoredFields: string[];
      }
    | { readonly ok: false; readonly fields: string[] } {
    if (!isRecord(candidate)) return { ok: false, fields: ["(the payload is not an object)"] };

    const missing: string[] = [];
    const numbers = {} as Record<RequiredNumberField, number>;
    for (const field of REQUIRED_NUMBER_FIELDS) {
        const value = candidate[field];
        if (isNumber(value)) numbers[field] = value;
        else missing.push(field);
    }
    for (const field of REQUIRED_BOOLEAN_FIELDS) {
        if (!isBoolean(candidate[field])) missing.push(field);
    }
    const cacheTtl = isString(candidate.cacheTtl) ? candidate.cacheTtl : undefined;
    if (cacheTtl === undefined) missing.push("cacheTtl");
    if (missing.length > 0 || cacheTtl === undefined) return { ok: false, fields: missing };

    const optional = new OptionalFields(candidate);
    const source: StatusViewSource = {
        ...numbers,
        isSubagent: candidate.isSubagent === true,
        cacheExpired: candidate.cacheExpired === true,
        cacheTtl,
        // Older servers leave these out; the view reads a missing budget as "no budget".
        compressionBudget: optional.read("compressionBudget", isNullableNumber) ?? null,
        compressionUsage: optional.read("compressionUsage", isNullableString) ?? null,
        executeThresholdClamped: optional.read("executeThresholdClamped", isBoolean),
        windowGeometry: optional.read("windowGeometry", isWindowGeometry),
        tailHygiene: optional.read("tailHygiene", isTailHygiene),
        tagCountsAuthoritative: optional.read("tagCountsAuthoritative", isBoolean),
        compactionMarker: optional.read("compactionMarker", isCompactionMarker),
        cacheTtlSource: optional.read("cacheTtlSource", isCacheTtlSource),
        cacheTtlModelKey: optional.read("cacheTtlModelKey", isString),
        cacheNeverExpires: optional.read("cacheNeverExpires", isBoolean),
        lastDreamerRunAt: optional.read("lastDreamerRunAt", isNullableNumber),
        dreamerUnsupportedTasks: optional.readArray("dreamerUnsupportedTasks", isString),
        dreamerSkipped: optional.readArray("dreamerSkipped", isString),
        dreamerFailures: optional.readArray(
            "dreamerFailures",
            (value): value is { task: string; error: string } =>
                isRecord(value) && isString(value.task) && isString(value.error),
        ),
        dreamerTickFailure: optional.read(
            "dreamerTickFailure",
            (value): value is NonNullable<StatusViewSource["dreamerTickFailure"]> | null =>
                value === null || isTickFailure(value),
        ),
        sessionNoteCount: optional.read("sessionNoteCount", isNumber),
        readySmartNoteCount: optional.read("readySmartNoteCount", isNumber),
        archivedCompartmentCount: optional.read("archivedCompartmentCount", isNumber),
        configParseFailures: optional.readArray("configParseFailures", isConfigParseFailure),
        configGeneration: optional.read("configGeneration", isNumber),
        configAdoptedAt: optional.read("configAdoptedAt", isNumber),
        configReloadFailure: optional.read("configReloadFailure", isConfigReloadFailure),
        compaction_enabled: optional.read("compaction_enabled", isBoolean),
        compactionEnabled: optional.read("compactionEnabled", isBoolean),
        // A failure code this build does not know has no text to print; it is
        // dropped rather than rendered as a crash.
        warnings: optional.readArray("warnings", isUserFacingFailureKey),
        hiddenVariantWarnings: optional.readArray("hiddenVariantWarnings", isString),
        unconfirmedMigrationHolders: optional.read(
            "unconfirmedMigrationHolders",
            isUnconfirmedMigrationHolders,
        ),
    };
    // The brand is what lets `buildStatusView` accept this object: only this
    // function produces one, after every field above has been checked.
    return { ok: true, source: source as CheckedStatusViewSource, ignoredFields: optional.ignored };
}

/** A host that builds its status in process: no transport, no version to compare. */
export function checkLocalStatusSource(candidate: unknown): StatusCheck {
    const checked = checkStatusViewSource(candidate);
    if (!checked.ok) {
        return {
            state: "unavailable",
            reason: { kind: "malformed", fields: checked.fields },
            versions: null,
        };
    }
    return {
        state: "ready",
        source: checked.source,
        ignoredFields: checked.ignoredFields,
        versions: null,
        extras: undefined,
    };
}

/**
 * An RPC failure (transport error, timeout, or client not started) as a status
 * result. No server answered, so there is no server version to compare.
 */
export function statusRpcFailure(message: string): StatusCheck<never> {
    return { state: "unavailable", reason: { kind: "rpc_error", message }, versions: null };
}

function isRecompProgress(
    value: unknown,
): value is NonNullable<OpenCodeStatusExtras["recompProgress"]> {
    return (
        isRecord(value) &&
        isString(value.phase) &&
        (value.kind === undefined || isString(value.kind)) &&
        isNumber(value.processedMessages) &&
        isNumber(value.totalMessages) &&
        isNumber(value.passCount) &&
        isNumber(value.compartmentsCreated) &&
        (value.message === undefined || isString(value.message)) &&
        (value.note === undefined || isString(value.note))
    );
}

/** The fields the warning list is derived from, each kept only with a usable shape. */
function warningInputFrom(raw: Fields, optional: OptionalFields): StatusWarningInput {
    return {
        lastTransformError: optional.read("lastTransformError", isNullableString) ?? null,
        historianFailureCount: optional.read("historianFailureCount", isNumber),
        configParseFailures: optional.readArray("configParseFailures", isConfigParseFailure),
        embedding:
            isRecord(raw.embedding) && isString(raw.embedding.state)
                ? { state: raw.embedding.state }
                : undefined,
        loggerDiagnostics:
            isRecord(raw.loggerDiagnostics) && isNumber(raw.loggerDiagnostics.swallowedWriteCount)
                ? { swallowedWriteCount: raw.loggerDiagnostics.swallowedWriteCount }
                : undefined,
        memoryMirror: isRecord(raw.memoryMirror)
            ? { stalled: raw.memoryMirror.stalled === true }
            : undefined,
        compactionMarker: optional.read("compactionMarker", isCompactionMarker),
        memoryAuthorityMismatch: raw.memoryAuthorityMismatch === true,
        dreamerFailures: Array.isArray(raw.dreamerFailures) ? raw.dreamerFailures : undefined,
        dreamerTickFailure: isTickFailure(raw.dreamerTickFailure) ? raw.dreamerTickFailure : null,
        hostLimitations: optional.readArray("hostLimitations", isUserFacingFailureKey),
    };
}

/**
 * Model window size the dialog shows. Prefer the RPC-provided limit (what the
 * sidebar shows) so the two surfaces never disagree; derive it from usage only
 * when the limit is absent (0), and leave it at 0 ("?") when usage is 0 too,
 * because the derivation is undefined there.
 */
function dialogContextLimit(raw: Fields): unknown {
    const { contextLimit, usagePercentage, inputTokens } = raw;
    if (!isNumber(contextLimit)) return contextLimit;
    if (contextLimit > 0) return contextLimit;
    if (isFiniteNumber(usagePercentage) && usagePercentage > 0 && isFiniteNumber(inputTokens)) {
        return Math.round(inputTokens / (usagePercentage / 100));
    }
    return 0;
}

/**
 * Checks a `status-detail` RPC reply for the OpenCode dialog (both host
 * generations). `uiVersion` is the version of the package drawing the dialog;
 * the server reports its own in `pluginVersion`, and a server too old to send
 * it reports `null`.
 */
export function checkStatusDetailPayload(
    raw: unknown,
    uiVersion: string,
): StatusCheck<OpenCodeStatusExtras> {
    if (!isRecord(raw)) {
        return {
            state: "unavailable",
            reason: { kind: "malformed", fields: ["(the payload is not an object)"] },
            versions: null,
        };
    }
    const versions: StatusVersions = {
        server: isString(raw.pluginVersion) ? raw.pluginVersion : null,
        ui: uiVersion,
    };
    if (isString(raw.error)) {
        // Servers older than the version field send bare error envelopes; that
        // absence says nothing about their age, so no version is compared.
        return {
            state: "unavailable",
            reason: { kind: "rpc_error", message: raw.error },
            versions: versions.server === null ? null : versions,
        };
    }
    if (raw.disabled === true) {
        return {
            state: "unavailable",
            reason: {
                kind: "not_tracked",
                cause: raw.paused === true ? "identity_paused" : "home_directory",
            },
            versions,
        };
    }

    const extrasFields = new OptionalFields(raw);
    const warnings = statusWarningsFromDetail(warningInputFrom(raw, extrasFields));
    const checked = checkStatusViewSource({
        ...raw,
        contextLimit: dialogContextLimit(raw),
        warnings,
    });
    if (!checked.ok) {
        return {
            state: "unavailable",
            reason: { kind: "malformed", fields: checked.fields },
            versions,
        };
    }
    const extras: OpenCodeStatusExtras = {
        recompProgress:
            extrasFields.read(
                "recompProgress",
                (value): value is NonNullable<OpenCodeStatusExtras["recompProgress"]> | null =>
                    value === null || isRecompProgress(value),
            ) ?? null,
        hostBackendsModuleSide: extrasFields.read("hostBackendsModuleSide", isBoolean) ?? false,
        historianRunning: extrasFields.read("historianRunning", isBoolean) ?? false,
        lastTransformError: extrasFields.read("lastTransformError", isNullableString) ?? null,
    };
    return {
        state: "ready",
        source: checked.source,
        ignoredFields: [...new Set([...checked.ignoredFields, ...extrasFields.ignored])],
        versions,
        extras,
    };
}

/**
 * One line naming a server/UI version difference, or null when both ends run
 * the same version (or the status comes from the same process). A server that
 * reports no version predates the field, so it is older than this UI.
 */
export function statusVersionNotice(versions: StatusVersions | null): string | null {
    if (!versions) return null;
    if (versions.server === versions.ui) return null;
    // OpenCode keeps a server process on the build it started with, so an
    // older server here means an OpenCode process from before the update is
    // still running; restarting only this window does not replace it.
    if (versions.server === null) {
        return `An older Magic Context server (one too old to report its version) is still running, while this UI is ${versions.ui}: quit all OpenCode processes, then start OpenCode again`;
    }
    if (compareVersions(versions.server, versions.ui) < 0) {
        return `An older Magic Context (${versions.server}) server is still running, while this UI is ${versions.ui}: quit all OpenCode processes, then start OpenCode again`;
    }
    return `Magic Context server is ${versions.server}, this UI is ${versions.ui}: restart OpenCode`;
}

/** Orders dotted release versions numerically; prerelease suffixes are ignored. */
function compareVersions(left: string, right: string): number {
    const parts = (version: string) =>
        version
            .split(/[-+]/, 1)[0]
            ?.split(".")
            .map((part) => Number.parseInt(part, 10) || 0) ?? [];
    const a = parts(left);
    const b = parts(right);
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
        const difference = (a[index] ?? 0) - (b[index] ?? 0);
        if (difference !== 0) return difference;
    }
    return 0;
}
