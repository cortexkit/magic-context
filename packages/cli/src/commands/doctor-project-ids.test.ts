import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import {
    copyFileSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EntorhinalResolveResult } from "@magic-context/core/features/magic-context/memory/entorhinal-resolve";
import { resolveEntorhinalProject } from "@magic-context/core/features/magic-context/memory/entorhinal-resolve";
import {
    initializeDatabase,
    runMigrations,
} from "@magic-context/core/features/magic-context/storage";
import { Database } from "@magic-context/core/shared/sqlite";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import * as databaseAccess from "../lib/database-access";
import { CLI_SCHEMA_FLOOR_VERSION, openExistingContextDatabase } from "../lib/database-access";
import {
    buildProjectIdPlan,
    type ProjectIdPlan,
    parseProjectIdsPlanArgs,
    runProjectIdsCli,
} from "./doctor-project-ids";
import { fakeProjectEndpoint, linkedCheckoutFixture } from "./doctor-project-ids.test-support";

let root: string;
let dbPath: string;
let db: Database;
const cleanups: Array<() => Promise<void>> = [];
const plannedAt = "2026-10-15T10:11:12.123Z";
const now = () => new Date(plannedAt);
const target = "pj-11111111-1111-4111-8111-111111111111";
const resolved = (projectId = target): EntorhinalResolveResult => ({
    status: "resolved",
    projectId,
    via: "root",
    canonicalRoot: null,
});

beforeEach(() => {
    root = realpathSync(createTestTempDirFromPath(join(tmpdir(), "mc-project-ids-")));
    dbPath = join(root, "context.db");
    db = new Database(dbPath);
    initializeDatabase(db);
    runMigrations(db);
});

afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    db.close();
    rmSync(root, { recursive: true, force: true });
});

function folder(name: string): string {
    const directory = join(root, name);
    mkdirSync(directory, { recursive: true });
    return directory;
}

function sidecar(directory: string, identity: string): void {
    const sidecars = join(root, "project-identities");
    mkdirSync(sidecars, { recursive: true });
    writeFileSync(
        join(sidecars, `${createHash("sha256").update(directory).digest("hex")}.json`),
        JSON.stringify({ directory, identity }),
    );
}

function source(identity: string, directories: string[]): void {
    db.prepare("INSERT INTO project_state(project_path) VALUES (?)").run(identity);
    for (const directory of directories) sidecar(directory, identity);
}

async function plan(resolve: (directory: string) => Promise<EntorhinalResolveResult>) {
    return buildProjectIdPlan(db, dbPath, null, { now, resolve });
}

function membership(id: number, identity: string, directory: string): void {
    db.prepare("INSERT OR IGNORE INTO workspaces VALUES (?, ?, 1, 1, '[]')").run(id, `space-${id}`);
    db.prepare("INSERT INTO workspace_members VALUES (?, ?, ?, ?, 1)").run(
        id,
        identity,
        identity,
        directory,
    );
}

function bytes(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("doctor project-ids plan", () => {
    it("plans registered raw absolute-path keys and reports unresolved paths and orphan git ids", async () => {
        const registered = [folder("engram"), folder("astrocyte"), folder("aft")];
        const implicit = folder("implicit");
        const unavailable = folder("not-answering");
        const missing = join(root, "missing");
        for (const identity of [...registered, implicit, unavailable, missing, "git:orphan"]) {
            db.prepare("INSERT INTO project_state(project_path) VALUES (?)").run(identity);
        }
        for (const [index, directory] of registered.entries()) {
            const count = [32, 19, 6][index];
            for (let i = 0; i < count; i++)
                db.prepare(`INSERT INTO memories
                (project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at)
                VALUES (?, 'CONSTRAINTS', ?, ?, 1, 1, 1, 1)`).run(
                    directory,
                    `memory-${index}-${i}`,
                    `hash-${index}-${i}`,
                );
        }
        const calls: string[] = [];
        const result = await plan(async (directory) => {
            calls.push(directory);
            if (registered.includes(directory))
                return resolved(`pj-${directory.split("/").at(-1)}`);
            return directory === implicit
                ? { status: "implicit" }
                : { status: "not_answering", reason: "transport" };
        });
        expect(
            result.pairs.map(({ from, to, rowsByTable }) => ({
                from,
                to,
                rows: rowsByTable.project_state,
            })),
        ).toEqual(
            [...registered]
                .sort()
                .map((from) => ({ from, to: `pj-${from.split("/").at(-1)}`, rows: 1 })),
        );
        expect(result.unchanged).toEqual(
            expect.arrayContaining([
                { identity: implicit, reason: "implicit" },
                { identity: unavailable, reason: "not_answering" },
                { identity: missing, reason: "no_existing_folder" },
                { identity: "git:orphan", reason: "no_existing_folder" },
            ]),
        );
        expect(
            result.pairs.map(({ from, rowsByTable }) => [
                from.split("/").at(-1),
                rowsByTable.memories,
            ]),
        ).toEqual([
            ["aft", 6],
            ["astrocyte", 19],
            ["engram", 32],
        ]);
        expect(calls.sort()).toEqual([...registered, implicit, unavailable].sort());
        expect(db.prepare("SELECT COUNT(*) AS n FROM project_state").get()).toEqual({ n: 7 });
        const log = spyOn(console, "log").mockImplementation(() => {});
        try {
            expect(
                await runProjectIdsCli(["plan", "--db", dbPath], {
                    now,
                    resolve: async (directory) =>
                        registered.includes(directory)
                            ? resolved(`pj-${directory.split("/").at(-1)}`)
                            : directory === implicit
                              ? { status: "implicit" }
                              : { status: "not_answering", reason: "transport" },
                }),
            ).toBe(0);
            const written = JSON.parse(
                readFileSync(
                    join(root, `project-id-plan-${plannedAt.replaceAll(":", "-")}.json`),
                    "utf8",
                ),
            ) as ProjectIdPlan;
            expect(written.pairs).toEqual(result.pairs);
            expect(written.unchanged).toEqual(result.unchanged);
        } finally {
            log.mockRestore();
        }
    });
    it("writes version 1 beside the canonical store, with host-first full inventory and no database or pin changes", async () => {
        const first = folder("a-host");
        const missing = join(root, "a-missing");
        const second = folder("b-sidecar");
        const third = folder("c-workspace");
        const from = "git:old";
        source(from, [second]);
        membership(1, from, third);
        const hostPath = join(root, "host.db");
        const host = new Database(hostPath);
        host.exec(
            "CREATE TABLE session(id TEXT, directory TEXT); CREATE TABLE session_v2(id TEXT, directory TEXT)",
        );
        host.prepare("INSERT INTO session VALUES ('one', ?), ('missing', ?)").run(first, missing);
        host.prepare("INSERT INTO session_v2 VALUES ('two', ?)").run(first);
        host.close();
        db.prepare(
            "INSERT INTO session_projects(session_id, harness, project_path, updated_at) VALUES ('one','opencode',?,1), ('missing','opencode',?,1), ('two','opencode2',?,1)",
        ).run(from, from, from);
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        const hostAlias = join(root, "host-alias.db");
        const dbAlias = join(root, "context-alias.db");
        symlinkSync(hostPath, hostAlias);
        symlinkSync(dbPath, dbAlias);
        const pinPaths = readdirSync(join(root, "project-identities")).map((name) =>
            join(root, "project-identities", name),
        );
        const before = [dbPath, hostPath, ...pinPaths].map(bytes);
        const calls: string[] = [];
        const open = databaseAccess.openExistingDatabase;
        let hostOpens = 0;
        const probe = spyOn(databaseAccess, "openExistingDatabase").mockImplementation(
            (path, options) => {
                const handle = open(path, options);
                if (path === hostPath && handle) {
                    hostOpens++;
                    try {
                        expect(() =>
                            handle.exec("CREATE TABLE readonly_probe (id INTEGER)"),
                        ).toThrow();
                    } catch (error) {
                        handle.close();
                        throw error;
                    }
                }
                return handle;
            },
        );
        try {
            expect(
                await runProjectIdsCli(["plan", "--db", dbAlias, "--host-db", hostAlias], {
                    now,
                    resolve: async (directory) => {
                        calls.push(directory);
                        return resolved();
                    },
                }),
            ).toBe(0);
        } finally {
            probe.mockRestore();
        }
        expect(hostOpens).toBe(1);
        const file = join(root, "project-id-plan-2026-10-15T10-11-12.123Z.json");
        const result: ProjectIdPlan = JSON.parse(readFileSync(file, "utf8"));
        expect(result).toEqual({
            version: 1,
            plannedAt,
            dbPath,
            hostDbPath: hostPath,
            schemaVersion: CLI_SCHEMA_FLOOR_VERSION,
            pairs: [
                {
                    from,
                    to: target,
                    rowsByTable: expect.any(Object),
                    inherited: [],
                    staysOnLegacy: [],
                    folders: [first, missing, second, third].map((directory) => ({
                        directory,
                        exists: directory !== missing,
                        gitCommonDir: null,
                        worktree: false,
                    })),
                },
            ],
            unchanged: [],
        });
        expect(result.pairs[0].rowsByTable.project_state).toBe(1);
        expect(result.pairs[0].rowsByTable.session_projects).toBe(3);
        expect(result.pairs[0].rowsByTable.workspace_members).toBe(1);
        expect(calls).toEqual([first, second, third]);
        expect([dbPath, hostPath, ...pinPaths].map(bytes)).toEqual(before);
        expect(readdirSync(join(root, "project-identities")).length).toBe(1);
        expect(
            db.prepare("SELECT 1 FROM project_state WHERE project_path = ?").get(target),
        ).toBeNull();
    }, 30_000);

    it("keeps conflicting targets ahead of implicit and unavailable answers", async () => {
        const a = folder("a");
        const b = folder("b");
        const c = folder("c");
        const d = folder("d");
        source("git:conflict", [a, b, c, d]);
        const result = await plan(async (directory) =>
            directory === b
                ? resolved("pj-OTHER")
                : directory === c
                  ? { status: "implicit" }
                  : directory === d
                    ? { status: "not_answering", reason: "transport" }
                    : resolved(),
        );
        expect(result.pairs).toEqual([]);
        expect(result.unchanged).toContainEqual({
            identity: "git:conflict",
            reason: "conflicting_targets",
        });
    }, 30_000);

    it("inherits implicit linked worktrees and lists an unrelated clone as staying on legacy", async () => {
        const { main, worktrees, clone, gitCommonDir } = linkedCheckoutFixture(root);
        const from = "git:linked";
        source(from, [...worktrees, clone, main]);
        const output = spyOn(console, "log").mockImplementation(() => {});
        try {
            expect(
                await runProjectIdsCli(["plan", "--db", dbPath], {
                    now,
                    resolve: async (directory) =>
                        directory === main ? resolved() : { status: "implicit" },
                }),
            ).toBe(0);
            const result: ProjectIdPlan = JSON.parse(
                readFileSync(join(root, "project-id-plan-2026-10-15T10-11-12.123Z.json"), "utf8"),
            );
            expect(result.unchanged).toEqual([]);
            expect(result.pairs).toHaveLength(1);
            expect(result.pairs[0]).toMatchObject({
                from,
                to: target,
                inherited: worktrees.map((directory) => ({ directory, gitCommonDir })),
                staysOnLegacy: [{ directory: clone, reason: "implicit" }],
            });
            expect(result.pairs[0].folders.map((folder) => folder.directory)).toEqual(
                [...worktrees, main].sort(),
            );
            const printed = output.mock.calls.flat().join("\n");
            for (const directory of worktrees)
                expect(printed).toContain(
                    `Inherited ${target}: ${directory} (git common dir: ${gitCommonDir})`,
                );
            expect(printed).toContain(`Stays on legacy: ${clone} (implicit; fresh legacy identity`);
        } finally {
            output.mockRestore();
        }
    }, 30_000);

    it("leaves an all-implicit source unchanged even when its folders share a git common dir", async () => {
        const { main, worktrees, clone } = linkedCheckoutFixture(root);
        source("git:implicit", [main, ...worktrees, clone]);
        const result = await plan(async () => ({ status: "implicit" }));
        expect(result.pairs).toEqual([]);
        expect(result.unchanged).toEqual([{ identity: "git:implicit", reason: "implicit" }]);
    }, 30_000);

    it("keeps unavailable answers ahead of implicit even with a resolved target", async () => {
        const main = folder("main");
        const implicit = folder("implicit");
        const down = folder("down");
        source("git:down", [main, implicit, down]);
        const result = await plan(async (directory) =>
            directory === main
                ? resolved()
                : directory === implicit
                  ? { status: "implicit" }
                  : { status: "not_answering", reason: "transport" },
        );
        expect(result.pairs).toEqual([]);
        expect(result.unchanged).toEqual([{ identity: "git:down", reason: "not_answering" }]);
    }, 30_000);

    it("lists missing-only and unobserved sources but missing folders do not block a resolved source", async () => {
        const existing = folder("existing");
        const missing = join(root, "missing");
        source("dir:eligible", [existing, missing]);
        source("git:missing", [join(root, "also-missing")]);
        source("dir:no-path", []);
        const calls: string[] = [];
        const result = await plan(async (directory) => {
            calls.push(directory);
            return resolved();
        });
        expect(result.pairs.map((pair) => pair.from)).toEqual(["dir:eligible"]);
        expect(result.pairs[0].folders.find((item) => item.directory === missing)).toEqual({
            directory: missing,
            exists: false,
            gitCommonDir: null,
            worktree: false,
        });
        expect(result.unchanged).toContainEqual({
            identity: "git:missing",
            reason: "no_existing_folder",
        });
        expect(result.unchanged).toContainEqual({
            identity: "dir:no-path",
            reason: "no_existing_folder",
        });
        expect(calls).toEqual([existing]);
    }, 30_000);

    it("requires every existing folder to answer, including absent, transport failure and unreadable paths", async () => {
        const absent = folder("absent");
        const down = folder("down");
        const thrown = folder("thrown");
        const notDirectory = join(root, "file");
        writeFileSync(notDirectory, "not a directory");
        source("dir:absent", [absent]);
        source("dir:down", [down]);
        source("dir:thrown", [thrown]);
        source("dir:file", [notDirectory]);
        const result = await plan(async (directory) => {
            if (directory === absent) return { status: "absent", reason: "unknown_module" };
            if (directory === thrown) throw new Error("transport closed");
            return { status: "not_answering", reason: "transport" };
        });
        expect(result.pairs).toEqual([]);
        for (const identity of ["dir:absent", "dir:down", "dir:thrown", "dir:file"])
            expect(result.unchanged).toContainEqual({ identity, reason: "not_answering" });
    }, 30_000);

    it("defers authority-managed sources before resolving and permits them when the row or table is gone", async () => {
        source("git:rust", [folder("rust")]);
        db.prepare("INSERT INTO authority_managed VALUES (?, 'fixture-store', 1)").run("git:rust");
        let calls = 0;
        const resolve = async () => {
            calls++;
            return resolved();
        };
        expect((await plan(resolve)).unchanged).toEqual([
            { identity: "git:rust", reason: "rust_managed" },
        ]);
        expect(calls).toBe(0);
        db.exec("DELETE FROM authority_managed");
        expect((await plan(resolve)).pairs.map((pair) => pair.from)).toEqual(["git:rust"]);
        db.exec("DROP TABLE authority_managed");
        expect((await plan(resolve)).pairs.map((pair) => pair.from)).toEqual(["git:rust"]);
        expect(calls).toBe(2);
    }, 30_000);

    it("rejects the whole pj- group across different source workspaces even with a zero-row target", async () => {
        source("git:a", []);
        source("git:b", []);
        source("dir:unbound", [folder("unbound")]);
        membership(1, "git:a", folder("a"));
        membership(2, "git:b", folder("b"));
        const result = await plan(async () => resolved());
        expect(result.pairs).toEqual([]);
        expect(result.unchanged).toEqual([
            { identity: "dir:unbound", reason: "workspace_conflict" },
            { identity: "git:a", reason: "workspace_conflict" },
            { identity: "git:b", reason: "workspace_conflict" },
        ]);
    }, 30_000);

    it("allows a shared workspace group and checks existing target membership independently per pj-", async () => {
        for (const identity of ["git:a", "dir:b", "git:c", "dir:d"]) source(identity, []);
        membership(1, "git:a", folder("a"));
        membership(1, "dir:b", folder("b"));
        membership(2, "git:c", folder("c"));
        membership(3, "dir:d", folder("d"));
        membership(4, "pj-existing", folder("target"));
        const result = await plan(async (directory) =>
            directory.endsWith("/c")
                ? resolved("pj-separate")
                : directory.endsWith("/d")
                  ? resolved("pj-existing")
                  : resolved(),
        );
        expect(result.pairs.map((pair) => [pair.from, pair.to])).toEqual([
            ["git:a", target],
            ["dir:b", target],
            ["git:c", "pj-separate"],
        ]);
        expect(result.unchanged).toEqual([{ identity: "dir:d", reason: "workspace_conflict" }]);
    }, 30_000);

    it("records file-read git common dirs and worktree flags without writing pins", async () => {
        const main = folder("main");
        const sub = folder("main/sub");
        const common = folder("main/.git");
        const linked = folder("linked");
        const gitdir = folder("main/.git/worktrees/linked");
        writeFileSync(join(linked, ".git"), `gitdir: ${gitdir}\n`);
        writeFileSync(join(gitdir, "commondir"), "../..\n");
        const separate = folder("separate");
        const external = folder("external-git");
        writeFileSync(join(separate, ".git"), `gitdir: ${external}\n`);
        const submodule = folder("submodule");
        const moduleGit = folder("main/.git/modules/submodule");
        writeFileSync(join(submodule, ".git"), `gitdir: ${moduleGit}\n`);
        const paths = [main, sub, linked, separate, submodule];
        source("git:topology", []);
        const host = new Database(join(root, "host.db"));
        host.exec("CREATE TABLE session(id TEXT, directory TEXT)");
        for (const [index, directory] of paths.entries()) {
            host.prepare("INSERT INTO session VALUES (?, ?)").run(String(index), directory);
            db.prepare(
                "INSERT INTO session_projects(session_id,harness,project_path,updated_at) VALUES (?,'opencode','git:topology',1)",
            ).run(String(index));
        }
        host.close();
        const result = await buildProjectIdPlan(db, dbPath, join(root, "host.db"), {
            now,
            resolve: async () => resolved(),
        });
        const folders = result.pairs[0].folders;
        for (const directory of paths) {
            expect(folders.find((item) => item.directory === directory)).toEqual({
                directory,
                exists: true,
                gitCommonDir:
                    directory === separate
                        ? external
                        : directory === submodule
                          ? moduleGit
                          : common,
                worktree: directory === linked,
            });
        }
        expect(readdirSync(root)).not.toContain("project-identities");
    }, 30_000);

    it("uses vendored replies through a fake subc endpoint and refuses an unknown via", async () => {
        const registered = folder("registered");
        const implicit = folder("implicit");
        const unknown = folder("unknown-via");
        source("git:registered", [registered]);
        source("dir:implicit", [implicit]);
        source("dir:unknown", [unknown]);
        const fake = await fakeProjectEndpoint(root);
        cleanups.push(fake.close);
        const result = await plan((directory) =>
            resolveEntorhinalProject(directory, { connectionFile: fake.connectionFile }),
        );
        expect(result.pairs.map((pair) => [pair.from, pair.to])).toEqual([
            ["git:registered", fake.projectId],
        ]);
        expect(result.unchanged).toContainEqual({ identity: "dir:implicit", reason: "implicit" });
        expect(result.unchanged).toContainEqual({
            identity: "dir:unknown",
            reason: "not_answering",
        });
        expect(fake.calls.sort()).toEqual([registered, implicit, unknown].sort());
        expect(fake.failures).toEqual([]);
    }, 30_000);

    it("records null without a host database, reuses the default host when present, and refuses explicit missing hosts", async () => {
        source("dir:source", [folder("source")]);
        expect(
            await runProjectIdsCli(["plan", "--db", dbPath], {
                now,
                resolve: async () => resolved(),
            }),
        ).toBe(0);
        const path = join(root, "project-id-plan-2026-10-15T10-11-12.123Z.json");
        expect(JSON.parse(readFileSync(path, "utf8")).hostDbPath).toBeNull();
        const host = new Database(join(root, "host.db"));
        host.exec("CREATE TABLE session(id TEXT, directory TEXT)");
        host.close();
        expect(
            await runProjectIdsCli(["plan", "--db", dbPath], {
                now,
                resolve: async () => resolved(),
            }),
        ).toBe(0);
        expect(JSON.parse(readFileSync(path, "utf8")).hostDbPath).toBe(join(root, "host.db"));
        await expect(
            runProjectIdsCli(["plan", "--db", dbPath, "--host-db", join(root, "missing.db")]),
        ).rejects.toThrow("Host database does not exist");
    }, 30_000);

    it("names skipped host session observations with --db and no host database", async () => {
        const output = spyOn(console, "log").mockImplementation(() => {});
        try {
            expect(await runProjectIdsCli(["plan", "--db", dbPath], { now })).toBe(0);
            expect(output.mock.calls.flat().join("\n")).toContain(
                "Skipped host session observations: no host database; use --host-db <path> to include them.",
            );
        } finally {
            output.mockRestore();
        }
    });

    it("enforces the schema fence before resolution without creating missing databases", async () => {
        const old = join(root, "old.db");
        const oldDb = new Database(old);
        oldDb.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY)");
        oldDb.prepare("INSERT INTO schema_migrations VALUES (?)").run(CLI_SCHEMA_FLOOR_VERSION - 1);
        oldDb.close();
        const before = bytes(old);
        await expect(runProjectIdsCli(["plan", "--db", old])).rejects.toThrow(
            "Run a session or doctor migrate first",
        );
        expect(bytes(old)).toBe(before);
        const missing = join(root, "missing.db");
        await expect(runProjectIdsCli(["plan", "--db", missing])).rejects.toThrow(
            "Context database does not exist",
        );
        expect(readdirSync(root)).not.toContain("missing.db");
    }, 30_000);

    it("works on a readonly handle with no schema or merge writes", async () => {
        source("dir:source", [folder("source")]);
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        const copy = join(root, "copy.db");
        copyFileSync(dbPath, copy);
        const readonly = openExistingContextDatabase(copy, {
            readonly: true,
            minimumSupportedVersion: CLI_SCHEMA_FLOOR_VERSION,
        });
        if (!readonly) throw new Error("Missing readonly fixture");
        try {
            expect(
                (
                    await buildProjectIdPlan(readonly, copy, null, {
                        now,
                        resolve: async () => resolved(),
                    })
                ).pairs.length,
            ).toBe(1);
            expect(() => readonly.exec("DELETE FROM project_state")).toThrow();
        } finally {
            readonly.close();
        }
    }, 30_000);

    it("dispatches the CLI plan online under a throwaway root without Entorhinal", async () => {
        source("dir:source", [folder("source")]);
        const child = Bun.spawn(
            [
                process.execPath,
                join(import.meta.dir, "../index.ts"),
                "doctor",
                "project-ids",
                "plan",
                "--db",
                dbPath,
            ],
            {
                cwd: root,
                env: {
                    PATH: process.env.PATH ?? "",
                    HOME: root,
                    XDG_DATA_HOME: join(root, "data"),
                    XDG_CONFIG_HOME: join(root, "config"),
                    XDG_STATE_HOME: join(root, "state"),
                    XDG_RUNTIME_DIR: join(root, "runtime"),
                    OPENCODE_DB: join(root, "unused-host.db"),
                    MAGIC_CONTEXT_STORAGE_DIR: root,
                },
                stdin: "ignore",
                windowsHide: true,
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
        expect(stdout).toContain("Project identity plan:");
        const files = readdirSync(root).filter(
            (name) => name.startsWith("project-id-plan-") && name.endsWith(".json"),
        );
        expect(files.length).toBe(1);
        const result: ProjectIdPlan = JSON.parse(readFileSync(join(root, files[0]), "utf8"));
        expect(result.hostDbPath).toBeNull();
        expect(result.pairs).toEqual([]);
        expect(result.unchanged).toEqual([{ identity: "dir:source", reason: "not_answering" }]);
    }, 30_000);

    it("uses the configured subc connection file in the CLI plan", async () => {
        const directory = folder("configured-project");
        source("dir:configured", [directory]);
        const fake = await fakeProjectEndpoint(root);
        cleanups.push(fake.close);
        const configHome = folder("config/cortexkit");
        writeFileSync(
            join(configHome, "magic-context.jsonc"),
            JSON.stringify({
                subc: { connection_file: fake.connectionFile },
            }),
        );
        const child = Bun.spawn(
            [
                process.execPath,
                join(import.meta.dir, "../index.ts"),
                "doctor",
                "project-ids",
                "plan",
                "--db",
                dbPath,
            ],
            {
                cwd: root,
                env: {
                    PATH: process.env.PATH ?? "",
                    HOME: root,
                    XDG_DATA_HOME: join(root, "data"),
                    XDG_CONFIG_HOME: join(root, "config"),
                    XDG_STATE_HOME: join(root, "state"),
                    MAGIC_CONTEXT_STORAGE_DIR: root,
                },
                windowsHide: true,
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
        expect(stdout).toContain("1 pair(s)");
        const file = readdirSync(root).find((name) => name.startsWith("project-id-plan-"));
        expect(file).toBeDefined();
        const result = JSON.parse(readFileSync(join(root, file!), "utf8")) as ProjectIdPlan;
        expect(result.pairs.map(({ from, to }) => [from, to])).toEqual([
            ["dir:configured", fake.projectId],
        ]);
        expect(fake.calls).toEqual([directory]);
        expect(fake.failures).toEqual([]);
    }, 30_000);
});

it("parses only the online plan command and its path overrides", () => {
    expect(parseProjectIdsPlanArgs(["plan", "--db", "context.db", "--host-db", "host.db"])).toEqual(
        { dbPath: "context.db", hostPath: "host.db" },
    );
    for (const args of [
        [],
        ["apply"],
        ["plan", "--apply"],
        ["plan", "--db"],
        ["plan", "--db", "--host-db"],
        ["plan", "--db", "one", "--db", "two"],
    ]) {
        expect(() => parseProjectIdsPlanArgs(args)).toThrow();
    }
});
