import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadPluginConfig } from "@magic-context/core/config";
import { substituteConfigVariables } from "@magic-context/core/config/variable";

import {
    type EmbeddingProbeOutcome,
    probeEmbeddingEndpoint,
} from "@magic-context/core/features/magic-context/memory/embedding-probe";
import { closeDatabase, openDatabase } from "@magic-context/core/features/magic-context/storage";
import { detectConflicts } from "@magic-context/core/shared/conflict-detector";
import { fixConflicts } from "@magic-context/core/shared/conflict-fixer";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { Database } from "@magic-context/core/shared/sqlite";
import { ensureTuiPluginEntry } from "@magic-context/core/shared/tui-config";
import { parse, stringify } from "comment-json";
import { isDevPathPluginEntry, matchesPluginEntry } from "../adapters/opencode";
import { writeFileAtomic } from "../lib/atomic-write";
import { migrateConfigLocationsForCli } from "../lib/config-location-migration";
import { collectDiagnostics } from "../lib/diagnostics-opencode";
import { checkLocalEmbeddingRuntime } from "../lib/embedding-runtime";
import { bundleIssueReport } from "../lib/logs-opencode";
import { migrateDreamerV2ForDoctor } from "../lib/migrate-dreamer-v2-doctor";
import { migrateExperimentalPinKeyFilesForDoctor } from "../lib/migrate-experimental-doctor";
import { isOpenCodeInstalled } from "../lib/opencode-helpers";
import {
    getOpenCodePluginCacheRoots,
    OPENCODE_PLUGIN_ENTRY_WITH_VERSION as PLUGIN_ENTRY_WITH_VERSION,
    OPENCODE_PLUGIN_NAME as PLUGIN_NAME,
} from "../lib/opencode-plugin-cache";
import { detectConfigPaths, getMagicContextLogPath } from "../lib/paths";
import { confirm, intro, log, outro, selectOne, spinner, text } from "../lib/prompts";
import { runV22BackfillCommands, type V22BackfillCommandArgs } from "../lib/v22-backfill-commands";
import { clearPluginCache } from "./doctor-opencode-cache";

const CLI_PACKAGE_NAME = "@cortexkit/magic-context";

export interface DoctorMigrationLogSink {
    success(message: string): void;
    warn(message: string): void;
}

export function migrateLegacyAgentEnabledConfigForDoctor(
    mcConfig: Record<string, unknown>,
    logs: DoctorMigrationLogSink,
): { changed: boolean; fixes: number } {
    let changed = false;
    let fixes = 0;

    const migrateLegacyAgentEnabled = (agentName: "dreamer" | "sidekick" | "historian"): void => {
        const agent = mcConfig[agentName] as Record<string, unknown> | undefined;
        if (!agent || typeof agent !== "object" || !("enabled" in agent)) return;

        const enabled = agent.enabled;
        const disable = agent.disable;
        delete agent.enabled;
        changed = true;
        fixes++;

        if (agentName === "historian") {
            logs.success(
                "Removed invalid historian.enabled (historian uses disable=true to turn off).",
            );
            return;
        }

        if (agentName === "dreamer") {
            if (disable !== true && enabled === false) {
                agent.disable = true;
                logs.warn(
                    "Migrated dreamer.enabled=false → dreamer.disable=true. This now also disables manual /ctx-dream. To keep manual dreaming, remove disable=true and set schedule to empty string.",
                );
            } else {
                logs.success(
                    'Removed deprecated dreamer.enabled (use dreamer.disable=true to turn off the Dreamer agent; use schedule="" for manual-only dreaming).',
                );
            }
            return;
        }

        if (disable !== true && enabled === false) {
            agent.disable = true;
            logs.success("Migrated sidekick.enabled=false → sidekick.disable=true.");
        } else {
            logs.success(
                "Removed deprecated sidekick.enabled (use sidekick.disable=true to turn off Sidekick).",
            );
        }
    };

    migrateLegacyAgentEnabled("dreamer");
    migrateLegacyAgentEnabled("sidekick");
    migrateLegacyAgentEnabled("historian");

    return { changed, fixes };
}

/**
 * Fetch the latest version of an npm package from the registry. Returns null
 * on any error so the doctor can report "check unavailable" rather than fail.
 */
async function fetchNpmLatest(pkg: string, timeoutMs = 5000): Promise<string | null> {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, {
                signal: controller.signal,
                headers: { Accept: "application/json" },
            });
            if (!res.ok) return null;
            const body = (await res.json()) as { version?: unknown };
            return typeof body.version === "string" ? body.version : null;
        } finally {
            clearTimeout(timer);
        }
    } catch {
        return null;
    }
}

/** Self-version with src/dist layout fallback. */
function getSelfVersion(): string {
    const req = createRequire(import.meta.url);
    for (const relPath of ["../../package.json", "../package.json"]) {
        try {
            const pkg = req(relPath) as { version?: unknown };
            if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
        } catch {
            // try next
        }
    }
    return "0.0.0";
}

/** Compare semver-like strings. Returns -1 if a<b, 0 if equal, 1 if a>b. */
function compareVersions(a: string, b: string): number {
    const pa = a.split(/[.-]/).map((s) => Number.parseInt(s, 10));
    const pb = b.split(/[.-]/).map((s) => Number.parseInt(s, 10));
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const x = pa[i] ?? 0;
        const y = pb[i] ?? 0;
        if (Number.isNaN(x) || Number.isNaN(y)) return 0;
        if (x < y) return -1;
        if (x > y) return 1;
    }
    return 0;
}

// ── Issue flow ──────────────────────────────────────────────────────

function isGhInstalled(): boolean {
    try {
        execSync("gh --version", { stdio: "pipe" });
        return true;
    } catch {
        return false;
    }
}

function openBrowser(url: string): void {
    try {
        if (process.platform === "darwin") {
            const child = spawnSync("open", [url], { stdio: "ignore" });
            if (child.status === 0) return;
        } else if (process.platform === "linux") {
            const child = spawnSync("xdg-open", [url], { stdio: "ignore" });
            if (child.status === 0) return;
        } else if (process.platform === "win32") {
            const child = spawnSync("cmd", ["/c", "start", "", url], { stdio: "ignore" });
            if (child.status === 0) return;
        }
    } catch {
        // Best-effort only.
    }
}

async function runIssueFlow(): Promise<number> {
    intro("Magic Context Issue Report");

    const title = await text("Issue title", {
        placeholder: "Short summary of the problem",
        validate: (value) => (value.trim() ? undefined : "Title is required"),
    });
    const description = await text("Issue description", {
        placeholder: "Describe what happened, what you expected, and repro steps",
        validate: (value) => (value.trim() ? undefined : "Description is required"),
    });

    const s = spinner();
    s.start("Collecting diagnostics");

    try {
        const report = await collectDiagnostics();
        s.stop("Diagnostics collected");

        // Ask the user which session this issue relates to. Only show the
        // picker when there's more than one recent session — otherwise the
        // single-session case is unambiguous, and the no-session case
        // (Node-only run without bun:sqlite) skips filtering entirely.
        let sessionFilter: string | null = null;
        if (report.recentSessions.length > 1) {
            const choice = await selectOne(
                "Which session is this issue about? (filters log lines from other sessions)",
                [
                    ...report.recentSessions.map((session, index) => {
                        const displayTitle = session.title.trim() || "(no title)";
                        const truncatedTitle =
                            displayTitle.length > 50
                                ? `${displayTitle.slice(0, 47)}...`
                                : displayTitle;
                        return {
                            label: `${truncatedTitle} — ${session.sessionId}${index === 0 ? " (most recent)" : ""}`,
                            value: session.sessionId,
                        };
                    }),
                    {
                        label: "All sessions (no filtering)",
                        value: "__all__",
                    },
                ],
            );
            sessionFilter = choice === "__all__" ? null : choice;
        }

        s.start("Bundling issue report");
        const bundled = await bundleIssueReport(report, description, title, sessionFilter);
        s.stop(`Report written to ${bundled.path}`);

        const shouldSubmit = await confirm("Submit this issue on GitHub now?", true);
        if (shouldSubmit && isGhInstalled()) {
            const result = spawnSync(
                "gh",
                [
                    "issue",
                    "create",
                    "-R",
                    "cortexkit/magic-context",
                    "--title",
                    title,
                    "--body-file",
                    bundled.path,
                ],
                { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
            );

            if (result.status === 0) {
                log.success(result.stdout.trim());
                outro("Issue submitted — thanks for the report!");
                return 0;
            }

            log.warn(result.stderr.trim() || "gh issue create failed");
        } else if (shouldSubmit && !isGhInstalled()) {
            log.warn("gh CLI not found — falling back to browser");
        }

        const url = `https://github.com/cortexkit/magic-context/issues/new?title=${encodeURIComponent(title)}&template=bug_report.yml`;
        log.info(
            `Open this URL and paste the contents of ${bundled.path} into the Diagnostics field:`,
        );
        log.info(url);
        openBrowser(url);
        outro("Issue report ready");
        return 0;
    } catch (error) {
        s.stop("Diagnostic collection failed");
        log.error(error instanceof Error ? error.message : String(error));
        outro("Issue report failed");
        return 1;
    }
}

// ── Embedding configuration check ───────────────────────────────────

/**
 * Validate the user's embedding configuration by probing the configured
 * endpoint. Runs only for `openai-compatible` providers — `local` needs no
 * network check and `off` degrades cleanly by design.
 *
 * Known footguns we surface specifically:
 *   - `{env:VAR}` in api_key when VAR is not exported → auth will fail with
 *     a literal `Bearer {env:VAR}` header.
 *   - Endpoint pointing at a specific route (e.g. `.../chat/completions`)
 *     rather than the provider base (e.g. `.../v1`) — gets detected by the
 *     real probe returning 404/405.
 *   - Provider that accepts the URL shape but doesn't implement embeddings
 *     (OpenRouter's /v1 for example) — same detection path.
 */
// Local embeddings need the native ONNX runtime (onnxruntime-node). On Windows
// it sometimes fails to install (its native binary download is interrupted), and
// the plugin's static `import "onnxruntime-node"` then throws on every embedding
// (#128). Surface it here with the fix instead of leaving users with the cryptic
// resolver error in the log. Shared by the explicit-`local` branch AND the
// no-config / default-provider path (local is the default, so a missing config
// still means local embeddings).
function checkLocalEmbeddingRuntimeForDoctor(): { issues: number; localRuntimeBroken?: boolean } {
    const runtime = checkLocalEmbeddingRuntime(getOpenCodePluginCacheRoots());
    if (runtime.state === "package-missing" || runtime.state === "binary-missing") {
        log.warn(
            "Embedding provider: local — but the native runtime (onnxruntime-node) " +
                `is ${runtime.state === "package-missing" ? "not installed" : "missing its platform binary"}. ` +
                "Local embeddings won't work. Fix: re-run with `doctor --force` to reinstall " +
                "the plugin, or set `embedding.provider` to `openai-compatible` (LM Studio / " +
                "Ollama) or `off`. Existing memories are unaffected.",
        );
        return { issues: 1, localRuntimeBroken: true };
    }
    log.success("Embedding provider: local (Xenova/all-MiniLM-L6-v2 bundled)");
    return { issues: 0 };
}

async function checkEmbeddingConfig(
    magicContextConfigPath: string,
): Promise<{ issues: number; localRuntimeBroken?: boolean }> {
    if (!existsSync(magicContextConfigPath)) {
        // No config → local provider defaults apply. Still verify the local
        // runtime: local is the DEFAULT, so "no config" means local embeddings,
        // and a broken onnxruntime-node would silently fail (#128/#6).
        return checkLocalEmbeddingRuntimeForDoctor();
    }

    let rawText: string;
    try {
        rawText = readFileSync(magicContextConfigPath, "utf-8");
    } catch {
        log.warn("Could not read magic-context.jsonc for embedding check");
        return { issues: 1 };
    }

    // Substitute {env:} and {file:} before parsing so api_key / endpoint
    // reflect the values the runtime will actually see, and so we can report
    // unresolved tokens as concrete issues.
    const substituted = substituteConfigVariables({
        text: rawText,
        configPath: magicContextConfigPath,
    });

    let parsedConfig: Record<string, unknown>;
    try {
        parsedConfig = parse(substituted.text) as Record<string, unknown>;
    } catch (error) {
        log.warn(
            `Embedding check skipped — could not parse magic-context.jsonc: ${error instanceof Error ? error.message : String(error)}`,
        );
        return { issues: 1 };
    }

    const embedding = parsedConfig?.embedding as Record<string, unknown> | undefined;
    const provider = embedding?.provider;

    if (provider === "off") {
        log.info("Embedding provider disabled — semantic memory search is off");
        return { issues: 0 };
    }

    if (provider === undefined || provider === "local") {
        return checkLocalEmbeddingRuntimeForDoctor();
    }

    if (provider !== "openai-compatible") {
        log.warn(
            `Unknown embedding provider: ${String(provider)} (expected local | openai-compatible | off)`,
        );
        return { issues: 1 };
    }

    const endpoint = typeof embedding?.endpoint === "string" ? embedding.endpoint.trim() : "";
    const model = typeof embedding?.model === "string" ? embedding.model.trim() : "";
    const apiKey = typeof embedding?.api_key === "string" ? embedding.api_key : undefined;
    const inputType =
        typeof embedding?.input_type === "string" ? embedding.input_type.trim() : undefined;
    const truncateMode =
        typeof embedding?.truncate === "string" ? embedding.truncate.trim() : undefined;

    let localIssues = 0;

    // Static configuration hygiene checks — raise before the network probe so
    // users get the specific guidance even when they're offline.
    if (!endpoint) {
        log.error("Embedding provider is openai-compatible but 'endpoint' is missing");
        return { issues: 1 };
    }
    if (!model) {
        log.error("Embedding provider is openai-compatible but 'model' is missing");
        return { issues: 1 };
    }

    // Flag unresolved {env:} residue — the substitution pass above would have
    // replaced resolved tokens, so any leftover {env: here means either the
    // env var was missing or the user wrote the literal text.
    if (apiKey && /\{env:[^}]+\}/.test(apiKey)) {
        log.warn(
            "api_key still contains {env:...} after substitution — the referenced environment variable is not set in this shell",
        );
        log.info(`  Raw value: ${apiKey}`);
        log.info(
            "  Export the variable before launching OpenCode (e.g. in ~/.zshrc, ~/.bashrc, or a shell profile)",
        );
        localIssues++;
    }

    // Surface any substitution warnings for the *user* config — we can't
    // tell which substitutions fed the embedding block specifically, but if
    // the block is broken and there are env-var warnings, they're almost
    // certainly related.
    if (substituted.warnings.length > 0) {
        for (const w of substituted.warnings.slice(0, 3)) {
            log.info(`  ${w}`);
        }
        if (substituted.warnings.length > 3) {
            log.info(`  ... and ${substituted.warnings.length - 3} more`);
        }
    }

    // Run the live probe.
    const probeSpinner = spinner();
    probeSpinner.start(`Testing embedding endpoint ${endpoint} (model: ${model})`);

    let outcome: EmbeddingProbeOutcome;
    try {
        outcome = await probeEmbeddingEndpoint({
            endpoint,
            model,
            apiKey: apiKey,
            ...(inputType ? { inputType } : {}),
            ...(truncateMode ? { truncate: truncateMode } : {}),
            timeoutMs: 10_000,
        });
    } catch (error) {
        probeSpinner.stop("Embedding probe failed unexpectedly");
        log.error(`Probe threw: ${error instanceof Error ? error.message : String(error)}`);
        return { issues: localIssues + 1 };
    }

    probeSpinner.stop("Embedding endpoint probed");

    switch (outcome.kind) {
        case "ok":
            log.success(
                `Embedding endpoint OK (${outcome.status}, ${outcome.dimensions ?? "?"}-dim vectors)`,
            );
            return { issues: localIssues };
        case "auth_failed":
            log.error(
                `Embedding endpoint rejected credentials (${outcome.status}) — check api_key / env var`,
            );
            if (outcome.preview) log.info(`  ${outcome.preview}`);
            return { issues: localIssues + 1 };
        case "endpoint_unsupported":
            log.error(`Embedding endpoint does not support embeddings (${outcome.status})`);
            if (outcome.preview) log.info(`  ${outcome.preview}`);
            log.info(
                "  Common causes: endpoint points at a chat-completion route (should be the provider base, e.g. '.../v1'), or the provider doesn't offer an embeddings API",
            );
            log.info(
                "  Known non-embedding providers: OpenRouter (chat proxy), Anthropic (no embeddings endpoint). Use OpenAI, Voyage, Together, or a local provider instead.",
            );
            return { issues: localIssues + 1 };
        case "http_error":
            log.error(`Embedding endpoint returned ${outcome.status}`);
            if (outcome.preview) log.info(`  ${outcome.preview}`);
            return { issues: localIssues + 1 };
        case "timeout":
            log.warn(
                `Embedding endpoint did not respond within ${outcome.timeoutMs}ms — check endpoint URL and network`,
            );
            return { issues: localIssues + 1 };
        case "network_error":
            log.error(`Could not reach embedding endpoint: ${outcome.message}`);
            return { issues: localIssues + 1 };
        case "invalid_scheme":
            log.error(
                `Embedding endpoint must start with http:// or https://: ${outcome.endpoint}`,
            );
            return { issues: localIssues + 1 };
    }
}

// ── Main doctor entry ───────────────────────────────────────────────

export async function runDoctor(
    options: { force?: boolean; issue?: boolean } & V22BackfillCommandArgs = {},
): Promise<number> {
    migrateConfigLocationsForCli(process.cwd(), log);

    if (options.issue) {
        return runIssueFlow();
    }

    const v22Result = await runV22BackfillCommands(
        {
            name: "OpenCode",
            openDatabase,
            closeDatabase,
            log,
        },
        options,
    );
    if (v22Result.handled) {
        return v22Result.exitCode;
    }

    intro("Magic Context Doctor");

    let issues = 0;
    let fixed = 0;
    // Aligned with Pi doctor: emit a PASS/WARN/FAIL summary at the end so
    // results are scannable.
    let passCount = 0;
    let warnCount = 0;
    let failCount = 0;
    const pass = (msg: string) => {
        log.success(msg);
        passCount++;
    };
    const warn = (msg: string) => {
        log.warn(msg);
        warnCount++;
    };
    const fail = (msg: string) => {
        log.error(msg);
        failCount++;
        issues++;
    };

    // 1. Check OpenCode is installed
    if (!isOpenCodeInstalled()) {
        fail("OpenCode is not installed or not in PATH");
        // Help users whose binary IS on PATH but is shadowed by a wrapper
        // script or lives in a directory not searched by our detection
        // (e.g. tool-version shims that only inject PATH at shell time).
        log.info("Doctor checked ~/.opencode/bin/opencode and each entry in $PATH.");
        log.info(
            "If `which opencode` succeeds outside doctor, your wrapper or shim may not be readable by Node — please share that wrapper in the issue.",
        );
        outro("Doctor failed — install OpenCode first");
        return 1;
    }
    pass("OpenCode installed");

    // 1b. CLI vs npm latest
    const selfVersion = getSelfVersion();
    const [npmLatest, pluginNpmLatest] = await Promise.all([
        fetchNpmLatest(CLI_PACKAGE_NAME),
        fetchNpmLatest(PLUGIN_NAME),
    ]);
    if (!npmLatest) {
        log.info(`Magic Context CLI v${selfVersion}; npm latest check unavailable`);
    } else if (compareVersions(selfVersion, npmLatest) < 0) {
        warn(`Magic Context CLI v${selfVersion} is older than npm latest v${npmLatest}`);
    } else {
        pass(`Magic Context CLI v${selfVersion} is current (npm latest v${npmLatest})`);
    }

    // 2. Check config paths exist
    const paths = detectConfigPaths();

    if (paths.opencodeConfigFormat === "none") {
        fail(`No opencode.json found at ${paths.opencodeConfig}`);
    } else {
        pass(`OpenCode config: ${paths.opencodeConfig}`);
    }

    // 3. Check magic-context.jsonc exists + parses + loads through schema
    if (existsSync(paths.magicContextConfig)) {
        pass(`Magic Context config: ${paths.magicContextConfig}`);
        // 3a. Validate JSONC parses (with config-variable substitution)
        try {
            const raw = readFileSync(paths.magicContextConfig, "utf-8");
            const substituted = substituteConfigVariables({
                text: raw,
                configPath: paths.magicContextConfig,
            }).text;
            parse(substituted);
            pass("magic-context.jsonc parses as valid JSONC");
        } catch (err) {
            fail(
                `magic-context.jsonc parse failed: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
        // 3b. Validate config loads through plugin schema. loadPluginConfig
        // recovers from invalid leaf settings field-by-field and surfaces
        // soft warnings via configWarnings, so we can ask the schema to
        // load and report them without bailing on the doctor run.
        try {
            const result = loadPluginConfig(process.cwd());
            const warnings = result.configWarnings ?? [];
            if (warnings.length > 0) {
                warn(
                    `Magic Context config has ${warnings.length} warning(s) — see 'magic-context doctor --issue' for details`,
                );
            } else {
                pass("Magic Context config loads successfully");
            }
        } catch (err) {
            fail(
                `Could not load Magic Context config: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    } else {
        warn(`No magic-context.jsonc found — using defaults`);
        log.info("  Run 'setup' to create one with model recommendations");
    }

    // 3b. Migrate deprecated experimental config keys in magic-context.jsonc
    if (existsSync(paths.magicContextConfig)) {
        try {
            const mcRaw = readFileSync(paths.magicContextConfig, "utf-8");
            const mcConfig = parse(mcRaw) as Record<string, unknown>;
            let mcChanged = false;

            // Remove deprecated compaction_markers config — always-on since v0.21.4.
            //
            // The flag lived in two places across releases:
            //   - `experimental.compaction_markers` (early experimental phase)
            //   - top-level `compaction_markers` (graduated stable, default true,
            //     v0.9.0+)
            //
            // As of v0.21.4 the feature is mandatory and the knob is gone from
            // the schema. We clean BOTH locations so users don't see a
            // "compaction_markers is not allowed" warning at plugin load.
            //
            // Intentional: comment-json stores comments on hidden Symbol keys
            // attached to the parent object via their associated key. Deleting
            // a key drops its immediately-preceding "before-property" comment.
            // We accept that single-comment loss; the rest of the user's
            // comments (block comments, other properties' before-comments,
            // trailing comments on sibling keys) survive untouched. We do NOT
            // delete the `experimental` object even when it becomes empty,
            // because its header comment is anchored there.
            const experimental = mcConfig.experimental as Record<string, unknown> | undefined;
            if (experimental && "compaction_markers" in experimental) {
                delete experimental.compaction_markers;
                mcChanged = true;
                log.success(
                    "Removed deprecated experimental.compaction_markers (always-on since v0.21.4)",
                );
                fixed++;
            }
            if ("compaction_markers" in mcConfig) {
                delete mcConfig.compaction_markers;
                mcChanged = true;
                log.success("Removed deprecated compaction_markers (always-on since v0.21.4)");
                fixed++;
            }

            // Remove deprecated auto_drop_tool_age / drop_tool_structure — Phase 2
            // replaced need-blind routine tool drops with the tiered target-headroom
            // emergency drop (always full-drop), so both knobs are gone from the
            // schema and would trigger a "not allowed" warning at plugin load.
            for (const deadKey of ["auto_drop_tool_age", "drop_tool_structure"]) {
                if (deadKey in mcConfig) {
                    delete mcConfig[deadKey];
                    mcChanged = true;
                    log.success(
                        `Removed deprecated ${deadKey} (replaced by tiered emergency drop)`,
                    );
                    fixed++;
                }
            }

            const agentEnabledMigration = migrateLegacyAgentEnabledConfigForDoctor(mcConfig, log);
            if (agentEnabledMigration.changed) {
                mcChanged = true;
                fixed += agentEnabledMigration.fixes;
            }

            // Migrate experimental.user_memories → dreamer.user_memories.
            // The feature is now stable and lives under dreamer config (since
            // dreamer owns candidate review and promotion). We preserve the
            // user's existing enabled state so users who had it enabled keep
            // it enabled, and users who had it explicitly disabled stay opted
            // out. New users (no existing setting) get the new default:
            // enabled=true under dreamer.user_memories.
            if (experimental && "user_memories" in experimental) {
                const dreamer = (mcConfig.dreamer as Record<string, unknown> | undefined) ?? {};
                const oldUM = experimental.user_memories;
                const existingUM = dreamer.user_memories;
                if (existingUM === undefined) {
                    // No dreamer.user_memories yet — move the old value over.
                    // Coerce primitives (e.g., `experimental.user_memories: true`)
                    // to object shape so the Zod schema accepts them. Without
                    // this coercion, a primitive would trip schema validation
                    // and silently fall back to defaults — losing the user's
                    // explicit opt-in/out state.
                    if (typeof oldUM === "boolean") {
                        dreamer.user_memories = { enabled: oldUM };
                    } else {
                        dreamer.user_memories = oldUM;
                    }
                } else if (
                    typeof oldUM === "object" &&
                    oldUM !== null &&
                    typeof existingUM === "object" &&
                    existingUM !== null
                ) {
                    // Both blocks exist — merge field-by-field so we don't drop
                    // sub-fields like `promotion_threshold` that the user set
                    // under experimental. Existing dreamer.user_memories fields
                    // win (user already graduated them).
                    const merged = {
                        ...(oldUM as Record<string, unknown>),
                        ...(existingUM as Record<string, unknown>),
                    };
                    dreamer.user_memories = merged;
                } else if (typeof oldUM === "object" && oldUM !== null) {
                    // Old block is a proper object but new block is a malformed
                    // primitive (e.g., user wrote `dreamer.user_memories: true`
                    // as a shortcut). Without this branch we'd silently drop
                    // the old block's sub-fields like `promotion_threshold`.
                    // Coerce the primitive to { enabled: <primitive-as-bool> }
                    // shape, then merge — old sub-fields fill in, new enabled
                    // preserves what the user literally typed.
                    const coerced: Record<string, unknown> = {
                        ...(oldUM as Record<string, unknown>),
                        enabled: Boolean(existingUM),
                    };
                    dreamer.user_memories = coerced;
                    log.warn(
                        `Coerced malformed dreamer.user_memories (${typeof existingUM}) to object form while merging sub-fields from experimental.user_memories`,
                    );
                }
                // else: both are primitive/malformed — nothing safe to merge.
                mcConfig.dreamer = dreamer;
                delete experimental.user_memories;
                mcChanged = true;
                log.success(
                    "Migrated experimental.user_memories → dreamer.user_memories (now default: enabled)",
                );
                fixed++;
            }

            if (experimental && migrateExperimentalPinKeyFilesForDoctor(mcConfig)) {
                mcChanged = true;
                log.success(
                    "Migrated experimental.pin_key_files → dreamer.pin_key_files (preserved user enabled state)",
                );
                fixed++;
            }

            // Relocate graduated feature flags out of the (retired) experimental.*
            // namespace to their new homes:
            //   - temporal_awareness / caveman_text_compression → top-level keys
            //   - auto_search / git_commit_indexing → memory.* (recall features)
            // We preserve the user's explicit values so opt-ins/opt-outs survive;
            // the destination wins when a user has already started graduating,
            // merging sub-fields so partial settings aren't dropped.
            const relocateGraduated = (
                key: string,
                dest: Record<string, unknown>,
                destLabel: string,
            ): void => {
                if (!experimental || !(key in experimental)) return;
                const oldValue = experimental[key];
                const existing = dest[key];
                if (existing === undefined) {
                    dest[key] = oldValue;
                } else if (
                    typeof oldValue === "object" &&
                    oldValue !== null &&
                    typeof existing === "object" &&
                    existing !== null
                ) {
                    dest[key] = {
                        ...(oldValue as Record<string, unknown>),
                        ...(existing as Record<string, unknown>),
                    };
                }
                delete experimental[key];
                mcChanged = true;
                log.success(`Migrated experimental.${key} → ${destLabel}${key} (graduated)`);
                fixed++;
            };
            if (experimental) {
                relocateGraduated("temporal_awareness", mcConfig, "");
                relocateGraduated("caveman_text_compression", mcConfig, "");
                const memoryDest = (mcConfig.memory as Record<string, unknown> | undefined) ?? {};
                relocateGraduated("auto_search", memoryDest, "memory.");
                relocateGraduated("git_commit_indexing", memoryDest, "memory.");
                if (Object.keys(memoryDest).length > 0) {
                    mcConfig.memory = memoryDest;
                }
                // The experimental.* namespace is fully retired; drop the now-empty
                // block so it does not linger as obsolete clutter. (Accepts the loss
                // of the block's anchored header comment — the block no longer exists.)
                if (Object.keys(experimental).length === 0 && "experimental" in mcConfig) {
                    delete mcConfig.experimental;
                    mcChanged = true;
                }
            }

            // Dreamer v2: convert the legacy v1 dreamer shape (window schedule,
            // tasks array, user_memories/pin_key_files blocks) into the per-task
            // `tasks` record. Runs AFTER the experimental migrations above so a
            // relocated dreamer.user_memories/pin_key_files is folded into tasks.
            if (migrateDreamerV2ForDoctor(mcConfig)) {
                mcChanged = true;
                log.success(
                    "Migrated legacy dreamer scheduling → per-task dreamer.tasks (window→cron, blocks→tasks)",
                );
                fixed++;
            }

            // Remove `compartment_token_budget` — replaced by auto-derivation from
            // main/historian model context in later versions. The value is no longer
            // read; leaving it in config is harmless but misleading.
            if ("compartment_token_budget" in mcConfig) {
                delete mcConfig.compartment_token_budget;
                mcChanged = true;
                log.success(
                    "Removed deprecated compartment_token_budget (auto-derived from model context now)",
                );
                fixed++;
            }

            if (mcChanged) {
                writeFileAtomic(paths.magicContextConfig, `${stringify(mcConfig, null, 2)}\n`);
            }
        } catch {
            log.warn("Could not migrate deprecated config keys in magic-context.jsonc");
        }
    }

    // 4. Check plugin is in opencode.json
    if (paths.opencodeConfigFormat !== "none") {
        try {
            const raw = readFileSync(paths.opencodeConfig, "utf-8");
            const config = parse(raw) as Record<string, unknown>;
            // Operate on the raw plugin array. Entries can be:
            //   • a string  "@cortexkit/opencode-magic-context@latest"
            //   • a tuple   ["@pkg/name@latest", { ...options }]
            //   • a dev URL "file:///abs/path/.../packages/plugin"
            // We MUST preserve every entry shape on write — filtering out
            // tuples (or stripping options) would silently drop user config.
            // matchesPluginEntry / isDevPathPluginEntry are imported from
            // ../adapters/opencode and accept both strings and tuples.
            const rawPlugins: unknown[] = Array.isArray(config?.plugin) ? config.plugin : [];
            const existingIdx = rawPlugins.findIndex(
                (entry) => matchesPluginEntry(entry, PLUGIN_NAME) || isDevPathPluginEntry(entry),
            );
            const configName =
                paths.opencodeConfigFormat === "jsonc" ? "opencode.jsonc" : "opencode.json";

            // Helper: extract the plain string (or first element of a tuple) so
            // we can compare against the desired @latest entry.
            const entryAsString = (entry: unknown): string | null => {
                if (typeof entry === "string") return entry;
                if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0];
                return null;
            };

            if (existingIdx >= 0 && rawPlugins[existingIdx] === PLUGIN_ENTRY_WITH_VERSION) {
                pass(`Plugin registered in ${configName}`);
            } else if (existingIdx >= 0) {
                const oldEntry = rawPlugins[existingIdx];
                const oldEntryStr = entryAsString(oldEntry) ?? "";

                // Dev-path entries (file://, absolute, relative) are detected
                // so we don't double-add @latest, but we MUST NOT replace them
                // — that would silently disable the developer's local plugin
                // checkout. Always log as-is and leave the entry alone, even
                // under --force.
                if (isDevPathPluginEntry(oldEntry)) {
                    pass(`Plugin registered in ${configName} (dev path: ${oldEntryStr})`);
                } else {
                    const isPinned =
                        oldEntryStr !== PLUGIN_NAME &&
                        oldEntryStr !== PLUGIN_ENTRY_WITH_VERSION &&
                        /^@cortexkit\/opencode-magic-context@\d/.test(oldEntryStr);

                    if (isPinned && !options.force) {
                        // Warn but don't change — user intentionally pinned
                        warn(
                            `Plugin pinned to ${oldEntryStr} in ${configName} — use 'doctor --force' to upgrade`,
                        );
                    } else {
                        // Upgrade versionless entry to @latest, or --force upgrades pinned.
                        // If the existing entry is a tuple, preserve options by
                        // updating only the package-name slot; otherwise replace
                        // with the plain string entry.
                        if (Array.isArray(oldEntry) && oldEntry.length >= 1) {
                            const replacement = [...oldEntry];
                            replacement[0] = PLUGIN_ENTRY_WITH_VERSION;
                            rawPlugins[existingIdx] = replacement;
                        } else {
                            rawPlugins[existingIdx] = PLUGIN_ENTRY_WITH_VERSION;
                        }
                        config.plugin = rawPlugins;
                        writeFileAtomic(paths.opencodeConfig, `${stringify(config, null, 2)}\n`);
                        pass(
                            `Upgraded plugin entry in ${configName}: ${oldEntryStr} → ${PLUGIN_ENTRY_WITH_VERSION}`,
                        );
                        fixed++;
                    }
                }
            } else {
                // Auto-add plugin entry — preserves comments AND every existing
                // tuple/options entry the user already had.
                rawPlugins.push(PLUGIN_ENTRY_WITH_VERSION);
                config.plugin = rawPlugins;
                writeFileAtomic(paths.opencodeConfig, `${stringify(config, null, 2)}\n`);
                pass(`Added plugin to ${configName}`);
                fixed++;
            }
        } catch {
            warn("Could not parse opencode config to verify plugin entry");
        }
    }

    // 5. Check for conflicts
    const cwd = process.cwd();
    const conflictResult = detectConflicts(cwd);

    if (conflictResult.hasConflict) {
        for (const reason of conflictResult.reasons) {
            fail(`Conflict: ${reason}`);
        }
        // Auto-fix conflicts
        const actions = fixConflicts(cwd, conflictResult.conflicts);
        for (const action of actions) {
            pass(`Fixed: ${action}`);
            fixed++;
        }
        if (actions.length > 0) {
            warn("Restart OpenCode for conflict fixes to take effect");
        }
    } else {
        pass("No conflicts detected (compaction, DCP, OMO hooks)");
    }

    // 6. Check tui.json
    const tuiAdded = ensureTuiPluginEntry();
    if (tuiAdded) {
        pass("Added TUI sidebar plugin to tui.json");
        warn("Restart OpenCode to see the sidebar");
        fixed++;
    } else if (existsSync(paths.tuiConfig)) {
        // Check for pinned version in tui config. Same tuple/dev-path rules
        // as the main opencode config — preserve every entry shape on write.
        try {
            const tuiRaw = readFileSync(paths.tuiConfig, "utf-8");
            const tuiConfig = parse(tuiRaw) as Record<string, unknown>;
            const tuiRawPlugins: unknown[] = Array.isArray(tuiConfig?.plugin)
                ? tuiConfig.plugin
                : [];
            const tuiIdx = tuiRawPlugins.findIndex(
                (entry) => matchesPluginEntry(entry, PLUGIN_NAME) || isDevPathPluginEntry(entry),
            );
            const tuiEntryAsString = (entry: unknown): string => {
                if (typeof entry === "string") return entry;
                if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0];
                return "";
            };
            if (tuiIdx >= 0) {
                const tuiEntry = tuiRawPlugins[tuiIdx];
                const tuiEntryStr = tuiEntryAsString(tuiEntry);
                if (isDevPathPluginEntry(tuiEntry)) {
                    pass(`TUI sidebar plugin configured (dev path: ${tuiEntryStr})`);
                } else {
                    const tuiPinned =
                        tuiEntryStr !== PLUGIN_NAME &&
                        tuiEntryStr !== PLUGIN_ENTRY_WITH_VERSION &&
                        /^@cortexkit\/opencode-magic-context@\d/.test(tuiEntryStr);
                    if (tuiPinned && !options.force) {
                        warn(
                            `TUI plugin pinned to ${tuiEntryStr} — use 'doctor --force' to upgrade`,
                        );
                    } else if (tuiPinned && options.force) {
                        // Preserve tuple options when upgrading.
                        if (Array.isArray(tuiEntry) && tuiEntry.length >= 1) {
                            const replacement = [...tuiEntry];
                            replacement[0] = PLUGIN_ENTRY_WITH_VERSION;
                            tuiRawPlugins[tuiIdx] = replacement;
                        } else {
                            tuiRawPlugins[tuiIdx] = PLUGIN_ENTRY_WITH_VERSION;
                        }
                        tuiConfig.plugin = tuiRawPlugins;
                        writeFileAtomic(paths.tuiConfig, `${stringify(tuiConfig, null, 2)}\n`);
                        pass(`Upgraded TUI plugin: ${tuiEntryStr} → ${PLUGIN_ENTRY_WITH_VERSION}`);
                        fixed++;
                    } else {
                        pass("TUI sidebar plugin configured");
                    }
                }
            } else {
                pass("TUI sidebar plugin configured");
            }
        } catch {
            pass("TUI sidebar plugin configured");
        }
    } else {
        pass("TUI sidebar plugin configured (tui.json created)");
    }

    // 7. Check user memories + dreamer compatibility.
    // user_memories graduated from experimental to dreamer.user_memories in
    // v0.14, and the default is now enabled. Candidate extraction still
    // requires dreamer to actually promote candidates into stable memories,
    // so warn loudly when the combination is wrong.
    if (existsSync(paths.magicContextConfig)) {
        try {
            const mcRaw = readFileSync(paths.magicContextConfig, "utf-8");
            const mcConfig = parse(mcRaw) as Record<string, unknown>;
            const dreamerObj = mcConfig?.dreamer as Record<string, unknown> | undefined;
            const dreamerDisabled = dreamerObj?.disable === true;
            const userMemObj = dreamerObj?.user_memories as Record<string, unknown> | undefined;
            // user_memories defaults to enabled, so treat `undefined` as true.
            const userMemEnabled = userMemObj?.enabled !== false;
            if (userMemEnabled && dreamerDisabled) {
                log.warn(
                    "dreamer.user_memories is enabled but dreamer.disable=true, so new promotions will not run. Remove dreamer.disable or set dreamer.user_memories.enabled=false.",
                );
                issues++;
            }
        } catch {
            // Config parse failed — skip this check
        }
    }

    // 7b. Validate embedding configuration — runs a real probe against the
    // configured endpoint so users catch misconfigured URL / missing env var /
    // wrong provider issues before relying on semantic memory search.
    const embeddingCheck = await checkEmbeddingConfig(paths.magicContextConfig);
    issues += embeddingCheck.issues;
    if (embeddingCheck.issues > 0) failCount += embeddingCheck.issues;
    else passCount++;

    // 7c. Shared context DB exists, opens, integrity_check, row counts.
    // This catches corrupted DB files and misaligned storage paths early.
    const dbPath = join(getMagicContextStorageDir(), "context.db");
    if (!existsSync(dbPath)) {
        log.info(`Shared context DB not yet created at ${dbPath} (will be created on first run)`);
    } else {
        pass(`Shared context DB exists at ${dbPath}`);
        try {
            const db = new Database(dbPath, { readonly: true });
            try {
                pass("openDatabase() opened the shared DB");
                try {
                    const integrity = db.prepare("PRAGMA integrity_check").get() as
                        | { integrity_check?: string }
                        | undefined;
                    const result = integrity?.integrity_check ?? "unknown";
                    if (result === "ok") pass("SQLite integrity_check: ok");
                    else fail(`SQLite integrity_check reported: ${result}`);
                } catch (err) {
                    fail(
                        `SQLite integrity_check failed: ${err instanceof Error ? err.message : String(err)}`,
                    );
                }

                // Row counts across the major tables — informational, not pass/fail.
                try {
                    const counts: Record<string, number> = {};
                    for (const table of [
                        "tags",
                        "compartments",
                        "memories",
                        "notes",
                        "dream_runs",
                    ]) {
                        try {
                            const row = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as
                                | { c?: number }
                                | undefined;
                            counts[table] = row?.c ?? 0;
                        } catch {
                            // Table may not exist on a brand-new DB before migrations run
                            counts[table] = 0;
                        }
                    }
                    const summary = Object.entries(counts)
                        .map(([k, v]) => `${k}=${v}`)
                        .join(", ");
                    log.info(`Shared DB row counts: ${summary}`);
                } catch {
                    // Don't fail the doctor on row-count introspection issues
                }
            } finally {
                db.close();
            }
        } catch (err) {
            fail(`Could not open shared DB: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    // 8. Check plugin npm cache — clear only if outdated
    const cacheResult = await clearPluginCache({
        force: options.force,
        latestVersion: pluginNpmLatest,
    });
    if (cacheResult.action === "cleared") {
        const versionInfo = cacheResult.cached
            ? ` (cached: ${cacheResult.cached}${cacheResult.latest ? `, latest: ${cacheResult.latest}` : ""})`
            : "";
        const reason = cacheResult.latest
            ? "outdated plugin cache"
            : "plugin cache (latest version check unavailable)";
        pass(`Cleared ${reason}${versionInfo} — latest will download on restart`);
        log.info(`  ${cacheResult.path}`);
        fixed++;
    } else if (cacheResult.action === "up_to_date") {
        pass(`Plugin cache up to date (v${cacheResult.cached})`);
    } else if (cacheResult.action === "check_unavailable") {
        warn(
            `Plugin cache version check unavailable; preserving cached plugin${cacheResult.cached ? ` (cached: ${cacheResult.cached})` : ""}. Use doctor --force to reinstall it.`,
        );
    } else if (cacheResult.action === "error") {
        warn(`Could not clear plugin cache: ${cacheResult.error}`);
        log.info(`  Manually delete: ${cacheResult.path}`);
        issues++;
    } else {
        pass("Plugin cache clean (no cached version found)");
    }

    // 9. Check for min-release-age / before restrictions in ~/.npmrc.
    // OpenCode installs plugins with npm under the hood, so npm's age guards
    // apply. We don't check Bun's bunfig.toml anymore — the unified CLI uses
    // npx and the auto-update checker uses npm install, neither of which read
    // bunfig.
    {
        const ageWarnings: string[] = [];
        const npmrcPath = join(homedir(), ".npmrc");
        if (existsSync(npmrcPath)) {
            try {
                const npmrc = readFileSync(npmrcPath, "utf-8");
                for (const line of npmrc.split("\n")) {
                    const trimmed = line.trim();
                    if (trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
                    const [key] = trimmed.split("=").map((s) => s.trim());
                    if (key === "min-release-age" || key === "before") {
                        ageWarnings.push(`~/.npmrc has '${trimmed}'`);
                    }
                }
            } catch {
                // Can't read .npmrc — skip
            }
        }

        if (ageWarnings.length > 0) {
            log.warn(
                "npm min-release-age restriction detected — this can prevent OpenCode from installing the latest plugin version",
            );
            for (const w of ageWarnings) {
                log.info(`  ${w}`);
            }
            log.info(
                "  If the plugin stays on an old version after doctor --force, this is the likely cause.",
            );
            log.info(
                "  Workaround: temporarily remove the restriction, restart OpenCode, then re-enable it.",
            );
            issues++;
        }
    }

    // 10. Show diagnostics info (log file, historian dumps)

    const logPath = getMagicContextLogPath("opencode");
    if (existsSync(logPath)) {
        const logStat = statSync(logPath);
        const sizeKb = (logStat.size / 1024).toFixed(0);
        log.info(`Log file: ${logPath} (${sizeKb} KB)`);
    } else {
        log.info(`Log file: ${logPath} (not yet created)`);
    }

    // Historian dumps live per-project under `<dir>/.cortexkit/magic-context/historian/`.
    // We surface them grouped by project so users can see which session's dumps are
    // where. Falls back to the legacy tmp-dir layout when collectDiagnostics returns
    // empty buckets (Node-only runs, no OpenCode DB, no historian has run yet under
    // the new path).
    const diagnostics = await collectDiagnostics();
    const dumpBuckets = diagnostics.historianDumps.byProject;
    if (dumpBuckets.length > 0) {
        const totalCount = dumpBuckets.reduce((sum, b) => sum + b.count, 0);
        const sessionCount = dumpBuckets.length;
        warn(`Historian debug dumps: ${totalCount} file(s) across ${sessionCount} project(s)`);
        for (const bucket of dumpBuckets) {
            log.info(`  [${bucket.directory}] ${bucket.count} file(s)`);
            for (const dump of bucket.recent.slice(0, 3)) {
                const age = dump.ageMinutes;
                const ageStr = age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`;
                log.info(`    ${dump.name} (${ageStr})`);
            }
            if (bucket.count > 3) {
                log.info(`    ... and ${bucket.count - 3} more`);
            }
        }
    }
    // Legacy tmp-dir dumps from pre-Phase 3 plugin versions — still listed if
    // present so users can find old artifacts without spelunking the tmp dir.
    const legacy = diagnostics.historianDumps.legacyDumps;
    if (legacy.count > 0) {
        log.info(`Legacy historian dumps (pre-v0.18.x): ${legacy.count} file(s) in ${legacy.dir}`);
    }

    // 11. Check OMO config
    if (paths.omoConfig) {
        log.info(`OMO config found: ${paths.omoConfig}`);
    }

    // Summary — aligned with Pi doctor format.
    console.log("");
    log.message(`Summary: PASS ${passCount} / WARN ${warnCount} / FAIL ${failCount}`);
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
