/// <reference types="bun-types" />

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
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
const originalTestDataDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;

let db: Database;
let opencodeDb: Database;

function useTempDataHome(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    process.env.MAGIC_CONTEXT_TEST_DATA_DIR = dir;
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
    if (originalTestDataDir === undefined) delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
    else process.env.MAGIC_CONTEXT_TEST_DATA_DIR = originalTestDataDir;
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

        const result = reconcileForkOrphanedCompactionMarkers(db, SESSION_ID);
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

        const result = reconcileForkOrphanedCompactionMarkers(db, SESSION_ID);
        expect(result.removed).toBe(0);

        const remaining = listSessionCompactionMarkers(SESSION_ID);
        const partIds = remaining.map((m) => m.compactionPartId).sort();
        expect(partIds).toEqual(
            ["prt_native_compaction", "prt_old_compaction", "prt_ours_compaction"].sort(),
        );
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

        // Pass 1: the orphan cuts the window above our boundary, so the visible
        // array does NOT contain msg_comp_end. Injection degrades and runs hygiene.
        const pass1Messages: MessageLike[] = [
            userMessage("msg_orphan_boundary", "orphan boundary"),
            userMessage("msg_later_1", "later one"),
            userMessage("msg_later_2", "later two"),
        ];
        const pass1 = prepareCompartmentInjection(db, SESSION_ID, pass1Messages, true);
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
        const pass2 = prepareCompartmentInjection(db, SESSION_ID, pass2Messages, true);
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
        const pass1 = prepareCompartmentInjection(db, SESSION_ID, makeVisible(), true);
        expect(pass1?.compartmentEndMessageId).toBeNull();
        expect(pass1?.skippedVisibleMessages).toBe(0);

        // Pass 2 (bust): count reaches the threshold — re-anchor splices at the
        // visible msg_c1_end boundary instead of looping.
        const pass2Messages = makeVisible();
        const pass2 = prepareCompartmentInjection(db, SESSION_ID, pass2Messages, true);
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
        const storeAPass = prepareCompartmentInjection(db, SESSION_ID, makeVisible(), true);
        expect(storeAPass?.compartmentEndMessageId).toBeNull();

        // Store B: independent database, same session id, its FIRST degraded pass.
        const storeA = db;
        const storeB = makeContextDb();
        try {
            db = storeB;
            seedTwoCompartments();
            const messages = makeVisible();
            const storeBPass = prepareCompartmentInjection(storeB, SESSION_ID, messages, true);
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
        const pass1 = prepareCompartmentInjection(db, SESSION_ID, makeVisible(), true);
        expect(pass1?.compartmentEndMessageId).toBeNull();
        expect(pass1?.skippedVisibleMessages).toBe(0);
    });

    it("requests fresh materialization when no compartment boundary is visible", () => {
        seedTwoCompartments();
        const makeVisible = (): MessageLike[] => [
            userMessage("msg_unrelated", "unrelated"),
            userMessage("msg_x", "x"),
        ];
        prepareCompartmentInjection(db, SESSION_ID, makeVisible(), true);
        const pass2 = prepareCompartmentInjection(db, SESSION_ID, makeVisible(), true);
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
        const bust = prepareCompartmentInjection(db, SESSION_ID, makeVisible(), true);
        expect(bust?.compartmentEndMessageId).toBeNull();

        // Two defer passes: degraded cache forces a rebuild each time, but the
        // re-anchor must NOT first-apply on a defer pass, and the rendered block
        // must stay byte-identical.
        const defer1Messages = makeVisible();
        const defer1 = prepareCompartmentInjection(db, SESSION_ID, defer1Messages, false);
        const defer2Messages = makeVisible();
        const defer2 = prepareCompartmentInjection(db, SESSION_ID, defer2Messages, false);

        expect(defer1?.block).toBe(bust?.block);
        expect(defer2?.block).toBe(bust?.block);
        // No splice happened on either defer pass (boundary still invisible).
        expect(defer1Messages.length).toBe(2);
        expect(defer2Messages.length).toBe(2);
        expect(defer1?.compartmentEndMessageId).toBeNull();
        expect(defer2?.compartmentEndMessageId).toBeNull();
    });
});
