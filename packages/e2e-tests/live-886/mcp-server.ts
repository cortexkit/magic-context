#!/usr/bin/env bun
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";

// A legacy stdio MCP peer: stdout carries JSON-RPC only. Reconnecting reads a new
// revision so both the host's Code Mode catalog and MCP guidance can change.
const revision = readFileSync(process.argv[2]!, "utf8").trim();
// An optional tool count sizes the catalog like a real MCP server's (the reporter's rows were ~5k tokens).
const toolCount = Number(process.argv[3] ?? 2);
const names = toolCount <= 2 ? ["echo", "inspect"].slice(0, Math.max(1, toolCount))
    : Array.from({ length: toolCount }, (_, index) => `fixture_tool_${String(index + 1).padStart(2, "0")}`);
const tools = names.map((name) => ({ name,
    description: toolCount <= 2
        ? `Issue886 local MCP ${name}, catalog revision ${revision}. Inspect disposable CLI fixtures only.`
        : `Issue886 local MCP ${name}, catalog revision ${revision}. Inspects one disposable CLI fixture in the workspace and reports its parsed expression tree, evaluation steps, operator precedence notes, and any arithmetic errors it finds, without changing files.`,
    inputSchema: { type: "object", properties: { text: { type: "string", description: "Fixture expression or relative path inside the workspace." },
        verbose: { type: "boolean", description: "Include every evaluation step." } }, additionalProperties: false },
}));
for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line) as { id?: number | string; method: string; params?: Record<string, unknown> };
    if (request.id === undefined) continue;
    let result: unknown;
    switch (request.method) {
        case "initialize": result = { protocolVersion: request.params?.protocolVersion ?? "2024-11-05",
            capabilities: { tools: {} }, serverInfo: { name: "issue886-local", version: revision },
            instructions: `Issue886 MCP guidance revision ${revision}: these local tools inspect disposable CLI fixtures. Never read credentials or files outside the workspace.` }; break;
        case "ping": result = {}; break;
        case "tools/list": result = { tools }; break;
        case "tools/call": result = { content: [{ type: "text", text: `Issue886 MCP revision ${revision}: ${JSON.stringify(request.params?.arguments ?? {})}` }] }; break;
        case "resources/list": result = { resources: [] }; break;
        case "prompts/list": result = { prompts: [] }; break;
        default:
            console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } }));
            continue;
    }
    console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
}
