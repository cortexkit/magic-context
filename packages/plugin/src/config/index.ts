import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { detectConfigFile, isPrototypePollutionKey, parseJsonc } from "../shared/jsonc-parser";
import { setOutputReserveConfig } from "../shared/models-dev-cache";
import type { PromptSurfaceConfig } from "../shared/prompt-surface";
import { setWindowOverlayPath } from "../shared/window-geometry";
import { isCompactionEnabled, migrateLegacyAgentEnabledInMemory } from "./agent-disable";
import {
    cortexKitProjectConfigBasePath,
    cortexKitUserConfigBasePath,
    type LegacyConfigSource,
    resolveLegacyConfigSources,
    resolveLegacyConfigSourcesForHarness,
} from "./migrate-config-location";
import { migrateDreamerV2 } from "./migrate-dreamer-v2";
import { migrateLegacyExperimental } from "./migrate-experimental";
import { resolveConfigProfile } from "./profiles";
import {
    constrainProjectThresholdOverrides,
    dropInheritedEmbeddingKeyOnRedirect,
    stripUnsafeProjectConfigFields,
} from "./project-security";
import { pruneNestedConfigLeaf } from "./prune-config-leaf";
import { loadRawConfigFile } from "./raw-loader";
import { type MagicContextConfig, MagicContextConfigSchema } from "./schema/magic-context";
import { resolveTransformMode } from "./transform-mode";
import { substituteConfigVariables } from "./variable";

export interface MagicContextPluginConfig extends MagicContextConfig {
    disabled_hooks?: string[];
    command?: Record<
        string,
        {
            template: string;
            description?: string;
            agent?: string;
            model?: string;
            subtask?: boolean;
        }
    >;
}

// Config is read from the shared CortexKit location. The location migrator
// (migrate-config-location.ts) runs at plugin init and moves legacy per-harness
// files to the CortexKit path before the loader runs. When the migration could
// NOT complete (it refuses on an OpenCode-vs-Pi config that differs, or it never
// ran in this process), the CortexKit base is absent — in that case the loader
// reads THIS harness's own legacy file as a non-destructive fallback rather than
// silently using schema defaults (which would re-enable features the user's real
// config disabled). See resolveLegacyReadFallback.
function getUserConfigBasePath(): string {
    return cortexKitUserConfigBasePath();
}

function getProjectConfigBasePath(directory: string): string {
    return cortexKitProjectConfigBasePath(directory);
}

const MODEL_OVERLAY_AGENTS = ["historian", "dreamer", "sidekick"] as const;
const MODEL_OVERLAY_FIELDS = ["model", "fallback_models", "variant"] as const;

function loadModelOverlay(): Record<string, unknown> | null {
    const configuredPath = process.env.MAGIC_CONTEXT_CONFIG?.trim();
    if (!configuredPath) return null;

    const loaded = loadConfigFileDetailed(
        resolvePath(configuredPath),
        "user",
    );
    if (!loaded) return null;

    const overlay: Record<string, unknown> = {};
    const ignored: string[] = [];
    for (const key of Object.keys(loaded.config)) {
        if (!(MODEL_OVERLAY_AGENTS as readonly string[]).includes(key)) {
            ignored.push(key);
        }
    }
    for (const agent of MODEL_OVERLAY_AGENTS) {
        const source = loaded.config[agent];
        if (!source || typeof source !== "object" || Array.isArray(source)) {
            if (source !== undefined) ignored.push(agent);
            continue;
        }
        const sourceRecord = source as Record<string, unknown>;
        const isFlatSidekick = agent === "sidekick";
        const harness = isFlatSidekick ? sourceRecord : sourceRecord.opencode;
        for (const key of Object.keys(sourceRecord)) {
            if (isFlatSidekick ? !(MODEL_OVERLAY_FIELDS as readonly string[]).includes(key) : key !== "opencode") {
                ignored.push(`${agent}.${key}`);
            }
        }
        if (!harness || typeof harness !== "object" || Array.isArray(harness)) {
            if (harness !== undefined) ignored.push(`${agent}${isFlatSidekick ? "" : ".opencode"}`);
            continue;
        }
        const selected: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(harness)) {
            if ((MODEL_OVERLAY_FIELDS as readonly string[]).includes(key)) {
                selected[key] = value;
            } else {
                ignored.push(`${agent}.opencode.${key}`);
            }
        }
        if (Object.keys(selected).length > 0) {
            overlay[agent] = isFlatSidekick ? selected : { opencode: selected };
        }
    }

    if (loaded.warnings.length > 0 || ignored.length > 0) {
        overlay.configWarnings = [
            ...loaded.warnings.map((warning) => `[model overlay] ${warning}`),
            ...(ignored.length > 0
                ? [
                      `[model overlay] Ignoring unsupported keys: ${ignored.join(", ")}. Only OpenCode model, fallback_models, and variant fields are supported.`,
                  ]
                : []),
        ];
    }
    return overlay;
}

interface LegacyReadFallback {
    /** The legacy file we read, or null if no harness-owned legacy file exists. */
    source: LegacyConfigSource | null;
}

/**
 * First existing legacy source owned by the OpenCode harness, for the read
 * fallback when the CortexKit base is absent. Pi has its own loader with the
 * symmetric Pi-scoped fallback.
 */
function resolveLegacyReadFallback(sources: readonly LegacyConfigSource[]): LegacyReadFallback {
    return { source: sources.find((s) => existsSync(s.path)) ?? null };
}

interface LoadedConfigFile {
    config: Record<string, unknown>;
    /** Warnings from {env:} / {file:} substitution, with config-path prefix applied. */
    warnings: string[];
}

export type LoadOutcome =
    | "ok"
    | "project-file-parse-error"
    | "project-file-io-error"
    | "legacy-config-unmigrated"
    | "schema-recovery"
    | "substitution-failure";

export interface LoadResultDetailed {
    config: MagicContextPluginConfig & { configWarnings?: string[] };
    /** USER-tier default/overrides captured before project routing is merged. */
    registrationPromptSurface: PromptSurfaceConfig;
    loadOutcome: LoadOutcome;
    sources: {
        userConfig: LoadOutcome;
        projectConfig: LoadOutcome;
    };
    substitutionFailures: Array<{ keyPath: string; source: "user" | "project"; message: string }>;
    recoveredTopLevelKeys: string[];
}

interface LoadedConfigFileDetailed extends LoadedConfigFile {
    outcome: LoadOutcome;
    source: "user" | "project";
}

function loadConfigFileDetailed(
    configPath: string,
    source: "user" | "project",
): LoadedConfigFileDetailed | null {
    if (!existsSync(configPath)) {
        return null;
    }

    let rawText: string;
    let rawWarnings: string[];
    try {
        const raw = loadRawConfigFile({ configPath, tier: source });
        if (!raw) return null;
        rawText = raw.text;
        rawWarnings = raw.warnings;
    } catch (error) {
        return {
            config: {},
            warnings: [
                `${configPath}: failed to read config: ${error instanceof Error ? error.message : String(error)}`,
            ],
            outcome: "project-file-io-error",
            source,
        };
    }

    try {
        const substituted = substituteConfigVariables({
            text: rawText,
            configPath,
            isProjectConfig: source === "project",
        });
        const rejectedKeyPaths: string[] = [];
        const config = parseJsonc<Record<string, unknown>>(substituted.text, {
            onRejectedKey: (path) => rejectedKeyPaths.push(path.join(".")),
        });
        const unsafeKeyWarnings = rejectedKeyPaths.map(
            (path) =>
                `Ignored unsafe config key "${path}" (security: prototype-pollution keys are not allowed).`,
        );
        return {
            config,
            warnings: [...rawWarnings, ...substituted.warnings, ...unsafeKeyWarnings].map(
                (warning) => `${configPath}: ${warning}`,
            ),
            outcome:
                rejectedKeyPaths.length > 0
                    ? "schema-recovery"
                    : substituted.warnings.length > 0
                      ? "substitution-failure"
                      : "ok",
            source,
        };
    } catch (error) {
        return {
            config: {},
            warnings: [
                `${configPath}: failed to load config: ${error instanceof Error ? error.message : String(error)}`,
            ],
            outcome: "project-file-parse-error",
            source,
        };
    }
}

/**
 * Deep-merge two raw JSON objects. Both inputs must come from BEFORE Zod
 * parsing — otherwise Zod-filled defaults appear as if they were explicit
 * overrides and clobber genuine values from the other source.
 *
 * Plain object values merge recursively. Arrays, primitives, and `null` are
 * replaced atomically (override wins). This matches typical config-merge
 * semantics: arrays like `disabled_hooks` should be set whole, not interleaved
 * element-wise.
 *
 * `disabled_hooks` is the one exception: we union-merge it below so user
 * and project can both contribute hook IDs without one silently losing the
 * other's entries.
 */
function defineOwnConfigValue(target: Record<string, unknown>, key: string, value: unknown): void {
    Object.defineProperty(target, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
    });
}

function deepMergeRawConfig(
    base: Record<string, unknown>,
    override: Record<string, unknown>,
): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(base)) {
        if (isPrototypePollutionKey(key)) continue;
        defineOwnConfigValue(result, key, base[key]);
    }

    for (const key of Object.keys(override)) {
        if (isPrototypePollutionKey(key)) continue;
        const baseVal = Object.hasOwn(base, key) ? base[key] : undefined;
        const overrideVal = override[key];
        let mergedValue: unknown;
        if (
            baseVal !== null &&
            typeof baseVal === "object" &&
            !Array.isArray(baseVal) &&
            overrideVal !== null &&
            typeof overrideVal === "object" &&
            !Array.isArray(overrideVal)
        ) {
            mergedValue = deepMergeRawConfig(
                baseVal as Record<string, unknown>,
                overrideVal as Record<string, unknown>,
            );
        } else if (
            key === "disabled_hooks" &&
            Array.isArray(baseVal) &&
            Array.isArray(overrideVal)
        ) {
            // Union-merge so user + project can both disable hooks without
            // one source erasing the other's entries.
            mergedValue = [...new Set([...baseVal, ...overrideVal])];
        } else {
            mergedValue = overrideVal;
        }
        defineOwnConfigValue(result, key, mergedValue);
    }
    return result;
}

/**
 * Render a config value for a warning message in a way that never leaks resolved
 * secrets from `{env:API_KEY}` / `{file:...}` substitution.
 *
 * Strings, numbers, booleans, and nulls are shown as type-plus-length so the
 * user can still diagnose the problem ("string, 48 chars", "number 200001") but
 * never see the resolved content. Objects and arrays are shown as their
 * structural shape only. `undefined` / missing values are reported as
 * `<missing>`.
 */
function redactConfigValue(value: unknown): string {
    if (value === undefined) return "<missing>";
    if (value === null) return "null";
    if (typeof value === "string")
        return `string, ${value.length} char${value.length === 1 ? "" : "s"}`;
    if (typeof value === "number") return `number ${value}`;
    if (typeof value === "boolean") return `boolean ${value}`;
    if (Array.isArray(value)) return `array, ${value.length} item${value.length === 1 ? "" : "s"}`;
    if (typeof value === "object") {
        const keys = Object.keys(value as Record<string, unknown>);
        return `object with keys [${keys.join(", ")}]`;
    }
    return typeof value;
}

function parsePluginConfig(
    rawConfig: Record<string, unknown>,
    recoveredTopLevelKeys: string[] = [],
): MagicContextPluginConfig & { configWarnings?: string[] } {
    // Pre-Zod shim: reshape legacy experimental.* graduated keys so the user's
    // opt-in/out state survives upgrades even when they never run `doctor`.
    const preMigrationWarnings: string[] = [];
    const migratedExperimental = migrateLegacyExperimental(rawConfig, preMigrationWarnings);
    // Dreamer v2: convert the legacy v1 dreamer shape (window schedule, tasks
    // array, user_memories/pin_key_files blocks) into the per-task `tasks` record.
    // Runs AFTER migrate-experimental so experimental.user_memories (already
    // relocated to dreamer.user_memories above) is folded into the v2 tasks here.
    const migratedDreamer = migrateDreamerV2(migratedExperimental, preMigrationWarnings);
    const migrated = migrateLegacyAgentEnabledInMemory(migratedDreamer, preMigrationWarnings);
    const parsed = MagicContextConfigSchema.safeParse(migrated);
    const disabledHooks = Array.isArray(rawConfig.disabled_hooks)
        ? rawConfig.disabled_hooks.filter((value): value is string => typeof value === "string")
        : undefined;
    const command =
        typeof rawConfig.command === "object" && rawConfig.command !== null
            ? (rawConfig.command as MagicContextPluginConfig["command"])
            : undefined;

    if (parsed.success) {
        return {
            ...parsed.data,
            disabled_hooks: disabledHooks,
            command,
            ...(preMigrationWarnings.length > 0 ? { configWarnings: preMigrationWarnings } : {}),
        };
    }

    // Full parse failed — recover field-by-field using defaults for invalid fields.
    // Invalid nested leaves are pruned from agent blocks; only root-level or
    // unreachable agent errors drop the block, because guessing a model config
    // could run an expensive unintended model or fail silently.
    const defaults = MagicContextConfigSchema.parse({});
    const warnings: string[] = [];

    // Build a patched copy of rawConfig, replacing invalid fields with undefined
    // so Zod fills in defaults on the second parse.
    const errorPaths = new Set<string>();
    // Collect any custom Zod messages per top-level key so a field with an
    // explanatory `.max(..., "why")` / `.refine(..., "why")` message surfaces the
    // reason to the user instead of a bare "invalid value" (e.g. issue #111's
    // execute_threshold cache-safety explanation). Only non-default Zod messages
    // are kept — the generic "Too big"/"Invalid input" boilerplate adds nothing.
    const customMessagesByKey = new Map<string, string>();
    // Per top-level key, the set of FULL error paths (e.g. ["memory","auto_search"]).
    // Used to prune only the invalid nested leaf instead of the whole block.
    const issuePathsByKey = new Map<string, PropertyKey[][]>();
    const GENERIC_ZOD_PREFIXES = ["Too big", "Too small", "Invalid input", "Invalid", "Expected"];
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
            const msg = issue.message;
            if (msg && !GENERIC_ZOD_PREFIXES.some((p) => msg.startsWith(p))) {
                if (!customMessagesByKey.has(key)) {
                    customMessagesByKey.set(key, msg);
                }
            }
        }
    }

    const patched: Record<string, unknown> = { ...rawConfig };
    for (const key of errorPaths) {
        recoveredTopLevelKeys.push(key);
        const isAgentConfig = key === "historian" || key === "dreamer" || key === "sidekick";

        // For object-valued keys (including agent harness blocks), prune only invalid
        // nested leaves and keep valid siblings, so one bad field does not remove
        // already-migrated keys such as memory.auto_search and
        // memory.git_commit_indexing. Fall back to whole-key deletion when the issue
        // is at the key itself or the value is not a prunable object.
        const issuePaths = issuePathsByKey.get(key) ?? [];
        const rawValue = rawConfig[key];
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
                // p is the full Zod issue path ([key, ...nested]); prune the
                // DEEPEST invalid leaf, not just the first child (p[1]), so a
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
                const reason = customMessagesByKey.get(key);
                warnings.push(
                    `"${key}": invalid nested field(s) ${prunedLeaves.map((leaf) => `"${key}.${leaf}"`).join(", ")}, using defaults for those.${reason ? ` ${reason}` : ""}`,
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

        // Use Zod default for this field.
        // Intentional: redactConfigValue reports type+length, never the
        // resolved value itself, because `{env:...}` / `{file:...}`
        // substitution may have already expanded secrets into rawConfig.
        delete patched[key];
        const defaultVal = (defaults as unknown as Record<string, unknown>)[key];
        const reason = customMessagesByKey.get(key);
        warnings.push(
            `"${key}": invalid value (${redactConfigValue(rawConfig[key])}), using default ${JSON.stringify(defaultVal)}.${reason ? ` ${reason}` : ""}`,
        );
    }

    // Re-run migration on the field-recovered patched config so legacy
    // experimental + dreamer-v1 blocks still migrate on the recovery path.
    const retryMigrated = migrateLegacyAgentEnabledInMemory(
        migrateDreamerV2(
            migrateLegacyExperimental(patched, preMigrationWarnings),
            preMigrationWarnings,
        ),
        preMigrationWarnings,
    );
    const retryParsed = MagicContextConfigSchema.safeParse(retryMigrated);
    if (retryParsed.success) {
        return {
            ...retryParsed.data,
            disabled_hooks: disabledHooks,
            command,
            configWarnings: [...preMigrationWarnings, ...warnings],
        };
    }

    // If even the patched version fails (shouldn't happen), fall back to full defaults
    // but keep enabled:true — the user intended to use the plugin.
    warnings.push("Config recovery failed, using all defaults.");
    return {
        ...defaults,
        disabled_hooks: disabledHooks,
        command,
        configWarnings: [...preMigrationWarnings, ...warnings],
    };
}

export function loadPluginConfig(
    directory: string,
): MagicContextPluginConfig & { configWarnings?: string[] } {
    // Delegate to the detailed loader so there is exactly ONE config-resolution
    // path. The detailed variant owns the read-legacy-on-conflict fallback (when
    // the shared CortexKit base is absent, read THIS harness's own legacy config
    // instead of falling to schema defaults), the project-config hardening, and
    // the embedding-redirect guard. Having a second hand-maintained copy here is
    // how the read-legacy fallback silently missed the runtime init path
    // (index.ts calls loadPluginConfig) while only the embedding bootstrap got
    // it — a config-drop bug. The extra detailed fields (outcome, sources,
    // substitutionFailures) are simply dropped for callers that only need the
    // config + warnings.
    return loadPluginConfigDetailed(directory).config;
}

function hasUserTierSubcConfig(config: Record<string, unknown> | undefined): boolean {
    const subc = config?.subc;
    if (typeof subc !== "object" || subc === null || Array.isArray(subc)) return false;
    const connectionFile = (subc as Record<string, unknown>).connection_file;
    return typeof connectionFile === "string" && connectionFile.trim().length > 0;
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
    loaded: LoadedConfigFileDetailed | null,
): Array<{ keyPath: string; source: "user" | "project"; message: string }> {
    if (!loaded || loaded.warnings.length === 0 || loaded.outcome !== "substitution-failure") {
        return [];
    }

    const emptyPaths = collectEmptyStringPaths(loaded.config);
    return loaded.warnings.map((message) => {
        const matchedPath = emptyPaths.find((path) => {
            const tail = path.split(".").at(-1) ?? path;
            return message.includes(path) || message.toLowerCase().includes(tail.toLowerCase());
        });
        return { keyPath: matchedPath ?? "<unknown>", source: loaded.source, message };
    });
}

function combinedOutcome(args: {
    sources: LoadResultDetailed["sources"];
    substitutionFailures: LoadResultDetailed["substitutionFailures"];
    recoveredTopLevelKeys: string[];
}): LoadOutcome {
    const sourceOutcomes = Object.values(args.sources);
    if (sourceOutcomes.includes("project-file-parse-error")) return "project-file-parse-error";
    if (sourceOutcomes.includes("project-file-io-error")) return "project-file-io-error";
    if (sourceOutcomes.includes("legacy-config-unmigrated")) return "legacy-config-unmigrated";
    if (args.recoveredTopLevelKeys.length > 0) return "schema-recovery";
    if (args.substitutionFailures.length > 0) return "substitution-failure";
    return "ok";
}

export function loadPluginConfigDetailed(directory: string): LoadResultDetailed {
    const userDetected = detectConfigFile(getUserConfigBasePath());
    const projectDetected = detectConfigFile(getProjectConfigBasePath(directory));
    // Both-harness sources drive the GC-suppression signal; this-harness sources
    // (OpenCode) drive the non-destructive read fallback when the base is absent.
    const legacySources = resolveLegacyConfigSources(directory);
    const harnessLegacy = resolveLegacyConfigSourcesForHarness(directory, "opencode");

    // When the CortexKit base is absent (migration refused on a differing
    // OpenCode/Pi pair, or hasn't run), read THIS harness's own legacy file
    // instead of falling to schema defaults that would silently re-enable
    // features the user disabled.
    const userLegacyFallback =
        userDetected.format === "none"
            ? resolveLegacyReadFallback(harnessLegacy.user)
            : { source: null };
    const projectLegacyFallback =
        projectDetected.format === "none"
            ? resolveLegacyReadFallback(harnessLegacy.project)
            : { source: null };

    // "Unmigrated" (→ untrusted, GC suppressed) ONLY when the base is absent,
    // some legacy config exists, AND we did NOT read this harness's own legacy.
    // If we read our own legacy the config is real → trusted. If only the OTHER
    // harness's legacy exists we fell to defaults → keep GC suppressed so a
    // default-config start can't reap the other harness's embedding vectors.
    const legacyUserUnmigrated =
        userDetected.format === "none" &&
        !userLegacyFallback.source &&
        legacySources.user.some((source) => existsSync(source.path));
    const legacyProjectUnmigrated =
        projectDetected.format === "none" &&
        !projectLegacyFallback.source &&
        legacySources.project.some((source) => existsSync(source.path));

    const userLoaded =
        userDetected.format !== "none"
            ? loadConfigFileDetailed(userDetected.path, "user")
            : userLegacyFallback.source
              ? loadConfigFileDetailed(userLegacyFallback.source.path, "user")
              : null;
    const projectLoaded =
        projectDetected.format !== "none"
            ? loadConfigFileDetailed(projectDetected.path, "project")
            : projectLegacyFallback.source
              ? loadConfigFileDetailed(projectLegacyFallback.source.path, "project")
              : null;

    const allWarnings: string[] = [];

    if (userLegacyFallback.source) {
        allWarnings.push(
            `[user config] reading legacy config from ${userLegacyFallback.source.path} until migration completes; run \`npx @cortexkit/magic-context doctor\` to consolidate into the shared CortexKit location.`,
        );
    } else if (legacyUserUnmigrated) {
        allWarnings.push(
            "[user config] legacy Magic Context config exists but the shared CortexKit config is absent; embedding registration is paused until config migration completes.",
        );
    }

    if (projectLegacyFallback.source) {
        allWarnings.push(
            `[project config] reading legacy config from ${projectLegacyFallback.source.path} until migration completes; run \`npx @cortexkit/magic-context doctor\` to consolidate into the shared CortexKit location.`,
        );
    } else if (legacyProjectUnmigrated) {
        allWarnings.push(
            "[project config] legacy Magic Context config exists but the shared CortexKit config is absent; embedding registration is paused until config migration completes.",
        );
    }

    if (userLoaded) {
        allWarnings.push(...userLoaded.warnings.map((w) => `[user config] ${w}`));
    }

    let projectRaw: Record<string, unknown> = {};
    if (projectLoaded) {
        allWarnings.push(...projectLoaded.warnings.map((w) => `[project config] ${w}`));
        projectRaw = { ...projectLoaded.config };
        for (const warning of stripUnsafeProjectConfigFields(projectRaw)) {
            allWarnings.push(`[project config] ${warning}`);
        }
    }

    // Resolve profiles at the single user→project merge choke point. The profile
    // definition is parsed from the trusted user tier, then its validated model
    // overlay is merged before the untrusted project config. The raw selector is
    // consumed here; only the resolved name remains as status metadata.
    const profileResolution = resolveConfigProfile({
        userRaw: userLoaded?.config ?? {},
        projectRaw,
    });
    allWarnings.push(...profileResolution.warnings.map((warning) => `[config] ${warning}`));
    const trustedProfiledRaw = deepMergeRawConfig(
        profileResolution.userBase,
        profileResolution.overlay,
    );
    let mergedRaw = trustedProfiledRaw;
    // Threshold trust boundary is relative to the USER/default effective config:
    // a cloned repo may delay compaction, but it may not lower thresholds in a
    // way that forces extra historian work on the user's account.
    const trustedBaseConfig = parsePluginConfig(trustedProfiledRaw);

    if (projectLoaded) {
        mergedRaw = deepMergeRawConfig(mergedRaw, profileResolution.projectBase);
        for (const warning of dropInheritedEmbeddingKeyOnRedirect(
            projectRaw,
            mergedRaw,
            profileResolution.userBase,
        )) {
            allWarnings.push(`[project config] ${warning}`);
        }
        for (const warning of constrainProjectThresholdOverrides({
            mergedRaw,
            projectRaw: profileResolution.projectBase,
            trustedBaseConfig,
        })) {
            allWarnings.push(`[project config] ${warning}`);
        }
    }

    const modelOverlay = loadModelOverlay();
    if (modelOverlay) {
        const overlayWarnings = modelOverlay.configWarnings;
        delete modelOverlay.configWarnings;
        mergedRaw = deepMergeRawConfig(mergedRaw, modelOverlay);
        if (overlayWarnings) allWarnings.push(...overlayWarnings);
    }

    const recoveredTopLevelKeys: string[] = [];
    const config = parsePluginConfig(mergedRaw, recoveredTopLevelKeys);
    if (profileResolution.activeProfile) config.profile = profileResolution.activeProfile;
    setOutputReserveConfig(config.output_reserve);
    setWindowOverlayPath(config.models?.window_overlay_path);
    if (config.configWarnings?.length) {
        allWarnings.push(
            ...config.configWarnings.map((w) => {
                if (userLoaded && projectLoaded) return `[config] ${w}`;
                if (userLoaded) return `[user config] ${w}`;
                return `[project config] ${w}`;
            }),
        );
    }

    const resolvedTransformMode = resolveTransformMode({
        configured: config.transform_mode,
        userTierHasSubc: hasUserTierSubcConfig(userLoaded?.config),
        compactionEnabled: isCompactionEnabled(config),
    });
    config.transform_mode = resolvedTransformMode.mode;
    allWarnings.push(...resolvedTransformMode.warnings.map((warning) => `[config] ${warning}`));

    if (allWarnings.length > 0) {
        config.configWarnings = allWarnings;
    } else if ("configWarnings" in config) {
        config.configWarnings = undefined;
    }

    const substitutionFailures = [
        ...bindSubstitutionFailures(userLoaded),
        ...bindSubstitutionFailures(projectLoaded),
    ];
    const sources = {
        userConfig:
            userLoaded?.outcome ??
            (legacyUserUnmigrated ? "legacy-config-unmigrated" : ("ok" as LoadOutcome)),
        projectConfig:
            projectLoaded?.outcome ??
            (legacyProjectUnmigrated ? "legacy-config-unmigrated" : ("ok" as LoadOutcome)),
    };

    return {
        config,
        registrationPromptSurface: trustedBaseConfig.prompt_surface,
        loadOutcome: combinedOutcome({ sources, substitutionFailures, recoveredTopLevelKeys }),
        sources,
        substitutionFailures,
        recoveredTopLevelKeys,
    };
}
