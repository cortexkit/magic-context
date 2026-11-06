import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { loadPluginConfig } from "@magic-context/core/config";
import { isCompactionEnabled } from "@magic-context/core/config/agent-disable";
import { detectConflicts } from "@magic-context/core/shared/conflict-detector";
import { fixConflicts } from "@magic-context/core/shared/conflict-fixer";
import {
    appendJsoncArrayValues,
    removeJsoncArrayEntries,
    setJsoncValue,
} from "@magic-context/core/shared/jsonc-edit";
import {
    type OpenCodeHostGeneration,
    openCodeHostGenerationFromVersion,
} from "@magic-context/core/shared/opencode-db-path";
import { stringify as stringifyJsonc } from "comment-json";
import {
    isDevPathPluginEntry,
    isLocalPathPluginEntry,
    matchesPluginEntry,
    pluginEntryPackage,
} from "../adapters/opencode";
import { writeFileAtomic } from "../lib/atomic-write";
import {
    hasUserConfigLocationMigrationRefusal,
    migrateConfigLocationsForCli,
} from "../lib/config-location-migration";
import { runDreamerSetup } from "../lib/dreamer-setup";
import {
    assertJsoncConfigsParseable,
    editableChild,
    readJsoncConfigForUpdate,
    readJsoncTextForEdit,
    readMagicContextConfigForSetup,
} from "../lib/jsonc-config";
import { pickModel } from "../lib/model-picker";
import { detectOpenCode, detectOpenCodeInstallations } from "../lib/opencode-detect";
import { getAvailableModels, getOpenCodeVersion } from "../lib/opencode-helpers";
import {
    OPENCODE_PLUGIN_ENTRY_WITH_VERSION as PLUGIN_ENTRY,
    OPENCODE_PLUGIN_NAME as PLUGIN_NAME,
} from "../lib/opencode-plugin-cache";
import {
    OPENCODE_PLUGIN_CONFIG_KEYS,
    pluginConfigKeyFor,
    readPluginEntries,
} from "../lib/opencode-plugin-registration";
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

// ─── Helpers ──────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ─── Config Manipulators ──────────────────────────────────

/**
 * The new contents of opencode.jsonc with the plugin registered, or null when
 * the file already has everything setup would write. Nothing is written here,
 * so setup can prepare every config before changing any of them.
 */
function planOpenCodeConfigUpdate(
    configPath: string,
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
    /**
     * Which key the running host reads registrations from. OpenCode 2 loads the
     * legacy `plugin` array and its native `plugins` array together, so a fresh
     * entry must go under the host's own key or the plugin loads twice.
     */
    hostGeneration: OpenCodeHostGeneration = "v1",
): string | null {
    const registrationKey = pluginConfigKeyFor(hostGeneration);
    // The detection result predates interactive prompts. Re-read at commit time so
    // a config created while the wizard was open is merged instead of overwritten.
    const existsAtCommit = existsSync(configPath);
    const existing = existsAtCommit ? readJsoncConfigForUpdate(configPath) : {};
    if (!existsAtCommit) {
        const created: Record<string, unknown> = { [registrationKey]: [PLUGIN_ENTRY] };
        if (compactionEnabled) {
            created.compaction = { auto: false, prune: false };
        }
        return `${stringifyJsonc(created, null, 2)}\n`;
    }

    const document = readJsoncTextForEdit(configPath);
    let text = document.text;
    let changed = false;
    // Both keys are live registrations on OpenCode 2; read them together so a
    // checkout registered under `plugins` is never doubled by an npm entry.
    const rawPlugins: unknown[] = readPluginEntries(existing).map(({ entry }) => entry);
    const retainedPlugins = removeDcp
        ? rawPlugins.filter((plugin) => !matchesPluginEntry(plugin, DCP_PLUGIN_NAME))
        : rawPlugins;

    if (
        retainedPlugins.some(
            (plugin) =>
                isLocalPathPluginEntry(plugin) &&
                String(plugin).includes("magic-context") &&
                !isDevPathPluginEntry(plugin, dirname(configPath)),
        )
    ) {
        log.warn(
            "An unverifiable local OpenCode plugin path was ignored; its package name is not Magic Context.",
        );
    }

    if (removeDcp) {
        for (const key of OPENCODE_PLUGIN_CONFIG_KEYS) {
            if (!Array.isArray(existing[key])) continue;
            const result = removeJsoncArrayEntries(text, [key], (plugin) =>
                matchesPluginEntry(plugin, DCP_PLUGIN_NAME),
            );
            if (result.removed) {
                text = result.text;
                changed = true;
            }
        }
    }

    const hasNpmEntry = retainedPlugins.some((plugin) => matchesPluginEntry(plugin, PLUGIN_NAME));
    const hasDevEntry = retainedPlugins.some((plugin) =>
        isDevPathPluginEntry(plugin, dirname(configPath)),
    );
    if (!hasNpmEntry && !hasDevEntry) {
        text = Array.isArray(existing[registrationKey])
            ? appendJsoncArrayValues(text, [registrationKey], [PLUGIN_ENTRY])
            : setJsoncValue(text, [registrationKey], [PLUGIN_ENTRY]);
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

    return changed ? document.bom + text : null;
}

export function addPluginToOpenCodeConfig(
    configPath: string,
    _format: "json" | "jsonc" | "none",
    removeDcp = false,
    compactionEnabled = true,
    hostGeneration: OpenCodeHostGeneration = "v1",
): void {
    const text = planOpenCodeConfigUpdate(configPath, removeDcp, compactionEnabled, hostGeneration);
    if (text !== null) writeFileAtomic(configPath, text);
}

/**
 * The new contents of tui.jsonc with the sidebar plugin registered, or null
 * when it is already registered. Nothing is written here.
 */
function planTuiConfigUpdate(configPath: string): string | null {
    // Config discovery may be stale after prompts; merge the commit-time contents.
    const existsAtCommit = existsSync(configPath);
    const existing = existsAtCommit ? readJsoncConfigForUpdate(configPath) : {};
    if (!existsAtCommit) {
        return `${stringifyJsonc({ plugin: [PLUGIN_ENTRY] }, null, 2)}\n`;
    }

    const rawPlugins: unknown[] = Array.isArray(existing.plugin) ? existing.plugin : [];
    if (
        rawPlugins.some(
            (plugin) =>
                isLocalPathPluginEntry(plugin) &&
                String(plugin).includes("magic-context") &&
                !isDevPathPluginEntry(plugin, dirname(configPath)),
        )
    ) {
        log.warn(
            "An unverifiable local TUI plugin path was ignored; its package name is not Magic Context.",
        );
    }

    const hasNpmEntry = rawPlugins.some((plugin) => matchesPluginEntry(plugin, PLUGIN_NAME));
    const hasDevEntry = rawPlugins.some((plugin) =>
        isDevPathPluginEntry(plugin, dirname(configPath)),
    );
    if (hasNpmEntry || hasDevEntry) return null;

    const document = readJsoncTextForEdit(configPath);
    const text = Array.isArray(existing.plugin)
        ? appendJsoncArrayValues(document.text, ["plugin"], [PLUGIN_ENTRY])
        : setJsoncValue(document.text, ["plugin"], [PLUGIN_ENTRY]);
    return document.bom + text;
}

export function addPluginToTuiConfig(configPath: string, _format: "json" | "jsonc" | "none"): void {
    const text = planTuiConfigUpdate(configPath);
    if (text !== null) writeFileAtomic(configPath, text);
}

/** opencode-dcp registrations under either plugin key (OpenCode 2 loads both). */
export function findDcpPluginEntries(config: Record<string, unknown>): unknown[] {
    return readPluginEntries(config)
        .map(({ entry }) => entry)
        .filter((entry) => matchesPluginEntry(entry, DCP_PLUGIN_NAME));
}

export function findDcpPluginIndexes(plugins: unknown[]): number[] {
    return plugins
        .map((plugin, index) => (matchesPluginEntry(plugin, DCP_PLUGIN_NAME) ? index : -1))
        .filter((index) => index >= 0);
}

function pluginEntryName(entry: unknown): string {
    return pluginEntryPackage(entry) ?? String(entry);
}

async function resolveDcpConflictBeforeSetup(
    configPath: string,
    format: "json" | "jsonc" | "none",
): Promise<boolean> {
    if (format === "none") return false;
    const dcpEntries = findDcpPluginEntries(readJsoncConfigForUpdate(configPath));
    if (dcpEntries.length === 0) return false;

    log.warn(`Found conflicting plugin: ${pluginEntryName(dcpEntries[0])}`);
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

export interface MagicContextSetupChoices {
    historianModel: string | null;
    dreamerEnabled: boolean;
    dreamerModel: string | null;
    /** Per-task schedule overrides (Dreamer v2); undefined keeps schema defaults. */
    dreamerTasks?: Record<string, { schedule: string }>;
    claudeMax: boolean;
}

/** The new contents of magic-context.jsonc with the wizard's choices. Nothing is written here. */
function planMagicContextConfig(configPath: string, options: MagicContextSetupChoices): string {
    // A malformed existing file must abort rather than become an empty config.
    const config = readMagicContextConfigForSetup(configPath);

    // Always set $schema for editor autocomplete/validation
    if (!config.$schema) {
        config.$schema =
            "https://raw.githubusercontent.com/cortexkit/magic-context/master/assets/magic-context.schema.json";
    }

    // Objects are edited in place so the comments comment-json attached to
    // them are written back unchanged.
    if (options.historianModel) {
        editableChild(editableChild(config, "historian"), "opencode").model =
            options.historianModel;
    }

    const dreamer = editableChild(config, "dreamer");
    delete dreamer.enabled;
    if (options.dreamerEnabled) {
        delete dreamer.disable;
        if (options.dreamerModel) {
            editableChild(dreamer, "opencode").model = options.dreamerModel;
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

    if (options.claudeMax) {
        // cache_ttl is either one TTL for every model or a per-model map. A
        // single string becomes the map's default so other models keep it.
        const existingTtl = config.cache_ttl;
        if (typeof existingTtl === "string") {
            config.cache_ttl = { default: existingTtl };
        } else if (existingTtl !== undefined && !isPlainObject(existingTtl)) {
            throw new Error(
                `Refusing to rewrite ${configPath}: "cache_ttl" must be a string or an object of per-model TTLs. Fix it by hand, then rerun setup.`,
            );
        }
        const cacheTtl = editableChild(config, "cache_ttl");
        if (!cacheTtl.default) cacheTtl.default = "5m";
        cacheTtl["anthropic/claude-sonnet-4-6"] = "59m";
        cacheTtl["anthropic/claude-opus-4-6"] = "59m";
    }

    return `${stringifyJsonc(config, null, 2)}\n`;
}

export function writeMagicContextConfig(
    configPath: string,
    options: MagicContextSetupChoices,
): void {
    writeFileAtomic(configPath, planMagicContextConfig(configPath, options), { ownerOnly: true });
}

/**
 * Prepare opencode.jsonc, magic-context.jsonc and (on OpenCode 1) tui.jsonc
 * first, then write them. Any config that cannot be updated stops setup before
 * the first write, instead of leaving the earlier files changed and the later
 * ones not.
 */
export function applyOpenCodeSetupConfigs(
    paths: { opencodeConfig: string; magicContextConfig: string; tuiConfig: string },
    choices: {
        removeDcp: boolean;
        compactionEnabled: boolean;
        hostGeneration: OpenCodeHostGeneration;
        magicContext: MagicContextSetupChoices;
    },
): void {
    const opencodeText = planOpenCodeConfigUpdate(
        paths.opencodeConfig,
        choices.removeDcp,
        choices.compactionEnabled,
        choices.hostGeneration,
    );
    const magicContextText = planMagicContextConfig(paths.magicContextConfig, choices.magicContext);
    // OpenCode 2 resolves the sidebar from the plugin entry itself; tui.json
    // is a 1.x-only surface and registers nothing on a 2.x host.
    const tuiText = choices.hostGeneration === "v1" ? planTuiConfigUpdate(paths.tuiConfig) : null;

    if (opencodeText !== null) writeFileAtomic(paths.opencodeConfig, opencodeText);
    writeFileAtomic(paths.magicContextConfig, magicContextText, { ownerOnly: true });
    if (tuiText !== null) writeFileAtomic(paths.tuiConfig, tuiText);
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
    // Older Desktop installs may have no runnable sidecar CLI; those keep the
    // 1.x config key. A runnable CLI overrides this below.
    let hostGeneration: OpenCodeHostGeneration = "v1";
    let cliBinary: string | null = detection.kind === "cli" ? detection.binary : null;
    let cliVersion: string | null = null;
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
        // No runnable CLI was found. The Desktop GUI still counts as an
        // install, so fall through to manual model entry instead of claiming
        // OpenCode is absent.
        s.stop("OpenCode Desktop detected (no runnable CLI found)");
        log.info(
            "Model auto-discovery needs a runnable OpenCode CLI; you will enter models manually. Install the CLI to auto-populate: https://opencode.ai",
        );
    } else if (cliBinary) {
        cliVersion = getOpenCodeVersion(cliBinary);
        s.stop(`OpenCode ${cliVersion ?? ""} detected`);
    }

    // ─── Step 2: Get available models ───────────────────
    s.start("Fetching available models");

    // Only a CLI can enumerate the authed/resolved model list. Probe every
    // detected CLI rung, not just the first: a stale 1.x npm shim on PATH can
    // fail against a 2.x config while the Desktop-bundled sidecar (the host the
    // user actually runs) enumerates it fine. The first successful catalog
    // also selects the host generation, so setup writes the matching config
    // key. If none works, the model prompts fall back to free-text entry.
    const cliInstallations = detectOpenCodeInstallations().filter(
        (installation) => installation.kind === "cli",
    );
    let allModels: string[] = [];
    for (const installation of cliInstallations) {
        const models = getAvailableModels(installation.path);
        if (models.length === 0) continue;
        allModels = models;
        if (installation.path !== cliBinary) {
            cliBinary = installation.path;
            cliVersion = getOpenCodeVersion(cliBinary);
            log.info(`Using the model catalog from ${cliBinary}`);
        }
        break;
    }
    if (cliVersion) {
        hostGeneration = openCodeHostGenerationFromVersion(cliVersion);
    }
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
        try {
            applyOpenCodeSetupConfigs(paths, {
                removeDcp,
                compactionEnabled,
                hostGeneration,
                magicContext: {
                    historianModel,
                    dreamerEnabled,
                    dreamerModel,
                    dreamerTasks,
                    claudeMax,
                },
            });
        } catch (error) {
            log.error(error instanceof Error ? error.message : String(error));
            outro("Setup stopped — fix the problem above and rerun setup.");
            return 1;
        }
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
        log.success(`Config written to ${paths.magicContextConfig}`);
        if (hostGeneration === "v1") {
            log.success(`TUI sidebar plugin added to ${basename(paths.tuiConfig)}`);
        } else {
            log.info("TUI sidebar loads from the plugin entry on OpenCode 2 (tui.json not used)");
        }

        // The conflict fixers edit other OpenCode and oh-my-opencode configs on
        // disk; they run after Magic Context's own configs are in place.
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
