import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseJsonc, readJsoncFile } from "./jsonc-parser";
import { log } from "./logger";
import { getOpenCodeConfigDirs, getOpenCodeGlobalConfigDir } from "./opencode-config-dir";
import type { OpenCodeHostGeneration } from "./opencode-db-path";

interface OpenCodeConfig {
    compaction?: {
        auto?: boolean;
        background?: boolean;
        prune?: boolean;
        keep?: { tokens?: number };
        buffer?: number;
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
    keepTokens?: number;
    buffer?: number;
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
    hostGeneration?: OpenCodeHostGeneration;
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
    const hostGeneration = options?.hostGeneration ?? "v1";
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
    let compactionResult =
        options?.resolvedCompaction ?? checkCompaction(directory, hostGeneration);
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
    if (hostGeneration === "v1" && compactionEnabled && compactionResult.auto) {
        conflicts.compactionAuto = true;
        reasons.push(
            options?.resolvedCompaction
                ? "OpenCode auto-compaction is enabled (compaction.auto=true) (resolved config)"
                : "OpenCode auto-compaction is enabled (compaction.auto=true)",
        );
    }
    if (hostGeneration === "v1" && compactionEnabled && compactionResult.prune) {
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
        nativeCompaction: {
            auto: compactionResult.auto,
            prune: hostGeneration === "v1" ? compactionResult.prune : false,
        },
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
        get: (options?: { signal?: AbortSignal }) => Promise<{ data?: unknown }>;
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
        keep?: { tokens?: number };
        buffer?: number;
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
 * A response WITHOUT a compaction block is INCONCLUSIVE, not "host defaults
 * apply": a server whose `/config` shape drifted (OpenCode Desktop bundles
 * its own server version) or a fetch racing boot returns data with no
 * `compaction` key, and reading that absence as `auto=true` disables the
 * plugin — the one wrong direction, because a false disable leaves NOTHING
 * managing the window and every long session overflows (issue #309, second
 * arm). Only an explicit `compaction.auto` boolean from the host resolves
 * this arm; anything else returns `null` so the caller falls back to the
 * file-based check, which reads the layers the user actually wrote.
 *
 * `compaction.prune` is read when present and treated as `false` when absent.
 * OpenCode serves only the keys the user wrote, so requiring it here rejected
 * the ordinary `{"compaction": {"auto": false}}` config and sent an
 * answerable question to the file arm (issue #484).
 *
 * Returns `null` when the fetch fails, times out (bounded to `timeoutMs` so
 * boot never hangs), or serves no explicit `compaction.auto`.
 */
export async function resolveCompactionForBoot(
    client: OpencodeConfigClientLike,
    timeoutMs = 2_000,
    hostGeneration: OpenCodeHostGeneration = "v1",
): Promise<ResolvedCompaction | null> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        // Install the deadline before invoking the generated SDK method. During
        // OpenCode bootstrap, /config can recursively wait for the same project
        // instance that is currently loading this plugin. Deferring invocation
        // ensures the deadline exists before any synchronous SDK/fetch prefix runs.
        const timeout = new Promise<null>((resolve) => {
            timer = setTimeout(
                () => {
                    controller.abort(new Error("config.get() timed out"));
                    resolve(null);
                },
                Math.max(0, timeoutMs),
            );
            (timer as { unref?: () => void }).unref?.();
        });
        const request = Promise.resolve().then(() =>
            client.config.get({ signal: controller.signal }),
        );
        const result = await Promise.race([request, timeout]);
        if (result === null) return null;

        // The SDK's generated `Config` type has no `compaction` key, so read it
        // defensively from the runtime response.
        const compaction = (result?.data as ResolvedCompactionBlock | undefined)?.compaction;
        if (hostGeneration === "v2") {
            if (typeof compaction?.auto !== "boolean") {
                log(
                    `[magic-context] conflict-detector: resolved v2 config carried no explicit compaction.auto (${JSON.stringify(compaction) ?? "absent"}); falling back to file-based detection`,
                );
                return null;
            }
            const keepTokens = compaction.keep?.tokens;
            const buffer = compaction.buffer;
            if (
                (keepTokens !== undefined && (!Number.isInteger(keepTokens) || keepTokens < 0)) ||
                (buffer !== undefined && (!Number.isInteger(buffer) || buffer < 0))
            ) {
                return null;
            }
            return {
                auto: compaction.auto,
                prune: false,
                ...(keepTokens === undefined ? {} : { keepTokens }),
                ...(buffer === undefined ? {} : { buffer }),
            };
        }
        // `compaction.auto` is the value the whole conflict decision turns on,
        // so an explicit boolean for it is required: an absent block means the
        // response did not carry the resolved state, and reading that absence
        // as the host default would disable the plugin (issue #309).
        //
        // `compaction.prune` is NOT required. OpenCode merges only the keys a
        // user actually wrote and does not materialise schema defaults into the
        // resolved config, so the ordinary `{"compaction": {"auto": false}}`
        // setup serves a block with no `prune` key at all — verified against
        // opencode 1.18.30 with `opencode debug config`. Demanding both
        // booleans rejected that every-day shape and pushed the decision onto
        // the file arm, which is how issue #484's reporter reached the file
        // arm at all. An absent `prune` takes OpenCode's documented default of
        // `false`, which is also the non-disabling direction.
        if (typeof compaction?.auto !== "boolean") {
            log(
                `[magic-context] conflict-detector: resolved config carried no explicit compaction.auto (${JSON.stringify(compaction) ?? "absent"}); falling back to file-based detection`,
            );
            return null;
        }
        return { auto: compaction.auto, prune: compaction.prune === true };
    } catch {
        return null;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function checkCompaction(
    directory: string,
    hostGeneration: OpenCodeHostGeneration,
): ResolvedCompaction {
    if (process.env.OPENCODE_DISABLE_AUTOCOMPACT) {
        return { auto: false, prune: false };
    }

    const merged = readCompactionFromConfigFiles(directory, hostGeneration);
    if (isRelevantCompactionBlock(merged, hostGeneration)) {
        return resolvedCompactionBlock(merged, hostGeneration);
    }

    // Nothing in any file OpenCode reads carried an explicit compaction key.
    // That is INCONCLUSIVE, not "the host default applies", and it must never
    // resolve to the plugin-disabling `auto: true`. We cannot tell "the user
    // wrote nothing" apart from "the user's setting lives somewhere this
    // reader cannot see" — a managed/remote config layer, a directory a
    // launcher pointed us away from, a file we failed to parse. Guessing the
    // disabling direction is the one guess with an unrecoverable cost: the
    // plugin switches off and NOTHING manages the context window, so every
    // long session overflows. Guessing the other way at worst leaves both
    // managers running, which is visible and fixable. Issue #309 established
    // this for the resolved-config arm; issue #484 extends it here after a
    // launcher exporting OPENCODE_CONFIG_DIR to a scaffolding-only directory
    // made this default fire against a user whose global config said
    // auto=false.
    log(
        "[magic-context] conflict-detector: no OpenCode config file carried an explicit compaction block; treating native compaction as inconclusive (not disabling the plugin)",
    );
    return { auto: false, prune: false };
}

/**
 * Every readable config file OpenCode merges for this project, ordered from
 * LOWEST to HIGHEST precedence.
 *
 * OpenCode 1.18.30 (`Config.loadInstanceState`) uses:
 *
 *   1. `$XDG_CONFIG_HOME/opencode/` — `config.json`, `opencode.json`, `opencode.jsonc`
 *   2. `$OPENCODE_CONFIG`          — the explicit single-file override
 *   3. the project's own `opencode.json` / `opencode.jsonc`
 *   4. the project's `.opencode/` directory
 *   5. `~/.opencode/` and `$OPENCODE_CONFIG_DIR` (see getOpenCodeConfigDirs)
 *
 * OpenCode 2.x orders the corresponding groups as well-known, global
 * supplementary, explicit, direct, then project supplementary. See
 * `packages/core/src/config.ts:220-236` at 7e70f7e1ab. Consequently project
 * `.opencode` files outrank global supplementary directories only on v2.
 *
 * Remote, org, managed-enterprise, and content layers are NOT readable from
 * here. That is why an empty result is inconclusive rather than the host
 * default.
 */
function openCodeConfigFileChain(
    directory: string,
    hostGeneration: OpenCodeHostGeneration,
): string[] {
    const globalDir = getOpenCodeGlobalConfigDir();
    const wellKnown = [
        join(globalDir, "config.json"),
        join(globalDir, "opencode.json"),
        join(globalDir, "opencode.jsonc"),
    ];
    const globalSupplementary = getOpenCodeConfigDirs()
        .filter((dir) => dir !== globalDir)
        .flatMap((dir) => [join(dir, "opencode.json"), join(dir, "opencode.jsonc")]);
    const explicitConfig = process.env.OPENCODE_CONFIG?.trim();
    const explicit = explicitConfig ? [explicitConfig] : [];
    // OpenCode 1 can ignore project opencode.json/jsonc and .opencode configs.
    // If config.get() times out during bootstrap, compaction detection falls
    // back here and must not read settings from those host-disabled files.
    const disableProjectConfig = process.env.OPENCODE_DISABLE_PROJECT_CONFIG?.toLowerCase();
    const skipProject =
        hostGeneration === "v1" &&
        (disableProjectConfig === "true" || disableProjectConfig === "1");
    const direct = skipProject
        ? []
        : [join(directory, "opencode.json"), join(directory, "opencode.jsonc")];
    const projectSupplementary = skipProject
        ? []
        : [
              join(directory, ".opencode", "opencode.json"),
              join(directory, ".opencode", "opencode.jsonc"),
          ];

    const files =
        hostGeneration === "v2"
            ? [
                  ...wellKnown,
                  ...globalSupplementary,
                  ...explicit,
                  ...direct,
                  ...projectSupplementary,
              ]
            : [
                  ...wellKnown,
                  ...explicit,
                  ...direct,
                  ...projectSupplementary,
                  ...globalSupplementary,
              ];
    return [...new Set(files)];
}

type CompactionBlock = NonNullable<OpenCodeConfig["compaction"]>;

/**
 * Merge the `compaction` blocks of every readable config file, in OpenCode's
 * own precedence order. Merging (rather than taking the first file that has a
 * block) is what OpenCode does, so a global `auto: false` and a project-level
 * `prune: true` both survive instead of one silently erasing the other.
 */
function readCompactionFromConfigFiles(
    directory: string,
    hostGeneration: OpenCodeHostGeneration,
    readConfig = readJsoncFile<OpenCodeConfig>,
): CompactionBlock {
    const merged: CompactionBlock = {};
    for (const filePath of openCodeConfigFileChain(directory, hostGeneration)) {
        let block: CompactionBlock | undefined;
        try {
            block = readConfig(filePath)?.compaction;
        } catch {
            // Intentional: each config read is best-effort. An unreadable file
            // leaves the chain inconclusive rather than failing detection.
        }
        if (!block || typeof block !== "object") continue;
        if (block.auto !== undefined) merged.auto = block.auto;
        if (block.background !== undefined) merged.background = block.background;
        if (block.prune !== undefined) merged.prune = block.prune;
        if (block.buffer !== undefined) merged.buffer = block.buffer;
        if (block.keep !== undefined) merged.keep = { ...merged.keep, ...block.keep };
    }
    return merged;
}

/** File-based input to doctor's advisory finding; never used to block plugin boot. */
export function readOpenCode2BackgroundCompaction(directory: string): {
    enabled: boolean;
    backgroundSource: string | undefined;
    unreadable: string[];
} {
    let backgroundSource: string | undefined;
    const unreadable: string[] = [];
    const compaction = readCompactionFromConfigFiles(directory, "v2", (path) => {
        try {
            const text = readFileSync(path, "utf-8").replace(/^\uFEFF/, "");
            const config = parseJsonc<OpenCodeConfig>(text);
            if (!config || typeof config !== "object" || Array.isArray(config)) {
                throw new Error("Expected an OpenCode config object");
            }
            if (config.compaction?.background !== undefined) backgroundSource = path;
            return config;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") unreadable.push(path);
            return null;
        }
    });
    return {
        enabled: compaction.auto !== false && compaction.background !== false,
        backgroundSource,
        unreadable,
    };
}

/** Whether a merged block carries any key this host generation acts on. */
function isRelevantCompactionBlock(
    block: CompactionBlock,
    hostGeneration: OpenCodeHostGeneration,
): boolean {
    if (block.auto !== undefined) return true;
    if (hostGeneration === "v1") return block.prune !== undefined;
    return block.keep?.tokens !== undefined || block.buffer !== undefined;
}

function resolvedCompactionBlock(
    block: NonNullable<OpenCodeConfig["compaction"]>,
    hostGeneration: OpenCodeHostGeneration,
): ResolvedCompaction & { resolved: true } {
    if (hostGeneration === "v2") {
        return {
            auto: block.auto !== false,
            prune: false,
            resolved: true,
            ...(typeof block.keep?.tokens === "number" ? { keepTokens: block.keep.tokens } : {}),
            ...(typeof block.buffer === "number" ? { buffer: block.buffer } : {}),
        };
    }
    return { auto: block.auto === true, prune: block.prune === true, resolved: true };
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

    // User-level config. Every directory OpenCode reads is searched, not just
    // the one we would write to: a launcher that exports OPENCODE_CONFIG_DIR
    // does not stop OpenCode from loading the plugin list in the user's global
    // config, so a conflicting plugin declared there is still installed.
    try {
        const globalDir = getOpenCodeGlobalConfigDir();
        for (const dir of getOpenCodeConfigDirs()) {
            const names =
                dir === globalDir
                    ? ["config.json", "opencode.json", "opencode.jsonc"]
                    : ["opencode.json", "opencode.jsonc"];
            for (const name of names) {
                const config = readJsoncFile<OpenCodeConfig>(join(dir, name));
                pushFrom(config?.plugin);
            }
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
        for (const dir of getOpenCodeConfigDirs()) {
            for (const name of configNames) {
                const config = readJsoncFile<OmoConfig>(join(dir, name));
                if (config?.disabled_hooks) {
                    for (const hook of config.disabled_hooks) {
                        disabled.add(hook);
                    }
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
