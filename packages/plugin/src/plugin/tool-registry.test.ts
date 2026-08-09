/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ToolDefinition, tool } from "@opencode-ai/plugin";
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
    createPromptSurfaceRuntime,
    LIGHT_TOOL_DESCRIPTIONS,
} from "../shared/prompt-surface-runtime";
import type { RustToolBackends } from "./rust-tool-backends";
import { createToolRegistry, getCompactionOffRemovedToolIds } from "./tool-registry";
import type { PluginContext } from "./types";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdgDataHome;
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
    const dir = mkdtempSync(join(tmpdir(), "tool-registry-"));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

// createToolRegistry only reads ctx.directory; the rest of PluginContext is
// unused, so a minimal stub is sufficient.
const ctx = { directory: process.cwd() } as unknown as PluginContext;

function buildRegistry(
    config: Partial<MagicContextPluginConfig>,
    rustToolBackends?: RustToolBackends,
    promptSurfaceRuntime?: PromptSurfaceRuntime,
    registrationPromptSurface?: MagicContextPluginConfig["prompt_surface"],
): Record<string, ToolDefinition> {
    return createToolRegistry({
        ctx,
        pluginConfig: { enabled: true, ...config } as MagicContextPluginConfig,
        rustToolBackends,
        promptSurfaceRuntime,
        registrationPromptSurface,
    });
}

describe("createToolRegistry — memory gating", () => {
    it("advertises only real ctx_* fields", () => {
        isolateDb();
        const tools = buildRegistry({});
        const expectedFields: Record<string, string[]> = {
            ctx_reduce: ["drop"],
            ctx_expand: ["start", "end", "verbose", "message"],
            ctx_note: [
                "action",
                "content",
                "surface_condition",
                "filter",
                "limit",
                "offset",
                "note_id",
            ],
            ctx_search: ["query", "limit", "sources"],
            ctx_memory: ["action", "content", "category", "ids", "limit", "reason"],
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
    });

    it("registers ctx_memory when memory is enabled (default)", () => {
        isolateDb();
        const tools = buildRegistry({});
        expect(Object.keys(tools)).toContain("ctx_memory");
        expect(Object.keys(tools)).toContain("ctx_search");
    });

    it("keeps ctx_note on context.db in rust mode", async () => {
        isolateDb();
        let moduleCalls = 0;
        const tools = buildRegistry(
            { transform_mode: "rust" },
            {
                reduce: async () => {
                    moduleCalls += 1;
                    return { ok: true, queued: 1 };
                },
                memorySync: () => {
                    moduleCalls += 1;
                },
            },
        );

        const result = await tools.ctx_note.execute(
            { action: "write", content: "Notes remain on the OpenCode leg." },
            { sessionID: "ses-note-rust", directory: process.cwd() },
        );
        const db = openDatabase();
        const row = db
            ?.prepare("SELECT content FROM notes WHERE session_id = ?")
            .get("ses-note-rust") as { content: string } | undefined;

        expect(result).toContain("Saved session note");
        expect(row?.content).toBe("Notes remain on the OpenCode leg.");
        expect(moduleCalls).toBe(0);
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

function readA1GoldenTools(): Record<string, GoldenTool> {
    const document = readA1GoldenDocument();
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
    it("matches the A1 golden for no config and explicit full", () => {
        const golden = readA1GoldenTools();
        isolateDb();
        const implicit = buildRegistry({});
        isolateDb();
        const explicit = buildRegistry({
            prompt_surface: { default: "full" },
        } as Partial<MagicContextPluginConfig>);

        expect(Object.keys(implicit).sort()).toEqual(Object.keys(golden).sort());
        expect(Object.keys(explicit).sort()).toEqual(Object.keys(golden).sort());
        for (const [toolId, expected] of Object.entries(golden)) {
            expect(implicit[toolId]?.description).toBe(expected.description);
            expect(explicit[toolId]?.description).toBe(expected.description);
            expect(providerParameters(implicit[toolId])).toEqual(expected.parameters);
            expect(providerParameters(explicit[toolId])).toEqual(expected.parameters);
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
            undefined,
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

    it("registers the built-in light descriptions without changing schemas", () => {
        const warnings: string[] = [];
        const runtime = createPromptSurfaceRuntime({
            userConfigDirectory: process.cwd(),
            warn: (warning) => warnings.push(warning),
        });
        isolateDb();
        const full = buildRegistry({});
        isolateDb();
        const light = buildRegistry(
            { prompt_surface: { default: "light" } } as Partial<MagicContextPluginConfig>,
            undefined,
            runtime,
        );

        for (const toolId of Object.keys(LIGHT_TOOL_DESCRIPTIONS)) {
            expect(light[toolId]?.description).toBe(
                LIGHT_TOOL_DESCRIPTIONS[toolId as keyof typeof LIGHT_TOOL_DESCRIPTIONS],
            );
            expect(providerParameters(light[toolId])).toEqual(providerParameters(full[toolId]));
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
            undefined,
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
