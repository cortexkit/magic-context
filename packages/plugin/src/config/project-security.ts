import {
    DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
    PER_HARNESS_MIGRATION_INVENTORY,
} from "./schema/magic-context";

/**
 * Security hardening for PROJECT-level (repo-supplied, untrusted) config.
 *
 * A project config lives inside a repository the user cloned. Opening a repo
 * must never let that repo's config escalate privilege or exfiltrate secrets.
 * These helpers run on the raw project config BEFORE/AFTER it is merged over the
 * trusted user config, mutating the relevant object in place and returning
 * human-readable warnings.
 *
 * Shared by both harnesses (OpenCode `config/index.ts` and Pi
 * `config/index.ts`) so the trust boundary is identical cross-harness.
 */

/** Hidden agents that run with elevated/autonomous capability. */
const HIDDEN_AGENT_KEYS = ["historian", "dreamer", "sidekick"] as const;
const HARNESS_KEYS = ["opencode", "pi"] as const;
/** Every historian model-resolution field, including per-harness qualifiers.
 *  Variant and thinking_level merge onto the user's historian model at resolve
 *  time, so leaving them would let a cloned repo force extra spend. */
const HISTORIAN_USER_ONLY_FIELDS = PER_HARNESS_MIGRATION_INVENTORY.historian.migrated_execution;
const PROMPT_SURFACE_USER_ONLY_FIELDS = ["guidance_override_path", "tool_descriptions"] as const;

/**
 * Fields on a hidden-agent block that constitute a privilege-escalation /
 * code-execution vector when set from an untrusted repo:
 *
 *  - `prompt`     — reprograms the agent's instructions. The dreamer runs
 *                   AUTONOMOUSLY in the background with `bash`/`edit`/`webfetch`,
 *                   so a repo-supplied prompt is an unattended exfil/RCE path.
 *  - `permission` — broadens the agent's per-tool permissions.
 *  - `tools`      — enable/disable map; could flip a denied tool (e.g. `bash`)
 *                   on for an agent whose allow-list intentionally excludes it.
 *  - `system_prompt` — sidekick's custom system prompt. It takes precedence over
 *                   the built-in prompt (sidekick/agent.ts reads
 *                   `config.system_prompt` before `config.prompt`), so leaving it
 *                   unstripped reopens the exact reprogramming vector `prompt`
 *                   closes — a cloned repo could rewrite sidekick's instructions
 *                   via `/ctx-aug`.
 *
 * Dreamer model/cadence fields are deliberately NOT stripped: a repo may tune
 * its own dreamer overlays and schedules through the user's provider auth.
 * Historian model selection stays USER-tier only, and compaction thresholds are
 * project raise-only, so a cloned repo cannot force earlier compaction or extra
 * historian spend on the user's dime.
 */
const AGENT_ESCALATION_FIELDS = ["prompt", "permission", "tools", "system_prompt"] as const;
const EMBEDDING_DESTINATION_FIELDS = ["endpoint", "provider", "fallback_provider"] as const;
const PERCENTAGE_THRESHOLD_REASON =
    "security: a repository may only raise compaction thresholds above the user's effective value; it cannot force earlier historian work or cloned-repo cost escalation.";
const TOKEN_THRESHOLD_REASON =
    "security: a repository may only raise execute_threshold_tokens above the user's trusted token threshold; it cannot force earlier historian work or cloned-repo cost escalation.";
const TOKEN_THRESHOLD_INTRODUCTION_REASON =
    "security: a repository cannot introduce a new execute_threshold_tokens override when the user has no trusted token threshold for that key; that could force earlier historian work or cloned-repo cost escalation.";

interface PercentageThresholdConfig {
    defaultValue: number;
    overrides: Map<string, number>;
}

interface TokenThresholdConfig {
    defaultValue: number | undefined;
    overrides: Map<string, number>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripListedFields(
    target: Record<string, unknown>,
    fields: readonly string[],
    path: string,
    removed: string[],
): void {
    for (const field of fields) {
        if (field in target) {
            delete target[field];
            removed.push(path.length > 0 ? `${path}.${field}` : field);
        }
    }
}

/** Strip prompt, permission, tools, and system_prompt from one agent, harness,
 *  task, or model-entry object, including each fallback_models entry. A cloned
 *  repo must not reprogram hidden agents through any of those nestings. */
function stripEscalationAtExecutableSite(
    block: Record<string, unknown>,
    path: string,
    removed: string[],
): void {
    stripListedFields(block, AGENT_ESCALATION_FIELDS, path, removed);
    if (isPlainObject(block.model)) {
        stripListedFields(block.model, AGENT_ESCALATION_FIELDS, `${path}.model`, removed);
    }
    if (Array.isArray(block.fallback_models)) {
        for (let index = 0; index < block.fallback_models.length; index++) {
            const entry = block.fallback_models[index];
            if (isPlainObject(entry)) {
                stripListedFields(
                    entry,
                    AGENT_ESCALATION_FIELDS,
                    `${path}.fallback_models.${index}`,
                    removed,
                );
            }
        }
    }
}

/** Remove `mural.model` smuggled under hidden-agent trees. Top-level and
 *  experimental mural blocks are handled separately so their warnings stay
 *  specific; this walk covers harness and task nesting the schema does not
 *  admit but a hostile file can still write. */
function stripNestedMuralModels(
    node: Record<string, unknown>,
    path: string,
    removed: string[],
): void {
    for (const [key, value] of Object.entries(node)) {
        if (key === "mural" && isPlainObject(value) && "model" in value) {
            delete value.model;
            removed.push(`${path}.${key}.model`);
        } else if (isPlainObject(value)) {
            stripNestedMuralModels(value, `${path}.${key}`, removed);
        }
    }
}

function isValidPercentageThreshold(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 20 && value <= 80;
}

function isValidTokenThreshold(value: unknown): value is number {
    return (
        typeof value === "number" && Number.isFinite(value) && value >= 5_000 && value <= 2_000_000
    );
}

function normalizeTrustedPercentageThresholds(value: unknown): PercentageThresholdConfig {
    if (typeof value === "number" && Number.isFinite(value)) {
        return { defaultValue: value, overrides: new Map() };
    }

    if (
        isPlainObject(value) &&
        typeof value.default === "number" &&
        Number.isFinite(value.default)
    ) {
        const overrides = new Map<string, number>();
        for (const [key, child] of Object.entries(value)) {
            if (key === "default") continue;
            if (typeof child === "number" && Number.isFinite(child)) {
                overrides.set(key, child);
            }
        }
        return { defaultValue: value.default, overrides };
    }

    return { defaultValue: DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE, overrides: new Map() };
}

function normalizeTrustedTokenThresholds(value: unknown): TokenThresholdConfig {
    if (!isPlainObject(value)) {
        return { defaultValue: undefined, overrides: new Map() };
    }

    const overrides = new Map<string, number>();
    for (const [key, child] of Object.entries(value)) {
        if (key === "default") continue;
        if (typeof child === "number" && Number.isFinite(child)) {
            overrides.set(key, child);
        }
    }

    return {
        defaultValue:
            typeof value.default === "number" && Number.isFinite(value.default)
                ? value.default
                : undefined,
        overrides,
    };
}

function clonePercentageThresholds(value: PercentageThresholdConfig): PercentageThresholdConfig {
    return {
        defaultValue: value.defaultValue,
        overrides: new Map(value.overrides),
    };
}

function cloneTokenThresholds(value: TokenThresholdConfig): TokenThresholdConfig {
    return {
        defaultValue: value.defaultValue,
        overrides: new Map(value.overrides),
    };
}

function percentageThresholdsEqual(
    left: PercentageThresholdConfig,
    right: PercentageThresholdConfig,
): boolean {
    if (left.defaultValue !== right.defaultValue) return false;
    if (left.overrides.size !== right.overrides.size) return false;
    for (const [key, value] of left.overrides) {
        if (right.overrides.get(key) !== value) return false;
    }
    return true;
}

function setMergedPercentageThreshold(
    mergedRaw: Record<string, unknown>,
    value: PercentageThresholdConfig,
): void {
    if (value.overrides.size === 0) {
        mergedRaw.execute_threshold_percentage = value.defaultValue;
        return;
    }

    const serialized: Record<string, number> = { default: value.defaultValue };
    for (const [key, threshold] of value.overrides) {
        serialized[key] = threshold;
    }
    mergedRaw.execute_threshold_percentage = serialized;
}

function setMergedTokenThreshold(
    mergedRaw: Record<string, unknown>,
    value: TokenThresholdConfig,
): void {
    if (value.defaultValue === undefined && value.overrides.size === 0) {
        delete mergedRaw.execute_threshold_tokens;
        return;
    }

    const serialized: Record<string, number> = {};
    if (value.defaultValue !== undefined) {
        serialized.default = value.defaultValue;
    }
    for (const [key, threshold] of value.overrides) {
        serialized[key] = threshold;
    }
    mergedRaw.execute_threshold_tokens = serialized;
}

function makeProjectThresholdWarning(field: string, reason: string): string {
    return `Ignoring ${field} from project config (${reason})`;
}

/**
 * Strip unsafe fields from a raw PROJECT config IN PLACE, before it is merged
 * over the user config. Returns warnings describing what was ignored.
 *
 * Closes:
 *  - `profiles` — profile definitions choose hidden-agent models and must stay
 *    in trusted user config; a repository may select a named profile but cannot
 *    supply its contents.
 *  - `auto_update` — a repo must not suppress plugin self-updates (which can
 *    carry security fixes).
 *  - `fail_closed_blocking` — a repo must not un-block (or force-block) the
 *    loud inoperability gate; only the user may restore silent degrade.
 *  - `allow_home_project` — only the user may opt a home-directory session
 *    into a durable project identity.
 *  - `output_reserve` / `models.window_overlay_path` — only the user may change
 *    process-wide window geometry inputs.
 *  - `language`: a repo must not inject prompt text through a user preference.
 *  - `sqlite` — `sqlite.cache_size_mb` / `mmap_size_mb` become PRAGMAs on the
 *    process-global shared DB handle (one connection across every project in the
 *    process). A cloned repo could set a huge value to exhaust host memory /
 *    address space — a resource-exhaustion vector with no legitimate per-repo
 *    use. Honor user-level config only.
 *  - `storage.enforce_private_permissions` — changing a shared store from
 *    owner-private to group-readable changes every session and memory's local
 *    confidentiality. Only the machine operator's user config may opt into an
 *    externally managed trusted-group deployment.
 *  - `embedding.endpoint` / `embedding.provider` — a repo must not choose
 *    where private memory/search/commit text is embedded. User-level config is
 *    the trust boundary for embedding destinations.
 *  - `transform_mode` is intentionally allowed at project tier so a repository
 *    can opt its own runtime into the experimental Rust pipeline. The resolver
 *    requires trusted user-level `subc` configuration before Rust can activate.
 *  - historian model-resolution fields (model, fallback_models, variant,
 *    thinking_level), including both per-harness blocks — historian model
 *    spend is user-level only. Qualifiers merge onto the user's historian
 *    model at resolve time, so a cloned repo cannot force extra thinking or
 *    variant cost.
 *  - `mural.model` at the top-level block, the legacy experimental spelling,
 *    and any nested `mural.model` under hidden agents — a cloned repo cannot
 *    choose where project memory is sent.
 *  - `pi.subagent_extensions` — a cloned repo must not choose which extensions
 *    the user's Pi child processes load.
 *  - `prompt_surface.guidance_override_path` / `tool_descriptions` — a repository
 *    may select a reviewed preset, but must not inject arbitrary guidance or tool
 *    description text into the user's provider-visible prompt.
 *  - hidden-agent `prompt`/`permission`/`tools`/`system_prompt` at the agent
 *    root, each harness block, each task block, and inside model/fallback
 *    entry objects — a repo must not reprogram or re-permission hidden agents.
 */
export function stripUnsafeProjectConfigFields(projectRaw: Record<string, unknown>): string[] {
    const warnings: string[] = [];

    if ("profiles" in projectRaw) {
        delete projectRaw.profiles;
        warnings.push(
            "Ignoring profiles from project config (security: profile definitions are user-level only; a repository may select a named user profile with profile).",
        );
    }

    if ("auto_update" in projectRaw) {
        delete projectRaw.auto_update;
        warnings.push(
            "Ignoring auto_update from project config (security: this setting only honors user-level config).",
        );
    }

    // Widening the empty-sentinel gate is a wire-behavior decision; a cloned
    // repo must not declare that its models filter empty parts.
    if ("anthropic_transport_providers" in projectRaw) {
        delete projectRaw.anthropic_transport_providers;
        warnings.push(
            "Ignoring anthropic_transport_providers from project config (security: transport gating is a user-level setting).",
        );
    }

    if ("fail_closed_blocking" in projectRaw) {
        delete projectRaw.fail_closed_blocking;
        warnings.push(
            "Ignoring fail_closed_blocking from project config (security: only user-level config may disable or force the loud inoperability gate).",
        );
    }

    if ("allow_home_project" in projectRaw) {
        delete projectRaw.allow_home_project;
        warnings.push(
            "Ignoring allow_home_project from project config (security: only user-level config may opt the user's home directory into Magic Context).",
        );
    }

    // compaction.enabled is USER-tier only: a cloned repo must never silently
    // disable the user's context management (it changes how the window is
    // owned and interacts with native compaction state). Field-scoped, not
    // block-scoped: a sibling key in a project `compaction` block survives the
    // strip, so a future project-tier compaction knob can still land.
    const compaction = projectRaw.compaction;
    if (isPlainObject(compaction) && "enabled" in compaction) {
        delete compaction.enabled;
        warnings.push(
            "Ignoring compaction.enabled from project config (security: only user-level config may disable Magic Context's context-window management; a cloned repo cannot change how the user's window is owned).",
        );
    }

    if ("output_reserve" in projectRaw) {
        delete projectRaw.output_reserve;
        warnings.push(
            "Ignoring output_reserve from project config (security: output-token reservation only honors user-level config).",
        );
    }

    const models = projectRaw.models;
    if (isPlainObject(models) && "window_overlay_path" in models) {
        delete models.window_overlay_path;
        warnings.push(
            "Ignoring models.window_overlay_path from project config (security: only user-level config may select model geometry metadata).",
        );
    }

    if ("language" in projectRaw) {
        delete projectRaw.language;
        warnings.push(
            "Ignoring language from project config (security: output language is a user-level setting).",
        );
    }

    if ("sqlite" in projectRaw) {
        delete projectRaw.sqlite;
        warnings.push(
            "Ignoring sqlite.* from project config (security: SQLite cache/mmap PRAGMAs apply to the " +
                "process-global shared database handle; only user-level config may set them).",
        );
    }

    // storage.enforce_private_permissions is USER-tier only because disabling it
    // changes the confidentiality of the process-global shared store. Field-scoped
    // stripping preserves future project-tier storage settings in the same block.
    const storage = projectRaw.storage;
    if (isPlainObject(storage) && "enforce_private_permissions" in storage) {
        delete storage.enforce_private_permissions;
        warnings.push(
            "Ignoring storage.enforce_private_permissions from project config (security: only user-level config may opt into externally managed shared storage permissions).",
        );
    }

    // Repositories may select preset routing, but project settings cannot add
    // guidance or tool-description text to the provider-visible prompt; those
    // user-only fields are removed before project settings are merged.
    const promptSurface = projectRaw.prompt_surface;
    if (isPlainObject(promptSurface)) {
        const removed: string[] = [];
        for (const field of PROMPT_SURFACE_USER_ONLY_FIELDS) {
            if (field in promptSurface) {
                delete promptSurface[field];
                removed.push(field);
            }
        }
        if (removed.length > 0) {
            warnings.push(
                `Ignoring prompt_surface.${removed.join("/")} from project config (security: repositories may select prompt presets but only user config may provide guidance or tool-description text).`,
            );
        }
    }

    const pi = projectRaw.pi;
    if (isPlainObject(pi) && "subagent_extensions" in pi) {
        delete pi.subagent_extensions;
        warnings.push(
            "Ignoring pi.subagent_extensions from project config (security: only user-level config may choose extensions loaded by Pi subagent children).",
        );
    }

    for (const field of ["subc", "shadow_embedding"] as const) {
        if (field in projectRaw) {
            delete projectRaw[field];
            warnings.push(
                `Ignoring ${field} from project config (security: daemon routing and developer-only embedding traffic are user-level settings).`,
            );
        }
    }

    const embedding = projectRaw.embedding;
    if (isPlainObject(embedding)) {
        const removed: string[] = [];
        for (const field of EMBEDDING_DESTINATION_FIELDS) {
            if (field in embedding) {
                delete embedding[field];
                removed.push(field);
            }
        }
        if (removed.length > 0) {
            warnings.push(
                `Ignoring embedding.${removed.join("/")} from project config ` +
                    "(security: a repository cannot choose where private text is embedded).",
            );
        }
    }

    for (const agentKey of HIDDEN_AGENT_KEYS) {
        const block = projectRaw[agentKey];
        if (!isPlainObject(block)) continue;
        const removed: string[] = [];
        stripEscalationAtExecutableSite(block, agentKey, removed);
        for (const harness of HARNESS_KEYS) {
            const harnessBlock = block[harness];
            if (!isPlainObject(harnessBlock)) continue;
            stripEscalationAtExecutableSite(harnessBlock, `${agentKey}.${harness}`, removed);
            const tasks = harnessBlock.tasks;
            if (isPlainObject(tasks)) {
                for (const [taskName, taskBlock] of Object.entries(tasks)) {
                    if (isPlainObject(taskBlock)) {
                        stripEscalationAtExecutableSite(
                            taskBlock,
                            `${agentKey}.${harness}.tasks.${taskName}`,
                            removed,
                        );
                    }
                }
            }
        }
        const schedulingTasks = block.tasks;
        if (isPlainObject(schedulingTasks)) {
            for (const [taskName, taskBlock] of Object.entries(schedulingTasks)) {
                if (isPlainObject(taskBlock)) {
                    stripListedFields(
                        taskBlock,
                        AGENT_ESCALATION_FIELDS,
                        `${agentKey}.tasks.${taskName}`,
                        removed,
                    );
                }
            }
        }
        if (removed.length > 0) {
            warnings.push(
                `Ignoring ${removed.join(", ")} from project config ` +
                    "(security: a repository cannot reprogram or re-permission hidden agents).",
            );
        }
    }

    const historian = projectRaw.historian;
    if (isPlainObject(historian)) {
        const removed: string[] = [];
        for (const field of HISTORIAN_USER_ONLY_FIELDS) {
            if (field in historian) {
                delete historian[field];
                removed.push(field);
            }
        }
        for (const harness of HARNESS_KEYS) {
            const harnessBlock = historian[harness];
            if (!isPlainObject(harnessBlock)) continue;
            for (const field of HISTORIAN_USER_ONLY_FIELDS) {
                if (field in harnessBlock) {
                    delete harnessBlock[field];
                    removed.push(`${harness}.${field}`);
                }
            }
        }
        if (removed.length > 0) {
            warnings.push(
                `Ignoring ${removed.map((path) => `historian.${path}`).join(", ")} from project config ` +
                    "(security: historian model selection is user-level only; a repository cannot force extra compaction cost).",
            );
        }
    }

    const mural = projectRaw.mural;
    if (isPlainObject(mural) && "model" in mural) {
        delete mural.model;
        warnings.push(
            "Ignoring mural.model from project config (security: the mural cue-compressor model is a user-level setting; a repository cannot choose where project memory is sent).",
        );
    }

    // Keep the same trust boundary while accepting the pre-graduation spelling.
    // This must run before the in-memory migration moves experimental.mural.model
    // to mural.model, otherwise an untrusted project could bypass the user-only
    // model check.
    const experimental = projectRaw.experimental;
    const legacyMural = isPlainObject(experimental) ? experimental.mural : undefined;
    if (isPlainObject(legacyMural) && "model" in legacyMural) {
        delete legacyMural.model;
        warnings.push(
            "Ignoring experimental.mural.model from project config (security: the mural cue-compressor model is a user-level setting; use user-level mural.model).",
        );
    }

    const nestedMuralRemoved: string[] = [];
    for (const agentKey of HIDDEN_AGENT_KEYS) {
        const block = projectRaw[agentKey];
        if (!isPlainObject(block)) continue;
        stripNestedMuralModels(block, agentKey, nestedMuralRemoved);
    }
    if (nestedMuralRemoved.length > 0) {
        warnings.push(
            `Ignoring ${nestedMuralRemoved.join(", ")} from project config (security: the mural cue-compressor model is a user-level setting; a repository cannot choose where project memory is sent).`,
        );
    }

    return warnings;
}

/**
 * Clamp project-tier compaction thresholds after merge so a cloned repository
 * may only DELAY compaction relative to the trusted user/default settings. A
 * repo may never lower thresholds in a way that forces earlier historian work
 * or cloned-repo cost escalation on the user's account.
 */
export function constrainProjectThresholdOverrides(args: {
    mergedRaw: Record<string, unknown>;
    projectRaw: Record<string, unknown>;
    trustedBaseConfig: {
        execute_threshold_percentage?: unknown;
        execute_threshold_tokens?: unknown;
    };
}): string[] {
    const warnings: string[] = [];
    const basePercentage = normalizeTrustedPercentageThresholds(
        args.trustedBaseConfig.execute_threshold_percentage,
    );
    const baseTokens = normalizeTrustedTokenThresholds(
        args.trustedBaseConfig.execute_threshold_tokens,
    );

    if ("execute_threshold_percentage" in args.projectRaw) {
        const projectValue = args.projectRaw.execute_threshold_percentage;

        if (isValidPercentageThreshold(projectValue)) {
            const constrained = clonePercentageThresholds(basePercentage);
            constrained.defaultValue = Math.max(basePercentage.defaultValue, projectValue);
            for (const [modelKey, threshold] of basePercentage.overrides) {
                const raisedThreshold = Math.max(threshold, projectValue);
                if (raisedThreshold === constrained.defaultValue) {
                    constrained.overrides.delete(modelKey);
                } else {
                    constrained.overrides.set(modelKey, raisedThreshold);
                }
            }
            setMergedPercentageThreshold(args.mergedRaw, constrained);
            if (percentageThresholdsEqual(constrained, basePercentage)) {
                warnings.push(
                    makeProjectThresholdWarning(
                        "execute_threshold_percentage",
                        PERCENTAGE_THRESHOLD_REASON,
                    ),
                );
            }
        } else if (isPlainObject(projectValue)) {
            const constrained = clonePercentageThresholds(basePercentage);
            let touchedValidEntry = false;

            if (isValidPercentageThreshold(projectValue.default)) {
                touchedValidEntry = true;
                if (projectValue.default > basePercentage.defaultValue) {
                    constrained.defaultValue = projectValue.default;
                } else {
                    warnings.push(
                        makeProjectThresholdWarning(
                            "execute_threshold_percentage.default",
                            PERCENTAGE_THRESHOLD_REASON,
                        ),
                    );
                }
            }

            for (const [modelKey, rawValue] of Object.entries(projectValue)) {
                if (modelKey === "default") continue;
                if (!isValidPercentageThreshold(rawValue)) continue;
                touchedValidEntry = true;
                const baseValue =
                    basePercentage.overrides.get(modelKey) ?? basePercentage.defaultValue;
                if (rawValue > baseValue) {
                    if (rawValue === constrained.defaultValue) {
                        constrained.overrides.delete(modelKey);
                    } else {
                        constrained.overrides.set(modelKey, rawValue);
                    }
                } else {
                    warnings.push(
                        makeProjectThresholdWarning(
                            `execute_threshold_percentage.${modelKey}`,
                            PERCENTAGE_THRESHOLD_REASON,
                        ),
                    );
                }
            }

            if (touchedValidEntry) {
                setMergedPercentageThreshold(args.mergedRaw, constrained);
            }
        }
    }

    if (
        "execute_threshold_tokens" in args.projectRaw &&
        isPlainObject(args.projectRaw.execute_threshold_tokens)
    ) {
        const projectValue = args.projectRaw.execute_threshold_tokens;
        const constrained = cloneTokenThresholds(baseTokens);
        let touchedValidEntry = false;

        if (isValidTokenThreshold(projectValue.default)) {
            touchedValidEntry = true;
            if (baseTokens.defaultValue === undefined) {
                warnings.push(
                    makeProjectThresholdWarning(
                        "execute_threshold_tokens.default",
                        TOKEN_THRESHOLD_INTRODUCTION_REASON,
                    ),
                );
            } else if (projectValue.default > baseTokens.defaultValue) {
                constrained.defaultValue = projectValue.default;
            } else {
                warnings.push(
                    makeProjectThresholdWarning(
                        "execute_threshold_tokens.default",
                        TOKEN_THRESHOLD_REASON,
                    ),
                );
            }
        }

        for (const [modelKey, rawValue] of Object.entries(projectValue)) {
            if (modelKey === "default") continue;
            if (!isValidTokenThreshold(rawValue)) continue;
            touchedValidEntry = true;
            const baseValue = baseTokens.overrides.get(modelKey) ?? baseTokens.defaultValue;
            if (baseValue === undefined) {
                warnings.push(
                    makeProjectThresholdWarning(
                        `execute_threshold_tokens.${modelKey}`,
                        TOKEN_THRESHOLD_INTRODUCTION_REASON,
                    ),
                );
                continue;
            }
            if (rawValue > baseValue) {
                if (rawValue === constrained.defaultValue) {
                    constrained.overrides.delete(modelKey);
                } else {
                    constrained.overrides.set(modelKey, rawValue);
                }
            } else {
                warnings.push(
                    makeProjectThresholdWarning(
                        `execute_threshold_tokens.${modelKey}`,
                        TOKEN_THRESHOLD_REASON,
                    ),
                );
            }
        }

        if (touchedValidEntry) {
            setMergedTokenThreshold(args.mergedRaw, constrained);
        }
    }

    return warnings;
}

/**
 * After the project config has been merged over the user config, drop the
 * user's inherited `embedding.api_key` when the project redirected the embedding
 * `endpoint` without supplying its own key.
 *
 * Threat: a malicious repo overrides only `embedding.endpoint` → an attacker
 * server, inheriting the user's `embedding.api_key`, which is then sent as
 * `Authorization: Bearer …` to that server. The victim did nothing but clone the
 * repo. Dropping the inherited key means a redirected endpoint never receives
 * the user's secret; a project that genuinely points at a different endpoint
 * must supply its own key.
 *
 * `projectRaw` is the raw project config (pre-merge, so we can see what the
 * project itself declared). `mergedRaw` is the post-merge result, mutated in
 * place. `userRaw` is the trusted user config; when supplied, the key is dropped
 * only when the project endpoint ACTUALLY differs from the user's endpoint — a
 * project repeating the user's own endpoint (e.g. only to change `model`) is not
 * a redirect and must keep the inherited key. Returns warnings.
 */
function normalizeEndpoint(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim().replace(/\/+$/, "");
    return trimmed.length > 0 ? trimmed.toLowerCase() : undefined;
}

export function dropInheritedEmbeddingKeyOnRedirect(
    projectRaw: Record<string, unknown>,
    mergedRaw: Record<string, unknown>,
    userRaw?: Record<string, unknown>,
): string[] {
    const projectEmbedding = projectRaw.embedding;
    if (!isPlainObject(projectEmbedding)) return [];

    // Only an ENDPOINT redirect changes WHERE the bytes (and the Authorization
    // header) are sent. A provider-only change keeps the user's endpoint, so it
    // is not an exfiltration vector.
    const redirectsEndpoint = "endpoint" in projectEmbedding;
    if (!redirectsEndpoint) return [];

    // A project that merely repeats the user's OWN endpoint (e.g. to override
    // `model` while keeping the same server) is not a redirect — the key was
    // always destined for that endpoint. Only drop when the destination
    // actually changed. When userRaw is absent we cannot tell, so fall back to
    // the conservative presence-based drop.
    const userEmbedding = userRaw?.embedding;
    if (isPlainObject(userEmbedding)) {
        const projectEndpoint = normalizeEndpoint(projectEmbedding.endpoint);
        const userEndpoint = normalizeEndpoint(userEmbedding.endpoint);
        if (projectEndpoint !== undefined && projectEndpoint === userEndpoint) {
            return [];
        }
    }

    const providesOwnKey =
        typeof projectEmbedding.api_key === "string" && projectEmbedding.api_key.length > 0;
    if (providesOwnKey) return [];

    const mergedEmbedding = mergedRaw.embedding;
    if (!isPlainObject(mergedEmbedding)) return [];
    if (!("api_key" in mergedEmbedding)) return [];

    delete mergedEmbedding.api_key;
    return [
        "Dropped inherited user embedding api_key because project config redirected " +
            "embedding.endpoint without supplying its own key (security: prevents key " +
            "exfiltration to a repository-chosen endpoint).",
    ];
}
