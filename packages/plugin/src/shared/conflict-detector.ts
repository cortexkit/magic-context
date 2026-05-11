import { join } from "node:path";
import { readJsoncFile } from "./jsonc-parser";
import { getOpenCodeConfigPaths } from "./opencode-config-dir";

interface OpenCodeConfig {
    compaction?: {
        auto?: boolean;
        prune?: boolean;
    };
    // OpenCode allows plugins as plain strings or [name, options] tuples.
    plugin?: Array<string | [string, unknown]>;
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

/**
 * Canonical npm package names that represent the conflicting plugin.
 * Matched against the npm-style segment of each plugin entry, so:
 *   - "@tarquinen/opencode-dcp"           ✓ direct match
 *   - "@tarquinen/opencode-dcp@latest"    ✓ version suffix stripped
 *   - "@tarquinen/opencode-dcp@^3.1.0"    ✓ semver suffix stripped
 *   - "file:///path/to/opencode-dcp-fork" ✗ unrelated path
 *
 * forks/renames that don't ship the conflicting transform/system hooks are
 * intentionally NOT matched.
 */
export const DCP_PACKAGE_NAMES = new Set(["@tarquinen/opencode-dcp"]);

function checkDcpPlugin(directory: string): boolean {
    const plugins = collectPluginEntries(directory);
    return plugins.some((p) => matchesPackageName(p, DCP_PACKAGE_NAMES));
}

/**
 * Match a plugin entry against a set of canonical npm package names.
 *
 * A plugin entry can be:
 *   - "pkg-name"
 *   - "pkg-name@version"
 *   - "@scope/pkg-name"
 *   - "@scope/pkg-name@version"
 *   - "file://..." or other URL/path forms (never matched here)
 *
 * For the canonical-name path we only match the exact package name (with
 * optional version suffix). file:// paths and forks with different
 * package names are intentionally NOT matched — even if a path string
 * happens to contain a substring like "oh-my-opencode" (e.g. forks like
 * "oh-my-opencode-slim" published under a different package name).
 */
export function matchesPackageName(entry: string, canonicalNames: Set<string>): boolean {
    // Skip URL/path forms — only npm-style entries can be canonically matched.
    // (Local file:// checkouts of canonical plugins are rare; users running
    // those need to ensure the path itself doesn't match a fork's name.)
    if (
        entry.startsWith("file:") ||
        entry.startsWith("http:") ||
        entry.startsWith("https:") ||
        entry.startsWith("/") ||
        entry.startsWith("./") ||
        entry.startsWith("../")
    ) {
        return false;
    }

    // Strip version suffix: "@scope/pkg@1.2.3" → "@scope/pkg"
    // Careful with scoped packages: the leading "@" is part of the name.
    const lastAt = entry.lastIndexOf("@");
    const nameOnly = lastAt > 0 ? entry.slice(0, lastAt) : entry;
    return canonicalNames.has(nameOnly);
}

/** Extract the package-name string from a plugin entry.
 *  OpenCode supports two forms:
 *   - plain string:        "@scope/pkg@latest"
 *   - tuple [name, opts]:  ["@scope/pkg@latest", { ... }]
 *  Returns null for any other shape (numbers, objects, etc.). */
export function extractPluginName(entry: unknown): string | null {
    if (typeof entry === "string") return entry;
    if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0];
    return null;
}

function collectPluginEntries(directory: string): string[] {
    const plugins: string[] = [];

    const pushFrom = (entries: Array<string | [string, unknown]> | undefined) => {
        if (!entries) return;
        for (const entry of entries) {
            const name = extractPluginName(entry);
            if (name) plugins.push(name);
        }
    };

    // Project-level configs
    for (const configPath of [
        join(directory, ".opencode", "opencode.jsonc"),
        join(directory, ".opencode", "opencode.json"),
        join(directory, "opencode.jsonc"),
        join(directory, "opencode.json"),
    ]) {
        const config = readJsoncFile<OpenCodeConfig>(configPath);
        pushFrom(config?.plugin);
    }

    // User-level config
    try {
        const paths = getOpenCodeConfigPaths({ binary: "opencode" });
        for (const configPath of [paths.configJsonc, paths.configJson]) {
            const config = readJsoncFile<OpenCodeConfig>(configPath);
            pushFrom(config?.plugin);
        }
    } catch {
        // best-effort
    }

    return plugins;
}

// --- OMO hook detection ---

/**
 * Canonical OMO npm package names. The plugin publishes under both names as
 * a versioned alias (latest 3.17.5 on npm at time of writing).
 *
 * Forks under a different package name (e.g. `oh-my-opencode-slim`,
 * `oh-my-opencode-cli`, etc.) are intentionally NOT matched here — they
 * don't ship the `preemptive-compaction`, `context-window-monitor`, or
 * `anthropic-context-window-limit-recovery` hooks that conflict with
 * Magic Context. See https://github.com/cortexkit/magic-context/issues/43.
 *
 * The legacy `@code-yeongyu/` scope is no longer used — both names are
 * unscoped on npm.
 */
export const OMO_PACKAGE_NAMES = new Set(["oh-my-opencode", "oh-my-openagent"]);

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
    const hasOmo = plugins.some((p) => matchesPackageName(p, OMO_PACKAGE_NAMES));
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
        "Fix: run `npx @cortexkit/opencode-magic-context@latest doctor`",
    ];
    return lines.join("\n");
}
