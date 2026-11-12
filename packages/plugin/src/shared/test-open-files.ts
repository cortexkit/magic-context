import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";

export interface OpenFileEntry {
    path: string;
    descriptor?: number;
}

export type OpenFilesResult =
    | { available: true; paths: string[]; entries: OpenFileEntry[] }
    | { available: false; reason: string };

/** Parse lsof's name fields without interpreting its padded human-readable table. */
export function parseLsofPaths(output: string): string[] {
    return output
        .split("\n")
        .filter((line) => line.startsWith("n"))
        .map((line) => line.slice(1));
}

function processIdentity(pid: number): string {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (["Z", "X", "x"].includes(fields[0] ?? "")) throw new Error(`Process ${pid} has exited`);
    const startTime = fields[19];
    if (!startTime) throw new Error(`Cannot read identity for process ${pid}`);
    return startTime; // Start time distinguishes a reused PID from the requested process.
}

/** Test-only inventory; callers decide whether an unavailable check can be skipped. */
export function listOpenFiles(pid = process.pid): OpenFilesResult {
    try {
        if (process.platform === "linux") {
            // /proc avoids subprocess output limits and lsof's overlay-mount warnings.
            const directory = pid === process.pid ? "/proc/self/fd" : `/proc/${pid}/fd`;
            const identity = pid === process.pid ? undefined : processIdentity(pid);
            const entries: OpenFileEntry[] = [];
            for (const descriptor of readdirSync(directory)) {
                try {
                    entries.push({
                        descriptor: Number(descriptor),
                        path: readlinkSync(`${directory}/${descriptor}`),
                    });
                } catch (error) {
                    // The listing's own directory handle, or any concurrent close, can vanish.
                    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                }
            }
            if (identity !== undefined && processIdentity(pid) !== identity)
                throw new Error(`Process ${pid} changed during the inventory`);
            return { available: true, paths: entries.map((entry) => entry.path), entries };
        }
        if (process.platform === "darwin") {
            const paths = parseLsofPaths(
                execFileSync("lsof", ["-p", String(pid), "-Fn"], {
                    encoding: "utf8",
                    maxBuffer: 64 * 1024 * 1024,
                    timeout: 10_000,
                    windowsHide: true,
                }),
            );
            return { available: true, paths, entries: paths.map((path) => ({ path })) };
        }
        return {
            available: false,
            reason: `Open-file inventory is unavailable on ${process.platform}`,
        };
    } catch (error) {
        return { available: false, reason: error instanceof Error ? error.message : String(error) };
    }
}
