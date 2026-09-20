import { log } from "../../shared/logger";
import {
    assertOpenCodeStoreGeneration,
    claimOpenCodeDbDiagnosticOnce,
    clearOpenCodeDbReadFailure,
    type OpenCodeDbPathResolution,
    openCodeDbPathExists,
    recordOpenCodeDbReadFailure,
    resolveOpenCodeDbPath,
} from "../../shared/opencode-db-path";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";

interface RawCountRow {
    count?: number;
}

interface AssistantAwaitingToolsRow {
    id?: string;
    finish?: string | null;
    timeCreated?: number;
}

interface ExistenceRow {
    one?: number;
}

interface PartDataRow {
    data?: string | null;
}

interface PersistedMessageRow {
    id?: string;
    data?: string;
}

export interface LatestPersistedMessage {
    id: string;
    role: string;
    parentID?: string;
    completedAt?: number;
    error?: unknown;
}

/** Whether the resolved OpenCode session database currently exists. */
export function openCodeDbExists(): boolean {
    return openCodeDbPathExists(resolveOpenCodeDbPath());
}

let cachedReadOnlyDb: { path: string; db: Database } | null = null;

function closeCachedReadOnlyDb(): void {
    if (!cachedReadOnlyDb) {
        return;
    }

    try {
        closeQuietly(cachedReadOnlyDb.db);
    } catch (error) {
        log("[magic-context] failed to close cached OpenCode read-only DB:", error);
    } finally {
        cachedReadOnlyDb = null;
    }
}

function getReadOnlySessionDb(): Database {
    const resolution = resolveOpenCodeDbPath();
    const dbPath = resolution.path;
    if (!openCodeDbPathExists(resolution)) {
        throw new Error(
            `OpenCode session database is unavailable at ${dbPath} (source=${resolution.source})`,
        );
    }
    if (cachedReadOnlyDb?.path === dbPath) {
        return cachedReadOnlyDb.db;
    }

    closeCachedReadOnlyDb();
    const db = new Database(dbPath, { readonly: true });
    try {
        assertOpenCodeStoreGeneration(db, "v1", dbPath);
    } catch (error) {
        closeQuietly(db);
        throw error;
    }
    cachedReadOnlyDb = { path: dbPath, db };
    clearOpenCodeDbReadFailure();
    return db;
}

export function withReadOnlySessionDb<T>(fn: (db: Database) => T): T {
    return fn(getReadOnlySessionDb());
}

// Intentional: exported for tests; production relies on process-exit cleanup (same as closeDatabase)
export function closeReadOnlySessionDb(): void {
    closeCachedReadOnlyDb();
}

export function getRawSessionMessageCountFromDb(db: Database, sessionId: string): number {
    // Exclude compaction summary messages injected by magic-context.
    // These are structural markers for OpenCode's filterCompacted, not real user/assistant content.
    // Use COALESCE to handle NULL json_extract results (messages without summary/finish fields).
    const row = db
        .prepare(
            `SELECT COUNT(*) as count FROM message WHERE session_id = ?
             AND NOT (COALESCE(json_extract(data, '$.summary'), 0) = 1
                      AND COALESCE(json_extract(data, '$.finish'), '') = 'stop')`,
        )
        .get(sessionId) as RawCountRow | null;
    return typeof row?.count === "number" ? row.count : 0;
}

interface TurnStateMessage {
    info: Record<string, unknown>;
    parts: readonly unknown[];
}

interface TrackedMessage {
    id: string;
    role: string;
    timeCreated: number;
    finish?: string;
    parts: Map<string, unknown>;
}

interface TrackedSession {
    messages: Map<string, TrackedMessage>;
    sequence: number;
}

const trackedSessions = new Map<string, TrackedSession>();
const pendingParts = new Map<string, Map<string, Map<string, unknown>>>();
let probeLogObserverForTests: ((message: string) => void) | undefined;

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function truthyStoredFlag(value: unknown): boolean {
    return value === true || value === 1 || value === "true";
}

function isMachineGeneratedPart(value: unknown): boolean {
    const part = asRecord(value);
    if (!part) return false;
    const metadata = asRecord(part.metadata);
    const marker = asRecord(metadata?.marker);
    return (
        truthyStoredFlag(part.synthetic) ||
        truthyStoredFlag(part.ignored) ||
        (marker !== null && marker.kind !== null && marker.kind !== undefined)
    );
}

function messageTimeCreated(message: TurnStateMessage, fallback: number): number {
    const time = asRecord(message.info.time);
    return typeof time?.created === "number" ? time.created : fallback;
}

function latestMessageByRole(
    messages: readonly TurnStateMessage[],
    role: "assistant" | "user",
    realUserOnly = false,
): { message: TurnStateMessage; timeCreated: number } | null {
    let latest: { message: TurnStateMessage; timeCreated: number; index: number } | null = null;
    for (const [index, message] of messages.entries()) {
        if (message.info.role !== role) continue;
        if (
            realUserOnly &&
            message.parts.length > 0 &&
            message.parts.every(isMachineGeneratedPart)
        ) {
            continue;
        }
        const timeCreated = messageTimeCreated(message, index);
        if (
            latest === null ||
            timeCreated > latest.timeCreated ||
            (timeCreated === latest.timeCreated && index > latest.index)
        ) {
            latest = { message, timeCreated, index };
        }
    }
    return latest;
}

/** Return whether the latest assistant is still waiting for local tool execution. */
export function assistantAwaitingToolsFromMessages(messages: readonly TurnStateMessage[]): boolean {
    const latestAssistant = latestMessageByRole(messages, "assistant");
    if (!latestAssistant) return false;
    const assistantTime = asRecord(latestAssistant.message.info.time);
    if (typeof assistantTime?.created !== "number") return false;
    const latestRealUser = latestMessageByRole(messages, "user", true);
    if (latestRealUser && latestRealUser.timeCreated > latestAssistant.timeCreated) return false;
    if (latestAssistant.message.info.finish === "tool-calls") return true;
    return latestAssistant.message.parts.some((value) => {
        const part = asRecord(value);
        return part?.type === "tool" && part.providerExecuted !== true;
    });
}

/** Apply the notice-hold predicate to an in-memory OpenCode message array. */
export function shouldHoldIgnoredNotificationFromMessages(
    messages: readonly TurnStateMessage[],
): boolean {
    if (assistantAwaitingToolsFromMessages(messages)) return true;
    const latestAssistant = latestMessageByRole(messages, "assistant");
    if (latestAssistant) {
        const finish = latestAssistant.message.info.finish;
        if (typeof finish !== "string" || finish.length === 0) return true;
        if (finish === "tool-calls" || finish === "unknown") return true;
    }
    const latestRealUser = latestMessageByRole(messages, "user", true);
    return (
        latestRealUser !== null && latestRealUser.timeCreated > (latestAssistant?.timeCreated ?? -1)
    );
}

function trackedMessages(session: TrackedSession): TurnStateMessage[] {
    return [...session.messages.values()]
        .sort((left, right) => left.timeCreated - right.timeCreated)
        .map((message) => ({
            info: {
                id: message.id,
                role: message.role,
                time: { created: message.timeCreated },
                ...(message.finish === undefined ? {} : { finish: message.finish }),
            },
            parts: [...message.parts.values()],
        }));
}

function pendingMessageParts(sessionId: string, messageId: string): Map<string, unknown> {
    return pendingParts.get(sessionId)?.get(messageId) ?? new Map<string, unknown>();
}

/** Track OpenCode events so turn-state checks work when no message array is directly available. */
export function observeOpenCodeTurnEvent(type: string, properties: unknown): void {
    const props = asRecord(properties);
    if (!props) return;

    if (type === "message.part.updated") {
        const part = asRecord(props.part);
        if (
            !part ||
            typeof part.sessionID !== "string" ||
            typeof part.messageID !== "string" ||
            typeof part.id !== "string"
        ) {
            return;
        }
        const tracked = trackedSessions.get(part.sessionID)?.messages.get(part.messageID);
        if (tracked) {
            tracked.parts.set(part.id, part);
            return;
        }
        let byMessage = pendingParts.get(part.sessionID);
        if (!byMessage) {
            byMessage = new Map();
            pendingParts.set(part.sessionID, byMessage);
        }
        let parts = byMessage.get(part.messageID);
        if (!parts) {
            parts = new Map();
            byMessage.set(part.messageID, parts);
        }
        parts.set(part.id, part);
        return;
    }

    if (type === "message.updated") {
        const info = asRecord(props.info);
        const time = asRecord(info?.time);
        if (
            !info ||
            (info.role !== "assistant" && info.role !== "user") ||
            typeof info.sessionID !== "string" ||
            typeof info.id !== "string"
        ) {
            return;
        }
        let session = trackedSessions.get(info.sessionID);
        if (!session) {
            session = { messages: new Map(), sequence: 0 };
            trackedSessions.set(info.sessionID, session);
        }
        session.sequence += 1;
        const existing = session.messages.get(info.id);
        session.messages.set(info.id, {
            id: info.id,
            role: info.role,
            timeCreated:
                typeof time?.created === "number"
                    ? time.created
                    : (existing?.timeCreated ?? session.sequence),
            ...(typeof info.finish === "string" ? { finish: info.finish } : {}),
            parts: existing?.parts ?? pendingMessageParts(info.sessionID, info.id),
        });
        pendingParts.get(info.sessionID)?.delete(info.id);
        return;
    }

    if (type === "message.removed") {
        if (typeof props.sessionID === "string" && typeof props.messageID === "string") {
            trackedSessions.get(props.sessionID)?.messages.delete(props.messageID);
            pendingParts.get(props.sessionID)?.delete(props.messageID);
        }
        return;
    }

    if (type === "session.deleted" && typeof props.sessionID === "string") {
        clearTrackedOpenCodeSession(props.sessionID);
    }
}

export function clearTrackedOpenCodeSession(sessionId: string): void {
    trackedSessions.delete(sessionId);
    pendingParts.delete(sessionId);
}

function logProbeFailureOnce(resolution: OpenCodeDbPathResolution, error: unknown): void {
    const failure = recordOpenCodeDbReadFailure(resolution, error);
    if (!claimOpenCodeDbDiagnosticOnce("session-state-probe", resolution)) return;
    const message = `[magic-context] OpenCode DB probe failed: path=${resolution.path} source=${resolution.source} cause=${failure.message}`;
    probeLogObserverForTests?.(message);
    log(message);
}

function resolvedDbIsAvailable(): {
    resolution: OpenCodeDbPathResolution;
    available: boolean;
} {
    const resolution = resolveOpenCodeDbPath();
    const available = openCodeDbPathExists(resolution);
    if (available) clearOpenCodeDbReadFailure(resolution.path);
    else logProbeFailureOnce(resolution, "opencode_db_missing");
    return { resolution, available };
}

export function assistantAwaitingTools(_deps: unknown, sessionId: string): boolean {
    const availability = resolvedDbIsAvailable();
    const tracked = trackedSessions.get(sessionId);
    if (tracked) return assistantAwaitingToolsFromMessages(trackedMessages(tracked));
    if (!availability.available) return false;
    try {
        return withReadOnlySessionDb((db) => assistantAwaitingToolsFromOpenCodeDb(db, sessionId));
    } catch (error) {
        logProbeFailureOnce(availability.resolution, error);
        return false;
    }
}

export const __openCodeTurnStateTest = {
    reset(): void {
        trackedSessions.clear();
        pendingParts.clear();
        probeLogObserverForTests = undefined;
    },
    setLogObserver(observer: (message: string) => void): void {
        probeLogObserverForTests = observer;
    },
};

/**
 * Whether a noReply/ignored status notice must be held instead of appended.
 *
 * `assistantAwaitingTools` only covers an assistant waiting on tools, and it releases
 * when a newer real user message exists. Notices require a stronger guard:
 * OpenCode's MessageV2.latest is role-based and does not skip
 * ignored rows, so a notice that becomes the newest user row while a run
 * is starting or in flight makes the loop-exit parentID check fail and
 * can fire a phantom generation. Hold whenever a run is in flight or an
 * unanswered real user prompt exists.
 */
export function shouldHoldIgnoredNotificationFromOpenCodeDb(
    db: Database,
    sessionId: string,
): boolean {
    if (assistantAwaitingToolsFromOpenCodeDb(db, sessionId)) return true;
    if (hasUnfinishedAssistant(db, sessionId)) return true;
    if (hasUnansweredRealUser(db, sessionId)) return true;
    return false;
}

export function shouldHoldIgnoredNotification(sessionId: string): boolean {
    if (process.env.MAGIC_CONTEXT_NOTICE_GATE === "bypass") return false;
    if (process.env.MAGIC_CONTEXT_NOTICE_GATE === "hold") return true;
    const availability = resolvedDbIsAvailable();
    const tracked = trackedSessions.get(sessionId);
    if (tracked) return shouldHoldIgnoredNotificationFromMessages(trackedMessages(tracked));
    if (!availability.available) return false;
    try {
        return withReadOnlySessionDb((db) =>
            shouldHoldIgnoredNotificationFromOpenCodeDb(db, sessionId),
        );
    } catch (error) {
        logProbeFailureOnce(availability.resolution, error);
        return false;
    }
}

export function assistantAwaitingToolsFromOpenCodeDb(db: Database, sessionId: string): boolean {
    const latestAssistant = latestAssistantRow(db, sessionId);

    if (typeof latestAssistant?.id !== "string") return false;
    if (hasNewerRealUserMessage(db, sessionId, latestAssistant.timeCreated)) return false;
    if (latestAssistant.finish === "tool-calls") return true;

    // Keep the session check for cross-session safety, but disqualify it from
    // index selection so the bounded message-id predicate drives the stock index.
    const partRows = db
        .prepare(
            "SELECT data FROM part WHERE +session_id = ? AND likelihood(message_id = ?, 0.000001)",
        )
        .all(sessionId, latestAssistant.id) as PartDataRow[];

    return partRows.some((row) => {
        if (typeof row.data !== "string" || row.data.length === 0) return false;
        try {
            const part = JSON.parse(row.data) as Record<string, unknown>;
            return part.type === "tool" && part.providerExecuted !== true;
        } catch {
            return false;
        }
    });
}

export function latestPersistedMessageForRecovery(
    sessionId: string,
): LatestPersistedMessage | null {
    return withReadOnlySessionDb((db) => {
        const row = db
            .prepare(
                `SELECT id, data
                   FROM message
                  WHERE session_id = ?
                  ORDER BY time_created DESC, id DESC
                  LIMIT 1`,
            )
            .get(sessionId) as PersistedMessageRow | null;
        if (typeof row?.id !== "string" || typeof row.data !== "string") return null;
        try {
            const data = JSON.parse(row.data) as Record<string, unknown>;
            if (typeof data.role !== "string") return null;
            const time =
                data.time && typeof data.time === "object"
                    ? (data.time as Record<string, unknown>)
                    : null;
            return {
                id: row.id,
                role: data.role,
                ...(typeof data.parentID === "string" ? { parentID: data.parentID } : {}),
                ...(typeof time?.completed === "number" ? { completedAt: time.completed } : {}),
                ...(data.error === undefined ? {} : { error: data.error }),
            };
        } catch {
            return null;
        }
    });
}

export function hasNewerRealUserMessage(
    db: Database,
    sessionId: string,
    latestAssistantTimeCreated: unknown,
): boolean {
    if (typeof latestAssistantTimeCreated !== "number") return false;
    const row = db
        .prepare(
            `SELECT 1 as one
             FROM message m
             WHERE m.session_id = ?
               AND m.time_created > ?
               AND json_extract(m.data, '$.role') = 'user'
               AND NOT (
                 EXISTS (SELECT 1 FROM part p WHERE p.message_id = m.id)
                 AND NOT EXISTS (
                   SELECT 1 FROM part p
                   WHERE p.message_id = m.id
                     AND COALESCE(json_extract(p.data, '$.synthetic'), 0) NOT IN (1, 'true')
                     AND json_extract(p.data, '$.metadata.marker.kind') IS NULL
                     AND COALESCE(json_extract(p.data, '$.ignored'), 0) NOT IN (1, 'true')
                 )
               )
             LIMIT 1`,
        )
        .get(sessionId, latestAssistantTimeCreated) as ExistenceRow | null;
    // OpenCode persists synthetic as an annotation on the PART row's data, never
    // on the message row. So separating injected from real user messages requires
    // a part join. A user message is injected iff it HAS at least one part AND
    // EVERY part is machine-generated — where a part is machine-generated if it
    // carries either synthetic=true, a marker part (metadata.marker.kind), or
    // an ignored flag. Marker parts are deliberately NON-synthetic so the TUI
    // renders them as visible system-event lines; they are identified
    // structurally. Ignored parts are dropped by opencode's own model-facing
    // serializer (message-v2.ts:206): an ignored text part is never pushed into
    // the model-facing message, so a message whose parts are all ignored cannot
    // constitute a real user turn. ALL-parts semantics is load-bearing: a real
    // operator prompt may include a synthetic `agent` part from an @mention —
    // classifying that as injected would leave the assistant tool-wait predicate
    // active despite genuine human input. The EXISTS guard on part rows is the
    // vacuous-ALL fence: a partless message satisfies "every part is machine-generated"
    // trivially, so it must count as real.
    return row?.one === 1;
}

function latestAssistantRow(db: Database, sessionId: string): AssistantAwaitingToolsRow | null {
    return db
        .prepare(
            `SELECT id,
                    json_extract(data, '$.finish') as finish,
                    time_created as timeCreated
             FROM message
             WHERE session_id = ?
               AND json_extract(data, '$.role') = 'assistant'
             ORDER BY time_created DESC
             LIMIT 1`,
        )
        .get(sessionId) as AssistantAwaitingToolsRow | null;
}

function hasUnfinishedAssistant(db: Database, sessionId: string): boolean {
    const latestAssistant = latestAssistantRow(db, sessionId);
    if (typeof latestAssistant?.id !== "string") return false;
    const finish = latestAssistant.finish;
    if (typeof finish !== "string" || finish.length === 0) return true;
    return finish === "tool-calls" || finish === "unknown";
}

function hasUnansweredRealUser(db: Database, sessionId: string): boolean {
    const latestAssistant = latestAssistantRow(db, sessionId);
    const latestAssistantTime =
        typeof latestAssistant?.timeCreated === "number" ? latestAssistant.timeCreated : -1;
    return hasNewerRealUserMessage(db, sessionId, latestAssistantTime);
}

interface AssistantModelRow {
    providerID?: string;
    modelID?: string;
}

/**
 * Read the provider/model of the most recent assistant message for a session
 * directly from OpenCode's SQLite DB. Used as a fallback when the in-memory
 * `liveModelBySession` map is empty — for example when `/ctx-status` is invoked
 * before any transform pass has populated the map after restart.
 *
 * Returns null for brand-new sessions with no assistant turn yet.
 */
interface MessageTimeRow {
    id?: string;
    time_created?: number;
}

/**
 * Resolve `time_created` (ms since epoch) for a set of OpenCode message IDs.
 * Returns a Map keyed by message ID. Missing IDs are simply omitted.
 *
 * Used by temporal-awareness to map compartment start/end message IDs to
 * wall-clock dates for `## start-end · date · title` headings in
 * `<session-history>`.
 */
export function getMessageTimesFromOpenCodeDb(
    sessionId: string,
    messageIds: readonly string[],
): Map<string, number> {
    const result = new Map<string, number>();
    if (messageIds.length === 0) return result;

    try {
        withReadOnlySessionDb((db) => {
            // SQLite limits on IN (?, ?, ...) are high (~999 by default) so a
            // single batched query is safe for any realistic compartment count.
            const placeholders = messageIds.map(() => "?").join(",");
            const rows = db
                .prepare(
                    `SELECT id, time_created FROM message WHERE session_id = ? AND id IN (${placeholders})`,
                )
                .all(sessionId, ...messageIds) as MessageTimeRow[];
            for (const row of rows) {
                if (typeof row.id === "string" && typeof row.time_created === "number") {
                    result.set(row.id, row.time_created);
                }
            }
        });
    } catch (error) {
        logProbeFailureOnce(resolveOpenCodeDbPath(), error);
    }

    return result;
}

function isV2SessionMessageStore(db: Database): boolean {
    try {
        const names = new Set(
            (
                db
                    .prepare(
                        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('message', 'part', 'session_message', 'session_v2')",
                    )
                    .all() as Array<{ name?: unknown }>
            ).flatMap((row) => (typeof row.name === "string" ? [row.name] : [])),
        );
        if (!names.has("session_message")) return false;
        // session_v2 is written only by an OpenCode 2 host; a native v2 store has
        // no v1 message tables at all. OpenCode 1.18 ships session_message beside
        // message+part, so those tables must not be mistaken for a v2 store.
        if (names.has("session_v2")) return true;
        return !(names.has("message") && names.has("part"));
    } catch {
        return false;
    }
}

export function findLastAssistantModelFromOpenCodeDb(
    sessionId: string,
): { providerID: string; modelID: string; agent?: string } | null {
    try {
        return withReadOnlySessionDb((db) => {
            // An OpenCode 1.18 store also ships a `session_message` table (pinned in
            // opencode-db-path tests), so its mere presence is NOT a v2 signal. Only
            // an OpenCode 2 store (native, or a v1 store it migrated) is queried as
            // v2; each query is individually guarded so a foreign shape falls through
            // to the other generation instead of aborting the whole lookup.
            const queryV2 = (): (AssistantModelRow & { agent?: string | null }) | null => {
                try {
                    return db
                        .prepare(
                            `SELECT json_extract(data, '$.model.providerID') as providerID,
                                    json_extract(data, '$.model.id') as modelID,
                                    json_extract(data, '$.agent') as agent
                             FROM session_message
                             WHERE session_id = ?
                               AND type = 'assistant'
                               AND json_extract(data, '$.model.providerID') IS NOT NULL
                               AND json_extract(data, '$.model.id') IS NOT NULL
                             ORDER BY seq DESC
                             LIMIT 1`,
                        )
                        .get(sessionId) as (AssistantModelRow & { agent?: string | null }) | null;
                } catch {
                    return null;
                }
            };
            const queryV1 = (): (AssistantModelRow & { agent?: string | null }) | null => {
                try {
                    return db
                        .prepare(
                            `SELECT json_extract(data, '$.providerID') as providerID,
                                    json_extract(data, '$.modelID') as modelID,
                                    json_extract(data, '$.agent') as agent
                             FROM message
                             WHERE session_id = ?
                               AND json_extract(data, '$.role') = 'assistant'
                               AND json_extract(data, '$.providerID') IS NOT NULL
                               AND json_extract(data, '$.modelID') IS NOT NULL
                             ORDER BY time_created DESC
                             LIMIT 1`,
                        )
                        .get(sessionId) as (AssistantModelRow & { agent?: string | null }) | null;
                } catch {
                    return null;
                }
            };
            // The frozen v1 `message` table on a migrated store holds only
            // pre-migration rows, so a v2 store prefers its own table and falls back
            // to v1 only for a legacy session untouched since the migration.
            const row = (isV2SessionMessageStore(db) ? queryV2() : null) ?? queryV1();
            if (!row || typeof row.providerID !== "string" || typeof row.modelID !== "string") {
                return null;
            }
            const agent =
                typeof row.agent === "string" && row.agent.length > 0 ? row.agent : undefined;
            return {
                providerID: row.providerID,
                modelID: row.modelID,
                ...(agent ? { agent } : {}),
            };
        });
    } catch (error) {
        logProbeFailureOnce(resolveOpenCodeDbPath(), error);
        return null;
    }
}
