import { createHash } from "node:crypto";
import {
    LKG_SNAPSHOT_ARRAY,
    LKG_SNAPSHOT_BOOLEAN,
    LKG_SNAPSHOT_KEY,
    LKG_SNAPSHOT_NULL,
    LKG_SNAPSHOT_NUMBER,
    LKG_SNAPSHOT_OBJECT,
    LKG_SNAPSHOT_STRING,
    LKG_SNAPSHOT_UNDEFINED,
    type LkgContentField,
    type LkgSlot,
    lkgContentFields,
    messageContentFields,
} from "./lkg-slot";

export interface MoveInputSummary {
    count: number;
    digest: string;
}

function jsonString(value: unknown): string {
    if (
        typeof value !== "string" ||
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)
    )
        throw new Error("host input contains invalid Unicode");
    return JSON.stringify(value);
}

/** Canonicalize detached input tokens, not the output a later hook may have rewritten. */
export function moveMessageDigestFromFields(fields: readonly LkgContentField[]): string {
    let index = 0;
    const value = (): string => {
        const kind = fields[index++];
        if (kind === LKG_SNAPSHOT_NULL || kind === LKG_SNAPSHOT_UNDEFINED) return "null";
        if (kind === LKG_SNAPSHOT_STRING) return jsonString(fields[index++]);
        if (kind === LKG_SNAPSHOT_BOOLEAN) {
            const boolean = fields[index++];
            if (typeof boolean !== "boolean") throw new Error("invalid input boolean");
            return String(boolean);
        }
        if (kind === LKG_SNAPSHOT_NUMBER) {
            const number = fields[index++];
            if (typeof number !== "number" || !Number.isFinite(number))
                throw new Error("host input contains a non-finite number");
            return JSON.stringify(number);
        }
        const count = fields[index++];
        if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
            throw new Error("invalid input token count");
        if (kind === LKG_SNAPSHOT_ARRAY) {
            const children = Array.from({ length: count }, value);
            return `[${children.join(",")}]`;
        }
        if (kind === LKG_SNAPSHOT_OBJECT) {
            const children: Array<[string, string]> = [];
            for (let i = 0; i < count; i++) {
                if (fields[index++] !== LKG_SNAPSHOT_KEY) throw new Error("invalid input key");
                const key = fields[index++];
                if (typeof key !== "string") throw new Error("invalid input key");
                jsonString(key);
                children.push([key, value()]);
            }
            // RFC 8785 orders unescaped property names by UTF-16 code units.
            children.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
            return `{${children.map(([key, child]) => `${jsonString(key)}:${child}`).join(",")}}`;
        }
        throw new Error("invalid input token kind");
    };
    const canonical = value();
    if (index !== fields.length) throw new Error("extra input tokens");
    return createHash("sha256").update(canonical).digest("hex");
}

/** Shared hostCut combination: ordered, unescaped mid/newline/hex-digest/newline. */
export function summarizeMoveInputs(
    ids: readonly string[],
    digests: readonly string[],
): MoveInputSummary {
    if (ids.length !== digests.length || new Set(ids).size !== ids.length)
        throw new Error("invalid host input sequence");
    const hash = createHash("sha256");
    ids.forEach((id, i) => {
        const digest = digests[i] ?? "";
        if (!id || id.includes("\n") || !/^[0-9a-f]{64}$/.test(digest))
            throw new Error("invalid host input id or digest");
        hash.update(`${id}\n${digest}\n`);
    });
    return { count: ids.length, digest: hash.digest("hex") };
}

/**
 * The host supplies its exact ingestion projection through the last input, excluding
 * the answering assistant. OpenCode uses MessageLike; Pi uses native messages and
 * reconciled JSONL ids (not its tagging view's synthetic tool-result users). Rust
 * uses the normalized MessageLike projection passed to the module. Ordering and
 * transcript-tail sealing belong to the host adapter, not message-id sorting here.
 */
export function moveInputs(
    mode: "ts" | "rust" | "pi",
    hostTranscript: readonly unknown[],
    piEntryIds?: readonly string[],
): MoveInputSummary {
    const ids = hostTranscript.map((message, i) => {
        const id =
            mode === "pi" ? piEntryIds?.[i] : (message as { info?: { id?: unknown } })?.info?.id;
        if (typeof id !== "string") throw new Error("host input id unavailable");
        return id;
    });
    if (mode === "pi" && piEntryIds?.length !== hostTranscript.length)
        throw new Error("Pi input ids must match native messages");
    const digests = hostTranscript.map((message) => {
        const fields =
            mode === "rust"
                ? messageContentFields(message as Parameters<typeof messageContentFields>[0])
                : lkgContentFields(message);
        if (!fields) throw new Error("host input snapshot unavailable");
        return moveMessageDigestFromFields(fields);
    });
    return summarizeMoveInputs(ids, digests);
}

export function persistedMoveInputs(slot: LkgSlot): MoveInputSummary {
    if (!slot.inputMoveDigests) throw new Error("portable input digests unavailable");
    return summarizeMoveInputs(slot.inputIdSeq, slot.inputMoveDigests);
}
