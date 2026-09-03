import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LATEST_SUPPORTED_VERSION } from "@magic-context/core/features/magic-context/storage-db";
import { Database } from "@magic-context/core/shared/sqlite";
import { parse as parseJsonc } from "comment-json";
import { openExistingContextDatabase } from "../lib/database-access";
import type { PiDiagnosticReport } from "../lib/diagnostics-pi";
import type { PromptIO, PromptSpinner, SelectOption } from "../lib/prompts";
import { parseDoctorArgs, type RunDoctorOptions, runDoctor } from "./doctor-pi";

setDefaultTimeout(30_000);

const tempRoots: string[] = [];
const originalHome = process.env.HOME;
const originalPiDir = process.env.PI_CODING_AGENT_DIR;
const originalDataHome = process.env.XDG_DATA_HOME;
const originalCacheHome = process.env.XDG_CACHE_HOME;
const originalConfigHome = process.env.XDG_CONFIG_HOME;

function makeTempRoot(prefix = "mc-pi-doctor-"): string {
    const path = mkdtempSync(join(tmpdir(), prefix));
    tempRoots.push(path);
    return path;
}

class MockPrompts implements PromptIO {
    readonly messages: string[] = [];
    private readonly texts: string[];
    private readonly confirms: boolean[];

    constructor(options: { texts?: string[]; confirms?: boolean[] } = {}) {
        this.texts = [...(options.texts ?? [])];
        this.confirms = [...(options.confirms ?? [])];
    }

    readonly log = {
        info: (message: string) => this.messages.push(`info:${message}`),
        success: (message: string) => this.messages.push(`success:${message}`),
        warn: (message: string) => this.messages.push(`warn:${message}`),
        error: (message: string) => this.messages.push(`error:${message}`),
        message: (message: string) => this.messages.push(`message:${message}`),
        step: (message: string) => this.messages.push(`step:${message}`),
    };

    intro(message: string): void {
        this.messages.push(`intro:${message}`);
    }

    outro(message: string): void {
        this.messages.push(`outro:${message}`);
    }

    note(message: string, title?: string): void {
        this.messages.push(`note:${title ?? ""}:${message}`);
    }

    spinner(): PromptSpinner {
        return {
            start: (message: string) => this.messages.push(`spinner-start:${message}`),
            stop: (message: string) => this.messages.push(`spinner-stop:${message}`),
        };
    }

    async confirm(): Promise<boolean> {
        return this.confirms.shift() ?? false;
    }

    async text(_message: string, options = {}): Promise<string> {
        return this.texts.shift() ?? options.initialValue ?? "mock text";
    }

    async selectOne(_message: string, options: SelectOption[]): Promise<string> {
        return options.find((option) => option.recommended)?.value ?? options[0].value;
    }
}

function setEnv(root: string, cwd: string): string {
    process.env.HOME = root;
    process.env.PI_CODING_AGENT_DIR = join(root, ".pi", "agent");
    process.env.XDG_DATA_HOME = join(root, ".local", "share");
    process.env.XDG_CACHE_HOME = join(root, ".cache");
    process.env.XDG_CONFIG_HOME = join(root, ".config");
    mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
    mkdirSync(join(process.env.XDG_CONFIG_HOME, "cortexkit"), { recursive: true });
    mkdirSync(join(cwd, ".cortexkit"), { recursive: true });
    return process.env.PI_CODING_AGENT_DIR;
}

function writeHealthyFiles(agentDir: string, cwd: string): void {
    writeFileSync(
        join(agentDir, "settings.json"),
        JSON.stringify({
            packages: ["npm:@cortexkit/pi-magic-context", "npm:other-pi-extension"],
        }),
    );
    const configHome = process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config");
    writeFileSync(
        join(configHome, "cortexkit", "magic-context.jsonc"),
        JSON.stringify({ embedding: { provider: "local" } }),
    );
    writeFileSync(
        join(cwd, ".cortexkit", "magic-context.jsonc"),
        JSON.stringify({ enabled: true }),
    );
}

function createInstalledPiPlugin(
    agentDir: string,
    withNativeBinding: boolean,
    withWasmFallback = false,
    withNativePackage = true,
): void {
    const pluginDir = join(agentDir, "npm", "node_modules", "@cortexkit", "pi-magic-context");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
        join(pluginDir, "package.json"),
        JSON.stringify({ name: "@cortexkit/pi-magic-context", version: "0.0.0" }),
    );

    if (withNativePackage) {
        const onnxDir = join(pluginDir, "node_modules", "onnxruntime-node");
        mkdirSync(onnxDir, { recursive: true });
        writeFileSync(
            join(onnxDir, "package.json"),
            JSON.stringify({ name: "onnxruntime-node", main: "index.js" }),
        );
        writeFileSync(join(onnxDir, "index.js"), "module.exports = {};\n");

        if (withNativeBinding) {
            const binDir = join(onnxDir, "bin", "napi-v6", process.platform, process.arch);
            mkdirSync(binDir, { recursive: true });
            writeFileSync(join(binDir, "onnxruntime_binding.node"), "mock native binding");
        }
    }

    if (withWasmFallback) {
        const wasmDir = join(pluginDir, "node_modules", "onnxruntime-web");
        mkdirSync(wasmDir, { recursive: true });
        writeFileSync(
            join(wasmDir, "package.json"),
            JSON.stringify({ name: "onnxruntime-web", main: "index.js" }),
        );
        writeFileSync(join(wasmDir, "index.js"), "module.exports = {};\n");
        const distDir = join(pluginDir, "dist");
        mkdirSync(distDir, { recursive: true });
        writeFileSync(join(distDir, "transformers-node-wasm.js"), "export {};\n");
    }
}

function writePiCachePackage(cacheRoot: string, version: string): string {
    const pluginDir = join(
        cacheRoot,
        "extensions",
        "npm",
        "node_modules",
        "@cortexkit",
        "pi-magic-context",
    );
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
        join(pluginDir, "package.json"),
        JSON.stringify({ name: "@cortexkit/pi-magic-context", version }),
    );
    return pluginDir;
}

function createMockDb(): Database {
    const db = new Database(":memory:");
    db.exec(`
		CREATE TABLE tags (id INTEGER);
		CREATE TABLE compartments (id INTEGER);
		CREATE TABLE memories (id INTEGER);
		CREATE TABLE notes (id INTEGER);
		CREATE TABLE dream_runs (id INTEGER);
		INSERT INTO tags VALUES (1);
		INSERT INTO memories VALUES (1);
	`);
    return db;
}

function baseOptions(root: string, cwd: string, prompts: MockPrompts): RunDoctorOptions {
    const storageDir = join(root, ".local", "share", "cortexkit", "magic-context");
    mkdirSync(storageDir, { recursive: true });
    writeFileSync(join(storageDir, "context.db"), "mock");
    return {
        cwd,
        prompts,
        deps: {
            detectPiBinary: () => ({
                path: join(root, ".pi", "bin", "pi"),
                source: "home",
            }),
            getPiVersion: () => "0.74.0",
            getLatestNpmVersion: () => "0.1.0",
            openExistingContextDatabase: () => createMockDb(),
            now: () => new Date("2026-04-28T12:34:56Z"),
            execFileSync: () => {
                throw new Error("gh unavailable");
            },
            spawnSync: () => ({ status: 1, stdout: "", stderr: "not expected" }) as never,
        },
    };
}

afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalPiDir;
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalDataHome;
    if (originalCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = originalCacheHome;
    if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalConfigHome;

    for (const path of tempRoots.splice(0)) {
        rmSync(path, { recursive: true, force: true });
    }
});

describe("Pi doctor", () => {
    it("parses v22 backfill flags", () => {
        expect(
            parseDoctorArgs([
                "--check-v22-backfill",
                "--retry-v22-backfill",
                "--rekey-v22-dir-identity",
                "/tmp/project",
            ]),
        ).toMatchObject({
            checkV22Backfill: true,
            retryV22Backfill: true,
            rekeyV22DirIdentity: "/tmp/project",
        });
    });

    it("passes Phase 1 with a healthy mocked environment", async () => {
        const root = makeTempRoot();
        const cwd = makeTempRoot("mc-pi-doctor-cwd-");
        const agentDir = setEnv(root, cwd);
        writeHealthyFiles(agentDir, cwd);
        const prompts = new MockPrompts();

        const code = await runDoctor(baseOptions(root, cwd, prompts));

        expect(code).toBe(0);
        const output = prompts.messages.join("\n");
        expect(output).toContain("PASS Pi 0.74.0 detected");
        expect(output).toContain("PASS npm:@cortexkit/pi-magic-context is registered");
        expect(output).toContain("PASS SQLite integrity_check: ok");
        expect(output).toContain("Summary: PASS");
        expect(output).toContain("FAIL 0");
    });

    it("names the database and repair command when integrity_check fails", async () => {
        const root = makeTempRoot();
        const cwd = makeTempRoot("mc-pi-doctor-cwd-");
        const agentDir = setEnv(root, cwd);
        writeHealthyFiles(agentDir, cwd);
        const prompts = new MockPrompts();
        const options = baseOptions(root, cwd, prompts);
        const damaged = createMockDb();
        const originalPrepare = damaged.prepare.bind(damaged);
        (damaged as Database & { prepare: typeof damaged.prepare }).prepare = ((sql: string) => {
            if (sql === "PRAGMA integrity_check") {
                return { get: () => ({ integrity_check: "invalid page number 42" }) };
            }
            return originalPrepare(sql);
        }) as typeof damaged.prepare;
        if (!options.deps) throw new Error("expected doctor dependencies");
        options.deps.openExistingContextDatabase = () => damaged;
        const code = await runDoctor(options);
        expect(code).toBe(1);

        const output = prompts.messages.join("\n");
        const dbPath = join(root, ".local", "share", "cortexkit", "magic-context", "context.db");
        expect(output).toContain(`Database: ${dbPath}`);
        expect(output).toContain("bunx @cortexkit/magic-context@latest doctor repair-db");
    });

    it("leaves an older supported shared DB schema unchanged", async () => {
        const root = makeTempRoot();
        const cwd = makeTempRoot("mc-pi-doctor-cwd-");
        const agentDir = setEnv(root, cwd);
        writeHealthyFiles(agentDir, cwd);
        const prompts = new MockPrompts();
        const options = baseOptions(root, cwd, prompts);
        const dbPath = join(root, ".local", "share", "cortexkit", "magic-context", "context.db");
        rmSync(dbPath);
        const fixture = new Database(dbPath);
        fixture.exec(`
            CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
            INSERT INTO schema_migrations(version) VALUES (50);
            CREATE TABLE tags (id INTEGER);
            CREATE TABLE compartments (id INTEGER);
            CREATE TABLE memories (id INTEGER);
            CREATE TABLE notes (id INTEGER);
            CREATE TABLE dream_runs (id INTEGER);
        `);
        fixture.close();
        if (!options.deps) throw new Error("expected doctor dependencies");
        options.deps.openExistingContextDatabase = openExistingContextDatabase;

        const code = await runDoctor(options);

        expect(code).toBe(0);
        const reopened = new Database(dbPath);
        const version = reopened
            .prepare("SELECT MAX(version) AS version FROM schema_migrations")
            .get() as {
            version: number;
        };
        reopened.close();
        expect(version.version).toBe(50);
        expect(prompts.messages.join("\n")).toContain(
            "PASS Opened the shared DB read-only with a supported schema",
        );
        // The stable storage-version probe reports the live DB schema (50) against
        // this binary's fence, matching the values the RPC status surface carries.
        const output = prompts.messages.join("\n");
        expect(output).toContain("context_db_schema_version=50");
        expect(output).toContain(`plugin_supported_version=${LATEST_SUPPORTED_VERSION}`);
    });

    it("warns when the local onnxruntime native binding is absent", async () => {
        const root = makeTempRoot();
        const cwd = makeTempRoot("mc-pi-doctor-cwd-");
        const agentDir = setEnv(root, cwd);
        writeHealthyFiles(agentDir, cwd);
        createInstalledPiPlugin(agentDir, false);
        const prompts = new MockPrompts();

        const code = await runDoctor(baseOptions(root, cwd, prompts));

        expect(code).toBe(0);
        const output = prompts.messages.join("\n");
        expect(output).toContain(
            "WARN Embedding provider: local — native runtime and WASM fallback both unavailable",
        );
        expect(output).toContain("postinstall likely failed");
        expect(output).toContain("Stale Pi extension cache found");
        expect(output).toContain("WARN 2");
    });

    it("skips unrelated local dev-path packages and broken trees when probing the embedding runtime", async () => {
        const root = makeTempRoot();
        const cwd = makeTempRoot("mc-pi-doctor-cwd-");
        const agentDir = setEnv(root, cwd);
        writeHealthyFiles(agentDir, cwd);

        // Unrelated local extension: has a package.json but is NOT the
        // magic-context plugin. Must not be probed as an embedding candidate.
        const unrelatedPlugin = makeTempRoot("mc-pi-doctor-unrelated-");
        writeFileSync(
            join(unrelatedPlugin, "package.json"),
            JSON.stringify({ name: "pi-tree-git-checkpoint", version: "0.0.0" }),
        );
        // Local dev tree of the actual plugin that is missing all embedding deps.
        const brokenDevTree = makeTempRoot("mc-pi-doctor-dev-");
        writeFileSync(
            join(brokenDevTree, "package.json"),
            JSON.stringify({ name: "@cortexkit/pi-magic-context", version: "0.0.0-dev" }),
        );

        writeFileSync(
            join(agentDir, "settings.json"),
            JSON.stringify({
                packages: [
                    "npm:@cortexkit/pi-magic-context",
                    unrelatedPlugin,
                    brokenDevTree,
                ],
            }),
        );
        createInstalledPiPlugin(agentDir, true);
        const prompts = new MockPrompts();

        const code = await runDoctor(baseOptions(root, cwd, prompts));

        expect(code).toBe(0);
        const output = prompts.messages.join("\n");
        expect(output).toContain(
            "PASS Embedding provider: local (native runtime selected and OK)",
        );
        expect(output).not.toContain(
            "WARN Embedding provider: local — native runtime and WASM fallback both unavailable",
        );
    });

    it("reports the WASM fallback when onnxruntime-node is completely absent", async () => {
        const root = makeTempRoot();
        const cwd = makeTempRoot("mc-pi-doctor-cwd-");
        const agentDir = setEnv(root, cwd);
        writeHealthyFiles(agentDir, cwd);
        createInstalledPiPlugin(agentDir, false, true, false);
        const prompts = new MockPrompts();

        const code = await runDoctor(baseOptions(root, cwd, prompts));

        expect(code).toBe(0);
        const output = prompts.messages.join("\n");
        expect(output).toContain(
            "WARN Embedding provider: local — onnxruntime-node native binding failed",
        );
        expect(output).toContain("WASM fallback active");
        expect(output).not.toContain("native runtime and WASM fallback both unavailable");
    });

    it("passes the local embedding check when the onnxruntime native binding is present", async () => {
        const root = makeTempRoot();
        const cwd = makeTempRoot("mc-pi-doctor-cwd-");
        const agentDir = setEnv(root, cwd);
        writeHealthyFiles(agentDir, cwd);
        createInstalledPiPlugin(agentDir, true);
        const prompts = new MockPrompts();

        const code = await runDoctor(baseOptions(root, cwd, prompts));

        expect(code).toBe(0);
        const output = prompts.messages.join("\n");
        expect(output).toContain("PASS Embedding provider: local (native runtime selected and OK)");
    });

    it("repairs missing package entry and missing user config in --force mode", async () => {
        const root = makeTempRoot();
        const cwd = makeTempRoot("mc-pi-doctor-cwd-");
        const agentDir = setEnv(root, cwd);
        writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
        writeFileSync(
            join(cwd, ".cortexkit", "magic-context.jsonc"),
            JSON.stringify({ enabled: true }),
        );
        const prompts = new MockPrompts();

        const code = await runDoctor({
            ...baseOptions(root, cwd, prompts),
            force: true,
        });

        expect(code).toBe(0);
        const settings = parseJsonc(readFileSync(join(agentDir, "settings.json"), "utf-8")) as {
            packages?: string[];
        };
        expect(settings.packages).toContain("npm:@cortexkit/pi-magic-context");
        expect(existsSync(join(root, ".config", "cortexkit", "magic-context.jsonc"))).toBe(true);
        const output = prompts.messages.join("\n");
        expect(output).toContain("FAIL npm:@cortexkit/pi-magic-context is missing from packages[]");
        expect(output).toContain("Added npm:@cortexkit/pi-magic-context");
        expect(output).toContain("Wrote default Magic Context config");
        expect(output).toContain("Repair attempted; 2 item(s) changed");
    });

    it("migrates legacy Pi user config before --force writes a default", async () => {
        const root = makeTempRoot();
        const cwd = makeTempRoot("mc-pi-doctor-cwd-");
        const agentDir = setEnv(root, cwd);
        const settingsPath = join(agentDir, "settings.json");
        const legacyPath = join(agentDir, "magic-context.jsonc");
        writeFileSync(settingsPath, JSON.stringify({ packages: [] }));
        writeFileSync(legacyPath, JSON.stringify({ protected_tags: 13 }));
        writeFileSync(
            join(cwd, ".cortexkit", "magic-context.jsonc"),
            JSON.stringify({ enabled: true }),
        );
        const prompts = new MockPrompts();

        const code = await runDoctor({
            ...baseOptions(root, cwd, prompts),
            force: true,
        });

        expect(code).toBe(0);
        const targetPath = join(root, ".config", "cortexkit", "magic-context.jsonc");
        const config = parseJsonc(readFileSync(targetPath, "utf-8")) as {
            protected_tags?: number;
        };
        expect(config.protected_tags).toBe(13);
        expect(existsSync(legacyPath)).toBe(false);
        expect(existsSync(`${legacyPath}.MOVED_READPLEASE`)).toBe(true);
        const output = prompts.messages.join("\n");
        expect(output).toContain("FAIL npm:@cortexkit/pi-magic-context is missing from packages[]");
        expect(output).toContain("Migrated Magic Context user config");
        expect(output).not.toContain("Wrote default Magic Context config");
    });

    it("does not write a default when legacy user configs conflict", async () => {
        const root = makeTempRoot();
        const cwd = makeTempRoot("mc-pi-doctor-cwd-");
        const agentDir = setEnv(root, cwd);
        writeFileSync(
            join(agentDir, "settings.json"),
            JSON.stringify({ packages: ["npm:@cortexkit/pi-magic-context"] }),
        );
        writeFileSync(
            join(cwd, ".cortexkit", "magic-context.jsonc"),
            JSON.stringify({ enabled: true }),
        );
        const opencodeDir = join(root, ".config", "opencode");
        mkdirSync(opencodeDir, { recursive: true });
        writeFileSync(
            join(opencodeDir, "magic-context.jsonc"),
            JSON.stringify({ protected_tags: 7 }),
        );
        writeFileSync(
            join(agentDir, "magic-context.jsonc"),
            JSON.stringify({ protected_tags: 13 }),
        );
        const prompts = new MockPrompts();

        const code = await runDoctor({
            ...baseOptions(root, cwd, prompts),
            force: true,
        });

        expect(code).toBe(0);
        expect(existsSync(join(root, ".config", "cortexkit", "magic-context.jsonc"))).toBe(false);
        const output = prompts.messages.join("\n");
        expect(output).toContain("Magic Context user config migration refused");
        expect(output).toContain("Default config repair skipped");
        expect(output).not.toContain("Wrote default Magic Context config");
    });

    it("recognizes object-form Magic Context package and preserves object entries during repair", async () => {
        const root = makeTempRoot();
        const cwd = makeTempRoot("mc-pi-doctor-cwd-");
        const agentDir = setEnv(root, cwd);
        const settingsPath = join(agentDir, "settings.json");
        writeFileSync(
            settingsPath,
            JSON.stringify({
                packages: [
                    { name: "npm:@cortexkit/pi-magic-context", version: "1.2.3" },
                    { name: "third-party-extension", version: "9.9.9", enabled: true },
                    "npm:other-pi-extension",
                ],
            }),
        );
        writeFileSync(
            join(root, ".config", "cortexkit", "magic-context.jsonc"),
            JSON.stringify({ embedding: { provider: "local" } }),
        );
        writeFileSync(
            join(cwd, ".cortexkit", "magic-context.jsonc"),
            JSON.stringify({ enabled: true }),
        );
        const prompts = new MockPrompts();

        const code = await runDoctor({
            ...baseOptions(root, cwd, prompts),
            force: true,
        });

        expect(code).toBe(0);
        const settings = parseJsonc(readFileSync(settingsPath, "utf-8")) as {
            packages?: unknown[];
        };
        expect(settings.packages).toEqual([
            { name: "npm:@cortexkit/pi-magic-context", version: "1.2.3" },
            { name: "third-party-extension", version: "9.9.9", enabled: true },
            "npm:other-pi-extension",
        ]);
        const output = prompts.messages.join("\n");
        expect(output).toContain("PASS npm:@cortexkit/pi-magic-context is registered");
        expect(output).not.toContain("Added npm:@cortexkit/pi-magic-context");
    });

    it("generates a sanitized markdown report in --issue mode without calling gh create", async () => {
        const root = makeTempRoot();
        const cwd = makeTempRoot("mc-pi-doctor-cwd-");
        const agentDir = setEnv(root, cwd);
        writeHealthyFiles(agentDir, cwd);
        writeFileSync(
            join(tmpdir(), "magic-context.log"),
            `token=abc123\nUser path ${root}/secret with sk-12345678901234567890\n`,
        );
        let ghCreateCalled = false;
        const logged: unknown[] = [];
        const originalConsoleLog = console.log;
        console.log = (...args: unknown[]) => {
            logged.push(...args);
        };
        const prompts = new MockPrompts({
            texts: ["Bug title", `Failure in ${root}`],
        });
        const diagnosticReport: PiDiagnosticReport = {
            timestamp: "2026-04-28T12:34:56.000Z",
            platform: "darwin",
            arch: "arm64",
            nodeVersion: "v24.0.0",
            pluginVersion: "0.1.0",
            piInstalled: true,
            piPath: join(root, ".pi", "bin", "pi"),
            piVersion: "0.74.0",
            settings: {
                path: join(agentDir, "settings.json"),
                exists: true,
                hasMagicContextPackage: true,
                packages: ["npm:@cortexkit/pi-magic-context"],
            },
            configPaths: {
                agentDir,
                userConfig: join(root, ".config", "cortexkit", "magic-context.jsonc"),
                projectConfig: join(cwd, ".cortexkit", "magic-context.jsonc"),
            },
            userConfig: {
                path: join(root, ".config", "cortexkit", "magic-context.jsonc"),
                exists: true,
                flags: { embedding: { provider: "local" } },
            },
            projectConfig: {
                path: join(cwd, ".cortexkit", "magic-context.jsonc"),
                exists: true,
                flags: { enabled: true },
            },
            loadedConfigPaths: ["<HOME>/.config/cortexkit/magic-context.jsonc"],
            loadWarnings: [],
            storageDir: {
                path: join(root, ".local", "share", "cortexkit", "magic-context"),
                exists: true,
                contextDbSizeBytes: 4,
            },
            conflicts: { knownConflicts: [], otherPiExtensions: [] },
            logFile: {
                path: join(tmpdir(), "magic-context.log"),
                exists: true,
                sizeKb: 1,
            },
            recentSessions: [],
            historianDumps: {
                byProject: [],
                legacyDumps: {
                    dir: join(tmpdir(), "pi", "magic-context", "historian"),
                    count: 0,
                    recent: [],
                },
            },
        };

        const options = baseOptions(root, cwd, prompts);
        try {
            const code = await runDoctor({
                ...options,
                issue: true,
                deps: {
                    ...options.deps,
                    collectDiagnostics: async () => diagnosticReport,
                    execFileSync: () => {
                        throw new Error("gh unavailable");
                    },
                    spawnSync: () => {
                        ghCreateCalled = true;
                        return { status: 0, stdout: "", stderr: "" } as never;
                    },
                },
            });

            expect(code).toBe(0);
        } finally {
            console.log = originalConsoleLog;
        }

        expect(ghCreateCalled).toBe(false);
        expect(logged.join("\n")).toContain("[pi] Bug title");
        const reportPath = join(cwd, "magic-context-pi-issue-20260428-123456.md");
        expect(existsSync(reportPath)).toBe(true);
        const report = readFileSync(reportPath, "utf-8");
        expect(report).toContain("[pi] Bug title");
        expect(report).toContain("<HOME>");
        expect(report).not.toContain(root);
        expect(report).not.toContain("abc123");
        expect(report).not.toContain("sk-12345678901234567890");
    });

    it("clears stale caches under PI_CODING_AGENT_DIR's parent without touching HOME/.pi/cache", async () => {
        const root = makeTempRoot();
        const home = join(root, "home");
        const cwd = makeTempRoot("mc-pi-doctor-cwd-");
        const agentDir = join(root, "isolated", "agent");
        process.env.HOME = home;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        process.env.XDG_DATA_HOME = join(root, "data");
        process.env.XDG_CACHE_HOME = join(root, "cache");
        process.env.XDG_CONFIG_HOME = join(root, "config");
        mkdirSync(agentDir, { recursive: true });
        mkdirSync(join(process.env.XDG_CONFIG_HOME, "cortexkit"), { recursive: true });
        mkdirSync(join(cwd, ".cortexkit"), { recursive: true });
        writeHealthyFiles(agentDir, cwd);
        const isolatedCachePlugin = writePiCachePackage(join(root, "isolated", "cache"), "9.9.9");
        const homeCachePlugin = writePiCachePackage(join(home, ".pi", "cache"), "9.9.9");
        const prompts = new MockPrompts();

        const code = await runDoctor({
            ...baseOptions(root, cwd, prompts),
            force: true,
        });

        expect(code).toBe(0);
        expect(existsSync(isolatedCachePlugin)).toBe(false);
        expect(existsSync(homeCachePlugin)).toBe(true);
        expect(prompts.messages.join("\n")).toContain(
            `Cleared stale Pi extension cache: ${isolatedCachePlugin}`,
        );
    });

    it("reports an unknown CLI version as info instead of pass-current", async () => {
        const root = makeTempRoot();
        const cwd = makeTempRoot("mc-pi-doctor-cwd-");
        const agentDir = setEnv(root, cwd);
        writeHealthyFiles(agentDir, cwd);
        const prompts = new MockPrompts();
        const options = baseOptions(root, cwd, prompts);

        const code = await runDoctor({
            ...options,
            deps: {
                ...options.deps,
                selfVersion: () => "unknown",
            },
        });

        expect(code).toBe(0);
        const output = prompts.messages.join("\n");
        expect(output).toContain(
            "INFO Magic Context for Pi CLI version unknown; npm latest is v0.1.0",
        );
        expect(output).not.toContain("PASS Magic Context for Pi CLI vunknown is current");
    });

    it("sanitizes invalid-scheme embedding endpoints before printing them", async () => {
        const root = makeTempRoot();
        const cwd = makeTempRoot("mc-pi-doctor-cwd-");
        const agentDir = setEnv(root, cwd);
        writeHealthyFiles(agentDir, cwd);
        writeFileSync(
            join(root, ".config", "cortexkit", "magic-context.jsonc"),
            JSON.stringify({
                embedding: {
                    provider: "openai-compatible",
                    endpoint: "ftp://user:pass@example.com/v1?api_key=secret",
                    model: "text-embedding-3-small",
                },
            }),
        );
        const prompts = new MockPrompts();
        const options = baseOptions(root, cwd, prompts);
        const code = await runDoctor({
            ...options,
            deps: {
                ...options.deps,
                probeEmbeddingEndpoint: async () => ({
                    kind: "invalid_scheme",
                    endpoint: "ftp://user:pass@example.com/v1?api_key=secret",
                }),
            },
        });

        expect(code).toBe(1);
        const output = prompts.messages.join("\n");
        expect(output).toContain("ftp://example.com/v1");
        expect(output).not.toContain("user:pass");
        expect(output).not.toContain("api_key=secret");
    });

    it("checks Copilot reasoning configuration in the Pi historian block", async () => {
        const root = makeTempRoot();
        const cwd = makeTempRoot("mc-pi-doctor-cwd-");
        const agentDir = setEnv(root, cwd);
        writeHealthyFiles(agentDir, cwd);
        writeFileSync(
            join(root, ".config", "cortexkit", "magic-context.jsonc"),
            JSON.stringify({
                embedding: { provider: "local" },
                historian: {
                    opencode: {
                        model: { model: "github-copilot/opencode-only", variant: "high" },
                    },
                    pi: { model: "github-copilot/gpt-5.4" },
                },
            }),
        );
        const prompts = new MockPrompts();

        const code = await runDoctor(baseOptions(root, cwd, prompts));

        expect(code).toBe(0);
        const output = prompts.messages.join("\n");
        expect(output).toContain(
            'WARN historian.model "github-copilot/gpt-5.4" is a GitHub Copilot reasoning model',
        );
        expect(output).not.toContain('github-copilot/opencode-only" is a GitHub Copilot');
    });

    it("sanitizes thrown embedding probe errors before printing them", async () => {
        const root = makeTempRoot();
        const cwd = makeTempRoot("mc-pi-doctor-cwd-");
        const agentDir = setEnv(root, cwd);
        writeHealthyFiles(agentDir, cwd);
        writeFileSync(
            join(root, ".config", "cortexkit", "magic-context.jsonc"),
            JSON.stringify({
                embedding: {
                    provider: "openai-compatible",
                    endpoint: "https://example.com/v1",
                    model: "text-embedding-3-small",
                },
            }),
        );
        const prompts = new MockPrompts();
        const options = baseOptions(root, cwd, prompts);
        const code = await runDoctor({
            ...options,
            deps: {
                ...options.deps,
                probeEmbeddingEndpoint: async () => {
                    throw new Error("token=abc123 from /Users/alice/private");
                },
            },
        });

        expect(code).toBe(1);
        const output = prompts.messages.join("\n");
        expect(output).toContain("Embedding probe threw: token=<REDACTED:token>");
        expect(output).toContain("/Users/<USER>/private");
        expect(output).not.toContain("alice");
        expect(output).not.toContain("token=abc123");
    });
});
