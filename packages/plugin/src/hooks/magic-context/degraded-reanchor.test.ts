/// <reference types="bun-types" />
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";

/**
 * Tests for the two-layer recovery of degraded compartment injection
 * (#263 fork-orphaned compaction markers, #264 degraded-mode re-anchor).
 *
 * Layer A (root cause): OpenCode `/fork` copies the parent's message rows —
 * including magic-context's compaction-marker rows — into the fork, but does
 * NOT inherit magic-context's durable marker state. The fork injects its own
 * marker behind the orphan; `filterCompacted` (which honours the NEWEST
 * marker) stops at the orphan, our boundary falls below the cut, and
 * inject-compartments degrades. `reconcileForkOrphanedCompactionMarkers`
 * removes the foreign marker so the window stops at ours again.
 *
 * Layer B (resilience): when the boundary stays invisible for
 * REANCHOR_MIN_DEGRADED_PASSES consecutive rebuilds, prepareCompartmentInjection
 * re-anchors the splice to the newest durable compartment boundary that IS
 * visible (or requests a fresh materialization when none is), instead of
 * looping. The re-anchor only applies on cache-busting passes so defer passes
 * stay byte-identical.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSessionCompactionMarkers } from "../../features/magic-context/compaction-marker";
import { replaceAllCompartmentState } from "../../features/magic-context/compartment-storage";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    type PersistedCompactionMarkerState,
    setPersistedCompactionMarkerState,
} from "../../features/magic-context/storage-meta-persisted";
import { _resetHarnessForTesting, setHarness } from "../../shared/harness";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    closeCompactionMarkerConnection,
    reconcileForkOrphanedCompactionMarkers,
} from "./compaction-marker-manager";
import { clearInjectionCache, prepareCompartmentInjection } from "./inject-compartments";
import type { MessageLike } from "./tag-messages";

const SESSION_ID = "ses_degraded_reanchor";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;

let db: Database;
let opencodeDb: Database;

function useTempDataHome(prefix: string): string {
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    process.env.XDG_CACHE_HOME = dir;
    mkdirSync(join(dir, "opencode"), { recursive: true });
    return dir;
}

function createOpenCodeDb(dataHome: string): Database {
    const dbPath = join(dataHome, "opencode", "opencode.db");
    const ocDb = new Database(dbPath);
    ocDb.exec("PRAGMA journal_mode=WAL");
    ocDb.exec(
        "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
    );
    ocDb.exec(
        "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
    );
    ocDb.exec("CREATE INDEX part_session_idx ON part(session_id)");
    ocDb.exec("CREATE INDEX part_message_id_id_idx ON part(message_id, id)");
    return ocDb;
}

function insertOcMessage(
    ocDb: Database,
    id: string,
    sessionId: string,
    timeCreated: number,
    data: Record<string, unknown>,
): void {
    ocDb.prepare(
        "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    ).run(id, sessionId, timeCreated, timeCreated, JSON.stringify(data));
}

function insertOcPart(
    ocDb: Database,
    id: string,
    messageId: string,
    sessionId: string,
    timeCreated: number,
    data: Record<string, unknown>,
): void {
    ocDb.prepare(
        "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, messageId, sessionId, timeCreated, timeCreated, JSON.stringify(data));
}

/** Inject a full magic-context marker row-set (compaction part + summary + text). */
function insertMagicContextMarker(
    ocDb: Database,
    sessionId: string,
    opts: {
        boundaryId: string;
        summaryId: string;
        partId: string;
        summaryPartId: string;
        time: number;
    },
): void {
    insertOcMessage(ocDb, opts.boundaryId, sessionId, opts.time, { role: "user" });
    insertOcPart(ocDb, opts.partId, opts.boundaryId, sessionId, opts.time, {
        type: "compaction",
        auto: true,
    });
    insertOcMessage(ocDb, opts.summaryId, sessionId, opts.time + 1, {
        role: "assistant",
        parentID: opts.boundaryId,
        summary: true,
        finish: "stop",
        providerID: "magic-context",
        modelID: "magic-context",
    });
    insertOcPart(ocDb, opts.summaryPartId, opts.summaryId, sessionId, opts.time + 1, {
        type: "text",
        text: "[Compacted by magic-context]",
    });
}

function userMessage(id: string, text: string): MessageLike {
    return {
        info: { id, role: "user", sessionID: SESSION_ID },
        parts: [{ type: "text", text }],
    };
}

function makeContextDb(): Database {
    const d = new Database(":memory:");
    initializeDatabase(d);
    getOrCreateSessionMeta(d, SESSION_ID);
    return d;
}

function legacyListActionableMarkers(
    ocDb: Database,
    sessionId: string,
): Array<{ compactionPartId: string; boundaryMessageId: string; summaryMessageIds: string[] }> {
    const parts = ocDb
        .prepare(
            `SELECT id, message_id FROM part
             WHERE session_id = ?
               AND COALESCE(json_extract(data, '$.type'), '') = 'compaction'`,
        )
        .all(sessionId) as Array<{ id: string; message_id: string }>;
    const summaries = ocDb.prepare(
        `SELECT id FROM message
         WHERE session_id = ?
           AND COALESCE(json_extract(data, '$.parentID'), '') = ?
           AND COALESCE(json_extract(data, '$.summary'), 0) = 1
           AND COALESCE(json_extract(data, '$.finish'), '') = 'stop'
           AND COALESCE(json_extract(data, '$.providerID'), '') = 'magic-context'`,
    );
    return parts.flatMap((part) => {
        const summaryMessageIds = (
            summaries.all(sessionId, part.message_id) as Array<{ id: string }>
        ).map((row) => row.id);
        return summaryMessageIds.length > 0
            ? [
                  {
                      compactionPartId: part.id,
                      boundaryMessageId: part.message_id,
                      summaryMessageIds,
                  },
              ]
            : [];
    });
}

function normalizedMarkerSet(
    markers: Array<{
        compactionPartId: string;
        boundaryMessageId: string;
        summaryMessageIds: string[];
    }>,
): string[] {
    return markers
        .map(
            (marker) =>
                `${marker.compactionPartId}:${marker.boundaryMessageId}:${[...marker.summaryMessageIds].sort().join(",")}`,
        )
        .sort();
}

beforeEach(() => {
    const dataHome = useTempDataHome("mc-degraded-reanchor-");
    opencodeDb = createOpenCodeDb(dataHome);
    db = makeContextDb();
    setHarness("opencode");
});

afterEach(() => {
    clearInjectionCache(SESSION_ID);
    closeCompactionMarkerConnection();
    closeQuietly(opencodeDb);
    closeQuietly(db);
    _resetHarnessForTesting();
    for (const dir of tempDirs.splice(0)) {
        try {
            rmSync(dir, { recursive: true, force: true });
        } catch {
            // ignore
        }
    }
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
});

describe("Layer A — fork-orphan marker hygiene (#263)", () => {
    it("removes a fork-orphaned marker that outranks ours, keeping our marker", () => {
        // Our marker at an older boundary (time 1000); orphan copied from the
        // parent at a newer boundary (time 2000). filterCompacted honours the
        // newest marker, so the orphan outranks ours.
        insertMagicContextMarker(opencodeDb, SESSION_ID, {
            boundaryId: "msg_ours_boundary",
            summaryId: "msg_ours_summary",
            partId: "prt_ours_compaction",
            summaryPartId: "prt_ours_summary_part",
            time: 1000,
        });
        insertMagicContextMarker(opencodeDb, SESSION_ID, {
            boundaryId: "msg_orphan_boundary",
            summaryId: "msg_orphan_summary",
            partId: "prt_orphan_compaction",
            summaryPartId: "prt_orphan_summary_part",
            time: 2000,
        });

        const owned: PersistedCompactionMarkerState = {
            boundaryMessageId: "msg_ours_boundary",
            summaryMessageId: "msg_ours_summary",
            compactionPartId: "prt_ours_compaction",
            summaryPartId: "prt_ours_summary_part",
            boundaryOrdinal: 5,
            targetEndMessageId: "msg_ours_boundary",
        };
        setPersistedCompactionMarkerState(db, SESSION_ID, owned);

        const result = reconcileForkOrphanedCompactionMarkers(db, SESSION_ID, true);
        expect(result.removed).toBe(1);
        expect(result.failed).toBe(false);

        // Only our marker remains; the orphan's rows are gone.
        const remaining = listSessionCompactionMarkers(SESSION_ID);
        expect(remaining.length).toBe(1);
        expect(remaining[0].compactionPartId).toBe("prt_ours_compaction");
        expect(remaining[0].boundaryMessageId).toBe("msg_ours_boundary");
    });

    it("does NOT touch an orphan that is older than ours (harmless) or a native compaction", () => {
        // Our marker is the NEWEST (time 3000). An older MC-shaped marker (time
        // 1000) cannot outrank us, so it must be left alone. A native /compact
        // marker (time 4000, real providerID) is newer but must NEVER be touched.
        insertMagicContextMarker(opencodeDb, SESSION_ID, {
            boundaryId: "msg_ours_boundary",
            summaryId: "msg_ours_summary",
            partId: "prt_ours_compaction",
            summaryPartId: "prt_ours_summary_part",
            time: 3000,
        });
        insertMagicContextMarker(opencodeDb, SESSION_ID, {
            boundaryId: "msg_old_boundary",
            summaryId: "msg_old_summary",
            partId: "prt_old_compaction",
            summaryPartId: "prt_old_summary_part",
            time: 1000,
        });
        // Native OpenCode compaction: summary carries a real provider id.
        insertOcMessage(opencodeDb, "msg_native_boundary", SESSION_ID, 4000, { role: "user" });
        insertOcPart(opencodeDb, "prt_native_compaction", "msg_native_boundary", SESSION_ID, 4000, {
            type: "compaction",
            auto: false,
        });
        insertOcMessage(opencodeDb, "msg_native_summary", SESSION_ID, 4001, {
            role: "assistant",
            parentID: "msg_native_boundary",
            summary: true,
            finish: "stop",
            providerID: "anthropic",
            modelID: "claude-x",
        });

        const owned: PersistedCompactionMarkerState = {
            boundaryMessageId: "msg_ours_boundary",
            summaryMessageId: "msg_ours_summary",
            compactionPartId: "prt_ours_compaction",
            summaryPartId: "prt_ours_summary_part",
            boundaryOrdinal: 5,
            targetEndMessageId: "msg_ours_boundary",
        };
        setPersistedCompactionMarkerState(db, SESSION_ID, owned);

        const result = reconcileForkOrphanedCompactionMarkers(db, SESSION_ID, true);
        expect(result.removed).toBe(0);

        const remaining = listSessionCompactionMarkers(SESSION_ID);
        const partIds = remaining.map((m) => m.compactionPartId).sort();
        // Discovery intentionally omits native markers because reconciliation
        // cannot act on rows without a completed Magic Context summary.
        expect(partIds).toEqual(["prt_old_compaction", "prt_ours_compaction"].sort());
    });

    it("old and reversed discovery produce identical actionable sets across 900 boundaries", () => {
        insertMagicContextMarker(opencodeDb, SESSION_ID, {
            boundaryId: "msg_owned_boundary",
            summaryId: "msg_owned_summary",
            partId: "prt_owned_compaction",
            summaryPartId: "prt_owned_summary_part",
            time: 10_000,
        });
        setPersistedCompactionMarkerState(db, SESSION_ID, {
            boundaryMessageId: "msg_owned_boundary",
            summaryMessageId: "msg_owned_summary",
            compactionPartId: "prt_owned_compaction",
            summaryPartId: "prt_owned_summary_part",
            boundaryOrdinal: 901,
            targetEndMessageId: "msg_owned_boundary",
        });

        for (let index = 0; index < 900; index += 1) {
            insertMagicContextMarker(opencodeDb, SESSION_ID, {
                boundaryId: `msg_bulk_boundary_${index}`,
                summaryId: `msg_bulk_summary_${index}`,
                partId: `prt_bulk_compaction_${index}`,
                summaryPartId: `prt_bulk_summary_part_${index}`,
                time: index + 1,
            });
        }
        insertOcMessage(opencodeDb, "msg_extra_summary", SESSION_ID, 20, {
            role: "assistant",
            parentID: "msg_bulk_boundary_10",
            summary: true,
            finish: "stop",
            providerID: "magic-context",
        });
        insertOcPart(opencodeDb, "prt_extra_compaction", "msg_bulk_boundary_10", SESSION_ID, 20, {
            type: "compaction",
            auto: true,
        });

        insertOcMessage(opencodeDb, "msg_native_boundary", SESSION_ID, 11_000, { role: "user" });
        insertOcPart(opencodeDb, "prt_native", "msg_native_boundary", SESSION_ID, 11_000, {
            type: "compaction",
        });
        insertOcMessage(opencodeDb, "msg_native_summary", SESSION_ID, 11_001, {
            role: "assistant",
            parentID: "msg_native_boundary",
            summary: true,
            finish: "stop",
            providerID: "anthropic",
        });

        insertMagicContextMarker(opencodeDb, "other-session", {
            boundaryId: "msg_cross_boundary",
            summaryId: "msg_cross_summary",
            partId: "prt_cross_compaction",
            summaryPartId: "prt_cross_summary_part",
            time: 12_000,
        });

        insertOcMessage(opencodeDb, "msg_missing_summary", SESSION_ID, 13_001, {
            role: "assistant",
            parentID: "msg_missing_boundary",
            summary: true,
            finish: "stop",
            providerID: "magic-context",
        });
        insertOcPart(opencodeDb, "prt_missing", "msg_missing_boundary", SESSION_ID, 13_000, {
            type: "compaction",
        });
        insertMagicContextMarker(opencodeDb, SESSION_ID, {
            boundaryId: "msg_new_orphan_boundary",
            summaryId: "msg_new_orphan_summary",
            partId: "prt_new_orphan",
            summaryPartId: "prt_new_orphan_summary_part",
            time: 20_000,
        });

        const legacy = legacyListActionableMarkers(opencodeDb, SESSION_ID);
        const reversed = listSessionCompactionMarkers(SESSION_ID);
        expect(normalizedMarkerSet(reversed)).toEqual(normalizedMarkerSet(legacy));

        const result = reconcileForkOrphanedCompactionMarkers(db, SESSION_ID, true);
        expect(result).toEqual({ removed: 1, failed: false });
        expect(
            normalizedMarkerSet(listSessionCompactionMarkers(SESSION_ID)).some((key) =>
                key.startsWith("prt_new_orphan:"),
            ),
        ).toBe(false);
        expect(
            opencodeDb.prepare("SELECT 1 FROM part WHERE id = 'prt_native'").get(),
        ).not.toBeNull();
        expect(
            opencodeDb.prepare("SELECT 1 FROM part WHERE id = 'prt_missing'").get(),
        ).not.toBeNull();
    });

    it("old and reversed discovery preserve retry decisions when marker removal fails", () => {
        insertMagicContextMarker(opencodeDb, SESSION_ID, {
            boundaryId: "msg_owned_boundary",
            summaryId: "msg_owned_summary",
            partId: "prt_owned_compaction",
            summaryPartId: "prt_owned_summary_part",
            time: 1_000,
        });
        insertMagicContextMarker(opencodeDb, SESSION_ID, {
            boundaryId: "msg_failing_boundary",
            summaryId: "msg_failing_summary",
            partId: "prt_failing_compaction",
            summaryPartId: "prt_failing_summary_part",
            time: 2_000,
        });
        setPersistedCompactionMarkerState(db, SESSION_ID, {
            boundaryMessageId: "msg_owned_boundary",
            summaryMessageId: "msg_owned_summary",
            // Simulate durable ownership pointing at a marker part that vanished.
            // The remaining owned-boundary marker must still be harmless, while
            // the newer orphan remains the only actionable deletion.
            compactionPartId: "prt_stale_owned",
            summaryPartId: "prt_owned_summary_part",
            boundaryOrdinal: 1,
            targetEndMessageId: "msg_owned_boundary",
        });
        expect(normalizedMarkerSet(listSessionCompactionMarkers(SESSION_ID))).toEqual(
            normalizedMarkerSet(legacyListActionableMarkers(opencodeDb, SESSION_ID)),
        );
        opencodeDb.exec(`CREATE TRIGGER reject_orphan_delete
            BEFORE DELETE ON part WHEN OLD.id = 'prt_failing_compaction'
            BEGIN SELECT RAISE(ABORT, 'simulated removal failure'); END`);

        expect(reconcileForkOrphanedCompactionMarkers(db, SESSION_ID, true)).toEqual({
            removed: 0,
            failed: true,
        });
        expect(
            opencodeDb.prepare("SELECT 1 FROM part WHERE id = 'prt_failing_compaction'").get(),
        ).not.toBeNull();
    });

    it("fork simulation: degraded pass repairs the orphan, next pass exits degraded", () => {
        // Compartments cover up to msg_comp_end; our marker sits at that boundary.
        replaceAllCompartmentState(
            db,
            SESSION_ID,
            [
                {
                    sequence: 1,
                    startMessage: 1,
                    endMessage: 5,
                    startMessageId: "msg_start",
                    endMessageId: "msg_comp_end",
                    title: "early history",
                    content: "Summary of early messages.",
                },
            ],
            [],
        );
        insertOcMessage(opencodeDb, "msg_comp_end", SESSION_ID, 1000, { role: "assistant" });
        insertMagicContextMarker(opencodeDb, SESSION_ID, {
            boundaryId: "msg_ours_boundary",
            summaryId: "msg_ours_summary",
            partId: "prt_ours_compaction",
            summaryPartId: "prt_ours_summary_part",
            time: 1000,
        });
        insertMagicContextMarker(opencodeDb, SESSION_ID, {
            boundaryId: "msg_orphan_boundary",
            summaryId: "msg_orphan_summary",
            partId: "prt_orphan_compaction",
            summaryPartId: "prt_orphan_summary_part",
            time: 2000,
        });
        setPersistedCompactionMarkerState(db, SESSION_ID, {
            boundaryMessageId: "msg_ours_boundary",
            summaryMessageId: "msg_ours_summary",
            compactionPartId: "prt_ours_compaction",
            summaryPartId: "prt_ours_summary_part",
            boundaryOrdinal: 5,
            targetEndMessageId: "msg_comp_end",
        });

        db.prepare(`UPDATE session_meta SET cached_m0_bytes = ?, cached_m1_bytes = ?,
            cached_m0_last_baseline_end_message_id = 'msg_comp_end' WHERE session_id = ?`).run(
            Buffer.from("<session-history>frozen baseline</session-history>"),
            Buffer.from("<session-history>frozen delta</session-history>"),
            SESSION_ID,
        );
        const beforeDefer = listSessionCompactionMarkers(SESSION_ID);
        prepareCompartmentInjection(
            db,
            SESSION_ID,
            [userMessage("msg_later_1", "later one")],
            false,
            [],
        );
        expect(listSessionCompactionMarkers(SESSION_ID)).toEqual(beforeDefer);
        clearInjectionCache(SESSION_ID);

        // Pass 1: the orphan cuts the window above our boundary, so the visible
        // array does NOT contain msg_comp_end. Injection degrades and runs hygiene.
        const pass1Messages: MessageLike[] = [
            userMessage("msg_orphan_boundary", "orphan boundary"),
            userMessage("msg_later_1", "later one"),
            userMessage("msg_later_2", "later two"),
        ];
        const pass1 = prepareCompartmentInjection(db, SESSION_ID, pass1Messages, true, []);
        expect(pass1?.compartmentEndMessageId).toBeNull();
        // Hygiene removed the orphan during this degraded pass.
        const remaining = listSessionCompactionMarkers(SESSION_ID);
        expect(remaining.length).toBe(1);
        expect(remaining[0].compactionPartId).toBe("prt_ours_compaction");

        // Pass 2: with the orphan gone, filterCompacted stops at our marker and
        // the visible window now includes msg_comp_end. Injection exits degraded.
        clearInjectionCache(SESSION_ID);
        const pass2Messages: MessageLike[] = [
            userMessage("msg_ours_boundary", "our boundary"),
            userMessage("msg_comp_end", "compartment end"),
            userMessage("msg_later_1", "later one"),
        ];
        const pass2 = prepareCompartmentInjection(db, SESSION_ID, pass2Messages, true, []);
        expect(pass2?.compartmentEndMessageId).toBe("msg_comp_end");
        expect(pass2?.skippedVisibleMessages).toBe(2);
        expect(pass2Messages.length).toBe(1);
        expect(pass2Messages[0].info.id).toBe("msg_later_1");
    });
});

describe("Layer B — degraded-mode re-anchor (#264)", () => {
    function seedTwoCompartments(): void {
        replaceAllCompartmentState(
            db,
            SESSION_ID,
            [
                {
                    sequence: 1,
                    startMessage: 1,
                    endMessage: 5,
                    startMessageId: "msg_start",
                    endMessageId: "msg_c1_end",
                    title: "compartment one",
                    content: "First compartment.",
                },
                {
                    sequence: 2,
                    startMessage: 6,
                    endMessage: 10,
                    startMessageId: "msg_c1_end",
                    endMessageId: "msg_c2_end",
                    title: "compartment two",
                    content: "Second compartment.",
                },
            ],
            [],
        );
    }

    it("re-anchors to the newest visible compartment boundary after N degraded bust passes", () => {
        seedTwoCompartments();
        // The natural boundary (msg_c2_end) is NOT visible, but msg_c1_end IS.
        const makeVisible = (): MessageLike[] => [
            userMessage("msg_c1_end", "compartment one end"),
            userMessage("msg_x", "x"),
            userMessage("msg_y", "y"),
        ];

        // Pass 1 (bust): first degraded detection — hygiene no-ops (no marker
        // state), count=1, no re-anchor yet.
        const pass1 = prepareCompartmentInjection(db, SESSION_ID, makeVisible(), true, []);
        expect(pass1?.compartmentEndMessageId).toBeNull();
        expect(pass1?.skippedVisibleMessages).toBe(0);

        // Pass 2 (bust): count reaches the threshold — re-anchor splices at the
        // visible msg_c1_end boundary instead of looping.
        const pass2Messages = makeVisible();
        const pass2 = prepareCompartmentInjection(db, SESSION_ID, pass2Messages, true, []);
        expect(pass2?.compartmentEndMessageId).toBe("msg_c1_end");
        expect(pass2?.compartmentEndMessage).toBe(5);
        expect(pass2?.skippedVisibleMessages).toBe(1);
        // msg_c1_end spliced out; msg_x and msg_y remain.
        expect(pass2Messages.length).toBe(2);
        expect(pass2Messages[0].info.id).toBe("msg_x");
        expect(pass2Messages[1].info.id).toBe("msg_y");
    });

    it("does not inherit another database's degraded count for the same session id", () => {
        // The degraded count gates a byte-CHANGING re-anchor. If it leaks across
        // stores sharing a session id, store B re-anchors on its FIRST degraded
        // pass because it inherited store A's episode.
        const makeVisible = (): MessageLike[] => [
            userMessage("msg_c1_end", "compartment one end"),
            userMessage("msg_x", "x"),
        ];

        // Store A: one degraded bust pass (count = 1, below the threshold).
        seedTwoCompartments();
        const storeAPass = prepareCompartmentInjection(db, SESSION_ID, makeVisible(), true, []);
        expect(storeAPass?.compartmentEndMessageId).toBeNull();

        // Store B: independent database, same session id, its FIRST degraded pass.
        const storeA = db;
        const storeB = makeContextDb();
        try {
            db = storeB;
            seedTwoCompartments();
            const messages = makeVisible();
            const storeBPass = prepareCompartmentInjection(storeB, SESSION_ID, messages, true, []);
            // Still pass 1 for THIS store: no re-anchor, nothing spliced.
            expect(storeBPass?.compartmentEndMessageId).toBeNull();
            expect(storeBPass?.skippedVisibleMessages).toBe(0);
            expect(messages.length).toBe(2);
        } finally {
            db = storeA;
            closeQuietly(storeB);
        }
    });

    it("does NOT re-anchor before the degraded-pass threshold", () => {
        seedTwoCompartments();
        const makeVisible = (): MessageLike[] => [
            userMessage("msg_c1_end", "compartment one end"),
            userMessage("msg_x", "x"),
        ];
        // A single degraded bust pass must stay degraded (no premature re-anchor).
        const pass1 = prepareCompartmentInjection(db, SESSION_ID, makeVisible(), true, []);
        expect(pass1?.compartmentEndMessageId).toBeNull();
        expect(pass1?.skippedVisibleMessages).toBe(0);
    });

    it("requests fresh materialization when no compartment boundary is visible", () => {
        seedTwoCompartments();
        const makeVisible = (): MessageLike[] => [
            userMessage("msg_unrelated", "unrelated"),
            userMessage("msg_x", "x"),
        ];
        prepareCompartmentInjection(db, SESSION_ID, makeVisible(), true, []);
        const pass2 = prepareCompartmentInjection(db, SESSION_ID, makeVisible(), true, []);
        expect(pass2?.compartmentEndMessageId).toBeNull();
        expect(pass2?.needsFreshMaterialization).toBe(true);
    });
});

describe("Byte stability — defer passes during degraded mode", () => {
    it("replays byte-identical output on defer passes and never first-applies a re-anchor", () => {
        replaceAllCompartmentState(
            db,
            SESSION_ID,
            [
                {
                    sequence: 1,
                    startMessage: 1,
                    endMessage: 5,
                    startMessageId: "msg_start",
                    endMessageId: "msg_c1_end",
                    title: "compartment one",
                    content: "First compartment.",
                },
                {
                    sequence: 2,
                    startMessage: 6,
                    endMessage: 10,
                    startMessageId: "msg_c1_end",
                    endMessageId: "msg_c2_end",
                    title: "compartment two",
                    content: "Second compartment.",
                },
            ],
            [],
        );
        const makeVisible = (): MessageLike[] => [
            userMessage("msg_c1_end", "compartment one end"),
            userMessage("msg_x", "x"),
        ];

        // Bust pass establishes the degraded cache (count=1).
        const bust = prepareCompartmentInjection(db, SESSION_ID, makeVisible(), true, []);
        expect(bust?.compartmentEndMessageId).toBeNull();

        // Two defer passes: degraded cache forces a rebuild each time, but the
        // re-anchor must NOT first-apply on a defer pass, and the rendered block
        // must stay byte-identical.
        const defer1Messages = makeVisible();
        const defer1 = prepareCompartmentInjection(db, SESSION_ID, defer1Messages, false, []);
        const defer2Messages = makeVisible();
        const defer2 = prepareCompartmentInjection(db, SESSION_ID, defer2Messages, false, []);

        expect(defer1?.block).toBe(bust?.block);
        expect(defer2?.block).toBe(bust?.block);
        // No splice happened on either defer pass (boundary still invisible).
        expect(defer1Messages.length).toBe(2);
        expect(defer2Messages.length).toBe(2);
        expect(defer1?.compartmentEndMessageId).toBeNull();
        expect(defer2?.compartmentEndMessageId).toBeNull();
    });
});
