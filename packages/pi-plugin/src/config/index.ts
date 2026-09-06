import {
	cortexKitProjectConfigBasePath,
	cortexKitUserConfigBasePath,
	type LegacyConfigSource,
	resolveLegacyConfigSources,
	resolveLegacyConfigSourcesForHarness,
} from "@magic-context/core/config/migrate-config-location";
import "@magic-context/core/config/prune-config-leaf";
import { existsSync } from "node:fs";
import { migrateLegacyAgentEnabledInMemory } from "@magic-context/core/config/agent-disable";
import { migrateDreamerV2 } from "@magic-context/core/config/migrate-dreamer-v2";
import { migrateLegacyExperimental } from "@magic-context/core/config/migrate-experimental";
import { resolveConfigProfile } from "@magic-context/core/config/profiles";
import {
	constrainProjectThresholdOverrides,
	dropInheritedEmbeddingKeyOnRedirect,
	stripUnsafeProjectConfigFields,
} from "@magic-context/core/config/project-security";
import { pruneNestedConfigLeaf } from "@magic-context/core/config/prune-config-leaf";
import { loadRawConfigFile } from "@magic-context/core/config/raw-loader";
import {
	type MagicContextConfig,
	MagicContextConfigSchema,
} from "@magic-context/core/config/schema/magic-context";
import { substituteConfigVariables } from "@magic-context/core/config/variable";
import {
	CONFIG_WARNING_CLASS,
	type ConfigParseFailure,
	type ConfigWarningDetail,
} from "@magic-context/core/shared/config-diagnostics";
import {
	isPrototypePollutionKey,
	parseJsoncRecovering,
} from "@magic-context/core/shared/jsonc-parser";
import { setOutputReserveConfig } from "@magic-context/core/shared/models-dev-cache";
import type { PromptSurfaceConfig } from "@magic-context/core/shared/prompt-surface";
import { setWindowOverlayPath } from "@magic-context/core/shared/window-geometry";

export interface LoadPiConfigOptions {
	cwd?: string;
}

export interface LoadPiConfigResult {
	config: MagicContextConfig;
	/** USER-tier default/overrides captured before project routing is merged. */
	registrationPromptSurface: PromptSurfaceConfig;
	warnings: string[];
	loadedFromPaths: string[];
	configParseFailures: ConfigParseFailure[];
	warningDetails: ConfigWarningDetail[];
	cacheTtlConfigured: boolean;
	hasDeprecatedProtectedTags?: boolean;
}

export type LoadOutcome =
	| "ok"
	| "project-file-parse-error"
	| "project-file-io-error"
	| "legacy-config-unmigrated"
	| "schema-recovery"
	| "substitution-failure";

export interface LoadPiConfigResultDetailed extends LoadPiConfigResult {
	loadOutcome: LoadOutcome;
	sources: {
		userConfig: LoadOutcome;
		projectConfig: LoadOutcome;
	};
	substitutionFailures: Array<{
		keyPath: string;
		source: "user" | "project";
		message: string;
	}>;
	recoveredTopLevelKeys: string[];
}

interface LoadedConfigFile {
	path: string;
	scope: "user" | "project";
	config: Record<string, unknown>;
	warnings: string[];
	parseFailures: ConfigParseFailure[];
	warningDetails: ConfigWarningDetail[];
	loadOutcome: LoadOutcome;
}

// Shared CortexKit paths are the primary config location. When that base is
// absent because migration refused/not-yet-ran, Pi may still READ its own legacy
// paths as a non-destructive fallback (see resolvePiLegacyFallback) rather than
// silently using schema defaults. The CortexKit target normalizes to .jsonc; we
// still detect a pre-existing .json at the target for resilience.
function getProjectConfigPaths(cwd: string): string[] {
	const basePath = cortexKitProjectConfigBasePath(cwd);
	return [`${basePath}.jsonc`, `${basePath}.json`];
}

function getUserConfigPaths(): string[] {
	const basePath = cortexKitUserConfigBasePath();
	return [`${basePath}.jsonc`, `${basePath}.json`];
}

function resolveFirstExisting(paths: string[]): string | undefined {
	return paths.find((path) => existsSync(path));
}

// When the shared CortexKit base is absent (migration refused on a differing
// OpenCode/Pi pair, or not yet run), read Pi's OWN legacy file as a
// non-destructive fallback rather than silently using schema defaults — which
// would re-enable features the user's real config disabled. Pi reads only Pi
// legacy paths so a differing pair stays correct per-harness.
function resolvePiLegacyFallback(
	sources: readonly LegacyConfigSource[],
): LegacyConfigSource | null {
	return sources.find((source) => existsSync(source.path)) ?? null;
}

function loadConfigFile(
	path: string,
	scope: "user" | "project",
): LoadedConfigFile | null {
	let raw: ReturnType<typeof loadRawConfigFile>;
	try {
		raw = loadRawConfigFile({ configPath: path, tier: scope });
		if (!raw) return null;
	} catch (error) {
		const message = `failed to read config: ${error instanceof Error ? error.message : String(error)}`;
		return {
			path,
			scope,
			config: {},
			warnings: [`${path}: ${message}`],
			parseFailures: [],
			warningDetails: [
				{
					warningClass: CONFIG_WARNING_CLASS.FILE_IO,
					source: scope,
					path,
					message,
				},
			],
			loadOutcome: "project-file-io-error",
		};
	}

	try {
		const substituted = substituteConfigVariables({
			text: raw.text,
			configPath: path,
			// Repo-supplied project configs are untrusted: do not expand
			// {env:}/{file:} secret-bearing tokens (parity with OpenCode).
			isProjectConfig: scope === "project",
		});
		const rejectedKeyPaths: string[] = [];
		const parsed = parseJsoncRecovering<Record<string, unknown>>(
			substituted.text,
			{
				onRejectedKey: (keyPath) => rejectedKeyPaths.push(keyPath.join(".")),
			},
		);
		const config =
			parsed.value &&
			typeof parsed.value === "object" &&
			!Array.isArray(parsed.value)
				? parsed.value
				: {};
		const unsafeKeyWarnings = rejectedKeyPaths.map(
			(keyPath) =>
				`Ignored unsafe config key "${keyPath}" (security: prototype-pollution keys are not allowed).`,
		);
		const firstIssue = parsed.issues[0];
		const recovered =
			firstIssue !== undefined && Object.keys(config).length > 0;
		const parseFailures: ConfigParseFailure[] = firstIssue
			? [
					{
						warningClass: CONFIG_WARNING_CLASS.FILE_PARSE,
						source: scope,
						path,
						line: firstIssue.line,
						column: firstIssue.column,
						message: firstIssue.message,
						recovered,
						warning: `${path}:${firstIssue.line}:${firstIssue.column}: ${firstIssue.message}; ${recovered ? "recovered values were applied, but the file must be fixed." : "using defaults for this file."}`,
					},
				]
			: [];
		return {
			path,
			scope,
			config,
			warnings: [
				...parseFailures.map((failure) => failure.warning),
				...raw.warnings.map((warning) => `${path}: ${warning}`),
				...substituted.warnings.map((warning) => `${path}: ${warning}`),
				...unsafeKeyWarnings.map((warning) => `${path}: ${warning}`),
			],
			parseFailures,
			warningDetails: parseFailures,
			loadOutcome:
				parseFailures.length > 0
					? "project-file-parse-error"
					: rejectedKeyPaths.length > 0
						? "schema-recovery"
						: substituted.warnings.length > 0
							? "substitution-failure"
							: "ok",
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const warning = `${path}:1:1: ${message}; using defaults for this file.`;
		const failure: ConfigParseFailure = {
			warningClass: CONFIG_WARNING_CLASS.FILE_PARSE,
			source: scope,
			path,
			line: 1,
			column: 1,
			message,
			recovered: false,
			warning,
		};
		return {
			path,
			scope,
			config: {},
			warnings: [warning],
			parseFailures: [failure],
			warningDetails: [failure],
			loadOutcome: "project-file-parse-error",
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

function defineOwnConfigValue(
	target: Record<string, unknown>,
	key: string,
	value: unknown,
): void {
	Object.defineProperty(target, key, {
		value,
		enumerable: true,
		configurable: true,
		writable: true,
	});
}

function mergeRawConfigs(
	base: Record<string, unknown>,
	override: Record<string, unknown>,
): Record<string, unknown> {
	const merged: Record<string, unknown> = {};
	for (const key of Object.keys(base)) {
		if (isPrototypePollutionKey(key)) continue;
		defineOwnConfigValue(merged, key, base[key]);
	}

	for (const key of Object.keys(override)) {
		if (isPrototypePollutionKey(key)) continue;
		const overrideValue = override[key];
		const baseValue = Object.hasOwn(base, key) ? base[key] : undefined;
		const mergedValue =
			isPlainObject(baseValue) && isPlainObject(overrideValue)
				? mergeRawConfigs(baseValue, overrideValue)
				: overrideValue;
		defineOwnConfigValue(merged, key, mergedValue);
	}

	return merged;
}

function parsePiConfig(
	rawConfig: Record<string, unknown>,
	recoveredTopLevelKeys: string[] = [],
): {
	config: MagicContextConfig;
	warnings: string[];
} {
	const preMigrationWarnings: string[] = [];
	const hasDeprecatedProtectedTags = Object.hasOwn(rawConfig, "protected_tags");
	if (hasDeprecatedProtectedTags) {
		preMigrationWarnings.push(
			'The "protected_tags" setting is deprecated and ignored. Use "protected_tokens" instead.',
		);
	}
	const configToMigrate = { ...rawConfig };
	if (hasDeprecatedProtectedTags) {
		delete configToMigrate.protected_tags;
	}
	const agentMigrated = migrateLegacyAgentEnabledInMemory(
		configToMigrate,
		preMigrationWarnings,
	);
	// Relocate graduated experimental.* keys (temporal_awareness, caveman →
	// top-level; auto_search, git_commit_indexing → memory.*; user_memories,
	// pin_key_files → dreamer.*). Shared with OpenCode so both harnesses preserve
	// a user's opt-in/opt-out across the upgrade.
	const migrated = migrateDreamerV2(
		migrateLegacyExperimental(agentMigrated, preMigrationWarnings),
		preMigrationWarnings,
	);
	const parsed = MagicContextConfigSchema.safeParse(migrated);
	if (parsed.success) {
		return { config: parsed.data, warnings: preMigrationWarnings };
	}

	const defaults = MagicContextConfigSchema.parse({});
	const errorPaths = new Set<string>();
	// Per top-level key, the FULL error paths — so we can prune only the invalid
	// nested leaf instead of the whole block (mirrors OpenCode config recovery).
	const issuePathsByKey = new Map<string, PropertyKey[][]>();
	for (const issue of parsed.error.issues) {
		const topKey = issue.path[0];
		if (topKey !== undefined) {
			const key = String(topKey);
			errorPaths.add(key);
			const paths = issuePathsByKey.get(key) ?? [];
			if (issue.code === "unrecognized_keys") {
				for (const unrecognizedKey of issue.keys) {
					paths.push([...issue.path, unrecognizedKey]);
				}
			} else {
				paths.push([...issue.path]);
			}
			issuePathsByKey.set(key, paths);
		}
	}

	const patched: Record<string, unknown> = { ...migrated };
	const warnings: string[] = [...preMigrationWarnings];

	for (const key of errorPaths) {
		recoveredTopLevelKeys.push(key);
		const isAgentConfig =
			key === "historian" || key === "dreamer" || key === "sidekick";

		// Object-valued key: prune ONLY invalid nested leaves, keep valid siblings
		// (e.g. don't wipe the whole `memory` block — incl. migrated auto_search /
		// git_commit_indexing — for one bad nested field). Falls back to whole-key
		// deletion when the issue is at the key itself or the value isn't an object.
		const issuePaths = issuePathsByKey.get(key) ?? [];
		const rawValue = migrated[key];
		const allNested =
			issuePaths.length > 0 &&
			issuePaths.every((p) => p.length >= 2) &&
			typeof rawValue === "object" &&
			rawValue !== null &&
			!Array.isArray(rawValue);
		if (allNested) {
			let prunedBlock: Record<string, unknown> = {
				...(rawValue as Record<string, unknown>),
			};
			const prunedLeaves: string[] = [];
			for (const p of issuePaths) {
				// Prune the DEEPEST invalid leaf (parity with OpenCode), so a
				// 3-level path like memory.git_commit_indexing.since_days drops
				// only `since_days` and keeps a sibling `enabled: false`.
				const relative = p.slice(1);
				const result = pruneNestedConfigLeaf(prunedBlock, relative);
				if (result) {
					prunedBlock = result.block;
					prunedLeaves.push(result.removed);
				}
			}
			if (prunedLeaves.length === issuePaths.length) {
				patched[key] = prunedBlock;
				warnings.push(
					`"${key}": invalid nested field(s) ${prunedLeaves.map((leaf) => `"${key}.${leaf}"`).join(", ")}, using defaults for those.`,
				);
				continue;
			}
		}

		// Root-level or unreachable agent errors cannot be repaired safely because
		// guessing a model configuration could select an expensive unintended model.
		if (isAgentConfig) {
			delete patched[key];
			warnings.push(
				`"${key}": invalid agent configuration, ignoring. Check your magic-context.jsonc.`,
			);
			continue;
		}

		delete patched[key];
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
	const detailed = loadPiConfigDetailed(opts);
	return {
		config: detailed.config,
		registrationPromptSurface: detailed.registrationPromptSurface,
		warnings: detailed.warnings,
		loadedFromPaths: detailed.loadedFromPaths,
		configParseFailures: detailed.configParseFailures,
		warningDetails: detailed.warningDetails,
		cacheTtlConfigured: detailed.cacheTtlConfigured,
		hasDeprecatedProtectedTags: detailed.hasDeprecatedProtectedTags,
	};
}

function collectEmptyStringPaths(value: unknown, prefix = ""): string[] {
	if (typeof value === "string") {
		return value === "" && prefix ? [prefix] : [];
	}
	if (Array.isArray(value) || value === null || typeof value !== "object") {
		return [];
	}

	const paths: string[] = [];
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		const nextPrefix = prefix ? `${prefix}.${key}` : key;
		paths.push(...collectEmptyStringPaths(child, nextPrefix));
	}
	return paths;
}

function bindSubstitutionFailures(
	loaded: LoadedConfigFile,
): Array<{ keyPath: string; source: "user" | "project"; message: string }> {
	if (
		loaded.warnings.length === 0 ||
		loaded.loadOutcome !== "substitution-failure"
	) {
		return [];
	}
	const emptyPaths = collectEmptyStringPaths(loaded.config);
	return loaded.warnings.map((message) => {
		const matchedPath = emptyPaths.find((path) => {
			const tail = path.split(".").at(-1) ?? path;
			return (
				message.includes(path) ||
				message.toLowerCase().includes(tail.toLowerCase())
			);
		});
		return {
			keyPath: matchedPath ?? "<unknown>",
			source: loaded.scope,
			message,
		};
	});
}

function combinedOutcome(args: {
	sources: LoadPiConfigResultDetailed["sources"];
	substitutionFailures: LoadPiConfigResultDetailed["substitutionFailures"];
	recoveredTopLevelKeys: string[];
}): LoadOutcome {
	const sourceOutcomes = Object.values(args.sources);
	if (sourceOutcomes.includes("project-file-parse-error"))
		return "project-file-parse-error";
	if (sourceOutcomes.includes("project-file-io-error"))
		return "project-file-io-error";
	if (sourceOutcomes.includes("legacy-config-unmigrated"))
		return "legacy-config-unmigrated";
	if (args.recoveredTopLevelKeys.length > 0) return "schema-recovery";
	if (args.substitutionFailures.length > 0) return "substitution-failure";
	return "ok";
}

export function loadPiConfigDetailed(
	opts: LoadPiConfigOptions = {},
): LoadPiConfigResultDetailed {
	const cwd = opts.cwd ?? process.cwd();
	const loadedFiles: LoadedConfigFile[] = [];
	const warnings: string[] = [];
	const legacySources = resolveLegacyConfigSources(cwd);
	const harnessLegacy = resolveLegacyConfigSourcesForHarness(cwd, "pi");

	const projectPath = resolveFirstExisting(getProjectConfigPaths(cwd));
	const projectLegacyFallback = projectPath
		? null
		: resolvePiLegacyFallback(harnessLegacy.project);
	const projectReadPath = projectPath ?? projectLegacyFallback?.path;
	if (projectReadPath) {
		const loaded = loadConfigFile(projectReadPath, "project");
		if (loaded) loadedFiles.push(loaded);
	}
	const legacyProjectUnmigrated =
		!projectPath &&
		!projectLegacyFallback &&
		legacySources.project.some((source) => existsSync(source.path));

	const userPath = resolveFirstExisting(getUserConfigPaths());
	const userLegacyFallback = userPath
		? null
		: resolvePiLegacyFallback(harnessLegacy.user);
	const userReadPath = userPath ?? userLegacyFallback?.path;
	if (userReadPath) {
		const loaded = loadConfigFile(userReadPath, "user");
		if (loaded) loadedFiles.push(loaded);
	}
	const legacyUserUnmigrated =
		!userPath &&
		!userLegacyFallback &&
		legacySources.user.some((source) => existsSync(source.path));

	if (userLegacyFallback) {
		warnings.push(
			`[user config] reading legacy config from ${userLegacyFallback.path} until migration completes; run \`npx @cortexkit/magic-context doctor\` to consolidate into the shared CortexKit location.`,
		);
	} else if (legacyUserUnmigrated) {
		warnings.push(
			"[user config] legacy Magic Context config exists but the shared CortexKit config is absent; embedding registration is paused until config migration completes.",
		);
	}

	if (projectLegacyFallback) {
		warnings.push(
			`[project config] reading legacy config from ${projectLegacyFallback.path} until migration completes; run \`npx @cortexkit/magic-context doctor\` to consolidate into the shared CortexKit location.`,
		);
	} else if (legacyProjectUnmigrated) {
		warnings.push(
			"[project config] legacy Magic Context config exists but the shared CortexKit config is absent; embedding registration is paused until config migration completes.",
		);
	}

	const mergeFiles = [...loadedFiles].sort((a, b) => {
		if (a.scope === b.scope) return 0;
		return a.scope === "user" ? -1 : 1;
	});
	const userRaw = mergeFiles.find((f) => f.scope === "user")?.config ?? {};
	const projectLayer = mergeFiles.find((f) => f.scope === "project");
	let projectRaw: Record<string, unknown> = {};

	for (const loaded of mergeFiles) {
		const prefix =
			loaded.scope === "user" ? "[user config]" : "[project config]";
		warnings.push(...loaded.warnings.map((warning) => `${prefix} ${warning}`));
		if (loaded.scope !== "project") continue;
		projectRaw = { ...loaded.config };
		for (const warning of stripUnsafeProjectConfigFields(projectRaw)) {
			warnings.push(`${prefix} ${warning}`);
		}
	}

	const profileResolution = resolveConfigProfile({ userRaw, projectRaw });
	warnings.push(
		...profileResolution.warnings.map((warning) => `[config] ${warning}`),
	);
	const trustedProfiledRaw = mergeRawConfigs(
		profileResolution.userBase,
		profileResolution.overlay,
	);
	let rawConfig = trustedProfiledRaw;
	const trustedBaseConfig = parsePiConfig(trustedProfiledRaw).config;
	if (projectLayer) {
		rawConfig = mergeRawConfigs(rawConfig, profileResolution.projectBase);
		for (const warning of dropInheritedEmbeddingKeyOnRedirect(
			projectRaw,
			rawConfig,
			profileResolution.userBase,
		)) {
			warnings.push(`[project config] ${warning}`);
		}
		for (const warning of constrainProjectThresholdOverrides({
			mergedRaw: rawConfig,
			projectRaw: profileResolution.projectBase,
			trustedBaseConfig,
		})) {
			warnings.push(`[project config] ${warning}`);
		}
	}

	const hasDeprecatedProtectedTags =
		Object.hasOwn(userRaw, "protected_tags") ||
		Object.hasOwn(projectRaw, "protected_tags") ||
		Object.hasOwn(rawConfig, "protected_tags");
	const recoveredTopLevelKeys: string[] = [];
	const cacheTtlConfigured = Object.hasOwn(rawConfig, "cache_ttl");
	const parsed = parsePiConfig(rawConfig, recoveredTopLevelKeys);
	if (profileResolution.activeProfile)
		parsed.config.profile = profileResolution.activeProfile;
	setOutputReserveConfig(parsed.config.output_reserve);
	setWindowOverlayPath(parsed.config.models?.window_overlay_path);
	warnings.push(
		...parsed.warnings.map((warning) => `[merged config] ${warning}`),
	);
	const substitutionFailures = loadedFiles.flatMap(bindSubstitutionFailures);
	const userLoaded = loadedFiles.find((loaded) => loaded.scope === "user");
	const projectLoaded = loadedFiles.find(
		(loaded) => loaded.scope === "project",
	);
	const configParseFailures = loadedFiles.flatMap(
		(loaded) => loaded.parseFailures,
	);
	const warningDetails: ConfigWarningDetail[] = [
		...loadedFiles.flatMap((loaded) => loaded.warningDetails),
		...parsed.warnings.map((message) => ({
			warningClass: CONFIG_WARNING_CLASS.INVALID_LEAF,
			message,
		})),
	];
	const sources = {
		userConfig:
			userLoaded?.loadOutcome ??
			(legacyUserUnmigrated
				? "legacy-config-unmigrated"
				: ("ok" as LoadOutcome)),
		projectConfig:
			projectLoaded?.loadOutcome ??
			(legacyProjectUnmigrated
				? "legacy-config-unmigrated"
				: ("ok" as LoadOutcome)),
	};

	return {
		config: parsed.config,
		registrationPromptSurface: trustedBaseConfig.prompt_surface,
		warnings,
		loadedFromPaths: loadedFiles.map((loaded) => loaded.path),
		loadOutcome: combinedOutcome({
			sources,
			substitutionFailures,
			recoveredTopLevelKeys,
		}),
		sources,
		substitutionFailures,
		recoveredTopLevelKeys,
		configParseFailures,
		warningDetails,
		cacheTtlConfigured,
		hasDeprecatedProtectedTags,
	};
}
