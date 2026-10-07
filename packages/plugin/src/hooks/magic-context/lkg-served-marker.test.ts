import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import {
    clearPersistedLkgSlotStrict,
    createDbLkgPersistence,
    loadPersistedLkgSlot,
    saveLkgSlotToDb,
} from "./lkg-persist";
import { captureLkgSlot, projectLkgEntry } from "./lkg-replay";
import {
    checkLkgDurability,
    readServedMarker,
    recordServedCapture,
    repairLkgDurability,
    ServedMarkerWriteError,
    startLkgDurabilityPoll,
} from "./lkg-served-marker";
import {
    captureSlot,
    dropSlot,
    forgetInMemorySlot,
    type LkgSlot,
    registerLkgPersistence,
    resetLkgSlotsForTest,
} from "./lkg-slot";
import {
    moveInputs,
    moveMessageDigestFromFields,
    persistedMoveInputs,
    summarizeMoveInputs,
} from "./move-inputs";
import type { MessageLike } from "./transform-operations";

const databases: Database[] = [];
function fixture(path = ":memory:"): Database {
    const db = new Database(path);
    initializeDatabase(db);
    runMigrations(db);
    databases.push(db);
    registerLkgPersistence(createDbLkgPersistence(db));
    return db;
}
const slot = (servedCaptureId: number): LkgSlot => ({
    jsonPrefix: '[{"text":"served"}]',
    inputIdSeq: ["u"],
    inputContentDigests: ["digest"],
    inputMoveDigests: ["a".repeat(64)],
    lastInputMessageId: "u",
    modelKey: "m",
    providerKey: "p",
    capturedAt: Date.now(),
    rowVersion: 900,
    captureSequence: 3,
    servedCaptureId,
});
afterEach(() => {
    resetLkgSlotsForTest();
    for (const db of databases) db.close();
    databases.length = 0;
});

describe("served marker durability", () => {
    test("refuses an older durable capture at the same row_version", () => {
        const db = fixture();
        expect(checkLkgDurability(db, "s")).toEqual({ durable: true, servedCaptureId: null });
        const first = slot(recordServedCapture(db, "s", true));
        expect(saveLkgSlotToDb(db, "s", first)).toBe(true);
        const second = { ...slot(recordServedCapture(db, "s", true)), captureSequence: 4 };
        expect(second.servedCaptureId).toBe(2);
        expect(checkLkgDurability(db, "s")).toEqual({ durable: false, reason: "lkg_not_durable" });
        expect(saveLkgSlotToDb(db, "s", second)).toBe(true);
        expect(checkLkgDurability(db, "s")).toEqual({ durable: true, servedCaptureId: 2 });
        expect(loadPersistedLkgSlot(db, "s")?.rowVersion).toBe(900);
        expect(loadPersistedLkgSlot(db, "s")?.captureSequence).toBe(4);
        expect(saveLkgSlotToDb(db, "s", first, { force: true })).toBe(false);
        expect(loadPersistedLkgSlot(db, "s")?.servedCaptureId).toBe(2);
        // An uncertified legacy writer cannot leave the newer id attached to
        // different slot bytes and accidentally authorize their export.
        expect(
            saveLkgSlotToDb(db, "s", {
                ...second,
                servedCaptureId: undefined,
                inputMoveDigests: undefined,
            }),
        ).toBe(true);
        expect(checkLkgDurability(db, "s")).toEqual({ durable: false, reason: "lkg_not_durable" });
    });

    test("a stopped fresh process refuses failed persistence instead of exporting an older slot", () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "served-marker-"));
        try {
            const db = fixture(join(root, "context.db"));
            const first = slot(recordServedCapture(db, "s", true));
            expect(saveLkgSlotToDb(db, "s", first)).toBe(true);
            const second = { ...slot(recordServedCapture(db, "s", true)), captureSequence: 4 };
            expect(captureSlot("s", second)).toBe(true);
            db.exec(
                "CREATE TRIGGER fail_lkg BEFORE INSERT ON lkg_slots BEGIN SELECT RAISE(ABORT, 'injected save failure'); END",
            );
            expect(saveLkgSlotToDb(db, "s", second)).toBe(false);
            resetLkgSlotsForTest();
            const fresh = new Database(join(root, "context.db"));
            databases.push(fresh);
            expect(repairLkgDurability(fresh, "s")).toEqual({
                durable: false,
                reason: "lkg_not_durable",
            });
            expect(loadPersistedLkgSlot(fresh, "s")?.servedCaptureId).toBe(1);
        } finally {
            for (const db of databases.splice(0)) db.close();
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("the one-second draining poll re-persists only the matching live capture", async () => {
        const db = fixture();
        const current = slot(recordServedCapture(db, "s", true));
        expect(captureSlot("s", current)).toBe(true);
        db.exec(
            "CREATE TRIGGER fail_lkg BEFORE INSERT ON lkg_slots BEGIN SELECT RAISE(ABORT, 'injected save failure'); END",
        );
        expect(saveLkgSlotToDb(db, "s", current)).toBe(false);
        db.exec("DROP TRIGGER fail_lkg");
        let draining: string[] = [];
        let polls = 0;
        const errors: unknown[] = [];
        const stop = startLkgDurabilityPoll(
            db,
            () => {
                polls++;
                return draining;
            },
            (error) => errors.push(error),
        );
        try {
            expect(checkLkgDurability(db, "s").durable).toBe(false);
            draining = ["s"];
            await new Promise((resolve) => setTimeout(resolve, 1100));
            expect(polls).toBe(1);
            expect(errors).toEqual([]);
            expect(checkLkgDurability(db, "s")).toEqual({ durable: true, servedCaptureId: 1 });
            expect(readServedMarker(db, "s")?.servedCaptureId).toBe(1);
            // Eviction cannot turn an older disk slot into proof of a newer capture.
            recordServedCapture(db, "s", true);
            forgetInMemorySlot("s");
            expect(repairLkgDurability(db, "s")).toEqual({
                durable: false,
                reason: "lkg_not_durable",
            });
        } finally {
            stop();
        }
    });

    test.each([
        "lkg_cache_bust_pending_capture",
        "lkg_refresh_declined",
        "lkg_async_capture_failed",
        "rust_marker_admission_fenced",
    ])("a %s drop records its reason atomically and the next capture recovers", (reason) => {
        const db = fixture();
        const first = slot(recordServedCapture(db, "s", true));
        expect(captureSlot("s", first)).toBe(true);
        expect(saveLkgSlotToDb(db, "s", first)).toBe(true);
        dropSlot("s", reason);
        expect(checkLkgDurability(db, "s")).toEqual({
            durable: false,
            reason: "no_frontier",
            slotState: reason,
        });
        expect(loadPersistedLkgSlot(db, "s")).toBeUndefined();
        const next = slot(recordServedCapture(db, "s", true));
        expect(saveLkgSlotToDb(db, "s", next)).toBe(true);
        expect(checkLkgDurability(db, "s")).toEqual({ durable: true, servedCaptureId: 2 });
    });

    test("marker failure rolls back the slot drop and refuses the pass", () => {
        const db = fixture();
        const first = slot(recordServedCapture(db, "s", true));
        expect(saveLkgSlotToDb(db, "s", first)).toBe(true);
        db.exec(
            "CREATE TRIGGER fail_marker BEFORE INSERT ON lkg_served_markers BEGIN SELECT RAISE(ABORT, 'marker write failure'); END",
        );
        expect(() => recordServedCapture(db, "s", true)).toThrow(ServedMarkerWriteError);
        expect(() => clearPersistedLkgSlotStrict(db, "s", "declined")).toThrow(
            ServedMarkerWriteError,
        );
        expect(loadPersistedLkgSlot(db, "s")?.servedCaptureId).toBe(1);
        expect(readServedMarker(db, "s")?.slotState).toBe("captured");
    });

    test("bounded busy acquisition refuses visibly and leaves no marker", () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "served-marker-busy-"));
        const db = fixture(join(root, "context.db"));
        const blocker = new Database(join(root, "context.db"));
        try {
            blocker.exec("BEGIN IMMEDIATE");
            const started = performance.now();
            expect(() => recordServedCapture(db, "s", true)).toThrow(ServedMarkerWriteError);
            expect(performance.now() - started).toBeLessThan(2000);
            expect(readServedMarker(db, "s")).toBeUndefined();
        } finally {
            blocker.exec("ROLLBACK");
            blocker.close();
            for (const connection of databases.splice(0)) connection.close();
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("TS saves the same marker id and certifies partial anchor coverage as no_frontier", () => {
        const db = fixture();
        const input = [
            {
                info: { id: "u", role: "user", time: { created: 1 } },
                parts: [{ type: "text", text: "input" }],
            },
            {
                info: { id: "a", role: "assistant", time: { created: 2 } },
                parts: [{ type: "text", text: "reply" }],
            },
        ] as MessageLike[];
        let captured: LkgSlot | undefined;
        expect(
            captureLkgSlot({
                sessionId: "s",
                input: projectLkgEntry(input),
                output: input,
                modelKey: "m",
                providerKey: "p",
                onPrepared: (snapshot, full) => {
                    snapshot.servedCaptureId = recordServedCapture(db, "s", full);
                    captured = snapshot;
                },
            }),
        ).toBe(true);
        expect(saveLkgSlotToDb(db, "s", captured!)).toBe(true);
        expect(checkLkgDurability(db, "s")).toEqual({
            durable: false,
            reason: "no_frontier",
            slotState: "partial_capture",
        });
        expect(persistedMoveInputs(loadPersistedLkgSlot(db, "s")!)).toEqual(
            moveInputs("ts", input.slice(0, 1)),
        );
    });
});

describe("portable move input projection", () => {
    test("pins canonical hex and ordered-line digests independent of object key order", () => {
        const first = { info: { role: "user", id: "z" }, parts: [{ text: "hello", type: "text" }] };
        const second = {
            parts: [{ type: "text", text: "hello" }],
            info: { id: "z", role: "user" },
        };
        // Independent known canonical bytes, rather than reproducing the projection.
        const expected = "366a58936ed9f6c52f3c72ad304d525c373f9af4bf4a3a9126a7318a98fb5f5a";
        expect(moveInputs("ts", [first]).digest).toBe(expected);
        expect(moveInputs("ts", [first])).toEqual(moveInputs("rust", [second]));
        expect(summarizeMoveInputs([], [])).toEqual({
            count: 0,
            digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        });
        expect(moveInputs("ts", [first]).count).toBe(1);
        expect(() => summarizeMoveInputs(["bad\nid"], ["a".repeat(64)])).toThrow();
        expect(() => summarizeMoveInputs(["id"], ["A".repeat(64)])).toThrow();
    });

    test("normalized synth-user ids stay intact and same-id edits change the frontier", () => {
        const messages = [
            {
                info: { id: "synth-user-tool-1", role: "user" },
                parts: [{ type: "text", text: "alpha" }],
            },
        ] as MessageLike[];
        const original = moveInputs("ts", messages);
        expect(moveInputs("rust", messages)).toEqual(original);
        messages[0]!.parts[0]!.text = "bravo";
        expect(moveInputs("ts", messages)).not.toEqual(original);
        expect(() => moveMessageDigestFromFields([])).toThrow();
    });
});
