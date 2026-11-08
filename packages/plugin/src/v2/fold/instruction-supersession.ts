import {
    readReplayEnvelope,
    updateReplayDocument,
} from "../../features/magic-context/storage-replay-document";
import {
    type HostRowReclaim,
    hostInstructionRow,
    markRetiredInstructionRow,
} from "../../hooks/magic-context/host-served-rows";
import type { MessageLike } from "../../hooks/magic-context/tag-messages";
import type { Database } from "../../shared/sqlite";
import type { StoreRow } from "../store-reader";
import { supersededInstructionIDs } from "./code-mode-catalog";

const namespace = "instructionSupersession";

function decode(value: unknown): Set<string> {
    if (value === undefined) return new Set();
    if (!Array.isArray(value) || !value.every((id) => typeof id === "string" && id.length > 0))
        throw new Error("Invalid instruction supersession replay state");
    return new Set(value);
}

export function retiredLiveInstructionIDs(db: Database, sessionID: string): Set<string> {
    return decode(readReplayEnvelope(db, sessionID)[namespace]);
}

export type SupersessionRow = StoreRow;

/** Persisted instruction-retirement decisions use store identity, never instruction text. */
export function reclaimInstructionRows(
    db: Database,
    sessionID: string,
    messages: MessageLike[],
    permitted: boolean,
    folded: ReadonlySet<string> = new Set(),
): HostRowReclaim {
    const rows = messages.flatMap((message) => {
        const row = hostInstructionRow(message.info) as SupersessionRow | undefined;
        return row ? [{ message, row }] : [];
    });
    const retired = rows.length ? retiredLiveInstructionIDs(db, sessionID) : new Set<string>();
    const selected = permitted
        ? supersededInstructionIDs(rows.map(({ row }) => row))
        : new Set<string>();
    const newlyRetired = new Set([...selected].filter((id) => !retired.has(id)));
    const omitted = new Set([...retired, ...newlyRetired]);
    const edits: MessageLike[] = [];
    for (const { message, row } of rows) {
        if (!omitted.has(row.id)) continue;
        if (newlyRetired.has(row.id) && message.parts.length > 0) edits.push(message);
        // Empty the row in place rather than removing it. On some Anthropic models
        // a thinking block's signature covers every byte before it, so removing
        // this row invalidates later thinking. The transform still needs the
        // row's position to find and strip that thinking. The payload bridge
        // leaves the emptied row out of the request.
        message.parts = [];
    }
    return {
        edits,
        commit() {
            // The transform calls this only after required thinking omissions are
            // durable. A failed omission must leave these choices fresh for retry.
            if (
                newlyRetired.size > 0 &&
                !updateReplayDocument(db, sessionID, (doc) => {
                    const current = decode(doc[namespace]);
                    if ([...newlyRetired].every((id) => current.has(id))) return false;
                    for (const id of folded) current.delete(id);
                    for (const id of newlyRetired) current.add(id);
                    doc.version = 2;
                    doc[namespace] = [...current];
                    return true;
                })
            )
                throw new Error("Cannot persist instruction supersession");
            for (const { message, row } of rows) {
                if (omitted.has(row.id)) markRetiredInstructionRow(message.info);
            }
        },
    };
}
