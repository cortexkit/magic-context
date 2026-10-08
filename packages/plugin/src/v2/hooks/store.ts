import { markHostUnservedRow } from "../../hooks/magic-context/host-served-rows";
import type { BoundedRawMessageProvider } from "../../hooks/magic-context/read-session-chunk";
import type {
    RawMessage,
    RawMessageOrdinalAnchor,
    RawMessageOrdinalEntry,
    RawMessageParts,
} from "../../hooks/magic-context/read-session-raw";
import { restoreRow } from "../fold/restore";
import {
    type MessageType,
    RAW_MESSAGE_TYPES,
    type StoreRow,
    type V2StoreReader,
} from "../store-reader";
import { toolStateContent } from "../tool-result";

const rawMessageTypes = new Set<MessageType>(RAW_MESSAGE_TYPES);
const isRawRow = (row: StoreRow) => rawMessageTypes.has(row.type);

// No live model matches this one, so provider-state-only reasoning is left out and a
// borderline assistant row counts as unserved. Erring that way only moves a boundary
// one row earlier; the opposite error would put a boundary on a row the host drops.
const NO_MODEL = { providerID: "", id: "" };

/**
 * Whether the host puts this row into the request draft under its own id. The
 * decision reuses restoreRow, the local mirror of the host's row-to-message
 * rendering, so the two cannot drift: an instruction-update `system` row, a
 * background shell row or an empty user turn renders without the row id (or not
 * at all) and can never be found again by a boundary lookup.
 */
export function hostServesRowById(row: StoreRow): boolean {
    return isRawRow(row) && restoreRow(row, NO_MODEL).some((message) => message.id === row.id);
}

function projectRawMessages(
    rows: readonly StoreRow[],
    ordinalFor: (row: StoreRow, index: number) => number,
): RawMessage[] {
    return rows.filter(isRawRow).map((row, index) => {
        const message: RawMessage = {
            id: row.id,
            ordinal: ordinalFor(row, index),
            role: row.type === "assistant" ? "assistant" : "user",
            createdAt: row.time_created ?? row.data.time?.created,
            parts:
                row.type === "assistant"
                    ? (row.data.content ?? []).map((part) => {
                          if (part.type !== "tool") return { ...part };
                          const state = part.state as Record<string, unknown>;
                          const content = state.content as
                              | Array<{ type: string; text?: string }>
                              | undefined;
                          return {
                              type: "tool",
                              tool: part.name,
                              callID: part.id,
                              state: {
                                  ...state,
                                  output:
                                      state.status === "error"
                                          ? toolStateContent(state)
                                          : (content
                                                ?.filter((p) => p.type === "text")
                                                .map((p) => p.text)
                                                .join("\n") ?? ""),
                              },
                          };
                      })
                    : [{ type: "text", text: row.data.text ?? "" }],
        };
        // Keep host provenance available to coordinate repair without changing the
        // enumerable RawMessage shape shared with the v1 differential fixtures.
        Object.defineProperty(message, "storeType", { value: row.type, enumerable: false });
        if (!hostServesRowById(row)) markHostUnservedRow(message);
        return message;
    });
}

/** Ordinals count conversational rows in the complete session, never a post-fold window.
 * A window caller must supply the full history so compaction cannot reassign tag identities. */
export function rawMessages(
    rows: readonly StoreRow[],
    history: readonly StoreRow[] = rows,
): RawMessage[] {
    const ordinals = new Map(history.filter(isRawRow).map((row, index) => [row.id, index + 1]));
    return projectRawMessages(rows, (row) => {
        // A row outside the supplied history has no ordinal; 0 is never a live ordinal,
        // so a caller that windowed without passing full history fails visibly rather
        // than inheriting a neighbour's tag identity.
        return ordinals.get(row.id) ?? 0;
    });
}

/** Project a SQL-bounded page whose first row follows `afterOrdinal`. */
export function rawMessagePage(rows: readonly StoreRow[], afterOrdinal: number): RawMessage[] {
    return projectRawMessages(rows, (_row, index) => afterOrdinal + index + 1);
}

export interface V2RawMessageReader {
    readPage(
        sessionID: string,
        afterOrdinal: number,
        limit: number,
        finalWatermark: number,
        after?: RawMessageOrdinalAnchor,
    ): RawMessage[];
    findById(sessionID: string, messageID: string): RawMessage | null;
    findPartsById(sessionID: string, messageID: string): RawMessageParts | null;
    hasById(sessionID: string, messageID: string): boolean;
    ordinalOf(sessionID: string, messageID: string): number | null;
    ordinalMapForRange(
        sessionID: string,
        fromOrdinal: number,
        toOrdinal: number,
    ): Map<string, number>;
    readOrdinalPage(
        sessionID: string,
        after: RawMessageOrdinalAnchor | null,
        limit: number,
    ): RawMessageOrdinalEntry[];
    getCount(sessionID: string): number;
    getStoredCount(sessionID: string): number;
    /** Id of the row the host serves in place of `messageID`; see servedBoundaryRow. */
    servedBoundaryIdOf?(sessionID: string, messageID: string): string | null;
}

const SERVED_BOUNDARY_PAGE = 50;

/**
 * The row a stored compartment boundary stands for in a request: the boundary
 * row itself when the host serves it by id, otherwise the nearest earlier row
 * that it does serve. Returns null when the id is not a conversational row in
 * the store or no earlier served row exists; callers then keep the stored id.
 */
export function servedBoundaryRow(
    reader: Pick<V2StoreReader, "messageById" | "rawRowsThrough">,
    sessionID: string,
    messageID: string,
): StoreRow | null {
    const boundary = reader.messageById(sessionID, messageID);
    if (!boundary) return null;
    if (hostServesRowById(boundary)) return boundary;
    let through = boundary.seq - 1;
    for (;;) {
        const rows = reader.rawRowsThrough(sessionID, through, SERVED_BOUNDARY_PAGE);
        const served = rows.find(hostServesRowById);
        if (served) return served;
        const oldest = rows.at(-1);
        if (rows.length < SERVED_BOUNDARY_PAGE || !oldest) return null;
        through = oldest.seq - 1;
    }
}

/**
 * The nearest user message at or before `endMessageID`, searched backward
 * through the store a page at a time rather than by reading the whole session.
 * Returns null when the id is absent, is not a conversational row, or has no
 * user message at or before it (the rule `resolveBoundaryUserMessage` applies
 * to an in-memory history).
 */
export function resolveV2BoundaryUserMessage(
    reader: Pick<V2StoreReader, "messageById" | "rawRowsThrough">,
    sessionID: string,
    endMessageID: string,
): RawMessage | null {
    const end = reader.messageById(sessionID, endMessageID);
    if (!end || !isRawRow(end)) return null;
    let through = end.seq;
    for (;;) {
        const rows = reader.rawRowsThrough(sessionID, through, SERVED_BOUNDARY_PAGE);
        const user = rows.find((row) => row.type !== "assistant");
        if (user) return rawMessagePage([user], 0)[0] ?? null;
        const oldest = rows.at(-1);
        if (rows.length < SERVED_BOUNDARY_PAGE || !oldest) return null;
        through = oldest.seq - 1;
    }
}

/** The only V2 full-history reader: store-generation conversion must inspect every part. */
export function readAllV2RawMessagesForConversion(
    openReader: () => V2StoreReader,
    sessionID: string,
): RawMessage[] {
    const reader = openReader();
    try {
        return rawMessages(reader.history(sessionID));
    } finally {
        reader.close();
    }
}

/** Rows per page read by `readV2RawMessagePagesForConversion`. */
const CONVERSION_PAGE_ROWS = 1000;

/**
 * `readAllV2RawMessagesForConversion`, a page at a time: the same messages with
 * the same ordinals, but only one page of store rows is decoded and held at
 * once. Ordinals count conversational rows across the whole session, so each
 * page continues the count where the previous one stopped. The reader is
 * closed when iteration ends, including when the consumer stops early.
 */
export function* readV2RawMessagePagesForConversion(
    openReader: () => V2StoreReader,
    sessionID: string,
    pageRows = CONVERSION_PAGE_ROWS,
): Generator<RawMessage[], void, void> {
    const reader = openReader();
    try {
        let after = -1;
        let ordinal = 0;
        for (;;) {
            const page = reader.page(sessionID, { after, limit: pageRows });
            const messages = rawMessagePage(page.rows, ordinal);
            ordinal += messages.length;
            if (messages.length > 0) yield messages;
            if (page.rows.length < pageRows || page.cursor === undefined) return;
            after = page.cursor;
        }
    } finally {
        reader.close();
    }
}

/** Build the SQL-bounded reader used by context, indexing, and historian passes. */
export function createV2RawMessageReader(openReader: () => V2StoreReader): V2RawMessageReader {
    const servedBoundaryCache = new Map<string, string | null>();
    return {
        readPage: (
            sessionID: string,
            afterOrdinal: number,
            limit: number,
            finalWatermark: number,
            after?: RawMessageOrdinalAnchor,
        ) => {
            const reader = openReader();
            try {
                return rawMessagePage(
                    reader.messagePage(sessionID, afterOrdinal, limit, finalWatermark, after),
                    afterOrdinal,
                );
            } finally {
                reader.close();
            }
        },
        findById: (sessionID: string, messageID: string) => {
            const reader = openReader();
            try {
                const ordinal = reader.messageOrdinalById(sessionID, messageID);
                const row = reader.messageById(sessionID, messageID);
                if (ordinal === null || row === null) return null;
                return rawMessagePage([row], ordinal - 1)[0] ?? null;
            } finally {
                reader.close();
            }
        },
        findPartsById: (sessionID: string, messageID: string) => {
            const reader = openReader();
            try {
                const row = reader.messageById(sessionID, messageID);
                return row ? (rawMessagePage([row], 0)[0] ?? null) : null;
            } finally {
                reader.close();
            }
        },
        hasById: (sessionID: string, messageID: string) => {
            const reader = openReader();
            try {
                return reader.messageExistsById(sessionID, messageID);
            } finally {
                reader.close();
            }
        },
        ordinalOf: (sessionID: string, messageID: string) => {
            const reader = openReader();
            try {
                return reader.messageOrdinalById(sessionID, messageID);
            } finally {
                reader.close();
            }
        },
        ordinalMapForRange: (sessionID: string, fromOrdinal: number, toOrdinal: number) => {
            const reader = openReader();
            try {
                return reader.messageIdOrdinals(sessionID, fromOrdinal, toOrdinal);
            } finally {
                reader.close();
            }
        },
        readOrdinalPage: (
            sessionID: string,
            after: RawMessageOrdinalAnchor | null,
            limit: number,
        ) => {
            const reader = openReader();
            try {
                return reader.messageOrdinalPage(sessionID, after, limit);
            } finally {
                reader.close();
            }
        },
        getCount: (sessionID: string) => {
            const reader = openReader();
            try {
                return reader.messageCount(sessionID);
            } finally {
                reader.close();
            }
        },
        getStoredCount: (sessionID: string) => {
            const reader = openReader();
            try {
                return reader.storedMessageCount(sessionID);
            } finally {
                reader.close();
            }
        },
        servedBoundaryIdOf: (sessionID: string, messageID: string) => {
            // Stored rows before a boundary never change kind, so one answer per
            // boundary id holds for the life of the session. The cap only bounds
            // memory for very long-lived processes.
            const key = `${sessionID}\u0000${messageID}`;
            if (servedBoundaryCache.has(key)) return servedBoundaryCache.get(key) ?? null;
            const reader = openReader();
            try {
                const served = servedBoundaryRow(reader, sessionID, messageID)?.id ?? null;
                if (servedBoundaryCache.size >= 1000) servedBoundaryCache.clear();
                if (served !== null) servedBoundaryCache.set(key, served);
                return served;
            } finally {
                reader.close();
            }
        },
    };
}

export function createV2RawMessageProvider(
    reader: V2RawMessageReader,
    sessionID: string,
): BoundedRawMessageProvider {
    return {
        readMessagePage: (afterOrdinal, limit, finalWatermark, after) =>
            reader.readPage(sessionID, afterOrdinal, limit, finalWatermark, after),
        readMessageById: (messageID) => reader.findById(sessionID, messageID),
        readMessagePartsById: (messageID) => reader.findPartsById(sessionID, messageID),
        hasMessageById: (messageID) => reader.hasById(sessionID, messageID),
        readMessageOrdinalById: (messageID) => reader.ordinalOf(sessionID, messageID),
        readMessageIdOrdinalsForRange: (fromOrdinal, toOrdinal) =>
            reader.ordinalMapForRange(sessionID, fromOrdinal, toOrdinal),
        readMessageOrdinalPage: (after, limit) => reader.readOrdinalPage(sessionID, after, limit),
        getMessageCount: () => reader.getCount(sessionID),
        getStoredMessageCount: () => reader.getStoredCount(sessionID),
        ...(reader.servedBoundaryIdOf
            ? {
                  readServedBoundaryId: (messageID: string) =>
                      reader.servedBoundaryIdOf?.(sessionID, messageID) ?? null,
              }
            : {}),
    };
}
