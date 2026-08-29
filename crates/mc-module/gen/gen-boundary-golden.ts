/**
 * Generate the differential BOUNDARY/TRIGGER golden for the Rust mc-module port.
 *
 * Drives the real TypeScript formatter, protected-tail resolver, and trigger
 * decision ingredients from packages/plugin via Bun.resolveSync. The emitted
 * fixture contains the equivalent Rust grouped tail (BoundaryMsg[]) plus the TS
 * results the Rust tests assert against.
 *
 * Run: bun crates/mc-module/gen/gen-boundary-golden.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const pluginDir = join(import.meta.dir, "..", "..", "..", "packages", "plugin");
const resolve = (m: string) => Bun.resolveSync(m, pluginDir);

const boundaryMod = await import(resolve("./src/hooks/magic-context/protected-tail-boundary"));
const chunkMod = await import(resolve("./src/hooks/magic-context/read-session-chunk"));
const formatting = await import(resolve("./src/hooks/magic-context/read-session-formatting"));
const budgets = await import(resolve("./src/hooks/magic-context/derive-budgets"));
const stable = await import(resolve("./src/shared/stable-json"));
const escalation = await import(resolve("./src/shared/escalation-bands"));

const { resolveProtectedTailBoundary, hasRunnableCompartmentWindow } = boundaryMod as {
    resolveProtectedTailBoundary: (ctx: Record<string, unknown>) => Record<string, unknown>;
    hasRunnableCompartmentWindow: (snapshot: Record<string, unknown>) => boolean;
};
const { DEFAULT_CONTEXT_LIMIT } = await import(
    resolve("./src/hooks/magic-context/event-resolvers"),
) as { DEFAULT_CONTEXT_LIMIT: number };
const { fenceBoundaryForCompletedToolArcs } = await import(
    resolve("./src/hooks/magic-context/read-session-true-raw-tokens"),
) as {
    fenceBoundaryForCompletedToolArcs: (
        candidate: number,
        arcs: Array<{ callId: string; invOrdinal: number; resOrdinal: number | null }>,
        publicationFloorOrdinal: number,
    ) => number;
};
const { readSessionChunk, withRawMessageProvider } = chunkMod as {
    readSessionChunk: (
        sessionId: string,
        tokenBudget: number,
        offset?: number,
        eligibleEndOrdinal?: number,
    ) => Record<string, unknown>;
    withRawMessageProvider: <T>(
        sessionId: string,
        provider: { readMessages(): RawMessage[]; getMessageCount(): number },
        fn: () => T,
    ) => T;
};
const { estimateTokens } = formatting as { estimateTokens: (text: string) => number };
const { deriveTriggerBudget } = budgets as {
    deriveTriggerBudget: (contextLimit: number, executeThresholdPercentage: number) => number;
};
const { stableStringify } = stable as { stableStringify: (value: unknown) => string };
const { escalationBands } = escalation as {
    escalationBands: (threshold: number) => { forceMaterializationPercentage: number };
};

interface RawMessage {
    ordinal: number;
    id: string;
    role: string;
    parts: unknown[];
}

type PartSpec =
    | { type: "text"; text: string; ignored?: boolean }
    | { type: "reasoning"; text: string }
    | {
          type: "tool";
          tool: string;
          callID: string;
          input?: Record<string, unknown> | string;
          output?: unknown;
          providerExecuted?: boolean;
      };

interface BoundaryCtxJson {
    context_limit: number;
    execute_threshold_percentage: number;
    usage_percentage: number;
    usage_input_tokens: number;
    last_compartment_end_ordinal: number;
    prior_boundary_ordinal: number;
    migration_floor_active: boolean;
    emergency_tail_scale: number | null;
    trigger_budget: number | null;
}

interface MsgFixture {
    message_ordinal: number;
    message_id: string;
    role: string;
    blocks: Array<Record<string, unknown>>;
}

interface FixtureMessage {
    raw: RawMessage;
    rust: MsgFixture;
}

const smallCtx = (usage: number, extra: Partial<BoundaryCtxJson> = {}): BoundaryCtxJson => ({
    context_limit: 20_000,
    execute_threshold_percentage: 50,
    usage_percentage: usage,
    usage_input_tokens: Math.round((20_000 * 0.5 * usage) / 100),
    last_compartment_end_ordinal: 0,
    prior_boundary_ordinal: 1,
    migration_floor_active: false,
    emergency_tail_scale: null,
    trigger_budget: null,
    ...extra,
});

function stringValue(value: unknown): string {
    if (typeof value === "string") return value;
    if (value === undefined || value === null) return "";
    return stableStringify(value);
}

function text(ord: number, role: string, body: string, ignored = false): FixtureMessage {
    const id = `m-${ord}`;
    const part: PartSpec = { type: "text", text: body, ignored };
    return buildMessage(ord, id, role, [part]);
}

function tool(
    ord: number,
    role: string,
    callID: string,
    toolName: string,
    input?: Record<string, unknown> | string,
    output?: unknown,
): FixtureMessage {
    const id = `m-${ord}`;
    return buildMessage(ord, id, role, [{ type: "tool", callID, tool: toolName, input, output }]);
}

function buildMessage(ord: number, id: string, role: string, parts: PartSpec[]): FixtureMessage {
    const rawParts: unknown[] = [];
    const blocks: Array<Record<string, unknown>> = [];
    parts.forEach((part, index) => {
        if (part.type === "text") {
            rawParts.push({ type: "text", text: part.text, ignored: part.ignored === true });
            blocks.push({
                id: `${id}#text${index}`,
                ordinal: ord,
                kind: "Text",
                provider_executed: false,
                byte_size: part.text.length,
                arc_id: null,
                original: part.text,
                rendered: null,
                ignored: part.ignored === true,
            });
            return;
        }
        if (part.type === "reasoning") {
            rawParts.push({ type: "reasoning", text: part.text });
            blocks.push({
                id: `${id}#reasoning${index}`,
                ordinal: ord,
                kind: "Reasoning",
                provider_executed: false,
                byte_size: part.text.length,
                arc_id: null,
                original: part.text,
                rendered: null,
                ignored: false,
            });
            return;
        }
        const state: Record<string, unknown> = {};
        if (part.input !== undefined) state.input = part.input;
        if (part.output !== undefined) state.output = part.output;
        rawParts.push({
            type: "tool",
            tool: part.tool,
            callID: part.callID,
            state,
            providerExecuted: part.providerExecuted === true,
        });
        const provider = part.providerExecuted === true;
        if (part.input !== undefined || part.output === undefined) {
            const original = part.input === undefined ? "" : stringValue(part.input);
            blocks.push({
                id: `${part.callID}#call${index}`,
                ordinal: ord,
                kind: { ToolCall: { name: part.tool, input: part.input ?? {} } },
                provider_executed: provider,
                byte_size: original.length,
                arc_id: part.callID,
                original,
                rendered: null,
                ignored: false,
            });
        }
        if (part.output !== undefined) {
            const original = stringValue(part.output);
            blocks.push({
                id: `${part.callID}#result${index}`,
                ordinal: ord,
                kind: { ToolResult: { tool_name: part.tool } },
                provider_executed: provider,
                byte_size: original.length,
                arc_id: part.callID,
                original,
                rendered: null,
                ignored: false,
            });
        }
    });
    return { raw: { ordinal: ord, id, role, parts: rawParts }, rust: { message_ordinal: ord, message_id: id, role, blocks } };
}

const words = (chunk: string, n: number) => chunk.repeat(n);
const BIG = words("alpha beta gamma delta epsilon ", 1_000);
const HUGE = words("alpha beta gamma delta epsilon ", 3_500);
const MID = words("orange purple silver ", 900);
const SMALL = words("small tail ", 80);

function rustMessages(items: FixtureMessage[]): MsgFixture[] {
    return items.map((item) => item.rust);
}

function rawMessages(items: FixtureMessage[]): RawMessage[] {
    return items.map((item) => item.raw);
}

function tsBoundary(messages: FixtureMessage[], ctx: BoundaryCtxJson, label: string): Record<string, unknown> {
    const sessionId = `boundary-${label.replace(/[^a-z0-9]+/gi, "-")}`;
    const triggerBudget = ctx.trigger_budget ?? deriveTriggerBudget(ctx.context_limit, ctx.execute_threshold_percentage);
    return withRawMessageProvider(
        sessionId,
        { readMessages: () => rawMessages(messages), getMessageCount: () => messages.length },
        () =>
            resolveProtectedTailBoundary({
                sessionId,
                mode: "trigger",
                contextLimit: ctx.context_limit,
                executeThresholdPercentage: ctx.execute_threshold_percentage,
                triggerBudget,
                usage: { percentage: ctx.usage_percentage, inputTokens: ctx.usage_input_tokens },
                usageSource: "live",
                lastCompartmentEndOrdinal: ctx.last_compartment_end_ordinal,
                priorBoundaryOrdinal: ctx.prior_boundary_ordinal,
                protectedTailPolicyVersion: 3,
                migrationFloorActive: ctx.migration_floor_active,
                emergencyTailScale: ctx.emergency_tail_scale ?? undefined,
                providerShapeVersion: "opencode-v1",
                cacheNamespace: `golden:${sessionId}`,
                createdAt: 0,
            }),
    );
}

function tsChunk(messages: FixtureMessage[], budgetStop: number, label: string): Record<string, unknown> {
    const sessionId = `chunk-${label.replace(/[^a-z0-9]+/gi, "-")}`;
    return withRawMessageProvider(
        sessionId,
        { readMessages: () => rawMessages(messages), getMessageCount: () => messages.length },
        () => readSessionChunk(sessionId, budgetStop, 1),
    );
}

function runTsTrigger(spec: TriggerSpec): Record<string, unknown> {
    if (spec.ctx.compartment_in_progress) return { fire: false, reason: null, consume_through_ordinal: null };
    const ctx = spec.ctx.boundary;
    const rawCount = spec.messages.length;
    const offset = Math.max(1, ctx.last_compartment_end_ordinal + 1);
    if (rawCount < offset) return { fire: false, reason: null, consume_through_ordinal: null };
    const triggerBudget = ctx.trigger_budget ?? deriveTriggerBudget(ctx.context_limit, ctx.execute_threshold_percentage);
    const primary = tsBoundary(spec.messages, { ...ctx, trigger_budget: triggerBudget, emergency_tail_scale: null }, spec.label);
    const hasProtectedEligibleHead = (primary.offset as number) < (primary.protectedTailStart as number);
    const scanBudget = Math.max(6_000, triggerBudget * 3);
    let chunk: Record<string, unknown> = { tokenEstimate: 0, hasMore: false, messageCount: 0, commitClusterCount: 0 };
    if (hasProtectedEligibleHead) {
        const sessionId = `trigger-${spec.label.replace(/[^a-z0-9]+/gi, "-")}`;
        chunk = withRawMessageProvider(
            sessionId,
            { readMessages: () => rawMessages(spec.messages), getMessageCount: () => spec.messages.length },
            () => readSessionChunk(sessionId, scanBudget, primary.offset as number, primary.protectedTailStart as number),
        );
    }
    const tokenEstimate = (chunk.hasMore as boolean)
        ? Math.max(chunk.tokenEstimate as number, scanBudget)
        : (chunk.tokenEstimate as number);
    const isMeaningful =
        (chunk.hasMore as boolean) ||
        (primary.trueRawEligibleTokens as number) >= 6_000 ||
        tokenEstimate >= 6_000 ||
        (chunk.messageCount as number) >= 12;
    const relativePostDropTarget = ctx.execute_threshold_percentage * 0.75;

    const fireFrom = (reason: string, boundary: Record<string, unknown>) => ({
        fire: true,
        reason,
        consume_through_ordinal:
            (boundary.eligibleEndOrdinal as number) > (boundary.offset as number)
                ? (boundary.eligibleEndOrdinal as number) - 1
                : null,
    });

    const forceMaterializationPercentage = escalationBands(
        ctx.execute_threshold_percentage,
    ).forceMaterializationPercentage;
    if (ctx.usage_percentage >= forceMaterializationPercentage) {
        if (
            spec.ctx.projected_post_drop_percentage !== null &&
            spec.ctx.projected_post_drop_percentage !== undefined &&
            spec.ctx.projected_post_drop_percentage <= relativePostDropTarget
        ) {
            return { fire: false, reason: null, consume_through_ordinal: null };
        }
        if (hasRunnableCompartmentWindow(primary)) return fireFrom("force_band", primary);
        const scale = ctx.usage_percentage >= 95 ? 0.25 : 0.5;
        const scaled = tsBoundary(spec.messages, { ...ctx, trigger_budget: triggerBudget, emergency_tail_scale: scale }, `${spec.label}-scaled`);
        if (hasRunnableCompartmentWindow(scaled)) return fireFrom("force_band", scaled);
        return { fire: false, reason: null, consume_through_ordinal: null };
    }

    if (
        spec.ctx.commit_cluster_trigger_enabled &&
        (chunk.commitClusterCount as number) >= spec.ctx.min_commit_clusters &&
        tokenEstimate >= triggerBudget
    ) {
        return fireFrom("commit_clusters", primary);
    }

    if (tokenEstimate >= triggerBudget * 3 || ((chunk.hasMore as boolean) && tokenEstimate > 0)) {
        return fireFrom("tail_size", primary);
    }

    const proactive = Math.max(0, ctx.execute_threshold_percentage - 2);
    if (ctx.usage_percentage < proactive) return { fire: false, reason: null, consume_through_ordinal: null };
    if (
        spec.ctx.projected_post_drop_percentage !== null &&
        spec.ctx.projected_post_drop_percentage !== undefined &&
        spec.ctx.projected_post_drop_percentage <= relativePostDropTarget
    ) {
        return { fire: false, reason: null, consume_through_ordinal: null };
    }
    if (!hasProtectedEligibleHead || !isMeaningful) return { fire: false, reason: null, consume_through_ordinal: null };
    return fireFrom("projected_headroom", primary);
}

function constantsFromSource(): Record<string, number> {
    const files = {
        boundary: readFileSync(resolve("./src/hooks/magic-context/protected-tail-boundary.ts"), "utf8"),
        trigger: readFileSync(resolve("./src/hooks/magic-context/compartment-trigger.ts"), "utf8"),
        budgets: readFileSync(resolve("./src/hooks/magic-context/derive-budgets.ts"), "utf8"),
        formatting: readFileSync(resolve("./src/hooks/magic-context/read-session-formatting.ts"), "utf8"),
    };
    const read = (source: string, name: string): number => {
        const match = source.match(new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*([^;]+);`));
        if (!match) throw new Error(`missing constant ${name}`);
        const normalized = match[1]!.trim().replace(/_/g, "");
        const value = Number(normalized);
        if (!Number.isFinite(value)) throw new Error(`constant ${name} is not numeric: ${match[1]}`);
        return value;
    };
    return {
        ALPHA: read(files.boundary, "ALPHA"),
        FLOOR_RATIO: read(files.boundary, "FLOOR_RATIO"),
        FLOOR_MIN: read(files.boundary, "FLOOR_MIN"),
        FLOOR_MAX: read(files.boundary, "FLOOR_MAX"),
        ABS_CAP: read(files.boundary, "ABS_CAP"),
        MAX_USABLE_RATIO: read(files.boundary, "MAX_USABLE_RATIO"),
        RESERVED_HEADROOM_MIN: read(files.boundary, "RESERVED_HEADROOM_MIN"),
        RESERVED_HEADROOM_RATIO: read(files.boundary, "RESERVED_HEADROOM_RATIO"),
        NON_EMERGENCY_MAX_CAP: read(files.boundary, "NON_EMERGENCY_MAX_CAP"),
        FORCE80_MAX_CAP: read(files.boundary, "FORCE80_MAX_CAP"),
        FORCE95_MAX_CAP: read(files.boundary, "FORCE95_MAX_CAP"),
        NORMAL_HYSTERESIS_TOKENS: read(files.boundary, "NORMAL_HYSTERESIS_TOKENS"),
        MIN_FORCE_ELIGIBLE_TOKENS_CAP: read(files.boundary, "MIN_FORCE_ELIGIBLE_TOKENS_CAP"),
        TRIGGER_BUDGET_PERCENTAGE: read(files.budgets, "TRIGGER_BUDGET_PERCENTAGE"),
        TRIGGER_BUDGET_MIN: read(files.budgets, "TRIGGER_BUDGET_MIN"),
        TRIGGER_BUDGET_MAX: read(files.budgets, "TRIGGER_BUDGET_MAX"),
        PROACTIVE_TRIGGER_OFFSET_PERCENTAGE: read(files.trigger, "PROACTIVE_TRIGGER_OFFSET_PERCENTAGE"),
        POST_DROP_TARGET_RATIO: read(files.trigger, "POST_DROP_TARGET_RATIO"),
        MIN_PROACTIVE_TAIL_TOKEN_ESTIMATE: read(files.trigger, "MIN_PROACTIVE_TAIL_TOKEN_ESTIMATE"),
        MIN_PROACTIVE_TAIL_MESSAGE_COUNT: read(files.trigger, "MIN_PROACTIVE_TAIL_MESSAGE_COUNT"),
        DEFAULT_MIN_COMMIT_CLUSTERS_FOR_TRIGGER: read(files.trigger, "DEFAULT_MIN_COMMIT_CLUSTERS_FOR_TRIGGER"),
        TAIL_SIZE_TRIGGER_MULTIPLIER: read(files.trigger, "TAIL_SIZE_TRIGGER_MULTIPLIER"),
        BLOCK_UNTIL_DONE_PERCENTAGE: read(files.trigger, "BLOCK_UNTIL_DONE_PERCENTAGE"),
        MAX_COMMITS_PER_BLOCK: read(files.formatting, "MAX_COMMITS_PER_BLOCK"),
    };
}

const chunkSpecs = [
    {
        label: "text-only mixed roles",
        messages: [text(1, "user", "hello    world"), text(2, "assistant", "done\nwith   spacing"), text(3, "user", "next")],
        budget_stop: 10_000,
    },
    {
        label: "tool-heavy summaries",
        messages: [
            tool(1, "assistant", "c1", "read", { filePath: "src/index.ts" }),
            tool(2, "user", "c2", "bash", { description: "run unit tests", command: "cargo test" }),
            text(3, "assistant", "All checks passed."),
        ],
        budget_stop: 10_000,
    },
    {
        label: "commit compaction and unicode",
        messages: [
            text(1, "user", "ship it 🚀"),
            text(2, "assistant", "Committed `4301a084` and merged `7e80a1a7` into main."),
            text(3, "assistant", "Résumé complete; naïve café stays readable."),
        ],
        budget_stop: 10_000,
    },
    {
        label: "budget stop has more",
        messages: [text(1, "user", words("one two three four five ", 400)), text(2, "assistant", words("six seven eight ", 400))],
        budget_stop: 100,
    },
];

const boundarySpecs = [
    {
        label: "fresh compartments size walk",
        messages: [text(1, "user", "start"), text(2, "assistant", BIG), text(3, "user", "continue"), text(4, "assistant", BIG)],
        ctx: smallCtx(81),
        flags: { floored_by_live_prompt: false, fenced_by_open_arc: false },
    },
    {
        label: "live prompt floor routine usage",
        messages: [text(1, "user", "old"), text(2, "assistant", BIG), text(3, "user", "please answer"), text(4, "assistant", BIG), text(5, "assistant", BIG)],
        ctx: smallCtx(79),
        flags: { floored_by_live_prompt: true, fenced_by_open_arc: false },
    },
    {
        label: "live prompt bypass derived force usage",
        messages: [text(1, "user", "old"), text(2, "assistant", BIG), text(3, "user", "please answer"), text(4, "assistant", BIG), text(5, "assistant", BIG)],
        ctx: smallCtx(85, { execute_threshold_percentage: 65 }),
        flags: { floored_by_live_prompt: false, fenced_by_open_arc: false },
    },
    {
        label: "recent open arc fences",
        messages: [text(1, "user", "old"), text(2, "assistant", BIG), text(3, "assistant", BIG), tool(4, "assistant", "open-recent", "bash", { description: "build" })],
        ctx: smallCtx(95, { emergency_tail_scale: 0.25 }),
        flags: { floored_by_live_prompt: false, fenced_by_open_arc: true },
    },
    {
        label: "stale open arc compactable",
        messages: [text(1, "user", "old"), tool(2, "assistant", "open-stale", "bash", { description: "build" }), text(3, "assistant", BIG), text(4, "assistant", BIG), text(5, "assistant", BIG)],
        ctx: smallCtx(95, { emergency_tail_scale: 0.25 }),
        flags: { floored_by_live_prompt: false, fenced_by_open_arc: false },
    },
    {
        label: "migration prior boundary floor",
        messages: [text(1, "user", "old"), text(2, "assistant", MID), text(3, "user", "next"), text(4, "assistant", SMALL), text(5, "assistant", SMALL)],
        ctx: smallCtx(81, { prior_boundary_ordinal: 4, migration_floor_active: true }),
        flags: { floored_by_live_prompt: true, fenced_by_open_arc: false },
    },
    {
        label: "emergency quarter scale",
        messages: [text(1, "user", "old"), text(2, "assistant", BIG), text(3, "user", "please answer"), text(4, "assistant", BIG), text(5, "assistant", BIG)],
        ctx: smallCtx(96, { emergency_tail_scale: 0.25 }),
        flags: { floored_by_live_prompt: false, fenced_by_open_arc: false },
    },
];

interface TriggerSpec {
    label: string;
    messages: FixtureMessage[];
    ctx: {
        boundary: BoundaryCtxJson;
        compartment_in_progress: boolean;
        projected_post_drop_percentage: number | null;
        commit_cluster_trigger_enabled: boolean;
        min_commit_clusters: number;
    };
}

const triggerCtx = (
    boundary: BoundaryCtxJson,
    extra: Partial<TriggerSpec["ctx"]> = {},
): TriggerSpec["ctx"] => ({
    boundary,
    compartment_in_progress: false,
    projected_post_drop_percentage: null,
    commit_cluster_trigger_enabled: true,
    min_commit_clusters: 3,
    ...extra,
});

const commitFiller = words("work phase details ", 900);
const proactiveFiller = words("pressure tail ", 4_000);
const triggerSpecs: TriggerSpec[] = [
    {
        label: "no new raw history",
        messages: [text(1, "user", "done")],
        ctx: triggerCtx(smallCtx(20, { last_compartment_end_ordinal: 1 })),
    },
    {
        label: "compartment in progress suppresses",
        messages: [text(1, "user", "start"), text(2, "assistant", HUGE)],
        ctx: triggerCtx(smallCtx(90), { compartment_in_progress: true }),
    },
    {
        label: "tail size fires above threshold",
        messages: [text(1, "user", "start"), text(2, "assistant", HUGE), text(3, "user", "continue"), text(4, "assistant", HUGE), text(5, "assistant", SMALL)],
        ctx: triggerCtx(smallCtx(20)),
    },
    {
        label: "commit clusters fire at min clusters",
        messages: [
            text(1, "user", "phase one"),
            text(2, "assistant", `Committed \`4301a084\` for phase one. ${commitFiller}`),
            text(3, "user", "phase two"),
            text(4, "assistant", `Cherry-picked \`7e80a1a7\` for phase two. ${commitFiller}`),
            text(5, "user", "phase three"),
            text(6, "assistant", `Merged \`9abc1234\` for phase three. ${commitFiller}`),
            text(7, "user", "wrap up after commits"),
            text(8, "assistant", BIG),
        ],
        ctx: triggerCtx(smallCtx(20)),
    },
    {
        label: "commit clusters min-1 no-fire",
        messages: [
            text(1, "user", "phase one"),
            text(2, "assistant", `Committed \`4301a084\` for phase one. ${commitFiller}`),
            text(3, "user", "phase two"),
            text(4, "assistant", `Cherry-picked \`7e80a1a7\` for phase two. ${commitFiller}`),
            text(5, "user", "wrap up before third commit"),
            text(6, "assistant", BIG),
        ],
        ctx: triggerCtx(smallCtx(20)),
    },
    {
        label: "force band projected drops suppress",
        messages: [text(1, "user", "start"), text(2, "assistant", BIG), text(3, "user", "next"), text(4, "assistant", SMALL)],
        ctx: triggerCtx(smallCtx(85, { execute_threshold_percentage: 65 }), { projected_post_drop_percentage: 20 }),
    },
    {
        label: "force band fires with runnable head",
        messages: [text(1, "user", "start"), text(2, "assistant", BIG), text(3, "user", "next"), text(4, "assistant", BIG), text(5, "assistant", SMALL)],
        ctx: triggerCtx(smallCtx(85, { execute_threshold_percentage: 65 })),
    },
    {
        label: "raised threshold usage below force band no-fire",
        messages: [text(1, "user", "start"), text(2, "assistant", BIG), text(3, "user", "next"), text(4, "assistant", BIG), text(5, "assistant", SMALL)],
        ctx: triggerCtx(smallCtx(86, { execute_threshold_percentage: 90 })),
    },
    {
        label: "proactive pressure fires above floor",
        messages: [text(1, "user", "start"), text(2, "assistant", proactiveFiller), text(3, "user", "next"), text(4, "assistant", BIG)],
        ctx: triggerCtx(smallCtx(64)),
    },
    {
        label: "proactive pressure floor-1 no-fire",
        messages: [text(1, "user", "start"), text(2, "assistant", proactiveFiller), text(3, "user", "next"), text(4, "assistant", BIG)],
        ctx: triggerCtx(smallCtx(47)),
    },
    {
        label: "hash lookalikes follow current TS chunk source",
        messages: [
            text(1, "user", "phase one"),
            text(2, "assistant", `artifact abcdef1 without an action verb. ${commitFiller}`),
            text(3, "user", "phase two"),
            text(4, "assistant", `artifact 123abcd without an action verb. ${commitFiller}`),
            text(5, "user", "phase three"),
            text(6, "assistant", `artifact deadbee without an action verb. ${commitFiller}`),
            text(7, "assistant", SMALL),
        ],
        ctx: triggerCtx(smallCtx(20)),
    },
];

const chunk_cases = chunkSpecs.map((spec) => {
    const chunk = tsChunk(spec.messages, spec.budget_stop, spec.label);
    const lines = String(chunk.text ?? "").length > 0 ? String(chunk.text).split("\n") : [];
    const blockTokens = lines.map((line) => estimateTokens(line));
    const hasMore = Boolean(chunk.hasMore);
    return {
        label: spec.label,
        messages: rustMessages(spec.messages),
        budget_stop: spec.budget_stop,
        expected: {
            formatted_blocks: lines,
            block_tokens: blockTokens,
            tokens: hasMore ? Math.max(Number(chunk.tokenEstimate), spec.budget_stop) : Number(chunk.tokenEstimate),
            has_more: hasMore,
            message_count: Number(chunk.messageCount),
            commit_cluster_count: Number(chunk.commitClusterCount),
        },
    };
});

const boundary_cases = boundarySpecs.map((spec) => {
    const boundary = tsBoundary(spec.messages, spec.ctx, spec.label);
    return {
        label: spec.label,
        messages: rustMessages(spec.messages),
        ctx: spec.ctx,
        expected: {
            protected_start_ordinal: boundary.protectedTailStart,
            eligible_head_start: boundary.offset,
            eligible_head_end: boundary.eligibleEndOrdinal,
            n_tokens: boundary.N,
            floored_by_live_prompt: spec.flags.floored_by_live_prompt,
            fenced_by_open_arc: spec.flags.fenced_by_open_arc,
            true_raw_eligible_tokens: boundary.trueRawEligibleTokens,
            oversize_atomic_unit: boundary.oversizeAtomicUnit,
        },
    };
});


function inspectTsTrigger(spec: TriggerSpec): Record<string, unknown> {
    const ctx = spec.ctx.boundary;
    const triggerBudget = ctx.trigger_budget ?? deriveTriggerBudget(ctx.context_limit, ctx.execute_threshold_percentage);
    const primary = tsBoundary(spec.messages, { ...ctx, trigger_budget: triggerBudget, emergency_tail_scale: null }, `${spec.label}-inspect`);
    const hasProtectedEligibleHead = (primary.offset as number) < (primary.protectedTailStart as number);
    const scanBudget = Math.max(6_000, triggerBudget * 3);
    let chunk: Record<string, unknown> = { tokenEstimate: 0, hasMore: false, messageCount: 0, commitClusterCount: 0 };
    if (hasProtectedEligibleHead) {
        const sessionId = `inspect-${spec.label.replace(/[^a-z0-9]+/gi, "-")}`;
        chunk = withRawMessageProvider(
            sessionId,
            { readMessages: () => rawMessages(spec.messages), getMessageCount: () => spec.messages.length },
            () => readSessionChunk(sessionId, scanBudget, primary.offset as number, primary.protectedTailStart as number),
        );
    }
    return {
        triggerBudget,
        scanBudget,
        boundary: {
            offset: primary.offset,
            protectedTailStart: primary.protectedTailStart,
            eligibleEndOrdinal: primary.eligibleEndOrdinal,
            trueRawEligibleTokens: primary.trueRawEligibleTokens,
            boundaryReason: primary.boundaryReason,
        },
        runnable: hasRunnableCompartmentWindow(primary),
        chunk: {
            tokenEstimate: chunk.tokenEstimate,
            hasMore: chunk.hasMore,
            messageCount: chunk.messageCount,
            commitClusterCount: chunk.commitClusterCount,
            text: chunk.text,
        },
    };
}

const trigger_cases = triggerSpecs.map((spec) => ({
    label: spec.label,
    messages: rustMessages(spec.messages),
    ctx: spec.ctx,
    expected: runTsTrigger(spec),
}));

function labelRequiresFire(label: string): boolean {
    const lower = label.toLowerCase();
    if (lower.includes("no-fire") || lower.includes("suppress")) return false;
    return /\b(?:fire|fires)\b/i.test(label);
}

for (const c of trigger_cases) {
    if (labelRequiresFire(c.label) && c.expected.fire !== true) {
        throw new Error(`trigger fixture '${c.label}' is labeled as firing but oracle returned ${JSON.stringify(c.expected)} diagnostics=${JSON.stringify(inspectTsTrigger(triggerSpecs.find((spec) => spec.label === c.label)!))}`);
    }
}

const requiredTriggerReasons = ["tail_size", "commit_clusters", "force_band", "projected_headroom"];
const firedReasons = new Set(
    trigger_cases
        .filter((c) => c.expected.fire === true)
        .map((c) => c.expected.reason)
        .filter((reason): reason is string => typeof reason === "string"),
);
for (const reason of requiredTriggerReasons) {
    if (!firedReasons.has(reason)) {
        throw new Error(`trigger golden does not cover firing reason '${reason}'`);
    }
}

const completed_arc_fence_cases = [
    {
        label: "completed arc inv=2 result=4 fences head end=3 backward",
        candidate: 3,
        publication_floor_ordinal: 2,
        arcs: [{ callId: "exact-381", invOrdinal: 2, resOrdinal: 4 }],
    },
    {
        label: "completed arc below publication floor closes forward",
        candidate: 3,
        publication_floor_ordinal: 3,
        arcs: [{ callId: "published-call", invOrdinal: 2, resOrdinal: 4 }],
    },
].map((fixture) => ({
    ...fixture,
    expected: fenceBoundaryForCompletedToolArcs(
        fixture.candidate,
        fixture.arcs,
        fixture.publication_floor_ordinal,
    ),
}));

const golden = {
    constants: constantsFromSource(),
    default_context_limit: DEFAULT_CONTEXT_LIMIT,
    chunk_cases,
    boundary_cases,
    trigger_cases,
    completed_arc_fence_cases,
};

const outPath = join(import.meta.dir, "..", "testdata", "boundary-golden.json");
writeFileSync(outPath, `${JSON.stringify(golden, null, 2)}\n`);
// eslint-disable-next-line no-console
console.log(
    `wrote ${chunk_cases.length} chunk cases, ${boundary_cases.length} boundary cases, ${trigger_cases.length} trigger cases → ${outPath}`,
);
