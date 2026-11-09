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

// The text OpenCode renders when Code Mode is switched off for a session
// (`removed` in codemode/instructions.ts, unchanged from v2.0.22 to v2.2.5).
export const CODE_MODE_REMOVED =
    "Code Mode tools are no longer available. Do not use any previously listed Code Mode tools.";

/** One MCP server's instructions as OpenCode lists them. */
export interface McpServerFixture {
    server: string;
    instructions: string;
    /** False when the server's tools are called directly instead of through Code Mode. */
    codemode?: false;
}

// Mirrors entries(), render(), update() and the `removed` renderer in OpenCode
// packages/core/src/mcp/instructions.ts at v2.0.22, v2.1.4 and v2.2.5, and
// McpTool.namespace() in tool/mcp.ts. Before 2.2, a server whose instructions
// changed made update() restate the whole list; from 2.2 it renders a "have
// changed" entry instead. Added and removed servers render as entries in
// every version, so connecting or disconnecting a server never restates the list.
function mcpEntries(servers: readonly McpServerFixture[]): string[] {
    return servers.flatMap((server) => [
        `  <server name="${server.server}">`,
        ...(server.codemode === false
            ? []
            : [
                  `    Use tools from this server through \`execute\` under \`tools[${JSON.stringify(server.server.replace(/[^a-zA-Z0-9_-]/g, "_"))}]\`.`,
              ]),
        ...server.instructions.split("\n").map((line) => `    ${line}`),
        "  </server>",
    ]);
}

export function renderMcpGuidance(servers: readonly McpServerFixture[]): string {
    return ["<mcp_instructions>", ...mcpEntries(servers), "</mcp_instructions>"].join("\n");
}

export function updateMcpGuidance(
    previous: readonly McpServerFixture[],
    current: readonly McpServerFixture[],
    version: CatalogVersion = "2.2.3",
): string {
    const before = new Map(previous.map((server) => [server.server, server]));
    const names = new Set(current.map((server) => server.server));
    const added = current.filter((server) => !before.has(server.server));
    const removed = previous.filter((server) => !names.has(server.server));
    const changed = current.filter((server) => {
        const old = before.get(server.server);
        return (
            old !== undefined &&
            (old.instructions !== server.instructions || old.codemode !== server.codemode)
        );
    });
    const restate =
        version === "2.2.3"
            ? added.length === 0 && changed.length === 0 && removed.length === 0
            : changed.length > 0 || (added.length === 0 && removed.length === 0);
    if (restate)
        return [
            "The available MCP server instructions have changed. This list supersedes the previous one.",
            renderMcpGuidance(current),
        ].join("\n");
    return [
        ...(added.length === 0
            ? []
            : [
                  "New MCP server instructions are available in addition to those previously listed:",
                  ...mcpEntries(added),
              ]),
        ...(changed.length === 0
            ? []
            : [
                  "The following MCP server instructions have changed. Each entry replaces the previously listed server with the same name:",
                  ...mcpEntries(changed),
              ]),
        ...(removed.length === 0
            ? []
            : [
                  `Instructions for the following MCP servers are no longer available: ${removed.map((server) => server.server).join(", ")}.`,
              ]),
    ].join("\n");
}

export const MCP_GUIDANCE_REMOVED = "MCP server instructions are no longer available.";

// The core/date source in OpenCode packages/core/src/instructions/builtins.ts.
export const changedDate = (date: Date) => `Today's date is now: ${date.toDateString()}`;

// Instructions.renderUpdate in OpenCode packages/core/src/instructions/index.ts
// joins the sources a row carries with a blank line, in the order
// SessionContext combines them: core/codemode, core/mcp-guidance, then project
// instructions (core/instructions), then core/date.
export const instructionRow = (...parts: string[]) => parts.join("\n\n");
