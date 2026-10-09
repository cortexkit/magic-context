import { type ContextDatabase, updateSessionMeta } from "../../features/magic-context/storage";
import { piModelRefToCanonical } from "../../shared/harness-provider-map";
import { sessionLog } from "../../shared/logger";
import { providerResponseFailed } from "../../shared/provider-response-completion";
import { withReadOnlySessionDb } from "./read-session-db";

const KEY = "opencodeProvenInputFloor";

/** Record only the unscaled maximum of accepted provider input measurements. */
export function recordOpenCodeProvenInputFloor(
    db: ContextDatabase,
    sessionId: string,
    modelKey: string,
    tokens: number,
): void {
    db.prepare(`UPDATE session_meta SET deferred_execute_state = json_set(
        CASE WHEN json_valid(deferred_execute_state) AND json_type(deferred_execute_state) = 'object'
             THEN deferred_execute_state ELSE '{}' END, '$.${KEY}', json(?)) WHERE session_id = ?`).run(
        JSON.stringify({ modelKey, tokens, basis: "provider_usage_v1" }),
        sessionId,
    );
}

function largestAcceptedInput(sessionId: string, modelKey: string): number {
    return withReadOnlySessionDb((db) => {
        const rows = db
            .prepare(`SELECT
            COALESCE(json_extract(data, '$.providerID'), json_extract(data, '$.model.providerID')) AS provider,
            COALESCE(json_extract(data, '$.modelID'), json_extract(data, '$.model.id')) AS model,
            json_extract(data, '$.finish') AS finish, json_extract(data, '$.error') AS error,
            json_extract(data, '$.tokens.input') AS input,
            json_extract(data, '$.tokens.cache.read') AS cacheRead,
            json_extract(data, '$.tokens.cache.write') AS cacheWrite
            FROM message WHERE session_id = ? AND json_valid(data)
            AND json_extract(data, '$.role') = 'assistant'`)
            .all(sessionId) as Array<{
            provider?: string;
            model?: string;
            finish?: unknown;
            error?: unknown;
            input?: number;
            cacheRead?: number;
            cacheWrite?: number;
        }>;
        let largest = 0;
        for (const row of rows) {
            if (
                !row.provider ||
                !row.model ||
                piModelRefToCanonical(`${row.provider}/${row.model}`) !==
                    piModelRefToCanonical(modelKey) ||
                providerResponseFailed(row)
            )
                continue;
            const components = [row.input ?? 0, row.cacheRead ?? 0, row.cacheWrite ?? 0];
            if (components.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)) {
                largest = Math.max(
                    largest,
                    components.reduce((sum, n) => sum + n, 0),
                );
            }
        }
        return largest;
    });
}

/** Clamp a legacy latch to accepted measurements, once, before TS or Rust consumes it. */
export function resolveOpenCodeProvenInputFloor(
    db: ContextDatabase,
    sessionId: string,
    modelKey: string | undefined,
): number {
    // Geometry is a hot path. Do not fetch the session's cached prompt BLOBs
    // just to validate the much smaller measurement record.
    const row = db
        .prepare(
            "SELECT observed_safe_input_tokens, last_observed_model_key, deferred_execute_state FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId) as
        | {
              observed_safe_input_tokens: number;
              last_observed_model_key?: string;
              deferred_execute_state?: string;
          }
        | undefined;
    const stored = row?.observed_safe_input_tokens ?? 0;
    if (
        !modelKey ||
        piModelRefToCanonical(row?.last_observed_model_key ?? "") !==
            piModelRefToCanonical(modelKey) ||
        !Number.isFinite(stored) ||
        stored <= 0
    )
        return 0;
    try {
        const record = JSON.parse(row?.deferred_execute_state ?? "{}")[KEY];
        if (
            record?.basis === "provider_usage_v1" &&
            record.modelKey === modelKey &&
            record.tokens === stored
        )
            return stored;
    } catch {
        /* An unreadable state document proves no measured basis. */
    }
    let measured = 0;
    try {
        measured = largestAcceptedInput(sessionId, modelKey);
    } catch {
        // Missing history cannot justify retaining an unverified legacy floor.
    }
    const repaired = Math.min(stored, measured);
    updateSessionMeta(db, sessionId, {
        observedSafeInputTokens: repaired,
        cacheAlertSent: false,
        lastUsageContextLimit: 0,
    });
    recordOpenCodeProvenInputFloor(db, sessionId, modelKey, repaired);
    sessionLog(
        sessionId,
        `legacy proven input floor ${stored} clamped to accepted provider usage: ${repaired}`,
    );
    return repaired;
}
