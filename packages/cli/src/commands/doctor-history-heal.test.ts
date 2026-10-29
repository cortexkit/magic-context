import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildCompactionMarkerRows } from "@magic-context/core/features/magic-context/compaction-marker";
import { getHistoryHealQueue } from "@magic-context/core/features/magic-context/history-heal-queue";
import {
    getOrCreateSessionMeta,
    initializeDatabase,
    runMigrations,
} from "@magic-context/core/features/magic-context/storage";
import {
    getPersistedCompactionMarkerState,
    setPendingCompactionMarkerState,
    setPersistedCompactionMarkerState,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import {
    materializeM0,
    mustMaterialize,
} from "@magic-context/core/hooks/magic-context/inject-compartments";
import { Database } from "@magic-context/core/shared/sqlite";
import {
    applyHealRewrites,
    applyHistoryHealPlan,
    buildHistoryHealPlan,
    type HistoryHealDeps,
    runHistoryHealCli,
} from "./doctor-history-heal";
import {
    canonical,
    digest,
    type HistoryHealPlan,
    inventory,
    selectHealMarker,
} from "./doctor-history-heal-plan";

let root: string, dbPath: string, hostPath: string, db: Database, host: Database;
const id = "ses_heal";
const deps: HistoryHealDeps = {
    inspectHolders: () => ({ safe: true, blockers: [] }),
    probe: () => ({ status: "free" }),
    freeBytes: () => Number.MAX_SAFE_INTEGER,
};
const mid = (n: number) => `msg_${String(n).padStart(3, "0")}`;
function insert(table: string, row: Record<string, unknown>) {
    host.prepare(
        `INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row)
            .map(() => "?")
            .join(",")})`,
    ).run(...Object.values(row));
}
function marker(end = 8, boundary = 7) {
    const built = buildCompactionMarkerRows(
        {
            sessionId: id,
            endOrdinal: end,
            endMessageId: mid(end),
            directory: "/fixture",
            summaryText: "MC placeholder",
        },
        { id: mid(boundary), timeCreated: boundary * 100 },
    );
    insert("part", built.compaction);
    insert("message", built.message);
    insert("part", built.text);
    return { ...built.marker, boundaryOrdinal: end, targetEndMessageId: mid(end) };
}
function range(seq: number, start: number, end: number) {
    db.prepare(
        "INSERT INTO compartments(session_id,sequence,start_message,end_message,start_message_id,end_message_id,title,content,created_at) VALUES (?,?,?,?,?,?,?,?,1)",
    ).run(id, seq, start, end, mid(start), mid(end), `summary ${seq}`, `unchanged prose ${seq}`);
}
function plan(): HistoryHealPlan {
    return buildHistoryHealPlan(db, host, dbPath, hostPath, [id]);
}
function close() {
    db.close();
    host.close();
}
function reopen() {
    db = new Database(dbPath);
    host = new Database(hostPath);
}
function apply(p = plan()) {
    close();
    try {
        return applyHistoryHealPlan(JSON.parse(JSON.stringify(p)), false, deps);
    } finally {
        reopen();
    }
}
function seedIndex() {
    for (let n = 1; n <= 12; n++) {
        const old = n >= 5 && n <= 8 ? n - 1 : n;
        db.prepare(
            "INSERT INTO message_history_source(session_id,message_id,message_ordinal,source_version,normalized_content_hash,role,harness,updated_at) VALUES (?,?,?,'v','h','user','opencode',1)",
        ).run(id, mid(n), old);
        db.prepare(
            "INSERT INTO message_history_fts(rowid,session_id,message_ordinal,message_id,role,content) VALUES (?,?,?,?, 'user','indexed content')",
        ).run(n, id, old, mid(n));
        // Row 5 already has old ordinal 4; inserting row 4 would violate the session-and-ordinal key.
        if (n !== 4)
            db.prepare(
                "INSERT INTO message_fts_rowid_map(session_id,message_ordinal,fts_rowid) VALUES (?,?,?)",
            ).run(id, old, n);
    }
}
beforeEach(() => {
    const scratch = resolve("../../target/scratch");
    mkdirSync(scratch, { recursive: true });
    root = realpathSync(mkdtempSync(join(scratch, "history-heal-test-")));
    dbPath = join(root, "fixture-context.sqlite");
    hostPath = join(root, "fixture-host.sqlite");
    db = new Database(dbPath);
    initializeDatabase(db);
    runMigrations(db);
    host = new Database(hostPath);
    host.exec(
        "CREATE TABLE session(id TEXT PRIMARY KEY,title TEXT); CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT); CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT)",
    );
    host.prepare("INSERT INTO session VALUES (?, 'fixture')").run(id);
    for (let n = 1; n <= 12; n++) {
        insert("message", {
            id: mid(n),
            session_id: id,
            time_created: n * 100,
            time_updated: n * 100,
            data: JSON.stringify({ role: n % 2 ? "user" : "assistant" }),
        });
        insert("part", {
            id: `part${n}`,
            message_id: mid(n),
            session_id: id,
            time_created: n * 100,
            time_updated: n * 100,
            data: JSON.stringify({ type: "text", text: `raw ${n}` }),
        });
    }
    range(0, 1, 4);
    range(1, 5, 8);
    setPersistedCompactionMarkerState(db, id, marker());
});
afterEach(() => {
    close();
    rmSync(root, { recursive: true, force: true });
});

describe("doctor history heal", () => {
    it("repairs drift by IDs across summaries, source, FTS and map without changing prose", () => {
        seedIndex();
        db.exec("UPDATE compartments SET start_message=4,end_message=7 WHERE sequence=1");
        const p = plan();
        expect(p.sessions[0].refusals).toEqual([]);
        apply(p);
        expect(
            db
                .prepare(
                    "SELECT start_message,end_message,content FROM compartments WHERE sequence=1",
                )
                .get(),
        ).toEqual({ start_message: 5, end_message: 8, content: "unchanged prose 1" });
        for (const table of ["message_history_source", "message_history_fts"])
            expect(
                (
                    db
                        .prepare(`SELECT message_ordinal FROM ${table} WHERE message_id=?`)
                        .get(mid(8)) as { message_ordinal: number }
                ).message_ordinal,
            ).toBe(8);
        expect(
            (
                db
                    .prepare("SELECT message_ordinal FROM message_fts_rowid_map WHERE fts_rowid=8")
                    .get() as { message_ordinal: number }
            ).message_ordinal,
        ).toBe(8);
    });
    it("trims overlaps in favour of the earlier summary", () => {
        db.prepare(
            "UPDATE compartments SET start_message=4,start_message_id=? WHERE sequence=1",
        ).run(mid(4));
        apply();
        expect(
            db
                .prepare("SELECT start_message,start_message_id FROM compartments WHERE sequence=1")
                .get(),
        ).toEqual({ start_message: 5, start_message_id: mid(5) });
    });
    it("extends a gap and queues exactly the neighbouring summary for partial recomp", () => {
        db.prepare("UPDATE compartments SET end_message=3,end_message_id=? WHERE sequence=0").run(
            mid(3),
        );
        apply();
        expect(
            db
                .prepare("SELECT end_message,end_message_id FROM compartments WHERE sequence=0")
                .get(),
        ).toEqual({ end_message: 4, end_message_id: mid(4) });
        expect(getHistoryHealQueue(db, id)).toEqual([
            { start: 1, end: 4, sequence: 0, gapStart: 4, gapEnd: 4 },
        ]);
        expect(plan().sessions[0].rewrites).toEqual([]);
    });
    it("snaps older block endpoints and recovers a missing start from the preceding seam", () => {
        db.exec(
            "UPDATE compartments SET end_block_index=2 WHERE sequence=0; UPDATE compartments SET start_message_id='',start_block_index=NULL,end_block_index=NULL WHERE sequence=1",
        );
        // A legacy block index makes the missing start ID recoverable from the preceding end.
        db.exec("UPDATE compartments SET start_block_index=0 WHERE sequence=1");
        apply();
        expect(
            db
                .prepare(
                    "SELECT start_message_id,start_block_index,end_block_index FROM compartments WHERE sequence=1",
                )
                .get(),
        ).toEqual({ start_message_id: mid(5), start_block_index: null, end_block_index: null });
        expect(getHistoryHealQueue(db, id)).toEqual([]);
    });
    it("returns the final partial message to raw history and relocates the marker with the shared writer", () => {
        db.exec("UPDATE compartments SET end_block_index=2 WHERE sequence=1");
        const p = plan();
        expect(p.sessions[0].refusals).toEqual([]);
        apply(p);
        expect(
            (
                db.prepare("SELECT end_message FROM compartments WHERE sequence=1").get() as {
                    end_message: number;
                }
            ).end_message,
        ).toBe(7);
        expect(getPersistedCompactionMarkerState(db, id)?.targetEndMessageId).toBe(mid(7));
        expect(inventory(host, id, true).message.some((m) => m.id === mid(8))).toBe(true);
    });
    it("adopts a unique host-selected MC pair without inventing a historical target", () => {
        setPersistedCompactionMarkerState(db, id, null);
        apply();
        expect(getPersistedCompactionMarkerState(db, id)?.targetEndMessageId).toBe(mid(8));
    });
    it("deletes orphan pairs including step parts but preserves carrier user text and file", () => {
        const old = marker(2, 1);
        insert("part", {
            id: "file",
            message_id: mid(1),
            session_id: id,
            time_created: 100,
            time_updated: 100,
            data: '{"type":"file","url":"fixture"}',
        });
        insert("part", {
            id: "step",
            message_id: old.summaryMessageId,
            session_id: id,
            time_created: 101,
            time_updated: 101,
            data: '{"type":"step-finish"}',
        });
        const before = inventory(host, id, true);
        const winner = selectHealMarker(before.message, before.part)?.carrier.id;
        apply();
        const after = inventory(host, id, true);
        expect(selectHealMarker(after.message, after.part)?.carrier.id).toBe(winner);
        expect(after.message.some((m) => m.id === mid(1))).toBe(true);
        expect(
            after.part
                .filter((p) => p.message_id === mid(1))
                .map((p) => p.id)
                .sort(),
        ).toEqual(["file", "part1"]);
        expect(after.part.some((p) => p.id === "step")).toBe(false);
    });
    it("is idempotent for the original plan as well as a fresh plan", () => {
        marker(2, 1);
        const p = plan();
        apply(p);
        const hashes = [digest(inventory(db, id)), digest(inventory(host, id, true))];
        const backups = readdirSync(root).filter((n) => n.startsWith("history-heal-backup-"));
        apply(p);
        expect(readdirSync(root).filter((n) => n.startsWith("history-heal-backup-"))).toEqual(
            backups,
        );
        expect([digest(inventory(db, id)), digest(inventory(host, id, true))]).toEqual(hashes);
        expect(plan().sessions[0].rewrites).toEqual([]);
    });
    it("plans without changing either database's logical rows", () => {
        marker(2, 1);
        const before = [digest(inventory(db, id)), digest(inventory(host, id, true))];
        plan();
        expect([digest(inventory(db, id)), digest(inventory(host, id, true))]).toEqual(before);
    });
    it("refuses stale data and edited proposals before making a backup", () => {
        marker(2, 1);
        const p = plan();
        db.exec("UPDATE compartments SET content='new prose' WHERE sequence=0");
        expect(() => apply(p)).toThrow("stale_plan");
        expect(readdirSync(root).filter((n) => n.startsWith("history-heal-backup-"))).toEqual([]);
    });
    it("refuses a host-held store, including uncertain probes, before backup", () => {
        marker(2, 1);
        const p = plan();
        close();
        try {
            expect(() =>
                applyHistoryHealPlan(p, false, {
                    ...deps,
                    probe: () => ({ status: "in_use", pids: [123] }),
                }),
            ).toThrow("holders");
            expect(() =>
                applyHistoryHealPlan(p, true, {
                    ...deps,
                    probe: () => ({ status: "unknown", reason: "no lsof" }),
                }),
            ).toThrow("holders");
        } finally {
            reopen();
        }
        expect(readdirSync(root).filter((n) => n.startsWith("history-heal-backup-"))).toEqual([]);
    });
    it("reports pending markers without touching the session", () => {
        setPendingCompactionMarkerState(db, id, {
            ordinal: 8,
            endMessageId: mid(8),
            publishedAt: 1,
        });
        const p = plan().sessions[0];
        expect(p.refusals[0].code).toBe("pending_marker");
        expect(p.rewrites).toEqual([]);
    });
    it("reports kept file drops as a normal-fold prerequisite, never rewrites file content", () => {
        db.prepare(
            "INSERT INTO tags(session_id,message_id,type,status,tag_number) VALUES (?,?,'file','dropped',1)",
        ).run(id, `${mid(10)}:file1`);
        expect(plan().sessions[0].refusals[0]).toEqual({
            code: "kept_file_drop",
            message:
                "needs a normal fold past message 10 before moving (1 dropped files in the kept window)",
        });
        expect(plan().sessions[0].rewrites).toEqual([]);
    });
    it("refuses a native winning marker rather than deleting it", () => {
        const newer = marker(10, 9);
        host.prepare(
            "UPDATE message SET data=json_set(data,'$.providerID','native') WHERE id=?",
        ).run(newer.summaryMessageId);
        expect(plan().sessions[0].refusals[0].code).toBe("foreign_or_missing_marker");
    });
    it("refuses absent endpoints and wholly swallowed summaries", () => {
        db.prepare("UPDATE compartments SET end_message_id='missing' WHERE sequence=1").run();
        expect(plan().sessions[0].refusals[0].code).toBe("missing_endpoint");
        db.prepare(
            "UPDATE compartments SET start_message_id=?,end_message_id=? WHERE sequence=1",
        ).run(mid(2), mid(3));
        expect(plan().sessions[0].refusals[0].code).toBe("swallowed_summary");
    });
    it("preserves missing-host search archive entries and resolves Rust block identities", () => {
        seedIndex();
        db.prepare("UPDATE message_history_source SET message_id=? WHERE message_id=?").run(
            `${mid(8)}#0`,
            mid(8),
        );
        db.prepare("UPDATE message_history_source SET message_id='missing' WHERE message_id=?").run(
            mid(10),
        );
        const p = plan();
        expect(p.sessions[0].unrecoverableArchiveEntries).toBe(1);
        apply(p);
        expect(
            (
                db
                    .prepare(
                        "SELECT message_ordinal FROM message_history_source WHERE message_id=?",
                    )
                    .get(`${mid(8)}#0`) as { message_ordinal: number }
            ).message_ordinal,
        ).toBe(8);
        expect(
            (
                db
                    .prepare(
                        "SELECT message_ordinal FROM message_history_source WHERE message_id='missing'",
                    )
                    .get() as { message_ordinal: number }
            ).message_ordinal,
        ).toBe(10);
    });
    it("--check re-plans without changing rows or taking backups", () => {
        marker(2, 1);
        const p = plan();
        close();
        try {
            expect(applyHistoryHealPlan(p, true, deps)).toBe(0);
        } finally {
            reopen();
        }
        expect(readdirSync(root).filter((n) => n.startsWith("history-heal-backup-"))).toEqual([]);
    });
});

it("keeps vectors via owner ranges and invalidates only drifted unanchored note coordinates", () => {
    seedIndex();
    db.exec("UPDATE compartments SET start_message=4,end_message=7 WHERE sequence=1");
    const owner = (
        db.prepare("SELECT id FROM compartments WHERE sequence=1").get() as { id: number }
    ).id;
    db.prepare(
        "INSERT INTO compartment_chunk_embeddings(compartment_id,session_id,project_path,window_index,start_ordinal,end_ordinal,chunk_hash,model_id,dims,vector,created_at) VALUES (?,?,'fixture',0,4,7,'hash','model',1,?,1)",
    ).run(owner, id, new Uint8Array([1, 2, 3, 4]));
    for (const [content, n, anchor] of [
        ["affected", 6, null],
        ["safe", 2, null],
        ["anchored", 6, `${mid(7)}#0`],
    ] as const)
        db.prepare(
            "INSERT INTO notes(content,session_id,created_at,updated_at,anchor_ordinal,anchor_block_id) VALUES (?,?,1,1,?,?)",
        ).run(content, id, n, anchor);
    apply();
    expect(
        db
            .prepare(
                "SELECT start_ordinal,end_ordinal,hex(vector) AS vector FROM compartment_chunk_embeddings",
            )
            .get(),
    ).toEqual({ start_ordinal: 5, end_ordinal: 8, vector: "01020304" });
    expect(db.prepare("SELECT content,anchor_ordinal FROM notes ORDER BY id").all()).toEqual([
        { content: "affected", anchor_ordinal: null },
        { content: "safe", anchor_ordinal: 2 },
        { content: "anchored", anchor_ordinal: 7 },
    ]);
});

it("adopts the verified frontier even when a normal fold is needed to create a move cut", () => {
    host.exec(
        "DELETE FROM part WHERE id NOT LIKE 'part%'; DELETE FROM message WHERE id NOT LIKE 'msg_%' OR json_extract(data,'$.summary')=1; UPDATE message SET data='{\"role\":\"assistant\"}' WHERE id<>'msg_001'",
    );
    const m = marker(8, 1);
    setPersistedCompactionMarkerState(db, id, null);
    const p = plan();
    expect(p.sessions[0].refusals[0].code).toBe("no_clean_cut");
    apply(p);
    expect(getPersistedCompactionMarkerState(db, id)?.summaryMessageId).toBe(m.summaryMessageId);
});

it("uses the loader's reverse walk, truthy finish and error filter, including native markers", () => {
    const messages = [
        { id: "u1", time_created: 1, data: '{"role":"user"}' },
        {
            id: "a1",
            time_created: 2,
            data: '{"role":"assistant","parentID":"u1","summary":true,"finish":"length"}',
        },
        { id: "u2", time_created: 3, data: '{"role":"user"}' },
        {
            id: "a2",
            time_created: 4,
            data: '{"role":"assistant","parentID":"u2","summary":true,"finish":"stop","error":{"message":"failed"}}',
        },
    ];
    const parts = [
        { message_id: "u1", data: '{"type":"compaction"}' },
        { message_id: "u2", data: '{"type":"compaction"}' },
    ];
    expect(selectHealMarker(messages, parts)?.carrier.id).toBe("u1");
    messages[3].data =
        '{"role":"assistant","parentID":"u2","summary":1,"finish":"stop","providerID":"native"}';
    expect(selectHealMarker(messages, parts)?.carrier.id).toBe("u2");
});

it("records structural healing as an m0 mutation and renders corrected ranges on the first pass", () => {
    db.exec("UPDATE compartments SET start_message=4,end_message=7 WHERE sequence=1");
    const opts = () => ({
        db,
        sessionId: id,
        state: getOrCreateSessionMeta(db, id),
        projectDirectory: root,
    });
    materializeM0(opts());
    const before = getOrCreateSessionMeta(db, id).cachedM0Bytes;
    expect(before).not.toBeNull();
    apply();
    expect(Buffer.from(getOrCreateSessionMeta(db, id).cachedM0Bytes!)).toEqual(
        Buffer.from(before!),
    );
    expect(mustMaterialize(opts()).reason).toBe("max_mutation_id");
    materializeM0(opts());
    const after = getOrCreateSessionMeta(db, id).cachedM0Bytes;
    expect(Buffer.from(after!).equals(Buffer.from(before!))).toBe(false);
    expect(mustMaterialize(opts()).value).toBe(false);
});

it("orphan-only cleanup leaves the frozen m0/m1 prefix byte-identical and requests no rebuild", () => {
    marker(2, 1);
    const opts = () => ({
        db,
        sessionId: id,
        state: getOrCreateSessionMeta(db, id),
        projectDirectory: root,
    });
    materializeM0(opts());
    const before = getOrCreateSessionMeta(db, id);
    apply();
    const after = getOrCreateSessionMeta(db, id);
    expect(Buffer.from(after.cachedM0Bytes!)).toEqual(Buffer.from(before.cachedM0Bytes!));
    expect(Buffer.from(after.cachedM1Bytes!)).toEqual(Buffer.from(before.cachedM1Bytes!));
    expect(mustMaterialize(opts()).value).toBe(false);
});

it("fills Rust synthetic-only gaps without queueing model work", () => {
    db.prepare(
        "UPDATE compartments SET end_message=3,end_message_id=?,end_block_index=1 WHERE sequence=0",
    ).run(mid(3));
    host.prepare("UPDATE part SET data=? WHERE message_id=?").run(
        '{"type":"text","text":"background notice","synthetic":true}',
        mid(4),
    );
    const p = plan();
    expect(p.sessions[0].refusals).toEqual([]);
    expect(p.sessions[0].metaAfter.queue).toEqual([]);
    apply(p);
    expect(
        (
            db.prepare("SELECT end_message FROM compartments WHERE sequence=0").get() as {
                end_message: number;
            }
        ).end_message,
    ).toBe(4);
});

it("refuses two safe pairs and inconsistent tracked coverage by name", () => {
    const current = getPersistedCompactionMarkerState(db, id)!;
    host.prepare("UPDATE message SET data=json_set(data,'$.parentID',?) WHERE id=?").run(
        mid(5),
        current.summaryMessageId,
    );
    host.prepare("UPDATE part SET message_id=? WHERE id=?").run(mid(5), current.compactionPartId);
    expect(plan().sessions[0].refusals[0].code).toBe("marker_coverage");
    host.prepare("UPDATE message SET data=json_set(data,'$.parentID',?) WHERE id=?").run(
        mid(7),
        current.summaryMessageId,
    );
    host.prepare("UPDATE part SET message_id=? WHERE id=?").run(mid(7), current.compactionPartId);
    const original = host
        .prepare("SELECT * FROM message WHERE id=?")
        .get(current.summaryMessageId) as Record<string, unknown>;
    insert("message", {
        ...original,
        id: "duplicate-summary",
        time_created: 702,
        time_updated: 702,
    });
    insert("part", {
        id: "duplicate-text",
        message_id: "duplicate-summary",
        session_id: id,
        time_created: 702,
        time_updated: 702,
        data: '{"type":"text","text":"placeholder"}',
    });
    setPersistedCompactionMarkerState(db, id, null);
    expect(plan().sessions[0].refusals[0].code).toBe("ambiguous_marker");
});

it("rejects schemas below the current CLI fence before planning or writing", () => {
    db.exec("DELETE FROM schema_migrations WHERE version>95");
    close();
    try {
        expect(() => runHistoryHealCli(["plan", "--db", dbPath, "--host-db", hostPath])).toThrow(
            "schema floor",
        );
    } finally {
        reopen();
    }
});

it("resumes a host-only commit using the planned store fingerprints", () => {
    marker(2, 1);
    db.exec("UPDATE compartments SET start_message=4,end_message=7 WHERE sequence=1");
    const p = plan();
    host.transaction(() =>
        applyHealRewrites(
            host,
            p.sessions[0].rewrites.filter((r) => r.store === "host"),
        ),
    )();
    apply(p);
    expect(
        db.prepare("SELECT start_message,end_message FROM compartments WHERE sequence=1").get(),
    ).toEqual({ start_message: 5, end_message: 8 });
    expect(plan().sessions[0].rewrites).toEqual([]);
});

it("does not delete a compaction part shared with a foreign summary", () => {
    const old = marker(2, 1);
    const sibling = {
        id: "foreign-sibling",
        session_id: id,
        time_created: 102,
        time_updated: 102,
        data: JSON.stringify({
            role: "assistant",
            summary: true,
            finish: "stop",
            parentID: mid(1),
            providerID: "native",
        }),
    };
    insert("message", sibling);
    expect(plan().sessions[0].refusals[0].code).toBe("shared_foreign_marker");
    expect(host.prepare("SELECT id FROM part WHERE id=?").get(old.compactionPartId)).toBeDefined();
});

it("updates an owned embedding window when only a final block endpoint changes", () => {
    const owner = (
        db.prepare("SELECT id FROM compartments WHERE sequence=1").get() as { id: number }
    ).id;
    db.prepare(
        "INSERT INTO compartment_chunk_embeddings(compartment_id,session_id,project_path,window_index,start_ordinal,end_ordinal,chunk_hash,model_id,dims,vector,created_at) VALUES (?,?,'fixture',0,5,8,'hash','model',1,?,1)",
    ).run(owner, id, new Uint8Array([1, 2, 3, 4]));
    db.exec("UPDATE compartments SET end_block_index=2 WHERE sequence=1");
    apply();
    expect(
        db
            .prepare(
                "SELECT start_ordinal,end_ordinal,hex(vector) AS vector FROM compartment_chunk_embeddings",
            )
            .get(),
    ).toEqual({ start_ordinal: 5, end_ordinal: 7, vector: "01020304" });
});

it("reconciles JSON and indexed marker targets through the storage accessor", () => {
    db.prepare(
        "UPDATE session_meta SET compaction_marker_state=json_set(compaction_marker_state,'$.targetEndMessageId',?) WHERE session_id=?",
    ).run(mid(6), id);
    const p = plan();
    expect(p.sessions[0].metaBefore.markerTargets).toEqual({
        jsonTarget: mid(6),
        columnTarget: mid(8),
    });
    apply(p);
    expect(plan().sessions[0].metaBefore.markerTargets).toEqual({
        jsonTarget: mid(8),
        columnTarget: mid(8),
    });
});

it("refuses tail-aware or incomplete marker pairs rather than guessing loader semantics", () => {
    const m = getPersistedCompactionMarkerState(db, id)!;
    host.prepare("UPDATE part SET data=json_set(data,'$.tail_start_id','tail') WHERE id=?").run(
        m.compactionPartId,
    );
    expect(plan().sessions[0].refusals[0].code).toBe("unsupported_marker");
    host.prepare("UPDATE part SET data=json_remove(data,'$.tail_start_id') WHERE id=?").run(
        m.compactionPartId,
    );
    host.prepare("DELETE FROM part WHERE id=?").run(m.summaryPartId);
    expect(plan().sessions[0].refusals[0].code).toBe("ambiguous_marker");
});

it("keeps duplicate archive documents when recounted map keys collide", () => {
    seedIndex();
    db.prepare(
        "INSERT INTO message_history_fts(rowid,session_id,message_ordinal,message_id,role,content) VALUES (20,?,8,?,'user','different archived version')",
    ).run(id, mid(8));
    db.prepare(
        "INSERT INTO message_fts_rowid_map(session_id,message_ordinal,fts_rowid) VALUES (?,8,20)",
    ).run(id);
    apply();
    expect(
        db
            .prepare(
                "SELECT message_ordinal,content FROM message_history_fts WHERE message_id=? ORDER BY rowid",
            )
            .all(mid(8)),
    ).toEqual([
        { message_ordinal: 8, content: "indexed content" },
        { message_ordinal: 8, content: "different archived version" },
    ]);
    expect(
        db.prepare("SELECT fts_rowid FROM message_fts_rowid_map WHERE message_ordinal=8").get(),
    ).toEqual({ fts_rowid: 20 });
    expect(
        db.prepare("SELECT fts_rowid FROM message_fts_rowid_map WHERE fts_rowid=8").get(),
    ).toBeFalsy();
    expect(plan().sessions[0].rewrites).toEqual([]);
});

it("reuses the census loader fixtures for newest, incomplete, errored and non-stop markers", () => {
    const row = (id: string, time_created: number, info: Record<string, unknown>) => ({
        id,
        time_created,
        data: JSON.stringify(info),
    });
    const user = (id: string, t: number) => row(id, t, { role: "user" });
    const summary = (id: string, parentID: string, t: number) =>
        row(id, t, { role: "assistant", parentID, summary: true, finish: "stop" });
    const messages = [
        user("old", 1),
        summary("old-summary", "old", 2),
        user("current", 3),
        summary("current-summary", "current", 4),
        user("tail", 5),
    ];
    const parts = (ids: string[]) =>
        ids.map((message_id) => ({ message_id, data: '{"type":"compaction"}' }));
    const winner = (ms = messages, ids = ["old", "current"]) =>
        selectHealMarker(ms, parts(ids))?.carrier.id;
    expect(winner()).toBe("current");
    expect(winner()).not.toBe("old");
    expect(winner(messages, ["old"])).toBe("old");
    for (const finish of [null, "end_turn"]) {
        const variant = [...messages];
        variant[3] = row("current-summary", 4, {
            role: "assistant",
            summary: true,
            parentID: "current",
            finish,
        });
        expect(winner(variant)).toBe(finish ? "current" : "old");
    }
    const errored = [...messages];
    errored[3] = row("current-summary", 4, {
        role: "assistant",
        summary: true,
        parentID: "current",
        finish: "stop",
        error: { message: "fixture failure" },
    });
    expect(winner(errored)).toBe("old");
    expect(winner(messages, [])).toBeUndefined();
    expect(winner([user("old", 1)], ["old"])).toBeUndefined();
    setPersistedCompactionMarkerState(db, id, null);
    expect(getPersistedCompactionMarkerState(db, id)).toBeNull();
});

it("refuses an unresolved anchored note rather than clearing its identity", () => {
    seedIndex();
    db.prepare(
        "INSERT INTO notes(content,session_id,created_at,updated_at,anchor_ordinal,anchor_block_id) VALUES ('anchored',?,1,1,6,'missing-message#0')",
    ).run(id);
    const p = plan().sessions[0];
    expect(p.refusals[0].code).toBe("note_anchor_missing");
    expect(p.rewrites).toEqual([]);
});

it("refuses an embedding window whose owner corrections would invert its range", () => {
    db.exec("UPDATE compartments SET start_message=4 WHERE sequence=1");
    const owner = (
        db.prepare("SELECT id FROM compartments WHERE sequence=1").get() as { id: number }
    ).id;
    db.prepare(
        "INSERT INTO compartment_chunk_embeddings(compartment_id,session_id,project_path,window_index,start_ordinal,end_ordinal,chunk_hash,model_id,dims,vector,created_at) VALUES (?,?,'fixture',0,5,5,'hash','model',1,?,1)",
    ).run(owner, id, new Uint8Array([1, 2, 3, 4]));
    const p = plan().sessions[0];
    expect(p.refusals[0].code).toBe("embedding_window_unresolvable");
    expect(p.rewrites).toEqual([]);
});

it("refuses mode-3 handoffs during planning and when they appear after a plan", () => {
    db.exec("UPDATE compartments SET start_message=4,end_message=7 WHERE sequence=1");
    const p = plan();
    db.prepare("INSERT INTO schema_migrations_meta(key,value) VALUES (?, '{}')").run(
        `mode3_move:opencode:${id}`,
    );
    expect(plan().sessions[0].refusals[0].code).toBe("already_moved");
    expect(() => apply(p)).toThrow("already_moved");
    expect(readdirSync(root).filter((n) => n.startsWith("history-heal-backup-"))).toEqual([]);
    expect(
        db.prepare("SELECT start_message,end_message FROM compartments WHERE sequence=1").get(),
    ).toEqual({ start_message: 4, end_message: 7 });
});

describe("independent history heal review witnesses", () => {
    it("does not execute an edited cross-session DELETE when resuming a host-only commit", () => {
        marker(2, 1);
        db.exec("UPDATE compartments SET start_message=4,end_message=7 WHERE sequence=1");
        db.prepare(
            "INSERT INTO notes(content,session_id,created_at,updated_at) VALUES ('irreplaceable note','other-session',1,1)",
        ).run();
        const victim = db.prepare("SELECT * FROM notes WHERE session_id='other-session'").get() as {
            id: number;
        };
        const p = plan();
        host.transaction(() =>
            applyHealRewrites(
                host,
                p.sessions[0].rewrites.filter((r) => r.store === "host"),
            ),
        )();
        p.sessions[0].rewrites.push({
            store: "context",
            table: "notes",
            key: { id: victim.id },
            before: victim,
            after: null,
            reason: "edited resume proposal",
        });
        try {
            apply(p);
        } catch {
            // Rejecting the edited manifest before any write is also a safe outcome.
        }
        expect(db.prepare("SELECT content FROM notes WHERE id=?").get(victim.id)).toEqual({
            content: "irreplaceable note",
        });
    });

    it("backs up the original store identity before writable-open initialization", () => {
        marker(2, 1);
        db.exec("DELETE FROM context_store_meta WHERE key='store_uuid'");
        const before = db.prepare("SELECT * FROM context_store_meta ORDER BY key").all();
        apply();
        const backup = readdirSync(root).find((n) => n.startsWith("history-heal-backup-"))!;
        const saved = new Database(join(root, backup, "context.db"), { readonly: true });
        try {
            expect(saved.prepare("SELECT * FROM context_store_meta ORDER BY key").all()).toEqual(
                before,
            );
        } finally {
            saved.close();
        }
    });

    it("refuses unresolved rebases before proposing structural writes", () => {
        db.exec(
            "UPDATE compartments SET start_message=4,end_message=7,rebase_status='unresolved' WHERE sequence=1",
        );
        const p = plan().sessions[0];
        expect(p.refusals.map((r) => r.code)).toContain("unresolved_rebase");
        expect(p.rewrites).toEqual([]);
    });

    it("reopens paired WAL backups at the exact pre-apply logical table state", () => {
        const snapshot = (store: Database) => {
            const tables = store
                .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
                .all() as { name: string }[];
            return Object.fromEntries(
                tables.map(({ name }) => [
                    name,
                    store
                        .prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
                        .all()
                        .map(canonical)
                        .sort(),
                ]),
            );
        };
        db.exec("PRAGMA journal_mode=WAL");
        host.exec("PRAGMA journal_mode=WAL");
        db.prepare(
            "INSERT OR IGNORE INTO context_store_meta VALUES ('store_uuid','review-fixture')",
        ).run();
        marker(2, 1);
        seedIndex();
        db.exec("UPDATE compartments SET start_message=4,end_message=7 WHERE sequence=1");
        const before = [snapshot(db), snapshot(host)];
        expect(applyHistoryHealPlan(plan(), false, deps)).toBe(0);
        const backup = readdirSync(root).find((n) => n.startsWith("history-heal-backup-"))!;
        const saved = ["context.db", "opencode.db"].map(
            (name) => new Database(join(root, backup, name), { readonly: true }),
        );
        try {
            expect(saved.map(snapshot)).toEqual(before);
            for (const store of saved)
                expect(store.prepare("PRAGMA integrity_check").get()).toEqual({
                    integrity_check: "ok",
                });
        } finally {
            for (const store of saved) store.close();
        }
    });
});
