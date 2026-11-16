import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** One historian dump file, as listed by doctor before its XML is parsed. */
export interface HistorianDumpFile {
    name: string;
    mtime: number;
    sizeKb: number;
}

/** A session's dump directory with its dump files, newest first. */
export interface HistorianSessionDumpDir {
    /** Directory name: the session id, reduced to filename-safe characters by the plugin. */
    sessionId: string;
    dir: string;
    files: HistorianDumpFile[];
}

/**
 * The `*.xml` files directly in `dir`, newest first. A missing or unreadable
 * directory has no dumps, so doctor never fails on it.
 */
export function scanHistorianDumpFiles(dir: string): HistorianDumpFile[] {
    if (!existsSync(dir)) return [];
    try {
        return readdirSync(dir)
            .filter((name) => name.endsWith(".xml"))
            .map((name) => {
                const stat = statSync(join(dir, name));
                return { name, mtime: stat.mtimeMs, sizeKb: Math.round(stat.size / 1024) };
            })
            .sort((a, b) => b.mtime - a.mtime);
    } catch {
        return [];
    }
}

/**
 * The per-session dump directories under a harness's historian root that hold
 * at least one dump, ordered by their newest dump, newest first. Only the file
 * listings are read here; callers parse the XML of the few dumps they report.
 */
export function scanHistorianSessionDumpDirs(root: string): HistorianSessionDumpDir[] {
    if (!existsSync(root)) return [];
    const sessions: HistorianSessionDumpDir[] = [];
    try {
        for (const entry of readdirSync(root, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const dir = join(root, entry.name);
            const files = scanHistorianDumpFiles(dir);
            if (files.length > 0) sessions.push({ sessionId: entry.name, dir, files });
        }
    } catch {
        return [];
    }
    return sessions.sort((a, b) => (b.files[0]?.mtime ?? 0) - (a.files[0]?.mtime ?? 0));
}
