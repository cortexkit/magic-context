import {
    type CloneCompartmentBoundary,
    type CloneCompartmentRow,
    type CloneSessionStateFilter,
    type CopySessionStateForCloneResult,
    copySessionStateForClone,
} from "../features/magic-context/storage-clone";
import { sessionLog } from "../shared/logger";
import type { Database } from "../shared/sqlite";
import { RAW_MESSAGE_TYPES, type V2ForkOrigin, type V2RowStamp } from "./store-reader";

/**
 * Fork inheritance for OpenCode 2.
 *
 * An OpenCode 2 fork is a new session id. The host copies the parent's settled
 * rows up to the fork boundary into it, keeping each row's `seq`, `type`,
 * `time_created` and body, and gives every copied row a new id of the form
 * `<id derived from the fork event>_<seq>` (`projectFork` in OpenCode's
 * `session/projector.ts`). It records the link in `session_v2.fork_session_id`
 * and `fork_boundary`. Magic Context keys its state by session and message id,
 * so without this the fork starts with no history blocks and no drops.
 *
 * The parent-to-fork id mapping is derived from the stored rows, never from the
 * id text alone: a fork row stands for the parent row with the same `seq`, and
 * the pair is accepted only when the fork id ends in `_<seq>` and both rows
 * have the same type and creation time. Rows the host did not copy (an
 * assistant reply still streaming at fork time, rows after the boundary) have
 * no pair, so nothing anchored to them is inherited.
 */

/** The parent and fork rows paired, plus the fork's own message positions. */
export interface V2ForkIdMap {
    parentToFork: Map<string, string>;
    /** 1-based position of each fork message among the rows Magic Context counts. */
    forkOrdinals: Map<string, number>;
    /** The same positions for the parent's copied rows, by parent id. */
    parentOrdinals: Map<number, string>;
    /** Highest parent `seq` the fork boundary includes. */
    throughSeq: number;
}

const RAW_TYPES = new Set<string>(RAW_MESSAGE_TYPES);

/** The `seq` of the last parent row the fork copied, or undefined when the boundary row is gone. */
export function forkBoundarySeq(
    origin: V2ForkOrigin,
    sequenceForId: (sessionID: string, id: string) => number | undefined,
): number | undefined {
    const seq = sequenceForId(origin.parentSessionID, origin.boundary.messageID);
    if (seq === undefined) return undefined;
    return origin.boundary.type === "before" ? seq - 1 : seq;
}

/**
 * Pair the parent's rows with the fork's copies. `parentRows` and `forkRows`
 * are each session's rows through the boundary seq, in seq order.
 */
export function buildForkIdMap(
    parentRows: readonly V2RowStamp[],
    forkRows: readonly V2RowStamp[],
    throughSeq: number,
): V2ForkIdMap {
    const parentBySeq = new Map<number, V2RowStamp>();
    for (const row of parentRows) if (row.seq <= throughSeq) parentBySeq.set(row.seq, row);
    const parentToFork = new Map<string, string>();
    const forkOrdinals = new Map<string, number>();
    let ordinal = 0;
    for (const row of forkRows) {
        if (row.seq > throughSeq) break;
        if (RAW_TYPES.has(row.type)) {
            ordinal += 1;
            forkOrdinals.set(row.id, ordinal);
        }
        const parent = parentBySeq.get(row.seq);
        if (
            parent &&
            parent.type === row.type &&
            parent.time_created === row.time_created &&
            row.id !== parent.id &&
            row.id.endsWith(`_${row.seq}`)
        ) {
            parentToFork.set(parent.id, row.id);
        }
    }
    const parentOrdinals = new Map<number, string>();
    let parentOrdinal = 0;
    for (const row of parentRows) {
        if (row.seq > throughSeq) break;
        if (!RAW_TYPES.has(row.type)) continue;
        parentOrdinal += 1;
        parentOrdinals.set(parentOrdinal, row.id);
    }
    return { parentToFork, forkOrdinals, parentOrdinals, throughSeq };
}

/** Text and file tags key on `<message id>:p<n>` / `<message id>:file<n>`. */
const CONTENT_ID_SUFFIX = /(:(?:p|file)\d+)$/;
/** Note anchors and some ledgers use `<message id>#<block>`. */
const BLOCK_ID_SUFFIX = /(#\d+)$/;

function splitMessageScopedId(id: string): { messageId: string; suffix: string } {
    const match = id.match(CONTENT_ID_SUFFIX) ?? id.match(BLOCK_ID_SUFFIX);
    if (!match?.[1]) return { messageId: id, suffix: "" };
    return { messageId: id.slice(0, -match[1].length), suffix: match[1] };
}

interface ForkCompartmentProof {
    sessionId: string;
    sequenceForId(id: string): number | undefined;
    matchingBodies(): ReadonlySet<string>;
}

function selectForkCompartments(
    source: readonly CloneCompartmentBoundary[],
    map: V2ForkIdMap,
    proof: ForkCompartmentProof,
): { rows: Map<number, CloneCompartmentRow>; rawTailAfter: number | undefined } {
    const rows = new Map<number, CloneCompartmentRow>();
    const forkId = (id: string) => map.parentToFork.get(id) ?? "";
    const ordinal = (id: string) => map.forkOrdinals.get(forkId(id));
    let matchingPrefix: number | undefined;
    const provePrefix = () => {
        const matching = proof.matchingBodies();
        let length = 0;
        // Missing or extra counted rows, mismatched roles or creation times,
        // and changed bodies invalidate position here even if later ids pair.
        for (const [position, id] of map.parentOrdinals) {
            if (ordinal(id) !== position || !matching.has(id)) break;
            length = position;
        }
        return length;
    };
    let stopped = false;
    let rawTailAfter: number | undefined;
    let lastEnd = 0;
    for (const [i, row] of source.entries()) {
        const { sequence, startMessage, endMessage, startMessageId, endMessageId } = row;
        const start = ordinal(startMessageId);
        const end = ordinal(endMessageId);
        let reason: string;
        if (stopped) {
            // The history head cuts one prefix, not individual intervals. A
            // later summary would advance it past the raw history we just kept.
            reason = "after first skipped compartment";
        } else if (start !== undefined && end !== undefined) {
            rows.set(sequence, {
                sequence,
                startMessage: start,
                endMessage: end,
                startMessageId: forkId(startMessageId),
                endMessageId: forkId(endMessageId),
            });
            lastEnd = end;
            continue;
        } else {
            const startSeq = start === undefined ? proof.sequenceForId(startMessageId) : undefined;
            const endSeq = end === undefined ? proof.sequenceForId(endMessageId) : undefined;
            const pastBoundary =
                (startSeq ?? -1) > map.throughSeq || (endSeq ?? -1) > map.throughSeq;
            const previous = source[i - 1];
            const next = source[i + 1];
            if (pastBoundary) {
                reason = "outside the fork boundary";
            } else if (startSeq !== undefined || endSeq !== undefined) {
                reason = "a live endpoint was not copied";
            } else if (row.rebaseStatus === "unresolved") {
                reason = "parent coordinates are unresolved";
            } else if (
                !Number.isSafeInteger(startMessage) ||
                !Number.isSafeInteger(endMessage) ||
                startMessage < 1 ||
                endMessage < startMessage ||
                endMessage > map.parentOrdinals.size
            ) {
                reason = "range is invalid or not wholly inside the fork boundary";
            } else if (row.startBlockIndex !== null || row.endBlockIndex !== null) {
                reason = "block boundaries cannot be proven by message order";
            } else if (
                (start !== undefined && start !== startMessage) ||
                (end !== undefined && end !== endMessage)
            ) {
                reason = "live endpoint conflicts with the stored position";
            } else if (
                // A complete host copy proves where current parent messages landed,
                // not that these saved ordinals still name the original range.
                // Bound each side with a live anchor at its saved coordinate or
                // an abutting neighbour's live anchor (or the start of history).
                (previous ? previous.endMessage !== startMessage - 1 : startMessage !== 1) ||
                (next && next.startMessage !== endMessage + 1) ||
                (start === undefined &&
                    previous &&
                    ordinal(previous.endMessageId) !== startMessage - 1) ||
                (end === undefined && (!next || ordinal(next.startMessageId) !== endMessage + 1))
            ) {
                reason = "live neighboring anchors do not prove the stored range";
            } else if (
                (end === undefined ? endMessage + 1 : endMessage) >
                (matchingPrefix ??= provePrefix())
            ) {
                reason = "parent and fork raw prefixes do not match in order and body";
            } else {
                rows.set(sequence, {
                    sequence,
                    startMessage,
                    endMessage,
                    startMessageId: forkId(map.parentOrdinals.get(startMessage) ?? ""),
                    endMessageId: forkId(map.parentOrdinals.get(endMessage) ?? ""),
                });
                lastEnd = endMessage;
                continue;
            }
            stopped = true;
            if (!pastBoundary) rawTailAfter = lastEnd;
        }
        sessionLog(
            proof.sessionId,
            `v2 fork skipped compartment ${sequence} (${startMessage}-${endMessage}): ${reason}`,
        );
    }
    return { rows, rawTailAfter };
}

/**
 * The clone filter for one fork. Message-scoped ids map through the paired
 * rows. Tool call ids are not message ids: the host copies the rows' bodies
 * unchanged, so a tool call keeps its id in the fork and is included when the
 * message that owns it was copied.
 */
export function forkCloneFilter(
    idMap: V2ForkIdMap,
    copiedToolCallIds: ReadonlySet<string>,
    proof?: ForkCompartmentProof,
): CloneSessionStateFilter {
    const mapMessageScoped = (id: string): string | undefined => {
        const direct = idMap.parentToFork.get(id);
        if (direct) return direct;
        const { messageId, suffix } = splitMessageScopedId(id);
        if (!suffix) return undefined;
        const mapped = idMap.parentToFork.get(messageId);
        return mapped ? `${mapped}${suffix}` : undefined;
    };
    let rawTailAfter: number | undefined;
    return {
        selectCompartments:
            proof &&
            ((source) => {
                const plan = selectForkCompartments(source, idMap, proof);
                rawTailAfter = plan.rawTailAfter;
                return plan.rows;
            }),
        resolveBoundaryOrdinal: (messageId) => {
            const forkId = idMap.parentToFork.get(messageId);
            return forkId ? idMap.forkOrdinals.get(forkId) : undefined;
        },
        includeMessageId: (messageId) =>
            mapMessageScoped(messageId) !== undefined || copiedToolCallIds.has(messageId),
        mapMessageId: (messageId) => mapMessageScoped(messageId) ?? messageId,
        includeTag: (tag) => {
            if (rawTailAfter !== undefined) {
                // A historian queues regular drops for covered content. In an
                // unproven tail they are indistinguishable from other drops;
                // neither the committed status nor the queue may hide that raw input.
                const owner =
                    tag.type === "tool"
                        ? tag.toolOwnerMessageId
                        : splitMessageScopedId(tag.messageId).messageId;
                const copy = owner && idMap.parentToFork.get(owner);
                if (!copy || (idMap.forkOrdinals.get(copy) ?? Infinity) > rawTailAfter)
                    return false;
            }
            if (tag.type === "tool") {
                return (
                    tag.toolOwnerMessageId !== null &&
                    idMap.parentToFork.has(tag.toolOwnerMessageId)
                );
            }
            return mapMessageScoped(tag.messageId) !== undefined;
        },
        mapOrdinal: (sourceOrdinal) => {
            const parentId = idMap.parentOrdinals.get(sourceOrdinal);
            const forkId = parentId ? idMap.parentToFork.get(parentId) : undefined;
            return forkId ? idMap.forkOrdinals.get(forkId) : undefined;
        },
        copySessionNotesAndFacts: true,
        // The pending marker column is Pi's; OpenCode sessions never carry one.
        selectPendingPiMarker: () => null,
    };
}

export type V2ForkSeedOutcome =
    | { kind: "not-a-fork" }
    | { kind: "has-state" }
    | { kind: "parent-missing"; parentSessionID: string; reason: string }
    | {
          kind: "seeded";
          parentSessionID: string;
          pairedRows: number;
          result: CopySessionStateForCloneResult;
      }
    | { kind: "destination-not-empty"; parentSessionID: string };

/** What the seed reads from the OpenCode 2 store. */
export interface V2ForkStore {
    forkOrigin(sessionID: string): V2ForkOrigin | null;
    sessionExists(sessionID: string): boolean;
    sequenceForId(sessionID: string, id: string): number | undefined;
    rowStampsThrough(sessionID: string, throughSeq: number): V2RowStamp[];
    matchingForkBodies(parentID: string, forkID: string, throughSeq: number): ReadonlySet<string>;
}

function countSessionRows(db: Database, table: string, sessionId: string): number {
    const row = db
        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`)
        .get(sessionId) as { count?: number } | undefined;
    return typeof row?.count === "number" ? row.count : 0;
}

/** True when Magic Context already holds history blocks or tags for the session. */
export function sessionHasMagicContextState(db: Database, sessionId: string): boolean {
    return (
        countSessionRows(db, "compartments", sessionId) > 0 ||
        countSessionRows(db, "tags", sessionId) > 0
    );
}

/**
 * Seed a fork's Magic Context state from its parent, up to the fork boundary,
 * the first time Magic Context meets the fork.
 *
 * The copy is `copySessionStateForClone`, the same copier `/clone` and Pi's
 * branch inheritance use: history blocks whose two ends were copied, with
 * their positions recomputed in the fork; the session facts; session notes
 * whose anchor was copied; tags whose message was copied, with their status
 * (compacted, dropped), source contents and queued operations; and the replay
 * decisions that keep the served bytes of the copied history the same as the
 * parent's. Usage, pressure and cached-render columns start fresh, so the
 * fork's first pass renders its history head from the copied history blocks.
 * Compartment events and chunk embeddings are not copied: the copier never
 * copies them (events are stored for future use and never rendered;
 * embeddings are rebuilt on demand).
 *
 * Idempotent across passes and processes: the copier takes the write lock
 * (`BEGIN IMMEDIATE`) before it checks that the fork has no compartments,
 * tags, notes or facts, and declines when it does. The first copy is
 * therefore the only one, and a fork that Magic Context has already served
 * (and so tagged) is never copied into. A fork whose parent has no state
 * here, or whose parent or boundary row the store no longer has, is left as
 * it is; the transform's over-window check handles its first request.
 */
export function seedV2ForkFromParent(args: {
    db: Database;
    store: V2ForkStore;
    sessionId: string;
}): V2ForkSeedOutcome {
    const { db, store, sessionId } = args;
    if (sessionHasMagicContextState(db, sessionId)) return { kind: "has-state" };
    const origin = store.forkOrigin(sessionId);
    if (!origin) return { kind: "not-a-fork" };
    const parentSessionID = origin.parentSessionID;
    if (parentSessionID === sessionId) return { kind: "not-a-fork" };
    if (!sessionHasMagicContextState(db, parentSessionID))
        return { kind: "parent-missing", parentSessionID, reason: "no Magic Context state" };
    if (!store.sessionExists(parentSessionID))
        return { kind: "parent-missing", parentSessionID, reason: "no host session row" };
    const throughSeq = forkBoundarySeq(origin, (session, id) => store.sequenceForId(session, id));
    if (throughSeq === undefined)
        return { kind: "parent-missing", parentSessionID, reason: "boundary row not in the store" };
    const idMap = buildForkIdMap(
        store.rowStampsThrough(parentSessionID, throughSeq),
        store.rowStampsThrough(sessionId, throughSeq),
        throughSeq,
    );
    if (idMap.parentToFork.size === 0)
        return { kind: "parent-missing", parentSessionID, reason: "no copied rows pair up" };
    const toolTags = db
        .prepare(
            "SELECT message_id, tool_owner_message_id FROM tags WHERE session_id = ? AND type = 'tool'",
        )
        .all(parentSessionID) as Array<{
        message_id: string;
        tool_owner_message_id: string | null;
    }>;
    const copiedToolCallIds = new Set(
        toolTags
            .filter(
                (row) =>
                    row.tool_owner_message_id !== null &&
                    idMap.parentToFork.has(row.tool_owner_message_id),
            )
            .map((row) => row.message_id),
    );
    const result = copySessionStateForClone(
        db,
        parentSessionID,
        sessionId,
        forkCloneFilter(idMap, copiedToolCallIds, {
            sessionId,
            sequenceForId: (id) => store.sequenceForId(parentSessionID, id),
            matchingBodies: () => store.matchingForkBodies(parentSessionID, sessionId, throughSeq),
        }),
    );
    if (result.kind === "destination-not-empty")
        return { kind: "destination-not-empty", parentSessionID };
    return { kind: "seeded", parentSessionID, pairedRows: idMap.parentToFork.size, result };
}
