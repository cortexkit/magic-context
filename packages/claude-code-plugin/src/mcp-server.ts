/**
 * Entry point of the Magic Context MCP server (`dist/mcp-server.js`).
 *
 * Claude Code starts one instance per session, with the session id and project
 * directory in the environment (see session.ts).
 */
import "./boot-harness";
import { flushLogger } from "@magic-context/core/shared/logger";
import pkg from "../package.json" with { type: "json" };
import { MCP_SERVER_INSTRUCTIONS } from "./guidance";
import { McpServer, serveStdio } from "./mcp/server";
import { openRuntime, type Runtime } from "./runtime";
import { type ClaudeCodeSession, resolveMcpSession } from "./session";
import { readCurrentSession } from "./session-handoff";
import { createClaudeCodeTools } from "./tools";

// stdout is the MCP transport. Anything that logs there would corrupt the stream.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

const session = resolveMcpSession();
let runtime = null as Runtime | null;

// Claude Code is this server's parent. The SessionStart hook may record the
// starting session a moment before the server is spawned; an older record is
// from an earlier process that had the same PID.
const claudePid = process.ppid;
const notBefore = Date.now() - 60_000;
function currentSession(): ClaudeCodeSession {
    const handoff = readCurrentSession(claudePid, notBefore);
    return handoff && handoff.directory === session.directory
        ? { sessionId: handoff.sessionId, directory: session.directory, source: "hook" }
        : session;
}

const server = new McpServer({
    name: "magic-context",
    title: "Magic Context",
    version: pkg.version,
    instructions: MCP_SERVER_INSTRUCTIONS,
    log: (message) => console.error(`[magic-context] ${message}`),
    getTools: () => {
        try {
            runtime = openRuntime(session.directory);
            return createClaudeCodeTools({ runtime, session, currentSession });
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            console.error(`[magic-context] ${reason}`);
            return createClaudeCodeTools({
                runtime: null,
                session,
                currentSession,
                unavailableReason: reason,
            });
        }
    },
});

await serveStdio(server);
runtime?.close();
// The core logger buffers on a timer that exiting would cut short.
flushLogger();
process.exit(0);
