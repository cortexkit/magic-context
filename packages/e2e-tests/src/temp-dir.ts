import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { e2eTempRoot } from "./root-environment";

const roots = new Set<string>();

export function cleanupE2ETempDir(root: string): void {
    if (!roots.delete(root)) return;
    if (process.env.MC_E2E_KEEP === "1") {
        console.error(`[e2e] kept fixture: ${root}`);
        return;
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

export function createE2ETempDir(prefix: string): string {
    const root = realpathSync(mkdtempSync(join(e2eTempRoot(), prefix)));
    roots.add(root);
    return root;
}

// Caller-owned environments may span host restarts. Retain them until the test
// process exits; runner-owned environments are removed by their stop methods.
process.once("exit", () => {
    for (const root of roots) cleanupE2ETempDir(root);
});
