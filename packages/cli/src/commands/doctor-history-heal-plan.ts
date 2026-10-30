import { createHash } from "node:crypto";
import { buildCompactionMarkerRows } from "@magic-context/core/features/magic-context/compaction-marker";
import { getRecompPartialRange } from "@magic-context/core/features/magic-context/compartment-storage";
import {
    getHistoryHealQueue,
    type HistoryHealRecomp,
} from "@magic-context/core/features/magic-context/history-heal-queue";
import { getM0MutationsBySession } from "@magic-context/core/features/magic-context/storage-m0-mutation-log";
import {
    getPendingCompactionMarkerState,
    getPersistedCompactionMarkerState,
    getPersistedCompactionMarkerTargets,
    loadProtectedTailMeta,
    type PersistedCompactionMarkerState,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { areRustHistorianSyntheticParts } from "@magic-context/core/hooks/magic-context/read-session-raw";
import type { Database } from "@magic-context/core/shared/sqlite";

export type Row = Record<string, any>;
export interface Rewrite {
    store: "context" | "host";
    table: string;
    key: Row;
    before: Row | null;
    after: Row | null;
    reason: string;
}
export interface HealMeta {
    marker: PersistedCompactionMarkerState | null;
    partial: { start: number; end: number } | null;
    floor: number;
    queue: HistoryHealRecomp[];
    mutations: { mutationType: string; targetId: number | null }[];
    pending: ReturnType<typeof getPendingCompactionMarkerState>;
    markerTargets: ReturnType<typeof getPersistedCompactionMarkerTargets>;
}
export interface HealSession {
    id: string;
    title: string;
    refusals: { code: string; message: string }[];
    rewrites: Rewrite[];
    metaBefore: HealMeta;
    metaAfter: HealMeta;
    before: { context: string; host: string };
    after: { context: string; host: string };
    historicalNumbers: { historianRuns: number; userMemoryCandidates: number };
    unrecoverableArchiveEntries: number;
    cut: number | null;
}
export interface HistoryHealPlan {
    version: 1;
    counting: "opencode1-created-id-finished-summary-v1";
    dbPath: string;
    hostDbPath: string;
    schemaVersion: number;
    sessions: HealSession[];
}

const TABLES = [
    "compartments",
    "recomp_compartments",
    "compartment_chunk_embeddings",
    "notes",
    "primer_candidates",
    "user_memory_candidates",
    "historian_runs",
    "compression_depth",
    "message_history_source",
    "message_history_fts",
    "message_fts_rowid_map",
    "message_history_index",
    "message_time_backfill_state",
    "tags",
];
const HOST_TABLES = ["message", "part"];
export const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
export function hasMode3MoveRecord(db: Database, sessionId: string): boolean {
    // offline_move.rs::move_record_key marks the handoff out of standalone ownership.
    return Boolean(
        db
            .prepare("SELECT 1 FROM schema_migrations_meta WHERE key=?")
            .get(`mode3_move:opencode:${sessionId}`),
    );
}
export function canonical(value: unknown): string {
    return JSON.stringify(value, (_key, v) => {
        if (v instanceof Uint8Array) return { bytes: Buffer.from(v).toString("base64") };
        if (v?.type === "Buffer" && Array.isArray(v.data))
            return { bytes: Buffer.from(v.data).toString("base64") };
        if (v && typeof v === "object" && !Array.isArray(v))
            return Object.fromEntries(
                Object.keys(v)
                    .sort()
                    .map((k) => [k, v[k]]),
            );
        return v;
    });
}
export function readHealMeta(db: Database, id: string): HealMeta {
    return {
        marker: getPersistedCompactionMarkerState(db, id),
        partial: getRecompPartialRange(db, id),
        floor: loadProtectedTailMeta(db, id).priorBoundaryOrdinal,
        queue: getHistoryHealQueue(db, id),
        mutations: getM0MutationsBySession(db, id).map(({ mutationType, targetId }) => ({
            mutationType,
            targetId,
        })),
        pending: getPendingCompactionMarkerState(db, id),
        markerTargets: getPersistedCompactionMarkerTargets(db, id),
    };
}
function rows(db: Database, table: string, id: string): Row[] {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table)) return [];
    const select = table === "message_history_fts" ? "rowid AS rowid,*" : "*";
    const owner = table === "message_time_backfill_state" ? "cursor_session_id" : "session_id";
    return db.prepare(`SELECT ${select} FROM ${quote(table)} WHERE ${owner}=?`).all(id) as Row[];
}
export function inventory(db: Database, id: string, host = false): Record<string, Row[]> {
    return Object.fromEntries((host ? HOST_TABLES : TABLES).map((t) => [t, rows(db, t, id)]));
}
export function digest(tables: Record<string, Row[]>, meta?: HealMeta): string {
    const hash = createHash("sha256");
    for (const table of Object.keys(tables).sort()) {
        hash.update(table);
        const key = (r: Row): string | number =>
            r.id ?? r.rowid ?? r.message_id ?? r.fts_rowid ?? r.message_ordinal ?? r.session_id;
        for (const row of [...tables[table]].sort((a, b) =>
            key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0,
        ))
            hash.update(canonical(row)).update("\n");
    }
    if (meta) hash.update(canonical(meta));
    return hash.digest("hex");
}
function projected(tables: Record<string, Row[]>, changes: Rewrite[]): Record<string, Row[]> {
    const out: Record<string, (Row | null)[]> = Object.fromEntries(
        Object.entries(tables).map(([t, rs]) => [t, rs.map((r) => ({ ...r }))]),
    );
    const indexes = new Map<string, Map<string, number>>();
    for (const change of changes) {
        const rs = out[change.table];
        const keys = Object.keys(change.key).sort();
        const indexKey = `${change.table}:${keys.join(",")}`;
        let index = indexes.get(indexKey);
        if (!index) {
            index = new Map(
                rs.flatMap((r, i) => (r ? [[canonical(keys.map((k) => r[k])), i] as const] : [])),
            );
            indexes.set(indexKey, index);
        }
        const key = canonical(keys.map((k) => change.key[k]));
        const i = index.get(key);
        if (change.after === null) {
            if (i !== undefined) rs[i] = null;
            index.delete(key);
        } else if (i === undefined) {
            index.set(key, rs.length);
            rs.push({ ...change.after });
        } else rs[i] = { ...rs[i], ...change.after };
    }
    return Object.fromEntries(
        Object.entries(out).map(([t, rs]) => [t, rs.filter((r): r is Row => r !== null)]),
    );
}
function json(row: Row | undefined): Row {
    try {
        return JSON.parse(row?.data ?? "null") ?? {};
    } catch {
        return {};
    }
}
function summary(row: Row): boolean {
    const j = json(row);
    return (j.summary === true || j.summary === 1) && j.finish === "stop";
}
function ordered(rs: Row[]): Row[] {
    return [...rs].sort(
        (a, b) => a.time_created - b.time_created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}
export function selectHealMarker(
    messages: Row[],
    parts: Row[],
): { carrier: Row; summary: Row } | null {
    const completed = new Map<string, Row>();
    const carriers = new Set(
        parts.filter((p) => json(p).type === "compaction").map((p) => p.message_id),
    );
    // Match OpenCode's loader: scan newest-first for a user with a compaction part and a
    // completed, error-free child summary. Timestamp alone cannot identify the active pair.
    for (const row of ordered(messages).reverse()) {
        const j = json(row);
        if (j.role === "user" && carriers.has(row.id) && completed.has(row.id))
            return { carrier: row, summary: completed.get(row.id)! };
        if (
            j.role === "assistant" &&
            j.summary &&
            j.finish &&
            !j.error &&
            typeof j.parentID === "string" &&
            !completed.has(j.parentID)
        )
            completed.set(j.parentID, row);
    }
    return null;
}
function owned(row: Row): boolean {
    const j = json(row);
    return (
        summary(row) &&
        j.role === "assistant" &&
        j.modelID === "magic-context" &&
        j.providerID === "magic-context"
    );
}
function eligible(row: Row, parts: Map<string, Row[]>): boolean {
    if (json(row).role !== "user" || summary(row)) return false;
    const ps = (parts.get(row.id) ?? []).filter((p) => json(p).type !== "compaction");
    return !ps.length || ps.some((p) => !json(p).synthetic && !json(p).syntheticTodoMarker);
}

export function planHealSession(db: Database, host: Database, id: string): HealSession {
    const ctx = inventory(db, id),
        hs = inventory(host, id, true);
    const meta = readHealMeta(db, id);
    const session = host.prepare("SELECT title FROM session WHERE id=?").get(id) as Row | undefined;
    const plan: HealSession = {
        id,
        title: session?.title ?? id,
        refusals: [],
        rewrites: [],
        metaBefore: meta,
        metaAfter: structuredClone(meta),
        before: { context: digest(ctx, meta), host: digest(hs) },
        after: { context: "", host: "" },
        historicalNumbers: { historianRuns: 0, userMemoryCandidates: 0 },
        unrecoverableArchiveEntries: 0,
        cut: null,
    };
    const refuse = (code: string, message: string): never => {
        throw Object.assign(new Error(message), { code });
    };
    const change = (
        table: string,
        row: Row | null,
        after: Row | null,
        reason: string,
        key?: Row,
        store: "host" | "context" = "context",
    ) => {
        const before =
            row === null
                ? null
                : after === null
                  ? row
                  : Object.fromEntries(Object.keys(after).map((k) => [k, row[k]]));
        if (canonical(before) === canonical(after)) return;
        plan.rewrites.push({
            store,
            table,
            key: key ?? { id: row?.id ?? after?.id },
            before,
            after,
            reason,
        });
    };
    try {
        if (!session || !ctx.compartments.length)
            refuse("missing_history", "No standalone OpenCode 1 history for this session");
        if (ctx.compartments.some((c) => c.harness !== "opencode"))
            refuse("foreign_history", "History belongs to another harness");
        if (hasMode3MoveRecord(db, id))
            refuse(
                "already_moved",
                "Session has moved to mode 3; standalone history heal must not change it",
            );
        if (getPendingCompactionMarkerState(db, id))
            refuse("pending_marker", "retry after the pending marker settles");
        if ([...ctx.compartments, ...ctx.recomp_compartments].some((c) => c.rebase_status !== "ok"))
            refuse(
                "unresolved_rebase",
                "Resolve the session's coordinate rebase before healing history",
            );
        if (ctx.recomp_compartments.length || meta.partial)
            refuse("active_recomp", "Finish the active recomp before healing history");
        const messages = ordered(hs.message),
            raw = messages.filter((m) => !summary(m));
        const ordinal = new Map(raw.map((m, i) => [m.id, i + 1]));
        const ordinalFor = (mid: string): number | undefined =>
            ordinal.get(mid) ?? ordinal.get(mid.replace(/#\d+$/, ""));
        const parts = new Map<string, Row[]>();
        for (const p of hs.part) {
            const ps = parts.get(p.message_id) ?? [];
            ps.push(p);
            parts.set(p.message_id, ps);
        }
        const at = (n: number): string => {
            if (!raw[n - 1]) refuse("missing_endpoint", `No counted message at ${n}`);
            return raw[n - 1].id;
        };
        const pos = (mid: string): number => {
            const n = ordinalFor(mid);
            if (!n)
                refuse(
                    "missing_endpoint",
                    `Message id ${mid || "(empty)"} is not counted in the host`,
                );
            return n!;
        };
        const cs = [...ctx.compartments].sort((a, b) => a.sequence - b.sequence);
        const healed: Row[] = [];
        const affected = new Set<number>();
        let previous = 0;
        for (let i = 0; i < cs.length; i++) {
            const c = cs[i];
            let start: number;
            // Legacy block-index rows sometimes omitted the start ID. Use the message after
            // the previous compartment's end, or message 1 for the first compartment.
            if (!c.start_message_id && (c.start_block_index !== null || c.end_block_index !== null))
                start = previous + 1;
            else start = pos(c.start_message_id);
            let end = pos(c.end_message_id);
            if (start > end)
                refuse("inverted_range", `Summary ${c.sequence} has an inverted identity range`);
            if ((c.start_message_id && start !== c.start_message) || end !== c.end_message) {
                for (let n = c.start_message; n <= c.end_message; n++) affected.add(n);
            }
            if (i === cs.length - 1 && c.end_block_index !== null) end--;
            if (start > previous + 1) {
                const owner = healed[healed.length - 1];
                const gapStart = previous + 1,
                    gapEnd = start - 1;
                const needsRecomp = raw
                    .slice(gapStart - 1, gapEnd)
                    .some(
                        (m) => !areRustHistorianSyntheticParts((parts.get(m.id) ?? []).map(json)),
                    );
                if (owner) {
                    owner.end_message = gapEnd;
                    owner.end_message_id = at(gapEnd);
                    if (needsRecomp)
                        plan.metaAfter.queue.push({
                            start: owner.start_message,
                            end: gapEnd,
                            sequence: owner.sequence,
                            gapStart,
                            gapEnd,
                        });
                    previous = gapEnd;
                } else {
                    if (needsRecomp)
                        plan.metaAfter.queue.push({
                            start: 1,
                            end,
                            sequence: c.sequence,
                            gapStart: 1,
                            gapEnd,
                        });
                }
            }
            start = previous + 1;
            if (start > end)
                refuse(
                    "swallowed_summary",
                    `Summary ${c.sequence} has no whole message after trimming`,
                );
            healed.push({
                ...c,
                start_message: start,
                end_message: end,
                start_message_id: at(start),
                end_message_id: at(end),
                start_block_index: null,
                end_block_index: null,
            });
            previous = end;
        }
        for (let i = 0; i < cs.length; i++) {
            const c = healed[i];
            change(
                "compartments",
                cs[i],
                Object.fromEntries(
                    [
                        "start_message",
                        "end_message",
                        "start_message_id",
                        "end_message_id",
                        "start_block_index",
                        "end_block_index",
                    ].map((k) => [k, c[k]]),
                ),
                "recount identities and tile whole-message summaries",
            );
        }
        const selected = selectHealMarker(messages, hs.part);
        if (!selected || !owned(selected.summary))
            refuse(
                "foreign_or_missing_marker",
                "OpenCode does not load a Magic Context marker pair",
            );
        const pair = selected!;
        const compactions = (parts.get(pair.carrier.id) ?? []).filter(
            (p) => json(p).type === "compaction",
        );
        const texts = (parts.get(pair.summary.id) ?? []).filter((p) => json(p).type === "text");
        if (compactions.length !== 1 || texts.length !== 1)
            refuse(
                "ambiguous_marker",
                "Selected marker must have one compaction part and one summary text part",
            );
        if (json(compactions[0]).tail_start_id)
            refuse(
                "unsupported_marker",
                "A tail_start_id marker requires the host's tail-aware loader",
            );
        const boundaryFor = (n: number): Row | undefined =>
            raw
                .slice(0, n)
                .reverse()
                .find((m) => eligible(m, parts));
        let target: Row | undefined;
        const recorded = meta.marker;
        if (
            recorded &&
            recorded.summaryMessageId === pair.summary.id &&
            recorded.targetEndMessageId
        ) {
            const oldTarget = recorded.targetEndMessageId;
            target = healed.find((c) => c.end_message_id === oldTarget);
            // The newest partial endpoint was deliberately returned to raw history.
            if (
                !target &&
                cs[cs.length - 1].end_message_id === oldTarget &&
                cs[cs.length - 1].end_block_index !== null
            )
                target = healed[healed.length - 1];
            if (!target)
                refuse(
                    "marker_coverage",
                    `Recorded fold target ${oldTarget} is not a healed summary endpoint`,
                );
        } else {
            target = healed[healed.length - 1];
            if (boundaryFor(target.end_message)?.id !== pair.carrier.id)
                refuse(
                    "marker_coverage",
                    "Host winner does not match the healed newest summary frontier",
                );
            const safe = messages.filter((m) => owned(m) && json(m).parentID === pair.carrier.id);
            if (safe.length !== 1)
                refuse(
                    "ambiguous_marker",
                    "Two candidate safe Magic Context pairs at the frontier",
                );
        }
        const t = target!;
        const movedNewest =
            cs[cs.length - 1].end_block_index !== null && t === healed[healed.length - 1];
        const relocationBoundary = movedNewest ? boundaryFor(t.end_message) : undefined;
        const replacement = relocationBoundary
            ? buildCompactionMarkerRows(
                  {
                      sessionId: id,
                      endOrdinal: t.end_message,
                      endMessageId: t.end_message_id,
                      summaryText: json(texts[0]).text,
                      directory: json(pair.summary).path?.cwd ?? "",
                  },
                  { id: relocationBoundary.id, timeCreated: relocationBoundary.time_created },
              )
            : null;
        // A crash can leave the canonical replacement committed before context metadata.
        // Recognize those exact rows so re-planning host-after never proposes another host write.
        const replacementPresent =
            replacement &&
            canonical(pair.summary) === canonical(replacement.message) &&
            canonical(compactions[0]) === canonical(replacement.compaction) &&
            canonical(texts[0]) === canonical(replacement.text);
        const relocate = movedNewest && !replacementPresent;
        if (!relocate && boundaryFor(t.end_message)?.id !== pair.carrier.id)
            refuse("marker_coverage", "Host marker disagrees with summary coverage");
        let marker: PersistedCompactionMarkerState = {
            boundaryMessageId: pair.carrier.id,
            summaryMessageId: pair.summary.id,
            compactionPartId: compactions[0].id,
            summaryPartId: texts[0].id,
            boundaryOrdinal: t.end_message,
            targetEndMessageId: t.end_message_id,
        };
        // Retire only positively owned pairs, never their user carriers or unrelated parts.
        const retired = new Set<string>();
        for (const m of messages.filter(owned)) {
            if (m.id === pair.summary.id && !relocate) continue;
            const parent = json(m).parentID;
            const cps = (parts.get(parent) ?? []).filter((p) => json(p).type === "compaction");
            if (
                cps.length !== 1 ||
                json(cps[0]).auto !== true ||
                Object.keys(json(cps[0])).sort().join(",") !== "auto,type"
            )
                refuse("orphan_ownership", `Cannot prove ownership of marker ${m.id}`);
            if (
                (relocate || parent !== pair.carrier.id) &&
                messages.some((sibling) => {
                    const info = json(sibling);
                    return (
                        !owned(sibling) &&
                        info.role === "assistant" &&
                        info.parentID === parent &&
                        info.summary &&
                        info.finish &&
                        !info.error
                    );
                })
            )
                refuse(
                    "shared_foreign_marker",
                    `Compaction part on ${parent} also belongs to a native or foreign summary`,
                );
            const mps = parts.get(m.id) ?? [];
            if (mps.filter((p) => json(p).type === "text").length !== 1)
                refuse("orphan_ownership", `Marker ${m.id} is missing a unique text part`);
            if (mps.some((p) => !["text", "step-start", "step-finish"].includes(json(p).type)))
                refuse("orphan_ownership", `Marker ${m.id} has unrelated parts`);
            for (const p of mps)
                change(
                    "part",
                    p,
                    null,
                    "retire obsolete Magic Context marker text",
                    undefined,
                    "host",
                );
            change("message", m, null, "retire obsolete Magic Context summary", undefined, "host");
            if (!retired.has(cps[0].id) && !(parent === pair.carrier.id && !relocate)) {
                change(
                    "part",
                    cps[0],
                    null,
                    "retire obsolete Magic Context compaction part",
                    undefined,
                    "host",
                );
                retired.add(cps[0].id);
            }
        }
        if (relocate) {
            const boundary = boundaryFor(t.end_message);
            if (!boundary)
                refuse("marker_relocation", "No eligible user carrier before the healed fold end");
            if (
                messages.some(
                    (m) =>
                        m.id !== pair.summary.id &&
                        m.id !== boundary!.id &&
                        m.time_created >= boundary!.time_created &&
                        m.time_created <= boundary!.time_created + 1,
                )
            )
                refuse(
                    "marker_collision",
                    "Relocated marker would collide with another host message",
                );
            const built = replacement!;
            for (const [table, row] of [
                ["part", built.compaction],
                ["message", built.message],
                ["part", built.text],
            ] as const) {
                if (
                    hs[table].some((r) => r.id === row.id) &&
                    !plan.rewrites.some(
                        (r) =>
                            r.store === "host" &&
                            r.table === table &&
                            r.key.id === row.id &&
                            r.after === null,
                    )
                )
                    refuse("marker_id_collision", `Marker id already exists: ${row.id}`);
                change(
                    table,
                    null,
                    row,
                    "relocate with plugin marker writer",
                    { id: row.id },
                    "host",
                );
            }
            marker = {
                ...built.marker,
                boundaryOrdinal: t.end_message,
                targetEndMessageId: t.end_message_id,
            };
        }
        const projectedHost = projected(
            hs,
            plan.rewrites.filter((r) => r.store === "host"),
        );
        const loaded = selectHealMarker(projectedHost.message, projectedHost.part);
        if (loaded?.summary.id !== marker.summaryMessageId)
            refuse("marker_shadowed", "Another marker shadows the healed marker");
        plan.metaAfter.marker = marker;
        plan.metaAfter.markerTargets = {
            jsonTarget: marker.targetEndMessageId,
            columnTarget: marker.targetEndMessageId,
        };
        const starts = new Set(healed.map((c) => c.start_message));
        starts.add(t.end_message + 1);
        const occupiedTimes = new Map<number, number>();
        for (const m of messages)
            if (!owned(m))
                occupiedTimes.set(m.time_created, (occupiedTimes.get(m.time_created) ?? 0) + 1);
        const cut = [...starts]
            .filter(
                (n) =>
                    n > 1 &&
                    n <= t.end_message + 1 &&
                    raw[n - 1] &&
                    eligible(raw[n - 1], parts) &&
                    (occupiedTimes.get(raw[n - 1].time_created) ?? 0) === 1 &&
                    !occupiedTimes.has(raw[n - 1].time_created + 1),
            )
            .sort((a, b) => b - a)[0];
        if (!cut || !healed.some((c) => c.end_message === cut - 1))
            plan.refusals.push({
                code: "no_clean_cut",
                message:
                    "needs a normal fold before moving: no eligible user at a summary start or at T+1",
            });
        plan.cut = cut ?? null;
        const files = ctx.tags
            .filter((tag) => tag.status === "dropped" && tag.type === "file")
            .map((tag) => ({
                tag,
                n: ordinal.get(String(tag.message_id).replace(/:file\d+$/, "")),
            }))
            .filter((x) => x.n !== undefined && cut !== undefined && x.n! >= cut);
        if (files.length)
            plan.refusals.push({
                code: "kept_file_drop",
                message: `needs a normal fold past message ${Math.max(...files.map((x) => x.n!))} before moving (${files.length} dropped files in the kept window)`,
            });
        if (!files.length) {
            plan.unrecoverableArchiveEntries = new Set(
                [...ctx.message_history_source, ...ctx.message_history_fts]
                    .filter((r) => !ordinalFor(r.message_id))
                    .map((r) => r.message_id),
            ).size;
            const oldToNew = new Map<number, Set<number>>();
            for (const r of ctx.message_history_source) {
                const n = ordinalFor(r.message_id);
                if (!n) continue;
                const set = oldToNew.get(r.message_ordinal) ?? new Set<number>();
                set.add(n!);
                oldToNew.set(r.message_ordinal, set);
                if (n !== r.message_ordinal) affected.add(r.message_ordinal);
                change(
                    "message_history_source",
                    r,
                    { message_ordinal: n },
                    "recount search source by message id",
                    { session_id: id, message_id: r.message_id },
                );
            }
            for (const r of ctx.message_history_fts) {
                const n = ordinalFor(r.message_id);
                if (n)
                    change(
                        "message_history_fts",
                        r,
                        { message_ordinal: n },
                        "recount FTS by message id",
                        { rowid: r.rowid },
                    );
            }
            const fts = new Map(ctx.message_history_fts.map((r) => [r.rowid, r]));
            const destinations = new Map<number, number>();
            for (const r of ctx.message_fts_rowid_map) {
                const source = fts.get(r.fts_rowid);
                if (!source) refuse("fts_map_orphan", `FTS map row ${r.fts_rowid} has no document`);
                const n = ordinalFor(source!.message_id) ?? r.message_ordinal;
                destinations.set(n, (destinations.get(n) ?? 0) + 1);
            }
            // Ordinal is part of the map's primary key: delete all moved keys before reinserting them.
            for (const r of ctx.message_fts_rowid_map) {
                const source = fts.get(r.fts_rowid);
                if (!source) refuse("fts_map_orphan", `FTS map row ${r.fts_rowid} has no document`);
                const n = ordinalFor(source!.message_id);
                if (!n) continue;
                if (n !== r.message_ordinal) {
                    // Legacy duplicate documents cannot share a unique ordinal-map key. Keep every
                    // FTS document and let the existing incomplete-map archive fallback read them all.
                    change(
                        "message_fts_rowid_map",
                        r,
                        (destinations.get(n) ?? 0) > 1 ? null : { ...r, message_ordinal: n },
                        (destinations.get(n) ?? 0) > 1
                            ? "invalidate colliding derived map entry; retain every FTS document"
                            : "recount FTS map via document id",
                        { session_id: id, fts_rowid: r.fts_rowid },
                    );
                }
            }
            const remap = (n: number): number => {
                if (!n || !affected.has(n)) return n;
                const set = oldToNew.get(n);
                if (set?.size !== 1)
                    refuse("unanchored_progress", `Cannot identify progress ordinal ${n}`);
                return [...set!][0];
            };
            for (const r of ctx.message_history_index)
                change(
                    "message_history_index",
                    r,
                    {
                        last_indexed_ordinal: remap(r.last_indexed_ordinal),
                        dirty_floor_ordinal: remap(r.dirty_floor_ordinal),
                    },
                    "recount index progress",
                    { session_id: id },
                );
            for (const r of ctx.message_time_backfill_state)
                change(
                    "message_time_backfill_state",
                    r,
                    { cursor_ordinal: remap(r.cursor_ordinal) },
                    "recount time backfill progress",
                );
            // The protected-tail floor follows the latest compartment endpoint, not search-index progress.
            if (meta.floor === cs[cs.length - 1].end_message + 1)
                plan.metaAfter.floor = healed[healed.length - 1].end_message + 1;
            const owners = new Map(cs.map((c, i) => [c.id, { old: c, healed: healed[i] }]));
            for (const r of ctx.compartment_chunk_embeddings) {
                const owner = owners.get(r.compartment_id);
                if (!owner) {
                    if (affected.has(r.start_ordinal) || affected.has(r.end_ordinal))
                        change(
                            "compartment_chunk_embeddings",
                            r,
                            null,
                            "rebuild ownerless drifted embedding",
                        );
                } else if (
                    owner.old.start_message !== owner.healed.start_message ||
                    owner.old.end_message !== owner.healed.end_message
                ) {
                    const clamp = (n: number) =>
                        Math.max(owner.healed.start_message, Math.min(owner.healed.end_message, n));
                    const start = clamp(
                        owner.healed.start_message + r.start_ordinal - owner.old.start_message,
                    );
                    const end = clamp(
                        owner.healed.end_message - (owner.old.end_message - r.end_ordinal),
                    );
                    if (start > end)
                        refuse(
                            "embedding_window_unresolvable",
                            `Embedding window ${r.id} cannot be reconstructed through its owner`,
                        );
                    change(
                        "compartment_chunk_embeddings",
                        r,
                        {
                            start_ordinal: start,
                            end_ordinal: end,
                        },
                        "recount embedding window through its compartment; keep vector",
                    );
                }
            }
            if (affected.size) {
                for (const r of ctx.notes.filter((n) => affected.has(n.anchor_ordinal))) {
                    if (r.anchor_block_id && typeof r.anchor_block_id !== "string")
                        refuse("note_anchor_missing", `Note ${r.id} has an invalid block anchor`);
                    const mid =
                        typeof r.anchor_block_id === "string"
                            ? r.anchor_block_id.replace(/#\d+$/, "")
                            : null;
                    if (mid && !ordinal.has(mid))
                        refuse(
                            "note_anchor_missing",
                            `Note ${r.id} names an absent host message ${mid}`,
                        );
                    change(
                        "notes",
                        r,
                        { anchor_ordinal: mid ? (ordinal.get(mid) ?? null) : null },
                        "recount anchored note; clear only unanchored drifted note coordinate",
                    );
                }
                for (const r of ctx.compression_depth.filter((r) =>
                    affected.has(r.message_ordinal),
                ))
                    change(
                        "compression_depth",
                        r,
                        null,
                        "invalidate unanchored drifted derived depth",
                        { session_id: id, message_ordinal: r.message_ordinal },
                    );
                for (const r of ctx.primer_candidates) {
                    const after: Row = {};
                    if (r.source_start_message_id)
                        after.source_compartment_start = pos(r.source_start_message_id);
                    if (r.source_end_message_id)
                        after.source_compartment_end = pos(r.source_end_message_id);
                    if (Object.keys(after).length)
                        change("primer_candidates", r, after, "recount primer source identities");
                }
                plan.historicalNumbers.historianRuns = ctx.historian_runs.filter((r) =>
                    [r.chunk_start_ordinal, r.chunk_end_ordinal, r.unprocessed_from].some((n) =>
                        affected.has(n),
                    ),
                ).length;
                plan.historicalNumbers.userMemoryCandidates = ctx.user_memory_candidates.filter(
                    (r) =>
                        [r.source_compartment_start, r.source_compartment_end].some((n) =>
                            affected.has(n),
                        ),
                ).length;
            }
        }
    } catch (error) {
        const e = error as Error & { code?: string };
        plan.refusals.push({ code: e.code ?? "invalid_history", message: e.message });
        plan.rewrites = [];
        plan.metaAfter = structuredClone(meta);
    }
    if (plan.rewrites.some((r) => r.store === "context" && r.table === "compartments"))
        plan.metaAfter.mutations.push({ mutationType: "recomp_boundary_change", targetId: null });
    plan.after = {
        context: digest(
            projected(
                ctx,
                plan.rewrites.filter((r) => r.store === "context"),
            ),
            plan.metaAfter,
        ),
        host: digest(
            projected(
                hs,
                plan.rewrites.filter((r) => r.store === "host"),
            ),
        ),
    };
    return plan;
}
