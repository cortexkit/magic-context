export const COMPARTMENT_RENDER_EPOCH = "cre2";

const EPOCH_COMPONENT_PREFIX = "|compartment-render:";
const MURAL_COMPONENT_PREFIX = "|mural-enabled:";
const BUDGET_COMPONENT_PREFIX = "|render-budgets:";
/**
 * Present only when the empty-sentinel capability was widened by the adapter
 * registry (a non-canonical provider serving Claude on `@ai-sdk/anthropic`).
 * Absence therefore means "not registry-widened", which is the correct reading
 * for both a canonical Anthropic session and a legacy row written before this
 * component existed. That asymmetry is deliberate: unlike mural/budget, a
 * missing component here is a KNOWN prior state, not an unknown one, so a
 * widened session folds once instead of adopting silently.
 */
const ANTHROPIC_WIRE_COMPONENT_PREFIX = "|anthropic-wire:";

export interface CachedM0UpgradeIdentity {
    upgradeState: string | null;
    compartmentRenderEpoch: string | null;
    muralEnabled: boolean | null;
    renderBudgetIdentity: string | null;
    /** True only when the adapter registry widened the empty-sentinel gate. */
    anthropicWireWidened: boolean;
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
    anthropicWireWidened = false,
): string | null {
    let encoded = upgradeState ?? "";
    if (compartmentRenderEpoch !== null) {
        encoded += `${EPOCH_COMPONENT_PREFIX}${compartmentRenderEpoch}`;
    }
    if (muralEnabled !== null) {
        encoded += `${MURAL_COMPONENT_PREFIX}${muralEnabled ? "1" : "0"}`;
    }
    if (renderBudgetIdentity !== null) {
        encoded += `${BUDGET_COMPONENT_PREFIX}${renderBudgetIdentity}`;
    }
    if (anthropicWireWidened) {
        encoded += `${ANTHROPIC_WIRE_COMPONENT_PREFIX}1`;
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
            muralEnabled: null,
            renderBudgetIdentity: null,
            anthropicWireWidened: false,
        };
    }
    const componentIndexes = [
        value.indexOf(EPOCH_COMPONENT_PREFIX),
        value.indexOf(MURAL_COMPONENT_PREFIX),
        value.indexOf(BUDGET_COMPONENT_PREFIX),
        value.indexOf(ANTHROPIC_WIRE_COMPONENT_PREFIX),
    ].filter((index) => index >= 0);
    const identityEnd = componentIndexes.length > 0 ? Math.min(...componentIndexes) : value.length;
    const upgradeState = value.slice(0, identityEnd);
    const muralComponent = component(value, MURAL_COMPONENT_PREFIX);
    return {
        upgradeState: upgradeState.length > 0 ? upgradeState : null,
        compartmentRenderEpoch: component(value, EPOCH_COMPONENT_PREFIX),
        muralEnabled: muralComponent === "1" ? true : muralComponent === "0" ? false : null,
        renderBudgetIdentity: component(value, BUDGET_COMPONENT_PREFIX),
        anthropicWireWidened: component(value, ANTHROPIC_WIRE_COMPONENT_PREFIX) === "1",
    };
}
