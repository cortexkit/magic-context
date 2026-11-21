import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordDreamerTickFailure } from "@magic-context/core/features/magic-context/dreamer/tick-failure";
import { openDatabase } from "@magic-context/core/features/magic-context/storage";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import { inspectMagicContextLogs } from "../lib/log-lines";
import type { PromptIO, PromptSpinner, SelectOption } from "../lib/prompts";
import { runDoctor } from "./doctor-omp";

class MockPrompts implements PromptIO {
    readonly messages: string[] = [];
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
    outro(): void {}
    note(): void {}
    spinner(): PromptSpinner {
        return { start: () => {}, stop: () => {}, message: () => {} };
    }
    async confirm(): Promise<boolean> {
        return false;
    }
    async text(): Promise<string> {
        return "test";
    }
    async selectOne(_message: string, options: SelectOption[]): Promise<string> {
        return options[0]?.value ?? "";
    }
    async selectMany(_message: string, options: SelectOption[]): Promise<string[]> {
        return options.map((option) => option.value);
    }
    async selectAutocomplete(_message: string, options: SelectOption[]): Promise<string> {
        return options[0]?.value ?? "";
    }
}

const roots: string[] = [];
const original = {
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_CONFIG_FILES: process.env.PI_CONFIG_FILES,
};

afterEach(() => {
    for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("OMP doctor", () => {
    it.each([
        "without flags",
        "--fix",
        "--force",
    ])("accepts a healthy OMP installation %s", async (mode) => {
        const root = createTestTempDirFromPath(join(tmpdir(), "mc-omp-doctor-"));
        roots.push(root);
        const agentDir = join(root, ".omp", "agent");
        const pluginDir = join(root, "plugin");
        const configDir = join(root, ".config", "cortexkit");
        mkdirSync(agentDir, { recursive: true });
        mkdirSync(pluginDir, { recursive: true });
        mkdirSync(configDir, { recursive: true });
        writeFileSync(
            join(pluginDir, "package.json"),
            JSON.stringify({ omp: { extensions: ["./dist/index.js"] } }),
        );
        writeFileSync(join(configDir, "magic-context.jsonc"), "{}\n");
        process.env.HOME = root;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        process.env.XDG_CONFIG_HOME = join(root, ".config");
        // Redirect explicitly: Bun caches os.homedir(), so deleting this can
        // make integrity_check reach the user's real context.db.
        process.env.XDG_DATA_HOME = join(root, ".local", "share");
        const prompts = new MockPrompts();

        const code = await runDoctor({
            cwd: root,
            prompts,
            fix: mode === "--fix",
            force: mode === "--force",
            deps: {
                detectOmpBinary: () => ({ path: "/fake/omp", source: "path" }),
                getOmpVersion: () => "17.1.7",
                listOmpPlugins: () => [
                    {
                        name: "@cortexkit/pi-magic-context",
                        version: "0.33.0",
                        enabled: true,
                        path: pluginDir,
                    },
                ],
                getOmpSetting: ((_path: string, key: string) =>
                    key === "compaction.enabled" ? false : "off") as never,
                runOmpCommand: (_path, args) => {
                    expect(args).toEqual(["config", "path"]);
                    return { ok: true, stdout: `${agentDir}/./`, stderr: "" };
                },
            },
        });

        expect(code).toBe(0);
        expect(prompts.messages.join("\n")).toContain("OMP 17.1.7 detected");
        expect(prompts.messages.join("\n")).toContain(
            `warn:WARN Magic Context storage is at ${join(root, ".local", "share", "cortexkit", "magic-context")}, outside the folder Engram backs up (~/.local/share/cortexkit/magic-context). It is not included in CortexKit backups.`,
        );
        expect(prompts.messages.join("\n")).toContain("FAIL 0");
        const guidance = prompts.messages.find((message) =>
            message.includes("omp plugin install @cortexkit/pi-magic-context@latest"),
        );
        if (mode === "without flags") expect(guidance).toBeUndefined();
        else expect(guidance).toContain("restart running Oh My Pi sessions");
        expect(
            prompts.messages.some((message) => message.includes("config repairs need --force")),
        ).toBe(mode === "--fix");
    });

    it("does not fail or run OMP checks when Magic Context is not installed", async () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "mc-omp-doctor-uninstalled-"));
        roots.push(root);
        const agentDir = join(root, ".omp", "agent");
        const configDir = join(root, ".config", "cortexkit");
        mkdirSync(agentDir, { recursive: true });
        mkdirSync(configDir, { recursive: true });
        writeFileSync(join(configDir, "magic-context.jsonc"), "{}\n");
        process.env.HOME = root;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        process.env.XDG_CONFIG_HOME = join(root, ".config");
        process.env.XDG_DATA_HOME = join(root, ".local", "share");
        const prompts = new MockPrompts();

        const code = await runDoctor({
            cwd: root,
            prompts,
            deps: {
                detectOmpBinary: () => ({ path: "/fake/omp", source: "path" }),
                getOmpVersion: () => "17.0.0",
                listOmpPlugins: () => [],
                getOmpSetting: (() => {
                    throw new Error("OMP settings should not be checked without the plugin");
                }) as never,
                runOmpCommand: () => {
                    throw new Error("OMP configuration should not be checked without the plugin");
                },
            },
        });

        expect(code).toBe(0);
        expect(prompts.messages).toContain(
            "info:INFO Oh My Pi 17.0.0 found; Magic Context is not installed there (run setup to add it)",
        );
        expect(
            prompts.messages.filter((message) => message.startsWith("info:INFO Oh My Pi ")),
        ).toHaveLength(1);
        expect(prompts.messages.filter((message) => message.startsWith("error:"))).toHaveLength(0);
        expect(prompts.messages.join("\n")).toContain("FAIL 0");
    });

    it("still fails when Magic Context is installed on an old OMP version", async () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "mc-omp-doctor-old-version-"));
        roots.push(root);
        const agentDir = join(root, ".omp", "agent");
        const pluginDir = join(root, "plugin");
        const configDir = join(root, ".config", "cortexkit");
        mkdirSync(agentDir, { recursive: true });
        mkdirSync(pluginDir, { recursive: true });
        mkdirSync(configDir, { recursive: true });
        writeFileSync(
            join(pluginDir, "package.json"),
            JSON.stringify({ omp: { extensions: ["./dist/index.js"] } }),
        );
        writeFileSync(join(configDir, "magic-context.jsonc"), "{}\n");
        process.env.HOME = root;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        process.env.XDG_CONFIG_HOME = join(root, ".config");
        process.env.XDG_DATA_HOME = join(root, ".local", "share");
        const prompts = new MockPrompts();

        const code = await runDoctor({
            cwd: root,
            prompts,
            deps: {
                detectOmpBinary: () => ({ path: "/fake/omp", source: "path" }),
                getOmpVersion: () => "17.0.0",
                listOmpPlugins: () => [
                    {
                        name: "@cortexkit/pi-magic-context",
                        version: "0.33.0",
                        enabled: true,
                        path: pluginDir,
                    },
                ],
                getOmpSetting: ((_path: string, key: string) =>
                    key === "compaction.enabled" ? false : "off") as never,
                runOmpCommand: () => ({ ok: true, stdout: agentDir, stderr: "" }),
            },
        });

        expect(code).toBe(1);
        expect(prompts.messages.join("\n")).toContain(
            "OMP 17.0.0 is older than tested minimum 17.1.7",
        );
    });

    /**
     * A maintenance pass that stops before its work leaves no failed task and
     * no changed schedule row, so the doctor is where a user can find out that
     * the background maintenance is not running at all (issue 496).
     */
    it("reports a background maintenance pass that stopped before its work", async () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "mc-omp-doctor-tick-"));
        roots.push(root);
        const agentDir = join(root, ".omp", "agent");
        const pluginDir = join(root, "plugin");
        const configDir = join(root, ".config", "cortexkit");
        const storageDir = join(root, ".local", "share", "cortexkit", "magic-context");
        mkdirSync(agentDir, { recursive: true });
        mkdirSync(pluginDir, { recursive: true });
        mkdirSync(configDir, { recursive: true });
        mkdirSync(storageDir, { recursive: true });
        writeFileSync(
            join(pluginDir, "package.json"),
            JSON.stringify({ omp: { extensions: ["./dist/index.js"] } }),
        );
        writeFileSync(join(configDir, "magic-context.jsonc"), "{}\n");
        process.env.HOME = root;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        process.env.XDG_CONFIG_HOME = join(root, ".config");
        process.env.XDG_DATA_HOME = join(root, ".local", "share");
        const seeded = openDatabase({ dbPath: join(storageDir, "context.db") });
        if (!seeded) throw new Error("could not create the test context database");
        recordDreamerTickFailure(seeded, {
            at: Date.parse("2026-09-21T09:15:00.000Z"),
            stage: "message-history maintenance",
            message: "OpenCode orphan sweep cannot read a omp host store",
        });
        seeded.close();
        const prompts = new MockPrompts();

        const code = await runDoctor({
            cwd: root,
            prompts,
            deps: {
                detectOmpBinary: () => ({ path: "/fake/omp", source: "path" }),
                getOmpVersion: () => "17.1.7",
                listOmpPlugins: () => [
                    {
                        name: "@cortexkit/pi-magic-context",
                        version: "0.42.6",
                        enabled: true,
                        path: pluginDir,
                    },
                ],
                getOmpSetting: ((_path: string, key: string) =>
                    key === "compaction.enabled" ? false : "off") as never,
                runOmpCommand: () => ({ ok: true, stdout: agentDir, stderr: "" }),
            },
        });

        expect(code).toBe(0);
        const output = prompts.messages.join("\n");
        expect(output).toContain("MC-D09");
        expect(output).toContain("Background maintenance stopped in message-history maintenance");
        expect(output).not.toContain("Background maintenance completed its last pass");
    });

    it("reports a background maintenance pass that completed", async () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "mc-omp-doctor-tick-ok-"));
        roots.push(root);
        const agentDir = join(root, ".omp", "agent");
        const pluginDir = join(root, "plugin");
        const configDir = join(root, ".config", "cortexkit");
        const storageDir = join(root, ".local", "share", "cortexkit", "magic-context");
        mkdirSync(agentDir, { recursive: true });
        mkdirSync(pluginDir, { recursive: true });
        mkdirSync(configDir, { recursive: true });
        mkdirSync(storageDir, { recursive: true });
        writeFileSync(
            join(pluginDir, "package.json"),
            JSON.stringify({ omp: { extensions: ["./dist/index.js"] } }),
        );
        writeFileSync(join(configDir, "magic-context.jsonc"), "{}\n");
        process.env.HOME = root;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        process.env.XDG_CONFIG_HOME = join(root, ".config");
        process.env.XDG_DATA_HOME = join(root, ".local", "share");
        const seeded = openDatabase({ dbPath: join(storageDir, "context.db") });
        if (!seeded) throw new Error("could not create the test context database");
        seeded.close();
        const prompts = new MockPrompts();

        const code = await runDoctor({
            cwd: root,
            prompts,
            deps: {
                detectOmpBinary: () => ({ path: "/fake/omp", source: "path" }),
                getOmpVersion: () => "17.1.7",
                listOmpPlugins: () => [
                    {
                        name: "@cortexkit/pi-magic-context",
                        version: "0.42.6",
                        enabled: true,
                        path: pluginDir,
                    },
                ],
                getOmpSetting: ((_path: string, key: string) =>
                    key === "compaction.enabled" ? false : "off") as never,
                runOmpCommand: () => ({ ok: true, stdout: agentDir, stderr: "" }),
            },
        });

        expect(code).toBe(0);
        const output = prompts.messages.join("\n");
        expect(output).toContain("Background maintenance completed its last pass");
        expect(output).not.toContain("MC-D09");
    });

    it("reads the OMP legacy log when no Pi log exists", async () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "mc-omp-doctor-log-"));
        roots.push(root);
        const agentDir = join(root, ".omp", "agent");
        const pluginDir = join(root, "plugin");
        const configDir = join(root, ".config", "cortexkit");
        const ompLog = join(root, "omp", "magic-context", "magic-context.log");
        mkdirSync(agentDir, { recursive: true });
        mkdirSync(pluginDir, { recursive: true });
        mkdirSync(configDir, { recursive: true });
        mkdirSync(join(root, "omp", "magic-context"), { recursive: true });
        writeFileSync(
            join(pluginDir, "package.json"),
            JSON.stringify({ omp: { extensions: ["./dist/index.js"] } }),
        );
        writeFileSync(join(configDir, "magic-context.jsonc"), "{}\n");
        writeFileSync(ompLog, "[2026-09-05T10:41:03.130Z] [magic-context][ses_omp] OMP started\n");
        process.env.HOME = root;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        process.env.XDG_CONFIG_HOME = join(root, ".config");
        process.env.XDG_DATA_HOME = join(root, ".local", "share");
        const prompts = new MockPrompts();

        const code = await runDoctor({
            cwd: root,
            prompts,
            deps: {
                detectOmpBinary: () => ({ path: "/fake/omp", source: "path" }),
                getOmpVersion: () => "17.1.7",
                listOmpPlugins: () => [
                    {
                        name: "@cortexkit/pi-magic-context",
                        version: "0.41.3",
                        enabled: true,
                        path: pluginDir,
                    },
                ],
                getOmpSetting: ((_path: string, key: string) =>
                    key === "compaction.enabled" ? false : "off") as never,
                runOmpCommand: () => ({ ok: true, stdout: agentDir, stderr: "" }),
                inspectMagicContextLogs: (harness) =>
                    inspectMagicContextLogs(harness, {
                        tempDir: root,
                        storageDir: join(root, "storage"),
                        override: null,
                    }),
            },
        });

        expect(code).toBe(0);
        expect(prompts.messages.join("\n")).toContain(
            `OMP runtime log read: ${ompLog} (grammar=legacy, lines=1`,
        );
        expect(prompts.messages.join("\n")).not.toContain(
            join(root, "pi", "magic-context", "magic-context.log"),
        );
    });

    it("repairs a missing config when it is the only health finding", async () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "mc-omp-doctor-config-only-"));
        roots.push(root);
        const agentDir = join(root, ".omp", "agent");
        const pluginDir = join(root, "plugin");
        mkdirSync(agentDir, { recursive: true });
        mkdirSync(pluginDir, { recursive: true });
        writeFileSync(
            join(pluginDir, "package.json"),
            JSON.stringify({ omp: { extensions: ["./dist/index.js"] } }),
        );
        process.env.HOME = root;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        process.env.XDG_CONFIG_HOME = join(root, ".config");
        process.env.XDG_DATA_HOME = join(root, ".local", "share");
        const prompts = new MockPrompts();

        const code = await runDoctor({
            cwd: root,
            force: true,
            prompts,
            deps: {
                detectOmpBinary: () => ({ path: "/fake/omp", source: "path" }),
                getOmpVersion: () => "17.1.7",
                listOmpPlugins: () => [
                    {
                        name: "@cortexkit/pi-magic-context",
                        version: "0.35.1",
                        enabled: true,
                        path: pluginDir,
                    },
                ],
                getOmpSetting: ((_path: string, key: string) =>
                    key === "compaction.enabled" ? false : "off") as never,
                runOmpCommand: () => ({ ok: true, stdout: agentDir, stderr: "" }),
            },
        });

        expect(code).toBe(0);
        // Only $schema is written: explicit copies of every schema default would
        // pin them, so later default changes would never reach this user.
        expect(
            JSON.parse(
                readFileSync(join(root, ".config", "cortexkit", "magic-context.jsonc"), "utf-8"),
            ),
        ).toEqual({
            $schema:
                "https://raw.githubusercontent.com/cortexkit/magic-context/master/assets/magic-context.schema.json",
        });
        expect(prompts.messages.join("\n")).toContain("Wrote default Magic Context config");
    });

    it("writes an independent default config even when OMP is missing", async () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "mc-omp-doctor-no-bin-"));
        roots.push(root);
        process.env.HOME = root;
        process.env.XDG_CONFIG_HOME = join(root, ".config");
        process.env.XDG_DATA_HOME = join(root, ".local", "share");
        delete process.env.PI_CODING_AGENT_DIR;
        const prompts = new MockPrompts();

        const code = await runDoctor({
            cwd: root,
            force: true,
            prompts,
            deps: { detectOmpBinary: () => null },
        });

        expect(code).toBe(1);
        expect(existsSync(join(root, ".config", "cortexkit", "magic-context.jsonc"))).toBe(true);
        expect(prompts.messages.join("\n")).toContain("Wrote default Magic Context config");
    });

    it("does not repair global settings through a project config override", async () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "mc-omp-doctor-project-"));
        roots.push(root);
        const agentDir = join(root, ".omp", "agent");
        const pluginDir = join(root, "plugin");
        mkdirSync(join(root, ".omp"), { recursive: true });
        mkdirSync(agentDir, { recursive: true });
        mkdirSync(pluginDir, { recursive: true });
        mkdirSync(join(root, ".config", "cortexkit"), { recursive: true });
        writeFileSync(join(root, ".omp", "config.yml"), "compaction:\n  enabled: true\n");
        writeFileSync(
            join(pluginDir, "package.json"),
            JSON.stringify({ omp: { extensions: ["./dist/index.js"] } }),
        );
        writeFileSync(join(root, ".config", "cortexkit", "magic-context.jsonc"), "{}\n");
        process.env.HOME = root;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        process.env.XDG_CONFIG_HOME = join(root, ".config");
        const calls: string[][] = [];
        const prompts = new MockPrompts();

        const code = await runDoctor({
            cwd: root,
            force: true,
            prompts,
            deps: {
                detectOmpBinary: () => ({ path: "/fake/omp", source: "path" }),
                getOmpVersion: () => "17.1.7",
                listOmpPlugins: () => [
                    {
                        name: "@cortexkit/pi-magic-context",
                        version: "0.33.0",
                        enabled: true,
                        path: pluginDir,
                    },
                ],
                getOmpSetting: ((_path: string, key: string) =>
                    key === "compaction.enabled" ? true : "mnemopi") as never,
                runOmpCommand: (_path, args) => {
                    calls.push(args);
                    return { ok: true, stdout: agentDir, stderr: "" };
                },
            },
        });

        expect(code).toBe(1);
        expect(calls.some((args) => args[0] === "config" && args[1] === "set")).toBe(false);
        expect(prompts.messages.join("\n")).toContain("automatic global repair is disabled");
    });
    it("rejects an array at the Magic Context config root", async () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "mc-omp-doctor-array-"));
        roots.push(root);
        mkdirSync(join(root, ".config", "cortexkit"), { recursive: true });
        writeFileSync(join(root, ".config", "cortexkit", "magic-context.jsonc"), "[]\n");
        process.env.HOME = root;
        process.env.XDG_CONFIG_HOME = join(root, ".config");
        const prompts = new MockPrompts();

        const code = await runDoctor({
            cwd: root,
            prompts,
            deps: { detectOmpBinary: () => null },
        });

        expect(code).toBe(1);
        expect(prompts.messages.join("\n")).toContain("Invalid Magic Context config");
    });

    it("does not write a default config after a refused legacy migration", async () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "mc-omp-doctor-migration-"));
        const cwd = createTestTempDirFromPath(join(tmpdir(), "mc-omp-doctor-cwd-"));
        roots.push(root, cwd);
        const piAgentDir = join(root, ".pi", "agent");
        const opencodeDir = join(root, ".config", "opencode");
        mkdirSync(piAgentDir, { recursive: true });
        mkdirSync(opencodeDir, { recursive: true });
        mkdirSync(join(cwd, ".cortexkit"), { recursive: true });
        writeFileSync(
            join(opencodeDir, "magic-context.jsonc"),
            JSON.stringify({ protected_tokens: 7 }),
        );
        writeFileSync(
            join(piAgentDir, "magic-context.jsonc"),
            JSON.stringify({ protected_tokens: 13 }),
        );
        writeFileSync(
            join(cwd, ".cortexkit", "magic-context.jsonc"),
            JSON.stringify({ enabled: true }),
        );
        process.env.HOME = root;
        process.env.XDG_CONFIG_HOME = join(root, ".config");
        process.env.PI_CODING_AGENT_DIR = piAgentDir;
        const prompts = new MockPrompts();

        const code = await runDoctor({
            cwd,
            force: true,
            prompts,
            deps: { detectOmpBinary: () => null },
        });

        expect(code).toBe(1);
        expect(existsSync(join(root, ".config", "cortexkit", "magic-context.jsonc"))).toBe(false);
        expect(prompts.messages.join("\n")).toContain(
            "Magic Context user config migration refused",
        );
        expect(prompts.messages.join("\n")).not.toContain("Wrote default Magic Context config");
    });
});

describe("OMP doctor Hide Secrets check", () => {
    /**
     * OMP install with Magic Context installed and enabled, built under
     * $TMPDIR/magic-context/omp-hide-secrets/ so the real ~/.omp is never read.
     * `userConfig` is the OMP agent config.yml content; undefined writes no
     * file, and `{ directory: true }` puts a directory there so reading fails.
     */
    async function runWithUserConfig(
        userConfig: string | undefined | { directory: true },
    ): Promise<{ code: number; messages: string[] }> {
        const parent = join(tmpdir(), "magic-context", "omp-hide-secrets");
        mkdirSync(parent, { recursive: true });
        const root = createTestTempDirFromPath(join(parent, "doctor-"));
        roots.push(root);
        const agentDir = join(root, ".omp", "agent");
        const pluginDir = join(root, "plugin");
        const configDir = join(root, ".config", "cortexkit");
        mkdirSync(agentDir, { recursive: true });
        mkdirSync(pluginDir, { recursive: true });
        mkdirSync(configDir, { recursive: true });
        writeFileSync(
            join(pluginDir, "package.json"),
            JSON.stringify({ omp: { extensions: ["./dist/index.js"] } }),
        );
        writeFileSync(join(configDir, "magic-context.jsonc"), "{}\n");
        const configPath = join(agentDir, "config.yml");
        if (typeof userConfig === "string") writeFileSync(configPath, userConfig);
        else if (userConfig) mkdirSync(configPath);
        // The secrets list lives in its own file; doctor must never echo it.
        writeFileSync(
            join(agentDir, "secrets.yml"),
            "- type: plain\n  content: sk-fixture-SECRET\n",
        );
        process.env.HOME = root;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        process.env.XDG_CONFIG_HOME = join(root, ".config");
        process.env.XDG_DATA_HOME = join(root, ".local", "share");
        delete process.env.PI_CONFIG_FILES;
        const prompts = new MockPrompts();

        const code = await runDoctor({
            cwd: root,
            prompts,
            deps: {
                detectOmpBinary: () => ({ path: "/fake/omp", source: "path" }),
                getOmpVersion: () => "18.11.3",
                listOmpPlugins: () => [
                    {
                        name: "@cortexkit/pi-magic-context",
                        version: "0.49.9",
                        enabled: true,
                        path: pluginDir,
                    },
                ],
                getOmpSetting: ((_path: string, key: string) =>
                    key === "compaction.enabled" ? false : "off") as never,
                runOmpCommand: () => ({ ok: true, stdout: agentDir, stderr: "" }),
            },
        });
        return { code, messages: prompts.messages };
    }

    const docsLink = "https://docs.cortexkit.io/magic-context/help/compatibility/#omp-hide-secrets";

    it("warns with a docs link when Hide Secrets is on, without failing", async () => {
        const { code, messages } = await runWithUserConfig(
            "secrets:\n  enabled: true\ncompaction:\n  enabled: false\n",
        );

        const warning = messages.find((message) => message.includes("Hide Secrets"));
        expect(code).toBe(0);
        expect(warning).toStartWith("warn:WARN OMP Hide Secrets (secrets.enabled) is on");
        expect(warning).toContain(docsLink);
        expect(warning).toContain("CLI flags and live settings toggles can't be detected");
        expect(messages.join("\n")).not.toContain("sk-fixture-SECRET");
    });

    it("passes when Hide Secrets is off", async () => {
        const { messages } = await runWithUserConfig("secrets:\n  enabled: false\n");

        expect(messages).toContain(
            "success:PASS OMP Hide Secrets (secrets.enabled) is off in OMP settings files (CLI flags and live settings toggles can't be detected)",
        );
        expect(messages.some((message) => message.startsWith("warn:WARN OMP Hide"))).toBe(false);
    });

    it("passes when OMP has no settings file", async () => {
        const { messages } = await runWithUserConfig(undefined);

        expect(
            messages.some((message) =>
                message.startsWith(
                    "success:PASS OMP Hide Secrets (secrets.enabled) is not set in OMP settings files",
                ),
            ),
        ).toBe(true);
    });

    it("warns when the OMP settings file cannot be read", async () => {
        const { code, messages } = await runWithUserConfig({ directory: true });

        const warning = messages.find((message) => message.includes("Hide Secrets"));
        expect(code).toBe(0);
        expect(warning).toStartWith("warn:WARN Could not check OMP Hide Secrets (secrets.enabled)");
        expect(warning).toContain(docsLink);
    });
});
