import { fileURLToPath } from "node:url";
import { isStorageNoticeText } from "../hooks/storage-notice";
import type { V2Message } from "../hooks/types";
import type { StoreRow } from "../store-reader";

type Part = Record<string, unknown>;
interface Attachment {
    mime: string;
    data: string;
    name?: string;
    description?: string;
    source: { type: string; uri?: string };
    mention?: { text?: string };
}
/**
 * How restored attachments are rendered. Hosts before OpenCode 2.0.15 take a plain
 * `{ mediaType, data }` media part; later hosts need their own `Media.Asset` instance
 * (see host-media.ts). When no instance can be produced the attachment is replaced by a
 * short note, so the row's text still reaches the model and the host does not reject
 * the whole request.
 */
export interface RestoreMedia {
    /** The host's asset for a base64 payload, or why none could be built. */
    asset(data: string, mediaType: string): object | string;
    /** Called once per attachment replaced by the note. */
    unavailable(detail: { rowID: string; name?: string; mediaType: string; reason: string }): void;
}

/** Depends only on the stored row, so a replay of the same row produces the same bytes. */
export function unavailableAttachmentNote(name: string | undefined, mediaType: string): string {
    return `[Attachment ${name ? `"${name}" ` : ""}(${mediaType}) is not available in this restored history]`;
}

const imageMimes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
function attachmentParts(files: Attachment[], rowID: string, media?: RestoreMedia): Part[] {
    const seen = new Map<string, Set<string>>();
    return files.flatMap((file): Part[] => {
        if (imageMimes.has(file.mime) && file.source.type === "inline" && file.mention?.text) {
            const key = JSON.stringify([
                file.mime,
                file.name ?? null,
                file.description ?? null,
                file.mention.text,
            ]);
            const payloads = seen.get(key) ?? new Set<string>();
            if (payloads.has(file.data)) return [];
            payloads.add(file.data);
            seen.set(key, payloads);
        }
        const uri = file.source.type === "uri" ? file.source.uri : undefined;
        const location = uri?.startsWith("file:") ? fileURLToPath(uri) : undefined;
        if (file.mime === "text/plain" || file.mime === "application/x-directory") {
            const directory = file.mime === "application/x-directory";
            return [
                {
                    type: "text",
                    text: `\n\n${[
                        directory
                            ? `Attached directory: ${location ?? file.name ?? uri ?? "directory"}`
                            : `Attached file: ${file.name ?? uri ?? "inline attachment"}`,
                        file.description === undefined
                            ? undefined
                            : `Description: ${file.description}`,
                        directory && !file.data.length ? undefined : "",
                        directory && !file.data.length
                            ? undefined
                            : Buffer.from(file.data, "base64").toString("utf8"),
                    ]
                        .filter((line) => line !== undefined)
                        .join("\n")}`,
                    metadata: {
                        attachment: {
                            source: file.source,
                            name: file.name,
                            description: file.description,
                        },
                    },
                },
            ];
        }
        if (!imageMimes.has(file.mime) && file.mime !== "application/pdf") return [];
        const metadata =
            file.description === undefined ? undefined : { description: file.description };
        const located = location ? [{ type: "text", text: `Attached file: ${location}` }] : [];
        if (!media)
            return [
                ...located,
                {
                    type: "media",
                    mediaType: file.mime,
                    data: file.data,
                    filename: file.name,
                    metadata,
                },
            ];
        const asset = media.asset(file.data, file.mime);
        if (typeof asset === "string") {
            media.unavailable({ rowID, name: file.name, mediaType: file.mime, reason: asset });
            return [
                ...located,
                { type: "text", text: unavailableAttachmentNote(file.name, file.mime) },
            ];
        }
        // Same keys, in the same order, as the host's own rendering of a stored attachment.
        return [...located, { type: "media", media: asset, filename: file.name, metadata }];
    });
}

/** Render retained store rows using GA's to-llm-message representation, not the lossy
 * historian projection. Tool results stay paired, and attachments retain their payloads.
 * The store remains read-only; the host's bounded recent-context is not a preservation source.
 */
export function restoreRow(
    row: StoreRow,
    model: { providerID: string; id: string },
    media?: RestoreMedia,
): V2Message[] {
    const data = row.data;
    const make = (role: string, content: Part[], metadata: unknown = data.metadata): V2Message => ({
        id: row.id,
        role,
        content,
        ...(metadata === undefined ? {} : { metadata }),
    });
    if (row.type === "user") {
        const skills = (data.skills ?? []) as Array<{ text?: string }>;
        const content: Part[] = [
            ...skills.flatMap((skill) =>
                skill.text === undefined ? [] : [{ type: "text", text: skill.text }],
            ),
            ...(data.text ? [{ type: "text", text: data.text }] : []),
            ...attachmentParts((data.files ?? []) as Attachment[], row.id, media),
        ];
        return content.length
            ? [
                  make("user", content, {
                      ...((data.metadata as Part) ?? {}),
                      ...((data.agents as unknown[])?.length ? { agents: data.agents } : {}),
                  }),
              ]
            : [];
    }
    // The host renders an instruction-update row as a bare system message with
    // neither the row id nor its metadata. Restoring it the same way keeps a
    // restored row byte-identical to the host-rendered one, so the request does
    // not change when the row moves between the restored range and the host's
    // own window, and an id-less row is never tagged or dropped as history.
    if (row.type === "system")
        return [{ role: "system", content: [{ type: "text", text: data.text ?? "" }] }];
    // Magic Context's own storage notices are for the user and are dropped from
    // every request the context hook serves, so a restored copy is dropped too, and
    // boundary lookups see the row as one the request never carries.
    if (row.type === "synthetic" && isStorageNoticeText(data.text)) return [];
    if (["synthetic", "skill"].includes(row.type))
        return [make("user", [{ type: "text", text: data.text ?? "" }])];
    if (row.type === "location-switched")
        return [
            make("user", [
                {
                    type: "text",
                    text: `The working directory has been changed to ${(data.location as { directory: string }).directory}.`,
                },
            ]),
        ];
    if (row.type === "shell")
        return (data.metadata as Part | undefined)?.background === true
            ? []
            : [
                  make("user", [
                      {
                          type: "text",
                          text: `The following shell command was executed by the user:\n\nCommand:\n${data.command}\n\nOutput:\n${(data.output as { output?: string } | undefined)?.output ?? ""}`,
                      },
                  ]),
              ];
    if (row.type !== "assistant") return [];
    const previousModel = data.model as { providerID: string; id: string };
    const sameProvider = previousModel?.providerID === model.providerID;
    const sameModel = sameProvider && previousModel?.id === model.id;
    const reuse = sameModel && data.error === undefined;
    const metadata = (state: unknown) =>
        state === undefined ? undefined : { [model.providerID]: state };
    const reasoningInterrupted = data.content?.some(
        (part) =>
            part.type === "reasoning" &&
            part.time !== undefined &&
            (part.time as Part).completed === undefined,
    );
    const content: Part[] = [];
    const results: V2Message[] = [];
    for (const part of data.content ?? []) {
        // Raw SQL rows bypass the host's legacy decoder. Current names win even
        // when explicitly undefined; legacy tool results then shallow-merge over
        // call data, just as OpenCode's SessionLegacy decoder does.
        let native =
            "native" in part ? part.native : part.type === "tool" ? part.providerState : part.state;
        if (
            part.type === "tool" &&
            part.providerResultState !== null &&
            typeof part.providerResultState === "object" &&
            !Array.isArray(part.providerResultState)
        )
            native = {
                ...(native !== null && typeof native === "object" && !Array.isArray(native)
                    ? native
                    : {}),
                ...part.providerResultState,
            };
        if (part.type === "text") {
            if (part.text !== "")
                content.push({
                    type: "text",
                    text: part.text,
                    providerMetadata: reuse ? metadata(native) : undefined,
                });
            continue;
        }
        if (part.type === "reasoning") {
            if (part.text !== "" || (reuse && !reasoningInterrupted && native !== undefined))
                content.push({
                    type: data.error === undefined && !reasoningInterrupted ? "reasoning" : "text",
                    text: part.text,
                    providerMetadata: reuse && !reasoningInterrupted ? metadata(native) : undefined,
                });
            continue;
        }
        const state = part.state as Part;
        const completed = state.status === "completed" || state.status === "error";
        const toolReuse = reuse || (sameModel && part.executed === true && completed);
        let input = state.input;
        if (state.status === "streaming" && typeof input === "string") {
            try {
                input = JSON.parse(input);
            } catch {
                /* An unfinished tool input is still text on GA. */
            }
        }
        content.push({
            type: "tool-call",
            id: part.id,
            name: part.name,
            input,
            providerExecuted: part.executed,
            providerMetadata: toolReuse ? metadata(native) : undefined,
        });
        if (!completed) continue;
        const toolContent = (state.content ?? []) as Part[];
        const single = toolContent.length === 1 ? toolContent[0] : undefined;
        const result: Part = {
            type: "tool-result",
            id: part.id,
            name: part.name,
            providerExecuted: part.executed,
            providerMetadata: (part.executed === true ? sameProvider : reuse)
                ? metadata(native)
                : undefined,
            // A finished tool-result part, in the shape `ToolResultPart.make` returns:
            // `{ type, value }`. `{ result, resultType }` is make's input, and
            // OpenCode 2.2's request schema rejects it, failing every request that
            // carries a restored failed call.
            result:
                state.status === "error"
                    ? { type: "error", value: { error: state.error, content: toolContent } }
                    : single?.type === "text"
                      ? { type: "text", value: single.text }
                      : { type: "content", value: toolContent },
        };
        if (part.executed === true) content.push(result);
        else results.push({ role: "tool", content: [result] });
    }
    return [...(content.length ? [make("assistant", content)] : []), ...results];
}
