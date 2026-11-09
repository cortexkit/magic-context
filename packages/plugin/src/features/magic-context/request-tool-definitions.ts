import { createHash } from "node:crypto";

type Definitions = Record<string, { description: string; input: unknown }>;
interface DefinitionIdentity {
    scope?: string;
    hash: string;
    tools: Array<[string, string]>;
}

const IDENTITY_SCOPE = "names-descriptions-v1";
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * The cache policy observes only the context hook's set of tool names and
 * descriptions. Schemas and tool ordering do not grant a rebuild opportunity:
 * the host may normalize schemas, and registration order is not a tool change.
 * OpenCode's per-request acceptance set is private; tool.list() exposes the
 * unfiltered registry, not that snapshot. Plugin-injected entries later dropped
 * by the host can therefore still change this identity. That limit, like changes
 * made by later context hooks, is an accepted observation-window boundary.
 * Store per-tool digests beside the aggregate hash (never whole definitions), so
 * even after a restart the fold log can identify the first differing tool.
 */
export function v2ToolDefinitionsHash(tools: Definitions): string {
    const pairs = Object.entries(tools)
        .map(([name, tool]) => [name, tool.description] as const)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return JSON.stringify({
        scope: IDENTITY_SCOPE,
        hash: sha(pairs),
        tools: pairs.map(([name, description]) => [name, sha([name, description])]),
    } satisfies DefinitionIdentity);
}

/** A legacy raw-schema identity must be adopted, not paid for as a tool change. */
export function needsRequestToolIdentityAdoption(previous: string, current: string): boolean {
    return (
        readIdentity(current).scope === IDENTITY_SCOPE &&
        readIdentity(previous).scope !== IDENTITY_SCOPE
    );
}

function readIdentity(value: string): DefinitionIdentity {
    try {
        const parsed = JSON.parse(value) as DefinitionIdentity;
        if (
            typeof parsed.hash === "string" &&
            Array.isArray(parsed.tools) &&
            parsed.tools.every(
                (item) =>
                    Array.isArray(item) &&
                    item.length === 2 &&
                    item.every((part) => typeof part === "string"),
            )
        )
            return parsed;
    } catch {
        /* Older or unrecognized markers still have a printable identity. */
    }
    return { hash: value, tools: [] };
}

export function describeRequestToolDefinitionChange(
    previous: string,
    current: string,
): {
    previousHash: string;
    currentHash: string;
    firstDifferingTool: string;
} {
    const before = readIdentity(previous);
    const after = readIdentity(current);
    let firstDifferingTool = "unknown";
    for (let index = 0; index < Math.max(before.tools.length, after.tools.length); index++) {
        const left = before.tools[index];
        const right = after.tools[index];
        if (left?.[0] === right?.[0] && left?.[1] === right?.[1]) continue;
        firstDifferingTool =
            left?.[0] === right?.[0]
                ? (left?.[0] ?? "unknown")
                : `${left?.[0] ?? "(absent)"}→${right?.[0] ?? "(absent)"}`;
        break;
    }
    return { previousHash: before.hash, currentHash: after.hash, firstDifferingTool };
}

/** One tool as the request sends it, for the signed-thinking release fingerprint. */
export interface RequestTool {
    name: string;
    description: string;
    /** `requestToolSchemaDigest` of the input schema the request sends. */
    schemaDigest: string;
    /**
     * The tool is declared with `defer_loading: true`. Anthropic does not count
     * such a tool in the prefix that binds signed thinking until something in
     * the conversation references it.
     */
    deferLoading?: boolean;
}

/**
 * Hashes of the tool list a request sends, each over the tools sorted by name:
 * their names; their names and descriptions; and their names, descriptions and
 * input schemas. Unlike the fold identity above, this one counts schemas: a
 * prefix-bound model binds every signed thinking block to the whole `tools`
 * array, so any edit there invalidates the kept blocks. The three levels only
 * name what changed in the logs.
 */
export interface RequestToolsFingerprint {
    names: string;
    descriptions: string;
    schemas: string;
}

/** The outermost level at which two fingerprints differ. */
export type RequestToolsChange = "names" | "descriptions" | "schemas";

/**
 * OpenCode 2: fingerprint a request draft's tool map. A tool declared with
 * `defer_loading: true` counts once a message part names it (a call to it).
 */
export function v2RequestToolsFingerprint(
    tools: Definitions,
    messages: ReadonlyArray<{ content: ReadonlyArray<Record<string, unknown>> }> = [],
): RequestToolsFingerprint {
    const entries: RequestTool[] = [];
    for (const [name, tool] of Object.entries(tools)) {
        if (!tool) continue;
        const declared = tool as Record<string, unknown>;
        entries.push({
            name,
            description: typeof tool.description === "string" ? tool.description : "",
            schemaDigest: requestToolSchemaDigest(tool.input),
            deferLoading: declared.defer_loading === true || declared.deferLoading === true,
        });
    }
    return requestToolsFingerprint(entries, () => {
        const referenced = new Set<string>();
        for (const message of messages)
            for (const part of message.content) {
                if (typeof part.type !== "string" || !part.type.includes("tool")) continue;
                if (typeof part.name === "string") referenced.add(part.name);
                if (typeof part.tool === "string") referenced.add(part.tool);
            }
        return referenced;
    });
}

/**
 * Fingerprint a request's tools. Order does not count: Anthropic describes the
 * checked prefix as "the set of tools", and the fold identity sorts the same
 * way. A tool with `defer_loading: true` is skipped unless `referencedNames`
 * (read only when such a tool exists) holds its name. `tool_choice` is a
 * request parameter, not a tool, and never reaches this function.
 */
export function requestToolsFingerprint(
    tools: Iterable<RequestTool>,
    referencedNames?: () => ReadonlySet<string>,
): RequestToolsFingerprint {
    let referenced: ReadonlySet<string> | undefined;
    const included: RequestTool[] = [];
    for (const tool of tools) {
        if (tool.deferLoading === true) {
            referenced ??= referencedNames?.() ?? new Set<string>();
            if (!referenced.has(tool.name)) continue;
        }
        included.push(tool);
    }
    included.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    return {
        names: sha(included.map((tool) => tool.name)),
        descriptions: sha(included.map((tool) => [tool.name, tool.description])),
        schemas: sha(included.map((tool) => [tool.name, tool.description, tool.schemaDigest])),
    };
}

/** What changed between two fingerprints of the same session and model, or null. */
export function classifyRequestToolsChange(
    previous: RequestToolsFingerprint,
    current: RequestToolsFingerprint,
): RequestToolsChange | null {
    if (previous.names !== current.names) return "names";
    if (previous.descriptions !== current.descriptions) return "descriptions";
    if (previous.schemas !== current.schemas) return "schemas";
    return null;
}

/**
 * Digest of a tool's input schema as JSON with object keys sorted, so key
 * order does not count and every value does. Values JSON cannot carry are
 * written as JSON.stringify writes them: dropped from objects, `null` in
 * arrays. A value that contains itself is written as "[Circular]"; a value
 * shared by two branches is written in full in both.
 */
export function requestToolSchemaDigest(schema: unknown): string {
    const pieces: string[] = [];
    writeCanonicalJson(schema, [], pieces);
    return createHash("sha256").update(pieces.join("")).digest("hex");
}

function isJsonValue(value: unknown): boolean {
    return value !== undefined && typeof value !== "function" && typeof value !== "symbol";
}

function writeCanonicalJson(value: unknown, ancestors: object[], out: string[]): void {
    if (value === null || typeof value === "boolean" || typeof value === "string") {
        out.push(JSON.stringify(value));
        return;
    }
    if (typeof value === "number") {
        out.push(Number.isFinite(value) ? JSON.stringify(value) : "null");
        return;
    }
    if (typeof value === "bigint") {
        out.push(JSON.stringify(value.toString()));
        return;
    }
    if (typeof value !== "object") {
        out.push("null");
        return;
    }
    if (ancestors.includes(value)) {
        out.push('"[Circular]"');
        return;
    }
    ancestors.push(value);
    if (Array.isArray(value)) {
        out.push("[");
        for (let index = 0; index < value.length; index += 1) {
            if (index > 0) out.push(",");
            if (isJsonValue(value[index])) writeCanonicalJson(value[index], ancestors, out);
            else out.push("null");
        }
        out.push("]");
    } else {
        const entries = Object.entries(value)
            .filter(([, child]) => isJsonValue(child))
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
        out.push("{");
        entries.forEach(([key, child], index) => {
            if (index > 0) out.push(",");
            out.push(JSON.stringify(key), ":");
            writeCanonicalJson(child, ancestors, out);
        });
        out.push("}");
    }
    ancestors.pop();
}
