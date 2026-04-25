/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeReadOnlySessionDb } from "../../hooks/magic-context/read-session-db";
import { Database } from "../../shared/sqlite";
import { resolveIsSubagentFromOpenCodeDb } from "./resolve-subagent-fallback";

/**
 * Regression tests for the subagent-detection fallback that bridges the race
 * between OpenCode creating a session and the async `session.created` event
 * reaching our handler.
 */
describe("resolveIsSubagentFromOpenCodeDb", () => {
    let tempDir: string;
    let originalXdg: string | undefined;
    let openCodeDb: Database | null = null;

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), "mc-subagent-fallback-"));
        originalXdg = process.env.XDG_DATA_HOME;
        process.env.XDG_DATA_HOME = tempDir;

        // Build the OpenCode DB at the path the helper resolves to.
        const dbDir = join(tempDir, "opencode");
        mkdirSync(dbDir, { recursive: true });
        openCodeDb = new Database(join(dbDir, "opencode.db"));
        openCodeDb.exec(`
            CREATE TABLE session (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL DEFAULT 'proj',
                parent_id TEXT,
                slug TEXT NOT NULL DEFAULT '',
                directory TEXT NOT NULL DEFAULT '/tmp',
                title TEXT NOT NULL DEFAULT '',
                version TEXT NOT NULL DEFAULT '',
                time_created INTEGER NOT NULL DEFAULT 0,
                time_updated INTEGER NOT NULL DEFAULT 0
            )
        `);
    });

    afterEach(() => {
        closeReadOnlySessionDb();
        openCodeDb?.close();
        openCodeDb = null;
        if (originalXdg === undefined) {
            process.env.XDG_DATA_HOME = undefined;
        } else {
            process.env.XDG_DATA_HOME = originalXdg;
        }
        rmSync(tempDir, { recursive: true, force: true });
    });

    it("returns true for a child session with a non-empty parent_id", () => {
        openCodeDb
            ?.prepare("INSERT INTO session (id, parent_id) VALUES ('ses_child', 'ses_parent')")
            .run();

        expect(resolveIsSubagentFromOpenCodeDb("ses_child")).toBe(true);
    });

    it("returns false for a primary session with NULL parent_id", () => {
        openCodeDb
            ?.prepare("INSERT INTO session (id, parent_id) VALUES ('ses_primary', NULL)")
            .run();

        expect(resolveIsSubagentFromOpenCodeDb("ses_primary")).toBe(false);
    });

    it("returns false for a primary session with empty-string parent_id", () => {
        openCodeDb?.prepare("INSERT INTO session (id, parent_id) VALUES ('ses_empty', '')").run();

        expect(resolveIsSubagentFromOpenCodeDb("ses_empty")).toBe(false);
    });

    it("returns null when the session row doesn't exist yet", () => {
        // OpenCode normally writes the session row synchronously as part of
        // Session.create() before returning the ID, so this case should be
        // rare. But when it happens, we must return null (not false) so
        // callers default to primary behavior without storing a bogus flag.
        expect(resolveIsSubagentFromOpenCodeDb("ses_missing")).toBe(null);
    });
});
