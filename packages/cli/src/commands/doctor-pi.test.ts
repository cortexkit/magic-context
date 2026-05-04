import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "@magic-context/core/shared/sqlite";
import { parse as parseJsonc } from "comment-json";
import type { PiDiagnosticReport } from "../lib/diagnostics-pi";
import type { PromptIO, PromptSpinner, SelectOption } from "../lib/prompts";
import { type RunDoctorOptions, runDoctor } from "./doctor-pi";

const tempRoots: string[] = [];
const originalHome = process.env.HOME;
const originalPiDir = process.env.PI_CODING_AGENT_DIR;
const originalDataHome = process.env.XDG_DATA_HOME;
const originalCacheHome = process.env.XDG_CACHE_HOME;

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
        message: (message: string) => this.messages.push(`message:${message}`),
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
    mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    return process.env.PI_CODING_AGENT_DIR;
}

function writeHealthyFiles(agentDir: string, cwd: string): void {
    writeFileSync(
        join(agentDir, "settings.json"),
        JSON.stringify({
            packages: ["npm:@cortexkit/pi-magic-context", "npm:other-pi-extension"],
        }),
    );
    writeFileSync(
        join(agentDir, "magic-context.jsonc"),
        JSON.stringify({ embedding: { provider: "local" } }),
    );
    writeFileSync(join(cwd, ".pi", "magic-context.jsonc"), JSON.stringify({ enabled: true }));
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
    let currentDb: Database | null = null;
    return {
        cwd,
        prompts,
        deps: {
            detectPiBinary: () => ({
                path: join(root, ".pi", "bin", "pi"),
                source: "home",
            }),
            getPiVersion: () => "0.71.0",
            getLatestNpmVersion: () => "0.1.0",
            openDatabase: () => {
                currentDb = createMockDb();
                return currentDb;
            },
            isDatabasePersisted: () => true,
            closeDatabase: () => currentDb?.close(),
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

    for (const path of tempRoots.splice(0)) {
        rmSync(path, { recursive: true, force: true });
    }
});

describe("Pi doctor", () => {
    it("passes Phase 1 with a healthy mocked environment", async () => {
        const root = makeTempRoot();
        const cwd = makeTempRoot("mc-pi-doctor-cwd-");
        const agentDir = setEnv(root, cwd);
        writeHealthyFiles(agentDir, cwd);
        const prompts = new MockPrompts();

        const code = await runDoctor(baseOptions(root, cwd, prompts));

        expect(code).toBe(0);
        const output = prompts.messages.join("\n");
        expect(output).toContain("PASS Pi 0.71.0 detected");
        expect(output).toContain("PASS npm:@cortexkit/pi-magic-context is registered");
        expect(output).toContain("PASS SQLite integrity_check: ok");
        expect(output).toContain("Summary: PASS");
        expect(output).toContain("FAIL 0");
    });

    it("repairs missing package entry and missing user config in --force mode", async () => {
        const root = makeTempRoot();
        const cwd = makeTempRoot("mc-pi-doctor-cwd-");
        const agentDir = setEnv(root, cwd);
        writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
        writeFileSync(join(cwd, ".pi", "magic-context.jsonc"), JSON.stringify({ enabled: true }));
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
        expect(existsSync(join(agentDir, "magic-context.jsonc"))).toBe(true);
        const output = prompts.messages.join("\n");
        expect(output).toContain("Added npm:@cortexkit/pi-magic-context");
        expect(output).toContain("Wrote default Magic Context config");
        expect(output).toContain("Repair attempted; 2 item(s) changed");
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
            piVersion: "0.71.0",
            settings: {
                path: join(agentDir, "settings.json"),
                exists: true,
                hasMagicContextPackage: true,
                packages: ["npm:@cortexkit/pi-magic-context"],
            },
            configPaths: {
                agentDir,
                userConfig: join(agentDir, "magic-context.jsonc"),
                projectConfig: join(cwd, ".pi", "magic-context.jsonc"),
            },
            userConfig: {
                path: join(agentDir, "magic-context.jsonc"),
                exists: true,
                flags: { embedding: { provider: "local" } },
            },
            projectConfig: {
                path: join(cwd, ".pi", "magic-context.jsonc"),
                exists: true,
                flags: { enabled: true },
            },
            loadedConfigPaths: ["<HOME>/.pi/agent/magic-context.jsonc"],
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
});
