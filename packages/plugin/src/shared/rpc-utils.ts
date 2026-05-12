import { createHash } from "node:crypto";
import { join } from "node:path";

export interface RpcPortFileRecord {
    port: number;
    pid: number;
    started_at: number;
}

/**
 * Stable hash for a project directory — scopes RPC port files per-project
 * so multiple OpenCode instances don't collide.
 */
export function projectHash(directory: string): string {
    const normalized = directory.replace(/\/+$/, "");
    return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/** Directory containing per-process RPC discovery files for a project. */
export function rpcPortDir(storageDir: string, directory: string): string {
    return join(storageDir, "rpc", projectHash(directory));
}

/** Per-process RPC port file path. */
export function rpcPortFilePath(storageDir: string, directory: string, pid = process.pid): string {
    return join(rpcPortDir(storageDir, directory), `port-${pid}.json`);
}

/** Legacy single-port file used by v0.18.0 and earlier. */
export function legacyRpcPortFilePath(storageDir: string, directory: string): string {
    return join(rpcPortDir(storageDir, directory), "port");
}

export function isPidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
    }
}

export function parseRpcPortFile(content: string, fallbackPid = 0): RpcPortFileRecord | null {
    const trimmed = content.trim();
    if (!trimmed) return null;

    if (trimmed.startsWith("{")) {
        try {
            const parsed = JSON.parse(trimmed) as Partial<RpcPortFileRecord>;
            const port = Number(parsed.port);
            const pid = Number(parsed.pid);
            const startedAt = Number(parsed.started_at);
            if (!isValidPort(port) || !Number.isInteger(pid) || pid <= 0) return null;
            return {
                port,
                pid,
                started_at: Number.isFinite(startedAt) ? startedAt : 0,
            };
        } catch {
            return null;
        }
    }

    const port = Number.parseInt(trimmed, 10);
    if (!isValidPort(port)) return null;
    return { port, pid: fallbackPid, started_at: 0 };
}

function isValidPort(port: number): boolean {
    return Number.isInteger(port) && port > 0 && port <= 65535;
}
