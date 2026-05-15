import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { parse as parseJsonc, stringify as stringifyJsonc } from "comment-json";
import { getPiAgentConfigDir, getPiUserConfigPath, getPiUserExtensionsPath } from "../lib/paths";
import {
    buildModelSelection,
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
    detectPiBinary: typeof detectPiBinary;
    getPiVersion: typeof getPiVersion;
    getAvailableModels: typeof getAvailableModels;
    paths: {
        getPiAgentConfigDir: typeof getPiAgentConfigDir;
        getPiUserConfigPath: typeof getPiUserConfigPath;
        getPiUserExtensionsPath: typeof getPiUserExtensionsPath;
    };
}

export interface RunSetupOptions {
    prompts?: PromptIO;
    env?: SetupEnvironment;
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

function ensureDir(path: string): void {
    if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

async function getDefaultPrompts(): Promise<PromptIO> {
    const { promptIO } = await import("../lib/prompts");
    return promptIO;
}

function readJsonc(path: string): Record<string, unknown> | null {
    try {
        return parseJsonc(readFileSync(path, "utf-8")) as Record<string, unknown>;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Could not parse ${path}: ${message}`);
        return null;
    }
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
    ensureDir(dirname(settingsPath));

    const settings: Record<string, unknown> = existsSync(settingsPath)
        ? (readJsonc(settingsPath) ?? {})
        : {};
    const packages = Array.isArray(settings.packages) ? settings.packages : [];

    const hasPackage = hasPiMagicContextPackage(packages);

    if (!hasPackage) packages.push(packageSource);
    settings.packages = packages;
    writeFileSync(settingsPath, `${stringifyJsonc(settings, null, 2)}\n`);
    return !hasPackage;
}

export function writeMagicContextConfig(
    configPath: string,
    options: {
        historianModel: string;
        historianThinkingLevel?: string;
        dreamerEnabled: boolean;
        dreamerModel: string;
        sidekickEnabled: boolean;
        sidekickModel?: string;
        embedding: EmbeddingChoice;
    },
): void {
    ensureDir(dirname(configPath));
    const config: Record<string, unknown> = existsSync(configPath)
        ? (readJsonc(configPath) ?? {})
        : {};

    if (!config.$schema) {
        config.$schema =
            "https://raw.githubusercontent.com/cortexkit/magic-context/master/assets/magic-context.schema.json";
    }

    config.historian = compactObject({
        ...((config.historian as Record<string, unknown> | undefined) ?? {}),
        model: options.historianModel,
        thinking_level: options.historianThinkingLevel,
    });
    config.dreamer = {
        ...((config.dreamer as Record<string, unknown> | undefined) ?? {}),
        enabled: options.dreamerEnabled,
        model: options.dreamerModel,
    };

    if (options.sidekickEnabled) {
        config.sidekick = compactObject({
            ...((config.sidekick as Record<string, unknown> | undefined) ?? {}),
            enabled: true,
            model: options.sidekickModel,
        });
    } else {
        config.sidekick = {
            ...((config.sidekick as Record<string, unknown> | undefined) ?? {}),
            enabled: false,
        };
    }

    config.embedding = options.embedding;
    writeFileSync(configPath, `${stringifyJsonc(config, null, 2)}\n`);
}

async function chooseModel(
    prompts: PromptIO,
    allModels: string[],
    role: "historian" | "dreamer" | "sidekick",
    message: string,
): Promise<string> {
    const options = buildModelSelection(allModels, role);
    return prompts.selectOne(message, options);
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

    prompts.intro("Magic Context for Pi — Setup");

    const spinner = prompts.spinner();
    spinner.start("Checking Pi installation");
    const pi = env.detectPiBinary();
    if (!pi) {
        spinner.stop("Pi not found");
        prompts.log.warn("Could not find `pi` on PATH or at ~/.pi/bin/pi.");
        prompts.log.message(
            "Install Pi first, then rerun setup. If Pi is installed in a custom location, add it to PATH.",
        );
        prompts.outro("Setup skipped");
        return 0;
    }

    const version = env.getPiVersion(pi.path);
    spinner.stop(version ? `Pi ${version} detected at ${pi.path}` : `Pi detected at ${pi.path}`);

    // Pi 0.74.0 moved to the `@earendil-works/pi-coding-agent` package scope.
    // Magic Context's peerDependency targets that scope, so older Pi versions
    // (on `@mariozechner/pi-coding-agent`) cannot load this extension.
    const MIN_PI_VERSION = "0.74.0";
    if (version && comparePiVersion(version, MIN_PI_VERSION) < 0) {
        prompts.log.warn(
            `Pi ${version} is older than the required ${MIN_PI_VERSION}.\n` +
                `Pi 0.74.0 renamed the npm package from \`@mariozechner/pi-coding-agent\` ` +
                `to \`@earendil-works/pi-coding-agent\`. Magic Context's peer dependency ` +
                `targets the new scope, so older Pi installs cannot load this extension.\n` +
                `Run \`pi update --self\` (or \`npm install -g @earendil-works/pi-coding-agent@latest\`) before continuing.`,
        );
        const proceed = await prompts.confirm(
            "Continue with setup anyway? (subagents will fail at runtime)",
            false,
        );
        if (!proceed) {
            prompts.outro("Setup cancelled — upgrade Pi and try again.");
            return 0;
        }
    }

    spinner.start("Fetching available Pi models");
    const allModels = env.getAvailableModels(pi.path);
    spinner.stop(`Found ${allModels.length} model choices`);

    const settingsPath = env.paths.getPiUserExtensionsPath();
    const configPath = env.paths.getPiUserConfigPath();
    const configurePi = await prompts.confirm("Configure Pi to load Magic Context?", true);
    let packageAdded = false;
    if (configurePi) {
        packageAdded = writePiSettingsPackage(settingsPath);
        prompts.log.success(
            packageAdded
                ? `Added ${PI_PACKAGE_SOURCE} to ${settingsPath}`
                : `Magic Context package already present in ${settingsPath}`,
        );
        prompts.log.message(
            "This mirrors `pi install npm:@cortexkit/pi-magic-context` without running installs during setup verification.",
        );
    } else {
        prompts.log.warn(
            "Skipped Pi package registration; install manually with `pi install npm:@cortexkit/pi-magic-context`.",
        );
    }

    const historianModel = await chooseModel(
        prompts,
        allModels,
        "historian",
        "Select a model for historian (background context compressor)",
    );

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
    const dreamerModel = await chooseModel(
        prompts,
        allModels,
        "dreamer",
        "Select a model for dreamer (overnight memory maintenance)",
    );
    const sidekickEnabled = await prompts.confirm("Enable sidekick for /ctx-aug?", false);
    const sidekickModel = sidekickEnabled
        ? await chooseModel(
              prompts,
              allModels,
              "sidekick",
              "Select a model for sidekick (fast models preferred)",
          )
        : undefined;
    const embedding = await chooseEmbedding(prompts);

    writeMagicContextConfig(configPath, {
        historianModel,
        historianThinkingLevel,
        dreamerEnabled,
        dreamerModel,
        sidekickEnabled,
        sidekickModel,
        embedding,
    });
    prompts.log.success(`Config written to ${configPath}`);

    const thinkingLevelSuffix = historianThinkingLevel
        ? ` (thinking: ${historianThinkingLevel})`
        : "";
    const summary = [
        `Pi settings: ${configurePi ? settingsPath : "skipped"}`,
        `Magic Context config: ${configPath}`,
        `Historian: ${historianModel}${thinkingLevelSuffix}`,
        `Dreamer: ${dreamerModel} (${dreamerEnabled ? "enabled" : "disabled"})`,
        sidekickEnabled ? `Sidekick: ${sidekickModel}` : "Sidekick: disabled",
        `Embedding: ${embedding.provider}${"model" in embedding ? ` (${embedding.model})` : ""}`,
    ].join("\n");

    prompts.note(summary, "Configuration");
    prompts.outro("Start a Pi session and try /ctx-aug");
    return 0;
}
