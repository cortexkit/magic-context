/**
 * Historian turn two: reconcile candidate facts with existing project memory on the
 * same hidden child session that ran turn one, and resolve each fact through the
 * shared applier.
 *
 * Fact states (`memory_pending_facts.state`):
 * - `retryable`: nothing decided, no reservation. Only these are ever sent.
 * - `in_flight`: reserved by one turn-two stage record. The reservation is written in
 *   the same transaction that persists the stage key, before dispatch, and holds
 *   through the reply, every narrow check and the resolving transaction. While the
 *   outcome is unknown (a crash, a lost reply) it stays, and recovery reattaches the
 *   original stage key and `run_attempt` instead of sending again.
 * - `applied` (written through the applier), `covered` (an existing memory already
 *   says it; only the mapping is kept) and `decided_pending` (left for the read-only
 *   review list): terminal, never sent again.
 *
 * Outcomes that consume an attempt (`fact_attempts` +1, `decided_pending` once it
 * reaches `MAX_STAGE2_ATTEMPTS`): a stage-2 transport failure, an unparseable,
 * length-capped or schema-invalid envelope (every fact of the send), a check
 * transport failure, an identity mismatch for any action or score, a compare-and-swap loss, and a
 * carrier that reports on recovery that the send or child no longer exists.
 * Pre-send skips consume nothing: a dormant lane, a carrier that cannot continue the child,
 * `authority_elsewhere` (the Rust module, not this process, owns the project's
 * memory), and backlog facts beyond `RETRY_BACKLOG_PER_RUN`.
 */

import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { sessionLog } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";
import { CHECK_SCHEMA_CONTRACT } from "./historian-schema";
import {
    type ApplierReceipt,
    applyHistorianRevision,
    applyMemoryAdmission,
    assertMemoryFactReservation,
    resolveFactDecision,
    tsOwnsMemory,
} from "./lifecycle-applier";
import { RETRY_BACKLOG_PER_RUN } from "./lifecycle-constants";
import {
    type AddedClause,
    CHECK_SYSTEM_PROMPTS,
    type ChangedClause,
    CheckOutcomeUnknownError,
    type CheckReply,
    type CheckRequest,
    type GateContext,
    type ReportedProfile,
    type RevisionDecision,
} from "./lifecycle-gates";
import {
    type EvidenceBlock,
    lifecycleTextHash,
    normalizeLifecycleText,
    splitMemoryClauses,
} from "./lifecycle-text";
import { getMemoryById } from "./storage-memory";
import type { TurnOneLane } from "./turn-one-publication";
import {
    applyDecidedPrefix,
    fitTurnTwoPrompt,
    parseTurnTwoEnvelope,
    type TurnTwoDecision,
    type TurnTwoPromptFact,
} from "./turn-two-envelope";
import {
    expandTurnTwoEntry,
    isTurnTwoEntry,
    lifecycleToolHash,
    matchesReportedProfile,
    matchesTurnTwoEntry,
    matchesTurnTwoSelection,
    type TurnTwoEntry,
    type TurnTwoTrialAuthorization,
} from "./turn-two-profile";
import { retrieveTurnTwoNeighbours, type TurnTwoQueryEmbedder } from "./turn-two-retrieval";
import {
    classificationWatermark,
    dueItemSequences,
    promptItems,
    recordItemScores,
    storeDueExcerpts,
    type TurnTwoExcerptReader,
} from "./turn-two-scoring";
import type { MemoryCategory } from "./types";

export const TURN_TWO_STAGE = "turn_two";

/**
 * Recovery visits after which a stage whose outcome is still unknown is given up:
 * its facts are charged one attempt (and resent while attempts remain) and its
 * child is closed. A visit counts only once the carrier says the send can no longer
 * be live; a young stage another run may still be serving does not count.
 */
export const TURN_TWO_UNKNOWN_MAX_VISITS = 3;
/**
 * Age after which a stage no carrier in this process can reach is given up the same
 * way, so a fact is never left in flight forever by a carrier that went away.
 */
export const TURN_TWO_UNREACHABLE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * Size bound for the turn-two prompt in UTF-16 units. Memories are never truncated:
 * when the batch would exceed this, later facts and items wait for a later request
 * and the prompt says how many were left out.
 */
export const TURN_TWO_PROMPT_MAX = 160_000;

/** Stage states in which a turn-two send may still be awaiting or resolving its reply. */
const OPEN_STAGE_STATES = ["reserved", "sending", "replied"] as const;

/** What a carrier hands back for one turn-two send. */
export interface TurnTwoStageReply {
    text: string;
    lengthCapped: boolean;
    /**
     * The profile the provider reported for this reply (provider, the model id it
     * actually answered with, variant, temperature, and the historian system hash).
     * Null when the carrier could not tell; the entire stage is then deferred
     * (`retryable`, one attempt consumed per fact) instead of applied.
     */
    profile: ReportedProfile | null;
    usage?: unknown;
    /** Any tool call or result invalidates the send, even beside valid text. */
    toolActivity?: boolean;
}

/**
 * Thrown by a carrier when it cannot tell whether a send was answered. The facts
 * stay reserved and the child stays open; recovery reattaches the stage later.
 */
export class TurnTwoOutcomeUnknownError extends Error {
    constructor(message = "turn two outcome unknown") {
        super(message);
        this.name = "TurnTwoOutcomeUnknownError";
    }
}

export type TurnTwoReattach =
    | { kind: "reply"; reply: TurnTwoStageReply }
    /**
     * The carrier is reachable, the send can no longer be in progress, and still no
     * answer is there. Counts toward `TURN_TWO_UNKNOWN_MAX_VISITS`.
     */
    | { kind: "unknown" }
    /** Another live run may still be serving the send; this visit does not count. */
    | { kind: "busy" }
    /** The carrier reports that the send or the child no longer exists. */
    | { kind: "gone" };

/** Sends narrow checks: each a fresh single-turn call, never on the historian child. */
export interface TurnTwoCheckCarrier {
    check(request: CheckRequest): Promise<CheckReply>;
    /**
     * Reattach a check an earlier run dispatched under `request.key`, without
     * sending it again. Absent when this process cannot reach such a check; the
     * check then stays dispatched and the fact it belongs to stays `in_flight` (never
     * selected for a send) until a run that can reach the check, or the deletion of
     * the stage's session, resolves it.
     */
    reattachCheck?(request: CheckRequest): Promise<CheckReply>;
}

/** The carrier of this run: the retained turn-one child plus a check sender. */
export interface TurnTwoCarrier extends TurnTwoCheckCarrier {
    /** Carrier kind written on stage records, so recovery can find its carrier again. */
    readonly carrier: string;
    readonly harness: string;
    /** Accepted for older callers, but ignored: provider enforcement does not authorize a send. */
    readonly enforcedJson?: boolean;
    /** The turn-one child this carrier continues; null when it cannot continue one. */
    readonly childSessionId: string | null;
    /**
     * What the child showed before turn two was sent (for example a hash of turn
     * one's reply), stored on the stage record so recovery can tell whether a reply
     * to turn two has arrived.
     */
    readonly baseline?: string;
    /**
     * Hash of the historian system prompt and the model variant configured for the
     * historian (for example a reasoning level), stored on the stage record so a reply
     * recovered later carries the profile it ran on.
     */
    readonly historianSystemHash?: string;
    readonly variant?: string | null;
    /** Continue the child with the turn-two prompt (a second turn, same session id). */
    send(prompt: string, stageKey: string): Promise<TurnTwoStageReply>;
}

/** A stage record as recovery sees it. */
export interface TurnTwoStageRecord {
    stageKey: string;
    projectPath: string;
    publicationId: string;
    runAttempt: number;
    sessionId: string;
    harness: string;
    carrier: string;
    childSessionId: string | null;
    startedAt: number;
    baseline: string | null;
    historianSystemHash: string | null;
    variant: string | null;
}

/**
 * Returns a handle on the carrier of an earlier stage; null when this process cannot
 * reach that carrier (the stage was sent through another carrier kind, for example
 * a different host transport, or another harness, or it recorded no child session);
 * or "busy"
 * when a live run may still be working on the stage, so recovery leaves it alone
 * this time without counting a visit.
 */
export type TurnTwoRecoveryResolver = (record: TurnTwoStageRecord) =>
    | (TurnTwoCheckCarrier & {
          reattach(): Promise<TurnTwoReattach>;
          /** Close the stage's hidden child session once none of its facts is in flight. */
          close?(): Promise<void>;
          /** Called under the give-up write lock; a renewed ownership lease can veto release. */
          canRelease?(): boolean;
          /** Called only after the give-up transaction commits, for carrier-specific release logging. */
          onRelease?(): void;
      })
    | "busy"
    | null;

export interface TurnTwoRunInput {
    projectPath: string;
    /**
     * The publication turn one just committed: its `retryable` facts are sent, and its
     * id is part of this turn-two stage's key.
     */
    publicationId: string;
    /** The session the historian ran for (the stage record's owner). */
    sessionId: string;
    lane: TurnOneLane;
    carrier: TurnTwoCarrier;
    memoryEnabled: boolean;
    autoPromote: boolean;
    /** Test-only expected identity rows. Production derives them from the frozen reply. */
    validatedProfiles?: readonly ReportedProfile[];
    trialAuthorization?: TurnTwoTrialAuthorization;
    embedQuery?: TurnTwoQueryEmbedder;
    readExcerpt?: TurnTwoExcerptReader;
    recover?: TurnTwoRecoveryResolver;
    log?: (message: string) => void;
}

export interface TurnTwoRunResult {
    status: "skipped" | "nothing_to_send" | "resolved" | "in_flight" | "failed";
    reason?: string;
    stageKey?: string;
    /**
     * True while a fact reserved by this run's stage is still `in_flight`; the caller
     * must then leave turn one's child session open.
     */
    childInFlight: boolean;
}

interface StageRequest {
    baseline?: string;
    historianSystemHash?: string;
    variant?: string | null;
    /** Recovery visits that found the outcome still unknown (or failed to resolve it). */
    recoveryVisits?: number;
    factAttempts: Record<string, number>;
    items: number[];
    lexicalOnly: boolean;
    prompt: string;
}

/** Persisted in turn one's request_json before dispatch; reports never supply these bytes. */
export interface TurnOneAuthorizationRequest {
    requestedIdentity: TurnTwoEntry;
    system: string;
    formatInstruction: string;
    toolSurface: unknown;
    checkToolSurface: unknown;
}

/** Build the requested identity from the exact bytes persisted before dispatch. */
export function buildTurnOneAuthorizationRequest(
    profile: Pick<
        TurnTwoEntry,
        "lane" | "carrier" | "provider" | "modelId" | "variant" | "temperature" | "thinkingLevel"
    >,
    bytes: Omit<TurnOneAuthorizationRequest, "requestedIdentity">,
): TurnOneAuthorizationRequest {
    return {
        ...bytes,
        requestedIdentity: {
            ...profile,
            historianSystemHash: lifecycleTextHash(bytes.system),
            combinedSchemaHash: lifecycleTextHash(bytes.formatInstruction),
            historianToolHash: lifecycleToolHash(bytes.toolSurface),
            checkSystemHashes: Object.fromEntries(
                Object.entries(CHECK_SYSTEM_PROMPTS).map(([kind, system]) => [
                    kind,
                    lifecycleTextHash(system),
                ]),
            ) as TurnTwoEntry["checkSystemHashes"],
            checkSchemaHash: lifecycleTextHash(CHECK_SCHEMA_CONTRACT),
            checkToolHash: lifecycleToolHash(bytes.checkToolSurface),
        },
    };
}

/** Set requested bytes once, while turn one is still dispatched. */
export function persistTurnOneAuthorization(
    db: Database,
    stageKey: string,
    request: TurnOneAuthorizationRequest,
): void {
    db.transaction(() => {
        const row = db
            .prepare(
                "SELECT request_json FROM memory_stage_attempts WHERE stage_key=? AND stage='turn_one' AND state='dispatched'",
            )
            .get(stageKey) as { request_json: string } | null;
        if (!row) throw new Error("Turn-one request is no longer writable");
        const existing = JSON.parse(row.request_json) as Record<string, unknown>;
        if (existing.requestedIdentity) throw new Error("Turn-one requested identity is immutable");
        db.prepare("UPDATE memory_stage_attempts SET request_json=? WHERE stage_key=?").run(
            JSON.stringify({ ...existing, ...request }),
            stageKey,
        );
    }).immediate();
}

/** Freeze transport metadata once; retries cannot overwrite the answering identity. */
export function freezeTurnOneProfile(
    db: Database,
    stageKey: string,
    profile: ReportedProfile,
): void {
    const changed = db
        .prepare(
            "UPDATE memory_stage_attempts SET reported_profile_json=? WHERE stage_key=? AND stage='turn_one' AND reported_profile_json IS NULL",
        )
        .run(JSON.stringify(profile), stageKey).changes;
    if (!changed) throw new Error("Turn-one actual identity is immutable");
}

export function trialRootMatches(db: Database, authorization: TurnTwoTrialAuthorization): boolean {
    try {
        const root = authorization.attestedRoot;
        if (!isAbsolute(root) || resolve(root) !== root || realpathSync(root) !== root)
            return false;
        const task = relative(join(realpathSync(tmpdir()), "magic-context"), root);
        if (!task || task.startsWith(`..${sep}`) || task === ".." || isAbsolute(task)) return false;
        const file = (
            db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>
        ).find((row) => row.name === "main")?.file;
        if (!file || realpathSync(file) !== resolve(file)) return false;
        const stored = relative(root, resolve(file));
        return !!stored && stored !== ".." && !stored.startsWith(`..${sep}`) && !isAbsolute(stored);
    } catch {
        return false;
    }
}

function stageAuthorization(
    db: Database,
    stageKey: string,
    context: Pick<TurnTwoRunInput, "validatedProfiles" | "trialAuthorization">,
): { profile: ReportedProfile; profiles: ReportedProfile[] } | null {
    const row = db
        .prepare(
            `SELECT t1.request_json,t1.reported_profile_json FROM memory_stage_attempts t1
         JOIN memory_stage_attempts t2 ON t1.project_path=t2.project_path AND t1.publication_id=t2.publication_id
         WHERE t2.stage_key=? AND t1.stage='turn_one' ORDER BY t1.run_attempt DESC LIMIT 1`,
        )
        .get(stageKey) as { request_json: string; reported_profile_json: string | null } | null;
    if (!row?.reported_profile_json) return null;
    try {
        const request = JSON.parse(row.request_json) as TurnOneAuthorizationRequest;
        const profile = JSON.parse(row.reported_profile_json) as ReportedProfile;
        const requested = request.requestedIdentity;
        if (
            !requested ||
            typeof request.system !== "string" ||
            typeof request.formatInstruction !== "string"
        )
            return null;
        const recomputed = buildTurnOneAuthorizationRequest(requested, request).requestedIdentity;
        const actual = {
            ...recomputed,
            lane: profile.lane,
            carrier: profile.carrier,
            provider: profile.provider,
            modelId: profile.modelId,
            variant: profile.variant,
            temperature: profile.temperature,
            thinkingLevel: profile.thinkingLevel,
        };
        if (!isTurnTwoEntry(actual)) return null;
        if (!matchesTurnTwoSelection(recomputed, requested)) return null;
        // A transport report cannot replace persisted system, contract or tool bytes.
        if (!matchesReportedProfile(profile, expandTurnTwoEntry(actual)[0])) return null;
        const trial = context.trialAuthorization;
        let profiles: ReportedProfile[];
        if (trial) {
            if (
                !trialRootMatches(db, trial) ||
                !matchesTurnTwoSelection(requested, trial.candidate) ||
                !matchesTurnTwoEntry(actual, trial.candidate)
            )
                return null;
            profiles = expandTurnTwoEntry(trial.candidate);
        } else if (context.validatedProfiles !== undefined) {
            const validated = context.validatedProfiles;
            profiles = expandTurnTwoEntry(actual);
            if (
                !profiles.every((expected) =>
                    validated.some((candidate) => matchesReportedProfile(expected, candidate)),
                )
            )
                return null;
        } else {
            // Check replies must match the frozen answering model and request bytes.
            profiles = expandTurnTwoEntry(actual);
        }
        return { profile, profiles };
    } catch {
        return null;
    }
}

interface FactRow {
    id: number;
    project_path: string;
    publication_id: string;
    category: string;
    content: string;
    anchor_known: number;
    fact_attempts: number;
    stageKey?: string;
}

const PLACEHOLDER_PROFILE: ReportedProfile = {
    provider: "",
    modelId: "",
    variant: null,
    temperature: null,
    systemHash: "",
};

function factBlocks(db: Database, factId: number): Array<EvidenceBlock & { sessionId: string }> {
    return (
        db
            .prepare(
                `SELECT b.source_session_id AS sessionId,b.start_ordinal AS startOrdinal,b.end_ordinal AS endOrdinal,b.role AS role,b.parts_json AS partsJson,b.joined_text AS joinedText
                 FROM memory_fact_block_links l JOIN memory_fact_blocks b ON b.id=l.block_id
                 WHERE l.fact_id=? ORDER BY b.start_ordinal`,
            )
            .all(factId) as Array<{
            sessionId: string;
            startOrdinal: number;
            endOrdinal: number;
            role: string;
            partsJson: string;
            joinedText: string;
        }>
    ).map((row) => ({
        sessionId: row.sessionId,
        startOrdinal: row.startOrdinal,
        endOrdinal: row.endOrdinal,
        role: row.role,
        parts: JSON.parse(row.partsJson) as string[],
        joinedText: row.joinedText,
    }));
}

function publicationSession(db: Database, publicationId: string): string {
    const row = db
        .prepare("SELECT source_session_id FROM memory_publications WHERE publication_id=?")
        .get(publicationId) as { source_session_id: string } | null;
    return row?.source_session_id ?? "";
}

/**
 * The facts a send carries: every `retryable` fact of this publication, then at most
 * `RETRY_BACKLOG_PER_RUN` `retryable` facts of earlier committed publications of the
 * project, oldest first by (publication commit order, fact id).
 */
export function selectTurnTwoFacts(
    db: Database,
    projectPath: string,
    publicationId: string,
): FactRow[] {
    const current = db
        .prepare(
            "SELECT id,project_path,publication_id,category,content,anchor_known,fact_attempts FROM memory_pending_facts WHERE project_path=? AND publication_id=? AND state='retryable' ORDER BY id",
        )
        .all(projectPath, publicationId) as FactRow[];
    const backlog = db
        .prepare(
            `SELECT f.id,f.project_path,f.publication_id,f.category,f.content,f.anchor_known,f.fact_attempts
             FROM memory_pending_facts f JOIN memory_publications p ON p.publication_id=f.publication_id
             WHERE f.project_path=? AND f.publication_id!=? AND f.state='retryable' AND p.commit_order IS NOT NULL
             ORDER BY p.commit_order, f.id LIMIT ?`,
        )
        .all(projectPath, publicationId, RETRY_BACKLOG_PER_RUN) as FactRow[];
    return [...current, ...backlog];
}

/**
 * The decision key: (project, fact, `fact_attempts` at send, the decision's position
 * in the reply, the target ids with the revisions the decision read, and the stage
 * key of the send). The resolving transaction records a receipt under it, so
 * recovery of the same send never applies a decision twice. The stage key makes it
 * unique per send: a receipt that left the fact `retryable` without charging an
 * attempt (the Rust module took over the project's memory while the reply was being
 * produced, so nothing could be applied here) can never answer a later resend.
 */
export function turnTwoDecisionKey(
    projectPath: string,
    factId: number,
    factAttempts: number,
    decision: TurnTwoDecision | null,
    stageKey: string,
): string {
    const targets: Array<[number, number | null]> = [];
    if (decision?.sources)
        for (const source of decision.sources) targets.push([source.id, source.revision]);
    else if (decision?.targetId !== undefined)
        targets.push([decision.targetId, decision.revision ?? null]);
    targets.sort((a, b) => a[0] - b[0]);
    return JSON.stringify([
        projectPath,
        factId,
        factAttempts,
        decision?.ordinal ?? -1,
        targets,
        stageKey,
    ]);
}

/** Consume one attempt of every fact still reserved by `stageKey`. */
function consumeStageAttempts(
    db: Database,
    stageKey: string,
    reason: string,
    state: string,
    canRelease?: () => boolean,
): boolean {
    return db
        .transaction(() => {
            if (
                !db
                    .prepare(
                        "SELECT 1 FROM memory_stage_attempts WHERE stage_key=? AND state IN ('reserved','sending','replied')",
                    )
                    .get(stageKey)
            )
                return false;
            if (canRelease && !canRelease()) return false;
            const facts = db
                .prepare(
                    "SELECT id,project_path FROM memory_pending_facts WHERE state='in_flight' AND reserved_stage_key=?",
                )
                .all(stageKey) as Array<{ id: number; project_path: string }>;
            for (const fact of facts)
                resolveFactDecision(db, {
                    key: JSON.stringify([stageKey, fact.id, reason]),
                    projectPath: fact.project_path,
                    factId: fact.id,
                    operation: "turn_two",
                    state: "retryable",
                    reason,
                });
            db.prepare(
                "UPDATE memory_stage_attempts SET state=? WHERE stage_key=? AND state IN ('reserved','sending','replied')",
            ).run(state, stageKey);
            return true;
        })
        .immediate();
}

function readStageRequest(db: Database, stageKey: string): StageRequest | null {
    const row = db
        .prepare("SELECT request_json FROM memory_stage_attempts WHERE stage_key=?")
        .get(stageKey) as { request_json: string } | null;
    if (!row) return null;
    const parsed = JSON.parse(row.request_json) as Partial<StageRequest>;
    return parsed.factAttempts ? (parsed as StageRequest) : null;
}

interface Reserved {
    stageKey: string;
    runAttempt: number;
    factIds: number[];
    items: number[];
}

/**
 * Reserve the facts and persist the stage key, its start and the classification
 * watermark in one transaction, before anything is sent. A fact another run
 * reserved meanwhile is left out. Returns null when there is nothing to send.
 */
function reserveTurnTwo(
    db: Database,
    input: TurnTwoRunInput,
    facts: readonly FactRow[],
    promptFacts: ReadonlyMap<number, TurnTwoPromptFact>,
    lexicalOnly: boolean,
): Reserved | null {
    return db
        .transaction((): Reserved | null => {
            const prior = db
                .prepare(
                    "SELECT COALESCE(MAX(run_attempt),0) AS attempt FROM memory_stage_attempts WHERE project_path=? AND publication_id=? AND stage=?",
                )
                .get(input.projectPath, input.publicationId, TURN_TWO_STAGE) as { attempt: number };
            const runAttempt = prior.attempt + 1;
            const stageKey = JSON.stringify([
                input.projectPath,
                input.publicationId,
                runAttempt,
                TURN_TWO_STAGE,
            ]);
            const watermark = classificationWatermark(db, input.projectPath);
            const items = dueItemSequences(db, input.projectPath, watermark);
            const reserve = db.prepare(
                "UPDATE memory_pending_facts SET state='in_flight',reserved_stage_key=? WHERE id=? AND state='retryable'",
            );
            // The stage row must exist before facts point at it, and facts are
            // reserved before the prompt is fixed, so the row is written first and its
            // request completed below.
            db.prepare(
                `INSERT INTO memory_stage_attempts(stage_key,project_path,publication_id,run_attempt,stage,session_id,harness,child_session_id,carrier,state,classification_watermark,request_json,started_at)
                 VALUES(?,?,?,?,?,?,?,?,?,'reserved',?,'{}',?)`,
            ).run(
                stageKey,
                input.projectPath,
                input.publicationId,
                runAttempt,
                TURN_TWO_STAGE,
                input.sessionId,
                input.carrier.harness,
                input.carrier.childSessionId,
                input.carrier.carrier,
                watermark,
                Date.now(),
            );
            const available: FactRow[] = [];
            for (const fact of facts)
                if (reserve.run(stageKey, fact.id).changes === 1) available.push(fact);
            const availableItems = promptItems(db, items);
            const fitted = fitTurnTwoPrompt({
                facts: available.map((fact) => promptFacts.get(fact.id)!),
                items: availableItems,
                lexicalOnly,
                maxLength: TURN_TWO_PROMPT_MAX,
            });
            const selectedIds = new Set(fitted.facts.map((fact) => fact.factId));
            const reserved = available.filter((fact) => selectedIds.has(fact.id));
            const itemViews = fitted.items;
            const release = db.prepare(
                "UPDATE memory_pending_facts SET state='retryable',reserved_stage_key=NULL WHERE id=? AND reserved_stage_key=?",
            );
            for (const fact of available)
                if (!reserved.includes(fact)) release.run(fact.id, stageKey);
            if (reserved.length === 0 && itemViews.length === 0) {
                db.prepare("DELETE FROM memory_stage_attempts WHERE stage_key=?").run(stageKey);
                return null;
            }
            const deferred = fitted.deferred;
            const request: StageRequest = {
                ...(input.carrier.baseline !== undefined
                    ? { baseline: input.carrier.baseline }
                    : {}),
                ...(input.carrier.historianSystemHash !== undefined
                    ? { historianSystemHash: input.carrier.historianSystemHash }
                    : {}),
                variant: input.carrier.variant ?? null,
                factAttempts: Object.fromEntries(
                    reserved.map((fact) => [String(fact.id), fact.fact_attempts]),
                ),
                items: itemViews.map((item) => item.item),
                lexicalOnly,
                prompt: fitted.prompt,
            };
            if (deferred.facts > 0 || deferred.items > 0)
                input.log?.(
                    `turn two: prompt size bound left out ${deferred.facts} fact(s) and ${deferred.items} item(s); eligible for later runs, with no scheduled retry`,
                );
            db.prepare("UPDATE memory_stage_attempts SET request_json=? WHERE stage_key=?").run(
                JSON.stringify(request),
                stageKey,
            );
            return {
                stageKey,
                runAttempt,
                factIds: reserved.map((fact) => fact.id),
                items: request.items,
            };
        })
        .immediate();
}

function recordStageReply(db: Database, stageKey: string, reply: TurnTwoStageReply): void {
    db.prepare(
        "UPDATE memory_stage_attempts SET reply_json=?,reported_profile_json=?,usage_json=?,state='replied' WHERE stage_key=? AND state IN ('reserved','sending')",
    ).run(
        JSON.stringify({
            text: reply.text,
            lengthCapped: reply.lengthCapped,
            toolActivity: reply.toolActivity,
        }),
        JSON.stringify(reply.profile),
        JSON.stringify(reply.usage ?? null),
        stageKey,
    );
}

interface ResolveContext {
    log?: (message: string) => void;
    memoryEnabled: boolean;
    autoPromote: boolean;
    validatedProfiles?: readonly ReportedProfile[];
    trialAuthorization?: TurnTwoTrialAuthorization;
    checks: TurnTwoCheckCarrier;
    owner: { sessionId: string; harness: string };
}

function stillReserved(db: Database, stageKey: string): number {
    const row = db
        .prepare(
            "SELECT COUNT(*) AS n FROM memory_pending_facts WHERE state='in_flight' AND reserved_stage_key=?",
        )
        .get(stageKey) as { n: number };
    return row.n;
}

function reservationsIntact(db: Database, stageKey: string, request: StageRequest): boolean {
    return Object.keys(request.factAttempts).every((id) => {
        const row = db
            .prepare("SELECT state,reserved_stage_key FROM memory_pending_facts WHERE id=?")
            .get(Number(id)) as { state: string; reserved_stage_key: string | null } | null;
        if (!row) return false;
        if (row.reserved_stage_key === stageKey && row.state === "in_flight") return true;
        // Only this stage's receipt can stand in for a reservation after a partial resolution.
        return !!db
            .prepare(
                "SELECT 1 FROM memory_decision_receipts WHERE fact_id=? AND CASE WHEN json_valid(decision_key) THEN json_extract(decision_key,'$[5]') END=?",
            )
            .get(Number(id), stageKey);
    });
}

/** The parser cannot know which facts or score items were actually sent. */
export function parseTurnTwoStageEnvelope(
    reply: Pick<TurnTwoStageReply, "text" | "lengthCapped" | "toolActivity">,
    factIds: readonly number[],
    items: readonly number[],
) {
    const envelope = parseTurnTwoEnvelope(reply.text, reply.lengthCapped, reply.toolActivity);
    if (!envelope.ok) return envelope;
    return {
        ...envelope,
        extraFactIds: [...envelope.decisions.keys()].filter((id) => !factIds.includes(id)),
        schemaValid:
            envelope.schemaValid &&
            factIds.every((id) => envelope.decisions.has(id)) &&
            [...envelope.decisions.keys()].every((id) => factIds.includes(id)) &&
            envelope.scores.every((score) => items.includes(score.item)),
    };
}

/**
 * Resolve every fact of a stage from its recorded reply. Each fact resolves in its
 * own transaction with a receipt keyed by its decision key, so a run that resumes
 * after a crash skips the facts already resolved and applies nothing twice.
 * Returns false when a check's outcome is unknown: the rest stays reserved.
 */
async function resolveStage(
    db: Database,
    stageKey: string,
    context: ResolveContext,
): Promise<boolean> {
    const row = db
        .prepare(
            "SELECT reply_json,reported_profile_json FROM memory_stage_attempts WHERE stage_key=? AND state='replied'",
        )
        .get(stageKey) as {
        reply_json: string | null;
        reported_profile_json: string | null;
    } | null;
    const request = readStageRequest(db, stageKey);
    if (!row?.reply_json || !request) return true;
    if (!reservationsIntact(db, stageKey, request)) {
        revokeStage(db, stageKey);
        return true;
    }
    const reply = JSON.parse(row.reply_json) as TurnTwoStageReply;
    const profile =
        (row.reported_profile_json
            ? (JSON.parse(row.reported_profile_json) as ReportedProfile | null)
            : null) ?? PLACEHOLDER_PROFILE;
    const authorization = stageAuthorization(db, stageKey, context);
    // Identity is a stage guard, before parsing can terminally resolve even one fact.
    if (!authorization || !matchesReportedProfile(profile, authorization.profile)) {
        consumeStageAttempts(db, stageKey, "identity_mismatch", "identity_mismatch");
        return true;
    }
    context = { ...context, validatedProfiles: authorization.profiles };
    const envelope = parseTurnTwoStageEnvelope(
        reply,
        Object.keys(request.factAttempts).map(Number),
        request.items,
    );
    db.prepare(
        "UPDATE memory_stage_attempts SET reply_json=? WHERE stage_key=? AND state='replied'",
    ).run(
        JSON.stringify({
            ...reply,
            envelopeValid: envelope.ok,
            schemaValid: envelope.ok && envelope.schemaValid,
            extraFactIds: envelope.ok ? envelope.extraFactIds : [],
        }),
        stageKey,
    );
    if (!envelope.ok) {
        consumeStageAttempts(db, stageKey, `envelope_${envelope.reason}`, "envelope_failed");
        return true;
    }
    if (envelope.extraFactIds.length > 0)
        context.log?.(`turn two: ignored extra fact ids: ${envelope.extraFactIds.join(", ")}`);
    const facts = db
        .prepare(
            "SELECT id,project_path,publication_id,category,content,anchor_known,fact_attempts,reserved_stage_key AS stageKey FROM memory_pending_facts WHERE state='in_flight' AND reserved_stage_key=? ORDER BY id",
        )
        .all(stageKey) as FactRow[];
    for (const fact of facts) {
        const attempts = request.factAttempts[String(fact.id)] ?? fact.fact_attempts;
        const decision = envelope.decisions.get(fact.id);
        try {
            assertMemoryFactReservation(db, {
                stageKey,
                factId: fact.id,
                projectPath: fact.project_path,
                factAttempts: attempts,
            });
            const receipt = await resolveFact(
                db,
                fact,
                attempts,
                decision,
                profile,
                context,
                stageKey,
            );
            if (receipt.reason === "unvalidated_profile") {
                // Earlier facts keep their receipts; the failed check stops the remaining batch.
                db.prepare(
                    "UPDATE memory_pending_facts SET reason='identity_mismatch' WHERE id=?",
                ).run(fact.id);
                consumeStageAttempts(db, stageKey, "identity_mismatch", "identity_mismatch");
                return true;
            }
        } catch (error) {
            if (error instanceof CheckOutcomeUnknownError) return false;
            throw error;
        }
    }
    db.transaction(() => {
        if (
            !db
                .prepare(
                    "SELECT 1 FROM memory_stage_attempts WHERE stage_key=? AND state='replied'",
                )
                .get(stageKey)
        )
            return;
        if (!reservationsIntact(db, stageKey, request)) {
            revokeStage(db, stageKey);
            return;
        }
        recordItemScores(db, request.items, envelope.scores);
        if (stillReserved(db, stageKey) === 0)
            db.prepare(
                "UPDATE memory_stage_attempts SET state='resolved' WHERE stage_key=? AND state='replied'",
            ).run(stageKey);
    }).immediate();
    return true;
}

function factReservation(fact: FactRow) {
    return fact.stageKey
        ? {
              stageKey: fact.stageKey,
              factId: fact.id,
              projectPath: fact.project_path,
              factAttempts: fact.fact_attempts,
          }
        : undefined;
}

function pending(
    db: Database,
    fact: FactRow,
    key: string,
    reason: string,
    memoryId?: number,
    mapping?: unknown,
): ApplierReceipt {
    return resolveFactDecision(db, {
        key,
        projectPath: fact.project_path,
        factId: fact.id,
        operation: "turn_two",
        state: "decided_pending",
        reservation: factReservation(fact),
        reason,
        memoryId,
        mapping,
    });
}

function liveTarget(db: Database, projectPath: string, id: number | undefined) {
    if (id === undefined) return null;
    const memory = getMemoryById(db, id);
    if (!memory || memory.projectPath !== projectPath || memory.status === "archived") return null;
    const { revision } = db.prepare("SELECT revision FROM memories WHERE id=?").get(id) as {
        revision: number;
    };
    return { memory, revision };
}

async function resolveFact(
    db: Database,
    fact: FactRow,
    attempts: number,
    decision: TurnTwoDecision | "malformed" | undefined,
    profile: ReportedProfile,
    context: ResolveContext,
    stageKey: string,
): Promise<ApplierReceipt> {
    if (decision === undefined || decision === "malformed")
        return pending(
            db,
            fact,
            turnTwoDecisionKey(fact.project_path, fact.id, attempts, null, stageKey),
            decision === undefined ? "missing_decision" : "malformed_decision",
        );
    const key = turnTwoDecisionKey(fact.project_path, fact.id, attempts, decision, stageKey);
    const sourceSessionId = publicationSession(db, fact.publication_id);
    const input = {
        projectPath: fact.project_path,
        category: fact.category as MemoryCategory,
        content: fact.content,
        sourceSessionId,
    };
    switch (decision.action) {
        case "abstain":
            return pending(db, fact, key, "abstain");
        case "retire":
        case "promote_rule": {
            // Turn two may patch grounded clauses, but cannot retire memories or
            // promote standing rules. Record the dropped decision, not a proposal.
            const message = `[memory] turn two dropped ${decision.action} for fact ${fact.id}`;
            if (context.log) context.log(message);
            else sessionLog(context.owner.sessionId, message);
            return pending(db, fact, key, `${decision.action}_dropped`);
        }
        case "new":
            return applyMemoryAdmission(db, {
                key,
                operation: "new",
                input: {
                    ...input,
                    content: applyDecidedPrefix(input.content, decision.decided),
                },
                memoryEnabled: context.memoryEnabled,
                autoPromote: context.autoPromote,
                factId: fact.id,
                reservation: factReservation(fact),
            });
        case "conflict": {
            if (!context.autoPromote) {
                const target = liveTarget(db, fact.project_path, decision.targetId);
                if (!target) return pending(db, fact, key, "conflict_target");
                // auto_promote is off: nothing is admitted, but the fact keeps the id of the
                // memory it disagrees with.
                return pending(db, fact, key, "auto_promote_disabled", target.memory.id, {
                    conflictWith: target.memory.id,
                });
            }
            return applyMemoryAdmission(db, {
                key,
                operation: "conflict",
                input,
                memoryEnabled: context.memoryEnabled,
                autoPromote: context.autoPromote,
                conflictTargetId: decision.targetId,
                factId: fact.id,
                reservation: factReservation(fact),
            });
        }
        case "covered":
            return resolveCovered(db, fact, key, decision);
        case "edit":
        case "replaces":
        case "merge":
            return resolveRevision(db, fact, key, decision, profile, context, stageKey);
    }
}

/**
 * A `covered` decision (an existing memory N already states the fact): the fact keeps
 * its mapping to N's clauses and nothing else is written. Coverage needs evidence the
 * user or a tool produced; a recitation (blocks with no user or tool part, or an
 * excerpt that is just a current clause of N) or a fact with no stored blocks
 * (unknown anchor) could be the model repeating memory back, so it stays pending.
 */
function resolveCovered(
    db: Database,
    fact: FactRow,
    key: string,
    decision: TurnTwoDecision,
): ApplierReceipt {
    const target = liveTarget(db, fact.project_path, decision.targetId);
    if (!target) return pending(db, fact, key, "covered_target");
    if (target.revision !== decision.revision)
        return resolveFactDecision(db, {
            key,
            projectPath: fact.project_path,
            factId: fact.id,
            operation: "turn_two",
            state: "retryable",
            reason: "cas_loss",
            reservation: factReservation(fact),
        });
    const clauses = splitMemoryClauses(target.memory.content);
    const ordinals = decision.clauses ?? [];
    if (
        new Set(ordinals).size !== ordinals.length ||
        ordinals.some((ordinal) => ordinal < 1 || ordinal > clauses.length)
    )
        return pending(db, fact, key, "covered_mapping");
    const blocks = factBlocks(db, fact.id);
    if (!fact.anchor_known || blocks.length === 0) return pending(db, fact, key, "unknown_lineage");
    if (!blocks.some((block) => block.role === "user" || block.role === "tool"))
        return pending(db, fact, key, "recitation");
    if (decision.excerpt !== undefined) {
        const excerpt = normalizeLifecycleText(decision.excerpt);
        if (clauses.some((clause) => normalizeLifecycleText(clause.text) === excerpt))
            return pending(db, fact, key, "recitation");
    }
    return resolveFactDecision(db, {
        key,
        projectPath: fact.project_path,
        factId: fact.id,
        operation: "covered",
        state: "covered",
        reservation: factReservation(fact),
        reason: "covered",
        memoryId: target.memory.id,
        mapping: { memoryId: target.memory.id, revision: target.revision, clauses: ordinals },
    });
}

async function resolveRevision(
    db: Database,
    fact: FactRow,
    key: string,
    decision: TurnTwoDecision,
    profile: ReportedProfile,
    context: ResolveContext,
    stageKey: string,
): Promise<ApplierReceipt> {
    const expectedSources =
        decision.action === "merge"
            ? (decision.sources ?? [])
            : [{ id: decision.targetId ?? -1, revision: decision.revision ?? -1 }];
    const changes: ChangedClause[] = [
        ...(decision.removed ?? []).map((clause) => ({ clause, replacement: false })),
        ...(decision.replaced ?? []).map((clause) => ({ clause, replacement: true })),
    ].map(({ clause, replacement }) => ({
        memoryId: clause.memoryId,
        ordinal: clause.clause,
        replacement,
        evidence: { blockStartOrdinal: clause.block, excerpt: clause.excerpt },
    }));
    const added: AddedClause[] = (decision.added ?? []).map((clause) => ({
        text: clause.text,
        evidence: { blockStartOrdinal: clause.block, excerpt: clause.excerpt },
    }));
    // The decision names its kept clauses; they must be exactly the clauses it does
    // not change, read at the revisions it cites. When a source revision changed
    // since, this comparison is skipped: the applier detects the stale revision and
    // retries the fact as a compare-and-swap loss.
    const current = expectedSources.map((source) => liveTarget(db, fact.project_path, source.id));
    if (
        current.every(
            (target, index) =>
                target !== null && target.revision === expectedSources[index]!.revision,
        )
    ) {
        const expectedKept = current.flatMap((target) =>
            splitMemoryClauses(target!.memory.content)
                .filter(
                    (clause) =>
                        !changes.some(
                            (change) =>
                                change.memoryId === target!.memory.id &&
                                change.ordinal === clause.ordinal,
                        ),
                )
                .map((clause) => `${target!.memory.id}:${clause.ordinal}`),
        );
        const named = (decision.kept ?? []).map((clause) => `${clause.memoryId}:${clause.clause}`);
        if (
            named.length !== expectedKept.length ||
            new Set(named).size !== named.length ||
            named.some((entry) => !expectedKept.includes(entry))
        )
            return pending(db, fact, key, "kept_mismatch");
    }
    const revision: RevisionDecision = {
        key,
        action: decision.action as RevisionDecision["action"],
        projectPath: fact.project_path,
        expectedSources,
        survivorId:
            decision.action === "merge" ? (decision.survivorId ?? -1) : (decision.targetId ?? -1),
        finalText: decision.finalText ?? "",
        changes,
        added,
    };
    const gate: GateContext = {
        enabled: true,
        memoryEnabled: context.memoryEnabled,
        autoPromote: context.autoPromote,
        anchorKnown: fact.anchor_known === 1,
        blocks: factBlocks(db, fact.id).map(({ sessionId: _session, ...block }) => block),
        sources: [],
        historianProfile: profile,
        validatedProfiles: [...(context.validatedProfiles ?? [])],
    };
    return applyHistorianRevision(
        db,
        revision,
        gate,
        context.owner,
        (request, { reattach }) => {
            if (!reattach) return context.checks.check(request);
            if (!context.checks.reattachCheck) throw new CheckOutcomeUnknownError();
            return context.checks.reattachCheck(request);
        },
        fact.id,
        {
            stageKey,
            factId: fact.id,
            projectPath: fact.project_path,
            factAttempts: fact.fact_attempts,
        },
    );
}

function stageRecords(db: Database, projectPath: string): TurnTwoStageRecord[] {
    return (
        db
            .prepare(
                `SELECT s.stage_key AS stageKey,s.project_path AS projectPath,s.publication_id AS publicationId,s.run_attempt AS runAttempt,
                        s.session_id AS sessionId,s.harness AS harness,s.carrier AS carrier,s.child_session_id AS childSessionId,
                        s.started_at AS startedAt,s.request_json AS requestJson
                 FROM memory_stage_attempts s
                 WHERE s.project_path=? AND s.stage=? AND s.state IN (${OPEN_STAGE_STATES.map(() => "?").join(",")})
                 ORDER BY s.started_at, s.stage_key`,
            )
            .all(projectPath, TURN_TWO_STAGE, ...OPEN_STAGE_STATES) as Array<
            Omit<TurnTwoStageRecord, "baseline" | "historianSystemHash" | "variant"> & {
                requestJson: string;
            }
        >
    ).map(({ requestJson, ...record }) => {
        const request = JSON.parse(requestJson) as Partial<StageRequest>;
        return {
            ...record,
            baseline: request.baseline ?? null,
            historianSystemHash: request.historianSystemHash ?? null,
            variant: request.variant ?? null,
        };
    });
}

/** Count one more recovery visit of a stage and return the new count. */
function countRecoveryVisit(db: Database, stageKey: string): number {
    const request = readStageRequest(db, stageKey);
    if (!request) return TURN_TWO_UNKNOWN_MAX_VISITS;
    const visits = (request.recoveryVisits ?? 0) + 1;
    db.prepare("UPDATE memory_stage_attempts SET request_json=? WHERE stage_key=?").run(
        JSON.stringify({ ...request, recoveryVisits: visits }),
        stageKey,
    );
    return visits;
}

/**
 * Reattach every open turn-two stage of the project: a recorded reply is resolved
 * without a second send; otherwise the stage's carrier is asked for the outcome
 * under the original stage key. No stage keeps its facts `in_flight` indefinitely:
 * - a carrier that reports the send or child gone charges one attempt at once;
 * - an outcome still unknown after `TURN_TWO_UNKNOWN_MAX_VISITS` counted visits, a
 *   stage no carrier here can reach for `TURN_TWO_UNREACHABLE_MAX_AGE_MS`, and a
 *   stage whose resolution keeps throwing are given up the same way.
 * A given-up or resolved stage's child is closed. A throw while recovering one stage
 * never stops the others or the run's new send.
 */
export async function recoverTurnTwoStages(
    db: Database,
    input: {
        projectPath: string;
        memoryEnabled: boolean;
        autoPromote: boolean;
        validatedProfiles?: readonly ReportedProfile[];
        trialAuthorization?: TurnTwoTrialAuthorization;
        resolver: TurnTwoRecoveryResolver | undefined;
        log?: (message: string) => void;
        now?: () => number;
    },
): Promise<void> {
    for (const record of stageRecords(db, input.projectPath)) {
        let carrier: Exclude<ReturnType<TurnTwoRecoveryResolver>, "busy"> = null;
        const giveUp = async (reason: string, state: string) => {
            if (
                !consumeStageAttempts(
                    db,
                    record.stageKey,
                    reason,
                    state,
                    () => carrier?.canRelease?.() ?? true,
                )
            )
                return;
            carrier?.onRelease?.();
            input.log?.(`turn two: gave up stage ${record.stageKey} (${reason})`);
            await carrier?.close?.().catch(() => undefined);
        };
        try {
            const resolved = input.resolver?.(record) ?? null;
            if (resolved === "busy") continue;
            carrier = resolved;
            const replied = db
                .prepare(
                    "SELECT reply_json IS NOT NULL AS replied FROM memory_stage_attempts WHERE stage_key=?",
                )
                .get(record.stageKey) as { replied: number };
            if (!replied.replied) {
                if (!carrier) {
                    if (
                        (input.now?.() ?? Date.now()) - record.startedAt >=
                        TURN_TWO_UNREACHABLE_MAX_AGE_MS
                    )
                        await giveUp("carrier_unreachable", "expired");
                    continue;
                }
                const outcome = await carrier
                    .reattach()
                    .catch((): TurnTwoReattach => ({ kind: "unknown" }));
                if (outcome.kind === "busy") continue;
                if (outcome.kind === "gone") {
                    await giveUp("carrier_lost", "lost");
                    continue;
                }
                if (outcome.kind === "unknown") {
                    if (countRecoveryVisit(db, record.stageKey) >= TURN_TWO_UNKNOWN_MAX_VISITS)
                        await giveUp("outcome_unknown", "expired");
                    continue;
                }
                recordStageReply(db, record.stageKey, outcome.reply);
            }
            const done = await resolveStage(db, record.stageKey, {
                memoryEnabled: input.memoryEnabled,
                autoPromote: input.autoPromote,
                validatedProfiles: input.validatedProfiles,
                trialAuthorization: input.trialAuthorization,
                checks: carrier ?? {
                    check: () => Promise.reject(new CheckOutcomeUnknownError("no carrier")),
                },
                owner: { sessionId: record.sessionId, harness: record.harness },
                log: input.log,
            });
            input.log?.(
                `turn two: recovered stage ${record.stageKey} (${done ? "resolved" : "still in flight"})`,
            );
            if (!done) {
                if (countRecoveryVisit(db, record.stageKey) >= TURN_TWO_UNKNOWN_MAX_VISITS)
                    await giveUp("check_outcome_unknown", "expired");
                continue;
            }
            if (stillReserved(db, record.stageKey) === 0) await carrier?.close?.();
        } catch (error) {
            input.log?.(`turn two: recovering stage ${record.stageKey} failed: ${String(error)}`);
            try {
                if (countRecoveryVisit(db, record.stageKey) >= TURN_TWO_UNKNOWN_MAX_VISITS)
                    await giveUp("recovery_error", "expired");
            } catch {
                // The next run counts the visit again.
            }
        }
    }
}

/** Revoke open stages without resolving a reply or charging a fact's send budget. */
export async function sweepTurnTwoStages(
    db: Database,
    input: { projectPath: string; resolver?: TurnTwoRecoveryResolver },
): Promise<void> {
    for (const record of stageRecords(db, input.projectPath)) {
        const carrier = input.resolver?.(record);
        const released = revokeStage(db, record.stageKey);
        if (released && carrier && carrier !== "busy") {
            carrier.onRelease?.();
            await carrier.close?.();
        }
    }
}

function revokeStage(db: Database, stageKey: string): boolean {
    return db
        .transaction(() => {
            const changed = db
                .prepare(
                    "UPDATE memory_stage_attempts SET state='revoked' WHERE stage_key=? AND state IN ('reserved','sending','replied')",
                )
                .run(stageKey).changes;
            if (!changed) return false;
            db.prepare(
                "UPDATE memory_pending_facts SET state='retryable',reason='turn_two_revoked',reserved_stage_key=NULL WHERE reserved_stage_key=? AND state='in_flight'",
            ).run(stageKey);
            return true;
        })
        .immediate();
}

/**
 * Run turn two for one publication on the retained turn-one child. The caller keeps
 * the child open until this returns and closes it only when `childInFlight` is false.
 */
export async function runTurnTwo(db: Database, input: TurnTwoRunInput): Promise<TurnTwoRunResult> {
    const skip = (reason: string): TurnTwoRunResult => ({
        status: "skipped",
        reason,
        childInFlight: false,
    });
    if (input.lane !== "enabled") return skip("lane_dormant");
    if (!input.memoryEnabled) return skip("memory_disabled");
    if (!tsOwnsMemory(db, input.projectPath)) {
        // The Rust module owns this project's memory, so this process may not apply
        // anything: no provider call, and the candidates wait as backlog for a turn
        // two run by the module.
        db.prepare(
            "UPDATE memory_pending_facts SET reason='authority_elsewhere' WHERE project_path=? AND publication_id=? AND state='retryable'",
        ).run(input.projectPath, input.publicationId);
        return skip("authority_elsewhere");
    }
    if (!input.carrier.childSessionId) return skip("carrier_cannot_continue");
    if (input.trialAuthorization && !trialRootMatches(db, input.trialAuthorization))
        return skip("invalid_trial_authorization");

    await recoverTurnTwoStages(db, {
        projectPath: input.projectPath,
        memoryEnabled: input.memoryEnabled,
        autoPromote: input.autoPromote,
        validatedProfiles: input.validatedProfiles,
        trialAuthorization: input.trialAuthorization,
        resolver: input.recover,
        log: input.log,
    });

    storeDueExcerpts(db, input.projectPath, input.readExcerpt);
    const facts = selectTurnTwoFacts(db, input.projectPath, input.publicationId);
    const promptFacts = new Map<number, TurnTwoPromptFact>();
    let lexicalOnly = false;
    for (const fact of facts) {
        const blocks = factBlocks(db, fact.id);
        const retrieved = await retrieveTurnTwoNeighbours(
            db,
            input.projectPath,
            fact.content,
            input.embedQuery,
        );
        lexicalOnly ||= retrieved.lexicalOnly;
        promptFacts.set(fact.id, {
            factId: fact.id,
            category: fact.category,
            content: fact.content,
            sourceSessionId: blocks[0]?.sessionId ?? publicationSession(db, fact.publication_id),
            anchorKnown: fact.anchor_known === 1,
            backlog: fact.publication_id !== input.publicationId,
            blocks,
            neighbours: retrieved.neighbours,
        });
    }
    const reserved = reserveTurnTwo(db, input, facts, promptFacts, lexicalOnly);
    if (!reserved) return { status: "nothing_to_send", childInFlight: false };
    const request = readStageRequest(db, reserved.stageKey)!;
    let reply: TurnTwoStageReply;
    try {
        db.prepare("UPDATE memory_stage_attempts SET state='sending' WHERE stage_key=?").run(
            reserved.stageKey,
        );
        reply = await input.carrier.send(request.prompt, reserved.stageKey);
    } catch (error) {
        if (error instanceof TurnTwoOutcomeUnknownError)
            return { status: "in_flight", stageKey: reserved.stageKey, childInFlight: true };
        // A known transport failure (including a prompt the provider refused as
        // too long): every fact of the send is retried later.
        consumeStageAttempts(db, reserved.stageKey, "stage2_transport", "transport_failed");
        input.log?.(`turn two: send failed (${String(error)})`);
        return {
            status: "failed",
            reason: "stage2_transport",
            stageKey: reserved.stageKey,
            childInFlight: false,
        };
    }
    recordStageReply(db, reserved.stageKey, reply);
    const done = await resolveStage(db, reserved.stageKey, {
        memoryEnabled: input.memoryEnabled,
        autoPromote: input.autoPromote,
        validatedProfiles: input.validatedProfiles,
        trialAuthorization: input.trialAuthorization,
        checks: input.carrier,
        owner: { sessionId: input.sessionId, harness: input.carrier.harness },
        log: input.log,
    });
    const inFlight = !done || stillReserved(db, reserved.stageKey) > 0;
    return {
        status: inFlight ? "in_flight" : "resolved",
        stageKey: reserved.stageKey,
        childInFlight: inFlight,
    };
}
