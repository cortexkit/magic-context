import { createHash } from "node:crypto";

type Definitions = Record<string, { description: string; input: unknown }>;
interface DefinitionIdentity {
    hash: string;
    tools: Array<[string, string]>;
}

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * Hash the request's definitions, not registrations or token measurements.
 * The running host exposes no callable provider-schema projector to plugins.
 * This is deliberately conservative: a schema change erased by the host's later
 * normalization can buy one unnecessary fold. Copying a pinned normalizer would
 * drift from the running host. Keep request order and raw schema serialization
 * so genuine tool changes cannot be hidden by canonicalization. Explicit field
 * projection ignores only draft-object field order, which the host also ignores.
 * Store per-tool digests beside the aggregate hash (never whole definitions), so
 * even after a restart the fold log can identify the first differing tool.
 */
export function v2ToolDefinitionsHash(tools: Definitions): string {
    const definitions = Object.entries(tools).map(([name, tool]) => ({
        name,
        description: tool.description,
        input_schema: tool.input,
    }));
    return JSON.stringify({
        hash: sha(definitions),
        tools: definitions.map((definition) => [definition.name, sha(definition)]),
    } satisfies DefinitionIdentity);
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
