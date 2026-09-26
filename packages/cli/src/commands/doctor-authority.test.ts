import { describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as contextAuthority from "@magic-context/core/features/magic-context/context-authority";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import { MARKER_LANE_VERSION } from "@magic-context/core/features/magic-context/single-store-marker";
import {
    initializeDatabase,
    runMigrations,
} from "@magic-context/core/features/magic-context/storage";
import { SubcModuleTransport } from "@magic-context/core/hooks/magic-context/module-transport";
import { Database } from "@magic-context/core/shared/sqlite";

import {
    reportAuthorityMarkers,
    reportModuleContextDbPath,
    runDoctorDrainAuthority,
} from "./doctor-authority";

function writeSubcConfig(configHome: string, connectionFile: string): void {
    const configDir = join(configHome, "cortexkit");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
        join(configDir, "magic-context.jsonc"),
        JSON.stringify({ subc: { connection_file: connectionFile } }),
    );
}

function createContextDatabase(path: string, projectPath: string): Database {
    const db = new Database(path);
    initializeDatabase(db);
    runMigrations(db);
    db.prepare(
        "INSERT INTO authority_managed (project_path, context_store_uuid, marked_at) VALUES (?, 'store-test', 0)",
    ).run(projectPath);
    return db;
}

function captureAuthorityStatusConnectionFiles(): {
    paths: string[];
    restore(): void;
} {
    const paths: string[] = [];
    const spy = spyOn(SubcModuleTransport.prototype, "authorityStatus").mockImplementation(
        async function (args) {
            paths.push((this as unknown as { connectionFile: string }).connectionFile);
            return {
                authority: {
                    context_store_uuid: args.context_store_uuid,
                    project: args.project,
                    domain: args.domain,
                    state: "TS",
                    generation: 1,
                },
            };
        },
    );
    return { paths, restore: () => spy.mockRestore() };
}

function plantMarker(db: Database, projectPath: string, uuid: string): void {
    db.prepare(
        `INSERT INTO single_store_projects
            (project_path, context_store_uuid, marked_at, marked_by_version)
         VALUES (?, ?, 1700000000123, 'build-sha-for-' || ?)`,
    ).run(projectPath, uuid, projectPath);
}

type DomainState = "TS" | "PREPARING" | "MODULE" | "DRAINING";

/** Stub every module route the doctor can reach, counting the calls. */
function stubModule(states: { memories: DomainState; notes: DomainState } | "unreachable") {
    const calls = { authorityStatus: 0, authorityDrain: 0, markerStatus: 0, mirrorPull: 0 };
    const spies = [
        spyOn(SubcModuleTransport.prototype, "authorityStatus").mockImplementation(async (args) => {
            calls.authorityStatus += 1;
            if (states === "unreachable") throw new Error("connect ENOENT");
            return {
                authority: {
                    context_store_uuid: args.context_store_uuid,
                    project: args.project,
                    domain: args.domain,
                    state: states[args.domain],
                    generation: 1,
                },
            };
        }),
        spyOn(SubcModuleTransport.prototype, "authorityDrain").mockImplementation(async () => {
            calls.authorityDrain += 1;
            throw new Error("the drain must not begin");
        }),
        spyOn(SubcModuleTransport.prototype, "markerStatus").mockImplementation(async () => {
            calls.markerStatus += 1;
            return { ok: true };
        }),
        spyOn(SubcModuleTransport.prototype, "mirrorPull").mockImplementation(async () => {
            calls.mirrorPull += 1;
            throw new Error("mirror.pull must not run");
        }),
    ];
    return {
        calls,
        restore: () => {
            for (const spy of spies) spy.mockRestore();
        },
    };
}

function captureConsole(): { output: () => string; restore(): void } {
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
    });
    const error = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
    });
    return {
        output: () => lines.join("\n"),
        restore: () => {
            log.mockRestore();
            error.mockRestore();
        },
    };
}

describe("doctor drain-authority on a single-store project", () => {
    for (const states of [
        { memories: "TS", notes: "MODULE" },
        { memories: "MODULE", notes: "MODULE" },
    ] as const) {
        it(`refuses once with the tripwire (memories=${states.memories}, notes=${states.notes})`, async () => {
            const root = mkdtempSync(join(tmpdir(), "mc-doctor-single-store-"));
            const dbPath = join(root, "context.db");
            const module = stubModule(states);
            const drains = spyOn(contextAuthority, "drainAuthority");
            const console = captureConsole();
            try {
                const projectPath = resolveProjectIdentity(root);
                const db = createContextDatabase(dbPath, projectPath);
                plantMarker(db, projectPath, "store-test");
                db.close();

                expect(await runDoctorDrainAuthority(root, dbPath)).toBe(1);

                const output = console.output();
                expect(output).toContain("single_store_tripwire");
                expect(output).toContain(`build-sha-for-${projectPath}`);
                expect(output).not.toContain("Authority drain is contended and remains retryable");
                // The doctor's own marker read runs once, for the one domain it drains.
                expect(output.split("Single-store marker for").length - 1).toBe(1);
                expect(drains).toHaveBeenCalledTimes(1);
                const firstRefused = states.memories === "MODULE" ? "memories" : "notes";
                expect(drains.mock.calls[0]?.[0]?.domain).toBe(firstRefused);
                expect(await drains.mock.results[0]?.value).toEqual({
                    code: "single_store_tripwire",
                    retryable: false,
                    state: "MODULE",
                    attempts: 0,
                    authority: null,
                });
                // No domain after the refused one is even looked at.
                expect(module.calls.authorityStatus).toBe(firstRefused === "memories" ? 1 : 2);
                expect(module.calls.authorityDrain + module.calls.mirrorPull).toBe(0);
            } finally {
                console.restore();
                drains.mockRestore();
                module.restore();
                rmSync(root, { recursive: true, force: true });
            }
        });
    }

    it("keeps the shipped eligibility answers", async () => {
        const root = mkdtempSync(join(tmpdir(), "mc-doctor-single-store-gates-"));
        const drains = spyOn(contextAuthority, "drainAuthority");
        const console = captureConsole();
        try {
            expect(await runDoctorDrainAuthority(root, join(root, "absent.db"))).toBe(1);
            expect(console.output()).toContain("No Magic Context database found.");

            // A marked project with no authority_managed row has nothing to drain.
            const unmanagedPath = join(root, "unmanaged.db");
            const unmanaged = new Database(unmanagedPath);
            initializeDatabase(unmanaged);
            runMigrations(unmanaged);
            plantMarker(unmanaged, resolveProjectIdentity(root), "store-test");
            unmanaged.close();
            expect(await runDoctorDrainAuthority(root, unmanagedPath)).toBe(0);
            expect(console.output()).toContain("No authority_managed marker exists");
            expect(drains).toHaveBeenCalledTimes(0);

            const preparingPath = join(root, "preparing.db");
            createContextDatabase(preparingPath, resolveProjectIdentity(root)).close();
            const module = stubModule({ memories: "PREPARING", notes: "MODULE" });
            try {
                expect(await runDoctorDrainAuthority(root, preparingPath)).toBe(1);
                expect(console.output()).toContain("retry after it settles");
            } finally {
                module.restore();
            }
        } finally {
            console.restore();
            drains.mockRestore();
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("doctor per-project single-store report", () => {
    const OUTSIDE_ROOT =
        "module state unavailable outside its project root — writes fenced; run with rust mode or restore subc connectivity";
    const UNREACHABLE =
        "module unreachable — writes fenced; run with rust mode or restore subc connectivity";

    async function report(
        setup: (db: Database, ids: { a: string; b: string; c: string }) => void,
        states: { memories: DomainState; notes: DomainState } | "unreachable" = {
            memories: "MODULE",
            notes: "TS",
        },
    ) {
        const root = mkdtempSync(join(tmpdir(), "mc-doctor-single-store-report-"));
        const originalCwd = process.cwd();
        const originalConfigHome = process.env.XDG_CONFIG_HOME;
        const module = stubModule(states);
        const info: string[] = [];
        const warn: string[] = [];
        const fail: string[] = [];
        let db: Database | null = null;
        try {
            process.env.XDG_CONFIG_HOME = join(root, "config");
            process.chdir(root);
            const ids = {
                a: "git:report-a",
                b: resolveProjectIdentity(process.cwd()),
                c: "git:report-c",
            };
            db = new Database(":memory:");
            initializeDatabase(db);
            runMigrations(db);
            const uuid = contextAuthority.ensureContextStoreUuid(db);
            for (const project of [ids.b, ids.c]) {
                db.prepare(
                    "INSERT INTO authority_managed (project_path, context_store_uuid, marked_at) VALUES (?, ?, 0)",
                ).run(project, uuid);
            }
            plantMarker(db, ids.a, uuid);
            plantMarker(db, ids.b, uuid);
            setup(db, ids);
            await reportAuthorityMarkers({
                db,
                info: (message) => info.push(message),
                warn: (message) => warn.push(message),
                fail: (message) => fail.push(message),
            });
            return { ids, info, warn, fail, calls: module.calls };
        } finally {
            db?.close();
            module.restore();
            process.chdir(originalCwd);
            if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
            else process.env.XDG_CONFIG_HOME = originalConfigHome;
            rmSync(root, { recursive: true, force: true });
        }
    }

    function markerLines(info: string[]): string[] {
        return info.filter((line) => line.includes("single_store_marker="));
    }

    it("lists the union of marked and authority-managed projects once each", async () => {
        const { ids, info, warn, fail } = await report(() => {});
        expect(markerLines(info)).toEqual([
            `  ${ids.b}: single_store_marker=present marked_at=1700000000123 marked_by_version=build-sha-for-${ids.b} context_store_uuid_mismatch=false`,
            `  ${ids.c}: single_store_marker=absent`,
            `  ${ids.a}: single_store_marker=present marked_at=1700000000123 marked_by_version=build-sha-for-${ids.a} context_store_uuid_mismatch=false`,
        ]);
        // Authority state only for the project the command runs in.
        expect(info).toContain(`  ${ids.b}: memories=MODULE, notes=TS`);
        expect(info.some((line) => line.startsWith(`  ${ids.a}: memories=`))).toBe(false);
        expect(warn).toEqual([`  ${ids.c}: ${OUTSIDE_ROOT}`]);
        expect(fail).toEqual([]);
    });

    it("flags a marker row written in another context.db and still lists the project", async () => {
        const { ids, info } = await report((db, projects) => {
            db.prepare(
                "UPDATE single_store_projects SET context_store_uuid = 'copied-from-elsewhere' WHERE project_path = ?",
            ).run(projects.a);
        });
        expect(markerLines(info)).toContain(
            `  ${ids.a}: single_store_marker=present marked_at=1700000000123 marked_by_version=build-sha-for-${ids.a} context_store_uuid_mismatch=true`,
        );
    });

    it("keeps both shipped warnings when the module is unreachable and does not fail", async () => {
        const { ids, info, warn, fail } = await report(() => {}, "unreachable");
        expect(markerLines(info)).toHaveLength(3);
        expect(warn).toEqual([`  ${ids.b}: ${UNREACHABLE}`, `  ${ids.c}: ${OUTSIDE_ROOT}`]);
        expect(fail).toEqual([]);
    });

    it("fails, without throwing, when the marker table is unreadable at the lane", async () => {
        const { ids, info, fail } = await report((db) => {
            db.exec("DROP TABLE single_store_projects");
        });
        expect(fail).toHaveLength(1);
        expect(fail[0]).toContain("single-store marker table unreadable");
        expect(markerLines(info)).toEqual([
            `  ${ids.b}: single_store_marker=unreadable`,
            `  ${ids.c}: single_store_marker=unreadable`,
        ]);
    });

    it("reports below_lane and nothing else new on a file the migration has not reached", async () => {
        const { ids, info, warn, fail } = await report((db) => {
            db.exec("DROP TABLE single_store_projects");
            db.prepare("DELETE FROM schema_migrations WHERE version >= ?").run(
                MARKER_LANE_VERSION - 1,
            );
        });
        expect(markerLines(info)).toEqual([
            `  ${ids.b}: single_store_marker=below_lane`,
            `  ${ids.c}: single_store_marker=below_lane`,
        ]);
        expect(warn).toEqual([`  ${ids.c}: ${OUTSIDE_ROOT}`]);
        expect(fail).toEqual([]);
    });
});

describe("doctor context.db path agreement with the module", () => {
    async function check(answer: () => Promise<{ ok: boolean; context_db_path?: string }>) {
        const info: string[] = [];
        const warn: string[] = [];
        await reportModuleContextDbPath({
            hostPath: "/data/host/cortexkit/magic-context/context.db",
            projectPath: "git:path-check",
            projectRoot: "/work/path-check",
            module: { markerStatus: answer },
            info: (message) => info.push(message),
            warn: (message) => warn.push(message),
        });
        return { info, warn };
    }

    it("says so when both read the same file", async () => {
        const { info, warn } = await check(async () => ({
            ok: true,
            context_db_path: "/data/host/cortexkit/magic-context/../magic-context/context.db",
        }));
        expect(warn).toEqual([]);
        expect(info).toEqual([
            "  context.db path agrees with the module: /data/host/cortexkit/magic-context/context.db",
        ]);
    });

    it("names both paths when they differ", async () => {
        const { warn } = await check(async () => ({
            ok: true,
            context_db_path: "/Users/me/.local/share/cortexkit/magic-context/context.db",
        }));
        expect(warn).toHaveLength(1);
        expect(warn[0]).toContain("context.db path mismatch");
        expect(warn[0]).toContain("/data/host/cortexkit/magic-context/context.db");
        expect(warn[0]).toContain("/Users/me/.local/share/cortexkit/magic-context/context.db");
    });

    it("names a module that cannot open its context.db", async () => {
        const { warn } = await check(async () => {
            throw Object.assign(
                new Error("could not open /elsewhere/context.db for domain writes: unable to open"),
                { code: "mirror_pull_failed" },
            );
        });
        expect(warn).toHaveLength(1);
        expect(warn[0]).toContain("module cannot open context.db");
        expect(warn[0]).toContain("/elsewhere/context.db");
    });

    it("stays quiet on a tripwire and warns without a path from an older module or no module", async () => {
        expect(
            await check(async () => {
                throw Object.assign(new Error("marked"), { code: "single_store_tripwire" });
            }),
        ).toEqual({ info: [], warn: [] });
        const old = await check(async () => ({ ok: true }));
        expect(old.warn).toEqual([
            "  module context.db path not checked: this module build does not report it",
        ]);
        const unreachable = await check(async () => {
            throw new Error("connect ENOENT");
        });
        expect(unreachable.warn).toEqual(["  module context.db path not checked: connect ENOENT"]);
    });
});

describe("doctor authority subc configuration", () => {
    it("reportAuthorityMarkers constructs its transport with configured subc.connection_file", async () => {
        const root = mkdtempSync(join(tmpdir(), "mc-doctor-authority-report-"));
        const originalCwd = process.cwd();
        const originalConfigHome = process.env.XDG_CONFIG_HOME;
        const configuredConnectionFile = join(root, "configured-subc.json");
        const capture = captureAuthorityStatusConnectionFiles();
        let db: Database | null = null;
        try {
            process.env.XDG_CONFIG_HOME = join(root, "config");
            writeSubcConfig(process.env.XDG_CONFIG_HOME, configuredConnectionFile);
            process.chdir(root);
            db = createContextDatabase(":memory:", resolveProjectIdentity(process.cwd()));

            await reportAuthorityMarkers({ db, info: () => {}, warn: () => {} });

            expect(capture.paths).toEqual([configuredConnectionFile, configuredConnectionFile]);
        } finally {
            db?.close();
            capture.restore();
            process.chdir(originalCwd);
            if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
            else process.env.XDG_CONFIG_HOME = originalConfigHome;
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("runDoctorDrainAuthority constructs its transport with configured subc.connection_file", async () => {
        const root = mkdtempSync(join(tmpdir(), "mc-doctor-authority-drain-"));
        const originalConfigHome = process.env.XDG_CONFIG_HOME;
        const configuredConnectionFile = join(root, "configured-subc.json");
        const dbPath = join(root, "context.db");
        const capture = captureAuthorityStatusConnectionFiles();
        try {
            process.env.XDG_CONFIG_HOME = join(root, "config");
            writeSubcConfig(process.env.XDG_CONFIG_HOME, configuredConnectionFile);
            const db = createContextDatabase(dbPath, resolveProjectIdentity(root));
            db.close();

            expect(await runDoctorDrainAuthority(root, dbPath)).toBe(1);
            expect(capture.paths).toEqual([configuredConnectionFile, configuredConnectionFile]);
        } finally {
            capture.restore();
            if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
            else process.env.XDG_CONFIG_HOME = originalConfigHome;
            rmSync(root, { recursive: true, force: true });
        }
    });
});
