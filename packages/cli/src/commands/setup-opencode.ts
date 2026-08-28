import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { loadPluginConfig } from "@magic-context/core/config";
import { isCompactionEnabled } from "@magic-context/core/config/agent-disable";
import { loadRawConfigFile } from "@magic-context/core/config/raw-loader";
import { detectConflicts } from "@magic-context/core/shared/conflict-detector";
import { fixConflicts } from "@magic-context/core/shared/conflict-fixer";
import {
    appendJsoncArrayValues,
    removeJsoncArrayEntries,
    setJsoncValue,
} from "@magic-context/core/shared/jsonc-edit";
import { sanitizeParsedJson } from "@magic-context/core/shared/jsonc-parser";
import { parse as parseJsonc, stringify as stringifyJsonc } from "comment-json";

import {
    isDevPathPluginEntry,
    isLocalPathPluginEntry,
    matchesPluginEntry,
} from "../adapters/opencode";
import { writeFileAtomic } from "../lib/atomic-write";
import {
    hasUserConfigLocationMigrationRefusal,
    migrateConfigLocationsForCli,
} from "../lib/config-location-migration";
import { runDreamerSetup } from "../lib/dreamer-setup";
import {
    assertJsoncConfigsParseable,
    ConfigParseError,
    readJsoncConfigForUpdate,
} from "../lib/jsonc-config";
import { pickModel } from "../lib/model-picker";
import { detectOpenCode } from "../lib/opencode-detect";
import { getAvailableModels, getOpenCodeVersion } from "../lib/opencode-helpers";
import {
    OPENCODE_PLUGIN_ENTRY_WITH_VERSION as PLUGIN_ENTRY,
    OPENCODE_PLUGIN_NAME as PLUGIN_NAME,
} from "../lib/opencode-plugin-cache";
import { detectConfigPaths } from "../lib/paths";
import { confirm, intro, log, note, outro, promptIO, spinner } from "../lib/prompts";

const DCP_PLUGIN_NAME = "@tarquinen/opencode-dcp";

/**
 * Resolve the MC compaction mode for CLI writers (setup/doctor/fixer) using
 * the SAME loader the plugin uses and the SAME accessor. On load failure the
 * writer takes the preserve-existing-native-fields branch: it returns `false`
 * so the writer/fixer skip any native compaction write/flip (never assuming
 * either mode) and emits a diagnostic. This is distinct from the boot/TUI
 * path, which fails toward mode-on when it cannot supply the resolved value.
 */
function resolveCompactionEnabledForWriter(): boolean {
    try {
        const config = loadPluginConfig(process.cwd());
        return isCompactionEnabled(config);
    } catch (error) {
        log.warn(
            `Could not load Magic Context config to resolve compaction mode; ` +
                `preserving existing native compaction fields. ` +
                `(${error instanceof Error ? error.message : String(error)})`,
        );
        return false;
    }
}

// Mirrors the server/TUI coexistence check in packages/plugin/src/index.ts
// and tui/index.tsx: a user who set conflicts.allow_dcp=true has explicitly
// opted into running DCP alongside Magic Context (compaction-off mode), so
// setup must not silently offer to strip it back out.
function isDcpCoexistenceAllowed(): boolean {
    try {
        return loadPluginConfig(process.cwd()).conflicts?.allow_dcp === true;
    } catch {
        return false;
    }
}

// ─── Helpers ──────────────────────────────────────────────

function ensureDir(dir: string): void {
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
}

function configObject(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? { ...(value as Record<string, unknown>) }
        : {};
}

/**
 * Read the shared config through the same raw-tier loader as runtime and doctor.
 * That loader performs any required per-harness migration before setup merges its
 * choices, so setup cannot reintroduce flat model fields into an existing config.
 */
function readMagicContextConfigForSetup(configPath: string): Record<string, unknown> {
    const raw = loadRawConfigFile({ configPath, tier: "user" });
    if (!raw) return {};

    try {
        const rejectedKeyPaths: string[] = [];
        const parsed = sanitizeParsedJson(parseJsonc(raw.text), {
            onRejectedKey: (keyPath) => rejectedKeyPaths.push(keyPath.join(".")),
        });
        if (rejectedKeyPaths.length > 0) {
            throw new Error(`unsafe prototype-pollution key at ${rejectedKeyPaths.join(", ")}`);
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("expected a JSON object at the document root");
        }
        return parsed as Record<string, unknown>;
    } catch (error) {
        throw new ConfigParseError(configPath, raw.text, error);
    }
}

// ─── Config Manipulators ──────────────────────────────────

export function addPluginToOpenCodeConfig(
    configPath: string,
    _format: "json" | "jsonc" | "none",
    removeDcp = false,
    /**
     * The resolved MC compaction mode. When `false` (compaction-off mode), the
     * writer MUST NOT write `compaction.auto=false` / `compaction.prune=false`
     * into opencode.jsonc — native compaction (or nothing) is the user's chosen
     * window manager, so pre-existing native compaction fields are left
     * byte-for-byte as found. Default `true` (mode-on) preserves today's write
     * behavior for call sites that cannot supply the resolved mode.
     */
    compactionEnabled = true,
): void {
    // The detection result predates interactive prompts. Re-read at commit time so
    // a config created while the wizard was open is merged instead of overwritten.
    const existsAtCommit = existsSync(configPath);
    const existing = existsAtCommit ? readJsoncConfigForUpdate(configPath) : {};
    if (!existsAtCommit) {
        ensureDir(dirname(configPath));
        const created: Record<string, unknown> = { plugin: [PLUGIN_ENTRY] };
        if (compactionEnabled) {
            created.compaction = { auto: false, prune: false };
        }
        writeFileAtomic(configPath, `${stringifyJsonc(created, null, 2)}\n`);
        return;
    }

    let text = readFileSync(configPath, "utf-8");
    let changed = false;
    const rawPlugins: unknown[] = Array.isArray(existing.plugin) ? existing.plugin : [];
    const retainedPlugins = removeDcp
        ? rawPlugins.filter((plugin) => !matchesPluginEntry(plugin, DCP_PLUGIN_NAME))
        : rawPlugins;

    if (
        retainedPlugins.some(
            (plugin) =>
                isLocalPathPluginEntry(plugin) &&
                String(plugin).includes("magic-context") &&
                !isDevPathPluginEntry(plugin),
        )
    ) {
        log.warn(
            "An unverifiable local OpenCode plugin path was ignored; its package name is not Magic Context.",
        );
    }

    if (Array.isArray(existing.plugin)) {
        if (removeDcp) {
            const result = removeJsoncArrayEntries(text, ["plugin"], (plugin) =>
                matchesPluginEntry(plugin, DCP_PLUGIN_NAME),
            );
            if (result.removed) {
                text = result.text;
                changed = true;
            }
        }

        const hasNpmEntry = retainedPlugins.some((plugin) =>
            matchesPluginEntry(plugin, PLUGIN_NAME),
        );
        const hasDevEntry = retainedPlugins.some((plugin) => isDevPathPluginEntry(plugin));
        if (!hasNpmEntry && !hasDevEntry) {
            text = appendJsoncArrayValues(text, ["plugin"], [PLUGIN_ENTRY]);
            changed = true;
        }
    } else {
        text = setJsoncValue(text, ["plugin"], [PLUGIN_ENTRY]);
        changed = true;
    }

    // In compaction-off mode native fields are never changed. In mode-on, update
    // existing booleans in place so comments and the rest of the file stay intact.
    if (compactionEnabled) {
        const compaction = existing.compaction;
        const hasCompactionObject =
            typeof compaction === "object" && compaction !== null && !Array.isArray(compaction);
        if (!hasCompactionObject) {
            text = setJsoncValue(text, ["compaction"], { auto: false, prune: false });
            changed = true;
        } else {
            const fields = compaction as Record<string, unknown>;
            if (fields.auto !== false) {
                text = setJsoncValue(text, ["compaction", "auto"], false);
                changed = true;
            }
            if (fields.prune !== false) {
                text = setJsoncValue(text, ["compaction", "prune"], false);
                changed = true;
            }
        }
    }

    if (changed) writeFileAtomic(configPath, text);
}

export function addPluginToTuiConfig(configPath: string, _format: "json" | "jsonc" | "none"): void {
    // Config discovery may be stale after prompts; merge the commit-time contents.
    const existsAtCommit = existsSync(configPath);
    const existing = existsAtCommit ? readJsoncConfigForUpdate(configPath) : {};
    if (!existsAtCommit) {
        ensureDir(dirname(configPath));
        writeFileAtomic(configPath, `${stringifyJsonc({ plugin: [PLUGIN_ENTRY] }, null, 2)}\n`);
        return;
    }

    const rawPlugins: unknown[] = Array.isArray(existing.plugin) ? existing.plugin : [];
    if (
        rawPlugins.some(
            (plugin) =>
                isLocalPathPluginEntry(plugin) &&
                String(plugin).includes("magic-context") &&
                !isDevPathPluginEntry(plugin),
        )
    ) {
        log.warn(
            "An unverifiable local TUI plugin path was ignored; its package name is not Magic Context.",
        );
    }

    const hasNpmEntry = rawPlugins.some((plugin) => matchesPluginEntry(plugin, PLUGIN_NAME));
    const hasDevEntry = rawPlugins.some((plugin) => isDevPathPluginEntry(plugin));
    if (hasNpmEntry || hasDevEntry) return;

    const text = Array.isArray(existing.plugin)
        ? appendJsoncArrayValues(readFileSync(configPath, "utf-8"), ["plugin"], [PLUGIN_ENTRY])
        : setJsoncValue(readFileSync(configPath, "utf-8"), ["plugin"], [PLUGIN_ENTRY]);
    writeFileAtomic(configPath, text);
}

export function findDcpPluginIndexes(plugins: unknown[]): number[] {
    return plugins
        .map((plugin, index) => (matchesPluginEntry(plugin, DCP_PLUGIN_NAME) ? index : -1))
        .filter((index) => index >= 0);
}

function pluginEntryName(entry: unknown): string {
    if (typeof entry === "string") return entry;
    if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0];
    return String(entry);
}

async function resolveDcpConflictBeforeSetup(
    configPath: string,
    format: "json" | "jsonc" | "none",
): Promise<boolean> {
    if (format === "none") return false;
    const ocConfig = readJsoncConfigForUpdate(configPath);
    const plugins = Array.isArray(ocConfig.plugin) ? ocConfig.plugin : [];
    const dcpIndexes = findDcpPluginIndexes(plugins);
    if (dcpIndexes.length === 0) return false;

    if (isDcpCoexistenceAllowed()) {
        log.info(
            "opencode-dcp detected but conflicts.allow_dcp=true — keeping it (DCP-coexistence mode)",
        );
        return false;
    }

    log.warn(`Found conflicting plugin: ${pluginEntryName(plugins[dcpIndexes[0]])}`);
    log.message(
        "opencode-dcp (Dynamic Context Pruning) and Magic Context both manage context.\n" +
            "Running both simultaneously will cause unpredictable behavior.",
    );
    const shouldRemove = await confirm("Remove opencode-dcp from your config?", true);
    if (!shouldRemove) {
        log.warn("Skipped — you may experience context management conflicts");
    }
    return shouldRemove;
}

export function writeMagicContextConfig(
    configPath: string,
    options: {
        historianModel: string | null;
        dreamerEnabled: boolean;
        dreamerModel: string | null;
        /** Per-task schedule overrides (Dreamer v2); undefined keeps schema defaults. */
        dreamerTasks?: Record<string, { schedule: string }>;
        sidekickEnabled: boolean;
        sidekickModel: string | null;
        claudeMax: boolean;
    },
): void {
    // A malformed existing file must abort rather than become an empty config.
    const config = readMagicContextConfigForSetup(configPath);

    // Always set $schema for editor autocomplete/validation
    if (!config.$schema) {
        config.$schema =
            "https://raw.githubusercontent.com/cortexkit/magic-context/master/assets/magic-context.schema.json";
    }

    if (options.historianModel) {
        const historian = configObject(config.historian);
        const opencode = configObject(historian.opencode);
        opencode.model = options.historianModel;
        historian.opencode = opencode;
        config.historian = historian;
    }

    const dreamer = configObject(config.dreamer);
    const opencode = configObject(dreamer.opencode);
    delete dreamer.enabled;
    if (options.dreamerEnabled) {
        delete dreamer.disable;
        if (options.dreamerModel) {
            opencode.model = options.dreamerModel;
            dreamer.opencode = opencode;
        }
        // Dreamer schedules are harness-independent and remain at dreamer.tasks.
        // Only write explicit wizard overrides so an existing harness's schedule
        // remains intact when this setup run accepts schema defaults.
        if (options.dreamerTasks) {
            dreamer.tasks = options.dreamerTasks;
        }
    } else {
        dreamer.disable = true;
    }
    config.dreamer = dreamer;

    const sidekick = configObject(config.sidekick);
    delete sidekick.enabled;
    if (options.sidekickEnabled) {
        delete sidekick.disable;
        if (options.sidekickModel) {
            sidekick.model = options.sidekickModel;
        }
        config.sidekick = sidekick;
    } else {
        sidekick.disable = true;
        config.sidekick = sidekick;
    }

    if (options.claudeMax) {
        const cacheTtl = (config.cache_ttl as Record<string, string>) ?? {};
        if (!cacheTtl.default) cacheTtl.default = "5m";
        cacheTtl["anthropic/claude-sonnet-4-6"] = "59m";
        cacheTtl["anthropic/claude-opus-4-6"] = "59m";
        config.cache_ttl = cacheTtl;
    }

    writeFileAtomic(configPath, `${stringifyJsonc(config, null, 2)}\n`);
}
// ─── Main Setup Flow ──────────────────────────────────────

export async function runSetup(dryRun = false): Promise<number> {
    intro("Magic Context — Setup");
    if (dryRun) {
        log.warn("Dry run — no files will be written and no config will be changed.");
        log.message(
            "[dry-run] would migrate legacy Magic Context config before setup reads or writes the shared CortexKit config.",
        );
    } else {
        const migrationWarnings = migrateConfigLocationsForCli(process.cwd(), log);
        if (hasUserConfigLocationMigrationRefusal(migrationWarnings)) {
            outro(
                "Setup stopped — resolve the legacy Magic Context user config migration conflict, then rerun setup.",
            );
            return 1;
        }
    }

    // ─── Step 1: Check OpenCode ─────────────────────────
    const s = spinner();
    s.start("Checking OpenCode installation");

    const detection = detectOpenCode();
    if (detection.kind === "none") {
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
    } else if (detection.kind === "desktop") {
        // OpenCode Desktop ships no invocable `opencode` CLI on any OS (its
        // server runs as a JS sidecar inside Electron), so `opencode models`
        // and `opencode --version` are unavailable. Recognize the install and
        // fall through to manual model entry instead of claiming OpenCode is
        // absent.
        s.stop("OpenCode Desktop detected (CLI not installed)");
        log.info(
            "Model auto-discovery needs the OpenCode CLI; you will enter models manually. Install the CLI to auto-populate: https://opencode.ai",
        );
    } else {
        const version = getOpenCodeVersion(detection.binary);
        s.stop(`OpenCode ${version ?? ""} detected`);
    }

    // ─── Step 2: Get available models ───────────────────
    s.start("Fetching available models");

    // Only the CLI can enumerate the authed/resolved model list; Desktop-only
    // installs have no on-disk equivalent, so models stay empty and the model
    // prompts fall back to free-text entry. Use the resolved binary path so a
    // stock CLI that is not on PATH still enumerates.
    const allModels = detection.kind === "cli" ? getAvailableModels(detection.binary) : [];
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

    if (!dryRun) {
        try {
            // Fail before touching any setup target if one existing file is malformed.
            assertJsoncConfigsParseable([
                paths.opencodeConfig,
                paths.magicContextConfig,
                paths.tuiConfig,
            ]);
        } catch (error) {
            log.error(error instanceof Error ? error.message : String(error));
            outro("Setup stopped — fix the malformed config and rerun setup.");
            return 1;
        }
    }

    // ─── Step 4: Check for DCP plugin conflict before mutating setup files ────────
    const removeDcp = dryRun
        ? false
        : await resolveDcpConflictBeforeSetup(paths.opencodeConfig, paths.opencodeConfigFormat);

    // Resolve the MC compaction mode once for all writer/fixer/summary calls.
    // CLI writers load user-tier config through the same loader the plugin uses
    // and read through the same accessor; on load failure the helper takes the
    // preserve-existing-native-fields branch (returns false) and emits a
    // diagnostic, never assuming either mode.
    const compactionEnabled = resolveCompactionEnabledForWriter();

    // Collect every interactive choice before applying setup writes. A cancelled
    // wizard can then unwind without leaving only some target files updated.
    if (dryRun) {
        log.message(
            compactionEnabled
                ? `[dry-run] would add the plugin to ${paths.opencodeConfig} and disable compaction`
                : `[dry-run] would add the plugin to ${paths.opencodeConfig} (compaction-off mode — native compaction fields left untouched)`,
        );
    }

    let conflictFix: Parameters<typeof fixConflicts>[1] | null = null;
    if (hadExistingSetup) {
        const conflicts = detectConflicts(process.cwd(), {
            compactionEnabled,
        });
        if (conflicts.hasConflict) {
            log.warn("Found conflicting configuration that can disable Magic Context:");
            for (const reason of conflicts.reasons) {
                log.message(`  • ${reason}`);
            }

            if (dryRun) {
                log.message("[dry-run] would offer to apply automatic conflict fixes");
            } else {
                const shouldFixConflicts = await confirm(
                    "Apply automatic conflict fixes to your OpenCode and OMO config files?",
                    true,
                );

                if (shouldFixConflicts) {
                    conflictFix = conflicts.conflicts;
                } else {
                    log.warn(
                        "Skipped automatic conflict fixes — Magic Context may remain disabled",
                    );
                }
            }
        }
    }

    // ─── Step 5: Historian model ────────────────────────
    // pickModel shows the full discovered list when non-empty; when discovery
    // returns [] it still runs and offers free-text provider/model entry (same as Pi setup).
    const historianModel = await pickModel(promptIO, allModels, "historian");
    log.success(`Historian: ${historianModel}`);

    // ─── Step 6: Dreamer ────────────────────────────────
    const dreamerEnabled = await confirm("Enable dreamer?", true);
    let dreamerModel: string | null = null;
    let dreamerTasks: Record<string, { schedule: string }> | undefined;
    if (dreamerEnabled) {
        const result = await runDreamerSetup(promptIO, allModels);
        dreamerModel = result.model;
        dreamerTasks = result.tasks;
    }

    // ─── Step 7: Sidekick ───────────────────────────────
    const sidekickEnabled = await confirm("Enable sidekick?", false);
    let sidekickModel: string | null = null;
    if (sidekickEnabled) {
        sidekickModel = await pickModel(promptIO, allModels, "sidekick");
        log.success(`Sidekick: ${sidekickModel}`);
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

    if (dryRun) {
        log.message(`[dry-run] would write Magic Context config to ${paths.magicContextConfig}`);
        log.message(`[dry-run] would add the TUI sidebar plugin to ${paths.tuiConfig}`);
    }

    // ─── Step 8: Oh-My-OpenCode compatibility ───────────
    // Intentional: this branch handles the FIRST-TIME-INSTALL case only.
    // Existing users hit the same OMO conflict-fix logic via the
    // `if (hadExistingSetup) detectConflicts/fixConflicts` block above
    // (lines 231-257), which already covers omoPreemptiveCompaction,
    // omoContextWindowMonitor, and omoAnthropicRecovery. Audit tools
    // sometimes flag this `!hadExistingSetup` gate as "OMO check skipped
    // for existing users" — that's a false positive.
    let disableOmoHooks = false;
    if (paths.omoConfig && !hadExistingSetup) {
        log.warn(`Found oh-my-opencode config: ${paths.omoConfig}`);
        log.message(
            "These hooks may conflict:\n" +
                "  • context-window-monitor\n" +
                "  • preemptive-compaction\n" +
                "  • anthropic-context-window-limit-recovery",
        );

        const shouldDisable = dryRun
            ? false
            : await confirm("Disable these hooks in oh-my-opencode?", true);
        if (dryRun) {
            log.message("[dry-run] would offer to disable conflicting oh-my-opencode hooks");
        }
        if (shouldDisable) {
            disableOmoHooks = true;
        } else {
            log.warn("Skipped — you may experience context management conflicts");
        }
    }

    if (!dryRun) {
        addPluginToOpenCodeConfig(
            paths.opencodeConfig,
            paths.opencodeConfigFormat,
            removeDcp,
            compactionEnabled,
        );
        log.success(`Plugin added to ${paths.opencodeConfig}`);
        if (removeDcp) log.success("Removed opencode-dcp from plugin list");
        if (compactionEnabled) {
            log.info("Disabled built-in compaction (auto=false, prune=false)");
            log.message(
                "Magic Context handles context management — built-in compaction would interfere",
            );
        } else {
            log.info("Compaction-off mode active — leaving native compaction config untouched");
        }

        if (conflictFix) {
            const actions = fixConflicts(process.cwd(), conflictFix, {
                compactionEnabled,
            });
            if (actions.length > 0) {
                for (const action of actions) log.success(action);
            } else {
                log.info("No additional conflict changes were needed");
            }
        }

        writeMagicContextConfig(paths.magicContextConfig, {
            historianModel,
            dreamerEnabled,
            dreamerModel,
            dreamerTasks,
            sidekickEnabled,
            sidekickModel,
            claudeMax,
        });
        log.success(`Config written to ${paths.magicContextConfig}`);
        addPluginToTuiConfig(paths.tuiConfig, paths.tuiConfigFormat);
        log.success(`TUI sidebar plugin added to ${basename(paths.tuiConfig)}`);

        if (disableOmoHooks) {
            const actions = fixConflicts(
                process.cwd(),
                {
                    compactionAuto: false,
                    compactionPrune: false,
                    dcpPlugin: false,
                    omoPreemptiveCompaction: true,
                    omoContextWindowMonitor: true,
                    omoAnthropicRecovery: true,
                },
                {
                    compactionEnabled,
                },
            );
            if (actions.includes("Disabled conflicting oh-my-opencode hooks")) {
                log.success("Hooks disabled in oh-my-opencode config");
            }
        }
    }

    // ─── Summary ────────────────────────────────────────
    const summary = [
        `Plugin: ${PLUGIN_NAME}`,
        compactionEnabled
            ? "Compaction: disabled (Magic Context manages the window)"
            : "Compaction: off (native compaction owns the window)",
        historianModel ? `Historian: ${historianModel}` : "Historian: fallback chain",
        dreamerEnabled
            ? `Dreamer: enabled${dreamerModel ? ` (${dreamerModel})` : ""}`
            : "Dreamer: disabled",
        sidekickEnabled
            ? `Sidekick: enabled${sidekickModel ? ` (${sidekickModel})` : ""}`
            : "Sidekick: disabled",
    ].join("\n");

    note(summary, dryRun ? "Configuration (dry run — not written)" : "Configuration");

    if (dryRun) {
        outro("Dry run complete — nothing was written.");
        return 0;
    }

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
