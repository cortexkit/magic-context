import type { MessageData } from "../store-reader";

const changed = "The Code Mode tool catalog has changed.";
const replacement = `${changed} This catalog supersedes the previous Code Mode tool catalog.`;

// Mirrors render()/update() in OpenCode packages/core/src/codemode/instructions.ts
// at v2.0.22, v2.1.4 and v2.2.5. This labels the catalog part only; whole-row
// retirement must use supersededInstructionIDs to account for every source in
// metadata.instructionSources, including sources other than Code Mode.
export function codeModeCatalogKind(
    data: MessageData,
): "initial" | "replacement" | "incremental" | "combined-replacement" | undefined {
    const text = data.text ?? "";
    const metadata = data.metadata;
    const keyed =
        typeof metadata === "object" && metadata !== null && "instructionSources" in metadata;
    if (keyed) {
        const sources = metadata.instructionSources;
        if (!Array.isArray(sources) || !sources.includes("core/codemode")) return undefined;
        if (sources.length !== 1)
            return text.startsWith(replacement) ? "combined-replacement" : undefined;
    }
    if (text.startsWith(replacement)) return "replacement";
    if (text.startsWith(changed)) return "incremental";
    if (
        keyed ||
        text.startsWith("# Code Mode\n") ||
        text.startsWith("No Code Mode tools are currently available.")
    )
        return "initial";
    return undefined;
}

const codeMode = "core/codemode";
const mcp = "core/mcp-guidance";
const mcpReplacement =
    "The available MCP server instructions have changed. This list supersedes the previous one.";
const mcpDeltas = [
    "New MCP server instructions are available in addition to those previously listed:",
    "The following MCP server instructions have changed. Each entry replaces the previously listed server with the same name:",
    "Instructions for the following MCP servers are no longer available:",
];

function sourceState(text: string, source: string): "full" | "delta" | undefined {
    // Instructions.renderUpdate joins source renderings with two newlines. Do
    // not mistake an MCP delta's server entries for a full instruction list.
    const starts = (prefix: string) => text.startsWith(prefix) || text.includes(`\n\n${prefix}`);
    if (source === codeMode) {
        if (text.startsWith(`${replacement}\n\n`)) {
            const rendered = text.slice(replacement.length + 2);
            if (
                rendered.startsWith("# Code Mode\n") ||
                rendered.startsWith("No Code Mode tools are currently available.")
            )
                return "full";
            return undefined;
        }
        if (text.startsWith(changed)) return "delta";
        if (
            text.startsWith("# Code Mode\n") ||
            text.startsWith("No Code Mode tools are currently available.")
        )
            return "full";
    }
    if (source === mcp) {
        if (mcpDeltas.some(starts)) return "delta";
        if (
            (starts(`${mcpReplacement}\n<mcp_instructions>\n`) || starts("<mcp_instructions>\n")) &&
            text.includes("</mcp_instructions>")
        )
            return "full";
    }
    return undefined;
}

/**
 * Rows are atomic on the wire, but supersession belongs to each instruction
 * source. A combined row can disappear only after every source it carries has
 * been fully restated. Deltas never cover their predecessors; unknown sources
 * and unrecognized renderings never authorize removal.
 */
export function supersededInstructionIDs(
    rows: readonly { id: string; data: MessageData }[],
): Set<string> {
    const covered = new Set<string>();
    const retired = new Set<string>();
    for (let index = rows.length - 1; index >= 0; index--) {
        const row = rows[index];
        const metadata = row.data.metadata;
        const keyed =
            typeof metadata === "object" && metadata !== null && "instructionSources" in metadata;
        const keys = keyed ? metadata.instructionSources : undefined;
        const text = row.data.text ?? "";
        const sources = keyed
            ? Array.isArray(keys) && keys.length > 0 && keys.every((key) => typeof key === "string")
                ? (keys as string[])
                : []
            : [codeMode, mcp].filter((source) => sourceState(text, source) !== undefined);
        const states = sources.map((source) => sourceState(text, source));
        if (
            sources.length > 0 &&
            sources.every((source, i) => states[i] !== undefined && covered.has(source))
        )
            retired.add(row.id);
        sources.forEach((source, i) => {
            if (states[i] === "full") covered.add(source);
        });
    }
    return retired;
}
