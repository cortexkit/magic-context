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
const date = "core/date";

// The fixed texts below are OpenCode's own renderings from v2.0.22 through
// v2.2.6: codemode/instructions.ts (render, update, removed),
// mcp/instructions.ts (entries, render, update, removed) and
// instructions/builtins.ts (core/date). Only the "have changed" MCP header is
// newer: update() writes it from 2.2 on.
const noCodeModeTools =
    "No Code Mode tools are currently available. Later Code Mode catalog updates may add or remove tools. Do not call `execute` unless there is at least one available Code Mode tool.";
const codeModeRemoved =
    "Code Mode tools are no longer available. Do not use any previously listed Code Mode tools.";
const mcpReplacement =
    "The available MCP server instructions have changed. This list supersedes the previous one.";
const mcpRemoved = "MCP server instructions are no longer available.";
const mcpAdded =
    "New MCP server instructions are available in addition to those previously listed:";
const mcpChanged =
    "The following MCP server instructions have changed. Each entry replaces the previously listed server with the same name:";
const mcpGone = "Instructions for the following MCP servers are no longer available: ";
const dateLine =
    /^Today's date(?: is now)?: (?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{2} \d{4}$/;

/**
 * What one source's part of an instruction row says. `full` restates the
 * whole source, including that it is now empty. Otherwise the part is a delta:
 * an MCP delta lists the servers it states anew, and a Code Mode delta
 * (`servers` absent) only amends the catalog before it.
 */
interface SourcePart {
    full: boolean;
    servers?: readonly string[];
}

function codeModePart(text: string): SourcePart | undefined {
    if (text === noCodeModeTools || text === codeModeRemoved || text.startsWith("# Code Mode\n"))
        return { full: true };
    if (text.startsWith(`${replacement}\n\n`)) {
        const rendered = text.slice(replacement.length + 2);
        return rendered === noCodeModeTools || rendered.startsWith("# Code Mode\n")
            ? { full: true }
            : undefined;
    }
    return text.startsWith(`${changed}\n\n`) ? { full: false } : undefined;
}

/**
 * Whether text that begins with a Code Mode part restates the whole catalog.
 * Used when the end of the part cannot be found; only the start is read.
 */
function startsWithFullCatalog(text: string): boolean {
    const begins = (whole: string) => text === whole || text.startsWith(`${whole}\n\n`);
    return (
        text.startsWith("# Code Mode\n") ||
        text.startsWith(`${replacement}\n\n# Code Mode\n`) ||
        begins(noCodeModeTools) ||
        begins(`${replacement}\n\n${noCodeModeTools}`) ||
        begins(codeModeRemoved)
    );
}

/**
 * Server entries as OpenCode's entries() writes them: `  <server name="…">`,
 * then the server's lines, each indented by four spaces, then `  </server>`.
 * The indentation keeps instruction text from closing an entry early.
 * Returns the server names and the index of the first line after the entries.
 */
function serverEntries(lines: readonly string[], start: number) {
    const names: string[] = [];
    let index = start;
    for (;;) {
        const open = /^ {2}<server name="(.*)">$/.exec(lines[index] ?? "");
        if (!open) return { names, next: index };
        let end = index + 1;
        while (lines[end]?.startsWith("    ")) end++;
        if (end === index + 1 || lines[end] !== "  </server>") return undefined;
        names.push(open[1]!);
        index = end + 1;
    }
}

function mcpPart(text: string): SourcePart | undefined {
    if (text === mcpRemoved) return { full: true };
    const lines = text.split("\n");
    const listStart = lines[0] === mcpReplacement ? 1 : 0;
    if (lines[listStart] === "<mcp_instructions>") {
        const entries = serverEntries(lines, listStart + 1);
        return entries &&
            entries.next === lines.length - 1 &&
            lines[entries.next] === "</mcp_instructions>"
            ? { full: true }
            : undefined;
    }
    if (listStart > 0) return undefined;
    // update() writes up to three sections, in this order: added servers,
    // changed servers (2.2 and later), then one line naming removed servers.
    const servers: string[] = [];
    let index = 0;
    for (const header of [mcpAdded, mcpChanged]) {
        if (lines[index] !== header) continue;
        const entries = serverEntries(lines, index + 1);
        if (!entries || entries.names.length === 0) return undefined;
        servers.push(...entries.names);
        index = entries.next;
    }
    const gone = lines[index];
    if (gone?.startsWith(mcpGone) && gone.endsWith(".") && gone.length > mcpGone.length + 1) {
        // OpenCode joins the removed server names with ", ".
        servers.push(...gone.slice(mcpGone.length, -1).split(", "));
        index++;
    }
    return index === lines.length && servers.length > 0 ? { full: false, servers } : undefined;
}

const datePart = (text: string): SourcePart | undefined =>
    dateLine.test(text) ? { full: true } : undefined;

const parsers: Record<string, (text: string) => SourcePart | undefined> = {
    [codeMode]: codeModePart,
    [mcp]: mcpPart,
    [date]: datePart,
};

/**
 * Split a row into one part per source. Instructions.renderUpdate joins the
 * parts with a blank line in the order of `instructionSources`. A Code Mode
 * catalog contains blank lines of its own, but MCP guidance and the date line
 * never do, so those parts are taken from the end of the row and Code Mode,
 * always first, keeps the rest. A source without a parser stops the split:
 * its part has no known end, so the parts before it are unknown, except that
 * a leading Code Mode part can still be read from its start.
 */
function splitRow(text: string, sources: readonly string[]): (SourcePart | undefined)[] {
    const parts: (SourcePart | undefined)[] = sources.map(() => undefined);
    let rest = text;
    let index = sources.length - 1;
    for (; index > 0; index--) {
        const source = sources[index]!;
        const cut = rest.lastIndexOf("\n\n");
        const part = source === codeMode || cut < 0 ? undefined : parsers[source]?.(rest.slice(cut + 2));
        if (!part) break;
        parts[index] = part;
        rest = rest.slice(0, cut);
    }
    if (index === 0) parts[0] = parsers[sources[0]!]?.(rest);
    else if (sources[0] === codeMode && startsWithFullCatalog(text)) parts[0] = { full: true };
    return parts;
}

function rowParts(data: MessageData) {
    const text = data.text ?? "";
    const metadata = data.metadata;
    if (typeof metadata === "object" && metadata !== null && "instructionSources" in metadata) {
        const keys = metadata.instructionSources;
        const sources =
            Array.isArray(keys) &&
            keys.length > 0 &&
            keys.every((key) => typeof key === "string") &&
            new Set(keys).size === keys.length
                ? (keys as string[])
                : [];
        return { sources, parts: splitRow(text, sources) };
    }
    // Rows without instructionSources (hosts older than 2.0.22) are read as a
    // catalog with its MCP guidance, a catalog alone, or MCP guidance alone.
    const combined = splitRow(text, [codeMode, mcp]);
    if (combined.every(Boolean)) return { sources: [codeMode, mcp], parts: combined };
    const catalog = codeModePart(text) ?? (startsWithFullCatalog(text) ? { full: true } : undefined);
    if (catalog) return { sources: [codeMode], parts: [catalog] };
    const guidance = mcpPart(text);
    return guidance ? { sources: [mcp], parts: [guidance] } : { sources: [], parts: [] };
}

/**
 * Rows are atomic on the wire, but supersession belongs to each instruction
 * source. Walking from the newest row back, a row is retired only when every
 * source it carries has a recognized part that newer rows restate:
 * - a Code Mode part, by a newer full catalog (a delta restates nothing);
 * - the date, by a newer date line;
 * - MCP guidance, by a newer full list, or, for a delta, by newer parts that
 *   name each of its servers again. A server's newest mention (added, changed
 *   or removed) therefore always stays. A full list waits for a newer full
 *   list, because dropping it on deltas alone would revive any server it
 *   removed from the session's initial instructions.
 * A source without a parser, or a part or entry that does not parse, keeps
 * its row, and only recognized parts restate anything.
 */
export function supersededInstructionIDs(
    rows: readonly { id: string; data: MessageData }[],
): Set<string> {
    const restated = new Set<string>();
    const mentioned = new Set<string>();
    const retired = new Set<string>();
    for (let index = rows.length - 1; index >= 0; index--) {
        const row = rows[index]!;
        const { sources, parts } = rowParts(row.data);
        if (
            sources.length > 0 &&
            parts.every(
                (part, i) =>
                    part !== undefined &&
                    (restated.has(sources[i]!) ||
                        (part.servers?.every((server) => mentioned.has(server)) ?? false)),
            )
        )
            retired.add(row.id);
        parts.forEach((part, i) => {
            if (part?.full) restated.add(sources[i]!);
            for (const server of part?.servers ?? []) mentioned.add(server);
        });
    }
    return retired;
}
