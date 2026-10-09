import { createHash } from "node:crypto";
import type { Compartment } from "./compartment-storage";

/** Version of the rescoring rules; TS and Rust readers must use the same integer. */
export const RESCORE_RUBRIC_VERSION = 1;

/** Display-only epoch milliseconds. Eligibility uses rescore_activation, not this date. */
export const HISTORIAN_REFERENCE_FIX_SHIPPED_AT = Date.parse("2026-10-06T10:13:16Z");

export type RescoreSource = Pick<
    Compartment,
    | "id"
    | "sessionId"
    | "createdAt"
    | "title"
    | "episodeType"
    | "legacy"
    | "content"
    | "p1"
    | "p2"
    | "p3"
    | "p4"
    | "sequence"
    | "startMessage"
    | "endMessage"
    | "startMessageId"
    | "endMessageId"
    | "startBlockIndex"
    | "endBlockIndex"
    | "importance"
>;

/**
 * SHA-256 of a versioned, fixed-order UTF-8 stream, independent of compartment
 * serialization or host-resolved dates. Each value is encoded as N; (null),
 * I<decimal>; (safe integer), or S<byte-length>:<bytes>; (string). Strings are
 * neither trimmed nor Unicode-normalized. Missing block indices equal null.
 *
 * Field order: id, sessionId, createdAt, title, episodeType, legacy, content,
 * p1, p2, p3, p4, sequence, startMessage, endMessage, startMessageId,
 * endMessageId, startBlockIndex, endBlockIndex, importance. Tiered rows encode
 * null content; legacy rows encode content and null tiers. The domain prefix
 * is the literal ASCII mc-rescore-source-v1 followed by a NUL byte.
 *
 * Creation identity prevents a reused id or a moved row from inheriting a
 * selection. Original importance also invalidates manual base-score edits.
 */
export function computeRescoreSourceIdentity(source: RescoreSource): string {
    const hash = createHash("sha256").update("mc-rescore-source-v1\0", "utf8");
    const legacy = source.legacy !== 0;
    const values: (string | number | null)[] = [
        source.id,
        source.sessionId,
        source.createdAt,
        source.title,
        source.episodeType,
        source.legacy,
        legacy ? source.content : null,
        legacy ? null : source.p1,
        legacy ? null : source.p2,
        legacy ? null : source.p3,
        legacy ? null : source.p4,
        source.sequence,
        source.startMessage,
        source.endMessage,
        source.startMessageId,
        source.endMessageId,
        source.startBlockIndex ?? null,
        source.endBlockIndex ?? null,
        source.importance,
    ];
    for (const value of values) {
        if (value === null) {
            hash.update("N;");
        } else if (typeof value === "number") {
            if (!Number.isSafeInteger(value)) {
                throw new Error("Rescore source identity requires safe integers");
            }
            hash.update(`I${value};`);
        } else {
            const bytes = Buffer.from(value, "utf8");
            hash.update(`S${bytes.length}:`).update(bytes).update(";");
        }
    }
    return hash.digest("hex");
}
