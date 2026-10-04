/**
 * A small Model Context Protocol server over stdio: newline-delimited JSON-RPC
 * 2.0, tools only. Claude Code is the client; it sends `initialize`, the
 * `notifications/initialized` notification, `tools/list` and `tools/call`, and
 * also probes with methods this server does not implement (it must answer those
 * with a standard "method not found" error rather than a result).
 *
 * Nothing but protocol messages may reach stdout: it is the transport. Diagnostics
 * belong on stderr.
 */

import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export const SUPPORTED_PROTOCOL_VERSIONS = [
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
] as const;

export interface McpToolResult {
    text: string;
    isError: boolean;
}

export interface McpTool {
    name: string;
    description: string;
    /** JSON Schema for the arguments; must be an object schema. */
    inputSchema: Record<string, unknown>;
    annotations?: {
        title?: string;
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
    };
    call(args: Record<string, unknown>): Promise<McpToolResult>;
}

export interface McpServerOptions {
    name: string;
    title?: string;
    version: string;
    instructions?: string;
    /** Resolved on first use so a slow or failing start-up cannot block `initialize`. */
    getTools: () => McpTool[] | Promise<McpTool[]>;
    log?: (message: string) => void;
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

type JsonRpcId = string | number | null;

interface JsonRpcResponse {
    jsonrpc: "2.0";
    id: JsonRpcId;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorResponse(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
    return { jsonrpc: "2.0", id, error: { code, message } };
}

export class McpServer {
    private tools: McpTool[] | null = null;

    constructor(private readonly options: McpServerOptions) {}

    private async resolveTools(): Promise<McpTool[]> {
        if (!this.tools) this.tools = await this.options.getTools();
        return this.tools;
    }

    /**
     * Handle one inbound message (or batch). Resolves to the response to send, or
     * undefined when none is due (notifications).
     */
    async handle(message: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | undefined> {
        if (Array.isArray(message)) {
            if (message.length === 0) {
                return errorResponse(null, INVALID_REQUEST, "Empty batch");
            }
            const responses = (
                await Promise.all(message.map((item) => this.handleOne(item)))
            ).filter((response): response is JsonRpcResponse => response !== undefined);
            return responses.length > 0 ? responses : undefined;
        }
        return this.handleOne(message);
    }

    private async handleOne(message: unknown): Promise<JsonRpcResponse | undefined> {
        if (!isObject(message) || typeof message.method !== "string") {
            // A response to a request this server never sent carries no method; ignore it.
            if (isObject(message) && ("result" in message || "error" in message)) return undefined;
            const id = isObject(message) && isRpcId(message.id) ? message.id : null;
            return errorResponse(id, INVALID_REQUEST, "Invalid request");
        }
        const hasId = "id" in message && message.id !== undefined;
        const id: JsonRpcId = hasId && isRpcId(message.id) ? message.id : null;
        const params = isObject(message.params) ? message.params : {};

        try {
            const result = await this.dispatch(message.method, params);
            if (!hasId) return undefined;
            if (result === NOT_FOUND) {
                return errorResponse(id, METHOD_NOT_FOUND, `Method not found: ${message.method}`);
            }
            return { jsonrpc: "2.0", id, result };
        } catch (error) {
            if (!hasId) {
                this.options.log?.(`notification ${message.method} failed: ${describe(error)}`);
                return undefined;
            }
            if (error instanceof InvalidParams) {
                return errorResponse(id, INVALID_PARAMS, error.message);
            }
            this.options.log?.(`${message.method} failed: ${describe(error)}`);
            return errorResponse(id, INTERNAL_ERROR, describe(error));
        }
    }

    private async dispatch(
        method: string,
        params: Record<string, unknown>,
    ): Promise<unknown | typeof NOT_FOUND> {
        switch (method) {
            case "initialize": {
                const requested = params.protocolVersion;
                const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.find(
                    (version) => version === requested,
                );
                return {
                    protocolVersion: protocolVersion ?? SUPPORTED_PROTOCOL_VERSIONS[0],
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: {
                        name: this.options.name,
                        ...(this.options.title ? { title: this.options.title } : {}),
                        version: this.options.version,
                    },
                    ...(this.options.instructions
                        ? { instructions: this.options.instructions }
                        : {}),
                };
            }
            case "ping":
                return {};
            case "tools/list": {
                const tools = await this.resolveTools();
                return {
                    tools: tools.map((tool) => ({
                        name: tool.name,
                        description: tool.description,
                        inputSchema: tool.inputSchema,
                        ...(tool.annotations ? { annotations: tool.annotations } : {}),
                    })),
                };
            }
            case "tools/call":
                return this.callTool(params);
            default:
                // Notifications (initialized, cancelled, progress, roots/list_changed) need no
                // handling; requests for capabilities this server does not advertise do.
                return method.startsWith("notifications/") ? {} : NOT_FOUND;
        }
    }

    private async callTool(params: Record<string, unknown>): Promise<unknown> {
        const name = params.name;
        if (typeof name !== "string") throw new InvalidParams("tools/call requires a tool name");
        const tool = (await this.resolveTools()).find((candidate) => candidate.name === name);
        if (!tool) throw new InvalidParams(`Unknown tool: ${name}`);
        const args = isObject(params.arguments) ? params.arguments : {};
        try {
            const result = await tool.call(args);
            return {
                content: [{ type: "text", text: result.text }],
                ...(result.isError ? { isError: true } : {}),
            };
        } catch (error) {
            // A failing tool is a tool result the model can read, not a protocol failure.
            this.options.log?.(`tool ${name} threw: ${describe(error)}`);
            return {
                content: [{ type: "text", text: `${name} failed: ${describe(error)}` }],
                isError: true,
            };
        }
    }
}

const NOT_FOUND = Symbol("method-not-found");

class InvalidParams extends Error {}

function isRpcId(value: unknown): value is JsonRpcId {
    return typeof value === "string" || typeof value === "number" || value === null;
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export interface ServeStdioOptions {
    input?: Readable;
    output?: Writable;
}

/**
 * Serve until the input closes. Requests are handled concurrently; each response
 * is one line on the output.
 */
export function serveStdio(server: McpServer, options: ServeStdioOptions = {}): Promise<void> {
    const input = options.input ?? process.stdin;
    const output = options.output ?? process.stdout;
    const send = (response: unknown): void => {
        output.write(`${JSON.stringify(response)}\n`);
    };
    const pending = new Set<Promise<void>>();
    const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });

    lines.on("line", (line) => {
        const trimmed = line.trim();
        if (trimmed.length === 0) return;
        const work = (async () => {
            let message: unknown;
            try {
                message = JSON.parse(trimmed);
            } catch {
                send(errorResponse(null, PARSE_ERROR, "Parse error"));
                return;
            }
            const response = await server.handle(message);
            if (response !== undefined) send(response);
        })().finally(() => pending.delete(work));
        pending.add(work);
    });

    return new Promise<void>((resolve) => {
        lines.on("close", () => {
            // Let in-flight calls answer before the process is allowed to exit.
            void Promise.allSettled([...pending]).then(() => resolve());
        });
    });
}
