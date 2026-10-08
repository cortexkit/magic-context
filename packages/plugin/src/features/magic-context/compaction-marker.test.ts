/// <reference types="bun-types" />

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as logger from "../../shared/logger";
import { Database, withSqliteTransformPass } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { OPENCODE1_MESSAGE_PART_SCHEMA } from "./__tests__/opencode1-query-fixture";
import {
    closeCompactionMarkerDb,
    findBoundaryUserMessage,
    generateMessageId,
    injectCompactionMarker,
    isOpenCodeGapHistorianAbsent,
    removeCompactionMarker,
    removeForeignCompactionMarker,
    removeMcOwnedCompactionMarkers,
    replaceCompactionMarker,
} from "./compaction-marker";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

function useTempDataHome(prefix: string): string {
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    mkdirSync(join(dir, "opencode"), { recursive: true });
    return dir;
}

function createOpenCodeDb(dataHome: string): Database {
    const db = new Database(join(dataHome, "opencode", "opencode.db"));
    db.exec("PRAGMA journal_mode=WAL");
    db.exec(OPENCODE1_MESSAGE_PART_SCHEMA);
    return db;
}

function insertMessage(
    db: Database,
    id: string,
    role: string,
    timeCreated: number,
    data: Record<string, unknown> = {},
): void {
    db.prepare(
        "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, 'ses-1', ?, ?, ?)",
    ).run(id, timeCreated, timeCreated, JSON.stringify({ role, ...data }));
}

/** A real independent writer outlives publication's 250ms acquisition budget. */
async function whileWriterIsLocked<T>(dbPath: string, operation: () => T): Promise<T> {
    const child = Bun.spawn(
        [
            "timeout",
            "10s",
            process.execPath,
            "-e",
            `import { Database } from "bun:sqlite";
         const db = new Database(process.env.OPENCODE_DB);
         db.exec("BEGIN IMMEDIATE");
         console.log("locked");
         await Bun.sleep(1200);
         db.exec("ROLLBACK"); db.close();`,
        ],
        {
            env: { ...process.env, OPENCODE_DB: dbPath },
            stdout: "pipe",
            stderr: "pipe",
            windowsHide: true,
        },
    );
    const reader = child.stdout.getReader();
    try {
        const signal = await reader.read();
        expect(new TextDecoder().decode(signal.value)).toContain("locked");
        return operation();
    } finally {
        reader.releaseLock();
        expect(await child.exited).toBe(0);
    }
}

describe("marker removal acquisition isolation", () => {
    for (const removal of ["owned", "foreign", "compaction-off"] as const) {
        it(`keeps ${removal} removal on the long wait inside a foreground transform`, async () => {
            const dataHome = useTempDataHome(`marker-removal-${removal}-`);
            const db = createOpenCodeDb(dataHome);
            insertMessage(db, "msg_user", "user", 100);
            const args = {
                sessionId: "ses-1",
                endOrdinal: 1,
                endMessageId: "msg_user",
                summaryText: "summary placeholder",
                directory: dataHome,
                resolvedBoundary: { id: "msg_user", timeCreated: 100 },
            };
            const marker = injectCompactionMarker(args);
            if (!marker) throw new Error("expected marker fixture");
            const result = await whileWriterIsLocked(
                join(dataHome, "opencode", "opencode.db"),
                () => {
                    const startedAt = performance.now();
                    const removed = withSqliteTransformPass(() => {
                        if (removal === "owned") return removeCompactionMarker(marker);
                        if (removal === "foreign")
                            return removeForeignCompactionMarker(
                                "ses-1",
                                {
                                    compactionPartId: marker.compactionPartId,
                                    boundaryMessageId: marker.boundaryMessageId,
                                    summaryMessageIds: [marker.summaryMessageId],
                                },
                                null,
                            );
                        return removeMcOwnedCompactionMarkers("ses-1", args.summaryText);
                    });
                    expect(performance.now() - startedAt).toBeGreaterThan(500);
                    return removed;
                },
            );
            if (removal === "compaction-off") {
                expect(result).toMatchObject({
                    verified: true,
                    removedLineages: 1,
                    removedRows: 3,
                });
            } else expect(result).toBe(true);
            expect(db.prepare("SELECT count(*) AS n FROM part").get()).toEqual({ n: 0 });
            expect(db.prepare("SELECT id FROM message ORDER BY id").all()).toEqual([
                { id: "msg_user" },
            ]);
            closeQuietly(db);
        }, 10_000);
    }

    it("keeps injection and replacement short after warming the removal connection", async () => {
        const dataHome = useTempDataHome("marker-removal-publication-isolation-");
        const db = createOpenCodeDb(dataHome);
        insertMessage(db, "msg_user", "user", 100);
        // Open the removal handle before publication ever opens its own handle.
        expect(removeMcOwnedCompactionMarkers("ses-1", "summary placeholder").verified).toBe(true);
        const args = {
            sessionId: "ses-1",
            endOrdinal: 1,
            endMessageId: "msg_user",
            summaryText: "summary placeholder",
            directory: dataHome,
            resolvedBoundary: { id: "msg_user", timeCreated: 100 },
        };
        await whileWriterIsLocked(join(dataHome, "opencode", "opencode.db"), () => {
            const startedAt = performance.now();
            expect(injectCompactionMarker(args)).toBeNull();
            expect(performance.now() - startedAt).toBeLessThan(1000);
            const replacementStartedAt = performance.now();
            expect(replaceCompactionMarker(null, args).kind).toBe("definitely-no-cut");
            expect(performance.now() - replacementStartedAt).toBeLessThan(1000);
        });
        expect(db.prepare("SELECT count(*) AS n FROM part").get()).toEqual({ n: 0 });
        expect(injectCompactionMarker(args)).not.toBeNull();
        closeQuietly(db);
    }, 10_000);
});

afterEach(() => {
    closeCompactionMarkerDb();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    tempDirs.length = 0;
});

describe("findBoundaryUserMessage", () => {
    it("uses bounded message walks without sorting and message-indexed part probes on OpenCode 1.18.30", () => {
        const dataHome = useTempDataHome("marker-indexed-probes-");
        const db = createOpenCodeDb(dataHome);
        insertMessage(db, "msg_prior", "user", 100);
        insertMessage(db, "msg_synthetic", "user", 200);
        insertMessage(db, "msg_target", "assistant", 300);
        db.prepare("INSERT INTO part VALUES (?, ?, 'ses-1', 200, 200, ?)").run(
            "prt_synthetic",
            "msg_synthetic",
            '{"type":"text","synthetic":true}',
        );
        db.transaction(() => {
            for (let index = 0; index < 1024; index++) {
                insertMessage(db, `msg_later_${index}`, "assistant", 1000 + index);
                db.prepare("INSERT INTO part VALUES (?, ?, 'ses-1', 1000, 1000, '{}')").run(
                    `prt_later_${index}`,
                    `msg_later_${index}`,
                );
            }
        })();
        const prepare = spyOn(Database.prototype, "prepare");
        try {
            expect(findBoundaryUserMessage("ses-1", "msg_target")?.id).toBe("msg_prior");
            expect(isOpenCodeGapHistorianAbsent("ses-1", "msg_prior", "msg_target")).toBe(true);
            const queries = prepare.mock.calls
                .map(([sql]) => sql)
                .filter((sql) => sql.includes("EXISTS (SELECT 1 FROM part p"));
            expect(queries).toHaveLength(2);
            const binds = [
                ["ses-1", 300, "msg_target"],
                ["ses-1", 100, "msg_prior", 300, "msg_target"],
            ];
            for (const statistics of ["absent", "analyzed", "adversarial"]) {
                if (statistics !== "absent") db.exec("ANALYZE");
                if (statistics === "adversarial") {
                    db.exec(`UPDATE sqlite_stat1 SET stat='1000000 1' WHERE idx='part_session_idx';
                        UPDATE sqlite_stat1 SET stat='1000000 1000000 1' WHERE idx='part_message_id_id_idx';
                        ANALYZE sqlite_schema;`);
                }
                for (const [index, query] of queries.entries()) {
                    const plan = db
                        .prepare(`EXPLAIN QUERY PLAN ${query}`)
                        .all(...binds[index]) as Array<{ detail: string }>;
                    const details = plan.map((row) => row.detail).join(" | ");
                    expect(details).not.toMatch(/TEMP B-TREE|SCAN /);
                    expect(details).toContain("message_session_time_created_id_idx");
                    expect(details).toContain(
                        index === 0
                            ? "(time_created,id)<(?,?)"
                            : "(time_created,id)>(?,?) AND (time_created,id)<(?,?)",
                    );
                    const partProbes = plan.filter((row) => /SEARCH p /.test(row.detail));
                    expect(partProbes).toHaveLength(2);
                    expect(
                        partProbes.every((row) =>
                            row.detail.includes("part_message_id_id_idx (message_id=?)"),
                        ),
                    ).toBe(true);
                }
            }
        } finally {
            prepare.mockRestore();
            closeQuietly(db);
        }
    });
    it("skips a synthetic-only user row even when it already carries a marker", () => {
        const dataHome = useTempDataHome("marker-synthetic-boundary-");
        const db = createOpenCodeDb(dataHome);
        insertMessage(db, "msg_001_prior_user", "user", 100);
        insertMessage(db, "msg_002_synthetic", "user", 200);
        insertMessage(db, "msg_003_target", "assistant", 300);
        db.prepare(
            "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, 'msg_002_synthetic', 'ses-1', 200, 200, ?)",
        ).run("part_notice", JSON.stringify({ type: "text", text: "notice", synthetic: true }));
        db.prepare(
            "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, 'msg_002_synthetic', 'ses-1', 200, 200, ?)",
        ).run("part_marker", JSON.stringify({ type: "compaction", auto: true }));
        closeQuietly(db);

        expect(findBoundaryUserMessage("ses-1", "msg_003_target")?.id).toBe("msg_001_prior_user");
    });
    it("anchors by endMessageId after rows before the target were deleted", () => {
        const dataHome = useTempDataHome("marker-boundary-deleted-before-");
        const db = createOpenCodeDb(dataHome);
        insertMessage(db, "msg_001_deleted_user", "user", 100);
        insertMessage(db, "msg_002_deleted_assistant", "assistant", 200);
        insertMessage(db, "msg_003_prior_user", "user", 300);
        insertMessage(db, "msg_004_target", "assistant", 400);
        insertMessage(db, "msg_005_after_user", "user", 500);
        db.prepare(
            "DELETE FROM message WHERE id IN ('msg_001_deleted_user', 'msg_002_deleted_assistant')",
        ).run();
        closeQuietly(db);

        expect(findBoundaryUserMessage("ses-1", "msg_004_target")?.id).toBe("msg_003_prior_user");
    });

    it("uses the canonical time_created/id tie-break at equal timestamps", () => {
        const dataHome = useTempDataHome("marker-boundary-tiebreak-");
        const db = createOpenCodeDb(dataHome);
        insertMessage(db, "msg_a_prior_user", "user", 1_000);
        insertMessage(db, "msg_b_target", "assistant", 1_000);
        insertMessage(db, "msg_c_after_user", "user", 1_000);
        closeQuietly(db);

        expect(findBoundaryUserMessage("ses-1", "msg_b_target")?.id).toBe("msg_a_prior_user");
    });

    it("returns the target itself when the target message is a user", () => {
        const dataHome = useTempDataHome("marker-boundary-target-user-");
        const db = createOpenCodeDb(dataHome);
        insertMessage(db, "msg_001_prior_user", "user", 100);
        insertMessage(db, "msg_002_target_user", "user", 200);
        closeQuietly(db);

        expect(findBoundaryUserMessage("ses-1", "msg_002_target_user")?.id).toBe(
            "msg_002_target_user",
        );
    });

    it("is unchanged by deleting rows after the target", () => {
        const dataHome = useTempDataHome("marker-boundary-deleted-after-");
        const db = createOpenCodeDb(dataHome);
        insertMessage(db, "msg_001_prior_user", "user", 100);
        insertMessage(db, "msg_002_target", "assistant", 200);
        insertMessage(db, "msg_003_after_user", "user", 300);
        closeQuietly(db);

        expect(findBoundaryUserMessage("ses-1", "msg_002_target")?.id).toBe("msg_001_prior_user");

        const reopened = new Database(join(dataHome, "opencode", "opencode.db"));
        reopened.prepare("DELETE FROM message WHERE id = 'msg_003_after_user'").run();
        closeQuietly(reopened);
        closeCompactionMarkerDb();

        expect(findBoundaryUserMessage("ses-1", "msg_002_target")?.id).toBe("msg_001_prior_user");
    });

    it("finds a prior user across a long assistant/tool span", () => {
        const dataHome = useTempDataHome("marker-boundary-long-span-");
        const db = createOpenCodeDb(dataHome);
        insertMessage(db, "msg_001_prior_user", "user", 100);
        for (let i = 0; i < 150; i++) {
            insertMessage(
                db,
                `msg_${String(i + 2).padStart(3, "0")}_assistant`,
                "assistant",
                101 + i,
            );
        }
        insertMessage(db, "msg_999_target", "tool", 1_000);
        closeQuietly(db);

        expect(findBoundaryUserMessage("ses-1", "msg_999_target")?.id).toBe("msg_001_prior_user");
    });
});

describe("injectCompactionMarker", () => {
    it("logs marker acquire, hold, work and transaction-end time separately", () => {
        const dataHome = useTempDataHome("marker-writer-timing-");
        const db = createOpenCodeDb(dataHome);
        insertMessage(db, "msg_user", "user", 100);
        closeQuietly(db);
        const logged = spyOn(logger, "log").mockImplementation(() => {});
        const times = [0, 70, 370, 390];
        const clock = spyOn(performance, "now").mockImplementation(() => times.shift() ?? 390);
        try {
            expect(
                injectCompactionMarker({
                    sessionId: "ses-1",
                    endOrdinal: 1,
                    endMessageId: "msg_user",
                    summaryText: "summary placeholder",
                    directory: dataHome,
                    resolvedBoundary: { id: "msg_user", timeCreated: 100 },
                }),
            ).not.toBeNull();
            const lines = logged.mock.calls
                .map(([message]) => String(message))
                .filter((message) =>
                    message.includes("sqlite writer site=compaction-marker-inject"),
                );
            expect(lines).toEqual([
                "[magic-context] sqlite writer site=compaction-marker-inject db=opencode acquire_ms=70 hold_ms=320 work_ms=300 end_ms=20 outcome=committed",
            ]);
        } finally {
            clock.mockRestore();
            logged.mockRestore();
        }
    });
    it("writes a completed summary timestamp for OpenCode 2 conversion", () => {
        const dataHome = useTempDataHome("marker-inject-completed-");
        const db = createOpenCodeDb(dataHome);
        insertMessage(db, "msg_001_user", "user", 100);
        insertMessage(db, "msg_002_target", "assistant", 200);
        closeQuietly(db);

        const result = injectCompactionMarker({
            sessionId: "ses-1",
            endOrdinal: 2,
            endMessageId: "msg_002_target",
            summaryText: "summary placeholder",
            directory: dataHome,
        });

        const inspection = new Database(join(dataHome, "opencode", "opencode.db"));
        const time = inspection
            .prepare("SELECT json_extract(data, '$.time') AS time FROM message WHERE id = ?")
            .get(result?.summaryMessageId) as { time: string };
        expect(JSON.parse(time.time)).toEqual({ created: 101, completed: 101 });
        closeQuietly(inspection);
    });

    it("keeps deterministic marker ids in OpenCode's lexicographic row order", () => {
        const dataHome = useTempDataHome("marker-inject-id-order-");
        const db = createOpenCodeDb(dataHome);
        const boundaryId = generateMessageId(1_000, 0n, "boundary");
        const retainedId = generateMessageId(1_002, 0n, "retained");
        insertMessage(db, boundaryId, "user", 1_000);
        insertMessage(db, retainedId, "assistant", 1_002);
        closeQuietly(db);

        const result = injectCompactionMarker({
            sessionId: "ses-1",
            endOrdinal: 2,
            endMessageId: retainedId,
            summaryText: "summary placeholder",
            directory: dataHome,
        });

        expect(result?.summaryMessageId).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
        expect(result?.compactionPartId).toMatch(/^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
        expect(boundaryId < (result?.summaryMessageId ?? "")).toBe(true);
        expect((result?.summaryMessageId ?? "") < retainedId).toBe(true);

        const inspection = new Database(join(dataHome, "opencode", "opencode.db"));
        const rows = inspection
            .prepare(
                "SELECT id, json_extract(data, '$.role') AS role, json_extract(data, '$.summary') AS summary, json_extract(data, '$.parentID') AS parentID FROM message WHERE session_id = 'ses-1' ORDER BY time_created ASC, id ASC",
            )
            .all() as Array<{
            id: string;
            role: string;
            summary: number | null;
            parentID: string | null;
        }>;
        expect(rows).toEqual([
            { id: boundaryId, role: "user", summary: null, parentID: null },
            {
                id: result?.summaryMessageId,
                role: "assistant",
                summary: 1,
                parentID: boundaryId,
            },
            { id: retainedId, role: "assistant", summary: null, parentID: null },
        ]);
        closeQuietly(inspection);
    });

    it("preserves the deterministic boundary in the healthy no-deletion case", () => {
        const dataHome = useTempDataHome("marker-inject-healthy-");
        const db = createOpenCodeDb(dataHome);
        insertMessage(db, "msg_001_user", "user", 100);
        insertMessage(db, "msg_002_assistant", "assistant", 200);
        insertMessage(db, "msg_003_target", "assistant", 300);
        closeQuietly(db);

        const result = injectCompactionMarker({
            sessionId: "ses-1",
            endOrdinal: 3,
            endMessageId: "msg_003_target",
            summaryText: "summary placeholder",
            directory: dataHome,
        });

        expect(result?.boundaryMessageId).toBe("msg_001_user");
        expect(result?.summaryMessageId).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);

        const retry = injectCompactionMarker({
            sessionId: "ses-1",
            endOrdinal: 3,
            endMessageId: "msg_003_target",
            summaryText: "summary placeholder",
            directory: dataHome,
        });
        expect(retry).toEqual(result);
    });
});
