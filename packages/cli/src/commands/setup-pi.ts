import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { piModelRefToCanonical } from "@magic-context/core/shared/harness-provider-map";
import { stringify as stringifyJsonc } from "comment-json";
import type { PluginEntryResult } from "../adapters/types";
import { writeFileAtomic } from "../lib/atomic-write";
import {
    hasUserConfigLocationMigrationRefusal,
    migrateConfigLocationsForCli,
} from "../lib/config-location-migration";
import { runDreamerSetup } from "../lib/dreamer-setup";
import { assertJsoncConfigsParseable, readJsoncConfigForUpdate } from "../lib/jsonc-config";
import { pickModel } from "../lib/model-picker";
import { getPiAgentConfigDir, getPiUserConfigPath, getPiUserExtensionsPath } from "../lib/paths";
import {
    detectPiBinary,
    getAvailableModels,
    getPiVersion,
    PI_PACKAGE_SOURCE,
} from "../lib/pi-helpers";
import { hasPiMagicContextPackage } from "../lib/pi-package-entry";
import type { PromptIO } from "../lib/prompts";

type EmbeddingChoice =
    | { provider: "local"; model: string }
    | {
          provider: "openai-compatible";
          endpoint: string;
          model: string;
          api_key?: string;
      };

export interface SetupEnvironment {
    detectPiBinary: () => { path: string } | null;
    getPiVersion: typeof getPiVersion;
    getAvailableModels: typeof getAvailableModels;
    paths: {
        getPiAgentConfigDir: typeof getPiAgentConfigDir;
        getPiUserConfigPath: typeof getPiUserConfigPath;
        getPiUserExtensionsPath: typeof getPiUserExtensionsPath;
    };
}

export type SetupRollback = () => Promise<void>;

export interface PiCompatibleSetupHost {
    displayName: string;
    cliName: string;
    packageSource: string;
    installCommand: string;
    minimumVersion?: string;
    versionWarning?: (version: string, minimum: string) => string;
    /** Convert this host's model selector to the shared canonical config form. */
    modelRefToCanonical?: (ref: string) => string;
    ensurePluginEntry: (settingsPath: string) => Promise<PluginEntryResult>;
    beforeWrite?: (options: {
        binaryPath: string;
        cwd: string;
        prompts: PromptIO;
        dryRun: boolean;
        configureHost: boolean;
    }) => Promise<SetupRollback | false>;
    rollbackPluginEntry?: (registration: PluginEntryResult) => Promise<void>;
}

export interface RunSetupOptions {
    prompts?: PromptIO;
    env?: SetupEnvironment;
    host?: PiCompatibleSetupHost;
    /**
     * When true, run the full interactive wizard (detection, model fetch,
     * type-ahead picker, all prompts) but write NO files and register NO
     * package — print what WOULD be written. Lets the flow be exercised end to
     * end without mutating the user's real Pi config.
     */
    dryRun?: boolean;
}

const DEFAULT_ENV: SetupEnvironment = {
    detectPiBinary,
    getPiVersion,
    getAvailableModels,
    paths: {
        getPiAgentConfigDir,
        getPiUserConfigPath,
        getPiUserExtensionsPath,
    },
};

const DEFAULT_HOST: PiCompatibleSetupHost = {
    displayName: "Pi",
    cliName: "pi",
    packageSource: PI_PACKAGE_SOURCE,
    installCommand: "pi install npm:@cortexkit/pi-magic-context",
    minimumVersion: "0.74.0",
    versionWarning: (version, minimum) =>
        `Pi ${version} is older than the required ${minimum}.\n` +
        `Pi 0.74.0 renamed the npm package from \`@mariozechner/pi-coding-agent\` ` +
        `to \`@earendil-works/pi-coding-agent\`. Magic Context's peer dependency ` +
        `targets the new scope, so older Pi installs cannot load this extension.\n` +
        `Run \`pi update --self\` (or \`npm install -g @earendil-works/pi-coding-agent@latest\`) before continuing.`,
    ensurePluginEntry: async (settingsPath) => {
        const settings = readJsoncConfigForUpdate(settingsPath);
        const packagesFieldExisted = Object.hasOwn(settings, "packages");
        try {
            const added = writePiSettingsPackage(settingsPath);
            return {
                ok: true,
                action: added ? "added" : "already_present",
                message: added
                    ? `Added ${PI_PACKAGE_SOURCE} to ${settingsPath}`
                    : `Magic Context package already present in ${settingsPath}`,
                configPath: settingsPath,
                packagesFieldExisted,
            };
        } catch (error) {
            return {
                ok: false,
                action: "error",
                message: error instanceof Error ? error.message : String(error),
                configPath: settingsPath,
            };
        }
    },
    rollbackPluginEntry: async (registration) => {
        if (registration.action === "added") {
            removePiSettingsPackage(
                registration.configPath,
                PI_PACKAGE_SOURCE,
                (registration as PluginEntryResult & { packagesFieldExisted?: boolean })
                    .packagesFieldExisted === false,
            );
        }
    },
};

function ensureDir(path: string): void {
    if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

async function getDefaultPrompts(): Promise<PromptIO> {
    const { promptIO } = await import("../lib/prompts");
    return promptIO;
}

function compactObject<T extends Record<string, unknown>>(obj: T): T {
    for (const key of Object.keys(obj)) {
        if (obj[key] === undefined) delete obj[key];
    }
    return obj;
}

/**
 * Compare two semver-ish strings (X.Y.Z, ignores any pre-release or build
 * suffix). Returns -1 if `a < b`, 0 if equal, 1 if `a > b`. Returns 0 when
 * either string can't be parsed (we conservatively assume "good enough" so
 * a parse failure doesn't block the user with a phantom upgrade prompt).
 */
function comparePiVersion(a: string, b: string): number {
    const parse = (v: string): [number, number, number] | null => {
        const match = v.match(/(\d+)\.(\d+)\.(\d+)/);
        return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
    };
    const left = parse(a);
    const right = parse(b);
    if (!left || !right) return 0;
    for (let i = 0; i < 3; i += 1) {
        if (left[i] < right[i]) return -1;
        if (left[i] > right[i]) return 1;
    }
    return 0;
}

export function writePiSettingsPackage(
    settingsPath: string,
    packageSource = PI_PACKAGE_SOURCE,
): boolean {
    const settings = readJsoncConfigForUpdate(settingsPath);
    ensureDir(dirname(settingsPath));
    if (settings.packages !== undefined && !Array.isArray(settings.packages)) {
        // Overwriting a non-array value would silently discard whatever the user
        // put there; refuse instead so setup never destroys host configuration.
        throw new Error(
            `Refusing to rewrite ${settingsPath}: "packages" is ${typeof settings.packages}, expected an array. Fix it by hand, then rerun setup.`,
        );
    }
    const packages = Array.isArray(settings.packages) ? settings.packages : [];

    const hasPackage = hasPiMagicContextPackage(packages);

    if (!hasPackage) packages.push(packageSource);
    settings.packages = packages;
    writeFileAtomic(settingsPath, `${stringifyJsonc(settings, null, 2)}\n`);
    return !hasPackage;
}
export function removePiSettingsPackage(
    settingsPath: string,
    packageSource = PI_PACKAGE_SOURCE,
    removeFieldWhenEmpty = false,
): boolean {
    const settings = readJsoncConfigForUpdate(settingsPath);
    if (!Array.isArray(settings.packages)) return false;
    const packages = settings.packages;
    const filtered = packages.filter((entry) => entry !== packageSource);
    if (filtered.length === packages.length) return false;
    if (removeFieldWhenEmpty && filtered.length === 0) delete settings.packages;
    else settings.packages = filtered;
    writeFileAtomic(settingsPath, `${stringifyJsonc(settings, null, 2)}\n`);
    return true;
}

export function writeMagicContextConfig(
    configPath: string,
    options: {
        historianModel: string;
        historianThinkingLevel?: string;
        dreamerEnabled: boolean;
        dreamerModel?: string;
        /** Per-task schedule overrides (Dreamer v2); undefined keeps schema defaults. */
        dreamerTasks?: Record<string, { schedule: string }>;
        sidekickEnabled: boolean;
        sidekickModel?: string;
        embedding: EmbeddingChoice;
        modelRefToCanonical?: (ref: string) => string;
    },
): void {
    const config = readJsoncConfigForUpdate(configPath);
    ensureDir(dirname(configPath));

    if (!config.$schema) {
        config.$schema =
            "https://raw.githubusercontent.com/cortexkit/magic-context/master/assets/magic-context.schema.json";
    }

    // Model pickers return harness-native provider IDs. Persist only canonical
    // OpenCode-form IDs so every harness reads the same shared config.
    const toCanonical = options.modelRefToCanonical ?? piModelRefToCanonical;
    config.historian = compactObject({
        ...((config.historian as Record<string, unknown> | undefined) ?? {}),
        model: toCanonical(options.historianModel),
        thinking_level: options.historianThinkingLevel,
    });
    const dreamer = {
        ...((config.dreamer as Record<string, unknown> | undefined) ?? {}),
        model: options.dreamerModel ? toCanonical(options.dreamerModel) : undefined,
        disable: options.dreamerEnabled ? undefined : true,
        enabled: undefined,
        // Dreamer v2 per-task schedules — only set when the user declined the
        // recommended defaults; otherwise leave unset so schema defaults apply.
        tasks: options.dreamerEnabled ? options.dreamerTasks : undefined,
    };
    config.dreamer = compactObject(dreamer);

    const sidekick = {
        ...((config.sidekick as Record<string, unknown> | undefined) ?? {}),
        model:
            options.sidekickEnabled && options.sidekickModel
                ? toCanonical(options.sidekickModel)
                : undefined,
        disable: options.sidekickEnabled ? undefined : true,
        enabled: undefined,
    };
    config.sidekick = compactObject(sidekick);

    config.embedding = {
        ...((config.embedding as Record<string, unknown> | undefined) ?? {}),
        ...options.embedding,
    };
    writeFileAtomic(configPath, `${stringifyJsonc(config, null, 2)}\n`);
}

async function chooseEmbedding(prompts: PromptIO): Promise<EmbeddingChoice> {
    const provider = await prompts.selectOne("Select embedding provider", [
        {
            label: "Local embeddings — no API key required",
            value: "local",
            recommended: true,
        },
        { label: "OpenAI-compatible endpoint", value: "openai-compatible" },
    ]);

    if (provider === "local") {
        return { provider: "local", model: "Xenova/all-MiniLM-L6-v2" };
    }

    const endpoint = await prompts.text("Embedding endpoint URL", {
        placeholder: "https://api.openai.com/v1",
        validate: (value) => (value.trim().length === 0 ? "Endpoint is required" : undefined),
    });
    const model = await prompts.text("Embedding model", {
        initialValue: "text-embedding-3-small",
        validate: (value) => (value.trim().length === 0 ? "Model is required" : undefined),
    });
    const apiKey = await prompts.text("Embedding API key (optional; leave blank to use env)", {
        placeholder: "optional",
    });

    return compactObject({
        provider: "openai-compatible" as const,
        endpoint: endpoint.trim(),
        model: model.trim(),
        api_key: apiKey.trim() || undefined,
    });
}

export async function runSetup(options: RunSetupOptions = {}): Promise<number> {
    const prompts = options.prompts ?? (await getDefaultPrompts());
    const env = options.env ?? DEFAULT_ENV;
    const host = options.host ?? DEFAULT_HOST;
    const dryRun = options.dryRun === true;

    prompts.intro(`Magic Context for ${host.displayName} — Setup`);
    if (dryRun) {
        prompts.log.warn("Dry run — no files will be written and no package will be registered.");
        prompts.log.message(
            "[dry-run] would migrate legacy Magic Context config before setup reads or writes the shared CortexKit config.",
        );
    } else {
        const migrationWarnings = migrateConfigLocationsForCli(process.cwd(), prompts.log);
        if (hasUserConfigLocationMigrationRefusal(migrationWarnings)) {
            prompts.outro(
                "Setup stopped — resolve the legacy Magic Context user config migration conflict, then rerun setup.",
            );
            return 1;
        }
    }

    const spinner = prompts.spinner();
    spinner.start(`Checking ${host.displayName} installation`);
    const binary = env.detectPiBinary();
    if (!binary) {
        spinner.stop(`${host.displayName} not found`);
        prompts.log.warn(
            `Could not find \`${host.cliName}\` on PATH or in standard user install directories.`,
        );
        prompts.log.message(`Install ${host.displayName} first, then rerun setup.`);
        prompts.outro(`Setup stopped — install ${host.displayName} and try again`);
        return 1;
    }

    const version = env.getPiVersion(binary.path);
    spinner.stop(
        version
            ? `${host.displayName} ${version} detected at ${binary.path}`
            : `${host.displayName} detected at ${binary.path}`,
    );

    if (version && host.minimumVersion && comparePiVersion(version, host.minimumVersion) < 0) {
        prompts.log.warn(
            host.versionWarning?.(version, host.minimumVersion) ??
                `${host.displayName} ${version} is older than required ${host.minimumVersion}.`,
        );
        const proceed = await prompts.confirm(
            "Continue with setup anyway? (subagents may fail at runtime)",
            false,
        );
        if (!proceed) {
            prompts.outro(`Setup cancelled — upgrade ${host.displayName} and try again.`);
            return 0;
        }
    }

    spinner.start(`Fetching available ${host.displayName} models`);
    const allModels = env.getAvailableModels(binary.path);
    spinner.stop(`Found ${allModels.length} model choices`);

    const settingsPath = env.paths.getPiUserExtensionsPath();
    const configPath = env.paths.getPiUserConfigPath();
    if (!dryRun) {
        try {
            // Validate every target before the wizard performs its first write.
            assertJsoncConfigsParseable([settingsPath, configPath]);
        } catch (error) {
            prompts.log.error(error instanceof Error ? error.message : String(error));
            prompts.outro("Setup stopped — fix the malformed config and rerun setup.");
            return 1;
        }
    }
    const configureHost = await prompts.confirm(
        `Configure ${host.displayName} to load Magic Context?`,
        true,
    );
    if (configureHost && dryRun) {
        prompts.log.message(
            `[dry-run] would register ${host.packageSource} for ${host.displayName} in ${settingsPath}`,
        );
    } else if (!configureHost) {
        prompts.log.warn(
            `Skipped ${host.displayName} package registration; install manually with \`${host.installCommand}\`.`,
        );
    }

    const historianModel = await pickModel(prompts, allModels, "historian");

    // GitHub Copilot reasoning models need an explicit thinking_level because
    // the Copilot API injects "minimal" as a default and then rejects it (400).
    let historianThinkingLevel: string | undefined;
    if (historianModel.startsWith("github-copilot/")) {
        prompts.log.warn(
            `GitHub Copilot reasoning models require an explicit thinking level.\n` +
                `Without it, Copilot injects "minimal" as a default — which it then rejects with a 400 error.`,
        );
        historianThinkingLevel = await prompts.selectOne("Select thinking level for historian", [
            {
                label: "medium — good quality, moderate cost (Recommended)",
                value: "medium",
                recommended: true,
            },
            { label: "low — faster, less thorough", value: "low" },
            { label: "high — best quality, slowest", value: "high" },
            {
                label: "off — no thinking, fastest (not recommended for historian)",
                value: "off",
            },
        ]);
    }

    const dreamerEnabled = await prompts.confirm(
        "Enable dreamer for overnight memory maintenance?",
        true,
    );
    // Only run the dreamer flow when enabled — asking after the user declined
    // (the prior behavior) was the #144 "still wanted a model after I said no"
    // complaint.
    let dreamerModel: string | undefined;
    let dreamerTasks: Record<string, { schedule: string }> | undefined;
    if (dreamerEnabled) {
        const result = await runDreamerSetup(prompts, allModels);
        dreamerModel = result.model;
        dreamerTasks = result.tasks;
    }
    const sidekickEnabled = await prompts.confirm("Enable sidekick for /ctx-aug?", false);
    const sidekickModel = sidekickEnabled
        ? await pickModel(prompts, allModels, "sidekick")
        : undefined;
    const embedding = await chooseEmbedding(prompts);

    const rollbackHost =
        (await host.beforeWrite?.({
            binaryPath: binary.path,
            cwd: process.cwd(),
            prompts,
            dryRun,
            configureHost,
        })) ?? (async () => {});
    if (rollbackHost === false) {
        prompts.outro(`Setup stopped — could not configure ${host.displayName}.`);
        return 1;
    }

    let registration: PluginEntryResult | undefined;
    try {
        if (dryRun) {
            prompts.log.message(`[dry-run] would write Magic Context config to ${configPath}`);
        } else {
            if (configureHost) {
                registration = await host.ensurePluginEntry(settingsPath);
                if (!registration.ok) throw new Error(registration.message);
                prompts.log.success(registration.message);
            }
            writeMagicContextConfig(configPath, {
                historianModel,
                historianThinkingLevel,
                dreamerEnabled,
                dreamerModel,
                dreamerTasks,
                sidekickEnabled,
                sidekickModel,
                embedding,
                modelRefToCanonical: host.modelRefToCanonical,
            });
            prompts.log.success(`Config written to ${configPath}`);
        }
    } catch (error) {
        if (registration?.ok && host.rollbackPluginEntry) {
            await host.rollbackPluginEntry(registration);
        }
        await rollbackHost();
        prompts.log.error(error instanceof Error ? error.message : String(error));
        prompts.outro(`Setup stopped — rolled back ${host.displayName} changes.`);
        return 1;
    }

    const thinkingLevelSuffix = historianThinkingLevel
        ? ` (thinking: ${historianThinkingLevel})`
        : "";
    const summary = [
        `${host.displayName} plugin: ${configureHost ? settingsPath : "skipped"}`,
        `Magic Context config: ${configPath}`,
        `Historian: ${historianModel}${thinkingLevelSuffix}`,
        `Dreamer: ${dreamerEnabled ? dreamerModel : "disabled"}`,
        sidekickEnabled ? `Sidekick: ${sidekickModel}` : "Sidekick: disabled",
        `Embedding: ${embedding.provider}${"model" in embedding ? ` (${embedding.model})` : ""}`,
    ].join("\n");

    prompts.note(summary, dryRun ? "Configuration (dry run — not written)" : "Configuration");
    prompts.outro(
        dryRun
            ? "Dry run complete — nothing was written."
            : `Start a ${host.displayName} session and try /ctx-aug`,
    );
    return 0;
}
