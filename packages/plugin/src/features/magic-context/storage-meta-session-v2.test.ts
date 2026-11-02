import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resetSubagentPolicy, setSubagentPolicy } from "../../plugin/subagent-policy";
import { hideSubagentTools, resolveStoredSubagentMode } from "../../plugin/subagent-tool-policy";
import { _resetHarnessForTesting, setHarness } from "../../shared/harness";
import { resetOpenCodeDbPathStateForTesting } from "../../shared/opencode-db-path";
import { Database } from "../../shared/sqlite";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { V2StoreReader } from "../../v2/store-reader";
import { initializeDatabase } from "./storage-db";
import { getOrCreateSessionMeta, updateSessionMeta } from "./storage-meta-session";

let root: string;
let host: Database;
let meta: Database;
const originalDataHome = process.env.XDG_DATA_HOME;
const originalDb = process.env.OPENCODE_DB;

beforeEach(() => {
    root = createTestTempDir("mc-session-meta-v2-").dir;
    process.env.XDG_DATA_HOME = root;
    process.env.OPENCODE_DB = "opencode2.db";
    resetOpenCodeDbPathStateForTesting();
    _resetHarnessForTesting();
    setHarness("opencode2");
    mkdirSync(join(root, "opencode"));
    host = new Database(join(root, "opencode", "opencode2.db"));
    host.exec(`
        CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT);
        CREATE TABLE session_message (id TEXT PRIMARY KEY);
        -- A converted store can retain the v1 table. It is not the authority.
        CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT);
        INSERT INTO session_v2 VALUES ('child', 'parent'), ('parent', NULL), ('empty', '');
        INSERT INTO session VALUES ('child', NULL), ('parent', 'wrong-parent');
    `);
    meta = new Database(":memory:");
    initializeDatabase(meta);
});

afterEach(() => {
    resetSubagentPolicy();
    meta.close();
    host.close();
    _resetHarnessForTesting();
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalDataHome;
    if (originalDb === undefined) delete process.env.OPENCODE_DB;
    else process.env.OPENCODE_DB = originalDb;
    resetOpenCodeDbPathStateForTesting();
    rmSync(root, { recursive: true, force: true });
});

test("OC2 meta creation uses session_v2.parent_id before the first pass", () => {
    meta.exec(`
        CREATE TABLE creation_modes (session_id TEXT, is_subagent INTEGER);
        CREATE TRIGGER capture_creation_mode AFTER INSERT ON session_meta BEGIN
            INSERT INTO creation_modes VALUES (new.session_id, new.is_subagent);
        END;
    `);
    expect(getOrCreateSessionMeta(meta, "child").isSubagent).toBe(true);
    expect(
        meta.prepare("SELECT is_subagent FROM session_meta WHERE session_id = 'child'").get(),
    ).toEqual({ is_subagent: 1 });
    expect(
        meta.prepare("SELECT is_subagent FROM creation_modes WHERE session_id = 'child'").get(),
    ).toEqual({ is_subagent: 1 });
    expect(getOrCreateSessionMeta(meta, "parent").isSubagent).toBe(false);
    expect(getOrCreateSessionMeta(meta, "empty").isSubagent).toBe(false);
});

test("OC2 existing meta rows keep their mode across upgrades and later parent changes", () => {
    // A child first seen by the old plugin already has a primary-mode baseline.
    updateSessionMeta(meta, "child", { isSubagent: false });
    expect(getOrCreateSessionMeta(meta, "child").isSubagent).toBe(false);
    expect(getOrCreateSessionMeta(meta, "parent").isSubagent).toBe(false);
    host.exec("UPDATE session_v2 SET parent_id = 'new-parent' WHERE id = 'parent'");
    expect(getOrCreateSessionMeta(meta, "parent").isSubagent).toBe(false);
    updateSessionMeta(meta, "empty", { isSubagent: true });
    expect(getOrCreateSessionMeta(meta, "empty").isSubagent).toBe(true);
});

for (const unavailable of ["missing", "throwing"] as const) {
    test(`OC2 retries a ${unavailable} parent read without persisting primary`, () => {
        if (unavailable === "throwing")
            host.exec("ALTER TABLE session_v2 RENAME COLUMN parent_id TO unreadable_parent");
        const id = unavailable === "missing" ? "late-child" : "child";
        expect(getOrCreateSessionMeta(meta, id).isSubagent).toBe(false);
        expect(
            meta.prepare("SELECT is_subagent FROM session_meta WHERE session_id = ?").get(id),
        ).toEqual({ is_subagent: null });
        updateSessionMeta(meta, id, { counter: 7, lastInputTokens: 1234 });
        expect(
            meta.prepare("SELECT is_subagent FROM session_meta WHERE session_id = ?").get(id),
        ).toEqual({ is_subagent: null });
        if (unavailable === "throwing")
            host.exec("ALTER TABLE session_v2 RENAME COLUMN unreadable_parent TO parent_id");
        else host.prepare("INSERT INTO session_v2 VALUES (?, 'parent')").run(id);
        expect(getOrCreateSessionMeta(meta, id)).toMatchObject({
            isSubagent: true,
            counter: 7,
            lastInputTokens: 1234,
        });
        expect(
            meta.prepare("SELECT is_subagent FROM session_meta WHERE session_id = ?").get(id),
        ).toEqual({ is_subagent: 1 });
    });
}

test("OC2 resolves metadata written before the parent lookup and confirms primary only on a successful read", () => {
    updateSessionMeta(meta, "late-primary", { counter: 9 });
    expect(
        meta
            .prepare("SELECT is_subagent FROM session_meta WHERE session_id = 'late-primary'")
            .get(),
    ).toEqual({ is_subagent: null });
    expect(getOrCreateSessionMeta(meta, "late-primary")).toMatchObject({
        isSubagent: false,
        counter: 9,
    });
    host.exec("INSERT INTO session_v2 VALUES ('late-primary', NULL)");
    expect(getOrCreateSessionMeta(meta, "late-primary")).toMatchObject({
        isSubagent: false,
        counter: 9,
    });
    expect(
        meta
            .prepare("SELECT is_subagent FROM session_meta WHERE session_id = 'late-primary'")
            .get(),
    ).toEqual({ is_subagent: 0 });
});

test("OC2 caps parent read retries, then retries after cooldown without making unknown primary", () => {
    const read = spyOn(V2StoreReader.prototype, "isSubagent").mockReturnValue(null);
    const clock = spyOn(Date, "now").mockReturnValue(1000);
    try {
        for (let i = 0; i < 20; i++) getOrCreateSessionMeta(meta, "late-child");
        expect(read).toHaveBeenCalledTimes(5);
        expect(
            meta
                .prepare("SELECT is_subagent FROM session_meta WHERE session_id = 'late-child'")
                .get(),
        ).toEqual({ is_subagent: null });
        clock.mockReturnValue(31_001);
        read.mockReturnValue(true);
        expect(getOrCreateSessionMeta(meta, "late-child").isSubagent).toBe(true);
        expect(read).toHaveBeenCalledTimes(6);
        expect(getOrCreateSessionMeta(meta, "late-child").isSubagent).toBe(true);
        expect(read).toHaveBeenCalledTimes(6);
    } finally {
        read.mockRestore();
        clock.mockRestore();
    }
});

test("OC2 keeps a compressed child a child for the stored-fact gates on its first pass", () => {
    setSubagentPolicy({ compress: true, memoryWrite: false });
    // No session_meta row yet: this is the order the transform uses
    // (hideSubagentTools runs before the pass stores the row).
    const draft = {
        sessionID: "child",
        tools: { ctx_memory: {}, ctx_note: {}, ctx_search: {} },
    };
    hideSubagentTools(draft, meta);
    expect(Object.keys(draft.tools)).toEqual(["ctx_search"]);
    // The row now exists and still records the parent link...
    expect(
        meta.prepare("SELECT is_subagent FROM session_meta WHERE session_id = 'child'").get(),
    ).toEqual({ is_subagent: 1 });
    // ...while the presentation projection hides it from the reduced-path gates.
    expect(getOrCreateSessionMeta(meta, "child").isSubagent).toBe(false);
    expect(resolveStoredSubagentMode(meta, "child")).toBe(true);
});
