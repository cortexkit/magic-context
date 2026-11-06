/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    type CompactionMarkerState,
    injectCompactionMarker,
    prepareCompactionMarkerCandidates,
} from "../../features/magic-context/compaction-marker";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import {
    getPersistedCompactionMarkerState,
    type PendingCompactionMarker,
    setPersistedCompactionMarkerState,
} from "../../features/magic-context/storage-meta-persisted";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../shared/test-temp-dir";
import {
    applyDeferredCompactionMarker,
    closeCompactionMarkerConnection,
    MARKER_SUMMARY_TEXT,
} from "./compaction-marker-manager";

const originalXdgDataHome = process.env.XDG_DATA_HOME;
const tempDirs: string[] = [];
const hostDbs: Database[] = [];
const first: PendingCompactionMarker = { ordinal: 10, endMessageId: "first", publishedAt: 1 };
const second: PendingCompactionMarker = { ordinal: 20, endMessageId: "second", publishedAt: 2 };

// Keep the real two-store schema and compartment targets used by the manager fixtures.
function fixture(coveredThrough: "first" | "second" = "second") {
    const home = createTestTempDirFromPath(join(tmpdir(), "marker-publication-review-"));
    tempDirs.push(home);
    process.env.XDG_DATA_HOME = home;
    mkdirSync(join(home, "opencode"), { recursive: true });
    mkdirSync(join(home, "cortexkit", "magic-context"), { recursive: true });
    const oc = new Database(join(home, "opencode", "opencode.db"));
    hostDbs.push(oc);
    oc.exec("PRAGMA journal_mode=WAL");
    oc.exec(
        "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
    );
    oc.exec(
        "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
    );
    const sid = "ses-review";
    for (const [id, time] of [
        ["first", 1_000],
        ["second", 2_000],
    ] as const)
        oc.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
            id,
            sid,
            time,
            time,
            JSON.stringify({ role: "user" }),
        );
    const db = openDatabase();
    appendCompartments(db, sid, [
        {
            sequence: 0,
            startMessage: 1,
            endMessage: 10,
            startMessageId: "first",
            endMessageId: "first",
            title: "first",
            content: "first",
        },
        ...(coveredThrough === "second"
            ? [
                  {
                      sequence: 1,
                      startMessage: 11,
                      endMessage: 20,
                      startMessageId: "second",
                      endMessageId: "second",
                      title: "second",
                      content: "second",
                  },
              ]
            : []),
    ]);
    db.prepare("INSERT INTO session_meta(session_id) VALUES (?)").run(sid);
    return { home, sid, oc, db };
}
type Fixture = ReturnType<typeof fixture>;

async function apply(f: Fixture, target: PendingCompactionMarker) {
    expect(await prepareCompactionMarkerCandidates(f.sid)).toBe(true);
    return applyDeferredCompactionMarker(f.db, f.sid, target, f.home);
}

async function seed(f: Fixture, target: PendingCompactionMarker): Promise<CompactionMarkerState> {
    expect(await prepareCompactionMarkerCandidates(f.sid)).toBe(true);
    const marker = injectCompactionMarker({
        sessionId: f.sid,
        endOrdinal: target.ordinal,
        endMessageId: target.endMessageId,
        directory: f.home,
        summaryText: MARKER_SUMMARY_TEXT,
    });
    if (!marker) throw new Error("expected a complete owned marker fixture");
    return marker;
}

function hostRows(oc: Database) {
    return {
        messages: oc.prepare("SELECT * FROM message ORDER BY id").all(),
        parts: oc.prepare("SELECT * FROM part ORDER BY id").all(),
    };
}

function summary(oc: Database, marker: CompactionMarkerState) {
    return oc.prepare("SELECT * FROM message WHERE id = ?").get(marker.summaryMessageId);
}

function hasCompletedPair(oc: Database, marker: CompactionMarkerState): boolean {
    return Boolean(
        oc
            .prepare(`SELECT 1 FROM message m JOIN part p ON p.message_id = json_extract(m.data, '$.parentID')
        AND p.session_id = m.session_id
        WHERE m.id = ? AND json_extract(m.data, '$.summary') = 1
          AND json_extract(m.data, '$.finish') = 'stop'
          AND json_extract(p.data, '$.type') = 'compaction'`)
            .get(marker.summaryMessageId),
    );
}

afterEach(() => {
    closeCompactionMarkerConnection();
    closeDatabase();
    for (const oc of hostDbs.splice(0)) closeQuietly(oc);
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const home of tempDirs.splice(0)) cleanupTestTempDir(home);
});

describe("compaction marker review witnesses", () => {
    it("does not leave an overextended recorded cut behind when adopting a pair at the repair target", async () => {
        const f = fixture("first");
        const atTarget = await seed(f, first);
        const overextended = await seed(f, second);
        // This is the equal-ordinal overextended state that the manager already repairs.
        setPersistedCompactionMarkerState(f.db, f.sid, {
            ...overextended,
            boundaryOrdinal: 10,
            targetEndMessageId: null,
        });
        const before = hostRows(f.oc);
        const outcome = await apply(f, first);
        if (outcome.kind === "applied") {
            expect(getPersistedCompactionMarkerState(f.db, f.sid)?.summaryMessageId).toBe(
                atTarget.summaryMessageId,
            );
            // A completed marker at the later user still outranks the adopted cut in the host.
            expect(hasCompletedPair(f.oc, overextended)).toBe(false);
        } else {
            expect(outcome.kind).toBe("retryable-failure");
            expect(hostRows(f.oc)).toEqual(before);
        }
    });

    it("preserves a recorded summary still referenced by a native tail_start_id when advancing", async () => {
        const f = fixture();
        expect((await apply(f, first)).kind).toBe("applied");
        const recorded = getPersistedCompactionMarkerState(f.db, f.sid)!;
        const native = await seed(f, second);
        f.oc
            .prepare(
                "UPDATE message SET data = json_set(data, '$.providerID', 'host', '$.modelID', 'host') WHERE id = ?",
            )
            .run(native.summaryMessageId);
        f.oc
            .prepare("UPDATE part SET data = json_set(data, '$.tail_start_id', ?) WHERE id = ?")
            .run(recorded.summaryMessageId, native.compactionPartId);
        // Publish at a third boundary so neither the native pair nor the old owned IDs are reused.
        f.oc
            .prepare("INSERT INTO message VALUES ('third', ?, 3000, 3000, '{\"role\":\"user\"}')")
            .run(f.sid);
        appendCompartments(f.db, f.sid, [
            {
                sequence: 2,
                startMessage: 21,
                endMessage: 30,
                startMessageId: "third",
                endMessageId: "third",
                title: "third",
                content: "third",
            },
        ]);
        const oldSummary = summary(f.oc, recorded);
        const nativeBefore = summary(f.oc, native);
        await apply(f, { ordinal: 30, endMessageId: "third", publishedAt: 3 });
        expect(summary(f.oc, native)).toEqual(nativeBefore);
        expect(summary(f.oc, recorded)).toEqual(oldSummary);
    });

    it("refuses a partial unrecorded owned summary instead of publishing beside it", async () => {
        const f = fixture("first");
        const complete = await seed(f, first);
        const partial = await seed(f, second);
        f.oc.prepare("DELETE FROM part WHERE id = ?").run(partial.compactionPartId);
        const before = hostRows(f.oc);
        const outcome = await apply(f, first);
        expect(outcome.kind).toBe("retryable-failure");
        expect(hostRows(f.oc)).toEqual(before);
        expect(summary(f.oc, complete)).not.toBeNull();
        expect(getPersistedCompactionMarkerState(f.db, f.sid)).toBeNull();
    });
});

describe("recorded marker native tail references", () => {
    for (const location of ["part", "message"] as const) {
        for (const target of ["summaryMessageId", "summaryPartId", "compactionPartId"] as const) {
            it(`refuses replacement when a native ${location} references the recorded ${target}`, async () => {
                const f = fixture();
                expect((await apply(f, first)).kind).toBe("applied");
                const recorded = getPersistedCompactionMarkerState(f.db, f.sid)!;
                const native = await seed(f, second);
                f.oc
                    .prepare(
                        "UPDATE message SET data = json_set(data, '$.providerID', 'host', '$.modelID', 'host') WHERE id = ?",
                    )
                    .run(native.summaryMessageId);
                if (location === "part") {
                    f.oc
                        .prepare(
                            "UPDATE part SET data = json_set(data, '$.tail_start_id', ?) WHERE id = ?",
                        )
                        .run(recorded[target], native.compactionPartId);
                } else {
                    f.oc
                        .prepare(
                            "UPDATE message SET data = json_set(data, '$.compaction.tail_start_id', ?) WHERE id = ?",
                        )
                        .run(recorded[target], native.summaryMessageId);
                }
                f.oc
                    .prepare(
                        "INSERT INTO message VALUES ('third', ?, 3000, 3000, '{\"role\":\"user\"}')",
                    )
                    .run(f.sid);
                appendCompartments(f.db, f.sid, [
                    {
                        sequence: 2,
                        startMessage: 21,
                        endMessage: 30,
                        startMessageId: "third",
                        endMessageId: "third",
                        title: "third",
                        content: "third",
                    },
                ]);
                const before = hostRows(f.oc);
                const outcome = await apply(f, {
                    ordinal: 30,
                    endMessageId: "third",
                    publishedAt: 3,
                });
                expect(outcome.kind).toBe("retryable-failure");
                expect(hostRows(f.oc)).toEqual(before);
                expect(getPersistedCompactionMarkerState(f.db, f.sid)).toEqual(recorded);
            });
        }
    }
});
