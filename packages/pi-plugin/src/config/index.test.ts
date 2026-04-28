import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MagicContextConfigSchema } from "@magic-context/core/config/schema/magic-context";
import { loadPiConfig } from "./index";

const tempRoots: string[] = [];
const originalHome = process.env.HOME;

function makeTempRoot(prefix: string): string {
	const path = mkdtempSync(join(tmpdir(), prefix));
	tempRoots.push(path);
	return path;
}

function withHome(home: string): void {
	process.env.HOME = home;
}

function writeConfig(path: string, text: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text, "utf-8");
}

function writeProjectConfig(
	cwd: string,
	text: string,
	extension: "jsonc" | "json" = "jsonc",
): string {
	const path = join(cwd, ".pi", `magic-context.${extension}`);
	writeConfig(path, text);
	return path;
}

function writeUserConfig(
	home: string,
	text: string,
	extension: "jsonc" | "json" = "jsonc",
): string {
	const path = join(home, ".pi", "agent", `magic-context.${extension}`);
	writeConfig(path, text);
	return path;
}

afterEach(() => {
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}

	for (const path of tempRoots.splice(0)) {
		rmSync(path, { recursive: true, force: true });
	}
});

describe("loadPiConfig", () => {
	it("returns defaults with no config files", () => {
		const cwd = makeTempRoot("mc-pi-cwd-");
		const home = makeTempRoot("mc-pi-home-");
		withHome(home);

		const result = loadPiConfig({ cwd });

		expect(result.config).toEqual(MagicContextConfigSchema.parse({}));
		expect(result.warnings).toEqual([]);
		expect(result.loadedFromPaths).toEqual([]);
	});

	it("loads project config only", () => {
		const cwd = makeTempRoot("mc-pi-cwd-");
		const home = makeTempRoot("mc-pi-home-");
		withHome(home);
		const projectPath = writeProjectConfig(
			cwd,
			`{
                // JSONC comments and trailing commas are accepted.
                "enabled": false,
                "memory": { "enabled": false, },
            }`,
		);

		const result = loadPiConfig({ cwd });

		expect(result.config.enabled).toBe(false);
		expect(result.config.memory.enabled).toBe(false);
		expect(result.warnings).toEqual([]);
		expect(result.loadedFromPaths).toEqual([projectPath]);
	});

	it("loads user config only", () => {
		const cwd = makeTempRoot("mc-pi-cwd-");
		const home = makeTempRoot("mc-pi-home-");
		withHome(home);
		const userPath = writeUserConfig(
			home,
			'{ "ctx_reduce_enabled": false }',
			"json",
		);

		const result = loadPiConfig({ cwd });

		expect(result.config.ctx_reduce_enabled).toBe(false);
		expect(result.loadedFromPaths).toEqual([userPath]);
	});

	it("merges user then project with project overrides winning", () => {
		const cwd = makeTempRoot("mc-pi-cwd-");
		const home = makeTempRoot("mc-pi-home-");
		withHome(home);
		const projectPath = writeProjectConfig(
			cwd,
			JSON.stringify({
				memory: { injection_budget_tokens: 9000 },
				nudge_interval_tokens: 5000,
			}),
		);
		const userPath = writeUserConfig(
			home,
			JSON.stringify({
				memory: { enabled: false, injection_budget_tokens: 2000 },
				nudge_interval_tokens: 4000,
			}),
		);

		const result = loadPiConfig({ cwd });

		expect(result.config.memory.enabled).toBe(false);
		expect(result.config.memory.injection_budget_tokens).toBe(9000);
		expect(result.config.nudge_interval_tokens).toBe(5000);
		expect(result.loadedFromPaths).toEqual([projectPath, userPath]);
	});

	it("warns and falls back to defaults for invalid JSONC", () => {
		const cwd = makeTempRoot("mc-pi-cwd-");
		const home = makeTempRoot("mc-pi-home-");
		withHome(home);
		const projectPath = writeProjectConfig(cwd, '{ "enabled": false,, }');

		const result = loadPiConfig({ cwd });

		expect(result.config).toEqual(MagicContextConfigSchema.parse({}));
		expect(result.loadedFromPaths).toEqual([projectPath]);
		expect(result.warnings.join("\n")).toContain("failed to load config");
		expect(result.warnings.join("\n")).toContain("using defaults");
	});

	it("warns and falls back to defaults for invalid Zod fields", () => {
		const cwd = makeTempRoot("mc-pi-cwd-");
		const home = makeTempRoot("mc-pi-home-");
		withHome(home);
		writeProjectConfig(
			cwd,
			JSON.stringify({
				enabled: false,
				nudge_interval_tokens: 50,
			}),
		);

		const result = loadPiConfig({ cwd });

		expect(result.config.enabled).toBe(false);
		expect(result.config.nudge_interval_tokens).toBe(
			MagicContextConfigSchema.parse({}).nudge_interval_tokens,
		);
		expect(result.warnings.join("\n")).toContain("nudge_interval_tokens");
		expect(result.warnings.join("\n")).toContain("using default");
	});

	it("substitutes variables before parsing", () => {
		const cwd = makeTempRoot("mc-pi-cwd-");
		const home = makeTempRoot("mc-pi-home-");
		withHome(home);
		writeProjectConfig(
			cwd,
			JSON.stringify({
				sidekick: {
					model: "test-model",
					prompt: "home={env:HOME}",
				},
			}),
		);

		const result = loadPiConfig({ cwd });

		expect(result.config.sidekick?.prompt).toBe(`home=${home}`);
		expect(result.warnings).toEqual([]);
	});
});
