import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { McpServer, type McpTool, serveStdio } from "./server";

function echoTool(overrides: Partial<McpTool> = {}): McpTool {
    return {
        name: "echo",
        description: "Echo the text back",
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
        annotations: { readOnlyHint: true },
        call: async (args) => ({ text: String(args.text ?? ""), isError: false }),
        ...overrides,
    };
}

function createServer(tools: McpTool[] = [echoTool()], logs: string[] = []): McpServer {
    return new McpServer({
        name: "test",
        title: "Test",
        version: "1.2.3",
        instructions: "be nice",
        getTools: () => tools,
        log: (message) => logs.push(message),
    });
}

describe("McpServer", () => {
    test("initialize echoes a supported protocol version and advertises tools", async () => {
        const response = await createServer().handle({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-06-18", capabilities: {} },
        });
        expect(response).toEqual({
            jsonrpc: "2.0",
            id: 1,
            result: {
                protocolVersion: "2025-06-18",
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: "test", title: "Test", version: "1.2.3" },
                instructions: "be nice",
            },
        });
    });

    test("initialize answers an unknown protocol version with the newest it supports", async () => {
        const response = (await createServer().handle({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "1999-01-01" },
        })) as { result: { protocolVersion: string } };
        expect(response.result.protocolVersion).toBe("2025-11-25");
    });

    test("notifications get no response", async () => {
        const server = createServer();
        expect(
            await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }),
        ).toBeUndefined();
        expect(
            await server.handle({
                jsonrpc: "2.0",
                method: "notifications/cancelled",
                params: { requestId: 3 },
            }),
        ).toBeUndefined();
    });

    test("unimplemented requests are method-not-found errors, not results", async () => {
        const response = await createServer().handle({
            jsonrpc: "2.0",
            id: "probe",
            method: "server/discover",
        });
        expect(response).toEqual({
            jsonrpc: "2.0",
            id: "probe",
            error: { code: -32601, message: "Method not found: server/discover" },
        });
    });

    test("ping answers with an empty result", async () => {
        expect(await createServer().handle({ jsonrpc: "2.0", id: 7, method: "ping" })).toEqual({
            jsonrpc: "2.0",
            id: 7,
            result: {},
        });
    });

    test("tools/list describes each tool", async () => {
        const response = (await createServer().handle({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/list",
        })) as { result: { tools: unknown[] } };
        expect(response.result.tools).toEqual([
            {
                name: "echo",
                description: "Echo the text back",
                inputSchema: { type: "object", properties: { text: { type: "string" } } },
                annotations: { readOnlyHint: true },
            },
        ]);
    });

    test("tools are resolved once, on first use", async () => {
        let resolved = 0;
        const server = new McpServer({
            name: "t",
            version: "0",
            getTools: () => {
                resolved++;
                return [echoTool()];
            },
        });
        await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
        expect(resolved).toBe(0);
        await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/list" });
        expect(resolved).toBe(1);
    });

    test("tools/call returns text content and flags tool errors", async () => {
        const server = createServer([
            echoTool(),
            echoTool({
                name: "fails",
                call: async () => ({ text: "Error: nope", isError: true }),
            }),
        ]);
        expect(
            await server.handle({
                jsonrpc: "2.0",
                id: 3,
                method: "tools/call",
                params: { name: "echo", arguments: { text: "hello" } },
            }),
        ).toEqual({
            jsonrpc: "2.0",
            id: 3,
            result: { content: [{ type: "text", text: "hello" }] },
        });
        expect(
            await server.handle({
                jsonrpc: "2.0",
                id: 4,
                method: "tools/call",
                params: { name: "fails", arguments: {} },
            }),
        ).toEqual({
            jsonrpc: "2.0",
            id: 4,
            result: { content: [{ type: "text", text: "Error: nope" }], isError: true },
        });
    });

    test("a throwing tool becomes an error result the model can read", async () => {
        const logs: string[] = [];
        const server = createServer(
            [
                echoTool({
                    call: async () => {
                        throw new Error("database is locked");
                    },
                }),
            ],
            logs,
        );
        const response = (await server.handle({
            jsonrpc: "2.0",
            id: 5,
            method: "tools/call",
            params: { name: "echo" },
        })) as { result: { content: Array<{ text: string }>; isError: boolean } };
        expect(response.result.isError).toBe(true);
        expect(response.result.content[0].text).toBe("echo failed: database is locked");
        expect(logs.some((line) => line.includes("database is locked"))).toBe(true);
    });

    test("calling an unknown tool or omitting the name is invalid params", async () => {
        const server = createServer();
        expect(
            await server.handle({
                jsonrpc: "2.0",
                id: 6,
                method: "tools/call",
                params: { name: "nope" },
            }),
        ).toEqual({
            jsonrpc: "2.0",
            id: 6,
            error: { code: -32602, message: "Unknown tool: nope" },
        });
        expect(
            ((await server.handle({ jsonrpc: "2.0", id: 7, method: "tools/call" })) as any).error
                .code,
        ).toBe(-32602);
    });

    test("a failing getTools is an internal error for that request only", async () => {
        const server = new McpServer({
            name: "t",
            version: "0",
            getTools: () => {
                throw new Error("boot failed");
            },
        });
        expect(await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })).toEqual({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32603, message: "boot failed" },
        });
        expect(await server.handle({ jsonrpc: "2.0", id: 2, method: "ping" })).toEqual({
            jsonrpc: "2.0",
            id: 2,
            result: {},
        });
    });

    test("invalid requests, stray responses and batches", async () => {
        const server = createServer();
        expect(await server.handle({ jsonrpc: "2.0", id: 9 })).toEqual({
            jsonrpc: "2.0",
            id: 9,
            error: { code: -32600, message: "Invalid request" },
        });
        expect(await server.handle({ jsonrpc: "2.0", id: 9, result: {} })).toBeUndefined();
        expect(await server.handle([])).toEqual({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32600, message: "Empty batch" },
        });
        expect(
            await server.handle([
                { jsonrpc: "2.0", id: 1, method: "ping" },
                { jsonrpc: "2.0", method: "notifications/initialized" },
            ]),
        ).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
    });
});

describe("serveStdio", () => {
    test("answers newline-delimited JSON-RPC and finishes in-flight calls on close", async () => {
        const input = new PassThrough();
        const output = new PassThrough();
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const server = createServer([
            echoTool({
                call: async (args) => {
                    await gate;
                    return { text: String(args.text), isError: false };
                },
            }),
        ]);
        const chunks: string[] = [];
        output.on("data", (chunk) => chunks.push(String(chunk)));
        const done = serveStdio(server, { input, output });

        input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\r\n`);
        input.write("\n{not json\n");
        input.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { text: "late" } } })}\n`,
        );
        input.end();
        await new Promise((resolve) => setTimeout(resolve, 20));
        release();
        await done;

        const responses = chunks
            .join("")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        expect(responses).toContainEqual({ jsonrpc: "2.0", id: 1, result: {} });
        expect(responses).toContainEqual({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
        });
        expect(responses).toContainEqual({
            jsonrpc: "2.0",
            id: 2,
            result: { content: [{ type: "text", text: "late" }] },
        });
    });
});
