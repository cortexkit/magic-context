/**
 * Conditional `opencode`/`opencode2` harness relabel driven by host-store evidence
 * (migration v87).
 *
 * Background. Migration v85 rewrote EVERY `opencode2` row to `opencode` on the
 * premise that no released Magic Context had ever run on a real OpenCode 2 host,
 * so every such row had to be the OpenCode 1.x mislabel (ungated `setup()` locked
 * the harness to "opencode2" on a 1.18.x seat). That premise held for most
 * installs and was wrong for early adopters: a store written by a genuine
 * OpenCode 2 host had its rows relabelled, the 2 host kept writing `opencode2`,
 * and every tag and session row it had already written became invisible to it
 * (issue #475: 2,788 tags and 32 session_meta rows).
 *
 * What this does instead. The label is decided PER SESSION from the OpenCode
 * store itself — the same store the runtime reads — and only when that store
 * answers. The rule is "whoever wrote the session most recently owns the label":
 *
 *   newest 2.x activity  > newest 1.x activity → `opencode2`
 *   newest 1.x activity  > newest 2.x activity → `opencode`
 *   equal, or the session is in neither generation's tables → leave unchanged
 *
 * 2.x activity is read from `session_message`/`session_v2` and counted only when
 * `session_v2` exists: a 1.18.x store ships an (empty) `session_message` table
 * too, so `session_v2` is the table that proves a 2.x host has touched the store
 * (PR #477). 1.x activity is read from `message.time_updated` and, for sessions
 * with no messages, the `session.time_updated` row the host maintains.
 *
 * The equal case is not a theoretical tie. When an OpenCode 2 host migrates a
 * 1.18.x store it copies each `session` row into `session_v2` with
 * `time_created`/`time_updated` PRESERVED and moves no messages (observed with
 * the real 1.18.30 and 2.0.5 binaries; pinned in
 * `__fixtures__/opencode-store-shapes.json`). A migrated-but-never-used session
 * therefore reports the same timestamp on both sides, which is exactly "no
 * evidence of who wrote last" — so the stored label stands. Once either host
 * writes again, its side becomes strictly newer and wins, which is what makes a
 * downgraded store (2.x migrated, then 1.x used again) resolve to `opencode`.
 *
 * When the store cannot be resolved or read, NOTHING is relabelled: the affected
 * session ids are recorded in `schema_migrations_meta` so `magic-context doctor`
 * can report the unresolved repair, and the situation is logged once.
 */

import { log } from "../../shared/logger";
import {
    getOpenCodeDbProbeDescriptions,
    type OpenCodeDbPathResolution,
    openCodeDbPathExists,
    resolveOpenCodeDbPath,
} from "../../shared/opencode-db-path";
import { Database } from "../../shared/sqlite";

/** The two harness labels this repair moves rows between. */
export type RelabelHarness = "opencode" | "opencode2";

/** `schema_migrations_meta` key holding the unresolved-repair report for doctor. */
export const OPENCODE2_RELABEL_STATE_KEY = "v87_opencode2_relabel";

/**
 * Independent rows whose harness twin cannot simply be relabelled: their PRIMARY KEY or
 * UNIQUE key contains `harness`, so the same natural key can hold one row per
 * label. v85 resolved these by keeping the newer row; v87 applies the SAME rule
 * in whichever direction the session resolves, with a tie keeping the row that
 * already carries the resolved label.
 *
 * `tags` is deliberately absent: its UNIQUE key is (session_id, tag_number) and
 * does not mention harness, so relabelling can never collide there. Duplicate
 * tag rows for one message are left alone on purpose — the tagger binds a
 * duplicate composite key to the LOWEST tag_number row it finds
 * (`storage-tags.ts`: `SELECT tag_number FROM tags WHERE session_id = ? AND
 * message_id = ? ORDER BY tag_number ASC LIMIT 1`, and the matching
 * `ORDER BY tag_number ASC` lookup for tool owners) and never deletes the newer
 * one, so neither does this repair.
 */
export const V87_HARNESS_TWIN_RULES: ReadonlyArray<{
    table: string;
    /** Natural-key columns other than `harness`. */
    keyColumns: readonly string[];
    /** True when the incoming (being relabelled) row is newer than the existing one. */
    incomingIsNewer: string;
}> = [
    {
        table: "session_projects",
        keyColumns: ["session_id"],
        incomingIsNewer: "incoming.updated_at > existing.updated_at",
    },
    {
        table: "primer_candidates",
        keyColumns: [
            "project_path",
            "session_id",
            "source_start_message_id",
            "source_end_message_id",
        ],
        incomingIsNewer: "incoming.created_at > existing.created_at",
    },
    {
        table: "transform_decisions",
        keyColumns: ["session_id", "message_id"],
        incomingIsNewer: "incoming.ts_ms > existing.ts_ms",
    },
];

/**
 * These tables form one runner record per (session_id, harness), including all
 * lineages. Entries, ids, views and state share ordinals and fences, so choosing
 * newer rows independently could splice incompatible records together.
 *
 * Any row in the group counts as a record, even if its state row is missing. If
 * both labels have a record, keep the resolved label's record unchanged and
 * discard every row under the other label. The discarded record is rebuildable
 * from the host store; report it as one declared prefix rebuild, not one per table.
 */
export const V87_HARNESS_AGGREGATE_RULES: ReadonlyArray<{
    record: "host_runner" | "memory_applied";
    tables: readonly string[];
}> = [
    {
        record: "host_runner",
        tables: [
            "host_runner_entries",
            "host_runner_ids",
            "host_runner_views",
            "host_runner_state",
        ],
    },
    {
        record: "memory_applied",
        tables: ["memory_applied_snapshots", "memory_applied_rows"],
    },
];

export interface OpenCode2RelabelReport {
    /**
     * `no_candidates` — nothing in this database carries an opencode/opencode2 label.
     * `resolved` — the host store answered; see `relabelledSessions`.
     * `unresolved` — no readable host store, so nothing was changed.
     */
    status: "no_candidates" | "resolved" | "unresolved";
    reason?: "store_not_found" | "store_unreadable" | "store_schema_unknown";
    storePath: string | null;
    /** Sessions carrying an opencode/opencode2 label when the repair ran. */
    candidateSessionIds: string[];
    /** Sessions whose rows moved, with the label they moved to. */
    relabelledSessions: Array<{ sessionId: string; harness: RelabelHarness }>;
    /** One declared prefix rebuild per discarded host-runner twin, not per table or row. */
    discardedRunnerRecords: string[];
}

/** The unresolved report doctor reads back out of `schema_migrations_meta`. */
export interface UnresolvedOpenCode2Relabel {
    reason: string;
    /** Where the store was looked for when the repair ran. */
    lookedFor: string;
    sessionIds: string[];
    recordedAt: number;
}

interface HarnessTableShape {
    table: string;
    hasSessionId: boolean;
}

export interface EvidenceStore {
    newestV1Activity(sessionId: string): number | null;
    newestV2Activity(sessionId: string): number | null;
}

interface OpenEvidenceStore extends EvidenceStore {
    close(): void;
}

type MinimalDb = Pick<Database, "prepare" | "exec">;

function tableExists(db: MinimalDb, name: string): boolean {
    return Boolean(
        db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name),
    );
}

function columnNames(db: MinimalDb, table: string): Set<string> {
    return new Set(
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
            (column) => column.name,
        ),
    );
}

/**
 * The v85 tables present in THIS database that carry a harness label, split by
 * whether the label belongs to a session. Tables keyed by harness alone
 * (`message_history_orphan_sweep`, `session_project_backfill_state`) are
 * per-harness cursors, not session state: no session evidence can speak for
 * them, so this repair leaves them where they are rather than guessing.
 */
export function listSessionScopedHarnessTables(
    db: MinimalDb,
    tables: readonly string[],
): HarnessTableShape[] {
    const shapes: HarnessTableShape[] = [];
    for (const table of tables) {
        if (!tableExists(db, table)) continue;
        const columns = columnNames(db, table);
        if (!columns.has("harness")) continue;
        shapes.push({ table, hasSessionId: columns.has("session_id") });
    }
    return shapes;
}

function collectCandidateSessions(db: MinimalDb, shapes: readonly HarnessTableShape[]): string[] {
    const sessions = new Set<string>();
    for (const shape of shapes) {
        if (!shape.hasSessionId) continue;
        const rows = db
            .prepare(
                `SELECT DISTINCT session_id AS id FROM ${shape.table}
                  WHERE session_id IS NOT NULL AND harness IN ('opencode', 'opencode2')`,
            )
            .all() as Array<{ id: string }>;
        for (const row of rows) sessions.add(row.id);
    }
    return [...sessions].sort();
}

/**
 * Open the OpenCode store READ-ONLY and expose the two "who wrote this session
 * last" questions. Returns null when the file exists but carries neither
 * generation's tables — a host that has not written its schema yet answers
 * nothing, and a silent "no activity" there would look like evidence.
 */
function openEvidenceStore(path: string): OpenEvidenceStore | null {
    const store = new Database(path, { readonly: true, fileMustExist: true });
    try {
        const hasV1Messages = tableExists(store, "message");
        const hasV1Session = tableExists(store, "session");
        // `session_v2` is the table only an OpenCode 2 host writes; without it,
        // `session_message` rows cannot be 2.x evidence (1.18.x ships the table).
        const hasV2 = tableExists(store, "session_v2");
        const hasV2Messages = hasV2 && tableExists(store, "session_message");
        if (!hasV1Messages && !hasV1Session && !hasV2) {
            store.close();
            return null;
        }

        const v1Message = hasV1Messages
            ? store.prepare("SELECT MAX(time_updated) AS newest FROM message WHERE session_id = ?")
            : null;
        const v1Session = hasV1Session
            ? store.prepare("SELECT time_updated AS newest FROM session WHERE id = ?")
            : null;
        const v2Message = hasV2Messages
            ? store.prepare(
                  "SELECT MAX(time_updated) AS newest FROM session_message WHERE session_id = ?",
              )
            : null;
        const v2Session = hasV2
            ? store.prepare("SELECT time_updated AS newest FROM session_v2 WHERE id = ?")
            : null;

        const newest = (
            statements: Array<{ get(id: string): unknown } | null>,
            sessionId: string,
        ): number | null => {
            let best: number | null = null;
            for (const statement of statements) {
                if (!statement) continue;
                const row = statement.get(sessionId) as { newest?: unknown } | null;
                const value = row?.newest;
                if (typeof value !== "number") continue;
                if (best === null || value > best) best = value;
            }
            return best;
        };

        return {
            newestV1Activity: (sessionId) => newest([v1Message, v1Session], sessionId),
            newestV2Activity: (sessionId) => newest([v2Message, v2Session], sessionId),
            close: () => store.close(),
        };
    } catch (error) {
        store.close();
        throw error;
    }
}

/** Decide one session's label from the store evidence. `null` means "no evidence". */
export function resolveHarnessFromEvidence(
    evidence: EvidenceStore,
    sessionId: string,
): RelabelHarness | null {
    const v1 = evidence.newestV1Activity(sessionId);
    const v2 = evidence.newestV2Activity(sessionId);
    if (v1 === null && v2 === null) return null;
    if (v2 !== null && (v1 === null || v2 > v1)) return "opencode2";
    if (v1 !== null && (v2 === null || v1 > v2)) return "opencode";
    return null;
}

interface TwinResolver {
    /** Drop whichever of the two rows for one session's natural key is older. */
    run(sessionId: string, target: RelabelHarness, source: RelabelHarness): void;
}

/**
 * Prepare the twin resolution for one table. `incoming` is the row about to be
 * relabelled, `existing` the row that already carries the resolved label; the
 * older of the pair is deleted so the surviving row can take the label without
 * colliding on a key that contains `harness`. A tie keeps the existing row — the
 * same preference v85 applied when it kept the already-correct `opencode` row.
 */
function prepareTwinResolver(
    db: MinimalDb,
    table: string,
    keyColumns: readonly string[],
    incomingIsNewer: string,
): TwinResolver {
    const joinOn = keyColumns
        .map((column) => `incoming.${column} = existing.${column}`)
        .join(" AND ");
    const dropIncoming = db.prepare(
        `DELETE FROM ${table} WHERE rowid IN (
             SELECT incoming.rowid FROM ${table} AS incoming
             JOIN ${table} AS existing ON ${joinOn} AND existing.harness = ?
             WHERE incoming.session_id = ? AND incoming.harness = ?
               AND NOT (${incomingIsNewer})
         )`,
    );
    const dropExisting = db.prepare(
        `DELETE FROM ${table} WHERE rowid IN (
             SELECT existing.rowid FROM ${table} AS existing
             JOIN ${table} AS incoming ON ${joinOn} AND incoming.harness = ?
             WHERE existing.session_id = ? AND existing.harness = ?
               AND (${incomingIsNewer})
         )`,
    );
    return {
        run(sessionId, target, source) {
            dropIncoming.run(target, sessionId, source);
            dropExisting.run(source, sessionId, target);
        },
    };
}

function prepareAggregateResolver(db: MinimalDb, tables: readonly string[]) {
    const records = tables.map((table) => ({
        exists: db.prepare(`SELECT 1 FROM ${table} WHERE session_id = ? AND harness = ? LIMIT 1`),
        drop: db.prepare(`DELETE FROM ${table} WHERE session_id = ? AND harness = ?`),
    }));
    return {
        /** Return true only when an entire incoming twin record was discarded. */
        run(sessionId: string, target: RelabelHarness, source: RelabelHarness): boolean {
            const hasTarget = records.some(({ exists }) => Boolean(exists.get(sessionId, target)));
            const hasSource = records.some(({ exists }) => Boolean(exists.get(sessionId, source)));
            if (!hasTarget || !hasSource) return false;
            for (const { drop } of records) drop.run(sessionId, source);
            return true;
        },
    };
}

function readState(db: MinimalDb): UnresolvedOpenCode2Relabel | null {
    if (!tableExists(db, "schema_migrations_meta")) return null;
    const row = db
        .prepare("SELECT value FROM schema_migrations_meta WHERE key = ?")
        .get(OPENCODE2_RELABEL_STATE_KEY) as { value?: unknown } | null;
    if (typeof row?.value !== "string") return null;
    try {
        const parsed: unknown = JSON.parse(row.value);
        if (!parsed || typeof parsed !== "object") return null;
        const state = parsed as Partial<UnresolvedOpenCode2Relabel>;
        if (!Array.isArray(state.sessionIds)) return null;
        return {
            reason: typeof state.reason === "string" ? state.reason : "unknown",
            lookedFor: typeof state.lookedFor === "string" ? state.lookedFor : "",
            sessionIds: state.sessionIds.filter((id): id is string => typeof id === "string"),
            recordedAt: typeof state.recordedAt === "number" ? state.recordedAt : 0,
        };
    } catch {
        return null;
    }
}

/**
 * The unresolved-repair report for `magic-context doctor`, or null when the
 * repair had nothing to do or completed against a readable store.
 */
export function readUnresolvedOpenCode2Relabel(db: MinimalDb): UnresolvedOpenCode2Relabel | null {
    return readState(db);
}

export function formatUnresolvedOpenCode2RelabelDoctorLines(
    state: UnresolvedOpenCode2Relabel,
    maxSessions = 20,
): string[] {
    const shown = state.sessionIds.slice(0, maxSessions);
    const remaining = state.sessionIds.length - shown.length;
    const lines = [
        `${state.sessionIds.length} session(s) could not have their OpenCode harness label verified: ` +
            `the OpenCode session database was not readable when the repair ran (${state.reason}; looked for ${state.lookedFor}). ` +
            "Set OPENCODE_DB to the store this install writes to and report the sessions below if their tags are missing.",
    ];
    for (const sessionId of shown) lines.push(`  ${sessionId}`);
    if (remaining > 0) lines.push(`  …and ${remaining} more`);
    return lines;
}

function writeUnresolvedState(
    db: MinimalDb,
    reason: NonNullable<OpenCode2RelabelReport["reason"]>,
    resolution: OpenCodeDbPathResolution,
    sessionIds: readonly string[],
): void {
    if (!tableExists(db, "schema_migrations_meta")) return;
    const value: UnresolvedOpenCode2Relabel = {
        reason,
        lookedFor: getOpenCodeDbProbeDescriptions(resolution).join(", "),
        sessionIds: [...sessionIds],
        recordedAt: Date.now(),
    };
    db.prepare(
        `INSERT INTO schema_migrations_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(OPENCODE2_RELABEL_STATE_KEY, JSON.stringify(value));
}

function clearUnresolvedState(db: MinimalDb): void {
    if (!tableExists(db, "schema_migrations_meta")) return;
    db.prepare("DELETE FROM schema_migrations_meta WHERE key = ?").run(OPENCODE2_RELABEL_STATE_KEY);
}

export interface RepairOptions {
    /** Tables v85 relabelled; the repair covers exactly the same set. */
    tables: readonly string[];
    env?: NodeJS.ProcessEnv;
}

/**
 * Relabel each session's rows to the generation that wrote that session most
 * recently, in both directions, using the OpenCode store as the only evidence.
 * Idempotent: a second run reads the same evidence and finds nothing to move.
 */
export function repairOpenCode2HarnessLabels(
    db: Database,
    options: RepairOptions,
): OpenCode2RelabelReport {
    const shapes = listSessionScopedHarnessTables(db, options.tables);
    const candidateSessionIds = collectCandidateSessions(db, shapes);
    if (candidateSessionIds.length === 0) {
        clearUnresolvedState(db);
        return {
            status: "no_candidates",
            storePath: null,
            candidateSessionIds,
            relabelledSessions: [],
            discardedRunnerRecords: [],
        };
    }

    // The same resolver the runtime uses: OPENCODE_DB first, then the channel
    // file, then candidate discovery over opencode.db / opencode-local.db /
    // opencode-dev.db. An OpenCode 2 host writes the same opencode.db in the
    // same data directory, so one resolution covers both generations.
    const resolution = resolveOpenCodeDbPath("v1", { env: options.env });
    let evidence: OpenEvidenceStore | null = null;
    let reason: NonNullable<OpenCode2RelabelReport["reason"]> | null = null;
    if (!openCodeDbPathExists(resolution)) {
        reason = "store_not_found";
    } else {
        try {
            evidence = openEvidenceStore(resolution.path);
            if (!evidence) reason = "store_schema_unknown";
        } catch (error) {
            // A locked, corrupt or permission-denied store is still "no evidence":
            // a migration must not fail closed because the host store is busy.
            reason = "store_unreadable";
            log(
                `[migration] OpenCode session database at ${resolution.path} could not be read: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    if (!evidence || reason !== null) {
        evidence?.close();
        writeUnresolvedState(db, reason ?? "store_not_found", resolution, candidateSessionIds);
        log(
            `[migration] OpenCode harness labels left unverified for ${candidateSessionIds.length} session(s): ` +
                `no readable OpenCode session database (${reason ?? "store_not_found"}) at ${resolution.path}. ` +
                "Nothing was relabelled; `magic-context doctor` reports the affected sessions.",
        );
        return {
            status: "unresolved",
            reason: reason ?? "store_not_found",
            storePath: null,
            candidateSessionIds,
            relabelledSessions: [],
            discardedRunnerRecords: [],
        };
    }

    const relabelledSessions: OpenCode2RelabelReport["relabelledSessions"] = [];
    const discardedRunnerRecords: string[] = [];
    try {
        const updates = shapes
            .filter((shape) => shape.hasSessionId)
            .map((shape) =>
                db.prepare(
                    `UPDATE ${shape.table} SET harness = ? WHERE session_id = ? AND harness = ?`,
                ),
            );
        const presentTables = new Set(shapes.map((shape) => shape.table));
        const twinResolvers = V87_HARNESS_TWIN_RULES.filter((rule) =>
            presentTables.has(rule.table),
        ).map((rule) => prepareTwinResolver(db, rule.table, rule.keyColumns, rule.incomingIsNewer));
        const aggregateResolvers = V87_HARNESS_AGGREGATE_RULES.map((rule) =>
            prepareAggregateResolver(
                db,
                rule.tables.filter((table) => presentTables.has(table)),
            ),
        );

        for (const sessionId of candidateSessionIds) {
            const target = resolveHarnessFromEvidence(evidence, sessionId);
            if (target === null) continue;
            const source: RelabelHarness = target === "opencode" ? "opencode2" : "opencode";

            // The repair also runs outside migration replay. Keep aggregate
            // discards and all other rows for this session in one transaction.
            const { moved, discardedRunnerRecord } = db
                .transaction(() => {
                    for (const resolver of twinResolvers) resolver.run(sessionId, target, source);
                    let discardedRunnerRecord = false;
                    for (const resolver of aggregateResolvers) {
                        if (resolver.run(sessionId, target, source)) discardedRunnerRecord = true;
                    }
                    let moved = 0;
                    for (const update of updates) {
                        moved += Number(update.run(target, sessionId, source).changes ?? 0);
                    }
                    return { moved, discardedRunnerRecord };
                })
                .immediate();
            if (moved > 0) relabelledSessions.push({ sessionId, harness: target });
            if (discardedRunnerRecord) discardedRunnerRecords.push(sessionId);
        }
    } finally {
        evidence.close();
    }

    clearUnresolvedState(db);
    if (relabelledSessions.length > 0) {
        const toOpenCode2 = relabelledSessions.filter(
            (entry) => entry.harness === "opencode2",
        ).length;
        log(
            `[migration] OpenCode harness labels repaired from ${resolution.path}: ` +
                `${toOpenCode2} session(s) restored to opencode2, ` +
                `${relabelledSessions.length - toOpenCode2} session(s) set to opencode.`,
        );
    }
    if (discardedRunnerRecords.length > 0) {
        log(
            `[migration] Discarded ${discardedRunnerRecords.length} host-runner twin record(s): ` +
                `one declared prefix rebuild per session (${discardedRunnerRecords.join(", ")}).`,
        );
    }
    return {
        status: "resolved",
        storePath: resolution.path,
        candidateSessionIds,
        relabelledSessions,
        discardedRunnerRecords,
    };
}
