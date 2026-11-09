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

// The fixed texts below are OpenCode's own renderings from v2.0.15 through
// v2.2.6: codemode/instructions.ts (render, update, removed),
// mcp/instructions.ts (entries, render, update, removed) and
// instructions/builtins.ts (core/date). Only the MCP "have changed" section is
// newer: update() writes it from v2.1.3 on, where earlier hosts restated the
// whole list.
const noCodeModeTools =
    "No Code Mode tools are currently available. Later Code Mode catalog updates may add or remove tools. Do not call `execute` unless there is at least one available Code Mode tool.";
const codeModeRemoved =
    "Code Mode tools are no longer available. Do not use any previously listed Code Mode tools.";
// render() ends the catalog prompt with one of these headings (the first up to
// v2.2.0, the second from v2.2.1), then lists the tools.
const catalogHeadings = ["## Available tools", "## Code Mode tools (call only inside `execute`)"];
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
 * an MCP delta names the servers it states anew, in `entries` and `removed`,
 * and a Code Mode delta (neither present) only amends the catalog before it.
 */
interface SourcePart {
    full: boolean;
    /** Servers an MCP part names in `<server name="…">` entries. */
    entries?: readonly string[];
    /** The names an MCP removal line lists, split on the ", " OpenCode joins them with. */
    removed?: readonly string[];
}

/** The servers an MCP delta states anew; empty for every other part. */
const mentions = (part: SourcePart) =>
    part.full ? [] : [...(part.entries ?? []), ...(part.removed ?? [])];

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
 * Whether text is one full Code Mode catalog with nothing after it. For rows
 * whose sources are unknown: render() ends with a heading and then a single
 * block of tool listings joined by single newlines, so a blank line after that
 * heading means another part follows.
 */
function wholeCatalog(text: string): boolean {
    if (text === codeModeRemoved) return true;
    const rendered = text.startsWith(`${replacement}\n\n`)
        ? text.slice(replacement.length + 2)
        : text;
    if (rendered === noCodeModeTools) return true;
    if (!rendered.startsWith("# Code Mode\n")) return false;
    const ends = catalogHeadings
        .map((heading) => {
            const at = rendered.indexOf(`\n\n${heading}\n\n`);
            return at < 0 ? undefined : at + heading.length + 4;
        })
        .filter((end) => end !== undefined);
    return ends.length > 0 && !rendered.slice(Math.min(...ends)).includes("\n\n");
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
        names.push(open[1]);
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
            ? { full: true, entries: entries.names }
            : undefined;
    }
    if (listStart > 0) return undefined;
    // update() writes up to three sections, in this order: added servers,
    // changed servers (v2.1.3 and later), then one line naming removed servers.
    const entries: string[] = [];
    let removed: string[] | undefined;
    let index = 0;
    for (const header of [mcpAdded, mcpChanged]) {
        if (lines[index] !== header) continue;
        const section = serverEntries(lines, index + 1);
        if (!section || section.names.length === 0) return undefined;
        entries.push(...section.names);
        index = section.next;
    }
    const gone = lines[index];
    if (gone?.startsWith(mcpGone) && gone.endsWith(".") && gone.length > mcpGone.length + 1) {
        removed = gone.slice(mcpGone.length, -1).split(", ");
        index++;
    }
    return index === lines.length && (entries.length > 0 || removed)
        ? { full: false, entries, ...(removed ? { removed } : {}) }
        : undefined;
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
 * first from OpenCode 2.0.19 on, keeps the rest. (2.0.16 to 2.0.18 listed the
 * date first; the split stops at their Code Mode part and such rows stay.)
 * A source without a parser stops the split: its part has no known end, so
 * the parts before it are unknown, except that a leading Code Mode part can
 * still be read from its start.
 */
function splitRow(text: string, sources: readonly string[]): (SourcePart | undefined)[] {
    const parts: (SourcePart | undefined)[] = sources.map(() => undefined);
    let rest = text;
    let index = sources.length - 1;
    for (; index > 0; index--) {
        const source = sources[index];
        const cut = rest.lastIndexOf("\n\n");
        const part =
            source === codeMode || cut < 0 ? undefined : parsers[source]?.(rest.slice(cut + 2));
        if (!part) break;
        parts[index] = part;
        rest = rest.slice(0, cut);
    }
    if (index === 0) parts[0] = parsers[sources[0]]?.(rest);
    else if (sources[0] === codeMode && startsWithFullCatalog(text)) parts[0] = { full: true };
    return parts;
}

function rowParts(data: MessageData): { sources: string[]; parts: (SourcePart | undefined)[] } {
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
    // OpenCode 2.0.15 and older wrote rows without instructionSources, and put
    // project instructions, skills and references between the catalog and the
    // MCP guidance, and API context after it. Such a row is read only when its
    // whole text is a full catalog, a full catalog followed by MCP guidance, or
    // MCP guidance alone; anything else keeps the row.
    const cut = text.lastIndexOf("\n\n");
    const guidance = cut < 0 ? undefined : mcpPart(text.slice(cut + 2));
    if (guidance && wholeCatalog(text.slice(0, cut)))
        return { sources: [codeMode, mcp], parts: [{ full: true }, guidance] };
    if (wholeCatalog(text)) return { sources: [codeMode], parts: [{ full: true }] };
    const alone = mcpPart(text);
    return alone ? { sources: [mcp], parts: [alone] } : { sources: [], parts: [] };
}

/** Every run of two or more consecutive names, joined back with ", ". */
function joinedRuns(names: readonly string[]): string[] {
    const runs: string[] = [];
    for (let start = 0; start < names.length; start++)
        for (let end = start + 2; end <= names.length; end++)
            runs.push(names.slice(start, end).join(", "));
    return runs;
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
    const parsed = rows.map((row) => rowParts(row.data));
    // OpenCode joins removed server names with ", " without escaping them, so a
    // name that contains ", " reads as several. A removal line is read only when
    // every name it splits into is a server some entry names, and no run of
    // those names joined back together is one; otherwise its row stays.
    const named = new Set(
        parsed.flatMap(({ parts }) => parts.flatMap((part) => part?.entries ?? [])),
    );
    for (const { parts } of parsed)
        parts.forEach((part, i) => {
            if (
                part?.removed &&
                !(
                    part.removed.every((name) => named.has(name)) &&
                    !joinedRuns(part.removed).some((name) => named.has(name))
                )
            )
                parts[i] = undefined;
        });
    const restated = new Set<string>();
    const mentioned = new Set<string>();
    const retired = new Set<string>();
    for (let index = rows.length - 1; index >= 0; index--) {
        const { sources, parts } = parsed[index];
        if (
            sources.length > 0 &&
            parts.every((part, i) => {
                if (part === undefined) return false;
                const servers = mentions(part);
                return (
                    restated.has(sources[i]) ||
                    (servers.length > 0 && servers.every((server) => mentioned.has(server)))
                );
            })
        )
            retired.add(rows[index].id);
        parts.forEach((part, i) => {
            if (part?.full) restated.add(sources[i]);
            for (const server of part ? mentions(part) : []) mentioned.add(server);
        });
    }
    return retired;
}
