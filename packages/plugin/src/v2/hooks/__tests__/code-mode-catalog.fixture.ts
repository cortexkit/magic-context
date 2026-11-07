type CatalogVersion = "2.0.22" | "2.1.4" | "2.2.3";

export const codeModeInstructionMetadata = {
    notice: "instructions",
    instructionSources: ["core/codemode"],
};

// Mirrors render() and the complete-catalog added-entry branch of update() in
// OpenCode packages/core/src/codemode/instructions.ts at v2.0.22, v2.1.4 and
// v2.2.3, with namespace/entry lines from codemode/catalog.ts. Descriptions are
// fixture inputs; changing a namespace description makes update() emit a full
// replacement. The newer version changes the prompt, not the replacement rules.
// Each namespace has one pinned tool, keeping the catalog complete even when
// deliberately large namespace descriptions exceed the normal inline budget.
export function renderCodeModeCatalog(
    descriptions: readonly string[],
    version: CatalogVersion = "2.1.4",
) {
    if (descriptions.length === 0)
        return "No Code Mode tools are currently available. Later Code Mode catalog updates may add or remove tools. Do not call `execute` unless there is at least one available Code Mode tool.";
    const introduction =
        version === "2.2.3"
            ? "The tools listed below cannot be called directly: they only work as JavaScript inside the `execute` tool. Every other tool you have is a normal tool call: call it directly, never inside `execute`."
            : "Use the `execute` tool to call the tools listed below. They cannot be called directly. They only work inside code you pass to `execute`.";
    const heading =
        version === "2.2.3"
            ? "## Code Mode tools (call only inside `execute`)"
            : "## Available tools";
    const tools = descriptions.flatMap((description, index) => [
        `- catalog${index} (1 tool) // ${description}`,
        `  - tools.catalog${index}.inspect(): Promise<unknown>`,
    ]);
    return `# Code Mode\n\n${introduction}\n\nThe catalog is complete. Do not guess tool names.\n\n${heading}\n\n${tools.join("\n")}`;
}

export function replaceCodeModeCatalog(
    entries: readonly string[],
    version: CatalogVersion = "2.1.4",
) {
    return `The Code Mode tool catalog has changed. This catalog supersedes the previous Code Mode tool catalog.\n\n${renderCodeModeCatalog(entries, version)}`;
}

export function addCodeModeEntries(descriptions: readonly string[]) {
    const entries = descriptions.map(
        (description) =>
            `  - tools.catalog0.${description.replace(/\W+/g, "_").toLowerCase()}(): Promise<unknown> // ${description}`,
    );
    return `The Code Mode tool catalog has changed.\n\nNew tools are available in addition to those previously listed:\n${entries.join("\n")}`;
}
