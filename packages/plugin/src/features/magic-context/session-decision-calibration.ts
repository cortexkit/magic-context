import {
    calibrationForModelKey,
    type DecisionCalibration,
    resolveDecisionCalibration,
} from "../../hooks/magic-context/decision-calibration";
import { piModelRefToCanonical } from "../../shared/harness-provider-map";
import type { Database } from "../../shared/sqlite";

const CALIBRATION_STATE_KEY = "magicContextTokenizerCalibration";
export const HYGIENE_PROVIDER_UNITS_VERSION = 2;

export interface FrozenSessionDecisionCalibration {
    revision: string;
    providerId: string;
    modelId: string;
    systemRatio: number;
    toolsRatio: number;
    proseRatio: number;
    source: DecisionCalibration["source"];
}

interface CalibrationStateNamespace {
    active?: FrozenSessionDecisionCalibration;
    hygieneUnitsVersion?: number;
}

interface SessionCalibrationRow {
    model_key?: string;
    deferred_execute_state?: string | null;
    last_nudge_undropped?: number | null;
    last_nudge_level?: string | null;
}

export interface SessionDecisionCalibrationPass {
    bustPermitted: boolean;
    modelKey?: string | null;
    bustReason?: string;
    onAdopt?: (message: string) => void;
}

function finitePositive(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function parseFrozenCalibration(
    value: unknown,
    acceptModelId = false,
): FrozenSessionDecisionCalibration | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const candidate = value as Partial<FrozenSessionDecisionCalibration>;
    if (
        typeof candidate.revision !== "string" ||
        candidate.revision.length === 0 ||
        typeof candidate.providerId !== "string" ||
        typeof candidate.modelId !== "string" ||
        !finitePositive(candidate.systemRatio) ||
        !finitePositive(candidate.toolsRatio) ||
        !finitePositive(candidate.proseRatio) ||
        (candidate.source !== "seed" &&
            candidate.source !== "family-fallback" &&
            !(acceptModelId && candidate.source === "model-id"))
    ) {
        return null;
    }
    return {
        revision: candidate.revision,
        providerId: candidate.providerId,
        modelId: candidate.modelId,
        systemRatio: candidate.systemRatio,
        toolsRatio: candidate.toolsRatio,
        proseRatio: candidate.proseRatio,
        source: candidate.source,
    };
}

function parseStateRoot(raw: string | null | undefined): Record<string, unknown> {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw) as unknown;
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? { ...(parsed as Record<string, unknown>) }
            : {};
    } catch {
        return {};
    }
}

function parseNamespace(
    root: Record<string, unknown>,
    acceptModelId = false,
): CalibrationStateNamespace {
    const value = root[CALIBRATION_STATE_KEY];
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    const namespace = value as Record<string, unknown>;
    const active = parseFrozenCalibration(namespace.active, acceptModelId);
    return {
        active: active ?? undefined,
        hygieneUnitsVersion:
            typeof namespace.hygieneUnitsVersion === "number" &&
            Number.isFinite(namespace.hygieneUnitsVersion)
                ? Math.max(0, Math.floor(namespace.hygieneUnitsVersion))
                : undefined,
    };
}

function readSessionRow(db: Database, sessionId: string): SessionCalibrationRow | undefined {
    try {
        return db
            .prepare(
                "SELECT COALESCE(NULLIF(cached_m0_model_key, ''), last_observed_model_key) AS model_key, deferred_execute_state, last_nudge_undropped, last_nudge_level FROM session_meta WHERE session_id = ?",
            )
            .get(sessionId) as SessionCalibrationRow | undefined;
    } catch {
        try {
            return db
                .prepare(
                    "SELECT COALESCE(NULLIF(cached_m0_model_key, ''), last_observed_model_key) AS model_key, deferred_execute_state FROM session_meta WHERE session_id = ?",
                )
                .get(sessionId) as SessionCalibrationRow | undefined;
        } catch {
            return undefined;
        }
    }
}

function splitCanonicalModelKey(modelKey: string): { providerId: string; modelId: string } {
    const slash = modelKey.indexOf("/");
    return slash > 0
        ? { providerId: modelKey.slice(0, slash), modelId: modelKey.slice(slash + 1) }
        : { providerId: "unknown", modelId: "unknown" };
}

function freezeCalibration(calibration: DecisionCalibration): FrozenSessionDecisionCalibration {
    const identity = splitCanonicalModelKey(calibration.modelKey);
    return {
        revision: calibration.revision,
        providerId: identity.providerId,
        modelId: identity.modelId,
        systemRatio: calibration.systemRatio,
        toolsRatio: calibration.toolsRatio,
        proseRatio: calibration.proseRatio,
        source: calibration.source,
    };
}

function thawCalibration(frozen: FrozenSessionDecisionCalibration): DecisionCalibration {
    const seeded =
        frozen.source === "family-fallback" ||
        frozen.systemRatio !== 1 ||
        frozen.toolsRatio !== 1 ||
        frozen.proseRatio !== 1;
    return Object.freeze({
        modelKey: `${frozen.providerId}/${frozen.modelId}`.toLowerCase(),
        revision: frozen.revision,
        seeded,
        source: frozen.source,
        systemRatio: frozen.systemRatio,
        toolsRatio: frozen.toolsRatio,
        proseRatio: frozen.proseRatio,
    });
}

function sameCalibration(
    left: FrozenSessionDecisionCalibration,
    right: FrozenSessionDecisionCalibration,
): boolean {
    return (
        left.revision === right.revision &&
        left.providerId === right.providerId &&
        left.modelId === right.modelId &&
        left.systemRatio === right.systemRatio &&
        left.toolsRatio === right.toolsRatio &&
        left.proseRatio === right.proseRatio &&
        left.source === right.source
    );
}

function persistNamespace(
    db: Database,
    sessionId: string,
    root: Record<string, unknown>,
    namespace: CalibrationStateNamespace,
): void {
    root[CALIBRATION_STATE_KEY] = namespace;
    db.prepare("UPDATE session_meta SET deferred_execute_state = ? WHERE session_id = ?").run(
        JSON.stringify(root),
        sessionId,
    );
}

/**
 * Read the calibration frozen with the active session generation. A new table is
 * adopted only when the caller already has permission to replace cached decisions.
 */
export function sessionDecisionCalibration(
    db: Database,
    sessionId: string,
    pass?: SessionDecisionCalibrationPass,
): DecisionCalibration {
    const row = readSessionRow(db, sessionId);
    const root = parseStateRoot(row?.deferred_execute_state);
    const namespace = parseNamespace(root);
    if (!pass?.bustPermitted) {
        return namespace.active
            ? thawCalibration(namespace.active)
            : resolveDecisionCalibration(undefined, undefined);
    }

    const key = piModelRefToCanonical(pass.modelKey ?? row?.model_key ?? "");
    const candidate = freezeCalibration(calibrationForModelKey(key));
    if (!namespace.active || !sameCalibration(namespace.active, candidate)) {
        const previousRevision = namespace.active?.revision ?? "unfrozen";
        persistNamespace(db, sessionId, root, { ...namespace, active: candidate });
        if (namespace.active) {
            pass.onAdopt?.(
                `calibration revision ${previousRevision} → ${candidate.revision} adopted (bust=${pass.bustReason ?? "unknown"})`,
            );
        }
    }
    return thawCalibration(candidate);
}

/**
 * The session's frozen calibration as the emergency tool drop measures with it,
 * read without changing session state.
 *
 * It differs from `sessionDecisionCalibration` in one way: it also reads back a
 * calibration saved with the `model-id` source (a proxy or relay route whose
 * model is recognised only by its model id). The shared reader rejects that
 * source, so every caller that reads the saved calibration gets the neutral
 * 1:1 ratios for it. Only a caller allowed to adopt a calibration gets the
 * model's own ratios back, and on OpenCode that caller only saves it and does
 * not use the value. Changing the shared reader would move the thresholds of
 * every lane on those routes, on passes far below the force band. The
 * emergency drop measures the fixed part of the request and the tags it may
 * drop with one object from here, so both sides of its arithmetic use the
 * same ratios.
 */
export function sessionEmergencyCalibration(db: Database, sessionId: string): DecisionCalibration {
    const row = readSessionRow(db, sessionId);
    const namespace = parseNamespace(parseStateRoot(row?.deferred_execute_state), true);
    return namespace.active
        ? thawCalibration(namespace.active)
        : resolveDecisionCalibration(undefined, undefined);
}

/** Return the durable hygiene unit version without changing session state. */
export function sessionHygieneUnitsVersion(db: Database, sessionId: string): number {
    const row = readSessionRow(db, sessionId);
    return parseNamespace(parseStateRoot(row?.deferred_execute_state)).hygieneUnitsVersion ?? 1;
}

function parseNudgeLevelState(raw: string | null | undefined): Record<string, unknown> | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as unknown;
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? { ...(parsed as Record<string, unknown>) }
            : null;
    } catch {
        return null;
    }
}

function scaledWatermark(value: unknown, ratio: number): number | null {
    return typeof value === "number" && Number.isFinite(value)
        ? Math.max(0, Math.round(value * ratio))
        : null;
}

/**
 * Convert persisted Channel-1 U watermarks exactly once when provider hygiene
 * units first become active. Defer passes leave both the stamp and old arithmetic untouched.
 */
export function transitionSessionHygieneUnits(
    db: Database,
    sessionId: string,
    bustPermitted: boolean,
    calibration: DecisionCalibration,
): number {
    const before = sessionHygieneUnitsVersion(db, sessionId);
    if (before >= HYGIENE_PROVIDER_UNITS_VERSION || !bustPermitted) return before;

    return db
        .transaction(() => {
            const row = readSessionRow(db, sessionId);
            const root = parseStateRoot(row?.deferred_execute_state);
            const namespace = parseNamespace(root);
            if ((namespace.hygieneUnitsVersion ?? 1) >= HYGIENE_PROVIDER_UNITS_VERSION) {
                return HYGIENE_PROVIDER_UNITS_VERSION;
            }

            const lastNudge = scaledWatermark(row?.last_nudge_undropped, calibration.toolsRatio);
            const nudgeLevel = parseNudgeLevelState(row?.last_nudge_level);
            if (nudgeLevel) {
                const grace = scaledWatermark(
                    nudgeLevel.postReduceGraceBaselineU,
                    calibration.toolsRatio,
                );
                if (grace !== null) nudgeLevel.postReduceGraceBaselineU = grace;
            }
            db.prepare(
                "UPDATE session_meta SET last_nudge_undropped = COALESCE(?, last_nudge_undropped), last_nudge_level = COALESCE(?, last_nudge_level) WHERE session_id = ?",
            ).run(lastNudge, nudgeLevel ? JSON.stringify(nudgeLevel) : null, sessionId);
            persistNamespace(db, sessionId, root, {
                ...namespace,
                hygieneUnitsVersion: HYGIENE_PROVIDER_UNITS_VERSION,
            });
            return HYGIENE_PROVIDER_UNITS_VERSION;
        })
        .immediate();
}
