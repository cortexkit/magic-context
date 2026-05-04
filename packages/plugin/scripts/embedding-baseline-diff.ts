#!/usr/bin/env bun
/**
 * Diff two embedding-baseline snapshots to judge whether a model upgrade
 * meaningfully reranked memory retrieval.
 *
 * Usage:
 *   bun packages/plugin/scripts/embedding-baseline-diff.ts <old.json> <new.json>
 *
 * Prints:
 *   - Score magnitude shift per query group (avg top1, avg top10)
 *   - Top-1 memory change rate (how often top-ranked memory changed)
 *   - Kendall tau rank correlation per query (1 = same order, -1 = inverted, 0 = random)
 *   - Category distribution diff in top-K
 *   - Per-query side-by-side top-3 so you can eyeball quality
 */

import { existsSync, readFileSync } from "node:fs";

interface TopKEntry {
    rank: number;
    memoryId: number;
    category: string;
    score: number;
    retrievalCount: number;
    preview: string;
}

interface QueryResult {
    id: string;
    group: string;
    text: string;
    topK: TopKEntry[];
}

interface Snapshot {
    tag: string | null;
    timestamp: string;
    modelId: string;
    embeddingDim: number | null;
    projectIdentity: string;
    stats: {
        memoriesConsidered: number;
        memoriesEmbedded: number;
        queryCount: number;
        topK: number;
        queryEmbedLatencyMs: { min: number; max: number; avg: number };
    };
    queries: QueryResult[];
}

function loadSnapshot(path: string): Snapshot {
    if (!existsSync(path)) {
        console.error(`File not found: ${path}`);
        process.exit(1);
    }
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return raw as Snapshot;
}

/** Kendall tau-b rank correlation over the intersection of two top-K lists.
 *  Returns null when the intersection is < 2 items (undefined correlation). */
function kendallTau(oldIds: number[], newIds: number[]): number | null {
    const common = oldIds.filter((id) => newIds.includes(id));
    if (common.length < 2) return null;

    const oldRank = new Map(oldIds.map((id, idx) => [id, idx]));
    const newRank = new Map(newIds.map((id, idx) => [id, idx]));

    let concordant = 0;
    let discordant = 0;
    for (let i = 0; i < common.length; i++) {
        for (let j = i + 1; j < common.length; j++) {
            const a = common[i];
            const b = common[j];
            const oldOrder = (oldRank.get(a) ?? 0) - (oldRank.get(b) ?? 0);
            const newOrder = (newRank.get(a) ?? 0) - (newRank.get(b) ?? 0);
            if (oldOrder * newOrder > 0) concordant++;
            else if (oldOrder * newOrder < 0) discordant++;
        }
    }
    const total = concordant + discordant;
    return total === 0 ? null : (concordant - discordant) / total;
}

function formatPreview(text: string, max = 90): string {
    const cleaned = text.replace(/\s+/g, " ").trim();
    return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function mean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
}

function main() {
    const [oldPath, newPath] = process.argv.slice(2);
    if (!oldPath || !newPath) {
        console.error(
            "Usage: bun packages/plugin/scripts/embedding-baseline-diff.ts <old.json> <new.json>",
        );
        process.exit(1);
    }

    const oldSnap = loadSnapshot(oldPath);
    const newSnap = loadSnapshot(newPath);

    console.log("");
    console.log("─── Snapshot meta ─────────────────────────────────────────");
    console.log(`OLD: ${oldSnap.modelId} (dim=${oldSnap.embeddingDim}) ${oldSnap.timestamp}`);
    console.log(`NEW: ${newSnap.modelId} (dim=${newSnap.embeddingDim}) ${newSnap.timestamp}`);
    console.log(
        `memories considered: old=${oldSnap.stats.memoriesConsidered} new=${newSnap.stats.memoriesConsidered}  topK=${oldSnap.stats.topK}`,
    );
    console.log(
        `avg query latency: old=${oldSnap.stats.queryEmbedLatencyMs.avg}ms new=${newSnap.stats.queryEmbedLatencyMs.avg}ms`,
    );

    // Build a map for quick lookup.
    const newById = new Map(newSnap.queries.map((q) => [q.id, q]));

    // Per-query metrics.
    interface Row {
        id: string;
        group: string;
        text: string;
        oldTop1: number;
        newTop1: number;
        oldTop10: number;
        newTop10: number;
        top1Changed: boolean;
        tau: number | null;
        overlapCount: number;
    }
    const rows: Row[] = [];

    for (const oldQ of oldSnap.queries) {
        const newQ = newById.get(oldQ.id);
        if (!newQ) continue;
        const oldIds = oldQ.topK.map((t) => t.memoryId);
        const newIds = newQ.topK.map((t) => t.memoryId);
        const newSet = new Set(newIds);
        const overlap = new Set(oldIds.filter((id) => newSet.has(id)));
        rows.push({
            id: oldQ.id,
            group: oldQ.group,
            text: oldQ.text,
            oldTop1: oldQ.topK[0]?.score ?? 0,
            newTop1: newQ.topK[0]?.score ?? 0,
            oldTop10: oldQ.topK[oldQ.topK.length - 1]?.score ?? 0,
            newTop10: newQ.topK[newQ.topK.length - 1]?.score ?? 0,
            top1Changed: oldIds[0] !== newIds[0],
            tau: kendallTau(oldIds, newIds),
            overlapCount: overlap.size,
        });
    }

    // Aggregate.
    console.log("");
    console.log("─── Aggregate shifts ──────────────────────────────────────");
    console.log(
        `mean top1:  old=${mean(rows.map((r) => r.oldTop1)).toFixed(3)}  new=${mean(rows.map((r) => r.newTop1)).toFixed(3)}`,
    );
    console.log(
        `mean top10: old=${mean(rows.map((r) => r.oldTop10)).toFixed(3)}  new=${mean(rows.map((r) => r.newTop10)).toFixed(3)}`,
    );
    const top1Changes = rows.filter((r) => r.top1Changed).length;
    console.log(
        `top-1 memory changed: ${top1Changes}/${rows.length} queries (${((100 * top1Changes) / rows.length).toFixed(0)}%)`,
    );
    const meanOverlap = mean(rows.map((r) => r.overlapCount));
    console.log(`mean topK overlap: ${meanOverlap.toFixed(1)}/${oldSnap.stats.topK}`);
    const validTaus = rows.map((r) => r.tau).filter((t): t is number => t !== null);
    if (validTaus.length > 0) {
        console.log(
            `mean Kendall tau (order similarity on overlap): ${mean(validTaus).toFixed(3)}  ` +
                `(1=identical order, 0=uncorrelated, -1=inverted)`,
        );
    }

    // Per-group aggregates.
    const groups = new Map<string, Row[]>();
    for (const row of rows) {
        const list = groups.get(row.group) ?? [];
        list.push(row);
        groups.set(row.group, list);
    }
    console.log("");
    console.log("─── Per-group ─────────────────────────────────────────────");
    console.log("group         mean_top1_Δ  mean_top10_Δ  top1_changed  mean_overlap  mean_tau");
    for (const [group, groupRows] of groups) {
        const top1Delta = mean(groupRows.map((r) => r.newTop1 - r.oldTop1));
        const top10Delta = mean(groupRows.map((r) => r.newTop10 - r.oldTop10));
        const top1Ch = groupRows.filter((r) => r.top1Changed).length;
        const ov = mean(groupRows.map((r) => r.overlapCount));
        const taus = groupRows.map((r) => r.tau).filter((t): t is number => t !== null);
        const meanTau = taus.length > 0 ? mean(taus) : null;
        console.log(
            `${group.padEnd(13)} ${top1Delta.toFixed(3).padStart(11)}  ${top10Delta.toFixed(3).padStart(12)}  ${`${top1Ch}/${groupRows.length}`.padStart(12)}  ${ov.toFixed(1).padStart(12)}  ${(meanTau !== null ? meanTau.toFixed(3) : "n/a").padStart(8)}`,
        );
    }

    // Category distribution diff in top-K.
    const oldCat = new Map<string, number>();
    const newCat = new Map<string, number>();
    for (const q of oldSnap.queries) {
        for (const t of q.topK) oldCat.set(t.category, (oldCat.get(t.category) ?? 0) + 1);
    }
    for (const q of newSnap.queries) {
        for (const t of q.topK) newCat.set(t.category, (newCat.get(t.category) ?? 0) + 1);
    }
    const cats = new Set([...oldCat.keys(), ...newCat.keys()]);
    console.log("");
    console.log("─── Category distribution in top-K (all queries combined) ─");
    console.log("category                    old  new  Δ");
    for (const cat of cats) {
        const o = oldCat.get(cat) ?? 0;
        const n = newCat.get(cat) ?? 0;
        const delta = n - o;
        const sign = delta > 0 ? "+" : "";
        console.log(
            `${cat.padEnd(27)}${String(o).padStart(4)} ${String(n).padStart(4)}  ${sign}${delta}`,
        );
    }

    // Side-by-side top-3 per query.
    console.log("");
    console.log("─── Per-query top-3 (OLD vs NEW) ──────────────────────────");
    for (const oldQ of oldSnap.queries) {
        const newQ = newById.get(oldQ.id);
        if (!newQ) continue;
        console.log("");
        console.log(`[${oldQ.id}] (${oldQ.group}) ${oldQ.text}`);
        for (let i = 0; i < 3; i++) {
            const o = oldQ.topK[i];
            const n = newQ.topK[i];
            const marker = o && n && o.memoryId === n.memoryId ? "=" : "≠";
            const oLine = o
                ? `#${o.memoryId} [${o.category}] ${o.score.toFixed(3)} ${formatPreview(o.preview, 60)}`
                : "(none)";
            const nLine = n
                ? `#${n.memoryId} [${n.category}] ${n.score.toFixed(3)} ${formatPreview(n.preview, 60)}`
                : "(none)";
            console.log(`  ${marker} OLD ${oLine}`);
            console.log(`    NEW ${nLine}`);
        }
    }

    console.log("");
}

main();
