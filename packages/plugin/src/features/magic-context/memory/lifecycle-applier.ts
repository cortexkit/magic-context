import type { Database } from "../../../shared/sqlite";
import { CATEGORY_DEFAULT_TTL } from "./constants";
import { MAX_STAGE2_ATTEMPTS } from "./lifecycle-constants";
import { planMemoryRevision, type GateContext, type RevisionDecision } from "./lifecycle-gates";
import { computeNormalizedHash } from "./normalize-hash";
import { getMemoryByHash, getMemoryById, insertMemory, updateMemorySeenCount } from "./storage-memory";
import type { Memory, MemoryInput } from "./types";

export type AdoptionClass = "live" | "deferred" | null;
export function memoryAdoptionClass(operation: string): AdoptionClass {
    if (["new", "conflict", "agent_save", "seen_count"].includes(operation)) return null;
    return ["edit", "merge", "replaces", "dashboard_content", "dashboard_archive"].includes(operation) ? "live" : "deferred";
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
    const row = db.prepare("SELECT receipt_json FROM memory_decision_receipts WHERE decision_key=?").get(key) as { receipt_json: string } | null;
    return row ? JSON.parse(row.receipt_json) as ApplierReceipt : null;
}
function recordReceipt(db: Database, request: {key:string; projectPath:string; factId?:number; operation:string}, receipt: ApplierReceipt): ApplierReceipt {
    const json = JSON.stringify(receipt);
    db.prepare("INSERT INTO memory_decision_receipts(decision_key,project_path,fact_id,receipt_json,resolved_at) VALUES(?,?,?,?,?)").run(request.key,request.projectPath,request.factId ?? null,json,Date.now());
    if (receipt.state === "applied") db.prepare("INSERT INTO memory_journal(project_path,decision_key,operation,receipt_json,applied_at) VALUES(?,?,?,?,?)").run(request.projectPath,request.key,request.operation,json,Date.now());
    if (request.factId !== undefined) db.prepare("UPDATE memory_pending_facts SET state=?,reason=?,matched_memory_id=?,reserved_stage_key=NULL WHERE id=? AND project_path=?").run(receipt.state,receipt.reason,receipt.memoryId ?? null,request.factId,request.projectPath);
    return receipt;
}
function tsOwnsMemory(db: Database, projectPath: string): boolean {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='authority_managed'").get()) return true;
    return !db.prepare("SELECT 1 FROM authority_managed WHERE project_path=? UNION SELECT 1 FROM authority_repair_pending WHERE project_path=? LIMIT 1").get(projectPath,projectPath);
}
function linkConflict(db: Database, key: string, left: number, right: number): void {
    db.prepare("INSERT OR IGNORE INTO memory_conflict_links(left_id,right_id,decision_key) VALUES(?,?,?)").run(Math.min(left,right),Math.max(left,right),key);
}

/** New rows surface on existing render opportunities; admission must not invalidate cached prompts. */
export function applyMemoryAdmission(db: Database, request: AdmissionRequest): ApplierReceipt {
    return db.transaction(() => {
        const existingReceipt = readReceipt(db,request.key);
        if (existingReceipt) return existingReceipt;
        const record = (receipt: ApplierReceipt) => recordReceipt(db,{key:request.key,projectPath:request.input.projectPath,factId:request.factId,operation:request.operation},receipt);
        const pending = (reason: string, memoryId?: number) => record({state:"decided_pending",reason,memoryId,adoptionClass:null});
        if (!request.memoryEnabled && request.memoryEnabled !== undefined) return pending("memory_disabled");
        if (!tsOwnsMemory(db,request.input.projectPath)) return record({state:"retryable",reason:"authority_elsewhere",adoptionClass:null});
        if (!request.input.content.trim()) return pending("empty_content");
        const target = request.operation === "conflict" ? getMemoryById(db,request.conflictTargetId ?? -1) : null;
        if (request.operation === "conflict" && (!target || target.projectPath !== request.input.projectPath || target.status === "archived")) return pending("conflict_target");
        if (request.operation !== "agent_save" && request.autoPromote === false) return pending("auto_promote_disabled",target?.id);
        if (request.operation === "agent_save" && request.classificationAnchor) {
            const prior = db.prepare("SELECT memory_id FROM memory_classification_items WHERE project_path=? AND source_session_id=? AND tool_call_part_id=?").get(request.input.projectPath,request.input.sourceSessionId ?? "",request.classificationAnchor.toolCallPartId) as {memory_id:number} | null;
            if (prior) return record({state:"applied",reason:"saved",memoryId:prior.memory_id,inserted:false,adoptionClass:null});
        }
        const hash = computeNormalizedHash(request.input.content);
        const match = getMemoryByHash(db,request.input.projectPath,request.input.category,hash);
        if (match?.status === "archived") return pending("archived_match",match.id);
        const cross = db.prepare("SELECT id FROM memories WHERE project_path=? AND category!=? AND normalized_hash=? AND content=? AND status!='archived' ORDER BY id LIMIT 1").get(request.input.projectPath,request.input.category,hash,request.input.content) as {id:number} | null;
        if (!match && cross) return pending("cross_category_match",cross.id);
        if (target && match?.id === target.id) return pending("self_conflict",target.id);
        let memory: Memory;
        if (match) {
            updateMemorySeenCount(db,match.id);
            memory = getMemoryById(db,match.id)!;
        } else {
            memory = insertMemory(db,{...request.input,sourceType:request.operation === "agent_save" ? "agent" : "historian",importance:request.operation === "agent_save" ? 50 : request.input.importance,expiresAt:request.operation === "agent_save" ? request.input.expiresAt : resolveExpiresAt(request.input.category)});
        }
        if (target) linkConflict(db,request.key,memory.id,target.id);
        if (request.operation === "agent_save" && request.classificationAnchor) {
            db.prepare("INSERT OR IGNORE INTO memory_classification_items(project_path,memory_id,saved_revision,source_session_id,tool_call_part_id,save_ordinal) SELECT project_path,id,revision,?,?,? FROM memories WHERE id=?").run(request.input.sourceSessionId ?? "",request.classificationAnchor.toolCallPartId,request.classificationAnchor.saveOrdinal,memory.id);
        }
        return record({state:"applied",reason:match ? "live_match" : "inserted",memoryId:memory.id,inserted:!match,adoptionClass:null});
    })();
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
    return db.transaction(() => {
        const sources = request.targetIds.map((id) => db.prepare("SELECT id,revision FROM memories WHERE id=?").get(id));
        db.prepare("INSERT OR IGNORE INTO memory_tool_proposals(project_path,source_session_id,proposal_key,writer,operation,target_ids_json,expected_revisions_json,proposal_json,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(request.projectPath,request.sourceSessionId ?? null,request.key ?? null,request.writer,request.operation,JSON.stringify(request.targetIds),JSON.stringify(sources),JSON.stringify(request.proposal),MEMORY_PENDING_PROPOSAL,Date.now());
        return {state:"decided_pending" as const,reason:MEMORY_PENDING_PROPOSAL,adoptionClass:memoryAdoptionClass(request.operation)};
    })();
}

/** Do not change served text until all renderers can replay snapshots without reading live edits. */
export function applyHistorianRevision(db: Database, decision: RevisionDecision, context: GateContext, factId?: number): ApplierReceipt {
    return db.transaction(() => {
        const existing = readReceipt(db,decision.key);
        if (existing) return existing;
        const plan = planMemoryRevision(decision,context);
        return recordReceipt(db,{key:decision.key,projectPath:decision.projectPath,factId,operation:decision.action},{state:"decided_pending",reason:plan.ok ? "projection_pending" : plan.reason,adoptionClass:memoryAdoptionClass(decision.action)});
    })();
}
export function releaseMemoryReservations(db: Database, sessionIds: readonly string[], harness?: string): void {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_stage_attempts'").get();
    if (!exists || sessionIds.length === 0) return;
    const placeholders = sessionIds.map(() => "?").join(",");
    const predicate = harness === undefined ? "" : " AND harness=?";
    db.prepare(`UPDATE memory_pending_facts SET fact_attempts=fact_attempts+1, state=CASE WHEN fact_attempts+1>=? THEN 'decided_pending' ELSE 'retryable' END,reason='session_deleted',reserved_stage_key=NULL WHERE state='in_flight' AND reserved_stage_key IN (SELECT stage_key FROM memory_stage_attempts WHERE session_id IN (${placeholders})${predicate})`).run(MAX_STAGE2_ATTEMPTS,...sessionIds,...(harness === undefined ? [] : [harness]));
}
