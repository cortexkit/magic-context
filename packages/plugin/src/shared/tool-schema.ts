/**
 * The zod copy the shared agent tools build their argument schemas with.
 *
 * A host that adapts those tools (the Claude Code MCP server turns them into MCP
 * tools) must validate and emit JSON Schema with this same copy, so two zod
 * versions never meet. It is re-exported here so the adapter resolves it through
 * the core instead of declaring its own dependency on the OpenCode SDK.
 */
export { tool } from "@opencode-ai/plugin";
