import { sessionLog } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";
import { queueMemoryMutation } from "../storage-memory-mutation-log";
import {
    recordAgentFragment,
    renderAddedFragmentLine,
    renderRemovedFragmentLine,
    renderSupersededFragmentLine,
    renderUpdatedFragmentLine,
} from "./agent-fragments";
import { sessionShowsMemoryText } from "./applied-projection";
import { CATEGORY_DEFAULT_TTL } from "./constants";
import { embedTextForProject } from "./embedding";
import { invalidateMemory } from "./embedding-cache";
import {
    makeMemoryHistoryDecision,
    memoryHistoryJson,
    memoryHistorySnapshot,
    normalizeMemoryHistorySnapshot,
    recordMemoryHistoryDecision,
} from "./history-applier";
import type { MemoryHistoryDecision } from "./history-contract";
import { checkMemoryRevision } from "./lifecycle-check-ledger";
import { MAX_STAGE2_ATTEMPTS } from "./lifecycle-constants";
import type { CheckReply, CheckRequest, ReportedProfile } from "./lifecycle-gates";
import {
    type GateContext,
    type GatePlan,
    planMemoryRevision,
    type RevisionDecision,
} from "./lifecycle-gates";
import { lifecycleTextHash, splitMemoryClauses } from "./lifecycle-text";
import { computeNormalizedHash } from "./normalize-hash";
import { normalizeStoredProjectPath } from "./project-identity";
import {
    archiveMemory,
    getMemoryByHash,
    getMemoryById,
    inheritMemorySafety,
    insertMemory,
    ModuleMemoryAuthorityError,
    mergeMemoryStats,
    supersededMemory,
    updateMemoryContent,
    updateMemorySeenCount,
} from "./storage-memory";
import { saveEmbeddingIfHashMatches } from "./storage-memory-embeddings";
import { recordMemoryVerifications } from "./storage-memory-verifications";

export {
    applyDashboardMemoryEdit,
    applyMemoryRestore,
    listMemoryHistory,
    previewMemoryRestore,
} from "./history-applier";

import type { Memory, MemoryInput } from "./types";

export type AdoptionClass = "live" | "deferred" | null;
export function memoryAdoptionClass(operation: string): AdoptionClass {
    if (["new", "conflict", "agent_save", "seen_count"].includes(operation)) return null;
    return ["edit", "merge", "replaces", "dashboard_content", "dashboard_archive"].includes(
        operation,
    )
        ? "live"
        : "deferred";
}
export interface ApplierReceipt {
    state: "applied" | "covered" | "decided_pending" | "retryable";
    reason: string;
    memoryId?: number;
    inserted?: boolean;
    adoptionClass: AdoptionClass;
    supersededIds?: number[];
    /**
     * The model profile the provider reported, recorded when the decision was deferred
     * because that profile (or one of its checks) is not a replay-validated one.
     */
    reportedProfile?: ReportedProfile;
    verificationResult?: VerificationResult;
}

export type VerificationResult =
    | "confirmed"
    | "unmapped"
    | "skipped"
    | "refused"
    | "failed"
    | "stale"
    | "updated"
    | "archived";
export interface MemoryVerificationRequest {
    key: string;
    projectPath: string;
    memoryId: number;
    expectedRevision: number;
    contentHashAtPrompt: string;
    kind: "verified" | "update" | "archive" | "skipped" | "unmapped" | "failed";
    files: string[];
    checkedCommit: string | null;
    sourceCommitMatches: boolean;
    checkedAt: number;
    content?: string;
    reason?: string;
    refusalReason?: string;
}

/** Apply code-check results and authorized automated corrections under one revision-bound transaction. */
export function applyMemoryVerification(
    db: Database,
    request: MemoryVerificationRequest,
): ApplierReceipt {
    return db
        .transaction(() => {
            const recovered = readReceipt(db, request.key);
            if (recovered) return recovered;
            const record = (
                state: ApplierReceipt["state"],
                reason: string,
                result: VerificationResult,
            ) =>
                recordReceipt(
                    db,
                    {
                        key: request.key,
                        projectPath: request.projectPath,
                        operation: "verification",
                    },
                    {
                        state,
                        reason,
                        memoryId: request.memoryId,
                        adoptionClass: "deferred",
                        verificationResult: result,
                    },
                );
            if (!tsOwnsMemory(db, request.projectPath))
                throw new ModuleMemoryAuthorityError(request.projectPath);
            const memory = getMemoryById(db, request.memoryId);
            if (
                !memory ||
                normalizeStoredProjectPath(memory.projectPath) !==
                    normalizeStoredProjectPath(request.projectPath)
            )
                return record("decided_pending", "target_not_owned", "stale");
            if (
                memory.status === "archived" ||
                memory.supersededByMemoryId !== null ||
                getMemoryRevision(db, memory.id) !== request.expectedRevision ||
                memory.normalizedHash !== request.contentHashAtPrompt
            )
                return record("decided_pending", "stale_revision", "stale");
            const mutation = request.kind === "update" || request.kind === "archive";
            let refusalReason = request.refusalReason;
            if (
                request.kind === "update" &&
                (!request.content?.trim() || request.content.trim().length > 20_000)
            )
                refusalReason = "invalid_content";
            let result: VerificationResult = !request.sourceCommitMatches
                ? "failed"
                : refusalReason
                  ? "refused"
                  : request.kind === "update"
                    ? request.files.length > 0
                        ? "updated"
                        : "unmapped"
                    : request.kind === "archive"
                      ? "archived"
                      : request.kind === "verified"
                        ? request.files.length > 0
                            ? "confirmed"
                            : "unmapped"
                        : request.kind;
            if (mutation && request.sourceCommitMatches && !refusalReason) {
                try {
                    const receipt = applyMemoryMutation(
                        db,
                        {
                            key: `${request.key}:mutation`,
                            projectPath: request.projectPath,
                            operation: request.kind as "update" | "archive",
                            targets: [{ id: memory.id, revision: request.expectedRevision }],
                            content: request.content,
                            reason: request.reason ?? `verify_${request.kind}`,
                            sourceSessionId: "",
                        },
                        true,
                        "verify",
                    );
                    if (receipt.state !== "applied") refusalReason = receipt.reason;
                    else if (request.kind === "update")
                        db.prepare(
                            "UPDATE memories SET verification_status='unverified',verified_at=NULL WHERE id=?",
                        ).run(memory.id);
                } catch (error) {
                    if (!(error instanceof MemoryContentDuplicateError)) throw error;
                    refusalReason = `duplicate_of:${error.memoryId}`;
                }
                if (refusalReason) result = "refused";
            }
            db.prepare(
                "UPDATE memories SET verify_result=?,verify_files_json=?,verify_commit=? WHERE id=?",
            ).run(result, JSON.stringify(request.files), request.checkedCommit, memory.id);
            if (result === "refused")
                return record("decided_pending", refusalReason ?? "refused", result);
            if (result === "confirmed" || (result === "updated" && request.files.length > 0)) {
                recordMemoryVerifications(db, memory.id, request.files, request.checkedAt);
                let metadata: Record<string, unknown> = {};
                try {
                    metadata = JSON.parse(memory.metadataJson ?? "{}");
                } catch {
                    /* Legacy metadata may be malformed. */
                }
                if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
                    metadata = {};
                db.prepare(
                    "UPDATE memories SET verification_status='verified',verified_at=?,metadata_json=? WHERE id=?",
                ).run(
                    request.checkedAt,
                    JSON.stringify({
                        ...metadata,
                        dreamerVerifiedAt: request.checkedAt,
                        dreamerVerifiedCommit: request.checkedCommit,
                    }),
                    memory.id,
                );
            }
            if (mutation && !refusalReason) {
                const mutationKey = `${request.key}:mutation`;
                const saved = db
                    .prepare("SELECT before_json FROM memory_journal WHERE decision_key=?")
                    .get(mutationKey) as { before_json: string } | null;
                if (saved) {
                    const decision = JSON.parse(saved.before_json) as MemoryHistoryDecision;
                    const after = memoryHistorySnapshot(db, memory.id)!;
                    decision.rows[0]!.after = after;
                    db.prepare(
                        "UPDATE memory_history SET after_json=? WHERE decision_key=? AND memory_id=?",
                    ).run(
                        memoryHistoryJson({ version: 1, snapshot: after }),
                        mutationKey,
                        memory.id,
                    );
                    db.prepare(
                        "UPDATE memory_journal SET before_json=?,after_json=? WHERE decision_key=?",
                    ).run(memoryHistoryJson(decision), memoryHistoryJson(decision), mutationKey);
                }
            }
            const receipt = record(
                "applied",
                request.sourceCommitMatches ? result : "source_commit_changed",
                result,
            );
            db.prepare("UPDATE memory_journal SET after_json=? WHERE decision_key=?").run(
                JSON.stringify({
                    files: request.files,
                    checkedCommit: request.checkedCommit,
                    revision: request.expectedRevision,
                }),
                request.key,
            );
            return receipt;
        })
        .immediate();
}

export interface MemoryFactReservation {
    stageKey: string;
    factId: number;
    projectPath: string;
    factAttempts: number;
}

export class MemoryStageOwnershipLostError extends Error {
    constructor() {
        super("memory stage no longer owns the fact reservation");
        this.name = "MemoryStageOwnershipLostError";
    }
}

/** Recheck the send's reservation under the resolving write lock; memory revision CAS does not revoke a released send. */
export function assertMemoryFactReservation(
    db: Database,
    reservation: MemoryFactReservation,
): void {
    const owned = db
        .prepare(
            `SELECT 1 FROM memory_pending_facts f JOIN memory_stage_attempts s ON s.stage_key=f.reserved_stage_key
         WHERE f.id=? AND f.project_path=? AND f.state='in_flight' AND f.fact_attempts=?
           AND s.stage_key=? AND s.project_path=f.project_path AND s.stage='turn_two' AND s.state='replied'`,
        )
        .get(
            reservation.factId,
            reservation.projectPath,
            reservation.factAttempts,
            reservation.stageKey,
        );
    if (!owned) throw new MemoryStageOwnershipLostError();
}
export interface AdmissionRequest {
    key: string;
    operation: "new" | "conflict" | "agent_save";
    input: MemoryInput;
    memoryEnabled?: boolean;
    autoPromote?: boolean;
    conflictTargetId?: number;
    factId?: number;
    reservation?: MemoryFactReservation;
    classificationAnchor?: { toolCallPartId: string; saveOrdinal: number };
    /** Harness of `input.sourceSessionId`, for an agent save's m[1] fragment. */
    sourceHarness?: string;
}
export function resolveExpiresAt(category: MemoryInput["category"]): number | null {
    const ttl = CATEGORY_DEFAULT_TTL[category];
    return ttl === undefined ? null : Date.now() + ttl;
}
function readReceipt(db: Database, key: string): ApplierReceipt | null {
    const row = db
        .prepare("SELECT receipt_json FROM memory_decision_receipts WHERE decision_key=?")
        .get(key) as { receipt_json: string } | null;
    return row ? (JSON.parse(row.receipt_json) as ApplierReceipt) : null;
}
function recordReceipt(
    db: Database,
    request: { key: string; projectPath: string; factId?: number; operation: string },
    receipt: ApplierReceipt,
): ApplierReceipt {
    const json = JSON.stringify(receipt);
    db.prepare(
        "INSERT INTO memory_decision_receipts(decision_key,project_path,fact_id,receipt_json,resolved_at) VALUES(?,?,?,?,?)",
    ).run(request.key, request.projectPath, request.factId ?? null, json, Date.now());
    if (receipt.state === "applied")
        db.prepare(
            "INSERT INTO memory_journal(project_path,decision_key,operation,receipt_json,applied_at) VALUES(?,?,?,?,?)",
        ).run(request.projectPath, request.key, request.operation, json, Date.now());
    if (request.factId !== undefined)
        db.prepare(
            "UPDATE memory_pending_facts SET state=?,reason=?,matched_memory_id=?,reserved_stage_key=NULL WHERE id=? AND project_path=?",
        ).run(
            receipt.state,
            receipt.reason,
            receipt.memoryId ?? null,
            request.factId,
            request.projectPath,
        );
    return receipt;
}
/** True when this TypeScript process holds memory authority for the project. */
export function tsOwnsMemory(db: Database, projectPath: string): boolean {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='authority_managed'").get())
        return true;
    return !db
        .prepare(
            "SELECT 1 FROM authority_managed WHERE project_path=? UNION SELECT 1 FROM authority_repair_pending WHERE project_path=? LIMIT 1",
        )
        .get(projectPath, projectPath);
}
function linkConflict(db: Database, key: string, left: number, right: number): void {
    db.prepare(
        "INSERT OR IGNORE INTO memory_conflict_links(left_id,right_id,decision_key) VALUES(?,?,?)",
    ).run(Math.min(left, right), Math.max(left, right), key);
}

/** New rows surface on existing render opportunities; admission must not invalidate cached prompts. */
export function applyMemoryAdmission(db: Database, request: AdmissionRequest): ApplierReceipt {
    return db
        .transaction(() => {
            const existingReceipt = readReceipt(db, request.key);
            if (existingReceipt) return existingReceipt;
            if (request.reservation) assertMemoryFactReservation(db, request.reservation);
            const record = (receipt: ApplierReceipt) =>
                recordReceipt(
                    db,
                    {
                        key: request.key,
                        projectPath: request.input.projectPath,
                        factId: request.factId,
                        operation: request.operation,
                    },
                    receipt,
                );
            const pending = (reason: string, memoryId?: number) =>
                record({ state: "decided_pending", reason, memoryId, adoptionClass: null });
            if (!request.memoryEnabled && request.memoryEnabled !== undefined)
                return pending("memory_disabled");
            if (!tsOwnsMemory(db, request.input.projectPath))
                return record({
                    state: "retryable",
                    reason: "authority_elsewhere",
                    adoptionClass: null,
                });
            if (!request.input.content.trim()) return pending("empty_content");
            const target =
                request.operation === "conflict"
                    ? getMemoryById(db, request.conflictTargetId ?? -1)
                    : null;
            if (
                request.operation === "conflict" &&
                (!target ||
                    target.projectPath !== request.input.projectPath ||
                    target.status === "archived")
            )
                return pending("conflict_target");
            if (request.operation !== "agent_save" && request.autoPromote === false)
                return pending("auto_promote_disabled", target?.id);
            if (request.operation === "agent_save" && request.classificationAnchor) {
                const prior = db
                    .prepare(
                        "SELECT memory_id FROM memory_classification_items WHERE project_path=? AND source_session_id=? AND tool_call_part_id=?",
                    )
                    .get(
                        request.input.projectPath,
                        request.input.sourceSessionId ?? "",
                        request.classificationAnchor.toolCallPartId,
                    ) as { memory_id: number } | null;
                if (prior)
                    return record({
                        state: "applied",
                        reason: "saved",
                        memoryId: prior.memory_id,
                        inserted: false,
                        adoptionClass: null,
                    });
            }
            const hash = computeNormalizedHash(request.input.content);
            const match = getMemoryByHash(
                db,
                request.input.projectPath,
                request.input.category,
                hash,
            );
            if (match?.status === "archived") return pending("archived_match", match.id);
            const cross = db
                .prepare(
                    "SELECT id FROM memories WHERE project_path=? AND category!=? AND normalized_hash=? AND content=? AND status!='archived' ORDER BY id LIMIT 1",
                )
                .get(
                    request.input.projectPath,
                    request.input.category,
                    hash,
                    request.input.content,
                ) as { id: number } | null;
            if (!match && cross) return pending("cross_category_match", cross.id);
            if (target && match?.id === target.id) return pending("self_conflict", target.id);
            const before = match ? memoryHistorySnapshot(db, match.id) : null;
            const conflictBefore = target ? memoryHistorySnapshot(db, target.id) : null;
            let memory: Memory;
            if (match) {
                updateMemorySeenCount(db, match.id);
                if (request.operation !== "agent_save")
                    db.prepare("UPDATE memories SET revision=revision+1 WHERE id=?").run(match.id);
                memory = getMemoryById(db, match.id)!;
            } else {
                memory = insertMemory(db, {
                    ...request.input,
                    // A dreamer save keeps its provenance; every other save is the agent's.
                    sourceType:
                        request.operation !== "agent_save"
                            ? "historian"
                            : request.input.sourceType === "dreamer"
                              ? "dreamer"
                              : "agent",
                    importance: request.operation === "agent_save" ? 50 : request.input.importance,
                    expiresAt:
                        request.operation === "agent_save"
                            ? request.input.expiresAt
                            : resolveExpiresAt(request.input.category),
                });
            }
            if (target) {
                linkConflict(db, request.key, memory.id, target.id);
                // The relationship changes both endpoints; keep pre-conflict decisions stale after undo.
                db.prepare("UPDATE memories SET revision=revision+1 WHERE id=?").run(target.id);
            }
            // An agent's own save surfaces in its session's m[1] as a fragment, including a
            // save that matched an existing memory this session does not show: the agent
            // asked for it, so it must reach the agent's own session. Historian admissions
            // and dreamer saves are automated: no fragment, so they wait for the next HARD
            // fold.
            if (
                request.operation === "agent_save" &&
                request.input.sourceSessionId &&
                request.input.sourceType !== "dreamer" &&
                (!match ||
                    !sessionShowsMemoryText(
                        db,
                        request.input.sourceSessionId,
                        memory.id,
                        memory.content,
                    ))
            )
                recordAgentFragment(db, {
                    sessionId: request.input.sourceSessionId,
                    harness: request.sourceHarness,
                    projectPath: request.input.projectPath,
                    operationKey: request.key,
                    memoryIds: [memory.id],
                    currentId: memory.id,
                    lines: [renderAddedFragmentLine(memory.id, memory.category, memory.content)],
                    visibleTexts: [{ id: memory.id, text: memory.content }],
                });
            if (request.operation === "agent_save" && request.classificationAnchor) {
                db.prepare(
                    "INSERT OR IGNORE INTO memory_classification_items(project_path,memory_id,saved_revision,source_session_id,tool_call_part_id,save_ordinal) SELECT project_path,id,revision,?,?,? FROM memories WHERE id=?",
                ).run(
                    request.input.sourceSessionId ?? "",
                    request.classificationAnchor.toolCallPartId,
                    request.classificationAnchor.saveOrdinal,
                    memory.id,
                );
            }
            const receipt = record({
                state: "applied",
                reason: match ? "live_match" : "inserted",
                memoryId: memory.id,
                inserted: !match,
                adoptionClass: null,
            });
            if (request.operation !== "agent_save") {
                // Admission changes no existing text, so its new revisions retain clause evidence.
                for (const source of [before, conflictBefore])
                    if (source)
                        db.prepare(
                            "INSERT INTO memory_clause_evidence(memory_id,revision,clause_ordinal,text_hash,evidence_json) SELECT memory_id,?,clause_ordinal,text_hash,evidence_json FROM memory_clause_evidence WHERE memory_id=? AND revision=?",
                        ).run(source.revision + 1, source.id, source.revision);
                const decision = makeMemoryHistoryDecision({
                    key: request.key,
                    projectPath: request.input.projectPath,
                    writer: "historian",
                    operation: request.operation,
                    reason: receipt.reason,
                    now: Date.now(),
                    before: [before, ...(conflictBefore ? [conflictBefore] : [])],
                    after: [
                        memoryHistorySnapshot(db, memory.id)!,
                        ...(target ? [memoryHistorySnapshot(db, target.id)!] : []),
                    ],
                    sourceIds: [...(match ? [match.id] : []), ...(target ? [target.id] : [])],
                    survivorId: memory.id,
                });
                recordMemoryHistoryDecision(db, decision);
                db.prepare(
                    "UPDATE memory_journal SET before_json=?,after_json=? WHERE decision_key=?",
                ).run(memoryHistoryJson(decision), memoryHistoryJson(decision), request.key);
            }
            return receipt;
        })
        .immediate();
}

/**
 * Resolve a candidate fact without touching any memory row: `covered` (the mapping
 * is recorded on the fact only), and every `decided_pending` outcome that needs no
 * applier write (abstain, a malformed decision, an unsupported operation, a
 * recitation). One transaction writes the receipt keyed by the decision key and the
 * fact's new state; a receipt already recorded under the key wins.
 */
export function resolveFactDecision(
    db: Database,
    request: {
        key: string;
        projectPath: string;
        factId: number;
        reservation?: MemoryFactReservation;
        operation: string;
        /**
         * `retryable` consumes one of the fact's attempts: the fact becomes
         * `retryable`, or `decided_pending` once the attempt reaches
         * `MAX_STAGE2_ATTEMPTS`.
         */
        state: "covered" | "decided_pending" | "retryable";
        reason: string;
        memoryId?: number;
        mapping?: unknown;
    },
): ApplierReceipt {
    return db
        .transaction(() => {
            const existing = readReceipt(db, request.key);
            if (existing) return existing;
            if (request.reservation) assertMemoryFactReservation(db, request.reservation);
            if (request.state === "retryable")
                return resolveRevisionFailure(db, request, request.reason, true);
            const receipt = recordReceipt(db, request, {
                state: request.state,
                reason: request.reason,
                memoryId: request.memoryId,
                adoptionClass: null,
            });
            if (request.mapping !== undefined)
                db.prepare("UPDATE memory_pending_facts SET mapping_json=? WHERE id=?").run(
                    JSON.stringify(request.mapping),
                    request.factId,
                );

            return receipt;
        })
        .immediate();
}

/** Record an automated transaction without signaling an external-editor epoch. */
export function recordAutomatedMemoryEdit(
    db: Database,
    input: { writer: "verify" | "expire"; before: Memory; reason: string },
): void {
    const revision = getMemoryRevision(db, input.before.id);
    if (revision === null) return;
    const before = normalizeMemoryHistorySnapshot(input.before, revision)!;
    db.prepare("UPDATE memories SET revision=revision+1 WHERE id=? AND revision=?").run(
        input.before.id,
        revision,
    );
    const after = memoryHistorySnapshot(db, input.before.id)!;
    const key = `${input.writer}:${input.before.id}:${revision}`;
    const decision = makeMemoryHistoryDecision({
        key,
        projectPath: input.before.projectPath,
        writer: input.writer,
        operation: "archive",
        reason: input.reason,
        now: Date.now(),
        before: [before],
        after: [after],
        sourceIds: [input.before.id],
    });
    recordMemoryHistoryDecision(db, decision);
    db.prepare(
        "INSERT INTO memory_journal(project_path,decision_key,operation,receipt_json,applied_at,before_json,after_json) VALUES(?,?,?,'{}',?,?,?)",
    ).run(
        input.before.projectPath,
        key,
        input.writer,
        decision.appliedAt,
        memoryHistoryJson(decision),
        memoryHistoryJson(decision),
    );
}

export interface AgentMemoryMutation {
    key: string;
    projectPath: string;
    operation: "update" | "merge" | "archive";
    targets: Array<{ id: number; revision: number }>;
    content?: string;
    category?: MemoryInput["category"];
    reason?: string;
    supersededById?: number;
    sourceSessionId: string;
    /** The harness of that session; defaults to this process's harness. */
    sourceHarness?: string;
}
export class MemoryContentDuplicateError extends Error {
    constructor(readonly memoryId: number) {
        super(
            `Memory content already exists as ID ${memoryId}; merge or archive duplicates instead.`,
        );
        this.name = "MemoryContentDuplicateError";
    }
}
export function getMemoryRevision(db: Database, id: number): number | null {
    const row = db.prepare("SELECT revision FROM memories WHERE id=?").get(id) as {
        revision: number;
    } | null;
    return row?.revision ?? null;
}
function snapshotMemoryRow(db: Database, id: number): unknown {
    return db.prepare("SELECT * FROM memories WHERE id=?").get(id) ?? null;
}
function clearAgentMutationDerivedData(db: Database, memory: Memory): void {
    const columns = new Set(
        (db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>).map(
            (column) => column.name,
        ),
    );
    if (columns.has("shareable"))
        db.prepare("UPDATE memories SET shareable=0 WHERE id=?").run(memory.id);
    if (columns.has("classified_at"))
        db.prepare("UPDATE memories SET classified_at=NULL WHERE id=?").run(memory.id);
    db.prepare("DELETE FROM memory_embeddings WHERE memory_id=?").run(memory.id);
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_verifications'").get())
        db.prepare("DELETE FROM memory_verifications WHERE memory_id=?").run(memory.id);
    invalidateMemory(memory.projectPath, memory.id);
}

/**
 * The m[1] lines an agent operation shows its own session (see agent-fragments.ts).
 * A merge shows every superseded source and, unless this session already shows the
 * survivor's current text, the survivor's text; an archive shows each removal.
 */
function agentMutationFragment(
    operation: AgentMemoryMutation["operation"],
    sources: readonly Memory[],
    canonical: Memory | null,
    survivorExisted: boolean,
    category: string,
    finalText: string | undefined,
    survivorShown: boolean,
): {
    memoryIds: number[];
    currentId: number | null;
    lines: string[];
    visibleTexts: Array<{ id: number; text: string }>;
} {
    if (operation === "archive")
        return {
            memoryIds: sources.map((source) => source.id),
            currentId: null,
            lines: sources.map((source) => renderRemovedFragmentLine(source.id)),
            visibleTexts: [],
        };
    if (!canonical || finalText === undefined)
        return { memoryIds: [], currentId: null, lines: [], visibleTexts: [] };
    if (operation === "update")
        return {
            memoryIds: [canonical.id],
            currentId: canonical.id,
            lines: [renderUpdatedFragmentLine(canonical.id, category, finalText)],
            visibleTexts: [{ id: canonical.id, text: finalText }],
        };
    const lines = sources
        .filter((source) => source.id !== canonical.id)
        .map((source) => renderSupersededFragmentLine(source.id, canonical.id));
    const original = sources.find((source) => source.id === canonical.id);
    // The survivor's text is shown unless this session's served pair already shows
    // exactly that text for it. Whether the row is new or changed does not decide it:
    // an unchanged survivor another writer added is still unknown to this session.
    const survivorChanged = !survivorShown;
    if (survivorChanged)
        lines.push(
            survivorExisted && original
                ? renderUpdatedFragmentLine(canonical.id, category, finalText)
                : renderAddedFragmentLine(canonical.id, category, finalText),
        );
    return {
        memoryIds: [
            ...sources.map((source) => source.id).filter((id) => id !== canonical.id),
            canonical.id,
        ],
        currentId: canonical.id,
        lines,
        visibleTexts: survivorChanged ? [{ id: canonical.id, text: finalText }] : [],
    };
}

/** Agent edits also publish prompt-update lines; automated edits wait for a full memory rebuild. */
export function applyAgentMemoryMutation(
    db: Database,
    request: AgentMemoryMutation,
): ApplierReceipt {
    return applyMemoryMutation(db, request, false);
}

/** Curate checks which memories it may read and edit; this transaction rechecks ownership and stored revisions. */
export function applyCurateMemoryMutation(
    db: Database,
    request: AgentMemoryMutation,
): ApplierReceipt {
    return applyMemoryMutation(db, request, true);
}

function applyMemoryMutation(
    db: Database,
    request: AgentMemoryMutation,
    automated: boolean,
    writer = automated ? "curate" : "ctx_memory",
): ApplierReceipt {
    const adoptionClass = automated ? "deferred" : "live";
    const queue = (mutation: Parameters<typeof queueMemoryMutation>[1]) => {
        if (!automated) queueMemoryMutation(db, mutation);
    };
    return db
        .transaction(() => {
            const recovered = readReceipt(db, request.key);
            if (recovered) return recovered;
            const record = (receipt: ApplierReceipt) =>
                recordReceipt(
                    db,
                    {
                        key: request.key,
                        projectPath: request.projectPath,
                        operation: `${writer}_${request.operation}`,
                    },
                    receipt,
                );
            const refuse = (reason: string) =>
                record({ state: "decided_pending", reason, adoptionClass });
            if (
                request.targets.length === 0 ||
                new Set(request.targets.map((target) => target.id)).size !==
                    request.targets.length ||
                (request.operation === "update" && request.targets.length !== 1) ||
                (request.operation === "merge" && request.targets.length < 2)
            )
                return refuse("invalid_targets");
            const sources: Memory[] = [];
            for (const target of request.targets) {
                const memory = getMemoryById(db, target.id);
                if (
                    !memory ||
                    (!automated &&
                        normalizeStoredProjectPath(memory.projectPath) !==
                            normalizeStoredProjectPath(request.projectPath))
                )
                    return refuse("target_not_owned");
                if (!tsOwnsMemory(db, memory.projectPath))
                    throw new ModuleMemoryAuthorityError(memory.projectPath);
                if (
                    getMemoryRevision(db, target.id) !== target.revision ||
                    (!automated &&
                        (memory.status === "archived" || memory.supersededByMemoryId !== null))
                )
                    return refuse("stale_revision");
                sources.push(memory);
            }
            const content = request.content?.trim();
            if (request.operation !== "archive" && !content) return refuse("empty_content");
            if (
                request.operation === "merge" &&
                new Set(sources.map((source) => source.category)).size !== 1
            )
                return refuse("cross_category_merge");
            const first = sources[0]!;
            const category = request.category ?? first.category;
            const hash = content ? computeNormalizedHash(content) : null;
            const duplicate =
                request.operation === "archive"
                    ? null
                    : getMemoryByHash(
                          db,
                          request.operation === "update" ? first.projectPath : request.projectPath,
                          category,
                          hash!,
                      );
            if (duplicate && !sources.some((source) => source.id === duplicate.id))
                throw new MemoryContentDuplicateError(duplicate.id);
            const before = sources.map((source) => snapshotMemoryRow(db, source.id));
            // Take every revision before changing any row. A failed source CAS rolls the whole operation back.
            for (const target of request.targets) {
                db.prepare(
                    automated
                        ? "UPDATE memories SET revision=revision+1 WHERE id=? AND revision=?"
                        : "UPDATE memories SET revision=revision+1 WHERE id=? AND revision=? AND status!='archived' AND superseded_by_memory_id IS NULL",
                ).run(target.id, target.revision);
                const result = db.prepare("SELECT changes() AS n").get() as { n: number };
                if (result.n !== 1) throw new Error("Memory revision changed during apply");
            }
            let canonical: Memory | null = null;
            const supersededIds: number[] = [];
            if (request.operation === "update") {
                updateMemoryContent(db, first.id, content!, hash!);
                db.prepare("UPDATE memories SET category=? WHERE id=?").run(category, first.id);
                queue({
                    projectPath: normalizeStoredProjectPath(first.projectPath),
                    mutationType: "update",
                    targetMemoryId: first.id,
                    category,
                    newContent: content!,
                });
                canonical = getMemoryById(db, first.id);
            } else if (request.operation === "archive") {
                for (const source of sources) {
                    archiveMemory(db, source.id, request.reason);
                    if (automated && request.supersededById !== undefined) {
                        supersededMemory(db, source.id, request.supersededById);
                        db.prepare(
                            "INSERT OR IGNORE INTO memory_successor_links(source_id,successor_id,decision_key) VALUES(?,?,?)",
                        ).run(source.id, request.supersededById, request.key);
                    }
                    clearAgentMutationDerivedData(db, source);
                    queue({
                        projectPath: normalizeStoredProjectPath(source.projectPath),
                        mutationType: "archive",
                        targetMemoryId: source.id,
                        operationId: request.key,
                    });
                }
            } else {
                canonical =
                    duplicate ??
                    insertMemory(db, {
                        projectPath: request.projectPath,
                        category,
                        content: content!,
                        sourceSessionId: request.sourceSessionId,
                        sourceType: automated ? "dreamer" : "agent",
                    });
                if (!duplicate) before.push(null);
                const assessment = inheritMemorySafety(sources, canonical.importance);
                db.prepare("UPDATE memories SET safety_critical=?,importance=? WHERE id=?").run(
                    assessment.safetyCritical,
                    assessment.importance,
                    canonical.id,
                );
                const changed = canonical.content !== content || canonical.normalizedHash !== hash;
                if (changed) {
                    updateMemoryContent(db, canonical.id, content!, hash!);
                    queue({
                        projectPath: normalizeStoredProjectPath(canonical.projectPath),
                        mutationType: "update",
                        targetMemoryId: canonical.id,
                        category,
                        newContent: content!,
                        operationId: request.key,
                    });
                }
                const mergedFrom = new Set(sources.map((source) => source.id));
                for (const source of sources) {
                    try {
                        const prior: unknown = JSON.parse(source.mergedFrom ?? "[]");
                        if (Array.isArray(prior))
                            for (const id of prior) if (typeof id === "number") mergedFrom.add(id);
                    } catch {
                        /* A malformed legacy ancestry never discards the current source ids. */
                    }
                    if (source.id !== canonical.id) {
                        supersededMemory(db, source.id, canonical.id);
                        clearAgentMutationDerivedData(db, source);
                        db.prepare(
                            "INSERT OR IGNORE INTO memory_successor_links(source_id,successor_id,decision_key) VALUES(?,?,?)",
                        ).run(source.id, canonical.id, request.key);
                        queue({
                            projectPath: normalizeStoredProjectPath(source.projectPath),
                            mutationType: "superseded",
                            targetMemoryId: source.id,
                            supersededById: canonical.id,
                            operationId: request.key,
                        });
                        supersededIds.push(source.id);
                    }
                }
                mergeMemoryStats(
                    db,
                    canonical.id,
                    sources.reduce((sum, source) => sum + source.seenCount, 0),
                    sources.reduce((sum, source) => sum + source.retrievalCount, 0),
                    JSON.stringify([...mergedFrom].sort((a, b) => a - b)),
                    sources.some((source) => source.status === "permanent")
                        ? "permanent"
                        : "active",
                );
                clearAgentMutationDerivedData(db, canonical);
            }
            const after = sources.map((source) => snapshotMemoryRow(db, source.id));
            if (canonical && !sources.some((source) => source.id === canonical.id))
                after.push(snapshotMemoryRow(db, canonical.id));
            const historyDecision = makeMemoryHistoryDecision({
                key: request.key,
                projectPath: first.projectPath,
                writer,
                operation: request.operation,
                reason: request.reason ?? `${writer}_${request.operation}`,
                now: Date.now(),
                before: before.map((row) =>
                    row === null ? null : normalizeMemoryHistorySnapshot(row),
                ),
                after: after.map((row) => normalizeMemoryHistorySnapshot(row)!),
                sourceIds: sources.map((source) => source.id),
                survivorId: request.operation === "merge" ? canonical?.id : null,
            });
            recordMemoryHistoryDecision(db, historyDecision);
            if (!automated)
                recordAgentFragment(db, {
                    sessionId: request.sourceSessionId,
                    harness: request.sourceHarness,
                    projectPath: normalizeStoredProjectPath(request.projectPath),
                    operationKey: request.key,
                    ...agentMutationFragment(
                        request.operation,
                        sources,
                        canonical,
                        duplicate !== null,
                        category,
                        content,
                        canonical !== null &&
                            content !== undefined &&
                            sessionShowsMemoryText(
                                db,
                                request.sourceSessionId,
                                canonical.id,
                                content,
                            ),
                    ),
                });
            const receipt = record({
                state: "applied",
                reason: request.operation,
                memoryId: canonical?.id ?? first.id,
                adoptionClass,
                supersededIds,
            });
            db.prepare(
                "UPDATE memory_journal SET before_json=?,after_json=? WHERE decision_key=?",
            ).run(
                memoryHistoryJson(historyDecision),
                memoryHistoryJson(historyDecision),
                request.key,
            );
            return receipt;
        })
        .immediate();
}

/**
 * Apply one gated historian edit, merge or replacement (turn two). It is an
 * automated edit: it changes canonical rows and writes history, but no mutation-log
 * row and no agent fragment, so it reaches a prompt only at that session's next
 * natural HARD fold (.cortexkit/internal-docs/designs/designs/memory-s3-projection.md, "Automated writers").
 *
 * Order: a recorded receipt answers at once; a project whose memory the module owns
 * is `authority_elsewhere`; a source that moved since the decision read it is a CAS
 * loss; then every deterministic gate runs before any check call.
 */
export async function applyHistorianRevision(
    db: Database,
    decision: RevisionDecision,
    context: GateContext,
    owner: { sessionId: string; harness: string },
    reattachOrSend: (request: CheckRequest, options: { reattach: boolean }) => Promise<CheckReply>,
    factId?: number,
    reservation?: MemoryFactReservation,
): Promise<ApplierReceipt> {
    const existing = readReceipt(db, decision.key);
    if (existing) return existing;
    context = {
        ...context,
        sources: decision.expectedSources.flatMap((expected) => {
            const row = db
                .prepare(
                    "SELECT id,revision,project_path AS projectPath,status,content FROM memories WHERE id=?",
                )
                .get(expected.id);
            return row ? [row as GateContext["sources"][number]] : [];
        }),
    };
    const request = {
        key: decision.key,
        projectPath: decision.projectPath,
        factId,
        operation: decision.action,
    };
    if (!tsOwnsMemory(db, decision.projectPath))
        return db
            .transaction(() => {
                const recovered = readReceipt(db, decision.key);
                if (recovered) return recovered;
                if (reservation) assertMemoryFactReservation(db, reservation);
                return recordReceipt(db, request, {
                    state: "retryable",
                    reason: "authority_elsewhere",
                    adoptionClass: memoryAdoptionClass(decision.action),
                });
            })
            .immediate();
    // A target or source of this project that was archived or revised after the
    // decision read it: the decision is stale, not wrong, so it is retried.
    if (
        Array.isArray(decision.expectedSources) &&
        decision.expectedSources.some((expected) => {
            const source = context.sources.find((row) => row.id === expected?.id);
            return (
                source !== undefined &&
                source.projectPath === decision.projectPath &&
                (source.status === "archived" || source.revision !== expected.revision)
            );
        })
    )
        return db
            .transaction(() => {
                const recovered = readReceipt(db, decision.key);
                if (recovered) return recovered;
                if (reservation) assertMemoryFactReservation(db, reservation);
                return resolveRevisionFailure(db, request, "cas_loss", true);
            })
            .immediate();
    const plan = planMemoryRevision(decision, context);
    if (!plan.ok)
        return db
            .transaction(() => {
                const recovered = readReceipt(db, decision.key);
                if (recovered) return recovered;
                if (reservation) assertMemoryFactReservation(db, reservation);
                return recordReceipt(db, request, {
                    state: "decided_pending",
                    reason: plan.reason,
                    adoptionClass: memoryAdoptionClass(decision.action),
                });
            })
            .immediate();
    const outcome = await checkMemoryRevision(db, owner, decision, context, reattachOrSend);
    const receipt = db
        .transaction(() => {
            const recovered = readReceipt(db, decision.key);
            if (recovered) return recovered;
            if (reservation) assertMemoryFactReservation(db, reservation);
            if (!outcome.ok)
                return resolveRevisionFailure(
                    db,
                    request,
                    outcome.reason,
                    outcome.retryable,
                    outcome.reportedProfile,
                );
            const rows = decision.expectedSources.map(
                (expected) =>
                    db
                        .prepare(
                            "SELECT revision FROM memories WHERE id=? AND project_path=? AND status!='archived'",
                        )
                        .get(expected.id, decision.projectPath) as { revision: number } | null,
            );
            if (
                rows.some(
                    (row, index) => row?.revision !== decision.expectedSources[index]!.revision,
                )
            )
                return resolveRevisionFailure(db, request, "cas_loss", true);
            return commitMemoryRevision(db, decision, context, plan, factId);
        })
        .immediate();
    if (receipt.state === "applied" && receipt.memoryId !== undefined) {
        const memory = getMemoryById(db, receipt.memoryId);
        if (memory) {
            try {
                const embedding = await embedTextForProject(memory.projectPath, memory.content);
                if (embedding)
                    saveEmbeddingIfHashMatches(
                        db,
                        memory.id,
                        embedding.vector,
                        embedding.modelId,
                        memory.normalizedHash,
                    );
            } catch (error) {
                sessionLog(
                    owner.sessionId,
                    `[memory] post-commit embedding failed: ${String(error)}`,
                );
            }
        }
    }
    return receipt;
}
function resolveRevisionFailure(
    db: Database,
    request: { key: string; projectPath: string; operation: string; factId?: number },
    reason: string,
    retryable: boolean,
    reportedProfile?: ReportedProfile,
): ApplierReceipt {
    if (retryable && request.factId !== undefined)
        db.prepare(
            "UPDATE memory_pending_facts SET fact_attempts=fact_attempts+1 WHERE id=? AND project_path=?",
        ).run(request.factId, request.projectPath);
    const attempts =
        request.factId === undefined
            ? 0
            : ((
                  db
                      .prepare("SELECT fact_attempts FROM memory_pending_facts WHERE id=?")
                      .get(request.factId) as { fact_attempts: number } | null
              )?.fact_attempts ?? 0);
    return recordReceipt(db, request, {
        state: retryable && attempts < MAX_STAGE2_ATTEMPTS ? "retryable" : "decided_pending",
        reason,
        adoptionClass: memoryAdoptionClass(request.operation),
        ...(reportedProfile ? { reportedProfile } : {}),
    });
}
/**
 * Commit a gated historian revision. Automated edits write no mutation-log row:
 * nothing between HARD folds renders them (see agent-fragments.ts).
 */
function commitMemoryRevision(
    db: Database,
    decision: RevisionDecision,
    context: GateContext,
    plan: Extract<GatePlan, { ok: true }>,
    factId?: number,
): ApplierReceipt {
    const before = context.sources.map((source) => memoryHistorySnapshot(db, source.id));
    const survivor = getMemoryById(db, decision.survivorId)!;
    const assessment = inheritMemorySafety(
        context.sources.map((source) => getMemoryById(db, source.id)!),
        decision.action === "replaces" ? 50 : survivor.importance,
    );
    let survivorId = survivor.id;
    if (decision.action === "replaces")
        survivorId = insertMemory(db, {
            projectPath: decision.projectPath,
            category: survivor.category,
            content: decision.finalText,
            sourceType: "historian",
            expiresAt: survivor.expiresAt,
        }).id;
    const survivorRevision =
        decision.action === "replaces"
            ? 1
            : decision.expectedSources.find((source) => source.id === survivorId)!.revision + 1;
    const keptHashes = new Set(plan.kept.map((operand) => lifecycleTextHash(operand.text)));
    const inherited = context.sources.flatMap(
        (source) =>
            db
                .prepare(
                    "SELECT text_hash,evidence_json FROM memory_clause_evidence WHERE memory_id=? AND revision=?",
                )
                .all(source.id, source.revision) as Array<{
                text_hash: string;
                evidence_json: string;
            }>,
    );
    for (const source of context.sources) {
        if (source.id === survivorId) {
            updateMemoryContent(
                db,
                source.id,
                decision.finalText,
                computeNormalizedHash(decision.finalText),
            );
            db.prepare("UPDATE memories SET revision=revision+1 WHERE id=?").run(source.id);
        } else {
            archiveMemory(db, source.id, decision.action);
            db.prepare("DELETE FROM memory_embeddings WHERE memory_id=?").run(source.id);
            db.prepare(
                "UPDATE memories SET revision=revision+1,superseded_by_memory_id=? WHERE id=?",
            ).run(survivorId, source.id);
            db.prepare(
                "INSERT INTO memory_successor_links(source_id,successor_id,decision_key) VALUES(?,?,?)",
            ).run(source.id, survivorId, decision.key);
        }
    }
    for (const clause of splitMemoryClauses(decision.finalText)) {
        const hash = lifecycleTextHash(clause.text);
        if (!keptHashes.has(hash)) continue;
        const evidence = inherited
            .filter((row) => row.text_hash === hash)
            .map((row) => JSON.parse(row.evidence_json) as unknown);
        if (evidence.length)
            db.prepare(
                "INSERT INTO memory_clause_evidence(memory_id,revision,clause_ordinal,text_hash,evidence_json) VALUES(?,?,?,?,?)",
            ).run(survivorId, survivorRevision, clause.ordinal, hash, JSON.stringify(evidence));
    }
    db.prepare("UPDATE memories SET safety_critical=?,importance=? WHERE id=?").run(
        assessment.safetyCritical,
        assessment.importance,
        survivorId,
    );
    const after = context.sources.map((source) => memoryHistorySnapshot(db, source.id)!);
    if (!context.sources.some((source) => source.id === survivorId)) {
        before.push(null);
        after.push(memoryHistorySnapshot(db, survivorId)!);
    }
    const historyDecision = makeMemoryHistoryDecision({
        key: decision.key,
        projectPath: decision.projectPath,
        writer: "historian",
        operation: decision.action,
        reason: decision.action,
        now: Date.now(),
        before,
        after,
        sourceIds: context.sources.map((row) => row.id),
        survivorId,
        evidence: plan.spans,
    });
    recordMemoryHistoryDecision(db, historyDecision);
    const receipt = recordReceipt(
        db,
        {
            key: decision.key,
            projectPath: decision.projectPath,
            factId,
            operation: decision.action,
        },
        { state: "applied", reason: decision.action, memoryId: survivorId, adoptionClass: "live" },
    );
    db.prepare("UPDATE memory_journal SET before_json=?,after_json=? WHERE decision_key=?").run(
        memoryHistoryJson(historyDecision),
        memoryHistoryJson(historyDecision),
        decision.key,
    );
    return receipt;
}
export function releaseMemoryReservations(
    db: Database,
    sessionIds: readonly string[],
    harness?: string,
): void {
    const exists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE name='memory_stage_attempts'")
        .get();
    if (!exists || sessionIds.length === 0) return;
    const placeholders = sessionIds.map(() => "?").join(",");
    const predicate = harness === undefined ? "" : " AND harness=?";
    // A stage is released when either its owning session or the hidden child that
    // carries it is deleted: without the child there is nothing left to reattach.
    db.prepare(
        `UPDATE memory_pending_facts SET fact_attempts=fact_attempts+1, state=CASE WHEN fact_attempts+1>=? THEN 'decided_pending' ELSE 'retryable' END,reason='session_deleted',reserved_stage_key=NULL WHERE state='in_flight' AND reserved_stage_key IN (SELECT stage_key FROM memory_stage_attempts WHERE (session_id IN (${placeholders}) OR child_session_id IN (${placeholders}))${predicate})`,
    ).run(
        MAX_STAGE2_ATTEMPTS,
        ...sessionIds,
        ...sessionIds,
        ...(harness === undefined ? [] : [harness]),
    );
}
