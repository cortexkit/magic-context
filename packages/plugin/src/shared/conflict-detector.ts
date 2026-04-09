import { join } from "node:path";
import { readJsoncFile } from "./jsonc-parser";
import { getOpenCodeConfigPaths } from "./opencode-config-dir";

interface OpenCodeConfig {
    compaction?: {
        auto?: boolean;
        prune?: boolean;
    };
    plugin?: string[];
}

interface OmoConfig {
    disabled_hooks?: string[];
}

export interface ConflictResult {
    /** Whether any blocking conflict was found */
    hasConflict: boolean;
    /** Human-readable reasons for each conflict */
    reasons: string[];
    /** Which conflicts were found — used for targeted fixes */
    conflicts: {
        compactionAuto: boolean;
        compactionPrune: boolean;
        dcpPlugin: boolean;
        omoPreemptiveCompaction: boolean;
        omoContextWindowMonitor: boolean;
        omoAnthropicRecovery: boolean;
    };
}

/**
 * Detect all conflicts that would prevent magic-context from working correctly.
 * Checks: OpenCode compaction, DCP plugin, OMO conflicting hooks.
 */
export function detectConflicts(directory: string): ConflictResult {
    const conflicts: ConflictResult["conflicts"] = {
        compactionAuto: false,
        compactionPrune: false,
        dcpPlugin: false,
        omoPreemptiveCompaction: false,
        omoContextWindowMonitor: false,
        omoAnthropicRecovery: false,
    };
    const reasons: string[] = [];

    // --- Check OpenCode compaction config ---
    const compactionResult = checkCompaction(directory);
    if (compactionResult.auto) {
        conflicts.compactionAuto = true;
        reasons.push("OpenCode auto-compaction is enabled (compaction.auto=true)");
    }
    if (compactionResult.prune) {
        conflicts.compactionPrune = true;
        reasons.push("OpenCode prune is enabled (compaction.prune=true)");
    }

    // --- Check for DCP plugin ---
    const dcpFound = checkDcpPlugin(directory);
    if (dcpFound) {
        conflicts.dcpPlugin = true;
        reasons.push(
            "opencode-dcp plugin is installed — it conflicts with Magic Context's context management",
        );
    }

    // --- Check OMO conflicting hooks ---
    const omoResult = checkOmoHooks(directory);
    if (omoResult.preemptiveCompaction) {
        conflicts.omoPreemptiveCompaction = true;
        reasons.push(
            "oh-my-opencode preemptive-compaction hook is active — it triggers compaction that conflicts with historian",
        );
    }
    if (omoResult.contextWindowMonitor) {
        conflicts.omoContextWindowMonitor = true;
        reasons.push(
            "oh-my-opencode context-window-monitor hook is active — it injects usage warnings that overlap with Magic Context nudges",
        );
    }
    if (omoResult.anthropicRecovery) {
        conflicts.omoAnthropicRecovery = true;
        reasons.push(
            "oh-my-opencode anthropic-context-window-limit-recovery hook is active — it triggers emergency compaction that bypasses historian",
        );
    }

    return {
        hasConflict: reasons.length > 0,
        reasons,
        conflicts,
    };
}

// --- Compaction detection (extracted from opencode-compaction-detector.ts) ---

function checkCompaction(directory: string): { auto: boolean; prune: boolean } {
    if (process.env.OPENCODE_DISABLE_AUTOCOMPACT) {
        return { auto: false, prune: false };
    }

    // Check project-level config first (higher precedence)
    const projectResult = readProjectCompaction(directory);
    if (projectResult.resolved) return projectResult;

    // Fall back to user-level config
    const userResult = readUserCompaction();
    if (userResult.resolved) return userResult;

    // Default: OpenCode has compaction enabled by default
    return { auto: true, prune: false };
}

function readProjectCompaction(directory: string): {
    auto: boolean;
    prune: boolean;
    resolved: boolean;
} {
    // .opencode/ config has higher precedence
    const dotOcJsonc = join(directory, ".opencode", "opencode.jsonc");
    const dotOcJson = join(directory, ".opencode", "opencode.json");
    const dotOcConfig =
        readJsoncFile<OpenCodeConfig>(dotOcJsonc) ?? readJsoncFile<OpenCodeConfig>(dotOcJson);

    if (dotOcConfig?.compaction) {
        const c = dotOcConfig.compaction;
        if (c.auto !== undefined || c.prune !== undefined) {
            return { auto: c.auto === true, prune: c.prune === true, resolved: true };
        }
    }

    // Root-level project config
    const rootJsonc = join(directory, "opencode.jsonc");
    const rootJson = join(directory, "opencode.json");
    const rootConfig =
        readJsoncFile<OpenCodeConfig>(rootJsonc) ?? readJsoncFile<OpenCodeConfig>(rootJson);

    if (rootConfig?.compaction) {
        const c = rootConfig.compaction;
        if (c.auto !== undefined || c.prune !== undefined) {
            return { auto: c.auto === true, prune: c.prune === true, resolved: true };
        }
    }

    return { auto: false, prune: false, resolved: false };
}

function readUserCompaction(): { auto: boolean; prune: boolean; resolved: boolean } {
    try {
        const paths = getOpenCodeConfigPaths({ binary: "opencode" });
        const config =
            readJsoncFile<OpenCodeConfig>(paths.configJsonc) ??
            readJsoncFile<OpenCodeConfig>(paths.configJson);

        if (config?.compaction) {
            const c = config.compaction;
            if (c.auto !== undefined || c.prune !== undefined) {
                return { auto: c.auto === true, prune: c.prune === true, resolved: true };
            }
        }
    } catch {
        // Intentional: config read is best-effort
    }
    return { auto: false, prune: false, resolved: false };
}

// --- DCP detection ---

function checkDcpPlugin(directory: string): boolean {
    const plugins = collectPluginEntries(directory);
    return plugins.some((p) => p.includes("opencode-dcp"));
}

function collectPluginEntries(directory: string): string[] {
    const plugins: string[] = [];

    // Project-level configs
    for (const configPath of [
        join(directory, ".opencode", "opencode.jsonc"),
        join(directory, ".opencode", "opencode.json"),
        join(directory, "opencode.jsonc"),
        join(directory, "opencode.json"),
    ]) {
        const config = readJsoncFile<OpenCodeConfig>(configPath);
        if (config?.plugin) {
            plugins.push(...config.plugin);
        }
    }

    // User-level config
    try {
        const paths = getOpenCodeConfigPaths({ binary: "opencode" });
        for (const configPath of [paths.configJsonc, paths.configJson]) {
            const config = readJsoncFile<OpenCodeConfig>(configPath);
            if (config?.plugin) {
                plugins.push(...config.plugin);
            }
        }
    } catch {
        // best-effort
    }

    return plugins;
}

// --- OMO hook detection ---

function checkOmoHooks(directory: string): {
    preemptiveCompaction: boolean;
    contextWindowMonitor: boolean;
    anthropicRecovery: boolean;
} {
    const result = {
        preemptiveCompaction: false,
        contextWindowMonitor: false,
        anthropicRecovery: false,
    };

    // First check if OMO is even installed
    const plugins = collectPluginEntries(directory);
    const hasOmo = plugins.some(
        (p) =>
            p.includes("oh-my-opencode") ||
            p.includes("oh-my-openagent") ||
            p.includes("@code-yeongyu/"),
    );
    if (!hasOmo) return result;

    // Read OMO config to check disabled_hooks
    const disabledHooks = readOmoDisabledHooks(directory);

    // Hooks are ACTIVE unless explicitly in disabled_hooks
    result.preemptiveCompaction = !disabledHooks.has("preemptive-compaction");
    result.contextWindowMonitor = !disabledHooks.has("context-window-monitor");
    result.anthropicRecovery = !disabledHooks.has("anthropic-context-window-limit-recovery");

    return result;
}

function readOmoDisabledHooks(directory: string): Set<string> {
    const disabled = new Set<string>();

    // Check both old and new OMO config names
    const configNames = [
        "oh-my-opencode.jsonc",
        "oh-my-opencode.json",
        "oh-my-openagent.jsonc",
        "oh-my-openagent.json",
    ];

    try {
        const paths = getOpenCodeConfigPaths({ binary: "opencode" });
        for (const name of configNames) {
            const configPath = join(paths.configDir, name);
            const config = readJsoncFile<OmoConfig>(configPath);
            if (config?.disabled_hooks) {
                for (const hook of config.disabled_hooks) {
                    disabled.add(hook);
                }
            }
        }
    } catch {
        // best-effort
    }

    // Also check project-level OMO configs
    for (const name of configNames) {
        const config = readJsoncFile<OmoConfig>(join(directory, name));
        if (config?.disabled_hooks) {
            for (const hook of config.disabled_hooks) {
                disabled.add(hook);
            }
        }
    }

    return disabled;
}

/**
 * Generate a short conflict summary for ignored message display.
 */
export function formatConflictShort(result: ConflictResult): string {
    if (!result.hasConflict) return "";

    const lines = [
        "⚠️ Magic Context is disabled due to conflicting configuration:",
        "",
        ...result.reasons.map((r) => `• ${r}`),
        "",
        "Fix: run `bunx @cortexkit/opencode-magic-context@latest doctor`",
    ];
    return lines.join("\n");
}
