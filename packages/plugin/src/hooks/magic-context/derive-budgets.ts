/**
 * Budget derivation
 *
 * Two scaling bases, two clamps. Replaces the old static
 * `compartment_token_budget` setting which tried to serve both roles
 * and scaled with neither model.
 *
 *   - triggerBudget: scales with (main model × executeThreshold).
 *     Drives size-based historian triggers (`tail_size`, `commit_clusters`).
 *     "How big can the uncompartmentalized tail get before we force
 *     historian to run." This is anchored to the MAIN model's usable
 *     working space, not its total context.
 *
 *   - historianChunkTokens: scales with the HISTORIAN model's context.
 *     The raw-history window historian processes per call. Different
 *     scaling basis because historian is a single-shot summarizer bound
 *     by its own context, not the main session's pressure math.
 */

import { HISTORIAN_AGENT } from "../../agents/historian";
import { AGENT_MODEL_REQUIREMENTS, expandFallbackChain } from "../../shared/model-requirements";
import { getModelsDevContextLimit } from "../../shared/models-dev-cache";

// 5% of (main_context × execute_threshold) is the "working usable × 5%" basis.
// This preserves the legacy static behavior for 1M × 40% (60K tail_size ≈ 15%
// of usable) while fixing the small-context regression where the old 60K tail
// threshold was 72% of usable on 128K × 65%.
const TRIGGER_BUDGET_PERCENTAGE = 0.05;
const TRIGGER_BUDGET_MIN = 5_000;
const TRIGGER_BUDGET_MAX = 50_000;

const HISTORIAN_CHUNK_PERCENTAGE = 0.25;
const HISTORIAN_CHUNK_MIN = 8_000;
const HISTORIAN_CHUNK_MAX = 50_000;

const DEFAULT_HISTORIAN_CONTEXT_FALLBACK = 128_000;

/**
 * Budget basis for size-based historian triggers (tail_size, commit_clusters).
 * Anchored to the MAIN model's usable working space, not its total context.
 *
 * @param mainContextLimit Main session model's context window (tokens).
 * @param executeThresholdPercentage The effective execute threshold (0-100).
 */
export function deriveTriggerBudget(
    mainContextLimit: number,
    executeThresholdPercentage: number,
): number {
    if (!Number.isFinite(mainContextLimit) || mainContextLimit <= 0) {
        return TRIGGER_BUDGET_MIN;
    }
    // Callers resolve executeThresholdPercentage through resolveExecuteThreshold(),
    // which caps at MAX_EXECUTE_THRESHOLD (80). We still guard against negative
    // inputs so derived budgets never go upside-down, but the upper clamp is
    // not needed and was dead defensively.
    const thresholdFraction = Math.max(0, executeThresholdPercentage) / 100;
    const usable = mainContextLimit * thresholdFraction;
    const derived = Math.round(usable * TRIGGER_BUDGET_PERCENTAGE);
    return Math.max(TRIGGER_BUDGET_MIN, Math.min(TRIGGER_BUDGET_MAX, derived));
}

/**
 * Raw-history chunk budget for historian's own context window.
 * Historian formats tool calls as compact `TC:` summaries and drops tool results,
 * so a 50K-token chunk typically represents far more raw messages than its token
 * count implies. The max is tuned around that compression.
 *
 * @param historianContextLimit Historian model's context window (tokens).
 */
export function deriveHistorianChunkTokens(historianContextLimit: number): number {
    if (!Number.isFinite(historianContextLimit) || historianContextLimit <= 0) {
        return HISTORIAN_CHUNK_MIN;
    }
    const derived = Math.round(historianContextLimit * HISTORIAN_CHUNK_PERCENTAGE);
    return Math.max(HISTORIAN_CHUNK_MIN, Math.min(HISTORIAN_CHUNK_MAX, derived));
}

/**
 * Resolve the historian model's context limit for chunk budget sizing.
 *
 * Behavior:
 *   - If `historianModelOverride` is a full `provider/model-id` → use that model's
 *     context directly. This honors explicit user intent.
 *   - If the override is set but lacks `/` (e.g. `"llama3-32k"`) → warn and fall
 *     through to the fallback chain, since we can't look up models without a
 *     provider and silently ignoring would produce incorrect chunk sizes.
 *   - If no override → scan the expanded fallback chain (all `provider/model`
 *     combinations OpenCode might try) and use the MINIMUM resolved context.
 *     This is defensive: if the first-choice model is unavailable and OpenCode
 *     falls back to a smaller-context entry, the chunk budget is still safe.
 *   - If neither models.dev nor opencode.json custom providers know the model,
 *     fall back to 128K as a conservative default.
 *
 * Context limits are resolved through `getModelsDevContextLimit`, which reads
 * both OpenCode's models.dev cache and custom `provider.*.models.*.limit.context`
 * entries from `opencode.json(c)`.
 */
export function resolveHistorianContextLimit(historianModelOverride?: string): number {
    // Explicit override with full provider/model form — user intent wins.
    if (typeof historianModelOverride === "string" && historianModelOverride.includes("/")) {
        const [providerID, ...rest] = historianModelOverride.split("/");
        const modelID = rest.join("/");
        if (providerID && modelID) {
            const limit = getModelsDevContextLimit(providerID, modelID);
            if (typeof limit === "number" && limit > 0) return limit;
        }
        return DEFAULT_HISTORIAN_CONTEXT_FALLBACK;
    }

    // Warn-and-fall-through for malformed overrides (Finding #4 sub-fix).
    if (typeof historianModelOverride === "string" && historianModelOverride.trim() !== "") {
        // Intentional: this is a config error we surface at log level, not a crash,
        // because the fallback chain still produces a workable budget.
        // eslint-disable-next-line no-console
        console.warn(
            `[magic-context] historian.model "${historianModelOverride}" lacks provider prefix ("provider/model-id"); using fallback chain for chunk-budget derivation.`,
        );
    }

    // Defensive minimum across the full expanded chain. This protects against
    // the first-choice model being unavailable and OpenCode falling back to a
    // smaller-context entry that would overflow with the larger chunk budget.
    const chain = AGENT_MODEL_REQUIREMENTS[HISTORIAN_AGENT]?.fallbackChain;
    if (!chain || chain.length === 0) return DEFAULT_HISTORIAN_CONTEXT_FALLBACK;
    const expanded = expandFallbackChain(chain);

    let minLimit: number | undefined;
    for (const key of expanded) {
        const [providerID, ...rest] = key.split("/");
        const modelID = rest.join("/");
        if (!providerID || !modelID) continue;
        const limit = getModelsDevContextLimit(providerID, modelID);
        if (typeof limit !== "number" || limit <= 0) continue;
        if (minLimit === undefined || limit < minLimit) minLimit = limit;
    }
    return minLimit ?? DEFAULT_HISTORIAN_CONTEXT_FALLBACK;
}
