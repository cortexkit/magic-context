import { readFileSync } from "node:fs";
import { rpcPortFilePath } from "./rpc-utils";

const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 500;
const REQUEST_TIMEOUT_MS = 5000;
const MAX_RERESOLVE_ATTEMPTS = 3;
const NON_RETRYABLE_RPC_ERROR = Symbol("nonRetryableRpcError");
type NonRetryableRpcError = Error & { [NON_RETRYABLE_RPC_ERROR]: true };

export class MagicContextRpcClient {
    private port: number | null = null;
    private portFilePath: string;
    private healthChecked = false;

    constructor(storageDir: string, directory: string) {
        this.portFilePath = rpcPortFilePath(storageDir, directory);
    }

    /** Call an RPC method. Retries port resolution if the server isn't ready yet. */
    async call<T = Record<string, unknown>>(
        method: string,
        params: Record<string, unknown> = {},
    ): Promise<T> {
        let lastError: unknown = null;

        for (let attempt = 0; attempt < MAX_RERESOLVE_ATTEMPTS; attempt++) {
            const port = await this.resolvePort();
            if (!port) {
                lastError = new Error("Magic Context RPC server not available");
                this.reset();
                continue;
            }

            try {
                const response = await this.fetchWithTimeout(`http://127.0.0.1:${port}/rpc/${method}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(params),
                });

                if (!response.ok) {
                    const text = await response.text();
                    const error = new Error(`RPC ${method} failed (${response.status}): ${text}`);
                    if (response.status >= 500) {
                        lastError = error;
                        this.reset();
                        continue;
                    }
                    (error as NonRetryableRpcError)[NON_RETRYABLE_RPC_ERROR] = true;
                    throw error;
                }

                return (await response.json()) as T;
            } catch (err) {
                if (isNonRetryableRpcError(err)) {
                    throw err;
                }
                lastError = err;
                this.reset();
            }
        }

        if (lastError instanceof Error) {
            throw lastError;
        }
        throw new Error("Magic Context RPC server not available");
    }

    /** Check if the RPC server is reachable. */
    async isAvailable(): Promise<boolean> {
        try {
            const port = await this.resolvePort();
            return port !== null;
        } catch {
            return false;
        }
    }

    private async resolvePort(): Promise<number | null> {
        if (this.port && this.healthChecked) {
            return this.port;
        }

        if (this.port) {
            const alive = await this.healthCheck(this.port);
            if (alive) {
                this.healthChecked = true;
                return this.port;
            }
            this.port = null;
            this.healthChecked = false;
        }

        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            const port = this.readPortFile();
            if (port) {
                const alive = await this.healthCheck(port);
                if (alive) {
                    this.port = port;
                    this.healthChecked = true;
                    return port;
                }
            }

            if (attempt < MAX_RETRIES - 1) {
                await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
            }
        }

        return null;
    }

    private readPortFile(): number | null {
        try {
            const content = readFileSync(this.portFilePath, "utf-8").trim();
            const port = Number.parseInt(content, 10);
            if (Number.isNaN(port) || port <= 0 || port > 65535) {
                return null;
            }
            return port;
        } catch {
            return null;
        }
    }

    private async healthCheck(port: number): Promise<boolean> {
        try {
            const response = await this.fetchWithTimeout(`http://127.0.0.1:${port}/health`, {
                method: "GET",
            });
            return response.ok;
        } catch {
            return false;
        }
    }

    private async fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            return await fetch(url, { ...options, signal: controller.signal });
        } finally {
            clearTimeout(timeout);
        }
    }

    reset(): void {
        this.port = null;
        this.healthChecked = false;
    }
}

function isNonRetryableRpcError(err: unknown): err is NonRetryableRpcError {
    return typeof err === "object" && err !== null && NON_RETRYABLE_RPC_ERROR in err;
}
