export const COMPARTMENT_RENDER_EPOCH = "cre2";
export const MEMORY_RENDER_FORMAT_EPOCH = "mre3";

const EPOCH_COMPONENT_PREFIX = "|compartment-render:";
const MEMORY_EPOCH_COMPONENT_PREFIX = "|memory-render:";
const MURAL_COMPONENT_PREFIX = "|mural-enabled:";
const BUDGET_COMPONENT_PREFIX = "|render-budgets:";
const RENDERED_BUDGETS_COMPONENT_PREFIX = "|rendered-budgets:";
const M0_MEMORY_IDS_COMPONENT_PREFIX = "|m0-memory-ids:";

export interface CachedM0UpgradeIdentity {
    upgradeState: string | null;
    compartmentRenderEpoch: string | null;
    memoryRenderEpoch: string | null;
    muralEnabled: boolean | null;
    renderBudgetIdentity: string | null;
    renderedBudgets: string | null;
}

/**
 * Store renderer and render-config identity in the existing cached upgrade-state marker.
 * Provider-visible byte changes must change this identity so each cached m[0] folds exactly once.
 */
export function encodeCachedM0UpgradeIdentity(
    upgradeState: string | null,
    compartmentRenderEpoch: string | null = COMPARTMENT_RENDER_EPOCH,
    muralEnabled: boolean | null = null,
    renderBudgetIdentity: string | null = null,
    memoryRenderEpoch: string | null = MEMORY_RENDER_FORMAT_EPOCH,
    renderedBudgets: string | null = null,
): string | null {
    let encoded = upgradeState ?? "";
    if (compartmentRenderEpoch !== null) {
        encoded += `${EPOCH_COMPONENT_PREFIX}${compartmentRenderEpoch}`;
    }
    if (memoryRenderEpoch !== null) {
        encoded += `${MEMORY_EPOCH_COMPONENT_PREFIX}${memoryRenderEpoch}`;
    }
    if (muralEnabled !== null) {
        encoded += `${MURAL_COMPONENT_PREFIX}${muralEnabled ? "1" : "0"}`;
    }
    if (renderBudgetIdentity !== null) {
        encoded += `${BUDGET_COMPONENT_PREFIX}${renderBudgetIdentity}`;
    }
    if (renderedBudgets !== null) {
        encoded += `${RENDERED_BUDGETS_COMPONENT_PREFIX}${renderedBudgets}`;
    }
    return encoded.length > 0 ? encoded : null;
}

function component(value: string, prefix: string): string | null {
    const start = value.lastIndexOf(prefix);
    if (start < 0) return null;
    const valueStart = start + prefix.length;
    const end = value.indexOf("|", valueStart);
    const result = value.slice(valueStart, end < 0 ? value.length : end);
    return result.length > 0 ? result : null;
}

export function decodeCachedM0UpgradeIdentity(value: string | null): CachedM0UpgradeIdentity {
    if (value === null) {
        return {
            upgradeState: null,
            compartmentRenderEpoch: null,
            memoryRenderEpoch: null,
            muralEnabled: null,
            renderBudgetIdentity: null,
            renderedBudgets: null,
        };
    }
    const componentIndexes = [
        value.indexOf(EPOCH_COMPONENT_PREFIX),
        value.indexOf(MEMORY_EPOCH_COMPONENT_PREFIX),
        value.indexOf(MURAL_COMPONENT_PREFIX),
        value.indexOf(BUDGET_COMPONENT_PREFIX),
        value.indexOf(RENDERED_BUDGETS_COMPONENT_PREFIX),
        value.indexOf(M0_MEMORY_IDS_COMPONENT_PREFIX),
    ].filter((index) => index >= 0);
    const identityEnd = componentIndexes.length > 0 ? Math.min(...componentIndexes) : value.length;
    const upgradeState = value.slice(0, identityEnd);
    const muralComponent = component(value, MURAL_COMPONENT_PREFIX);
    return {
        upgradeState: upgradeState.length > 0 ? upgradeState : null,
        compartmentRenderEpoch: component(value, EPOCH_COMPONENT_PREFIX),
        memoryRenderEpoch: component(value, MEMORY_EPOCH_COMPONENT_PREFIX),
        muralEnabled: muralComponent === "1" ? true : muralComponent === "0" ? false : null,
        renderBudgetIdentity: component(value, BUDGET_COMPONENT_PREFIX),
        renderedBudgets: component(value, RENDERED_BUDGETS_COMPONENT_PREFIX),
    };
}

/**
 * Keep the frozen m[0] selection separate from the visible m[0]+m[1] manifest.
 * A forced replacement in m[1] can be below the baseline id watermark, so the
 * watermark alone cannot recover m[0]'s ids on the next refresh. Recording them
 * in the existing snapshot metadata avoids parsing ids out of memory content.
 */
export function withCachedM0MemoryIds(identity: string | null, ids: readonly number[]): string {
    const withoutIds = (identity ?? "").replace(/\|m0-memory-ids:[^|]*/g, "");
    return `${withoutIds}${M0_MEMORY_IDS_COMPONENT_PREFIX}${JSON.stringify(ids)}`;
}

export function readCachedM0MemoryIds(
    identity: string | null,
    legacyVisibleIds: readonly number[],
    maxMemoryId: number,
): number[] {
    const encoded = component(identity ?? "", M0_MEMORY_IDS_COMPONENT_PREFIX);
    if (encoded !== null) {
        try {
            const ids: unknown = JSON.parse(encoded);
            if (Array.isArray(ids) && ids.every((id) => Number.isSafeInteger(id) && id > 0)) {
                return ids;
            }
        } catch {
            // Malformed metadata must not invent visible ids.
        }
    }
    // Before the full visible manifest was recorded, Pi stored only m[0] ids;
    // OpenCode also stored additive m[1] ids, all above this watermark.
    return legacyVisibleIds.filter((id) => id <= maxMemoryId);
}

/** Compare recorded render budgets while lazily adopting older numeric history identities. */
export function renderBudgetIdentityChanged(cached: string, current: string): boolean {
    const legacy = /^(m[^-]+)-h\d+$/.exec(cached);
    if (legacy && current.startsWith("m") && current.includes("-hp")) {
        // Older history numbers include the observed model window, not just user
        // config. They cannot identify a policy edit. Record the new history policy
        // when another trigger rebuilds m[0]; a changed absolute memory budget must
        // still rebuild immediately.
        return legacy[1] !== current.slice(0, current.indexOf("-h"));
    }
    return cached !== current;
}

/** Numeric allowances supplied to a render, separate from its stable config identity. */
export function renderedBudgetSnapshot(memoryTokens: number, historyTokens: number): string {
    return `m${memoryTokens}-h${historyTokens}`;
}

function readRenderedBudgets(
    value: string | null | undefined,
): { memory: number; history: number } | null {
    const match = value?.match(/^m(\d+(?:\.\d+)?)-h(\d+(?:\.\d+)?)$/);
    if (!match) return null;
    const memory = Number(match[1]);
    const history = Number(match[2]);
    return Number.isFinite(memory) && Number.isFinite(history) ? { memory, history } : null;
}

/**
 * A larger live allowance keeps the cached prefix. A decrease in either allowance
 * beyond 64 tokens or 1% of its recorded value (whichever is larger) requires a
 * HARD rebuild before delivery so history rendered for a larger window can shrink.
 */
export function renderedBudgetShrinkReason(
    cached: string | null | undefined,
    current: string | null | undefined,
): string | null {
    const before = readRenderedBudgets(cached);
    const after = readRenderedBudgets(current);
    if (!before || !after) return null;
    // Compare the live allowance with the allowance recorded for the cached
    // render, not a rolling observation. Several small decreases must eventually
    // trigger once their total exceeds the tolerance; growth never triggers.
    const shrunk = (oldTokens: number, newTokens: number) =>
        oldTokens - newTokens > Math.max(64, oldTokens * 0.01);
    return shrunk(before.memory, after.memory) || shrunk(before.history, after.history)
        ? `render_config:budget_shrink(${cached}→${current})`
        : null;
}
