import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { Database } from "../../../shared/sqlite";
import { bumpProjectMemoryEpoch } from "../storage-project-state";
import { invalidateMemory } from "./embedding-cache";
import type {
    MemoryEditReceipt,
    MemoryEditRequest,
    MemoryHistoryDecision,
    MemoryHistoryPage,
    MemoryHistoryRequest,
    MemoryHistorySnapshot,
    MemoryRestorePreview,
    MemoryRestoreReceipt,
    MemoryRestoreRequest,
    MemoryRevisionExpectation,
    MemoryWriteConflict,
} from "./history-contract";
import { tsOwnsMemory } from "./lifecycle-applier";
import { computeNormalizedHash } from "./normalize-hash";
import type { MemoryCategory } from "./types";

const fields = [
    "id",
    "projectPath",
    "revision",
    "category",
    "content",
    "normalizedHash",
    "importance",
    "scope",
    "shareable",
    "safetyCritical",
    "sourceSessionId",
    "sourceType",
    "seenCount",
    "retrievalCount",
    "firstSeenAt",
    "createdAt",
    "updatedAt",
    "lastSeenAt",
    "lastRetrievedAt",
    "status",
    "expiresAt",
    "verificationStatus",
    "verifiedAt",
    "supersededByMemoryId",
    "mergedFrom",
    "metadataJson",
] as const;
const categories = new Set([
    "PROJECT_RULES",
    "ARCHITECTURE",
    "CONFIG_VALUES",
    "ARCHITECTURE_DECISIONS",
    "CONSTRAINTS",
    "CONFIG_DEFAULTS",
    "NAMING",
    "USER_PREFERENCES",
    "USER_DIRECTIVES",
    "ENVIRONMENT",
    "WORKFLOW_RULES",
    "KNOWN_ISSUES",
]);
const nullable = new Set([
    "safetyCritical",
    "importance",
    "sourceSessionId",
    "sourceType",
    "lastRetrievedAt",
    "expiresAt",
    "verifiedAt",
    "supersededByMemoryId",
    "mergedFrom",
    "metadataJson",
]);
const numeric = new Set([
    "safetyCritical",
    "id",
    "revision",
    "importance",
    "shareable",
    "seenCount",
    "retrievalCount",
    "firstSeenAt",
    "createdAt",
    "updatedAt",
    "lastSeenAt",
    "lastRetrievedAt",
    "expiresAt",
    "verifiedAt",
    "supersededByMemoryId",
]);
const snake = (field: string) => field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);

/** Sorting recursively makes persisted envelopes identical across JS and Rust writers. */
export function memoryHistoryJson(value: unknown): string {
    const sorted = (input: unknown): unknown =>
        Array.isArray(input)
            ? input.map(sorted)
            : object(input)
              ? Object.fromEntries(
                    Object.keys(input)
                        .sort()
                        .map((key) => [key, sorted(input[key])]),
                )
              : input;
    return JSON.stringify(sorted(value));
}

export function normalizeMemoryHistorySnapshot(
    value: unknown,
    revision?: number,
): MemoryHistorySnapshot | null {
    if (!object(value)) return null;
    if (value.version !== undefined) {
        if (value.version !== 1) return null;
        value = value.snapshot;
        if (!object(value)) return null;
    }
    const result: Record<string, unknown> = {};
    for (const field of fields) {
        const item = Object.hasOwn(value, field)
            ? value[field]
            : Object.hasOwn(value, snake(field))
              ? value[snake(field)]
              : field === "revision"
                ? revision
                : nullable.has(field)
                  ? null
                  : undefined;
        if (
            item === undefined ||
            (item === null && !nullable.has(field)) ||
            (item !== null &&
                (numeric.has(field)
                    ? typeof item !== "number" || !Number.isSafeInteger(item)
                    : typeof item !== "string"))
        )
            return null;
        result[field] = item;
    }
    if (
        (result.id as number) <= 0 ||
        (result.revision as number) <= 0 ||
        !categories.has(result.category as string) ||
        !["active", "permanent", "archived"].includes(result.status as string) ||
        !["project", "ecosystem", "universe"].includes(result.scope as string) ||
        ![0, 1].includes(result.shareable as number) ||
        (result.safetyCritical !== null && ![0, 1].includes(result.safetyCritical as number))
    )
        return null;
    return result as unknown as MemoryHistorySnapshot;
}
export function memoryHistorySnapshot(db: Database, id: number): MemoryHistorySnapshot | null {
    return normalizeMemoryHistorySnapshot(db.prepare("SELECT * FROM memories WHERE id=?").get(id));
}

export function makeMemoryHistoryDecision(input: {
    key: string;
    projectPath: string;
    writer: string;
    operation: string;
    reason: string;
    now: number;
    before: Array<MemoryHistorySnapshot | null>;
    after: MemoryHistorySnapshot[];
    sourceIds: number[];
    survivorId?: number | null;
    evidence?: unknown;
}): MemoryHistoryDecision {
    return {
        version: 1,
        decisionKey: input.key,
        projectPath: input.projectPath,
        writer: input.writer,
        operation: input.operation,
        reason: input.reason,
        appliedAt: input.now,
        evidence: input.evidence ?? [],
        sourceIds: input.sourceIds,
        survivorId: input.survivorId ?? null,
        rows: input.after.map((after, index) => ({
            memoryId: after.id,
            role:
                after.id === input.survivorId
                    ? "survivor"
                    : input.after.length > 1
                      ? "source"
                      : "target",
            beforeRevision: input.before[index]?.revision ?? null,
            afterRevision: after.revision,
            before: input.before[index] ?? null,
            after,
            completeness: "complete",
        })),
        restorable: true,
        refusalReason: null,
    };
}
export function recordMemoryHistoryDecision(db: Database, decision: MemoryHistoryDecision): void {
    for (const row of decision.rows)
        db.prepare(
            "INSERT INTO memory_history(memory_id,revision,previous_text,after_text,before_json,after_json,applied_at,reason,evidence_json,source_ids_json,decision_key) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        ).run(
            row.memoryId,
            row.beforeRevision ?? 0,
            row.before?.content ?? "",
            row.after?.content ?? "",
            memoryHistoryJson({ version: 1, snapshot: row.before }),
            memoryHistoryJson({ version: 1, snapshot: row.after }),
            decision.appliedAt,
            decision.reason,
            memoryHistoryJson(decision.evidence),
            memoryHistoryJson(decision.sourceIds),
            decision.decisionKey,
        );
}

export function readMemoryHistoryDecision(
    db: Database,
    projectPath: string,
    key: string,
): MemoryHistoryDecision | null {
    const journal = db
        .prepare(
            "SELECT before_json,after_json,operation FROM memory_journal WHERE project_path=? AND decision_key=?",
        )
        .get(projectPath, key) as {
        before_json: string | null;
        after_json: string | null;
        operation: string;
    } | null;
    const history = db
        .prepare(
            "SELECT h.* FROM memory_history h JOIN memories m ON m.id=h.memory_id WHERE m.project_path=? AND h.decision_key=? ORDER BY h.id",
        )
        .all(projectPath, key) as Array<{
        memory_id: number;
        revision: number;
        applied_at: number;
        reason: string;
        evidence_json: string;
        source_ids_json: string;
        before_json: string | null;
        after_json: string | null;
    }>;
    if (!history.length) return null;
    const parse = (raw: string | null): unknown => {
        try {
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    };
    const total = (
        db.prepare("SELECT COUNT(*) n FROM memory_history WHERE decision_key=?").get(key) as {
            n: number;
        }
    ).n;
    const foreign = total !== history.length;
    const saved = parse(journal?.before_json ?? null);
    if (
        object(saved) &&
        saved.version === 1 &&
        saved.decisionKey === key &&
        saved.projectPath === projectPath &&
        Array.isArray(saved.rows)
    ) {
        const decision = saved as unknown as MemoryHistoryDecision;
        if (
            !foreign &&
            decision.version === 1 &&
            decision.restorable === true &&
            decision.rows.length === history.length &&
            new Set(decision.rows.map((row) => row.memoryId)).size === history.length &&
            decision.rows.every(
                (row) =>
                    history.some((record) => record.memory_id === row.memoryId) &&
                    row.completeness === "complete" &&
                    row.afterRevision === row.after?.revision &&
                    row.beforeRevision === (row.before?.revision ?? null) &&
                    row.after &&
                    normalizeMemoryHistorySnapshot(row.after) &&
                    row.after.projectPath === projectPath &&
                    row.memoryId === row.after.id &&
                    (row.before === null ||
                        (normalizeMemoryHistorySnapshot(row.before) &&
                            row.before.projectPath === projectPath &&
                            row.before.id === row.memoryId)),
            )
        )
            return decision;
    }
    const first = history[0]!;
    const beforeJournal = parse(journal?.before_json ?? null);
    const afterJournal = parse(journal?.after_json ?? null);
    const paired =
        Array.isArray(beforeJournal) &&
        Array.isArray(afterJournal) &&
        beforeJournal.length === afterJournal.length;
    const entries = paired
        ? afterJournal.map((value, i) => ({
              before: beforeJournal[i],
              after: value,
              revision: history.find((row) => row.memory_id === (object(value) ? value.id : null))
                  ?.revision,
          }))
        : history.map((row) => ({
              before: parse(row.before_json),
              after: parse(row.after_json),
              revision: row.revision,
          }));
    const rows = entries.map((entry, index) => {
        const before = normalizeMemoryHistorySnapshot(entry.before, entry.revision);
        const after = normalizeMemoryHistorySnapshot(
            entry.after,
            entry.revision === undefined ? undefined : entry.revision + 1,
        );
        const created = paired && entry.before === null && after !== null;
        return {
            memoryId: after?.id ?? before?.id ?? history[index]?.memory_id ?? 0,
            role: created
                ? ("survivor" as const)
                : entries.length > 1
                  ? ("source" as const)
                  : ("target" as const),
            beforeRevision: before?.revision ?? null,
            afterRevision: after?.revision ?? null,
            before,
            after,
            completeness: (after && (before || created) ? "complete" : "legacy-partial") as
                | "complete"
                | "legacy-partial",
        };
    });
    const complete =
        !foreign &&
        !(object(saved) && "version" in saved) &&
        rows.every(
            (row) =>
                row.completeness === "complete" &&
                row.after?.projectPath === projectPath &&
                (!row.before || row.before.projectPath === projectPath),
        );
    return {
        version: 1,
        decisionKey: key,
        projectPath,
        writer: journal?.operation.split("_")[0] ?? key.split(":")[0] ?? "unknown",
        operation: journal?.operation ?? first.reason,
        reason: first.reason,
        appliedAt: first.applied_at,
        evidence: parse(first.evidence_json),
        sourceIds: history.map((row) => row.memory_id),
        survivorId: rows.find((row) => row.role === "survivor")?.memoryId ?? null,
        rows,
        restorable: complete,
        refusalReason: complete ? null : "incomplete_decision",
    };
}

export function listMemoryHistory(db: Database, request: MemoryHistoryRequest): MemoryHistoryPage {
    if (
        !request.projectPath ||
        (request.memoryId !== undefined &&
            memoryHistorySnapshot(db, request.memoryId)?.projectPath !== request.projectPath)
    )
        throw new Error("target_not_owned");
    const limit = Math.min(100, Math.max(1, request.limit ?? 25));
    let cursor: {
        projectPath: string;
        memoryId?: number;
        high: number;
        time: number;
        key: string;
    } | null = null;
    if (request.cursor) {
        cursor = JSON.parse(request.cursor);
        if (
            !cursor ||
            cursor.projectPath !== request.projectPath ||
            cursor.memoryId !== request.memoryId ||
            !Number.isSafeInteger(cursor.high) ||
            !Number.isSafeInteger(cursor.time) ||
            typeof cursor.key !== "string"
        )
            throw new Error("invalid_request");
    }
    const high =
        cursor?.high ??
        (db.prepare("SELECT COALESCE(MAX(id),0) n FROM memory_history").get() as { n: number }).n;
    const selected = db
        .prepare(
            "SELECT h.decision_key,MAX(h.applied_at) time FROM memory_history h JOIN memories m ON m.id=h.memory_id WHERE m.project_path=? AND h.id<=? AND (? IS NULL OR h.decision_key IN (SELECT decision_key FROM memory_history WHERE memory_id=?)) GROUP BY h.decision_key HAVING (? IS NULL OR MAX(h.applied_at)<? OR (MAX(h.applied_at)=? AND h.decision_key<?)) ORDER BY time DESC,h.decision_key DESC LIMIT ?",
        )
        .all(
            request.projectPath,
            high,
            request.memoryId ?? null,
            request.memoryId ?? null,
            cursor?.time ?? null,
            cursor?.time ?? null,
            cursor?.time ?? null,
            cursor?.key ?? null,
            limit + 1,
        ) as Array<{ decision_key: string; time: number }>;
    const page = selected.slice(0, limit);
    const last = page.at(-1);
    return {
        version: 1,
        decisions: page
            .map((row) => readMemoryHistoryDecision(db, request.projectPath, row.decision_key)!)
            .filter(Boolean),
        nextCursor:
            selected.length > limit && last
                ? memoryHistoryJson({
                      projectPath: request.projectPath,
                      memoryId: request.memoryId,
                      high,
                      time: last.time,
                      key: last.decision_key,
                  })
                : null,
    };
}

type Plan = {
    state: "ready" | "refused" | "conflict";
    reason: string | null;
    conflicts: MemoryWriteConflict[];
    before: MemoryHistorySnapshot[];
    after: MemoryHistorySnapshot[];
    decision: MemoryHistoryDecision | null;
};
function planMemoryWrite(
    db: Database,
    request: MemoryRestoreRequest | MemoryEditRequest,
    now: number,
    checkRevisions: boolean,
    checkAuthority = true,
): Plan {
    const failed = (
        state: "refused" | "conflict",
        reason: string,
        conflicts: MemoryWriteConflict[] = [],
    ): Plan => ({ state, reason, conflicts, before: [], after: [], decision: null });
    if (!request.projectPath || (checkAuthority && !tsOwnsMemory(db, request.projectPath)))
        return failed("refused", "authority_unavailable");
    const restoring = "decisionKey" in request;
    const decision = restoring
        ? readMemoryHistoryDecision(db, request.projectPath, request.decisionKey)
        : null;
    if (restoring && !decision) return failed("refused", "history_not_found");
    if (restoring && !decision?.restorable) return failed("refused", "incomplete_decision");
    const ids = restoring
        ? decision!.rows.map((row) => row.memoryId)
        : request.changes.map((row) => row.memoryId);
    if (
        !ids.length ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !Number.isSafeInteger(id) || id <= 0)
    )
        return failed("refused", "invalid_request");
    const expectations = request.expectedRevisions;
    if (
        checkRevisions &&
        (expectations.length !== ids.length ||
            new Set(expectations.map((row) => row.memoryId)).size !== ids.length ||
            expectations.some(
                (row) =>
                    !ids.includes(row.memoryId) ||
                    !Number.isSafeInteger(row.revision) ||
                    row.revision <= 0,
            ))
    )
        return failed("refused", "invalid_request");
    const before: MemoryHistorySnapshot[] = [];
    const after: MemoryHistorySnapshot[] = [];
    for (const id of ids) {
        const current = memoryHistorySnapshot(db, id);
        if (!current || current.projectPath !== request.projectPath)
            return failed("refused", "target_not_owned");
        const expected = expectations.find((row) => row.memoryId === id)?.revision;
        if (checkRevisions && current.revision !== expected)
            return failed("conflict", "stale_revision", [
                {
                    memoryId: id,
                    expectedRevision: expected ?? null,
                    currentRevision: current.revision,
                },
            ]);
        const target = { ...current };
        if (restoring) {
            const row = decision!.rows.find((change) => change.memoryId === id)!;
            if (
                row.after &&
                [
                    "content",
                    "category",
                    "importance",
                    "scope",
                    "status",
                    "expiresAt",
                    "supersededByMemoryId",
                    "mergedFrom",
                    "metadataJson",
                    "safetyCritical",
                    "sourceSessionId",
                    "sourceType",
                ].some(
                    (field) =>
                        current[field as keyof MemoryHistorySnapshot] !==
                        row.after![field as keyof MemoryHistorySnapshot],
                )
            )
                return failed(
                    "conflict",
                    decision!.rows.length > 1 ? "successor_changed" : "stale_revision",
                    [
                        {
                            memoryId: id,
                            expectedRevision: expected ?? null,
                            currentRevision: current.revision,
                        },
                    ],
                );
            if (
                (decision!.operation.includes("merge") || decision!.operation === "replaces") &&
                current.supersededByMemoryId !== null
            ) {
                const link = db
                    .prepare(
                        "SELECT decision_key FROM memory_successor_links WHERE source_id=? AND successor_id=?",
                    )
                    .get(id, current.supersededByMemoryId) as { decision_key: string } | null;
                if (link?.decision_key !== decision!.decisionKey)
                    return failed("conflict", "successor_changed", [
                        {
                            memoryId: id,
                            expectedRevision: expected ?? null,
                            currentRevision: current.revision,
                        },
                    ]);
            }
            if (!row.before || row.role === "survivor" || decision!.survivorId === id) {
                const dependents = db
                    .prepare("SELECT id FROM memories WHERE superseded_by_memory_id=?")
                    .all(id) as Array<{ id: number }>;
                if (dependents.some((source) => !ids.includes(source.id)))
                    return failed("conflict", "successor_changed");
            }
            if (!row.before) {
                target.status = "archived";
                target.supersededByMemoryId = null;
            } else
                for (const field of [
                    "category",
                    "content",
                    "importance",
                    "scope",
                    "status",
                    "expiresAt",
                    "supersededByMemoryId",
                    "mergedFrom",
                    "metadataJson",
                    "safetyCritical",
                    "sourceSessionId",
                    "sourceType",
                ] as const)
                    Object.assign(target, { [field]: row.before[field] });
            if (row.before && ["new", "conflict"].includes(decision!.operation)) {
                target.seenCount = row.before.seenCount;
                target.lastSeenAt = row.before.lastSeenAt;
            }
        } else {
            const change = request.changes.find((row) => row.memoryId === id)!;
            if (change.content !== undefined) target.content = change.content.trim();
            if (change.category !== undefined) target.category = change.category as MemoryCategory;
            if (change.status !== undefined) target.status = change.status;
        }
        if (
            !target.content.trim() ||
            target.content.length > 20_000 ||
            !categories.has(target.category) ||
            !["active", "permanent", "archived"].includes(target.status) ||
            !["project", "ecosystem", "universe"].includes(target.scope)
        )
            return failed("refused", "invalid_request");
        target.normalizedHash = computeNormalizedHash(target.content);
        target.shareable = 0;
        target.verificationStatus = "unverified";
        target.verifiedAt = null;
        target.updatedAt = now;
        target.revision = current.revision + 1;
        before.push(current);
        after.push(target);
    }
    if (
        !restoring &&
        after.every((target, index) =>
            ["content", "category", "status"].every(
                (field) =>
                    target[field as keyof MemoryHistorySnapshot] ===
                    before[index]![field as keyof MemoryHistorySnapshot],
            ),
        )
    )
        return failed("refused", "no_change");
    for (const target of after) {
        if (
            after.some(
                (other) =>
                    other.id !== target.id &&
                    other.category === target.category &&
                    other.normalizedHash === target.normalizedHash,
            )
        )
            return failed("conflict", "duplicate_content");
        const collisions = db
            .prepare(
                "SELECT id FROM memories WHERE project_path=? AND category=? AND normalized_hash=? AND id!=?",
            )
            .all(target.projectPath, target.category, target.normalizedHash, target.id) as Array<{
            id: number;
        }>;
        const collision = collisions.find((row) => !ids.includes(row.id));
        if (collision)
            return failed("conflict", "duplicate_content", [
                {
                    memoryId: target.id,
                    expectedRevision: target.revision - 1,
                    currentRevision: target.revision - 1,
                    duplicateId: collision.id,
                },
            ]);
        if (
            target.supersededByMemoryId !== null &&
            (target.supersededByMemoryId === target.id ||
                memoryHistorySnapshot(db, target.supersededByMemoryId)?.projectPath !==
                    request.projectPath)
        )
            return failed("refused", "target_not_owned");
    }
    return { state: "ready", reason: null, conflicts: [], before, after, decision };
}

function applyPlannedWrite(
    db: Database,
    plan: Plan,
    key: string,
    projectPath: string,
    now: number,
    writer: string,
): MemoryHistoryDecision {
    for (const source of plan.before) {
        db.prepare(
            "UPDATE memories SET normalized_hash=?,revision=revision+1 WHERE id=? AND revision=?",
        ).run(`history-pending:${key}:${source.id}`, source.id, source.revision);
        if ((db.prepare("SELECT changes() n").get() as { n: number }).n !== 1)
            throw new Error("Memory revision changed during apply");
    }
    for (const [index, target] of plan.after.entries()) {
        const source = plan.before[index]!;
        db.prepare(
            "UPDATE memories SET content=?,category=?,normalized_hash=?,importance=?,scope=?,status=?,expires_at=?,superseded_by_memory_id=?,merged_from=?,metadata_json=?,safety_critical=?,source_session_id=?,source_type=?,seen_count=?,last_seen_at=?,shareable=0,classified_at=NULL,verification_status='unverified',verified_at=NULL,updated_at=? WHERE id=? AND revision=?",
        ).run(
            target.content,
            target.category,
            target.normalizedHash,
            target.importance,
            target.scope,
            target.status,
            target.expiresAt,
            target.supersededByMemoryId,
            target.mergedFrom,
            target.metadataJson,
            target.safetyCritical,
            target.sourceSessionId,
            target.sourceType,
            target.seenCount,
            target.lastSeenAt,
            now,
            target.id,
            source.revision + 1,
        );
        const changed = db.prepare("SELECT changes() n").get() as { n: number };
        if (changed.n !== 1) throw new Error("Memory revision changed during apply");
        const restored = plan.decision?.rows.find((row) => row.memoryId === target.id)?.before;
        if (restored)
            // Evidence is revision-scoped: restoring text publishes its original evidence at the new revision.
            db.prepare(
                "INSERT INTO memory_clause_evidence(memory_id,revision,clause_ordinal,text_hash,evidence_json) SELECT memory_id,?,clause_ordinal,text_hash,evidence_json FROM memory_clause_evidence WHERE memory_id=? AND revision=?",
            ).run(target.revision, target.id, restored.revision);
        db.prepare("DELETE FROM memory_embeddings WHERE memory_id=?").run(target.id);
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_verifications'").get())
            db.prepare("DELETE FROM memory_verifications WHERE memory_id=?").run(target.id);
        const columns = new Set(
            (db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>).map(
                (column) => column.name,
            ),
        );
        const derived = [
            "mural_cue",
            "mural_cue_hash",
            "mural_cue_at",
            "verify_result",
            "verify_files_json",
            "verify_commit",
        ].filter((column) => columns.has(column));
        if (derived.length)
            db.prepare(
                `UPDATE memories SET ${derived.map((column) => `${column}=NULL`).join(",")} WHERE id=?`,
            ).run(target.id);
    }
    if (plan.decision) {
        db.prepare("DELETE FROM memory_successor_links WHERE decision_key=?").run(
            plan.decision.decisionKey,
        );
        db.prepare("DELETE FROM memory_conflict_links WHERE decision_key=?").run(
            plan.decision.decisionKey,
        );
    }
    for (const target of plan.after)
        if (target.supersededByMemoryId !== null)
            db.prepare(
                "INSERT OR IGNORE INTO memory_successor_links(source_id,successor_id,decision_key) VALUES(?,?,?)",
            ).run(target.id, target.supersededByMemoryId, key);
    const decision = makeMemoryHistoryDecision({
        key,
        projectPath,
        writer,
        operation: writer === "dashboard_restore" ? "restore" : "edit",
        reason: plan.decision ? `restore:${plan.decision.decisionKey}` : "dashboard_edit",
        now,
        before: plan.before,
        after: plan.after,
        sourceIds: plan.before.map((row) => row.id),
        evidence: plan.decision
            ? {
                  restoredDecisionKey: plan.decision.decisionKey,
                  originalEvidence: plan.decision.evidence,
              }
            : [],
    });
    recordMemoryHistoryDecision(db, decision);
    // Keep dashboard deltas atomic with the audited canonical edit.
    for (const target of plan.after) {
        db.prepare(`INSERT INTO memory_mutation_log
            (project_path, mutation_type, target_memory_id, superseded_by_id, category, new_content, queued_at, operation_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
            projectPath,
            target.supersededByMemoryId !== null
                ? "superseded"
                : target.status === "archived"
                  ? "archive"
                  : "update",
            target.id,
            target.supersededByMemoryId,
            target.category,
            target.content,
            now,
            `dashboard:${key}`,
        );
    }
    const epochProject =
        projectPath.startsWith("git:") || projectPath.startsWith("dir:")
            ? projectPath
            : `dir:${createHash("md5").update(resolve(projectPath)).digest("hex").slice(0, 12)}`;
    const identities = new Set([epochProject]);
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='workspace_members'").get())
        for (const member of db
            .prepare(
                "SELECT project_path FROM workspace_members WHERE workspace_id IN (SELECT workspace_id FROM workspace_members WHERE project_path=?)",
            )
            .all(epochProject) as Array<{ project_path: string }>)
            identities.add(member.project_path);
    for (const identity of [...identities].sort()) bumpProjectMemoryEpoch(db, identity, now);
    return decision;
}

function write(
    db: Database,
    request: MemoryRestoreRequest | MemoryEditRequest,
    now: number,
): MemoryRestoreReceipt | MemoryEditReceipt {
    const restore = "decisionKey" in request;
    const receipt = (
        state: MemoryEditReceipt["state"],
        reason: string | null,
        key: string | null,
        revisions: MemoryRevisionExpectation[] = [],
        conflicts: MemoryWriteConflict[] = [],
    ): MemoryEditReceipt | MemoryRestoreReceipt =>
        restore
            ? {
                  version: 1,
                  state,
                  projectPath: request.projectPath,
                  operationId: request.operationId,
                  reason,
                  decisionKey: request.decisionKey,
                  restoredDecisionKey: key,
                  revisions,
                  conflicts,
                  adoption: "next_allowed_bust",
              }
            : {
                  version: 1,
                  state,
                  projectPath: request.projectPath,
                  operationId: request.operationId,
                  reason,
                  decisionKey: key,
                  revisions,
                  conflicts,
              };
    if (!request.operationId || request.operationId.length > 128)
        return receipt("refused", "invalid_request", null);
    const key = memoryHistoryJson([
        restore ? "memory-restore" : "memory-edit",
        request.projectPath,
        request.operationId,
    ]);
    const identity = memoryHistoryJson({
        ...request,
        expectedRevisions: [...request.expectedRevisions].sort((a, b) => a.memoryId - b.memoryId),
    });
    const changedIds: number[] = [];
    const result = db
        .transaction(() => {
            if (!tsOwnsMemory(db, request.projectPath))
                return receipt("refused", "authority_unavailable", null);
            const otherKey = memoryHistoryJson([
                restore ? "memory-edit" : "memory-restore",
                request.projectPath,
                request.operationId,
            ]);
            if (
                db
                    .prepare(
                        "SELECT 1 FROM memory_decision_receipts WHERE decision_key=? AND project_path=?",
                    )
                    .get(otherKey, request.projectPath)
            )
                return receipt("refused", "operation_id_reused", null);
            const saved = db
                .prepare(
                    "SELECT receipt_json FROM memory_decision_receipts WHERE decision_key=? AND project_path=?",
                )
                .get(key, request.projectPath) as { receipt_json: string } | null;
            if (saved) {
                const value = JSON.parse(saved.receipt_json) as {
                    identity: string;
                    receipt: MemoryEditReceipt | MemoryRestoreReceipt;
                };
                return value.identity === identity
                    ? value.receipt
                    : receipt("refused", "operation_id_reused", null);
            }
            const plan = planMemoryWrite(db, request, now, true);
            let result: MemoryEditReceipt | MemoryRestoreReceipt;
            if (plan.state !== "ready")
                result = receipt(plan.state, plan.reason, null, [], plan.conflicts);
            else {
                const decision = applyPlannedWrite(
                    db,
                    plan,
                    key,
                    request.projectPath,
                    now,
                    restore ? "dashboard_restore" : "dashboard_edit",
                );
                changedIds.push(...plan.after.map((row) => row.id));
                result = receipt(
                    "applied",
                    null,
                    key,
                    plan.after.map((row) => ({ memoryId: row.id, revision: row.revision })),
                );
                db.prepare(
                    "INSERT INTO memory_journal(project_path,decision_key,operation,receipt_json,applied_at,before_json,after_json) VALUES(?,?,?,?,?,?,?)",
                ).run(
                    request.projectPath,
                    key,
                    decision.writer,
                    memoryHistoryJson(result),
                    now,
                    memoryHistoryJson(decision),
                    memoryHistoryJson(decision),
                );
            }
            db.prepare(
                "INSERT INTO memory_decision_receipts(decision_key,project_path,fact_id,receipt_json,resolved_at) VALUES(?,?,NULL,?,?)",
            ).run(key, request.projectPath, memoryHistoryJson({ identity, receipt: result }), now);
            return result;
        })
        .immediate();
    for (const id of changedIds) invalidateMemory(request.projectPath, id);
    return result;
}
export function applyMemoryRestore(
    db: Database,
    request: MemoryRestoreRequest,
    now = Date.now(),
): MemoryRestoreReceipt {
    validateWriteRequest(request, true);
    return write(db, request, now) as MemoryRestoreReceipt;
}
export function applyDashboardMemoryEdit(
    db: Database,
    request: MemoryEditRequest,
    now = Date.now(),
): MemoryEditReceipt {
    validateWriteRequest(request, false);
    return write(db, request, now) as MemoryEditReceipt;
}
export function previewMemoryRestore(
    db: Database,
    request: Pick<MemoryRestoreRequest, "projectPath" | "decisionKey">,
): MemoryRestorePreview {
    return db
        .transaction(() => {
            const plan = planMemoryWrite(
                db,
                { ...request, operationId: "preview", expectedRevisions: [] },
                Date.now(),
                false,
                false,
            );
            const decision =
                plan.decision ??
                readMemoryHistoryDecision(db, request.projectPath, request.decisionKey);
            const currentRows =
                decision?.rows
                    .map((row) => memoryHistorySnapshot(db, row.memoryId))
                    .filter(
                        (row): row is MemoryHistorySnapshot =>
                            row !== null && row.projectPath === request.projectPath,
                    ) ?? [];
            return {
                version: 1,
                state: plan.state,
                projectPath: request.projectPath,
                decisionKey: request.decisionKey,
                reason: plan.reason,
                decision,
                expectedRevisions: currentRows.map((row) => ({
                    memoryId: row.id,
                    revision: row.revision,
                })),
                changes: plan.after.map((after, index) => ({
                    memoryId: after.id,
                    before: plan.before[index]!,
                    after,
                })),
                adoption: "next_allowed_bust",
            } as MemoryRestorePreview;
        })
        .deferred();
}

function validateWriteRequest(
    request: MemoryRestoreRequest | MemoryEditRequest,
    restoring: boolean,
): void {
    const record = (value: unknown): value is Record<string, unknown> =>
        value !== null && typeof value === "object" && !Array.isArray(value);
    const allowed = restoring
        ? ["projectPath", "operationId", "decisionKey", "expectedRevisions"]
        : ["projectPath", "operationId", "expectedRevisions", "changes"];
    if (
        !record(request) ||
        Object.keys(request).some((key) => !allowed.includes(key)) ||
        typeof request.projectPath !== "string" ||
        typeof request.operationId !== "string" ||
        !Array.isArray(request.expectedRevisions) ||
        request.expectedRevisions.some(
            (row) =>
                !record(row) ||
                Object.keys(row).some((key) => !["memoryId", "revision"].includes(key)) ||
                typeof row.memoryId !== "number" ||
                typeof row.revision !== "number",
        )
    )
        throw new Error("invalid_request");
    if (restoring) {
        if (!("decisionKey" in request) || typeof request.decisionKey !== "string")
            throw new Error("invalid_request");
    } else if (
        !("changes" in request) ||
        !Array.isArray(request.changes) ||
        request.changes.some(
            (row) =>
                !record(row) ||
                typeof row.memoryId !== "number" ||
                Object.keys(row).some(
                    (key) => !["memoryId", "content", "category", "status"].includes(key),
                ) ||
                ["content", "category", "status"].some(
                    (key) => key in row && typeof row[key] !== "string",
                ),
        )
    )
        throw new Error("invalid_request");
}
export function validateMemoryWriteRequest(
    request: MemoryRestoreRequest | MemoryEditRequest,
    method: "memory.restore" | "memory.edit",
): void {
    validateWriteRequest(request, method === "memory.restore");
}
