import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { upsertCommits } from "@magic-context/core/features/magic-context/git-commits/storage-git-commits";
import { runMigrations } from "@magic-context/core/features/magic-context/migrations";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { Database } from "@magic-context/core/shared/sqlite";
import { createTestTempDir } from "../../../plugin/src/shared/test-temp-dir";
import { inspectGitFtsMap, runDoctorGitFtsMap, runDoctorGitFtsMapCli } from "./doctor-git-fts-map";

let root: string, data: string, lines: string[];
beforeEach(() => {
    root = createTestTempDir("git-fts-map-doctor-").dir;
    data = join(root, "data");
    mkdirSync(data);
    const db = new Database(join(data, "context.db"));
    initializeDatabase(db);
    runMigrations(db);
    upsertCommits(db, "project", [
        { sha: "sha-a", shortSha: "a", message: "old cache", author: "fixture", committedAtMs: 1 },
    ]);
    db.exec(
        "INSERT INTO git_commits_fts(rowid,sha,project_path,message) VALUES(7,123,'project','numeric legacy'); INSERT INTO git_commit_fts_rowid_map VALUES(7,123)",
    );
    db.close();
    const store = new Database(join(data, "store.db"));
    store.exec("CREATE TABLE pair(value TEXT); INSERT INTO pair VALUES('unchanged store')");
    store.close();
    lines = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const deps = () => ({
    storageDir: data,
    inspectHolders: () => ({ safe: true, blockers: [] }),
    print: (line: string) => lines.push(line),
});
function mutate(sql: string) {
    const db = new Database(join(data, "context.db"));
    try {
        db.exec(sql);
    } finally {
        db.close();
    }
}
function read(path = join(data, "context.db")) {
    return new Database(path, { readonly: true });
}

test("read-only doctor detects missing, wrong and extra map entries without repairing", () => {
    mutate(
        "DELETE FROM git_commit_fts_rowid_map WHERE fts_rowid=1; UPDATE git_commit_fts_rowid_map SET sha='wrong' WHERE fts_rowid=7; INSERT INTO git_commit_fts_rowid_map VALUES(99,'extra')",
    );
    expect(runDoctorGitFtsMap({}, deps())).toBe(1);
    const db = read();
    try {
        expect(inspectGitFtsMap(db)).toEqual({
            indexed: true,
            mapPresent: true,
            missing: 1,
            mismatched: 1,
            extra: 1,
        });
    } finally {
        db.close();
    }
    expect(lines.join("\n")).toContain("doctor git-fts-map --repair");
});

test("offline repair verifies a paired backup before replacing only map inventory", () => {
    mutate("DELETE FROM git_commit_fts_rowid_map; DELETE FROM schema_migrations WHERE version=95");
    const before = read();
    const fts = before.prepare("SELECT rowid,* FROM git_commits_fts ORDER BY rowid").all();
    const meta = before.prepare("SELECT * FROM session_meta").all();
    before.close();
    let verified = false;
    expect(
        runDoctorGitFtsMap(
            { repair: true },
            {
                ...deps(),
                print: (line) => {
                    if (line.startsWith("Paired backup verified:")) {
                        const folder = join(
                            data,
                            "backups",
                            readdirSync(join(data, "backups"))[0]!,
                        );
                        const backup = read(join(folder, "context.db"));
                        const store = read(join(folder, "store.db"));
                        try {
                            expect(
                                backup
                                    .prepare("SELECT count(*) AS n FROM git_commit_fts_rowid_map")
                                    .get(),
                            ).toEqual({ n: 0 });
                            expect(store.prepare("SELECT value FROM pair").get()).toEqual({
                                value: "unchanged store",
                            });
                            verified = true;
                        } finally {
                            backup.close();
                            store.close();
                        }
                    }
                    lines.push(line);
                },
            },
        ),
    ).toBe(0);
    expect(verified).toBe(true);
    const after = new Database(join(data, "context.db"));
    try {
        expect(inspectGitFtsMap(after)).toEqual({
            indexed: true,
            mapPresent: true,
            missing: 0,
            mismatched: 0,
            extra: 0,
        });
        expect(after.prepare("SELECT rowid,* FROM git_commits_fts ORDER BY rowid").all()).toEqual(
            fts,
        );
        expect(after.prepare("SELECT * FROM session_meta").all()).toEqual(meta);
        expect(after.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({
            v: 94,
        });
        expect(
            after
                .prepare("SELECT typeof(sha) AS t FROM git_commit_fts_rowid_map WHERE fts_rowid=7")
                .get(),
        ).toEqual({ t: "integer" });
        runMigrations(after);
        expect(after.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({
            v: 95,
        });
    } finally {
        after.close();
    }
});

test("repair refuses a live or uncertain holder before creating backups or mutating", () => {
    mutate("DELETE FROM git_commit_fts_rowid_map");
    expect(
        runDoctorGitFtsMap(
            { repair: true },
            {
                ...deps(),
                inspectHolders: () => ({ safe: false, blockers: ["OpenCode server PID 42"] }),
            },
        ),
    ).toBe(2);
    expect(readdirSync(data)).not.toContain("backups");
    const db = read();
    try {
        expect(inspectGitFtsMap(db).missing).toBe(2);
    } finally {
        db.close();
    }
});

test("repair rechecks holders under both locks and rolls back if a host appears", () => {
    mutate("DELETE FROM git_commit_fts_rowid_map");
    let inspections = 0;
    expect(
        runDoctorGitFtsMap(
            { repair: true },
            {
                ...deps(),
                inspectHolders: () =>
                    ++inspections === 1
                        ? { safe: true, blockers: [] }
                        : { safe: false, blockers: ["new holder"] },
            },
        ),
    ).toBe(2);
    expect(inspections).toBe(2);
    expect(readdirSync(data)).not.toContain("backups");
    const db = read();
    try {
        expect(inspectGitFtsMap(db).missing).toBe(2);
    } finally {
        db.close();
    }
});

test("failed verification rolls back repair while retaining the paired backup", () => {
    mutate("DELETE FROM git_commit_fts_rowid_map");
    expect(
        runDoctorGitFtsMap(
            { repair: true },
            {
                ...deps(),
                verify: () => {
                    throw new Error("injected verify failure");
                },
            },
        ),
    ).toBe(2);
    const db = read();
    try {
        expect(inspectGitFtsMap(db).missing).toBe(2);
    } finally {
        db.close();
    }
    expect(readdirSync(join(data, "backups"))).toHaveLength(1);
});

// Interference after the INSERT must be caught by the real verifier, not just
// an injected exception at its test seam. Each case isolates one inventory error.
for (const [damage, interference] of [
    ["a missing row", "DELETE FROM git_commit_fts_rowid_map WHERE fts_rowid=NEW.fts_rowid"],
    ["an extra row", "INSERT INTO git_commit_fts_rowid_map VALUES(99,'extra')"],
    [
        "a wrong SHA storage class",
        "UPDATE git_commit_fts_rowid_map SET sha=123.0 WHERE fts_rowid=NEW.fts_rowid",
    ],
] as const) {
    test(`repair verification rejects ${damage} introduced during the map rewrite`, () => {
        mutate(`DELETE FROM git_commit_fts_rowid_map;
            CREATE TRIGGER interfere_with_map AFTER INSERT ON git_commit_fts_rowid_map
            WHEN NEW.fts_rowid=7 BEGIN ${interference}; END`);
        expect(runDoctorGitFtsMap({ repair: true }, deps())).toBe(2);
        expect(lines.join("\n")).toContain("git FTS map verification failed; repair rolled back");
        const db = read();
        try {
            expect(db.prepare("SELECT count(*) AS n FROM git_commit_fts_rowid_map").get()).toEqual({
                n: 0,
            });
            expect(
                db.prepare("SELECT sha,message FROM git_commits_fts WHERE rowid=7").get(),
            ).toEqual({ sha: 123, message: "numeric legacy" });
        } finally {
            db.close();
        }
        expect(readdirSync(join(data, "backups"))).toHaveLength(1);
    });
}

test("missing-map recovery is offline and does not touch FTS or its ledger", () => {
    mutate("DROP TABLE git_commit_fts_rowid_map");
    expect(runDoctorGitFtsMap({}, deps())).toBe(1);
    expect(runDoctorGitFtsMap({ repair: true }, deps())).toBe(0);
    const db = read();
    try {
        expect(inspectGitFtsMap(db).missing).toBe(0);
        expect(db.prepare("SELECT count(*) AS n FROM git_commits_fts").get()).toEqual({ n: 2 });
    } finally {
        db.close();
    }
});

test("a missing companion store prevents unpaired repair", () => {
    rmSync(join(data, "store.db"));
    expect(runDoctorGitFtsMap({ repair: true }, deps())).toBe(2);
    expect(lines.join("\n")).toContain("Both context.db and store.db must exist");
});

test("help and bad arguments never open or mutate a database", () => {
    expect(runDoctorGitFtsMapCli(["--help"])).toBe(0);
    expect(runDoctorGitFtsMapCli(["--repair", "--unknown"])).toBe(2);
});
