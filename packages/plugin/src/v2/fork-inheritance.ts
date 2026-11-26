import {
    type CloneCompartmentBoundary,
    type CloneCompartmentRow,
    type CloneSessionStateFilter,
    type CopySessionStateForCloneResult,
    copySessionStateForClone,
} from "../features/magic-context/storage-clone";
import type { InheritedCoordinateGap } from "../features/magic-context/store-generation-rebase";
import { validateStoredCompartments } from "../hooks/magic-context/compartment-runner-validation";
import { nonNarrativeStoredGapRanges } from "../hooks/magic-context/stored-compartment-gaps";
import { sessionLog } from "../shared/logger";
import type { Database } from "../shared/sqlite";
import { readV2MessageRange } from "./hooks/store";
import {
    RAW_MESSAGE_TYPES,
    type V2ForkOrigin,
    type V2RowStamp,
    type V2StoreReader,
} from "./store-reader";

/**
 * Fork inheritance for OpenCode 2.
 *
 * An OpenCode 2 fork is a new session id. The host copies the parent's settled
 * rows up to the fork boundary into it, keeping each row's `seq`, `type` and
 * `time_created`, and gives every copied row a new id of the form
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
    /** Counted parent rows through the boundary, including rows the fork did not copy. */
    parentOrdinals: Map<number, string>;
    /** Inclusive parent sequence limit from the fork boundary, not proof of a copy. */
    throughSeq: number;
}

const RAW_TYPES = new Set<string>(RAW_MESSAGE_TYPES);

/** Convert the host boundary to an inclusive parent sequence limit. */
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
    matchingBodies(): ReadonlyMap<string, string>;
    acceptedGaps(
        source: readonly CloneCompartmentBoundary[],
        onConversionGap?: (gap: InheritedCoordinateGap) => void,
    ): InheritedCoordinateGap[];
}

function selectForkCompartments(
    source: readonly CloneCompartmentBoundary[],
    map: V2ForkIdMap,
    proof: ForkCompartmentProof,
): {
    rows: Map<number, CloneCompartmentRow>;
    keepRaw: Set<string>;
    inheritedGaps: InheritedCoordinateGap[];
} {
    const rows = new Map<number, CloneCompartmentRow>();
    const forkId = (id: string) => map.parentToFork.get(id) ?? "";
    const ordinal = (id: string) => map.forkOrdinals.get(forkId(id));
    let matchingPrefix: number | undefined;
    const provePrefix = () => {
        const matching = proof.matchingBodies();
        let length = 0;
        // Compare the current parent and fork. An edit to the parent after the
        // summary was written but before forking can leave both rows with the
        // same new text; neither store records what the historian read.
        // Ordinal equality also rejects a counted row added to the fork,
        // which the body comparison of paired rows alone cannot see.
        for (const [position, id] of map.parentOrdinals) {
            if (ordinal(id) !== position || matching.get(id) !== forkId(id)) break;
            length = position;
        }
        return length;
    };
    let stopped = false;
    let lastEnd = 0;
    let acceptedGaps: ReturnType<ForkCompartmentProof["acceptedGaps"]> | undefined;
    const conversionGaps: InheritedCoordinateGap[] = [];
    const inheritedGaps: InheritedCoordinateGap[] = [];
    for (const [i, row] of source.entries()) {
        const { sequence, startMessage, endMessage, startMessageId, endMessageId } = row;
        const start = ordinal(startMessageId);
        const end = ordinal(endMessageId);
        let reason: string;
        if (stopped) {
            // The history head cuts one prefix, not individual intervals. A
            // later summary would advance it past the raw history we just kept.
            reason = "after first skipped compartment";
        } else {
            const startSeq = start === undefined ? proof.sequenceForId(startMessageId) : undefined;
            const endSeq = end === undefined ? proof.sequenceForId(endMessageId) : undefined;
            const previous = source[i - 1];
            const next = source[i + 1];
            // An out-of-bound ID also fails the uncopied-ID check. Keep the
            // distinction so an ordinary fork point gets the right reason.
            if ((startSeq ?? -1) > map.throughSeq || (endSeq ?? -1) > map.throughSeq) {
                reason = "outside the fork boundary";
            } else if (startSeq !== undefined || endSeq !== undefined) {
                reason = "a live endpoint was not copied";
            } else if (row.rebaseStatus === "unresolved") {
                reason = "parent coordinates are unresolved";
            } else if (
                !Number.isSafeInteger(startMessage) ||
                !Number.isSafeInteger(endMessage) ||
                startMessage < 1 ||
                endMessage < startMessage
            ) {
                reason = "invalid message range";
            } else if (startMessage <= lastEnd) {
                reason = "range overlaps the inherited prefix";
            } else if (
                startMessage > lastEnd + 1 &&
                validateStoredCompartments(
                    // Collapse the already-accepted prefix so the validator
                    // checks just the gap before this candidate.
                    lastEnd > 0 ? [{ startMessage: 1, endMessage: lastEnd }, row] : [row],
                    (acceptedGaps ??= proof.acceptedGaps(source, (gap) =>
                        conversionGaps.push(gap),
                    )),
                ) !== null
            ) {
                reason = "gap before range";
            } else if (
                (start !== undefined && start !== startMessage) ||
                (end !== undefined && end !== endMessage)
            ) {
                reason = "live endpoint conflicts with the stored position";
            } else if (
                // A stale ID needs an anchor among the host's current rows.
                // The preceding check repeats the prior range proof, but
                // makes the witness for a stale start explicit here.
                (start === undefined && previous && ordinal(previous.endMessageId) !== lastEnd) ||
                (end === undefined &&
                    (!next ||
                        next.startMessage !== endMessage + 1 ||
                        ordinal(next.startMessageId) !== endMessage + 1))
            ) {
                reason = "live neighboring anchors do not prove the stored range";
            } else if (
                (end === undefined ? endMessage + 1 : endMessage) >
                (matchingPrefix ??= provePrefix())
            ) {
                reason = "parent and fork raw prefixes do not match in order and body";
            } else {
                // The copier preserves block indices. The byte proof above
                // includes every part of both messages those indices address.
                rows.set(sequence, {
                    sequence,
                    startMessage,
                    endMessage,
                    startMessageId: forkId(map.parentOrdinals.get(startMessage) ?? ""),
                    endMessageId: forkId(map.parentOrdinals.get(endMessage) ?? ""),
                });
                const conversionGap = conversionGaps.find(
                    ({ start, end }) => start === lastEnd + 1 && end === startMessage - 1,
                );
                // Every position in this gap was proved equal in the fork,
                // so the accepted interval already uses the fork's ordinals.
                if (conversionGap) inheritedGaps.push(conversionGap);
                lastEnd = endMessage;
                continue;
            }
            stopped = true;
        }
        sessionLog(
            proof.sessionId,
            `v2 fork skipped compartment ${sequence} (${startMessage}-${endMessage}): ${reason}`,
        );
    }
    // Do not replay removals from a rejected summary: those messages need to
    // remain raw. An independent drop outside those ranges still applies.
    // Protect a boundary message even if the summary covers only part of it.
    const keepRaw = new Set<string>();
    if (stopped) {
        const count = map.parentOrdinals.size;
        const changes = new Int32Array(count + 2);
        const markCovered = (from: number, to: number) => {
            const start = Math.max(1, from);
            const end = Math.min(count, to);
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) return;
            changes[start] = (changes[start] ?? 0) + 1;
            changes[end + 1] = (changes[end + 1] ?? 0) - 1;
        };
        const parentPositions = new Map(
            [...map.parentOrdinals].map(([position, id]) => [id, position]),
        );
        const liveOrdinal = (id: string) => {
            const position = parentPositions.get(id);
            if (position !== undefined) return position;
            return (proof.sequenceForId(id) ?? -1) > map.throughSeq ? count + 1 : undefined;
        };
        const live = source.map((row) => ({
            start: liveOrdinal(row.startMessageId),
            end: liveOrdinal(row.endMessageId),
        }));
        for (const [index, row] of source.entries()) {
            if (rows.has(row.sequence)) continue;
            markCovered(row.startMessage, row.endMessage);
            // The host can cut at a live end ID past the saved ordinal. Use
            // the neighbouring live endpoint to bound a missing side. If
            // only one side resolves, extend the stored range to cover it.
            const { start, end } = live[index] ?? {};
            if (start === undefined && end === undefined) continue;
            const previousEnd = live[index - 1]?.end;
            const nextStart = live[index + 1]?.start;
            const from =
                start ??
                (previousEnd !== undefined ? previousEnd + 1 : index === 0 ? 1 : undefined);
            const to = end ?? (nextStart !== undefined ? nextStart - 1 : undefined);
            if (from !== undefined && to !== undefined) markCovered(from, to);
            else
                markCovered(
                    Math.min(row.startMessage, from ?? row.startMessage),
                    Math.max(row.endMessage, to ?? row.endMessage),
                );
        }
        let covering = 0;
        for (const [position, id] of map.parentOrdinals) {
            covering += changes[position] ?? 0;
            if (covering > 0) keepRaw.add(id);
        }
    }
    return { rows, keepRaw, inheritedGaps };
}

/**
 * The clone filter for one fork. Message-scoped ids map through the paired
 * rows. Tool calls are keyed by call id; their owner determines whether they
 * were copied and whether replay would hide part of a rejected summary.
 */
export function forkCloneFilter(
    idMap: V2ForkIdMap,
    copiedToolCallIds: ReadonlySet<string>,
    proof?: ForkCompartmentProof,
    toolOwners?: ReadonlyMap<string, readonly string[]>,
): CloneSessionStateFilter {
    const mapMessageScoped = (id: string): string | undefined => {
        const direct = idMap.parentToFork.get(id);
        if (direct) return direct;
        const { messageId, suffix } = splitMessageScopedId(id);
        if (!suffix) return undefined;
        const mapped = idMap.parentToFork.get(messageId);
        return mapped ? `${mapped}${suffix}` : undefined;
    };
    let keepRaw: ReadonlySet<string> | undefined;
    let inheritedGaps: InheritedCoordinateGap[] = [];
    const includeMessageId = (messageId: string) =>
        mapMessageScoped(messageId) !== undefined || copiedToolCallIds.has(messageId);
    return {
        selectCompartments:
            proof &&
            ((source) => {
                const plan = selectForkCompartments(source, idMap, proof);
                keepRaw = plan.keepRaw;
                inheritedGaps = plan.inheritedGaps;
                return plan.rows;
            }),
        inheritedCoordinateGaps: proof && (() => inheritedGaps),
        resolveBoundaryOrdinal: (messageId) => {
            const forkId = idMap.parentToFork.get(messageId);
            return forkId ? idMap.forkOrdinals.get(forkId) : undefined;
        },
        includeMessageId,
        includeReplayMessageId: (messageId) =>
            includeMessageId(messageId) &&
            !keepRaw?.has(splitMessageScopedId(messageId).messageId) &&
            !toolOwners?.get(messageId)?.some((owner) => keepRaw?.has(owner)),
        mapMessageId: (messageId) => mapMessageScoped(messageId) ?? messageId,
        includeTag: (tag) => {
            const owner =
                tag.type === "tool"
                    ? tag.toolOwnerMessageId
                    : splitMessageScopedId(tag.messageId).messageId;
            if (owner && keepRaw?.has(owner)) return false;
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
export interface V2ForkStore extends Pick<V2StoreReader, "iterateRawMessageRange"> {
    forkOrigin(sessionID: string): V2ForkOrigin | null;
    sessionExists(sessionID: string): boolean;
    sequenceForId(sessionID: string, id: string): number | undefined;
    rowStampsThrough(sessionID: string, throughSeq: number): V2RowStamp[];
    matchingForkBodies(
        parentID: string,
        forkID: string,
        throughSeq: number,
    ): ReadonlyMap<string, string>;
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
 * branch inheritance use: a proved prefix of history blocks, mapped to real
 * fork ids even when a saved endpoint is stale; the session facts; session notes
 * whose anchor was copied; tags whose message was copied, with their status
 * (compacted, dropped), source contents and queued operations; and replay
 * decisions. Removals in a rejected block cannot come along without the block.
 * Usage, pressure and cached-render columns start fresh, so the
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
    const toolOwners = new Map<string, string[]>();
    for (const row of toolTags) {
        if (!row.tool_owner_message_id) continue;
        const owners = toolOwners.get(row.message_id) ?? [];
        owners.push(row.tool_owner_message_id);
        toolOwners.set(row.message_id, owners);
    }
    const result = copySessionStateForClone(
        db,
        parentSessionID,
        sessionId,
        forkCloneFilter(
            idMap,
            copiedToolCallIds,
            {
                sessionId,
                sequenceForId: (id) => store.sequenceForId(parentSessionID, id),
                matchingBodies: () =>
                    store.matchingForkBodies(parentSessionID, sessionId, throughSeq),
                acceptedGaps: (source, onConversionGap) =>
                    nonNarrativeStoredGapRanges(
                        db,
                        parentSessionID,
                        source,
                        (start, end) =>
                            readV2MessageRange(
                                store,
                                parentSessionID,
                                start,
                                Math.min(end, idMap.parentOrdinals.size),
                            ),
                        onConversionGap,
                    ),
            },
            toolOwners,
        ),
    );
    if (result.kind === "destination-not-empty")
        return { kind: "destination-not-empty", parentSessionID };
    return { kind: "seeded", parentSessionID, pairedRows: idMap.parentToFork.size, result };
}
