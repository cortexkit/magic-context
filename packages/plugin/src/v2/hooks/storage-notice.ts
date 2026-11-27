import {
    type FailClosedReason,
    formatFailClosedBlockingSummary,
} from "../../features/magic-context/fail-closed-block";
import type { StoreRow } from "../store-reader";
import type { V2Message } from "./types";

/**
 * Every notice Magic Context stores in an OpenCode 2 conversation about its own
 * storage starts with this text. The notices are for the user: none of them may
 * reach the model, and the conversation keeps them across restarts, so they are
 * recognized by this reserved prefix together with their original admission or
 * their persisted native fork-copy shape, never by process memory.
 */
export const STORAGE_NOTICE_PREFIX = "[Magic Context storage notice] ";

/** The notice stored when a turn is refused because the context database is unavailable. */
export function formatStorageRefusalNotice(reason: FailClosedReason): string {
    return `${STORAGE_NOTICE_PREFIX}This turn was not sent to the model. ${formatFailClosedBlockingSummary(reason)}`;
}

/** The notice stored once when the context database opens after a refused start. */
export function formatStorageRecoveryNotice(hiddenWorkRecovered: boolean): string {
    return hiddenWorkRecovered
        ? `${STORAGE_NOTICE_PREFIX}Magic Context storage is available again and turns are sent to the model. The historian and dreamer are running again. Restart OpenCode to enable Magic Context's tools.`
        : `${STORAGE_NOTICE_PREFIX}Magic Context storage is available again and turns are sent to the model. Restart OpenCode to enable Magic Context's tools, historian and dreamer.`;
}

export function isStorageNoticeText(text: unknown): boolean {
    return typeof text === "string" && text.startsWith(STORAGE_NOTICE_PREFIX);
}

/** Both request handling and row restoration recognize the same native notice shape. */
export function isStoredStorageNotice(row: Pick<StoreRow, "type" | "data">): boolean {
    return row.type === "synthetic" && isStorageNoticeText(row.data.text);
}

/** A native fork assigns `msg_<fork-event-id>_<source-seq>` and preserves seq. */
export function isCopiedStorageNotice(row: StoreRow | null): boolean {
    return (
        row !== null &&
        isStoredStorageNotice(row) &&
        /^msg_[A-Za-z0-9]+_\d+$/.test(row.id) &&
        row.id.endsWith(`_${row.seq}`)
    );
}

/**
 * Whether a request message has the shape the host gives a stored notice: a user
 * message whose only part is the notice text. The caller still confirms that the
 * host recorded the message as a Magic Context synthetic.
 */
export function hasStorageNoticeShape(message: V2Message): boolean {
    if (message.role !== "user" || typeof message.id !== "string") return false;
    if (message.content.length !== 1) return false;
    const part = message.content[0];
    return part?.type === "text" && isStorageNoticeText(part.text);
}

/**
 * Remove stored storage notices from a request draft in place. A message counts
 * only when it has the notice shape and either has a durable admission record or
 * is a native fork copy. A user who types the same text keeps their message.
 */
export async function dropStorageNotices(
    messages: V2Message[],
    isAdmittedSynthetic: (id: string) => Promise<boolean>,
    isCopy: (id: string) => boolean = () => false,
): Promise<number> {
    const drop = new Set<V2Message>();
    for (const message of messages) {
        if (!message.id || !hasStorageNoticeShape(message)) continue;
        if ((await isAdmittedSynthetic(message.id)) || isCopy(message.id)) drop.add(message);
    }
    if (drop.size === 0) return 0;
    const kept = messages.filter((message) => !drop.has(message));
    messages.splice(0, messages.length, ...kept);
    return drop.size;
}

/** After removing notices, scan back to the last reply or the row order of the last idle. */
export function storageNoticeHasNewInput(
    messages: readonly V2Message[],
    idleSeq: number,
    sequenceOf: (id: string) => number | undefined,
): boolean {
    let idlessTool = false;
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message.role === "assistant") {
            if (!idlessTool) return false;
            // A tool result without its own row follows the assistant call that owns it.
            const owner = message.id ? sequenceOf(message.id) : undefined;
            return owner === undefined || owner > idleSeq;
        }
        if (message.role !== "user" && message.role !== "tool") continue;
        if (!message.id) {
            if (message.role === "user") return true;
            idlessTool = true;
            continue;
        }
        const seq = sequenceOf(message.id);
        if (seq === undefined || seq > idleSeq) return true;
        // A result after the last idle may be new if its assistant call is not in the draft.
        return idlessTool;
    }
    return idlessTool;
}
