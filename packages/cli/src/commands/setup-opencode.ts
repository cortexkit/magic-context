import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { detectConflicts } from "@magic-context/core/shared/conflict-detector";
import { fixConflicts } from "@magic-context/core/shared/conflict-fixer";
import { parse as parseJsonc, stringify as stringifyJsonc } from "comment-json";
import {
    buildModelSelection,
    getAvailableModels,
    getOpenCodeVersion,
    isOpenCodeInstalled,
} from "../lib/opencode-helpers";
import { detectConfigPaths } from "../lib/paths";
import { confirm, intro, log, note, outro, selectOne, spinner } from "../lib/prompts";

const PLUGIN_NAME = "@cortexkit/opencode-magic-context";
const PLUGIN_ENTRY = "@cortexkit/opencode-magic-context@latest";

// ─── Helpers ──────────────────────────────────────────────

function ensureDir(dir: string): void {
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
}

function readJsonc(path: string): Record<string, unknown> | null {
    const content = readFileSync(path, "utf-8");
    try {
        return parseJsonc(content) as Record<string, unknown>;
    } catch (err) {
        console.error(`  ⚠ Failed to parse ${path}: ${err instanceof Error ? err.message : err}`);
        return null;
    }
}
// ─── Config Manipulators ──────────────────────────────────

function addPluginToOpenCodeConfig(configPath: string, format: "json" | "jsonc" | "none"): void {
    ensureDir(dirname(configPath));

    if (format === "none") {
        const config = {
            plugin: [PLUGIN_ENTRY],
            compaction: { auto: false, prune: false },
        };
        writeFileSync(configPath, `${stringifyJsonc(config, null, 2)}\n`);
        return;
    }

    // Read existing config, merge our changes, preserve everything else
    const existing = readJsonc(configPath);
    if (!existing) {
        log.warn(`Could not parse ${configPath} — skipping to avoid data loss`);
        return;
    }

    // Add plugin if not present
    const plugins = (existing.plugin as string[]) ?? [];
    const hasPlugin = plugins.some((p) => p === PLUGIN_NAME || p.startsWith(`${PLUGIN_NAME}@`));
    if (!hasPlugin) {
        plugins.push(PLUGIN_ENTRY);
    }
    existing.plugin = plugins;

    // Set compaction fields without replacing other compaction settings
    const compaction = (existing.compaction as Record<string, unknown>) ?? {};
    compaction.auto = false;
    compaction.prune = false;
    existing.compaction = compaction;

    writeFileSync(configPath, `${stringifyJsonc(existing, null, 2)}\n`);
}

function addPluginToTuiConfig(configPath: string, format: "json" | "jsonc" | "none"): void {
    ensureDir(dirname(configPath));

    if (format === "none") {
        writeFileSync(configPath, `${stringifyJsonc({ plugin: [PLUGIN_ENTRY] }, null, 2)}\n`);
        return;
    }

    const existing = readJsonc(configPath);
    if (!existing) {
        log.warn(`Could not parse ${configPath} — skipping to avoid data loss`);
        return;
    }

    const plugins = (existing.plugin as string[]) ?? [];
    const hasPlugin = plugins.some((p) => p === PLUGIN_NAME || p.startsWith(`${PLUGIN_NAME}@`));
    if (!hasPlugin) {
        plugins.push(PLUGIN_ENTRY);
    }

    existing.plugin = plugins;
    writeFileSync(configPath, `${stringifyJsonc(existing, null, 2)}\n`);
}

function writeMagicContextConfig(
    configPath: string,
    options: {
        historianModel: string | null;
        dreamerEnabled: boolean;
        dreamerModel: string | null;
        sidekickEnabled: boolean;
        sidekickModel: string | null;
        claudeMax: boolean;
    },
): void {
    // Read existing config to preserve user's other settings
    const config: Record<string, unknown> =
        (existsSync(configPath) ? readJsonc(configPath) : null) ?? {};

    // Always set $schema for editor autocomplete/validation
    if (!config.$schema) {
        config.$schema =
            "https://raw.githubusercontent.com/cortexkit/magic-context/master/assets/magic-context.schema.json";
    }

    if (options.historianModel) {
        const historian = (config.historian as Record<string, unknown>) ?? {};
        historian.model = options.historianModel;
        config.historian = historian;
    }

    if (options.dreamerEnabled) {
        const dreamer = (config.dreamer as Record<string, unknown>) ?? {};
        dreamer.enabled = true;
        if (options.dreamerModel) {
            dreamer.model = options.dreamerModel;
        }
        config.dreamer = dreamer;
    } else {
        const dreamer = (config.dreamer as Record<string, unknown>) ?? {};
        dreamer.enabled = false;
        config.dreamer = dreamer;
    }

    if (options.sidekickEnabled) {
        const sidekick = (config.sidekick as Record<string, unknown>) ?? {};
        sidekick.enabled = true;
        if (options.sidekickModel) {
            sidekick.model = options.sidekickModel;
        }
        config.sidekick = sidekick;
    }

    if (options.claudeMax) {
        const cacheTtl = (config.cache_ttl as Record<string, string>) ?? {};
        if (!cacheTtl.default) cacheTtl.default = "5m";
        cacheTtl["anthropic/claude-sonnet-4-6"] = "59m";
        cacheTtl["anthropic/claude-opus-4-6"] = "59m";
        config.cache_ttl = cacheTtl;
    }

    writeFileSync(configPath, `${stringifyJsonc(config, null, 2)}\n`);
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
    const hadExistingSetup =
        paths.opencodeConfigFormat !== "none" ||
        existsSync(paths.magicContextConfig) ||
        paths.tuiConfigFormat !== "none";

    // ─── Step 4: Add plugin & disable compaction ────────
    addPluginToOpenCodeConfig(paths.opencodeConfig, paths.opencodeConfigFormat);
    log.success(`Plugin added to ${paths.opencodeConfig}`);
    log.info("Disabled built-in compaction (auto=false, prune=false)");
    log.message("Magic Context handles context management — built-in compaction would interfere");

    // ─── Step 4.5: Check for DCP plugin conflict ────────
    if (paths.opencodeConfigFormat !== "none") {
        const ocConfig = readJsonc(paths.opencodeConfig);
        if (ocConfig) {
            const plugins = (ocConfig.plugin as string[]) ?? [];
            const dcpIndex = plugins.findIndex((p) => p.startsWith("@tarquinen/opencode-dcp"));
            if (dcpIndex !== -1) {
                log.warn(`Found conflicting plugin: ${plugins[dcpIndex]}`);
                log.message(
                    "opencode-dcp (Dynamic Context Pruning) and Magic Context both manage context.\n" +
                        "Running both simultaneously will cause unpredictable behavior.",
                );
                const shouldRemove = await confirm("Remove opencode-dcp from your config?", true);
                if (shouldRemove) {
                    plugins.splice(dcpIndex, 1);
                    ocConfig.plugin = plugins;
                    writeFileSync(paths.opencodeConfig, `${stringifyJsonc(ocConfig, null, 2)}\n`);
                    log.success("Removed opencode-dcp from plugin list");
                } else {
                    log.warn("Skipped — you may experience context management conflicts");
                }
            }
        }
    }

    if (hadExistingSetup) {
        const conflicts = detectConflicts(process.cwd());
        if (conflicts.hasConflict) {
            log.warn("Found conflicting configuration that can disable Magic Context:");
            for (const reason of conflicts.reasons) {
                log.message(`  • ${reason}`);
            }

            const shouldFixConflicts = await confirm(
                "Apply automatic conflict fixes to your OpenCode and OMO config files?",
                true,
            );

            if (shouldFixConflicts) {
                const actions = fixConflicts(process.cwd(), conflicts.conflicts);
                if (actions.length > 0) {
                    for (const action of actions) {
                        log.success(action);
                    }
                } else {
                    log.info("No additional conflict changes were needed");
                }
            } else {
                log.warn("Skipped automatic conflict fixes — Magic Context may remain disabled");
            }
        }
    }

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

    // ─── Claude Max subscription ────────────────────────
    const hasAnthropic = allModels.some((m) => m.startsWith("anthropic/"));
    let claudeMax = false;
    if (hasAnthropic) {
        log.message(
            "Claude Max/Pro subscribers get extended prompt caching (up to 1 hour).\n" +
                "This lets Magic Context defer context operations much longer, saving money.",
        );
        claudeMax = await confirm("Do you have a Claude Max or Pro subscription?", false);
        if (claudeMax) {
            log.success("Cache TTL set to 59m for Anthropic models");
        }
    }

    // Write magic-context config
    writeMagicContextConfig(paths.magicContextConfig, {
        historianModel,
        dreamerEnabled,
        dreamerModel,
        sidekickEnabled,
        sidekickModel,
        claudeMax,
    });
    log.success(`Config written to ${paths.magicContextConfig}`);
    addPluginToTuiConfig(paths.tuiConfig, paths.tuiConfigFormat);
    log.success("TUI sidebar plugin added to tui.json");

    // ─── Step 8: Oh-My-OpenCode compatibility ───────────
    if (paths.omoConfig && !hadExistingSetup) {
        log.warn(`Found oh-my-opencode config: ${paths.omoConfig}`);
        log.message(
            "These hooks may conflict:\n" +
                "  • context-window-monitor\n" +
                "  • preemptive-compaction\n" +
                "  • anthropic-context-window-limit-recovery",
        );

        const shouldDisable = await confirm("Disable these hooks in oh-my-opencode?", true);
        if (shouldDisable) {
            const actions = fixConflicts(process.cwd(), {
                compactionAuto: false,
                compactionPrune: false,
                dcpPlugin: false,
                omoPreemptiveCompaction: true,
                omoContextWindowMonitor: true,
                omoAnthropicRecovery: true,
            });

            if (actions.includes("Disabled conflicting oh-my-opencode hooks")) {
                log.success("Hooks disabled in oh-my-opencode config");
            }
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

    // Ask user to star the repo
    const shouldStar = await confirm("★ Star the repo on GitHub?", true);
    if (shouldStar) {
        try {
            const { execSync } = await import("node:child_process");
            execSync("gh api --silent --method PUT /user/starred/cortexkit/magic-context", {
                stdio: "ignore",
                timeout: 10_000,
            });
            log.success("Thanks for starring! ★");
        } catch {
            log.info(
                "Couldn't star automatically. You can star manually:\n  https://github.com/cortexkit/magic-context",
            );
        }
    }

    outro("Run 'opencode' to start!");

    return 0;
}
