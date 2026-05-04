/**
 * Per-model tokenizer calibration ratios.
 *
 * ai-tokenizer's `claude` / `o200k_base` / `cl100k_base` / `p50k_base` encodings
 * approximate provider tokenizers but drift from the API's actual count by
 * model-specific amounts. Empirically measured ratios from
 * `scripts/calibrate-tokenizer/` (sweep against real production system prompt
 * + 39 MCP-style tools + minimal conversation, comparing local count vs each
 * provider's own usage.input_tokens).
 *
 * `system_ratio = api_tokens / local_raw_tokens` for plain-text system prompts
 * `tools_ratio  = api_tokens / local_raw_tokens` for the tools array
 *
 * Multiplying the local count by these ratios yields the API's count.
 *
 * Pattern matching: longest prefix wins. Unknown models fall back to 1.0 / 1.0
 * (no calibration). Re-run the harness when adding new models or after a
 * provider tokenizer change.
 */

export interface ModelCalibration {
    systemRatio: number;
    toolsRatio: number;
}

interface CalibrationEntry extends ModelCalibration {
    /** Match against `${providerID}/${modelID}` (case-insensitive). Longest wins. */
    prefix: string;
}

/**
 * Empirically measured drift ratios. Order does not matter - longest prefix
 * is selected at lookup time. Verified models only; unknown models fall back
 * to 1.0/1.0 which is safer than guessing.
 */
const CALIBRATION_TABLE: CalibrationEntry[] = [
    // Anthropic Opus 4.7 — new tokenizer not yet in ai-tokenizer's claude encoding.
    { prefix: "anthropic/claude-opus-4-7", systemRatio: 1.51, toolsRatio: 1.57 },
    { prefix: "anthropic/claude-opus-4.7", systemRatio: 1.51, toolsRatio: 1.57 },
    // Claude 4.5/4.6 family — ai-tokenizer's claude encoding matches well.
    { prefix: "anthropic/claude-opus-4-5", systemRatio: 1.02, toolsRatio: 1.16 },
    { prefix: "anthropic/claude-opus-4.5", systemRatio: 1.02, toolsRatio: 1.16 },
    { prefix: "anthropic/claude-opus-4-6", systemRatio: 1.02, toolsRatio: 1.16 },
    { prefix: "anthropic/claude-opus-4.6", systemRatio: 1.02, toolsRatio: 1.16 },
    { prefix: "anthropic/claude-sonnet-4-5", systemRatio: 1.02, toolsRatio: 1.16 },
    { prefix: "anthropic/claude-sonnet-4.5", systemRatio: 1.02, toolsRatio: 1.16 },
    { prefix: "anthropic/claude-sonnet-4-6", systemRatio: 1.02, toolsRatio: 1.14 },
    { prefix: "anthropic/claude-sonnet-4.6", systemRatio: 1.02, toolsRatio: 1.14 },
    { prefix: "anthropic/claude-haiku-4-5", systemRatio: 1.02, toolsRatio: 1.16 },
    { prefix: "anthropic/claude-haiku-4.5", systemRatio: 1.02, toolsRatio: 1.16 },
    // Claude through OpenRouter / GitHub Copilot — same upstream tokenizer.
    // Opus 4.7 routed via OpenRouter / GitHub Copilot uses Anthropic's new
    // tokenizer too; without these entries the longest-prefix matcher falls
    // through to NEUTRAL (1.0/1.0) and the sidebar misattributes ~30K tokens
    // from System+ToolDefs into Conversation/ToolCalls. Sum-to-inputTokens is
    // still preserved (residuals absorb), but the per-bucket numbers drift.
    { prefix: "openrouter/anthropic/claude-opus-4-7", systemRatio: 1.51, toolsRatio: 1.57 },
    { prefix: "openrouter/anthropic/claude-opus-4.7", systemRatio: 1.51, toolsRatio: 1.57 },
    { prefix: "github-copilot/claude-opus-4-7", systemRatio: 1.51, toolsRatio: 1.57 },
    { prefix: "github-copilot/claude-opus-4.7", systemRatio: 1.51, toolsRatio: 1.57 },
    { prefix: "openrouter/anthropic/claude-sonnet-4.6", systemRatio: 1.02, toolsRatio: 1.14 },
    { prefix: "github-copilot/claude-sonnet-4.6", systemRatio: 1.02, toolsRatio: 1.14 },
    { prefix: "github-copilot/claude-sonnet-4.5", systemRatio: 1.02, toolsRatio: 1.16 },
    { prefix: "github-copilot/claude-opus-4.5", systemRatio: 1.02, toolsRatio: 1.16 },
    { prefix: "github-copilot/claude-haiku-4.5", systemRatio: 1.02, toolsRatio: 1.16 },
    // OpenAI gpt-5.x — ai-tokenizer's o200k_base matches exactly, tools overcounted ~16%.
    { prefix: "openai/gpt-5", systemRatio: 1.0, toolsRatio: 0.84 },
    // xAI Grok — ai-tokenizer overcounts (uses p50k_base which doesn't match Grok exactly).
    { prefix: "xai/grok-4", systemRatio: 0.82, toolsRatio: 0.88 },
    { prefix: "xai/grok-code-fast", systemRatio: 0.82, toolsRatio: 0.89 },
    // Cerebras — qwen tokenizer accurate, glm close, gpt-oss-120b overcounts heavily.
    { prefix: "cerebras/qwen-3-235b", systemRatio: 1.0, toolsRatio: 1.1 },
    { prefix: "cerebras/zai-glm-4.7", systemRatio: 1.0, toolsRatio: 1.09 },
    { prefix: "cerebras/gpt-oss-120b", systemRatio: 0.84, toolsRatio: 0.79 },
    // Fireworks — DeepSeek and GLM close, kimi diverges significantly.
    {
        prefix: "fireworks-ai/accounts/fireworks/models/glm-5p1",
        systemRatio: 1.0,
        toolsRatio: 1.06,
    },
    {
        prefix: "fireworks-ai/accounts/fireworks/models/deepseek-v3p2",
        systemRatio: 1.05,
        toolsRatio: 1.09,
    },
    // OpenCode-Go — same upstream open-weight providers.
    { prefix: "opencode-go/glm-5.1", systemRatio: 1.0, toolsRatio: 1.06 },
    { prefix: "opencode-go/glm-5", systemRatio: 1.0, toolsRatio: 1.06 },
    { prefix: "opencode-go/kimi-k2.6", systemRatio: 0.87, toolsRatio: 0.86 },
];

const NEUTRAL: ModelCalibration = { systemRatio: 1.0, toolsRatio: 1.0 };

/**
 * Look up calibration ratios for a given `providerID/modelID` key. Performs
 * longest-prefix match (case-insensitive). Returns neutral ratios (1.0/1.0)
 * for unknown models so the calibration is a no-op rather than incorrect.
 */
export function resolveModelCalibration(
    providerId: string | undefined,
    modelId: string | undefined,
): ModelCalibration {
    if (!providerId || !modelId) return NEUTRAL;
    const key = `${providerId}/${modelId}`.toLowerCase();
    let best: CalibrationEntry | null = null;
    for (const entry of CALIBRATION_TABLE) {
        const prefix = entry.prefix.toLowerCase();
        if (!key.startsWith(prefix)) continue;
        if (!best || prefix.length > best.prefix.length) {
            best = entry;
        }
    }
    return best ?? NEUTRAL;
}

/**
 * Apply calibration to local raw counts and absorb the residual into the
 * unknown-drift buckets so all categories sum to exactly inputTokens.
 *
 * Bucket policy by stability:
 *   1. **Calibrated** (System, Tool Defs) — local count × measured per-model
 *      ratio. We have empirically derived ratios from `scripts/calibrate-tokenizer/`,
 *      so these match the API to within ~5%.
 *   2. **Verbatim** (Compartments, Facts, Memories) — local raw count, no
 *      scaling. Magic-context owns this content end-to-end (rendered XML,
 *      injected via `prepareCompartmentInjection`), and the compressor uses
 *      the same local count for budget math (`execute-status.ts` "History
 *      block"). Showing a different number here would confuse users and
 *      desync the sidebar from `/ctx-status`.
 *   3. **Residual absorbers** (Conversation, Tool Calls) — proportionally
 *      scaled to absorb whatever's left after (1) and (2). These have the
 *      most genuine drift (mixed user/assistant text + tool I/O) and the
 *      least fixed structure, so attributing the unknown remainder here is
 *      the most honest mapping.
 *
 * Behavior at the edges:
 *   - inputTokens === 0 → returns all zeros.
 *   - residual local sum === 0 (no conversation or tool calls yet) →
 *     conversation absorbs the full remainder so the bar still adds up.
 *   - non-residual buckets together exceed inputTokens (rare clamp case) →
 *     residuals = 0; calibrated + verbatim are scaled down proportionally so
 *     the sum never exceeds inputTokens.
 *   - rounding: residual ±1 token from rounding lands in the larger residual
 *     bucket so exact equality is preserved.
 */
export interface CalibratedBuckets {
    systemTokens: number;
    toolDefinitionTokens: number;
    compartmentTokens: number;
    factTokens: number;
    memoryTokens: number;
    conversationTokens: number;
    toolCallTokens: number;
}

export interface CalibrationInput {
    inputTokens: number;
    /** Local raw count (ai-tokenizer) for the system prompt. */
    systemLocal: number;
    /** Local raw count (ai-tokenizer) for the tool definitions. */
    toolDefsLocal: number;
    /** Verbatim — local raw counts displayed unchanged so the sidebar matches `/ctx-status`. */
    compartmentsLocal: number;
    factsLocal: number;
    memoriesLocal: number;
    /** Residual absorbers — proportionally scaled to absorb the remainder. */
    conversationLocal: number;
    toolCallsLocal: number;
    calibration: ModelCalibration;
}

export function calibrateBuckets(input: CalibrationInput): CalibratedBuckets {
    const empty: CalibratedBuckets = {
        systemTokens: 0,
        toolDefinitionTokens: 0,
        compartmentTokens: 0,
        factTokens: 0,
        memoryTokens: 0,
        conversationTokens: 0,
        toolCallTokens: 0,
    };
    if (input.inputTokens <= 0) return empty;

    // (1) Calibrated buckets: System + Tool Defs scaled by per-model ratios.
    let calibratedSystem = Math.round(input.systemLocal * input.calibration.systemRatio);
    let calibratedToolDefs = Math.round(input.toolDefsLocal * input.calibration.toolsRatio);

    // (2) Verbatim buckets: Compartments / Facts / Memories — local raw counts,
    // no scaling. Same numbers shown in `/ctx-status` "History block" so the
    // sidebar and status dialog match exactly.
    let compartments = Math.max(0, input.compartmentsLocal);
    let facts = Math.max(0, input.factsLocal);
    let memories = Math.max(0, input.memoriesLocal);

    // Edge case: calibrated + verbatim already exceed inputTokens. Clamp them
    // down proportionally so the residual buckets stay non-negative.
    const nonResidualTotal =
        calibratedSystem + calibratedToolDefs + compartments + facts + memories;
    if (nonResidualTotal > input.inputTokens) {
        const ratio = input.inputTokens / nonResidualTotal;
        calibratedSystem = Math.round(calibratedSystem * ratio);
        calibratedToolDefs = Math.round(calibratedToolDefs * ratio);
        compartments = Math.round(compartments * ratio);
        facts = Math.round(facts * ratio);
        memories = Math.round(memories * ratio);
    }

    // (3) Residual buckets: Conversation + Tool Calls absorb whatever's left.
    const residualTarget = Math.max(
        0,
        input.inputTokens - calibratedSystem - calibratedToolDefs - compartments - facts - memories,
    );
    const residualLocalSum = input.conversationLocal + input.toolCallsLocal;

    let conversation: number;
    let toolCalls: number;

    if (residualLocalSum <= 0) {
        // No conversation / tool-call content locally yet — park the full
        // residual in conversation so the bar still adds up cleanly.
        conversation = residualTarget;
        toolCalls = 0;
    } else {
        const scale = residualTarget / residualLocalSum;
        conversation = Math.round(input.conversationLocal * scale);
        toolCalls = Math.round(input.toolCallsLocal * scale);
    }

    // Rounding correction: residual ±1/±2 token from Math.round lands in the
    // larger residual bucket so the final sum equals inputTokens exactly.
    const provisionalSum =
        calibratedSystem +
        calibratedToolDefs +
        compartments +
        facts +
        memories +
        conversation +
        toolCalls;
    let delta = input.inputTokens - provisionalSum;
    if (delta !== 0) {
        if (conversation >= toolCalls) {
            const adjusted = Math.max(0, conversation + delta);
            delta -= adjusted - conversation;
            conversation = adjusted;
        } else {
            const adjusted = Math.max(0, toolCalls + delta);
            delta -= adjusted - toolCalls;
            toolCalls = adjusted;
        }
    }

    // Edge case: in the clamp path with both residuals already at zero, the
    // round-up overshoot from `Math.round(x * ratio)` can't be absorbed by
    // residuals (Math.max clamps the negative delta to 0). Subtract the
    // remaining overshoot from non-residual buckets in descending-size
    // order until delta reaches zero, so the final sum equals inputTokens
    // exactly. Loops because a single bucket may not be large enough to
    // absorb the entire overshoot (rare but possible at tiny inputTokens
    // with heavy calibration ratios). Without this loop, pathological inputs
    // could leave a residual of +1 or +2 tokens.
    if (delta < 0) {
        type BucketName = "system" | "toolDefs" | "compartments" | "facts" | "memories";
        const get = (name: BucketName): number => {
            if (name === "system") return calibratedSystem;
            if (name === "toolDefs") return calibratedToolDefs;
            if (name === "compartments") return compartments;
            if (name === "facts") return facts;
            return memories;
        };
        const subtract = (name: BucketName, amount: number): void => {
            if (name === "system") calibratedSystem -= amount;
            else if (name === "toolDefs") calibratedToolDefs -= amount;
            else if (name === "compartments") compartments -= amount;
            else if (name === "facts") facts -= amount;
            else memories -= amount;
        };
        const buckets: BucketName[] = ["system", "toolDefs", "compartments", "facts", "memories"];
        // Sort by current value descending so we drain the largest first.
        buckets.sort((a, b) => get(b) - get(a));
        for (const name of buckets) {
            if (delta >= 0) break;
            const value = get(name);
            if (value <= 0) continue;
            const adjustment = Math.min(value, -delta);
            subtract(name, adjustment);
            delta += adjustment;
        }
    }

    return {
        systemTokens: calibratedSystem,
        toolDefinitionTokens: calibratedToolDefs,
        compartmentTokens: compartments,
        factTokens: facts,
        memoryTokens: memories,
        conversationTokens: conversation,
        toolCallTokens: toolCalls,
    };
}
