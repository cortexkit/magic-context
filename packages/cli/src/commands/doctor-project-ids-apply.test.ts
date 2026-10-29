import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    initializeDatabase,
    runMigrations,
} from "@magic-context/core/features/magic-context/storage";
import { mergeProjectIdentities } from "@magic-context/core/features/magic-context/storage-identity-merge";
import { Database } from "@magic-context/core/shared/sqlite";
import * as storagePermissions from "@magic-context/core/shared/storage-permissions";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import * as databaseAccess from "../lib/database-access";
import { runMergeIdentityCli } from "./doctor-merge-identity";
import { buildProjectIdPlan, type ProjectIdPlan, runProjectIdsCli } from "./doctor-project-ids";
import { fakeProjectEndpoint, linkedCheckoutFixture } from "./doctor-project-ids.test-support";
import {
    type ProjectIdsApplyDeps,
    parseProjectIdsApplyArgs,
    preflightProjectIdApply,
} from "./doctor-project-ids-apply";

let root: string;
let dbPath: string;
let db: Database;
const from = "git:old";
const to = "pj-11111111-1111-4111-8111-111111111111";
const deps: ProjectIdsApplyDeps = {
    inspectHolders: () => ({ safe: true, blockers: [] }),
    probe: () => ({ status: "free" }),
    freeBytes: () => Number.MAX_SAFE_INTEGER,
};

beforeEach(() => {
    root = realpathSync(createTestTempDirFromPath(join(tmpdir(), "mc-project-ids-apply-")));
    dbPath = join(root, "context.db");
    db = new Database(dbPath);
    initializeDatabase(db);
    runMigrations(db);
});
afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
});

function folder(name: string): string {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    return path;
}
function sidecar(directory: string, identity = from): string {
    folder("project-identities");
    const path = sidecarPath(directory);
    writeFileSync(path, JSON.stringify({ directory, identity }));
    return path;
}
function sidecarPath(directory: string): string {
    return join(
        root,
        "project-identities",
        `${createHash("sha256").update(directory).digest("hex")}.json`,
    );
}
function hostDatabase(): string {
    const path = join(root, "planned-host.db");
    const host = new Database(path);
    host.exec("CREATE TABLE session(id TEXT, directory TEXT)");
    host.prepare("INSERT INTO session VALUES ('host-session', ?)").run(folder("host-folder"));
    host.close();
    db.prepare(
        "INSERT INTO session_projects(session_id, harness, project_path, updated_at) VALUES ('host-session', 'opencode', ?, 1)",
    ).run(from);
    return path;
}
async function makePlan(hostDbPath: string | null = null): Promise<ProjectIdPlan> {
    db.prepare("INSERT INTO project_state(project_path) VALUES (?)").run(from);
    sidecar(folder("checkout"));
    return buildProjectIdPlan(db, dbPath, hostDbPath, {
        now: () => new Date("2026-10-15T10:11:12Z"),
        resolve: async () => ({
            status: "resolved",
            via: "root",
            projectId: to,
            canonicalRoot: null,
        }),
    });
}
function check(plan: ProjectIdPlan, overrides: Partial<ProjectIdsApplyDeps> = {}) {
    return preflightProjectIdApply(plan, { dbPath }, { ...deps, ...overrides });
}
function planFile(plan: ProjectIdPlan): string {
    const path = join(root, "plan.json");
    writeFileSync(path, JSON.stringify(plan));
    return path;
}
function bytes(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

it("repairs root pin common-dir metadata when re-running apply on an already-applied store", async () => {
    const main = folder("registered-root");
    folder("registered-root/.git");
    const path = sidecar(main, to);
    writeFileSync(join(root, "project-identities", `${"0".repeat(64)}.json`), "null");
    db.prepare("INSERT INTO project_state(project_path) VALUES (?)").run(to);
    const plan = await buildProjectIdPlan(db, dbPath, null, {
        resolve: async () => {
            throw new Error("No legacy ids remain");
        },
    });
    expect(plan.pairs).toEqual([]);
    expect((await apply(plan)).code).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        directory: main,
        identity: to,
        gitCommonDir: join(main, ".git"),
    });
    const repaired = bytes(path);
    const backupCount = backups().length;
    expect((await apply(plan)).code).toBe(0);
    expect(bytes(path)).toBe(repaired);
    expect(backups()).toHaveLength(backupCount);
});

const second = "dir:second";
async function orderedPlan(): Promise<ProjectIdPlan> {
    db.prepare("INSERT INTO project_state(project_path) VALUES (?)").run(second);
    sidecar(folder("second"), second);
    const plan = await makePlan();
    plan.pairs = [from, second].map((identity) => {
        const pair = plan.pairs.find((candidate) => candidate.from === identity);
        if (!pair) throw new Error(`Missing fixture pair: ${identity}`);
        return pair;
    });
    return plan;
}
function backups(): string[] {
    return readdirSync(root).filter((entry) => entry.startsWith("project-ids-backup-"));
}
function mappings(): unknown[] {
    return db
        .prepare(
            "SELECT old_project_path, new_project_path FROM v22_identity_rekey_map ORDER BY old_project_path",
        )
        .all();
}
async function apply(plan: ProjectIdPlan): Promise<{ code: number; statuses: string[] }> {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
        const code = await runProjectIdsCli(["apply", planFile(plan), "--db", dbPath], deps);
        const statuses = log.mock.calls
            .flat()
            .map(String)
            .filter((line) => /: (applied|pins repaired|already applied)$/.test(line));
        return { code, statuses };
    } finally {
        log.mockRestore();
    }
}

async function killedApply(plan: ProjectIdPlan, point: "committed" | "applied"): Promise<void> {
    const path = planFile(plan);
    const source = `
        import { spyOn } from 'bun:test';
        import { writeSync } from 'node:fs';
        import * as permissions from ${JSON.stringify(join(import.meta.dir, "../../../plugin/src/shared/storage-permissions.ts"))};
        import { runProjectIdsCli } from ${JSON.stringify(join(import.meta.dir, "doctor-project-ids.ts"))};
        const kill = () => { writeSync(1, 'KILL CHECKPOINT\\n'); process.kill(process.pid, 'SIGKILL'); };
        if (${JSON.stringify(point)} === 'committed') {
            const write = permissions.writeStorageFileAtomicSync;
            spyOn(permissions, 'writeStorageFileAtomicSync').mockImplementation((path, ...args) => {
                if (path === ${JSON.stringify(sidecarPath(plan.pairs[0].folders[0].directory))}) kill();
                return write(path, ...args);
            });
        } else {
            const log = console.log;
            spyOn(console, 'log').mockImplementation((...args) => {
                log(...args);
                if (args[0] === ${JSON.stringify(`${from} → ${to}: applied`)}) kill();
            });
        }
        const code = await runProjectIdsCli(['apply', ${JSON.stringify(path)}, '--db', ${JSON.stringify(dbPath)}], {
            inspectHolders: () => ({ safe: true, blockers: [] }),
            probe: () => ({ status: 'free' }),
            freeBytes: () => Number.MAX_SAFE_INTEGER,
        });
        process.exit(code);
    `;
    const child = Bun.spawn([process.execPath, "--eval", source], {
        cwd: import.meta.dir,
        env: {
            ...process.env,
            HOME: root,
            XDG_DATA_HOME: join(root, "data"),
            XDG_CONFIG_HOME: join(root, "config"),
            XDG_STATE_HOME: join(root, "state"),
            XDG_RUNTIME_DIR: join(root, "runtime"),
            OPENCODE_DB: join(root, "host.db"),
            MAGIC_CONTEXT_STORAGE_DIR: root,
        },
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
    });
    const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
    ]);
    expect({ checkpoint: stdout.includes("KILL CHECKPOINT"), stderr }).toEqual({
        checkpoint: true,
        stderr: "",
    });
    expect(code).not.toBe(0);
}

describe("doctor project-ids apply preflight", () => {
    for (const checkOnly of [true, false])
        it(`names skipped host session observations during apply${checkOnly ? " --check" : ""}`, async () => {
            const plan = await makePlan();
            const output = spyOn(console, "log").mockImplementation(() => {});
            try {
                expect(
                    await runProjectIdsCli(
                        [
                            "apply",
                            ...(checkOnly ? ["--check"] : []),
                            planFile(plan),
                            "--db",
                            dbPath,
                        ],
                        deps,
                    ),
                ).toBe(0);
                expect(output.mock.calls.flat().join("\n")).toContain(
                    "Skipped host session observations: plan has no host database; re-plan with --host-db <path> to include them.",
                );
            } finally {
                output.mockRestore();
            }
        });
    it("checks offline using the planned host by default, with read-only handles and identical database bytes", async () => {
        const hostPath = hostDatabase();
        const plan = await makePlan(hostPath);
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        const pin = sidecar(folder("checkout"));
        const paths = [dbPath, hostPath, pin];
        const before = paths.map(bytes);
        const open = databaseAccess.openExistingDatabase;
        const opens: string[] = [];
        const probe = spyOn(databaseAccess, "openExistingDatabase").mockImplementation(
            (path, options) => {
                expect(options.readonly).toBe(true);
                opens.push(path);
                return open(path, options);
            },
        );
        let resolves = 0;
        try {
            expect(
                await runProjectIdsCli(["apply", "--check", planFile(plan), "--db", dbPath], {
                    ...deps,
                    resolve: async () => {
                        resolves++;
                        throw new Error("offline");
                    },
                }),
            ).toBe(0);
        } finally {
            probe.mockRestore();
        }
        expect(resolves).toBe(0);
        expect(opens).toContain(hostPath);
        expect(opens).toContain(dbPath);
        expect(paths.map(bytes)).toEqual(before);
        expect(
            db.prepare("SELECT 1 FROM project_state WHERE project_path = ?").get(from),
        ).toBeTruthy();
        expect(db.prepare("SELECT * FROM v22_identity_rekey_map").all()).toEqual([]);
    });

    it("refuses another store before opening it", async () => {
        const plan = await makePlan();
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        const other = join(root, "other.db");
        copyFileSync(dbPath, other);
        const before = bytes(other);
        const result = preflightProjectIdApply(plan, { dbPath: other }, deps);
        expect(result.refusals.map((r) => r.code)).toEqual(["store_mismatch"]);
        expect(bytes(other)).toBe(before);
    });

    it("refuses a changed schemaVersion", async () => {
        const plan = await makePlan();
        plan.schemaVersion--;
        expect(check(plan).refusals.map((r) => r.code)).toEqual(["schema_mismatch"]);
    });

    it("accepts canonical aliases for the planned store and host", async () => {
        const hostPath = hostDatabase();
        const plan = await makePlan(hostPath);
        const hostAlias = join(root, "host-alias.db");
        const dbAlias = join(root, "context-alias.db");
        symlinkSync(hostPath, hostAlias);
        symlinkSync(dbPath, dbAlias);
        expect(
            preflightProjectIdApply(plan, { dbPath: dbAlias, hostPath: hostAlias }, deps).refusals,
        ).toEqual([]);
    });

    it("refuses host B even when it has identical bytes to planned host A", async () => {
        const hostPath = hostDatabase();
        const plan = await makePlan(hostPath);
        const other = join(root, "other-host.db");
        copyFileSync(hostPath, other);
        expect(
            preflightProjectIdApply(plan, { dbPath, hostPath: other }, deps).refusals.map(
                (r) => r.code,
            ),
        ).toEqual(["host_mismatch"]);
    });

    it("refuses a missing planned host instead of dropping its inventory", async () => {
        const hostPath = hostDatabase();
        const plan = await makePlan(hostPath);
        rmSync(hostPath);
        expect(check(plan).refusals.map((r) => r.code)).toEqual(["database_unreadable"]);
    });

    it("refuses an unreadable planned host", async () => {
        const hostPath = hostDatabase();
        const plan = await makePlan(hostPath);
        writeFileSync(hostPath, "not a SQLite database");
        expect(check(plan).refusals.map((r) => r.code)).toEqual(["database_unreadable"]);
    });

    it("refuses an explicit host on a null-host plan", async () => {
        const plan = await makePlan();
        const hostPath = hostDatabase();
        expect(
            preflightProjectIdApply(plan, { dbPath, hostPath }, deps).refusals.map((r) => r.code),
        ).toEqual(["host_mismatch"]);
    });

    for (const empty of [false, true])
        it(`refuses a conflicting rekey target for a ${empty ? "zero-row" : "populated"} source`, async () => {
            const plan = await makePlan();
            if (empty) db.prepare("DELETE FROM project_state WHERE project_path = ?").run(from);
            db.prepare("INSERT INTO v22_identity_rekey_map VALUES (?, 'pj-OTHER', 1)").run(from);
            expect(check(plan).refusals.map((r) => r.code)).toEqual(["rekey_conflict"]);
        });

    for (const completed of [false, true])
        it(`refuses a gained folder for a ${completed ? "completed source that regained rows" : "not-yet-merged source"}`, async () => {
            const plan = await makePlan();
            if (completed) {
                mergeProjectIdentities(db, from, to);
                db.prepare("INSERT INTO project_state(project_path) VALUES (?)").run(from);
            }
            sidecar(folder("new-folder"));
            expect(check(plan).refusals.map((r) => r.code)).toEqual(["new_folder"]);
        });

    it("recomputes host and workspace observations, not only sidecars", async () => {
        const hostPath = hostDatabase();
        const plan = await makePlan(hostPath);
        const host = new Database(hostPath);
        host.prepare("UPDATE session SET directory = ?").run(folder("new-host-folder"));
        host.close();
        db.exec("INSERT INTO workspaces VALUES (1, 'space', 1, 1, '[]')");
        db.prepare("INSERT INTO workspace_members VALUES (1, ?, 'alias', ?, 1)").run(
            from,
            folder("new-workspace-folder"),
        );
        expect(check(plan).refusals.filter((r) => r.code === "new_folder")).toHaveLength(2);
    });

    for (const completed of [false, true])
        it(`does not check gained folders of a zero-row ${completed ? "completed" : "unstarted"} source`, async () => {
            const plan = await makePlan();
            if (completed) mergeProjectIdentities(db, from, to);
            else db.prepare("DELETE FROM project_state WHERE project_path = ?").run(from);
            sidecar(folder("new-folder"));
            const result = check(plan);
            expect(result.pairs[0].liveRows).toBe(0);
            expect(result.refusals).toEqual([]);
        });

    it("ignores folders no longer attributed to a source with remaining rows", async () => {
        const plan = await makePlan();
        sidecar(folder("unrelated-folder"), "git:other");
        rmSync(join(root, "checkout"), { recursive: true });
        expect(check(plan).refusals).toEqual([]);
    });

    it("reports planned and live counts without refusing count drift", async () => {
        const plan = await makePlan();
        db.prepare(
            "INSERT INTO session_projects(session_id, harness, project_path, updated_at) VALUES ('new-session', 'pi', ?, 1)",
        ).run(from);
        const result = check(plan);
        expect(result.refusals).toEqual([]);
        expect(result.pairs[0].pair.rowsByTable.session_projects).toBe(0);
        expect(result.pairs[0].liveRowsByTable.session_projects).toBe(1);
        const output = spyOn(console, "log").mockImplementation(() => {});
        try {
            expect(
                await runProjectIdsCli(["apply", "--check", planFile(plan), "--db", dbPath], deps),
            ).toBe(0);
            expect(output.mock.calls.flat().join("\n")).toContain(
                "session_projects: planned 0; live 1",
            );
            expect(output.mock.calls.flat().join("\n")).toContain("Nothing was changed");
        } finally {
            output.mockRestore();
        }
    });

    it("enforces the injected free-space threshold for the whole bundle plus ten percent", async () => {
        const plan = await makePlan();
        const nested = join(folder("project-identities/nested"), "extra.bin");
        writeFileSync(nested, Buffer.alloc(1234));
        const pinPath = sidecar(folder("checkout"));
        const bundle = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, nested, pinPath].reduce(
            (sum, path) => sum + statSync(path).size,
            0,
        );
        const required = Math.ceil((bundle * 11) / 10);
        const result = check(plan, {
            freeBytes: (path) => {
                expect(path).toBe(root);
                return required - 1;
            },
        });
        expect(result.space).toEqual({
            bundleBytes: bundle,
            requiredBytes: required,
            freeBytes: required - 1,
        });
        expect(result.refusals.map((r) => r.code)).toEqual(["insufficient_space"]);
        expect(check(plan, { freeBytes: () => required }).refusals).toEqual([]);
    });

    it.each([
        "holder",
        "in_use",
        "unknown",
    ])("refuses offline holder uncertainty (%s)", async (kind) => {
        const plan = await makePlan();
        const result = check(
            plan,
            kind === "holder"
                ? {
                      inspectHolders: () => ({ safe: false, blockers: ["ck-mc"] }),
                  }
                : {
                      probe: () =>
                          kind === "in_use"
                              ? { status: "in_use", pids: [123] }
                              : { status: "unknown", reason: "probe failed" },
                  },
        );
        expect(result.refusals.map((r) => r.code)).toEqual(["holders"]);
        expect(result.pairs).toEqual([]);
    });

    it("retains the shared authority-managed and workspace merge fences", async () => {
        const plan = await makePlan();
        db.prepare("INSERT INTO authority_managed VALUES (?, 'fixture-store', 1)").run(from);
        expect(check(plan).refusals.map((r) => r.code)).toEqual(["merge_not_allowed"]);
        db.exec(
            "DELETE FROM authority_managed; INSERT INTO workspaces VALUES (1,'a',1,1,'[]'), (2,'b',1,1,'[]')",
        );
        db.prepare("INSERT INTO workspace_members VALUES (1, ?, 'a', ?, 1), (2, ?, 'b', ?, 1)").run(
            from,
            folder("checkout"),
            to,
            folder("target"),
        );
        expect(check(plan).refusals.map((r) => r.code)).toEqual(["merge_not_allowed"]);
    });

    it("rejects malformed plans and wrong-way pairs without writing", async () => {
        const plan = await makePlan();
        expect(() => check({ ...plan, version: 2 } as unknown as ProjectIdPlan)).toThrow(
            "Invalid version",
        );
        expect(() => check({ ...plan, pairs: [{ ...plan.pairs[0], to: "dir:wrong" }] })).toThrow(
            "Invalid project identity plan pair",
        );
        expect(() =>
            check({ ...plan, pairs: [{ ...plan.pairs[0], to: "pj-implicit1-abc" }] }),
        ).toThrow("Invalid project identity plan pair");
        for (const staysOnLegacy of [
            null,
            {},
            [{ reason: "implicit" }],
            [{ directory: "x", reason: "resolved" }],
        ])
            expect(() =>
                check({
                    ...plan,
                    pairs: [{ ...plan.pairs[0], staysOnLegacy }],
                } as unknown as ProjectIdPlan),
            ).toThrow("Invalid project identity plan pair");
    });

    it("still accepts version 1 plans without inheritance or legacy-only fields", async () => {
        const plan = JSON.parse(JSON.stringify(await makePlan()));
        delete plan.pairs[0].inherited;
        delete plan.pairs[0].staysOnLegacy;
        expect(check(plan).refusals).toEqual([]);
    });

    it("parses apply and an optional read-only check with one plan path", () => {
        expect(
            parseProjectIdsApplyArgs([
                "apply",
                "--check",
                "plan.json",
                "--db",
                "context.db",
                "--host-db",
                "host.db",
            ]),
        ).toEqual({
            planPath: "plan.json",
            check: true,
            dbPath: "context.db",
            hostPath: "host.db",
        });
        expect(parseProjectIdsApplyArgs(["apply", "plan.json"])).toEqual({
            planPath: "plan.json",
            check: false,
            dbPath: undefined,
            hostPath: undefined,
        });
        for (const args of [
            ["apply"],
            ["apply", "--check"],
            ["apply", "--check", "a", "b"],
            ["apply", "--check", "a", "--force"],
            ["apply", "--check", "--check", "a"],
            ["apply", "--check", "a", "--db"],
        ])
            expect(() => parseProjectIdsApplyArgs(args)).toThrow();
    });

    it("refuses the whole check when a later pair gained a folder, without changing earlier pairs", async () => {
        db.prepare("INSERT INTO project_state(project_path) VALUES ('dir:later')").run();
        sidecar(folder("later"), "dir:later");
        const plan = await makePlan();
        expect(plan.pairs).toHaveLength(2);
        const later = plan.pairs[1];
        sidecar(folder("later-new-folder"), later.from);
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        const before = bytes(dbPath);
        expect(check(plan).refusals).toEqual([
            expect.objectContaining({ code: "new_folder", from: later.from }),
        ]);
        const log = spyOn(console, "log").mockImplementation(() => {});
        const error = spyOn(console, "error").mockImplementation(() => {});
        try {
            expect(
                await runProjectIdsCli(["apply", "--check", planFile(plan), "--db", dbPath], deps),
            ).toBe(1);
            expect(log.mock.calls.flat().join("\n")).toContain("Nothing was changed");
        } finally {
            log.mockRestore();
            error.mockRestore();
        }
        expect(bytes(dbPath)).toBe(before);
        expect(db.prepare("SELECT * FROM v22_identity_rekey_map").all()).toEqual([]);
    });
});

describe("doctor project-ids apply pairs", () => {
    it("limits restore advice to before further use and says store.db was not changed", async () => {
        const plan = await makePlan();
        const storePath = join(root, "store.db");
        writeFileSync(storePath, "untouched host store fixture");
        const before = bytes(storePath);
        const output = spyOn(console, "log").mockImplementation(() => {});
        try {
            expect(await runProjectIdsCli(["apply", planFile(plan), "--db", dbPath], deps)).toBe(0);
            const text = output.mock.calls.flat().join("\n");
            expect(text).toContain(
                "store.db was not changed. Restoring context.db and identity sidecars is safe only before further use; close all hosts first.",
            );
            expect(text).toContain("Restore with hosts closed:");
            expect(text).toContain("Restore identity sidecars too:");
            expect(bytes(storePath)).toBe(before);
        } finally {
            output.mockRestore();
        }
    });
    it("takes one backup for two merges, including legacy sidecars", async () => {
        const plan = await orderedPlan();
        const sidecars = plan.pairs.map((pair) => sidecar(pair.folders[0].directory, pair.from));
        const originals = sidecars.map(bytes);
        const nested = join(folder("project-identities/nested"), "extra.bin");
        writeFileSync(nested, "also backed up");
        expect(db.prepare("SELECT 1 FROM project_state WHERE project_path = ?").get(to)).toBeNull();
        expect(await apply(plan)).toEqual({
            code: 0,
            statuses: [`${from} → ${to}: applied`, `${second} → ${to}: applied`],
        });
        expect(backups()).toHaveLength(1);
        const backup = join(root, backups()[0]);
        expect(
            sidecars.map((path) =>
                bytes(join(backup, "project-identities", path.split("/").pop()!)),
            ),
        ).toEqual(originals);
        expect(readFileSync(join(backup, "project-identities/nested/extra.bin"), "utf8")).toBe(
            "also backed up",
        );
        const savedDb = new Database(join(backup, "context.db"), { readonly: true });
        try {
            expect(
                savedDb
                    .prepare("SELECT project_path FROM project_state ORDER BY project_path")
                    .all(),
            ).toEqual([{ project_path: second }, { project_path: from }]);
            expect(savedDb.prepare("SELECT * FROM v22_identity_rekey_map").all()).toEqual([]);
        } finally {
            savedDb.close();
        }
        expect(mappings()).toEqual([
            { old_project_path: second, new_project_path: to },
            { old_project_path: from, new_project_path: to },
        ]);
        expect(db.prepare("SELECT project_path FROM project_state").all()).toEqual([
            { project_path: to },
        ]);
        for (const path of sidecars)
            expect(JSON.parse(readFileSync(path, "utf8")).identity).toBe(to);
    });

    it("pins every existing non-worktree folder after commit using live file metadata", async () => {
        const plan = await makePlan();
        const main = folder("checkout");
        const git = folder("checkout/.git");
        const sub = folder("checkout/sub");
        const worktree = folder("worktree");
        const gitdir = folder("checkout/.git/worktrees/linked");
        writeFileSync(join(gitdir, "commondir"), "../..");
        writeFileSync(join(worktree, ".git"), `gitdir: ${gitdir}\n`);
        const separate = folder("separate");
        const separateGit = folder("separate-gitdir");
        writeFileSync(join(separate, ".git"), `gitdir: ${separateGit}\n`);
        const missing = join(root, "missing");
        const paths = [main, sub, worktree, separate, missing].map((directory) =>
            sidecar(directory),
        );
        const worktreeBytes = bytes(paths[2]);
        plan.pairs[0].folders = [main, sub, worktree, separate, missing].map((directory) => ({
            directory,
            exists: true,
            worktree: false,
            gitCommonDir: "/stale/planned/gitdir",
        }));
        const write = storagePermissions.writeStorageFileAtomicSync;
        const writes: string[] = [];
        const spy = spyOn(storagePermissions, "writeStorageFileAtomicSync").mockImplementation(
            (path, content, ...rest) => {
                const reader = new Database(dbPath, { readonly: true });
                try {
                    expect(
                        reader
                            .prepare(
                                "SELECT new_project_path FROM v22_identity_rekey_map WHERE old_project_path = ?",
                            )
                            .get(from),
                    ).toEqual({ new_project_path: to });
                    expect(
                        reader
                            .prepare("SELECT 1 FROM project_state WHERE project_path = ?")
                            .get(from),
                    ).toBeNull();
                } finally {
                    reader.close();
                }
                writes.push(path);
                write(path, content, ...rest);
            },
        );
        try {
            expect((await apply(plan)).code).toBe(0);
        } finally {
            spy.mockRestore();
        }
        expect(writes).toEqual([paths[0], paths[1], paths[3]]);
        expect(JSON.parse(readFileSync(paths[0], "utf8"))).toEqual({
            directory: main,
            identity: to,
            gitCommonDir: git,
        });
        expect(JSON.parse(readFileSync(paths[1], "utf8"))).toEqual({
            directory: sub,
            identity: to,
            gitCommonDir: git,
        });
        expect(JSON.parse(readFileSync(paths[3], "utf8"))).toEqual({
            directory: separate,
            identity: to,
            gitCommonDir: separateGit,
        });
        expect(bytes(paths[2])).toBe(worktreeBytes);
        expect(JSON.parse(readFileSync(paths[4], "utf8")).identity).toBe(from);
    });

    it("applies a remap and implicit worktree sessions inherit only the main checkout pin", async () => {
        const { main, worktrees, clone, gitCommonDir } = linkedCheckoutFixture(root);
        db.prepare("INSERT INTO project_state(project_path) VALUES (?)").run(from);
        for (const directory of [...worktrees, clone, main]) sidecar(directory);
        const unpinnedPaths = [...worktrees, clone].map(sidecarPath);
        const before = unpinnedPaths.map(bytes);
        const fake = await fakeProjectEndpoint(root, [...worktrees, clone]);
        try {
            const plan = await buildProjectIdPlan(db, dbPath, null, {
                resolve: async (directory) =>
                    directory === main
                        ? {
                              status: "resolved",
                              via: "root",
                              projectId: fake.projectId,
                              canonicalRoot: main,
                          }
                        : { status: "implicit" },
            });
            expect(plan.pairs).toHaveLength(1);
            expect(plan.pairs[0].inherited).toHaveLength(worktrees.length);
            expect(plan.pairs[0].staysOnLegacy).toEqual([{ directory: clone, reason: "implicit" }]);
            expect((await apply(plan)).code).toBe(0);
            expect(JSON.parse(readFileSync(sidecarPath(main), "utf8"))).toEqual({
                directory: main,
                identity: fake.projectId,
                gitCommonDir,
            });
            expect(unpinnedPaths.map(bytes)).toEqual(before);
            expect(mappings()).toEqual([
                { old_project_path: from, new_project_path: fake.projectId },
            ]);

            // A fresh host process must find the apply-written main pin, not an in-memory cache.
            const child = Bun.spawn(
                [
                    process.execPath,
                    "--eval",
                    `
                    import { awaitSessionIdentityDecision } from ${JSON.stringify(join(import.meta.dir, "../../../plugin/src/features/magic-context/memory/session-identity-decision.ts"))};
                    const decisions = [];
                    for (const directory of ${JSON.stringify(worktrees)}) {
                        decisions.push(await awaitSessionIdentityDecision(directory, directory, {
                            connectionFile: ${JSON.stringify(fake.connectionFile)},
                            allowHomeProject: true,
                        }));
                    }
                    console.log(JSON.stringify(decisions));
                    `,
                ],
                {
                    cwd: root,
                    windowsHide: true,
                    env: {
                        PATH: process.env.PATH ?? "",
                        HOME: root,
                        MAGIC_CONTEXT_STORAGE_DIR: root,
                        XDG_DATA_HOME: join(root, "data"),
                        XDG_CONFIG_HOME: join(root, "config"),
                        XDG_STATE_HOME: join(root, "state"),
                        XDG_RUNTIME_DIR: join(root, "runtime"),
                    },
                    stdin: "ignore",
                    stdout: "pipe",
                    stderr: "pipe",
                },
            );
            const [stdout, stderr, code] = await Promise.all([
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
                child.exited,
            ]);
            expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
            expect(JSON.parse(stdout)).toEqual(
                worktrees.map((directory) => ({ directory, identity: fake.projectId })),
            );
            expect(fake.calls).toEqual(worktrees);
            expect(fake.failures).toEqual([]);
            expect(unpinnedPaths.map(bytes)).toEqual(before);
        } finally {
            await fake.close();
        }
    }, 30_000);

    it("commits each pair separately and rolls back a failed pair's rekey map before any of its pins", async () => {
        const plan = await orderedPlan();
        db.exec(
            `CREATE TRIGGER stop_second BEFORE DELETE ON project_state WHEN old.project_path = '${second}' BEGIN SELECT RAISE(ABORT, 'second pair interrupted'); END`,
        );
        const log = spyOn(console, "log").mockImplementation(() => {});
        try {
            await expect(
                runProjectIdsCli(["apply", planFile(plan), "--db", dbPath], deps),
            ).rejects.toThrow("second pair interrupted");
            expect(log.mock.calls.flat()).toContain(`${from} → ${to}: applied`);
            expect(log.mock.calls.flat()).not.toContain(`${second} → ${to}: applied`);
        } finally {
            log.mockRestore();
        }
        expect(mappings()).toEqual([{ old_project_path: from, new_project_path: to }]);
        expect(
            db.prepare("SELECT project_path FROM project_state ORDER BY project_path").all(),
        ).toEqual([{ project_path: second }, { project_path: to }]);
        const firstPin = sidecarPath(plan.pairs[0].folders[0].directory);
        const secondPin = sidecarPath(plan.pairs[1].folders[0].directory);
        expect(JSON.parse(readFileSync(firstPin, "utf8")).identity).toBe(to);
        expect(JSON.parse(readFileSync(secondPin, "utf8")).identity).toBe(second);
    });

    for (const point of ["committed", "applied"] as const)
        it(`resumes in plan order after SIGKILL with the first pair ${point}`, async () => {
            const plan = await orderedPlan();
            const zero = "git:zero-row";
            const zeroDir = folder("zero-row");
            const zeroPin = sidecar(zeroDir, zero);
            plan.pairs.push({
                from: zero,
                to,
                rowsByTable: {},
                folders: [
                    { directory: zeroDir, exists: true, worktree: false, gitCommonDir: null },
                ],
            });
            const firstPin = sidecarPath(plan.pairs[0].folders[0].directory);
            const secondPin = sidecarPath(plan.pairs[1].folders[0].directory);
            const secondBytes = bytes(secondPin);
            const zeroBytes = bytes(zeroPin);
            await killedApply(plan, point);
            expect(mappings()).toEqual([{ old_project_path: from, new_project_path: to }]);
            expect(
                db.prepare("SELECT 1 FROM project_state WHERE project_path = ?").get(second),
            ).toBeTruthy();
            expect(JSON.parse(readFileSync(firstPin, "utf8")).identity).toBe(
                point === "committed" ? from : to,
            );
            expect(bytes(secondPin)).toBe(secondBytes);
            expect(bytes(zeroPin)).toBe(zeroBytes);
            expect(check(plan).refusals).toEqual([]);
            const beforeMerge = db
                .prepare("SELECT * FROM v22_identity_rekey_map WHERE old_project_path = ?")
                .get(from);
            const write = storagePermissions.writeStorageFileAtomicSync;
            const pinsInOrder: string[] = [];
            const spy = spyOn(storagePermissions, "writeStorageFileAtomicSync").mockImplementation(
                (path, ...args) => {
                    if (path === firstPin || path === secondPin)
                        expect(bytes(zeroPin)).toBe(zeroBytes);
                    if (path === zeroPin) {
                        expect(JSON.parse(readFileSync(secondPin, "utf8")).identity).toBe(to);
                        expect(mappings()).toHaveLength(2);
                    }
                    pinsInOrder.push(path);
                    write(path, ...args);
                },
            );
            let result: Awaited<ReturnType<typeof apply>>;
            try {
                result = await apply(plan);
            } finally {
                spy.mockRestore();
            }
            expect(result).toEqual({
                code: 0,
                statuses: [
                    `${from} → ${to}: ${point === "committed" ? "pins repaired" : "already applied"}`,
                    `${second} → ${to}: applied`,
                    `${zero} → ${to}: pins repaired`,
                ],
            });
            expect(pinsInOrder).toEqual(
                point === "committed" ? [firstPin, secondPin, zeroPin] : [secondPin, zeroPin],
            );
            expect(
                db
                    .prepare("SELECT * FROM v22_identity_rekey_map WHERE old_project_path = ?")
                    .get(from),
            ).toEqual(beforeMerge);
            expect(JSON.parse(readFileSync(zeroPin, "utf8")).identity).toBe(to);
            expect(mappings()).toHaveLength(2);
        });

    it("rerunning a finished plan writes nothing and reports already applied for every pair", async () => {
        const plan = await orderedPlan();
        expect((await apply(plan)).code).toBe(0);
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        const paths = [dbPath, ...plan.pairs.map((pair) => sidecarPath(pair.folders[0].directory))];
        const before = paths.map(bytes);
        const savedBackups = backups();
        const map = db.prepare("SELECT * FROM v22_identity_rekey_map").all();
        const write = spyOn(storagePermissions, "writeStorageFileAtomicSync");
        const open = databaseAccess.openExistingDatabase;
        const spy = spyOn(databaseAccess, "openExistingDatabase").mockImplementation(
            (path, options) => {
                expect(options.readonly).toBe(true);
                return open(path, options);
            },
        );
        try {
            expect(await apply(plan)).toEqual({
                code: 0,
                statuses: [
                    `${from} → ${to}: already applied`,
                    `${second} → ${to}: already applied`,
                ],
            });
            expect(write).not.toHaveBeenCalled();
        } finally {
            spy.mockRestore();
            write.mockRestore();
        }
        expect(backups()).toEqual(savedBackups);
        expect(paths.map(bytes)).toEqual(before);
        expect(db.prepare("SELECT * FROM v22_identity_rekey_map").all()).toEqual(map);
    });

    it("refuses a later pair's new folder before backing up, merging or pinning earlier pairs", async () => {
        const plan = await orderedPlan();
        sidecar(folder("unplanned"), second);
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        const paths = [dbPath, ...plan.pairs.map((pair) => sidecarPath(pair.folders[0].directory))];
        const before = paths.map(bytes);
        const error = spyOn(console, "error").mockImplementation(() => {});
        try {
            expect(await apply(plan)).toEqual({ code: 1, statuses: [] });
        } finally {
            error.mockRestore();
        }
        expect(backups()).toEqual([]);
        expect(paths.map(bytes)).toEqual(before);
        expect(mappings()).toEqual([]);
        expect(existsSync(join(root, "project-identities"))).toBe(true);
    });

    it("keeps manual git-to-dir and git-to-pj refusals even with force", async () => {
        await makePlan();
        db.prepare("INSERT INTO project_state(project_path) VALUES ('dir:target')").run();
        for (const target of ["dir:target", to])
            expect(() =>
                runMergeIdentityCli(
                    ["--db", dbPath, "--from", from, "--to", target, "--apply", "--force"],
                    deps,
                ),
            ).toThrow("repository-wide identity");
        expect(mappings()).toEqual([]);
        expect(backups()).toEqual([]);
    });
});
