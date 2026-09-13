#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { getMagicContextStorageDir } from "../src/shared/data-path";
import { Database, withPrivilegedWriter } from "../src/shared/sqlite";

export const CREATED_AT_READER_AUDIT =
    "memories.created_at reader audit: dreamer curate/decay/review age gates, classification staging, dashboard age columns, decay/newest ordering, and expiry reasoning all consume memory timestamps; epoch-zero historian rows appear ancient and must be repaired at both the module source and context mirror.";

type RepairDisposition =
    | "repairable"
    | "repaired-from-compartment"
    | "repaired-from-neighbour"
    | "missing-module-row"
    | "ambiguous-module-rows"
    | "invalid-module-created-at";

interface ContextMirrorTimestampRow {
    id: number;
    project_path: string;
    normalized_hash: string;
    first_seen_at: number;
    created_at: number;
    updated_at: number;
    last_seen_at: number;
    classified_at: number | null;
    verified_at: number | null;
}

interface ModuleTimestampRow {
    rowid: number;
    id: number;
    project_path: string;
    normalized_hash: string;
    source_session_id: string | null;
    source_type: string | null;
    first_seen_at: number;
    created_at: number;
    updated_at: number;
    last_seen_at: number;
    classified_at: number | null;
    verified_at: number | null;
}

export interface MirrorCreatedAtRepairRow {
    contextId: number;
    projectPath: string;
    normalizedHash: string;
    contextCreatedAt: number;
    moduleRowIds: number[];
    moduleCreatedAt: number | null;
    repairCreatedAt: number | null;
    disposition: RepairDisposition;
}

export interface MirrorCreatedAtRepairReport {
    apply: boolean;
    candidates: MirrorCreatedAtRepairRow[];
    repaired: number;
}

interface PlannedRepair {
    context: ContextMirrorTimestampRow;
    source: ModuleTimestampRow | null;
    repairCreatedAt: number | null;
    report: MirrorCreatedAtRepairRow;
}

const HISTORIAN_NONCE_PATTERN = /^historian-exact:[0-9a-f]{16}:(\d+)$/i;

function tableExists(database: Database, table: string): boolean {
    return Boolean(
        database
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get(table),
    );
}

function historianNonce(normalizedHash: string): number | null {
    const match = HISTORIAN_NONCE_PATTERN.exec(normalizedHash);
    if (!match) return null;
    const nonce = Number(match[1]);
    return Number.isSafeInteger(nonce) ? nonce : null;
}

function deriveCompartmentPublishTime(database: Database, source: ModuleTimestampRow): number | null {
    if (
        source.source_type !== "historian" ||
        !source.source_session_id ||
        historianNonce(source.normalized_hash) === null ||
        !tableExists(database, "mc_compartments")
    ) {
        return null;
    }

    const publishRows = database
        .prepare(
            `SELECT created_at, MIN(sequence) AS first_sequence
               FROM mc_compartments
              WHERE session_id = ? AND created_at > 0
              GROUP BY created_at
              ORDER BY first_sequence`,
        )
        .all(source.source_session_id) as Array<{ created_at: number; first_sequence: number }>;
    const publishTimes = publishRows.map((row) => row.created_at);
    if (publishTimes.length === 1) return publishTimes[0] ?? null;
    if (publishTimes.length === 0) return null;

    const orderedFacts = (
        database
            .prepare(
                `SELECT id, normalized_hash, created_at
                   FROM mc_memories
                  WHERE project_path = ?
                    AND source_session_id = ?
                    AND source_type = 'historian'`,
            )
            .all(source.project_path, source.source_session_id) as Array<{
            id: number;
            normalized_hash: string;
            created_at: number;
        }>
    )
        .map((row) => ({ ...row, nonce: historianNonce(row.normalized_hash) }))
        .filter((row): row is typeof row & { nonce: number } => row.nonce !== null)
        .sort((left, right) => left.nonce - right.nonce);
    const sourceIndex = orderedFacts.findIndex((row) => row.id === source.id);
    if (sourceIndex < 0) return null;
    const publishTimeSet = new Set(publishTimes);
    // Several publications in one session cannot be assigned from zero timestamps alone.
    // Nonce order is conclusive only when dated facts on both sides identify the same publish.
    const previous = orderedFacts
        .slice(0, sourceIndex)
        .reverse()
        .find((row) => row.created_at > 0 && publishTimeSet.has(row.created_at));
    const next = orderedFacts
        .slice(sourceIndex + 1)
        .find((row) => row.created_at > 0 && publishTimeSet.has(row.created_at));
    return previous && next && previous.created_at === next.created_at ? previous.created_at : null;
}

function deriveNeighbourCreatedAt(database: Database, source: ModuleTimestampRow): number | null {
    const previous = database
        .prepare(
            `SELECT created_at
               FROM mc_memories
              WHERE project_path = ? AND rowid < ? AND created_at > 0
              ORDER BY rowid DESC
              LIMIT 1`,
        )
        .get(source.project_path, source.rowid) as { created_at: number } | null;
    const next = database
        .prepare(
            `SELECT created_at
               FROM mc_memories
              WHERE project_path = ? AND rowid > ? AND created_at > 0
              ORDER BY rowid ASC
              LIMIT 1`,
        )
        .get(source.project_path, source.rowid) as { created_at: number } | null;
    const candidates = [previous?.created_at, next?.created_at].filter(
        (timestamp): timestamp is number => typeof timestamp === "number" && timestamp > 0,
    );
    return candidates.length > 0 ? Math.min(...candidates) : null;
}

function repairedTimestamp(value: number, replacement: number): number {
    return value > 0 ? value : replacement;
}

function loadRepairPlan(contextDb: Database, moduleDb: Database): PlannedRepair[] {
    const contextRows = contextDb
        .prepare(
            `SELECT m.id, m.project_path, m.normalized_hash, m.first_seen_at, m.created_at,
                    m.updated_at, m.last_seen_at, m.classified_at, m.verified_at
               FROM memories AS m
              WHERE m.created_at = 0
                AND EXISTS (
                    SELECT 1
                      FROM mirror_identity AS identity
                     WHERE identity.domain = 'memories'
                       AND identity.context_row_id = m.id
                )
              ORDER BY m.project_path, m.id`,
        )
        .all() as ContextMirrorTimestampRow[];
    const moduleMatches = moduleDb.prepare(
        `SELECT rowid AS rowid, id, project_path, normalized_hash, source_session_id, source_type,
                first_seen_at, created_at, updated_at, last_seen_at, classified_at, verified_at
           FROM mc_memories
          WHERE project_path = ? AND normalized_hash = ?
          ORDER BY id`,
    );

    return contextRows.map((context) => {
        const matches = moduleMatches.all(context.project_path, context.normalized_hash) as ModuleTimestampRow[];
        const source = matches.length === 1 ? (matches[0] ?? null) : null;
        let repairCreatedAt: number | null = null;
        let disposition: RepairDisposition;
        if (!source) {
            disposition = matches.length === 0 ? "missing-module-row" : "ambiguous-module-rows";
        } else if (source.created_at > 0) {
            repairCreatedAt = source.created_at;
            disposition = "repairable";
        } else {
            const compartmentCreatedAt = deriveCompartmentPublishTime(moduleDb, source);
            if (compartmentCreatedAt !== null) {
                repairCreatedAt = compartmentCreatedAt;
                disposition = "repaired-from-compartment";
            } else {
                const neighbourCreatedAt = deriveNeighbourCreatedAt(moduleDb, source);
                if (neighbourCreatedAt !== null) {
                    repairCreatedAt = neighbourCreatedAt;
                    disposition = "repaired-from-neighbour";
                } else {
                    disposition = "invalid-module-created-at";
                }
            }
        }
        return {
            context,
            source,
            repairCreatedAt,
            report: {
                contextId: context.id,
                projectPath: context.project_path,
                normalizedHash: context.normalized_hash,
                contextCreatedAt: context.created_at,
                moduleRowIds: matches.map((match) => match.id),
                moduleCreatedAt: source?.created_at ?? null,
                repairCreatedAt,
                disposition,
            },
        };
    });
}

export function repairMirrorCreatedAt(
    contextDb: Database,
    moduleDb: Database,
    options: { apply: boolean },
): MirrorCreatedAtRepairReport {
    const plan = loadRepairPlan(contextDb, moduleDb);
    if (!options.apply) {
        return { apply: false, candidates: plan.map((entry) => entry.report), repaired: 0 };
    }

    const derivedRepairs = plan.filter(
        (entry) =>
            entry.source &&
            entry.repairCreatedAt !== null &&
            (entry.report.disposition === "repaired-from-compartment" ||
                entry.report.disposition === "repaired-from-neighbour"),
    );
    if (derivedRepairs.length > 0) {
        const updateModule = moduleDb.prepare(
            `UPDATE mc_memories
                SET first_seen_at = CASE WHEN first_seen_at <= 0 THEN ? ELSE first_seen_at END,
                    created_at = ?,
                    updated_at = CASE WHEN updated_at <= 0 THEN ? ELSE updated_at END,
                    last_seen_at = CASE WHEN last_seen_at <= 0 THEN ? ELSE last_seen_at END
              WHERE rowid = ? AND created_at <= 0`,
        );
        moduleDb.exec("BEGIN IMMEDIATE");
        try {
            for (const entry of derivedRepairs) {
                const source = entry.source;
                const replacement = entry.repairCreatedAt;
                if (!source || replacement === null) continue;
                updateModule.run(replacement, replacement, replacement, replacement, source.rowid);
            }
            moduleDb.exec("COMMIT");
        } catch (error) {
            moduleDb.exec("ROLLBACK");
            throw error;
        }
    }

    let repaired = 0;
    withPrivilegedWriter(contextDb, () => {
        const updateContext = contextDb.prepare(
            `UPDATE memories
                SET first_seen_at = CASE WHEN first_seen_at = 0 THEN ? ELSE first_seen_at END,
                    created_at = ?,
                    updated_at = CASE WHEN updated_at = 0 THEN ? ELSE updated_at END,
                    last_seen_at = CASE WHEN last_seen_at = 0 THEN ? ELSE last_seen_at END,
                    classified_at = CASE WHEN COALESCE(classified_at, 0) = 0 THEN ? ELSE classified_at END,
                    verified_at = CASE WHEN COALESCE(verified_at, 0) = 0 THEN ? ELSE verified_at END
              WHERE id = ? AND created_at = 0`,
        );
        for (const entry of plan) {
            if (!entry.source || entry.repairCreatedAt === null) continue;
            const replacement = entry.repairCreatedAt;
            const result = updateContext.run(
                repairedTimestamp(entry.source.first_seen_at, replacement),
                replacement,
                repairedTimestamp(entry.source.updated_at, replacement),
                repairedTimestamp(entry.source.last_seen_at, replacement),
                entry.source.classified_at,
                entry.source.verified_at,
                entry.context.id,
            );
            if (Number(result.changes) > 0) repaired += 1;
        }
    });

    return { apply: true, candidates: plan.map((entry) => entry.report), repaired };
}

export function formatMirrorCreatedAtRepairReport(report: MirrorCreatedAtRepairReport): string {
    const lines = [
        `mode: ${report.apply ? "apply" : "dry-run"}`,
        CREATED_AT_READER_AUDIT,
        "context id | project | normalized hash | module ids | module created_at | repair created_at | disposition",
        "---: | --- | --- | --- | ---: | ---: | ---",
    ];
    if (report.candidates.length === 0) {
        lines.push("(none) | (none) | (none) | (none) | (none) | (none) | no candidates");
    } else {
        for (const row of report.candidates) {
            lines.push(
                `${row.contextId} | ${row.projectPath} | ${row.normalizedHash} | ${row.moduleRowIds.join(",") || "(none)"} | ${row.moduleCreatedAt ?? "(none)"} | ${row.repairCreatedAt ?? "(none)"} | ${row.disposition}`,
            );
        }
    }
    const dispositions: RepairDisposition[] = [
        "repairable",
        "repaired-from-compartment",
        "repaired-from-neighbour",
        "missing-module-row",
        "ambiguous-module-rows",
        "invalid-module-created-at",
    ];
    for (const disposition of dispositions) {
        const count = report.candidates.filter((candidate) => candidate.disposition === disposition).length;
        lines.push(`${disposition}: ${count}`);
    }
    lines.push(`candidates: ${report.candidates.length}`);
    lines.push(`repaired: ${report.repaired}`);
    if (!report.apply) lines.push("no writes performed; rerun with --apply to repair eligible rows");
    return `${lines.join("\n")}\n`;
}

function parseArgs(argv: string[]): {
    apply: boolean;
    contextDbPath: string;
    moduleDbPath: string;
} {
    let apply = false;
    let explicitDryRun = false;
    let contextDbPath: string | undefined;
    let moduleDbPath: string | undefined;
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--apply") {
            apply = true;
            continue;
        }
        if (arg === "--dry-run") {
            explicitDryRun = true;
            continue;
        }
        if (arg === "--context-db" || arg === "--module-db") {
            const value = argv[index + 1];
            if (!value || value.startsWith("--")) throw new Error(`${arg} requires a path`);
            if (arg === "--context-db") contextDbPath = resolve(value);
            else moduleDbPath = resolve(value);
            index += 1;
            continue;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }
    if (apply && explicitDryRun) throw new Error("Choose either --dry-run or --apply, not both");
    const storageDir = getMagicContextStorageDir();
    return {
        apply,
        contextDbPath: contextDbPath ?? join(storageDir, "context.db"),
        moduleDbPath: moduleDbPath ?? join(storageDir, "store.db"),
    };
}

if (import.meta.main) {
    try {
        const args = parseArgs(process.argv.slice(2));
        if (!existsSync(args.contextDbPath)) {
            throw new Error(`context database not found: ${args.contextDbPath}`);
        }
        if (!existsSync(args.moduleDbPath)) {
            throw new Error(`module database not found: ${args.moduleDbPath}`);
        }
        const contextDb = new Database(args.contextDbPath, args.apply ? undefined : { readonly: true });
        const moduleDb = new Database(args.moduleDbPath, args.apply ? undefined : { readonly: true });
        try {
            const report = repairMirrorCreatedAt(contextDb, moduleDb, { apply: args.apply });
            process.stdout.write(formatMirrorCreatedAtRepairReport(report));
        } finally {
            moduleDb.close();
            contextDb.close();
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`repair-mirror-created-at: ${message}`);
        process.exitCode = 1;
    }
}
