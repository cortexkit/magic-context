import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    it("accepts a healthy OMP installation", async () => {
        const root = mkdtempSync(join(tmpdir(), "mc-omp-doctor-"));
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
                runOmpCommand: () => ({ ok: true, stdout: `${agentDir}/./`, stderr: "" }),
            },
        });

        expect(code).toBe(0);
        expect(prompts.messages.join("\n")).toContain("OMP 17.1.7 detected");
        expect(prompts.messages.join("\n")).toContain("FAIL 0");
    });

    it("repairs a missing config when it is the only health finding", async () => {
        const root = mkdtempSync(join(tmpdir(), "mc-omp-doctor-config-only-"));
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
        expect(existsSync(join(root, ".config", "cortexkit", "magic-context.jsonc"))).toBe(true);
        expect(prompts.messages.join("\n")).toContain("Wrote default Magic Context config");
    });

    it("writes an independent default config even when OMP is missing", async () => {
        const root = mkdtempSync(join(tmpdir(), "mc-omp-doctor-no-bin-"));
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
        const root = mkdtempSync(join(tmpdir(), "mc-omp-doctor-project-"));
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
        const root = mkdtempSync(join(tmpdir(), "mc-omp-doctor-array-"));
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
        const root = mkdtempSync(join(tmpdir(), "mc-omp-doctor-migration-"));
        const cwd = mkdtempSync(join(tmpdir(), "mc-omp-doctor-cwd-"));
        roots.push(root, cwd);
        const piAgentDir = join(root, ".pi", "agent");
        const opencodeDir = join(root, ".config", "opencode");
        mkdirSync(piAgentDir, { recursive: true });
        mkdirSync(opencodeDir, { recursive: true });
        mkdirSync(join(cwd, ".cortexkit"), { recursive: true });
        writeFileSync(
            join(opencodeDir, "magic-context.jsonc"),
            JSON.stringify({ protected_tags: 7 }),
        );
        writeFileSync(
            join(piAgentDir, "magic-context.jsonc"),
            JSON.stringify({ protected_tags: 13 }),
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
