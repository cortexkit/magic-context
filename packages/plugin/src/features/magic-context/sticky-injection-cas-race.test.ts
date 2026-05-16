/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import {
    appendAutoSearchHintDecision,
    appendNoteNudgeAnchor,
    deliverNoteNudgeAtomic,
    getNoteNudgeAnchors,
    pruneNoteNudgeAnchors,
} from "./storage-meta-persisted";

function createRaceDb(path: string): Database {
    const db = new Database(path);
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

describe("sticky-injection CAS helpers", () => {
    it("two WAL handles append distinct note-nudge anchors without losing either", () => {
        const dir = mkdtempSync(join(tmpdir(), "sticky-anchor-race-"));
        try {
            const path = join(dir, "context.db");
            const a = createRaceDb(path);
            const b = createRaceDb(path);
            expect(appendNoteNudgeAnchor(a, "s1", "m1", "text-1")).toBe(true);
            expect(appendNoteNudgeAnchor(b, "s1", "m2", "text-2")).toBe(true);
            expect(getNoteNudgeAnchors(a, "s1")).toEqual([
                { messageId: "m1", text: "text-1" },
                { messageId: "m2", text: "text-2" },
            ]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("append plus prune keeps newly appended visible anchor", () => {
        const dir = mkdtempSync(join(tmpdir(), "sticky-anchor-prune-race-"));
        try {
            const path = join(dir, "context.db");
            const a = createRaceDb(path);
            const b = createRaceDb(path);
            expect(appendNoteNudgeAnchor(a, "s1", "m1", "text-1")).toBe(true);
            expect(appendNoteNudgeAnchor(b, "s1", "m2", "text-2")).toBe(true);
            expect(pruneNoteNudgeAnchors(a, "s1", new Set(["m2"]))).toBe(1);
            expect(getNoteNudgeAnchors(b, "s1")).toEqual([{ messageId: "m2", text: "text-2" }]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("conflicting note-nudge delivery refuses second text for same message id", () => {
        const dir = mkdtempSync(join(tmpdir(), "sticky-anchor-conflict-"));
        try {
            const path = join(dir, "context.db");
            const db = createRaceDb(path);
            expect(deliverNoteNudgeAtomic(db, "s1", "m1", "text-1")).toEqual({
                ok: true,
                kind: "appended",
            });
            expect(deliverNoteNudgeAtomic(db, "s1", "m1", "text-2")).toEqual({
                ok: false,
                kind: "conflict",
            });
            expect(getNoteNudgeAnchors(db, "s1")).toEqual([{ messageId: "m1", text: "text-1" }]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("auto-search already-present outcome returns stored decision", () => {
        const dir = mkdtempSync(join(tmpdir(), "sticky-auto-stored-"));
        try {
            const path = join(dir, "context.db");
            const db = createRaceDb(path);
            const stored = { messageId: "m1", decision: "hint" as const, text: "STORED" };
            expect(appendAutoSearchHintDecision(db, "s1", stored)).toEqual({
                ok: true,
                kind: "appended",
                decision: stored,
            });
            expect(
                appendAutoSearchHintDecision(db, "s1", {
                    messageId: "m1",
                    decision: "no-hint",
                    reason: "stacked",
                }),
            ).toEqual({ ok: true, kind: "already-present", decision: stored });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
