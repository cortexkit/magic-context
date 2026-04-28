import { afterEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseJsonc } from "comment-json";
import type { PromptIO, PromptSpinner, SelectOption } from "./prompts";
import { runSetup, type SetupEnvironment } from "./setup";

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
			start: (message: string) =>
				this.messages.push(`spinner-start:${message}`),
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
	it("writes Pi settings and magic-context config with mocked prompts", async () => {
		const root = makeTempRoot();
		const agentDir = join(root, ".pi", "agent");
		mkdirSync(agentDir, { recursive: true });

		const env: SetupEnvironment = {
			detectPiBinary: () => ({ path: join(root, "bin", "pi"), source: "path" }),
			getPiVersion: () => "0.69.0",
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
		const prompts = new MockPrompts({ confirms: [true, false] });

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
			historian?: { model?: string };
			dreamer?: { enabled?: boolean; model?: string };
			sidekick?: { enabled?: boolean };
			embedding?: { provider?: string; model?: string };
		};
		expect(config.historian?.model).toBe("anthropic/claude-haiku-4-5");
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
});
