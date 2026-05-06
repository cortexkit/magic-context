/**
 * Tool-definition token measurement store.
 *
 * OpenCode's `tool.definition` hook fires once per tool per
 * `ToolRegistry.tools()` call, with `{ toolID }` as input and
 * `{ description, parameters }` as output. Crucially the hook input does NOT
 * carry `sessionID` — the tool set is computed per
 * `{providerID, modelID, agent}` combination, independent of session.
 *
 * We measure each tool's description + JSON-schema parameters, tokenize with
 * the same Claude tokenizer used everywhere else in the plugin, and store
 * per-tool totals keyed by `${providerID}/${modelID}/${agentName}`. Inner map
 * keys on `toolID` so every hook fire idempotently overwrites its own slot
 * (same tool set on each turn → same key → same measured total).
 *
 * Consumers (RPC sidebar/status handlers) look up the active session's
 * measurement via `getMeasuredToolDefinitionTokens(providerID, modelID,
 * agentName)`. Returns `undefined` when the key has never been measured — the
 * caller is expected to fall back to residual math or show zero.
 *
 * Persistence (v9+): measurements are also written to SQLite so that a
 * plugin restart can repopulate the in-memory map without waiting for the
 * next chat.message → tool.definition hook chain. The in-memory Map remains
 * the hot read path; SQLite is a write-through mirror that backs cold starts.
 * If `setDatabase()` hasn't been called yet (cold path before openDatabase
 * completes), `recordToolDefinition` still updates the in-memory map and
 * silently skips persistence — first measurement after init lands both.
 */

import { estimateTokens } from "../../hooks/magic-context/read-session-formatting";
import type { Database } from "../../shared/sqlite";

// Inner map: toolID → measured tokens for that tool (description + params).
// Outer map: composite key → per-tool breakdown.
const measurements = new Map<string, Map<string, number>>();

// Database reference for persistence. Set by setDatabase() once
// openDatabase() has finished migrations. Until then, recordToolDefinition
// only updates the in-memory map (lossy, but the next call after init will
// land in SQLite).
let persistenceDb: Database | null = null;

function keyFor(providerID: string, modelID: string, agentName: string | undefined): string {
    const agent = agentName && agentName.length > 0 ? agentName : "default";
    return `${providerID}/${modelID}/${agent}`;
}

/**
 * Register the database used to persist measurements. Called by
 * openDatabase() after runMigrations() has ensured the
 * `tool_definition_measurements` table exists. Subsequent
 * recordToolDefinition() calls will write through to SQLite.
 */
export function setDatabase(db: Database): void {
    persistenceDb = db;
}

/**
 * Populate the in-memory measurements map from the
 * `tool_definition_measurements` table. Called once at startup after
 * setDatabase(), before the first sidebar snapshot or status query, so the
 * sidebar's "Tool Defs" segment shows the correct value immediately on
 * restart instead of 0.
 *
 * Idempotent: re-running over the same DB reapplies the same values; the
 * inner-map key (toolID) ensures duplicates overwrite rather than accumulate.
 */
export function loadToolDefinitionMeasurements(db: Database): void {
    let rows: Array<{
        provider_id: string;
        model_id: string;
        agent_name: string;
        tool_id: string;
        token_count: number;
    }> = [];
    try {
        rows = db
            .prepare(
                "SELECT provider_id, model_id, agent_name, tool_id, token_count FROM tool_definition_measurements",
            )
            .all() as typeof rows;
    } catch {
        // Table doesn't exist yet — migrations haven't run. Nothing to load.
        return;
    }

    for (const row of rows) {
        const key = keyFor(row.provider_id, row.model_id, row.agent_name);
        let inner = measurements.get(key);
        if (!inner) {
            inner = new Map<string, number>();
            measurements.set(key, inner);
        }
        inner.set(row.tool_id, row.token_count);
    }
}

/**
 * Tokenize a single tool's schema and store it under the given key. Called
 * from the `tool.definition` plugin hook once per tool per flight. Same
 * toolID on a later flight overwrites its slot — the total for the key stays
 * consistent even if descriptions or parameters drift between turns.
 */
export function recordToolDefinition(
    providerID: string,
    modelID: string,
    agentName: string | undefined,
    toolID: string,
    description: string,
    parameters: unknown,
): void {
    if (!providerID || !modelID || !toolID) return;
    const key = keyFor(providerID, modelID, agentName);

    // Serialize parameters to match what the provider actually sees on the
    // wire. `JSON.stringify(undefined)` returns undefined, so guard that.
    let paramsText = "";
    try {
        paramsText = parameters === undefined ? "" : JSON.stringify(parameters);
    } catch {
        paramsText = "";
    }

    // Count: description + serialized params. This is the token cost of a
    // single tool's definition inside the `tools` array the provider
    // receives. Overhead around the array (field names, commas, braces) is
    // attributed to the separate "Overhead" bucket the RPC handler computes
    // as a residual against inputTokens.
    const tokens = estimateTokens(description ?? "") + estimateTokens(paramsText);

    let inner = measurements.get(key);
    if (!inner) {
        inner = new Map<string, number>();
        measurements.set(key, inner);
    }
    inner.set(toolID, tokens);

    // Write-through to SQLite so the value survives a plugin restart.
    // Skipped silently when the DB isn't wired yet (cold path before
    // openDatabase has finished init): the in-memory map still has the
    // value, and the next recordToolDefinition() after init lands both.
    if (persistenceDb) {
        try {
            const agent = agentName && agentName.length > 0 ? agentName : "default";
            persistenceDb
                .prepare(
                    `INSERT OR REPLACE INTO tool_definition_measurements
                     (provider_id, model_id, agent_name, tool_id, token_count, recorded_at)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                )
                .run(providerID, modelID, agent, toolID, tokens, Date.now());
        } catch {
            // Persistence is best-effort. A SQLITE_BUSY or transient write
            // failure must not break the live measurement: the in-memory
            // map already has the new value and the sidebar will display
            // it correctly until the next plugin restart.
        }
    }
}

/**
 * Returns the summed measured tokens for a `{provider, model, agent}` key,
 * or `undefined` when never measured (e.g. fresh session before first turn).
 */
export function getMeasuredToolDefinitionTokens(
    providerID: string,
    modelID: string,
    agentName: string | undefined,
): number | undefined {
    if (!providerID || !modelID) return undefined;
    const inner = measurements.get(keyFor(providerID, modelID, agentName));
    if (!inner || inner.size === 0) return undefined;
    let total = 0;
    for (const tokens of inner.values()) total += tokens;
    return total;
}

/** Test helper: reset the store so suites don't leak measurements. */
export function __resetToolDefinitionMeasurements(): void {
    measurements.clear();
    persistenceDb = null;
}

/** Inspection helper: snapshot the current store (for debug logging/tests). */
export function getToolDefinitionSnapshot(): Array<{
    key: string;
    totalTokens: number;
    toolCount: number;
}> {
    return Array.from(measurements.entries()).map(([key, inner]) => {
        let total = 0;
        for (const tokens of inner.values()) total += tokens;
        return { key, totalTokens: total, toolCount: inner.size };
    });
}
