import { afterEach, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage-meta";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { resolveContextLimit } from "./event-resolvers";
import { resolveOpenCodeProvenInputFloor } from "./opencode-proven-floor";
import { closeReadOnlySessionDb } from "./read-session-db";

const previousDataHome = process.env.XDG_DATA_HOME;
let root: string | undefined;
afterEach(() => {
    closeReadOnlySessionDb();
    if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousDataHome;
    if (root) rmSync(root, { recursive: true, force: true });
});

it("TS and Rust host resolution clamp a legacy 8732692 floor to measured accepted inputs", () => {
    root = createTestTempDirFromPath(join(tmpdir(), "mc-measured-floor-"));
    process.env.XDG_DATA_HOME = root;
    mkdirSync(join(root, "opencode"));
    const rawDb = new Database(join(root, "opencode", "opencode.db"));
    rawDb.exec("CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, data TEXT)");
    const sessionId = "ses-upgrade-floor";
    const add = (id: string, input: number, extra: Record<string, unknown> = {}) =>
        rawDb.prepare("INSERT INTO message VALUES (?, ?, ?)").run(
            id,
            sessionId,
            JSON.stringify({
                role: "assistant",
                providerID: "cursor",
                modelID: "grok-4.7",
                finish: "stop",
                tokens: { input, cache: { read: 0, write: 0 } },
                ...extra,
            }),
        );
    add("a", 757_872);
    add("b", 1_328_370);
    add("c", 8_732_692, { finish: "error" });
    add("d", 8_732_692, { modelID: "other" });
    add("e", 8_732_692, { role: "user" });
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    try {
        updateSessionMeta(db, sessionId, {
            observedSafeInputTokens: 8_732_692,
            lastObservedModelKey: "cursor/grok-4.7",
            lastInputTokens: 834_492,
            lastUsageContextLimit: 8_732_692,
        });
        expect(resolveContextLimit("cursor", "grok-4.7", { db, sessionID: sessionId })).toBe(
            1_328_370,
        );
        expect(getOrCreateSessionMeta(db, sessionId).observedSafeInputTokens).toBe(1_328_370);
        // The basis survives restart and does not depend on reading the same row twice.
        closeReadOnlySessionDb();
        expect(resolveOpenCodeProvenInputFloor(db, sessionId, "cursor/grok-4.7")).toBe(1_328_370);
    } finally {
        closeQuietly(rawDb);
        closeQuietly(db);
    }
});
