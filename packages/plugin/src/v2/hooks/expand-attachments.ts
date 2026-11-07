import type { RecoveryAttachments } from "../../tools/ctx-expand/render";
import type { V2StoreReader } from "../store-reader";

/**
 * Borrow the expand worker's reader so every message in a range uses the same connection.
 * Keep the rawMessages view used by history and transforms unchanged.
 */
export function createV2RecoveryAttachments(
    reader: Pick<V2StoreReader, "messageById">,
): RecoveryAttachments {
    return (sessionId, messageId) => {
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
    };
}
