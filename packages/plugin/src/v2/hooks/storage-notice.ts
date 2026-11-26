import {
    type FailClosedReason,
    formatFailClosedBlockingSummary,
} from "../../features/magic-context/fail-closed-block";
import type { V2Message } from "./types";

/**
 * Every notice Magic Context stores in an OpenCode 2 conversation about its own
 * storage starts with this text. The notices are for the user: none of them may
 * reach the model, and the conversation keeps them across restarts, so they are
 * recognized by this fixed prefix together with the host's own record that the
 * message is a synthetic one Magic Context sent, never by process memory.
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
 * only when it has the notice shape and `isAdmittedSynthetic` confirms, from the
 * host's durable plugin storage, that Magic Context sent it as a synthetic; a
 * user who types the same text keeps their message. Returns how many were removed.
 */
export async function dropStorageNotices(
    messages: V2Message[],
    isAdmittedSynthetic: (id: string) => Promise<boolean>,
): Promise<number> {
    const drop = new Set<V2Message>();
    for (const message of messages) {
        if (!hasStorageNoticeShape(message)) continue;
        if (await isAdmittedSynthetic(message.id as string)) drop.add(message);
    }
    if (drop.size === 0) return 0;
    const kept = messages.filter((message) => !drop.has(message));
    messages.splice(0, messages.length, ...kept);
    return drop.size;
}
