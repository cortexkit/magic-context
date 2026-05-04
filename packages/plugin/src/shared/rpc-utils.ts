import { createHash } from "node:crypto";
import { join } from "node:path";

/**
 * Stable hash for a project directory — scopes RPC port files per-project
 * so multiple OpenCode instances don't collide.
 */
export function projectHash(directory: string): string {
    const normalized = directory.replace(/\/+$/, "");
    return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/** Per-project RPC port file path. */
export function rpcPortFilePath(storageDir: string, directory: string): string {
    return join(storageDir, "rpc", projectHash(directory), "port");
}
