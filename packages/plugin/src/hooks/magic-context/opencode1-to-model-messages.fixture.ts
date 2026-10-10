/**
 * OpenCode 1's conversion of session messages to model messages, vendored from
 * `toModelMessagesEffect` in packages/opencode/src/session/message-v2.ts at tag
 * v1.18.35 for tests (read-only copy; the Effect wrapper and the final
 * `convertToModelMessages` call are left out). It returns the UI messages that
 * function hands to the AI SDK's `convertToModelMessages`, which is a pure
 * function of them, so equal results here mean equal provider requests.
 *
 * Every read of a part or tool-state field is kept as the host makes it. Two
 * things are reduced to what the tests exercise: the assistant error rule (the
 * host also keeps an aborted assistant that produced parts) and the provider
 * media rules (only the Anthropic and OpenAI adapters are listed); the
 * synthetic attachment message gets no generated id.
 */

// biome-ignore lint/suspicious/noExplicitAny: a vendored copy of untyped host code.
type Any = Record<string, any>;

interface Model {
    providerID: string;
    id: string;
    api: { npm: string; id: string };
}

const SYNTHETIC_ATTACHMENT_PROMPT = "Attached image(s) from tool result:";

function isMedia(mime: string): boolean {
    return mime.startsWith("image/") || mime === "application/pdf";
}

function providerMeta(metadata: Any | undefined) {
    if (!metadata) return undefined;
    const { providerExecuted: _, ...rest } = metadata;
    return Object.keys(rest).length > 0 ? rest : undefined;
}

function truncateToolOutput(text: string, maxChars?: number): string {
    if (!maxChars || text.length <= maxChars) return text;
    const omitted = text.length - maxChars;
    return `${text.slice(0, maxChars)}\n[Tool output truncated for compaction: omitted ${omitted} chars]`;
}

export function opencode1UiMessages(input: Any[], model: Model): Any[] {
    const result: Any[] = [];
    const supportsMediaInToolResult = (_attachment: Any) => {
        if (model.api.npm === "@ai-sdk/anthropic") return true;
        if (model.api.npm === "@ai-sdk/openai") return true;
        return false;
    };
    const rejectedByProvider = (attachment: Any) =>
        model.api.npm === "@ai-sdk/xai" &&
        attachment.mime.startsWith("image/") &&
        !["image/png", "image/jpeg", "image/webp"].includes(attachment.mime);

    for (const msg of input) {
        if (msg.parts.length === 0) continue;
        if (msg.info.role === "user") {
            const userMessage: Any = { id: msg.info.id, role: "user", parts: [] };
            for (const part of msg.parts) {
                if (part.type === "text" && !part.ignored && part.text !== "")
                    userMessage.parts.push({ type: "text", text: part.text });
                if (
                    part.type === "file" &&
                    part.mime !== "text/plain" &&
                    part.mime !== "application/x-directory"
                ) {
                    userMessage.parts.push({
                        type: "file",
                        url: part.url,
                        mediaType: part.mime,
                        filename: part.filename,
                    });
                }
                if (part.type === "compaction")
                    userMessage.parts.push({ type: "text", text: "What did we do so far?" });
                if (part.type === "subtask")
                    userMessage.parts.push({
                        type: "text",
                        text: "The following tool was executed by the user",
                    });
            }
            if (userMessage.parts.length > 0) result.push(userMessage);
        }

        if (msg.info.role === "assistant") {
            const differentModel =
                `${model.providerID}/${model.id}` !== `${msg.info.providerID}/${msg.info.modelID}`;
            const media: Any[] = [];
            if (msg.info.error) continue;
            const assistantMessage: Any = { id: msg.info.id, role: "assistant", parts: [] };
            const hasSignedReasoning = msg.parts.some((part: Any) => {
                if (part.type !== "reasoning") return false;
                return part.metadata?.anthropic?.signature != null;
            });
            for (const part of msg.parts) {
                if (part.type === "text") {
                    const text = part.text === "" && hasSignedReasoning ? " " : part.text;
                    assistantMessage.parts.push({
                        type: "text",
                        text,
                        ...(differentModel ? {} : { providerMetadata: part.metadata }),
                    });
                }
                if (part.type === "step-start") assistantMessage.parts.push({ type: "step-start" });
                if (part.type === "tool") {
                    if (part.state.status === "completed") {
                        const outputText = part.state.time.compacted
                            ? "[Old tool result content cleared]"
                            : truncateToolOutput(part.state.output, undefined);
                        const attachments = part.state.time.compacted
                            ? []
                            : (part.state.attachments ?? []).filter(
                                  (a: Any) => !rejectedByProvider(a),
                              );
                        const mediaAttachments = attachments.filter((a: Any) => isMedia(a.mime));
                        const extractedMedia = mediaAttachments.filter(
                            (a: Any) => !supportsMediaInToolResult(a),
                        );
                        if (extractedMedia.length > 0) media.push(...extractedMedia);
                        const finalAttachments = attachments.filter(
                            (a: Any) => !isMedia(a.mime) || supportsMediaInToolResult(a),
                        );
                        const output =
                            finalAttachments.length > 0
                                ? { text: outputText, attachments: finalAttachments }
                                : outputText;
                        assistantMessage.parts.push({
                            type: `tool-${part.tool}`,
                            state: "output-available",
                            toolCallId: part.callID,
                            input: part.state.input,
                            output,
                            ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                            ...(differentModel
                                ? {}
                                : { callProviderMetadata: providerMeta(part.metadata) }),
                        });
                    }
                    if (part.state.status === "error") {
                        const output =
                            part.state.metadata?.interrupted === true
                                ? part.state.metadata.output
                                : undefined;
                        if (typeof output === "string") {
                            assistantMessage.parts.push({
                                type: `tool-${part.tool}`,
                                state: "output-available",
                                toolCallId: part.callID,
                                input: part.state.input,
                                output,
                                ...(part.metadata?.providerExecuted
                                    ? { providerExecuted: true }
                                    : {}),
                                ...(differentModel
                                    ? {}
                                    : { callProviderMetadata: providerMeta(part.metadata) }),
                            });
                        } else {
                            assistantMessage.parts.push({
                                type: `tool-${part.tool}`,
                                state: "output-error",
                                toolCallId: part.callID,
                                input: part.state.input,
                                errorText: part.state.error,
                                ...(part.metadata?.providerExecuted
                                    ? { providerExecuted: true }
                                    : {}),
                                ...(differentModel
                                    ? {}
                                    : { callProviderMetadata: providerMeta(part.metadata) }),
                            });
                        }
                    }
                    if (part.state.status === "pending" || part.state.status === "running")
                        assistantMessage.parts.push({
                            type: `tool-${part.tool}`,
                            state: "output-error",
                            toolCallId: part.callID,
                            input: part.state.input,
                            errorText: "[Tool execution was interrupted]",
                            ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                            ...(differentModel
                                ? {}
                                : { callProviderMetadata: providerMeta(part.metadata) }),
                        });
                }
                if (part.type === "reasoning") {
                    if (differentModel) {
                        if (part.text.trim().length > 0)
                            assistantMessage.parts.push({ type: "text", text: part.text });
                        continue;
                    }
                    assistantMessage.parts.push({
                        type: "reasoning",
                        text: part.text,
                        providerMetadata: part.metadata,
                    });
                }
            }
            if (assistantMessage.parts.length > 0) {
                result.push(assistantMessage);
                if (media.length > 0) {
                    result.push({
                        role: "user",
                        parts: [
                            { type: "text", text: SYNTHETIC_ATTACHMENT_PROMPT },
                            ...media.map((attachment) => ({
                                type: "file",
                                url: attachment.url,
                                mediaType: attachment.mime,
                                filename: attachment.filename,
                            })),
                        ],
                    });
                }
            }
        }
    }
    return result.filter((msg) => msg.parts.some((part: Any) => part.type !== "step-start"));
}
