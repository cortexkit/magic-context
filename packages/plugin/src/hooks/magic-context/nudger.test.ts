/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    getTopNBySize,
    insertTag,
    openDatabase,
    queuePendingOp,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { createNudger, RECENT_CTX_REDUCE_WINDOW_MS } from "./nudger";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdgDataHome;

    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
});

function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function useTempDataHome(prefix: string): void {
    process.env.XDG_DATA_HOME = makeTempDir(prefix);
}

describe("createNudger", () => {
    it("does not fire a rolling nudge before the token interval is reached", () => {
        //#given
        useTempDataHome("context-nudger-under-interval-");
        const sessionId = "ses-under-interval";
        const db = openDatabase();
        insertTag(db, sessionId, "m-1", "message", 120, 1);
        const nudger = createNudger({
            protected_tags: 8,
            nudge_interval_tokens: 20_000,
            iteration_nudge_threshold: 5,
            execute_threshold_percentage: 65,
        });

        //#when
        const result = nudger(
            sessionId,
            { percentage: 30, inputTokens: 19_999 },
            db,
            getTopNBySize,
        );

        //#then
        expect(result).toBeNull();
        expect(getOrCreateSessionMeta(db, sessionId).lastNudgeTokens).toBe(0);
    });

    it("fires a rolling nudge after 20k token growth and persists the anchor", () => {
        //#given
        useTempDataHome("context-nudger-rolling-");
        const sessionId = "ses-rolling";
        const db = openDatabase();
        insertTag(db, sessionId, "m-1", "message", 120, 1);
        insertTag(db, sessionId, "m-2", "message", 500, 2);
        insertTag(db, sessionId, "m-3", "message", 300, 3);
        insertTag(db, sessionId, "m-4", "message", 400, 4);
        const nudger = createNudger({
            protected_tags: 8,
            nudge_interval_tokens: 20_000,
            iteration_nudge_threshold: 5,
            execute_threshold_percentage: 65,
        });

        //#when
        const result = nudger(
            sessionId,
            { percentage: 32, inputTokens: 20_000 },
            db,
            getTopNBySize,
        );

        //#then
        expect(result).toEqual(expect.objectContaining({ type: "assistant" }));
        expect(result?.text).toContain("CONTEXT REMINDER");
        expect(result?.text).toContain("§2§, §4§, §3§");
        expect(getOrCreateSessionMeta(db, sessionId).lastNudgeTokens).toBe(20_000);
    });

    it("uses a halved interval for the near band", () => {
        //#given
        useTempDataHome("context-nudger-near-interval-");
        const sessionId = "ses-near-interval";
        const db = openDatabase();
        insertTag(db, sessionId, "m-1", "message", 120, 1);
        const nudger = createNudger({
            protected_tags: 8,
            nudge_interval_tokens: 20_000,
            iteration_nudge_threshold: 5,
            execute_threshold_percentage: 65,
        });

        //#when
        const result = nudger(
            sessionId,
            { percentage: 45, inputTokens: 10_000 },
            db,
            getTopNBySize,
        );

        //#then
        expect(result).toEqual(expect.objectContaining({ type: "assistant" }));
        expect(result?.text).toContain("CONTEXT WARNING");
        expect(result?.text).toContain("Drop processed outputs, keep anything you might need soon");
        expect(getOrCreateSessionMeta(db, sessionId).lastNudgeTokens).toBe(10_000);
    });

    it("uses an eighth-sized interval for the critical band", () => {
        //#given
        useTempDataHome("context-nudger-critical-interval-");
        const sessionId = "ses-critical-interval";
        const db = openDatabase();
        insertTag(db, sessionId, "m-1", "message", 120, 1);
        const nudger = createNudger({
            protected_tags: 8,
            nudge_interval_tokens: 20_000,
            iteration_nudge_threshold: 5,
            execute_threshold_percentage: 65,
        });

        //#when
        const result = nudger(sessionId, { percentage: 65, inputTokens: 2_500 }, db, getTopNBySize);

        //#then
        expect(result).toEqual(expect.objectContaining({ type: "assistant" }));
        expect(result?.text).toContain("CONTEXT CRITICAL");
        expect(getOrCreateSessionMeta(db, sessionId).lastNudgeTokens).toBe(2_500);
    });

    it("falls through to 65% assistant nudge at 80% (emergency handled by promptAsync)", () => {
        //#given
        useTempDataHome("context-nudger-emergency-");
        const sessionId = "ses-emergency";
        const db = openDatabase();
        insertTag(db, sessionId, "m-1", "message", 500, 1);
        const nudger = createNudger({
            protected_tags: 8,
            nudge_interval_tokens: 20_000,
            iteration_nudge_threshold: 5,
            execute_threshold_percentage: 65,
        });

        //#when
        const result = nudger(
            sessionId,
            { percentage: 81, inputTokens: 162_000 },
            db,
            getTopNBySize,
        );

        //#then — 80% is handled via promptAsync; nudger fires 65% assistant nudge
        expect(result).toEqual({
            type: "assistant",
            text: expect.stringContaining("CONTEXT CRITICAL"),
        });
    });

    it("fires immediately when the rolling urgency band escalates", () => {
        //#given
        useTempDataHome("context-nudger-escalate-");
        const sessionId = "ses-escalate";
        const db = openDatabase();
        insertTag(db, sessionId, "m-1", "message", 700, 1);
        insertTag(db, sessionId, "m-2", "message", 600, 2);
        insertTag(db, sessionId, "m-3", "tool", 500, 3);
        const nudger = createNudger({
            protected_tags: 8,
            nudge_interval_tokens: 20_000,
            iteration_nudge_threshold: 5,
            execute_threshold_percentage: 65,
        });

        //#when
        updateSessionMeta(db, sessionId, { lastNudgeTokens: 132_000, lastNudgeBand: "near" });

        const first = nudger(
            sessionId,
            { percentage: 58, inputTokens: 132_001 },
            db,
            getTopNBySize,
        );
        const second = nudger(
            sessionId,
            { percentage: 58, inputTokens: 132_001 },
            db,
            getTopNBySize,
        );

        //#then
        expect(first).toEqual(expect.objectContaining({ type: "assistant" }));
        expect(first?.text).toContain("CONTEXT URGENT");
        expect(second).toBeNull();
        const meta = getOrCreateSessionMeta(db, sessionId);
        expect(meta.lastNudgeBand).toBe("urgent");
    });

    it("does not suppress rolling nudges when pending drops would bring context below 45%", () => {
        //#given
        useTempDataHome("context-nudger-suppress-");
        const sessionId = "ses-suppress";
        const db = openDatabase();
        insertTag(db, sessionId, "m-1", "message", 800, 1);
        insertTag(db, sessionId, "m-2", "message", 200, 2);
        const now = 3_000_000;
        queuePendingOp(db, sessionId, 1, "drop", now - RECENT_CTX_REDUCE_WINDOW_MS - 1);
        const nudger = createNudger({
            protected_tags: 8,
            nudge_interval_tokens: 20_000,
            iteration_nudge_threshold: 5,
            execute_threshold_percentage: 65,
            now: () => now,
        });

        //#when
        const result = nudger(
            sessionId,
            { percentage: 55, inputTokens: 110_000 },
            db,
            getTopNBySize,
        );

        //#then
        expect(result).toEqual(expect.objectContaining({ type: "assistant" }));
        expect(result?.text).toContain("CONTEXT URGENT");
    });

    it("suppresses regular nudges shortly after ctx_reduce queued drops", () => {
        //#given
        useTempDataHome("context-nudger-recent-reduce-");
        const sessionId = "ses-recent-reduce";
        const db = openDatabase();
        insertTag(db, sessionId, "m-1", "message", 800, 1);
        const now = 1_000_000;
        const recentReduceBySession = new Map<string, number>([[sessionId, now]]);
        const nudger = createNudger({
            protected_tags: 8,
            nudge_interval_tokens: 20_000,
            iteration_nudge_threshold: 5,
            execute_threshold_percentage: 65,
            now: () => now,
            recentReduceBySession,
        });

        //#when
        const result = nudger(
            sessionId,
            { percentage: 55, inputTokens: 110_000 },
            db,
            getTopNBySize,
        );

        //#then
        expect(result).toBeNull();
        expect(getOrCreateSessionMeta(db, sessionId).lastNudgeTokens).toBe(0);
    });

    it("allows regular nudges again after the recent ctx_reduce cooldown expires", () => {
        //#given
        useTempDataHome("context-nudger-reduce-cooldown-");
        const sessionId = "ses-reduce-cooldown";
        const db = openDatabase();
        insertTag(db, sessionId, "m-1", "message", 800, 1);
        let now = 2_000_000;
        const recentReduceBySession = new Map<string, number>([[sessionId, now]]);
        const nudger = createNudger({
            protected_tags: 8,
            nudge_interval_tokens: 20_000,
            iteration_nudge_threshold: 5,
            execute_threshold_percentage: 65,
            now: () => now,
            recentReduceBySession,
        });

        //#when
        const suppressed = nudger(
            sessionId,
            { percentage: 55, inputTokens: 110_000 },
            db,
            getTopNBySize,
        );
        now += RECENT_CTX_REDUCE_WINDOW_MS + 1;
        const result = nudger(
            sessionId,
            { percentage: 55, inputTokens: 110_000 },
            db,
            getTopNBySize,
        );

        //#then
        expect(suppressed).toBeNull();
        expect(result).toEqual(expect.objectContaining({ type: "assistant" }));
        expect(result?.text).toContain("CONTEXT URGENT");
    });

    it("uses the configured threshold to choose the rolling urgency band", () => {
        //#given
        useTempDataHome("context-nudger-insufficient-");
        const sessionId = "ses-insufficient";
        const db = openDatabase();
        insertTag(db, sessionId, "m-1", "message", 100, 1);
        insertTag(db, sessionId, "m-2", "message", 900, 2);
        const now = 4_000_000;
        queuePendingOp(db, sessionId, 1, "drop", now - RECENT_CTX_REDUCE_WINDOW_MS - 1);
        const nudger = createNudger({
            protected_tags: 8,
            nudge_interval_tokens: 20_000,
            iteration_nudge_threshold: 5,
            execute_threshold_percentage: 70,
            now: () => now,
        });

        //#when
        const result = nudger(
            sessionId,
            { percentage: 55, inputTokens: 110_000 },
            db,
            getTopNBySize,
        );

        //#then
        expect(result).toEqual(expect.objectContaining({ type: "assistant" }));
        expect(result?.text).toContain("CONTEXT WARNING");
    });

    it("still fires a rolling nudge when pending drops would bring projected usage below 45%", () => {
        //#given
        useTempDataHome("context-nudger-rolling-projected-");
        const sessionId = "ses-rolling-projected";
        const db = openDatabase();
        insertTag(db, sessionId, "m-1", "message", 800, 1);
        insertTag(db, sessionId, "m-2", "message", 200, 2);
        const now = 5_000_000;
        queuePendingOp(db, sessionId, 1, "drop", now - RECENT_CTX_REDUCE_WINDOW_MS - 1);
        const nudger = createNudger({
            protected_tags: 8,
            nudge_interval_tokens: 20_000,
            iteration_nudge_threshold: 5,
            execute_threshold_percentage: 65,
            now: () => now,
        });

        //#when
        const result = nudger(
            sessionId,
            { percentage: 44, inputTokens: 25_000 },
            db,
            getTopNBySize,
        );

        //#then
        expect(result).toEqual(expect.objectContaining({ type: "assistant" }));
        expect(result?.text).toContain("CONTEXT REMINDER");
        expect(getOrCreateSessionMeta(db, sessionId).lastNudgeTokens).toBe(25_000);
    });

    it("fires again after the rolling anchor is reset after drops execute", () => {
        //#given
        useTempDataHome("context-nudger-reset-anchor-");
        const sessionId = "ses-reset-anchor";
        const db = openDatabase();
        insertTag(db, sessionId, "m-1", "message", 500, 1);
        updateSessionMeta(db, sessionId, { lastNudgeTokens: 100_000 });
        const nudger = createNudger({
            protected_tags: 8,
            nudge_interval_tokens: 20_000,
            iteration_nudge_threshold: 5,
            execute_threshold_percentage: 65,
        });

        //#when
        const result = nudger(
            sessionId,
            { percentage: 34, inputTokens: 121_000 },
            db,
            getTopNBySize,
        );

        //#then
        expect(result).toEqual(expect.objectContaining({ type: "assistant" }));
        expect(getOrCreateSessionMeta(db, sessionId).lastNudgeTokens).toBe(121_000);
    });
});
