import { homedir } from "node:os";
import { z } from "zod";
import { isValidLanguageCode } from "../../agents/language-directive";
import { DEFAULT_PROTECTED_TAGS } from "../../features/magic-context/defaults";
import { isValidCron } from "../../features/magic-context/dreamer/cron";
import type {
    AGENTIC_DREAM_TASKS,
    DreamTaskName,
} from "../../features/magic-context/dreamer/task-registry";
import { isValidPromptSurfaceModelKey } from "../../shared/prompt-surface";
import { AgentOverrideConfigSchema } from "./agent-overrides";

export const DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE = 65;
// Output reservation now removes generation capacity from the usable window.
// The 90% cap leaves roughly 10% of that safe input budget for mid-turn growth;
// escalation derives above the effective threshold and the 95% wall stays fixed.
export const EXECUTE_THRESHOLD_CAP_MESSAGE =
    "execute_threshold is capped at 90% for cache safety: output capacity is reserved from the usable context window, and the remaining 10% absorbs mid-turn growth before the absolute 95% emergency wall. Use a value between 20 and 90.";
export const DEFAULT_HISTORIAN_TIMEOUT_MS = 600_000;
export const DEFAULT_HISTORY_BUDGET_PERCENTAGE = 0.15;

export const DEFAULT_LOCAL_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

// Re-exported from the (DB-free) task registry so the schema and the runtime
// scheduler share ONE source of truth for task names. DreamingTask remains the
// agentic tasks (those driven by buildDreamTaskPrompt); CANONICAL_DREAM_TASKS
// is the full task set used for per-task scheduling config.
export type DreamingTask = (typeof AGENTIC_DREAM_TASKS)[number];

/** Valid thinking levels for Pi subagents. Maps to Pi's --thinking CLI flag.
 *  Off: disable reasoning. Minimal/low/medium/high/xhigh/max: increasing reasoning depth.
 *  `max` was added in Pi 0.83.0.
 *  Pi-only — OpenCode uses `variant` in agent config instead. */
export const PiThinkingLevelSchema = z
    .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
    .optional();
export type PiThinkingLevel = z.infer<typeof PiThinkingLevelSchema>;

/** OMP accepts Pi's thinking levels plus host-managed inheritance and automatic selection. */
export const OmpThinkingLevelSchema = z
    .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max", "inherit", "auto"])
    .optional();
export type OmpThinkingLevel = z.infer<typeof OmpThinkingLevelSchema>;

/** Pi-only child-process controls. This block is intentionally optional so an
 * absent allowlist preserves Pi's normal extension discovery behavior. */
export const PiConfigSchema = z
    .object({
        subagent_extensions: z
            .array(z.string().trim().min(1))
            .optional()
            .describe(
                "User-only allowlist of Pi extensions for Magic Context subagent children. When set, children use --no-extensions and load only these entries (plus Magic Context's scoped child extension where applicable). Relative paths resolve from ~/.pi/agent, matching Pi's settings.json package location. Unset preserves normal Pi extension discovery.",
            ),
    })
    .optional();
export type PiConfig = NonNullable<z.infer<typeof PiConfigSchema>>;

/**
 * Route the built-in prompt surface without changing guidance or tool registration.
 * Project config can choose preset routing; only user config can provide override text.
 */
export const PromptSurfacePresetSchema = z.enum(["full", "light"]);
export type { PromptSurfacePreset } from "../../shared/prompt-surface";

const PromptSurfaceModelKeySchema = z.string().refine(isValidPromptSurfaceModelKey, {
    message:
        "Use a non-empty bare model key, provider/model key, or the literal provider/* wildcard; model IDs may contain additional slashes and matching is case-sensitive.",
});
// Tool-description keys must be non-empty IDs; harness-specific known-tool
// validation can run when a user override is applied.
const PromptSurfaceToolKeySchema = z.string().refine((value) => value.trim().length > 0, {
    message: "tool description keys must not be empty or whitespace-only",
});

export const PromptSurfaceConfigSchema = z
    .object({
        default: PromptSurfacePresetSchema.default("full").describe(
            'Fallback prompt-surface preset ("full" or "light").',
        ),
        models: z
            .record(PromptSurfaceModelKeySchema, PromptSurfacePresetSchema)
            .optional()
            .describe(
                "Literal per-model routing. Keys are bare model IDs, provider/model, or provider/*; matching is case-sensitive and preserves additional slashes in model IDs.",
            ),
        guidance_override_path: z
            .string()
            .refine((value) => value.trim().length > 0, {
                message: "guidance_override_path must not be empty or whitespace-only",
            })
            .optional()
            .describe(
                "USER-LEVEL ONLY path to a complete primary guidance section. Relative paths resolve from the user config file.",
            ),
        tool_descriptions: z
            .record(
                PromptSurfaceToolKeySchema,
                z.string().refine((value) => value.trim().length > 0, {
                    message: "tool description values must not be empty or whitespace-only",
                }),
            )
            .optional()
            .describe(
                "USER-LEVEL ONLY top-level description overrides keyed by ctx_* tool ID; parameter schemas and descriptions are unchanged.",
            ),
    })
    .describe(
        "Prompt-surface preset routing. Project config may select default/models, while guidance_override_path and tool_descriptions are user-level only.",
    );
export type PromptSurfaceConfig = z.infer<typeof PromptSurfaceConfigSchema>;

/**
 * The flat model-resolution fields are the only fields that move into harness
 * blocks. Keeping this inventory next to the schema gives the loader migration
 * an exhaustive contract instead of a catch-all rule.
 */
export const PER_HARNESS_MIGRATION_INVENTORY = {
    historian: {
        retained: [
            "temperature",
            "top_p",
            "prompt",
            "tools",
            "disable",
            "description",
            "mode",
            "color",
            "maxSteps",
            "permission",
            "maxTokens",
            "two_pass",
            "disallowed_tools",
        ],
        migrated_execution: ["model", "fallback_models", "variant", "thinking_level"],
    },
    dreamer: {
        retained: [
            "temperature",
            "top_p",
            "prompt",
            "tools",
            "disable",
            "description",
            "mode",
            "color",
            "maxSteps",
            "permission",
            "maxTokens",
            "inject_docs",
        ],
        migrated_execution: ["model", "fallback_models", "variant", "thinking_level"],
    },
    task: {
        retained: ["schedule", "promotion_threshold"],
        migrated_execution: [
            "model",
            "fallback_models",
            "variant",
            "thinking_level",
            "timeout_minutes",
        ],
    },
} as const;

/** Harness keys that own independent hidden-agent model-selection blocks. */
export const PER_HARNESS_MODEL_KEYS = ["opencode", "pi", "omp"] as const;

/** OpenCode entry objects permit `variant` and reject Pi-only `thinking_level`. */
const OcEntryObjectSchema = z
    .object({
        model: z.string().describe("OpenCode model ID (for example, provider/model)."),
        variant: z.string().optional().describe("OpenCode reasoning variant for this entry."),
    })
    .strict();
export const OcEntrySchema = z.union([z.string(), OcEntryObjectSchema]);
export type OcEntry = z.infer<typeof OcEntrySchema>;

/** Pi entry objects permit `thinking_level` and reject OpenCode-only `variant`. */
const PiEntryObjectSchema = z
    .object({
        model: z.string().describe("Pi model ID (for example, provider/model)."),
        thinking_level: PiThinkingLevelSchema.describe("Pi thinking level for this entry."),
    })
    .strict();
export const PiEntrySchema = z.union([z.string(), PiEntryObjectSchema]);
export type PiEntry = z.infer<typeof PiEntrySchema>;

/** OMP entry objects use Pi's qualifier vocabulary, including OMP-only auto/inherit. */
const OmpEntryObjectSchema = z
    .object({
        model: z.string().describe("OMP model ID (for example, provider/model)."),
        thinking_level: OmpThinkingLevelSchema.describe("OMP thinking level for this entry."),
    })
    .strict();
export const OmpEntrySchema = z.union([z.string(), OmpEntryObjectSchema]);
export type OmpEntry = z.infer<typeof OmpEntrySchema>;

/** Strict model-resolution block used by historian.opencode. */
export const OpenCodeHarnessBlockSchema = z
    .object({
        model: OcEntrySchema.optional().describe("Primary OpenCode model entry."),
        fallback_models: z
            .array(OcEntrySchema)
            .optional()
            .describe(
                "Ordered fallback OpenCode entries. New-shape configuration requires an array; legacy singleton values migrate to a one-element array.",
            ),
        variant: z
            .string()
            .optional()
            .describe(
                "OpenCode reasoning variant for the primary entry when it declares none. Fallback entries declare variants per-entry.",
            ),
    })
    .strict()
    .describe("Strict OpenCode model-resolution block. It accepts no Pi vocabulary.");
export type OpenCodeHarnessBlock = z.infer<typeof OpenCodeHarnessBlockSchema>;

/** Strict model-resolution block used by historian.pi. */
export const PiHarnessBlockSchema = z
    .object({
        model: PiEntrySchema.optional().describe("Primary Pi model entry."),
        fallback_models: z
            .array(PiEntrySchema)
            .optional()
            .describe(
                "Ordered fallback Pi entries. New-shape configuration requires an array; legacy singleton values migrate to a one-element array.",
            ),
        thinking_level: PiThinkingLevelSchema.describe(
            "Pi thinking level for the primary entry when it declares none. Fallback entries declare thinking levels per-entry.",
        ),
    })
    .strict()
    .describe("Strict Pi model-resolution block. It accepts no OpenCode vocabulary.");
export type PiHarnessBlock = z.infer<typeof PiHarnessBlockSchema>;

/** Strict model-resolution block used by historian.omp. */
export const OmpHarnessBlockSchema = z
    .object({
        model: OmpEntrySchema.optional().describe("Primary OMP model entry."),
        fallback_models: z
            .array(OmpEntrySchema)
            .optional()
            .describe("Ordered fallback OMP entries."),
        thinking_level: OmpThinkingLevelSchema.describe(
            "OMP thinking level for the primary entry when it declares none. Fallback entries declare thinking levels per-entry.",
        ),
    })
    .strict()
    .describe("Strict OMP model-resolution block. It accepts no OpenCode vocabulary.");
export type OmpHarnessBlock = z.infer<typeof OmpHarnessBlockSchema>;

/** Strict OpenCode-only execution override for one dreamer task. */
export const OpenCodeTaskExecutionSchema = z
    .object({
        model: OcEntrySchema.optional().describe("OpenCode model entry for this task."),
        fallback_models: z
            .array(OcEntrySchema)
            .optional()
            .describe("Ordered OpenCode fallback entries for this task."),
        variant: z
            .string()
            .optional()
            .describe(
                "OpenCode reasoning variant for this task's primary entry when it declares none. Fallback entries declare variants per-entry.",
            ),
        timeout_minutes: z
            .number()
            .min(5)
            .optional()
            .describe("Minutes allowed for this task before it is aborted."),
    })
    .strict();
export type OpenCodeTaskExecution = z.infer<typeof OpenCodeTaskExecutionSchema>;

/** Strict Pi-only execution override for one dreamer task. */
export const PiTaskExecutionSchema = z
    .object({
        model: PiEntrySchema.optional().describe("Pi model entry for this task."),
        fallback_models: z
            .array(PiEntrySchema)
            .optional()
            .describe("Ordered Pi fallback entries for this task."),
        thinking_level: PiThinkingLevelSchema.describe(
            "Pi thinking level for this task's primary entry when it declares none. Fallback entries declare thinking levels per-entry.",
        ),
        timeout_minutes: z
            .number()
            .min(5)
            .optional()
            .describe("Minutes allowed for this task before it is aborted."),
    })
    .strict();
export type PiTaskExecution = z.infer<typeof PiTaskExecutionSchema>;

/** Strict OMP-only execution override for one dreamer task. */
export const OmpTaskExecutionSchema = z
    .object({
        model: OmpEntrySchema.optional().describe("OMP model entry for this task."),
        fallback_models: z
            .array(OmpEntrySchema)
            .optional()
            .describe("Ordered OMP fallback entries for this task."),
        thinking_level: OmpThinkingLevelSchema.describe(
            "OMP thinking level for this task's primary entry when it declares none. Fallback entries declare thinking levels per-entry.",
        ),
        timeout_minutes: z
            .number()
            .min(5)
            .optional()
            .describe("Minutes allowed for this task before it is aborted."),
    })
    .strict();
export type OmpTaskExecution = z.infer<typeof OmpTaskExecutionSchema>;

/** Strict OpenCode harness block for dreamer execution and task overrides. */
export const DreamerOpenCodeHarnessBlockSchema = z
    .object({
        model: OcEntrySchema.optional().describe("Primary OpenCode model entry."),
        fallback_models: z
            .array(OcEntrySchema)
            .optional()
            .describe(
                "Ordered fallback OpenCode entries. New-shape configuration requires an array; legacy singleton values migrate to a one-element array.",
            ),
        variant: z
            .string()
            .optional()
            .describe(
                "OpenCode reasoning variant for the primary entry when it declares none. Fallback entries declare variants per-entry.",
            ),
        tasks: z
            .record(z.string(), OpenCodeTaskExecutionSchema)
            .optional()
            .describe(
                "OpenCode task execution overrides. Each named task accepts only model, fallback_models, variant, and timeout_minutes.",
            ),
    })
    .strict()
    .describe("Strict OpenCode dreamer model-resolution block. It accepts no Pi vocabulary.");
export type DreamerOpenCodeHarnessBlock = z.infer<typeof DreamerOpenCodeHarnessBlockSchema>;

/** Strict Pi harness block for dreamer execution and task overrides. */
export const DreamerPiHarnessBlockSchema = z
    .object({
        model: PiEntrySchema.optional().describe("Primary Pi model entry."),
        fallback_models: z
            .array(PiEntrySchema)
            .optional()
            .describe(
                "Ordered fallback Pi entries. New-shape configuration requires an array; legacy singleton values migrate to a one-element array.",
            ),
        thinking_level: PiThinkingLevelSchema.describe(
            "Pi thinking level for the primary entry when it declares none. Fallback entries declare thinking levels per-entry.",
        ),
        tasks: z
            .record(z.string(), PiTaskExecutionSchema)
            .optional()
            .describe(
                "Pi task execution overrides. Each named task accepts only model, fallback_models, thinking_level, and timeout_minutes.",
            ),
    })
    .strict()
    .describe("Strict Pi dreamer model-resolution block. It accepts no OpenCode vocabulary.");
export type DreamerPiHarnessBlock = z.infer<typeof DreamerPiHarnessBlockSchema>;

/** Strict OMP harness block for dreamer execution and task overrides. */
export const DreamerOmpHarnessBlockSchema = z
    .object({
        model: OmpEntrySchema.optional().describe("Primary OMP model entry."),
        fallback_models: z
            .array(OmpEntrySchema)
            .optional()
            .describe("Ordered fallback OMP entries."),
        thinking_level: OmpThinkingLevelSchema.describe(
            "OMP thinking level for the primary entry when it declares none. Fallback entries declare thinking levels per-entry.",
        ),
        tasks: z
            .record(z.string(), OmpTaskExecutionSchema)
            .optional()
            .describe(
                "OMP task execution overrides. Each named task accepts only model, fallback_models, thinking_level, and timeout_minutes.",
            ),
    })
    .strict()
    .describe("Strict OMP dreamer model-resolution block. It accepts no OpenCode vocabulary.");
export type DreamerOmpHarnessBlock = z.infer<typeof DreamerOmpHarnessBlockSchema>;

/**
 * A profile may select models but must not alter execution policy. Keep this
 * separate from the full harness schemas, whose dreamer blocks also admit task
 * overrides such as timeout_minutes.
 */
const ProfileOpenCodeModelBlockSchema = z
    .object({
        model: OcEntrySchema.optional().describe("Primary OpenCode model entry."),
        fallback_models: z
            .array(OcEntrySchema)
            .optional()
            .describe("Ordered fallback OpenCode model entries."),
        variant: z
            .string()
            .optional()
            .describe("OpenCode reasoning variant for the primary model entry."),
    })
    .strict()
    .describe("Strict profile-only OpenCode model-selection block.");
const ProfilePiModelBlockSchema = z
    .object({
        model: PiEntrySchema.optional().describe("Primary Pi model entry."),
        fallback_models: z
            .array(PiEntrySchema)
            .optional()
            .describe("Ordered fallback Pi model entries."),
        thinking_level: PiThinkingLevelSchema.describe(
            "Pi thinking level for the primary model entry.",
        ),
    })
    .strict()
    .describe("Strict profile-only Pi model-selection block.");
const ProfileOmpModelBlockSchema = z
    .object({
        model: OmpEntrySchema.optional().describe("Primary OMP model entry."),
        fallback_models: z
            .array(OmpEntrySchema)
            .optional()
            .describe("Ordered fallback OMP model entries."),
        thinking_level: OmpThinkingLevelSchema.describe(
            "OMP thinking level for the primary model entry.",
        ),
    })
    .strict()
    .describe("Strict profile-only OMP model-selection block.");
const ProfileHistorianSchema = z
    .object({
        opencode: ProfileOpenCodeModelBlockSchema.optional(),
        pi: ProfilePiModelBlockSchema.optional(),
        omp: ProfileOmpModelBlockSchema.optional(),
    })
    .strict();
const ProfileDreamerSchema = z
    .object({
        opencode: ProfileOpenCodeModelBlockSchema.optional(),
        pi: ProfilePiModelBlockSchema.optional(),
        omp: ProfileOmpModelBlockSchema.optional(),
    })
    .strict();
const ProfileSidekickSchema = AgentOverrideConfigSchema.pick({
    model: true,
    fallback_models: true,
    variant: true,
})
    .extend({
        thinking_level: PiThinkingLevelSchema.describe(
            "Pi thinking level for the sidekick model selection.",
        ),
    })
    .strict();

export const ConfigProfileSchema = z
    .object({
        historian: ProfileHistorianSchema.optional(),
        dreamer: ProfileDreamerSchema.optional(),
        sidekick: ProfileSidekickSchema.optional(),
    })
    .strict()
    .describe(
        "User-owned model-selection overlay. Only historian/dreamer harness model blocks and sidekick model-selection fields are allowed.",
    );
export type ConfigProfile = z.infer<typeof ConfigProfileSchema>;

export const ConfigProfilesSchema = z.record(
    z.string().trim().min(1, "Profile names must not be empty or whitespace-only."),
    ConfigProfileSchema,
);
export type ConfigProfiles = z.infer<typeof ConfigProfilesSchema>;

/** A 5-field cron expression, or "" to disable the task. */
const CronScheduleSchema = z
    .string()
    .refine((s) => s.trim() === "" || isValidCron(s), {
        message:
            'Invalid schedule: use a 5-field cron expression (e.g. "0 3 * * *" for 3am daily, "0 3 * * 0" for Sunday 3am, "0 */6 * * *" every 6h) or "" to disable.',
    })
    .describe('5-field cron schedule (e.g. "0 3 * * *"), or "" to disable this task.');

/**
 * Harness-independent task metadata. These fields stay at dreamer.tasks.<task>
 * during per-harness migration; model execution fields are deliberately absent.
 */
const DreamTaskBaseConfigSchema = z
    .object({
        schedule: CronScheduleSchema.default(""),
    })
    .strict();

const PromotionThresholdSchema = z
    .number()
    .min(2)
    .max(20)
    .optional()
    .describe(
        "review-user-memories: min candidate observations before promotion is considered (default: 3)",
    );
const PrimerPromotionThresholdSchema = z
    .number()
    .min(2)
    .max(20)
    .optional()
    .describe(
        "promote-primers: min recurring source days before promotion is considered (default: 2)",
    );
export const DreamTaskConfigSchema = DreamTaskBaseConfigSchema.extend({
    promotion_threshold: PromotionThresholdSchema,
});
const ReviewUserMemoriesTaskConfigSchema = DreamTaskBaseConfigSchema.extend({
    promotion_threshold: PromotionThresholdSchema,
});
const PromotePrimersTaskConfigSchema = DreamTaskBaseConfigSchema.extend({
    promotion_threshold: PrimerPromotionThresholdSchema,
});
export type DreamTaskConfig = z.infer<typeof DreamTaskConfigSchema>;

/** Default schedule per task. Preserves v1 behavior: verify runs nightly;
 *  curate runs weekly; classify runs daily after curation; maintain-docs
 *  defaults OFF (it was not in the v1 default list); the two promoted
 *  post-phases run nightly and are gated. */
const DEFAULT_TASK_SCHEDULES: Record<DreamTaskName, string> = {
    // map-memories is a one-time-style backfill (gate: unmapped memories exist).
    // Default nightly so it drains the pool then no-ops once everything is mapped.
    "map-memories": "0 2 * * *",
    verify: "0 3 * * *",
    "verify-broad": "0 4 * * 0",
    curate: "0 4 * * 0",
    // Daily trickle: chunks are small (~40 memories), so after the initial
    // backfill the per-memory cue compression is cheap to run every night.
    "compress-cues": "0 4 * * *",
    "classify-memories": "0 6 * * *",
    retrospective: "0 5 * * *",
    "maintain-docs": "",
    "evaluate-smart-notes": "0 3 * * *",
    "review-user-memories": "0 3 * * *",
    "promote-primers": "0 3 * * *",
    "refresh-primers": "0 3 * * *",
};

function defaultTaskConfig(task: DreamTaskName): z.input<typeof DreamTaskConfigSchema> {
    const base: z.input<typeof DreamTaskConfigSchema> = { schedule: DEFAULT_TASK_SCHEDULES[task] };
    if (task === "review-user-memories") base.promotion_threshold = 3;
    if (task === "promote-primers") base.promotion_threshold = 2;
    return base;
}

/** The harness-independent task metadata record. Schedule remains the only
 * disable control; runtime gates are not configuration fields. */
export const DreamTasksSchema = z
    .object({
        "map-memories": DreamTaskBaseConfigSchema.default(() =>
            DreamTaskBaseConfigSchema.parse(defaultTaskConfig("map-memories")),
        ),
        verify: DreamTaskBaseConfigSchema.default(() =>
            DreamTaskBaseConfigSchema.parse(defaultTaskConfig("verify")),
        ),
        "verify-broad": DreamTaskBaseConfigSchema.default(() =>
            DreamTaskBaseConfigSchema.parse(defaultTaskConfig("verify-broad")),
        ),
        curate: DreamTaskBaseConfigSchema.default(() =>
            DreamTaskBaseConfigSchema.parse(defaultTaskConfig("curate")),
        ),
        "compress-cues": DreamTaskBaseConfigSchema.default(() =>
            DreamTaskBaseConfigSchema.parse(defaultTaskConfig("compress-cues")),
        ),
        "classify-memories": DreamTaskBaseConfigSchema.default(() =>
            DreamTaskBaseConfigSchema.parse(defaultTaskConfig("classify-memories")),
        ),
        retrospective: DreamTaskBaseConfigSchema.default(() =>
            DreamTaskBaseConfigSchema.parse(defaultTaskConfig("retrospective")),
        ),
        "maintain-docs": DreamTaskBaseConfigSchema.default(() =>
            DreamTaskBaseConfigSchema.parse(defaultTaskConfig("maintain-docs")),
        ),
        "evaluate-smart-notes": DreamTaskBaseConfigSchema.default(() =>
            DreamTaskBaseConfigSchema.parse(defaultTaskConfig("evaluate-smart-notes")),
        ),
        "review-user-memories": ReviewUserMemoriesTaskConfigSchema.default(() =>
            ReviewUserMemoriesTaskConfigSchema.parse(defaultTaskConfig("review-user-memories")),
        ),
        "promote-primers": PromotePrimersTaskConfigSchema.default(() =>
            PromotePrimersTaskConfigSchema.parse(defaultTaskConfig("promote-primers")),
        ),
        "refresh-primers": DreamTaskBaseConfigSchema.default(() =>
            DreamTaskBaseConfigSchema.parse(defaultTaskConfig("refresh-primers")),
        ),
    })
    .describe(
        "Harness-independent task metadata. schedule, promotion_threshold, and other task metadata remain here; execution settings live under dreamer.opencode.tasks, dreamer.pi.tasks, or dreamer.omp.tasks.",
    );

const AgentMetadataSchema = AgentOverrideConfigSchema.pick({
    temperature: true,
    top_p: true,
    prompt: true,
    tools: true,
    disable: true,
    description: true,
    mode: true,
    color: true,
    maxSteps: true,
    permission: true,
    maxTokens: true,
});

/** Combined dreamer metadata plus independent strict execution blocks. */
export const DreamerConfigSchema = AgentMetadataSchema.extend({
    opencode: DreamerOpenCodeHarnessBlockSchema.optional(),
    pi: DreamerPiHarnessBlockSchema.optional(),
    omp: DreamerOmpHarnessBlockSchema.optional(),
    tasks: DreamTasksSchema.default(() => DreamTasksSchema.parse({})),
    inject_docs: z
        .boolean()
        .default(true)
        .describe(
            "Inject ARCHITECTURE.md and STRUCTURE.md into the m[0] `<project-docs>` block (default true)",
        ),
});
export type DreamerConfig = z.infer<typeof DreamerConfigSchema>;

export const SidekickConfigSchema = AgentOverrideConfigSchema.extend({
    timeout_ms: z.number().default(30000).describe("Timeout for sidekick calls in milliseconds"),
    system_prompt: z.string().optional().describe("Custom system prompt for sidekick"),
    thinking_level: PiThinkingLevelSchema.describe(
        "Pi only: explicit thinking level for sidekick subagent invocations. See historian.pi.thinking_level.",
    ),
}).optional();
export type SidekickConfig = NonNullable<z.infer<typeof SidekickConfigSchema>>;

/**
 * Historian metadata remains harness-independent. Only model resolution moves to
 * the strict opencode, pi, and omp blocks; two_pass and disallowed_tools stay here.
 */
export const HistorianConfigSchema = AgentMetadataSchema.extend({
    opencode: OpenCodeHarnessBlockSchema.optional(),
    pi: PiHarnessBlockSchema.optional(),
    omp: OmpHarnessBlockSchema.optional(),
    two_pass: z
        .boolean()
        .default(false)
        .describe(
            "Run a second editor pass over historian output to clean low-signal U: lines and cross-compartment duplicates. Adds ~1 extra API call and ~1.3x cost per historian run. Useful for models without extended thinking support. (default: false)",
        ),
    disallowed_tools: z
        .array(z.enum(["*", "read", "aft_outline", "aft_zoom", "aft_search"]))
        .default([])
        .describe(
            'OpenCode only. Tools to REMOVE from the historian\'s default allow-list [read, aft_outline, aft_zoom, aft_search]. Applies to both historian and historian-editor agents. Use ["*"] to strip all tool definitions from the model request — this prevents weak instruction-following models (e.g. mistral-small-latest) from entering tool-calling loops. Individual tool names remove just that tool. Note: a user-supplied historian.permission override can re-allow a tool that disallowed_tools removed — disallowed_tools sets the baseline, permission overrides take precedence. (default: [])',
        ),
}).optional();
export type HistorianConfig = NonNullable<z.infer<typeof HistorianConfigSchema>>;

const EmbeddingFallbackProviderSchema = z.enum(["local", "openai-compatible", "off"]);

function expandConfigPath(value: string): string {
    const trimmed = value.trim();
    if (trimmed === "~") return homedir();
    if (trimmed.startsWith("~/")) return `${homedir()}/${trimmed.slice(2)}`;
    return trimmed;
}

const BaseEmbeddingConfigSchema = z
    .object({
        provider: z
            .enum(["local", "openai-compatible", "off", "synapse"])
            .default("local")
            .describe(
                "Embedding provider. 'local' uses Xenova/all-MiniLM-L6-v2, 'openai-compatible' requires endpoint and model, 'synapse' uses the certified local Synapse lane with an explicit fallback provider, and 'off' disables embeddings.",
            ),
        fallback_provider: EmbeddingFallbackProviderSchema.optional().describe(
            "Fallback provider for the Synapse lane. Required when provider is 'synapse'; local, openai-compatible, and off are valid.",
        ),
        model: z
            .string()
            .optional()
            .describe("Embedding model name. Required for openai-compatible, ignored for local."),
        endpoint: z
            .string()
            .optional()
            .describe("API endpoint URL. Required when provider is openai-compatible."),
        api_key: z.string().optional().describe("API key for remote embedding provider (optional)"),
        input_type: z
            .string()
            .optional()
            .describe(
                "Default input_type for stored/indexed (passage) embeddings in the request body. Required by some openai-compatible providers (e.g. NVIDIA NIM). Omitted from the request when unset.",
            ),
        query_input_type: z
            .string()
            .optional()
            .describe(
                "Optional input_type for query (search) embeddings on asymmetric models (e.g. NVIDIA NIM 'query'). When unset, query embeddings use embedding.input_type. Passage/stored content always uses embedding.input_type.",
            ),
        truncate: z
            .string()
            .optional()
            .describe(
                "Optional truncate mode sent in the embedding request body (e.g. NVIDIA NIM accepts 'NONE' | 'START' | 'END'). Omitted from the request when unset.",
            ),
        max_input_tokens: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
                "Optional maximum input tokens for chunk embeddings. Defaults conservatively to 512 when omitted.",
            ),
        dimensions: z
            .number()
            .int()
            .positive()
            .max(8192)
            .optional()
            .describe(
                "Optional embedding dimensions for Matryoshka models like Qwen3-Embedding (e.g. 768, 1024, 4096). When set, sent as dimensions in the embedding request body. Omitted keeps provider default.",
            ),
        local_runtime: z
            .enum(["auto", "native", "wasm"])
            .default("auto")
            .describe(
                "Local provider only: ONNX runtime selection. 'auto' uses native under Node and uses WASM under Bun versions before 1.4.0, where Bun's NAPI teardown race can panic on quit; native is restored automatically on Bun 1.4.0+. Set 'native' only to prefer speed while accepting that pre-1.4.0 Bun crash risk, or 'wasm' to avoid loading the native addon.",
            ),
        local_dtype: z
            .enum([
                "auto",
                "fp32",
                "fp16",
                "q8",
                "int8",
                "uint8",
                "q4",
                "bnb4",
                "q4f16",
                "q2",
                "q2f16",
                "q1",
                "q1f16",
            ])
            .optional()
            .describe(
                "Local provider only: ONNX model dtype passed to the transformers.js feature-extraction pipeline. Accepts the @huggingface/transformers DataType strings (auto, fp32, fp16, q8, int8, uint8, q4, bnb4, q4f16, q2, q2f16, q1, q1f16). Omitted keeps today's behavior (fp32). A non-default value changes the produced vectors and folds into the embedding model identity, so switching dtype re-embeds rather than mixing vector spaces. Useful for selecting a quantized variant (e.g. q8) of a larger multilingual model to cut memory and CPU cost; see issue #259.",
            ),
    })
    .superRefine((data, ctx) => {
        const validationProvider =
            data.provider === "synapse" ? data.fallback_provider : data.provider;
        if (validationProvider === "openai-compatible" && !data.endpoint?.trim()) {
            ctx.addIssue({
                code: "custom",
                path: ["endpoint"],
                message: "endpoint is required when embedding.provider is openai-compatible",
            });
        }

        if (validationProvider === "openai-compatible" && !data.model?.trim()) {
            ctx.addIssue({
                code: "custom",
                path: ["model"],
                message: "model is required when embedding.provider is openai-compatible",
            });
        }
    });

export const EmbeddingConfigSchema = BaseEmbeddingConfigSchema.transform((data) => {
    if (data.provider === "synapse") {
        const model = data.model?.trim();
        const endpoint = data.endpoint?.trim();
        const apiKey = data.api_key?.trim();
        const inputType = data.input_type?.trim();
        const queryInputType = data.query_input_type?.trim();
        const truncate = data.truncate?.trim();
        return {
            provider: "synapse" as const,
            ...(data.fallback_provider ? { fallback_provider: data.fallback_provider } : {}),
            ...(model ? { model } : {}),
            ...(endpoint ? { endpoint } : {}),
            ...(apiKey ? { api_key: apiKey } : {}),
            ...(inputType ? { input_type: inputType } : {}),
            ...(queryInputType ? { query_input_type: queryInputType } : {}),
            ...(truncate ? { truncate } : {}),
            ...(data.dimensions ? { dimensions: data.dimensions } : {}),
            ...(data.max_input_tokens ? { max_input_tokens: data.max_input_tokens } : {}),
        };
    }

    if (data.provider === "local") {
        return {
            provider: "local" as const,
            model: data.model?.trim() || DEFAULT_LOCAL_EMBEDDING_MODEL,
            local_runtime: data.local_runtime,
            ...(data.max_input_tokens ? { max_input_tokens: data.max_input_tokens } : {}),
            // local_dtype is spread CONDITIONALLY: omitting it when unset keeps
            // the identity byte-identical for the common no-dtype config, so
            // adding this field does not force a global re-embed — only configs
            // that actually set a dtype get a new identity (and under per-model
            // coexistence even that just coexists + lazily GCs, never a
            // destructive wipe). Mirrors the truncate fold pattern.
            ...(data.local_dtype ? { local_dtype: data.local_dtype } : {}),
        };
    }

    if (data.provider === "openai-compatible") {
        const apiKey = data.api_key?.trim();
        const inputType = data.input_type?.trim();
        const queryInputType = data.query_input_type?.trim();
        const truncate = data.truncate?.trim();
        return {
            provider: "openai-compatible" as const,
            model: data.model?.trim() ?? "",
            endpoint: data.endpoint?.trim() ?? "",
            ...(apiKey ? { api_key: apiKey } : {}),
            ...(inputType ? { input_type: inputType } : {}),
            ...(queryInputType ? { query_input_type: queryInputType } : {}),
            ...(truncate ? { truncate } : {}),
            ...(data.dimensions ? { dimensions: data.dimensions } : {}),
            ...(data.max_input_tokens ? { max_input_tokens: data.max_input_tokens } : {}),
        };
    }

    return { provider: "off" as const };
});

export type EmbeddingConfig = z.infer<typeof EmbeddingConfigSchema>;
export type EmbeddingFallbackProvider = z.infer<typeof EmbeddingFallbackProviderSchema>;

export interface SubcConfig {
    connection_file: string;
}

export interface ShadowEmbeddingConfig {
    enabled: boolean;
}

export interface MuralConfig {
    enabled: boolean;
    /** The CUE COMPRESSOR model for the compress-cues dreamer task (the mural is
     *  now rendered deterministically, so this no longer names an author model). */
    model?: string;
}

export interface MagicContextConfig {
    enabled: boolean;
    /** User-level setting that lets a session started exactly in the canonical home directory use a deterministic directory identity. */
    allow_home_project: boolean;
    mural: MuralConfig;
    /** Selects the runtime implementation for this project. Rust mode is experimental and requires user-level subc configuration. */
    transform_mode: "ts" | "rust";
    /** Auto-update the cached OpenCode plugin wrapper when a newer npm version is available.
     *  USER config only; project configs cannot disable it. Default: true. */
    auto_update?: boolean;
    /** Output language for generated Magic Context prose. USER config only. */
    language?: string;
    /** Active user-owned model profile after user/project resolution. */
    profile?: string;
    /** Named user-owned model profiles. Declarations are consumed during resolution. */
    profiles?: ConfigProfiles;
    historian?: HistorianConfig;
    dreamer?: DreamerConfig;
    smart_notes: {
        /** Flip ownership of authoring-compiled conditions from dreamer to retina. */
        retina_handoff: boolean;
    };
    cache_ttl: string | { default: string; [modelKey: string]: string };
    /** Preset routing for guidance and provider-visible prompt surfaces. */
    prompt_surface: PromptSurfaceConfig;
    /** User-only output-token reservation override. Zero disables reservation. */
    output_reserve?: number | { default: number; [modelKey: string]: number };
    /** User-only model metadata inputs. */
    models?: { window_overlay_path?: string };
    /** TUI toast lifetime in milliseconds for Magic Context notifications. Default: 5000. */
    toast_duration_ms?: number;
    execute_threshold_percentage: number | { default: number; [modelKey: string]: number };
    /** Absolute token thresholds per model. When set for a given model (or via `default`),
     *  this overrides `execute_threshold_percentage` for that model. Useful for hard caps
     *  matching provider input limits. Values above 90% × context_limit are clamped with a warning. */
    execute_threshold_tokens?: { default?: number; [modelKey: string]: number | undefined };
    protected_tags: number;
    clear_reasoning_age: number;
    history_budget_percentage: number;
    historian_timeout_ms: number;
    commit_cluster_trigger: {
        enabled: boolean;
        min_clusters: number;
    };
    /** Per-connection SQLite tuning for Magic Context's own context.db. */
    sqlite: {
        cache_size_mb: number;
        mmap_size_mb: number;
    };
    /**
     * Keep shared-storage permissions under an external operator's control.
     * USER config only; project configs cannot weaken local data privacy.
     */
    storage: {
        enforce_private_permissions: boolean;
    };
    /**
     * Controls whether and where Magic Context augments the system prompt
     * (`## Magic Context` guidance, `<project-docs>`, `<user-profile>`,
     * sticky date) inside `experimental.chat.system.transform`.
     *
     * Internal OpenCode hidden agents (title, summary, compaction) are
     * always skipped automatically — that's a separate code path.
     */
    system_prompt_injection: {
        /** When false, NO injection happens for ANY agent — global escape hatch. */
        enabled: boolean;
        /**
         * If the agent's system prompt contains any of these substrings,
         * skip ALL Magic Context injection for that call. Lets users opt
         * specific agents out (e.g. read-only QA agents that deny our
         * `ctx_*` tools and don't need the guidance). The default marker
         * `<!-- magic-context: skip -->` is meant to be added inside the
         * user's custom agent prompt.
         */
        skip_signatures: string[];
    };
    /** Inject elapsed-time markers between user messages and date ranges on
     *  compartments so the agent has a wall-clock sense of the session.
     *  Graduated from `experimental.temporal_awareness`; default: true. */
    temporal_awareness: boolean;
    /** Debug: when true, keep the child sessions Magic Context spawns for its
     *  own subagents (historian, dreamer, sidekick, memory-migration) instead
     *  of deleting them on success. For short-term inspection/data collection;
     *  kept sessions accumulate until manually cleared. Default false. */
    keep_subagents: boolean;
    /**
     * When true (default), deterministic inoperability (schema fence, storage
     * open/migration failure) blocks the primary-session transform with a loud
     * recovery error instead of silently falling through to native compaction.
     * USER config only — project tier cannot set this. Not recommended to disable.
     */
    fail_closed_blocking: boolean;
    /**
     * Compaction-off mode gate. When `enabled` is false Magic Context stops
     * managing the context window and keeps only its knowledge layer, letting
     * the harness's native compaction (or nothing) own the window. USER config
     * only — project tier `compaction.enabled` is stripped for security.
     * Boot-resolved: changing it requires a process restart.
     */
    compaction: {
        enabled: boolean;
    };
    /** Pi-only controls for Magic Context's OpenCode-parity todowrite surface. */
    todowrite: {
        enabled: boolean;
        overlay: boolean;
    };
    /** Pi-only child-process extension controls. */
    pi?: PiConfig;
    /** Content-aware reclaim of tool output that a later call supersedes, added
     *  to the normal age-based auto-drop: superseded todowrite/ctx_reduce/meta
     *  outputs are dropped, and older edits to a file are compressed to a marker
     *  that keeps only the filePath. Only runs on a transform pass that is
     *  already rewriting the messages, so it never triggers a prompt-cache miss
     *  on its own; when off, the messages sent to the model are byte-identical to
     *  the age-based-only behavior. Experimental, opt-in, default off until cache
     *  stability is proven. */
    smart_drops: boolean;
    /**
     * Age-tier caveman compression for long user/assistant text parts.
     * Graduated from `experimental.caveman_text_compression`; opt-in, default off.
     *
     * Active only for primary sessions when enabled; never for subagents.
     * Buckets eligible (outside-protected-tail) messages into four age
     * tiers by tag position — oldest 20% → ultra, next 20% → full,
     * next 20% → lite, newest 40% → untouched — and rewrites the text
     * part in place.
     * Always compresses from the original source (source_contents), so
     * tier shifts produce the same result as if the target depth were
     * applied directly to the original text.
     *
     * Disabled by default because it rewrites agent-visible history.
     */
    caveman_text_compression: {
        enabled: boolean;
        /** Text parts shorter than this (characters) are left untouched. */
        min_chars: number;
    };
    embedding: EmbeddingConfig;
    /** User-only connection settings for the Synapse daemon. */
    subc?: SubcConfig;
    /** Developer-only Synapse shadow lane switch. */
    shadow_embedding?: ShadowEmbeddingConfig;
    memory: {
        enabled: boolean;
        injection_budget_tokens: number;
        auto_promote: boolean;
        retrieval_count_promotion_threshold: number;
        /** Appends a compact hint to new user messages when ctx_search finds
         *  highly-related memories, conversation, or git commits. Does NOT
         *  inject full content — just vague fragments that nudge the agent to
         *  run ctx_search for full context if relevant. Graduated from
         *  `experimental.auto_search`; enabled by default. Independent of
         *  `memory.enabled` — it can still surface conversation/git hints when
         *  the memory store is off. */
        auto_search: {
            enabled: boolean;
            /** Top hit score must exceed this threshold for the hint to fire. */
            score_threshold: number;
            /** Minimum user message length in characters (skip short prompts). */
            min_prompt_chars: number;
        };
        /** Index git commit messages from HEAD into a new ctx_search source so
         *  agents can recall recent regressions, fixes, and decisions from
         *  commit history without running git log manually. Graduated from
         *  `experimental.git_commit_indexing`; opt-in, default off. Independent
         *  of `memory.enabled`. */
        git_commit_indexing: {
            enabled: boolean;
            /** Days of history to index (default: 365) */
            since_days: number;
            /** Max commits kept per project; oldest evicted (default: 2000) */
            max_commits: number;
        };
    };
    sidekick?: SidekickConfig;
}

export const MagicContextConfigSchema = z
    .object({
        enabled: z.boolean().default(true).describe("Enable magic context (default: true)"),
        allow_home_project: z
            .boolean()
            .default(false)
            .describe(
                "Allow Magic Context sessions launched from the exact canonical home directory. The home session uses its deterministic dir: identity so pre-gate memories reconnect. USER-LEVEL ONLY: project config is ignored. The home identity is excluded from registry seed exports, never resolves descendants by containment, and cannot join a workspace.",
            ),
        mural: z
            .object({
                enabled: z.boolean().default(false),
                model: z
                    .string()
                    .trim()
                    .min(1)
                    .optional()
                    .describe(
                        "Model for the compress-cues task that compresses each memory into a mural cue. The mural image itself is rendered deterministically (no author model).",
                    ),
            })
            .default({ enabled: false })
            .describe(
                "Experimental mural: a single deterministically-rendered image of project memories that did not fit the context budget. Cues are compressed per-memory by the compress-cues dreamer task.",
            ),
        transform_mode: z
            .enum(["ts", "rust"])
            .default("ts")
            .describe(
                'Experimental: routes the entire Magic Context runtime for the project through the ck-mc Rust module over subc (requires user-level `subc` config); "ts" is the current TypeScript pipeline.',
            ),
        auto_update: z
            .boolean()
            .optional()
            .describe(
                "Enable automatic npm self-update checks for the OpenCode plugin. Security: USER-only in config loader, so hostile project configs cannot suppress updates.",
            ),
        language: z
            .string()
            .trim()
            .toLowerCase()
            .refine(
                (s) => isValidLanguageCode(s),
                'language must be a 2-letter ISO 639-1 code (e.g. "tr", "es", "de")',
            )
            .optional()
            .describe(
                "Output language for Magic Context's generated content and guidance, as a " +
                    '2-letter ISO 639-1 code (e.g. "tr", "es", "de", "ja", "pt"). When set, the ' +
                    "historian, dreamer, sidekick, and the agent-guidance block instruct the model to " +
                    "write its PROSE in this language while keeping all structural tokens (XML tags, " +
                    "the five memory category names, code identifiers, file paths) in English. " +
                    "USER-LEVEL ONLY (ignored in project config for security). Unset = today's " +
                    "behavior (model mirrors the conversation; English scaffolding). Changing it " +
                    "triggers one cache re-materialization; existing compartments/memories keep their " +
                    "original language until naturally rewritten.",
            ),
        profile: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe(
                "Select a named user-owned model profile. A valid project name overrides this user default; an empty string, null, or other non-string project value is ignored with a warning so the user selection still applies. Unknown names warn and use the base configuration.",
            ),
        profiles: ConfigProfilesSchema.optional().describe(
            "User-level named model profiles. A profile may contain only historian/dreamer model, fallback_models, OpenCode variant, and Pi/OMP thinking_level fields plus sidekick model-selection fields; task execution policy (including timeout_minutes) is excluded. Project configs may select a name but cannot define profiles.",
        ),
        historian: HistorianConfigSchema.describe(
            "Historian metadata plus independent strict OpenCode, Pi, and OMP execution blocks. Retained metadata stays at historian; model, fallback_models, variant, and thinking_level belong only in historian.opencode, historian.pi, or historian.omp.",
        ),
        dreamer: DreamerConfigSchema.optional().describe(
            "Dreamer metadata and scheduling plus independent strict OpenCode, Pi, and OMP execution blocks. schedule and promotion_threshold stay at dreamer.tasks; model, fallback_models, variant, thinking_level, and timeout_minutes belong only in the matching harness block.",
        ),
        smart_notes: z
            .object({
                retina_handoff: z
                    .boolean()
                    .default(false)
                    .describe(
                        "When true, dreamer skips smart notes whose surface conditions compiled to retina provider configs at authoring time. Default false keeps both paths active until the retina consumer is deployed.",
                    ),
            })
            .default({ retina_handoff: false })
            .describe("Smart-note ownership transition controls."),
        cache_ttl: z
            .union([z.string(), z.object({ default: z.string() }).catchall(z.string())])
            .default("5m")
            .describe(
                'How long Magic Context assumes the provider\'s cached prefix stays valid. This is MC\'s own deferral gate — it does not change the provider\'s actual cache lifetime. String (e.g. "5m", "1h", "30s") or per-model object ({ default: "5m", "model-id": "10m" }). Set to "never" to mean MC never assumes expiry (for lanes kept warm externally by a cache-keep tool) — disables the idle-TTL heuristic so MC never initiates a rebuild based on elapsed time. Provider-side extended TTL is a separate request-level concern (cache_control: { ttl } in the request body).',
            ),
        prompt_surface: PromptSurfaceConfigSchema.default({ default: "full" }).describe(
            "Prompt-surface presets: default is full; models use bare model IDs, provider/model, or provider/* routing keys. Guidance and tool-description overrides are user-level only. On OpenCode and Pi, per-model routing applies to the guidance block only: tool descriptions are registered once per process, so they follow the default preset (a v1 plugin-surface limitation; per-model tool descriptions are planned for the OpenCode v2 plugin API once the SDK stabilizes).",
        ),
        output_reserve: z
            .union([
                z.number().min(0),
                z.object({ default: z.number().min(0) }).catchall(z.number().min(0)),
            ])
            .optional()
            .describe(
                'User-only output-token reservation override. Number or per-model object ({ default: 16384, "provider/model": 8192 }); 0 disables reservation. Takes precedence over every derived source: an explicit value here always wins against catalog output limits, provider window-geometry facts, and the 25%-of-context fallback (usable window = context window minus this reserve). When unset, Magic Context reserves the catalog output limit (capped at 25% of context) for shared-window providers and keeps proven separate-quota Google/Gemini windows unchanged.',
            ),
        models: z
            .object({
                window_overlay_path: z.string().trim().min(1).optional(),
            })
            .optional()
            .describe(
                "User-only Fusiform window-overlay settings. The path defaults to <dataDir>/fusiform/window-overlay.json.",
            ),
        toast_duration_ms: z
            .number()
            .min(0)
            .max(60_000)
            .default(5_000)
            .describe(
                "TUI toast lifetime in milliseconds for Magic Context notifications. Set to 0 to disable Magic Context toasts entirely (min: 0, max: 60000, default: 5000)",
            ),
        execute_threshold_percentage: z
            .union([
                z.number().min(20).max(90, EXECUTE_THRESHOLD_CAP_MESSAGE),
                z
                    .object({ default: z.number().min(20).max(90, EXECUTE_THRESHOLD_CAP_MESSAGE) })
                    .catchall(z.number().min(20).max(90, EXECUTE_THRESHOLD_CAP_MESSAGE)),
            ])
            .default(DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE)
            .describe(
                'Context percentage that forces queued operations to execute. Number or per-model object ({ default: 65, "provider/model": 45 }). Values above 90 are rejected because the runtime caps at 90% of the output-reserved safe window (MAX_EXECUTE_THRESHOLD). Default: DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE',
            ),
        execute_threshold_tokens: z
            .object({
                default: z.number().min(5_000).max(2_000_000).optional(),
            })
            .catchall(z.number().min(5_000).max(2_000_000))
            .optional()
            .describe(
                "Absolute token thresholds per model. When matched, overrides execute_threshold_percentage for that model. Accepts `default` for all models or per-model keys. Values above 90% × context_limit are clamped with a warning log. Min 5_000, max 2_000_000.",
            ),
        protected_tags: z
            .number()
            .min(1)
            .max(100)
            .optional()
            .describe(
                "Number of recent tags to protect from dropping (min: 1, max: 100, default: 20)",
            ),
        clear_reasoning_age: z
            .number()
            .min(10)
            .default(50)
            .describe("Clear reasoning/thinking blocks older than N tags (default: 50)"),
        history_budget_percentage: z
            .number()
            .min(0.05)
            .max(0.5)
            .default(DEFAULT_HISTORY_BUDGET_PERCENTAGE)
            .describe(
                "Fraction of usable context (context_limit × execute_threshold) reserved for the session history block (default: 0.15)",
            ),
        historian_timeout_ms: z
            .number()
            .min(60_000)
            .default(DEFAULT_HISTORIAN_TIMEOUT_MS)
            .describe("Timeout for each historian prompt call in milliseconds (default: 600000)"),
        commit_cluster_trigger: z
            .object({
                enabled: z
                    .boolean()
                    .default(true)
                    .describe("Enable commit-cluster based historian triggering (default: true)"),
                min_clusters: z
                    .number()
                    .min(1)
                    .default(3)
                    .describe(
                        "Minimum commit clusters required to trigger historian (min: 1, default: 3)",
                    ),
            })
            .default({ enabled: true, min_clusters: 3 })
            .describe(
                "Commit-cluster trigger: fire historian when enough commit clusters accumulate in the unsummarized tail",
            ),
        system_prompt_injection: z
            .object({
                enabled: z
                    .boolean()
                    .default(true)
                    .describe(
                        "When false, NO injection happens for ANY agent — global escape hatch. (default: true)",
                    ),
                skip_signatures: z
                    .array(z.string())
                    .default(["<!-- magic-context: skip -->"])
                    .describe(
                        "Substring opt-out list. If the agent's system prompt contains any of these strings, skip ALL Magic Context injection for that call. Default \"<!-- magic-context: skip -->\" is meant to be added inside a user's custom agent prompt to opt that agent out.",
                    ),
            })
            .default({
                enabled: true,
                skip_signatures: ["<!-- magic-context: skip -->"],
            })
            .describe(
                "Controls whether and where Magic Context augments the system prompt. Lets users opt specific agents out of the Magic Context guidance and the surrounding project-docs / user-profile blocks. OpenCode's internal hidden agents — title, summary, and compaction — are always skipped automatically.",
            ),
        // v2: the LLM compressor was removed — deterministic decay-tier rendering
        // (decay-render.ts) replaces it, so there are no compressor knobs. A
        // leftover `compressor` block in an existing config is silently ignored
        // (the schema strips unknown keys).
        sqlite: z
            .object({
                cache_size_mb: z
                    .number()
                    .min(2)
                    .max(2048)
                    .default(64)
                    .describe(
                        "Page-cache size in MiB per connection (PRAGMA cache_size). Larger keeps more hot pages resident, cutting re-reads on repeated full-table scans. (min 2, max 2048, default 64)",
                    ),
                mmap_size_mb: z
                    .number()
                    .min(0)
                    .max(8192)
                    .default(0)
                    .describe(
                        "Memory-mapped I/O size in MiB (PRAGMA mmap_size). 0 disables mmap (SQLite default). Raising it can cut read overhead on large DBs at the cost of address space. (min 0, max 8192, default 0)",
                    ),
            })
            .default({ cache_size_mb: 64, mmap_size_mb: 0 })
            .describe(
                "SQLite connection tuning for Magic Context's own context.db. These are per-connection PRAGMAs applied at open; they do not change the schema or what is stored.",
            ),
        storage: z
            .object({
                enforce_private_permissions: z
                    .boolean()
                    .default(true)
                    .describe(
                        "When true (default), Magic Context creates and re-tightens its storage directories to owner-only 0700 and storage files to owner-only 0600. Set false only for a deliberate trusted-group deployment whose operator manages directory, database, WAL/SHM, cache, and RPC file permissions externally; Magic Context then never chmods or supplies restrictive creation modes. USER-LEVEL ONLY — ignored in project config for security. On Windows, POSIX chmod modes are already meaningless, so this setting is a no-op.",
                    ),
            })
            .default({ enforce_private_permissions: true })
            .describe(
                "Storage permission policy. The default keeps session content and memories owner-private. Disabling enforcement is for trusted shared-group storage managed externally; every group member able to read the storage can read all stored session content and memories.",
            ),
        embedding: EmbeddingConfigSchema.default({
            provider: "local",
            model: DEFAULT_LOCAL_EMBEDDING_MODEL,
            local_runtime: "auto",
        }).describe("Embedding provider configuration"),
        subc: z
            .object({
                connection_file: z
                    .string()
                    .trim()
                    .min(1)
                    .transform(expandConfigPath)
                    .describe("Path to the owner-only subc connection file."),
            })
            .optional()
            .describe("User-only Synapse daemon connection settings."),
        shadow_embedding: z
            .object({
                enabled: z
                    .boolean()
                    .default(false)
                    .describe("Developer-only Synapse shadow embedding lane switch."),
            })
            .default({ enabled: false })
            .describe("Developer-only Synapse shadow embedding lane."),
        temporal_awareness: z
            .boolean()
            .default(true)
            .describe(
                'Inject wall-clock gap markers (<!-- +Xm -->) between user messages where > 5 min elapsed since the previous message, and add compact date ranges to compartment headings. Gives the agent a sense of session pacing and "how long ago" across multi-day sessions. Graduated from experimental.temporal_awareness; default: true (set false to opt out).',
            ),
        keep_subagents: z
            .boolean()
            .default(false)
            .describe(
                "Debug: keep the child sessions Magic Context spawns for its own subagents (historian, dreamer, sidekick, memory-migration) instead of deleting them on success. Useful for short-term inspection/data collection — their full transcript (prompt, tool calls, token usage, output) stays in the host session store. Kept sessions accumulate until manually cleared; leave false for normal use. Requires a restart to take effect.",
            ),
        fail_closed_blocking: z
            .boolean()
            .default(true)
            .describe(
                "When Magic Context cannot operate (schema fence mismatch, storage open/migration failure), block the primary-session prompt with a loud recovery error instead of silently degrading to native compaction. Default true. Set false only to restore the old degrade-silently behavior (not recommended). USER-LEVEL ONLY — ignored in project config for security. Requires a restart.",
            ),
        compaction: z
            .object({
                enabled: z
                    .boolean()
                    .default(true)
                    .describe(
                        "When false, Magic Context stops managing the context window and keeps its knowledge layer: memory and docs/user-profile/key-files injection through additive m[0]/m[1], raw-message FTS indexing, dreamer, notes, ctx_search, ctx_expand, ctx_memory, and /ctx-embed remain available. MC's historian/compartment preparation, tagging, markers, pruning, folding, drops, strips, splicing, synthetic context-management todos, temporal markers, nudges, and fail-closed blocking stop; ctx_expand remains a knowledge-surface tool. fail_closed_blocking is inert: a transform failure passes the input messages through without blocking or cancelling. This setting does not enable native compaction: OpenCode's compaction.auto / compaction.prune or Pi's equivalent owns the window, or nothing does. MC's compaction.enabled in magic-context.jsonc is distinct from OpenCode's compaction.auto / compaction.prune in opencode.jsonc; they are different files and different owners. On the first turn after disabling, a long session may trigger one native compaction cycle; MC removes only its own marker boundary, leaves native boundaries and stored compartments intact, and does no pre-trimming mitigation. Marker cleanup is lazy per session, so an unresumed session is cleaned when it is next resumed. If compaction is enabled again, run /ctx-wrapup when the historian is runnable to catch up. OpenCode peer verification against v1.18.4 confirms native compaction covers child sessions: subagents receive additive memory/docs injection and no MC reclaim in this mode, so keep subagent tasks small or leave compaction.enabled on for long subagent runs. This is boot-resolved and requires a process restart; project-tier compaction.enabled is stripped so a cloned repository cannot disable the user's setting. The sidebar reports raw usage as Context: <pct>% · native compaction or Context: <pct>% · no active compaction and does not show an MC execute-threshold fill. /ctx-wrapup, /ctx-recomp, /ctx-flush, and /ctx-session-upgrade refuse without context-management side effects; /ctx-embed remains functional. Raw content hidden by a native boundary before Magic Context's first pass is not retroactively indexed.",
                    ),
            })
            .default({ enabled: true })
            .describe(
                "Compaction-off mode gate. Default true (MC manages the context window as today). Set compaction.enabled=false to keep the knowledge layer while letting native compaction (or nothing) own the window. Boot-resolved; requires a restart to change.",
            ),
        todowrite: z
            .object({
                enabled: z
                    .boolean()
                    .default(true)
                    .describe(
                        "Pi only: register Magic Context's todowrite task-list tool. Disable if you use your own todo extension. OpenCode ships its own built-in todowrite; this setting has no effect there.",
                    ),
                overlay: z
                    .boolean()
                    .default(true)
                    .describe(
                        "Pi only: show the persistent todo overlay above the editor while tasks are active.",
                    ),
            })
            .default({ enabled: true, overlay: true })
            .describe(
                "Pi-only todowrite tool and overlay controls. Pi registers tools and widgets at extension boot, so changing this after /cd requires /reload or restart.",
            ),
        pi: PiConfigSchema.describe(
            "Pi-only child-process extension controls. This setting is user-level only; project configuration cannot choose which extensions a user's subagent children load.",
        ),
        smart_drops: z
            .boolean()
            .default(false)
            .describe(
                "Content-aware reclaim of provably-superseded tool output, layered on the existing execute-pass auto-drop. When on: superseded todowrite (keep newest 1), spent ctx_reduce (keep newest 3), and zero-value meta (bash_status, bash_kill, ctx_note read/dismiss) outputs are dropped; older edits to a file are compressed to a filePath-preserving marker while the newest edit per file stays full. Only acts on passes already busting the cache, so it never originates a cache bust. Honors the protected-tag reserve. Experimental: opt-in, default off until cache stability is proven; when off the wire is byte-identical to the positional-only reclaim. Requires a restart.",
            ),
        caveman_text_compression: z
            .object({
                enabled: z
                    .boolean()
                    .default(false)
                    .describe(
                        "Apply deterministic caveman-style text compression to old conversation text. Active for primary sessions when enabled; never for subagents. Compresses user/assistant text in oldest-first tiers: ultra (oldest 20%), full, lite, untouched (newest 40%).",
                    ),
                min_chars: z
                    .number()
                    .min(100)
                    .max(10000)
                    .default(500)
                    .describe(
                        "Text parts shorter than this (characters) stay untouched. Min 100, max 10000. Default: 500.",
                    ),
            })
            .default({ enabled: false, min_chars: 500 })
            .describe(
                "Age-tier caveman compression for long user/assistant text parts. Active for primary sessions when enabled; never for subagents. Oldest 20% of eligible tags (outside protected tail) go to ultra, next 20% to full, next 20% to lite, newest 40% untouched. Graduated from experimental.caveman_text_compression; opt-in, default off (lossy).",
            ),
        memory: z
            .object({
                enabled: z
                    .boolean()
                    .default(true)
                    .describe("Enable cross-session memory (default: true)"),
                injection_budget_tokens: z
                    .number()
                    .min(500)
                    .max(20000)
                    .default(4000)
                    .describe(
                        "Token budget for memory injection on session start (min: 500, max: 20000, default: 4000)",
                    ),
                auto_promote: z
                    .boolean()
                    .default(true)
                    .describe(
                        "Automatically promote eligible session facts into memory (default: true)",
                    ),
                retrieval_count_promotion_threshold: z
                    .number()
                    .min(1)
                    .default(3)
                    .describe(
                        "retrieval_count threshold for promoting memory to permanent status (min: 1, default: 3)",
                    ),
                auto_search: z
                    .object({
                        enabled: z
                            .boolean()
                            .default(true)
                            .describe(
                                "Automatically append a compact <ctx-search-hint> to eligible user messages when relevant memories, conversation, or commits are found. Graduated from experimental.auto_search; on by default (set false to opt out). Independent of memory.enabled.",
                            ),
                        score_threshold: z
                            .number()
                            .min(0.3)
                            .max(0.95)
                            .default(0.6)
                            .describe(
                                "Top hit score must exceed this threshold for the hint to fire (min: 0.3, max: 0.95, default: 0.60)",
                            ),
                        min_prompt_chars: z
                            .number()
                            .min(5)
                            .max(500)
                            .default(20)
                            .describe(
                                "Skip hint when user message is shorter than this (min: 5, max: 500, default: 20)",
                            ),
                    })
                    .default({ enabled: true, score_threshold: 0.6, min_prompt_chars: 20 })
                    .describe(
                        "Auto-search hint: transform-time ctx_search on each new user message; when the top hit clears the threshold, append a compact <ctx-search-hint> block of vague fragments to that user message. Does NOT inject full content. Graduated from experimental.auto_search; enabled by default (set enabled: false to opt out). Independent of memory.enabled.",
                    ),
                git_commit_indexing: z
                    .object({
                        enabled: z
                            .boolean()
                            .default(false)
                            .describe(
                                "Index HEAD git commits for ctx_search (git_commit source). Graduated from experimental.git_commit_indexing; opt-in, default off. Independent of memory.enabled.",
                            ),
                        since_days: z
                            .number()
                            .min(7)
                            .max(3650)
                            .default(365)
                            .describe(
                                "Days of HEAD history to index (min: 7, max: 3650, default: 365)",
                            ),
                        max_commits: z
                            .number()
                            .min(100)
                            .max(20000)
                            .default(2000)
                            .describe(
                                "Max commits kept per project; oldest evicted (min: 100, max: 20000, default: 2000)",
                            ),
                    })
                    .default({ enabled: false, since_days: 365, max_commits: 2000 })
                    .describe(
                        "Index git commit messages from HEAD into ctx_search. Commits become a 4th searchable source alongside memories and session history. Graduated from experimental.git_commit_indexing; opt-in, default off (per-project embedding cost). Independent of memory.enabled.",
                    ),
            })
            .default({
                enabled: true,
                injection_budget_tokens: 4000,
                auto_promote: true,
                retrieval_count_promotion_threshold: 3,
                auto_search: { enabled: true, score_threshold: 0.6, min_prompt_chars: 20 },
                git_commit_indexing: { enabled: false, since_days: 365, max_commits: 2000 },
            })
            .describe("Cross-session memory configuration"),
        sidekick: SidekickConfigSchema.describe(
            "Optional sidekick agent configuration for session-start memory retrieval",
        ),
    })
    .transform((data): MagicContextConfig => {
        return {
            ...data,
            protected_tags: data.protected_tags ?? DEFAULT_PROTECTED_TAGS,
        };
    });
