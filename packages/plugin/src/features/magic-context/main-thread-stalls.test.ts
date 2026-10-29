import { afterEach, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    resolveBoundaryContext,
    resolveProtectedTailBoundary,
} from "../../hooks/magic-context/protected-tail-boundary";
import { withRawMessageProvider } from "../../hooks/magic-context/read-session-chunk";
import { Database } from "../../shared/sqlite";
import {
    createStallContext,
    createStallHost,
    OLD_LEGACY_MARKER_SQL,
    OLD_PI_OWNER_SQL,
    STALL_SESSION,
    stallMessageId,
} from "./__tests__/stall.fixture";
import {
    closeCompactionMarkerDb,
    getOpenCodeDbPath,
    getPreparedCompactionMarkerSummaryIds,
    injectCompactionMarker,
    LEGACY_MARKER_LINEAGE_SQL,
    prepareCompactionMarkerCandidates,
} from "./compaction-marker";
import { findPiFallbackToolOwnerTags, getAllStatusTagTokenTotalsFlat } from "./storage-tags";

const dirs: string[] = [];
const originalHome = process.env.XDG_DATA_HOME;
function fixtureDir() {
    const path = join(tmpdir(), "magic-context", `five-stalls-test-${crypto.randomUUID()}`);
    mkdirSync(path, { recursive: true });
    dirs.push(path);
    return path;
}
afterEach(() => {
    closeCompactionMarkerDb();
    process.env.XDG_DATA_HOME = originalHome;
    for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

it("legacy marker cleanup preserves the old deletion set with primary-key candidate probes", async () => {
    const dir = fixtureDir();
    process.env.XDG_DATA_HOME = dir;
    const db = createStallHost(join(dir, "opencode", "opencode.db"), 4096, 12800);
    try {
        db.prepare("UPDATE message SET data='{}' WHERE json_valid(data)=0").run();
        const boundary = stallMessageId(4080);
        for (const [id, time, parent, text, finish] of [
            ["legacy-at", 4080, boundary, "summary", "stop"],
            ["legacy-after", 4081, boundary, "summary", "stop"],
            ["foreign-text", 4082, boundary, "other", "stop"],
            ["foreign-parent", 4082, stallMessageId(4000), "summary", "stop"],
            ["unfinished", 4083, boundary, "summary", "length"],
            ["older-lineage", 4001, stallMessageId(4000), "summary", "stop"],
        ] as const) {
            db.prepare("INSERT INTO message VALUES (?,?,?, ?,?)").run(
                id,
                STALL_SESSION,
                time,
                time,
                JSON.stringify({ role: "assistant", summary: true, finish, parentID: parent }),
            );
            db.prepare("INSERT INTO part VALUES (?,?,?, ?,?,?)").run(
                `${id}-part`,
                id,
                STALL_SESSION,
                time,
                time,
                JSON.stringify({ type: "text", text }),
            );
        }
        const oldIds = db
            .prepare(OLD_LEGACY_MARKER_SQL)
            .all(STALL_SESSION, "canonical", boundary, "summary") as { id: string }[];
        expect(oldIds.map((r) => r.id).sort()).toEqual(["legacy-after", "legacy-at"]);
        expect(await prepareCompactionMarkerCandidates(STALL_SESSION)).toBe(true);
        const candidates = getPreparedCompactionMarkerSummaryIds(STALL_SESSION)!;
        for (const row of oldIds) expect(candidates).toContain(row.id);
        expect(getOpenCodeDbPath()).toBe(join(dir, "opencode", "opencode.db"));
        expect(db.inTransaction).toBe(false);
        expect(
            (
                db
                    .prepare(LEGACY_MARKER_LINEAGE_SQL)
                    .all(
                        STALL_SESSION,
                        JSON.stringify(candidates),
                        "canonical",
                        boundary,
                        "summary",
                    ) as { id: string }[]
            )
                .map((row) => row.id)
                .sort(),
        ).toEqual(oldIds.map((row) => row.id).sort());
        const planStatement = db.prepare(`EXPLAIN QUERY PLAN ${LEGACY_MARKER_LINEAGE_SQL}`);
        const plan = planStatement.all(
            STALL_SESSION,
            JSON.stringify(candidates),
            "canonical",
            boundary,
            "summary",
        ) as { detail: string }[];
        // Bun's EXPLAIN cursor over json_each retains a read snapshot until it
        // is finalized; release it before observing the marker writer's commit.
        (planStatement as unknown as { finalize(): void }).finalize();
        expect(plan.some((r) => r.detail.includes("sqlite_autoindex_message_1 (id=?)"))).toBe(true);
        expect(plan.some((r) => r.detail.includes("part_message_id_id_idx"))).toBe(true);
        const result = injectCompactionMarker({
            sessionId: STALL_SESSION,
            endMessageId: boundary,
            endOrdinal: 4081,
            summaryText: "summary",
            directory: dir,
            resolvedBoundary: { id: boundary, timeCreated: 4080 },
        });
        expect(result).not.toBeNull();
        const peer = new Database(join(dir, "opencode", "opencode.db"));
        try {
            for (const row of oldIds)
                expect(peer.prepare("SELECT id FROM message WHERE id=?").get(row.id)).toBeNull();
        } finally {
            peer.close();
        }
        for (const row of oldIds) {
            expect(db.prepare("SELECT id FROM message WHERE id=?").get(row.id)).toBeNull();
            expect(db.prepare("SELECT id FROM part WHERE message_id=?").get(row.id)).toBeNull();
        }
        for (const id of [
            boundary,
            "foreign-text",
            "foreign-parent",
            "unfinished",
            "older-lineage",
        ])
            expect(db.prepare("SELECT id FROM message WHERE id=?").get(id)).not.toBeNull();
    } finally {
        db.close();
    }
});

it("token totals load only requested owners without changing all-status calibrated sums", async () => {
    const dir = fixtureDir();
    const db = createStallContext(join(dir, "context.db"), 4096);
    try {
        const calibration = { proseRatio: 1.37, toolsRatio: 0.83 };
        const full = getAllStatusTagTokenTotalsFlat(db, STALL_SESSION, 0, calibration);
        const fullDefault = getAllStatusTagTokenTotalsFlat(db, STALL_SESSION);
        const owners = Array.from({ length: 12 }, (_, i) => stallMessageId(4084 + i));
        let readRows = 0;
        const plans: string[] = [];
        const prepare = db.prepare.bind(db);
        db.prepare = ((sql: string) => {
            const statement = prepare(sql);
            return new Proxy(statement, {
                get(target, prop) {
                    const value = Reflect.get(target, prop);
                    if (prop === "all")
                        return (...args: unknown[]) => {
                            if (sql.includes("FROM tags WHERE id IN")) {
                                plans.push(
                                    ...(
                                        prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as {
                                            detail: string;
                                        }[]
                                    ).map((row) => row.detail),
                                );
                            }
                            const rows = Reflect.apply(value, target, args);
                            if (!sql.startsWith("EXPLAIN") && !sql.includes("pragma_index_xinfo"))
                                readRows += rows.length;
                            return rows;
                        };
                    return typeof value === "function" ? value.bind(target) : value;
                },
            });
        }) as typeof db.prepare;
        const scoped = getAllStatusTagTokenTotalsFlat(db, STALL_SESSION, 0, calibration, owners);
        expect(readRows).toBe(36);
        expect(plans.some((plan) => plan.includes("message_id>? AND message_id<?"))).toBe(true);
        expect(plans.some((plan) => plan.includes("tool_owner_message_id=?"))).toBe(true);
        for (const id of owners) {
            expect(scoped.totals.get(id)).toBe(full.totals.get(id));
            expect(scoped.nullMessageIds.has(id)).toBe(full.nullMessageIds.has(id));
        }
        expect(scoped.totals.size + scoped.nullMessageIds.size).toBe(owners.length);
        readRows = 0;
        const messages = owners.map((id, i) => ({
            id,
            ordinal: 4085 + i,
            role: "user",
            parts: [{ type: "text", text: `message ${i}` }],
        }));
        await withRawMessageProvider(STALL_SESSION, { readMessages: () => messages }, async () => {
            const ctx = resolveBoundaryContext({
                db,
                sessionId: STALL_SESSION,
                mode: "trigger",
                contextLimit: 128000,
                executeThresholdPercentage: 80,
                protectedTailMeta: { priorBoundaryOrdinal: 4085, protectedTailPolicyVersion: 3 },
            });
            const actual = resolveProtectedTailBoundary({ ...ctx, createdAt: 1234 });
            expect(ctx.storedTokenTotalsForMessages).toBeDefined();
            expect(readRows).toBeLessThan(100);
            expect(actual).toEqual(
                resolveProtectedTailBoundary({
                    ...ctx,
                    createdAt: 1234,
                    storedTokenTotalsForMessages: undefined,
                    storedTokenTotals: fullDefault.totals,
                }),
            );
        });
    } finally {
        db.close();
    }
});

it("Pi fallback owner lookup retains ASCII LIKE matches with indexed prefix seeks", () => {
    const dir = fixtureDir();
    const db = createStallContext(join(dir, "context.db"), 4096);
    try {
        const old = db.prepare(OLD_PI_OWNER_SQL).all(STALL_SESSION);
        const prepare = db.prepare.bind(db);
        const plans: string[] = [];
        db.prepare = ((sql: string) => {
            const stmt = prepare(sql);
            if (sql.includes("AS toolOwnerMessageId"))
                return new Proxy(stmt, {
                    get(target, prop) {
                        const value = Reflect.get(target, prop);
                        if (prop === "all")
                            return (...args: unknown[]) => {
                                plans.push(
                                    ...(
                                        prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as {
                                            detail: string;
                                        }[]
                                    ).map((r) => r.detail),
                                );
                                return Reflect.apply(value, target, args);
                            };
                        return typeof value === "function" ? value.bind(target) : value;
                    },
                });
            return stmt;
        }) as typeof db.prepare;
        expect(findPiFallbackToolOwnerTags(db, STALL_SESSION)).toEqual(old);
        expect(
            plans.some((p) => p.includes("tool_owner_message_id>? AND tool_owner_message_id<?")),
        ).toBe(true);
    } finally {
        db.close();
    }
});
