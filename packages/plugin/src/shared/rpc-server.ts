import {
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { log } from "./logger";
import { isPidAlive, parseRpcPortFile, rpcPortDir, rpcPortFilePath } from "./rpc-utils";

type RpcHandler = (params: Record<string, unknown>) => Promise<Record<string, unknown>>;

export class MagicContextRpcServer {
    private server: Server | null = null;
    private port = 0;
    private handlers = new Map<string, RpcHandler>();
    private portFilePath: string;
    private portDir: string;
    private startedAt = Date.now();

    constructor(storageDir: string, directory: string) {
        this.portFilePath = rpcPortFilePath(storageDir, directory);
        this.portDir = rpcPortDir(storageDir, directory);
    }

    /** Register an RPC method handler. */
    handle(method: string, handler: RpcHandler): void {
        this.handlers.set(method, handler);
    }

    /** Start the server on a random port, write port to disk. */
    async start(): Promise<number> {
        return new Promise((resolve, reject) => {
            const server = createServer((req, res) => this.dispatch(req, res));

            server.on("error", (err) => {
                log(`[rpc] server error: ${err.message}`);
                reject(err);
            });

            server.listen(0, "127.0.0.1", () => {
                const addr = server.address();
                if (!addr || typeof addr === "string") {
                    reject(new Error("Failed to get server address"));
                    return;
                }
                this.port = addr.port;
                this.server = server;

                // Write a per-process port file atomically. Multi-instance
                // OpenCode is supported: TUI discovery scans all live pid files
                // and picks the most recent instead of cross-wiring via one
                // shared project file.
                try {
                    this.warnIfOtherLiveInstance();
                    const dir = dirname(this.portFilePath);
                    mkdirSync(dir, { recursive: true });
                    const tmpPath = `${this.portFilePath}.tmp`;
                    writeFileSync(
                        tmpPath,
                        JSON.stringify({
                            port: this.port,
                            pid: process.pid,
                            started_at: this.startedAt,
                        }),
                        "utf-8",
                    );
                    renameSync(tmpPath, this.portFilePath);
                    log(`[rpc] server listening on 127.0.0.1:${this.port}`);
                } catch (err) {
                    log(`[rpc] failed to write port file: ${err}`);
                }

                resolve(this.port);
            });

            // Don't keep the process alive just for the RPC server
            server.unref();
        });
    }

    private warnIfOtherLiveInstance(): void {
        try {
            for (const entry of readdirSync(this.portDir)) {
                if (!entry.startsWith("port-") || !entry.endsWith(".json")) continue;
                const record = parseRpcPortFile(readFileSync(`${this.portDir}/${entry}`, "utf-8"));
                if (!record || record.pid === process.pid || !isPidAlive(record.pid)) continue;
                log(
                    `[rpc] another Magic Context RPC server is active for this project (pid ${record.pid}, port ${record.port}); starting separate instance on a new port`,
                );
                return;
            }
        } catch {
            // No discovery directory yet, or unreadable stale file. Not fatal.
        }
    }

    /** Stop the server and clean up port file. */
    stop(): void {
        if (this.server) {
            this.server.close();
            this.server = null;
        }
        try {
            unlinkSync(this.portFilePath);
        } catch {
            // Intentional: port file may already be gone
        }
    }

    private dispatch(req: IncomingMessage, res: ServerResponse): void {
        const url = req.url ?? "";

        // CORS headers for same-origin fetch
        res.setHeader("Access-Control-Allow-Origin", "*");

        if (req.method === "GET" && url === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, pid: process.pid }));
            return;
        }

        if (req.method !== "POST" || !url.startsWith("/rpc/")) {
            res.writeHead(404);
            res.end("Not Found");
            return;
        }

        const method = url.slice(5); // strip "/rpc/"
        const handler = this.handlers.get(method);
        if (!handler) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `Unknown method: ${method}` }));
            return;
        }

        let body = "";
        req.on("data", (chunk: Buffer) => {
            body += chunk.toString();
            if (body.length > 1_048_576) {
                res.writeHead(413);
                res.end("Request too large");
                req.destroy();
            }
        });

        req.on("end", () => {
            let params: Record<string, unknown> = {};
            try {
                if (body.length > 0) {
                    params = JSON.parse(body);
                }
            } catch {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Invalid JSON" }));
                return;
            }

            handler(params)
                .then((result) => {
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify(result));
                })
                .catch((err) => {
                    log(`[rpc] handler error: ${method} => ${err}`);
                    res.writeHead(500, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: String(err) }));
                });
        });
    }
}
