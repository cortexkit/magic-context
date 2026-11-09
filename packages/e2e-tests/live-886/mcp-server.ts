#!/usr/bin/env bun
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";

// A legacy stdio MCP peer: stdout carries JSON-RPC only. Reconnecting reads a new
// revision so both the host's Code Mode catalog and MCP guidance can change.
const revision = readFileSync(process.argv[2]!, "utf8").trim();
const tools = ["echo", "inspect"].map((name) => ({ name,
    description: `Issue886 local MCP ${name}, catalog revision ${revision}. Inspect disposable CLI fixtures only.`,
    inputSchema: { type: "object", properties: { text: { type: "string" } }, additionalProperties: false },
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
