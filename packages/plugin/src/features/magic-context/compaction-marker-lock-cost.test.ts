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
    const capture = spyOn(candidates, "readMarkerCandidateBasis").mockImplementation((db, sid) => {
        writer = db;
        return readBasis(db, sid);
    });
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
    const prepare = db.prepare.bind(db);
    const transaction = db.transaction.bind(db);
    let locked = false;
    const reads: Array<{ sql: string; plan: string[]; returnedRows: number }> = [];
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
    const statements = spyOn(db, "prepare").mockImplementation((sql: string) => {
        const statement = prepare(sql);
        return new Proxy(statement, {
            get(target, key) {
                if (key !== "get" && key !== "all") return Reflect.get(target, key, target);
                return (...parameters: unknown[]) => {
                    const result = target[key](...parameters);
                    if (locked && /^\s*(SELECT|WITH)\b/i.test(sql)) {
                        const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(
                            ...parameters,
                        ) as Array<{
                            detail: string;
                        }>;
                        reads.push({
                            sql,
                            plan: plan.map((row) => row.detail),
                            returnedRows: Array.isArray(result) ? result.length : result ? 1 : 0,
                        });
                    }
                    return result;
                };
            },
        });
    });
    return {
        reads,
        restore() {
            statements.mockRestore();
            tx.mockRestore();
        },
    };
}

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
