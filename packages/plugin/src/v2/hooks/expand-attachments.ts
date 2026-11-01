import type { RecoveryAttachments } from "../../tools/ctx-expand/render";
import type { V2StoreReader } from "../store-reader";

/** Read metadata only for ctx_expand, without changing the rawMessages view used by history and transforms. */
export function createV2RecoveryAttachments(
    openReader: () => Pick<V2StoreReader, "messageById" | "close">,
): RecoveryAttachments {
    return (sessionId, messageId) => {
        const reader = openReader();
        try {
            const row = reader.messageById(sessionId, messageId);
            if (row?.type !== "user" || !Array.isArray(row.data.files)) return [];
            return row.data.files.map((file: Record<string, unknown>, index: number) => {
                const source = file.source as { uri?: unknown } | undefined;
                return {
                    type: "file",
                    filename: file.name,
                    mime: file.mime,
                    url: source?.uri,
                    partIndex: index + 1,
                };
            });
        } finally {
            reader.close();
        }
    };
}
