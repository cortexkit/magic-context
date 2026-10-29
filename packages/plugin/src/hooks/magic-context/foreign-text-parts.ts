import { removePendingOp } from "../../features/magic-context/storage-ops";
import type { Database, Statement } from "../../shared/sqlite";
import { isTextPart } from "./tag-part-guards";

/**
 * Text parts another OpenCode 1 plugin added to a stored message.
 *
 * OpenCode 1 gives every part it stores a `prt_…` id, including the parts it
 * creates mid-turn, before handing the messages to
 * `experimental.chat.messages.transform`. A text part with no id inside a
 * message that has stored parts was therefore appended by a plugin that ran
 * earlier in the same hook (for example an auth plugin's effort marker). Such
 * a part is that plugin's content, so the tagger never tags it, saves it or
 * restores an older copy over it: a new part passes through unchanged. A part
 * an older release already tagged keeps serving what that release served
 * (its prefix, drop placeholder or compressed form) while the plugin's text is
 * unchanged, so a cache-hit pass never changes its bytes.
 */
export type ForeignTextParts = { has(part: object): boolean };

interface ForeignMessageLike {
    info: { id?: unknown };
    parts: unknown[];
}

function hasStringId(part: unknown): boolean {
    return (
        part !== null &&
        typeof part === "object" &&
        typeof (part as { id?: unknown }).id === "string"
    );
}

/** Index of the last part OpenCode stored (one with an id), or -1. */
export function lastStoredPartIndex(parts: readonly unknown[]): number {
    for (let index = parts.length - 1; index >= 0; index -= 1) {
        if (hasStringId(parts[index])) return index;
    }
    return -1;
}

/**
 * Collect the id-less text parts of messages that also carry stored parts.
 * Call this on the array the host handed to the hook, before Magic Context
 * edits anything, so parts Magic Context itself adds later in the pass are
 * never mistaken for another plugin's. Messages with no stored part (test
 * fixtures, rows built whole by a plugin or by Magic Context) are left alone.
 */
export function collectForeignTextParts(
    messages: readonly ForeignMessageLike[],
): ForeignTextParts | undefined {
    let foreign: WeakSet<object> | undefined;
    for (const message of messages) {
        if (typeof message.info.id !== "string") continue;
        if (!message.parts.some(hasStringId)) continue;
        for (const part of message.parts) {
            if (isTextPart(part) && !hasStringId(part)) {
                foreign ??= new WeakSet();
                foreign.add(part);
            }
        }
    }
    return foreign;
}

// Tags that a release before this rule existed put on another plugin's part.
// The transform records them as it sees them so ctx_reduce can tell the model
// there is nothing to reclaim. Process memory is enough: ctx_reduce only runs
// after a transform pass of the same process served the tag, and the tagger
// also removes any drop queued for such a tag before the drain could apply it.
const legacyForeignTextTags = new Map<string, Set<number>>();

export function rememberLegacyForeignTextTags(
    sessionId: string,
    tagNumbers: Iterable<number>,
): void {
    for (const tagNumber of tagNumbers) {
        let known = legacyForeignTextTags.get(sessionId);
        if (!known) {
            known = new Set();
            legacyForeignTextTags.set(sessionId, known);
        }
        known.add(tagNumber);
    }
}

export function isLegacyForeignTextTag(sessionId: string, tagNumber: number): boolean {
    return legacyForeignTextTags.get(sessionId)?.has(tagNumber) ?? false;
}

/** @internal test isolation */
export function clearLegacyForeignTextTagsForTest(): void {
    legacyForeignTextTags.clear();
}

const pendingOpForTagStatements = new WeakMap<Database, Statement>();

/**
 * Remove a drop queued for a legacy foreign tag. The tag has no target, so
 * the drain would mark it dropped without changing the wire, and the next
 * pass would then serve the part without its prefix: a byte change on a pass
 * that may not change bytes. Reads first so an ordinary pass does not write.
 */
export function discardPendingOpForForeignTag(
    db: Database,
    sessionId: string,
    tagNumber: number,
): void {
    let statement = pendingOpForTagStatements.get(db);
    if (!statement) {
        statement = db.prepare(
            "SELECT 1 AS present FROM pending_ops WHERE session_id = ? AND tag_id = ? LIMIT 1",
        );
        pendingOpForTagStatements.set(db, statement);
    }
    if (statement.get(sessionId, tagNumber)) removePendingOp(db, sessionId, tagNumber);
}
