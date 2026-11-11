import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** Optional per-run I/O accounting; request bodies are counted, never retained. */
export interface DumpScanMetrics {
    listings: number;
    directoryStats: number;
    fileStats: number;
    metaReads: number;
    bodyReads: number;
}

export function listDumpFiles(directory: string, metrics?: DumpScanMetrics): string[] {
    if (metrics) metrics.listings += 1;
    return readdirSync(directory);
}

interface ParsedDumpName {
    createdAt: string;
    sequence: number;
    session: string;
}

interface DumpNameEntry extends ParsedDumpName {
    file: string;
    timestamp: number;
}

interface DirectoryIndex {
    stamp: string;
    listedAt: number;
    sessions: Map<string, DumpNameEntry[]>;
    legacyFiles: string[];
    metadata: Map<string, { stamp: string; value: Record<string, unknown> }>;
}

// Fleet writes must not turn a shared listing back into one listing per batch.
// Arrivals wait until the listing is at least five seconds old or the next run,
// just as files written after a run ends already wait for the next run. Force a
// refresh after thirty seconds even when coarse directory timestamps hide writes.
const MIN_LISTING_AGE_MS = 5_000;
const MAX_LISTING_AGE_MS = 30_000;

/** Run-local names and small metadata only; normalized bodies must stay batch-local. */
export class DumpScanIndex {
    private directories = new Map<string, DirectoryIndex>();

    constructor(
        private parseFilename: (file: string) => ParsedDumpName | null,
        private metrics?: DumpScanMetrics,
    ) {}

    refresh(directory: string, now: number): void {
        const key = resolve(directory);
        const previous = this.directories.get(key);
        const ageMs = previous ? now - previous.listedAt : Infinity;
        if (ageMs < MIN_LISTING_AGE_MS) return;
        let stamp: string;
        try {
            if (this.metrics) this.metrics.directoryStats += 1;
            const stat = statSync(directory, { bigint: true });
            stamp = `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`;
        } catch {
            this.directories.delete(key);
            return;
        }
        if (previous?.stamp === stamp && ageMs < MAX_LISTING_AGE_MS) return;
        const sessions = new Map<string, DumpNameEntry[]>();
        const legacyFiles: string[] = [];
        const metadata: DirectoryIndex["metadata"] = new Map();
        for (const file of listDumpFiles(directory, this.metrics)) {
            if (!file.endsWith(".meta.json")) continue;
            const parsed = this.parseFilename(file);
            if (parsed) {
                const entries = sessions.get(parsed.session) ?? [];
                entries.push({ file, ...parsed, timestamp: Date.parse(parsed.createdAt) });
                sessions.set(parsed.session, entries);
            } else legacyFiles.push(file);
            const cached = previous?.metadata.get(file);
            if (cached) metadata.set(file, cached);
        }
        // Keep the stamp from BEFORE readdir: an arrival during the listing must
        // invalidate the next eligible check even if readdir omitted its name.
        this.directories.set(key, { stamp, listedAt: now, sessions, legacyFiles, metadata });
    }

    entries(directory: string, session: string): readonly DumpNameEntry[] {
        return this.directories.get(resolve(directory))?.sessions.get(session) ?? [];
    }

    contextFiles(directory: string, session: string): string[] {
        const index = this.directories.get(resolve(directory));
        return [...(index?.sessions.get(session) ?? []).map((entry) => entry.file), ...(index?.legacyFiles ?? [])];
    }

    metadata(directory: string, file: string, read: () => Record<string, unknown>): Record<string, unknown> {
        const index = this.directories.get(resolve(directory));
        if (!index) return read();
        if (this.metrics) this.metrics.fileStats += 1;
        const stat = statSync(join(directory, file), { bigint: true });
        const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
        const cached = index.metadata.get(file);
        if (cached?.stamp === stamp) return cached.value;
        const value = read();
        // Unexpectedly large metadata must not turn the run cache into a body store.
        if (JSON.stringify(value).length <= 8_192) index.metadata.set(file, { stamp, value });
        else index.metadata.delete(file);
        return value;
    }
}
