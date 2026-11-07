import { expect, it, spyOn } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "../../shared/sqlite";
import { fixture, hostStore, messageId, SESSION } from "./__tests__/host-stalls.fixture";
import {
    closeCompactionMarkerDb,
    injectCompactionMarker,
    prepareCompactionMarkerCandidates,
    replaceCompactionMarker,
    withCompactionMarkerPublicationLock,
} from "./compaction-marker";
import * as candidates from "./compaction-marker-candidates";

async function markerFixture(ordinaryRows: number) {
    const f = fixture();
    const previous = { home: process.env.XDG_DATA_HOME, db: process.env.OPENCODE_DB };
    const path = join(f.dir, "opencode/opencode.db");
    process.env.XDG_DATA_HOME = f.dir;
    process.env.OPENCODE_DB = path;
    mkdirSync(join(f.dir, "opencode"));
    const host = hostStore(path, ordinaryRows);
    const insert = host.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)");
    host.transaction(() => {
        for (let i = 0; i < ordinaryRows; i++)
            insert.run(
                `prt_ordinary_${String(i).padStart(6, "0")}`,
                messageId(i),
                SESSION,
                i,
                i,
                JSON.stringify({ type: "text", text: "ordinary payload ".repeat(64) }),
            );
        insert.run("prt_native", messageId(1), SESSION, 1, 1, '{"type":"compaction","auto":true}');
    })();
    const args = {
        sessionId: SESSION,
        endOrdinal: 4,
        endMessageId: messageId(3),
        directory: f.dir,
        summaryText: "summary",
        resolvedBoundary: { id: messageId(3), timeCreated: 1 },
    };
    let writer: Database | undefined;
    const readBasis = candidates.readMarkerCandidateBasis;
    const capture = spyOn(candidates, "readMarkerCandidateBasis").mockImplementation(
        (db, sid, reader) => {
            writer = db;
            return readBasis(db, sid, reader);
        },
    );
    try {
        expect(await prepareCompactionMarkerCandidates(SESSION)).toBe(true);
        const marker = injectCompactionMarker(args);
        expect(marker).not.toBeNull();
        expect(await prepareCompactionMarkerCandidates(SESSION)).toBe(true);
        if (!writer || !marker) throw new Error("marker fixture did not capture its writer");
        return {
            host,
            writer,
            marker,
            args: {
                ...args,
                endOrdinal: 7,
                endMessageId: messageId(6),
                resolvedBoundary: { id: messageId(6), timeCreated: 2 },
            },
            cleanup() {
                closeCompactionMarkerDb();
                host.close();
                for (const [key, value] of [
                    ["XDG_DATA_HOME", previous.home],
                    ["OPENCODE_DB", previous.db],
                ] as const) {
                    if (value === undefined) delete process.env[key];
                    else process.env[key] = value;
                }
                f.cleanup();
            },
        };
    } finally {
        capture.mockRestore();
    }
}

// Observe the outermost BEGIN IMMEDIATE, not db.inTransaction: the preflight
// deliberately runs in a read transaction, which must not count as locked work.
function traceWriter(db: Database, beforeLock: () => void = () => {}) {
    const transaction = db.transaction.bind(db);
    let locked = false;
    const reads: Array<{
        sql: string;
        plan: string[];
        returnedRows: number;
        parameters: unknown[];
    }> = [];
    const preparationReads: typeof reads = [];
    const tx = spyOn(db, "transaction").mockImplementation((operation: () => unknown) => {
        const run = transaction(operation);
        const immediate = run.immediate.bind(run);
        run.immediate = () => {
            if (locked) return immediate();
            beforeLock();
            locked = true;
            try {
                return immediate();
            } finally {
                locked = false;
            }
        };
        return run;
    });
    const observe = (connection: Database) => {
        const prepare = connection.prepare.bind(connection);
        return spyOn(connection, "prepare").mockImplementation((sql: string) => {
            const statement = prepare(sql);
            return new Proxy(statement, {
                get(target, key) {
                    if (key !== "get" && key !== "all") {
                        const value = Reflect.get(target, key, target);
                        return typeof value === "function" ? value.bind(target) : value;
                    }
                    return (...parameters: unknown[]) => {
                        const result = target[key](...parameters);
                        if (
                            (locked || connection.inTransaction) &&
                            /^\s*(SELECT|WITH)\b/i.test(sql)
                        ) {
                            const explain = prepare(`EXPLAIN QUERY PLAN ${sql}`);
                            let plan: Array<{ detail: string }>;
                            try {
                                plan = explain.all(...parameters) as typeof plan;
                            } finally {
                                (
                                    explain as typeof explain & { finalize?: () => void }
                                ).finalize?.();
                            }
                            (locked ? reads : preparationReads).push({
                                sql,
                                plan: plan.map((row) => row.detail),
                                returnedRows: Array.isArray(result)
                                    ? result.length
                                    : result
                                      ? 1
                                      : 0,
                                parameters,
                            });
                        }
                        return result;
                    };
                },
            });
        });
    };
    const statements = observe(db);
    const readers: Array<ReturnType<typeof observe>> = [];
    const observed = new Set<Database>();
    const readBasis = candidates.readMarkerCandidateBasis;
    const certification = spyOn(candidates, "readMarkerCandidateBasis").mockImplementation(
        (writer, sid, reader) => {
            if (reader && reader !== db && !observed.has(reader)) {
                observed.add(reader);
                readers.push(observe(reader));
            }
            return readBasis(writer, sid, reader);
        },
    );
    return {
        reads,
        preparationReads,
        readConnections: observed,
        restore() {
            statements.mockRestore();
            for (const reader of readers) reader.mockRestore();
            certification.mockRestore();
            tx.mockRestore();
        },
    };
}

function discoveryCost(reads: ReturnType<typeof traceWriter>["preparationReads"]) {
    const discovery = reads.filter(
        (read) =>
            read.sql !== candidates.MARKER_CERTIFICATION_SQL &&
            !read.sql.includes("ORDER BY id DESC LIMIT 1"),
    );
    const suffixes = discovery.filter((read) => read.sql.includes("WHERE id > ? AND +session_id"));
    return {
        selects: reads.length,
        sessionScans: discovery.flatMap((read) =>
            read.plan.filter(
                (detail) =>
                    /SCAN (part|message)\b/.test(detail) ||
                    /SEARCH (part|message) USING INDEX \S+ \(session_id=\?\)$/.test(detail),
            ),
        ).length,
        primaryKeyReads: discovery.filter((read) =>
            read.sql.includes("WHERE id = ? AND session_id = ?"),
        ).length,
        suffixes: suffixes.length,
        indexedSuffixes: suffixes.every((read) =>
            read.plan.some((detail) => detail.includes("(id>?)")),
        ),
        discoveredSuffixRows: suffixes.reduce((total, read) => total + read.returnedRows, 0),
    };
}

it("the second marker move discovers only known compactions and the new-ID suffix", async () => {
    const measurements: ReturnType<typeof discoveryCost>[] = [];
    for (const ordinaryRows of [20, 20_000]) {
        const f = await markerFixture(ordinaryRows);
        const firstTrace = traceWriter(f.writer);
        let first: ReturnType<typeof replaceCompactionMarker>;
        try {
            first = withCompactionMarkerPublicationLock(
                () => replaceCompactionMarker(f.marker, f.args, true),
                SESSION,
            );
            expect(first.kind).toBe("committed");
            expect(discoveryCost(firstTrace.preparationReads).sessionScans).toBe(2);
        } finally {
            firstTrace.restore();
        }
        if (first.kind !== "committed") throw new Error("first marker move did not commit");
        await prepareCompactionMarkerCandidates(SESSION);
        f.host
            .prepare("INSERT INTO part VALUES (?,?,?,?,?,?)")
            .run("prt_zz_native", messageId(1), SESSION, 1, 1, '{"type":"compaction","auto":true}');
        f.host
            .prepare("INSERT INTO part VALUES (?,?,?,?,?,?)")
            .run(
                "prt_zz_ordinary",
                messageId(1),
                SESSION,
                1,
                1,
                '{"type":"text","text":"ordinary"}',
            );
        const trace = traceWriter(f.writer);
        try {
            const marker = first.marker;
            const outcome = withCompactionMarkerPublicationLock(
                () =>
                    replaceCompactionMarker(
                        marker,
                        {
                            ...f.args,
                            endOrdinal: 10,
                            endMessageId: messageId(9),
                            resolvedBoundary: { id: messageId(9), timeCreated: 3 },
                        },
                        true,
                    ),
                SESSION,
            );
            expect(outcome.kind).toBe("committed");
            expect(trace.readConnections).toEqual(firstTrace.readConnections);
            const cost = discoveryCost(trace.preparationReads);
            console.log(
                `marker second-move discovery: ${JSON.stringify({ ordinaryRows, ...cost })}`,
            );
            measurements.push(cost);
        } finally {
            trace.restore();
            f.cleanup();
        }
    }
    for (const cost of measurements) {
        expect(cost.sessionScans).toBe(0);
        expect(cost.primaryKeyReads).toBe(4);
        expect(cost.suffixes).toBe(2);
        expect(cost.indexedSuffixes).toBe(true);
        // The newly inserted native compaction has no tail yet but must be
        // learned now, before a later native update publishes its tail target.
        expect(cost.discoveredSuffixRows).toBe(1);
    }
    expect(measurements[1]).toEqual(measurements[0]);
});

it("incremental discovery retains a backdated injected part that later gains a native tail", async () => {
    const f = await markerFixture(20);
    try {
        const first = withCompactionMarkerPublicationLock(
            () => replaceCompactionMarker(f.marker, f.args, true),
            SESSION,
        );
        expect(first.kind).toBe("committed");
        if (first.kind !== "committed") throw new Error("first marker move did not commit");
        expect(await prepareCompactionMarkerCandidates(SESSION)).toBe(true);
        const highest = f.host.prepare("SELECT id FROM part ORDER BY id DESC LIMIT 1").get() as {
            id: string;
        };
        const injected = injectCompactionMarker({
            ...f.args,
            endOrdinal: 10,
            endMessageId: messageId(9),
            resolvedBoundary: { id: messageId(9), timeCreated: 3 },
        });
        expect(injected).not.toBeNull();
        if (!injected) throw new Error("backdated marker injection failed");
        expect(injected.compactionPartId < highest.id).toBe(true);
        f.host
            .prepare("UPDATE part SET data=json_set(data,'$.tail_start_id',?) WHERE id=?")
            .run(first.marker.summaryPartId, injected.compactionPartId);
        expect(await prepareCompactionMarkerCandidates(SESSION)).toBe(true);
        const rows = () => ({
            messages: f.host.prepare("SELECT * FROM message ORDER BY id").all(),
            parts: f.host.prepare("SELECT * FROM part ORDER BY id").all(),
        });
        const before = rows();
        const trace = traceWriter(f.writer);
        try {
            const outcome = withCompactionMarkerPublicationLock(
                () =>
                    replaceCompactionMarker(
                        first.marker,
                        {
                            ...f.args,
                            endOrdinal: 13,
                            endMessageId: messageId(12),
                            resolvedBoundary: { id: messageId(12), timeCreated: 4 },
                        },
                        true,
                    ),
                SESSION,
            );
            expect(outcome.kind).not.toBe("committed");
            if (outcome.kind !== "committed")
                expect(outcome.error.message).toContain("tail_start_id");
            expect(rows()).toEqual(before);
            expect(discoveryCost(trace.preparationReads).sessionScans).toBe(0);
            expect(
                trace.preparationReads.some(
                    (read) =>
                        read.sql.includes("WHERE id = ? AND session_id = ?") &&
                        read.parameters[0] === injected.compactionPartId,
                ),
            ).toBe(true);
        } finally {
            trace.restore();
        }
    } finally {
        f.cleanup();
    }
});

it("back-to-back marker moves release read cursors before the other connection writes", async () => {
    const f = await markerFixture(20);
    f.host.exec("PRAGMA busy_timeout=0");
    let writes = 0;
    try {
        let marker = f.marker;
        for (const index of [6, 9]) {
            expect(await prepareCompactionMarkerCandidates(SESSION)).toBe(true);
            const trace = traceWriter(f.writer, () => {
                // A WAL writer can append despite a lingering reader, but cannot
                // truncate its WAL. Check both so a pinned cursor cannot hide
                // behind a successful UPDATE on the other connection.
                expect(
                    f.host
                        .prepare("UPDATE message SET time_updated=time_updated+1 WHERE id=?")
                        .run(messageId(0)).changes,
                ).toBe(1);
                writes++;
                const checkpoint = f.host.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
                    busy: number;
                };
                expect(checkpoint.busy).toBe(0);
            });
            try {
                const outcome = withCompactionMarkerPublicationLock(
                    () =>
                        replaceCompactionMarker(
                            marker,
                            {
                                ...f.args,
                                endOrdinal: index + 1,
                                endMessageId: messageId(index),
                                resolvedBoundary: {
                                    id: messageId(index),
                                    timeCreated: Math.floor(index / 3),
                                },
                            },
                            true,
                        ),
                    SESSION,
                );
                expect(outcome.kind).toBe("committed");
                if (outcome.kind === "committed") marker = outcome.marker;
            } finally {
                trace.restore();
            }
        }
        expect(writes).toBe(2);
    } finally {
        f.cleanup();
    }
});

it("the writer refuses a basis changed after certification on the read connection", async () => {
    const f = await markerFixture(20);
    const rows = () => ({
        messages: f.host.prepare("SELECT * FROM message ORDER BY id").all(),
        parts: f.host.prepare("SELECT * FROM part ORDER BY id").all(),
    });
    let afterRace: unknown;
    const trace = traceWriter(f.writer, () => {
        f.host
            .prepare("INSERT INTO message VALUES (?,?,?,?,?)")
            .run(
                "msg_zz_native_summary",
                SESSION,
                100,
                100,
                JSON.stringify({ role: "assistant", summary: true, parentID: messageId(1) }),
            );
        afterRace = rows();
    });
    try {
        const outcome = withCompactionMarkerPublicationLock(
            () => replaceCompactionMarker(f.marker, f.args, true),
            SESSION,
        );
        expect(outcome.kind).toBe("deferred");
        if (outcome.kind !== "committed")
            expect(outcome.error.message).toContain("host store changed");
        expect(rows()).toEqual(afterRace);
        expect(trace.readConnections.size).toBe(1);
        expect(() =>
            [...trace.readConnections][0]!
                .prepare("UPDATE message SET time_updated=time_updated+1 WHERE id=?")
                .run(messageId(0)),
        ).toThrow(/readonly|read-only/);
        expect(
            trace.preparationReads.filter(
                (read) => read.sql === candidates.MARKER_CERTIFICATION_SQL,
            ),
        ).toHaveLength(1);
    } finally {
        trace.restore();
        f.cleanup();
    }
});

it("marker replacement never scans historical session rows under the outer writer lock", async () => {
    const measurements: Array<{
        ordinaryRows: number;
        selects: number;
        sessionScans: number;
        suffixes: number;
        indexedSuffixes: boolean;
        primaryKeyReads: number;
    }> = [];
    for (const ordinaryRows of [20, 20_000]) {
        const f = await markerFixture(ordinaryRows);
        const trace = traceWriter(f.writer);
        try {
            const outcome = withCompactionMarkerPublicationLock(
                () => replaceCompactionMarker(f.marker, f.args, true),
                SESSION,
            );
            expect(outcome.kind).toBe("committed");
            // A session-index equality with no ID/time bound reads the entire
            // session, even though EXPLAIN calls it SEARCH rather than SCAN.
            // The existing certification's ORDER BY rowid DESC LIMIT 1 probes
            // are labelled SCAN too, but each stops after the newest row.
            const sessionScans = trace.reads
                .filter((read) => read.sql !== candidates.MARKER_CERTIFICATION_SQL)
                .flatMap((read) =>
                    read.plan.filter(
                        (detail) =>
                            /SCAN (part|message)\b/.test(detail) ||
                            /SEARCH (part|message) USING INDEX \S+ \(session_id=\?\)$/.test(detail),
                    ),
                );
            const suffixes = trace.reads.filter((read) =>
                read.sql.includes("WHERE id > ? AND +session_id"),
            );
            measurements.push({
                ordinaryRows,
                selects: trace.reads.length,
                sessionScans: sessionScans.length,
                suffixes: suffixes.length,
                indexedSuffixes: suffixes.every((read) =>
                    read.plan.some((detail) => detail.includes("(id>?)")),
                ),
                primaryKeyReads: trace.reads.filter((read) =>
                    read.sql.includes("WHERE id = ? AND session_id = ?"),
                ).length,
            });
            console.log(
                `marker locked reads: ${JSON.stringify(measurements.at(-1))}; plans=${JSON.stringify(trace.reads.flatMap((read) => read.plan))}`,
            );
        } finally {
            trace.restore();
            f.cleanup();
        }
    }
    for (const measurement of measurements) {
        expect(measurement.sessionScans).toBe(0);
        expect(measurement.suffixes).toBe(2);
        expect(measurement.indexedSuffixes).toBe(true);
        // One native and one owned compaction part are re-read by primary key.
        expect(measurement.primaryKeyReads).toBe(2);
    }
    expect(measurements[1]!.selects).toBe(measurements[0]!.selects);
});

for (const race of ["insert part", "update part", "update compatibility message"] as const) {
    it(`marker replacement defers without deleting when a native tail races the scan: ${race}`, async () => {
        const f = await markerFixture(20);
        if (race === "update compatibility message")
            f.host
                .prepare(
                    "UPDATE message SET data=json_set(data,'$.compaction',json('{}')) WHERE id=?",
                )
                .run(messageId(1));
        let afterRace: unknown;
        const rows = () => ({
            messages: f.host.prepare("SELECT * FROM message ORDER BY id").all(),
            parts: f.host.prepare("SELECT * FROM part ORDER BY id").all(),
        });
        const trace = traceWriter(f.writer, () => {
            if (race === "insert part")
                f.host.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)").run(
                    "prt_zz_new_native",
                    messageId(1),
                    SESSION,
                    1,
                    1,
                    JSON.stringify({
                        type: "compaction",
                        tail_start_id: f.marker.summaryPartId,
                    }),
                );
            else if (race === "update part")
                f.host
                    .prepare(
                        "UPDATE part SET data=json_set(data,'$.tail_start_id',?) WHERE id='prt_native'",
                    )
                    .run(f.marker.compactionPartId);
            else
                f.host
                    .prepare(
                        "UPDATE message SET data=json_set(data,'$.compaction.tail_start_id',?) WHERE id=?",
                    )
                    .run(f.marker.summaryMessageId, messageId(1));
            afterRace = rows();
        });
        try {
            const outcome = withCompactionMarkerPublicationLock(
                () => replaceCompactionMarker(f.marker, f.args, true),
                SESSION,
            );
            expect(outcome.kind).toBe("deferred");
            if (outcome.kind !== "committed")
                expect(outcome.error.message).toContain("tail_start_id");
            expect(rows()).toEqual(afterRace);
        } finally {
            trace.restore();
            f.cleanup();
        }
    });
}
