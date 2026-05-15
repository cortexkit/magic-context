import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseJsonc } from "comment-json";
import type { PromptIO, PromptSpinner, SelectOption } from "../lib/prompts";
import { runSetup, type SetupEnvironment, writePiSettingsPackage } from "./setup-pi";

const tempRoots: string[] = [];

function makeTempRoot(): string {
    const path = mkdtempSync(join(tmpdir(), "mc-pi-setup-"));
    tempRoots.push(path);
    return path;
}

class MockPrompts implements PromptIO {
    readonly messages: string[] = [];
    private readonly confirms: boolean[];
    private readonly texts: string[];

    constructor(options: { confirms: boolean[]; texts?: string[] }) {
        this.confirms = [...options.confirms];
        this.texts = [...(options.texts ?? [])];
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
        const next = this.confirms.shift();
        if (next === undefined) throw new Error("No mock confirm response queued");
        return next;
    }

    async text(_message: string, options = {}): Promise<string> {
        return this.texts.shift() ?? options.initialValue ?? "";
    }

    async selectOne(_message: string, options: SelectOption[]): Promise<string> {
        const recommended = options.find((option) => option.recommended);
        return (recommended ?? options[0]).value;
    }
}

afterEach(() => {
    for (const path of tempRoots.splice(0)) {
        rmSync(path, { recursive: true, force: true });
    }
});

describe("runSetup", () => {
    it("preserves object-form Pi package entries and detects object-form Magic Context", () => {
        const root = makeTempRoot();
        const settingsPath = join(root, "settings.json");
        mkdirSync(root, { recursive: true });

        const existing = {
            packages: [
                { name: "npm:@cortexkit/pi-magic-context", version: "1.2.3" },
                "npm:other-string-extension",
                { name: "third-party-extension", version: "9.9.9", enabled: true },
            ],
        };
        writeFileSync(settingsPath, JSON.stringify(existing));

        const added = writePiSettingsPackage(settingsPath);
        const updated = parseJsonc(
            readFileSync(settingsPath, "utf-8"),
        ) as unknown as typeof existing;

        expect(added).toBe(false);
        expect(updated.packages).toEqual(existing.packages);
    });

    it("round-trips mixed string and object package entries when adding Magic Context", () => {
        const root = makeTempRoot();
        const settingsPath = join(root, "settings.json");
        mkdirSync(root, { recursive: true });
        writeFileSync(
            settingsPath,
            JSON.stringify({
                packages: ["npm:one", { name: "two", version: "2.0.0" }],
            }),
        );

        const added = writePiSettingsPackage(settingsPath);
        const updated = parseJsonc(readFileSync(settingsPath, "utf-8")) as {
            packages?: unknown[];
        };

        expect(added).toBe(true);
        expect(updated.packages).toEqual([
            "npm:one",
            { name: "two", version: "2.0.0" },
            "npm:@cortexkit/pi-magic-context",
        ]);
    });

    it("writes Pi settings and magic-context config with mocked prompts", async () => {
        const root = makeTempRoot();
        const agentDir = join(root, ".pi", "agent");
        mkdirSync(agentDir, { recursive: true });

        const env: SetupEnvironment = {
            detectPiBinary: () => ({ path: join(root, "bin", "pi"), source: "path" }),
            getPiVersion: () => "0.74.0",
            getAvailableModels: () => [
                "anthropic/claude-haiku-4-5",
                "anthropic/claude-sonnet-4-6",
                "github-copilot/gemini-3-flash-preview",
            ],
            paths: {
                getPiAgentConfigDir: () => agentDir,
                getPiUserConfigPath: () => join(agentDir, "magic-context.jsonc"),
                getPiUserExtensionsPath: () => join(agentDir, "settings.json"),
            },
        };
        // confirms: configurePi=true, dreamerEnabled=true, sidekickEnabled=false
        const prompts = new MockPrompts({ confirms: [true, true, false] });

        const code = await runSetup({ prompts, env });

        expect(code).toBe(0);
        const settingsPath = join(agentDir, "settings.json");
        const configPath = join(agentDir, "magic-context.jsonc");
        expect(existsSync(settingsPath)).toBe(true);
        expect(existsSync(configPath)).toBe(true);

        const settings = parseJsonc(readFileSync(settingsPath, "utf-8")) as {
            packages?: string[];
        };
        expect(settings.packages).toContain("npm:@cortexkit/pi-magic-context");

        const config = parseJsonc(readFileSync(configPath, "utf-8")) as {
            historian?: { model?: string; thinking_level?: string };
            dreamer?: { enabled?: boolean; model?: string };
            sidekick?: { enabled?: boolean };
            embedding?: { provider?: string; model?: string };
        };
        // anthropic model — no thinking_level needed
        expect(config.historian?.model).toBe("anthropic/claude-haiku-4-5");
        expect(config.historian?.thinking_level).toBeUndefined();
        expect(config.dreamer).toEqual({
            enabled: true,
            model: "anthropic/claude-sonnet-4-6",
        });
        expect(config.sidekick?.enabled).toBe(false);
        expect(config.embedding).toEqual({
            provider: "local",
            model: "Xenova/all-MiniLM-L6-v2",
        });
    });

    it("prompts for thinking_level when historian model is github-copilot", async () => {
        const root = makeTempRoot();
        const agentDir = join(root, ".pi", "agent");
        mkdirSync(agentDir, { recursive: true });

        const env: SetupEnvironment = {
            detectPiBinary: () => ({ path: join(root, "bin", "pi"), source: "path" }),
            getPiVersion: () => "0.74.0",
            // Only github-copilot model so buildModelSelection always picks it first
            getAvailableModels: () => ["github-copilot/gpt-5.4"],
            paths: {
                getPiAgentConfigDir: () => agentDir,
                getPiUserConfigPath: () => join(agentDir, "magic-context.jsonc"),
                getPiUserExtensionsPath: () => join(agentDir, "settings.json"),
            },
        };
        // selectOne picks the recommended option ("medium" for thinking_level)
        // confirms: configurePi=true, dreamerEnabled=true, sidekickEnabled=false
        const prompts = new MockPrompts({ confirms: [true, true, false] });

        const code = await runSetup({ prompts, env });
        expect(code).toBe(0);

        const config = parseJsonc(readFileSync(join(agentDir, "magic-context.jsonc"), "utf-8")) as {
            historian?: { model?: string; thinking_level?: string };
        };
        // github-copilot model — thinking_level must be set by setup wizard
        expect(config.historian?.model).toBe("github-copilot/gpt-5.4");
        expect(config.historian?.thinking_level).toBe("medium");
    });

    it("exits gracefully without writing files when Pi is missing", async () => {
        const root = makeTempRoot();
        const agentDir = join(root, ".pi", "agent");
        const env: SetupEnvironment = {
            detectPiBinary: () => null,
            getPiVersion: () => null,
            getAvailableModels: () => [],
            paths: {
                getPiAgentConfigDir: () => agentDir,
                getPiUserConfigPath: () => join(agentDir, "magic-context.jsonc"),
                getPiUserExtensionsPath: () => join(agentDir, "settings.json"),
            },
        };
        const prompts = new MockPrompts({ confirms: [] });

        const code = await runSetup({ prompts, env });

        expect(code).toBe(0);
        expect(existsSync(agentDir)).toBe(false);
        expect(prompts.messages.join("\n")).toContain("Pi not found");
    });

    it("warns and exits when Pi version is below 0.74.0 and user declines", async () => {
        const root = makeTempRoot();
        const agentDir = join(root, ".pi", "agent");
        const env: SetupEnvironment = {
            detectPiBinary: () => ({ path: "/usr/local/bin/pi", source: "path" }),
            getPiVersion: () => "0.69.0",
            getAvailableModels: () => ["anthropic/claude-haiku-4-5"],
            paths: {
                getPiAgentConfigDir: () => agentDir,
                getPiUserConfigPath: () => join(agentDir, "magic-context.jsonc"),
                getPiUserExtensionsPath: () => join(agentDir, "settings.json"),
            },
        };
        // One confirm: continue-anyway prompt → false (user declines)
        const prompts = new MockPrompts({ confirms: [false] });

        const code = await runSetup({ prompts, env });

        expect(code).toBe(0);
        const log = prompts.messages.join("\n");
        expect(log).toContain("Pi 0.69.0 is older than the required 0.74.0");
        expect(log).toContain("outro:Setup cancelled");
        expect(existsSync(join(agentDir, "magic-context.jsonc"))).toBe(false);
        expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
    });

    it("continues setup when Pi version is below 0.74.0 and user opts in", async () => {
        const root = makeTempRoot();
        const agentDir = join(root, ".pi", "agent");
        const env: SetupEnvironment = {
            detectPiBinary: () => ({ path: "/usr/local/bin/pi", source: "path" }),
            getPiVersion: () => "0.69.0",
            getAvailableModels: () => ["anthropic/claude-haiku-4-5"],
            paths: {
                getPiAgentConfigDir: () => agentDir,
                getPiUserConfigPath: () => join(agentDir, "magic-context.jsonc"),
                getPiUserExtensionsPath: () => join(agentDir, "settings.json"),
            },
        };
        // confirms: continue-anyway=true, configurePi=true,
        //           dreamerEnabled=true, sidekickEnabled=false
        const prompts = new MockPrompts({ confirms: [true, true, true, false] });

        const code = await runSetup({ prompts, env });

        expect(code).toBe(0);
        expect(existsSync(join(agentDir, "magic-context.jsonc"))).toBe(true);
        expect(prompts.messages.join("\n")).toContain(
            "Pi 0.69.0 is older than the required 0.74.0",
        );
    });
});
