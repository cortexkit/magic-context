import { createHash, randomUUID } from "node:crypto";
import { log } from "../../shared/logger";
import type { Database, Statement } from "../../shared/sqlite";
import { withPrivilegedWriter } from "../../shared/sqlite";

export const AUTHORITY_DOMAINS = ["memories", "notes"] as const;
export type AuthorityDomain = (typeof AUTHORITY_DOMAINS)[number];
export type AuthorityState = "TS" | "PREPARING" | "MODULE" | "DRAINING";

export interface AuthorityStatus {
    context_store_uuid: string;
    project: string;
    domain: AuthorityDomain;
    state: AuthorityState;
    generation: number;
    captured_upper_bound?: number | null;
    drain_cursor?: number;
    step_seed?: boolean;
    step_memories?: boolean;
    step_notes?: boolean;
    step_compartments?: boolean;
    step_reconcile?: boolean;
    step_verify?: boolean;
    step_flip?: boolean;
    coordinator_lease?: string | null;
    lease_expires_at?: number | null;
    /** Attempt-unique drain coordinator token minted at begin/takeover. */
    coordinator_token?: string | null;
    checksum_expected?: string | null;
    checksum_actual?: string | null;
    checksum_ok?: number | boolean | null;
}

export interface AuthorityDrainContended {
    code: "authority_drain_contended";
    retryable: true;
    state: "DRAINING";
    attempts: number;
    authority: AuthorityStatus | null;
}

export type AuthorityDrainResult = AuthorityStatus | AuthorityDrainContended;

export interface AuthorityDrainResponse {
    authority?: AuthorityStatus;
    code?: string;
    retryable?: boolean;
}

export interface AuthorityModuleClient {
    authorityStatus(args: {
        context_store_uuid: string;
        project: string;
        projectRoot?: string;
        domain: AuthorityDomain;
    }): Promise<{ authority: AuthorityStatus | null }>;
    authorityPrepare(args: Record<string, unknown>): Promise<{ authority: AuthorityStatus }>;
    authorityDrain?(args: Record<string, unknown>): Promise<AuthorityDrainResponse>;
    authoritySeed?(
        args: Record<string, unknown>,
    ): Promise<{ seeded: number; module_row_ids?: number[] }>;
    mirrorPull?(args: {
        domain: AuthorityDomain;
        cursor: number;
        limit: number;
        live_only?: boolean;
        projectRoot?: string;
    }): Promise<{ page: ChangefeedPage }>;
}

export interface ModuleNoteEvaluationBridge {
    sync(): Promise<void>;
    evaluate(args: { contextNoteId: number; sessionId: string; verdict: boolean }): Promise<void>;
}

const moduleNoteEvaluationBridges = new Map<string, ModuleNoteEvaluationBridge>();

export function registerModuleNoteEvaluationBridge(
    projectPath: string,
    bridge: ModuleNoteEvaluationBridge,
): void {
    moduleNoteEvaluationBridges.set(projectPath, bridge);
}

export function getModuleNoteEvaluationBridge(
    projectPath: string,
): ModuleNoteEvaluationBridge | undefined {
    return moduleNoteEvaluationBridges.get(projectPath);
}

export interface ChangefeedRow {
    feed_seq: number;
    domain: AuthorityDomain;
    op: "insert" | "update" | "tombstone";
    module_row_id: number;
    full_row_snapshot: Record<string, unknown>;
    content_hash: string | null;
}

export interface ChangefeedPage {
    domain: AuthorityDomain;
    cursor: number;
    next_cursor: number;
    has_more: boolean;
    rows: ChangefeedRow[];
}

interface StoreMetaRow {
    value: string;
}

export function getContextStoreUuid(db: Database): string | null {
    const row = db.prepare("SELECT value FROM context_store_meta WHERE key = 'store_uuid'").get() as
        | StoreMetaRow
        | undefined;
    return typeof row?.value === "string" && row.value.length > 0 ? row.value : null;
}

/** Mint the store identity once. Restoring a database restores this value too,
 * which is what lets the module recognize a regressed marker. */
export function ensureContextStoreUuid(db: Database): string {
    const existing = getContextStoreUuid(db);
    if (existing) return existing;
    const minted = randomUUID();
    withPrivilegedWriter(db, () => {
        db.transaction(() => {
            db.prepare(
                "INSERT INTO context_store_meta(key, value) VALUES ('store_uuid', ?) ON CONFLICT(key) DO NOTHING",
            ).run(minted);
        }).immediate();
    });
    return getContextStoreUuid(db) ?? minted;
}

export interface AuthorityManagedMarker {
    project_path: string;
    context_store_uuid: string;
    marked_at: number;
}

export function getAuthorityManagedMarker(
    db: Database,
    projectPath: string,
): AuthorityManagedMarker | null {
    return (
        (db
            .prepare(
                "SELECT project_path, context_store_uuid, marked_at FROM authority_managed WHERE project_path = ?",
            )
            .get(projectPath) as AuthorityManagedMarker | undefined) ?? null
    );
}

export function listAuthorityManagedMarkers(db: Database): AuthorityManagedMarker[] {
    return db
        .prepare(
            "SELECT project_path, context_store_uuid, marked_at FROM authority_managed ORDER BY project_path",
        )
        .all() as AuthorityManagedMarker[];
}

export function installAuthorityManagedMarker(
    db: Database,
    projectPath: string,
    contextStoreUuid = ensureContextStoreUuid(db),
): void {
    withPrivilegedWriter(db, () => {
        db.prepare(
            "INSERT INTO authority_managed(project_path, context_store_uuid, marked_at) VALUES (?, ?, ?) ON CONFLICT(project_path) DO UPDATE SET context_store_uuid = excluded.context_store_uuid, marked_at = excluded.marked_at",
        ).run(projectPath, contextStoreUuid, Date.now());
    });
}

export function removeAuthorityManagedMarker(db: Database, projectPath: string): void {
    withPrivilegedWriter(db, () => {
        db.prepare("DELETE FROM authority_managed WHERE project_path = ?").run(projectPath);
    });
}

function setRepairPending(db: Database, projectPath: string): void {
    withPrivilegedWriter(db, () => {
        db.prepare(
            "INSERT INTO authority_repair_pending(project_path, started_at) VALUES (?, ?) ON CONFLICT(project_path) DO UPDATE SET started_at = excluded.started_at",
        ).run(projectPath, Date.now());
    });
}

function clearRepairPending(db: Database, projectPath: string): void {
    withPrivilegedWriter(db, () => {
        db.prepare("DELETE FROM authority_repair_pending WHERE project_path = ?").run(projectPath);
    });
}

/**
 * Repair a marker lost by restoring an older context.db snapshot. The write barrier
 * makes the repair atomic with the marker installation; callers keep application
 * writes closed until this function resolves.
 */
export async function reconcileAuthorityMarker(args: {
    db: Database;
    projectPath: string;
    module: AuthorityModuleClient;
}): Promise<{ status: "legacy" | "ok" | "repaired"; authority: AuthorityStatus | null }> {
    const contextStoreUuid = ensureContextStoreUuid(args.db);
    const marker = getAuthorityManagedMarker(args.db, args.projectPath);
    if (marker) {
        const statuses = await Promise.all(
            AUTHORITY_DOMAINS.map((domain) =>
                args.module.authorityStatus({
                    context_store_uuid: contextStoreUuid,
                    project: args.projectPath,
                    domain,
                }),
            ),
        );
        return {
            status: "ok",
            authority: statuses.find((result) => result.authority !== null)?.authority ?? null,
        };
    }

    // A missing marker is ambiguous until the module answers. Keep all writes closed
    // during that round-trip so a restored store cannot accept a write before repair.
    setRepairPending(args.db, args.projectPath);
    // Keep the durable pending marker if the module request fails: this host is expected
    // to reach the module, so an unknown result remains fail-closed until a later retry.
    const statuses: Array<{ authority: AuthorityStatus | null }> = await Promise.all(
        AUTHORITY_DOMAINS.map((domain) =>
            args.module.authorityStatus({
                context_store_uuid: contextStoreUuid,
                project: args.projectPath,
                domain,
            }),
        ),
    );
    const authority =
        statuses.find((result) => result.authority !== null && result.authority.state !== "TS")
            ?.authority ?? null;
    if (!authority) {
        clearRepairPending(args.db, args.projectPath);
        return { status: "legacy", authority: null };
    }

    // The module still owns this UUID, so a marker-less restore is regressed rather
    // than a new store. Hold the SQLite writer lock while reinstalling the fence.
    withPrivilegedWriter(args.db, () => {
        installAuthorityManagedMarker(args.db, args.projectPath, contextStoreUuid);
        args.db
            .prepare("DELETE FROM authority_repair_pending WHERE project_path = ?")
            .run(args.projectPath);
    });
    return { status: "repaired", authority };
}

export async function reconcileAuthorityProject(args: {
    db: Database;
    projectPath: string;
    module: AuthorityModuleClient;
}): Promise<void> {
    await reconcileAuthorityMarker(args);
    const contextStoreUuid = ensureContextStoreUuid(args.db);
    for (const domain of AUTHORITY_DOMAINS) {
        const status = await args.module.authorityStatus({
            context_store_uuid: contextStoreUuid,
            project: args.projectPath,
            domain,
        });
        if (status.authority?.state !== "MODULE") continue;
        const identity = args.db
            .prepare(
                "SELECT 1 FROM mirror_identity WHERE domain = ? AND module_project = ? LIMIT 1",
            )
            .get(domain, args.projectPath);
        if (identity) continue;
        if (!args.module.mirrorPull) {
            throw new Error(`authority reconciliation requires mirror.pull for ${domain}`);
        }
        withPrivilegedWriter(args.db, () => {
            args.db
                .transaction(() => {
                    args.db
                        .prepare(
                            "DELETE FROM mirror_identity WHERE domain = ? AND module_project = ?",
                        )
                        .run(domain, args.projectPath);
                    args.db
                        .prepare(
                            "DELETE FROM mirror_pending_references WHERE domain = ? AND module_project = ?",
                        )
                        .run(domain, args.projectPath);
                    if (domain === "notes") {
                        args.db
                            .prepare("DELETE FROM mirror_note_revisions WHERE module_project = ?")
                            .run(args.projectPath);
                    }
                    args.db
                        .prepare(
                            "INSERT INTO mirror_cursors(domain, cursor, updated_at) VALUES (?, 0, ?) ON CONFLICT(domain) DO UPDATE SET cursor = 0, updated_at = excluded.updated_at",
                        )
                        .run(domain, Date.now());
                })
                .immediate();
        });
        if (domain === "memories") {
            await ensureLiveMemoryResnapshot({ db: args.db, module: args.module, limit: 1000 });
        }
        for (;;) {
            const cursor = getMirrorCursor(args.db, domain);
            const response = await args.module.mirrorPull({ domain, cursor, limit: 1000 });
            const next = applyMirrorPage({ db: args.db, page: response.page });
            if (!response.page.has_more || next === cursor) break;
        }
    }
}

export interface PrepareAuthorityArgs {
    db: Database;
    projectPath: string;
    domains?: readonly AuthorityDomain[];
    module: AuthorityModuleClient;
    seedPages: (domain: AuthorityDomain) => Promise<readonly Record<string, unknown>[]>;
    /** Test seam for alternate canonical encoders. Production uses the shared row digest. */
    checksum?: (domain: AuthorityDomain, rows: readonly Record<string, unknown>[]) => string;
}

function canonicalizeSeedValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalizeSeedValue);
    if (value === null || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
        Object.keys(record)
            .sort()
            .map((key) => [key, canonicalizeSeedValue(record[key])]),
    );
}

export function checksumAuthoritySeedRows(rows: readonly Record<string, unknown>[]): string {
    const ordered = [...rows].sort((left, right) => {
        const leftId = seedSourceRowId(left) ?? Number.MAX_SAFE_INTEGER;
        const rightId = seedSourceRowId(right) ?? Number.MAX_SAFE_INTEGER;
        return leftId - rightId;
    });
    return createHash("sha256")
        .update(JSON.stringify(ordered.map(canonicalizeSeedValue)))
        .digest("hex");
}

function maxDomainRowId(db: Database, domain: AuthorityDomain, projectPath: string): number {
    const row = (
        domain === "memories"
            ? db
                  .prepare(
                      "SELECT COALESCE(MAX(rowid), 0) AS max_rowid FROM memories WHERE project_path = ?",
                  )
                  .get(projectPath)
            : db
                  .prepare(
                      `SELECT COALESCE(MAX(n.rowid), 0) AS max_rowid
                         FROM notes n
                        WHERE n.project_path = ?
                           OR (n.project_path IS NULL AND EXISTS (
                               SELECT 1 FROM session_projects sp
                                WHERE sp.session_id = n.session_id AND sp.project_path = ?
                           ))`,
                  )
                  .get(projectPath, projectPath)
    ) as { max_rowid?: number } | undefined;
    return typeof row?.max_rowid === "number" ? row.max_rowid : 0;
}

/** Read the transactionally maintained domain mutation epoch (0 when never bumped). */
export function readDomainMutationEpoch(
    db: Database,
    projectPath: string,
    domain: AuthorityDomain,
): number {
    const row = db
        .prepare("SELECT epoch FROM domain_mutation_epoch WHERE project_path = ? AND domain = ?")
        .get(projectPath, domain) as { epoch?: number } | undefined;
    return typeof row?.epoch === "number" ? row.epoch : 0;
}

/**
 * Bump the domain mutation epoch inside the current privileged write transaction.
 * Same-connection privileged UPDATEs do not advance PRAGMA data_version; this epoch
 * is the capture bound that detects those writes.
 */
export function bumpDomainMutationEpoch(
    db: Database,
    projectPath: string,
    domain: AuthorityDomain,
): void {
    db.prepare(
        `INSERT INTO domain_mutation_epoch(project_path, domain, epoch) VALUES (?, ?, 1)
         ON CONFLICT(project_path, domain) DO UPDATE SET epoch = epoch + 1`,
    ).run(projectPath, domain);
}

function installMarkerAndCaptureBounds(args: {
    db: Database;
    projectPath: string;
    contextStoreUuid: string;
    domains: readonly AuthorityDomain[];
}): void {
    args.db.exec("BEGIN IMMEDIATE");
    try {
        withPrivilegedWriter(args.db, () => {
            args.db
                .prepare(
                    "INSERT INTO authority_managed(project_path, context_store_uuid, marked_at) VALUES (?, ?, ?) ON CONFLICT(project_path) DO UPDATE SET context_store_uuid = excluded.context_store_uuid, marked_at = excluded.marked_at",
                )
                .run(args.projectPath, args.contextStoreUuid, Date.now());
            const capture = args.db.prepare(
                "INSERT INTO authority_capture_bounds(project_path, domain, max_rowid, data_version, mutation_epoch, captured_at) VALUES (?, ?, ?, 0, ?, ?) ON CONFLICT(project_path, domain) DO UPDATE SET max_rowid = excluded.max_rowid, data_version = excluded.data_version, mutation_epoch = excluded.mutation_epoch, captured_at = excluded.captured_at",
            );
            for (const domain of args.domains) {
                capture.run(
                    args.projectPath,
                    domain,
                    maxDomainRowId(args.db, domain, args.projectPath),
                    readDomainMutationEpoch(args.db, args.projectPath, domain),
                    Date.now(),
                );
            }
        });
        args.db.exec("COMMIT");
    } catch (error) {
        try {
            args.db.exec("ROLLBACK");
        } catch {
            // Preserve the capture failure.
        }
        throw error;
    }
}

function capturedBoundsUnchanged(
    db: Database,
    projectPath: string,
    domains: readonly AuthorityDomain[],
): boolean {
    db.exec("BEGIN IMMEDIATE");
    try {
        const read = db.prepare(
            "SELECT max_rowid, mutation_epoch FROM authority_capture_bounds WHERE project_path = ? AND domain = ?",
        );
        const unchanged = domains.every((domain) => {
            const captured = read.get(projectPath, domain) as
                | { max_rowid: number; mutation_epoch: number }
                | undefined;
            return (
                captured !== undefined &&
                captured.max_rowid === maxDomainRowId(db, domain, projectPath) &&
                captured.mutation_epoch === readDomainMutationEpoch(db, projectPath, domain)
            );
        });
        db.exec("COMMIT");
        return unchanged;
    } catch (error) {
        try {
            db.exec("ROLLBACK");
        } catch {
            // Preserve the verification failure.
        }
        throw error;
    }
}

export async function prepareAuthority(args: PrepareAuthorityArgs): Promise<AuthorityStatus[]> {
    const contextStoreUuid = ensureContextStoreUuid(args.db);
    const domains = args.domains ?? AUTHORITY_DOMAINS;
    if (!args.module.authoritySeed) {
        throw new Error("authority preparation requires the authority.seed module route");
    }

    installMarkerAndCaptureBounds({
        db: args.db,
        projectPath: args.projectPath,
        contextStoreUuid,
        domains,
    });

    const startedGenerations = new Map<AuthorityDomain, number>();
    const prepared: Array<{
        domain: AuthorityDomain;
        generation: number;
    }> = [];
    try {
        for (const domain of domains) {
            const started = await args.module.authorityPrepare({
                method: "authority.prepare",
                phase: "begin",
                context_store_uuid: contextStoreUuid,
                project: args.projectPath,
                domain,
            });
            startedGenerations.set(domain, started.authority.generation);
            const rows = await args.seedPages(domain);
            for (const page of chunkRowsForFrame(rows)) {
                const seedResponse = await args.module.authoritySeed({
                    method: "authority.seed",
                    context_store_uuid: contextStoreUuid,
                    project: args.projectPath,
                    domain,
                    rows: page,
                });
                const identityByModuleRowId = new Map<
                    number,
                    { moduleRowId: number; sourceRowId: number }
                >();
                for (const [index, moduleRowId] of (seedResponse.module_row_ids ?? []).entries()) {
                    const sourceRowId = seedSourceRowId(page[index]);
                    if (sourceRowId === null) continue;
                    // The module coalesces same-frame natural-key duplicates to the
                    // last snapshot. Repeated module ids therefore choose the last
                    // source id as the canonical mirror-back target as well.
                    identityByModuleRowId.set(moduleRowId, { moduleRowId, sourceRowId });
                }
                const identities = [...identityByModuleRowId.values()];
                if (identities.length > 0) {
                    // Seed identities are one response batch: keeping the SELECT+insert
                    // sequence in one local transaction prevents one SQLite write lock per row.
                    args.db
                        .transaction(() => {
                            for (const identity of identities) {
                                rememberIdentity(
                                    args.db,
                                    domain,
                                    args.projectPath,
                                    identity.moduleRowId,
                                    identity.sourceRowId,
                                );
                            }
                        })
                        .immediate();
                }
            }
            const digest = args.checksum?.(domain, rows) ?? checksumAuthoritySeedRows(rows);
            const completed = await args.module.authorityPrepare({
                method: "authority.prepare",
                phase: "complete",
                context_store_uuid: contextStoreUuid,
                project: args.projectPath,
                domain,
                generation: started.authority.generation,
                checksum_expected: digest,
            });
            const authority = completed.authority;
            const checksumOk = authority.checksum_ok === true || authority.checksum_ok === 1;
            if (
                authority.state !== "PREPARING" ||
                !checksumOk ||
                authority.checksum_expected !== digest ||
                authority.checksum_actual !== digest
            ) {
                log(
                    `[magic-context] authority seed checksum mismatch for ${domain}; aborting module ownership`,
                );
                throw new Error(`authority seed verification failed for ${domain}`);
            }
            prepared.push({ domain, generation: started.authority.generation });
        }

        if (!capturedBoundsUnchanged(args.db, args.projectPath, domains)) {
            log(
                "[magic-context] authority capture bound drifted while writers were fenced; aborting module ownership",
            );
            throw new Error("authority capture bound changed while TypeScript writers were fenced");
        }

        const results: AuthorityStatus[] = [];
        for (const item of prepared) {
            const acknowledged = await args.module.authorityPrepare({
                method: "authority.prepare",
                phase: "ack",
                context_store_uuid: contextStoreUuid,
                project: args.projectPath,
                domain: item.domain,
                generation: item.generation,
            });
            if (acknowledged.authority.state !== "MODULE") {
                throw new Error(`authority acknowledgement failed for ${item.domain}`);
            }
            results.push(acknowledged.authority);
        }
        return results;
    } catch (error) {
        let moduleOwnsDomain = false;
        for (const [domain, generation] of startedGenerations) {
            try {
                const aborted = await args.module.authorityPrepare({
                    method: "authority.prepare",
                    phase: "abort",
                    context_store_uuid: contextStoreUuid,
                    project: args.projectPath,
                    domain,
                    generation,
                });
                moduleOwnsDomain ||= aborted.authority.state === "MODULE";
            } catch {
                moduleOwnsDomain = true;
            }
        }
        if (!moduleOwnsDomain) removeAuthorityManagedMarker(args.db, args.projectPath);
        throw error;
    }
}

function authorityDrainErrorCode(error: unknown): string | null {
    let current = error;
    for (let depth = 0; depth < 3; depth += 1) {
        if (!current || typeof current !== "object") break;
        const record = current as { code?: unknown; cause?: unknown };
        if (typeof record.code === "string") return record.code;
        current = record.cause;
    }
    return error instanceof Error && error.message.includes("authority_feed_head_advanced")
        ? "authority_feed_head_advanced"
        : null;
}

const MAX_DRAIN_RECAPTURE_ATTEMPTS = 5;

export async function drainAuthority(args: {
    db: Database;
    projectPath: string;
    domain: AuthorityDomain;
    module: AuthorityModuleClient;
    checksum: string | (() => string);
    limit?: number;
}): Promise<AuthorityDrainResult> {
    if (!args.module.authorityDrain) {
        throw new Error("authority drain is unavailable on this module client");
    }
    if (!args.module.mirrorPull) {
        throw new Error("memory authority drain requires the mirror.pull module route");
    }
    const contextStoreUuid = ensureContextStoreUuid(args.db);
    const limit = Math.max(1, Math.min(args.limit ?? 100, 1000));
    let recaptureAttempts = 0;

    drainAttempt: while (true) {
        const leaseStartedAt = Date.now();
        const beginResponse = await args.module.authorityDrain({
            method: "authority.drain.begin",
            context_store_uuid: contextStoreUuid,
            project: args.projectPath,
            domain: args.domain,
            action: "begin",
            lease: `ts:${contextStoreUuid}`,
            lease_started_at: leaseStartedAt,
            lease_expires_at: leaseStartedAt + 60_000,
        });
        if (!beginResponse.authority) {
            if (authorityDrainErrorCode(beginResponse) === "authority_feed_head_advanced") {
                if (recaptureAttempts >= MAX_DRAIN_RECAPTURE_ATTEMPTS) {
                    return {
                        code: "authority_drain_contended",
                        retryable: true,
                        state: "DRAINING",
                        attempts: recaptureAttempts,
                        authority: beginResponse.authority ?? null,
                    };
                }
                recaptureAttempts += 1;
                continue;
            }
            throw new Error("authority drain begin omitted authority");
        }
        let status = beginResponse.authority;
        const coordinatorToken = status.coordinator_token;
        if (typeof coordinatorToken !== "string" || coordinatorToken.length === 0) {
            throw new Error("authority drain begin omitted coordinator_token");
        }

        if (args.domain === "memories") {
            // Recovery drains share the ordinary mirror feed. Restore the module's canonical
            // live identities before advancing its cursor, so replaying a tombstone cannot
            // delete an identity that has not yet been restored.
            await ensureLiveMemoryResnapshot({ db: args.db, module: args.module, limit });
        }
        const upperBound = status.captured_upper_bound ?? status.drain_cursor ?? 0;
        while (getMirrorCursor(args.db, args.domain) < upperBound) {
            const cursor = getMirrorCursor(args.db, args.domain);
            const page = await args.module.mirrorPull({
                domain: args.domain,
                cursor,
                limit,
            });
            applyMirrorPage({ db: args.db, page: page.page });
            const next = getMirrorCursor(args.db, args.domain);
            if (next === cursor) break;
        }
        if (args.domain === "memories") {
            resolvePendingMemoryReferencesForDrain(args.db);
        }
        for (const step of [
            "seed",
            "memories",
            "notes",
            "compartments",
            "reconcile",
            "verify",
        ] as const) {
            const stepResponse = await args.module.authorityDrain({
                method: `authority.drain_${step}`,
                context_store_uuid: contextStoreUuid,
                project: args.projectPath,
                domain: args.domain,
                action: step,
                generation: status.generation,
                cursor: getMirrorCursor(args.db, args.domain),
                coordinator_token: coordinatorToken,
                now_ms: Date.now(),
            });
            if (!stepResponse.authority) {
                if (authorityDrainErrorCode(stepResponse) === "authority_feed_head_advanced") {
                    if (recaptureAttempts >= MAX_DRAIN_RECAPTURE_ATTEMPTS) {
                        return {
                            code: "authority_drain_contended",
                            retryable: true,
                            state: "DRAINING",
                            attempts: recaptureAttempts,
                            authority: status,
                        };
                    }
                    recaptureAttempts += 1;
                    continue drainAttempt;
                }
                throw new Error(`authority drain ${step} omitted authority`);
            }
            status = stepResponse.authority;
        }
        const drainChecksum = typeof args.checksum === "function" ? args.checksum() : args.checksum;
        let finished: AuthorityStatus;
        try {
            const finishResponse = await args.module.authorityDrain({
                method: "authority.drain.finish",
                context_store_uuid: contextStoreUuid,
                project: args.projectPath,
                domain: args.domain,
                action: "finish",
                generation: status.generation,
                checksum_expected: drainChecksum,
                checksum_actual: drainChecksum,
                verified: true,
                coordinator_token: coordinatorToken,
                now_ms: Date.now(),
            });
            if (!finishResponse.authority) {
                if (authorityDrainErrorCode(finishResponse) === "authority_feed_head_advanced") {
                    throw Object.assign(new Error("authority_feed_head_advanced"), {
                        code: "authority_feed_head_advanced",
                    });
                }
                throw new Error("authority drain finish omitted authority");
            }
            finished = finishResponse.authority;
        } catch (error) {
            if (authorityDrainErrorCode(error) === "authority_feed_head_advanced") {
                if (recaptureAttempts >= MAX_DRAIN_RECAPTURE_ATTEMPTS) {
                    // Historian publication and state sync legitimately remain writable while
                    // DRAINING. They are bursty, so a later scheduled drain normally converges;
                    // bounding this coordinator prevents a steady producer from livelocking it.
                    return {
                        code: "authority_drain_contended",
                        retryable: true,
                        state: "DRAINING",
                        attempts: recaptureAttempts,
                        authority: status,
                    };
                }
                recaptureAttempts += 1;
                // A non-facade writer may append after the prior bound. Beginning the next
                // attempt captures a fresh head; replay remains bounded to that captured head.
                continue;
            }
            throw error;
        }
        if (finished.state !== "TS") {
            throw new Error("memory authority drain did not reactivate TypeScript ownership");
        }
        // A project marker fences both authority domains. Remove it only after neither
        // domain remains module-owned; a one-domain drain must not reopen the other domain.
        const remaining = await Promise.all(
            AUTHORITY_DOMAINS.map((domain) =>
                args.module.authorityStatus({
                    context_store_uuid: contextStoreUuid,
                    project: args.projectPath,
                    domain,
                }),
            ),
        );
        if (remaining.every((result) => !result.authority || result.authority.state === "TS")) {
            removeAuthorityManagedMarker(args.db, args.projectPath);
        }
        return finished;
    }
}

function seedSourceRowId(row: Record<string, unknown>): number | null {
    const direct = row.source_row_id;
    if (typeof direct === "number" && Number.isInteger(direct)) return direct;
    const snapshot = row.snapshot;
    if (snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)) {
        const sourceId = (snapshot as Record<string, unknown>).id;
        return typeof sourceId === "number" && Number.isInteger(sourceId) ? sourceId : null;
    }
    const id = row.id;
    return typeof id === "number" && Number.isInteger(id) ? id : null;
}

const MAX_AUTHORITY_SEED_FRAME_BYTES = 900 * 1024;

function chunkRowsForFrame<T>(rows: readonly T[]): T[][] {
    const chunks: T[][] = [];
    let current: T[] = [];
    let currentBytes = 2;
    for (const row of rows) {
        const rowBytes = new TextEncoder().encode(JSON.stringify(row)).byteLength + 1;
        if (current.length > 0 && currentBytes + rowBytes > MAX_AUTHORITY_SEED_FRAME_BYTES) {
            chunks.push(current);
            current = [];
            currentBytes = 2;
        }
        current.push(row);
        currentBytes += rowBytes;
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
}

export function getMirrorCursor(db: Database, domain: AuthorityDomain): number {
    const row = db.prepare("SELECT cursor FROM mirror_cursors WHERE domain = ?").get(domain) as
        | { cursor?: number }
        | undefined;
    return typeof row?.cursor === "number" ? row.cursor : 0;
}

function rowNumber(row: Record<string, unknown>, key: string, fallback = 0): number {
    const value = row[key];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function rowString(row: Record<string, unknown>, key: string, fallback = ""): string {
    const value = row[key];
    return typeof value === "string" ? value : fallback;
}

function rowNullableString(row: Record<string, unknown>, key: string): string | null {
    const value = row[key];
    return typeof value === "string" ? value : null;
}

const MEMORY_SNAPSHOT_COLUMNS = [
    "id",
    "project_path",
    "category",
    "content",
    "normalized_hash",
    "importance",
    "scope",
    "shareable",
    "source_session_id",
    "source_type",
    "seen_count",
    "retrieval_count",
    "first_seen_at",
    "created_at",
    "updated_at",
    "last_seen_at",
    "last_retrieved_at",
    "status",
    "expires_at",
    "verification_status",
    "verified_at",
    "classified_at",
    "superseded_by_memory_id",
    "merged_from",
    "metadata_json",
    "context_store_uuid",
    "context_row_id",
    "mural_cue",
    "mural_cue_hash",
    "mural_cue_at",
    "mural_cue_rejection_count",
] as const;

function hasSnapshotField(row: Record<string, unknown>, key: string): boolean {
    // Own-property checks distinguish a missing snapshot field from an explicit null clear.
    // biome-ignore lint/suspicious/noPrototypeBuiltins: snapshot objects may have an untrusted prototype
    return Object.prototype.hasOwnProperty.call(row, key);
}

function isCompleteMemorySnapshot(row: Record<string, unknown>): boolean {
    return MEMORY_SNAPSHOT_COLUMNS.every((column) => hasSnapshotField(row, column));
}

type MirrorResnapshotStatus = "pending_check" | "resnapshotting" | "complete";

interface MirrorResnapshotState {
    status: MirrorResnapshotStatus;
    generation: string | null;
    updated_at: number;
}

function memoryResnapshotState(db: Database): MirrorResnapshotState | null {
    const row = db
        .prepare(
            "SELECT status, generation, updated_at FROM mirror_resnapshot_state WHERE domain = 'memories'",
        )
        .get() as MirrorResnapshotState | undefined;
    return row ?? null;
}

function casMemoryResnapshotState(
    db: Database,
    observed: MirrorResnapshotState,
    status: MirrorResnapshotStatus,
    generation: string | null,
): boolean {
    const result = db
        .prepare(
            `UPDATE mirror_resnapshot_state
                SET status = ?, generation = ?, updated_at = ?
              WHERE domain = 'memories'
                AND status = ?
                AND generation IS ?`,
        )
        .run(status, generation, Date.now(), observed.status, observed.generation);
    return result.changes === 1;
}

function upgradeMemoryMirrorNeedsResnapshot(db: Database): boolean {
    // A partially populated live view is just as unsafe as an empty one. Compare the
    // identity sets, not only their counts, so an interrupted upgrade cannot mark a
    // truncated mirror complete and leave classification candidates missing.
    const missingLive = db
        .prepare(
            `SELECT 1
               FROM mirror_identity identity
              WHERE identity.domain = 'memories'
                AND NOT EXISTS (
                    SELECT 1
                      FROM mirror_live_memory_rows live
                     WHERE live.module_project = identity.module_project
                       AND live.module_row_id = identity.module_row_id
                )
              LIMIT 1`,
        )
        .get();
    if (missingLive) return true;
    const orphanedLive = db
        .prepare(
            `SELECT 1
               FROM mirror_live_memory_rows live
              WHERE NOT EXISTS (
                    SELECT 1
                      FROM mirror_identity identity
                     WHERE identity.domain = 'memories'
                       AND identity.module_project = live.module_project
                       AND identity.module_row_id = live.module_row_id
              )
              LIMIT 1`,
        )
        .get();
    return Boolean(orphanedLive);
}

function stageLiveMemorySnapshotPage(
    db: Database,
    generation: string,
    rows: readonly ChangefeedRow[],
): boolean {
    const owned = db
        .prepare(
            `SELECT 1
               FROM mirror_resnapshot_state
              WHERE domain = 'memories'
                AND status = 'resnapshotting'
                AND generation = ?`,
        )
        .get(generation);
    if (!owned) return false;

    const insert = db.prepare(
        `INSERT OR IGNORE INTO mirror_live_staging(
             generation, module_project, module_row_id, category, normalized_hash, full_row_snapshot
          ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const feed of rows) {
        const row = feed.full_row_snapshot;
        const moduleProject = rowString(row, "project_path");
        const normalizedHash = rowString(row, "normalized_hash");
        if (!moduleProject || !normalizedHash) {
            throw new Error("live memory snapshot omitted project_path or normalized_hash");
        }
        insert.run(
            generation,
            moduleProject,
            feed.module_row_id,
            rowString(row, "category", "CONSTRAINTS"),
            normalizedHash,
            JSON.stringify(row),
        );
    }
    return true;
}

function installStagedLiveMemorySnapshot(db: Database, generation: string): boolean {
    const owned = db
        .prepare(
            `SELECT 1
               FROM mirror_resnapshot_state
              WHERE domain = 'memories'
                AND status = 'resnapshotting'
                AND generation = ?`,
        )
        .get(generation);
    if (!owned) return false;

    db.prepare("DELETE FROM mirror_live_memory_rows").run();
    db.prepare(
        `INSERT INTO mirror_live_memory_rows(
            module_project, module_row_id, category, normalized_hash, full_row_snapshot
         )
         SELECT module_project, module_row_id, category, normalized_hash, full_row_snapshot
           FROM mirror_live_staging
          WHERE generation = ?`,
    ).run(generation);
    const completed = db
        .prepare(
            `UPDATE mirror_resnapshot_state
                SET status = 'complete', updated_at = ?
              WHERE domain = 'memories'
                AND status = 'resnapshotting'
                AND generation = ?`,
        )
        .run(Date.now(), generation);
    if (completed.changes !== 1) {
        throw new Error("live memory resnapshot ownership changed inside its install transaction");
    }
    db.prepare("DELETE FROM mirror_live_staging WHERE generation = ?").run(generation);
    return true;
}

interface MirrorPageStatements {
    identityByModule: Statement;
    insertIdentity: Statement;
    deleteIdentityByContext: Statement;
    deleteLiveMemory: Statement;
    deletePendingReferencesForMemory: Statement;
    deleteIdentity: Statement;
    sharedIdentity: Statement;
    memoryById: Statement;
    memoryIdByStoreId: Statement;
    memoryCandidates: Statement;
    insertMemory: Statement;
    liveMemoryMatches: Statement;
    deleteMemoryEmbeddings: Statement;
    deleteMemory: Statement;
    liveMemorySnapshot: Statement;
    upsertLiveMemory: Statement;
    updateMemory: Statement;
    updateSuperseded: Statement;
    deletePendingReference: Statement;
    upsertPendingReference: Statement;
    deleteMemoryVerifications: Statement;
    insertMemoryVerification: Statement;
    noteById: Statement;
    noteIdByStoreId: Statement;
    insertNote: Statement;
    deleteNote: Statement;
    deleteNoteRevisions: Statement;
    updateNote: Statement;
    upsertNoteRevision: Statement;
    translateMemoryReferences: Statement;
    clearTranslatedReferences: Statement;
    repairPending: Statement;
    markRepairPending: Statement;
    clearRepairPending: Statement;
    repairCandidates: Statement;
    repairMemory: Statement;
    updateCursor: Statement;
    contextStoreUuid: string | null;
}

function ensureMemoryRepairState(db: Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS mirror_memory_repair_state (
            id INTEGER PRIMARY KEY CHECK(id = 1),
            dirty INTEGER NOT NULL DEFAULT 0 CHECK(dirty IN (0, 1)),
            updated_at INTEGER NOT NULL DEFAULT 0
        );
    `);
    db.prepare(
        "INSERT OR IGNORE INTO mirror_memory_repair_state(id, dirty, updated_at) VALUES (1, 0, 0)",
    ).run();
}

function markMemoryRepairPending(db: Database): void {
    ensureMemoryRepairState(db);
    db.prepare("UPDATE mirror_memory_repair_state SET dirty = 1, updated_at = ? WHERE id = 1").run(
        Date.now(),
    );
}

function prepareMirrorPageStatements(db: Database): MirrorPageStatements {
    return {
        identityByModule: db.prepare(
            "SELECT context_row_id FROM mirror_identity WHERE domain = ? AND module_project = ? AND module_row_id = ?",
        ),
        insertIdentity: db.prepare(
            "INSERT OR IGNORE INTO mirror_identity(domain, module_project, module_row_id, context_row_id) VALUES (?, ?, ?, ?)",
        ),
        deleteIdentityByContext: db.prepare(
            "DELETE FROM mirror_identity WHERE domain = ? AND context_row_id = ?",
        ),
        deleteLiveMemory: db.prepare(
            "DELETE FROM mirror_live_memory_rows WHERE module_project = ? AND module_row_id = ?",
        ),
        deletePendingReferencesForMemory: db.prepare(
            "DELETE FROM mirror_pending_references WHERE domain = ? AND module_project = ? AND (module_row_id = ? OR target_module_row_id = ?)",
        ),
        deleteIdentity: db.prepare(
            "DELETE FROM mirror_identity WHERE domain = ? AND module_project = ? AND module_row_id = ?",
        ),
        sharedIdentity: db.prepare(
            "SELECT 1 FROM mirror_identity WHERE domain = ? AND context_row_id = ? LIMIT 1",
        ),
        memoryById: db.prepare(
            `SELECT project_path, category, content, normalized_hash, importance, scope, shareable,
                    source_session_id, source_type, seen_count, retrieval_count, first_seen_at,
                    created_at, updated_at, last_seen_at, last_retrieved_at, status, expires_at,
                     verification_status, verified_at, classified_at, superseded_by_memory_id,
                     merged_from, metadata_json, mural_cue, mural_cue_hash, mural_cue_at,
                     mural_cue_rejection_count
                FROM memories WHERE id = ?`,
        ),
        memoryIdByStoreId: db.prepare("SELECT id FROM memories WHERE id = ? AND project_path = ?"),
        memoryCandidates: db.prepare(
            "SELECT id FROM memories WHERE project_path = ? AND category = ? AND normalized_hash = ? ORDER BY id",
        ),
        insertMemory: db.prepare(
            "INSERT INTO memories (project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, ?, '', '', 0, 0, 0, 0)",
        ),
        liveMemoryMatches: db.prepare(
            `SELECT module_project, module_row_id FROM mirror_live_memory_rows
              WHERE module_project = ? AND category = ? AND normalized_hash = ?
              ORDER BY module_row_id LIMIT 2`,
        ),
        deleteMemoryEmbeddings: db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?"),
        deleteMemory: db.prepare("DELETE FROM memories WHERE id = ?"),
        liveMemorySnapshot: db.prepare(
            "SELECT full_row_snapshot FROM mirror_live_memory_rows WHERE module_project = ? AND module_row_id = ?",
        ),
        upsertLiveMemory: db.prepare(
            `INSERT INTO mirror_live_memory_rows(
                 module_project, module_row_id, category, normalized_hash, full_row_snapshot
             ) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(module_project, module_row_id) DO UPDATE SET
                 category = excluded.category,
                 normalized_hash = excluded.normalized_hash,
                 full_row_snapshot = excluded.full_row_snapshot`,
        ),
        updateMemory: db.prepare(
            `UPDATE memories SET project_path = ?, category = ?, content = ?, normalized_hash = ?,
             importance = ?, scope = ?, shareable = ?, source_session_id = ?, source_type = ?,
             seen_count = ?, retrieval_count = ?, first_seen_at = ?, created_at = ?, updated_at = ?,
             last_seen_at = ?, last_retrieved_at = ?, status = ?, expires_at = ?,
              verification_status = ?, verified_at = ?, classified_at = ?, superseded_by_memory_id = ?,
              merged_from = ?, metadata_json = ?, mural_cue = ?, mural_cue_hash = ?, mural_cue_at = ?,
              mural_cue_rejection_count = ? WHERE id = ?`,
        ),
        updateSuperseded: db.prepare(
            "UPDATE memories SET superseded_by_memory_id = ?, updated_at = ? WHERE id = ?",
        ),
        deletePendingReference: db.prepare(
            "DELETE FROM mirror_pending_references WHERE domain = 'memories' AND module_project = ? AND module_row_id = ?",
        ),
        upsertPendingReference: db.prepare(
            "INSERT INTO mirror_pending_references(domain, module_project, module_row_id, target_module_row_id) VALUES ('memories', ?, ?, ?) ON CONFLICT(domain, module_project, module_row_id) DO UPDATE SET target_module_row_id = excluded.target_module_row_id",
        ),
        deleteMemoryVerifications: db.prepare(
            "DELETE FROM memory_verifications WHERE memory_id = ?",
        ),
        insertMemoryVerification: db.prepare(
            "INSERT INTO memory_verifications(memory_id, file_path, verified_at, mapped_at, mapping_origin) VALUES (?, ?, ?, ?, ?)",
        ),
        noteById: db.prepare("SELECT * FROM notes WHERE id = ?"),
        noteIdByStoreId: db.prepare(
            "SELECT id FROM notes WHERE id = ? AND type = 'smart' AND project_path = ?",
        ),
        insertNote: db.prepare(
            "INSERT INTO notes (type, status, content, project_path, session_id, created_at, updated_at) VALUES ('smart', 'active', '', ?, ?, 0, 0)",
        ),
        deleteNote: db.prepare("DELETE FROM notes WHERE id = ?"),
        deleteNoteRevisions: db.prepare(
            "DELETE FROM mirror_note_revisions WHERE module_project = ? AND module_row_id = ?",
        ),
        updateNote: db.prepare(
            `UPDATE notes SET type = ?, status = ?, project_path = ?, session_id = ?, content = ?,
             surface_condition = ?, compiled_provider = ?, compiled_config = ?, compiled_at = ?, compile_status = ?,
             ready_at = ?, ready_reason = ?, manifest_json = ?, compiled_check = ?,
             check_hash = ?, check_cron = ?, check_failure_count = ?, check_network_failure_count = ?,
             check_quarantined_until = ?, check_next_due_at = ?, check_compiled_at = ?, check_false_since_at = ?,
             check_last_liveness_at = ?, last_checked_at = ?, check_status = ?, check_version = ?,
             policy_version = ?, anchor_block_id = ?, anchor_ordinal = ?, created_at = ?, updated_at = ? WHERE id = ?`,
        ),
        upsertNoteRevision: db.prepare(
            "INSERT OR REPLACE INTO mirror_note_revisions(module_project, module_row_id, context_row_id, status_version) VALUES (?, ?, ?, ?)",
        ),
        translateMemoryReferences: db.prepare(
            `UPDATE memories
                SET superseded_by_memory_id = (
                    SELECT target.context_row_id
                      FROM mirror_pending_references pending
                      JOIN mirror_identity source
                        ON source.domain = pending.domain
                       AND source.module_project = pending.module_project
                       AND source.module_row_id = pending.module_row_id
                      JOIN mirror_identity target
                        ON target.domain = pending.domain
                       AND target.module_project = pending.module_project
                       AND target.module_row_id = pending.target_module_row_id
                     WHERE pending.domain = 'memories'
                       AND source.context_row_id = memories.id
                ),
                    updated_at = ?
              WHERE id IN (
                    SELECT source.context_row_id
                      FROM mirror_pending_references pending
                      JOIN mirror_identity source
                        ON source.domain = pending.domain
                       AND source.module_project = pending.module_project
                       AND source.module_row_id = pending.module_row_id
                      JOIN mirror_identity target
                        ON target.domain = pending.domain
                       AND target.module_project = pending.module_project
                       AND target.module_row_id = pending.target_module_row_id
                     WHERE pending.domain = 'memories'
              )`,
        ),
        clearTranslatedReferences: db.prepare(
            `DELETE FROM mirror_pending_references
              WHERE domain = 'memories'
                AND EXISTS (
                    SELECT 1
                      FROM mirror_identity source
                      JOIN mirror_identity target
                        ON target.domain = source.domain
                       AND target.module_project = source.module_project
                       AND target.module_row_id = mirror_pending_references.target_module_row_id
                     WHERE source.domain = mirror_pending_references.domain
                       AND source.module_project = mirror_pending_references.module_project
                       AND source.module_row_id = mirror_pending_references.module_row_id
                )`,
        ),
        repairPending: db.prepare("SELECT dirty FROM mirror_memory_repair_state WHERE id = 1"),
        markRepairPending: db.prepare(
            "UPDATE mirror_memory_repair_state SET dirty = 1, updated_at = ? WHERE id = 1",
        ),
        clearRepairPending: db.prepare(
            "UPDATE mirror_memory_repair_state SET dirty = 0, updated_at = ? WHERE id = 1",
        ),
        repairCandidates: db.prepare(
            `SELECT memory.id, live.full_row_snapshot
               FROM memories memory
               JOIN mirror_identity identity
                 ON identity.domain = 'memories'
                AND identity.context_row_id = memory.id
               JOIN mirror_live_memory_rows live
                 ON live.module_project = identity.module_project
                AND live.module_row_id = identity.module_row_id
               JOIN authority_managed managed
                 ON managed.project_path = memory.project_path
                  OR managed.project_path = identity.module_project
              WHERE (memory.source_type IS NULL OR memory.importance IS NULL)
                AND live.full_row_snapshot IS NOT NULL`,
        ),
        repairMemory: db.prepare(
            `UPDATE memories
                SET source_type = COALESCE(?, source_type),
                    importance = COALESCE(?, importance),
                    updated_at = ?
              WHERE id = ?`,
        ),
        updateCursor: db.prepare(
            "INSERT INTO mirror_cursors(domain, cursor, updated_at) VALUES (?, ?, ?) ON CONFLICT(domain) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at",
        ),
        contextStoreUuid: getContextStoreUuid(db),
    };
}

function mirrorIdentity(
    db: Database,
    domain: AuthorityDomain,
    moduleProject: string,
    moduleRowId: number,
    statements?: MirrorPageStatements,
): { context_row_id: number } | null {
    return (
        ((
            statements?.identityByModule ??
            db.prepare(
                "SELECT context_row_id FROM mirror_identity WHERE domain = ? AND module_project = ? AND module_row_id = ?",
            )
        ).get(domain, moduleProject, moduleRowId) as { context_row_id: number } | undefined) ?? null
    );
}

export interface MirroredNoteCompileFields {
    compiledProvider: string | null;
    compiledConfig: string | null;
    compiledAt: number | null;
    compileStatus: "compiled" | "plain" | "refused";
}

export function applyMirroredNoteCompileFields(args: {
    db: Database;
    moduleProject: string;
    moduleRowId: number;
    fields: MirroredNoteCompileFields;
}): boolean {
    return withPrivilegedWriter(args.db, () => {
        const result = args.db
            .prepare(
                `UPDATE notes
                    SET compiled_provider = ?, compiled_config = ?, compiled_at = ?, compile_status = ?,
                        updated_at = ?
                  WHERE id = (
                        SELECT context_row_id
                          FROM mirror_identity
                         WHERE domain = 'notes' AND module_project = ? AND module_row_id = ?
                  )`,
            )
            .run(
                args.fields.compiledProvider,
                args.fields.compiledConfig,
                args.fields.compiledAt,
                args.fields.compileStatus,
                Date.now(),
                args.moduleProject,
                args.moduleRowId,
            );
        return result.changes === 1;
    });
}

function rememberIdentity(
    db: Database,
    domain: AuthorityDomain,
    moduleProject: string,
    moduleRowId: number,
    contextRowId: number,
    statements?: MirrorPageStatements,
): void {
    const existing = mirrorIdentity(db, domain, moduleProject, moduleRowId, statements);
    if (existing) return;
    // A note can be re-minted with a new module row id when authority is prepared
    // again. Replace its stale canonical identity so note evaluation joins the live
    // revision instead of retaining an id that the module no longer recognizes.
    if (domain === "notes") {
        (
            statements?.deleteIdentityByContext ??
            db.prepare("DELETE FROM mirror_identity WHERE domain = ? AND context_row_id = ?")
        ).run(domain, contextRowId);
    }
    // A context row has one canonical module identity. A duplicate memory feed row
    // may still update that row, but it must not claim a second identity for it.
    (
        statements?.insertIdentity ??
        db.prepare(
            "INSERT OR IGNORE INTO mirror_identity(domain, module_project, module_row_id, context_row_id) VALUES (?, ?, ?, ?)",
        )
    ).run(domain, moduleProject, moduleRowId, contextRowId);
}

function contextMemoryId(
    db: Database,
    domain: AuthorityDomain,
    moduleProject: string,
    row: Record<string, unknown>,
    moduleRowId: number,
    statements?: MirrorPageStatements,
): number {
    const mapped = mirrorIdentity(db, domain, moduleProject, moduleRowId, statements);
    if (mapped) return mapped.context_row_id;
    const sourceUuid = rowNullableString(row, "context_store_uuid");
    const sourceId = rowNumber(row, "context_row_id", -1);
    const localStoreUuid = statements?.contextStoreUuid ?? getContextStoreUuid(db);
    // A module row id is meaningful only inside the context database that minted it;
    // matching the number in another store could silently bind this project to foreign data.
    if (sourceUuid && sourceUuid === localStoreUuid && sourceId >= 0) {
        const existing = (
            statements?.memoryIdByStoreId ??
            db.prepare("SELECT id FROM memories WHERE id = ? AND project_path = ?")
        ).get(sourceId, moduleProject) as { id?: number } | undefined;
        if (existing?.id !== undefined) {
            rememberIdentity(db, domain, moduleProject, moduleRowId, existing.id, statements);
            return existing.id;
        }
    }
    // A legacy facade row may have no source identity even though this project in the
    // context database already owns the same fact. Scope the fallback to the module
    // row's context-store project identity so another project cannot claim that row.
    const normalizedHash = rowString(row, "normalized_hash");
    const category = rowString(row, "category", "CONSTRAINTS");
    if (normalizedHash) {
        const candidates = (
            statements?.memoryCandidates ??
            db.prepare(
                "SELECT id FROM memories WHERE project_path = ? AND category = ? AND normalized_hash = ? ORDER BY id",
            )
        ).all(moduleProject, category, normalizedHash) as Array<{ id?: number }>;
        if (candidates.length === 1 && candidates[0]?.id !== undefined) {
            rememberIdentity(db, domain, moduleProject, moduleRowId, candidates[0].id, statements);
            return candidates[0].id;
        }
    }
    const result = (
        statements?.insertMemory ??
        db.prepare(
            "INSERT INTO memories (project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, ?, '', '', 0, 0, 0, 0)",
        )
    ).run(moduleProject, rowString(row, "category", "CONSTRAINTS"));
    const contextId = Number(result.lastInsertRowid);
    rememberIdentity(db, domain, moduleProject, moduleRowId, contextId, statements);
    return contextId;
}

function applyMemoryRow(db: Database, feed: ChangefeedRow, statements: MirrorPageStatements): void {
    const row = feed.full_row_snapshot;
    const moduleProject = rowString(row, "project_path");
    if (!moduleProject) throw new Error("memory feed snapshot has no project_path");
    if (feed.op === "tombstone") {
        statements.deleteLiveMemory.run(moduleProject, feed.module_row_id);
        // Drop pending refs even when the tombstoned module row was never mapped
        // locally; otherwise a forward reference to a never-seen target leaks forever.
        statements.deletePendingReferencesForMemory.run(
            feed.domain,
            moduleProject,
            feed.module_row_id,
            feed.module_row_id,
        );
        const mapped = mirrorIdentity(
            db,
            feed.domain,
            moduleProject,
            feed.module_row_id,
            statements,
        );
        if (!mapped) return;
        statements.deleteIdentity.run(feed.domain, moduleProject, feed.module_row_id);
        const shared = statements.sharedIdentity.get(feed.domain, mapped.context_row_id);
        // A cleanup tombstone for one legacy twin must not delete the context row
        // still owned by another module identity for the same source memory.
        if (shared) return;
        const contextRow = statements.memoryById.get(mapped.context_row_id) as
            | { project_path?: string; category?: string; normalized_hash?: string }
            | undefined;
        if (contextRow?.project_path && contextRow.category && contextRow.normalized_hash) {
            const liveMatches = statements.liveMemoryMatches.all(
                contextRow.project_path,
                contextRow.category,
                contextRow.normalized_hash,
            ) as Array<{ module_project: string; module_row_id: number }>;
            if (liveMatches.length === 1 && liveMatches[0]) {
                // Feed inserts can race for the mirror's one identity slot. Rechecking live
                // content after removing the tombstoned owner preserves the canonical row
                // without weakening the one-context-row/one-module-row invariant.
                rememberIdentity(
                    db,
                    feed.domain,
                    liveMatches[0].module_project,
                    liveMatches[0].module_row_id,
                    mapped.context_row_id,
                    statements,
                );
                return;
            }
        }
        statements.deleteMemoryEmbeddings.run(mapped.context_row_id);
        statements.deleteMemory.run(mapped.context_row_id);
        return;
    }

    const storedLive = statements.liveMemorySnapshot.get(moduleProject, feed.module_row_id) as
        | { full_row_snapshot?: string | null }
        | undefined;
    const snapshotJson =
        !isCompleteMemorySnapshot(row) && storedLive?.full_row_snapshot
            ? storedLive.full_row_snapshot
            : JSON.stringify(row);
    statements.upsertLiveMemory.run(
        moduleProject,
        feed.module_row_id,
        rowString(row, "category", "CONSTRAINTS"),
        rowString(row, "normalized_hash"),
        snapshotJson,
    );
    const metadataClobberRisk =
        (hasSnapshotField(row, "source_type") && rowNullableString(row, "source_type") === null) ||
        (hasSnapshotField(row, "importance") &&
            !(typeof row.importance === "number" && Number.isFinite(row.importance)));
    if (metadataClobberRisk) statements.markRepairPending.run(Date.now());
    const contextId = contextMemoryId(
        db,
        feed.domain,
        moduleProject,
        row,
        feed.module_row_id,
        statements,
    );
    const existing = statements.memoryById.get(contextId) as
        | {
              project_path?: string;
              category?: string;
              content?: string;
              normalized_hash?: string;
              importance?: number | null;
              scope?: string;
              shareable?: number;
              source_session_id?: string | null;
              source_type?: string | null;
              seen_count?: number;
              retrieval_count?: number;
              first_seen_at?: number;
              created_at?: number;
              updated_at?: number;
              last_seen_at?: number;
              last_retrieved_at?: number | null;
              status?: string;
              expires_at?: number | null;
              verification_status?: string;
              verified_at?: number | null;
              classified_at?: number | null;
              superseded_by_memory_id?: number | null;
              merged_from?: string | null;
              metadata_json?: string | null;
              mural_cue?: string | null;
              mural_cue_hash?: string | null;
              mural_cue_at?: number | null;
              mural_cue_rejection_count?: number | null;
          }
        | undefined;
    if (existing && existing.project_path !== moduleProject) {
        // Mirror identities identify rows but never authorize moving ownership between projects;
        // keep the durable row untouched when stale or corrupt metadata points across that boundary.
        log(
            `[magic-context] skipping memory mirror update for module ${moduleProject}/${feed.module_row_id}: context row ${contextId} belongs to ${existing.project_path}`,
        );
        return;
    }
    const has = (key: string): boolean => hasSnapshotField(row, key);
    const nullableNumber = (key: string, previous: number | null | undefined): number | null =>
        has(key)
            ? typeof row[key] === "number" && Number.isFinite(row[key])
                ? row[key]
                : null
            : (previous ?? null);
    const nullableString = (key: string, previous: string | null | undefined): string | null =>
        has(key) ? rowNullableString(row, key) : (previous ?? null);
    const hasSuperseded = has("superseded_by_memory_id");
    const previousHash = existing?.normalized_hash;

    // A feed update is allowed to be a sparse legacy snapshot. An absent property means
    // "unchanged"; only a property explicitly present as null is a genuine clear.
    statements.updateMemory.run(
        has("project_path")
            ? rowString(row, "project_path")
            : (existing?.project_path ?? moduleProject),
        has("category")
            ? rowString(row, "category", "CONSTRAINTS")
            : (existing?.category ?? "CONSTRAINTS"),
        has("content") ? rowString(row, "content") : (existing?.content ?? ""),
        has("normalized_hash")
            ? rowString(row, "normalized_hash")
            : (existing?.normalized_hash ?? ""),
        has("importance")
            ? typeof row.importance === "number" && Number.isFinite(row.importance)
                ? row.importance
                : null
            : (existing?.importance ?? null),
        has("scope") ? rowString(row, "scope", "project") : (existing?.scope ?? "project"),
        has("shareable") ? rowNumber(row, "shareable") : (existing?.shareable ?? 0),
        nullableString("source_session_id", existing?.source_session_id),
        nullableString("source_type", existing?.source_type),
        has("seen_count") ? rowNumber(row, "seen_count", 1) : (existing?.seen_count ?? 1),
        has("retrieval_count")
            ? rowNumber(row, "retrieval_count")
            : (existing?.retrieval_count ?? 0),
        has("first_seen_at") ? rowNumber(row, "first_seen_at") : (existing?.first_seen_at ?? 0),
        has("created_at") ? rowNumber(row, "created_at") : (existing?.created_at ?? 0),
        has("updated_at") ? rowNumber(row, "updated_at") : (existing?.updated_at ?? 0),
        has("last_seen_at") ? rowNumber(row, "last_seen_at") : (existing?.last_seen_at ?? 0),
        nullableNumber("last_retrieved_at", existing?.last_retrieved_at),
        has("status") ? rowString(row, "status", "active") : (existing?.status ?? "active"),
        nullableNumber("expires_at", existing?.expires_at),
        has("verification_status")
            ? rowString(row, "verification_status", "unverified")
            : (existing?.verification_status ?? "unverified"),
        nullableNumber("verified_at", existing?.verified_at),
        nullableNumber("classified_at", existing?.classified_at),
        hasSuperseded ? null : (existing?.superseded_by_memory_id ?? null),
        nullableString("merged_from", existing?.merged_from),
        nullableString("metadata_json", existing?.metadata_json),
        nullableString("mural_cue", existing?.mural_cue),
        nullableString("mural_cue_hash", existing?.mural_cue_hash),
        nullableNumber("mural_cue_at", existing?.mural_cue_at),
        has("mural_cue_rejection_count")
            ? rowNumber(row, "mural_cue_rejection_count")
            : (existing?.mural_cue_rejection_count ?? 0),
        contextId,
    );
    if (hasSuperseded && typeof row.superseded_by_memory_id === "number") {
        const translated = mirrorIdentity(
            db,
            "memories",
            moduleProject,
            row.superseded_by_memory_id,
            statements,
        );
        if (translated) {
            statements.updateSuperseded.run(translated.context_row_id, Date.now(), contextId);
            statements.deletePendingReference.run(moduleProject, feed.module_row_id);
        } else {
            statements.upsertPendingReference.run(
                moduleProject,
                feed.module_row_id,
                row.superseded_by_memory_id,
            );
        }
    } else if (hasSuperseded) {
        statements.deletePendingReference.run(moduleProject, feed.module_row_id);
    }
    const appliedHash = has("normalized_hash") ? rowString(row, "normalized_hash") : previousHash;
    if (previousHash !== appliedHash && appliedHash !== undefined) {
        statements.deleteMemoryEmbeddings.run(contextId);
    }
    // Mapping snapshots replace the whole side table. An array is a durable mapping (an empty
    // array is the file-independent sentinel); null is a mapping tombstone and leaves no rows.
    if (has("mapping")) {
        statements.deleteMemoryVerifications.run(contextId);
        if (Array.isArray(row.mapping)) {
            const files = [
                ...new Set(
                    row.mapping.filter((file): file is string => typeof file === "string").sort(),
                ),
            ];
            const verifiedAt = rowNumber(row, "verified_at");
            const mappedAt = rowNumber(row, "updated_at", Date.now());
            const mappingOrigin =
                row.mapping_origin === "host_rejected_fallback"
                    ? "host_rejected_fallback"
                    : "mapper";
            for (const file of files.length > 0 ? files : [""]) {
                statements.insertMemoryVerification.run(
                    contextId,
                    file,
                    verifiedAt,
                    mappedAt,
                    mappingOrigin,
                );
            }
        }
    }
}

function repairNullClobberedMemoryRows(statements: MirrorPageStatements): void {
    const pending = statements.repairPending.get() as { dirty?: number } | undefined;
    if (pending?.dirty !== 1) return;
    const candidates = statements.repairCandidates.all() as Array<{
        id: number;
        full_row_snapshot?: string | null;
    }>;
    for (const candidate of candidates) {
        if (!candidate.full_row_snapshot) continue;
        let snapshot: Record<string, unknown>;
        try {
            const parsed: unknown = JSON.parse(candidate.full_row_snapshot);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
            snapshot = parsed as Record<string, unknown>;
        } catch {
            continue;
        }
        const sourceType =
            hasSnapshotField(snapshot, "source_type") && typeof snapshot.source_type === "string"
                ? snapshot.source_type
                : null;
        const importance =
            hasSnapshotField(snapshot, "importance") &&
            typeof snapshot.importance === "number" &&
            Number.isFinite(snapshot.importance)
                ? snapshot.importance
                : null;
        if (sourceType === null && importance === null) continue;
        // This idempotent repair handles stores where sparse mapping records overwrote
        // source_type and importance with null before the mirror retained full snapshots.
        statements.repairMemory.run(sourceType, importance, Date.now(), candidate.id);
    }
    // The candidate query is an intentional full pass only while dirty. Clearing the flag
    // makes subsequent mirror pages avoid the unindexed scan entirely.
    statements.clearRepairPending.run(Date.now());
}

function contextNoteId(
    db: Database,
    feed: ChangefeedRow,
    moduleProject: string,
    statements?: MirrorPageStatements,
): number {
    const mapped = mirrorIdentity(db, feed.domain, moduleProject, feed.module_row_id, statements);
    if (mapped) return mapped.context_row_id;
    const row = feed.full_row_snapshot;
    const sourceId = rowNumber(row, "context_row_id", -1);
    const sourceUuid = rowNullableString(row, "context_store_uuid");
    const localStoreUuid = statements?.contextStoreUuid ?? getContextStoreUuid(db);
    if (sourceUuid && sourceUuid === localStoreUuid && sourceId >= 0) {
        const existing = (
            statements?.noteIdByStoreId ??
            db.prepare("SELECT id FROM notes WHERE id = ? AND type = 'smart' AND project_path = ?")
        ).get(sourceId, moduleProject) as { id?: number } | undefined;
        if (existing?.id !== undefined) {
            rememberIdentity(
                db,
                feed.domain,
                moduleProject,
                feed.module_row_id,
                existing.id,
                statements,
            );
            return existing.id;
        }
    }
    const result = (
        statements?.insertNote ??
        db.prepare(
            "INSERT INTO notes (type, status, content, project_path, session_id, created_at, updated_at) VALUES ('smart', 'active', '', ?, ?, 0, 0)",
        )
    ).run(moduleProject, rowNullableString(row, "session_id"));
    const contextId = Number(result.lastInsertRowid);
    rememberIdentity(db, feed.domain, moduleProject, feed.module_row_id, contextId, statements);
    return contextId;
}

function translateMemoryReferences(statements: MirrorPageStatements): void {
    statements.translateMemoryReferences.run(Date.now());
    statements.clearTranslatedReferences.run();
}

function resolvePendingMemoryReferencesForDrain(db: Database): void {
    withPrivilegedWriter(db, () => {
        db.transaction(() => {
            const statements = prepareMirrorPageStatements(db);
            // While queued mirror updates are being drained, mirroring is paused. Leave
            // targets that still lack an identity in the durable pending-reference table,
            // and resolve references whose target identity is now available before the
            // TypeScript implementation regains control of memory writes.
            translateMemoryReferences(statements);
        }).immediate();
    });
}

function applyNoteRow(db: Database, feed: ChangefeedRow, statements: MirrorPageStatements): void {
    const row = feed.full_row_snapshot;
    const moduleProject = rowString(row, "project_path");
    if (!moduleProject) throw new Error("note feed snapshot has no project_path");
    if (feed.op === "tombstone") {
        const mapped = mirrorIdentity(
            db,
            feed.domain,
            moduleProject,
            feed.module_row_id,
            statements,
        );
        if (!mapped) return;
        statements.deleteNote.run(mapped.context_row_id);
        statements.deleteIdentity.run(feed.domain, moduleProject, feed.module_row_id);
        statements.deleteNoteRevisions.run(moduleProject, feed.module_row_id);
        return;
    }
    const contextId = contextNoteId(db, feed, moduleProject, statements);
    const existing = statements.noteById.get(contextId) as Record<string, unknown> | undefined;
    // Historical v23 feed rows contain only the small note surface. Preserve every
    // rich TS-owned column that is absent from such a snapshot, while still honoring
    // explicit nulls in current complete rows.
    const effectiveRow: Record<string, unknown> = { ...(existing ?? {}), ...row };
    if (!hasSnapshotField(row, "created_at_ms") && existing?.created_at !== undefined) {
        effectiveRow.created_at_ms = existing.created_at;
    }
    if (!hasSnapshotField(row, "updated_at_ms") && existing?.updated_at !== undefined) {
        effectiveRow.updated_at_ms = existing.updated_at;
    }
    // Delivery-only module states are collapsed to the TS vocabulary. The ledger remains
    // authoritative for at-least-once delivery; context.db must not invent a new status.
    const moduleStatus = rowString(effectiveRow, "status", "active");
    const contextStatus =
        moduleStatus === "surfaced" || moduleStatus === "surfacing" ? "ready" : moduleStatus;
    statements.updateNote.run(
        rowString(effectiveRow, "type", "smart"),
        contextStatus,
        moduleProject,
        rowNullableString(effectiveRow, "session_id"),
        rowString(effectiveRow, "content"),
        rowNullableString(effectiveRow, "surface_condition"),
        rowNullableString(effectiveRow, "compiled_provider"),
        rowNullableString(effectiveRow, "compiled_config"),
        typeof effectiveRow.compiled_at === "number" ? effectiveRow.compiled_at : null,
        rowNullableString(effectiveRow, "compile_status"),
        typeof effectiveRow.ready_at === "number" ? effectiveRow.ready_at : null,
        rowNullableString(effectiveRow, "ready_reason"),
        rowNullableString(effectiveRow, "manifest_json"),
        rowNullableString(effectiveRow, "compiled_check"),
        rowNullableString(effectiveRow, "check_hash"),
        rowNullableString(effectiveRow, "check_cron"),
        rowNumber(effectiveRow, "check_failure_count"),
        rowNumber(effectiveRow, "check_network_failure_count"),
        typeof effectiveRow.check_quarantined_until === "number"
            ? effectiveRow.check_quarantined_until
            : null,
        typeof effectiveRow.check_next_due_at === "number" ? effectiveRow.check_next_due_at : null,
        typeof effectiveRow.check_compiled_at === "number" ? effectiveRow.check_compiled_at : null,
        typeof effectiveRow.check_false_since_at === "number"
            ? effectiveRow.check_false_since_at
            : null,
        typeof effectiveRow.check_last_liveness_at === "number"
            ? effectiveRow.check_last_liveness_at
            : null,
        typeof effectiveRow.last_checked_at === "number" ? effectiveRow.last_checked_at : null,
        rowString(effectiveRow, "check_status", "uncompiled"),
        rowNumber(effectiveRow, "check_version"),
        rowNumber(effectiveRow, "policy_version", 1),
        rowNullableString(effectiveRow, "anchor_block_id"),
        typeof effectiveRow.anchor_ordinal === "number" ? effectiveRow.anchor_ordinal : null,
        rowNumber(effectiveRow, "created_at_ms"),
        rowNumber(effectiveRow, "updated_at_ms"),
        contextId,
    );
    statements.upsertNoteRevision.run(
        moduleProject,
        feed.module_row_id,
        contextId,
        rowNumber(effectiveRow, "status_version"),
    );
}

export function applyMirrorPage(args: { db: Database; page: ChangefeedPage }): number {
    const { db, page } = args;
    if (!AUTHORITY_DOMAINS.includes(page.domain)) throw new Error("unknown mirror domain");
    const durableCursor = getMirrorCursor(db, page.domain);
    if (page.cursor !== durableCursor) {
        throw new Error(
            `mirror cursor mismatch for ${page.domain}: expected ${durableCursor}, got ${page.cursor}`,
        );
    }
    if (page.next_cursor < durableCursor) {
        throw new Error("mirror page moved its cursor backwards");
    }

    const resnapshotState = page.domain === "memories" ? memoryResnapshotState(db) : null;
    const hasNewRows = page.rows.some(
        (feed) => feed.domain === page.domain && feed.feed_seq > durableCursor,
    );
    // When replaying memories from cursor 0, this transaction must perform the
    // resnapshot state compare-and-swap. While a resnapshot is pending, it must also
    // prevent tombstones from being applied prematurely. Other pages with no new rows
    // do not change any invariants.
    const replayMustRun =
        page.domain === "memories" &&
        resnapshotState !== null &&
        resnapshotState.status !== "complete" &&
        (durableCursor === 0 || page.rows.some((feed) => feed.op === "tombstone"));
    if (!hasNewRows && !replayMustRun) {
        if (page.next_cursor <= durableCursor) return durableCursor;
        withPrivilegedWriter(db, () => {
            db.prepare(
                "INSERT INTO mirror_cursors(domain, cursor, updated_at) VALUES (?, ?, ?) ON CONFLICT(domain) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at",
            ).run(page.domain, page.next_cursor, Date.now());
        });
        return page.next_cursor;
    }

    let nextCursor = durableCursor;
    withPrivilegedWriter(db, () => {
        db.transaction(() => {
            ensureMemoryRepairState(db);
            const statements = prepareMirrorPageStatements(db);
            const currentResnapshotState =
                page.domain === "memories" ? memoryResnapshotState(db) : null;
            let resnapshotStatus =
                page.domain === "memories" ? (currentResnapshotState?.status ?? null) : "complete";
            if (
                page.domain === "memories" &&
                durableCursor === 0 &&
                currentResnapshotState &&
                resnapshotStatus !== "complete"
            ) {
                // A cursor-zero replay observes every insert before its tombstone, so it is
                // equivalent to a live resnapshot and may safely enable destructive cleanup.
                statements.markRepairPending.run(Date.now());
                if (
                    !casMemoryResnapshotState(
                        db,
                        currentResnapshotState,
                        "complete",
                        currentResnapshotState.generation,
                    )
                ) {
                    throw new Error("memory mirror resnapshot ownership changed during replay");
                }
                resnapshotStatus = "complete";
            }
            if (
                page.domain === "memories" &&
                resnapshotStatus !== "complete" &&
                page.rows.some((feed) => feed.op === "tombstone")
            ) {
                // Upgrade cursors can start after a canonical insert. Never delete through a
                // tombstone until the module's current live identities have been captured.
                throw new Error("memory mirror resnapshot must complete before tombstones");
            }
            const touchedProjects = new Set<string>();
            for (const feed of page.rows) {
                if (feed.domain !== page.domain || feed.feed_seq <= nextCursor) continue;
                const projectPath = rowString(feed.full_row_snapshot, "project_path");
                if (projectPath) touchedProjects.add(projectPath);
                if (feed.domain === "memories") applyMemoryRow(db, feed, statements);
                else applyNoteRow(db, feed, statements);
                nextCursor = feed.feed_seq;
            }
            if (page.domain === "memories") {
                translateMemoryReferences(statements);
                repairNullClobberedMemoryRows(statements);
            }
            for (const projectPath of touchedProjects) {
                bumpDomainMutationEpoch(db, projectPath, page.domain);
            }
            if (page.next_cursor < nextCursor) {
                throw new Error("mirror page moved its cursor backwards");
            }
            nextCursor = Math.max(nextCursor, page.next_cursor);
            statements.updateCursor.run(page.domain, nextCursor, Date.now());
        }).immediate();
    });
    return nextCursor;
}

export async function ensureLiveMemoryResnapshot(args: {
    db: Database;
    module: AuthorityModuleClient;
    limit: number;
}): Promise<void> {
    let adoptedWinner = false;
    let generation: string;
    while (true) {
        const observed = memoryResnapshotState(args.db);
        if (!observed || observed.status === "complete") return;
        if (observed.status === "resnapshotting") {
            // A resnapshot retains complete source rows used by the one-shot metadata heal.
            withPrivilegedWriter(args.db, () => markMemoryRepairPending(args.db));
        }
        if (observed.status === "pending_check" && !upgradeMemoryMirrorNeedsResnapshot(args.db)) {
            let completed = false;
            withPrivilegedWriter(args.db, () => {
                args.db
                    .transaction(() => {
                        // The mirror migration can leave source metadata incomplete,
                        // while a non-complete resnapshot means the complete source rows
                        // needed to repair it may still be available. Mark a metadata-
                        // healing pass for the next mirror page before completing the
                        // resnapshot.
                        markMemoryRepairPending(args.db);
                        completed = casMemoryResnapshotState(
                            args.db,
                            observed,
                            "complete",
                            observed.generation,
                        );
                        if (completed) {
                            args.db
                                .prepare(
                                    "DELETE FROM mirror_live_staging WHERE generation IS NOT ?",
                                )
                                .run(observed.generation);
                        }
                    })
                    .immediate();
            });
            if (completed) return;
            // A sibling may have started a resnapshot between the check and this CAS. Re-read
            // below and adopt its generation instead of turning a recoverable race into a pull
            // failure.
            continue;
        }
        if (!args.module.mirrorPull) {
            throw new Error("memory mirror resnapshot requires the mirror.pull module route");
        }

        const now = Date.now();
        generation = `${now.toString(36)}:${crypto.randomUUID()}`;
        let claimed = false;
        withPrivilegedWriter(args.db, () => {
            args.db
                .transaction(() => {
                    // A stale resnapshot owner is safe to replace because the CAS fences every
                    // page and install from the abandoned generation. The same CAS also lets a
                    // concurrently-starting caller win deterministically.
                    claimed = casMemoryResnapshotState(
                        args.db,
                        observed,
                        "resnapshotting",
                        generation,
                    );
                    if (claimed) {
                        markMemoryRepairPending(args.db);
                        args.db
                            .prepare("DELETE FROM mirror_live_staging WHERE generation != ?")
                            .run(generation);
                    }
                })
                .immediate();
        });
        if (claimed) break;

        // CAS loss is expected when another process begins the resnapshot first. Re-read once
        // and adopt that winner's generation; do not report a hard pull error for the race.
        const winner = memoryResnapshotState(args.db);
        if (
            !adoptedWinner &&
            winner?.status === "resnapshotting" &&
            typeof winner.generation === "string" &&
            winner.generation.length > 0
        ) {
            generation = winner.generation;
            adoptedWinner = true;
            break;
        }
    }

    let cursor = 0;
    while (true) {
        const response = await args.module.mirrorPull({
            domain: "memories",
            cursor,
            limit: args.limit,
            live_only: true,
        });
        const page = response.page;
        if (page.domain !== "memories" || page.cursor !== cursor) {
            throw new Error("live memory resnapshot returned a mismatched page");
        }
        let staged = false;
        withPrivilegedWriter(args.db, () => {
            args.db
                .transaction(() => {
                    staged = stageLiveMemorySnapshotPage(args.db, generation, page.rows);
                })
                .immediate();
        });
        if (!staged) return;
        if (!page.has_more) break;
        if (page.next_cursor <= cursor) {
            throw new Error("live memory resnapshot did not advance its cursor");
        }
        cursor = page.next_cursor;
    }

    withPrivilegedWriter(args.db, () => {
        args.db
            .transaction(() => {
                installStagedLiveMemorySnapshot(args.db, generation);
            })
            .immediate();
    });
}

export async function pullAndApplyMirrorPage(args: {
    db: Database;
    module: AuthorityModuleClient;
    domain: AuthorityDomain;
    limit?: number;
}): Promise<number> {
    if (!args.module.mirrorPull) {
        throw new Error("memory mirror consumer requires the mirror.pull module route");
    }
    const limit = Math.max(1, Math.min(args.limit ?? 100, 1000));
    if (args.domain === "memories") {
        await ensureLiveMemoryResnapshot({ db: args.db, module: args.module, limit });
    }
    const cursor = getMirrorCursor(args.db, args.domain);
    const response = await args.module.mirrorPull({
        domain: args.domain,
        cursor,
        limit,
    });
    return applyMirrorPage({ db: args.db, page: response.page });
}

const mirrorFlights = new WeakMap<object, Promise<number>>();

/**
 * The rust transform pass is the mirror cadence. Coalesce overlapping passes so a
 * slower pull can never race a second cursor application on the same connection.
 */
export function pullMemoryMirrorOnce(args: {
    db: Database;
    module: AuthorityModuleClient;
    limit?: number;
}): Promise<number> {
    const existing = mirrorFlights.get(args.module);
    if (existing) return existing;
    const flight = pullAndApplyMirrorPage({
        db: args.db,
        module: args.module,
        domain: "memories",
        limit: args.limit,
    }).finally(() => mirrorFlights.delete(args.module));
    mirrorFlights.set(args.module, flight);
    return flight;
}
