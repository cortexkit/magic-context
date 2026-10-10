import {
    getLargestMeasuredToolDefinitionTokens,
    getMeasuredToolDefinitionTokens,
    getToolDefinitionMeasurementSignature,
} from "../../features/magic-context/tool-definition-tokens";
import {
    hasMeasuredDecisionCalibration,
    providerMass,
    resolveDecisionCalibration,
} from "./decision-calibration";
import {
    estimateImageTokensFromDataUrl,
    estimateToolAttachmentImageTokens,
} from "./image-token-estimate";
import {
    createTokenCountMemo,
    hasTokenizerForFit,
    tokenCountUsesByteBound,
} from "./read-session-formatting";
import type { MessageLike } from "./tag-messages";
import { UNKNOWN_FIT_RATIO } from "./tokenizer-calibration";

export interface MessageTokenEstimate {
    conversation: number;
    toolCall: number;
}

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

function serializedText(value: unknown): string {
    if (value === undefined) return "";
    return (typeof value === "string" ? value : JSON.stringify(value)) ?? "";
}

const wireTextTokens = createTokenCountMemo(100_000, 128 * 1024 * 1024);

function serializedTokens(value: unknown, bounded = false): number {
    const serialized = serializedText(value);
    if (bounded && tokenCountUsesByteBound(serialized)) return Buffer.byteLength(serialized);
    return serialized ? wireTextTokens(serialized) : 0;
}

type WireBucket = keyof MessageTokenEstimate;

/**
 * Visit every field of a message that reaches the provider request: `text` with
 * the field's value (a string, or a value the request carries serialized), and
 * `image` with the token count of an image the request carries. Fields OpenCode
 * keeps only for itself, such as tool metadata, are not visited. Token estimates
 * and wire byte counts both walk this, so they agree on what the wire holds.
 */
function visitWireContent(
    message: MessageLike,
    visit: {
        text: (bucket: WireBucket, value: unknown) => void;
        image: (bucket: WireBucket, tokens: number) => void;
    },
): void {
    for (const part of message.parts) {
        if (!part || typeof part !== "object") continue;
        const p = part as {
            type?: string;
            text?: string;
            thinking?: string;
            signature?: string;
            data?: string;
            ignored?: boolean;
            state?: { input?: unknown; output?: unknown; content?: unknown; error?: unknown };
            args?: unknown;
            input?: unknown;
            content?: unknown;
            output?: unknown;
            result?: unknown;
            mime?: string;
            url?: unknown;
            metadata?: { anthropic?: { signature?: string } };
        };
        if (p.ignored) continue;
        const text = (value: unknown) => {
            if (typeof value === "string") visit.text("conversation", value);
        };
        const tool = (value: unknown) => visit.text("toolCall", value);
        switch (p.type) {
            case "text":
                text(p.text);
                break;
            case "reasoning":
                text(p.text);
                text(p.metadata?.anthropic?.signature);
                break;
            case "thinking":
                text(p.thinking);
                text(p.signature);
                break;
            case "redacted_thinking":
                text(p.data);
                break;
            case "file":
                if (typeof p.mime === "string" && p.mime.startsWith("image/")) {
                    visit.image(
                        "conversation",
                        typeof p.url === "string" && p.url.startsWith("data:")
                            ? estimateImageTokensFromDataUrl(p.url)
                            : 1200,
                    );
                }
                break;
            case "tool":
                tool(p.state?.input ?? p.input ?? p.args);
                tool(p.state?.output ?? p.state?.content ?? p.output ?? p.result ?? p.content);
                tool(p.state?.error);
                // Legacy skeletons may still carry media. Count what the wire
                // actually contains, not what its output marker implies.
                visit.image("toolCall", estimateToolAttachmentImageTokens(p.state));
                break;
            case "tool-call":
                tool(p.input ?? p.args);
                break;
            case "tool-invocation":
                tool(p.args ?? p.input);
                tool(p.result ?? p.output ?? p.state?.output);
                tool(p.state?.error);
                break;
            case "tool-result":
                tool(p.result ?? p.content ?? p.output);
                break;
            case "tool_use":
                tool(p.input ?? p.args);
                break;
            case "tool_result":
                tool(p.content ?? p.result ?? p.output);
                break;
        }
    }
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

/**
 * The UTF-8 bytes of the fields `messages` put on the provider wire, the same
 * fields `estimateMessageTokens` counts; an image counts as `bytesPerToken` bytes
 * per estimated image token, since the provider bills it by size, not by its
 * base64 text. Stops as soon as the sum exceeds `abortAboveBytes`. Null when a
 * field cannot be serialized.
 */
export function wireContentBytes(
    messages: readonly MessageLike[],
    abortAboveBytes: number,
    bytesPerToken: number,
): { bytes: number; aborted: boolean } | null {
    let bytes = 0;
    try {
        for (const message of messages) {
            visitWireContent(message, {
                text: (_bucket, value) => {
                    bytes += Buffer.byteLength(serializedText(value));
                },
                image: (_bucket, tokens) => {
                    bytes += tokens * bytesPerToken;
                },
            });
            if (bytes > abortAboveBytes) return { bytes, aborted: true };
        }
    } catch {
        return null;
    }
    return { bytes, aborted: false };
}

export interface FinalWireTokenEstimateInput {
    messages: readonly MessageLike[];
    systemPromptTokens: number;
    /** Detached measurement of this request's complete tool set, including an empty set. */
    toolDefinitionTokens?: number;
    providerID: string | undefined;
    modelID: string | undefined;
    agentName: string | undefined;
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
    const served = new Map<
        string,
        { envelope: string; prefix: string[]; parent: string; at: number }
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
            input: FinalWireTokenEstimateInput,
            limit?: number,
        ): FinalWireTokenEstimate {
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
                    }
                }
            } catch {
                /* If prior usage cannot be matched to this request, estimate from
                 * current calibration instead. */
            }
            return estimateOutgoingWireForRefusal({ ...input, measuredPrefix }, limit);
        },
        capture(sessionId: string, input: FinalWireTokenEstimateInput): void {
            served.delete(sessionId);
            try {
                const envelope = envelopeFor(input);
                const rows = wireRows(input);
                const parent = [...rows].reverse().find((row) => row.info.role === "user")?.info.id;
                if (!envelope || typeof parent !== "string" || !rows.every(hasCountableParts))
                    return;
                const prefix = rows.map(rowBytes);
                // Keep this exact-match evidence small without limiting the larger durable replay cache.
                if (prefix.reduce((sum, text) => sum + text.length, 0) > 4 * 1024 * 1024) return;
                if (served.size >= 16) served.delete(served.keys().next().value!);
                served.set(sessionId, { envelope, prefix, parent, at: Date.now() });
            } catch {
                /* A failed evidence capture must not reject a healthy request. */
            }
        },
    };
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
     * from the largest tool set measured on any route.
     */
    toolDefinitionsMeasured?: boolean;
    /** Unscaled transform-array/system/tool measurement; provider framing is unmeasured. */
    rawTokens?: number;
    rawComponents?: { system: number; tools: number; prose: number };
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
            ? getMeasuredToolDefinitionTokens(input.providerID, input.modelID, input.agentName)
            : undefined);
    const calibration = resolveDecisionCalibration(input.providerID, input.modelID);
    const largestToolDefinitions =
        measuredToolDefinitions === undefined
            ? getLargestMeasuredToolDefinitionTokens()
            : undefined;
    // An unknown route inherits an upper envelope from observed tool sets, not zero.
    // Account for calibration below one on known models; unknown models already apply
    // UNKNOWN_FIT_RATIO to the whole request in providerMass.
    const toolDefinitions =
        measuredToolDefinitions ??
        (largestToolDefinitions === undefined
            ? undefined
            : Math.ceil(
                  (largestToolDefinitions * UNKNOWN_FIT_RATIO) /
                      (calibration.seeded ? calibration.toolsRatio : UNKNOWN_FIT_RATIO),
              ));
    const rawComponents = {
        system: input.systemPromptTokens,
        tools: (toolDefinitions ?? 0) + messageTokens.toolCall,
        prose: messageTokens.conversation,
    };
    const tokens = providerMass(rawComponents, calibration, true);
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
            if (tokenCountUsesByteBound(serializedText(value))) exact = false;
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

function hasCountableParts(message: MessageLike): boolean {
    return message.parts.every((part) => {
        if (!part || typeof part !== "object") return false;
        const p = part as unknown as Record<string, unknown>;
        if (p.ignored === true) return true;
        switch (p.type) {
            case "text":
            case "reasoning":
                return typeof p.text === "string";
            case "thinking":
                return typeof p.thinking === "string";
            case "redacted_thinking":
                return typeof p.data === "string";
            case "tool": {
                const state =
                    p.state !== null && typeof p.state === "object"
                        ? (p.state as Record<string, unknown>)
                        : undefined;
                const hasInput =
                    state?.input !== undefined || p.input !== undefined || p.args !== undefined;
                const hasResult =
                    state?.output !== undefined ||
                    state?.content !== undefined ||
                    state?.error !== undefined ||
                    p.output !== undefined ||
                    p.result !== undefined ||
                    p.content !== undefined;
                return hasInput && hasResult;
            }
            case "tool-call":
                return p.input !== undefined || p.args !== undefined;
            case "tool-invocation":
                return (
                    (p.args !== undefined || p.input !== undefined) &&
                    (p.result !== undefined ||
                        p.output !== undefined ||
                        (p.state !== null && typeof p.state === "object"))
                );
            case "tool-result":
                return p.result !== undefined || p.content !== undefined || p.output !== undefined;
            case "tool_use":
                return p.input !== undefined || p.args !== undefined;
            case "tool_result":
                return p.content !== undefined || p.result !== undefined || p.output !== undefined;
            case "step-start":
            case "step-finish":
                return true;
            case "file":
                // An inline image is counted from its pixel dimensions, and that count
                // is capped per image, so it is a bounded estimate. Every session with a
                // memory mural carries one in m[0]; leaving it uncountable made every
                // fit check on those sessions untrusted, so last-known-good replay was
                // refused on every engine blip. Other attachments stay uncountable.
                return typeof p.url === "string" && p.url.startsWith("data:image/");
            default:
                return false;
        }
    });
}
