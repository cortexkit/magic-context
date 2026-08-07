import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseJsonc } from "comment-json";
import type { PromptIO, PromptSpinner, SelectOption } from "../lib/prompts";
import {
    removePiSettingsPackage,
    runSetup,
    type SetupEnvironment,
    writePiSettingsPackage,
} from "./setup-pi";

const tempRoots: string[] = [];
const originalHome = process.env.HOME;
const originalPiDir = process.env.PI_CODING_AGENT_DIR;
const originalConfigHome = process.env.XDG_CONFIG_HOME;

function makeTempRoot(): string {
    const path = mkdtempSync(join(tmpdir(), "mc-pi-setup-"));
    tempRoots.push(path);
    return path;
}

function setConfigEnv(root: string, agentDir: string): void {
    process.env.HOME = root;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.XDG_CONFIG_HOME = join(root, ".config");
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

    async selectAutocomplete(_message: string, options: SelectOption[]): Promise<string> {
        const recommended = options.find((option) => option.recommended);
        return (recommended ?? options[0]).value;
    }
}

afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalPiDir;
    if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalConfigHome;

    for (const path of tempRoots.splice(0)) {
        rmSync(path, { recursive: true, force: true });
    }
});

describe("Pi settings rollback", () => {
    it("removes only the package entry added by setup", () => {
        const root = makeTempRoot();
        const settingsPath = join(root, "settings.json");
        writeFileSync(
            settingsPath,
            JSON.stringify({ packages: ["unrelated-package", "npm:@cortexkit/pi-magic-context"] }),
        );

        expect(removePiSettingsPackage(settingsPath)).toBe(true);
        expect(parseJsonc(readFileSync(settingsPath, "utf-8"))).toEqual({
            packages: ["unrelated-package"],
        });
        expect(removePiSettingsPackage(settingsPath)).toBe(false);
    });

    it("restores an absent packages field when setup added the only entry", () => {
        const root = makeTempRoot();
        const settingsPath = join(root, "settings.json");
        writeFileSync(settingsPath, "{}");

        expect(writePiSettingsPackage(settingsPath)).toBe(true);
        expect(removePiSettingsPackage(settingsPath, "npm:@cortexkit/pi-magic-context", true)).toBe(
            true,
        );
        expect(parseJsonc(readFileSync(settingsPath, "utf-8"))).toEqual({});
    });

    it("refuses to overwrite a non-array packages value instead of discarding it", () => {
        const root = makeTempRoot();
        const settingsPath = join(root, "settings.json");
        const original = JSON.stringify({ packages: { legacy: true } });
        writeFileSync(settingsPath, original);

        expect(() => writePiSettingsPackage(settingsPath)).toThrow(/expected an array/);
        expect(readFileSync(settingsPath, "utf-8")).toBe(original);
    });
});

describe("runSetup", () => {
    it("aborts before writing when an existing target is malformed", async () => {
        const root = makeTempRoot();
        const agentDir = join(root, ".pi", "agent");
        setConfigEnv(root, agentDir);
        mkdirSync(agentDir, { recursive: true });
        const settingsPath = join(agentDir, "settings.json");
        const malformed = `{\n  "packages": [\n`;
        writeFileSync(settingsPath, malformed);

        const env: SetupEnvironment = {
            detectPiBinary: () => ({ path: join(root, "bin", "pi"), source: "path" }),
            getPiVersion: () => "0.74.0",
            getAvailableModels: () => ["anthropic/claude-haiku-4-5"],
            paths: {
                getPiAgentConfigDir: () => agentDir,
                getPiUserConfigPath: () =>
                    join(root, ".config", "cortexkit", "magic-context.jsonc"),
                getPiUserExtensionsPath: () => settingsPath,
            },
        };
        const prompts = new MockPrompts({ confirms: [] });

        const code = await runSetup({ prompts, env });

        expect(code).toBe(1);
        expect(readFileSync(settingsPath, "utf-8")).toBe(malformed);
        expect(existsSync(env.paths.getPiUserConfigPath())).toBe(false);
        expect(prompts.messages.join("\n")).toContain(
            `Refusing to overwrite unparseable config ${settingsPath} at line 3, column 1`,
        );
    });

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

    it("migrates legacy Pi user config before writing setup choices", async () => {
        const root = makeTempRoot();
        const agentDir = join(root, ".pi", "agent");
        setConfigEnv(root, agentDir);
        mkdirSync(agentDir, { recursive: true });
        const legacyPath = join(agentDir, "magic-context.jsonc");
        writeFileSync(legacyPath, JSON.stringify({ protected_tags: 7 }));

        const env: SetupEnvironment = {
            detectPiBinary: () => ({ path: join(root, "bin", "pi"), source: "path" }),
            getPiVersion: () => "0.74.0",
            getAvailableModels: () => ["anthropic/claude-haiku-4-5"],
            paths: {
                getPiAgentConfigDir: () => agentDir,
                getPiUserConfigPath: () =>
                    join(root, ".config", "cortexkit", "magic-context.jsonc"),
                getPiUserExtensionsPath: () => join(agentDir, "settings.json"),
            },
        };
        const prompts = new MockPrompts({ confirms: [true, true, true, false] });

        const code = await runSetup({ prompts, env });

        expect(code).toBe(0);
        const targetPath = join(root, ".config", "cortexkit", "magic-context.jsonc");
        const config = parseJsonc(readFileSync(targetPath, "utf-8")) as {
            protected_tags?: number;
        };
        expect(config.protected_tags).toBe(7);
        expect(existsSync(legacyPath)).toBe(false);
        expect(existsSync(`${legacyPath}.MOVED_READPLEASE`)).toBe(true);
    });

    it("writes Pi settings and magic-context config with mocked prompts", async () => {
        const root = makeTempRoot();
        const agentDir = join(root, ".pi", "agent");
        setConfigEnv(root, agentDir);
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
                getPiUserConfigPath: () =>
                    join(root, ".config", "cortexkit", "magic-context.jsonc"),
                getPiUserExtensionsPath: () => join(agentDir, "settings.json"),
            },
        };
        // confirms: configurePi=true, dreamerEnabled=true, useRecommendedSchedules=true, sidekickEnabled=false
        const prompts = new MockPrompts({ confirms: [true, true, true, false] });

        const code = await runSetup({ prompts, env });

        expect(code).toBe(0);
        const settingsPath = join(agentDir, "settings.json");
        const configPath = join(root, ".config", "cortexkit", "magic-context.jsonc");
        expect(existsSync(settingsPath)).toBe(true);
        expect(existsSync(configPath)).toBe(true);

        const settings = parseJsonc(readFileSync(settingsPath, "utf-8")) as {
            packages?: string[];
        };
        expect(settings.packages).toContain("npm:@cortexkit/pi-magic-context");

        const config = parseJsonc(readFileSync(configPath, "utf-8")) as {
            historian?: { model?: string; thinking_level?: string };
            dreamer?: { enabled?: boolean; model?: string; disable?: boolean };
            sidekick?: { enabled?: boolean; disable?: boolean };
            embedding?: { provider?: string; model?: string };
        };
        // No recommendation tree anymore: the picker shows the full model list
        // sorted, and the mock selects the first option — alphabetically
        // "anthropic/claude-haiku-4-5" for BOTH historian and dreamer.
        expect(config.historian?.model).toBe("anthropic/claude-haiku-4-5");
        expect(config.historian?.thinking_level).toBeUndefined();
        expect(config.dreamer).toEqual({
            model: "anthropic/claude-haiku-4-5",
        });
        expect(config.dreamer).not.toHaveProperty("enabled");
        expect(config.sidekick?.disable).toBe(true);
        expect(config.sidekick).not.toHaveProperty("enabled");
        expect(config.embedding).toEqual({
            provider: "local",
            model: "Xenova/all-MiniLM-L6-v2",
        });
    });

    it("does not ask for a dreamer model when the dreamer is declined (issue #144)", async () => {
        const root = makeTempRoot();
        const agentDir = join(root, ".pi", "agent");
        setConfigEnv(root, agentDir);
        mkdirSync(agentDir, { recursive: true });

        const env: SetupEnvironment = {
            detectPiBinary: () => ({ path: join(root, "bin", "pi"), source: "path" }),
            getPiVersion: () => "0.74.0",
            getAvailableModels: () => ["anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-4-6"],
            paths: {
                getPiAgentConfigDir: () => agentDir,
                getPiUserConfigPath: () =>
                    join(root, ".config", "cortexkit", "magic-context.jsonc"),
                getPiUserExtensionsPath: () => join(agentDir, "settings.json"),
            },
        };
        // confirms: configurePi=true, dreamerEnabled=FALSE, sidekickEnabled=false.
        // The picker is invoked once (historian); a 2nd autocomplete call would
        // mean the dreamer model was wrongly requested after the user declined.
        let autocompleteCalls = 0;
        const prompts = new MockPrompts({ confirms: [true, false, false] });
        const origAuto = prompts.selectAutocomplete.bind(prompts);
        prompts.selectAutocomplete = async (message, options) => {
            autocompleteCalls += 1;
            return origAuto(message, options);
        };

        const code = await runSetup({ prompts, env });
        expect(code).toBe(0);
        expect(autocompleteCalls).toBe(1); // historian only — not dreamer

        const config = parseJsonc(
            readFileSync(join(root, ".config", "cortexkit", "magic-context.jsonc"), "utf-8"),
        ) as {
            dreamer?: { model?: string; disable?: boolean };
        };
        expect(config.dreamer?.disable).toBe(true);
        expect(config.dreamer).not.toHaveProperty("model");
    });

    it("prompts for thinking_level when historian model is github-copilot", async () => {
        const root = makeTempRoot();
        const agentDir = join(root, ".pi", "agent");
        setConfigEnv(root, agentDir);
        mkdirSync(agentDir, { recursive: true });

        const env: SetupEnvironment = {
            detectPiBinary: () => ({ path: join(root, "bin", "pi"), source: "path" }),
            getPiVersion: () => "0.74.0",
            // Only one model so the model picker has a single deterministic choice.
            getAvailableModels: () => ["github-copilot/gpt-5.4"],
            paths: {
                getPiAgentConfigDir: () => agentDir,
                getPiUserConfigPath: () =>
                    join(root, ".config", "cortexkit", "magic-context.jsonc"),
                getPiUserExtensionsPath: () => join(agentDir, "settings.json"),
            },
        };
        // selectOne picks the recommended option ("medium" for thinking_level)
        // confirms: configurePi=true, dreamerEnabled=true, useRecommendedSchedules=true, sidekickEnabled=false
        const prompts = new MockPrompts({ confirms: [true, true, true, false] });

        const code = await runSetup({ prompts, env });
        expect(code).toBe(0);

        const config = parseJsonc(
            readFileSync(join(root, ".config", "cortexkit", "magic-context.jsonc"), "utf-8"),
        ) as {
            historian?: { model?: string; thinking_level?: string };
        };
        // github-copilot model — thinking_level must be set by setup wizard
        expect(config.historian?.model).toBe("github-copilot/gpt-5.4");
        expect(config.historian?.thinking_level).toBe("medium");
    });

    it("exits gracefully without writing files when Pi is missing", async () => {
        const root = makeTempRoot();
        const agentDir = join(root, ".pi", "agent");
        setConfigEnv(root, agentDir);
        const env: SetupEnvironment = {
            detectPiBinary: () => null,
            getPiVersion: () => null,
            getAvailableModels: () => [],
            paths: {
                getPiAgentConfigDir: () => agentDir,
                getPiUserConfigPath: () =>
                    join(root, ".config", "cortexkit", "magic-context.jsonc"),
                getPiUserExtensionsPath: () => join(agentDir, "settings.json"),
            },
        };
        const prompts = new MockPrompts({ confirms: [] });

        const code = await runSetup({ prompts, env });

        expect(code).toBe(1);
        expect(existsSync(agentDir)).toBe(false);
        expect(prompts.messages.join("\n")).toContain("Pi not found");
    });

    it("warns and exits when Pi version is below 0.74.0 and user declines", async () => {
        const root = makeTempRoot();
        const agentDir = join(root, ".pi", "agent");
        setConfigEnv(root, agentDir);
        const env: SetupEnvironment = {
            detectPiBinary: () => ({ path: "/usr/local/bin/pi", source: "path" }),
            getPiVersion: () => "0.69.0",
            getAvailableModels: () => ["anthropic/claude-haiku-4-5"],
            paths: {
                getPiAgentConfigDir: () => agentDir,
                getPiUserConfigPath: () =>
                    join(root, ".config", "cortexkit", "magic-context.jsonc"),
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
        expect(existsSync(join(root, ".config", "cortexkit", "magic-context.jsonc"))).toBe(false);
        expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
    });

    it("continues setup when Pi version is below 0.74.0 and user opts in", async () => {
        const root = makeTempRoot();
        const agentDir = join(root, ".pi", "agent");
        setConfigEnv(root, agentDir);
        const env: SetupEnvironment = {
            detectPiBinary: () => ({ path: "/usr/local/bin/pi", source: "path" }),
            getPiVersion: () => "0.69.0",
            getAvailableModels: () => ["anthropic/claude-haiku-4-5"],
            paths: {
                getPiAgentConfigDir: () => agentDir,
                getPiUserConfigPath: () =>
                    join(root, ".config", "cortexkit", "magic-context.jsonc"),
                getPiUserExtensionsPath: () => join(agentDir, "settings.json"),
            },
        };
        // confirms: continue-anyway=true, configurePi=true,
        //           dreamerEnabled=true, useRecommendedSchedules=true, sidekickEnabled=false
        const prompts = new MockPrompts({ confirms: [true, true, true, true, false] });

        const code = await runSetup({ prompts, env });

        expect(code).toBe(0);
        expect(existsSync(join(root, ".config", "cortexkit", "magic-context.jsonc"))).toBe(true);
        expect(prompts.messages.join("\n")).toContain(
            "Pi 0.69.0 is older than the required 0.74.0",
        );
    });
});
