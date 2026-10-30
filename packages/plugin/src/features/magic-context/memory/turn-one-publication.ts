import { randomUUID } from "node:crypto";
import type { Database } from "../../../shared/sqlite";
import { PROMOTABLE_CATEGORIES } from "./constants";
import { tsOwnsMemory } from "./lifecycle-applier";
import type { ReportedProfile } from "./lifecycle-gates";
import { sweepTurnTwoStages, type TurnOneAuthorizationRequest, trialRootMatches } from "./turn-two";
import { closeTurnTwoChild, retainedTurnTwoChild } from "./turn-two-children";
import {
    expandTurnTwoEntry,
    matchesReportedProfile,
    matchesTurnTwoEntry,
    matchesTurnTwoSelection,
    type TurnOneFailureKey,
    type TurnOneFailureRow,
    type TurnTwoTrialAuthorization,
    turnOneFailureCount,
    turnOneFailureProfileHash,
    turnOneFailurePublicationId,
} from "./turn-two-profile";

/** Persisted once and appended unchanged to the first request; turn two retains its history. */
export const HISTORIAN_FORMAT_INSTRUCTION =
    'Reply with exactly one JSON object with a result object. On turn one use {"result":{"step":"turn_one","xml":"the complete compartment XML"}}. On turn two use {"result":{"step":"turn_two","decisions":[],"scores":[]}} with the decisions and scores described in the system contract. Do not call tools.';

const turnOneChildren = new Map<string, () => Promise<void>>();

/** Share a release guard between a live send and a dormant firing that revokes it. */
export function registerTurnOneChild(id: string, close: () => Promise<void>): () => Promise<void> {
    let closed = false;
    const release = async () => {
        if (closed) return;
        closed = true;
        turnOneChildren.delete(id);
        await close();
    };
    turnOneChildren.set(id, release);
    return release;
}

/** Revocation must close live children too; normal recovery deliberately treats them as busy. */
export async function sweepDormantTurnTwo(
    db: Database,
    projectPath: string,
    close?: (childId: string) => Promise<void>,
): Promise<void> {
    await sweepTurnTwoStages(db, {
        projectPath,
        resolver: (record) => ({
            check: async () => {
                throw new Error("Revoked stage cannot run checks");
            },
            reattach: async () => ({ kind: "unknown" }),
            close: async () => {
                if (!record.childSessionId) return;
                if (retainedTurnTwoChild(record.childSessionId))
                    await closeTurnTwoChild(record.childSessionId);
                else await close?.(record.childSessionId);
            },
        }),
    });
    const sends = db
        .prepare(
            "SELECT stage_key,child_session_id FROM memory_stage_attempts WHERE project_path=? AND stage='turn_one' AND state IN ('sending','replied')",
        )
        .all(projectPath) as Array<{ stage_key: string; child_session_id: string | null }>;
    for (const send of sends) {
        const changed = db
            .prepare(
                "UPDATE memory_stage_attempts SET state='revoked' WHERE stage_key=? AND state IN ('sending','replied')",
            )
            .run(send.stage_key).changes;
        if (changed && send.child_session_id) {
            const release = turnOneChildren.get(send.child_session_id);
            if (release) await release();
            else await close?.(send.child_session_id);
        }
    }
}

export function parseEnabledTurnOne(text: string): string | null {
    try {
        const parsed = JSON.parse(text);
        return parsed?.result?.step === "turn_one" && typeof parsed.result.xml === "string"
            ? parsed.result.xml
            : null;
    } catch {
        return null;
    }
}

/** Trial evidence is exclusive: a malformed trial cannot fall through to normal execution. */
export function selectTurnOneExecution(
    db: Database,
    input: {
        projectPath: string;
        request: TurnOneAuthorizationRequest;
        override?: TurnOneLane;
        turnTwo?: "on" | "off";
        twoPass?: boolean;
        canContinue: boolean;
        hasUI?: boolean;
        validatedProfiles?: readonly ReportedProfile[];
        trialAuthorization?: TurnTwoTrialAuthorization;
    },
): { lane: TurnOneLane; refused: boolean; validatedProfiles?: readonly ReportedProfile[] } {
    const { request, trialAuthorization: trial } = input;
    if (
        trial &&
        (!trialRootMatches(db, trial) ||
            !matchesTurnTwoSelection(request.requestedIdentity, trial.candidate))
    )
        return { lane: "dormant", refused: true };
    const eligible =
        input.turnTwo !== "off" &&
        input.canContinue &&
        // Reconciliation runs detached after turn one publishes. A headless parent
        // can exit before its retained child's second turn completes.
        input.hasUI !== false &&
        (input.override === "enabled" || (!input.twoPass && input.override !== "dormant"));
    return {
        lane: eligible ? "enabled" : "dormant",
        refused: !!trial && !eligible,
        validatedProfiles: input.validatedProfiles,
    };
}

export function turnOneProfileAuthorized(
    request: TurnOneAuthorizationRequest,
    actual: ReportedProfile | undefined,
    profiles?: readonly ReportedProfile[],
    trial?: TurnTwoTrialAuthorization,
): boolean {
    if (!actual) return false;
    const identity = {
        ...request.requestedIdentity,
        lane: actual.lane,
        carrier: actual.carrier,
        provider: actual.provider,
        modelId: actual.modelId,
        variant: actual.variant,
        temperature: actual.temperature,
        thinkingLevel: actual.thinkingLevel,
    };
    const rows = expandTurnTwoEntry(identity as typeof request.requestedIdentity);
    if (rows.length !== 5 || !matchesReportedProfile(actual, rows[0])) return false;
    if (trial) return matchesTurnTwoEntry(identity, trial.candidate);
    if (profiles !== undefined)
        return rows.every((row) =>
            profiles.some((candidate) => matchesReportedProfile(row, candidate)),
        );
    return true;
}

export function turnOneCounterKey(
    request: TurnOneAuthorizationRequest,
    parentSessionId: string,
    firstMessageId: string,
): TurnOneFailureKey {
    const identity = request.requestedIdentity;
    return {
        parentSessionId,
        firstMessageId,
        profileHash: turnOneFailureProfileHash(identity),
        renderingHash: identity.historianSystemHash,
        schemaHash: identity.combinedSchemaHash,
        toolHash: identity.historianToolHash,
    };
}

export function readTurnOneFailureCount(
    db: Database,
    projectPath: string,
    key: TurnOneFailureKey,
): number {
    const id = turnOneFailurePublicationId(key);
    return turnOneFailureCount(
        id,
        db
            .prepare(
                "SELECT publication_id,stage,run_attempt,state FROM memory_stage_attempts WHERE project_path=? AND publication_id=?",
            )
            .all(projectPath, id) as TurnOneFailureRow[],
    );
}

/** Counter rows are independent of publications, so growing chunks and restarts keep the budget. */
export function recordTurnOneCounter(
    db: Database,
    input: {
        projectPath: string;
        key: TurnOneFailureKey;
        harness: string;
        carrier: string;
        state: "parse_failed" | "counter_reset";
    },
): void {
    db.transaction(() => {
        if (
            input.state === "counter_reset" &&
            readTurnOneFailureCount(db, input.projectPath, input.key) === 0
        )
            return;
        const id = turnOneFailurePublicationId(input.key);
        const prior = db
            .prepare(
                "SELECT COALESCE(MAX(run_attempt),0) AS n FROM memory_stage_attempts WHERE project_path=? AND publication_id=?",
            )
            .get(input.projectPath, id) as { n: number };
        const attempt = prior.n + 1;
        db.prepare(`INSERT INTO memory_stage_attempts(stage_key,project_path,publication_id,run_attempt,stage,session_id,harness,carrier,state,request_json,started_at)
            VALUES(?,?,?,?,'turn_one',?,?,?,?,?,?)`).run(
            `${id}:${attempt}`,
            input.projectPath,
            id,
            attempt,
            input.key.parentSessionId,
            input.harness,
            input.carrier,
            input.state,
            JSON.stringify(input.key),
            Date.now(),
        );
    }).immediate();
}

/**
 * How a historian lane (one transport path to the historian model: the OpenCode host
 * prompt, the OpenCode 2 hidden completion, the Pi subagent, ...) runs its first
 * historian request, "turn one".
 * - `enabled`: the prompt has no project-memory block, facts carry source anchors,
 *   and every fact is published as a pending candidate (`memory_pending_facts`) for
 *   a later reconcile step to decide, instead of being promoted.
 * - `dormant`: the existing turn one. The prompt keeps the memory block, and facts
 *   are promoted through the lifecycle applier when this process holds memory
 *   authority (`tsOwnsMemory`).
 */
export type TurnOneLane = "enabled" | "dormant";

/**
 * Publication helpers default to one-pass XML when called without a lane.
 * Host runners select the enabled contract before dispatch and retain that choice.
 */
export function resolveTurnOneLane(override?: TurnOneLane): TurnOneLane {
    return override ?? "dormant";
}

/** The record persisted before turn one is dispatched. */
export interface TurnOneSend {
    recovery?: boolean;
    publicationId: string;
    runAttempt: number;
    stageKey: string;
    lane: TurnOneLane;
}

export interface TurnOneSendInput {
    projectPath: string;
    sessionId: string;
    harness: string;
    /** Which transport carries the send, for diagnostics and later recovery. */
    carrier: string;
    lane: TurnOneLane;
    chunkStart: number;
    chunkEnd: number;
}

/**
 * Persist turn one's send record before the historian is dispatched, allocating the
 * publication id the compartment transaction will commit under. A publication that
 * never committed (a crash, a failed or refused pass) is reused by the session's
 * next run with the next `run_attempt`, so one chunk publishes under one id no
 * matter how many sends it took.
 */
export function allocateTurnOneSend(db: Database, input: TurnOneSendInput): TurnOneSend {
    return db
        .transaction((): TurnOneSend => {
            const unknown =
                input.lane === "enabled"
                    ? (db
                          .prepare(`SELECT stage_key,publication_id,run_attempt FROM memory_stage_attempts
                WHERE project_path=? AND session_id=? AND harness=? AND carrier=? AND stage='turn_one' AND state IN ('sending','replied') ORDER BY started_at DESC LIMIT 1`)
                          .get(
                              input.projectPath,
                              input.sessionId,
                              input.harness,
                              input.carrier,
                          ) as {
                          stage_key: string;
                          publication_id: string;
                          run_attempt: number;
                      } | null)
                    : null;
            if (unknown)
                return {
                    publicationId: unknown.publication_id,
                    runAttempt: unknown.run_attempt,
                    stageKey: unknown.stage_key,
                    lane: input.lane,
                    recovery: true,
                };
            const reusable = db
                .prepare(
                    `SELECT p.publication_id FROM memory_publications p
                     WHERE p.project_path=? AND p.source_session_id=? AND p.commit_order IS NULL
                       AND EXISTS (SELECT 1 FROM memory_stage_attempts s
                                   WHERE s.publication_id=p.publication_id AND s.stage='turn_one'
                                     AND s.session_id=p.source_session_id AND s.harness=?)
                     ORDER BY p.rowid DESC LIMIT 1`,
                )
                .get(input.projectPath, input.sessionId, input.harness) as {
                publication_id: string;
            } | null;
            const publicationId = reusable?.publication_id ?? randomUUID();
            if (!reusable) {
                db.prepare(
                    "INSERT INTO memory_publications(publication_id,project_path,source_session_id) VALUES(?,?,?)",
                ).run(publicationId, input.projectPath, input.sessionId);
            }
            const prior = db
                .prepare(
                    "SELECT COALESCE(MAX(run_attempt),0) AS attempt FROM memory_stage_attempts WHERE project_path=? AND publication_id=? AND stage='turn_one'",
                )
                .get(input.projectPath, publicationId) as { attempt: number };
            const runAttempt = prior.attempt + 1;
            // Only the newest send of a publication is live; an older one never
            // published and is never resumed, so it is closed here.
            supersedeTurnOneSends(db, input.projectPath, publicationId);
            const stageKey = JSON.stringify([
                input.projectPath,
                publicationId,
                runAttempt,
                "turn_one",
            ]);
            db.prepare(
                `INSERT INTO memory_stage_attempts(stage_key,project_path,publication_id,run_attempt,stage,session_id,harness,carrier,state,request_json,started_at)
                 VALUES(?,?,?,?,'turn_one',?,?,?,'dispatched',?,?)`,
            ).run(
                stageKey,
                input.projectPath,
                publicationId,
                runAttempt,
                input.sessionId,
                input.harness,
                input.carrier,
                JSON.stringify({
                    lane: input.lane,
                    chunkStart: input.chunkStart,
                    chunkEnd: input.chunkEnd,
                }),
                Date.now(),
            );
            return { publicationId, runAttempt, stageKey, lane: input.lane };
        })
        .immediate();
}

/**
 * Close every `dispatched` turn-one send of a publication except `liveStageKey`:
 * a later attempt replaced it, so no recovery step may treat it as in flight.
 */
function supersedeTurnOneSends(
    db: Database,
    projectPath: string,
    publicationId: string,
    liveStageKey?: string,
): void {
    db.prepare(
        `UPDATE memory_stage_attempts SET state='superseded'
         WHERE project_path=? AND publication_id=? AND stage='turn_one' AND state='dispatched'
           AND stage_key IS NOT ?`,
    ).run(projectPath, publicationId, liveStageKey ?? null);
}

/**
 * Delete the uncommitted publications of sessions being deleted, before their send
 * records go. Without a send record no run can reuse or commit such a publication.
 * Committed publications are project history and stay. With `harness`, a
 * publication another harness also sent under is kept.
 */
export function deleteUncommittedPublications(
    db: Database,
    sessionIds: readonly string[],
    harness?: string,
): void {
    if (sessionIds.length === 0) return;
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_publications'").get()) return;
    const placeholders = sessionIds.map(() => "?").join(",");
    const otherHarness =
        harness === undefined
            ? ""
            : " AND NOT EXISTS (SELECT 1 FROM memory_stage_attempts s WHERE s.publication_id=memory_publications.publication_id AND s.harness!=?)";
    db.prepare(
        `DELETE FROM memory_publications WHERE commit_order IS NULL AND source_session_id IN (${placeholders})${otherHarness}`,
    ).run(...sessionIds, ...(harness === undefined ? [] : [harness]));
}

/** A fact's source anchor as written by the historian (see `splitFactAnchorPrefix`). */
export interface TurnOneFactAnchor {
    compartmentIndex: number;
    startOrdinal?: number;
    endOrdinal?: number;
    ranges?: Array<{ startOrdinal: number; endOrdinal: number }>;
}

export interface TurnOneFact {
    category: string;
    content: string;
    anchor?: TurnOneFactAnchor;
    /** The fact's position in the reply; defaults to its position in the list given. */
    factIndex?: number;
}

/**
 * Whether a fact of a validated reply is published (promoted or recorded as a
 * candidate). A fact anchored to compartment N is kept when N is one of the
 * `persistedCount` published compartments and is not the weak final compartment of
 * a forced keep (`weakFinalIndex`); one anchored past them points at a discarded
 * tail. An unanchored fact is kept only when the reply has no weak tail: none was
 * discarded (`droppedTail`) and no final compartment was kept without lookahead.
 * Dropped facts come back when the next run re-derives those lines. Mirrors
 * `keep_side_channel` in crates/mc-module/src/historian_validate.rs; both are
 * pinned by the `keep` cases of
 * crates/mc-module/tests/fixtures/turn-one-anchor-goldens.json.
 */
export function keepPublishedFact(
    compartmentIndex: number | undefined,
    persistedCount: number,
    droppedTail: boolean,
    weakFinalIndex: number | null,
): boolean {
    if (compartmentIndex === undefined) return !droppedTail && weakFinalIndex === null;
    return (
        compartmentIndex >= 1 &&
        compartmentIndex <= persistedCount &&
        compartmentIndex !== weakFinalIndex
    );
}

/** The facts of a reply that `keepPublishedFact` keeps, each with its reply position. */
export function publishedFacts<T extends TurnOneFact>(
    facts: readonly T[],
    persistedCount: number,
    droppedTail: boolean,
    weakFinalIndex: number | null,
): T[] {
    return facts
        .map((fact, factIndex) => ({ ...fact, factIndex: fact.factIndex ?? factIndex }))
        .filter((fact) =>
            keepPublishedFact(
                fact.anchor?.compartmentIndex,
                persistedCount,
                droppedTail,
                weakFinalIndex,
            ),
        );
}

/** A `[N]`/`[N-M]` line of the chunk text the historian was sent. */
export interface TurnOnePrintedBlock {
    role: string;
    startOrdinal: number;
    endOrdinal: number;
    parts: readonly string[];
}

export interface TurnOneCompartmentRange {
    startMessage: number;
    endMessage: number;
}

export interface ResolvedFactAnchor {
    /** 1-based position of the anchored compartment among the published ones. */
    compartmentIndex: number;
    /** Printed blocks that exactly tile the cited range, in order. */
    blockIndexes: number[];
}

/**
 * Resolve a fact's anchor against the compartments of the same reply that are being
 * published and the lines the historian was actually sent. Anything that does not
 * resolve exactly is unknown; nothing is guessed:
 * - the index must name a published compartment (a discarded tail does not count);
 * - the cited range must lie inside that compartment;
 * - the range must start at a printed line's start and end at a printed line's end,
 *   so the printed lines inside it tile it exactly.
 * `historian_validate::resolve_fact_anchor` in the Rust module applies the same rules.
 */
export function resolveTurnOneFactAnchor(
    anchor: TurnOneFactAnchor | undefined,
    compartments: readonly TurnOneCompartmentRange[],
    blocks: ReadonlyArray<{ startOrdinal: number; endOrdinal: number }>,
    chunk: { startOrdinal?: number; endOrdinal?: number } = {
        startOrdinal: compartments[0]?.startMessage,
        endOrdinal: compartments.at(-1)?.endMessage,
    },
): ResolvedFactAnchor | null {
    if (!anchor || anchor.startOrdinal === undefined || anchor.endOrdinal === undefined) {
        return null;
    }
    const { compartmentIndex } = anchor;
    const ranges = anchor.ranges ?? [
        { startOrdinal: anchor.startOrdinal, endOrdinal: anchor.endOrdinal },
    ];
    if (ranges.length === 0 || ranges.length > 3) return null;
    if (compartmentIndex < 1 || compartmentIndex > compartments.length) return null;
    const compartment = compartments[compartmentIndex - 1];
    const blockIndexes: number[] = [];
    for (const { startOrdinal, endOrdinal } of ranges) {
        // A whole-chunk citation cannot distinguish this fact from unrelated evidence.
        if (startOrdinal === chunk.startOrdinal && endOrdinal === chunk.endOrdinal) return null;
        if (startOrdinal > endOrdinal) return null;
        if (startOrdinal < compartment.startMessage || endOrdinal > compartment.endMessage) {
            return null;
        }
        const rangeIndexes: number[] = [];
        blocks.forEach((block, index) => {
            if (block.startOrdinal >= startOrdinal && block.endOrdinal <= endOrdinal) {
                rangeIndexes.push(index);
            }
        });
        if (rangeIndexes.length === 0) return null;
        const first = blocks[rangeIndexes[0]];
        const last = blocks[rangeIndexes[rangeIndexes.length - 1]];
        if (first.startOrdinal !== startOrdinal || last.endOrdinal !== endOrdinal) return null;
        blockIndexes.push(...rangeIndexes);
    }
    if (new Set(blockIndexes).size !== blockIndexes.length) return null;
    return { compartmentIndex, blockIndexes };
}

/**
 * The printed blocks whose whole line reached the historian. The runner may cut the
 * chunk text to fit the producer window; a line past the cut was not seen, so an
 * anchor naming it stays unknown.
 */
export function blocksSentToHistorian<T extends { textEnd: number }>(
    blocks: readonly T[] | undefined,
    chunkText: string,
    sentText: string,
): T[] {
    if (!blocks) return [];
    let common = 0;
    const limit = Math.min(chunkText.length, sentText.length);
    while (common < limit && chunkText.charCodeAt(common) === sentText.charCodeAt(common)) {
        common += 1;
    }
    return blocks.filter((block) => block.textEnd <= common);
}

export interface TurnOnePublicationInput {
    send: TurnOneSend;
    projectPath: string;
    sessionId: string;
    /**
     * The durable rows just appended for this reply, in reply order. Each carries its
     * stored range (`startMessage`/`endMessage`) and the range of the validated
     * compartment it was appended from (`replyStartMessage`/`replyEndMessage`, after
     * gap healing and boundary snapping). If any row's two ranges differ, the rows
     * are misaligned with the reply's compartments, so no fact anchor is resolved to
     * them and every candidate is stored with an unknown anchor.
     */
    compartments: ReadonlyArray<{
        id: number;
        startMessage: number;
        endMessage: number;
        replyStartMessage: number;
        replyEndMessage: number;
    }>;
    /** Printed blocks the historian was sent; used only when anchors are honoured. */
    blocks: readonly TurnOnePrintedBlock[];
    /** Facts to record as candidates, in reply order. Empty when none are recorded. */
    candidateFacts: readonly TurnOneFact[];
    /**
     * Resolve each candidate's source anchor against `compartments` and `blocks`. Only
     * an `enabled` lane asks the historian for anchors; when false every candidate's
     * anchor is stored as unknown.
     */
    honourAnchors: boolean;
}

export interface TurnOnePublicationResult {
    commitOrder: number;
    candidatesInserted: number;
    anchoredCandidates: number;
    blocksStored: number;
    activityIncrements: number;
    /** True when the project's memory is owned by the Rust module. */
    authorityElsewhere: boolean;
}

function isPromotableFact(fact: TurnOneFact): boolean {
    return (
        typeof fact.category === "string" &&
        typeof fact.content === "string" &&
        fact.content.trim().length > 0 &&
        PROMOTABLE_CATEGORIES.some((category) => category === fact.category)
    );
}

/**
 * Commit turn one's publication inside the caller's compartment transaction:
 * - mark the publication committed exactly once and give it the next commit order;
 * - count each newly published compartment once in the project activity ledger;
 * - record the candidate facts with their stored source blocks.
 * Candidates need no memory authority, so they are written here even when the Rust
 * module owns the project's memory; their resolution goes through that authority.
 * Throws when the publication has already committed, which rolls the caller's
 * transaction back instead of publishing the same id twice.
 */
export function commitTurnOnePublication(
    db: Database,
    input: TurnOnePublicationInput,
): TurnOnePublicationResult {
    const stage = db
        .prepare("SELECT state,request_json FROM memory_stage_attempts WHERE stage_key=?")
        .get(input.send.stageKey) as { state: string; request_json: string } | null;
    if (stage?.state === "revoked" || stage?.state === "expired")
        throw new Error("Turn-one send was released before publication");
    const now = Date.now();
    const request = JSON.parse(stage?.request_json ?? "{}") as {
        chunkStart?: number;
        chunkEnd?: number;
    };
    const chunkRange =
        request.chunkStart !== undefined && request.chunkEnd !== undefined
            ? { startOrdinal: request.chunkStart, endOrdinal: request.chunkEnd }
            : undefined;
    const committed = db
        .prepare(
            `UPDATE memory_publications
             SET commit_order=(SELECT COALESCE(MAX(commit_order),0)+1 FROM memory_publications), committed_at=?
             WHERE publication_id=? AND commit_order IS NULL`,
        )
        .run(now, input.send.publicationId);
    if (committed.changes !== 1) {
        throw new Error(`memory publication ${input.send.publicationId} is already committed`);
    }
    const { commit_order: commitOrder } = db
        .prepare("SELECT commit_order FROM memory_publications WHERE publication_id=?")
        .get(input.send.publicationId) as { commit_order: number };
    db.prepare("UPDATE memory_stage_attempts SET state='published' WHERE stage_key=?").run(
        input.send.stageKey,
    );
    supersedeTurnOneSends(db, input.projectPath, input.send.publicationId, input.send.stageKey);

    let activityIncrements = 0;
    const ledger = db.prepare(
        "INSERT OR IGNORE INTO memory_activity_ledger(project_path,publication_id,compartment_id,committed_at) VALUES(?,?,?,?)",
    );
    for (const compartment of input.compartments) {
        activityIncrements += ledger.run(
            input.projectPath,
            input.send.publicationId,
            compartment.id,
            now,
        ).changes;
    }

    const authorityElsewhere = !tsOwnsMemory(db, input.projectPath);
    const bound = input.compartments.every(
        (row) =>
            row.startMessage === row.replyStartMessage && row.endMessage === row.replyEndMessage,
    );
    const ranges = input.compartments.map((row) => ({
        startMessage: row.startMessage,
        endMessage: row.endMessage,
    }));
    // Published compartments are contiguous; their outer bounds describe the
    // full published range, including citations that span compartment boundaries.
    const publishedStart = Math.min(...ranges.map((range) => range.startMessage));
    const publishedEnd = Math.max(...ranges.map((range) => range.endMessage));
    const insertFact = db.prepare(
        `INSERT OR IGNORE INTO memory_pending_facts(project_path,publication_id,fact_index,compartment_id,category,content,anchor_known,state,fact_attempts,reason)
         VALUES(?,?,?,?,?,?,?,'retryable',0,?)`,
    );
    const insertBlock = db.prepare(
        "INSERT OR IGNORE INTO memory_fact_blocks(publication_id,source_session_id,start_ordinal,end_ordinal,role,parts_json,joined_text) VALUES(?,?,?,?,?,?,?)",
    );
    const findBlock = db.prepare(
        "SELECT id FROM memory_fact_blocks WHERE publication_id=? AND start_ordinal=? AND end_ordinal=?",
    );
    const linkBlock = db.prepare(
        "INSERT OR IGNORE INTO memory_fact_block_links(fact_id,block_id) VALUES(?,?)",
    );
    let candidatesInserted = 0;
    let anchoredCandidates = 0;
    let blocksStored = 0;
    input.candidateFacts.forEach((fact, position) => {
        if (!isPromotableFact(fact)) return;
        // A compartment label cannot authorize evidence from an unpublished tail.
        // Unanchored facts still follow the caller's existing publication policy.
        const sourceRanges =
            fact.anchor?.ranges ??
            (fact.anchor?.startOrdinal !== undefined && fact.anchor?.endOrdinal !== undefined
                ? [{ startOrdinal: fact.anchor.startOrdinal, endOrdinal: fact.anchor.endOrdinal }]
                : []);
        if (
            input.honourAnchors &&
            sourceRanges.some(
                ({ startOrdinal: start, endOrdinal: end }) =>
                    Math.min(start, end) < publishedStart || Math.max(start, end) > publishedEnd,
            )
        )
            return;
        const factIndex = fact.factIndex ?? position;
        const resolved =
            input.honourAnchors && bound
                ? resolveTurnOneFactAnchor(fact.anchor, ranges, input.blocks, chunkRange)
                : null;
        const compartmentId = resolved
            ? input.compartments[resolved.compartmentIndex - 1].id
            : null;
        const inserted = insertFact.run(
            input.projectPath,
            input.send.publicationId,
            factIndex,
            compartmentId,
            fact.category,
            fact.content,
            resolved ? 1 : 0,
            authorityElsewhere ? "authority_elsewhere" : null,
        );
        if (inserted.changes !== 1) return;
        candidatesInserted += 1;
        if (!resolved) return;
        anchoredCandidates += 1;
        const factId = Number(inserted.lastInsertRowid);
        const groupedBlocks = sourceRanges.map((range) => {
            const selected = resolved.blockIndexes
                .map((index) => input.blocks[index])
                .filter(
                    (block) =>
                        block.startOrdinal >= range.startOrdinal &&
                        block.endOrdinal <= range.endOrdinal,
                );
            const role = selected.every((block) => block.role === selected[0].role)
                ? selected[0].role
                : "mixed";
            const parts =
                role === "mixed"
                    ? selected.map(
                          (block) =>
                              `[${block.startOrdinal === block.endOrdinal ? block.startOrdinal : `${block.startOrdinal}-${block.endOrdinal}`}] ${block.role}: ${block.parts.join(" / ")}`,
                      )
                    : selected.flatMap((block) => block.parts);
            return { ...range, role, parts };
        });
        for (const block of groupedBlocks) {
            blocksStored += insertBlock.run(
                input.send.publicationId,
                input.sessionId,
                block.startOrdinal,
                block.endOrdinal,
                block.role,
                JSON.stringify(block.parts),
                block.parts.join(" / "),
            ).changes;
            const { id } = findBlock.get(
                input.send.publicationId,
                block.startOrdinal,
                block.endOrdinal,
            ) as { id: number };
            linkBlock.run(factId, id);
        }
    });

    return {
        commitOrder,
        candidatesInserted,
        anchoredCandidates,
        blocksStored,
        activityIncrements,
        authorityElsewhere,
    };
}
