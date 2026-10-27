import {
    getMeasuredToolDefinitionTokens,
    getSessionToolDefinitionTokens,
    getToolDefinitionMeasurementSignature,
} from "../../features/magic-context/tool-definition-tokens";
import {
    hasMeasuredDecisionCalibration,
    providerMass,
    resolveDecisionCalibration,
} from "./decision-calibration";
import {
    createTokenCountMemo,
    hasTokenizerForFit,
    tokenCountUsesByteBound,
} from "./read-session-formatting";
import type { MessageLike } from "./tag-messages";
import { UNKNOWN_FIT_RATIO } from "./tokenizer-calibration";
import {
    hasCountableParts,
    type MessageTokenEstimate,
    serializedWireText,
    visitWireContent,
    wireContentBytes,
} from "./wire-content";

export {
    estimatePartImageTokens,
    type MessageTokenEstimate,
    wireContentBytes,
} from "./wire-content";

function compactWireLabel(value: unknown, fallback: string): string {
    if (typeof value !== "string" || value.length === 0) return fallback;
    return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 32) || fallback;
}

function wirePartKind(part: unknown, role: string): string {
    const rawType =
        part !== null &&
        typeof part === "object" &&
        typeof (part as { type?: unknown }).type === "string"
            ? (part as { type: string }).type
            : "unknown";
    if (rawType === "tool_result" || rawType === "tool-result") return "toolresult";
    if (rawType === "tool_use" || rawType === "tool-use" || rawType === "tool-invocation") {
        return "tool";
    }
    // OpenCode's native `tool` part carries the result on user-role messages
    // and the call on assistant-role messages.
    if (role === "user" && rawType === "tool") return "toolresult";
    return compactWireLabel(rawType, "unknown");
}

/** Describe the final three post-transform messages without serializing content. */
export function describeFinalWireTail(messages: readonly MessageLike[]): string {
    return `[${messages
        .slice(-3)
        .map((message) => {
            const role = compactWireLabel(message.info.role, "unknown");
            const kinds = message.parts.map((part) => wirePartKind(part, role)).join("+") || "none";
            return `${role}:${kinds}`;
        })
        .join(", ")}]`;
}

const wireTextTokens = createTokenCountMemo(100_000, 128 * 1024 * 1024);

function serializedTokens(value: unknown, bounded = false): number {
    const serialized = serializedWireText(value);
    if (bounded && tokenCountUsesByteBound(serialized)) return Buffer.byteLength(serialized);
    return serialized ? wireTextTokens(serialized) : 0;
}

/** Count the token-bearing fields in the message representation sent to OpenCode. */
export function estimateMessageTokens(message: MessageLike, bounded = false): MessageTokenEstimate {
    const total: MessageTokenEstimate = { conversation: 0, toolCall: 0 };
    visitWireContent(message, {
        text: (bucket, value) => {
            total[bucket] += serializedTokens(value, bounded);
        },
        image: (bucket, tokens) => {
            total[bucket] += tokens;
        },
    });
    return total;
}

export interface FinalWireTokenEstimateInput {
    messages: readonly MessageLike[];
    systemPromptTokens: number;
    /** Detached measurement of this request's complete tool set, including an empty set. */
    toolDefinitionTokens?: number;
    providerID: string | undefined;
    modelID: string | undefined;
    agentName: string | undefined;
    /**
     * The session the request belongs to. On OpenCode 2 it selects the exact
     * tool set this session's request carries. For a route with no measurement
     * it names the session whose last known tool figure may stand in: its
     * exact set on OpenCode 2, or its last route's activity total on OpenCode 1.
     */
    sessionId?: string;
    systemPromptHash?: string;
    /** Bound tokenizer work for refusal checks; ordinary admission uses its
     * separate fit estimator. */
    boundedTokenization?: boolean;
    /** Counts from a prior provider request, reusable only after matching its
     * exact route, envelope and prefix. */
    measuredPrefix?: { inputTokens: number; appendedMessages: readonly MessageLike[] };
}

/** Keep only exact served requests. A usage sample is reusable solely when the
 * same route/envelope and complete prefix survive, followed by its own reply.
 * No durable session aggregate or another route's usage can stand in for this.
 */
export function createFinalWireUsageTracker() {
    const fallbackLogged = new Set<string>();
    const served = new Map<
        string,
        {
            envelope: string;
            prefix: string[];
            parent: string;
            at: number;
            signed: boolean;
            estimate: number;
            driftLogged?: boolean;
        }
    >();
    const wireRows = (input: FinalWireTokenEstimateInput) =>
        input.messages.filter((message) =>
            message.parts.some(
                (part) =>
                    !part ||
                    typeof part !== "object" ||
                    !["step-start", "step-finish"].includes(
                        String((part as { type?: string }).type),
                    ),
            ),
        );
    const rowBytes = (message: MessageLike) =>
        JSON.stringify({ id: message.info.id, role: message.info.role, parts: message.parts });
    const envelopeFor = (input: FinalWireTokenEstimateInput): string | undefined => {
        if (!input.providerID || !input.modelID || !input.systemPromptHash) return;
        const tools = getToolDefinitionMeasurementSignature(
            input.providerID,
            input.modelID,
            input.agentName,
            input.sessionId,
        );
        if (!tools) return;
        return JSON.stringify([
            input.providerID,
            input.modelID,
            input.agentName,
            input.systemPromptHash,
            input.systemPromptTokens,
            tools,
        ]);
    };
    return {
        estimate(
            sessionId: string,
            request: FinalWireTokenEstimateInput,
            limit?: number,
        ): FinalWireTokenEstimate {
            const input = { ...request, sessionId: request.sessionId ?? sessionId };
            let measuredPrefix: FinalWireTokenEstimateInput["measuredPrefix"];
            try {
                const previous = served.get(sessionId);
                const rows = wireRows(input);
                if (
                    previous &&
                    previous.envelope === envelopeFor(input) &&
                    rows.length > previous.prefix.length &&
                    previous.prefix.every((bytes, i) => rowBytes(rows[i]) === bytes)
                ) {
                    const reply = rows[previous.prefix.length]?.info as Record<string, unknown>;
                    const tokens = reply.tokens as
                        | { input?: number; cache?: { read?: number; write?: number } }
                        | undefined;
                    const time = reply.time as { completed?: number } | undefined;
                    const counts = [tokens?.input, tokens?.cache?.read, tokens?.cache?.write];
                    if (
                        reply.role === "assistant" &&
                        reply.parentID === previous.parent &&
                        reply.providerID === input.providerID &&
                        reply.modelID === input.modelID &&
                        ["stop", "tool-calls", "length"].includes(String(reply.finish)) &&
                        !reply.error &&
                        typeof time?.completed === "number" &&
                        time.completed >= previous.at &&
                        counts.every(
                            (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0,
                        )
                    ) {
                        const inputTokens = counts.reduce<number>((sum, n) => sum + (n ?? 0), 0);
                        if (inputTokens > 0)
                            measuredPrefix = {
                                inputTokens,
                                appendedMessages: rows.slice(previous.prefix.length),
                            };
                        if (inputTokens > 0 && previous.signed && !previous.driftLogged) {
                            sessionLog(
                                sessionId,
                                `thinking estimate drift: estimate=${previous.estimate} provider=${inputTokens} ratio=${(previous.estimate / inputTokens).toFixed(4)} (previous served request; telemetry only)`,
                            );
                            previous.driftLogged = true;
                        }
                    }
                }
            } catch {
                /* If prior usage cannot be matched to this request, estimate from
                 * current calibration instead. */
            }
            const fallbackSteps = opaqueThinkingFallbackSteps(input.messages);
            if (fallbackSteps > 0 && !fallbackLogged.has(sessionId)) {
                sessionLog(
                    sessionId,
                    `opaque thinking fallback: steps=${fallbackSteps} tokensPerStep=1000 (native usage unavailable; telemetry only)`,
                );
                fallbackLogged.add(sessionId);
            }
            return estimateOutgoingWireForRefusal({ ...input, measuredPrefix }, limit);
        },
        capture(sessionId: string, request: FinalWireTokenEstimateInput): void {
            const input = { ...request, sessionId: request.sessionId ?? sessionId };
            const previous = served.get(sessionId);
            served.delete(sessionId);
            try {
                const alreadyLogged = fallbackLogged.delete(sessionId);
                const fallbackSteps = opaqueThinkingFallbackSteps(input.messages);
                if (!alreadyLogged && fallbackSteps > 0)
                    sessionLog(
                        sessionId,
                        `opaque thinking fallback: steps=${fallbackSteps} tokensPerStep=1000 (native usage unavailable; telemetry only)`,
                    );
                if (previous?.signed && !previous.driftLogged) {
                    const [providerID, modelID] = JSON.parse(previous.envelope);
                    const reply = [...input.messages].reverse().find((row) => {
                        const info = row.info as unknown as Record<string, unknown> | undefined;
                        const time = info?.time as { completed?: number } | undefined;
                        return (
                            info?.role === "assistant" &&
                            info.parentID === previous.parent &&
                            info.providerID === providerID &&
                            info.modelID === modelID &&
                            !info.error &&
                            ["stop", "tool-calls", "length"].includes(String(info.finish)) &&
                            typeof time?.completed === "number" &&
                            time.completed >= previous.at
                        );
                    });
                    const usage = (
                        reply?.info as unknown as
                            | {
                                  tokens?: {
                                      input?: number;
                                      cache?: { read?: number; write?: number };
                                  };
                              }
                            | undefined
                    )?.tokens;
                    const counts = [usage?.input, usage?.cache?.read, usage?.cache?.write];
                    if (
                        counts.every(
                            (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0,
                        )
                    ) {
                        const inputTokens = counts.reduce<number>((sum, n) => sum + (n ?? 0), 0);
                        if (inputTokens > 0)
                            sessionLog(
                                sessionId,
                                `thinking estimate drift: estimate=${previous.estimate} provider=${inputTokens} ratio=${(previous.estimate / inputTokens).toFixed(4)} (previous served request; telemetry only)`,
                            );
                    }
                }
                const envelope = envelopeFor(input);
                const rows = wireRows(input);
                const parent = [...rows].reverse().find((row) => row.info.role === "user")?.info.id;
                if (!envelope || typeof parent !== "string" || !rows.every(hasCountableParts))
                    return;
                const prefix = rows.map(rowBytes);
                // Keep this exact-match evidence small without limiting the larger durable replay cache.
                if (prefix.reduce((sum, text) => sum + text.length, 0) > 4 * 1024 * 1024) return;
                if (served.size >= 16) served.delete(served.keys().next().value!);
                const signed = input.messages.some((row) =>
                    row.parts.some((part) => {
                        const p = part as {
                            signature?: string;
                            metadata?: {
                                anthropic?: { signature?: string; redactedData?: string };
                            };
                        };
                        return Boolean(p.signature || p.metadata?.anthropic?.signature);
                    }),
                );
                served.set(sessionId, {
                    envelope,
                    prefix,
                    parent,
                    at: Date.now(),
                    signed,
                    estimate: signed ? estimateFinalWireInputTokens(input).tokens : 0,
                });
            } catch {
                /* A failed evidence capture must not reject a healthy request. */
            }
        },
    };
}

export function opaqueThinkingFallbackSteps(messages: readonly MessageLike[]): number {
    return messages.filter((message) => {
        if (!message || !Array.isArray(message.parts)) return false;
        const usage = (
            message.info as unknown as
                | { tokens?: { reasoning?: number; output?: number } }
                | undefined
        )?.tokens;
        return (
            opaqueThinkingCost(usage?.reasoning, usage?.output).fallback &&
            message.parts.some((part) => {
                if (!part || typeof part !== "object") return false;
                const p = part as {
                    type?: string;
                    ignored?: boolean;
                    redacted?: boolean;
                    text?: string;
                    thinking?: string;
                    signature?: string;
                    metadata?: { anthropic?: { signature?: string; redactedData?: string } };
                };
                return (
                    !p.ignored &&
                    (p.type === "redacted_thinking" ||
                        (p.type === "reasoning" &&
                            (p.redacted ||
                                p.metadata?.anthropic?.redactedData ||
                                (!p.text && p.metadata?.anthropic?.signature))) ||
                        (p.type === "thinking" && (p.redacted || (!p.thinking && p.signature))))
                );
            })
        );
    }).length;
}

export interface FinalWireTokenEstimate {
    tokens: number;
    trusted: boolean;
    /** Proof of non-fit, excluding unknown/family multipliers and tool counts
     * borrowed from another route. */
    refusalGrade?: boolean;
    refusalTokens?: number;
    refusalBasis?: "calibrated" | "provider-prefix" | "byte-bound";
    messageTokens: MessageTokenEstimate;
    systemTokens: number;
    toolDefinitionTokens: number | undefined;
    /**
     * True when the tool-definition figure is this route's own measurement. When
     * false, `toolDefinitionTokens` is either unknown or an upper envelope taken
     * from this session's last known tool figure (its exact set on OpenCode 2,
     * its last route's activity total on OpenCode 1).
     */
    toolDefinitionsMeasured?: boolean;
    /** Unscaled transform-array/system/tool measurement; provider framing is unmeasured. */
    rawTokens?: number;
    rawComponents?: { system: number; tools: number; prose: number };
    /**
     * Calibrated provider mass for reading context pressure, not for fit. A
     * seeded model gets its measured ratios, an unseeded model counts at the
     * neutral 1:1 ratio, and tool definitions this route has not measured count
     * at the session's last known tool figure, without the fit envelope.
     * `tokens` keeps the fit envelope for admission and must not be read as a
     * pressure reading: for an unseeded model it doubles the whole request.
     */
    pressureTokens?: number;
    completeness?: "complete" | "partial";
    componentsComplete?: boolean;
}

/**
 * Estimate the returned transform array plus observed system and tool definitions.
 * This is not exact provider tokenization: provider framing remains unmeasured.
 * Fit callers must require trusted, not merely compare a numeric partial estimate.
 */
/** Before tokenizing with the byte-pair encoder, refusal checks use byte bounds
 * when those bounds settle whether the request fits. Admission (deciding whether
 * to send) continues to use its separate fit policy and complete envelope. */
export function estimateOutgoingWireForRefusal(
    input: FinalWireTokenEstimateInput,
    limit?: number,
): FinalWireTokenEstimate {
    if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
        const measured = input.measuredPrefix;
        const baseline = measured?.inputTokens ?? 0;
        const pricedMessages = measured?.appendedMessages ?? input.messages;
        const bytes = wireContentBytes(pricedMessages, Math.max(0, limit - baseline) * 4, 4);
        if (bytes) {
            const lower = baseline + Math.ceil(bytes.bytes / 4);
            const calibration = resolveDecisionCalibration(input.providerID, input.modelID);
            const tools =
                input.providerID && input.modelID
                    ? getMeasuredToolDefinitionTokens(
                          input.providerID,
                          input.modelID,
                          input.agentName,
                          input.sessionId,
                      )
                    : undefined;
            const envelope = measured
                ? baseline
                : tools !== undefined &&
                    Number.isFinite(input.systemPromptTokens) &&
                    input.systemPromptTokens > 0
                  ? providerMass({ system: input.systemPromptTokens, tools }, calibration, true)
                  : undefined;
            const upper =
                envelope === undefined
                    ? undefined
                    : envelope +
                      Math.ceil(
                          bytes.bytes *
                              Math.max(
                                  UNKNOWN_FIT_RATIO,
                                  calibration.toolsRatio,
                                  calibration.proseRatio,
                              ),
                      );
            if (bytes.aborted || lower > limit || (upper !== undefined && upper <= limit)) {
                const over = bytes.aborted || lower > limit;
                return {
                    tokens: over ? lower : upper!,
                    trusted: !over,
                    refusalGrade: over && envelope !== undefined,
                    refusalTokens: over ? lower : undefined,
                    refusalBasis: "byte-bound",
                    messageTokens: { conversation: 0, toolCall: 0 },
                    systemTokens: input.systemPromptTokens,
                    toolDefinitionTokens: tools,
                    toolDefinitionsMeasured: tools !== undefined,
                };
            }
        }
    }
    return estimateFinalWireInputTokens({ ...input, boundedTokenization: true });
}

export function estimateFinalWireInputTokens(
    input: FinalWireTokenEstimateInput,
): FinalWireTokenEstimate {
    const messageTokens = input.messages.reduce<MessageTokenEstimate>(
        (total, message) => {
            const next = estimateMessageTokens(message, input.boundedTokenization);
            total.conversation += next.conversation;
            total.toolCall += next.toolCall;
            return total;
        },
        { conversation: 0, toolCall: 0 },
    );
    const measuredToolDefinitions =
        input.toolDefinitionTokens ??
        (input.providerID && input.modelID
            ? getMeasuredToolDefinitionTokens(
                  input.providerID,
                  input.modelID,
                  input.agentName,
                  input.sessionId,
              )
            : undefined);
    const calibration = resolveDecisionCalibration(input.providerID, input.modelID);
    // A route with no measurement of its own borrows this session's last known
    // tool figure (typically the same tools under the model it just switched
    // from), never the largest figure in the store. On OpenCode 1 that is the
    // last route's activity total, which can include tools other sessions on
    // that route were offered.
    const borrowedToolDefinitions =
        measuredToolDefinitions === undefined
            ? getSessionToolDefinitionTokens(input.sessionId)
            : undefined;
    // An unknown route inherits an upper envelope from the borrowed set, not zero.
    // Account for calibration below one on known models; unknown models already apply
    // UNKNOWN_FIT_RATIO to the whole request in providerMass.
    const toolDefinitions =
        measuredToolDefinitions ??
        (borrowedToolDefinitions === undefined
            ? undefined
            : Math.ceil(
                  (borrowedToolDefinitions * UNKNOWN_FIT_RATIO) /
                      (calibration.seeded ? calibration.toolsRatio : UNKNOWN_FIT_RATIO),
              ));
    const rawComponents = {
        system: input.systemPromptTokens,
        tools: (toolDefinitions ?? 0) + messageTokens.toolCall,
        prose: messageTokens.conversation,
    };
    const tokens = providerMass(rawComponents, calibration, true);
    const pressureToolDefinitions = measuredToolDefinitions ?? borrowedToolDefinitions ?? 0;
    const pressureTokens = providerMass(
        {
            system: rawComponents.system,
            tools: pressureToolDefinitions + messageTokens.toolCall,
            prose: rawComponents.prose,
        },
        calibration,
    );
    const complete =
        Number.isFinite(tokens) &&
        tokens > 0 &&
        Number.isFinite(input.systemPromptTokens) &&
        input.systemPromptTokens > 0 &&
        toolDefinitions !== undefined &&
        input.messages.every(hasCountableParts);
    const refusalGrade =
        complete &&
        hasTokenizerForFit() &&
        measuredToolDefinitions !== undefined &&
        hasMeasuredDecisionCalibration(calibration) &&
        input.messages.every(hasRefusalCountableParts);
    const measured = input.measuredPrefix;
    const useMeasured =
        refusalGrade &&
        measured &&
        Number.isSafeInteger(measured.inputTokens) &&
        measured.inputTokens > 0 &&
        measured.appendedMessages.every(hasCountableParts);
    const tail = useMeasured
        ? measured.appendedMessages.reduce<MessageTokenEstimate>(
              (sum, message) => {
                  const next = estimateMessageTokens(message, input.boundedTokenization);
                  return {
                      conversation: sum.conversation + next.conversation,
                      toolCall: sum.toolCall + next.toolCall,
                  };
              },
              { conversation: 0, toolCall: 0 },
          )
        : undefined;
    const refusalTokens = refusalGrade
        ? tail && measured
            ? measured.inputTokens +
              providerMass({ tools: tail.toolCall, prose: tail.conversation }, calibration)
            : providerMass(rawComponents, calibration)
        : undefined;
    const systemTokens = Math.round(
        Math.max(0, input.systemPromptTokens) * calibration.systemRatio,
    );
    const toolDefinitionTokens =
        toolDefinitions === undefined
            ? undefined
            : Math.round(
                  toolDefinitions *
                      (calibration.seeded ? calibration.toolsRatio : UNKNOWN_FIT_RATIO),
              );
    return {
        tokens,
        trusted: complete,
        refusalGrade,
        refusalTokens,
        refusalBasis: refusalGrade ? (useMeasured ? "provider-prefix" : "calibrated") : undefined,
        rawTokens: rawComponents.system + rawComponents.tools + rawComponents.prose,
        rawComponents,
        pressureTokens,
        completeness: complete ? "complete" : "partial",
        componentsComplete:
            toolDefinitions !== undefined && input.messages.every(hasCountableParts),
        messageTokens,
        systemTokens,
        toolDefinitionTokens,
        toolDefinitionsMeasured: measuredToolDefinitions !== undefined,
    };
}

function hasRefusalCountableParts(message: MessageLike): boolean {
    let exact = true;
    visitWireContent(message, {
        text: (_bucket, value) => {
            if (tokenCountUsesByteBound(serializedWireText(value))) exact = false;
        },
        image: () => {},
    });
    return exact;
}

/** A measured request already paid for its envelope; estimate only new messages. */
export function estimateAppendedWireTokens(
    input: Pick<FinalWireTokenEstimateInput, "messages" | "providerID" | "modelID">,
): FinalWireTokenEstimate {
    const messageTokens = input.messages.reduce<MessageTokenEstimate>(
        (total, message) => {
            const next = estimateMessageTokens(message);
            total.conversation += next.conversation;
            total.toolCall += next.toolCall;
            return total;
        },
        { conversation: 0, toolCall: 0 },
    );
    const tokens = providerMass(
        { prose: messageTokens.conversation, tools: messageTokens.toolCall },
        resolveDecisionCalibration(input.providerID, input.modelID),
        true,
    );
    return {
        tokens,
        trusted:
            hasTokenizerForFit() &&
            Number.isFinite(tokens) &&
            tokens >= 0 &&
            input.messages.every(hasCountableParts),
        messageTokens,
        systemTokens: 0,
        toolDefinitionTokens: 0,
    };
}

import { sessionLog } from "../../shared/logger";
import { opaqueThinkingCost } from "./opaque-thinking";
