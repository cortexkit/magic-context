import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
        delete process.env.XDG_DATA_HOME;
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
                runOmpCommand: () => ({ ok: true, stdout: agentDir, stderr: "" }),
            },
        });

        expect(code).toBe(0);
        expect(prompts.messages.join("\n")).toContain("OMP 17.1.7 detected");
        expect(prompts.messages.join("\n")).toContain("FAIL 0");
    });
});
