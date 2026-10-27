/**
 * Tool-definition token measurement store.
 *
 * Every provider request carries the definitions of the tools offered on it,
 * and those definitions take room in the context window. This store measures
 * them so estimates of a request's size can include them. Each tool's
 * description + JSON-schema parameters is tokenized with the same Claude
 * tokenizer used everywhere else in the plugin and stored per tool under a
 * `${providerID}/${modelID}/${agentName}` route key.
 *
 * What a total counts: the tools of the current request. A tool the host
 * stopped offering, or a tool another session was offered, must not add to it
 * for long, and a tool the request does carry must never be left out. The
 * totals feed the 95% size refusal and the replay fits as a trusted figure, so
 * counting too few tools is the dangerous direction; counting a few too many
 * for a while is the safe one. How the current request's tools are known
 * depends on the host:
 *
 * - OpenCode 1 fires its `tool.definition` hook once per tool per
 *   `ToolRegistry.tools()` call (once per request, all tools at once, before
 *   the messages transform of that request), with `{ toolID }` as input and
 *   no session and no "last tool" signal. Calls on one route can run at the
 *   same time and their fires interleave, so fires cannot be grouped into
 *   requests. Instead a route's total counts every tool fired within
 *   `ACTIVITY_WINDOW_MS` of the route's latest fire, measured on the route's
 *   own activity clock (see `advanceClock`): idle time does not age a tool,
 *   so an idle route keeps its whole set, and a tool leaves only after the
 *   route has gone on firing for ten minutes without it.
 * - OpenCode 2 has no such hook, but each request draft carries its whole tool
 *   set, so `recordToolDefinitionSet` replaces the route's set with exactly
 *   that set and remembers it for the draft's session. A read with that
 *   session id returns that session's own set, even when another session on
 *   the same route was offered different tools since.
 *
 * Persistence (v9+): measurements are also written to SQLite so that a
 * plugin restart can show a "Tool Defs" figure before the first request of
 * the new process. A row is deleted when its tool leaves the route's count,
 * so the table holds each route's recent set. Rows loaded at startup count as
 * if fired at load time: until the route's first live fire, and on OpenCode 1
 * until the route has gone on firing for `ACTIVITY_WINDOW_MS` without them.
 * The exception is rows an older version of this store wrote: it never
 * deleted a row, so its rows can hold every tool a route was ever offered
 * (the overcount reported in GitHub issue 797). Those "legacy" rows count
 * only until the route's first live fire. Which rows are legacy is told by a
 * marker in `schema_migrations_meta` (see `WINDOWED_SINCE_KEY`). If
 * `setDatabase()` hasn't been called yet (cold path before openDatabase
 * completes), measurements still update the in-memory map and are written
 * once a database is bound.
 *
 * Hot-path optimization: `tool.definition` fires once per tool per LLM
 * flight (~58 tools × 5–18ms SQLite write = ~1.4s of redundant work per
 * flight on large MC databases). Tool descriptions and parameters almost
 * never change between flights, so each tool keeps the content fingerprint of
 * its last measurement and an identical fire only refreshes its last-fire
 * time, without tokenizing or writing. A tool that left the count keeps its
 * fingerprint and token count in a small per-route cache, so when it comes
 * back unchanged it is not tokenized again, and its row is written again only
 * if it was actually deleted. Any tool whose description or schema actually
 * changed (e.g. MCP server restart, OpenCode upgrade) is re-measured. Cached
 * prepared statements avoid repeated `db.prepare()` compile cost.
 */

import { createHash } from "node:crypto";
import type { MarkerToolDefinition } from "../../hooks/magic-context/marker-envelope";
import { estimateTokens } from "../../hooks/magic-context/read-session-formatting";
import { BoundedSessionMap } from "../../shared/bounded-session-map";
import type { Database, Statement } from "../../shared/sqlite";
import { stableStringify } from "../../shared/stable-json";

/**
 * OpenCode 1: a tool counts while its last fire is at most this far behind the
 * route's latest fire on the route's activity clock.
 *
 * Accepted residual undercount: OpenCode 1 attributes `tool.definition` fires
 * to the route of the most recent `chat.message`, which fires once per user
 * message. After a primary session's `task` child sends its `chat.message`,
 * the primary's later steps fire under the child's route, not its own. If at
 * the same time another session keeps firing a smaller set on the primary's
 * route for ten minutes of activity, the primary-only tools leave that route
 * and the primary's own transform reads it low. A smaller set on the same
 * {provider, model, agent} route only happens when a mode-"all" agent also
 * runs as a subagent, which drops the primary-only tools (`task`,
 * `todowrite`); those are the only tools that can go missing, about 1.5K
 * tokens in OpenCode 1's set (`task` roughly 800 plus a line per subagent,
 * `todowrite` roughly 650). This needs the
 * old misattribution, both uses of that agent at once and ten minutes with no
 * user message in the primary session, so it was accepted rather than
 * counting every tool ever fired on the route, the overcount reported in
 * GitHub issue 797.
 */
const ACTIVITY_WINDOW_MS = 10 * 60_000;
/**
 * OpenCode 1: the most one gap between consecutive fires on a route advances
 * its activity clock. Fires of one request arrive within milliseconds and
 * agent steps follow each other within seconds to minutes, while a longer gap
 * is the route sitting idle, which must not age its tools.
 */
const MAX_ACTIVITY_GAP_MS = 60_000;
/** Tools that left a route's count whose fingerprint and token count are kept. */
const RETIRED_CACHE_LIMIT = 64;
/** Least time between two attempts to write the same tool's row after a failure. */
const WRITE_RETRY_MS = 5_000;
/**
 * `schema_migrations_meta` key holding the time this version of the store
 * took over the table (milliseconds). Rows with a `recorded_at` at or after
 * it were written by a store that deletes rows as their tools leave, so they
 * hold a recent set; older rows, or every row of a table without the key, may
 * hold every tool a route was ever offered.
 */
const WINDOWED_SINCE_KEY = "tool_definition_measurements:windowed_since";

interface ToolSlot {
    tokens: number;
    /**
     * Content fingerprint of the measured description and parameters, or
     * undefined for a row loaded from SQLite, whose content this process has
     * not seen.
     */
    fingerprint: string | undefined;
    /** Route activity-clock time at which the host last offered this tool. */
    lastFireAt: number;
    /**
     * A row loaded from SQLite that an older version of this store wrote and
     * the host has not offered since. It stops counting at the route's first
     * live fire, and its row is deleted once it leaves the window.
     */
    legacy: boolean;
    /** True when SQLite is known to hold this slot's token count. */
    persisted: boolean;
    /** Wall-clock time of the last failed write of this slot, if any. */
    writeFailedAt?: number;
}

interface RetiredTool {
    fingerprint: string;
    tokens: number;
    /** True when the tool's row is still in SQLite with this token count. */
    rowKept: boolean;
}

interface RouteMeasurements {
    providerID: string;
    modelID: string;
    agentName: string;
    tools: Map<string, ToolSlot>;
    /** True once the host offered this route's tools in this process. */
    live: boolean;
    /** Activity-clock time of the route's latest fire, set write or load. */
    clock: number;
    /** Wall-clock time of the route's latest fire, set write or load. */
    lastWallAt: number;
    /**
     * Lower bound on the oldest `lastFireAt` among `tools`, so most fires can
     * tell without a scan that nothing left the window.
     */
    oldestFireAt: number;
    /**
     * Tools that recently left the count, oldest first, so a tool that comes
     * back unchanged is not tokenized or written again.
     */
    retired: Map<string, RetiredTool>;
    /** Tool ids whose SQLite row is still one an older store version wrote. */
    legacyRows: Set<string>;
}

interface ToolSetSummary {
    total: number;
    /** Undefined when a counted tool's content is unknown in this process. */
    signature: string | undefined;
    hash: string;
}

interface SessionFlight {
    key: string;
    /** OpenCode 2: the exact set this session's last request carried. */
    exact?: ToolSetSummary;
}

const routes = new Map<string, RouteMeasurements>();

// The route each session's tools were last measured under, and on OpenCode 2
// the exact set. Bounded like other per-session state: an evicted session
// falls back to its route's figure.
const sessionFlights = new BoundedSessionMap<SessionFlight>(1000);

// Route key → toolID → the definition as last measured in this process, for
// the marker envelope bound. Raw definitions are process-local evidence only;
// persisted token totals cannot reconstruct schemas or prove provider
// serialization overhead, so a row loaded from SQLite has no entry here.
const material = new Map<string, Map<string, MarkerToolDefinition>>();

// Database reference for persistence. Set by setDatabase() once
// openDatabase() has finished migrations. Until then, measurements only
// update the in-memory map and are written on their next fire after binding.
let persistenceDb: Database | null = null;
// The bound table's `WINDOWED_SINCE_KEY` value, or undefined while the table
// has none (every row in it is treated as legacy).
let windowedSince: number | undefined;
// When the current database was bound: the value this process writes as
// `WINDOWED_SINCE_KEY`. Rows already in the table are older; rows this process
// writes are not.
let boundAt = 0;

// Cached statements — recompiling on every fire was a significant share of
// the hot-path cost. Initialized lazily on first use after `setDatabase()` and
// dropped on reset / DB rebind.
let cachedInsertStmt: Statement | null = null;
let cachedDeleteStmt: Statement | null = null;

function agentKey(agentName: string | undefined): string {
    return agentName && agentName.length > 0 ? agentName : "default";
}

function keyFor(providerID: string, modelID: string, agentName: string | undefined): string {
    return `${providerID}/${modelID}/${agentKey(agentName)}`;
}

/**
 * Build a stable fingerprint of all inputs that determine the measured value.
 * Correctness beats the prior shallow optimization: nested schema changes must
 * invalidate cached token counts too.
 */
function fingerprintFor(description: string, parameters: unknown): string {
    return createHash("sha256")
        .update(description)
        .update("\0")
        .update(stableStringify(parameters))
        .digest("hex");
}

function measure(description: string, parameters: unknown): number {
    // Serialize parameters to match what the provider actually sees on the
    // wire. `JSON.stringify(undefined)` returns undefined, so guard that.
    let paramsText = "";
    try {
        paramsText = parameters === undefined ? "" : JSON.stringify(parameters);
    } catch {
        paramsText = "";
    }
    // Count: description + serialized params. This is the token cost of a
    // single tool's definition inside the `tools` array the provider
    // receives. Overhead around the array (field names, commas, braces) is
    // attributed to the separate "Overhead" bucket the RPC handler computes
    // as a residual against inputTokens.
    return estimateTokens(description) + estimateTokens(paramsText);
}

function routeFor(providerID: string, modelID: string, agentName: string | undefined) {
    const key = keyFor(providerID, modelID, agentName);
    let route = routes.get(key);
    if (!route) {
        route = {
            providerID,
            modelID,
            agentName: agentKey(agentName),
            tools: new Map(),
            live: false,
            clock: 0,
            lastWallAt: Date.now(),
            oldestFireAt: Number.POSITIVE_INFINITY,
            retired: new Map(),
            legacyRows: new Set(),
        };
        routes.set(key, route);
    }
    return { key, route };
}

/**
 * Move the route's activity clock to a fire, set write or load happening now
 * and return the new clock time. The clock advances by the wall-clock time
 * since the route's previous one, but by at most `MAX_ACTIVITY_GAP_MS` per
 * gap: time the route sat idle does not count as activity, so a break never
 * ages its tools, and the first fire after a break cannot push the rest of
 * the set out before the request fires it. A wall clock that steps back
 * advances it by nothing.
 */
function advanceClock(route: RouteMeasurements): number {
    const now = Date.now();
    const gap = Math.min(Math.max(now - route.lastWallAt, 0), MAX_ACTIVITY_GAP_MS);
    route.clock += gap;
    route.lastWallAt = Math.max(route.lastWallAt, now);
    return route.clock;
}

/** Whether a slot counts toward its route's total right now. */
function counts(route: RouteMeasurements, slot: ToolSlot): boolean {
    // Before the route's first live fire, every loaded row stands in for it.
    if (!route.live) return true;
    if (slot.legacy) return false;
    return slot.lastFireAt >= route.clock - ACTIVITY_WINDOW_MS;
}

/**
 * The tools a route's total counts. Before the host offered the route's tools
 * in this process, that is the set loaded from SQLite; after, the tools fired
 * within the activity window (OpenCode 1) or the last request's set (OpenCode
 * 2), plus rows loaded at startup that have not left the window yet.
 */
function currentTools(route: RouteMeasurements): Array<[string, ToolSlot]> {
    return [...route.tools.entries()].filter(([, slot]) => counts(route, slot));
}

function summarize(entries: Array<[string, ToolSlot]>, live: boolean): ToolSetSummary {
    let total = 0;
    for (const [, slot] of entries) total += slot.tokens;
    const ids = entries.map(([id]) => id).sort();
    // A row loaded from SQLite carries no fingerprint. Once the route fired in
    // this process, such a row is a tool the host has not offered since the
    // restart (an offered tool gets measured when it fires), so its content
    // cannot differ between two requests of this process, and a fixed stand-in
    // keeps provider usage comparable across them. Signatures are compared
    // only within one process, so the stand-in never meets a fingerprint
    // measured before the restart.
    const fingerprints = new Map(
        entries.map(([id, slot]) => [
            id,
            slot.fingerprint ?? (live ? `stored:${slot.tokens}` : undefined),
        ]),
    );
    const complete = ids.every((id) => fingerprints.get(id) !== undefined);
    return {
        total,
        // Before the route's first live fire every counted tool is a stored
        // row whose content this process has not seen, so no signature can
        // vouch for the set.
        signature: complete
            ? createHash("sha256")
                  .update(JSON.stringify(ids.map((id) => [id, fingerprints.get(id)])))
                  .digest("hex")
            : undefined,
        // An empty string means no tool definitions were observed, as before
        // any measurement.
        hash: ids.length === 0 ? "" : createHash("sha256").update(ids.join("\0")).digest("hex"),
    };
}

function resolve(
    providerID: string,
    modelID: string,
    agentName: string | undefined,
    sessionId: string | undefined,
): ToolSetSummary | undefined {
    if (!providerID || !modelID) return undefined;
    const key = keyFor(providerID, modelID, agentName);
    if (sessionId) {
        const flight = sessionFlights.peek(sessionId);
        if (flight?.key === key && flight.exact) return flight.exact;
    }
    const route = routes.get(key);
    if (!route) return undefined;
    const entries = currentTools(route);
    // A route known only from storage with no rows is not a measurement. A
    // live route with no tools is: OpenCode 2 sent a request with no tools.
    if (!route.live && entries.length === 0) return undefined;
    return summarize(entries, route.live);
}

/**
 * Read the bound table's `WINDOWED_SINCE_KEY`. Undefined when the key or its
 * table is missing, which treats every stored row as legacy.
 */
function readWindowedSince(db: Database): number | undefined {
    try {
        const row = db
            .prepare("SELECT value FROM schema_migrations_meta WHERE key = ?")
            .get(WINDOWED_SINCE_KEY) as { value: string } | null | undefined;
        if (!row) return undefined;
        const value = Number(row.value);
        return Number.isFinite(value) ? value : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Write `WINDOWED_SINCE_KEY` once, with the time this database was bound.
 * Called only when no legacy row needs this process's cleanup to be safe to
 * trust: the table was empty at binding, a prune of a route's rows committed,
 * or a route's last legacy row was overwritten. Until then a crash leaves the
 * table without the key, and the next process treats every row as legacy.
 * Rows written before `boundAt` stay legacy either way.
 */
function markWindowed(): void {
    if (windowedSince !== undefined || !persistenceDb) return;
    try {
        persistenceDb
            .prepare("INSERT OR IGNORE INTO schema_migrations_meta (key, value) VALUES (?, ?)")
            .run(WINDOWED_SINCE_KEY, String(boundAt));
        // Another process may have written the key first; its value wins.
        windowedSince = readWindowedSince(persistenceDb);
    } catch {
        // Best-effort: the next committed prune tries again.
    }
}

function persistInsert(route: RouteMeasurements, toolID: string, tokens: number): boolean {
    if (!persistenceDb) return false;
    try {
        // Compile statement once per DB binding. `.run()` is reusable
        // across calls with different bound values.
        cachedInsertStmt ??= persistenceDb.prepare(
            `INSERT OR REPLACE INTO tool_definition_measurements
             (provider_id, model_id, agent_name, tool_id, token_count, recorded_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
        );
        cachedInsertStmt.run(
            route.providerID,
            route.modelID,
            route.agentName,
            toolID,
            tokens,
            Date.now(),
        );
    } catch {
        // Persistence is best-effort. A SQLITE_BUSY or transient write
        // failure must not break the live measurement: the in-memory map
        // already has the new value, and the old row (if any) is still in
        // place. Drop the cached statement on error — if the DB connection
        // went bad, recompiling on the next attempt is the safe move.
        cachedInsertStmt = null;
        return false;
    }
    // The row now holds this store's measurement instead of a legacy one.
    if (route.legacyRows.delete(toolID) && route.legacyRows.size === 0) markWindowed();
    return true;
}

/**
 * Delete the route's stored rows for exactly `toolIDs`, in one statement.
 * Only rows of tools that left the count are named, so a failed write of a
 * tool still counted can never be preceded by the deletion of its row.
 */
function persistDelete(route: RouteMeasurements, toolIDs: string[]): boolean {
    if (!persistenceDb) return false;
    try {
        cachedDeleteStmt ??= persistenceDb.prepare(
            `DELETE FROM tool_definition_measurements
             WHERE provider_id = ? AND model_id = ? AND agent_name = ?
               AND tool_id IN (SELECT value FROM json_each(?))`,
        );
        cachedDeleteStmt.run(
            route.providerID,
            route.modelID,
            route.agentName,
            JSON.stringify(toolIDs),
        );
    } catch {
        // Best-effort, as for inserts: a row left behind only counts after
        // the next restart, until it leaves the window again.
        cachedDeleteStmt = null;
        return false;
    }
    for (const id of toolIDs) route.legacyRows.delete(id);
    markWindowed();
    return true;
}

/**
 * Write a slot whose token count SQLite is not known to hold. A failed write
 * is retried on a later fire of the tool (at most every `WRITE_RETRY_MS`), so
 * a tool whose content never changes still reaches the table.
 */
function writeSlot(route: RouteMeasurements, toolID: string, slot: ToolSlot): void {
    if (slot.persisted || !persistenceDb) return;
    const now = Date.now();
    if (slot.writeFailedAt !== undefined && now - slot.writeFailedAt < WRITE_RETRY_MS) return;
    if (persistInsert(route, toolID, slot.tokens)) {
        slot.persisted = true;
        slot.writeFailedAt = undefined;
    } else {
        slot.writeFailedAt = now;
    }
}

/** Keep a tool that left the count, so its return needs no re-measurement. */
function retire(route: RouteMeasurements, toolID: string, slot: ToolSlot, rowDeleted: boolean) {
    if (slot.fingerprint === undefined) return;
    route.retired.delete(toolID);
    route.retired.set(toolID, {
        fingerprint: slot.fingerprint,
        tokens: slot.tokens,
        rowKept: slot.persisted && !rowDeleted,
    });
    if (route.retired.size > RETIRED_CACHE_LIMIT) {
        const oldest = route.retired.keys().next().value;
        if (oldest !== undefined) route.retired.delete(oldest);
    }
}

/**
 * A new slot for a tool measured now, reusing the token count of a retired
 * slot with the same content instead of tokenizing again.
 */
function freshSlot(
    route: RouteMeasurements,
    toolID: string,
    description: string,
    parameters: unknown,
    fingerprint: string,
    now: number,
): ToolSlot {
    const retired = route.retired.get(toolID);
    if (retired) route.retired.delete(toolID);
    const reuse = retired?.fingerprint === fingerprint ? retired : undefined;
    return {
        tokens: reuse ? reuse.tokens : measure(description, parameters),
        fingerprint,
        lastFireAt: now,
        legacy: false,
        // A retired tool whose row was never deleted needs no write.
        persisted: reuse?.rowKept === true,
    };
}

/** Keep the raw definition of a tool measured now, for `getMarkerToolDefinitions`. */
function recordMaterial(key: string, toolID: string, description: string, parameters: unknown) {
    let definitions = material.get(key);
    if (!definitions) material.set(key, (definitions = new Map()));
    try {
        definitions.set(toolID, {
            name: toolID,
            description,
            inputSchema: structuredClone(parameters) as Record<string, unknown>,
        });
    } catch {
        definitions.delete(toolID);
    }
}

/**
 * OpenCode 1: drop the tools that left the activity window, and delete their
 * rows. Runs after each fire; the `oldestFireAt` bound skips the scan when no
 * tool can have left.
 */
function expire(route: RouteMeasurements): void {
    const cutoff = route.clock - ACTIVITY_WINDOW_MS;
    if (route.oldestFireAt >= cutoff) return;
    const leaving: Array<[string, ToolSlot]> = [];
    let oldest = Number.POSITIVE_INFINITY;
    for (const entry of route.tools) {
        if (entry[1].lastFireAt >= cutoff) oldest = Math.min(oldest, entry[1].lastFireAt);
        else leaving.push(entry);
    }
    route.oldestFireAt = oldest;
    if (leaving.length === 0) return;
    const deleted = persistDelete(
        route,
        leaving.map(([id]) => id),
    );
    for (const [id, slot] of leaving) {
        route.tools.delete(id);
        retire(route, id, slot, deleted);
    }
}

/**
 * Register the database used to persist measurements. Called by
 * openDatabase() after runMigrations() has ensured the
 * `tool_definition_measurements` table exists. Subsequent measurements will
 * write through to SQLite.
 */
export function setDatabase(db: Database): void {
    const rebound = persistenceDb !== null && persistenceDb !== db;
    persistenceDb = db;
    boundAt = Date.now();
    // New DB binding invalidates any cached statement compiled against the
    // previous handle.
    cachedInsertStmt = null;
    cachedDeleteStmt = null;
    if (rebound) {
        // Nothing measured so far is known to be in the new table.
        for (const route of routes.values()) {
            for (const slot of route.tools.values()) {
                slot.persisted = false;
                slot.writeFailedAt = undefined;
            }
            for (const retired of route.retired.values()) retired.rowKept = false;
            route.legacyRows.clear();
        }
    }
    windowedSince = readWindowedSince(db);
    if (windowedSince !== undefined) return;
    // An empty table holds no legacy rows, so there is nothing to clean up
    // before every row in it can be trusted.
    try {
        if (!db.prepare("SELECT 1 FROM tool_definition_measurements LIMIT 1").get()) markWindowed();
    } catch {
        // Table missing: leave the key unwritten.
    }
}

/**
 * Populate the in-memory store from the `tool_definition_measurements` table.
 * Called once at startup after setDatabase(), before the first sidebar
 * snapshot or status query, so the sidebar's "Tool Defs" segment shows a
 * figure immediately on restart instead of 0.
 *
 * Loaded rows count as if their tools fired at load time: they stand in for
 * the route until its first live fire and then, on OpenCode 1, until the
 * route has gone on firing for the activity window without them. A read in
 * the middle of the first request after a restart therefore still counts the
 * stored set. Legacy rows (written before `WINDOWED_SINCE_KEY`, or in a table
 * without it) can hold every tool a route was ever offered, so they stop
 * counting at the route's first live fire. Since this process never measured
 * a loaded row's content, it carries no fingerprint.
 *
 * Idempotent: re-running over the same DB reapplies the same values; the
 * per-route tool key ensures duplicates overwrite rather than accumulate.
 * Routes already measured in this process are left alone.
 */
export function loadToolDefinitionMeasurements(db: Database): void {
    let rows: Array<{
        provider_id: string;
        model_id: string;
        agent_name: string;
        tool_id: string;
        token_count: number;
        recorded_at: number;
    }> = [];
    try {
        rows = db
            .prepare(
                "SELECT provider_id, model_id, agent_name, tool_id, token_count, recorded_at FROM tool_definition_measurements",
            )
            .all() as typeof rows;
    } catch {
        // Table doesn't exist yet — migrations haven't run. Nothing to load.
        return;
    }
    const since = readWindowedSince(db);

    const loadedAt = new Map<RouteMeasurements, number>();
    for (const row of rows) {
        const { route } = routeFor(row.provider_id, row.model_id, row.agent_name);
        if (route.live) continue;
        let now = loadedAt.get(route);
        if (now === undefined) {
            now = advanceClock(route);
            loadedAt.set(route, now);
        }
        const legacy = since === undefined || !(Number(row.recorded_at) >= since);
        route.tools.set(row.tool_id, {
            tokens: row.token_count,
            fingerprint: undefined,
            lastFireAt: now,
            legacy,
            persisted: !legacy,
        });
        route.oldestFireAt = Math.min(route.oldestFireAt, now);
        if (legacy) route.legacyRows.add(row.tool_id);
        else route.legacyRows.delete(row.tool_id);
    }
}

/**
 * OpenCode 1: measure one tool the host is offering on the current request.
 * Called from the `tool.definition` plugin hook once per tool per flight.
 * `sessionId` is the session the request is believed to belong to (the hook
 * carries none); it only records which route that session last flew.
 */
export function recordToolDefinition(
    providerID: string,
    modelID: string,
    agentName: string | undefined,
    toolID: string,
    description: string,
    parameters: unknown,
    sessionId?: string,
): void {
    if (!providerID || !modelID || !toolID) return;
    const { key, route } = routeFor(providerID, modelID, agentName);

    // The last-fire bookkeeping runs before the fingerprint skip: an
    // unchanged tool must still be marked as offered now.
    const now = advanceClock(route);
    if (!route.live) {
        // First live fire for the route in this process. Legacy rows stop
        // counting; their rows stay until they leave the window from now, so a
        // tool this request re-offers has its row overwritten, never deleted
        // first.
        route.live = true;
        for (const slot of route.tools.values()) if (slot.legacy) slot.lastFireAt = now;
    }
    if (sessionId) sessionFlights.set(sessionId, { key });

    // Fast-path skip: if this exact tool's last measurement carried an
    // identical fingerprint, tokenizing and writing would produce the same
    // result.
    const fingerprint = fingerprintFor(description ?? "", parameters);
    let slot = route.tools.get(toolID);
    if (slot && slot.fingerprint === fingerprint) {
        slot.lastFireAt = now;
    } else {
        slot = freshSlot(route, toolID, description ?? "", parameters, fingerprint, now);
        route.tools.set(toolID, slot);
        recordMaterial(key, toolID, description ?? "", parameters);
        route.oldestFireAt = Math.min(route.oldestFireAt, now);
    }
    // Write-through to SQLite so the value survives a plugin restart.
    writeSlot(route, toolID, slot);
    expire(route);
}

/**
 * OpenCode 2: record the exact tool set one request carries. The route's set
 * becomes exactly `tools` (tools no longer offered are forgotten and their
 * stored rows deleted), and `sessionId`'s figure becomes this set until its
 * next request. Unchanged tools are not tokenized or written again.
 */
export function recordToolDefinitionSet(
    providerID: string,
    modelID: string,
    agentName: string | undefined,
    tools: Iterable<{ id: string; description: string; parameters: unknown }>,
    sessionId?: string,
): void {
    if (!providerID || !modelID) return;
    const { key, route } = routeFor(providerID, modelID, agentName);
    const now = advanceClock(route);
    route.live = true;
    const next = new Map<string, ToolSlot>();
    for (const tool of tools) {
        if (!tool.id) continue;
        const fingerprint = fingerprintFor(tool.description ?? "", tool.parameters);
        const previous = route.tools.get(tool.id);
        if (previous && previous.fingerprint === fingerprint) {
            previous.lastFireAt = now;
            next.set(tool.id, previous);
            continue;
        }
        next.set(
            tool.id,
            freshSlot(route, tool.id, tool.description ?? "", tool.parameters, fingerprint, now),
        );
        recordMaterial(key, tool.id, tool.description ?? "", tool.parameters);
    }
    const removed = [...route.tools].filter(([id]) => !next.has(id));
    route.tools = next;
    route.oldestFireAt = now;
    if (removed.length > 0) {
        const deleted = persistDelete(
            route,
            removed.map(([id]) => id),
        );
        for (const [id, slot] of removed) retire(route, id, slot, deleted);
    }
    for (const [toolID, slot] of next) writeSlot(route, toolID, slot);
    if (sessionId)
        sessionFlights.set(sessionId, { key, exact: summarize([...next.entries()], true) });
}

/**
 * Hash the tool names of the current tool set for one model/agent route.
 *
 * Tool names alone identify the prefix change this marker explains. Schema
 * fingerprints remain necessary for measurement de-duplication, but including
 * them here would add cost without improving cache-bust attribution. An empty
 * string is returned both before any measurement and for a request that
 * carried no tools; it does not tell those cases apart.
 */
export function getCurrentToolSetHash(
    providerID: string,
    modelID: string,
    agentName: string | undefined,
    sessionId?: string,
): string {
    return resolve(providerID, modelID, agentName, sessionId)?.hash ?? "";
}

/**
 * Hash the current tool set's IDs and full schemas so provider usage is reused
 * only for the same definitions. Undefined when a counted tool's content was
 * not measured in this process.
 */
export function getToolDefinitionMeasurementSignature(
    providerID: string,
    modelID: string,
    agentName: string | undefined,
    sessionId?: string,
): string | undefined {
    return resolve(providerID, modelID, agentName, sessionId)?.signature;
}

/**
 * Returns the measured tokens of the current tool set for a
 * `{provider, model, agent}` route, or `undefined` when never measured (e.g.
 * fresh session before first turn). With `sessionId`, an OpenCode 2 session
 * whose last request flew this route gets that request's exact set.
 */
export function getMeasuredToolDefinitionTokens(
    providerID: string,
    modelID: string,
    agentName: string | undefined,
    sessionId?: string,
): number | undefined {
    return resolve(providerID, modelID, agentName, sessionId)?.total;
}

/**
 * The tool-definition total of the route `sessionId` last flew: on OpenCode 2
 * the exact set of that session's last request, on OpenCode 1 the route's
 * recent-activity total. For a session whose current route has no
 * measurement yet (for example right after a model switch), this is the best
 * evidence of the tools it is offered; undefined when the session never had
 * its tools measured.
 */
export function getSessionToolDefinitionTokens(sessionId: string | undefined): number | undefined {
    if (!sessionId) return undefined;
    const flight = sessionFlights.peek(sessionId);
    if (!flight) return undefined;
    if (flight.exact) return flight.exact.total;
    const route = routes.get(flight.key);
    return route ? summarize(currentTools(route), route.live).total : undefined;
}

/** Test helper: reset the store so suites don't leak measurements. */
export function __resetToolDefinitionMeasurements(): void {
    routes.clear();
    sessionFlights.clear();
    material.clear();
    persistenceDb = null;
    windowedSince = undefined;
    boundAt = 0;
    cachedInsertStmt = null;
    cachedDeleteStmt = null;
}

/**
 * The raw definitions of the route's current tool set (the tools its total
 * counts), or undefined when a counted tool was not measured in this process,
 * such as a row loaded from SQLite that has not fired since.
 */
export function getMarkerToolDefinitions(
    providerID: string,
    modelID: string,
    agentName: string | undefined,
): MarkerToolDefinition[] | undefined {
    const key = keyFor(providerID, modelID, agentName);
    const route = routes.get(key);
    const definitions = material.get(key);
    if (!route || !definitions) return undefined;
    const ids = currentTools(route).map(([id]) => id);
    if (ids.length === 0 || ids.some((id) => !definitions.has(id))) return undefined;
    return ids.map((id) => definitions.get(id) as MarkerToolDefinition);
}

/** Sorted names of the tools in the route's current set, as the `tool.definition`
 * hook reported them. OpenCode does not run that hook for MCP tools, so they are
 * never listed. */
export function getHookToolNames(
    providerID: string,
    modelID: string,
    agentName: string | undefined,
): string[] | undefined {
    const route = routes.get(keyFor(providerID, modelID, agentName));
    if (!route) return undefined;
    const ids = currentTools(route).map(([id]) => id);
    return ids.length > 0 ? ids.sort() : undefined;
}

/** Inspection helper: snapshot each route's current set (for debug logging/tests). */
export function getToolDefinitionSnapshot(): Array<{
    key: string;
    totalTokens: number;
    toolCount: number;
}> {
    return Array.from(routes.entries()).map(([key, route]) => {
        const entries = currentTools(route);
        return {
            key,
            totalTokens: summarize(entries, route.live).total,
            toolCount: entries.length,
        };
    });
}
