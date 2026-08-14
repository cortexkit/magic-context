import { homedir } from "node:os";
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

/** Shape of the new unified omo.jsonc (oh-my-openagent >= 4.19.0).
 *  Hook config lives inside the `[opencode]` harness block. */
interface OmoV2Config {
    "[opencode]"?: {
        disabled_hooks?: string[];
    };
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
    /**
     * Resolved native compaction state observed during detection, for honest
     * reporting in both MC modes. `auto`/`prune` reflect the OpenCode
     * `compaction` block as resolved by the detector (env override, project
     * then user, default-on). They are populated even when MC compaction is
     * OFF (in which case they are NOT flagged as conflicts).
     */
    nativeCompaction: {
        auto: boolean;
        prune: boolean;
    };
}

/**
 * Resolved native compaction state, as reported by the host's own config
 * resolution (ctx.client.config.get() — the same object `opencode debug
 * config` prints). `auto`/`prune` are booleans; the OpenCode schema annotates
 * `auto` with default `true` and `prune` with default `false`, so an absent
 * compaction block resolves to `{ auto: true, prune: false }`.
 */
export interface ResolvedCompaction {
    auto: boolean;
    prune: boolean;
}

/**
 * Options for {@link detectConflicts}.
 *
 * `compactionEnabled` is the boot-resolved Magic Context compaction mode
 * (the result of {@link isCompactionEnabled} on the resolved user-tier
 * config). It MUST be threaded through every production call site — plugin
 * boot, setup, doctor, conflict-fixer — so the MC-mode decision is never
 * re-derived at a call site. A call site that genuinely cannot supply it
 * (e.g. a low-level native-config reader with no MC config handle) MUST
 * omit it and accept the default `true` (mode-on) behavior, which preserves
 * today's conflict semantics; it must never silently skip the check.
 *
 * `resolvedCompaction` is the host's RESOLVED native compaction state
 * (fetched via {@link resolveCompactionForBoot}). When present, the
 * file-based {@link checkCompaction} is NOT called — the resolved values are
 * used directly. Absent means the file-based fallback is used. The
 * OPENCODE_DISABLE_AUTOCOMPACT env short-circuit is applied on top of
 * whichever arm produced the value.
 *
 * When `compactionEnabled` is `false` (compaction-off mode), OpenCode
 * `compaction.auto=true` / `compaction.prune=true` are NOT plugin-disabling
 * conflicts — native compaction is the user's chosen window manager. DCP
 * and the three OMO conflict classes keep their existing policy in BOTH
 * modes.
 */
export interface DetectConflictsOptions {
    compactionEnabled?: boolean;
    resolvedCompaction?: ResolvedCompaction;
}

/**
 * Detect all conflicts that would prevent magic-context from working correctly.
 * Checks: OpenCode compaction, DCP plugin, OMO conflicting hooks.
 *
 * `compactionEnabled` (default `true`) is the resolved MC compaction mode.
 * When `false` (compaction-off mode), native `compaction.auto`/`prune` are
 * reported in {@link ConflictResult.nativeCompaction} but are NOT flagged as
 * conflicts — native compaction is the intended window manager in that mode.
 *
 * `resolvedCompaction` (optional) is the host's RESOLVED native compaction
 * state from {@link resolveCompactionForBoot}. When present it is used
 * directly and the file-based {@link checkCompaction} is skipped; when absent
 * the file-based fallback runs unchanged.
 */
export function detectConflicts(
    directory: string,
    options?: DetectConflictsOptions,
): ConflictResult {
    const compactionEnabled = options?.compactionEnabled ?? true;
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
    // The host's resolved config is the authority when available (issue #309:
    // the file-based re-derivation defaults to auto=true when no file resolves,
    // wrongly disabling the plugin for users whose auto=false lives in a layer
    // the file reader cannot see). When the resolved fetch failed, fall back to
    // the file-based check unchanged.
    let compactionResult = options?.resolvedCompaction ?? checkCompaction(directory);
    // OPENCODE_DISABLE_AUTOCOMPACT short-circuits BOTH arms: it is the first,
    // cheapest check and is correct regardless of which arm produced the value.
    // (checkCompaction already applies it internally for the file arm; this
    // covers the resolved arm, which skips checkCompaction entirely.)
    if (process.env.OPENCODE_DISABLE_AUTOCOMPACT) {
        compactionResult = { auto: false, prune: false };
    }
    // Native compaction is a conflict ONLY when MC compaction is ON. In
    // compaction-off mode the user has explicitly handed the window to native
    // compaction (or nothing), so compaction.auto=true / prune=true are the
    // intended state, not a plugin-disabling conflict.
    if (compactionEnabled && compactionResult.auto) {
        conflicts.compactionAuto = true;
        reasons.push(
            options?.resolvedCompaction
                ? "OpenCode auto-compaction is enabled (compaction.auto=true) (resolved config)"
                : "OpenCode auto-compaction is enabled (compaction.auto=true)",
        );
    }
    if (compactionEnabled && compactionResult.prune) {
        conflicts.compactionPrune = true;
        reasons.push(
            options?.resolvedCompaction
                ? "OpenCode prune is enabled (compaction.prune=true) (resolved config)"
                : "OpenCode prune is enabled (compaction.prune=true)",
        );
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
        nativeCompaction: { auto: compactionResult.auto, prune: compactionResult.prune },
    };
}

// --- Compaction detection (extracted from opencode-compaction-detector.ts) ---

/**
 * Minimal shape of the OpenCode SDK client's `config.get()` response. The
 * SDK's generated `Config` type does not declare a `compaction` field (the
 * schema lives in OpenCode's core config, not the SDK surface), so we read it
 * defensively at runtime. `config.get()` returns a `RequestResult` whose
 * `data` is the resolved config object — the same object `opencode debug
 * config` prints. The `data` is typed as `unknown` here so the real SDK client
 * (whose `Config` has no `compaction` key) is structurally assignable.
 */
export interface OpencodeConfigClientLike {
    config: {
        get: () => Promise<{ data?: unknown }>;
    };
}

/**
 * Shape of the `compaction` block inside the resolved config, read defensively
 * from the SDK response at runtime.
 */
interface ResolvedCompactionBlock {
    compaction?: {
        auto?: boolean;
        prune?: boolean;
    };
}

/**
 * Fetch the host's RESOLVED native compaction state from the OpenCode SDK
 * client (`ctx.client.config.get()`). This is the authority for the plugin's
 * conflict decision (issue #309): the file-based re-derivation cannot see
 * every layer OpenCode folds in (env-var config path, managed configs,
 * multi-file merge), so any user whose `auto=false` lives in a layer we don't
 * read would be wrongly flagged. We never re-derive what the host will tell
 * us.
 *
 * ABSENT IS NOT A VALUE. A response that carries no `compaction` block tells us
 * NOTHING about the user's setting — it does not tell us the host resolved the
 * default. Defaulting to `auto: true` there reintroduces exactly the bug #309
 * set out to fix, one layer up: a plugin-disabling verdict derived from a field
 * nobody reported. It is not hypothetical. The SDK's generated `Config` type has
 * no `compaction` key at all (the only `compaction` in the SDK surface is the
 * message-part variant `type: "compaction"`), so on an SDK whose schema omits it
 * the block is ALWAYS absent, `?? true` always wins, and Magic Context disables
 * itself on every boot no matter what the user configured.
 *
 * So: only a present block is authoritative. Within a present block the host's
 * documented per-field defaults apply (`auto` true, `prune` false — see
 * packages/core/src/v1/config/config.ts in the opencode repo), because there the
 * host really is reporting a resolved object. An absent block returns `null`,
 * which routes the caller to the file-based check — the same path used when the
 * fetch fails, and the one that reads the user's actual config.
 *
 * Returns `null` when the fetch fails, times out (bounded to `timeoutMs` so boot
 * never hangs), or reports no compaction block at all.
 */
export async function resolveCompactionForBoot(
    client: OpencodeConfigClientLike,
    timeoutMs = 2_000,
): Promise<ResolvedCompaction | null> {
    try {
        const result = await Promise.race([
            client.config.get(),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("config.get() timed out")), timeoutMs),
            ),
        ]);
        // The SDK's generated `Config` type has no `compaction` key, so read it
        // defensively from the runtime response.
        const data = result?.data as ResolvedCompactionBlock | undefined;
        const compaction = data?.compaction;
        // Absent block => we learned nothing. Fall back to the file-based check
        // rather than inventing a plugin-disabling default from silence.
        if (!compaction || typeof compaction !== "object") return null;
        // Present block => authoritative, with the host's per-field defaults.
        return {
            auto: compaction.auto ?? true,
            prune: compaction.prune ?? false,
        };
    } catch {
        return null;
    }
}

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

    // Check both old and new OMO config names in the OpenCode config dir
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

    // Also check project-level OMO configs (old format)
    for (const name of configNames) {
        const config = readJsoncFile<OmoConfig>(join(directory, name));
        if (config?.disabled_hooks) {
            for (const hook of config.disabled_hooks) {
                disabled.add(hook);
            }
        }
    }

    // --- New unified omo.jsonc (oh-my-openagent >= 4.19.0) ---
    // User-level: ~/.omo/omo.jsonc (fallback ~/.omo/omo.json)
    const homeDir = process.env.HOME || homedir();
    const omoHomeDir = join(homeDir, ".omo");
    for (const name of ["omo.jsonc", "omo.json"]) {
        const config = readJsoncFile<OmoV2Config>(join(omoHomeDir, name));
        if (config?.["[opencode]"]?.disabled_hooks) {
            for (const hook of config["[opencode]"].disabled_hooks) {
                disabled.add(hook);
            }
        }
    }

    // Project-level: .omo/omo.jsonc (fallback .omo/omo.json)
    for (const name of ["omo.jsonc", "omo.json"]) {
        const config = readJsoncFile<OmoV2Config>(join(directory, ".omo", name));
        if (config?.["[opencode]"]?.disabled_hooks) {
            for (const hook of config["[opencode]"].disabled_hooks) {
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
