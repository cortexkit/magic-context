/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import {
    measureAgentSurface,
    measurePromptSurfaceText,
} from "../../scripts/prompt-surface-measurement";
import type { MagicContextPluginConfig } from "../config";
import { closeDatabase, openDatabase } from "../features/magic-context/storage";
import { resetCtxReduceRegisteredGloballyForTest } from "../hooks/magic-context/ctx-reduce-availability";
import {
    A1_HASH_BASELINE_HEADING,
    A1_TOOL_SECTION_HEADING,
    a1GoldenSectionOffset,
    readA1GoldenDocument,
} from "../shared/prompt-surface-a1-golden";
import type { PromptSurfaceRuntime } from "../shared/prompt-surface-runtime";
import {
    ACTIVE_TOOL_IDS,
    createPromptSurfaceRuntime,
    LIGHT_TOOL_DESCRIPTIONS,
} from "../shared/prompt-surface-runtime";
import { createTestTempDirFromPath } from "../shared/test-temp-dir";
import {
    SESSION_ID,
    seedTypeScriptTagHistory,
    TS_TAG_TEXT,
} from "../tools/ctx-expand/tag-history.test-support";
import {
    FULL_PARAMETER_DESCRIPTIONS,
    LIGHT_PARAMETER_DESCRIPTIONS,
} from "../tools/parameter-descriptions";
import { createToolRegistry, getCompactionOffRemovedToolIds } from "./tool-registry";
import type { PluginContext } from "./types";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* ignore */
        }
    }
    tempDirs.length = 0;
    // The compaction-off override is process-global and boot-resolved; reset
    // to the default-true baseline so a compaction-off test cannot leak a
    // false verdict into a later test in the same bun process.
    resetCtxReduceRegisteredGloballyForTest();
});

function isolateDb(): void {
    const dir = createTestTempDirFromPath(join(tmpdir(), "tool-registry-"));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    // The host opens storage asynchronously before registration; this fixture
    // uses the explicitly synchronous test opener to establish that ready state.
    expect(openDatabase()).not.toBeNull();
}

// createToolRegistry only reads ctx.directory; the rest of PluginContext is
// unused, so a minimal stub is sufficient.
const ctx = { directory: process.cwd() } as unknown as PluginContext;

// ctx_note advertises smart notes only with a runnable dreamer, which evaluates
// them; the golden and field-list tests describe that full surface.
const RUNNABLE_DREAMER = { dreamer: {} } as Partial<MagicContextPluginConfig>;

function buildRegistry(
    config: Partial<MagicContextPluginConfig>,
    promptSurfaceRuntime?: PromptSurfaceRuntime,
    registrationPromptSurface?: MagicContextPluginConfig["prompt_surface"],
    includeDreamerOnlyTools = false,
): Record<string, ToolDefinition> {
    return createToolRegistry({
        ctx,
        pluginConfig: { enabled: true, ...config } as MagicContextPluginConfig,
        promptSurfaceRuntime,
        registrationPromptSurface,
        includeDreamerOnlyTools,
    });
}

describe("createToolRegistry — memory gating", () => {
    it("advertises only real ctx_* fields", () => {
        isolateDb();
        const tools = buildRegistry(RUNNABLE_DREAMER);
        const expectedFields: Record<string, string[]> = {
            ctx_reduce: ["drop"],
            ctx_expand: ["start", "end", "verbose", "message", "tag"],
            ctx_note: [
                "action",
                "content",
                "surface_condition",
                "filter",
                "limit",
                "offset",
                "note_ids",
            ],
            ctx_search: ["query", "limit", "from", "to", "sources"],
            // No `limit`: it only sized the dreamer-only list action, which now
            // lives on ctx_memory_list (issue 575).
            ctx_memory: ["action", "content", "category", "ids", "reason"],
        };

        for (const [name, fields] of Object.entries(expectedFields)) {
            const definition = tools[name];
            expect(definition).toBeDefined();
            const jsonSchema = tool.schema.toJSONSchema(
                tool.schema.object(definition?.args ?? {}),
            ) as { properties?: Record<string, unknown> };
            expect(Object.keys(jsonSchema.properties ?? {}).sort()).toEqual([...fields].sort());
            expect(jsonSchema.properties).not.toHaveProperty("reduced");
            expect(jsonSchema.properties).not.toHaveProperty("summary");
        }

        // Without a dreamer block smart notes cannot run, so ctx_note drops surface_condition.
        isolateDb();
        const noDreamer = tool.schema.toJSONSchema(
            tool.schema.object(buildRegistry({}).ctx_note?.args ?? {}),
        ) as { properties?: Record<string, unknown> };
        expect(Object.keys(noDreamer.properties ?? {}).sort()).toEqual(
            expectedFields.ctx_note!.filter((field) => field !== "surface_condition").sort(),
        );
    });

    it("keeps the primary memory surface free of the dreamer-only list tool and action", () => {
        isolateDb();
        const tools = buildRegistry({});
        expect(Object.keys(tools)).toContain("ctx_memory");
        expect(Object.keys(tools)).not.toContain("ctx_memory_list");
        expect(Object.keys(tools)).toContain("ctx_search");
        const memorySchema = tool.schema.toJSONSchema(
            tool.schema.object(tools.ctx_memory?.args ?? {}),
        ) as { properties?: { action?: { enum?: string[] } } };
        expect(memorySchema.properties?.action?.enum).toEqual([
            "write",
            "update",
            "archive",
            "merge",
            "get",
        ]);
    });

    it("registers ctx_memory_list only for the permission-filtered runtime map", () => {
        isolateDb();
        const tools = buildRegistry({}, undefined, undefined, true);
        expect(Object.keys(tools)).toContain("ctx_memory_list");
        const listSchema = tool.schema.toJSONSchema(
            tool.schema.object(tools.ctx_memory_list?.args ?? {}),
        ) as { properties?: Record<string, unknown> };
        expect(Object.keys(listSchema.properties ?? {}).sort()).toEqual(["category", "limit"]);
    });

    it("omits ctx_memory when memory.enabled is false, but keeps ctx_search", () => {
        isolateDb();
        const tools = buildRegistry({ memory: { enabled: false } as never });
        expect(Object.keys(tools)).not.toContain("ctx_memory");
        expect(Object.keys(tools)).toContain("ctx_search");
        // ctx_note / ctx_expand are unaffected by the memory gate.
        expect(Object.keys(tools)).toContain("ctx_note");
        expect(Object.keys(tools)).toContain("ctx_expand");
    });
});

describe("createToolRegistry — compaction-off mode (#266 S4)", () => {
    // The canonical enumerated removed-set, imported from the registry source
    // so a future tool the reduce factory grows appears here and fails the
    // diff rather than silently vanishing in compaction-off mode. The factory
    // is plural (returns a record keyed by tool name), so the test must
    // distinguish "factory skipped" from "one ID filtered" — this enumeration
    // is the removed-set the acceptance test diffs against the mode-on tool
    // list.
    const COMPACTION_OFF_REMOVED_TOOL_IDS = getCompactionOffRemovedToolIds();

    it("compaction-off tool set = mode-on tool set minus exactly the reduce factory's IDs", () => {
        isolateDb();
        const modeOn = buildRegistry({});
        isolateDb();
        const modeOff = buildRegistry({ compaction: { enabled: false } as never });

        const onIds = new Set(Object.keys(modeOn));
        const offIds = new Set(Object.keys(modeOff));

        // The diff is EXACTLY the enumerated removed-set and nothing else.
        const removed = [...onIds].filter((id) => !offIds.has(id));
        const added = [...offIds].filter((id) => !onIds.has(id));
        expect(removed.sort()).toEqual([...COMPACTION_OFF_REMOVED_TOOL_IDS].sort());
        expect(added).toEqual([]);

        // Every other ctx_* tool stays registered (subject to its own gates).
        for (const id of ["ctx_expand", "ctx_search", "ctx_note", "ctx_memory"]) {
            expect(offIds.has(id)).toBe(true);
        }
    });

    it("compaction-on (default) registers ctx_reduce", () => {
        isolateDb();
        const tools = buildRegistry({});
        expect(Object.keys(tools)).toContain("ctx_reduce");
    });

    it("compaction { enabled: true } is identical to default (back-compat)", () => {
        isolateDb();
        const implicit = buildRegistry({});
        isolateDb();
        const explicit = buildRegistry({ compaction: { enabled: true } as never });
        expect(Object.keys(explicit).sort()).toEqual(Object.keys(implicit).sort());
        expect(Object.keys(explicit)).toContain("ctx_reduce");
    });

    it("compaction-off does not advertise ctx_reduce's `drop` arg field", () => {
        isolateDb();
        const tools = buildRegistry({ compaction: { enabled: false } as never });
        expect(tools.ctx_reduce).toBeUndefined();
        // ctx_expand still advertises its fields — the reduce factory was
        // skipped, not the expand factory.
        const expandSchema = tool.schema.toJSONSchema(
            tool.schema.object(tools.ctx_expand?.args ?? {}),
        ) as { properties?: Record<string, unknown> };
        expect(Object.keys(expandSchema.properties ?? {})).toContain("start");
    });
});

type GoldenTool = { description: string; parameters: Record<string, unknown> };

function readA1GoldenTools(document = readA1GoldenDocument()): Record<string, GoldenTool> {
    const toolSection = document.slice(
        a1GoldenSectionOffset(document, A1_TOOL_SECTION_HEADING),
        a1GoldenSectionOffset(document, A1_HASH_BASELINE_HEADING),
    );
    const headings = [...toolSection.matchAll(/^### (ctx_[a-z_]+) —.*$/gm)];
    return Object.fromEntries(
        headings.map((heading, index) => {
            const start = (heading.index ?? 0) + heading[0].length;
            const end = headings[index + 1]?.index ?? toolSection.length;
            const body = toolSection.slice(start, end);
            const description = body.match(/\*\*Description:\*\*\s+```\n([\s\S]*?)\n```/)?.[1];
            const parameters = body.match(
                /\*\*Parameters \(JSON Schema per parameter, as serialized to the provider\):\*\*\s+```json\n([\s\S]*?)\n```/,
            )?.[1];
            if (description === undefined || parameters === undefined) {
                throw new Error(`Malformed A1 golden tool section: ${heading[1]}`);
            }
            return [
                heading[1],
                { description, parameters: JSON.parse(parameters) as Record<string, unknown> },
            ];
        }),
    );
}

function withoutDescriptions(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(withoutDescriptions);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
        Object.entries(value)
            .filter(([key]) => key !== "description")
            .map(([key, child]) => [key, withoutDescriptions(child)]),
    );
}

function providerParameters(definition: ToolDefinition): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(definition.args ?? {}).map(([name, schema]) => {
            const serializable = schema as { _zod?: { toJSONSchema?: () => unknown } };
            return [
                name,
                serializable._zod?.toJSONSchema
                    ? serializable._zod.toJSONSchema()
                    : "<no toJSONSchema>",
            ];
        }),
    );
}

describe("createToolRegistry — prompt-surface registration", () => {
    it("surface generators serialize the registered parameter descriptions", () => {
        isolateDb();
        const registered = buildRegistry(RUNNABLE_DREAMER);
        const dir = createTestTempDirFromPath(join(tmpdir(), "agent-surface-export-"));
        tempDirs.push(dir);
        const output = join(dir, "surface.md");
        const exported = Bun.spawnSync({
            cmd: [
                process.execPath,
                join(import.meta.dir, "../../scripts/export-agent-surface.ts"),
                output,
            ],
            env: process.env,
            windowsHide: true,
        });
        expect(exported.exitCode).toBe(0);
        const tools = readA1GoldenTools(readFileSync(output, "utf8"));
        const measured = measureAgentSurface();
        for (const id of ACTIVE_TOOL_IDS) {
            const definition = registered[id];
            if (!definition) throw new Error(`Missing registered tool ${id}`);
            const parameters = providerParameters(definition);
            expect(tools[id]?.parameters).toEqual(parameters);
            expect(measured.tools[id].serializedParameterSchema).toEqual(
                measurePromptSurfaceText(JSON.stringify(parameters)),
            );
        }
    });

    it("links canonical prompt-surface IDs to light descriptions and registration", () => {
        isolateDb();
        const registeredCtxToolIds = Object.keys(buildRegistry({})).filter((id) =>
            id.startsWith("ctx_"),
        );
        const canonicalIds = new Set<string>(ACTIVE_TOOL_IDS);
        const registeredIds = new Set(registeredCtxToolIds);
        const missing = [...canonicalIds].filter((id) => !registeredIds.has(id));
        const extra = [...registeredIds].filter((id) => !canonicalIds.has(id));
        if (missing.length > 0 || extra.length > 0) {
            throw new Error(
                [
                    "Prompt-surface tool registry drifted from ACTIVE_TOOL_IDS.",
                    `Missing: ${missing.join(", ") || "none"}.`,
                    `Extra: ${extra.join(", ") || "none"}.`,
                    "If this is a new ctx_* tool, also review the Rust prompt-surface list in crates/mc-module/src/prompt_surface.rs; cross-language drift is intentionally checked separately.",
                ].join(" "),
            );
        }

        for (const id of ACTIVE_TOOL_IDS) {
            expect(Object.hasOwn(LIGHT_TOOL_DESCRIPTIONS, id)).toBe(true);
            expect(LIGHT_TOOL_DESCRIPTIONS[id].trim().length).toBeGreaterThan(0);
        }
    });

    it("matches the A1 golden for no config and explicit full", () => {
        const golden = readA1GoldenTools();
        isolateDb();
        const implicit = buildRegistry(RUNNABLE_DREAMER);
        isolateDb();
        const explicit = buildRegistry({
            ...RUNNABLE_DREAMER,
            prompt_surface: { default: "full" },
        } as Partial<MagicContextPluginConfig>);
        isolateDb();
        const noDreamer = buildRegistry({});

        expect(Object.keys(implicit).sort()).toEqual(Object.keys(golden).sort());
        expect(Object.keys(explicit).sort()).toEqual(Object.keys(golden).sort());
        for (const [toolId, expected] of Object.entries(golden)) {
            expect(implicit[toolId]?.description).toBe(expected.description);
            expect(explicit[toolId]?.description).toBe(expected.description);
            expect(providerParameters(implicit[toolId])).toEqual(expected.parameters);
            expect(providerParameters(explicit[toolId])).toEqual(expected.parameters);
            // Without a dreamer only ctx_note differs: it loses its smart-note text.
            if (toolId === "ctx_note") {
                expect(noDreamer[toolId]?.description).not.toBe(expected.description);
                expect(JSON.stringify(providerParameters(noDreamer[toolId]))).not.toContain(
                    "surface_condition",
                );
            } else {
                expect(noDreamer[toolId]?.description).toBe(expected.description);
                expect(providerParameters(noDreamer[toolId])).toEqual(expected.parameters);
            }
        }
    });

    it("applies only top-level user descriptions and ignores model routes", () => {
        const warnings: string[] = [];
        const runtime = createPromptSurfaceRuntime({
            userConfigDirectory: process.cwd(),
            warn: (warning) => warnings.push(warning),
        });
        isolateDb();
        const baseline = buildRegistry({});
        isolateDb();
        const overridden = buildRegistry(
            {
                prompt_surface: {
                    default: "full",
                    models: { "provider/model": "light" },
                    tool_descriptions: { ctx_search: "Custom search surface" },
                },
            } as Partial<MagicContextPluginConfig>,
            runtime,
        );

        expect(overridden.ctx_search.description).toBe("Custom search surface");
        expect(overridden.ctx_reduce.description).toBe(baseline.ctx_reduce.description);
        for (const toolId of Object.keys(baseline)) {
            expect(providerParameters(overridden[toolId])).toEqual(
                providerParameters(baseline[toolId]),
            );
        }
        expect(warnings).toEqual([]);
    });

    it("registers built-in light descriptions without changing non-prose schema fields", () => {
        const warnings: string[] = [];
        const runtime = createPromptSurfaceRuntime({
            userConfigDirectory: process.cwd(),
            warn: (warning) => warnings.push(warning),
        });
        isolateDb();
        const full = buildRegistry(RUNNABLE_DREAMER);
        isolateDb();
        const light = buildRegistry(
            {
                ...RUNNABLE_DREAMER,
                prompt_surface: { default: "light" },
            } as Partial<MagicContextPluginConfig>,
            runtime,
        );

        for (const toolId of Object.keys(LIGHT_TOOL_DESCRIPTIONS)) {
            expect(light[toolId]?.description).toBe(
                LIGHT_TOOL_DESCRIPTIONS[toolId as keyof typeof LIGHT_TOOL_DESCRIPTIONS],
            );
            const lightParameters = providerParameters(light[toolId]);
            const fullParameters = providerParameters(full[toolId]);
            expect(lightParameters).not.toEqual(fullParameters);
            expect(withoutDescriptions(lightParameters)).toEqual(
                withoutDescriptions(fullParameters),
            );
            for (const [name, description] of Object.entries(
                LIGHT_PARAMETER_DESCRIPTIONS[toolId as keyof typeof LIGHT_PARAMETER_DESCRIPTIONS],
            )) {
                expect((lightParameters[name] as { description?: string }).description).toBe(
                    description,
                );
                expect((fullParameters[name] as { description?: string }).description).toBe(
                    (FULL_PARAMETER_DESCRIPTIONS as Record<string, Record<string, string>>)[
                        toolId
                    ]?.[name],
                );
            }
        }
        expect(warnings).toEqual([]);
    });
});

describe("createToolRegistry — user-owned registration default", () => {
    it("does not let a project-routed default select process-scoped tool text", () => {
        const warnings: string[] = [];
        const runtime = createPromptSurfaceRuntime({
            userConfigDirectory: process.cwd(),
            warn: (warning) => warnings.push(warning),
        });
        isolateDb();
        const registry = buildRegistry(
            {
                prompt_surface: {
                    default: "light",
                    tool_descriptions: { ctx_search: "User-owned search description" },
                },
            } as Partial<MagicContextPluginConfig>,
            runtime,
            {
                default: "full",
                tool_descriptions: { ctx_search: "User-owned search description" },
            },
        );

        expect(registry.ctx_search.description).toBe("User-owned search description");
        expect(warnings).toEqual([]);
    });
});

describe("createToolRegistry — ctx_expand tag lookup", () => {
    async function expandTag(): Promise<unknown> {
        const root = join(tmpdir(), "magic-context", "expand-tag");
        mkdirSync(root, { recursive: true });
        const dir = createTestTempDirFromPath(join(root, "registry-"));
        tempDirs.push(dir);
        process.env.XDG_DATA_HOME = dir;
        const db = openDatabase();
        if (!db) throw new Error("test database unavailable");
        const cleanup = seedTypeScriptTagHistory(db);
        try {
            const tools = buildRegistry({});
            return await tools.ctx_expand!.execute({ tag: 75386 }, {
                sessionID: SESSION_ID,
            } as never);
        } finally {
            cleanup();
        }
    }

    it("keeps tag lookup for the TypeScript transform", async () => {
        expect(await expandTag()).toContain(TS_TAG_TEXT);
    });
});
