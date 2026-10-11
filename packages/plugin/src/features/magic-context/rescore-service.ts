import { createHash, randomUUID } from "node:crypto";
import { estimateTokens } from "../../hooks/magic-context/read-session-formatting";
import {
    buildRescorePrompt,
    RESCORE_PROMPT_HASH,
    RESCORE_SYSTEM_PROMPT,
    rescoreCandidate,
    validateRescoreScores,
} from "../../hooks/magic-context/rescore-prompt";
import type { Database } from "../../shared/sqlite";
import { type Compartment, getCompartments } from "./compartment-storage";
import { isNoContentCompartment } from "./no-content-compartment";
import {
    computeRescoreSourceIdentity,
    HISTORIAN_REFERENCE_FIX_SHIPPED_AT,
    RESCORE_RUBRIC_VERSION,
} from "./rescore-identity";

export const RESCORE_FAILED_BATCH_PAUSE = 3;
export const RESCORE_HEARTBEAT_MS = 10_000;
export const RESCORE_USAGE =
    "ctx-rescore [--project | confirm <snapshot-id> | status | pause | resume | cancel | undo <job-id> [base] | undo <compartment-id> <revision-id|base>]";
export type RescoreCommand =
    | { kind: "preview"; project: boolean }
    | { kind: "confirm"; snapshotId: string }
    | { kind: "status" | "pause" | "resume" | "cancel" }
    | { kind: "undo-job"; jobId: string; base: boolean }
    | { kind: "undo-compartment"; compartmentId: number; revisionId: number | null };

export function parseRescoreCommand(input: string): RescoreCommand {
    const args = input.trim().split(/\s+/).filter(Boolean);
    if (!args.length) return { kind: "preview", project: false };
    if (args.length === 1 && args[0] === "--project") return { kind: "preview", project: true };
    if (args.length === 1 && ["status", "pause", "resume", "cancel"].includes(args[0]))
        return { kind: args[0] as "status" | "pause" | "resume" | "cancel" };
    if (args.length === 2 && args[0] === "confirm") return { kind: "confirm", snapshotId: args[1] };
    if (
        args[0] === "undo" &&
        args.length === 3 &&
        /^[1-9]\d*$/.test(args[1]) &&
        (args[2] === "base" || /^[1-9]\d*$/.test(args[2]))
    ) {
        const compartmentId = Number(args[1]);
        const revisionId = args[2] === "base" ? null : Number(args[2]);
        if (
            Number.isSafeInteger(compartmentId) &&
            (revisionId === null || Number.isSafeInteger(revisionId))
        )
            return { kind: "undo-compartment", compartmentId, revisionId };
    }
    if (
        args[0] === "undo" &&
        (args.length === 2 || (args.length === 3 && args[2] === "base")) &&
        !/^\d+$/.test(args[1])
    )
        return { kind: "undo-job", jobId: args[1], base: args[2] === "base" };
    throw new Error(RESCORE_USAGE);
}

export interface RescoreModelProfile {
    model: string | null;
    variant?: string;
    thinkingLevel?: string;
    temperature: number;
    maxOutputTokens: number;
}
export type RescoreItemState =
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "oversize"
    | "cancelled"
    | "stale"
    | "skipped";
export interface RescoreItem {
    id: string;
    job_id: string;
    target_session_id: string;
    compartment_id: number;
    source_identity: string;
    state: RescoreItemState;
    batch_id: string | null;
    attempt_id: string | null;
    skipped_job_id: string | null;
}
export interface RescoreJob {
    id: string;
    snapshot_id: string;
    originating_harness: string;
    project_path: string;
    model_profile: string;
    cutoff: number;
    rubric_version: number;
    owner_generation: number;
    heartbeat_at: number;
    consecutive_failed_batches: number;
    last_error: string | null;
    state: "running" | "paused" | "auto-paused" | "interrupted" | "cancelled" | "complete";
    pause_reason: string | null;
    blocking_job_id: string | null;
    created_at: number;
    updated_at: number;
}
export interface RescoreAttempt {
    id: string;
    job_id: string;
    batch_id: string;
    state: "admitted" | "settled" | "abandoned" | "cancelled";
    outcome: "published" | "failed" | null;
    handle_map: string;
    prompt_hash: string;
    seed_ids: string;
    model: string;
    owner_generation: number;
    admitted_at: number;
    carrier_run_id: string | null;
    payload: string | null;
    item_outcomes: string | null;
    settled_at: number | null;
}
interface SnapshotItem {
    sessionId: string;
    compartmentId: number;
    sourceIdentity: string;
    oversize: boolean;
}
interface Snapshot {
    id: string;
    scope: "session" | "project";
    scope_key: string;
    project_path: string;
    target_sessions: string;
    items: string;
    cutoff: number;
    rubric_version: number;
    model_profile: string;
    created_at: number;
    superseded_at: number | null;
}
export interface RescorePreview {
    snapshotId: string;
    sessions: string[];
    eligible: number;
    oversize: number;
    postFix: number;
    postActivationByHarness: Record<string, number>;
    estimatedCalls: number;
    disclosure: string;
}
export interface RescoreAuthority {
    jobId: string;
    generation: number;
}
export interface RescoreAdmission {
    attempt: RescoreAttempt;
    prompt: string;
    system: string;
    profile: RescoreModelProfile;
}
export type RescorePublication = { state: string; outcomes: Record<string, RescoreItemState> };
export interface RescoreServiceOptions {
    db: Database;
    /** Already resolved through the host's canonical project registry, not a caller cwd. */
    projectPath: string;
    sessionId: string;
    harness: string;
    profile: RescoreModelProfile;
    admissionFailure: (
        prompt: string,
        system: string,
        profile: RescoreModelProfile,
    ) => string | null;
    now?: () => number;
}

export class RescoreService {
    readonly db: Database;
    private readonly now: () => number;
    private sourceCache = new Map<string, Map<number, Compartment>>();
    constructor(readonly options: RescoreServiceOptions) {
        this.db = options.db;
        this.now = options.now ?? Date.now;
    }
    private write<T>(fn: () => T): T {
        return this.db
            .transaction(() => {
                this.sourceCache.clear();
                try {
                    return fn();
                } finally {
                    this.sourceCache.clear();
                }
            })
            .immediate();
    }
    private job(id: string): RescoreJob {
        const job = this.db
            .prepare("SELECT * FROM rescore_jobs WHERE id = ? AND project_path = ?")
            .get(id, this.options.projectPath) as RescoreJob | undefined;
        if (!job) throw new Error("Unknown rescore job in this project");
        return job;
    }
    private owner(authority: RescoreAuthority): RescoreJob | null {
        const job = this.job(authority.jobId);
        return job.owner_generation === authority.generation &&
            job.originating_harness === this.options.harness &&
            job.model_profile === profileJSON(this.options.profile)
            ? job
            : null;
    }
    private attempt(id: string): RescoreAttempt {
        const attempt = this.db.prepare("SELECT * FROM rescore_attempts WHERE id = ?").get(id) as
            | RescoreAttempt
            | undefined;
        if (!attempt) throw new Error("Unknown rescore attempt");
        this.job(attempt.job_id);
        return attempt;
    }
    private admitted(authority: RescoreAuthority, id: string): RescoreAttempt | null {
        const job = this.owner(authority);
        const attempt = this.attempt(id);
        const batch = this.db
            .prepare("SELECT current_attempt_id FROM rescore_batches WHERE id = ?")
            .get(attempt.batch_id) as { current_attempt_id: string } | undefined;
        return job &&
            job.state !== "cancelled" &&
            attempt.job_id === job.id &&
            attempt.state === "admitted" &&
            attempt.owner_generation === authority.generation &&
            batch?.current_attempt_id === id
            ? attempt
            : null;
    }
    private items(jobId: string): RescoreItem[] {
        return this.db
            .prepare("SELECT * FROM rescore_items WHERE job_id = ? ORDER BY id")
            .all(jobId) as RescoreItem[];
    }
    private source(item: {
        target_session_id: string;
        compartment_id: number;
    }): Compartment | undefined {
        const belongs = this.db
            .prepare(
                "SELECT 1 FROM compartments c JOIN session_projects s ON s.session_id = c.session_id AND s.harness = c.harness WHERE c.session_id = ? AND s.project_path = ? AND c.id = ?",
            )
            .get(item.target_session_id, this.options.projectPath, item.compartment_id);
        if (!belongs) return undefined;
        let rows = this.sourceCache.get(item.target_session_id);
        if (!rows) {
            rows = new Map(
                getCompartments(this.db, item.target_session_id).map((row) => [row.id, row]),
            );
            this.sourceCache.set(item.target_session_id, rows);
        }
        return rows.get(item.compartment_id);
    }
    private revision(
        row: Compartment,
        identity: string,
        rubric = RESCORE_RUBRIC_VERSION,
    ): { id: number; job_id: string } | undefined {
        return this.db
            .prepare(
                "SELECT id, job_id FROM compartment_score_revisions WHERE compartment_id = ? AND session_id = ? AND source_identity = ? AND rubric_version = ?",
            )
            .get(row.id, row.sessionId, identity, rubric) as
            | { id: number; job_id: string }
            | undefined;
    }
    private sessions(project: boolean): string[] {
        const all = this.db
            .prepare(
                "SELECT DISTINCT session_id FROM session_projects WHERE project_path = ? ORDER BY session_id",
            )
            .all(this.options.projectPath) as { session_id: string }[];
        return all
            .map((row) => row.session_id)
            .filter((id) => project || id === this.options.sessionId);
    }
    private candidates(sessions: string[], cutoff: number) {
        const ownedIds = new Set(
            (
                this.db
                    .prepare(`SELECT c.id FROM compartments c JOIN session_projects s
            ON s.session_id = c.session_id AND s.harness = c.harness WHERE s.project_path = ?`)
                    .all(this.options.projectPath) as { id: number }[]
            ).map((row) => row.id),
        );
        return sessions
            .flatMap((session) => getCompartments(this.db, session))
            .filter(
                (row) =>
                    ownedIds.has(row.id) &&
                    row.createdAt < cutoff &&
                    row.legacy === 0 &&
                    row.p1?.trim() &&
                    !isNoContentCompartment(row),
            )
            .map((row) => ({ row, identity: computeRescoreSourceIdentity(row) }))
            .filter(({ row, identity }) => !this.revision(row, identity));
    }
    preview(project = false): RescorePreview {
        return this.write(() => {
            const cutoff = (
                this.db
                    .prepare("SELECT activated_at FROM rescore_activation WHERE id = 1")
                    .get() as { activated_at: number }
            ).activated_at;
            const sessions = this.sessions(project);
            const id = randomUUID();
            const rows = this.candidates(sessions, cutoff);
            const items: SnapshotItem[] = rows.map(({ row, identity }) => ({
                sessionId: row.sessionId,
                compartmentId: row.id,
                sourceIdentity: identity,
                oversize: !!this.options.admissionFailure(
                    buildRescorePrompt([rescoreCandidate(row)], id, 1).prompt,
                    RESCORE_SYSTEM_PROMPT,
                    this.options.profile,
                ),
            }));
            const postActivationByHarness: Record<string, number> = {};
            const counts = this.db
                .prepare(`SELECT c.harness, COUNT(*) AS n FROM compartments c WHERE c.created_at >= ? AND EXISTS
                (SELECT 1 FROM session_projects s WHERE s.session_id = c.session_id AND s.harness = c.harness AND s.project_path = ?) GROUP BY c.harness`)
                .all(cutoff, this.options.projectPath) as { harness: string; n: number }[];
            for (const row of counts) postActivationByHarness[row.harness] = row.n;
            const pool = rows
                .filter(({ row }) => !items.find((item) => item.compartmentId === row.id)?.oversize)
                .map(({ row }) => row)
                .sort((a, b) =>
                    shuffleKey(id, `${a.sessionId}:${a.id}`).localeCompare(
                        shuffleKey(id, `${b.sessionId}:${b.id}`),
                    ),
                );
            let calls = 0;
            let inputTokens = 0;
            while (pool.length) {
                const batch: Compartment[] = [];
                for (let index = 0; index < pool.length && batch.length < 20; ) {
                    const row = pool[index];
                    if (
                        batch.some(
                            (other) =>
                                row.sessionId === other.sessionId &&
                                Math.abs(row.sequence - other.sequence) <= 1,
                        )
                    ) {
                        index++;
                        continue;
                    }
                    const packed = buildRescorePrompt(
                        [...batch, row].map((row) => rescoreCandidate(row)),
                        id,
                        calls + 1,
                    );
                    if (
                        this.options.admissionFailure(
                            packed.prompt,
                            RESCORE_SYSTEM_PROMPT,
                            this.options.profile,
                        )
                    ) {
                        if (!batch.length) {
                            pool.splice(index, 1);
                            const snapshotItem = items.find(
                                (item) => item.compartmentId === row.id,
                            );
                            if (snapshotItem) snapshotItem.oversize = true;
                            continue;
                        }
                        break;
                    }
                    batch.push(row);
                    pool.splice(index, 1);
                }
                if (!batch.length) continue;
                calls++;
                inputTokens +=
                    estimateTokens(
                        buildRescorePrompt(
                            batch.map((row) => rescoreCandidate(row)),
                            id,
                            calls,
                        ).prompt,
                    ) + estimateTokens(RESCORE_SYSTEM_PROMPT);
            }
            const estimate = {
                calls,
                items: items.length,
                inputTokens,
                maxOutputTokens: calls * this.options.profile.maxOutputTokens,
            };
            const scope = project ? "project" : "session";
            const scopeKey = project ? this.options.projectPath : this.options.sessionId;
            this.db
                .prepare(`UPDATE rescore_snapshots SET superseded_at = ? WHERE scope = ? AND scope_key = ? AND superseded_at IS NULL
                AND NOT EXISTS (SELECT 1 FROM rescore_jobs j WHERE j.snapshot_id = rescore_snapshots.id)`)
                .run(this.now(), scope, scopeKey);
            this.db
                .prepare(`INSERT INTO rescore_snapshots(id,scope,scope_key,project_path,target_sessions,items,cutoff,rubric_version,model_profile,seed_policy,cost_estimate,created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
                .run(
                    id,
                    scope,
                    scopeKey,
                    this.options.projectPath,
                    JSON.stringify(sessions),
                    JSON.stringify(items),
                    cutoff,
                    RESCORE_RUBRIC_VERSION,
                    profileJSON(this.options.profile),
                    "three-distinct-bands-v1",
                    JSON.stringify(estimate),
                    this.now(),
                );
            return {
                snapshotId: id,
                sessions,
                eligible: items.length,
                oversize: items.filter((item) => item.oversize).length,
                postFix: rows.filter(
                    ({ row }) => row.createdAt > HISTORIAN_REFERENCE_FIX_SHIPPED_AT,
                ).length,
                postActivationByHarness,
                estimatedCalls: estimate.calls,
                disclosure:
                    "Scores apply at the next natural history rebuild; compaction and memory settings are unchanged. Rows after 2026-10-06T10:13:16Z may already have been scored by the fixed historian; stored history has no version provenance. The activation cutoff is installation-wide: a harness upgraded later can write post-activation rows excluded here. Post-activation counts are shown per harness.",
            };
        });
    }
    confirm(snapshotId: string): RescoreAuthority {
        return this.write(() => {
            const snapshot = this.db
                .prepare("SELECT * FROM rescore_snapshots WHERE id = ? AND project_path = ?")
                .get(snapshotId, this.options.projectPath) as Snapshot | undefined;
            if (
                !snapshot ||
                snapshot.superseded_at !== null ||
                this.db.prepare("SELECT 1 FROM rescore_jobs WHERE snapshot_id = ?").get(snapshotId)
            )
                throw new Error("Unknown, superseded or confirmed snapshot; preview again");
            if (
                snapshot.model_profile !== profileJSON(this.options.profile) ||
                snapshot.rubric_version !== RESCORE_RUBRIC_VERSION
            )
                throw new Error("Model profile or rubric changed; preview again");
            const items = JSON.parse(snapshot.items) as SnapshotItem[];
            const identities = new Set(
                items.map((item) => `${item.sessionId}:${item.compartmentId}`),
            );
            if (
                this.candidates(this.sessions(snapshot.scope === "project"), snapshot.cutoff).some(
                    ({ row }) => !identities.has(`${row.sessionId}:${row.id}`),
                )
            )
                throw new Error("Eligible items outside snapshot; preview again");
            const id = randomUUID();
            this.db
                .prepare(`INSERT INTO rescore_jobs(id,snapshot_id,originating_harness,project_path,model_profile,cutoff,rubric_version,heartbeat_at,state,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,'running',?,?)`)
                .run(
                    id,
                    snapshot.id,
                    this.options.harness,
                    snapshot.project_path,
                    snapshot.model_profile,
                    snapshot.cutoff,
                    snapshot.rubric_version,
                    this.now(),
                    this.now(),
                    this.now(),
                );
            for (const item of items)
                this.db
                    .prepare(
                        `INSERT INTO rescore_items(id,job_id,target_session_id,compartment_id,source_identity,state) VALUES (?,?,?,?,?,?)`,
                    )
                    .run(
                        randomUUID(),
                        id,
                        item.sessionId,
                        item.compartmentId,
                        item.sourceIdentity,
                        item.oversize ? "oversize" : "pending",
                    );
            this.finish(id);
            return { jobId: id, generation: 1 };
        });
    }
    private finish(jobId: string, blocker?: string): void {
        const job = this.job(jobId);
        if (["cancelled", "auto-paused", "paused", "interrupted"].includes(job.state)) return;
        const items = this.items(jobId);
        let state: RescoreJob["state"] = "running";
        let reason: string | null = null;
        if (blocker && !items.some((item) => item.state === "running")) {
            state = "paused";
            reason = "overlap";
        } else if (!items.some((item) => item.state === "pending" || item.state === "running")) {
            state = items.some((item) => item.state === "failed") ? "paused" : "complete";
            reason = state === "paused" ? "failed-items" : null;
        }
        this.db
            .prepare(
                "UPDATE rescore_jobs SET state = ?, pause_reason = ?, blocking_job_id = ?, updated_at = ? WHERE id = ?",
            )
            .run(state, reason, blocker ?? null, this.now(), jobId);
    }
    heartbeat(authority: RescoreAuthority): boolean {
        return this.write(() => {
            const job = this.owner(authority);
            if (
                !job ||
                job.state === "cancelled" ||
                job.state === "complete" ||
                job.heartbeat_at < this.now() - 2 * RESCORE_HEARTBEAT_MS
            )
                return false;
            this.db
                .prepare(
                    "UPDATE rescore_jobs SET heartbeat_at = ?, updated_at = ? WHERE id = ? AND owner_generation = ?",
                )
                .run(this.now(), this.now(), job.id, authority.generation);
            return true;
        });
    }
    admit(authority: RescoreAuthority): RescoreAdmission | null {
        return this.write(() => {
            const job = this.owner(authority);
            if (
                job?.state !== "running" ||
                job.heartbeat_at < this.now() - 2 * RESCORE_HEARTBEAT_MS ||
                this.db
                    .prepare(
                        "SELECT 1 FROM rescore_attempts WHERE job_id = ? AND state = 'admitted'",
                    )
                    .get(job.id)
            )
                return null;
            const profile = JSON.parse(job.model_profile) as RescoreModelProfile;
            const next = (
                this.db
                    .prepare(
                        "SELECT COALESCE(MAX(sequence),0)+1 AS n FROM rescore_batches WHERE job_id = ?",
                    )
                    .get(job.id) as { n: number }
            ).n;
            const pool = this.items(job.id)
                .filter((item) => item.state === "pending")
                .sort((a, b) =>
                    shuffleKey(
                        job.snapshot_id,
                        `${a.target_session_id}:${a.compartment_id}`,
                    ).localeCompare(
                        shuffleKey(job.snapshot_id, `${b.target_session_id}:${b.compartment_id}`),
                    ),
                );
            const selected: { item: RescoreItem; row: Compartment; handle: string }[] = [];
            let blocker: string | undefined;
            for (const item of pool) {
                if (selected.length === 20) break;
                const row = this.source(item);
                if (!row || computeRescoreSourceIdentity(row) !== item.source_identity) {
                    this.setItem(item.id, "stale");
                    continue;
                }
                const revision = this.revision(row, item.source_identity, job.rubric_version);
                if (revision) {
                    this.db
                        .prepare(
                            "UPDATE rescore_items SET state = 'skipped', skipped_job_id = ? WHERE id = ?",
                        )
                        .run(revision.job_id, item.id);
                    continue;
                }
                const reservation = this.db
                    .prepare(`SELECT a.job_id FROM rescore_items i JOIN rescore_attempts a ON a.id = i.attempt_id
                    WHERE i.compartment_id = ? AND i.source_identity = ? AND a.state = 'admitted' AND a.job_id <> ? LIMIT 1`)
                    .get(item.compartment_id, item.source_identity, job.id) as
                    | { job_id: string }
                    | undefined;
                if (reservation) {
                    blocker = reservation.job_id;
                    continue;
                }
                const handle = randomUUID();
                const singleton = buildRescorePrompt(
                    [rescoreCandidate(row, handle)],
                    job.snapshot_id,
                    next,
                );
                if (
                    this.options.admissionFailure(singleton.prompt, RESCORE_SYSTEM_PROMPT, profile)
                ) {
                    this.setItem(item.id, "oversize");
                    continue;
                }
                if (
                    selected.some(
                        (other) =>
                            row.sessionId === other.row.sessionId &&
                            Math.abs(row.sequence - other.row.sequence) <= 1,
                    )
                )
                    continue;
                const packed = buildRescorePrompt(
                    [
                        ...selected.map((other) => rescoreCandidate(other.row, other.handle)),
                        rescoreCandidate(row, handle),
                    ],
                    job.snapshot_id,
                    next,
                );
                if (this.options.admissionFailure(packed.prompt, RESCORE_SYSTEM_PROMPT, profile))
                    break;
                selected.push({ item, row, handle });
            }
            if (!selected.length) {
                this.finish(job.id, blocker);
                return null;
            }
            const batchId = randomUUID();
            const attemptId = randomUUID();
            const { prompt, seedIds } = buildRescorePrompt(
                selected.map((other) => rescoreCandidate(other.row, other.handle)),
                job.snapshot_id,
                next,
            );
            this.db
                .prepare(
                    "INSERT INTO rescore_batches(id,job_id,sequence,state,current_attempt_id,created_at) VALUES (?,?,?,'running',?,?)",
                )
                .run(batchId, job.id, next, attemptId, this.now());
            this.db
                .prepare(`INSERT INTO rescore_attempts(id,job_id,batch_id,state,handle_map,prompt_hash,seed_ids,model,owner_generation,admitted_at)
                VALUES (?,?,?,'admitted',?,?,?,?,?,?)`)
                .run(
                    attemptId,
                    job.id,
                    batchId,
                    JSON.stringify(
                        Object.fromEntries(selected.map((other) => [other.handle, other.item.id])),
                    ),
                    RESCORE_PROMPT_HASH,
                    JSON.stringify(seedIds),
                    profile.model ?? "",
                    authority.generation,
                    this.now(),
                );
            for (const { item } of selected)
                this.db
                    .prepare(
                        "UPDATE rescore_items SET state = 'running', batch_id = ?, attempt_id = ? WHERE id = ?",
                    )
                    .run(batchId, attemptId, item.id);
            return {
                attempt: this.attempt(attemptId),
                prompt,
                system: RESCORE_SYSTEM_PROMPT,
                profile,
            };
        });
    }
    private setItem(id: string, state: RescoreItemState): void {
        this.db.prepare("UPDATE rescore_items SET state = ? WHERE id = ?").run(state, id);
    }
    recordCarrier(
        authority: RescoreAuthority,
        attemptId: string,
        carrierId: string,
        previousId: string | null = null,
    ): boolean {
        return this.write(() => {
            if (!this.admitted(authority, attemptId)) return false;
            this.db
                .prepare(
                    "UPDATE rescore_attempts SET carrier_run_id = ? WHERE id = ? AND carrier_run_id IS ?",
                )
                .run(carrierId, attemptId, previousId);
            return this.attempt(attemptId).carrier_run_id === carrierId;
        });
    }
    hasAuthority(authority: RescoreAuthority): boolean {
        return this.owner(authority) !== null;
    }
    waitForCarrier(authority: RescoreAuthority, attemptId: string): void {
        this.write(() => {
            if (!this.admitted(authority, attemptId)) return;
            this.db
                .prepare(
                    "UPDATE rescore_jobs SET pause_reason = 'carrier-active', last_error = ?, updated_at = ? WHERE id = ?",
                )
                .run(
                    JSON.stringify({
                        class: "recovery-wait",
                        message:
                            "The previous score carrier has not been confirmed terminal; its reservation is retained",
                    }),
                    this.now(),
                    authority.jobId,
                );
        });
    }
    persistPayload(authority: RescoreAuthority, attemptId: string, text: string): boolean {
        return this.write(() => {
            const attempt = this.admitted(authority, attemptId);
            if (!attempt) return false;
            const scores = validateRescoreScores(text, Object.keys(JSON.parse(attempt.handle_map)));
            if (attempt.payload !== null) return attempt.payload === JSON.stringify(scores);
            this.db
                .prepare("UPDATE rescore_attempts SET payload = ? WHERE id = ?")
                .run(JSON.stringify(scores), attemptId);
            return true;
        });
    }
    private receipt(attempt: RescoreAttempt): RescorePublication {
        return {
            state: attempt.outcome ?? attempt.state,
            outcomes: JSON.parse(attempt.item_outcomes ?? "{}") as Record<string, RescoreItemState>,
        };
    }
    fail(
        authority: RescoreAuthority,
        attemptId: string,
        error: { class: string; message: string },
    ): RescorePublication | null {
        return this.write(() => {
            const previous = this.attempt(attemptId);
            if (previous.state !== "admitted") return this.receipt(previous);
            const attempt = this.admitted(authority, attemptId);
            if (!attempt) return null;
            const outcomes = this.settleItems(attempt, "failed");
            this.db
                .prepare(
                    "UPDATE rescore_attempts SET state = 'settled', outcome = 'failed', payload = NULL, item_outcomes = ?, settled_at = ? WHERE id = ?",
                )
                .run(JSON.stringify(outcomes), this.now(), attemptId);
            this.db
                .prepare("UPDATE rescore_batches SET state = 'failed' WHERE id = ?")
                .run(attempt.batch_id);
            this.db
                .prepare(`UPDATE rescore_jobs SET consecutive_failed_batches = consecutive_failed_batches + 1, last_error = ?, updated_at = ?,
                state = CASE WHEN consecutive_failed_batches + 1 >= ? THEN 'auto-paused' ELSE state END,
                pause_reason = CASE WHEN consecutive_failed_batches + 1 >= ? THEN 'failed-batches' ELSE pause_reason END WHERE id = ?`)
                .run(
                    JSON.stringify(error),
                    this.now(),
                    RESCORE_FAILED_BATCH_PAUSE,
                    RESCORE_FAILED_BATCH_PAUSE,
                    authority.jobId,
                );
            this.finish(authority.jobId);
            return this.receipt(this.attempt(attemptId));
        });
    }
    private settleItems(
        attempt: RescoreAttempt,
        state: RescoreItemState,
    ): Record<string, RescoreItemState> {
        const outcomes: Record<string, RescoreItemState> = {};
        for (const id of Object.values(JSON.parse(attempt.handle_map)) as string[]) {
            this.setItem(id, state);
            outcomes[id] = state;
        }
        return outcomes;
    }
    abandon(authority: RescoreAuthority, attemptId: string): RescorePublication | null {
        return this.write(() => {
            const previous = this.attempt(attemptId);
            if (previous.state !== "admitted") return this.receipt(previous);
            const attempt = this.admitted(authority, attemptId);
            if (!attempt || attempt.payload !== null) return null;
            const outcomes = this.settleItems(attempt, "failed");
            this.db
                .prepare(
                    "UPDATE rescore_attempts SET state = 'abandoned', payload = NULL, item_outcomes = ?, settled_at = ? WHERE id = ?",
                )
                .run(JSON.stringify(outcomes), this.now(), attemptId);
            this.db
                .prepare("UPDATE rescore_batches SET state = 'failed' WHERE id = ?")
                .run(attempt.batch_id);
            this.db
                .prepare("UPDATE rescore_jobs SET last_error = ?, updated_at = ? WHERE id = ?")
                .run(
                    JSON.stringify({
                        class: "abandoned",
                        message:
                            "Admitted completion could not be recovered; explicit resume required",
                    }),
                    this.now(),
                    authority.jobId,
                );
            this.finish(authority.jobId);
            return this.receipt(this.attempt(attemptId));
        });
    }
    publish(authority: RescoreAuthority, attemptId: string): RescorePublication | null {
        return this.write(() => {
            // A receipt precedes authorization so redelivery also works after takeover or undo.
            const previous = this.attempt(attemptId);
            if (previous.state !== "admitted") return this.receipt(previous);
            const attempt = this.admitted(authority, attemptId);
            if (!attempt || attempt.payload === null) return null;
            const map = JSON.parse(attempt.handle_map) as Record<string, string>;
            const items = this.items(authority.jobId).filter(
                (item) => item.attempt_id === attemptId,
            );
            if (items.some((item) => this.leaseHeld(item.target_session_id))) {
                this.db
                    .prepare(
                        "UPDATE rescore_jobs SET pause_reason = 'recomp-lease', updated_at = ? WHERE id = ?",
                    )
                    .run(this.now(), authority.jobId);
                return { state: "waiting", outcomes: {} };
            }
            const scores = validateRescoreScores(attempt.payload, Object.keys(map));
            const job = this.job(authority.jobId);
            const outcomes: Record<string, RescoreItemState> = {};
            for (const score of scores) {
                const item = items.find((item) => item.id === map[score.handle]);
                if (!item) throw new Error("Persisted handle map is inconsistent");
                const row = this.source(item);
                if (!row || computeRescoreSourceIdentity(row) !== item.source_identity) {
                    this.setItem(item.id, "stale");
                    outcomes[item.id] = "stale";
                    continue;
                }
                const accepted = this.revision(row, item.source_identity, job.rubric_version);
                if (accepted) {
                    this.db
                        .prepare(
                            "UPDATE rescore_items SET state = 'skipped', skipped_job_id = ? WHERE id = ?",
                        )
                        .run(accepted.job_id, item.id);
                    outcomes[item.id] = "skipped";
                    continue;
                }
                const result = this.db
                    .prepare(`INSERT INTO compartment_score_revisions(compartment_id,session_id,source_identity,old_importance,new_importance,rubric_version,prompt_hash,model,seed_ids,job_id,batch_id,attempt_id,completed_at,reason)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
                    .run(
                        row.id,
                        row.sessionId,
                        item.source_identity,
                        row.importance,
                        score.importance,
                        job.rubric_version,
                        attempt.prompt_hash,
                        attempt.model,
                        attempt.seed_ids,
                        job.id,
                        attempt.batch_id,
                        attempt.id,
                        this.now(),
                        score.reason,
                    );
                this.select(row.sessionId, row.id, Number(result.lastInsertRowid), attempt);
                this.setItem(item.id, "completed");
                outcomes[item.id] = "completed";
            }
            this.db
                .prepare(
                    "UPDATE rescore_attempts SET state = 'settled', outcome = 'published', payload = NULL, item_outcomes = ?, settled_at = ? WHERE id = ?",
                )
                .run(JSON.stringify(outcomes), this.now(), attemptId);
            this.db
                .prepare("UPDATE rescore_batches SET state = 'published' WHERE id = ?")
                .run(attempt.batch_id);
            this.db
                .prepare(
                    "UPDATE rescore_jobs SET consecutive_failed_batches = 0, pause_reason = CASE WHEN pause_reason IN ('recomp-lease','carrier-active') THEN NULL ELSE pause_reason END, updated_at = ? WHERE id = ?",
                )
                .run(this.now(), authority.jobId);
            this.finish(authority.jobId);
            return this.receipt(this.attempt(attemptId));
        });
    }
    private leaseHeld(sessionId: string): boolean {
        return !!this.db
            .prepare(
                "SELECT 1 FROM compartment_state_lease WHERE session_id = ? AND expires_at > ?",
            )
            .get(sessionId, this.now());
    }
    private select(
        session: string,
        compartment: number,
        revision: number | null,
        attempt?: RescoreAttempt,
    ): void {
        this.db
            .prepare(`INSERT INTO compartment_score_selections(session_id,compartment_id,sequence,revision_id,origin,job_id,batch_id,attempt_id)
            VALUES (?, ?, (SELECT COALESCE(MAX(sequence),0)+1 FROM compartment_score_selections WHERE session_id = ?), ?, ?, ?, ?, ?)`)
            .run(
                session,
                compartment,
                session,
                revision,
                attempt ? "publication" : "undo",
                attempt?.job_id ?? null,
                attempt?.batch_id ?? null,
                attempt?.id ?? null,
            );
    }
    status(jobId: string) {
        const stored = this.job(jobId);
        const job = { ...stored };
        if (job.state === "running" && job.heartbeat_at < this.now() - 2 * RESCORE_HEARTBEAT_MS)
            job.state = "interrupted";
        const counts = Object.fromEntries(
            [
                "pending",
                "running",
                "completed",
                "failed",
                "oversize",
                "cancelled",
                "stale",
                "skipped",
            ].map((state) => [
                state,
                this.items(jobId).filter((item) => item.state === state).length,
            ]),
        );
        const attempts = this.db
            .prepare("SELECT * FROM rescore_attempts WHERE job_id = ? ORDER BY admitted_at, id")
            .all(jobId) as RescoreAttempt[];
        return {
            job,
            counts,
            attempts: attempts.map(({ payload: _payload, ...attempt }) => attempt),
            waitingForLease: job.pause_reason === "recomp-lease",
        };
    }
    pause(authority: RescoreAuthority): boolean {
        return this.write(() => {
            const job = this.owner(authority);
            if (!job || job.state === "cancelled" || job.state === "complete") return false;
            this.db
                .prepare(
                    "UPDATE rescore_jobs SET state = 'paused', pause_reason = 'user', updated_at = ? WHERE id = ?",
                )
                .run(this.now(), job.id);
            return true;
        });
    }
    cancel(jobId: string): string[] {
        return this.write(() => {
            const job = this.job(jobId);
            if (job.state === "complete") return [];
            const attempts = this.db
                .prepare("SELECT * FROM rescore_attempts WHERE job_id = ? AND state = 'admitted'")
                .all(jobId) as RescoreAttempt[];
            for (const attempt of attempts) {
                const outcomes = this.settleItems(attempt, "cancelled");
                this.db
                    .prepare(
                        "UPDATE rescore_attempts SET state = 'cancelled', payload = NULL, item_outcomes = ?, settled_at = ? WHERE id = ?",
                    )
                    .run(JSON.stringify(outcomes), this.now(), attempt.id);
                this.db
                    .prepare("UPDATE rescore_batches SET state = 'cancelled' WHERE id = ?")
                    .run(attempt.batch_id);
            }
            this.db
                .prepare(
                    "UPDATE rescore_items SET state = 'cancelled' WHERE job_id = ? AND state IN ('pending','failed')",
                )
                .run(jobId);
            this.db
                .prepare(
                    "UPDATE rescore_jobs SET state = 'cancelled', pause_reason = NULL, blocking_job_id = NULL, updated_at = ? WHERE id = ?",
                )
                .run(this.now(), jobId);
            return attempts.flatMap((attempt) =>
                attempt.carrier_run_id ? [attempt.carrier_run_id] : [],
            );
        });
    }
    takeover(jobId: string, observedGeneration: number): RescoreAuthority | null {
        return this.write(() => {
            const job = this.job(jobId);
            this.sameDriver(job);
            if (
                job.owner_generation !== observedGeneration ||
                job.heartbeat_at >= this.now() - 2 * RESCORE_HEARTBEAT_MS ||
                job.state === "cancelled" ||
                job.state === "complete"
            )
                return null;
            const generation = observedGeneration + 1;
            this.db
                .prepare(
                    "UPDATE rescore_jobs SET owner_generation = ?, heartbeat_at = ?, updated_at = ?, state = CASE WHEN state = 'running' THEN 'interrupted' ELSE state END WHERE id = ? AND owner_generation = ?",
                )
                .run(generation, this.now(), this.now(), jobId, observedGeneration);
            this.db
                .prepare(
                    "UPDATE rescore_attempts SET owner_generation = ? WHERE job_id = ? AND state = 'admitted'",
                )
                .run(generation, jobId);
            return { jobId, generation };
        });
    }
    private sameDriver(job: RescoreJob): void {
        if (
            job.originating_harness !== this.options.harness ||
            job.model_profile !== profileJSON(this.options.profile)
        )
            throw new Error("Resume requires the originating harness and frozen model profile");
    }
    resume(authority: RescoreAuthority): boolean {
        return this.write(() => {
            const job = this.owner(authority);
            if (!job || job.state === "cancelled" || job.state === "complete") return false;
            this.sameDriver(job);
            if (
                this.db
                    .prepare(
                        "SELECT 1 FROM rescore_attempts WHERE job_id = ? AND state = 'admitted'",
                    )
                    .get(job.id)
            )
                throw new Error("Recover the admitted attempt before resuming");
            for (const item of this.items(job.id).filter(
                (item) => item.state === "pending" || item.state === "failed",
            )) {
                const row = this.source(item);
                this.setItem(
                    item.id,
                    row && computeRescoreSourceIdentity(row) === item.source_identity
                        ? "pending"
                        : "stale",
                );
            }
            this.db
                .prepare(
                    "UPDATE rescore_jobs SET state = 'running', pause_reason = NULL, blocking_job_id = NULL, consecutive_failed_batches = 0, heartbeat_at = ?, updated_at = ? WHERE id = ?",
                )
                .run(this.now(), this.now(), job.id);
            this.finish(job.id);
            return true;
        });
    }
    undoCompartment(compartmentId: number, revisionId: number | null): void {
        this.write(() => {
            const session = this.db
                .prepare(`SELECT c.session_id FROM compartments c WHERE c.id = ? AND EXISTS
                (SELECT 1 FROM session_projects s WHERE s.session_id = c.session_id AND s.harness = c.harness AND s.project_path = ?)`)
                .get(compartmentId, this.options.projectPath) as { session_id: string } | undefined;
            if (!session) throw new Error("Unknown compartment in this project");
            if (
                revisionId !== null &&
                !this.db
                    .prepare(
                        "SELECT 1 FROM compartment_score_revisions WHERE id = ? AND compartment_id = ? AND session_id = ?",
                    )
                    .get(revisionId, compartmentId, session.session_id)
            )
                throw new Error("Unknown or foreign score revision");
            this.select(session.session_id, compartmentId, revisionId);
        });
    }
    undoJob(jobId: string, base = false): { undone: number; unchanged: number } {
        return this.write(() => {
            this.job(jobId);
            let undone = 0;
            const items = this.items(jobId);
            for (const item of items) {
                const active = this.db
                    .prepare(
                        "SELECT * FROM compartment_score_selections WHERE session_id = ? AND compartment_id = ? ORDER BY sequence DESC LIMIT 1",
                    )
                    .get(item.target_session_id, item.compartment_id) as
                    | { job_id: string | null; sequence: number }
                    | undefined;
                if (active?.job_id !== jobId || !this.source(item)) continue;
                const previous = base
                    ? undefined
                    : (this.db
                          .prepare(
                              "SELECT revision_id FROM compartment_score_selections WHERE session_id = ? AND compartment_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT 1",
                          )
                          .get(item.target_session_id, item.compartment_id, active.sequence) as
                          | { revision_id: number | null }
                          | undefined);
                this.select(
                    item.target_session_id,
                    item.compartment_id,
                    previous?.revision_id ?? null,
                );
                undone++;
            }
            return { undone, unchanged: items.length - undone };
        });
    }
}

function profileJSON(profile: RescoreModelProfile): string {
    if (
        !Number.isFinite(profile.temperature) ||
        !Number.isSafeInteger(profile.maxOutputTokens) ||
        profile.maxOutputTokens <= 0
    )
        throw new Error("Rescore requires explicit sampling and output reservation");
    return JSON.stringify({
        model: profile.model,
        ...(profile.variant ? { variant: profile.variant } : {}),
        ...(profile.thinkingLevel ? { thinkingLevel: profile.thinkingLevel } : {}),
        temperature: profile.temperature,
        maxOutputTokens: profile.maxOutputTokens,
    });
}
function shuffleKey(job: string, item: string): string {
    return createHash("sha256").update(`${job}:${item}`).digest("hex");
}
