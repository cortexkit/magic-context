import { existsSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { removeJsoncValue } from "../shared/jsonc-edit";
import {
    ensureStorageDirectorySync,
    writeStorageFileAtomicSync,
} from "../shared/storage-permissions";

/**
 * Config-LOCATION migration: move Magic Context config from the per-harness
 * legacy locations to one shared CortexKit location, mirroring AFT's proven
 * move-and-marker design (NOT copy-in-place, which is a silent stale-edit trap).
 *
 * Legacy (read by old builds):
 *   user:    ~/.config/opencode/magic-context.{jsonc,json}
 *            ~/.pi/agent/magic-context.{jsonc,json}
 *   project: <root>/magic-context.{jsonc,json}            (bare root)
 *            <root>/.opencode/magic-context.{jsonc,json}
 *            <root>/.pi/magic-context.{jsonc,json}
 *
 * Target (the only thing new builds read — HARD CUTOVER, harness-agnostic):
 *   user:    ~/.config/cortexkit/magic-context.jsonc
 *   project: <root>/.cortexkit/magic-context.jsonc
 *
 * The migrator runs at plugin init before the loader. Idempotency comes from
 * the legacy file being renamed away (not from a sentinel): once a source is
 * moved aside to `<name>.MOVED_READPLEASE`, later runs find no legacy source
 * and no-op. The marker is a pure human breadcrumb — the loader never reads it.
 *
 * NB: this is config-LOCATION migration. It is unrelated to the schema/key
 * migrations (migrate-dreamer-v2, migrate-experimental) that rewrite keys
 * INSIDE an already-located config file.
 */

export interface LegacyConfigSource {
    path: string;
    label: string;
}

export interface ConfigMigrationLogger {
    warn?: (msg: string) => void;
    info?: (msg: string) => void;
    log?: (msg: string) => void;
}

export interface ConfigFileMigrationOptions {
    scope: "user" | "project";
    targetPath: string;
    legacySources: readonly LegacyConfigSource[];
    logger?: ConfigMigrationLogger;
}

export interface ConfigFileMigrationResult {
    migrated: boolean;
    conflict: boolean;
    sourcePath?: string;
    targetPath: string;
    warnings: string[];
}

const CONFIG_FILE_BASENAME = "magic-context";
const MOVED_MARKER_SUFFIX = ".MOVED_READPLEASE";

// ── Path resolution ──────────────────────────────────────────

function homeDir(): string {
    if (process.platform === "win32") {
        return process.env.USERPROFILE || process.env.HOME || homedir();
    }
    return process.env.HOME || homedir();
}

function configHome(): string {
    const xdg = process.env.XDG_CONFIG_HOME;
    if (xdg && isAbsolute(xdg)) return xdg;
    return join(homeDir(), ".config");
}

/** `~/.config/cortexkit/magic-context` (no extension — for detectConfigFile). */
export function cortexKitUserConfigBasePath(): string {
    return join(configHome(), "cortexkit", CONFIG_FILE_BASENAME);
}

/** `<root>/.cortexkit/magic-context` (no extension — for detectConfigFile). */
export function cortexKitProjectConfigBasePath(directory: string): string {
    return join(directory, ".cortexkit", CONFIG_FILE_BASENAME);
}

/** The migration target: always normalized to `.jsonc`. */
export function resolveCortexKitUserConfigPath(): string {
    return `${cortexKitUserConfigBasePath()}.jsonc`;
}

/** The migration target: always normalized to `.jsonc`. */
export function resolveCortexKitProjectConfigPath(directory: string): string {
    return `${cortexKitProjectConfigBasePath(directory)}.jsonc`;
}

function legacySourcesForBase(basePath: string, label: string): LegacyConfigSource[] {
    return [
        { path: `${basePath}.jsonc`, label: `${label} magic-context.jsonc` },
        { path: `${basePath}.json`, label: `${label} magic-context.json` },
    ];
}

/**
 * Every user-scope config path the migrator knows: the CortexKit user target
 * plus the user legacy sources. A project-scope migration must NEVER move any of
 * these (they are user-scope files, not project files).
 */
function userScopeConfigPaths(): Set<string> {
    return new Set<string>([
        // The CortexKit user target, both extensions: the bare-root project
        // source produces `.jsonc` AND `.json`, so exclude both or a stray
        // `~/.config/cortexkit/magic-context.json` would still be eaten.
        `${cortexKitUserConfigBasePath()}.jsonc`,
        `${cortexKitUserConfigBasePath()}.json`,
        join(configHome(), "opencode", `${CONFIG_FILE_BASENAME}.jsonc`),
        join(configHome(), "opencode", `${CONFIG_FILE_BASENAME}.json`),
        join(homeDir(), ".pi", "agent", `${CONFIG_FILE_BASENAME}.jsonc`),
        join(homeDir(), ".pi", "agent", `${CONFIG_FILE_BASENAME}.json`),
    ]);
}

/**
 * The legacy config locations to migrate FROM, by scope. Each base produces a
 * `.jsonc` and a `.json` candidate; whichever exists migrates, target is always
 * `.jsonc`. The bare-root project source (`<root>/magic-context.*`) is unique to
 * Magic Context (AFT never had it) — omitting it would orphan repo-root configs.
 *
 * Project sources are filtered against the user-scope path set: when a session's
 * project directory IS the user config home (e.g. opencode opened in
 * `~/.config/cortexkit`), the bare-root project source `<root>/magic-context.jsonc`
 * resolves to the USER config path. Without this guard the project migration
 * would "migrate" the user's own config into `<root>/.cortexkit/` and rename the
 * original aside, leaving the user on schema defaults (the config-eats-itself
 * bug). A project migration must never touch a user-scope file.
 */
export function resolveLegacyConfigSources(directory: string): {
    user: LegacyConfigSource[];
    project: LegacyConfigSource[];
} {
    const userPaths = userScopeConfigPaths();
    return {
        user: [
            ...legacySourcesForBase(
                join(configHome(), "opencode", CONFIG_FILE_BASENAME),
                "OpenCode user",
            ),
            ...legacySourcesForBase(
                join(homeDir(), ".pi", "agent", CONFIG_FILE_BASENAME),
                "Pi user",
            ),
        ],
        project: [
            ...legacySourcesForBase(join(directory, CONFIG_FILE_BASENAME), "project root"),
            ...legacySourcesForBase(
                join(directory, ".opencode", CONFIG_FILE_BASENAME),
                "OpenCode project",
            ),
            ...legacySourcesForBase(join(directory, ".pi", CONFIG_FILE_BASENAME), "Pi project"),
        ].filter((source) => !userPaths.has(source.path)),
    };
}

export type ConfigHarness = "opencode" | "pi";

/**
 * Legacy sources owned by ONE harness, most-specific first. Used by the loaders
 * as a NON-DESTRUCTIVE read fallback: when the shared CortexKit base is absent
 * (migration not yet run, or refused because OpenCode and Pi legacy configs
 * differ), the running harness reads its OWN legacy config rather than silently
 * falling back to schema defaults — which would re-enable features the legacy
 * config disabled. Each harness reads only its own files, so a differing pair
 * stays correct per-harness until the user consolidates. The bare project-root
 * `<root>/magic-context.*` was OpenCode-only historically.
 */
export function resolveLegacyConfigSourcesForHarness(
    directory: string,
    harness: ConfigHarness,
): { user: LegacyConfigSource[]; project: LegacyConfigSource[] } {
    if (harness === "pi") {
        return {
            user: legacySourcesForBase(
                join(homeDir(), ".pi", "agent", CONFIG_FILE_BASENAME),
                "Pi user",
            ),
            project: legacySourcesForBase(
                join(directory, ".pi", CONFIG_FILE_BASENAME),
                "Pi project",
            ),
        };
    }
    return {
        user: legacySourcesForBase(
            join(configHome(), "opencode", CONFIG_FILE_BASENAME),
            "OpenCode user",
        ),
        project: [
            ...legacySourcesForBase(join(directory, CONFIG_FILE_BASENAME), "project root"),
            ...legacySourcesForBase(
                join(directory, ".opencode", CONFIG_FILE_BASENAME),
                "OpenCode project",
            ),
        ],
    };
}

// ── JSONC semantics comparison (dependency-free, ported from AFT) ─────────────
// A legacy source that semantically MATCHES an existing target is moved aside
// (target wins); one that DIFFERS triggers refuse-and-warn (never auto-clobber).
// We strip comments/trailing-commas and sort keys so formatting/comment/order
// differences don't read as a conflict.

function stripJsoncForParse(input: string): string {
    let out = "";
    let inString = false;
    let escaped = false;
    for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        const next = input[i + 1];
        if (inString) {
            out += ch;
            if (escaped) escaped = false;
            else if (ch === "\\") escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
            out += ch;
            continue;
        }
        if (ch === "/" && next === "/") {
            while (i < input.length && input[i] !== "\n") i++;
            out += "\n";
            continue;
        }
        if (ch === "/" && next === "*") {
            i += 2;
            while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
            i++;
            out += " ";
            continue;
        }
        out += ch;
    }
    let withoutTrailingCommas = "";
    inString = false;
    escaped = false;
    for (let i = 0; i < out.length; i++) {
        const ch = out[i];
        if (inString) {
            withoutTrailingCommas += ch;
            if (escaped) escaped = false;
            else if (ch === "\\") escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
            withoutTrailingCommas += ch;
            continue;
        }
        if (ch === ",") {
            let j = i + 1;
            while (j < out.length && /\s/.test(out[j])) j++;
            if (out[j] === "}" || out[j] === "]") continue;
        }
        withoutTrailingCommas += ch;
    }
    return withoutTrailingCommas;
}

function sortJson(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortJson);
    if (value && typeof value === "object") {
        const sorted: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) {
            if (key === "protected_tags" || key === "clear_reasoning_age") continue;
            sorted[key] = sortJson((value as Record<string, unknown>)[key]);
        }
        return sorted;
    }
    return value;
}

function normalizedJsoncSemantics(content: string): string {
    return JSON.stringify(sortJson(JSON.parse(stripJsoncForParse(content))));
}

function fileSemanticsMatch(a: string, b: string): boolean {
    try {
        return normalizedJsoncSemantics(a) === normalizedJsoncSemantics(b);
    } catch {
        // If either side can't be parsed (truly malformed), fall back to an
        // exact-bytes comparison — a parse-broken legacy file that differs byte
        // for byte is conservatively treated as a conflict, never auto-clobbered.
        return a === b;
    }
}

// ── Cross-process lock (Desktop runs many instances concurrently) ────────────

// A real migration is a sub-second rename+write, so a lock older than this was
// almost certainly left by a crashed holder and is safe to reclaim.
const CONFIG_LOCK_STALE_MS = 4_000;

/**
 * Directory-mkdir lock. `mkdir` is atomic; EEXIST means another instance holds
 * it. We do NOT block plugin init: migration is not correctness-critical this
 * run (the loaders read-legacy-on-conflict when the CortexKit base is absent),
 * so on a LIVE competing holder we return null immediately and skip migration
 * this run — the holder finishes its sub-second rename+write, and the next init
 * sees target-present and consolidates. The ONLY retry is a single one-shot
 * stale reclaim: a crashed holder's lock dir (older than the stale threshold) is
 * removed and we re-attempt mkdir once. No busy-wait, no synchronous sleep — the
 * init path never blocks on lock contention.
 */
function acquireConfigMigrationLock(lockDir: string): (() => void) | null {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            ensureStorageDirectorySync(lockDir, true, false);
            return () => {
                try {
                    rmSync(lockDir, { recursive: true, force: true });
                } catch {
                    // best-effort lock cleanup
                }
            };
        } catch (err) {
            const code = (err as { code?: unknown })?.code;
            if (code !== "EEXIST") throw err;
            // EEXIST: another instance holds the lock. Reclaim ONLY if it's stale
            // (crashed holder) and retry mkdir once; otherwise a live holder owns
            // it → skip this run rather than block init.
            try {
                const ageMs = Date.now() - statSync(lockDir).mtimeMs;
                if (ageMs > CONFIG_LOCK_STALE_MS) {
                    rmSync(lockDir, { recursive: true, force: true });
                    continue;
                }
            } catch {
                // Lock vanished between stat and now — retry mkdir once.
                continue;
            }
            return null;
        }
    }
    return null;
}

// ── Atomic writes ────────────────────────────────────────────

function atomicWriteConfigFile(targetPath: string, content: string): void {
    writeStorageFileAtomicSync(targetPath, content, true);
}

// ── Marker ───────────────────────────────────────────────────

function movedMarkerContent(
    targetPath: string,
    originalName: string,
    originalContent: string,
): string {
    const header = [
        "// Magic Context configuration moved.",
        "//",
        "// Magic Context now reads its configuration from one shared CortexKit",
        "// location instead of a per-agent path. The settings that were in this",
        "// file have been moved to:",
        "//",
        `//     ${targetPath}`,
        "//",
        "// Edit that file to change Magic Context settings. This location is no",
        "// longer read by Magic Context.",
        "//",
        `// To undo, rename this file back to "${originalName}" (and remove the`,
        "// CortexKit copy above if you want this location to take precedence).",
        "//",
        "// Your original settings are preserved below for reference.",
        "",
        "",
    ].join("\n");
    return `${header}${originalContent}`;
}

/**
 * After the live config is safely at the CortexKit target, rename each legacy
 * source aside to `<name>.MOVED_READPLEASE` so a user editing the old path
 * notices it is no longer read (a copy-in-place leaves a silent stale-edit
 * trap). A failure here is non-fatal: the content is already at the target, so
 * we warn and leave the legacy file in place.
 */
function markLegacySourcesMovedAside(
    sources: readonly { path: string }[],
    targetPath: string,
    logger?: ConfigMigrationLogger,
): string[] {
    const warnings: string[] = [];
    const info = logger?.info ?? logger?.log;
    for (const source of sources) {
        const markerPath = `${source.path}${MOVED_MARKER_SUFFIX}`;
        try {
            const original = readFileSync(source.path, "utf-8");
            atomicWriteConfigFile(
                markerPath,
                movedMarkerContent(targetPath, basename(source.path), original),
            );
            unlinkSync(source.path);
            info?.(
                `Moved legacy Magic Context config ${source.path} aside to ${markerPath}; now reading ${targetPath}`,
            );
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            warnings.push(
                `Magic Context could not move legacy config ${source.path} aside (${msg}); it is now stale and ignored. Delete it manually — config is read from ${targetPath}.`,
            );
            logger?.warn?.(
                `Could not move legacy Magic Context config ${source.path} aside (${msg}); reading ${targetPath}`,
            );
        }
    }
    return warnings;
}

function visibleConfigMigrationWarning(
    scope: "user" | "project",
    targetPath: string,
    paths: readonly string[],
    reason: string,
): string {
    const uniquePaths = [...new Set([targetPath, ...paths])];
    return (
        `Magic Context ${scope} config migration refused: ${reason}. ` +
        `Legacy and CortexKit config paths collapse to one file, but Magic Context will not overwrite or merge them automatically. ` +
        `Please consolidate manually into ${targetPath}. Paths: ${uniquePaths.join(" ; ")}`
    );
}

// ── Core per-file migration (ported from AFT migrateAftConfigFile) ───────────

export function migrateConfigFile(opts: ConfigFileMigrationOptions): ConfigFileMigrationResult {
    const warnings: string[] = [];
    const existingSources = opts.legacySources.filter((source) => existsSync(source.path));
    const info = opts.logger?.info ?? opts.logger?.log;

    if (existingSources.length === 0) {
        return { migrated: false, conflict: false, targetPath: opts.targetPath, warnings };
    }

    ensureStorageDirectorySync(dirname(opts.targetPath), true);
    const release = acquireConfigMigrationLock(`${opts.targetPath}.lock`);
    if (!release) {
        // Another instance holds the lock past our short budget. Skip rather than
        // block init; the loaders read-legacy-on-conflict so config is correct
        // this run, and the next init retries the migration.
        warnings.push(
            `Config migration for ${opts.scope} skipped this run (another instance is migrating); will retry on next start.`,
        );
        return { migrated: false, conflict: false, targetPath: opts.targetPath, warnings };
    }
    try {
        const sources = existingSources.map((source) => ({
            ...source,
            content: readFileSync(source.path, "utf-8"),
        }));

        if (existsSync(opts.targetPath)) {
            const targetContent = readFileSync(opts.targetPath, "utf-8");
            const differing = sources.filter(
                (source) => !fileSemanticsMatch(source.content, targetContent),
            );
            if (differing.length > 0) {
                const message = visibleConfigMigrationWarning(
                    opts.scope,
                    opts.targetPath,
                    differing.map((source) => source.path),
                    "the CortexKit target already exists with different settings",
                );
                warnings.push(message);
                opts.logger?.warn?.(message);
                return { migrated: false, conflict: true, targetPath: opts.targetPath, warnings };
            }
            info?.(
                `Magic Context ${opts.scope} config already present at ${opts.targetPath}; legacy copies match`,
            );
            warnings.push(...markLegacySourcesMovedAside(sources, opts.targetPath, opts.logger));
            return { migrated: false, conflict: false, targetPath: opts.targetPath, warnings };
        }

        const first = sources[0];
        const differing = sources.filter(
            (source) => !fileSemanticsMatch(source.content, first.content),
        );
        if (differing.length > 0) {
            const message = visibleConfigMigrationWarning(
                opts.scope,
                opts.targetPath,
                sources.map((source) => source.path),
                "multiple legacy sources have different settings",
            );
            warnings.push(message);
            opts.logger?.warn?.(message);
            return { migrated: false, conflict: true, targetPath: opts.targetPath, warnings };
        }

        let migratedContent = first.content;
        let strippedProtectedTags = false;
        try {
            const stripped = removeJsoncValue(removeJsoncValue(first.content, ["protected_tags"]), [
                "clear_reasoning_age",
            ]);
            if (stripped !== first.content) {
                migratedContent = stripped;
                strippedProtectedTags = true;
            }
        } catch {
            // Keep original content if jsonc editing fails
        }

        atomicWriteConfigFile(opts.targetPath, migratedContent);
        if (strippedProtectedTags) {
            if (first.content.includes('"protected_tags"'))
                info?.(`Stripped deprecated "protected_tags" key during config location migration`);
            if (first.content.includes('"clear_reasoning_age"'))
                info?.(
                    `Stripped deprecated "clear_reasoning_age" key during config location migration`,
                );
        }
        info?.(
            `Migrated Magic Context ${opts.scope} config from ${first.path} to ${opts.targetPath}`,
        );
        warnings.push(...markLegacySourcesMovedAside(sources, opts.targetPath, opts.logger));
        return {
            migrated: true,
            conflict: false,
            sourcePath: first.path,
            targetPath: opts.targetPath,
            warnings,
        };
    } catch (err) {
        const message = visibleConfigMigrationWarning(
            opts.scope,
            opts.targetPath,
            existingSources.map((source) => source.path),
            `migration failed (${err instanceof Error ? err.message : String(err)})`,
        );
        warnings.push(message);
        opts.logger?.warn?.(message);
        return { migrated: false, conflict: true, targetPath: opts.targetPath, warnings };
    } finally {
        release();
    }
}

/**
 * Run both the user-scope and project-scope config-location migrations for a
 * project directory. Idempotent and cheap when nothing to migrate (a few
 * existsSync calls). Call once at plugin init, before loading config. Returns
 * any warnings (conflicts / partial failures) for the host to surface + log.
 */
export function migrateMagicContextConfigLocations(
    directory: string,
    logger?: ConfigMigrationLogger,
): string[] {
    const warnings: string[] = [];
    const legacy = resolveLegacyConfigSources(directory);
    try {
        warnings.push(
            ...migrateConfigFile({
                scope: "user",
                targetPath: resolveCortexKitUserConfigPath(),
                legacySources: legacy.user,
                logger,
            }).warnings,
        );
        warnings.push(
            ...migrateConfigFile({
                scope: "project",
                targetPath: resolveCortexKitProjectConfigPath(directory),
                legacySources: legacy.project,
                logger,
            }).warnings,
        );
    } catch (err) {
        // Fail OPEN: a migration failure must never abort plugin init. Worst
        // case the loader reads the CortexKit path (possibly empty) and a legacy
        // file is left in place for the user to consolidate.
        const msg = err instanceof Error ? err.message : String(err);
        logger?.warn?.(`Magic Context config-location migration error (continuing): ${msg}`);
        warnings.push(`Magic Context config-location migration error: ${msg}`);
    }
    return warnings;
}
