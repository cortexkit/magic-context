import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
	type MagicContextConfig,
	MagicContextConfigSchema,
} from "@magic-context/core/config/schema/magic-context";
import { substituteConfigVariables } from "@magic-context/core/config/variable";
import { parse as parseJsonc } from "comment-json";

export interface LoadPiConfigOptions {
	cwd?: string;
}

export interface LoadPiConfigResult {
	config: MagicContextConfig;
	warnings: string[];
	loadedFromPaths: string[];
}

interface LoadedConfigFile {
	path: string;
	scope: "user" | "project";
	config: Record<string, unknown>;
	warnings: string[];
}

const CONFIG_FILE_NAME = "magic-context";

function getProjectConfigPaths(cwd: string): string[] {
	const basePath = join(cwd, ".pi", CONFIG_FILE_NAME);
	return [`${basePath}.jsonc`, `${basePath}.json`];
}

function getUserConfigPaths(): string[] {
	const home = process.env.HOME ?? homedir();
	const basePath = join(home, ".pi", "agent", CONFIG_FILE_NAME);
	return [`${basePath}.jsonc`, `${basePath}.json`];
}

function resolveFirstExisting(paths: string[]): string | undefined {
	return paths.find((path) => existsSync(path));
}

function loadConfigFile(
	path: string,
	scope: "user" | "project",
): LoadedConfigFile | null {
	try {
		const rawText = readFileSync(path, "utf-8");
		const substituted = substituteConfigVariables({
			text: rawText,
			configPath: path,
		});
		return {
			path,
			scope,
			config: parseJsonc(substituted.text) as Record<string, unknown>,
			warnings: substituted.warnings.map((warning) => `${path}: ${warning}`),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			path,
			scope,
			config: {},
			warnings: [
				`${path}: failed to load config: ${message}; using defaults for this file.`,
			],
		};
	}
}

function redactConfigValue(value: unknown): string {
	if (value === undefined) return "<missing>";
	if (value === null) return "null";
	if (typeof value === "string") {
		return `string, ${value.length} char${value.length === 1 ? "" : "s"}`;
	}
	if (typeof value === "number") return `number ${value}`;
	if (typeof value === "boolean") return `boolean ${value}`;
	if (Array.isArray(value))
		return `array, ${value.length} item${value.length === 1 ? "" : "s"}`;
	if (typeof value === "object") {
		const keys = Object.keys(value as Record<string, unknown>);
		return `object with keys [${keys.join(", ")}]`;
	}
	return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeRawConfigs(
	base: Record<string, unknown>,
	override: Record<string, unknown>,
): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...base };

	for (const [key, overrideValue] of Object.entries(override)) {
		const baseValue = merged[key];
		merged[key] =
			isPlainObject(baseValue) && isPlainObject(overrideValue)
				? mergeRawConfigs(baseValue, overrideValue)
				: overrideValue;
	}

	return merged;
}

function parsePiConfig(rawConfig: Record<string, unknown>): {
	config: MagicContextConfig;
	warnings: string[];
} {
	const parsed = MagicContextConfigSchema.safeParse(rawConfig);
	if (parsed.success) {
		return { config: parsed.data, warnings: [] };
	}

	const defaults = MagicContextConfigSchema.parse({});
	const errorPaths = new Set<string>();
	for (const issue of parsed.error.issues) {
		const topKey = issue.path[0];
		if (topKey !== undefined) {
			errorPaths.add(String(topKey));
		}
	}

	const patched: Record<string, unknown> = { ...rawConfig };
	const warnings: string[] = [];

	for (const key of errorPaths) {
		const isAgentConfig =
			key === "historian" || key === "dreamer" || key === "sidekick";
		delete patched[key];

		if (isAgentConfig) {
			warnings.push(
				`"${key}": invalid agent configuration, ignoring. Check your magic-context.jsonc.`,
			);
			continue;
		}

		const defaultValue = (defaults as unknown as Record<string, unknown>)[key];
		warnings.push(
			`"${key}": invalid value (${redactConfigValue(rawConfig[key])}), using default ${JSON.stringify(defaultValue)}.`,
		);
	}

	const retryParsed = MagicContextConfigSchema.safeParse(patched);
	if (retryParsed.success) {
		return { config: retryParsed.data, warnings };
	}

	warnings.push("Config recovery failed, using all defaults.");
	return { config: defaults, warnings };
}

export function loadPiConfig(
	opts: LoadPiConfigOptions = {},
): LoadPiConfigResult {
	const cwd = opts.cwd ?? process.cwd();
	const loadedFiles: LoadedConfigFile[] = [];
	const warnings: string[] = [];

	const projectPath = resolveFirstExisting(getProjectConfigPaths(cwd));
	if (projectPath) {
		const loaded = loadConfigFile(projectPath, "project");
		if (loaded) loadedFiles.push(loaded);
	}

	const userPath = resolveFirstExisting(getUserConfigPaths());
	if (userPath) {
		const loaded = loadConfigFile(userPath, "user");
		if (loaded) loadedFiles.push(loaded);
	}

	let rawConfig: Record<string, unknown> = {};
	const mergeFiles = [...loadedFiles].sort((a, b) => {
		if (a.scope === b.scope) return 0;
		return a.scope === "user" ? -1 : 1;
	});

	for (const loaded of mergeFiles) {
		const prefix =
			loaded.scope === "user" ? "[user config]" : "[project config]";
		warnings.push(...loaded.warnings.map((warning) => `${prefix} ${warning}`));
		rawConfig = mergeRawConfigs(rawConfig, loaded.config);
	}

	const parsed = parsePiConfig(rawConfig);
	warnings.push(
		...parsed.warnings.map((warning) => `[merged config] ${warning}`),
	);

	return {
		config: parsed.config,
		warnings,
		loadedFromPaths: loadedFiles.map((loaded) => loaded.path),
	};
}
