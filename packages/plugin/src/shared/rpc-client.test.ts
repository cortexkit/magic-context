import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MagicContextRpcClient } from "./rpc-client";
import { rpcPortFilePath } from "./rpc-utils";

interface TestServer {
    port: number;
    close: () => Promise<void>;
}

const tempDirs: string[] = [];
let servers: TestServer[] = [];

afterEach(async () => {
    for (const server of servers.splice(0)) {
        await server.close();
    }
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "mc-rpc-client-"));
    tempDirs.push(dir);
    return dir;
}

function writePortFile(storageDir: string, directory: string, port: number): void {
    const portFile = rpcPortFilePath(storageDir, directory);
    mkdirSync(dirname(portFile), { recursive: true });
    writeFileSync(
        portFile,
        JSON.stringify({ port, pid: process.pid, started_at: Date.now() }),
        "utf-8",
    );
}

function writePortFileForPid(
    storageDir: string,
    directory: string,
    port: number,
    pid: number,
    startedAt: number,
): void {
    const portFile = rpcPortFilePath(storageDir, directory, pid);
    mkdirSync(dirname(portFile), { recursive: true });
    writeFileSync(portFile, JSON.stringify({ port, pid, started_at: startedAt }), "utf-8");
}

async function startRpcServer(handler: (method: string) => Response | object): Promise<TestServer> {
    const server = createServer(async (req, res) => {
        if (req.method === "GET" && req.url === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        if (req.method === "POST" && req.url?.startsWith("/rpc/")) {
            const method = req.url.slice("/rpc/".length);
            const result = handler(method);
            if (result instanceof Response) {
                res.writeHead(result.status, { "Content-Type": "application/json" });
                res.end(await result.text());
                return;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result));
            return;
        }

        res.writeHead(404);
        res.end("Not Found");
    });

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("failed to bind test server");

    const testServer = {
        port: addr.port,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.close((err) => (err ? reject(err) : resolve()));
            }),
    };
    servers.push(testServer);
    return testServer;
}

async function closeServer(server: TestServer): Promise<void> {
    servers = servers.filter((s) => s !== server);
    await server.close();
}

describe("MagicContextRpcClient", () => {
    test("re-reads the port file after the cached server restarts on a new port", async () => {
        const storageDir = makeTempDir();
        const directory = "/repo";
        const client = new MagicContextRpcClient(storageDir, directory);

        const first = await startRpcServer(() => ({ value: "first" }));
        writePortFile(storageDir, directory, first.port);
        expect(await client.call<{ value: string }>("value")).toEqual({ value: "first" });

        await closeServer(first);
        const second = await startRpcServer(() => ({ value: "second" }));
        writePortFile(storageDir, directory, second.port);

        expect(await client.call<{ value: string }>("value")).toEqual({ value: "second" });
    });

    test("gives up when the port file points at a dead server", async () => {
        const storageDir = makeTempDir();
        const directory = "/repo";
        const dead = await startRpcServer(() => ({ ok: true }));
        const port = dead.port;
        await closeServer(dead);
        writePortFile(storageDir, directory, port);

        const client = new MagicContextRpcClient(storageDir, directory);
        await expect(client.call("value")).rejects.toThrow(
            "Magic Context RPC server not available",
        );
    }, 20_000);

    test("re-resolves and retries transient 5xx responses", async () => {
        const storageDir = makeTempDir();
        const directory = "/repo";
        let calls = 0;
        const server = await startRpcServer(() => {
            calls++;
            if (calls === 1) {
                return new Response(JSON.stringify({ error: "warming up" }), { status: 503 });
            }
            return { value: "ok" };
        });
        writePortFile(storageDir, directory, server.port);

        const client = new MagicContextRpcClient(storageDir, directory);
        expect(await client.call<{ value: string }>("value")).toEqual({ value: "ok" });
        expect(calls).toBe(2);
    });

    test("ignores newer stale pid files and discovers the latest live instance", async () => {
        const storageDir = makeTempDir();
        const directory = "/repo";
        const live = await startRpcServer(() => ({ value: "live" }));
        writePortFileForPid(storageDir, directory, 65535, 999_999_999, Date.now() + 10_000);
        writePortFileForPid(storageDir, directory, live.port, process.pid, Date.now());

        const client = new MagicContextRpcClient(storageDir, directory);
        expect(await client.call<{ value: string }>("value")).toEqual({ value: "live" });
    });
});
