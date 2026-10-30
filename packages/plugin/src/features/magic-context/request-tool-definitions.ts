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
 * Changes made by later context hooks are outside this observation window; that
 * limit is intentionally accepted rather than guessing their final output.
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
