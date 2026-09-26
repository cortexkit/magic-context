/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { LATEST_MIGRATION_VERSION, runMigrations } from "./migrations";
import { initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";
import { getOrCreateSessionMeta } from "./storage-meta-session";
import {
    adoptFallbackTagMessageId,
    adoptNullOwnerToolTag,
    adoptPiFallbackMessageTag,
    adoptPiFallbackToolOwnerTag,
    deleteToolTagsByOwner,
    getNullOwnerToolTag,
    insertTag,
    markTagsCompactedByMessageIds,
} from "./storage-tags";

function seedAppliedVersion(db: Database, version: number): void {
    db.exec(`
        CREATE TABLE schema_migrations (
            version INTEGER PRIMARY KEY,
            description TEXT NOT NULL,
            applied_at INTEGER NOT NULL
        );
    `);
    const insert = db.prepare(
        "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)",
    );
    for (let current = 1; current <= version; current += 1) {
        insert.run(current, `seed v${current}`, Date.now());
    }
}

function tagsVersion(db: Database, sessionId: string): number {
    return (
        db.prepare("SELECT tags_version FROM session_meta WHERE session_id = ?").get(sessionId) as {
            tags_version: number;
        }
    ).tags_version;
}

function exerciseTagWriteGuards(withThrowawayTriggers: boolean): {
    guards: Record<string, unknown>;
    auditRows: number;
} {
    const db = new Database(":memory:");
    try {
        initializeDatabase(db);
        runMigrations(db);
        if (withThrowawayTriggers) {
            db.exec(`
                CREATE TABLE tag_write_audit (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    operation TEXT NOT NULL,
                    tag_id INTEGER NOT NULL
                );
                CREATE TRIGGER throwaway_tags_update AFTER UPDATE ON tags BEGIN
                    INSERT INTO tag_write_audit(operation, tag_id) VALUES('update', NEW.id);
                END;
                CREATE TRIGGER throwaway_tags_delete AFTER DELETE ON tags BEGIN
                    INSERT INTO tag_write_audit(operation, tag_id) VALUES('delete', OLD.id);
                END;
            `);
        }

        insertTag(db, "ses-guards", "pi-msg-0-fallback:p0", "message", 10, 1);
        insertTag(db, "ses-guards", "call:pi", "tool", 10, 2, 0, "read", 0, "owner-old");
        insertTag(db, "ses-guards", "pi-msg-1-fallback:p0", "message", 10, 3);
        insertTag(db, "ses-guards", "trim-root", "message", 10, 4);
        insertTag(db, "ses-guards", "trim-root:p0", "message", 10, 5);
        insertTag(db, "ses-guards", "call:trim", "tool", 10, 6, 0, "read", 0, "trim-root");
        insertTag(db, "ses-guards", "call:null-owner", "tool", 10, 7);
        insertTag(db, "ses-guards", "call:delete-a", "tool", 10, 8, 0, "read", 0, "delete-owner");
        insertTag(db, "ses-guards", "call:delete-b", "tool", 10, 9, 0, "grep", 0, "delete-owner");
        insertTag(db, "ses-guards", "call:keep", "tool", 10, 10, 0, "read", 0, "keep-owner");

        const orphan = getNullOwnerToolTag(db, "ses-guards", "call:null-owner");
        if (!orphan) throw new Error("expected NULL-owner fixture row");

        const guards = {
            fallbackApplied: adoptFallbackTagMessageId(
                db,
                "ses-guards",
                1,
                "pi-msg-0-fallback:p0",
                "real-message:p0",
            ),
            fallbackStale: adoptFallbackTagMessageId(
                db,
                "ses-guards",
                1,
                "pi-msg-0-fallback:p0",
                "other-message:p0",
            ),
            piTool: adoptPiFallbackToolOwnerTag(
                db,
                "ses-guards",
                2,
                "call:pi",
                "owner-old",
                "owner-real",
            ),
            piMessage: adoptPiFallbackMessageTag(
                db,
                "ses-guards",
                3,
                "pi-msg-1-fallback:p0",
                "real-pi-message:p0",
            ),
            compacted: markTagsCompactedByMessageIds(db, "ses-guards", ["trim-root"]),
            compactedAgain: markTagsCompactedByMessageIds(db, "ses-guards", ["trim-root"]),
            nullOwnerWon: adoptNullOwnerToolTag(db, orphan.id, "owner-claimed"),
            nullOwnerLost: adoptNullOwnerToolTag(db, orphan.id, "owner-late"),
            deleted: deleteToolTagsByOwner(db, "ses-guards", "delete-owner"),
        };
        const auditRows = withThrowawayTriggers
            ? (
                  db.prepare("SELECT COUNT(*) AS count FROM tag_write_audit").get() as {
                      count: number;
                  }
              ).count
            : 0;
        return { guards, auditRows };
    } finally {
        closeQuietly(db);
    }
}

describe("migration v86: session-local tag versions", () => {
    test("tag write guards ignore writes performed by current and future AFTER triggers", () => {
        const baseline = exerciseTagWriteGuards(false);
        const withThrowawayTriggers = exerciseTagWriteGuards(true);

        expect(withThrowawayTriggers.auditRows).toBeGreaterThan(0);
        expect(withThrowawayTriggers.guards).toEqual(baseline.guards);
        expect(withThrowawayTriggers.guards).toEqual({
            fallbackApplied: true,
            fallbackStale: false,
            piTool: { action: "rekeyed", tagNumber: 2 },
            piMessage: { action: "rekeyed", tagNumber: 3 },
            compacted: 3,
            compactedAgain: 0,
            nullOwnerWon: true,
            nullOwnerLost: false,
            deleted: 2,
        });
    });

    test("tag-first sessions keep the normal metadata row shape and preserve durable values", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            getOrCreateSessionMeta(db, "ses-normal");
            expect(
                db.prepare("SELECT 1 FROM session_meta WHERE session_id = ?").get("ses-tag-first"),
            ).toBeNull();

            insertTag(db, "ses-tag-first", "msg:p0", "message", 1, 1);
            const defaultColumns = `harness, last_response_time, cache_ttl, counter,
                last_nudge_tokens, last_nudge_band, last_transform_error, is_subagent,
                last_context_percentage, last_input_tokens, observed_safe_input_tokens,
                cache_alert_sent, times_execute_threshold_reached, compartment_in_progress,
                system_prompt_hash, cleared_reasoning_through_tag`;
            const normalDefaults = db
                .prepare(`SELECT ${defaultColumns} FROM session_meta WHERE session_id = ?`)
                .get("ses-normal");
            const triggerDefaults = db
                .prepare(`SELECT ${defaultColumns} FROM session_meta WHERE session_id = ?`)
                .get("ses-tag-first");

            db.prepare(
                `UPDATE session_meta
                 SET counter = 7,
                     cleared_reasoning_through_tag = 6,
                     tool_reclaim_watermark = 5,
                     last_response_time = NULL
                 WHERE session_id = ?`,
            ).run("ses-tag-first");
            const readBack = getOrCreateSessionMeta(db, "ses-tag-first");

            expect({
                counter: readBack.counter,
                clearedReasoningThroughTag: readBack.clearedReasoningThroughTag,
                toolReclaimWatermark: readBack.toolReclaimWatermark,
                lastResponseTime: readBack.lastResponseTime,
            }).toEqual({
                counter: 7,
                clearedReasoningThroughTag: 6,
                toolReclaimWatermark: 5,
                lastResponseTime: 0,
            });
            expect(triggerDefaults).toEqual(normalDefaults);
            expect(tagsVersion(db, "ses-tag-first")).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });

    test("upgrades v85 and advances only the session whose tag identity changed", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            db.exec(`
                DROP TRIGGER tags_version_ai;
                DROP TRIGGER tags_version_ad;
                DROP TRIGGER tags_version_au;
                ALTER TABLE session_meta DROP COLUMN tags_version;
            `);
            seedAppliedVersion(db, 85);
            db.prepare("INSERT INTO session_meta(session_id, counter) VALUES(?, 0)").run("ses-a");
            db.prepare("INSERT INTO session_meta(session_id, counter) VALUES(?, 0)").run("ses-b");

            runMigrations(db);
            expect(LATEST_SUPPORTED_VERSION).toBe(93);
            expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
            expect(tagsVersion(db, "ses-a")).toBe(0);
            expect(tagsVersion(db, "ses-b")).toBe(0);

            db.prepare(
                "INSERT INTO tags(session_id, message_id, type, byte_size, tag_number, harness) VALUES(?, ?, 'message', 1, 1, 'opencode')",
            ).run("ses-a", "msg-a:p0");
            expect(tagsVersion(db, "ses-a")).toBe(1);
            expect(tagsVersion(db, "ses-b")).toBe(0);

            db.prepare("UPDATE tags SET message_id = ? WHERE session_id = ?").run(
                "msg-a:p1",
                "ses-a",
            );
            expect(tagsVersion(db, "ses-a")).toBe(2);
        } finally {
            closeQuietly(db);
        }
    });
});
