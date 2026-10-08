/// <reference types="bun-types" />

import { expect, it, spyOn } from "bun:test";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import {
    createQueryFixture,
    explainQuery,
    FIXTURE_SESSION,
    fixtureKey,
    OLD_BOUNDARY_SQL,
    OLD_GAP_SQL,
    oldBoundary,
    oldGap,
    randomFixtureIndices,
} from "./__tests__/opencode1-query-fixture";
import {
    closeCompactionMarkerDb,
    findBoundaryUserMessage,
    isOpenCodeGapHistorianAbsent,
} from "./compaction-marker";

function withFixture(
    messages: number,
    parts: number,
    run: (db: Database, path: string) => void,
): void {
    const root = createTestTempDirFromPath(join(tmpdir(), "marker-keyset-"));
    const originalDataHome = process.env.XDG_DATA_HOME;
    const originalDb = process.env.OPENCODE_DB;
    // Never use an inherited database override, even when this file is run alone.
    delete process.env.OPENCODE_DB;
    process.env.XDG_DATA_HOME = root;
    mkdirSync(join(root, "opencode"));
    const path = join(root, "opencode", "opencode.db");
    const db = createQueryFixture(path, messages, parts);
    try {
        expect(
            db
                .prepare(`SELECT
                    (SELECT count(*) FROM message WHERE session_id=?) AS messages,
                    (SELECT count(*) FROM part WHERE session_id=?) AS parts`)
                .get(FIXTURE_SESSION, FIXTURE_SESSION),
        ).toEqual({ messages, parts });
        run(db, path);
    } finally {
        closeCompactionMarkerDb();
        db.close();
        if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = originalDataHome;
        if (originalDb === undefined) delete process.env.OPENCODE_DB;
        else process.env.OPENCODE_DB = originalDb;
        rmSync(root, { recursive: true, force: true });
    }
}

function compareTargets(db: Database, messages: number, randomCount: number): void {
    const indices = [
        0,
        1,
        2,
        3,
        239,
        240,
        241,
        479,
        480,
        481,
        699,
        700,
        701,
        710,
        720,
        730,
        900,
        901,
        902,
        903,
        messages - 1,
        ...randomFixtureIndices(randomCount, messages),
    ];
    for (const index of indices) {
        const target = fixtureKey(index);
        expect(findBoundaryUserMessage(FIXTURE_SESSION, target.id)).toEqual(
            oldBoundary(db, target.id),
        );
        for (const nextIndex of [
            index,
            Math.min(messages - 1, index + 1),
            Math.min(messages - 1, index + 16),
        ]) {
            const next = fixtureKey(nextIndex);
            expect(isOpenCodeGapHistorianAbsent(FIXTURE_SESSION, target.id, next.id)).toBe(
                oldGap(db, target.id, next.id),
            );
        }
    }
    expect(findBoundaryUserMessage(FIXTURE_SESSION, "missing")).toBeNull();
    expect(findBoundaryUserMessage(FIXTURE_SESSION, "msg_foreign")).toBeNull();
    expect(isOpenCodeGapHistorianAbsent(FIXTURE_SESSION, "missing", fixtureKey(1).id)).toBe(false);
}

it("matches pre-keyset boundary and gap results across randomized targets and JSON edge cases", () => {
    withFixture(4096, 27_000, (db) => compareTargets(db, 4096, 256));
});

function captureProductionQueries(): [string, string] {
    const prepare = spyOn(Database.prototype, "prepare");
    try {
        findBoundaryUserMessage(FIXTURE_SESSION, fixtureKey(241).id);
        isOpenCodeGapHistorianAbsent(FIXTURE_SESSION, fixtureKey(239).id, fixtureKey(241).id);
        const queries = prepare.mock.calls
            .map(([sql]) => sql)
            .filter((sql) => sql.includes("EXISTS (SELECT 1 FROM part p"));
        expect(queries).toHaveLength(2);
        return [queries[0], queries[1]];
    } finally {
        // Connections opened during spying bind the spy in their prepare shim.
        // Close them before restoring it; later calls must bind the real method.
        closeCompactionMarkerDb();
        prepare.mockRestore();
    }
}

function medianTime(run: () => unknown, iterations = 5): number {
    run();
    const times = Array.from({ length: iterations }, () => {
        const start = performance.now();
        run();
        return performance.now() - start;
    }).sort((a, b) => a - b);
    return Number(times[Math.floor(times.length / 2)].toFixed(3));
}

// Opt in to the million-part throwaway reproduction; ordinary suite runs keep
// the smaller differential and production-query plan guard above/beside it.
it.skipIf(process.env.MC_BOUNDARY_BENCH !== "1")(
    "benchmarks and differentially checks 157000 messages and 1000000 parts",
    () => {
        withFixture(157_000, 1_000_000, (db, path) => {
            const [boundarySql, gapSql] = captureProductionQueries();
            console.log(
                JSON.stringify({
                    bun: Bun.version,
                    sqlite: db.prepare("SELECT sqlite_version() AS version").get(),
                    messages: 157_000,
                    parts: 1_000_000,
                    foreignMessages: 1,
                    foreignParts: 1,
                    bytes: statSync(path).size,
                }),
            );
            for (const statistics of ["absent", "analyzed"]) {
                if (statistics === "analyzed") db.exec("ANALYZE");
                for (const index of [1000, 78_500, 156_999]) {
                    const key = fixtureKey(index);
                    const oldArgs = [FIXTURE_SESSION, key.timeCreated, key.timeCreated, key.id];
                    const newArgs = [FIXTURE_SESSION, key.timeCreated, key.id];
                    const oldQuery = db.prepare(OLD_BOUNDARY_SQL);
                    const newQuery = db.prepare(boundarySql);
                    const afterPlan = explainQuery(db, boundarySql, newArgs);
                    expect(afterPlan.join(" | ")).not.toMatch(/TEMP B-TREE|SCAN /);
                    expect(afterPlan.join(" | ")).toContain("(time_created,id)<(?,?)");
                    expect(afterPlan.join(" | ")).not.toContain("part_session_idx");
                    console.log(
                        JSON.stringify({
                            query: "boundary",
                            statistics,
                            index,
                            beforeMs: medianTime(() => oldQuery.get(...oldArgs)),
                            afterMs: medianTime(() => newQuery.get(...newArgs)),
                            beforePlan: explainQuery(db, OLD_BOUNDARY_SQL, oldArgs),
                            afterPlan,
                        }),
                    );
                    const end = fixtureKey(index - 1);
                    const oldGapArgs = [
                        FIXTURE_SESSION,
                        end.timeCreated,
                        end.timeCreated,
                        end.id,
                        key.timeCreated,
                        key.timeCreated,
                        key.id,
                    ];
                    const gapArgs = [
                        FIXTURE_SESSION,
                        end.timeCreated,
                        end.id,
                        key.timeCreated,
                        key.id,
                    ];
                    console.log(
                        JSON.stringify({
                            query: "gap",
                            statistics,
                            index,
                            beforeMs: medianTime(() => db.prepare(OLD_GAP_SQL).get(...oldGapArgs)),
                            afterMs: medianTime(() => db.prepare(gapSql).get(...gapArgs)),
                            beforePlan: explainQuery(db, OLD_GAP_SQL, oldGapArgs),
                            afterPlan: explainQuery(db, gapSql, gapArgs),
                        }),
                    );
                }
            }
            compareTargets(db, 157_000, 128);
            console.log(
                "Differential: 149 boundary targets and 447 gap pairs matched (seed 0x12345678).",
            );
        });
    },
    180_000,
);
