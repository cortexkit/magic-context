/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    assertOpenCodeStoreGeneration,
    detectOpenCodeStoreGeneration,
    formatOpenCodeDbDoctorLine,
    formatOpenCodeDbMissingBanner,
    formatOpenCodeDbMissingStatusLine,
    openCodeDbPathExists,
    resetOpenCodeDbPathStateForTesting,
    resolveOpenCodeDbPath,
    sourceOpenCodeDatabaseFilename,
} from "./opencode-db-path";
import { Database } from "./sqlite";

const ORIGINAL_ENV = {
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    OPENCODE_DB: process.env.OPENCODE_DB,
    OPENCODE_DISABLE_CHANNEL_DB: process.env.OPENCODE_DISABLE_CHANNEL_DB,
    OPENCODE_CHANNEL: process.env.OPENCODE_CHANNEL,
};
const tempDirs: string[] = [];

function restore(name: keyof typeof ORIGINAL_ENV): void {
    const value = ORIGINAL_ENV[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

afterEach(() => {
    restore("XDG_DATA_HOME");
    restore("OPENCODE_DB");
    restore("OPENCODE_DISABLE_CHANNEL_DB");
    restore("OPENCODE_CHANNEL");
    resetOpenCodeDbPathStateForTesting();
    for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function useDataHome(): { dataHome: string; openCodeDir: string } {
    const dataHome = mkdtempSync(join(tmpdir(), "opencode-db-path-"));
    const openCodeDir = join(dataHome, "opencode");
    mkdirSync(openCodeDir, { recursive: true });
    tempDirs.push(dataHome);
    process.env.XDG_DATA_HOME = dataHome;
    delete process.env.OPENCODE_DB;
    delete process.env.OPENCODE_DISABLE_CHANNEL_DB;
    delete process.env.OPENCODE_CHANNEL;
    resetOpenCodeDbPathStateForTesting();
    return { dataHome, openCodeDir };
}

function createCandidate(openCodeDir: string, name: string, mtimeMs: number): string {
    const path = join(openCodeDir, name);
    writeFileSync(path, "sqlite fixture");
    const time = new Date(mtimeMs);
    utimesSync(path, time, time);
    return path;
}

describe("resolveOpenCodeDbPath", () => {
    it("honors absolute and relative OPENCODE_DB overrides before every other source", () => {
        const { openCodeDir } = useDataHome();
        const absolute = join(openCodeDir, "elsewhere.db");
        process.env.OPENCODE_DB = absolute;
        process.env.OPENCODE_DISABLE_CHANNEL_DB = "true";
        process.env.OPENCODE_CHANNEL = "dev";
        expect(resolveOpenCodeDbPath()).toEqual({
            path: absolute,
            source: "OPENCODE_DB",
            channel: null,
        });

        process.env.OPENCODE_DB = "relative.db";
        expect(resolveOpenCodeDbPath()).toEqual({
            path: join(openCodeDir, "relative.db"),
            source: "OPENCODE_DB",
            channel: null,
        });
    });

    it("treats OPENCODE_DB=:memory: as an explicit but absent store", () => {
        useDataHome();
        process.env.OPENCODE_DB = ":memory:";
        const resolution = resolveOpenCodeDbPath();
        expect(resolution).toEqual({ path: ":memory:", source: "OPENCODE_DB", channel: null });
        expect(openCodeDbPathExists(resolution)).toBe(false);
    });

    it("uses the default DB when channel databases are disabled", () => {
        const { openCodeDir } = useDataHome();
        process.env.OPENCODE_DISABLE_CHANNEL_DB = "1";
        process.env.OPENCODE_CHANNEL = "dev";
        expect(resolveOpenCodeDbPath()).toEqual({
            path: join(openCodeDir, "opencode.db"),
            source: "default",
            channel: null,
        });
    });

    it("honors an OPENCODE_CHANNEL visible to the plugin", () => {
        const { openCodeDir } = useDataHome();
        process.env.OPENCODE_CHANNEL = "dev";
        expect(resolveOpenCodeDbPath()).toEqual({
            path: join(openCodeDir, "opencode-dev.db"),
            source: "channel",
            channel: "dev",
        });
    });

    for (const selectedName of [
        "opencode.db",
        "opencode-local.db",
        "opencode-dev.db",
        "opencode-nightly.db",
    ]) {
        it(`discovers ${selectedName} when it is the newest existing candidate`, () => {
            const { openCodeDir } = useDataHome();
            const names = [
                "opencode.db",
                "opencode-local.db",
                "opencode-dev.db",
                "opencode-nightly.db",
            ];
            for (const [index, name] of names.entries()) {
                createCandidate(openCodeDir, name, name === selectedName ? 10_000 : 1_000 + index);
            }

            expect(resolveOpenCodeDbPath()).toEqual({
                path: join(openCodeDir, selectedName),
                source: "discovered",
                channel:
                    selectedName === "opencode.db"
                        ? null
                        : selectedName.slice("opencode-".length, -".db".length),
            });
        });
    }

    it("uses candidate order as the deterministic tie-breaker for equal mtimes", () => {
        const { openCodeDir } = useDataHome();
        for (const name of ["opencode-local.db", "opencode-dev.db", "opencode.db"]) {
            createCandidate(openCodeDir, name, 5_000);
        }
        expect(resolveOpenCodeDbPath()).toEqual({
            path: join(openCodeDir, "opencode.db"),
            source: "discovered",
            channel: null,
        });
    });

    it("returns the default path by value when no candidate exists", () => {
        const { openCodeDir } = useDataHome();
        const resolution = resolveOpenCodeDbPath();
        expect(resolution).toEqual({
            path: join(openCodeDir, "opencode.db"),
            source: "default",
            channel: null,
        });
        expect(openCodeDbPathExists(resolution)).toBe(false);
    });

    it("re-probes discovery when the memoized chosen file disappears", () => {
        const { openCodeDir } = useDataHome();
        const primary = createCandidate(openCodeDir, "opencode-local.db", 2_000);
        const fallback = createCandidate(openCodeDir, "opencode.db", 1_000);
        expect(resolveOpenCodeDbPath().path).toBe(primary);

        unlinkSync(primary);
        expect(resolveOpenCodeDbPath()).toEqual({
            path: fallback,
            source: "discovered",
            channel: null,
        });
    });

    it("uses the verbatim v2 channel filename table without changing v1 defaults", () => {
        const { dataHome, openCodeDir } = useDataHome();
        for (const channel of ["latest", "dev", "beta", "next", "prod"]) {
            expect(sourceOpenCodeDatabaseFilename("v2", channel, {})).toBe("opencode.db");
        }
        expect(sourceOpenCodeDatabaseFilename("v2", "a/b c!._-", {})).toBe("opencode-abc._-.db");
        expect(
            resolveOpenCodeDbPath("v2", {
                dataHome,
                channel: "local",
                env: { OPENCODE_DB: "opencode2.db" },
            }),
        ).toEqual({
            path: join(openCodeDir, "opencode2.db"),
            source: "OPENCODE_DB",
            channel: null,
        });
    });

    it("detects store generations and refuses a mismatched schema before reading", () => {
        const { openCodeDir } = useDataHome();
        const v1Path = join(openCodeDir, "v1.db");
        const v2Path = join(openCodeDir, "v2.db");
        const v1 = new Database(v1Path);
        const v2 = new Database(v2Path);
        try {
            v1.exec("CREATE TABLE message(id TEXT); CREATE TABLE part(id TEXT)");
            v2.exec("CREATE TABLE session_message(id TEXT)");
            expect(detectOpenCodeStoreGeneration(v1)).toBe("v1");
            expect(detectOpenCodeStoreGeneration(v2)).toBe("v2");
            expect(() => assertOpenCodeStoreGeneration(v2, "v1", v2Path)).toThrow(
                "expected v1, found v2",
            );
            expect(() => assertOpenCodeStoreGeneration(v1, "v2", v1Path)).toThrow(
                "expected v2, found v1",
            );
        } finally {
            v1.close();
            v2.close();
        }
    });

    it("reads a live OpenCode 1.18.x store as v1 even though it ships session_message", () => {
        const { openCodeDir } = useDataHome();
        const livePath = join(openCodeDir, "live-v1.db");
        const live = new Database(livePath);
        try {
            // Captured from a running OpenCode 1.18.30 store. session_message exists in v1,
            // so a detector keyed on its presence calls a v1 host v2 and every v1 reader
            // (historian chunk, marker discovery, message index, tool-owner backfill) then
            // refuses. Keep this table list as observed, not as remembered.
            for (const table of [
                "account",
                "event",
                "message",
                "part",
                "permission",
                "project",
                "session",
                "session_message",
                "session_run_lease",
                "todo",
                "workspace",
            ]) {
                live.exec(`CREATE TABLE ${table}(id TEXT)`);
            }
            expect(detectOpenCodeStoreGeneration(live)).toBe("v1");
            expect(() => assertOpenCodeStoreGeneration(live, "v1", livePath)).not.toThrow();
            expect(() => assertOpenCodeStoreGeneration(live, "v2", livePath)).toThrow(
                "expected v2, found v1",
            );
        } finally {
            live.close();
        }
    });

    it("accepts a v1 store migrated to OpenCode 2 for v2 readers, and still for v1 readers", () => {
        const { openCodeDir } = useDataHome();
        const migratedPath = join(openCodeDir, "migrated-v2.db");
        const migrated = new Database(migratedPath);
        try {
            // Captured from an OpenCode 2.0.7 store that the v2 host migrated from a 1.18.x
            // store: it keeps the v1 `message`/`part` tables beside its own schema, so it
            // carries BOTH generations. `session_v2` is written only by an OpenCode 2 host
            // (the 1.18.31 binary never references it). Keep this table list as observed.
            for (const table of [
                "account",
                "account_state",
                "control_account",
                "credential",
                "event",
                "event_sequence",
                "instruction_blob",
                "instruction_entry",
                "instruction_state",
                "kv",
                "message",
                "migration",
                "part",
                "permission",
                "project",
                "project_directory",
                "session",
                "session_inbox",
                "session_message",
                "session_pending",
                "session_share",
                "session_v2",
                "todo",
                "workspace",
                "worktree",
            ]) {
                migrated.exec(`CREATE TABLE ${table}(id TEXT)`);
            }
            expect(() => assertOpenCodeStoreGeneration(migrated, "v2", migratedPath)).not.toThrow();
            expect(() => assertOpenCodeStoreGeneration(migrated, "v1", migratedPath)).not.toThrow();
        } finally {
            migrated.close();
        }
    });

    it("reads a fresh OpenCode 2 store as v2 only", () => {
        const { openCodeDir } = useDataHome();
        const freshV2Path = join(openCodeDir, "fresh-v2.db");
        const freshV2 = new Database(freshV2Path);
        try {
            // Captured from a new OpenCode 2.0.7 data directory: no v1 message tables.
            for (const table of [
                "account",
                "event",
                "migration",
                "permission",
                "project",
                "session_inbox",
                "session_message",
                "session_pending",
                "session_v2",
                "workspace",
            ]) {
                freshV2.exec(`CREATE TABLE ${table}(id TEXT)`);
            }
            expect(detectOpenCodeStoreGeneration(freshV2)).toBe("v2");
            expect(() => assertOpenCodeStoreGeneration(freshV2, "v2", freshV2Path)).not.toThrow();
            expect(() => assertOpenCodeStoreGeneration(freshV2, "v1", freshV2Path)).toThrow(
                "expected v1, found v2",
            );
        } finally {
            freshV2.close();
        }
    });

    it("treats a store with no schema yet as empty rather than as a conflicting host", () => {
        const { openCodeDir } = useDataHome();
        const freshPath = join(openCodeDir, "fresh.db");
        const fresh = new Database(freshPath);
        try {
            // A host that has not written its first row looks like this. Readers have always
            // seen it as empty; refusing here throws inside the historian, marker and index
            // readers on every fresh data directory.
            expect(detectOpenCodeStoreGeneration(fresh)).toBe("unknown");
            expect(() => assertOpenCodeStoreGeneration(fresh, "v1", freshPath)).not.toThrow();
            expect(() => assertOpenCodeStoreGeneration(fresh, "v2", freshPath)).not.toThrow();
        } finally {
            fresh.close();
        }
    });

    it("formats the missing banner, status, and doctor lines by value", () => {
        const { openCodeDir } = useDataHome();
        const lookedFor = [
            join(openCodeDir, "opencode.db"),
            join(openCodeDir, "opencode-local.db"),
            join(openCodeDir, "opencode-dev.db"),
            join(openCodeDir, "opencode-<channel>.db"),
        ].join(", ");
        const resolution = resolveOpenCodeDbPath();

        expect(formatOpenCodeDbMissingBanner(resolution)).toBe(
            `Magic Context cannot find OpenCode's session database (looked for ${lookedFor}). History compaction (historian) and the mid-turn valve are disabled until it is found; set OPENCODE_DB if OpenCode stores it elsewhere.`,
        );
        expect(formatOpenCodeDbMissingStatusLine(resolution)).toBe(
            `OpenCode DB: MISSING (looked for ${lookedFor}). History compaction (historian) and the mid-turn valve are disabled; set OPENCODE_DB if OpenCode stores it elsewhere.`,
        );
        expect(formatOpenCodeDbDoctorLine(resolution)).toBe(
            `FAIL OpenCode session database: not found (looked for ${lookedFor}); set OPENCODE_DB if OpenCode stores it elsewhere.`,
        );
    });
});
