import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { detectConfigFile, parseJsonc } from "../shared/jsonc-parser";
import { type MagicContextConfig, MagicContextConfigSchema } from "./schema/magic-context";
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

const CONFIG_FILE_BASENAME = "magic-context";

function getUserConfigBasePath(): string {
    const configRoot = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
    return join(configRoot, "opencode", CONFIG_FILE_BASENAME);
}

function getProjectConfigBasePath(directory: string): string {
    return join(directory, ".opencode", CONFIG_FILE_BASENAME);
}

interface LoadedConfigFile {
    config: Record<string, unknown>;
    /** Warnings from {env:} / {file:} substitution, with config-path prefix applied. */
    warnings: string[];
}

function loadConfigFile(configPath: string): LoadedConfigFile | null {
    try {
        if (!existsSync(configPath)) {
            return null;
        }
        const rawText = readFileSync(configPath, "utf-8");
        // Substitute {env:VAR} and {file:path} tokens on the raw text before
        // parsing so users can reference env vars (API keys) and external files
        // without leaking secrets into the config file itself. Matches OpenCode's
        // ConfigVariable.substitute semantics exactly.
        const substituted = substituteConfigVariables({ text: rawText, configPath });
        return {
            config: parseJsonc<Record<string, unknown>>(substituted.text),
            warnings: substituted.warnings.map((w) => `${configPath}: ${w}`),
        };
    } catch (error) {
        console.warn(
            `[magic-context] failed to load config from ${configPath}:`,
            error instanceof Error ? error.message : String(error),
        );
        return null;
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
function deepMergeRawConfig(
    base: Record<string, unknown>,
    override: Record<string, unknown>,
): Record<string, unknown> {
    const result: Record<string, unknown> = { ...base };
    for (const key of Object.keys(override)) {
        const baseVal = base[key];
        const overrideVal = override[key];
        if (
            baseVal !== null &&
            typeof baseVal === "object" &&
            !Array.isArray(baseVal) &&
            overrideVal !== null &&
            typeof overrideVal === "object" &&
            !Array.isArray(overrideVal)
        ) {
            result[key] = deepMergeRawConfig(
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
            result[key] = [...new Set([...baseVal, ...overrideVal])];
        } else {
            result[key] = overrideVal;
        }
    }
    return result;
}

function getProjectUserOnlyFields(config: Record<string, unknown>): string[] {
    return "auto_update" in config ? ["auto_update"] : [];
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

/**
 * Startup-time shim for graduated experimental features.
 *
 * v0.14 graduated `experimental.user_memories` and `experimental.pin_key_files`
 * into `dreamer.user_memories` / `dreamer.pin_key_files`. Doctor runs an
 * on-disk migration, but users who never run doctor would otherwise lose their
 * opt-in/opt-out because the graduated keys are no longer in the schema — Zod
 * silently strips unknown keys.
 *
 * This shim runs in-memory on every load: if the user has legacy
 * `experimental.<graduated-key>` blocks, we reshape the raw config so the
 * new schema sees them at their graduated path. The on-disk file stays
 * untouched (doctor is still the tool that cleans it up), and the user's
 * explicit intent is preserved for this session's runtime behavior.
 *
 * Primitive values (e.g., `experimental.user_memories: true`) are coerced to
 * `{ enabled: <bool> }` object form so Zod accepts them. Without this coercion,
 * the primitive would fail schema validation and fall back to the graduated
 * default — silently flipping a user's explicit `false` to the new `true`
 * default, or vice versa.
 *
 * Idempotent: if the new path already has a value, we don't overwrite it.
 */
function migrateLegacyExperimental(
    rawConfig: Record<string, unknown>,
    warnings: string[],
): Record<string, unknown> {
    const experimental = rawConfig.experimental;
    if (typeof experimental !== "object" || experimental === null) {
        return rawConfig;
    }
    const exp = experimental as Record<string, unknown>;
    const hasUM = "user_memories" in exp;
    const hasPKF = "pin_key_files" in exp;
    if (!hasUM && !hasPKF) {
        return rawConfig;
    }

    // Clone shallowly — we only mutate the experimental + dreamer branches.
    const patched: Record<string, unknown> = { ...rawConfig };
    const dreamer =
        typeof patched.dreamer === "object" && patched.dreamer !== null
            ? { ...(patched.dreamer as Record<string, unknown>) }
            : ({} as Record<string, unknown>);
    const newExperimental = { ...exp };

    const coerceToObject = (value: unknown): Record<string, unknown> | undefined => {
        if (typeof value === "boolean") {
            return { enabled: value };
        }
        if (typeof value === "object" && value !== null) {
            return { ...(value as Record<string, unknown>) };
        }
        return undefined;
    };

    if (hasUM) {
        const oldUM = coerceToObject(exp.user_memories);
        if (oldUM !== undefined) {
            if (dreamer.user_memories === undefined) {
                dreamer.user_memories = oldUM;
                warnings.push(
                    'Migrated "experimental.user_memories" → "dreamer.user_memories" in-memory (run `doctor` to persist).',
                );
            } else if (
                typeof dreamer.user_memories === "object" &&
                dreamer.user_memories !== null
            ) {
                // Both exist: dreamer.* wins (user has graduated), but fill
                // in any sub-fields that only exist on the old block so
                // explicit settings like promotion_threshold aren't lost.
                dreamer.user_memories = {
                    ...oldUM,
                    ...(dreamer.user_memories as Record<string, unknown>),
                };
            }
        }
        delete newExperimental.user_memories;
    }

    if (hasPKF) {
        const oldPKF = coerceToObject(exp.pin_key_files);
        if (oldPKF !== undefined) {
            if (dreamer.pin_key_files === undefined) {
                dreamer.pin_key_files = oldPKF;
                warnings.push(
                    'Migrated "experimental.pin_key_files" → "dreamer.pin_key_files" in-memory (run `doctor` to persist).',
                );
            } else if (
                typeof dreamer.pin_key_files === "object" &&
                dreamer.pin_key_files !== null
            ) {
                dreamer.pin_key_files = {
                    ...oldPKF,
                    ...(dreamer.pin_key_files as Record<string, unknown>),
                };
            }
        }
        delete newExperimental.pin_key_files;
    }

    patched.experimental = newExperimental;
    patched.dreamer = dreamer;
    return patched;
}

function parsePluginConfig(
    rawConfig: Record<string, unknown>,
): MagicContextPluginConfig & { configWarnings?: string[] } {
    // Pre-Zod shim: reshape legacy experimental.* graduated keys so the user's
    // opt-in/out state survives upgrades even when they never run `doctor`.
    const preMigrationWarnings: string[] = [];
    const migrated = migrateLegacyExperimental(rawConfig, preMigrationWarnings);
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
    // Agent configs (historian, dreamer, sidekick) are dropped on error rather than defaulted
    // because wrong model config could run expensive models or fail silently.
    const defaults = MagicContextConfigSchema.parse({});
    const warnings: string[] = [];

    // Build a patched copy of rawConfig, replacing invalid fields with undefined
    // so Zod fills in defaults on the second parse.
    const errorPaths = new Set<string>();
    for (const issue of parsed.error.issues) {
        const topKey = issue.path[0];
        if (topKey !== undefined) {
            errorPaths.add(String(topKey));
        }
    }

    const patched: Record<string, unknown> = { ...rawConfig };
    for (const key of errorPaths) {
        const isAgentConfig = key === "historian" || key === "dreamer" || key === "sidekick";
        if (isAgentConfig) {
            // Drop agent configs entirely on error — don't default them
            delete patched[key];
            warnings.push(
                `"${key}": invalid agent configuration, ignoring. Check your magic-context.jsonc.`,
            );
        } else {
            // Use Zod default for this field.
            // Intentional: redactConfigValue reports type+length, never the
            // resolved value itself, because `{env:...}` / `{file:...}`
            // substitution may have already expanded secrets into rawConfig.
            delete patched[key];
            const defaultVal = (defaults as unknown as Record<string, unknown>)[key];
            warnings.push(
                `"${key}": invalid value (${redactConfigValue(rawConfig[key])}), using default ${JSON.stringify(defaultVal)}.`,
            );
        }
    }

    // Re-run migration on the field-recovered patched config so legacy
    // experimental blocks still migrate on the recovery path.
    const retryMigrated = migrateLegacyExperimental(patched, preMigrationWarnings);
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
    const userDetected = detectConfigFile(getUserConfigBasePath());
    // Check project root first, then .opencode/ — root takes precedence
    const rootDetected = detectConfigFile(join(directory, CONFIG_FILE_BASENAME));
    const dotOpenCodeDetected = detectConfigFile(getProjectConfigBasePath(directory));
    const projectDetected = rootDetected.format !== "none" ? rootDetected : dotOpenCodeDetected;

    const userLoaded = userDetected.format === "none" ? null : loadConfigFile(userDetected.path);
    const projectLoaded =
        projectDetected.format === "none" ? null : loadConfigFile(projectDetected.path);

    const allWarnings: string[] = [];
    let mergedRaw: Record<string, unknown> = {};

    if (userLoaded) {
        // Variable-substitution warnings surface first so users see missing
        // env vars before any downstream schema-validation warnings.
        allWarnings.push(...userLoaded.warnings.map((w) => `[user config] ${w}`));
        mergedRaw = deepMergeRawConfig(mergedRaw, userLoaded.config);
    }

    if (projectLoaded) {
        allWarnings.push(...projectLoaded.warnings.map((w) => `[project config] ${w}`));

        // Strip user-only fields from project raw BEFORE merging. Project
        // configs must not silently override `auto_update` — that's a
        // security boundary: a malicious project config could otherwise
        // suppress plugin self-updates that may include security fixes.
        const projectRaw = { ...projectLoaded.config };
        const strippedUserOnlyFields = getProjectUserOnlyFields(projectRaw);
        if (strippedUserOnlyFields.length > 0) {
            for (const key of strippedUserOnlyFields) {
                delete projectRaw[key];
            }
            allWarnings.push(
                `[project config] Ignoring ${strippedUserOnlyFields.join(
                    ", ",
                )} from project config (security: these settings only honor user-level config)`,
            );
        }

        mergedRaw = deepMergeRawConfig(mergedRaw, projectRaw);
    }

    // Parse the merged raw config ONCE. Critical: parsing must run AFTER the
    // raw merge so Zod fills defaults only for keys neither user nor project
    // explicitly set. The previous design parsed each source separately then
    // merged the parsed (defaults-filled) results, which let a project
    // config that didn't mention `embedding` silently override a user's
    // explicit openai-compatible config with the local Zod default. See
    // regression discussion 2026-05-12.
    const config = parsePluginConfig(mergedRaw);

    if (config.configWarnings?.length) {
        // Tag schema-validation warnings against whichever source set the
        // bad field. We can't always tell which one set what after merging,
        // so use a generic prefix when the offending key appears in both.
        allWarnings.push(
            ...config.configWarnings.map((w) => {
                if (userLoaded && projectLoaded) return `[config] ${w}`;
                if (userLoaded) return `[user config] ${w}`;
                return `[project config] ${w}`;
            }),
        );
    }

    if (allWarnings.length > 0) {
        config.configWarnings = allWarnings;
    } else if ("configWarnings" in config) {
        // Don't leak an empty configWarnings field through to callers when
        // the merge was clean.
        config.configWarnings = undefined;
    }

    return config;
}
