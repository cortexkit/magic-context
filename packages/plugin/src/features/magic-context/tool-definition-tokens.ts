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
 * The store lives entirely in-memory. A process restart re-measures on the
 * first turn, which is essentially free; persisting these values across
 * restarts would add schema/migration cost for no user-visible benefit.
 */

import { estimateTokens } from "../../hooks/magic-context/read-session-formatting";

// Inner map: toolID → measured tokens for that tool (description + params).
// Outer map: composite key → per-tool breakdown.
const measurements = new Map<string, Map<string, number>>();

function keyFor(providerID: string, modelID: string, agentName: string | undefined): string {
    const agent = agentName && agentName.length > 0 ? agentName : "default";
    return `${providerID}/${modelID}/${agent}`;
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
