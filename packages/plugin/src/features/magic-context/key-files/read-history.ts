import { realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { Database } from "../../../shared/sqlite";

export interface ReadRange {
    start: number;
    end: number;
    count: number;
    lastReadAt: number;
}

export interface KeyFileCandidate {
    path: string;
    totalReads: number;
    rangedReads: number;
    fullReads: number;
    editCount: number;
    latestReadBytes: number;
    firstReadAt: number;
    lastReadAt: number;
    ranges: ReadRange[];
}

interface RawReadRow {
    session_id: string;
    file_path: string | null;
    start_line: number | null;
    end_line: number | null;
    offset_value: number | null;
    limit_value: number | null;
    output_bytes: number | null;
    time_created: number | string | null;
}

function toMs(value: number | string | null): number {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
        const n = Number(value);
        if (Number.isFinite(n)) return n;
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return 0;
}

function toPositiveInt(value: unknown): number | null {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export function coalesceRanges(ranges: ReadRange[]): ReadRange[] {
    if (ranges.length === 0) return [];
    const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
    const merged: ReadRange[] = [];
    for (const range of sorted) {
        const last = merged.at(-1);
        if (last && range.start <= last.end + 10) {
            last.end = Math.max(last.end, range.end);
            last.count += range.count;
            last.lastReadAt = Math.max(last.lastReadAt, range.lastReadAt);
        } else {
            merged.push({ ...range });
        }
    }
    return merged.sort((a, b) => b.lastReadAt - a.lastReadAt || b.count - a.count).slice(0, 3);
}

function normalizeProjectRelativePath(projectPath: string, filePath: string): string | null {
    const root = realpathSync(projectPath);
    const abs = filePath.startsWith("/") ? resolve(filePath) : resolve(root, filePath);
    let real = abs;
    try {
        real = realpathSync(abs);
    } catch {
        // Reads may refer to a now-deleted path. Keep the lexical under-root check.
    }
    if (!real.startsWith(`${root}/`) && real !== root) return null;
    const rel = relative(root, real).replaceAll("\\", "/");
    if (!rel || rel.startsWith("..")) return null;
    return rel;
}

function primarySessionIds(db: Database): Set<string> {
    try {
        const rows = db
            .prepare("SELECT session_id AS sessionId FROM session_meta WHERE is_subagent = 0")
            .all() as Array<{ sessionId: string }>;
        return new Set(rows.map((row) => row.sessionId));
    } catch {
        return new Set();
    }
}

export function collectKeyFileCandidates(args: {
    openCodeDb: Database;
    magicDb: Database;
    projectPath: string;
    minReads: number;
}): KeyFileCandidate[] {
    const primaryIds = primarySessionIds(args.magicDb);
    if (primaryIds.size === 0) return [];

    const reads = args.openCodeDb
        .prepare(
            `SELECT p.session_id,
                    json_extract(json_extract(p.data, '$.state'), '$.input.filePath') AS file_path,
                    json_extract(json_extract(p.data, '$.state'), '$.input.startLine') AS start_line,
                    json_extract(json_extract(p.data, '$.state'), '$.input.endLine') AS end_line,
                    json_extract(json_extract(p.data, '$.state'), '$.input.offset') AS offset_value,
                    json_extract(json_extract(p.data, '$.state'), '$.input.limit') AS limit_value,
                    LENGTH(json_extract(json_extract(p.data, '$.state'), '$.output')) AS output_bytes,
                    p.time_created
               FROM part p
              WHERE json_extract(p.data, '$.type') = 'tool'
                AND json_extract(p.data, '$.tool') = 'read'
                AND json_extract(json_extract(p.data, '$.state'), '$.input.filePath') IS NOT NULL`,
        )
        .all() as RawReadRow[];

    const byPath = new Map<string, KeyFileCandidate & { rangeMap: Map<string, ReadRange> }>();
    for (const row of reads) {
        if (!primaryIds.has(row.session_id) || !row.file_path) continue;
        const rel = normalizeProjectRelativePath(args.projectPath, row.file_path);
        if (!rel) continue;
        const timestamp = toMs(row.time_created);
        const candidate =
            byPath.get(rel) ??
            ({
                path: rel,
                totalReads: 0,
                rangedReads: 0,
                fullReads: 0,
                editCount: 0,
                latestReadBytes: 0,
                firstReadAt: timestamp || Date.now(),
                lastReadAt: 0,
                ranges: [],
                rangeMap: new Map<string, ReadRange>(),
            } satisfies KeyFileCandidate & { rangeMap: Map<string, ReadRange> });
        candidate.totalReads++;
        candidate.firstReadAt = Math.min(candidate.firstReadAt, timestamp || candidate.firstReadAt);
        candidate.lastReadAt = Math.max(candidate.lastReadAt, timestamp);
        if (timestamp >= candidate.lastReadAt)
            candidate.latestReadBytes = Number(row.output_bytes ?? 0);

        const start = toPositiveInt(row.start_line) ?? toPositiveInt(row.offset_value);
        const explicitEnd = toPositiveInt(row.end_line);
        const limit = toPositiveInt(row.limit_value);
        const end = explicitEnd ?? (start && limit ? start + limit - 1 : null);
        if (start && end) {
            candidate.rangedReads++;
            const key = `${start}:${end}`;
            const existing = candidate.rangeMap.get(key);
            if (existing) {
                existing.count++;
                existing.lastReadAt = Math.max(existing.lastReadAt, timestamp);
            } else {
                candidate.rangeMap.set(key, { start, end, count: 1, lastReadAt: timestamp });
            }
        } else {
            candidate.fullReads++;
        }
        byPath.set(rel, candidate);
    }

    const edits = args.openCodeDb
        .prepare(
            `SELECT p.session_id,
                    json_extract(json_extract(p.data, '$.state'), '$.input.filePath') AS file_path,
                    COUNT(*) AS edit_count
               FROM part p
              WHERE json_extract(p.data, '$.type') = 'tool'
                AND json_extract(p.data, '$.tool') IN ('edit', 'write', 'mcp_edit', 'mcp_write')
                AND json_extract(json_extract(p.data, '$.state'), '$.input.filePath') IS NOT NULL
              GROUP BY p.session_id, file_path`,
        )
        .all() as Array<{ session_id: string; file_path: string | null; edit_count: number }>;
    for (const row of edits) {
        if (!primaryIds.has(row.session_id) || !row.file_path) continue;
        const rel = normalizeProjectRelativePath(args.projectPath, row.file_path);
        if (!rel) continue;
        const candidate = byPath.get(rel);
        if (candidate) candidate.editCount += Number(row.edit_count ?? 0);
    }

    return [...byPath.values()]
        .filter((candidate) => candidate.totalReads >= args.minReads)
        .map(({ rangeMap, ...candidate }) => ({
            ...candidate,
            ranges: coalesceRanges([...rangeMap.values()]),
        }))
        .sort((a, b) => b.totalReads - a.totalReads || b.lastReadAt - a.lastReadAt)
        .slice(0, 200);
}
