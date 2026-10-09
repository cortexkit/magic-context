import { sessionLog } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";
import { queueMemoryMutation } from "../storage-memory-mutation-log";
import { CATEGORY_DEFAULT_TTL } from "./constants";
import { embedTextForProject } from "./embedding";
import { checkMemoryRevision } from "./lifecycle-check-ledger";
import { MAX_STAGE2_ATTEMPTS } from "./lifecycle-constants";
import type { CheckReply, CheckRequest } from "./lifecycle-gates";
import {
    type GateContext,
    type GatePlan,
    planMemoryRevision,
    type RevisionDecision,
} from "./lifecycle-gates";
import { lifecycleTextHash, splitMemoryClauses } from "./lifecycle-text";
import { computeNormalizedHash } from "./normalize-hash";
import {
    archiveMemory,
    getMemoryByHash,
    getMemoryById,
    insertMemory,
    updateMemoryContent,
    updateMemorySeenCount,
} from "./storage-memory";
import { saveEmbeddingIfHashMatches } from "./storage-memory-embeddings";
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
}
export interface AdmissionRequest {
    key: string;
    operation: "new" | "conflict" | "agent_save";
    input: MemoryInput;
    memoryEnabled?: boolean;
    autoPromote?: boolean;
    conflictTargetId?: number;
    factId?: number;
    classificationAnchor?: { toolCallPartId: string; saveOrdinal: number };
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
function tsOwnsMemory(db: Database, projectPath: string): boolean {
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
            let memory: Memory;
            if (match) {
                updateMemorySeenCount(db, match.id);
                memory = getMemoryById(db, match.id)!;
            } else {
                memory = insertMemory(db, {
                    ...request.input,
                    sourceType: request.operation === "agent_save" ? "agent" : "historian",
                    importance: request.operation === "agent_save" ? 50 : request.input.importance,
                    expiresAt:
                        request.operation === "agent_save"
                            ? request.input.expiresAt
                            : resolveExpiresAt(request.input.category),
                });
            }
            if (target) linkConflict(db, request.key, memory.id, target.id);
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
            return record({
                state: "applied",
                reason: match ? "live_match" : "inserted",
                memoryId: memory.id,
                inserted: !match,
                adoptionClass: null,
            });
        })
        .immediate();
}

export interface ProposalRequest {
    projectPath: string;
    sourceSessionId?: string;
    key?: string;
    writer: "ctx_memory" | "curate";
    operation: "update" | "archive" | "merge";
    targetIds: number[];
    proposal: unknown;
}
export const MEMORY_PENDING_PROPOSAL = "MEMORY_PENDING_PROPOSAL";
export function proposeMemoryMutation(db: Database, request: ProposalRequest): ApplierReceipt {
    return db
        .transaction(() => {
            const sources = request.targetIds.map((id) =>
                db.prepare("SELECT id,revision FROM memories WHERE id=?").get(id),
            );
            db.prepare(
                "INSERT OR IGNORE INTO memory_tool_proposals(project_path,source_session_id,proposal_key,writer,operation,target_ids_json,expected_revisions_json,proposal_json,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
            ).run(
                request.projectPath,
                request.sourceSessionId ?? null,
                request.key ?? null,
                request.writer,
                request.operation,
                JSON.stringify(request.targetIds),
                JSON.stringify(sources),
                JSON.stringify(request.proposal),
                MEMORY_PENDING_PROPOSAL,
                Date.now(),
            );
            return {
                state: "decided_pending" as const,
                reason: MEMORY_PENDING_PROPOSAL,
                adoptionClass: memoryAdoptionClass(request.operation),
            };
        })
        .immediate();
}

// Before edits can apply, each renderer must replay the memory bytes it already served.
// Reading new canonical text on a deferred pass would silently change the cached prompt.
const MEMORY_PROJECTION_READY = false;
export async function applyHistorianRevision(
    db: Database,
    decision: RevisionDecision,
    context: GateContext,
    owner: { sessionId: string; harness: string },
    reattachOrSend: (request: CheckRequest) => Promise<CheckReply>,
    factId?: number,
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
    const plan = planMemoryRevision(decision, context);
    const request = {
        key: decision.key,
        projectPath: decision.projectPath,
        factId,
        operation: decision.action,
    };
    if (!tsOwnsMemory(db, decision.projectPath))
        return db
            .transaction(
                () =>
                    readReceipt(db, decision.key) ??
                    recordReceipt(db, request, {
                        state: "retryable",
                        reason: "authority_elsewhere",
                        adoptionClass: memoryAdoptionClass(decision.action),
                    }),
            )
            .immediate();
    if (!plan.ok || !MEMORY_PROJECTION_READY)
        return db
            .transaction(
                () =>
                    readReceipt(db, decision.key) ??
                    recordReceipt(db, request, {
                        state: "decided_pending",
                        reason: plan.ok ? "projection_pending" : plan.reason,
                        adoptionClass: memoryAdoptionClass(decision.action),
                    }),
            )
            .immediate();
    const outcome = await checkMemoryRevision(db, owner, decision, context, reattachOrSend);
    const receipt = db
        .transaction(() => {
            const recovered = readReceipt(db, decision.key);
            if (recovered) return recovered;
            if (!outcome.ok)
                return resolveRevisionFailure(db, request, outcome.reason, outcome.retryable);
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
    });
}
function commitMemoryRevision(
    db: Database,
    decision: RevisionDecision,
    context: GateContext,
    plan: Extract<GatePlan, { ok: true }>,
    factId?: number,
): ApplierReceipt {
    const survivor = getMemoryById(db, decision.survivorId)!;
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
        db.prepare(
            "INSERT INTO memory_history(memory_id,revision,previous_text,applied_at,reason,evidence_json,source_ids_json,decision_key) VALUES(?,?,?,?,?,?,?,?)",
        ).run(
            source.id,
            source.revision,
            source.content,
            Date.now(),
            decision.action,
            JSON.stringify(plan.spans),
            JSON.stringify(context.sources.map((row) => row.id)),
            decision.key,
        );
        if (source.id === survivorId) {
            updateMemoryContent(
                db,
                source.id,
                decision.finalText,
                computeNormalizedHash(decision.finalText),
            );
            db.prepare("UPDATE memories SET revision=revision+1 WHERE id=?").run(source.id);
            const mutation = queueMemoryMutation(db, {
                projectPath: decision.projectPath,
                mutationType: "update",
                targetMemoryId: source.id,
                category: survivor.category,
                newContent: decision.finalText,
            });
            db.prepare("UPDATE memory_mutation_log SET adoption_class='live' WHERE id=?").run(
                mutation.id,
            );
        } else {
            archiveMemory(db, source.id, decision.action);
            db.prepare("DELETE FROM memory_embeddings WHERE memory_id=?").run(source.id);
            db.prepare(
                "UPDATE memories SET revision=revision+1,superseded_by_memory_id=? WHERE id=?",
            ).run(survivorId, source.id);
            db.prepare(
                "INSERT INTO memory_successor_links(source_id,successor_id,decision_key) VALUES(?,?,?)",
            ).run(source.id, survivorId, decision.key);
            const mutation = queueMemoryMutation(db, {
                projectPath: decision.projectPath,
                mutationType: "superseded",
                targetMemoryId: source.id,
                supersededById: survivorId,
            });
            db.prepare("UPDATE memory_mutation_log SET adoption_class='live' WHERE id=?").run(
                mutation.id,
            );
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
    return recordReceipt(
        db,
        {
            key: decision.key,
            projectPath: decision.projectPath,
            factId,
            operation: decision.action,
        },
        { state: "applied", reason: decision.action, memoryId: survivorId, adoptionClass: "live" },
    );
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
    db.prepare(
        `UPDATE memory_pending_facts SET fact_attempts=fact_attempts+1, state=CASE WHEN fact_attempts+1>=? THEN 'decided_pending' ELSE 'retryable' END,reason='session_deleted',reserved_stage_key=NULL WHERE state='in_flight' AND reserved_stage_key IN (SELECT stage_key FROM memory_stage_attempts WHERE session_id IN (${placeholders})${predicate})`,
    ).run(MAX_STAGE2_ATTEMPTS, ...sessionIds, ...(harness === undefined ? [] : [harness]));
}
