/// <reference types="bun-types" />

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
    acquireCompartmentLease,
    releaseCompartmentLease,
} from "../../features/magic-context/compartment-lease";
import {
    appendCompartments,
    getCompartments,
    getLastCompartmentEndMessageId,
} from "../../features/magic-context/compartment-storage";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { repairMissingHistoryBoundary } from "./history-boundary-repair";

const SESSION = "ses-history-boundary";

let db: Database | undefined;

afterEach(() => {
    if (db) closeQuietly(db);
    db = undefined;
});

/**
 * Three compartments ending at host messages m-2, m-4 and m-6, and a cached
 * m[0]/m[1] prefix whose recorded boundary is the newest end.
 */
function seed(options: { baseline?: string | null; latestEndId?: string } = {}): Database {
    const database = new Database(":memory:");
    initializeDatabase(database);
    getOrCreateSessionMeta(database, SESSION);
    appendCompartments(
        database,
        SESSION,
        [1, 2, 3].map((index) => ({
            sequence: index - 1,
            startMessage: index * 2 - 1,
            endMessage: index * 2,
            startMessageId: `m-${index * 2 - 1}`,
            endMessageId:
                index === 3 && options.latestEndId !== undefined
                    ? options.latestEndId
                    : `m-${index * 2}`,
            title: `Compartment ${index}`,
            content: `Summary ${index}`,
        })),
    );
    database
        .prepare(
            "UPDATE session_meta SET cached_m0_bytes = ?, cached_m1_bytes = ?, cached_m0_last_baseline_end_message_id = ? WHERE session_id = ?",
        )
        .run(
            Buffer.from("m0"),
            Buffer.from("m1"),
            options.baseline === undefined ? "m-6" : options.baseline,
            SESSION,
        );
    for (const ordinal of [2, 4, 6])
        database
            .prepare(
                "INSERT INTO compression_depth (session_id, message_ordinal, depth, harness) VALUES (?, ?, 1, 'opencode')",
            )
            .run(SESSION, ordinal);
    db = database;
    return database;
}

/** A host store holding exactly `ids`; every other id is a definite "not there". */
function store(ids: string[]): (id: string) => boolean {
    const held = new Set(ids);
    return (id) => held.has(id);
}

function cachedPair(database: Database): { m0: unknown; boundary: string | null } {
    return database
        .prepare(
            "SELECT cached_m0_bytes AS m0, cached_m0_last_baseline_end_message_id AS boundary FROM session_meta WHERE session_id = ?",
        )
        .get(SESSION) as { m0: unknown; boundary: string | null };
}

function depthOrdinals(database: Database): number[] {
    return (
        database
            .prepare(
                "SELECT message_ordinal AS ordinal FROM compression_depth WHERE session_id = ? ORDER BY message_ordinal",
            )
            .all(SESSION) as Array<{ ordinal: number }>
    ).map((row) => row.ordinal);
}

function captureBoundaryRead(database: Database) {
    const prepare = database.prepare.bind(database);
    let sql = "";
    let rows: Array<Record<string, unknown>> = [];
    const spy = spyOn(database, "prepare").mockImplementation((query) => {
        const statement = prepare(query);
        if (sql || !/\bFROM\s+compartments\b/i.test(query)) return statement;
        sql = query;
        return {
            all: (...params: Parameters<typeof statement.all>) => {
                rows = statement.all(...params) as Array<Record<string, unknown>>;
                return rows;
            },
        } as typeof statement;
    });
    return {
        get sql() {
            return sql;
        },
        get rows() {
            return rows;
        },
        restore: () => spy.mockRestore(),
    };
}

describe("repairMissingHistoryBoundary", () => {
    it("store checks transfer only sequence and end id, not compartment bodies", () => {
        const database = seed();
        database
            .prepare("UPDATE compartments SET content = ?, p1 = ?, p2 = ?, p3 = ?, p4 = ?")
            .run(...Array.from({ length: 5 }, () => "Summary payload ".repeat(1024)));
        const expected = getCompartments(database, SESSION).map(({ sequence, endMessageId }) => ({
            sequence,
            endMessageId,
        }));
        const captured = captureBoundaryRead(database);
        try {
            expect(
                repairMissingHistoryBoundary({
                    db: database,
                    sessionId: SESSION,
                    scope: "store",
                    isInHostStore: store(["m-2", "m-4", "m-6"]),
                }),
            ).toEqual({ kind: "intact" });
            expect(
                captured.sql
                    .split(/\bFROM\b/i)[0]
                    ?.replace(/\s+/g, " ")
                    .trim(),
            ).toBe("SELECT sequence, end_message_id AS endMessageId");
            expect(captured.rows).toEqual(expected);
        } finally {
            captured.restore();
        }
    });

    it("store projection preserves full-row filtering, anchor and retirement decisions", () => {
        const database = seed();
        appendCompartments(
            database,
            SESSION,
            Array.from({ length: 8 }, (_, offset) => {
                const sequence = offset + 3;
                return {
                    sequence,
                    startMessage: sequence * 2 + 1,
                    endMessage: sequence * 2 + 2,
                    startMessageId: `m-${sequence * 2 + 1}`,
                    endMessageId: sequence === 9 ? "" : `m-${sequence * 2 + 2}`,
                    title: `Compartment ${sequence}`,
                    content: "Summary",
                    p1: null,
                    p2: null,
                    p3: null,
                    p4: null,
                };
            }),
        );
        database.exec("UPDATE compartments SET end_message_id = NULL WHERE sequence IN (3, 10)");
        database.exec("UPDATE compartments SET start_message_id = NULL WHERE sequence = 4");
        database
            .prepare("UPDATE compartments SET content = ? WHERE sequence = 5")
            .run(new Uint8Array([65, 66, 67]));
        database
            .prepare("UPDATE compartments SET p2 = ? WHERE sequence = 6")
            .run(new Uint8Array([65, 66, 67]));
        database.exec("UPDATE compartments SET importance = 'invalid' WHERE sequence = 7");
        const previous = getCompartments(database, SESSION);
        expect(previous.map((row) => row.sequence)).toEqual([0, 1, 2, 8, 9]);
        const held = new Set(["m-2", "m-4", "m-10", "m-12", "m-14", "m-16"]);
        const latestIndex = previous.findLastIndex((row) => row.endMessageId !== "");
        const latest = previous[latestIndex]!;
        const anchor = previous
            .slice(0, latestIndex)
            .findLast((row) => held.has(row.endMessageId))!;
        const expectedDropped = (
            database
                .prepare(
                    "SELECT sequence FROM compartments WHERE session_id = ? AND sequence > ? ORDER BY sequence",
                )
                .all(SESSION, anchor.sequence) as Array<{ sequence: number }>
        ).map((row) => row.sequence);
        const checked: string[] = [];
        let retired: Array<{ sequence: number; endMessageId: string }> = [];
        let retiredAnchor: { sequence: number; endMessageId: string } | null = null;
        expect(
            repairMissingHistoryBoundary({
                db: database,
                sessionId: SESSION,
                scope: "store",
                isInHostStore: (id) => {
                    checked.push(id);
                    return held.has(id);
                },
                onRetire: (rows, surviving) => {
                    retired = rows.map(({ sequence, endMessageId }) => ({
                        sequence,
                        endMessageId,
                    }));
                    retiredAnchor = surviving
                        ? { sequence: surviving.sequence, endMessageId: surviving.endMessageId }
                        : null;
                },
            }),
        ).toEqual({
            kind: "repaired",
            missingEndMessageId: latest.endMessageId,
            anchorEndMessageId: anchor.endMessageId,
            droppedSequences: expectedDropped,
        });
        expect(checked).toEqual(["m-18", "m-6", "m-4"]);
        expect(retired).toEqual(
            previous
                .slice(latestIndex)
                .map(({ sequence, endMessageId }) => ({ sequence, endMessageId })),
        );
        expect(retiredAnchor).toEqual({
            sequence: anchor.sequence,
            endMessageId: anchor.endMessageId,
        });
        expect(getCompartments(database, SESSION).map((row) => row.sequence)).toEqual([0, 1]);
        expect(depthOrdinals(database)).toEqual([2, 4]);
        expect(cachedPair(database)).toEqual({ m0: null, boundary: null });
    });

    it("store projection keeps the full-row path's older-schema behavior", () => {
        const database = seed();
        database.exec("ALTER TABLE compartments RENAME COLUMN p2 TO retired_p2");
        database.exec("ALTER TABLE compartments RENAME COLUMN importance TO retired_importance");
        const expected = getCompartments(database, SESSION).map(({ sequence, endMessageId }) => ({
            sequence,
            endMessageId,
        }));
        const captured = captureBoundaryRead(database);
        try {
            expect(
                repairMissingHistoryBoundary({
                    db: database,
                    sessionId: SESSION,
                    scope: "store",
                    isInHostStore: () => true,
                }),
            ).toEqual({ kind: "intact" });
            expect(captured.rows).toEqual(expected);
        } finally {
            captured.restore();
        }
        database.exec("ALTER TABLE compartments RENAME COLUMN title TO retired_title");
        database.exec(
            "ALTER TABLE compartments RENAME COLUMN end_message_id TO retired_end_message_id",
        );
        expect(getCompartments(database, SESSION)).toEqual([]);
        expect(
            repairMissingHistoryBoundary({
                db: database,
                sessionId: SESSION,
                scope: "store",
                isInHostStore: () => false,
            }),
        ).toEqual({ kind: "intact" });
    });

    it("leaves a session alone when the store has the newest compartment end", () => {
        const database = seed();
        const result = repairMissingHistoryBoundary({
            db: database,
            sessionId: SESSION,
            isInHostStore: store(["m-2", "m-4", "m-6"]),
        });
        expect(result).toEqual({ kind: "intact" });
        expect(getCompartments(database, SESSION)).toHaveLength(3);
        expect(cachedPair(database).m0).not.toBeNull();
    });

    it("re-anchors on the newest compartment end the store still has", () => {
        const database = seed();
        const result = repairMissingHistoryBoundary({
            db: database,
            sessionId: SESSION,
            isInHostStore: store(["m-2", "m-4"]),
        });
        expect(result).toEqual({
            kind: "repaired",
            missingEndMessageId: "m-6",
            anchorEndMessageId: "m-4",
            droppedSequences: [2],
        });
        expect(getCompartments(database, SESSION).map((row) => row.endMessageId)).toEqual([
            "m-2",
            "m-4",
        ]);
        // The pair rendered the removed compartment, so it is rebuilt next pass.
        expect(cachedPair(database)).toEqual({ m0: null, boundary: null });
        expect(depthOrdinals(database)).toEqual([2, 4]);
    });

    it("skips older compartments whose ends are gone too and anchors on the newest one left", () => {
        const database = seed();
        const result = repairMissingHistoryBoundary({
            db: database,
            sessionId: SESSION,
            isInHostStore: store(["m-2"]),
        });
        expect(result.kind).toBe("repaired");
        expect(getCompartments(database, SESSION).map((row) => row.endMessageId)).toEqual(["m-2"]);
    });

    it("keeps a newest compartment with no end_message_id (the fork shape) and bounds at the newest id", () => {
        // A compartment without an end id cannot be placed, but that says nothing
        // about the store, so it is kept. The boundary is the newest end id.
        const database = seed({ latestEndId: "", baseline: "m-4" });
        const result = repairMissingHistoryBoundary({
            db: database,
            sessionId: SESSION,
            isInHostStore: store(["m-2", "m-4", "m-6"]),
        });
        expect(result).toEqual({ kind: "intact" });
        expect(getCompartments(database, SESSION)).toHaveLength(3);
        expect(getLastCompartmentEndMessageId(database, SESSION)).toBe("m-4");
    });

    it("re-anchors past an id-less newest compartment when the newest end id is gone", () => {
        const database = seed({ latestEndId: "", baseline: "m-4" });
        const result = repairMissingHistoryBoundary({
            db: database,
            sessionId: SESSION,
            isInHostStore: store(["m-2"]),
        });
        expect(result).toEqual({
            kind: "repaired",
            missingEndMessageId: "m-4",
            anchorEndMessageId: "m-2",
            droppedSequences: [1, 2],
        });
    });

    it("changes nothing when the store cannot answer", () => {
        const database = seed();
        const result = repairMissingHistoryBoundary({
            db: database,
            sessionId: SESSION,
            isInHostStore: () => null,
        });
        expect(result).toEqual({ kind: "unknown" });
        expect(getCompartments(database, SESSION)).toHaveLength(3);
        expect(cachedPair(database).boundary).toBe("m-6");
    });

    it("reports an unresolved boundary when no compartment end is left to anchor on", () => {
        const database = seed();
        const result = repairMissingHistoryBoundary({
            db: database,
            sessionId: SESSION,
            isInHostStore: store([]),
        });
        expect(result).toEqual({
            kind: "unresolved",
            reason: "no-anchor",
            missingEndMessageId: "m-6",
        });
        expect(getCompartments(database, SESSION)).toHaveLength(3);
        expect(cachedPair(database).boundary).toBe("m-6");
    });

    it("waits while another holder owns compartment state", () => {
        const database = seed();
        expect(acquireCompartmentLease(database, SESSION, "historian")).not.toBeNull();
        try {
            const result = repairMissingHistoryBoundary({
                db: database,
                sessionId: SESSION,
                isInHostStore: store(["m-2", "m-4"]),
            });
            expect(result).toEqual({
                kind: "unresolved",
                reason: "busy",
                missingEndMessageId: "m-6",
            });
            expect(getCompartments(database, SESSION)).toHaveLength(3);
        } finally {
            releaseCompartmentLease(database, SESSION, "historian");
        }
    });

    it("clears a cached pair whose boundary the store no longer has", () => {
        const database = seed({ baseline: "m-5" });
        const result = repairMissingHistoryBoundary({
            db: database,
            sessionId: SESSION,
            isInHostStore: store(["m-2", "m-4", "m-6"]),
        });
        expect(result).toEqual({
            kind: "baseline-reset",
            anchorEndMessageId: "m-6",
            staleBaselineId: "m-5",
        });
        expect(getCompartments(database, SESSION)).toHaveLength(3);
        expect(cachedPair(database)).toEqual({ m0: null, boundary: null });
    });

    it("keeps an older cached boundary the store still has: the next priced pass moves it", () => {
        const database = seed({ baseline: "m-4" });
        const result = repairMissingHistoryBoundary({
            db: database,
            sessionId: SESSION,
            isInHostStore: store(["m-2", "m-4", "m-6"]),
        });
        expect(result).toEqual({ kind: "intact" });
        expect(cachedPair(database).boundary).toBe("m-4");
    });

    it("leaves a pair recorded before the first compartment alone", () => {
        // Replaying that cached pair covers none of the compartments, so their raw
        // rows are meant to be served until the next cache-busting pass folds them in.
        const database = seed({ baseline: null });
        expect(
            repairMissingHistoryBoundary({
                db: database,
                sessionId: SESSION,
                isInHostStore: store(["m-2", "m-4", "m-6"]),
            }),
        ).toEqual({ kind: "intact" });
        expect(cachedPair(database).m0).not.toBeNull();
    });
});
