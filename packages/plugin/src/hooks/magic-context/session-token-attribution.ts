import { getMeasuredToolDefinitionTokens } from "../../features/magic-context/tool-definition-tokens";
import type { Database } from "../../shared/sqlite";
import { computeM0BlockTokens, type M0BlockTokens } from "./m0-token-breakdown";
import { findLastAssistantModelFromOpenCodeDb } from "./read-session-db";
import { calibrateBuckets, resolveModelCalibration } from "./tokenizer-calibration";

export type TokenAttribution = ReturnType<typeof calibrateBuckets>;
export interface AttributionRoute {
    liveModelBySession: ReadonlyMap<string, { providerID: string; modelID: string }>;
    agentBySession: ReadonlyMap<string, string>;
}

export interface AttributionPrefix {
    projectIdentity: string | undefined;
    injectionBudgetTokens?: number;
    memoryBlockCount?: number;
}

export function readAttributionBlocks(
    db: Database,
    sessionId: string,
    meta: Record<string, unknown> | undefined,
    prefix: AttributionPrefix,
): M0BlockTokens {
    const decode = (bytes: unknown): string =>
        bytes instanceof Uint8Array
            ? Buffer.from(bytes).toString("utf8")
            : typeof bytes === "string"
              ? bytes
              : "";
    return computeM0BlockTokens(db, sessionId, {
        m0Text: decode(meta?.cached_m0_bytes),
        m1Text: decode(meta?.cached_m1_bytes),
        ...prefix,
        injectionBudgetTokens: prefix.injectionBudgetTokens,
        memoryBlockCount: prefix.memoryBlockCount ?? Number(meta?.memory_block_count ?? 0),
    });
}

/**
 * Share display inputs and calibration without changing the routes used by transform decisions.
 * Only the sidebar caller may cache recovered model/agent hints for subsequent polls.
 */
export function buildOpenCodeTokenAttribution(
    db: Database,
    sessionId: string,
    meta: Record<string, unknown> | undefined,
    prefix: AttributionPrefix,
    route?: AttributionRoute,
    blocks = readAttributionBlocks(db, sessionId, meta, prefix),
) {
    let measuredToolDefTokens = 0;
    let activeProviderID: string | undefined;
    let activeModelID: string | undefined;
    let recoveredModel: { providerID: string; modelID: string } | undefined;
    let recoveredAgent: string | undefined;
    if (route) {
        let model = route.liveModelBySession.get(sessionId);
        let agent = route.agentBySession.get(sessionId);
        if (!model || !agent) {
            const recovered = findLastAssistantModelFromOpenCodeDb(sessionId);
            if (recovered) {
                if (!model) {
                    model = recoveredModel = {
                        providerID: recovered.providerID,
                        modelID: recovered.modelID,
                    };
                }
                if (!agent && recovered.agent) {
                    agent = recoveredAgent = recovered.agent;
                }
            }
        }
        if (model) {
            activeProviderID = model.providerID;
            activeModelID = model.modelID;
            measuredToolDefTokens =
                getMeasuredToolDefinitionTokens(
                    model.providerID,
                    model.modelID,
                    agent,
                    sessionId,
                ) ?? 0;
        }
    }
    const injected =
        blocks.compartmentTokens +
        blocks.factTokens +
        blocks.memoryTokens +
        blocks.docsTokens +
        blocks.profileTokens;
    const buckets = calibrateBuckets({
        inputTokens: Number(meta?.last_input_tokens ?? 0),
        systemLocal: Number(meta?.system_prompt_tokens ?? 0),
        toolDefsLocal: measuredToolDefTokens,
        compartmentsLocal: blocks.compartmentTokens,
        factsLocal: blocks.factTokens,
        memoriesLocal: blocks.memoryTokens,
        docsLocal: blocks.docsTokens,
        profileLocal: blocks.profileTokens,
        conversationLocal: Math.max(0, Number(meta?.conversation_tokens ?? 0) - injected),
        toolCallsLocal: Math.max(0, Number(meta?.tool_call_tokens ?? 0)),
        calibration: resolveModelCalibration(activeProviderID, activeModelID),
    });
    return { buckets, activeProviderID, activeModelID, recoveredModel, recoveredAgent };
}

/** Keep the phone's existing part names; the last user message is already in conversation. */
export function tokenAttributionParts(buckets: TokenAttribution): Record<string, number> {
    return {
        system_prompt: buckets.systemTokens,
        tool_definitions: buckets.toolDefinitionTokens,
        history_summaries: buckets.compartmentTokens + buckets.factTokens,
        memory: buckets.memoryTokens,
        project_docs: buckets.docsTokens,
        user_profile: buckets.profileTokens,
        history_raw: buckets.conversationTokens,
        tool_calls_results: buckets.toolCallTokens,
        last_user_message: 0,
    };
}
