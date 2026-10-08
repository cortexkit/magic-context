/**
 * Builds the example `tool.catalog` payloads that accompany
 * `docs/designs/mc-tool-catalog-v1.md`.
 *
 * Run from the repository root:
 *
 *   bun docs/designs/mc-tool-catalog-v1/generate.ts          # write the files
 *   bun docs/designs/mc-tool-catalog-v1/generate.ts --check  # fail if any file differs
 *
 * The payloads are built from the one definition the Rust module also serves
 * from: `crates/mc-module/assets/tool_catalog_v1.json` (tools, argument-schema
 * structures, descriptions, parameter descriptions and the guidance texts) and
 * the two `tools-only` texts beside it (`catalog_tools_only.txt`,
 * `catalog_tools_only_light.txt`). The texts are templates; `renderText` below
 * is the reference renderer, and the module's `tool_catalog.rs` renders them
 * the same way. The design document explains how each schema differs from what
 * the plugin and the Rust module advertise today.
 *
 * Both modes also check what the payloads promise:
 *
 * - the definition's descriptions and parameter descriptions equal the
 *   plugin's shipped strings, and its guidance texts render to exactly what the
 *   plugin's `buildMagicContextSection` builds, for every combination of its
 *   inputs, so a wording change on either side is a `--check` failure instead
 *   of silent drift;
 * - each example text equals the Rust module's shipped guidance asset for the
 *   same variant (`crates/mc-module/assets/`);
 * - every capability tag passes the tool-provider role's tag check, and
 *   `system_text.tool_names` matches the sorted, deduplicated Magic Context
 *   served tool names whenever system_text is present;
 * - `ctx_reduce` keeps its frozen name and structural schema;
 * - this file's JCS and schema-digest code reproduces the canonical JSON and
 *   schema hashes published in the commons role-contract and prefrontal fetch-plan
 *   test vectors. The generator reads those repositories with `git show` at pinned
 *   commits. They are looked up next to this repository's main checkout, or at
 *   `MC_CATALOG_COMMONS_REPO` and `MC_CATALOG_PREFRONTAL_REPO`; when one is missing,
 *   the run says so and skips that cross-check.
 *
 * Besides the example payloads it writes
 * `crates/mc-module/testdata/tool-catalog-guidance-matrix.json`: the digest of
 * every guidance text for every combination of config inputs, which the Rust
 * module's tests render and compare, so both renderers stay byte-identical.
 *
 * This is a documentation helper. Nothing in the plugin or the module imports it.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { buildPrimaryLanguageDirective } from "../../../packages/plugin/src/agents/language-directive";
import { buildMagicContextSection } from "../../../packages/plugin/src/agents/magic-context-prompt";
import { CTX_EXPAND_DESCRIPTION } from "../../../packages/plugin/src/tools/ctx-expand/constants";
import { CTX_MEMORY_DESCRIPTION } from "../../../packages/plugin/src/tools/ctx-memory/constants";
import { CTX_NOTE_DESCRIPTION } from "../../../packages/plugin/src/tools/ctx-note/constants";
import { CTX_REDUCE_DESCRIPTION } from "../../../packages/plugin/src/tools/ctx-reduce/constants";
import { resolvePromptSurface } from "../../../packages/plugin/src/shared/prompt-surface";
import { CTX_SEARCH_DESCRIPTION } from "../../../packages/plugin/src/tools/ctx-search/constants";
import {
    CTX_EXPAND_LIGHT_DESCRIPTION,
    CTX_MEMORY_LIGHT_DESCRIPTION,
    CTX_NOTE_LIGHT_DESCRIPTION,
    CTX_REDUCE_LIGHT_DESCRIPTION,
    CTX_SEARCH_LIGHT_DESCRIPTION,
} from "../../../packages/plugin/src/tools/light-descriptions";
import {
    FULL_PARAMETER_DESCRIPTIONS,
    LIGHT_PARAMETER_DESCRIPTIONS,
} from "../../../packages/plugin/src/tools/parameter-descriptions";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
type Surface = "full" | "light";
type ToolId = "ctx_reduce" | "ctx_expand" | "ctx_note" | "ctx_memory" | "ctx_search";

/** Fleet roles; the frozen composition independently selects compaction. */
const PRESETS = ["head", "worker", "reader"] as const;
type Preset = (typeof PRESETS)[number];

const TOOL_PARAMS = new Set(["scope", "tool_descs", "exclude", "behavior", "model"]);
const TEXT_PARAMS = new Set(["surface", "model"]);

/** Magic Context's daemon-registered module id (crates/mc-module/src/lib.rs, DEFAULT_MODULE_ID). */
const MODULE_ID = "magic-context";

/**
 * `ctx_reduce`'s name and structural schema are frozen for v1. The Claude Code
 * gateway grants stamping authority only to a tool with exactly this name and
 * schema, so changing either here without a matching gateway change would turn
 * stamping off on Claude Code. Any change to either must ship in the same
 * release as the gateway change that recognises it.
 */
const FROZEN_CTX_REDUCE_SCHEMA_DIGEST =
    "69c7dd3393dc8af19386eb80f849df7a1943126bfe1a14769bfff1182b88abf6";

/**
 * The unprefixed capability tags the tool-provider role defines
 * (`DEFINED_CAPABILITY_TAGS` in commons' cortexkit-role-tool-provider 0.4.3).
 * The cross-check below compares this list with the crate's.
 */
const DEFINED_CAPABILITY_TAGS = [
    "shell.exec/v1",
    "code.read/v1",
    "code.edit/v1",
    "code.search/v1",
    "code.files/v1",
    "code.outline/v1",
    "code.callgraph/v1",
    "code.diagnostics/v1",
    "browser.use/v1",
    "computer.use/v1",
];

/**
 * A port of `check_capability_tag` from cortexkit-role-tool-provider 0.4.3:
 * a tag is one of the defined unprefixed tags, or `<namespace>:<name>/v<N>`
 * with a namespace of lowercase letters and digits in `-`-separated words, a
 * name of `.`-separated words of lowercase letters, digits and `_`, and a
 * version with no leading zero. Returns the problem, or null for a good tag.
 */
export function capabilityTagProblem(tag: string): string | null {
    const colon = tag.indexOf(":");
    if (colon < 0) {
        return DEFINED_CAPABILITY_TAGS.includes(tag) ? null : "undefined unprefixed tag";
    }
    const namespace = tag.slice(0, colon);
    const rest = tag.slice(colon + 1);
    if (namespace === "") return "empty namespace";
    if (!namespace.split("-").every((word) => /^[a-z0-9]+$/.test(word))) {
        return "malformed namespace";
    }
    const versionAt = rest.lastIndexOf("/v");
    if (versionAt < 0) return "malformed name";
    const name = rest.slice(0, versionAt);
    const version = rest.slice(versionAt + 2);
    if (!/^[1-9][0-9]*$/.test(version)) return "malformed name";
    if (!name.split(".").every((word) => /^[a-z0-9_]+$/.test(word))) return "malformed name";
    return null;
}

const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), "..", "..", "..");
const ASSETS = join(REPO_ROOT, "crates/mc-module/assets");

/** One tool as the shared definition declares it. */
interface ToolDefinition {
    name: ToolId;
    /** Capability tags, all `magic-context:*` (see the design document, §2.2). */
    capabilities: string[];
    /**
     * Hooks may add text before or after a Magic Context result but never
     * replace it: ctx_expand and ctx_search return archived conversation and
     * memories, and the guidance tells the model to trust that content as the
     * exact record.
     */
    result_ops: string[];
    semantics: number;
    /**
     * Served under `scope: read`: the tool writes no project data (memories,
     * notes). Stamping with ctx_reduce only changes what this session's model sees.
     */
    read_scope: boolean;
    /** The argument schema without descriptions; property order never affects a digest. */
    structure: JsonObject;
}

interface Definition {
    format: string;
    /** Catalog order: the plugin's single list of ctx_* tools (ACTIVE_TOOL_IDS). */
    tools: ToolDefinition[];
    preset_tools: Record<"compacting" | "not_compacting", Record<Preset, ToolId[]>>;
    preset_aliases: Record<string, Preset>;
    descriptions: Record<Surface, Record<ToolId, string>>;
    parameter_descriptions: Record<Surface, Record<ToolId, Record<string, string>>>;
    /** Guidance templates and the fragments they include, by name (see `renderText`). */
    texts: Record<string, string>;
}

const DEFINITION_FORMAT = "magic-context/tool-catalog-definition/1";

function loadDefinition(): Definition {
    const definition = JSON.parse(
        readFileSync(join(ASSETS, "tool_catalog_v1.json"), "utf8"),
    ) as Definition;
    if (definition.format !== DEFINITION_FORMAT) {
        throw new Error(`tool_catalog_v1.json has format ${definition.format}`);
    }
    // The tools-only texts are their own assets so they read as plain text.
    definition.texts["tools_only/full"] = readFileSync(join(ASSETS, "catalog_tools_only.txt"), "utf8");
    definition.texts["tools_only/light"] = readFileSync(
        join(ASSETS, "catalog_tools_only_light.txt"),
        "utf8",
    );
    return definition;
}

const DEFINITION = loadDefinition();
const TOOL_ORDER: readonly ToolId[] = DEFINITION.tools.map((tool) => tool.name);
const TOOL_DEFINITIONS = new Map<string, ToolDefinition>(DEFINITION.tools.map((tool) => [tool.name, tool]));
const FULL_DESCRIPTIONS = DEFINITION.descriptions.full;
const LIGHT_DESCRIPTIONS = DEFINITION.descriptions.light;

function toolDefinition(tool: ToolId): ToolDefinition {
    const definition = TOOL_DEFINITIONS.get(tool);
    if (!definition) throw new Error(`the definition has no tool ${tool}`);
    return definition;
}

// ── Guidance templates ───────────────────────────────────────────────────

/** The config switches a guidance template may test. */
interface TextFlags {
    memory: boolean;
    dreamer: boolean;
    temporal: boolean;
    caveman: boolean;
    language: boolean;
}

/**
 * Render the definition's text `name`. A template is literal text with four
 * kinds of tag:
 *
 * - `{{name}}` includes the definition's text `name`, rendered the same way;
 * - `{{$name}}` inserts the runtime value `name` verbatim (never rendered);
 * - `{{#flag}}…{{/flag}}` keeps its body only when `flag` is on, and
 *   `{{^flag}}…{{/flag}}` only when it is off. Sections nest, and a closing tag
 *   names the section it closes.
 *
 * Anything else between `{{` and `}}`, an unknown name or flag, or an unclosed
 * section is an error. The Rust module's renderer follows the same rules.
 */
export function renderText(
    name: string,
    flags: TextFlags,
    values: Record<string, string>,
    texts: Record<string, string> = DEFINITION.texts,
): string {
    const template = texts[name];
    if (template === undefined) throw new Error(`no text named ${name}`);
    let out = "";
    // Each open section: its flag, and whether its body is kept.
    const open: { flag: string; keep: boolean }[] = [];
    const keeping = () => open.every((section) => section.keep);
    let at = 0;
    while (at < template.length) {
        const start = template.indexOf("{{", at);
        if (start < 0) {
            if (keeping()) out += template.slice(at);
            break;
        }
        if (keeping()) out += template.slice(at, start);
        const end = template.indexOf("}}", start + 2);
        if (end < 0) throw new Error(`${name}: unterminated tag`);
        const tag = template.slice(start + 2, end);
        at = end + 2;
        const sigil = tag[0];
        const body = tag.slice(1);
        if (sigil === "#" || sigil === "^") {
            if (!(body in flags)) throw new Error(`${name}: unknown flag ${body}`);
            const on = flags[body as keyof TextFlags];
            open.push({ flag: body, keep: sigil === "#" ? on : !on });
        } else if (sigil === "/") {
            const section = open.pop();
            if (section?.flag !== body) throw new Error(`${name}: {{/${body}}} closes nothing open`);
        } else if (sigil === "$") {
            const value = values[body];
            if (value === undefined) throw new Error(`${name}: no value ${body}`);
            if (keeping()) out += value;
        } else if (/^[a-z_/]+$/.test(tag)) {
            if (keeping()) out += renderText(tag, flags, values, texts);
        } else {
            throw new Error(`${name}: malformed tag {{${tag}}}`);
        }
    }
    if (open.length > 0) throw new Error(`${name}: section ${open[0]?.flag} is never closed`);
    return out;
}

/** The guidance inputs a text varies by, as the catalog resolves them. */
interface TextInputs {
    memory: boolean;
    dreamer: boolean;
    temporal: boolean;
    caveman: boolean;
    language: string | null;
    surface: Surface;
}

function renderVariant(
    variant: "primary/reduce" | "primary/no_reduce" | "subagent" | "tools_only" | "head/reduce" | "head/no_reduce" | "worker",
    inputs: TextInputs,
    override?: string,
): string {
    const directive = buildPrimaryLanguageDirective(inputs.language ?? undefined);
    const flags: TextFlags = {
        memory: inputs.memory,
        dreamer: inputs.dreamer,
        temporal: inputs.temporal,
        caveman: inputs.caveman,
        language: directive !== "",
    };
    const values: Record<string, string> = { language_directive: directive };
    if (override !== undefined && variant.startsWith("primary/")) {
        return renderText("override", flags, { ...values, override });
    }
    return renderText(`${variant}/${inputs.surface}`, flags, values);
}

/**
 * Check the definition against the plugin's shipped strings: descriptions and
 * parameter descriptions are equal, and every text the plugin's builder makes
 * is what the definition renders for the same inputs. The tools-only texts
 * have no plugin counterpart.
 */
function checkDefinitionMatchesPlugin(): void {
    const plugin = {
        descriptions: {
            full: {
                ctx_reduce: CTX_REDUCE_DESCRIPTION,
                ctx_expand: CTX_EXPAND_DESCRIPTION,
                ctx_note: CTX_NOTE_DESCRIPTION,
                ctx_memory: CTX_MEMORY_DESCRIPTION,
                ctx_search: CTX_SEARCH_DESCRIPTION,
            },
            light: {
                ctx_reduce: CTX_REDUCE_LIGHT_DESCRIPTION,
                ctx_expand: CTX_EXPAND_LIGHT_DESCRIPTION,
                ctx_note: CTX_NOTE_LIGHT_DESCRIPTION,
                ctx_memory: CTX_MEMORY_LIGHT_DESCRIPTION,
                ctx_search: CTX_SEARCH_LIGHT_DESCRIPTION,
            },
        },
        parameter_descriptions: {
            full: FULL_PARAMETER_DESCRIPTIONS,
            light: LIGHT_PARAMETER_DESCRIPTIONS,
        },
    };
    for (const key of ["descriptions", "parameter_descriptions"] as const) {
        if (jcs(DEFINITION[key] as unknown as Json) !== jcs(plugin[key] as unknown as Json)) {
            throw new Error(`tool_catalog_v1.json ${key} differ from the plugin's`);
        }
    }
    for (const inputs of everyTextInput()) {
        const { memory, dreamer, temporal, caveman, language, surface } = inputs;
        const lang = language ?? undefined;
        for (const reduce of [true, false]) {
            const variant = reduce ? "primary/reduce" : "primary/no_reduce";
            const expected = buildMagicContextSection(
                null, 0, reduce, dreamer, temporal, caveman, false, lang, memory, surface,
            );
            if (renderVariant(variant, inputs) !== expected) {
                throw new Error(`${variant} differs from the plugin for ${JSON.stringify(inputs)}`);
            }
            const overridden = buildMagicContextSection(
                null, 0, reduce, dreamer, temporal, caveman, false, lang, memory, surface, OVERRIDE_SAMPLE,
            );
            if (renderVariant(variant, inputs, OVERRIDE_SAMPLE) !== overridden) {
                throw new Error(`the override text differs from the plugin for ${JSON.stringify(inputs)}`);
            }
        }
        const subagent = buildMagicContextSection(
            null, 0, true, dreamer, temporal, caveman, true, lang, memory, surface,
        );
        if (renderVariant("subagent", inputs) !== subagent) {
            throw new Error(`subagent differs from the plugin for ${JSON.stringify(inputs)}`);
        }
    }
}

/** A stand-in for a user's guidance override, for the parity check and the matrix. */
const OVERRIDE_SAMPLE = "## My guidance\n\nA user's own section, with {{braces}} kept as typed.";

/** Languages the parity check and the matrix cover: none, and one with a directive. */
const SAMPLE_LANGUAGES: (string | null)[] = [null, "fr"];

function* everyTextInput(): Generator<TextInputs> {
    for (const surface of ["full", "light"] as Surface[]) {
        for (const language of SAMPLE_LANGUAGES) {
            for (let bits = 0; bits < 16; bits++) {
                yield {
                    memory: (bits & 1) !== 0,
                    dreamer: (bits & 2) !== 0,
                    temporal: (bits & 4) !== 0,
                    caveman: (bits & 8) !== 0,
                    language,
                    surface,
                };
            }
        }
    }
}

/**
 * The digest of every guidance text for every input combination, for the Rust
 * module's renderer to reproduce. Written to the module's testdata.
 */
function guidanceMatrix(): JsonObject {
    const cases: JsonObject[] = [];
    for (const inputs of everyTextInput()) {
        const entries: [string, string | undefined][] = [
            ["primary/reduce", undefined],
            ["primary/no_reduce", undefined],
            ["subagent", undefined],
            ["tools_only", undefined],
            ["primary/reduce", OVERRIDE_SAMPLE],
            ["head/reduce", undefined],
            ["head/no_reduce", undefined],
            ["worker", undefined],
        ];
        for (const [variant, override] of entries) {
            const text = renderVariant(variant as "primary/reduce", inputs, override);
            cases.push({
                variant,
                override: override !== undefined,
                ...inputs,
                bytes: Buffer.byteLength(text, "utf8"),
                sha256: sha256Hex(text),
            } as unknown as JsonObject);
        }
    }
    return { override_sample: OVERRIDE_SAMPLE, cases } as JsonObject;
}

/** The user and project configuration every example resolves against. */
interface ResolvedConfig {
    compaction_enabled: boolean;
    memory_enabled: boolean;
    dreamer_runnable: boolean;
    temporal_awareness: boolean;
    caveman_text_compression: boolean;
    language: string | null;
    prompt_surface: { default: Surface; models: Record<string, Surface> };
    guidance_override_sha256: string | null;
    tool_descriptions: Record<string, string>;
    disabled_tools: string[];
}

export const EXAMPLE_CONFIG: ResolvedConfig = {
    compaction_enabled: true,
    memory_enabled: true,
    dreamer_runnable: true,
    temporal_awareness: true,
    caveman_text_compression: false,
    language: null,
    prompt_surface: { default: "full", models: { "anthropic/claude-haiku-4-5": "light" } },
    guidance_override_sha256: null,
    tool_descriptions: {},
    disabled_tools: [],
};

// ── Canonical JSON and digests ────────────────────────────────────────────

/**
 * RFC 8785 (JCS) for the values these payloads hold: objects, arrays, strings,
 * booleans, null and safe integers. Key order is UTF-16 code-unit order, which
 * is what Array.prototype.sort gives for strings; strings and integers are
 * written exactly as JSON.stringify writes them, which is what RFC 8785 requires.
 */
export function jcs(value: Json): string {
    if (value === null || typeof value === "boolean" || typeof value === "string") {
        return JSON.stringify(value);
    }
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value)) {
            throw new Error(`generate.ts writes only safe integers, got ${value}`);
        }
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(jcs).join(",")}]`;
    }
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${jcs(value[key] as Json)}`).join(",")}}`;
}

export function sha256Hex(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

const SUBSCHEMA_KEYWORDS = new Set([
    "items",
    "additionalItems",
    "additionalProperties",
    "unevaluatedItems",
    "unevaluatedProperties",
    "not",
    "if",
    "then",
    "else",
    "contains",
    "propertyNames",
]);
const SUBSCHEMA_ARRAY_KEYWORDS = new Set(["prefixItems", "anyOf", "oneOf", "allOf"]);
const SUBSCHEMA_MAP_KEYWORDS = new Set([
    "properties",
    "patternProperties",
    "dependentSchemas",
    "$defs",
    "definitions",
]);

/** The tool-provider/v1 structural schema: `description` removed from every schema object. */
export function structuralSchema(schema: Json): Json {
    if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return schema;
    const out: JsonObject = {};
    for (const [key, value] of Object.entries(schema)) {
        if (key === "description") continue;
        if (SUBSCHEMA_KEYWORDS.has(key)) {
            out[key] = structuralSchema(value);
        } else if (SUBSCHEMA_ARRAY_KEYWORDS.has(key) && Array.isArray(value)) {
            out[key] = value.map(structuralSchema);
        } else if (
            SUBSCHEMA_MAP_KEYWORDS.has(key) &&
            value !== null &&
            typeof value === "object" &&
            !Array.isArray(value)
        ) {
            out[key] = Object.fromEntries(
                Object.entries(value).map(([name, sub]) => [name, structuralSchema(sub)]),
            );
        } else {
            out[key] = value;
        }
    }
    return out;
}

export function schemaDigest(schema: Json): string {
    return sha256Hex(jcs(structuralSchema(schema)));
}

// ── Resolution ───────────────────────────────────────────────────────────

interface CatalogRequest {
    preset?: string;
    params: JsonObject;
    composition?: JsonObject;
    system_text?: { preset: string; params: JsonObject };
    digest_only?: boolean;
}

/**
 * The surface from Magic Context's own config: the request's optional `model`
 * param (the starter fixes it when it builds the session's plan, so a later
 * model switch changes nothing until the next refresh) looked up in
 * `prompt_surface.models` through the plugin's model-key walk, then
 * `prompt_surface.default`.
 */
function resolvedSurface(params: JsonObject, config: ResolvedConfig): Surface {
    const model = typeof params.model === "string" ? params.model : undefined;
    return resolvePromptSurface(config.prompt_surface, model).preset;
}

/** One shared alias table is consumed by both engines and by call admission. */
export function parsePreset(name: string): Preset {
    const preset = Object.hasOwn(DEFINITION.preset_aliases, name) ? DEFINITION.preset_aliases[name] : name;
    if (!(PRESETS as readonly string[]).includes(preset)) {
        throw new Error(`invalid_request {field: "preset"}: Magic Context defines no preset ${JSON.stringify(name)}`);
    }
    return preset as Preset;
}

/** Missing compaction means Magic Context does not compact this session. */
export function compactsSession(composition?: JsonObject): boolean {
    if (!composition || !Object.hasOwn(composition, "compaction")) return false;
    const item = composition.compaction;
    if (item === null || typeof item !== "object" || Array.isArray(item)
        || typeof item.provider !== "string" || item.provider.length === 0) {
        throw new Error('invalid_request {field: "composition.compaction"}');
    }
    return item.provider === MODULE_ID;
}

/** The request's preset, refusing anything Magic Context does not define. */
function requestPreset(request: CatalogRequest): Preset {
    const preset = parsePreset(request.preset ?? "head");
    if (request.system_text && parsePreset(request.system_text.preset) !== preset) {
        throw new Error("the tool item and the text item must name the same preset");
    }
    return preset;
}

function checkParams(params: JsonObject, allowed: Set<string>, field: string): void {
    for (const key of Object.keys(params)) {
        if (!allowed.has(key)) throw new Error(`invalid_request {field: "${field}.${key}"}`);
    }
}

function toolSurface(params: JsonObject, config: ResolvedConfig): Surface {
    if (params.tool_descs === "concise") return "light";
    if (params.tool_descs === "full") return "full";
    return resolvedSurface(params, config);
}

function textSurface(params: JsonObject, config: ResolvedConfig): Surface {
    if (params.surface === "light" || params.surface === "full") return params.surface;
    return resolvedSurface(params, config);
}

function inputSchema(tool: ToolId, surface: Surface): JsonObject {
    const descriptions = DEFINITION.parameter_descriptions[surface][tool];
    const structure = toolDefinition(tool).structure;
    const properties = structure.properties as JsonObject;
    const described: JsonObject = {};
    for (const [name, sub] of Object.entries(properties)) {
        const text = descriptions[name];
        if (text === undefined) throw new Error(`no ${surface} description for ${tool}.${name}`);
        described[name] = { ...(sub as JsonObject), description: text };
    }
    return { ...structure, properties: described };
}

function servedToolIds(request: CatalogRequest, config: ResolvedConfig): ToolId[] {
    const exclude = new Set((request.params.exclude as string[] | undefined) ?? []);
    for (const name of exclude) {
        if (!(TOOL_ORDER as readonly string[]).includes(name)) {
            throw new Error(`invalid_request {field: "params.exclude"}: ${name}`);
        }
    }
    const scope = (request.params.scope as string | undefined) ?? "all";
    const preset = requestPreset(request);
    const table = DEFINITION.preset_tools[compactsSession(request.composition) ? "compacting" : "not_compacting"];
    return TOOL_ORDER.filter((tool) => {
        if (tool === "ctx_reduce" && !config.compaction_enabled) return false;
        if (!table[preset].includes(tool)) return false;
        if (tool === "ctx_memory" && !config.memory_enabled) return false;
        if (config.disabled_tools.includes(tool)) return false;
        if (exclude.has(tool)) return false;
        if (scope === "read" && !toolDefinition(tool).read_scope) return false;
        return true;
    });
}

function catalogTools(request: CatalogRequest, config: ResolvedConfig): JsonObject[] {
    const surface = toolSurface(request.params, config);
    return servedToolIds(request, config).map((tool) => {
        const schema = inputSchema(tool, surface);
        if (tool === "ctx_reduce" && schemaDigest(schema) !== FROZEN_CTX_REDUCE_SCHEMA_DIGEST) {
            throw new Error("ctx_reduce's schema is frozen for v1; change it only with the gateway");
        }
        const definition = toolDefinition(tool);
        const description =
            config.tool_descriptions[tool] ??
            (surface === "light" ? LIGHT_DESCRIPTIONS[tool] : FULL_DESCRIPTIONS[tool]);
        return {
            name: tool,
            schema_digest: schemaDigest(schema),
            semantics: definition.semantics,
            result_ops: definition.result_ops,
            capabilities: definition.capabilities,
            description,
            input_schema: schema,
        };
    });
}

/**
 * Magic Context's own tool names as the request's composition lists them. A
 * preflight request carries no composition, so the served tool names stand in.
 */
function ownToolNames(request: CatalogRequest, served: ToolId[]): Set<string> {
    const providers = request.composition?.providers as JsonObject[] | undefined;
    if (!providers) return new Set(served);
    const own = providers.find((entry) => entry.provider === MODULE_ID);
    const tools = (own?.tools as JsonObject[] | undefined) ?? [];
    return new Set(tools.map((tool) => tool.name as string));
}

/**
 * The text for the request's system_text item. The examples' config has no
 * guidance override; the module renders a user's override through the
 * definition's `override` text, which the parity check and the matrix cover.
 */
function guidanceText(request: CatalogRequest, config: ResolvedConfig): string {
    const item = request.system_text;
    if (!item) throw new Error("guidanceText needs a system_text item");
    const own = ownToolNames(request, servedToolIds(request, config));
    const preset = requestPreset(request);
    const compacting = compactsSession(request.composition);
    if (!compacting && preset !== "head") return "";
    const requiredTools = !compacting
        ? ["ctx_search", "ctx_memory", "ctx_note"]
        : preset === "head" ? ["ctx_expand", "ctx_search", "ctx_note"] : ["ctx_expand", "ctx_search"];
    for (const required of requiredTools) {
        if (!own.has(required)) {
            throw new Error(`no shipped text names the session without ${required} (open question 3)`);
        }
    }
    const reduce = own.has("ctx_reduce");
    const inputs: TextInputs = {
        memory: config.memory_enabled && own.has("ctx_memory"),
        dreamer: config.dreamer_runnable,
        temporal: config.temporal_awareness,
        caveman: config.caveman_text_compression,
        language: config.language,
        surface: textSurface(item.params, config),
    };
    if (!compacting) {
        // Another provider compacts the session, or none does, so Magic Context
        // puts nothing into the conversation: no tags, no history, no project
        // memory block, no markings. The tools-only text describes only the
        // tools. Without tags or archived session history, ctx_reduce and
        // ctx_expand have nothing to act on. The catalog builder rejects
        // compositions listing either because they differ from the served tools.
        return renderVariant("tools_only", inputs);
    }
    if (preset !== "head") {
        // A subagent without ctx_reduce has no tagged messages and no archive use,
        // so it gets no guidance (the OpenCode plugin behaves the same way).
        if (!reduce) return "";
        return renderVariant("worker", inputs);
    }
    return renderVariant(reduce ? "head/reduce" : "head/no_reduce", inputs);
}

/**
 * A hash over every model-facing string this build ships, so a wording change
 * moves the digest: every guidance template and fragment in the definition
 * (the tools-only texts included), every tool description and every parameter
 * description. `checkTextRevisionCoversAssets` fails the run when a shipped
 * guidance asset is not covered by it.
 */
function textRevision(): string {
    return sha256Hex(
        jcs({
            texts: DEFINITION.texts,
            descriptions: DEFINITION.descriptions,
            parameters: DEFINITION.parameter_descriptions,
        } as unknown as JsonObject),
    );
}

/**
 * The Rust module's guidance.get assets, and the definition text each is
 * rendered from at the example config. They are still served by guidance.get,
 * so they must stay renderings of texts `text_revision` covers.
 */
const LEGACY_GUIDANCE_ASSETS: Record<string, string> = {
    "guidance_primary.txt": "primary/reduce/full",
    "guidance_light_primary.txt": "primary/reduce/light",
    "guidance_no_reduce.txt": "primary/no_reduce/full",
    "guidance_light_no_reduce.txt": "primary/no_reduce/light",
};

/** The definition's own files, every byte of which `text_revision` covers. */
const DEFINITION_ASSETS = ["tool_catalog_v1.json", "catalog_tools_only.txt", "catalog_tools_only_light.txt"];

/**
 * Fail when the module ships a guidance asset `text_revision` does not cover:
 * every file in the assets directory is part of the definition, or a
 * guidance.get asset equal to a definition text rendered at the example config.
 */
function checkTextRevisionCoversAssets(): void {
    for (const file of readdirSync(ASSETS)) {
        if (DEFINITION_ASSETS.includes(file)) continue;
        const text = LEGACY_GUIDANCE_ASSETS[file];
        if (text === undefined) {
            throw new Error(`assets/${file} is not covered by text_revision; add it to the definition`);
        }
        const flags: TextFlags = {
            memory: EXAMPLE_CONFIG.memory_enabled,
            dreamer: EXAMPLE_CONFIG.dreamer_runnable,
            temporal: EXAMPLE_CONFIG.temporal_awareness,
            caveman: EXAMPLE_CONFIG.caveman_text_compression,
            language: false,
        };
        const rendered = renderText(text, flags, { language_directive: "" });
        if (readFileSync(join(ASSETS, file), "utf8") !== rendered) {
            throw new Error(`assets/${file} is not the rendering of the definition's ${text}`);
        }
    }
    for (const file of DEFINITION_ASSETS) {
        if (!existsSync(join(ASSETS, file))) throw new Error(`assets/${file} is missing`);
    }
}

function preflightDigest(
    item: { preset: string; params: JsonObject },
    config: ResolvedConfig,
): string {
    return sha256Hex(
        jcs({
            format: "magic-context/preflight/1",
            preset: item.preset,
            params: item.params,
            config: config as unknown as JsonObject,
            text_revision: textRevision(),
        }),
    );
}

/**
 * Refuse an example whose composition lists different Magic Context tools than
 * the request serves: the runner refuses such a fetch, and the text is chosen
 * from the composition, so the example would describe tools it doesn't have.
 */
function checkCompositionMatches(request: CatalogRequest, served: ToolId[]): void {
    if (!request.composition) return;
    const listed = [...ownToolNames(request, served)].sort();
    const expected = [...served].sort();
    if (jcs(listed) !== jcs(expected)) {
        throw new Error(`composition lists ${listed.join(",")} but the request serves ${expected.join(",")}`);
    }
}

/** Every capability tag in a value, wherever a `capabilities` array holds it. */
function capabilityTags(value: Json, found: string[] = []): string[] {
    if (Array.isArray(value)) {
        for (const item of value) capabilityTags(item, found);
    } else if (value !== null && typeof value === "object") {
        for (const [key, item] of Object.entries(value)) {
            if (key === "capabilities" && Array.isArray(item)) {
                for (const tag of item) if (typeof tag === "string") found.push(tag);
            } else {
                capabilityTags(item, found);
            }
        }
    }
    return found;
}

export function answer(request: CatalogRequest, config: ResolvedConfig): JsonObject {
    checkParams(request.params, TOOL_PARAMS, "params");
    if (request.system_text) checkParams(request.system_text.params, TEXT_PARAMS, "system_text.params");
    checkCompositionMatches(request, servedToolIds(request, config));
    const content: JsonObject = {};
    const compositionDigest = request.composition ? sha256Hex(jcs(request.composition)) : undefined;
    if (compositionDigest) content.composition_digest = compositionDigest;
    content.tools = catalogTools(request, config);
    if (request.system_text) {
        const text = guidanceText(request, config);
        const toolNames = [...ownToolNames(request, servedToolIds(request, config))].sort();
        const servedNames = [...new Set((content.tools as JsonObject[]).map((tool) => tool.name as string))].sort();
        if (jcs(toolNames) !== jcs(servedNames)) {
            throw new Error("system_text.tool_names must equal the sorted, deduplicated served tool names");
        }
        const systemText: JsonObject = {
            text,
            item_digest: sha256Hex(text),
            preflight_digest: preflightDigest(request.system_text, config),
        };
        systemText.tool_names = toolNames;
        if (compositionDigest) systemText.composition_digest = compositionDigest;
        content.system_text = systemText;
    }
    const catalogDigest = sha256Hex(jcs(content));
    if (request.digest_only) return { generation: catalogDigest, catalog_digest: catalogDigest };
    return { generation: catalogDigest, catalog_digest: catalogDigest, ...content };
}

// ── Example compositions ─────────────────────────────────────────────────

function mcEntry(tools: ToolId[]): JsonObject {
    return {
        provider: MODULE_ID,
        tools: [...tools].sort().map((name) => ({ name, capabilities: toolDefinition(name).capabilities })),
    };
}

/**
 * Part of the AFT file-tools module's catalog for a head session run by Broca,
 * with the capability tags AFT's own catalog fixture declares for those tools.
 */
const AFT_HEAD: JsonObject = {
    provider: "aft",
    tools: [
        { name: "bash", capabilities: ["shell.exec/v1"] },
        { name: "bash_status", capabilities: ["shell.exec/v1"] },
        { name: "edit", capabilities: ["code.edit/v1"] },
        { name: "outline", capabilities: ["code.outline/v1"] },
        { name: "read", capabilities: ["code.read/v1"] },
        { name: "search", capabilities: ["code.search/v1"] },
        { name: "zoom", capabilities: ["code.outline/v1"] },
    ],
};

/**
 * Prefrontal's forwarding tools, tagged in the role's two tiers: the generic
 * unprefixed tag (`browser.use/v1`, `computer.use/v1`), which promises only
 * that a browser or desktop is driven, beside the namespaced tag of the
 * provider whose specific contract the tool follows. Tags are listed in
 * bytewise order, as the compositions' canonical form requires.
 */
const PREFRONTAL_HEAD: JsonObject = {
    provider: "prefrontal-core",
    tools: [
        { name: "browser_use", capabilities: ["browser.use/v1", "cerebellum:browser.use/v1"] },
        { name: "computer_use", capabilities: ["cerebellum:computer.use/v1", "computer.use/v1"] },
    ],
};

const ALL_TOOLS: ToolId[] = [...TOOL_ORDER];
const WITHOUT_REDUCE: ToolId[] = TOOL_ORDER.filter((tool) => tool !== "ctx_reduce");
const TOOLS_ONLY = DEFINITION.preset_tools.not_compacting.head;
const HELPER_TOOLS = DEFINITION.preset_tools.compacting.worker;
const MC_COMPACTION: JsonObject = { provider: MODULE_ID };

interface Example {
    name: string;
    request: CatalogRequest;
    /** The Rust module's shipped guidance asset this example's text must equal, if any. */
    rustAsset?: string;
}

const EXAMPLES: Example[] = [
    {
        name: "preflight",
        request: { preset: "head", params: {} },
    },
    {
        name: "head-full",
        request: {
            preset: "head",
            params: {},
            composition: { providers: [AFT_HEAD, mcEntry(ALL_TOOLS), PREFRONTAL_HEAD], compaction: MC_COMPACTION },
            system_text: { preset: "head", params: {} },
        },
        rustAsset: "guidance_primary.txt",
    },
    {
        name: "head-full.digest-only",
        request: {
            preset: "head",
            params: {},
            composition: { providers: [AFT_HEAD, mcEntry(ALL_TOOLS), PREFRONTAL_HEAD], compaction: MC_COMPACTION },
            system_text: { preset: "head", params: {} },
            digest_only: true,
        },
    },
    {
        name: "head-light",
        request: {
            preset: "head",
            params: { tool_descs: "concise" },
            composition: { providers: [AFT_HEAD, mcEntry(ALL_TOOLS), PREFRONTAL_HEAD], compaction: MC_COMPACTION },
            system_text: { preset: "head", params: { surface: "light" } },
        },
        rustAsset: "guidance_light_primary.txt",
    },
    {
        name: "worker",
        request: {
            preset: "worker",
            params: {},
            composition: { providers: [AFT_HEAD, mcEntry(HELPER_TOOLS)], compaction: MC_COMPACTION },
            system_text: { preset: "worker", params: {} },
        },
    },
    {
        name: "no-reduce",
        request: {
            preset: "head",
            params: { exclude: ["ctx_reduce"] },
            composition: { providers: [AFT_HEAD, mcEntry(WITHOUT_REDUCE), PREFRONTAL_HEAD], compaction: MC_COMPACTION },
            system_text: { preset: "head", params: {} },
        },
        rustAsset: "guidance_no_reduce.txt",
    },
    {
        name: "head-no-compaction",
        request: {
            preset: "head",
            params: {},
            composition: { providers: [AFT_HEAD, mcEntry(TOOLS_ONLY), PREFRONTAL_HEAD] },
            system_text: { preset: "head", params: {} },
        },
    },
    {
        // The surface comes from the frozen `model` param, looked up in the
        // example config's `prompt_surface.models`, not from explicit params.
        name: "head-no-compaction-light",
        request: {
            preset: "head",
            params: { model: "anthropic/claude-haiku-4-5" },
            composition: { providers: [AFT_HEAD, mcEntry(TOOLS_ONLY), PREFRONTAL_HEAD] },
            system_text: { preset: "head", params: { model: "anthropic/claude-haiku-4-5" } },
        },
    },
    ...["worker", "reader"].map((preset): Example => ({
        name: `${preset}-no-compaction`,
        request: { preset, params: {}, composition: { providers: [AFT_HEAD] }, system_text: { preset, params: {} } },
    })),
    {
        name: "reader",
        request: { preset: "reader", params: {}, composition: { providers: [AFT_HEAD, mcEntry(HELPER_TOOLS)], compaction: MC_COMPACTION }, system_text: { preset: "reader", params: {} } },
    },
];

// ── Output ───────────────────────────────────────────────────────────────────────

/** The guidance matrix's path, relative to this directory. */
const MATRIX_PATH = "../../../crates/mc-module/testdata/tool-catalog-guidance-matrix.json";

function outputs(): Map<string, string> {
    checkDefinitionMatchesPlugin();
    checkTextRevisionCoversAssets();
    const files = new Map<string, string>();
    for (const { name, request, rustAsset } of EXAMPLES) {
        const reply = answer(request, EXAMPLE_CONFIG);
        for (const tag of capabilityTags([request as unknown as Json, reply])) {
            const problem = capabilityTagProblem(tag);
            if (problem) throw new Error(`${name}: capability tag ${tag}: ${problem}`);
        }
        if (rustAsset) {
            const asset = readFileSync(join(ASSETS, rustAsset), "utf8");
            const text = (reply.system_text as JsonObject | undefined)?.text;
            if (text !== asset) throw new Error(`${name}: text differs from ${rustAsset}`);
        }
        files.set(`${name}.request.json`, `${JSON.stringify(request, null, 2)}\n`);
        files.set(`${name}.answer.json`, `${JSON.stringify(reply, null, 2)}\n`);
        files.set(`${name}.answer.jcs`, jcs(reply));
        const systemText = reply.system_text as JsonObject | undefined;
        if (systemText) files.set(`text/${name}.txt`, systemText.text as string);
    }
    files.set(
        "config.json",
        `${JSON.stringify({ config: EXAMPLE_CONFIG, text_revision: textRevision() }, null, 2)}\n`,
    );
    files.set(MATRIX_PATH, `${JSON.stringify(guidanceMatrix(), null, 2)}\n`);
    return files;
}

// ── Cross-checks against the tool-provider and fetch-plan test vectors ────

/** commons at cortexkit-role-tool-provider 0.4.3, which defines the ten unprefixed tags. */
const COMMONS_REF = "42949fc331d8c318225d8ffa0faa024584237c57";
/**
 * prefrontal at a commit whose fetch-plan vectors (compositions and plans, each
 * as pretty JSON, JCS bytes and SHA-256) the design document cites.
 */
const PREFRONTAL_REF = process.env.MC_CATALOG_PREFRONTAL_REF ?? "c40b81e46e205a30e27a2d0a56d4f91cb5bf0803";

function git(repo: string, args: string[]): string | undefined {
    const run = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 << 20 });
    return run.status === 0 ? run.stdout : undefined;
}

/**
 * A sibling repository: the environment variable when set, otherwise the
 * directory next to this repository's main checkout. A worktree's
 * `--git-common-dir` is the main checkout's `.git`, so this also works from one.
 */
function siblingRepo(envName: string, dirName: string): string | undefined {
    const fromEnv = process.env[envName];
    if (fromEnv) return fromEnv;
    const common = git(REPO_ROOT, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (!common) return undefined;
    const candidate = join(dirname(dirname(common.trim())), dirName);
    return existsSync(candidate) ? candidate : undefined;
}

/** True when every number in the value is a safe integer, the only kind this file's JCS writes. */
function integersOnly(value: Json): boolean {
    if (typeof value === "number") return Number.isSafeInteger(value) && !Object.is(value, -0);
    if (Array.isArray(value)) return value.every(integersOnly);
    if (value !== null && typeof value === "object") return Object.values(value).every(integersOnly);
    return true;
}

interface CrossCheck {
    failures: string[];
    report: string[];
}

/** Validate real plan items, not a guessed role derived from a filename.
 * Empty helper catalogs are valid, but a non-compacting helper plan must omit
 * Magic Context entirely rather than fetching an unnecessary empty item.
 */
export function checkPlanMagicContext(plan: JsonObject): void {
    const compacting = compactsSession(plan.composition as JsonObject | undefined);
    for (const key of ["tool_items", "system_text_items", "step_transform_items"]) {
        const items = plan[key];
        if (!Array.isArray(items)) continue;
        for (const item of items) {
            if (item === null || typeof item !== "object" || Array.isArray(item) || item.provider !== MODULE_ID) continue;
            const preset = parsePreset(typeof item.preset === "string" ? item.preset : "head");
            if (!compacting && preset !== "head") {
                throw new Error(`Magic Context ${key} preset ${JSON.stringify(item.preset)} without Magic Context compaction: omit the item`);
            }
        }
    }
}

function crossCheckCommons(repo: string, out: CrossCheck): void {
    const show = (path: string) => git(repo, ["show", `${COMMONS_REF}:${path}`]);
    const compositions = show("test-vectors/tool-provider-v1/composition-digest.json");
    const schemas = show("test-vectors/tool-provider-v1/schema-digest.json");
    const lib = show("crates/cortexkit-role-tool-provider/src/lib.rs");
    if (!compositions || !schemas || !lib) {
        out.report.push(`commons: skipped, ${COMMONS_REF.slice(0, 8)} not readable in ${repo}`);
        return;
    }
    let checked = 0;
    let skipped = 0;
    for (const vector of JSON.parse(compositions).digests as JsonObject[]) {
        if (!integersOnly(vector.composition as Json)) {
            skipped++;
            continue;
        }
        checked++;
        const bytes = jcs(vector.composition as Json);
        if (bytes !== vector.jcs || sha256Hex(bytes) !== vector.composition_digest) {
            out.failures.push(`commons composition-digest: ${vector.name}`);
        }
    }
    const schemaFile = JSON.parse(schemas) as Record<string, JsonObject[]>;
    for (const vector of schemaFile.digests ?? []) {
        if (!integersOnly(vector.schema as Json)) {
            skipped++;
            continue;
        }
        checked++;
        if (schemaDigest(vector.schema as Json) !== vector.schema_digest) {
            out.failures.push(`commons schema-digest: ${vector.name}`);
        }
    }
    for (const [kind, same] of [
        ["same_digest", true],
        ["different_digest", false],
    ] as const) {
        for (const pair of schemaFile[kind] ?? []) {
            if (!integersOnly(pair.a as Json) || !integersOnly(pair.b as Json)) {
                skipped++;
                continue;
            }
            checked++;
            const equal = schemaDigest(pair.a as Json) === schemaDigest(pair.b as Json);
            if (equal !== same) out.failures.push(`commons schema-digest ${kind}: ${pair.name}`);
        }
    }
    const block = /DEFINED_CAPABILITY_TAGS: &\[&str\] = &\[([\s\S]*?)\];/.exec(lib)?.[1] ?? "";
    const crateTags = [...block.replaceAll(/\/\/.*$/gm, "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    if (jcs(crateTags) !== jcs(DEFINED_CAPABILITY_TAGS)) {
        out.failures.push(`commons DEFINED_CAPABILITY_TAGS is ${crateTags.join(", ")}`);
    }
    out.report.push(
        `commons ${COMMONS_REF.slice(0, 8)}: ${checked} digest vectors match (${skipped} with floats skipped); defined tags match`,
    );
}

function checkPrefrontalMagicContextTags(value: Json, vectorFile: string, out: CrossCheck): void {
    const object = value as JsonObject;
    const composition = (object.composition ?? value) as JsonObject;
    const providers = composition?.providers;
    if (!Array.isArray(providers)) return;
    for (const provider of providers) {
        if (provider === null || typeof provider !== "object" || Array.isArray(provider) || provider.provider !== MODULE_ID || !Array.isArray(provider.tools)) continue;
        for (const entry of provider.tools) {
            if (entry === null || typeof entry !== "object" || Array.isArray(entry) || typeof entry.name !== "string" || !Array.isArray(entry.capabilities)) continue;
            const definition = TOOL_DEFINITIONS.get(entry.name);
            const expected = definition?.capabilities ?? [];
            const actual = entry.capabilities;
            if (jcs(expected) !== jcs(actual)) {
                out.failures.push(`prefrontal ${vectorFile} tool ${entry.name}: expected tags ${JSON.stringify(expected)}, actual tags ${JSON.stringify(actual)}`);
            }
        }
    }
}

function crossCheckPrefrontal(repo: string, out: CrossCheck): void {
    const dir = "test-vectors/fetch-plan-v1";
    const listing = git(repo, ["show", `${PREFRONTAL_REF}:${dir}`]);
    if (!listing) {
        out.report.push(`prefrontal: skipped, ${PREFRONTAL_REF.slice(0, 8)} not readable in ${repo}`);
        return;
    }
    let checked = 0;
    let skipped = 0;
    // Read both tree entries and vector bytes via git show; the sibling's
    // working tree is neither a source nor a destination for this check.
    function vectorPaths(tree: string, path: string): string[] {
        return tree.split("\n").flatMap((entry) => {
            if (entry.endsWith(".jcs")) return [`${path}/${entry}`];
            if (!entry.endsWith("/")) return [];
            const child = `${path}/${entry.slice(0, -1)}`;
            const contents = git(repo, ["show", `${PREFRONTAL_REF}:${child}`]);
            if (contents === undefined) { out.failures.push(`prefrontal: unreadable tree ${child}`); return []; }
            return vectorPaths(contents, child);
        });
    }
    for (const path of vectorPaths(listing, dir)) {
        const stem = path.slice(0, -".jcs".length);
        const show = (suffix: string) => git(repo, ["show", `${PREFRONTAL_REF}:${stem}${suffix}`]);
        const pretty = show(".json");
        const bytes = show(".jcs");
        const digest = show(".sha256");
        if (pretty === undefined || bytes === undefined || digest === undefined) {
            out.failures.push(`prefrontal: incomplete vector ${stem}`);
            continue;
        }
        const value = JSON.parse(pretty) as Json;
        if (!integersOnly(value)) {
            skipped++;
            continue;
        }
        checked++;
        const name = stem.slice(dir.length + 1);
        const previousFailures = out.failures.length;
        checkPrefrontalMagicContextTags(value, name, out);
        if (name.startsWith("plans/")) {
            try { checkPlanMagicContext(value as JsonObject); }
            catch (error) { out.failures.push(`prefrontal ${name}: ${error instanceof Error ? error.message : error}`); }
        }
        if (jcs(value) !== bytes || sha256Hex(bytes) !== digest.trim()) {
            out.failures.push(`prefrontal ${stem.slice(dir.length + 1)}`);
        }
        if (stem === `${dir}/plans/broca-head-no-compaction`) {
            const plan = value as JsonObject;
            const computed = sha256Hex(jcs(plan.composition));
            if (computed !== plan.composition_digest) {
                out.failures.push(`prefrontal plans/broca-head-no-compaction composition_digest: computed ${computed}, declared ${plan.composition_digest}`);
            }
            out.report.push(`prefrontal plans/broca-head-no-compaction composition_digest: ${computed}`);
        }
        out.report.push(`prefrontal ${name}: ${out.failures.length === previousFailures ? "PASS" : "FAIL"}`);
    }
    if (checked === 0) out.failures.push("prefrontal: no fetch-plan vectors found");
    out.report.push(
        `prefrontal ${PREFRONTAL_REF.slice(0, 8)}: ${checked} fetch-plan vectors checked (${skipped} with floats skipped)`,
    );
}

function crossCheck(): CrossCheck {
    const out: CrossCheck = { failures: [], report: [] };
    const commons = siblingRepo("MC_CATALOG_COMMONS_REPO", "commons");
    if (commons) crossCheckCommons(commons, out);
    else out.report.push("commons: skipped, repository not found");
    const prefrontal = siblingRepo("MC_CATALOG_PREFRONTAL_REPO", "prefrontal");
    if (prefrontal) crossCheckPrefrontal(prefrontal, out);
    else out.report.push("prefrontal: skipped, repository not found");
    return out;
}

function main(): void {
    const here = dirname(new URL(import.meta.url).pathname);
    const check = process.argv.includes("--check");
    const crossChecks = process.argv.includes("--examples-only") ? { failures: [], report: ["external vectors skipped (--examples-only)"] } : crossCheck();
    for (const line of crossChecks.report) console.log(`cross-check ${line}`);
    if (crossChecks.failures.length > 0) {
        console.error(`cross-check failed: ${crossChecks.failures.join("; ")}`);
        process.exit(1);
    }
    const differing: string[] = [];
    const generated = outputs();
    for (const [relative, content] of generated) {
        const path = join(here, relative);
        if (check) {
            let current: string | undefined;
            try {
                current = readFileSync(path, "utf8");
            } catch {
                current = undefined;
            }
            if (current !== content) differing.push(relative);
        } else {
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, content);
        }
    }
    if (check && differing.length > 0) {
        console.error(`out of date: ${differing.join(", ")}`);
        process.exit(1);
    }
    console.log(`${check ? "all example files are current" : "wrote example files"}: ${EXAMPLES.length} examples, ${generated.size} files, ${(guidanceMatrix().cases as Json[]).length} guidance cases`);
}

if (import.meta.main) main();
