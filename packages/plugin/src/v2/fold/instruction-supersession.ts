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
// Whether covered instruction rows (rows the history summary covers, which
// the transform still serves at the head of the request) follow the persisted
// decisions. Releases before this switch served every covered row, including
// rows retired while they were live, so it is turned on only on a pass that
// may rewrite the whole prefix, and every later pass reads it. Its own
// namespace in the per-session replay document, so no schema change is needed.
const coveredNamespace = "coveredInstructionSupersession";

function decode(value: unknown): Set<string> {
    if (value === undefined) return new Set();
    if (!Array.isArray(value) || !value.every((id) => typeof id === "string" && id.length > 0))
        throw new Error("Invalid instruction supersession replay state");
    return new Set(value);
}

const coveredOn = (value: unknown) =>
    typeof value === "object" && value !== null && (value as { on?: unknown }).on === true;

export function retiredLiveInstructionIDs(db: Database, sessionID: string): Set<string> {
    return decode(readReplayEnvelope(db, sessionID)[namespace]);
}

export function coveredInstructionSupersessionOn(db: Database, sessionID: string): boolean {
    return coveredOn(readReplayEnvelope(db, sessionID)[coveredNamespace]);
}

let coveredSupersessionEnabled = true;

/** False only in tests that reproduce the serving of releases before covered rows followed supersession. */
export function setCoveredInstructionSupersessionEnabledForTests(value: boolean): void {
    coveredSupersessionEnabled = value;
}

export type SupersessionRow = StoreRow;

/**
 * Persisted instruction-retirement decisions use store identity, never
 * instruction text. `covered` holds the instruction rows the history summary
 * covers that this pass serves at the head of the request; they are older
 * than every row in `messages` and follow the same decisions, once the
 * session's switch is on. `permitted` is the transform's whole-prefix rewrite
 * permission (canEditWholePrefix): only such a pass selects new retirements
 * or turns the switch on; every other pass replays the persisted decisions.
 */
export function reclaimInstructionRows(
    db: Database,
    sessionID: string,
    messages: MessageLike[],
    permitted: boolean,
    folded: ReadonlySet<string> = new Set(),
    covered: readonly MessageLike[] = [],
): HostRowReclaim {
    const instructionRows = (list: readonly MessageLike[]) =>
        list.flatMap((message) => {
            const row = hostInstructionRow(message.info) as SupersessionRow | undefined;
            return row ? [{ message, row }] : [];
        });
    const coveredRows = coveredSupersessionEnabled ? instructionRows(covered) : [];
    const rows = [...coveredRows, ...instructionRows(messages)];
    const coveredMessages = new Set(coveredRows.map(({ message }) => message));
    const retired = rows.length ? retiredLiveInstructionIDs(db, sessionID) : new Set<string>();
    const coveredFollowed =
        rows.length > 0 &&
        (coveredRows.length > 0 || permitted) &&
        coveredInstructionSupersessionOn(db, sessionID);
    // The first pass that may rewrite the whole prefix and carries instruction
    // rows turns the switch on, whether or not they are covered yet: a row
    // this pass retires while uncovered becomes a covered row on a later pass
    // that may not, and must stay retired there. Until then covered rows are
    // served as earlier releases served them, so no other pass changes their
    // bytes.
    const switchCovered =
        permitted && rows.length > 0 && !coveredFollowed && coveredSupersessionEnabled;
    const selected = permitted
        ? supersededInstructionIDs(rows.map(({ row }) => row))
        : new Set<string>();
    const newlyRetired = new Set([...selected].filter((id) => !retired.has(id)));
    const omitted = new Set([...retired, ...newlyRetired]);
    const omits = (message: MessageLike, id: string) =>
        omitted.has(id) && (!coveredMessages.has(message) || coveredFollowed || switchCovered);
    const edits: MessageLike[] = [];
    for (const { message, row } of rows) {
        if (!omits(message, row.id)) continue;
        const firstApplication =
            newlyRetired.has(row.id) || (coveredMessages.has(message) && switchCovered);
        if (firstApplication && message.parts.length > 0) edits.push(message);
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
                (newlyRetired.size > 0 || switchCovered) &&
                !updateReplayDocument(db, sessionID, (doc) => {
                    const current = decode(doc[namespace]);
                    if (
                        [...newlyRetired].every((id) => current.has(id)) &&
                        (!switchCovered || coveredOn(doc[coveredNamespace]))
                    )
                        return false;
                    for (const id of folded) current.delete(id);
                    for (const id of newlyRetired) current.add(id);
                    doc.version = 2;
                    doc[namespace] = [...current];
                    if (switchCovered) doc[coveredNamespace] = { on: true };
                    return true;
                })
            )
                throw new Error("Cannot persist instruction supersession");
            for (const { message, row } of rows) {
                if (omits(message, row.id)) markRetiredInstructionRow(message.info);
            }
        },
    };
}
