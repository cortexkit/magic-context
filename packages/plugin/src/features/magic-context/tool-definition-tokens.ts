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
 *
 * Hot-path optimization: `tool.definition` fires once per tool per LLM
 * flight (~58 tools × 5–18ms SQLite write = ~1.4s of redundant work per
 * flight on large MC databases). Tool descriptions and parameters almost
 * never change between flights, so we keep a per-key content-fingerprint
 * Map and bail out at the top of `recordToolDefinition` when the new fire
 * carries the same fingerprint as the previous one. This collapses
 * steady-state hook overhead from ~1.4s to <1ms while still re-measuring
 * any tool whose description/schema actually changed (e.g. MCP server
 * restart, OpenCode upgrade). Cached prepared statement avoids repeated
 * `db.prepare()` compile cost on first-flight rebuilds.
 */

import { createHash } from "node:crypto";
import { estimateTokens } from "../../hooks/magic-context/read-session-formatting";
import type { Database, Statement } from "../../shared/sqlite";
import { stableStringify } from "../../shared/stable-json";

// Inner map: toolID → measured tokens for that tool (description + params).
// Outer map: composite key → per-tool breakdown.
const measurements = new Map<string, Map<string, number>>();

// Parallel structure: composite key → toolID → cheap content fingerprint
// derived from the inputs of the previous fire. Used solely to short-circuit
// repeated identical fires; the actual measurement still lives in the
// `measurements` map above. Cleared together with `measurements` on reset.
const fingerprints = new Map<string, Map<string, string>>();

// Database reference for persistence. Set by setDatabase() once
// openDatabase() has finished migrations. Until then, recordToolDefinition
// only updates the in-memory map (lossy, but the next call after init will
// land in SQLite).
let persistenceDb: Database | null = null;

// Cached INSERT OR REPLACE statement — recompiling on every fire was a
// significant share of the hot-path cost. Initialized lazily on first use
// after `setDatabase()` and dropped on reset / DB rebind.
let cachedInsertStmt: Statement | null = null;

function keyFor(providerID: string, modelID: string, agentName: string | undefined): string {
    const agent = agentName && agentName.length > 0 ? agentName : "default";
    return `${providerID}/${modelID}/${agent}`;
}

/**
 * Build a stable fingerprint of all inputs that determine the measured value.
 * Correctness beats the prior shallow optimization: nested schema changes must
 * invalidate cached token counts too.
 */
function fingerprintFor(description: string, parameters: unknown): string {
    return createHash("sha256")
        .update(description)
        .update("\0")
        .update(stableStringify(parameters))
        .digest("hex");
}

/**
 * Register the database used to persist measurements. Called by
 * openDatabase() after runMigrations() has ensured the
 * `tool_definition_measurements` table exists. Subsequent
 * recordToolDefinition() calls will write through to SQLite.
 */
export function setDatabase(db: Database): void {
    persistenceDb = db;
    // New DB binding invalidates any cached statement compiled against the
    // previous handle.
    cachedInsertStmt = null;
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
    // Note: we deliberately do NOT seed `fingerprints` from DB here. The
    // first fire after restart will compute a real fingerprint, find no
    // entry, do the work once, and store both. This means the very first
    // flight after restart pays full measurement cost (~1.4s on a large
    // tool set) but every subsequent flight skips it — same steady-state
    // behavior as before-restart.
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

    // Fast-path skip: if this exact tool's last fire under this key carried
    // an identical fingerprint, every downstream operation (stringify,
    // tokenize, map write, SQLite write) would produce the same result.
    // Bail out before doing any of them.
    const fp = fingerprintFor(description ?? "", parameters);
    let innerFp = fingerprints.get(key);
    if (innerFp && innerFp.get(toolID) === fp) return;

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

    // Update fingerprint AFTER the in-memory map so a thrown error above
    // doesn't poison the skip-check on the next fire. (Currently nothing
    // above can throw post-guard, but the ordering is intentionally
    // defensive.)
    if (!innerFp) {
        innerFp = new Map<string, string>();
        fingerprints.set(key, innerFp);
    }
    innerFp.set(toolID, fp);

    // Write-through to SQLite so the value survives a plugin restart.
    // Skipped silently when the DB isn't wired yet (cold path before
    // openDatabase has finished init): the in-memory map still has the
    // value, and the next recordToolDefinition() after init lands both.
    if (persistenceDb) {
        try {
            const agent = agentName && agentName.length > 0 ? agentName : "default";
            // Compile statement once per DB binding. `.run()` is reusable
            // across calls with different bound values.
            if (!cachedInsertStmt) {
                cachedInsertStmt = persistenceDb.prepare(
                    `INSERT OR REPLACE INTO tool_definition_measurements
                     (provider_id, model_id, agent_name, tool_id, token_count, recorded_at)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                );
            }
            cachedInsertStmt.run(providerID, modelID, agent, toolID, tokens, Date.now());
        } catch {
            // Persistence is best-effort. A SQLITE_BUSY or transient write
            // failure must not break the live measurement: the in-memory
            // map already has the new value and the sidebar will display
            // it correctly until the next plugin restart.
            // Drop the cached statement on error — if the DB connection
            // went bad, recompiling on the next attempt is the safe move.
            cachedInsertStmt = null;
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
    fingerprints.clear();
    persistenceDb = null;
    cachedInsertStmt = null;
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
