import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "comment-json";
import { detectConflicts } from "../shared/conflict-detector";
import { fixConflicts } from "../shared/conflict-fixer";
import { ensureTuiPluginEntry } from "../shared/tui-config";
import { detectConfigPaths } from "./config-paths";
import { isOpenCodeInstalled } from "./opencode-helpers";
import { intro, log, outro } from "./prompts";

const PLUGIN_NAME = "@cortexkit/opencode-magic-context";
const PLUGIN_ENTRY_WITH_VERSION = `${PLUGIN_NAME}@latest`;

/**
 * Resolve OpenCode's XDG-based cache directory.
 * OpenCode uses `xdg-basedir` which resolves to:
 * - macOS/Linux: $XDG_CACHE_HOME or ~/.cache
 * - Windows: $XDG_CACHE_HOME or %LOCALAPPDATA%
 * Plugin cache lives at <cacheDir>/opencode/packages/<pkg>/
 */
function getOpenCodeCacheDir(): string {
    const xdgCache = process.env.XDG_CACHE_HOME;
    if (xdgCache) return join(xdgCache, "opencode");

    const os = platform();
    if (os === "win32") {
        const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
        return join(localAppData, "opencode");
    }
    // macOS + Linux
    return join(homedir(), ".cache", "opencode");
}

async function clearPluginCache(force = false): Promise<{
    action: "cleared" | "up_to_date" | "not_found" | "error";
    path: string;
    cached?: string;
    latest?: string;
    error?: string;
}> {
    const cacheDir = getOpenCodeCacheDir();
    const pluginCacheDir = join(cacheDir, "packages", PLUGIN_ENTRY_WITH_VERSION);

    if (!existsSync(pluginCacheDir)) {
        return { action: "not_found", path: pluginCacheDir };
    }

    // Read cached version from the installed package.json (more reliable than package-lock.json)
    let cachedVersion: string | undefined;
    try {
        const installedPkgPath = join(
            pluginCacheDir,
            "node_modules",
            "@cortexkit",
            "opencode-magic-context",
            "package.json",
        );
        if (existsSync(installedPkgPath)) {
            const pkg = JSON.parse(readFileSync(installedPkgPath, "utf-8"));
            if (typeof pkg?.version === "string") {
                cachedVersion = pkg.version;
            }
        }
    } catch {
        // Can't read cached version — proceed with clearing
    }

    // Compare against our own version — when running via `bunx @cortexkit/opencode-magic-context@latest doctor`,
    // our package.json IS the latest published version. No network call needed.
    // Try multiple relative paths to handle both src/ and dist/ build output locations.
    const require = createRequire(import.meta.url);
    let selfVersion: string | undefined;
    for (const relPath of ["../../package.json", "../package.json"]) {
        try {
            selfVersion = (require(relPath) as { version?: string }).version;
            if (selfVersion) break;
        } catch {
            // Try next path
        }
    }

    // If we know both versions and they match, skip (unless forced)
    if (!force && cachedVersion && cachedVersion === selfVersion) {
        return {
            action: "up_to_date",
            path: pluginCacheDir,
            cached: cachedVersion,
            latest: selfVersion,
        };
    }

    try {
        rmSync(pluginCacheDir, { recursive: true, force: true });
        return {
            action: "cleared",
            path: pluginCacheDir,
            cached: cachedVersion,
            latest: selfVersion,
        };
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { action: "error", path: pluginCacheDir, error: msg };
    }
}

export async function runDoctor(options: { force?: boolean } = {}): Promise<number> {
    intro("Magic Context Doctor");

    let issues = 0;
    let fixed = 0;

    // 1. Check OpenCode is installed
    if (!isOpenCodeInstalled()) {
        log.error("OpenCode is not installed or not in PATH");
        outro("Doctor failed — install OpenCode first");
        return 1;
    }
    log.success("OpenCode installed");

    // 2. Check config paths exist
    const paths = detectConfigPaths();

    if (paths.opencodeConfigFormat === "none") {
        log.error(`No opencode.json found at ${paths.opencodeConfig}`);
        issues++;
    } else {
        log.success(`OpenCode config: ${paths.opencodeConfig}`);
    }

    // 3. Check magic-context.jsonc exists
    if (existsSync(paths.magicContextConfig)) {
        log.success(`Magic Context config: ${paths.magicContextConfig}`);
    } else {
        log.warn(`No magic-context.jsonc found — using defaults`);
        log.info("  Run 'setup' to create one with model recommendations");
    }

    // 4. Check plugin is in opencode.json
    if (paths.opencodeConfigFormat !== "none") {
        try {
            const raw = readFileSync(paths.opencodeConfig, "utf-8");
            const config = parse(raw) as Record<string, unknown>;
            const plugins = Array.isArray(config?.plugin) ? config.plugin : [];
            const hasPlugin = (plugins as unknown[]).some(
                (p: unknown) =>
                    typeof p === "string" &&
                    (p === PLUGIN_NAME ||
                        p.startsWith(`${PLUGIN_NAME}@`) ||
                        p.includes("opencode-magic-context")),
            );
            const configName =
                paths.opencodeConfigFormat === "jsonc" ? "opencode.jsonc" : "opencode.json";
            if (hasPlugin) {
                log.success(`Plugin registered in ${configName}`);
            } else {
                // Auto-add plugin entry — preserves comments
                const updatedPlugins = [...(plugins as unknown[]), PLUGIN_ENTRY_WITH_VERSION];
                config.plugin = updatedPlugins;
                writeFileSync(paths.opencodeConfig, `${stringify(config, null, 2)}\n`);
                log.success(`Added plugin to ${configName}`);
                fixed++;
            }
        } catch {
            log.warn("Could not parse opencode config to verify plugin entry");
        }
    }

    // 5. Check for conflicts
    const cwd = process.cwd();
    const conflictResult = detectConflicts(cwd);

    if (conflictResult.hasConflict) {
        for (const reason of conflictResult.reasons) {
            log.error(`Conflict: ${reason}`);
        }
        // Auto-fix conflicts
        const actions = fixConflicts(cwd, conflictResult.conflicts);
        for (const action of actions) {
            log.success(`Fixed: ${action}`);
            fixed++;
        }
        // Only count unfixed conflicts as issues
        issues += conflictResult.reasons.length - actions.length;

        if (actions.length > 0) {
            log.warn("Restart OpenCode for conflict fixes to take effect");
        }
    } else {
        log.success("No conflicts detected (compaction, DCP, OMO hooks)");
    }

    // 6. Check tui.json
    const tuiAdded = ensureTuiPluginEntry();
    if (tuiAdded) {
        log.success("Added TUI sidebar plugin to tui.json");
        log.warn("Restart OpenCode to see the sidebar");
        fixed++;
    } else {
        // Check if it's already there vs missing tui.json entirely
        if (existsSync(paths.tuiConfig)) {
            log.success("TUI sidebar plugin configured");
        } else {
            log.success("TUI sidebar plugin configured (tui.json created)");
        }
    }

    // 7. Check user memories + dreamer compatibility
    if (existsSync(paths.magicContextConfig)) {
        try {
            const mcRaw = readFileSync(paths.magicContextConfig, "utf-8");
            const mcConfig = parse(mcRaw) as Record<string, unknown>;
            const userMemObj = (mcConfig?.experimental as Record<string, unknown>)?.user_memories as
                | Record<string, unknown>
                | undefined;
            const userMemEnabled = userMemObj?.enabled === true;
            const dreamerObj = mcConfig?.dreamer as Record<string, unknown> | undefined;
            const dreamerEnabled = dreamerObj?.enabled === true;
            if (userMemEnabled && !dreamerEnabled) {
                log.warn(
                    "experimental_user_memories is enabled but dreamer is disabled — user memory candidates will be collected but never promoted to stable memories",
                );
                issues++;
            }
        } catch {
            // Config parse failed — skip this check
        }
    }

    // 8. Check plugin npm cache — clear only if outdated
    const cacheResult = await clearPluginCache(options.force);
    if (cacheResult.action === "cleared") {
        const versionInfo = cacheResult.cached
            ? ` (cached: ${cacheResult.cached}${cacheResult.latest ? `, latest: ${cacheResult.latest}` : ""})`
            : "";
        log.success(
            `Cleared outdated plugin cache${versionInfo} — latest will download on restart`,
        );
        log.info(`  ${cacheResult.path}`);
        fixed++;
    } else if (cacheResult.action === "up_to_date") {
        log.success(`Plugin cache up to date (v${cacheResult.cached})`);
    } else if (cacheResult.action === "error") {
        log.warn(`Could not clear plugin cache: ${cacheResult.error}`);
        log.info(`  Manually delete: ${cacheResult.path}`);
        issues++;
    } else {
        log.success("Plugin cache clean (no cached version found)");
    }

    // 9. Show diagnostics info (log file, historian dumps)
    const logPath = join(tmpdir(), "magic-context.log");
    if (existsSync(logPath)) {
        const logStat = statSync(logPath);
        const sizeKb = (logStat.size / 1024).toFixed(0);
        log.info(`Log file: ${logPath} (${sizeKb} KB)`);
    } else {
        log.info(`Log file: ${logPath} (not yet created)`);
    }

    const historianDumpDir = join(tmpdir(), "magic-context-historian");
    if (existsSync(historianDumpDir)) {
        try {
            const dumps = readdirSync(historianDumpDir)
                .filter((f) => f.endsWith(".xml"))
                .map((f) => ({
                    name: f,
                    mtime: statSync(join(historianDumpDir, f)).mtimeMs,
                }))
                .sort((a, b) => b.mtime - a.mtime);
            if (dumps.length > 0) {
                log.warn(`Historian debug dumps: ${dumps.length} file(s) in ${historianDumpDir}`);
                for (const dump of dumps.slice(0, 3)) {
                    const age = Math.round((Date.now() - dump.mtime) / 60000);
                    const ageStr = age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`;
                    log.info(`  ${dump.name} (${ageStr})`);
                }
                if (dumps.length > 3) {
                    log.info(`  ... and ${dumps.length - 3} more`);
                }
            }
        } catch {
            // Can't read dump directory — skip
        }
    }

    // 10. Check OMO config
    if (paths.omoConfig) {
        log.info(`OMO config found: ${paths.omoConfig}`);
    }

    // Summary
    console.log("");
    if (issues === 0 && fixed === 0) {
        outro("Everything looks good! ✨");
    } else if (issues > 0 && fixed > 0) {
        outro(`Found ${issues} issue(s), fixed ${fixed}. Restart OpenCode to apply.`);
    } else if (fixed > 0) {
        outro(`Fixed ${fixed} issue(s). Restart OpenCode to apply.`);
    } else {
        outro(`Found ${issues} issue(s) that need manual attention.`);
        return 1;
    }

    return 0;
}
