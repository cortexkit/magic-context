import {
    isStrictGapHealingMessage,
    type RawMessage,
} from "../../hooks/magic-context/read-session-raw";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import {
    clearIndexedMessagesInTransaction,
    indexSourcesAfterOrdinal,
    type MessageIndexSource,
    toMessageIndexSource,
} from "./message-index";
import { clearCachedM0M1, ensureSessionMetaRow } from "./storage-meta-shared";
import {
    sessionMetaCollectionSelect,
    updateSessionMetaCollection,
} from "./storage-session-collections";
import { foldShrunkPartTags, type ShrunkPartMessage } from "./storage-tags";
import { rewriteMessageLabels } from "./store-generation-rebase-labels";

/**
 * Which projection of the OpenCode store a session's saved coordinates were
 * derived against. `v1` is the `message`/`part` reader, `v2` is the
 * `session_message` reader.
 */
export type CoordinateGeneration = "v1" | "v2";

export interface StoreGenerationRebaseOutcome {
    /**
     * `unchanged` — the session's recorded projection already matches the running
     * host, so nothing was read or written.
     * `stamped` — the projection was recorded for the first time (or changed) but
     * no saved coordinate actually moved, so only the stamp was written.
     * `rebased` — coordinates moved and were re-derived.
     * `repaired` — the projection already matched, but unresolved compartments
     * left behind by an older build were placed from their neighbours.
     */
    status: "unchanged" | "stamped" | "rebased" | "repaired";
    generation: CoordinateGeneration;
    previousGeneration: CoordinateGeneration | null;
    compartmentsRebased: number;
    compartmentsUnresolved: number;
    /** Compartments placed `ok` with at least one end taken from a neighbour. */
    compartmentsDerived: number;
    compartmentsResolvedAgain: number;
    recompCompartmentsRebased: number;
    recompCompartmentsUnresolved: number;
    notesRebased: number;
    notesCleared: number;
    priorBoundaryRebased: boolean;
    recompPartialRangeRebased: boolean;
    compressionDepthRowsDropped: number;
    chunkEmbeddingsDeleted: number;
    indexRebuilt: boolean;
    /** Documents written back into the search index after the rebuild. */
    indexRowsRebuilt: number;
    partTagsFolded: number;
    partTagsRekeyed: number;
    queuedReductionsDiscarded: number;
    lkgSlotsDropped: number;
    frozenPartEntriesDropped: number;
    healedGaps: number;
    narrativeGaps: number;
}

/**
 * Durable summary of the last rebase, written so `/ctx-status` and the log can
 * tell the user what the projection change cost them. Only the facts a user can
 * act on are kept.
 */
export interface CoordinateRebaseNotice {
    generation: CoordinateGeneration;
    previousGeneration: CoordinateGeneration | null;
    at: number;
    unresolvedCompartments: number;
    discardedReductions: number;
    droppedDepthRows: number;
    healedGaps: number;
    narrativeGaps: number;
    /**
     * Compartments that lost an anchor message but took the missing end from
     * the neighbouring compartments, with the range they now cover.
     */
    derivedCompartments: CompartmentRangeNote[];
    /** Compartments that could not be placed even from their neighbours. */
    unresolvedCompartmentRanges: CompartmentRangeNote[];
    /**
     * When neighbour recovery last ran over this session's compartments (ms),
     * or null if it never has. Its presence is what keeps the one-time repair
     * of sessions stamped by an older build from running again.
     */
    neighbourRecoveryAt: number | null;
}

/** One compartment named in the rebase notice: its sequence and message range. */
export interface CompartmentRangeNote {
    sequence: number;
    start: number;
    end: number;
}

function emptyOutcome(
    status: StoreGenerationRebaseOutcome["status"],
    generation: CoordinateGeneration,
    previousGeneration: CoordinateGeneration | null,
): StoreGenerationRebaseOutcome {
    return {
        status,
        generation,
        previousGeneration,
        compartmentsRebased: 0,
        compartmentsUnresolved: 0,
        compartmentsDerived: 0,
        compartmentsResolvedAgain: 0,
        recompCompartmentsRebased: 0,
        recompCompartmentsUnresolved: 0,
        notesRebased: 0,
        notesCleared: 0,
        priorBoundaryRebased: false,
        recompPartialRangeRebased: false,
        compressionDepthRowsDropped: 0,
        chunkEmbeddingsDeleted: 0,
        indexRebuilt: false,
        indexRowsRebuilt: 0,
        partTagsFolded: 0,
        partTagsRekeyed: 0,
        queuedReductionsDiscarded: 0,
        lkgSlotsDropped: 0,
        frozenPartEntriesDropped: 0,
        healedGaps: 0,
        narrativeGaps: 0,
    };
}

/**
 * A refusal fence, not the rebase trigger.
 *
 * Only the OpenCode hosts have two store projections to move between. Pi reads
 * its own transcript files and supplies its own raw-message source, so its rows
 * can never be renumbered by an OpenCode store conversion and must never be
 * rewritten by this code even if a caller passes a generation. The decision to
 * REBASE is still taken from the recorded projection, never from this label.
 */
function sessionIsOpenCodeOwned(db: Database, sessionId: string): boolean {
    const row = db
        .prepare("SELECT harness FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { harness?: unknown } | null | undefined;
    const harness = row?.harness;
    // No row yet means a session Magic Context is meeting for the first time on
    // this host, which the caller's own generation describes.
    if (harness === undefined || harness === null) return true;
    return harness === "opencode" || harness === "opencode2";
}

/**
 * The projection an unstamped session's coordinates were written against,
 * inferred from the harness that wrote them. A session labelled `opencode`
 * was read through the 1.x tables; `opencode2` through the 2.x ones. Null when
 * the label carries no such evidence (no row, or a harness with one store
 * shape). A session that flipped BEFORE any generation-aware build saw it and
 * was then relabelled by its newer activity is beyond this: its label already
 * names the running projection, so it reads as never having moved.
 */
function generationImpliedByHarness(db: Database, sessionId: string): CoordinateGeneration | null {
    const row = db
        .prepare("SELECT harness FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { harness?: unknown } | null | undefined;
    if (row?.harness === "opencode") return "v1";
    if (row?.harness === "opencode2") return "v2";
    return null;
}

export function readCoordinateGeneration(
    db: Database,
    sessionId: string,
): CoordinateGeneration | null {
    const row = db
        .prepare("SELECT coordinate_generation FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { coordinate_generation?: unknown } | null | undefined;
    const value = row?.coordinate_generation;
    return value === "v1" || value === "v2" ? value : null;
}

export function readCoordinateRebaseNotice(
    db: Database,
    sessionId: string,
): CoordinateRebaseNotice | null {
    const row = db
        .prepare("SELECT coordinate_rebase_notice FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { coordinate_rebase_notice?: unknown } | null | undefined;
    const raw = row?.coordinate_rebase_notice;
    if (typeof raw !== "string" || raw.length === 0) return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        const record = parsed as Record<string, unknown>;
        if (record.generation !== "v1" && record.generation !== "v2") return null;
        const count = (value: unknown): number =>
            typeof value === "number" && Number.isFinite(value) ? value : 0;
        const ranges = (value: unknown): CompartmentRangeNote[] =>
            Array.isArray(value)
                ? value.flatMap((entry) => {
                      if (!entry || typeof entry !== "object") return [];
                      const { sequence, start, end } = entry as Record<string, unknown>;
                      return typeof sequence === "number" &&
                          typeof start === "number" &&
                          typeof end === "number"
                          ? [{ sequence, start, end }]
                          : [];
                  })
                : [];
        return {
            generation: record.generation,
            previousGeneration:
                record.previousGeneration === "v1" || record.previousGeneration === "v2"
                    ? record.previousGeneration
                    : null,
            at: count(record.at),
            unresolvedCompartments: count(record.unresolvedCompartments),
            discardedReductions: count(record.discardedReductions),
            droppedDepthRows: count(record.droppedDepthRows),
            healedGaps: count(record.healedGaps),
            narrativeGaps: count(record.narrativeGaps),
            derivedCompartments: ranges(record.derivedCompartments),
            unresolvedCompartmentRanges: ranges(record.unresolvedCompartmentRanges),
            neighbourRecoveryAt:
                typeof record.neighbourRecoveryAt === "number" &&
                Number.isFinite(record.neighbourRecoveryAt)
                    ? record.neighbourRecoveryAt
                    : null,
        };
    } catch {
        return null;
    }
}

/**
 * One user-visible line describing what the last projection change cost, or null
 * when the rebase took nothing away.
 */
export function formatCoordinateRebaseNotice(notice: CoordinateRebaseNotice): string | null {
    const parts: string[] = [];
    if (notice.discardedReductions > 0) {
        parts.push(
            `${notice.discardedReductions} queued reduction${notice.discardedReductions === 1 ? " was" : "s were"} discarded because their targets merged in the host's store conversion`,
        );
    }
    if (notice.derivedCompartments.length > 0) {
        const count = notice.derivedCompartments.length;
        parts.push(
            `${count} compartment${count === 1 ? " was" : "s were"} re-anchored from the compartments around ${count === 1 ? "it" : "them"} (${formatRangeNotes(notice.derivedCompartments)})`,
        );
    }
    if (notice.unresolvedCompartments > 0) {
        const listed =
            notice.unresolvedCompartmentRanges.length > 0
                ? ` (${formatRangeNotes(notice.unresolvedCompartmentRanges)})`
                : "";
        parts.push(
            `${notice.unresolvedCompartments} compartment${notice.unresolvedCompartments === 1 ? "" : "s"} could not be re-anchored and are excluded from range recovery${listed}`,
        );
    }
    if (notice.droppedDepthRows > 0) {
        parts.push(`${notice.droppedDepthRows} compression-depth records were rebuilt from zero`);
    }
    if (notice.healedGaps > 0) {
        parts.push(
            `${notice.healedGaps} non-narrative compartment gap${notice.healedGaps === 1 ? " was" : "s were"} healed`,
        );
    }
    if (notice.narrativeGaps > 0) {
        parts.push(
            `${notice.narrativeGaps} narrative compartment gap${notice.narrativeGaps === 1 ? " remains" : "s remain"} for review`,
        );
    }
    return parts.length === 0 ? null : parts.join("; ");
}

function formatRangeNotes(notes: readonly CompartmentRangeNote[]): string {
    return notes.map((note) => `messages ${note.start}-${note.end}`).join(", ");
}

interface CompartmentCoordinateRow {
    id: number;
    sequence: number;
    start_message: number;
    end_message: number;
    start_message_id: string | null;
    end_message_id: string | null;
    rebase_status: string | null;
    title: string;
    content: string;
    p1: string | null;
    p2: string | null;
    p3: string | null;
    p4: string | null;
}

function isCompartmentCoordinateRow(row: unknown): row is CompartmentCoordinateRow {
    if (row === null || typeof row !== "object") return false;
    const candidate = row as Record<string, unknown>;
    return (
        typeof candidate.id === "number" &&
        typeof candidate.sequence === "number" &&
        typeof candidate.start_message === "number" &&
        typeof candidate.end_message === "number"
    );
}

interface PlannedCompartment {
    table: "compartments" | "recomp_compartments";
    id: number;
    sequence: number;
    /** At least one end came from a neighbouring compartment rather than the row's own anchor. */
    derived: boolean;
    previousStart: number;
    previousEnd: number;
    start: number;
    end: number;
    status: "ok" | "unresolved";
    previousStatus: "ok" | "unresolved";
    source: CompartmentCoordinateRow;
    known: KnownEnds;
}

interface NoteCoordinateRow {
    id: number;
    anchor_ordinal: number | null;
    anchor_block_id: string | null;
}

interface PlannedNote {
    id: number;
    ordinal: number | null;
    previousOrdinal: number | null;
}

/**
 * What the rebase keeps from the running host's projection of the session. The
 * messages themselves are not kept: a long session's parts (tool output above
 * all) are many times larger than these fields.
 */
interface Projection {
    ordinalById: Map<string, number>;
    partCountById: Map<string, number>;
    nonNarrativeOrdinals: Set<number>;
    messageCount: number;
    /** What the search index files for each message, in ordinal order, when requested. */
    indexSources: MessageIndexSource[];
}

function emptyProjection(): Projection {
    return {
        ordinalById: new Map(),
        partCountById: new Map(),
        nonNarrativeOrdinals: new Set(),
        messageCount: 0,
        indexSources: [],
    };
}

function addToProjection(
    projection: Projection,
    messages: readonly RawMessage[],
    withIndexSources: boolean,
): void {
    for (const message of messages) {
        projection.ordinalById.set(message.id, message.ordinal);
        projection.partCountById.set(
            message.id,
            Array.isArray(message.parts) ? message.parts.length : 0,
        );
        if (isStrictGapHealingMessage(message))
            projection.nonNarrativeOrdinals.add(message.ordinal);
        if (withIndexSources) projection.indexSources.push(toMessageIndexSource(message));
    }
    projection.messageCount += messages.length;
}

/**
 * The pages of the running projection, read exactly once: from the paged reader
 * when the host supplies one, otherwise as the single page `readMessages` returns.
 */
function readProjectionPages(args: RebaseSessionCoordinatesArgs): Iterable<RawMessage[]> {
    if (args.readMessagePages) return args.readMessagePages(args.sessionId);
    return [args.readMessages(args.sessionId)];
}

/** Build the projection a page at a time, yielding between pages. */
function* buildProjectionSteps(
    args: RebaseSessionCoordinatesArgs,
    withIndexSources: boolean,
): Generator<void, Projection, void> {
    const projection = emptyProjection();
    for (const page of readProjectionPages(args)) {
        addToProjection(projection, page, withIndexSources);
        yield;
    }
    return projection;
}

/** Search-index documents written per transaction while the index is rebuilt. */
const INDEX_REBUILD_CHUNK = 2000;

/** The message id an anchor block id (`<messageId>#<block>`) names. */
function messageIdFromAnchorBlockId(anchorBlockId: string): string {
    const hash = anchorBlockId.lastIndexOf("#");
    return hash > 0 ? anchorBlockId.slice(0, hash) : anchorBlockId;
}

function readCompartmentRows(
    db: Database,
    table: "compartments" | "recomp_compartments",
    sessionId: string,
): CompartmentCoordinateRow[] {
    return db
        .prepare(
            `SELECT id, sequence, start_message, end_message, start_message_id, end_message_id, rebase_status,
                    title, content, p1, p2, p3, p4
             FROM ${table} WHERE session_id = ? ORDER BY sequence ASC`,
        )
        .all(sessionId)
        .filter(isCompartmentCoordinateRow);
}

/**
 * Where the running projection places each end of a compartment, when it can.
 * `undefined` means that end has no position of its own: its anchor message is
 * gone, or the row never recorded one.
 */
interface KnownEnds {
    start: number | undefined;
    end: number | undefined;
}

function resolveAnchor(
    messageId: string | null,
    resolveOrdinal: (messageId: string) => number | undefined,
): number | undefined {
    return messageId && messageId.length > 0 ? resolveOrdinal(messageId) : undefined;
}

function planCompartments(
    rows: readonly CompartmentCoordinateRow[],
    table: "compartments" | "recomp_compartments",
    projection: Projection,
): PlannedCompartment[] {
    const resolveOrdinal = (messageId: string) => projection.ordinalById.get(messageId);
    return recoverFromNeighbours(
        rows,
        table,
        rows.map((row) => ({
            start: resolveAnchor(row.start_message_id, resolveOrdinal),
            end: resolveAnchor(row.end_message_id, resolveOrdinal),
        })),
    );
}

/**
 * Place every compartment from the ends that are known, filling a missing end
 * from the compartment next to it.
 *
 * Compartments tile the history with no gaps and no overlaps, so the message
 * after one compartment's end is where the next one starts. When a row lost an
 * anchor (typically because the host's store conversion removed that message,
 * as it does to the boundary row of a completed native compaction), the
 * neighbouring anchor on the far side of that shared boundary still says where
 * the boundary is:
 *
 * - a known end always wins;
 * - a missing start is the previous compartment's known end + 1, or 1 for the
 *   first compartment;
 * - a missing end is the next compartment's known start - 1.
 *
 * A row is `ok` only when both ends come from its own anchors or from such a
 * neighbour. Anything else stays `unresolved`: the ends that are known are
 * used, the rest keep their stored value (for a trailing compartment with no
 * end anchor that is the end the store recorded), and the range is then
 * clamped so it never overlaps a neighbour that is `ok`. Nothing is guessed:
 * a boundary with no anchor on either side, or a derived range that is empty
 * or inverted, leaves the row unresolved.
 */
function recoverFromNeighbours(
    rows: readonly CompartmentCoordinateRow[],
    table: "compartments" | "recomp_compartments",
    known: readonly KnownEnds[],
): PlannedCompartment[] {
    const plans = rows.map((row, index): PlannedCompartment => {
        const own = known[index] ?? { start: undefined, end: undefined };
        const previousEnd = index === 0 ? 0 : known[index - 1]?.end;
        const nextStart = index === rows.length - 1 ? undefined : known[index + 1]?.start;
        const start = own.start ?? (previousEnd === undefined ? undefined : previousEnd + 1);
        const end = own.end ?? (nextStart === undefined ? undefined : nextStart - 1);
        const base = {
            table,
            id: row.id,
            sequence: row.sequence,
            previousStart: row.start_message,
            previousEnd: row.end_message,
            source: row,
            known: own,
            previousStatus:
                row.rebase_status === "unresolved" ? ("unresolved" as const) : ("ok" as const),
        };
        if (start !== undefined && end !== undefined && start <= end) {
            return {
                ...base,
                start,
                end,
                status: "ok",
                derived: own.start === undefined || own.end === undefined,
            };
        }
        return {
            ...base,
            start: start ?? row.start_message,
            end: end ?? row.end_message,
            status: "unresolved",
            derived: false,
        };
    });

    // An unresolved row's stored ordinals belong to the projection it was
    // written against. Left overlapping an `ok` neighbour, they make the stored
    // history fail validation and stop the historian from ever running again.
    for (let index = 0; index < plans.length; index += 1) {
        const plan = plans[index];
        if (plan?.status !== "unresolved") continue;
        const previous = plans[index - 1];
        const next = plans[index + 1];
        if (previous?.status === "ok" && plan.start <= previous.end) {
            plan.start = previous.end + 1;
        }
        if (next?.status === "ok" && plan.end >= next.start) {
            plan.end = next.start - 1;
        }
    }
    return plans;
}

function healNonNarrativeCompartmentGaps(
    plans: PlannedCompartment[],
    projection: Projection,
): { healed: number; narrative: number } {
    let healed = 0;
    let narrative = 0;
    for (let index = 1; index < plans.length; index += 1) {
        const previous = plans[index - 1];
        const current = plans[index];
        if (!previous || !current || previous.status !== "ok" || current.status !== "ok") continue;
        const gapStart = previous.end + 1;
        const gapEnd = current.start - 1;
        if (gapEnd < gapStart) continue;

        let safeToHeal = true;
        for (let ordinal = gapStart; ordinal <= gapEnd; ordinal += 1) {
            if (!projection.nonNarrativeOrdinals.has(ordinal)) {
                safeToHeal = false;
                break;
            }
        }
        if (safeToHeal) {
            previous.end = gapEnd;
            healed += 1;
        } else {
            narrative += 1;
        }
    }
    return { healed, narrative };
}

function compartmentPlanChanges(plan: PlannedCompartment): boolean {
    return (
        plan.status !== plan.previousStatus ||
        plan.start !== plan.previousStart ||
        plan.end !== plan.previousEnd
    );
}

function rangeNotes(
    plans: readonly PlannedCompartment[],
    predicate: (plan: PlannedCompartment) => boolean,
): CompartmentRangeNote[] {
    return plans
        .filter((plan) => plan.table === "compartments" && predicate(plan))
        .map((plan) => ({ sequence: plan.sequence, start: plan.start, end: plan.end }));
}

function planNotes(db: Database, sessionId: string, projection: Projection): PlannedNote[] {
    const rows = db
        .prepare(
            "SELECT id, anchor_ordinal, anchor_block_id FROM notes WHERE session_id = ? AND anchor_ordinal IS NOT NULL",
        )
        .all(sessionId) as NoteCoordinateRow[];
    return rows.flatMap((row) => {
        if (typeof row.id !== "number") return [];
        const previousOrdinal = typeof row.anchor_ordinal === "number" ? row.anchor_ordinal : null;
        const anchorBlockId = typeof row.anchor_block_id === "string" ? row.anchor_block_id : "";
        if (anchorBlockId.length === 0) {
            // No id anchor at all: the stored ordinal is a position in a list this
            // host no longer serves and cannot be re-derived, so it is cleared
            // rather than left pointing at whichever message now sits there.
            return [{ id: row.id, ordinal: null, previousOrdinal }];
        }
        const ordinal = projection.ordinalById.get(messageIdFromAnchorBlockId(anchorBlockId));
        return [{ id: row.id, ordinal: ordinal ?? null, previousOrdinal }];
    });
}

function countRows(db: Database, sql: string, ...params: unknown[]): number {
    const row = db.prepare(sql).get(...params) as { count?: unknown } | null | undefined;
    return typeof row?.count === "number" ? row.count : 0;
}

function stampGeneration(
    db: Database,
    sessionId: string,
    generation: CoordinateGeneration,
    notice: CoordinateRebaseNotice | null,
): void {
    ensureSessionMetaRow(db, sessionId);
    if (notice === null) {
        db.prepare("UPDATE session_meta SET coordinate_generation = ? WHERE session_id = ?").run(
            generation,
            sessionId,
        );
        return;
    }
    db.prepare(
        "UPDATE session_meta SET coordinate_generation = ?, coordinate_rebase_notice = ? WHERE session_id = ?",
    ).run(generation, JSON.stringify(notice), sessionId);
}

/** Drop `<messageId>:p<index>` entries whose part index the host no longer projects. */
function pruneShrunkPartEntries(
    db: Database,
    sessionId: string,
    column:
        | "stripped_placeholder_ids"
        | "merged_reasoning_stripped_ids"
        | "trailing_blank_decisions",
    shrunk: readonly ShrunkPartMessage[],
): number {
    if (shrunk.length === 0) return 0;
    const row = db
        .prepare(
            `SELECT ${sessionMetaCollectionSelect(column, "value", db)} FROM session_meta WHERE session_id = ?`,
        )
        .get(sessionId) as { value?: unknown } | null | undefined;
    const raw = row?.value;
    if (typeof raw !== "string" || raw.length === 0) return 0;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return 0;
    }
    // Keyed lookup rather than a scan of every shrunk message per entry: these
    // columns can hold tens of thousands of entries on a long session. An entry
    // `<messageId>:p<digits>` names exactly one message id, everything before
    // its last `:p`, because the digits cannot contain another `:p`.
    const partCountByMessage = new Map(shrunk.map((entry) => [entry.messageId, entry.partCount]));
    const isStale = (candidate: string): boolean => {
        const marker = candidate.lastIndexOf(":p");
        if (marker < 0) return false;
        const suffix = candidate.slice(marker + 2);
        if (!/^\d+$/.test(suffix)) return false;
        const partCount = partCountByMessage.get(candidate.slice(0, marker));
        return partCount !== undefined && Number.parseInt(suffix, 10) >= partCount;
    };

    let dropped = 0;
    const pruneArray = (values: unknown[]): unknown[] =>
        values.filter((value) => {
            if (typeof value === "string" && isStale(value)) {
                dropped += 1;
                return false;
            }
            return true;
        });

    let next: unknown;
    if (Array.isArray(parsed)) {
        next = pruneArray(parsed);
    } else if (parsed && typeof parsed === "object") {
        const source = parsed as Record<string, unknown>;
        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(source)) {
            if (isStale(key)) {
                dropped += 1;
                continue;
            }
            result[key] = Array.isArray(value) ? pruneArray(value) : value;
        }
        next = result;
    } else {
        return 0;
    }
    if (dropped === 0) return 0;
    updateSessionMetaCollection(db, sessionId, column, JSON.stringify(next));
    return dropped;
}

export interface RebaseSessionCoordinatesArgs {
    db: Database;
    sessionId: string;
    /** Projection the running host serves for this session. */
    generation: CoordinateGeneration;
    /**
     * Reads that projection. Called at most once, and only when a change is
     * possible; not called at all when `readMessagePages` is supplied.
     */
    readMessages: (sessionId: string) => RawMessage[];
    /**
     * The same messages as `readMessages`, in ascending ordinal pages, so the
     * whole history never has to be held at once. Preferred when present, and
     * iterated at most once per call.
     */
    readMessagePages?: (sessionId: string) => Iterable<RawMessage[]>;
}

/**
 * Re-derive every position-keyed coordinate this session saved, from the message
 * ids that survived, against the projection the running host serves.
 *
 * Message ids are stable across the OpenCode 1.x/2.x store conversion but the
 * positions are not: converting a 1.x store splits some turns into two rows and
 * folds others into one, and the v1 tables are kept, so a user can be served
 * either projection on any given launch. Everything Magic Context saved as "the
 * Nth message" therefore has to be re-derived from the anchor ids whenever the
 * projection this session was last read under is not the one now in front of us.
 *
 * Nothing is guessed. An anchor the running projection does not contain marks
 * its row unresolved instead of being snapped to a neighbouring position, and
 * state with no id anchor at all (the search index, chunk windows, compression
 * depth) is rebuilt from the authoritative source rather than renumbered.
 *
 * The row rewrites, the index clear and the generation stamp commit together, so
 * a crash leaves the session either fully rebased or untouched; an untouched
 * session still has the old stamp, so the next pass runs this again.
 *
 * This form runs to completion without giving up the thread. The request path
 * uses `rebaseSessionCoordinatesAsync`, which does the same work but lets other
 * work run between history pages and between index-rebuild chunks.
 */
export function rebaseSessionCoordinates(
    args: RebaseSessionCoordinatesArgs,
): StoreGenerationRebaseOutcome {
    const steps = rebaseSteps(args);
    for (;;) {
        const step = steps.next();
        if (step.done) return step.value;
    }
}

/** How long the async form may hold the thread before it lets other work run. */
const REBASE_SLICE_MS = 20;

const rebasesInFlight = new WeakMap<Database, Map<string, Promise<StoreGenerationRebaseOutcome>>>();

/**
 * `rebaseSessionCoordinates` for the request path: identical work and
 * identical rows, but the thread is released every ~20 ms at the points where
 * that is safe, so a long first reconciliation no longer freezes the host.
 *
 * It is released only outside write transactions: while the history is read
 * (nothing written yet, and every saved row is read again after the read
 * ends, so work done meanwhile is seen), and between the search-index rebuild
 * chunks that follow the commit (each chunk is its own transaction and the
 * index is designed to be caught up in pieces). The coordinate rewrite, the
 * index clear and the generation stamp still commit as one transaction that
 * nothing else runs inside, and the caller's promise settles only after the
 * stamp has committed, so a prompt built after awaiting this never sees the old
 * coordinates.
 *
 * Two calls for the same session on one connection do not run side by side:
 * the second waits for the first and then finds the session already stamped.
 */
export async function rebaseSessionCoordinatesAsync(
    args: RebaseSessionCoordinatesArgs,
): Promise<StoreGenerationRebaseOutcome> {
    let sessions = rebasesInFlight.get(args.db);
    if (!sessions) {
        sessions = new Map();
        rebasesInFlight.set(args.db, sessions);
    }
    const earlier = sessions.get(args.sessionId);
    if (earlier) await earlier.catch(() => undefined);

    const run = runSliced(args);
    sessions.set(args.sessionId, run);
    try {
        return await run;
    } finally {
        if (sessions.get(args.sessionId) === run) sessions.delete(args.sessionId);
    }
}

async function runSliced(
    args: RebaseSessionCoordinatesArgs,
): Promise<StoreGenerationRebaseOutcome> {
    const steps = rebaseSteps(args);
    let finished = false;
    try {
        let sliceStartedAt = performance.now();
        for (;;) {
            const step = steps.next();
            if (step.done) {
                finished = true;
                return step.value;
            }
            if (performance.now() - sliceStartedAt >= REBASE_SLICE_MS) {
                await new Promise<void>((resolve) => setImmediate(resolve));
                sliceStartedAt = performance.now();
            }
        }
    } finally {
        // Closes the history reader if a step threw before the read finished.
        if (!finished) steps.return(emptyOutcome("unchanged", args.generation, null));
    }
}

/**
 * The rebase itself. Each `yield` marks a point where no write transaction is
 * open and the caller may let other work run before continuing.
 */
function* rebaseSteps(
    args: RebaseSessionCoordinatesArgs,
): Generator<void, StoreGenerationRebaseOutcome, void> {
    const { db, sessionId, generation } = args;
    const startedAt = performance.now();
    if (!sessionIsOpenCodeOwned(db, sessionId)) {
        return emptyOutcome("unchanged", generation, null);
    }
    const previousGeneration = readCoordinateGeneration(db, sessionId);
    if (previousGeneration === generation) {
        const outcome = emptyOutcome("unchanged", generation, previousGeneration);
        const repair = repairStampedSessionOnce(db, sessionId, args);
        if (repair !== null && repair.rowsRewritten > 0) {
            outcome.status = "repaired";
            outcome.compartmentsDerived = repair.derived.length;
            outcome.compartmentsUnresolved = repair.unresolved.length;
        }
        return outcome;
    }

    // A session seen for the first time by a generation-aware build carries no
    // stamp, but it does carry evidence: the harness that wrote its coordinates.
    // When that names the projection this host serves, nothing can have moved
    // (compartments whose raw rows the host has since pruned included: their
    // anchors resolve nowhere, yet they are exactly as consistent as they were
    // yesterday, and re-deriving them would mark most of a long session's
    // history unresolved on an ordinary upgrade boot). When it names the other
    // projection, the store was converted before this build's first look — the
    // upgrade shape itself, a 1.x store meeting OpenCode 2 and this plugin in
    // one boot — and the rebase must run from that implied generation.
    const impliedGeneration =
        previousGeneration ?? generationImpliedByHarness(db, sessionId) ?? generation;
    if (impliedGeneration === generation) {
        stampGeneration(db, sessionId, generation, null);
        return emptyOutcome("stamped", generation, previousGeneration);
    }

    // The only history read of the call. It also keeps what the search index
    // needs, so the index rebuild after the commit does not read it again.
    const projection = yield* buildProjectionSteps(args, true);
    // The outcome and its log line name the projection the rebase actually ran
    // from, which for an unstamped session is the harness-implied one.
    const outcome = emptyOutcome("rebased", generation, impliedGeneration);

    const compartmentRows = readCompartmentRows(db, "compartments", sessionId);
    const recompRows = readCompartmentRows(db, "recomp_compartments", sessionId);
    const compartmentPlans = planCompartments(compartmentRows, "compartments", projection);
    const recompPlans = planCompartments(recompRows, "recomp_compartments", projection);
    const compartmentGapResult = healNonNarrativeCompartmentGaps(compartmentPlans, projection);
    const recompGapResult = healNonNarrativeCompartmentGaps(recompPlans, projection);
    const notePlans = planNotes(db, sessionId, projection);

    // Tags carry the message id plus the part index the text sat at. A host that
    // rewrites a multi-part message into one joined text part leaves every tag
    // above the surviving index without a target.
    const shrunkMessages: ShrunkPartMessage[] = [];
    // De-duplicated here rather than with SELECT DISTINCT, which makes SQLite
    // walk the message-id index and fetch every tag row in index order: on a
    // session with a few hundred thousand tags that was ten times slower.
    const taggedMessageIds = new Set(
        (
            db
                .prepare("SELECT message_id FROM tags WHERE session_id = ? AND type = 'message'")
                .all(sessionId) as Array<{ message_id?: unknown }>
        ).flatMap((row) => (typeof row.message_id === "string" ? [row.message_id] : [])),
    );
    const highestTaggedPartIndex = new Map<string, number>();
    for (const contentId of taggedMessageIds) {
        const marker = contentId.lastIndexOf(":p");
        if (marker <= 0) continue;
        const suffix = contentId.slice(marker + 2);
        if (!/^\d+$/.test(suffix)) continue;
        const messageId = contentId.slice(0, marker);
        const partIndex = Number.parseInt(suffix, 10);
        highestTaggedPartIndex.set(
            messageId,
            Math.max(highestTaggedPartIndex.get(messageId) ?? 0, partIndex),
        );
    }
    for (const [messageId, highestIndex] of highestTaggedPartIndex) {
        const partCount = projection.partCountById.get(messageId);
        if (partCount === undefined || highestIndex < partCount) continue;
        shrunkMessages.push({ messageId, partCount });
    }

    const indexNeedsRebuild = indexDisagreesWithProjection(db, sessionId, projection);
    const chunkEmbeddingCount = countRows(
        db,
        "SELECT COUNT(*) AS count FROM compartment_chunk_embeddings WHERE session_id = ?",
        sessionId,
    );
    const depthRowCount = countRows(
        db,
        "SELECT COUNT(*) AS count FROM compression_depth WHERE session_id = ?",
        sessionId,
    );
    const lkgSlotCount = countRows(
        db,
        "SELECT COUNT(*) AS count FROM lkg_slots WHERE session_id = ?",
        sessionId,
    );

    const boundaryPlan = planPriorBoundary(db, sessionId, compartmentPlans);
    const partialRangePlan = planRecompPartialRange(db, sessionId, recompPlans);

    outcome.healedGaps = compartmentGapResult.healed + recompGapResult.healed;
    outcome.narrativeGaps = compartmentGapResult.narrative + recompGapResult.narrative;
    const movedCompartments = compartmentPlans.filter(compartmentPlanChanges);
    const movedRecomp = recompPlans.filter(compartmentPlanChanges);
    const movedNotes = notePlans.filter((plan) => plan.ordinal !== plan.previousOrdinal);
    const anythingMoved =
        movedCompartments.length > 0 ||
        movedRecomp.length > 0 ||
        movedNotes.length > 0 ||
        shrunkMessages.length > 0 ||
        indexNeedsRebuild ||
        boundaryPlan !== null ||
        partialRangePlan !== null ||
        outcome.healedGaps > 0 ||
        outcome.narrativeGaps > 0;

    if (!anythingMoved) {
        // The projection agrees with every saved coordinate. Recording it is the
        // whole change: a session that did not actually move must not pay a fold
        // or lose its index, because that would alter bytes the model already saw.
        stampGeneration(db, sessionId, generation, null);
        return emptyOutcome("stamped", generation, impliedGeneration);
    }

    let labelsLeftUnchanged = 0;
    db.exec("BEGIN IMMEDIATE");
    // True once the transaction has been closed here, by COMMIT or by the
    // deliberate ROLLBACK below; the finally block rolls back anything else.
    let closed = false;
    try {
        // Another pass (this process's sync caller, or another process on the
        // same database) may have rebased the session while the history was
        // being read. Its stamp is authoritative; rewriting on top of it from
        // the older rows read above would only repeat or undo its work.
        if (readCoordinateGeneration(db, sessionId) !== previousGeneration) {
            db.exec("ROLLBACK");
            closed = true;
            return emptyOutcome("unchanged", generation, readCoordinateGeneration(db, sessionId));
        }

        // Everything below commits together, so the order only matters for cost.
        // Every tag write fires a trigger that rewrites this session's
        // session_meta row, which on a long session carries megabytes of cached
        // render and frozen-part lists. Shrinking that row first, and doing the
        // tag writes before the index clear fills the page cache with deleted
        // search documents, keeps each of those rewrites cheap.
        //
        // The cached prefix bytes contain the ranges corrected by this pass, so
        // the next pass must regenerate those bytes instead of replaying the old
        // render. Clear the previous host's system-prompt hash at the same time so
        // the new host can establish its baseline without scheduling another HARD
        // fold after this initial rebuild.
        clearCachedM0M1(db, sessionId);
        db.prepare("UPDATE session_meta SET system_prompt_hash = '' WHERE session_id = ?").run(
            sessionId,
        );
        for (const column of [
            "stripped_placeholder_ids",
            "merged_reasoning_stripped_ids",
            "trailing_blank_decisions",
        ] as const) {
            outcome.frozenPartEntriesDropped += pruneShrunkPartEntries(
                db,
                sessionId,
                column,
                shrunkMessages,
            );
        }
        const fold = foldShrunkPartTags(db, sessionId, shrunkMessages);
        outcome.partTagsFolded = fold.foldedTagNumbers.length;
        outcome.partTagsRekeyed = fold.rekeyedTagNumbers.length;
        outcome.queuedReductionsDiscarded = fold.discardedDropTagNumbers.length;

        const updateCompartment = {
            compartments: db.prepare(
                "UPDATE compartments SET start_message = ?, end_message = ?, rebase_status = ?, title = ?, content = ?, p1 = ?, p2 = ?, p3 = ?, p4 = ? WHERE id = ?",
            ),
            recomp_compartments: db.prepare(
                "UPDATE recomp_compartments SET start_message = ?, end_message = ?, rebase_status = ?, title = ?, content = ?, p1 = ?, p2 = ?, p3 = ?, p4 = ? WHERE id = ?",
            ),
        };
        for (const plan of [...compartmentPlans, ...recompPlans]) {
            const delta = plan.start - plan.previousStart;
            const uniform =
                plan.status === "ok" && !plan.derived && delta === plan.end - plan.previousEnd;
            const resolveLabel = (ordinal: number): number | undefined => {
                // Endpoints have stable identities even when the interior's
                // projection changed non-uniformly. Never infer an interior delta
                // from only one surviving endpoint.
                if (ordinal === plan.previousStart && plan.known.start !== undefined)
                    return plan.known.start;
                if (ordinal === plan.previousEnd && plan.known.end !== undefined)
                    return plan.known.end;
                if (uniform && ordinal >= plan.previousStart && ordinal <= plan.previousEnd)
                    return ordinal + delta;
                return undefined;
            };
            const textValues = (["title", "content", "p1", "p2", "p3", "p4"] as const).map(
                (field) => {
                    const value = plan.source[field];
                    if (value === null) return null;
                    const rewritten = rewriteMessageLabels(value, resolveLabel);
                    labelsLeftUnchanged += rewritten.unchanged;
                    return rewritten.text;
                },
            );
            if (!compartmentPlanChanges(plan)) continue;
            updateCompartment[plan.table].run(
                plan.start,
                plan.end,
                plan.status,
                ...textValues,
                plan.id,
            );
            const rebased = plan.status === "ok" ? 1 : 0;
            const unresolved = plan.status === "unresolved" ? 1 : 0;
            if (plan.table === "compartments") {
                outcome.compartmentsRebased += rebased;
                outcome.compartmentsUnresolved += unresolved;
                if (rebased === 1 && plan.derived) outcome.compartmentsDerived += 1;
                if (rebased === 1 && plan.previousStatus === "unresolved")
                    outcome.compartmentsResolvedAgain += 1;
            } else {
                outcome.recompCompartmentsRebased += rebased;
                outcome.recompCompartmentsUnresolved += unresolved;
            }
        }
        const updateNote = db.prepare(
            "UPDATE notes SET anchor_ordinal = ? WHERE id = ? AND session_id = ?",
        );
        for (const plan of movedNotes) {
            updateNote.run(plan.ordinal, plan.id, sessionId);
            if (plan.ordinal === null) outcome.notesCleared += 1;
            else outcome.notesRebased += 1;
        }
        if (boundaryPlan !== null) {
            db.prepare(
                "UPDATE session_meta SET prior_boundary_ordinal = ? WHERE session_id = ?",
            ).run(boundaryPlan, sessionId);
            outcome.priorBoundaryRebased = true;
        }
        if (partialRangePlan !== null) {
            db.prepare(
                "UPDATE session_meta SET recomp_partial_range_start = ?, recomp_partial_range_end = ? WHERE session_id = ?",
            ).run(partialRangePlan.start, partialRangePlan.end, sessionId);
            outcome.recompPartialRangeRebased = true;
        }

        // No id anchor exists for these, so they are re-derived rather than moved.
        // clearIndexedMessagesInTransaction also resets the watermark and the
        // dirty floor, which is what makes the rebuild after the commit complete.
        if (indexNeedsRebuild) {
            clearIndexedMessagesInTransaction(db, sessionId);
            outcome.indexRebuilt = true;
            outcome.compressionDepthRowsDropped = depthRowCount;
        }
        if (chunkEmbeddingCount > 0) {
            db.prepare("DELETE FROM compartment_chunk_embeddings WHERE session_id = ?").run(
                sessionId,
            );
            outcome.chunkEmbeddingsDeleted = chunkEmbeddingCount;
        }
        if (lkgSlotCount > 0) {
            // The replay slot keys on content digests of the exact prefix it
            // captured. Text the host re-joined no longer hashes the same, so the
            // slot could only decline; deleting it says so instead of pretending.
            db.prepare("DELETE FROM lkg_slot_chunks WHERE session_id = ?").run(sessionId);
            db.prepare("DELETE FROM lkg_slots WHERE session_id = ?").run(sessionId);
            outcome.lkgSlotsDropped = lkgSlotCount;
        }

        stampGeneration(db, sessionId, generation, {
            generation,
            previousGeneration: impliedGeneration,
            at: Date.now(),
            unresolvedCompartments:
                outcome.compartmentsUnresolved + outcome.recompCompartmentsUnresolved,
            discardedReductions: outcome.queuedReductionsDiscarded,
            droppedDepthRows: outcome.compressionDepthRowsDropped,
            healedGaps: outcome.healedGaps,
            narrativeGaps: outcome.narrativeGaps,
            derivedCompartments: rangeNotes(
                compartmentPlans,
                (plan) => plan.status === "ok" && plan.derived,
            ),
            unresolvedCompartmentRanges: rangeNotes(
                compartmentPlans,
                (plan) => plan.status === "unresolved",
            ),
            // This rebase already filled every anchor its neighbours determine,
            // so the one-time repair for older stamped sessions has nothing to add.
            neighbourRecoveryAt: Date.now(),
        });
        db.exec("COMMIT");
        closed = true;
    } finally {
        if (!closed) {
            try {
                db.exec("ROLLBACK");
            } catch {
                // Already rolled back by the failure that brought us here.
            }
        }
    }

    // Repopulating the search index is idempotent catch-up from the authoritative
    // source, not part of the atomic state change: the committed transaction left
    // an empty index with a zero watermark, which every later pass heals the same
    // way if this call does not get to run. It is written from the history read
    // above, in bounded transactions; each one advances the watermark over the
    // ordinals it covers, so stopping between them leaves a shorter but
    // consistent index that the next reconciliation extends.
    if (outcome.indexRebuilt) {
        const sources = projection.indexSources;
        for (let start = 0; start < sources.length; start += INDEX_REBUILD_CHUNK) {
            indexSourcesAfterOrdinal(
                db,
                sessionId,
                sources.slice(start, start + INDEX_REBUILD_CHUNK),
                sources.length,
            );
            yield;
        }
        outcome.indexRowsRebuilt = countRows(
            db,
            "SELECT COUNT(*) AS count FROM message_history_source WHERE session_id = ?",
            sessionId,
        );
    }

    // One line per rebased session, written unconditionally to magic-context.log
    // so a migration drill can be read back from the log alone.
    sessionLog(
        sessionId,
        `${formatRebaseLogLine(outcome, performance.now() - startedAt)} labels_left_unchanged=${labelsLeftUnchanged}`,
    );
    return outcome;
}

export interface NeighbourRecoveryResult {
    /** Compartment rows whose coordinates or status were rewritten. */
    rowsRewritten: number;
    /** Rows placed `ok` from a neighbour, with their new ranges. */
    derived: CompartmentRangeNote[];
    /** Rows that are still unresolved after recovery, with their clamped ranges. */
    unresolved: CompartmentRangeNote[];
}

export interface RecoverUnresolvedCompartmentsArgs {
    db: Database;
    sessionId: string;
    /**
     * The ordinal the running host serves a message id at, or undefined when it
     * serves no such message. Only called for the anchors of unresolved rows.
     */
    resolveOrdinal: (messageId: string) => number | undefined;
    /** Names the caller in the log line. */
    reason: string;
}

/**
 * Place the session's unresolved compartments from their neighbours, without a
 * projection change.
 *
 * Rows marked `ok` are trusted exactly as stored: their ordinals already
 * describe the projection this session is stamped with, and re-deriving them
 * from anchors here would turn every compartment whose raw rows the host has
 * since pruned into an unresolved one. Only unresolved rows are re-examined,
 * with the same rules the rebase uses (see `recoverFromNeighbours`), so a row
 * whose missing anchor its neighbours determine becomes `ok` and one they do
 * not is clamped off its `ok` neighbours.
 *
 * The cached m0/m1 render is deliberately left in place. Rewriting a
 * compartment row changes what the next render produces, and that change must
 * reach the provider on a pass that is already rebuilding the prefix (the
 * historian's next publish is one), never on a pass that replays the cached
 * bytes.
 */
export function recoverUnresolvedCompartments(
    args: RecoverUnresolvedCompartmentsArgs,
): NeighbourRecoveryResult {
    const { db, sessionId } = args;
    const rows = readCompartmentRows(db, "compartments", sessionId);
    const result: NeighbourRecoveryResult = { rowsRewritten: 0, derived: [], unresolved: [] };
    if (!rows.some((row) => row.rebase_status === "unresolved")) return result;

    const known = rows.map((row): KnownEnds => {
        if (row.rebase_status !== "unresolved") {
            return { start: row.start_message, end: row.end_message };
        }
        return {
            start: resolveAnchor(row.start_message_id, args.resolveOrdinal),
            end: resolveAnchor(row.end_message_id, args.resolveOrdinal),
        };
    });
    const plans = recoverFromNeighbours(rows, "compartments", known);
    const wasUnresolved = (plan: PlannedCompartment) => plan.previousStatus === "unresolved";
    result.derived = rangeNotes(
        plans,
        (plan) => wasUnresolved(plan) && plan.status === "ok" && plan.derived,
    );
    result.unresolved = rangeNotes(plans, (plan) => plan.status === "unresolved");
    const changed = plans.filter(compartmentPlanChanges);

    const now = Date.now();
    db.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
        for (const plan of changed) {
            db.prepare(
                "UPDATE compartments SET start_message = ?, end_message = ?, rebase_status = ? WHERE id = ?",
            ).run(plan.start, plan.end, plan.status, plan.id);
        }
        // The recovery is recorded in the existing rebase notice, keeping what
        // the last rebase reported. The generation stamp itself is not touched:
        // nothing about the projection changed.
        const previous = readCoordinateRebaseNotice(db, sessionId);
        const generation = previous?.generation ?? readCoordinateGeneration(db, sessionId);
        if (generation !== null) {
            const derivedSequences = new Set(result.derived.map((note) => note.sequence));
            const notice: CoordinateRebaseNotice = {
                generation,
                previousGeneration: previous?.previousGeneration ?? null,
                at: previous?.at ?? now,
                unresolvedCompartments: result.unresolved.length,
                discardedReductions: previous?.discardedReductions ?? 0,
                droppedDepthRows: previous?.droppedDepthRows ?? 0,
                healedGaps: previous?.healedGaps ?? 0,
                narrativeGaps: previous?.narrativeGaps ?? 0,
                derivedCompartments: [
                    ...(previous?.derivedCompartments ?? []).filter(
                        (note) => !derivedSequences.has(note.sequence),
                    ),
                    ...result.derived,
                ],
                unresolvedCompartmentRanges: result.unresolved,
                neighbourRecoveryAt: now,
            };
            ensureSessionMetaRow(db, sessionId);
            db.prepare(
                "UPDATE session_meta SET coordinate_rebase_notice = ? WHERE session_id = ?",
            ).run(JSON.stringify(notice), sessionId);
        }
        db.exec("COMMIT");
        committed = true;
    } finally {
        if (!committed) {
            try {
                db.exec("ROLLBACK");
            } catch {
                // Already rolled back by the failure that brought us here.
            }
        }
    }
    result.rowsRewritten = changed.length;
    sessionLog(
        sessionId,
        `INFO compartment neighbour recovery (${args.reason}) rows_rewritten=${changed.length} ` +
            `derived=${result.derived.map((note) => `${note.start}-${note.end}`).join(",") || "none"} ` +
            `unresolved=${result.unresolved.map((note) => `${note.start}-${note.end}`).join(",") || "none"}`,
    );
    return result;
}

/**
 * Sessions whose stored compartments this process has already checked for the
 * one-time repair, per database handle, so later passes pay nothing.
 */
const repairCheckedSessions = new WeakMap<Database, Set<string>>();

/**
 * Whether an unresolved row is what breaks the stored tiling: the first
 * compartment not starting at 1, a gap, an overlap or an inverted range at a
 * boundary that touches an unresolved row. This is the shape that makes the
 * historian's check on its stored compartments fail before every run.
 */
function unresolvedRowBreaksTiling(rows: readonly CompartmentCoordinateRow[]): boolean {
    let expectedStart = 1;
    for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        if (!row) continue;
        const broken = row.start_message !== expectedStart || row.end_message < row.start_message;
        const touchesUnresolved =
            row.rebase_status === "unresolved" || rows[index - 1]?.rebase_status === "unresolved";
        if (broken && touchesUnresolved) return true;
        expectedStart = row.end_message + 1;
    }
    return false;
}

/**
 * Repair a session an older build stamped while leaving an unresolved
 * compartment overlapping its neighbour.
 *
 * Builds before neighbour recovery kept an unresolved row's stale ordinals,
 * which could overlap the next compartment and make every historian run fail
 * its check on the stored compartments. Those sessions already carry the
 * running generation's stamp, so no projection change will come to rebase them
 * again. This runs the recovery once for them: only when an unresolved row is
 * what breaks the stored tiling, and only if the rebase notice records no
 * earlier recovery.
 */
function repairStampedSessionOnce(
    db: Database,
    sessionId: string,
    readArgs: RebaseSessionCoordinatesArgs,
): NeighbourRecoveryResult | null {
    let checked = repairCheckedSessions.get(db);
    if (!checked) {
        checked = new Set();
        repairCheckedSessions.set(db, checked);
    }
    if (checked.has(sessionId)) return null;
    checked.add(sessionId);

    const rows = readCompartmentRows(db, "compartments", sessionId);
    if (!rows.some((row) => row.rebase_status === "unresolved")) return null;
    if (readCoordinateRebaseNotice(db, sessionId)?.neighbourRecoveryAt != null) return null;
    if (!unresolvedRowBreaksTiling(rows)) return null;

    let ordinalById: Map<string, number> | null = null;
    return recoverUnresolvedCompartments({
        db,
        sessionId,
        resolveOrdinal: (messageId) => {
            if (ordinalById === null) {
                const projection = emptyProjection();
                for (const page of readProjectionPages(readArgs)) {
                    addToProjection(projection, page, false);
                }
                ordinalById = projection.ordinalById;
            }
            return ordinalById.get(messageId);
        },
        reason: "stamped-session repair",
    });
}

/** Single-line summary of one session's rebase, in the order an operator reads it. */
export function formatRebaseLogLine(
    outcome: StoreGenerationRebaseOutcome,
    elapsedMs: number,
): string {
    const rowsRewritten =
        outcome.compartmentsRebased +
        outcome.recompCompartmentsRebased +
        outcome.notesRebased +
        outcome.notesCleared +
        (outcome.priorBoundaryRebased ? 1 : 0) +
        (outcome.recompPartialRangeRebased ? 1 : 0);
    const unresolved = outcome.compartmentsUnresolved + outcome.recompCompartmentsUnresolved;
    return (
        `INFO store-generation-rebase ${outcome.previousGeneration ?? "unrecorded"}->${outcome.generation} ` +
        `rows_rewritten=${rowsRewritten} unresolved=${unresolved} derived=${outcome.compartmentsDerived} ` +
        `index_rows_rebuilt=${outcome.indexRowsRebuilt} drops_discarded=${outcome.queuedReductionsDiscarded} ` +
        `healed_gaps=${outcome.healedGaps} narrative_gaps=${outcome.narrativeGaps} ` +
        `ms=${Math.round(elapsedMs)} ` +
        `(chunk_windows_deleted=${outcome.chunkEmbeddingsDeleted} depth_rows_dropped=${outcome.compressionDepthRowsDropped} ` +
        `part_tags_folded=${outcome.partTagsFolded} lkg_slots_dropped=${outcome.lkgSlotsDropped} ` +
        `frozen_part_entries_dropped=${outcome.frozenPartEntriesDropped})`
    );
}

/**
 * The protected-tail floor was taken from a compartment boundary, so it moves
 * with the compartment it came from. When no compartment ends where the floor
 * sits, the value has no anchor to follow and is left alone.
 */
function planPriorBoundary(
    db: Database,
    sessionId: string,
    plans: readonly PlannedCompartment[],
): number | null {
    const row = db
        .prepare("SELECT prior_boundary_ordinal FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { prior_boundary_ordinal?: unknown } | null | undefined;
    const current =
        typeof row?.prior_boundary_ordinal === "number" ? row.prior_boundary_ordinal : 1;
    if (current <= 1) return null;
    const source = plans.find(
        (plan) => plan.status === "ok" && plan.previousEnd === current && plan.end !== current,
    );
    return source ? source.end : null;
}

function planRecompPartialRange(
    db: Database,
    sessionId: string,
    plans: readonly PlannedCompartment[],
): { start: number; end: number } | null {
    const row = db
        .prepare(
            "SELECT recomp_partial_range_start AS start, recomp_partial_range_end AS end FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId) as { start?: unknown; end?: unknown } | null | undefined;
    const start = typeof row?.start === "number" ? row.start : 0;
    const end = typeof row?.end === "number" ? row.end : 0;
    if (start <= 0 && end <= 0) return null;
    const startSource = plans.find((plan) => plan.status === "ok" && plan.previousStart === start);
    const endSource = plans.find((plan) => plan.status === "ok" && plan.previousEnd === end);
    if (!startSource || !endSource) return null;
    if (startSource.start === start && endSource.end === end) return null;
    return { start: startSource.start, end: endSource.end };
}

/**
 * Whether the search index still describes the projection in front of us.
 *
 * Each indexed document records the message id it came from beside the ordinal
 * it was filed under, so this is an exact comparison rather than an estimate:
 * an id the projection numbers differently (or does not contain at all) means
 * those documents were filed against a different message list. The FTS rowid
 * map is checked too, because a document can be left behind at an ordinal the
 * source table has already moved away from — that stale pair is how the same
 * message ends up indexed twice.
 */
function indexDisagreesWithProjection(
    db: Database,
    sessionId: string,
    projection: Projection,
): boolean {
    const sourceRows = db
        .prepare(
            "SELECT message_id, message_ordinal FROM message_history_source WHERE session_id = ?",
        )
        .all(sessionId) as Array<{ message_id?: unknown; message_ordinal?: unknown }>;
    if (sourceRows.length === 0) {
        return (
            countRows(
                db,
                "SELECT COUNT(*) AS count FROM message_fts_rowid_map WHERE session_id = ?",
                sessionId,
            ) > 0
        );
    }
    for (const row of sourceRows) {
        if (typeof row.message_id !== "string" || typeof row.message_ordinal !== "number") {
            return true;
        }
        if (projection.ordinalById.get(row.message_id) !== row.message_ordinal) return true;
    }
    const orphanedMapRows = countRows(
        db,
        `SELECT COUNT(*) AS count FROM message_fts_rowid_map AS m
         WHERE m.session_id = ?
           AND NOT EXISTS (
               SELECT 1 FROM message_history_source AS s
               WHERE s.session_id = m.session_id AND s.message_ordinal = m.message_ordinal
           )`,
        sessionId,
    );
    return orphanedMapRows > 0;
}
