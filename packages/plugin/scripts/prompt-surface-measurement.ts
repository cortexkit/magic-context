import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Tokenizer from "ai-tokenizer";
import type { ToolDefinition } from "@opencode-ai/plugin";
import * as claudeEncoding from "ai-tokenizer/encoding/claude";
import { buildMagicContextSection } from "../src/agents/magic-context-prompt";
import { normalizeToolArgSchemas } from "../src/plugin/normalize-tool-arg-schemas";
import {
    ACTIVE_TOOL_IDS,
    LIGHT_TOOL_DESCRIPTIONS,
    type PromptSurfaceToolId,
} from "../src/shared/prompt-surface-runtime";
import { createCtxExpandTools } from "../src/tools/ctx-expand/tools";
import { createCtxMemoryTools } from "../src/tools/ctx-memory/tools";
import { createCtxNoteTools } from "../src/tools/ctx-note/tools";
import { createCtxReduceTools } from "../src/tools/ctx-reduce/tools";
import { createCtxSearchTools } from "../src/tools/ctx-search/tools";
import { CTX_SKILL_NOTE_TOOL_NAME, createCtxSkillNoteTool } from "../src/tools/ctx-skill-note";
import {
    CTX_SKILL_RECALL_TOOL_NAME,
    createCtxSkillRecallTool,
} from "../src/tools/ctx-skill-recall";

export const TOKENIZER_PACKAGE = "ai-tokenizer";
export const TOKENIZER_ENCODING = "claude";
export const TOKENIZER_VERSION = "1.0.6";
export const PRIMARY_VARIANT_ID = "primary-full-reduce-memory-on";

export type ToolId = PromptSurfaceToolId;

export interface TokenCount {
    chars: number;
    tokens: number;
}

export interface MeasuredTool {
    description: TokenCount;
    serializedParameterSchema: TokenCount;
}

export interface MeasuredGuidance {
    id: string;
    label: string;
    featureVariant: Record<string, boolean | string | undefined>;
    full: TokenCount;
}

export interface MeasuredSurface {
    tokenizer: {
        package: string;
        encoding: string;
        version: string;
        method: string;
    };
    guidance: MeasuredGuidance[];
    tools: Record<string, MeasuredTool>;
    primary: {
        guidance: MeasuredGuidance;
        activeTools: ToolId[];
        mutableProseBaseline: number;
        serializedParameterSchemaTotal: number;
        builtInProviderVisibleTotal: number;
    };
}

export interface LightSurfaceInput {
    variant: string;
    guidance: string;
    descriptions: Partial<Record<ToolId, string>>;
}

export function builtInLightSurface(): LightSurfaceInput {
    return {
        variant: PRIMARY_VARIANT_ID,
        guidance: buildMagicContextSection(
            null,
            20,
            true,
            true,
            true,
            false,
            false,
            undefined,
            true,
            "light",
        ),
        descriptions: { ...LIGHT_TOOL_DESCRIPTIONS },
    };
}

export interface MeasuredLightSurface {
    variant: string;
    guidance: TokenCount;
    descriptions: Record<string, TokenCount>;
    mutableProseTotal: number;
    serializedParameterSchemaTotal: number;
    builtInProviderVisibleTotal: number;
}

const tokenizer = new Tokenizer(claudeEncoding);

function count(text: string): TokenCount {
    return { chars: text.length, tokens: tokenizer.count(text) };
}

export function measurePromptSurfaceText(text: string): TokenCount {
    return count(text);
}

function buildToolDefinitions() {
    const stubDeps = new Proxy(
        {},
        {
            get: (_target, property) => {
                if (property === "then") return undefined;
                return () => {
                    throw new Error(`stub dependency called while measuring tools: ${String(property)}`);
                };
            },
        },
    ) as never;

    const definitions: Record<string, ToolDefinition> = Object.assign(
        {},
        createCtxReduceTools(stubDeps),
        createCtxExpandTools(stubDeps),
        createCtxNoteTools(stubDeps),
        createCtxMemoryTools(stubDeps),
        createCtxSearchTools(stubDeps),
        // Skill-memory tools return a single ToolDefinition each rather than a
        // record, so they are keyed explicitly instead of merged as a record.
        {
            [CTX_SKILL_NOTE_TOOL_NAME]: createCtxSkillNoteTool(stubDeps),
            [CTX_SKILL_RECALL_TOOL_NAME]: createCtxSkillRecallTool(stubDeps),
        },
    );
    const definitionIds = new Set(Object.keys(definitions));
    const canonicalIds = new Set<string>(ACTIVE_TOOL_IDS);
    const missing = ACTIVE_TOOL_IDS.filter((id) => !definitionIds.has(id));
    const extra = Object.keys(definitions).filter((id) => !canonicalIds.has(id));
    if (missing.length > 0 || extra.length > 0) {
        throw new Error(
            `Prompt-surface measurement tool definitions drifted from ACTIVE_TOOL_IDS (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`,
        );
    }

    for (const definition of Object.values(definitions)) {
        normalizeToolArgSchemas(definition);
    }
    return definitions;
}

function serializedParameterSchema(definition: {
    args: Record<string, { _zod?: { toJSONSchema?: () => unknown } }>;
}): string {
    const params: Record<string, unknown> = {};
    for (const [name, schema] of Object.entries(definition.args)) {
        params[name] = schema._zod?.toJSONSchema ? schema._zod.toJSONSchema() : "<no toJSONSchema>";
    }
    return JSON.stringify(params);
}

const guidanceDefinitions: Array<{
    id: string;
    label: string;
    args: Parameters<typeof buildMagicContextSection>;
    featureVariant: Record<string, boolean | string | undefined>;
}> = [
    {
        id: PRIMARY_VARIANT_ID,
        label: "PRIMARY full (reduce=on, memory=on, dreamer=on, temporal=on)",
        args: [null, 20, true, true, true, false, false, undefined, true],
        featureVariant: {
            ctxReduceCallable: true,
            dreamerEnabled: true,
            temporalAwarenessEnabled: true,
            cavemanTextCompressionEnabled: false,
            subagentMode: false,
            language: undefined,
            memoryEnabled: true,
        },
    },
    {
        id: "primary-full-reduce-memory-off",
        label: "PRIMARY full (reduce=on, memory=off, dreamer=on, temporal=on)",
        args: [null, 20, true, true, true, false, false, undefined, false],
        featureVariant: {
            ctxReduceCallable: true,
            dreamerEnabled: true,
            temporalAwarenessEnabled: true,
            cavemanTextCompressionEnabled: false,
            subagentMode: false,
            language: undefined,
            memoryEnabled: false,
        },
    },
    {
        id: "primary-full-no-reduce-memory-on",
        label: "PRIMARY full (reduce=off, memory=on, dreamer=on, temporal=on)",
        args: [null, 20, false, true, true, false, false, undefined, true],
        featureVariant: {
            ctxReduceCallable: false,
            dreamerEnabled: true,
            temporalAwarenessEnabled: true,
            cavemanTextCompressionEnabled: false,
            subagentMode: false,
            language: undefined,
            memoryEnabled: true,
        },
    },
    {
        id: "primary-full-no-reduce-memory-off",
        label: "PRIMARY full (reduce=off, memory=off, dreamer=on, temporal=on)",
        args: [null, 20, false, true, true, false, false, undefined, false],
        featureVariant: {
            ctxReduceCallable: false,
            dreamerEnabled: true,
            temporalAwarenessEnabled: true,
            cavemanTextCompressionEnabled: false,
            subagentMode: false,
            language: undefined,
            memoryEnabled: false,
        },
    },
    {
        id: "primary-full-reduce-dreamer-off",
        label: "PRIMARY full (reduce=on, memory=on, dreamer=off, temporal=on)",
        args: [null, 20, true, false, true, false, false, undefined, true],
        featureVariant: {
            ctxReduceCallable: true,
            dreamerEnabled: false,
            temporalAwarenessEnabled: true,
            cavemanTextCompressionEnabled: false,
            subagentMode: false,
            language: undefined,
            memoryEnabled: true,
        },
    },
    {
        id: "primary-full-reduce-temporal-off",
        label: "PRIMARY full (reduce=on, memory=on, dreamer=on, temporal=off)",
        args: [null, 20, true, true, false, false, false, undefined, true],
        featureVariant: {
            ctxReduceCallable: true,
            dreamerEnabled: true,
            temporalAwarenessEnabled: false,
            cavemanTextCompressionEnabled: false,
            subagentMode: false,
            language: undefined,
            memoryEnabled: true,
        },
    },
    {
        id: "primary-full-reduce-caveman-on",
        label: "PRIMARY full (reduce=on, memory=on, caveman=on)",
        args: [null, 20, true, true, true, true, false, undefined, true],
        featureVariant: {
            ctxReduceCallable: true,
            dreamerEnabled: true,
            temporalAwarenessEnabled: true,
            cavemanTextCompressionEnabled: true,
            subagentMode: false,
            language: undefined,
            memoryEnabled: true,
        },
    },
    {
        id: "primary-full-reduce-language-on",
        label: "PRIMARY full (reduce=on, memory=on, language=tr)",
        args: [null, 20, true, true, true, false, false, "tr", true],
        featureVariant: {
            ctxReduceCallable: true,
            dreamerEnabled: true,
            temporalAwarenessEnabled: true,
            cavemanTextCompressionEnabled: false,
            subagentMode: false,
            language: "tr",
            memoryEnabled: true,
        },
    },
    {
        id: "subagent-reduce",
        label: "SUBAGENT minimal (reduce=on)",
        args: [null, 20, true, false, false, false, true, undefined, true],
        featureVariant: {
            ctxReduceCallable: true,
            dreamerEnabled: false,
            temporalAwarenessEnabled: false,
            cavemanTextCompressionEnabled: false,
            subagentMode: true,
            language: undefined,
            memoryEnabled: true,
        },
    },
];

export function measureAgentSurface(): MeasuredSurface {
    const guidance = guidanceDefinitions.map((definition) => ({
        id: definition.id,
        label: definition.label,
        featureVariant: definition.featureVariant,
        full: count(buildMagicContextSection(...definition.args)),
    }));
    const definitions = buildToolDefinitions() as Record<
        string,
        { description?: string; args: Record<string, { _zod?: { toJSONSchema?: () => unknown } }> }
    >;
    const tools: Record<string, MeasuredTool> = {};
    for (const id of ACTIVE_TOOL_IDS) {
        const definition = definitions[id];
        if (!definition) throw new Error(`Tool definition ${id} is missing from the measurement catalog`);
        tools[id] = {
            description: count(definition.description ?? ""),
            serializedParameterSchema: count(serializedParameterSchema(definition)),
        };
    }

    const primaryGuidance = guidance.find((item) => item.id === PRIMARY_VARIANT_ID);
    if (!primaryGuidance) throw new Error(`Primary guidance ${PRIMARY_VARIANT_ID} is missing`);
    const mutableProseBaseline =
        primaryGuidance.full.tokens +
        ACTIVE_TOOL_IDS.reduce((total, id) => total + tools[id].description.tokens, 0);
    const serializedParameterSchemaTotal = ACTIVE_TOOL_IDS.reduce(
        (total, id) => total + tools[id].serializedParameterSchema.tokens,
        0,
    );

    return {
        tokenizer: {
            package: TOKENIZER_PACKAGE,
            encoding: TOKENIZER_ENCODING,
            version: TOKENIZER_VERSION,
            method: "new Tokenizer(claudeEncoding).count(rawText)",
        },
        guidance,
        tools,
        primary: {
            guidance: primaryGuidance,
            activeTools: [...ACTIVE_TOOL_IDS],
            mutableProseBaseline,
            serializedParameterSchemaTotal,
            builtInProviderVisibleTotal: mutableProseBaseline + serializedParameterSchemaTotal,
        },
    };
}

export function measureLightSurface(input: LightSurfaceInput, surface = measureAgentSurface()): MeasuredLightSurface {
    const descriptions: Record<string, TokenCount> = {};
    for (const id of surface.primary.activeTools) {
        const description = input.descriptions[id];
        if (typeof description !== "string" || description.trim() === "") {
            throw new Error(`Light surface is missing a non-empty description for active tool ${id}`);
        }
        descriptions[id] = count(description);
    }
    const guidance = count(input.guidance);
    const mutableProseTotal =
        guidance.tokens + Object.values(descriptions).reduce((total, item) => total + item.tokens, 0);
    return {
        variant: input.variant,
        guidance,
        descriptions,
        mutableProseTotal,
        serializedParameterSchemaTotal: surface.primary.serializedParameterSchemaTotal,
        builtInProviderVisibleTotal: mutableProseTotal + surface.primary.serializedParameterSchemaTotal,
    };
}

export function readLightSurface(path: string): LightSurfaceInput {
    const parsed = JSON.parse(readFileSync(resolve(path), "utf8")) as Partial<LightSurfaceInput>;
    if (typeof parsed.variant !== "string" || typeof parsed.guidance !== "string" || parsed.descriptions === null) {
        throw new Error(`Invalid light surface manifest ${path}: expected variant, guidance, and descriptions`);
    }
    return {
        variant: parsed.variant,
        guidance: parsed.guidance,
        descriptions: parsed.descriptions as Partial<Record<ToolId, string>>,
    };
}
