import type { MessageLike } from "../../hooks/magic-context/tag-messages";
import type { SessionContext, V2Message } from "./types";

export const HEAD_IDS = ["__magic_context_v2_m0__", "__magic_context_v2_m1__"] as const;
type Part = Record<string, unknown>;
interface ToolBridge {
    call?: Part;
    result?: Part;
    output: string;
    resultMessage?: V2Message;
}

/** Project the host's split call/result pair into the TS pipeline's native tool part.
 * Only native tool parts allocate tags; feeding a bare tool_result can replay an
 * existing tag but cannot create one. The inverse projection preserves host metadata.
 */
export function adaptPayload(draft: SessionContext, admittedIDs: ReadonlySet<string> = new Set()) {
    const existingHeads = new Map(
        draft.messages.filter((m) => HEAD_IDS.some((id) => m.id === id)).map((m) => [m.id, m]),
    );
    const source = draft.messages.filter((m) => !existingHeads.has(m.id));
    const results = new Map<string, Array<{ part: Part; message: V2Message }>>();
    for (const message of source) {
        for (const part of message.content) {
            if (part.type === "tool-result" && typeof part.id === "string") {
                const queue = results.get(part.id) ?? [];
                queue.push({ part, message });
                results.set(part.id, queue);
            }
        }
    }
    const paired = new Set<Part>();
    const bridges = new Map<unknown, ToolBridge>();
    const originals = new Map<MessageLike, V2Message>();
    // The pipeline does not preserve object identity: the drop and edit-marker paths swap a
    // rewritten structuredClone into `parts`, and trailing-blank normalization replaces a
    // message with a copy. commit() therefore also resolves a part's bridge by (message id,
    // callID) and a message's host original by id. Scoped per message because two turns may
    // reuse one callID; host tool-result carriers have no id, so they keep an object key.
    const bridgesByMessageID = new Map<string, Map<string, ToolBridge>>();
    const bridgesByCarrier = new Map<MessageLike, Map<string, ToolBridge>>();
    const originalsByID = new Map<string, V2Message>();
    const bridgesFor = (message: MessageLike) =>
        typeof message.info.id === "string"
            ? bridgesByMessageID.get(message.info.id)
            : bridgesByCarrier.get(message);
    const nativeTool = (
        call: Part | undefined,
        result: { part: Part; message: V2Message } | undefined,
    ): Part => {
        const value = (result?.part.result as Part | undefined)?.value;
        const output =
            typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
        const part = {
            type: "tool",
            callID: call?.id ?? result?.part.id,
            tool: call?.name ?? result?.part.name,
            state: {
                input: structuredClone(call?.input ?? {}),
                status: result ? "completed" : "running",
                ...(result ? { output } : {}),
            },
        };
        bridges.set(part, { call, result: result?.part, resultMessage: result?.message, output });
        if (result) paired.add(result.part);
        return part;
    };
    // Pair calls before walking result carriers; the host omits IDs on those
    // carriers, while the assistant row ID remains the composite tag owner.
    const callParts = new Map<Part, Part>();
    for (const message of source) {
        for (const part of message.content) {
            if (part.type === "tool-call")
                callParts.set(part, nativeTool(part, results.get(String(part.id))?.shift()));
        }
    }
    const messages: MessageLike[] = [];
    for (const message of source) {
        const parts: Part[] = [];
        for (const content of message.content) {
            if (paired.has(content)) continue;
            const part =
                callParts.get(content) ??
                (content.type === "tool-result"
                    ? nativeTool(undefined, { part: content, message })
                    : structuredClone(content));
            if (message.id && admittedIDs.has(message.id)) part.synthetic = true;
            parts.push(part);
        }
        if (!parts.length && message.content.length) continue;
        const byCallID = new Map<string, ToolBridge>();
        for (const part of parts) {
            const bridge = bridges.get(part);
            if (bridge && typeof part.callID === "string") byCallID.set(part.callID, bridge);
        }
        if (typeof message.id === "string") {
            bridgesByMessageID.set(message.id, byCallID);
            originalsByID.set(message.id, message);
        }
        const mapped: MessageLike = {
            info: {
                id: message.id,
                sessionID: draft.sessionID,
                role: message.role,
                ...{
                    providerID: draft.model.providerID,
                    modelID: draft.model.id,
                    agent: draft.agent,
                    tools: draft.tools,
                },
            },
            parts,
        };
        originals.set(mapped, message);
        if (typeof message.id !== "string") bridgesByCarrier.set(mapped, byCallID);
        messages.push(mapped);
    }
    return {
        messages,
        commit() {
            let head = 0;
            const rendered: V2Message[] = [];
            for (const message of messages) {
                const original =
                    originals.get(message) ??
                    (typeof message.info.id === "string"
                        ? originalsByID.get(message.info.id)
                        : undefined);
                const id = message.info.syntheticHead ? HEAD_IDS[head++] : original?.id;
                const content: Part[] = [];
                const following: V2Message[] = [];
                for (const candidate of message.parts) {
                    const part = candidate as Part;
                    const bridge =
                        bridges.get(part) ??
                        (part.type === "tool" && typeof part.callID === "string"
                            ? bridgesFor(message)?.get(part.callID)
                            : undefined);
                    if (!bridge) {
                        const { synthetic: _synthetic, ...clean } = part;
                        content.push(clean);
                        continue;
                    }
                    const state = part.state as Part;
                    if (bridge.call) content.push({ ...bridge.call, input: state.input });
                    if (bridge.result && bridge.resultMessage) {
                        const result = {
                            ...bridge.result,
                            result:
                                state.output === bridge.output
                                    ? bridge.result.result
                                    : { type: "text", value: state.output },
                        };
                        if (bridge.resultMessage === original) content.push(result);
                        else following.push({ ...bridge.resultMessage, content: [result] });
                    }
                }
                if (content.length || !original?.content.length) {
                    const value: V2Message = {
                        ...original,
                        id,
                        role: message.info.role ?? "user",
                        content,
                    };
                    const existing = id ? existingHeads.get(id) : undefined;
                    rendered.push(existing ? Object.assign(existing, { content }) : value);
                }
                rendered.push(...following);
            }
            draft.messages.splice(0, draft.messages.length, ...rendered);
        },
    };
}
