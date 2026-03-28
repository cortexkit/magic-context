import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { detectConfigPaths } from "./config-paths";
import {
    buildModelSelection,
    getAvailableModels,
    getOpenCodeVersion,
    isOpenCodeInstalled,
} from "./opencode-helpers";
import { confirm, intro, log, note, outro, selectOne, spinner } from "./prompts";

const PLUGIN_NAME = "@cortexkit/opencode-magic-context";

// ─── Helpers ──────────────────────────────────────────────

function ensureDir(dir: string): void {
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
}

function stripJsoncComments(text: string): string {
    return text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

function readJsonc(path: string): Record<string, unknown> {
    const content = readFileSync(path, "utf-8");
    try {
        return JSON.parse(stripJsoncComments(content));
    } catch {
        return {};
    }
}

function writeJsonc(path: string, data: Record<string, unknown>): void {
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

// ─── Config Manipulators ──────────────────────────────────

function addPluginToOpenCodeConfig(configPath: string, format: "json" | "jsonc" | "none"): void {
    ensureDir(dirname(configPath));

    if (format === "none") {
        const config = {
            plugin: [PLUGIN_NAME],
            compaction: { auto: false, prune: false },
        };
        writeJsonc(configPath, config);
        return;
    }

    const config = readJsonc(configPath);

    const plugins = (config.plugin as string[]) ?? [];
    const hasPlugin = plugins.some((p) => p === PLUGIN_NAME || p.startsWith(`${PLUGIN_NAME}@`));
    if (!hasPlugin) {
        plugins.push(PLUGIN_NAME);
        config.plugin = plugins;
    }

    const compaction = (config.compaction as Record<string, unknown>) ?? {};
    compaction.auto = false;
    compaction.prune = false;
    config.compaction = compaction;

    writeJsonc(configPath, config);
}

function writeMagicContextConfig(
    configPath: string,
    options: {
        historianModel: string | null;
        dreamerEnabled: boolean;
        dreamerModel: string | null;
        sidekickEnabled: boolean;
        sidekickModel: string | null;
    },
): void {
    const config: Record<string, unknown> = {};

    if (options.historianModel) {
        config.historian = { model: options.historianModel };
    }

    if (options.dreamerEnabled) {
        const dreamer: Record<string, unknown> = { enabled: true };
        if (options.dreamerModel) {
            dreamer.model = options.dreamerModel;
        }
        config.dreamer = dreamer;
    } else {
        config.dreamer = { enabled: false };
    }

    if (options.sidekickEnabled) {
        const sidekick: Record<string, unknown> = { enabled: true };
        if (options.sidekickModel) {
            sidekick.model = options.sidekickModel;
        }
        config.sidekick = sidekick;
    }

    writeJsonc(configPath, config);
}

function disableOmoHooks(omoConfigPath: string): void {
    const config = readJsonc(omoConfigPath);
    const disabledHooks = (config.disabled_hooks as string[]) ?? [];

    const hooksToDisable = [
        "context-window-monitor",
        "preemptive-compaction",
        "anthropic-context-window-limit-recovery",
    ];

    for (const hook of hooksToDisable) {
        if (!disabledHooks.includes(hook)) {
            disabledHooks.push(hook);
        }
    }

    config.disabled_hooks = disabledHooks;
    writeJsonc(omoConfigPath, config);
}

// ─── Main Setup Flow ──────────────────────────────────────

export async function runSetup(): Promise<number> {
    intro("Magic Context — Setup");

    // ─── Step 1: Check OpenCode ─────────────────────────
    const s = spinner();
    s.start("Checking OpenCode installation");

    const installed = isOpenCodeInstalled();
    if (!installed) {
        s.stop("OpenCode not found");
        const shouldContinue = await confirm(
            "OpenCode not found on PATH. Continue setup anyway?",
            false,
        );
        if (!shouldContinue) {
            log.info("Install OpenCode: https://opencode.ai");
            outro("Setup cancelled");
            return 1;
        }
    } else {
        const version = getOpenCodeVersion();
        s.stop(`OpenCode ${version ?? ""} detected`);
    }

    // ─── Step 2: Get available models ───────────────────
    s.start("Fetching available models");

    const allModels = installed ? getAvailableModels() : [];
    if (allModels.length > 0) {
        s.stop(`Found ${allModels.length} models`);
    } else {
        s.stop("No models found");
        log.warn("You can configure models manually in magic-context.jsonc later");
    }

    // ─── Step 3: Detect config paths ────────────────────
    const paths = detectConfigPaths();

    // ─── Step 4: Add plugin & disable compaction ────────
    addPluginToOpenCodeConfig(paths.opencodeConfig, paths.opencodeConfigFormat);
    log.success(`Plugin added to ${paths.opencodeConfig}`);
    log.info("Disabled built-in compaction (auto=false, prune=false)");
    log.message("Magic Context handles context management — built-in compaction would interfere");

    // ─── Step 5: Historian model ────────────────────────
    let historianModel: string | null = null;
    if (allModels.length > 0) {
        const historianOptions = buildModelSelection(allModels, "historian");
        if (historianOptions.length > 0) {
            historianModel = await selectOne(
                "Select a model for historian (background context compressor)",
                historianOptions,
            );
            log.success(`Historian: ${historianModel}`);
        } else {
            log.info("No suitable historian models found — using built-in fallback chain");
        }
    } else {
        log.info("Skipping model selection — using built-in fallback chain");
    }

    // ─── Step 6: Dreamer ────────────────────────────────
    log.message("The dreamer runs overnight to consolidate and maintain project memories.");
    const dreamerEnabled = await confirm("Enable dreamer?", true);
    let dreamerModel: string | null = null;

    if (dreamerEnabled && allModels.length > 0) {
        const dreamerOptions = buildModelSelection(allModels, "dreamer");
        if (dreamerOptions.length > 0) {
            dreamerModel = await selectOne(
                "Select a model for dreamer (runs in background, local LLMs ideal)",
                dreamerOptions,
            );
            log.success(`Dreamer: ${dreamerModel}`);
        } else {
            log.info("No suitable dreamer models — using built-in fallback chain");
        }
    } else if (dreamerEnabled) {
        log.info("Using built-in fallback chain for dreamer");
    }

    // ─── Step 7: Sidekick ───────────────────────────────
    log.message("Sidekick augments prompts with project context via /ctx-aug command.");
    const sidekickEnabled = await confirm("Enable sidekick?", false);
    let sidekickModel: string | null = null;

    if (sidekickEnabled && allModels.length > 0) {
        const sidekickOptions = buildModelSelection(allModels, "sidekick");
        if (sidekickOptions.length > 0) {
            sidekickModel = await selectOne(
                "Select a model for sidekick (fast models preferred)",
                sidekickOptions,
            );
            log.success(`Sidekick: ${sidekickModel}`);
        } else {
            log.info("No suitable sidekick models — using built-in fallback chain");
        }
    } else if (sidekickEnabled) {
        log.info("Using built-in fallback chain for sidekick");
    }

    // Write magic-context config
    writeMagicContextConfig(paths.magicContextConfig, {
        historianModel,
        dreamerEnabled,
        dreamerModel,
        sidekickEnabled,
        sidekickModel,
    });
    log.success(`Config written to ${paths.magicContextConfig}`);

    // ─── Step 8: Oh-My-OpenCode compatibility ───────────
    if (paths.omoConfig) {
        log.warn(`Found oh-my-opencode config: ${paths.omoConfig}`);
        log.message(
            "These hooks may conflict:\n" +
                "  • context-window-monitor\n" +
                "  • preemptive-compaction\n" +
                "  • anthropic-context-window-limit-recovery",
        );

        const shouldDisable = await confirm("Disable these hooks in oh-my-opencode?", true);
        if (shouldDisable) {
            disableOmoHooks(paths.omoConfig);
            log.success("Hooks disabled in oh-my-opencode config");
        } else {
            log.warn("Skipped — you may experience context management conflicts");
        }
    }

    // ─── Summary ────────────────────────────────────────
    const summary = [
        `Plugin: ${PLUGIN_NAME}`,
        "Compaction: disabled",
        historianModel ? `Historian: ${historianModel}` : "Historian: fallback chain",
        dreamerEnabled
            ? `Dreamer: enabled${dreamerModel ? ` (${dreamerModel})` : ""}`
            : "Dreamer: disabled",
        sidekickEnabled
            ? `Sidekick: enabled${sidekickModel ? ` (${sidekickModel})` : ""}`
            : "Sidekick: disabled",
    ].join("\n");

    note(summary, "Configuration");

    outro("Run 'opencode' to start!");

    return 0;
}
