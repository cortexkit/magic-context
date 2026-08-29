import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import type { Database as DatabaseType } from "@magic-context/core/shared/sqlite";
import { writeFileAtomic } from "../lib/atomic-write";
import {
    getPersistedSchemaVersion,
    openExistingContextDatabase,
    openExistingContextDatabaseForMutation,
    openExistingDatabase,
} from "../lib/database-access";
import { getOpenCodeDatabasePath, projectPathToPiSessionSlug } from "../lib/migration-paths";
import { getOmpSessionsRoot, getPiSessionsRoot } from "../lib/paths";

export interface MigrateOpenCodeSessionToPiOptions {
    /**
     * OpenCode source DB handle. Read-only operations: session, message,
     * part rows. Owns nothing about Magic Context state — that lives in
     * the cortexkit DB below.
     */
    db?: DatabaseLike;
    /**
     * Magic Context shared-DB handle (`~/.local/share/cortexkit/magic-context/context.db`).
     * The migrator reads source compartments + facts under
     * `harness='opencode'` keyed by source session_id and writes copies
     * keyed by the new Pi session_id under `harness='pi'`. When omitted,
     * the migrator opens the canonical path read-write.
     *
     * Pass `null` explicitly to skip the cortexkit copy entirely (the
     * legacy V1 behavior — JSONL only).
     */
    cortexkitDb?: DatabaseLike | null;
    fs?: FileSystemLike;
    now?: Date;
    sessionId: string;
    maxMessages?: number;
    dryRun?: boolean;
    opencodeDbPath?: string;
    cortexkitDbPath?: string;
    piSessionsRoot?: string;
    provider?: string;
    modelId?: string;
    /**
     * Target harness recorded in the migration journal key. Defaults to "pi";
     * pass "omp" when the session JSONL is written into OMP's sessions root.
     */
    targetHarness?: "pi" | "omp";
}

export interface MigrationResult {
    outputPath: string;
    piSessionId: string;
    messageCount: number;
    byteCount: number;
    sourceMessageCount: number;
    /** Number of OpenCode compartments copied to the new Pi session_id. */
    compartmentsCopied: number;
    /** Number of OpenCode session_facts copied to the new Pi session_id. */
    factsCopied: number;
    /** Number of compartment boundaries that were nearest-at-or-before remapped (vs exact match). */
    boundariesApproximated: number;
    compactionMarkerWritten: boolean;
    compactionBoundaryEntryId?: string;
    compactionFirstKeptEntryId?: string;
    /** Records the shared database's persisted schema version before and after migration so callers can verify it stays within the running plugin's supported limit. */
    cortexkitSchemaVersionBefore?: number;
    cortexkitSchemaVersionAfter?: number;
    /**
     * Journal key (hash of source session + target harness) when the shared-DB
     * crash-recovery journal tracked this migration. Absent for dry runs and
     * JSONL-only migrations without a cortexkit database.
     */
    migrationKey?: string;
    /** True when a journal row from an earlier interrupted attempt supplied the Pi session identity. */
    journalResumed?: boolean;
    /** Recovery sweep reconciled before this migration ran (only when the journal is active). */
    recovery?: MigrationSweepReport;
    dryRun: boolean;
}

/**
 * One in-flight row of the `migration_pending` journal. Column names avoid a
 * bare `session_id` on purpose: the structural clearSession contract wipes
 * every table carrying that column, and session deletion must not destroy
 * crash-recovery records.
 */
export interface MigrationPendingRow {
    migration_key: string;
    source_session_id: string;
    target_harness: string;
    pi_session_id: string;
    final_path: string;
    stage_path: string;
    content_sha256: string;
    phase: "staged" | "db_committed";
    created_at: number;
}

/** Outcome of reconciling interrupted migrations by journal phase. */
export interface MigrationSweepReport {
    /** Finished migrations whose journal row outlived the final rename. */
    completed: number;
    /** db_committed rows roll-forwarded (stage file renamed to its final path). */
    rolledForward: number;
    /** staged rows rolled back (stage file removed; shared state provably absent). */
    rolledBack: number;
    /**
     * db_committed rows whose stage AND final files are both missing. The shared
     * state committed but the session bytes were lost; these are reported, never
     * silently deleted.
     */
    lost: MigrationPendingRow[];
}

export interface MigrateCliOptions {
    from?: string;
    to?: string;
    session?: string;
    maxMessages?: number;
    dryRun?: boolean;
}

type DatabaseLike = Pick<DatabaseType, "prepare" | "close" | "exec">;

type FileSystemLike = {
    writeFileAtomic(path: string, data: string): unknown;
    unlinkSync(path: string): unknown;
    existsSync(path: string): boolean;
    renameSync(from: string, to: string): unknown;
    mkdirSync(path: string, options?: { recursive?: boolean }): unknown;
};

type StatementLike<T = unknown> = {
    get(...params: unknown[]): T | undefined;
    all(...params: unknown[]): T[];
    run(...params: unknown[]): unknown;
};

type OpenCodeSessionRow = {
    id: string;
    title?: string;
    directory?: string;
    path?: string | null;
    time_created: number;
};

type OpenCodeMessageRow = {
    id: string;
    time_created: number;
    data: string;
};

type OpenCodePartRow = {
    id: string;
    message_id: string;
    time_created: number;
    data: string;
};

type PiJson = Record<string, unknown>;

type OpenCodeMessageTokens = {
    input?: number;
    output?: number;
    reasoning?: number;
    total?: number;
    cache?: { read?: number; write?: number };
};

type OpenCodeMessageData = {
    role?: string;
    time?: { created?: number };
    modelID?: string;
    providerID?: string;
    model?: { providerID?: string; modelID?: string };
    tokens?: OpenCodeMessageTokens;
};

type OpenCodePartData = {
    type?: string;
    text?: string;
    filename?: string;
    name?: string;
    tool?: string;
    tool_name?: string;
    callID?: string;
    call_id?: string;
    toolCallId?: string;
    tool_call_id?: string;
    input?: unknown;
    output?: unknown;
    state?: {
        input?: unknown;
        output?: unknown;
        title?: string;
        metadata?: { output?: unknown };
    };
    metadata?: { anthropic?: { signature?: string } };
};

interface CortexkitCompartmentRow {
    sequence: number;
    start_message: number;
    end_message: number;
    start_message_id: string;
    end_message_id: string;
    title: string;
    content: string;
    created_at: number;
    p1: string | null;
    p2: string | null;
    p3: string | null;
    p4: string | null;
    importance: number | null;
    episode_type: string | null;
    legacy: number;
}

interface CortexkitSessionFactRow {
    category: string;
    content: string;
    created_at: number;
    updated_at: number;
}

const DEFAULT_PROVIDER = "openai-codex";
const DEFAULT_MODEL = "gpt-5.5";
const MIGRATION_COMPACTION_SUMMARY =
    "Magic Context compacted prior conversation. See <session-history> block for the structured summary.";
const PART_LOOKUP_CHUNK_SIZE = 900;
/**
 * Directory name for staged migration JSONL, created as a SIBLING of the
 * target sessions root (e.g. `~/.pi/agent/.mc-migrations` for the default Pi
 * layout). Staging outside the sessions tree keeps half-written migrations
 * away from any harness that scans session files by suffix, while staying on
 * the same filesystem so the stage→final rename remains atomic.
 */
const MIGRATION_STAGE_DIRNAME = ".mc-migrations";

function defaultOpenCodeDbPath(): string {
    return getOpenCodeDatabasePath();
}

function defaultCortexkitDbPath(): string {
    return join(getMagicContextStorageDir(), "context.db");
}

function defaultPiSessionsRoot(): string {
    return getPiSessionsRoot();
}

function defaultFs(): FileSystemLike {
    return { writeFileAtomic, unlinkSync, existsSync, renameSync, mkdirSync };
}

function stmt<T>(db: DatabaseLike, sql: string): StatementLike<T> {
    return db.prepare(sql) as unknown as StatementLike<T>;
}

export function projectPathToPiDirSlug(
    projectPath: string,
    platform: NodeJS.Platform = process.platform,
): string {
    return projectPathToPiSessionSlug(projectPath, platform);
}

export function formatPiFilenameTimestamp(date: Date): string {
    return date.toISOString().replaceAll(":", "-").replace(".", "-");
}

export function generateUuidV7(date = new Date()): string {
    const bytes = randomBytes(16);
    let ms = BigInt(date.getTime());
    for (let i = 5; i >= 0; i--) {
        bytes[i] = Number(ms & 0xffn);
        ms >>= 8n;
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function shortId(): string {
    return randomBytes(4).toString("hex");
}

/**
 * Stable identity for one (source session, target harness) migration. Hashed
 * so the journal's PRIMARY KEY is fixed-size and filesystem-neutral; identical
 * across retries, which is what lets a re-run resume the original attempt's
 * Pi session identity instead of minting a second one.
 */
export function migrationKeyFor(sourceSessionId: string, targetHarness: string): string {
    return createHash("sha256").update(`${sourceSessionId}\n${targetHarness}`).digest("hex");
}

function moduleManagedProjectForSession(db: DatabaseLike, sessionId: string): string | null {
    const tables = db
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('authority_managed', 'session_projects')",
        )
        .all() as Array<{ name?: unknown }>;
    const names = new Set(
        tables.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])),
    );
    if (!names.has("authority_managed") || !names.has("session_projects")) return null;
    const row = db
        .prepare(
            `SELECT am.project_path
               FROM authority_managed am
               JOIN session_projects sp ON sp.project_path = am.project_path
              WHERE sp.session_id = ? AND sp.harness = 'opencode'
              LIMIT 1`,
        )
        .get(sessionId) as { project_path?: unknown } | undefined;
    return typeof row?.project_path === "string" ? row.project_path : null;
}

function hasMigrationJournal(db: DatabaseLike): boolean {
    return Boolean(
        stmt(
            db,
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'migration_pending'",
        ).get(),
    );
}

/**
 * Reconcile interrupted migrations recorded in `migration_pending`, by phase
 * and with NO time thresholds — a row is only ever reconciled by what its
 * phase and files prove:
 *
 *   final file present            → done (crash between rename and row
 *                                    deletion): delete the row.
 *   phase=db_committed + stage    → ROLL FORWARD: the shared-DB state
 *                                    committed, so finish the rename and
 *                                    delete the row.
 *   phase=staged                  → ROLL BACK: delete stage file + row. The
 *                                    shared-DB state is provably absent
 *                                    because the phase only advances inside
 *                                    the same transaction that writes it.
 *   phase=db_committed, no files  → the staged bytes were lost after the DB
 *                                    commit. Report loudly and keep the row —
 *                                    the checksum names what was lost; never
 *                                    silently delete.
 *
 * Idempotent: running it against an already-clean journal is a no-op.
 */
export function sweepPendingMigrations(
    db: DatabaseLike,
    fs: FileSystemLike = defaultFs(),
): MigrationSweepReport {
    const report: MigrationSweepReport = {
        completed: 0,
        rolledForward: 0,
        rolledBack: 0,
        lost: [],
    };
    if (!hasMigrationJournal(db)) return report;

    const rows = stmt<MigrationPendingRow>(
        db,
        `SELECT migration_key, source_session_id, target_harness, pi_session_id,
               final_path, stage_path, content_sha256, phase, created_at
          FROM migration_pending
      ORDER BY created_at ASC`,
    ).all();

    for (const row of rows) {
        if (fs.existsSync(row.final_path)) {
            // Finished: the rename landed but the journal row deletion didn't.
            stmt(db, "DELETE FROM migration_pending WHERE migration_key = ?").run(
                row.migration_key,
            );
            report.completed += 1;
            continue;
        }
        if (row.phase === "db_committed") {
            if (fs.existsSync(row.stage_path)) {
                // Roll forward: shared state is committed; complete the rename.
                fs.mkdirSync(dirname(row.final_path), { recursive: true });
                fs.renameSync(row.stage_path, row.final_path);
                stmt(db, "DELETE FROM migration_pending WHERE migration_key = ?").run(
                    row.migration_key,
                );
                report.rolledForward += 1;
            } else {
                // Lost: committed state with no recoverable session bytes.
                report.lost.push(row);
            }
            continue;
        }
        // phase === "staged": roll back. Best-effort stage removal — a missing
        // stage file is fine (the row still goes away).
        try {
            fs.unlinkSync(row.stage_path);
        } catch {
            // The staged file may already be gone; the row deletion below is
            // the authoritative rollback.
        }
        stmt(db, "DELETE FROM migration_pending WHERE migration_key = ?").run(row.migration_key);
        report.rolledBack += 1;
    }
    return report;
}

const JOURNAL_SELECT_SQL = `SELECT migration_key, source_session_id, target_harness, pi_session_id,
               final_path, stage_path, content_sha256, phase, created_at
          FROM migration_pending WHERE migration_key = ?`;

function readPendingMigration(
    db: DatabaseLike,
    migrationKey: string,
): MigrationPendingRow | undefined {
    return stmt<MigrationPendingRow>(db, JOURNAL_SELECT_SQL).get(migrationKey);
}

/**
 * Claim the journal identity for this migration key BEFORE building the
 * session content: mint the Pi uuid on first attempt and persist it in a
 * phase=staged row, or reuse the persisted row on retry. The content embeds
 * the identity (session entry + filename), so the identity must be settled
 * first — and a re-run must never mint a second identity for the same key.
 *
 * The checksum is still unknown at claim time (the bytes are built after);
 * the row lands with an empty placeholder and `commitStagedChecksum` fills it
 * once the content exists, before the stage file is written. A crash in that
 * window leaves a plain staged row, which the sweep rolls back safely.
 *
 * The insert is upsert-shaped (ON CONFLICT DO NOTHING + re-read) so two
 * racing first attempts converge on ONE identity: the loser adopts the
 * winner's persisted row instead of carrying a second uuid into the content.
 */
function claimJournalIdentity(args: {
    db: DatabaseLike;
    migrationKey: string;
    sourceSessionId: string;
    targetHarness: string;
    finalPathFor: (piSessionId: string) => string;
    stageDir: string;
    now: number;
}): { row: MigrationPendingRow; resumed: boolean } {
    const existing = readPendingMigration(args.db, args.migrationKey);
    if (existing) {
        return { row: existing, resumed: true };
    }

    const piSessionId = generateUuidV7(new Date(args.now));
    stmt(
        args.db,
        `INSERT INTO migration_pending (
             migration_key, source_session_id, target_harness, pi_session_id,
             final_path, stage_path, content_sha256, phase, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, '', 'staged', ?)
         ON CONFLICT(migration_key) DO NOTHING`,
    ).run(
        args.migrationKey,
        args.sourceSessionId,
        args.targetHarness,
        piSessionId,
        args.finalPathFor(piSessionId),
        join(args.stageDir, `${args.migrationKey}.jsonl`),
        args.now,
    );
    // Re-read: a concurrent writer may have won the insert race, in which case
    // THEIR identity is authoritative (this attempt resumes it).
    const row = readPendingMigration(args.db, args.migrationKey);
    if (!row) {
        throw new Error("migration journal row disappeared during insert; aborting migration");
    }
    return { row, resumed: row.pi_session_id !== piSessionId };
}

/**
 * Step (1) completion: record the checksum of the bytes about to be staged.
 * For a resumed row this refreshes the checksum to describe THIS attempt's
 * content; the phase is deliberately left untouched — a row that already
 * reached db_committed must never regress to staged, because sweep roll-back
 * trusts staged to mean "no shared state was committed".
 */
function commitStagedChecksum(db: DatabaseLike, migrationKey: string, contentSha256: string): void {
    stmt(db, "UPDATE migration_pending SET content_sha256 = ? WHERE migration_key = ?").run(
        contentSha256,
        migrationKey,
    );
}

function parseJsonObject<T>(text: string): T {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Expected JSON object");
    }
    return parsed as T;
}

function isoFromMs(ms: number | undefined, fallback: Date): string {
    return new Date(
        typeof ms === "number" && Number.isFinite(ms) ? ms : fallback.getTime(),
    ).toISOString();
}

function textFromUnknown(value: unknown): string {
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    return JSON.stringify(value, null, 2);
}

function roleFromMessage(row: OpenCodeMessageRow): "user" | "assistant" | undefined {
    const data = parseJsonObject<OpenCodeMessageData>(row.data);
    return data.role === "user" || data.role === "assistant" ? data.role : undefined;
}

function tokensFromMessage(row: OpenCodeMessageRow): OpenCodeMessageTokens {
    try {
        const data = parseJsonObject<OpenCodeMessageData>(row.data);
        return data.tokens ?? {};
    } catch {
        return {};
    }
}

function extractModel(rows: OpenCodeMessageRow[]): {
    provider: string;
    modelId: string;
} {
    for (const row of rows) {
        try {
            const data = parseJsonObject<OpenCodeMessageData>(row.data);
            const provider = data.providerID ?? data.model?.providerID;
            const modelId = data.modelID ?? data.model?.modelID;
            if (provider && modelId) return { provider, modelId };
        } catch {
            // Ignore malformed rows; conversion below will surface concrete row errors.
        }
    }
    return { provider: DEFAULT_PROVIDER, modelId: DEFAULT_MODEL };
}

function normalizeOpenCodeTool(part: OpenCodePartData): {
    callId: string;
    name: string;
    input: unknown;
    output: unknown;
} {
    const callId =
        part.callID ??
        part.call_id ??
        part.toolCallId ??
        part.tool_call_id ??
        `migrated_${shortId()}`;
    const name = part.tool ?? part.tool_name ?? part.name ?? part.state?.title ?? "unknown_tool";
    const input = part.input ?? part.state?.input ?? {};
    const output = part.output ?? part.state?.output ?? part.state?.metadata?.output ?? "";
    return { callId, name, input, output };
}

/**
 * Build a Pi-shaped `usage` object from OpenCode `message.tokens`.
 *
 * OpenCode shape: `{ total, input, output, reasoning, cache: { read, write } }`.
 * Pi shape: `{ input, output, cacheRead, cacheWrite, totalTokens, cost: {...} }`.
 *
 * Pi's interactive footer reads `entry.message.usage.input` on every
 * assistant render. Without realistic numbers, `getContextUsage()` reports
 * 0% of the model's window because Pi sums these per-turn input fields.
 * Real numbers from the source session let the scheduler + historian
 * trigger correctly the moment a migrated session loads.
 *
 * Cost is set to zeroes — recovering OpenCode pricing is non-trivial and
 * Pi's footer aggregator handles missing cost gracefully.
 */
function tokensToPiUsage(tokens: OpenCodeMessageTokens | undefined): Record<string, unknown> {
    const input = tokens?.input ?? 0;
    const output = tokens?.output ?? 0;
    const cacheRead = tokens?.cache?.read ?? 0;
    const cacheWrite = tokens?.cache?.write ?? 0;
    const total = tokens?.total ?? input + output + cacheRead + cacheWrite;
    return {
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens: total,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
}

function makeMessageEntry(
    role: "user" | "assistant",
    text: string,
    timestamp: string,
    parentId: string | null,
    usage: Record<string, unknown>,
): PiJson {
    const message: Record<string, unknown> = {
        role,
        content: [{ type: "text", text }],
        timestamp: Date.parse(timestamp),
    };
    if (role === "assistant") {
        message.usage = usage;
    }
    return {
        type: "message",
        id: shortId(),
        parentId,
        timestamp,
        message,
    };
}

function makeThinkingEntry(
    text: string,
    timestamp: string,
    parentId: string | null,
    usage: Record<string, unknown>,
): PiJson {
    return {
        type: "message",
        id: shortId(),
        parentId,
        timestamp,
        message: {
            role: "assistant",
            content: [{ type: "thinking", thinking: text, thinkingSignature: null }],
            timestamp: Date.parse(timestamp),
            usage,
        },
    };
}

function makeToolCallEntry(
    tool: { callId: string; name: string; input: unknown },
    timestamp: string,
    parentId: string | null,
    usage: Record<string, unknown>,
): PiJson {
    return {
        type: "message",
        id: shortId(),
        parentId,
        timestamp,
        message: {
            role: "assistant",
            content: [
                {
                    type: "toolCall",
                    id: tool.callId,
                    name: tool.name,
                    arguments: tool.input ?? {},
                },
            ],
            timestamp: Date.parse(timestamp),
            usage,
        },
    };
}

function makeToolResultEntry(
    tool: { callId: string; name: string; output: unknown },
    timestamp: string,
    parentId: string | null,
): PiJson {
    return {
        type: "message",
        id: shortId(),
        parentId,
        timestamp,
        message: {
            role: "toolResult",
            toolCallId: tool.callId,
            toolName: tool.name,
            content: [{ type: "text", text: textFromUnknown(tool.output) }],
            isError: false,
            timestamp: Date.parse(timestamp),
        },
    };
}

interface ConvertPartContext {
    role: "user" | "assistant";
    row: OpenCodePartRow;
    timestamp: string;
    parentId: string | null;
    usage: Record<string, unknown>;
}

function convertPartToEntries(ctx: ConvertPartContext): PiJson[] {
    const part = parseJsonObject<OpenCodePartData>(ctx.row.data);
    switch (part.type) {
        case "step-start":
        case "step-finish":
        case "patch":
            return [];
        case "text":
            return part.text
                ? [makeMessageEntry(ctx.role, part.text, ctx.timestamp, ctx.parentId, ctx.usage)]
                : [];
        case "reasoning":
            return part.text
                ? [makeThinkingEntry(part.text, ctx.timestamp, ctx.parentId, ctx.usage)]
                : [];
        case "tool": {
            const tool = normalizeOpenCodeTool(part);
            const call = makeToolCallEntry(tool, ctx.timestamp, ctx.parentId, ctx.usage);
            const result = makeToolResultEntry(tool, ctx.timestamp, call.id as string);
            return [call, result];
        }
        case "file": {
            const name = part.filename ?? part.name ?? "attachment";
            return [
                makeMessageEntry(
                    ctx.role,
                    `<file omitted: ${name}>`,
                    ctx.timestamp,
                    ctx.parentId,
                    ctx.usage,
                ),
            ];
        }
        default:
            return [];
    }
}

interface BuildEntriesResult {
    entries: PiJson[];
    piSessionId: string;
    /**
     * Map from OpenCode message_id → the FIRST Pi entry id derived from that
     * source message. Compartment START boundaries remap through this map so a
     * source message that expands into several Pi entries keeps its whole
     * expansion inside the compartment (a last-entry-only remap would silently
     * shrink the start span).
     */
    messageIdToFirstPiEntryId: Map<string, string>;
    /**
     * Map from OpenCode message_id → the LAST Pi entry id derived from
     * that source message. Compartment END boundaries remap through this map
     * (it captures all parts of that source message).
     */
    messageIdToLastPiEntryId: Map<string, string>;
    /**
     * Source-message ids in chronological order. Used for nearest-at-or-before
     * remapping when a compartment's start_message_id doesn't directly
     * match (e.g. its part-only synthetic boundary).
     */
    orderedSourceMessageIds: string[];
}

function buildPiEntries(params: {
    session: OpenCodeSessionRow;
    messages: OpenCodeMessageRow[];
    parts: OpenCodePartRow[];
    now: Date;
    provider: string;
    modelId: string;
    /**
     * The Pi session identity for the migrated JSONL. Minted by the caller (or
     * reused from the migration journal on retry) rather than here, so the
     * journal's persisted identity stays authoritative across attempts.
     */
    piSessionId: string;
}): BuildEntriesResult {
    const sessionUuid = params.piSessionId;
    const nowIso = params.now.toISOString();
    const entries: PiJson[] = [
        {
            type: "session",
            version: 3,
            id: sessionUuid,
            timestamp: nowIso,
            cwd: params.session.directory ?? params.session.path ?? process.cwd(),
        },
        {
            type: "model_change",
            id: shortId(),
            parentId: null,
            timestamp: nowIso,
            provider: params.provider,
            modelId: params.modelId,
        },
    ];

    // Migration boundary marker — appears as the first user message in
    // the migrated session. This is intentionally stub usage (zeros)
    // because no real LLM produced it; it's a synthetic marker only.
    const boundary = makeMessageEntry(
        "user",
        `<!-- migrated from OpenCode session ${params.session.id} at ${nowIso} -->\n\nThe following conversation was migrated from a different harness. Reasoning context from prior turns may be incomplete; tool calls reference tools that may not exist in this environment.`,
        nowIso,
        null,
        {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
    );
    entries.push(boundary);

    const partsByMessage = new Map<string, OpenCodePartRow[]>();
    for (const part of params.parts) {
        const list = partsByMessage.get(part.message_id) ?? [];
        list.push(part);
        partsByMessage.set(part.message_id, list);
    }

    const messageIdToFirstPiEntryId = new Map<string, string>();
    const messageIdToLastPiEntryId = new Map<string, string>();
    const orderedSourceMessageIds: string[] = [];

    let parentId = boundary.id as string;
    for (const message of params.messages) {
        const role = roleFromMessage(message);
        if (!role) continue;
        const timestamp = isoFromMs(message.time_created, params.now);
        const tokens = tokensFromMessage(message);
        const usage = tokensToPiUsage(tokens);

        let firstEntryIdForMessage: string | null = null;
        let lastEntryIdForMessage: string | null = null;
        for (const part of partsByMessage.get(message.id) ?? []) {
            const newEntries = convertPartToEntries({
                role,
                row: part,
                timestamp,
                parentId,
                usage,
            });
            for (const entry of newEntries) {
                if (entry.parentId === undefined || entry.parentId === parentId)
                    entry.parentId = parentId;
                entries.push(entry);
                parentId = entry.id as string;
                if (firstEntryIdForMessage === null) firstEntryIdForMessage = parentId;
                lastEntryIdForMessage = parentId;
            }
        }
        if (lastEntryIdForMessage !== null && firstEntryIdForMessage !== null) {
            messageIdToFirstPiEntryId.set(message.id, firstEntryIdForMessage);
            messageIdToLastPiEntryId.set(message.id, lastEntryIdForMessage);
            orderedSourceMessageIds.push(message.id);
        }
    }

    return {
        entries,
        piSessionId: sessionUuid,
        messageIdToFirstPiEntryId,
        messageIdToLastPiEntryId,
        orderedSourceMessageIds,
    };
}

function fetchRows(db: DatabaseLike, sessionId: string, maxMessages: number | undefined) {
    db.exec("PRAGMA busy_timeout=5000");
    db.exec("BEGIN DEFERRED");
    try {
        const session = stmt<OpenCodeSessionRow>(
            db,
            "SELECT id, title, directory, path, time_created FROM session WHERE id = ?",
        ).get(sessionId);
        if (!session) throw new Error(`OpenCode session not found: ${sessionId}`);

        const sourceMessageCount =
            stmt<{ count: number }>(
                db,
                "SELECT COUNT(*) AS count FROM message WHERE session_id = ?",
            ).get(sessionId)?.count ?? 0;

        const limitClause = maxMessages ? "LIMIT ?" : "";
        const params = maxMessages ? [sessionId, maxMessages] : [sessionId];
        const newestFirst = stmt<OpenCodeMessageRow>(
            db,
            `SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC ${limitClause}`,
        ).all(...params);
        const messages = newestFirst.reverse();
        const ids = messages.map((row) => row.id);
        const parts: OpenCodePartRow[] = [];
        // Keep every lookup inside this deferred transaction while bounding each
        // IN list below SQLite's conservative 999-variable configurations.
        for (let offset = 0; offset < ids.length; offset += PART_LOOKUP_CHUNK_SIZE) {
            const chunk = ids.slice(offset, offset + PART_LOOKUP_CHUNK_SIZE);
            parts.push(
                ...stmt<OpenCodePartRow>(
                    db,
                    `SELECT id, message_id, time_created, data FROM part WHERE message_id IN (${chunk.map(() => "?").join(",")})`,
                ).all(...chunk),
            );
        }
        parts.sort((left, right) => {
            if (left.time_created !== right.time_created) {
                return left.time_created - right.time_created;
            }
            return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
        });

        db.exec("COMMIT");
        return { session, sourceMessageCount, messages, parts };
    } catch (error) {
        try {
            db.exec("ROLLBACK");
        } catch {
            // Preserve the read failure if the transaction already closed.
        }
        throw error;
    }
}

/**
 * Translate an OpenCode boundary id to the equivalent Pi entry id.
 *
 * Strategy (in order):
 *   1. If the OpenCode message id maps directly to a Pi entry, use that.
 *      The EDGE selects which derived entry: a START boundary maps to the
 *      FIRST Pi entry derived from the source message and an END boundary to
 *      the LAST, so a source message that expands into several Pi entries
 *      stays fully inside the compartment on both sides.
 *   2. Otherwise find the nearest source message whose chronological
 *      position is at-or-before the missing one and use ITS LAST Pi entry —
 *      the closest point still at-or-before the missing boundary, for start
 *      and end edges alike. "At-or-before" is by index in
 *      `orderedSourceMessageIds`.
 *   3. If no message at-or-before exists (boundary precedes the
 *      earliest migrated message), return undefined and the caller
 *      drops the compartment.
 *
 * Returns `{ piEntryId, exact }` so the caller can count approximations.
 */
function remapBoundaryId(
    openCodeMessageId: string,
    edge: "start" | "end",
    messageIdToFirstPiEntryId: Map<string, string>,
    messageIdToLastPiEntryId: Map<string, string>,
    orderedSourceMessageIds: readonly string[],
): { piEntryId: string; exact: boolean } | undefined {
    const directMap = edge === "start" ? messageIdToFirstPiEntryId : messageIdToLastPiEntryId;
    const direct = directMap.get(openCodeMessageId);
    if (direct !== undefined) return { piEntryId: direct, exact: true };

    // Boundary id wasn't a top-level message id — find nearest at-or-before.
    // Use string comparison as a proxy for chronological order: OpenCode
    // message ids are ULID-ish (`msg_${time}_${random}`), so lexicographic
    // order matches creation order for messages in the same session.
    let nearestAtOrBefore: string | undefined;
    for (const id of orderedSourceMessageIds) {
        if (id <= openCodeMessageId) {
            nearestAtOrBefore = id;
        } else {
            break;
        }
    }
    if (nearestAtOrBefore === undefined) return undefined;
    const piEntryId = messageIdToLastPiEntryId.get(nearestAtOrBefore);
    if (piEntryId === undefined) return undefined;
    return { piEntryId, exact: false };
}

interface CopyMagicContextStateResult {
    compartmentsCopied: number;
    factsCopied: number;
    boundariesApproximated: number;
    lastCompartmentEndPiEntryId?: string;
}

interface RemappedCompartment {
    sequence: number;
    start_message: number;
    end_message: number;
    start_message_id: string;
    end_message_id: string;
    title: string;
    content: string;
    p1: string | null;
    p2: string | null;
    p3: string | null;
    p4: string | null;
    importance: number | null;
    episode_type: string | null;
    legacy: number;
}

/**
 * The remapped state to copy, plus a committer that performs all writes
 * inside a single transaction. The plan is computed without writing so the
 * caller can (a) read `lastCompartmentEndPiEntryId` for the compaction marker,
 * (b) derive runtime-basis ordinals into `remappedCompartments` AFTER the
 * compaction marker mutates the entry array, and (c) write the Pi JSONL file
 * FIRST, then call `commit()` only after the file persists — so an
 * interruption never leaves orphaned shared-DB rows with no usable session
 * file.
 *
 * Pass the journal's `migration_key` to `commit()` to advance that row's phase
 * to `db_committed` INSIDE the same transaction as the state writes — the
 * ordering the crash-recovery sweep relies on.
 */
interface CopyMagicContextStatePlan extends CopyMagicContextStateResult {
    /**
     * Remapped rows awaiting runtime-basis ordinals (start_message /
     * end_message) before commit. Exposed so the caller derives them from the
     * FINAL entry array (post compaction-marker insertion).
     */
    remappedCompartments: RemappedCompartment[];
    commit: (journalKey?: string) => void;
}

interface CompactionMarkerResult {
    written: boolean;
    boundaryEntryId?: string;
    firstKeptEntryId?: string;
}

function insertCompactionMarker(
    entries: PiJson[],
    boundaryEntryId: string | undefined,
): CompactionMarkerResult {
    if (boundaryEntryId === undefined) return { written: false };

    const boundaryIndex = entries.findIndex((entry) => entry.id === boundaryEntryId);
    if (boundaryIndex < 0) return { written: false };

    const firstKept = entries[boundaryIndex + 1];
    if (!firstKept?.id) return { written: false };

    const compactedPrefixChars = entries
        .slice(0, boundaryIndex + 1)
        .reduce((total, entry) => total + JSON.stringify(entry.message ?? "").length, 0);
    const compactionId = shortId();
    const marker: PiJson = {
        type: "compaction",
        id: compactionId,
        parentId: boundaryEntryId,
        timestamp: String(entries[boundaryIndex].timestamp),
        summary: MIGRATION_COMPACTION_SUMMARY,
        firstKeptEntryId: firstKept.id,
        tokensBefore: Math.ceil(compactedPrefixChars / 4),
        fromHook: true,
    };

    firstKept.parentId = compactionId;
    entries.splice(boundaryIndex + 1, 0, marker);
    return {
        written: true,
        boundaryEntryId,
        firstKeptEntryId: firstKept.id as string,
    };
}

/**
 * Copy compartments + session_facts from the source OpenCode session
 * into a new Pi session keyed by the migrated session UUID. Boundary
 * IDs are remapped from OpenCode message ids to Pi entry ids (the
 * runtime path also stores entry.id; see read-session-pi.ts and
 * inject-compartments-pi.ts for the consumer).
 *
 * The shared cortexkit DB is treated as already-initialized (Magic
 * Context creates it on first plugin load). We only INSERT here —
 * never CREATE TABLE — because the schema migration system owns that
 * lifecycle.
 *
 * On dry runs we still read source state and compute the remap so the
 * result counts are accurate, but we don't write anything to the DB.
 */
function copyMagicContextState(args: {
    cortexkitDb: DatabaseLike;
    sourceSessionId: string;
    piSessionId: string;
    messageIdToFirstPiEntryId: Map<string, string>;
    messageIdToLastPiEntryId: Map<string, string>;
    orderedSourceMessageIds: readonly string[];
    now: number;
    dryRun: boolean;
}): CopyMagicContextStatePlan {
    const sourceCompartments = stmt<CortexkitCompartmentRow>(
        args.cortexkitDb,
        `SELECT sequence, start_message, end_message, start_message_id, end_message_id,
              title, content, created_at,
              p1, p2, p3, p4, importance, episode_type, legacy
         FROM compartments
        WHERE session_id = ? AND harness = 'opencode'
     ORDER BY sequence ASC`,
    ).all(args.sourceSessionId);

    const sourceFacts = stmt<CortexkitSessionFactRow>(
        args.cortexkitDb,
        `SELECT category, content, created_at, updated_at
         FROM session_facts
        WHERE session_id = ? AND harness = 'opencode'
     ORDER BY category ASC, id ASC`,
    ).all(args.sourceSessionId);

    let boundariesApproximated = 0;
    const remappedCompartments: RemappedCompartment[] = [];

    for (const c of sourceCompartments) {
        const startRemap = remapBoundaryId(
            c.start_message_id,
            "start",
            args.messageIdToFirstPiEntryId,
            args.messageIdToLastPiEntryId,
            args.orderedSourceMessageIds,
        );
        const endRemap = remapBoundaryId(
            c.end_message_id,
            "end",
            args.messageIdToFirstPiEntryId,
            args.messageIdToLastPiEntryId,
            args.orderedSourceMessageIds,
        );
        // If either boundary doesn't translate (precedes our migrated
        // range entirely), skip that compartment. The remaining compartments
        // still form a contiguous prefix from the perspective of the trim
        // machinery, just shorter.
        if (!startRemap || !endRemap) continue;
        if (!startRemap.exact || !endRemap.exact) boundariesApproximated++;
        remappedCompartments.push({
            sequence: c.sequence,
            start_message: c.start_message,
            end_message: c.end_message,
            start_message_id: startRemap.piEntryId,
            end_message_id: endRemap.piEntryId,
            title: c.title,
            content: c.content,
            p1: c.p1,
            p2: c.p2,
            p3: c.p3,
            p4: c.p4,
            importance: c.importance,
            episode_type: c.episode_type,
            legacy: c.legacy,
        });
    }

    const result: CopyMagicContextStateResult = {
        compartmentsCopied: remappedCompartments.length,
        factsCopied: sourceFacts.length,
        boundariesApproximated,
        lastCompartmentEndPiEntryId: remappedCompartments.at(-1)?.end_message_id,
    };

    if (args.dryRun) {
        return { ...result, remappedCompartments, commit: () => {} };
    }

    // Defer all writes into a single transaction the caller runs AFTER the Pi
    // JSONL file persists. Insert compartments + facts under
    // (harness='pi', session_id=<new>). The shared DB schema includes
    // `harness TEXT NOT NULL DEFAULT 'opencode'` on both tables, and
    // (session_id, sequence) is UNIQUE on compartments.
    const commit = (journalKey?: string) => {
        const insertCompartment = stmt(
            args.cortexkitDb,
            `INSERT INTO compartments (
       session_id, sequence, start_message, end_message,
       start_message_id, end_message_id, title, content,
       p1, p2, p3, p4, importance, episode_type, legacy,
       created_at, harness
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pi')`,
        );
        const insertFact = stmt(
            args.cortexkitDb,
            `INSERT INTO session_facts (
       session_id, category, content, created_at, updated_at, harness
     ) VALUES (?, ?, ?, ?, ?, 'pi')`,
        );
        args.cortexkitDb.exec("BEGIN IMMEDIATE");
        try {
            // Upsert-shaped replay: a resumed attempt reuses the journal's
            // pi_session_id, and a crash AFTER this transaction committed (but
            // before the staged file reached its final path) leaves rows under
            // it. Replacing any prior rows for this session inside the same
            // transaction keeps the replay idempotent — no UNIQUE collision on
            // compartments(session_id, sequence), no duplicated facts.
            stmt(
                args.cortexkitDb,
                "DELETE FROM compartments WHERE session_id = ? AND harness = 'pi'",
            ).run(args.piSessionId);
            stmt(
                args.cortexkitDb,
                "DELETE FROM session_facts WHERE session_id = ? AND harness = 'pi'",
            ).run(args.piSessionId);
            for (const c of remappedCompartments) {
                insertCompartment.run(
                    args.piSessionId,
                    c.sequence,
                    c.start_message,
                    c.end_message,
                    c.start_message_id,
                    c.end_message_id,
                    c.title,
                    c.content,
                    c.p1,
                    c.p2,
                    c.p3,
                    c.p4,
                    // Preserve v2 metadata so the decay renderer tiers/decays
                    // migrated history. Without these, rows land legacy=0 + NULL
                    // tiers and the renderer falls back to full `content` for every
                    // tier (no decay, prompt bloat). importance mirrors the schema
                    // default when absent.
                    typeof c.importance === "number" ? c.importance : 50,
                    c.episode_type,
                    c.legacy,
                    args.now,
                );
            }
            for (const f of sourceFacts) {
                insertFact.run(args.piSessionId, f.category, f.content, f.created_at, f.updated_at);
            }
            if (journalKey !== undefined) {
                // Advance the journal phase INSIDE this transaction: the sweep's
                // roll-forward arm (db_committed ⇒ shared state committed) is
                // only true because the two writes commit atomically.
                stmt(
                    args.cortexkitDb,
                    "UPDATE migration_pending SET phase = 'db_committed' WHERE migration_key = ?",
                ).run(journalKey);
            }
            args.cortexkitDb.exec("COMMIT");
        } catch (error) {
            args.cortexkitDb.exec("ROLLBACK");
            throw error;
        }
    };

    return { ...result, remappedCompartments, commit };
}

/**
 * Replicate the ordinal basis the Pi runtime reader produces, so migrated
 * compartment ordinals match what `readSessionChunk` consumes at runtime.
 *
 * The Pi reader (`convertEntriesToRawMessages` in pi-plugin's
 * read-session-pi.ts) walks the JSONL entries and counts RawMessages:
 *   - non-`message` entries (session, model_change, compaction, …) carry no
 *     ordinal at all;
 *   - each user or assistant message entry gets its own ordinal;
 *   - `toolResult` entries get NONE — they fold into the next user entry
 *     (sharing its ordinal), or into a synthetic user turn emitted ahead of
 *     the next assistant entry (consuming its own ordinal), or into a
 *     trailing synthetic user turn;
 *   - unknown roles get their own ordinal without folding pending results.
 *
 * Returns entry-id → ordinal for every entry that participates in a
 * RawMessage. MUST stay in lockstep with the reader; the migration tests
 * resolve expected ordinals through the reader itself, never this helper.
 */
function derivePiRuntimeOrdinals(entries: readonly PiJson[]): Map<string, number> {
    const ordinalByEntryId = new Map<string, number>();
    let nextOrdinal = 1;
    const pendingToolResultIds: string[] = [];

    const foldPendingInto = (ordinal: number): void => {
        for (const id of pendingToolResultIds) ordinalByEntryId.set(id, ordinal);
        pendingToolResultIds.length = 0;
    };

    for (const entry of entries) {
        const message = entry.message;
        if (
            entry.type !== "message" ||
            typeof entry.id !== "string" ||
            message === null ||
            typeof message !== "object"
        ) {
            // Structural entries never reach the runtime reader's ordinals.
            continue;
        }
        const role = (message as { role?: unknown }).role;

        if (role === "toolResult") {
            pendingToolResultIds.push(entry.id);
            continue;
        }

        if (role === "assistant" && pendingToolResultIds.length > 0) {
            // The reader emits a synthetic user turn for the pending results
            // BEFORE this assistant message; that turn consumes an ordinal.
            foldPendingInto(nextOrdinal);
            nextOrdinal += 1;
        }

        const ordinal = nextOrdinal;
        nextOrdinal += 1;
        if (role === "user" && pendingToolResultIds.length > 0) {
            // Pending results fold into this user turn and share its ordinal.
            foldPendingInto(ordinal);
        }
        ordinalByEntryId.set(entry.id, ordinal);
    }

    if (pendingToolResultIds.length > 0) {
        // Trailing results fold into a final synthetic user turn.
        foldPendingInto(nextOrdinal);
    }
    return ordinalByEntryId;
}

/**
 * Fill each remapped compartment's start_message/end_message with ordinals
 * derived from the FINAL entry array — after insertCompactionMarker ran — so
 * the stored ordinals are in the exact basis the Pi runtime reader produces.
 * Boundary entry ids come from the entries built in this same run, so a
 * missing ordinal is a migrator bug and fails loudly (before anything is
 * written).
 *
 * FUTURE-ONLY fix: this corrects ordinal derivation for migrations written by
 * this and later versions. Raw-copy rows shipped by earlier migrators (which
 * copied the source session's ordinals verbatim) are deliberately NOT
 * backfilled here — a repair needs field evidence that mis-based sessions
 * exist, and none has been reported.
 */
function applyRuntimeOrdinals(
    remappedCompartments: RemappedCompartment[],
    entries: readonly PiJson[],
): void {
    const ordinals = derivePiRuntimeOrdinals(entries);
    for (const compartment of remappedCompartments) {
        const startOrdinal = ordinals.get(compartment.start_message_id);
        const endOrdinal = ordinals.get(compartment.end_message_id);
        if (startOrdinal === undefined || endOrdinal === undefined) {
            const missing =
                startOrdinal === undefined
                    ? compartment.start_message_id
                    : compartment.end_message_id;
            throw new Error(
                `Migration boundary entry ${missing} has no runtime ordinal; migrator invariant violated`,
            );
        }
        compartment.start_message = startOrdinal;
        compartment.end_message = endOrdinal;
    }
}

function ensureValidOptions(
    opts: MigrateCliOptions,
): asserts opts is Required<Pick<MigrateCliOptions, "from" | "to" | "session">> &
    MigrateCliOptions {
    if (!opts.from) throw new Error("Missing required flag: --from <opencode>");
    if (!opts.to) throw new Error("Missing required flag: --to <pi|omp>");
    if (opts.from !== "opencode" || (opts.to !== "pi" && opts.to !== "omp")) {
        if ((opts.from === "pi" || opts.from === "omp") && opts.to === "opencode") {
            throw new Error(
                `Migration ${opts.from} → opencode is not yet supported (supported: opencode → pi|omp)`,
            );
        }
        throw new Error(
            `Unsupported migration: ${opts.from} → ${opts.to} (supported: opencode → pi|omp)`,
        );
    }
    if (!opts.session) throw new Error("Missing required flag: --session <id>");
    if (
        opts.maxMessages !== undefined &&
        (!Number.isInteger(opts.maxMessages) || opts.maxMessages <= 0)
    ) {
        throw new Error("--max-messages must be a positive integer");
    }
}

export function migrateOpenCodeSessionToPi(
    opts: MigrateOpenCodeSessionToPiOptions,
): MigrationResult {
    const fs = opts.fs ?? defaultFs();
    const now = opts.now ?? new Date();
    const opencodeDbPath = opts.opencodeDbPath ?? defaultOpenCodeDbPath();
    const piSessionsRoot = opts.piSessionsRoot ?? defaultPiSessionsRoot();
    const ownsDb = !opts.db;
    const db = opts.db ?? openExistingDatabase(opencodeDbPath, { readonly: true });
    if (db === null) {
        throw new Error(`OpenCode database not found at ${opencodeDbPath}; nothing to migrate.`);
    }

    // Cortexkit DB: when not provided explicitly, open the canonical
    // shared DB read-write (we'll INSERT into compartments + session_facts).
    // Pass null to skip the cortexkit copy entirely (legacy V1 behavior).
    let cortexkitDb: DatabaseLike | null;
    let ownsCortexkitDb = false;
    let cortexkitSchemaVersionBefore: number | null = null;
    if (opts.cortexkitDb === null) {
        cortexkitDb = null;
    } else if (opts.cortexkitDb !== undefined) {
        cortexkitDb = opts.cortexkitDb;
    } else {
        const cortexkitDbPath = opts.cortexkitDbPath ?? defaultCortexkitDbPath();
        cortexkitDb = opts.dryRun
            ? openExistingContextDatabase(cortexkitDbPath, { readonly: true })
            : openExistingContextDatabaseForMutation(cortexkitDbPath);
        ownsCortexkitDb = cortexkitDb !== null;
        if (cortexkitDb !== null)
            cortexkitSchemaVersionBefore = getPersistedSchemaVersion(cortexkitDb as DatabaseType);
        // If Magic Context has never created context.db, skip the state copy;
        // opening a missing path must not fabricate an empty database.
    }

    try {
        const { session, sourceMessageCount, messages, parts } = fetchRows(
            db,
            opts.sessionId,
            opts.maxMessages,
        );
        const model = extractModel(messages);
        const provider = opts.provider ?? model.provider;
        const modelId = opts.modelId ?? model.modelId;
        const cwd = session.directory ?? session.path ?? process.cwd();
        const outputDir = join(piSessionsRoot, projectPathToPiDirSlug(cwd));
        const targetHarness = opts.targetHarness ?? "pi";
        const moduleManagedProject =
            cortexkitDb === null ? null : moduleManagedProjectForSession(cortexkitDb, session.id);
        if (moduleManagedProject) {
            throw new Error(
                `Migration refused: source session ${session.id} belongs to module-managed project ${moduleManagedProject}; context.db may contain only host mirrors, not the Rust engine truth. Drain authority to TypeScript with \`magic-context doctor drain-authority ${cwd}\`, then retry.`,
            );
        }

        // Journal-backed runs (real cortexkit DB, not a dry run) reconcile any
        // interrupted attempts FIRST, then claim this migration's identity.
        // The sweep runs by phase with no time thresholds; see
        // sweepPendingMigrations for the reconciliation arms.
        const journalActive = cortexkitDb !== null && !opts.dryRun;
        let recovery: MigrationSweepReport | undefined;
        let migrationKey: string | undefined;
        let journalResumed = false;
        let piSessionId: string;
        let finalPath: string;
        let stagePath: string;
        if (journalActive && cortexkitDb !== null) {
            if (!hasMigrationJournal(cortexkitDb)) {
                throw new Error(
                    "context.db has no migration_pending journal (shared schema older than v78). Run a harness session once so the plugin can upgrade the schema, then retry doctor migrate.",
                );
            }
            recovery = sweepPendingMigrations(cortexkitDb, fs);
            migrationKey = migrationKeyFor(session.id, targetHarness);
            const claimed = claimJournalIdentity({
                db: cortexkitDb,
                migrationKey,
                sourceSessionId: session.id,
                targetHarness,
                finalPathFor: (id) =>
                    join(outputDir, `${formatPiFilenameTimestamp(now)}_${id}.jsonl`),
                // Sibling of the sessions root: outside any directory a harness
                // scans for session files, on the same filesystem so the
                // stage→final rename stays atomic.
                stageDir: join(dirname(piSessionsRoot), MIGRATION_STAGE_DIRNAME),
                now: now.getTime(),
            });
            piSessionId = claimed.row.pi_session_id;
            finalPath = claimed.row.final_path;
            stagePath = claimed.row.stage_path;
            journalResumed = claimed.resumed;
        } else {
            piSessionId = generateUuidV7(now);
            finalPath = join(outputDir, `${formatPiFilenameTimestamp(now)}_${piSessionId}.jsonl`);
            stagePath = "";
        }

        const buildResult = buildPiEntries({
            session,
            messages,
            parts,
            now,
            provider,
            modelId,
            piSessionId,
        });
        // Copy magic-context durable state (compartments + facts) to the
        // new Pi session_id when the cortexkit DB is reachable.
        let copyResult: CopyMagicContextStateResult = {
            compartmentsCopied: 0,
            factsCopied: 0,
            boundariesApproximated: 0,
        };
        let plan: CopyMagicContextStatePlan | null = null;
        if (cortexkitDb !== null) {
            plan = copyMagicContextState({
                cortexkitDb,
                sourceSessionId: session.id,
                piSessionId,
                messageIdToFirstPiEntryId: buildResult.messageIdToFirstPiEntryId,
                messageIdToLastPiEntryId: buildResult.messageIdToLastPiEntryId,
                orderedSourceMessageIds: buildResult.orderedSourceMessageIds,
                now: now.getTime(),
                dryRun: Boolean(opts.dryRun),
            });
            copyResult = plan;
        }

        const compactionMarker = insertCompactionMarker(
            buildResult.entries,
            copyResult.lastCompartmentEndPiEntryId,
        );

        // Compartment ordinals are derived from the POST-INSERTION entry array
        // (the compaction marker above has mutated it) in the runtime reader's
        // ordinal basis, so what the DB stores is exactly what the Pi read path
        // will consume.
        if (plan) applyRuntimeOrdinals(plan.remappedCompartments, buildResult.entries);

        const jsonl = `${buildResult.entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;

        if (!opts.dryRun) {
            if (journalActive && cortexkitDb !== null && migrationKey !== undefined && plan) {
                const contentSha256 = createHash("sha256").update(jsonl, "utf8").digest("hex");
                // (1) journal row committed at phase=staged with the checksum of
                //     the bytes about to be staged (row + identity were claimed
                //     before content build).
                commitStagedChecksum(cortexkitDb, migrationKey, contentSha256);
                // (2) stage the JSONL outside the sessions root.
                fs.writeFileAtomic(stagePath, jsonl);
                // (3) shared-DB state transaction, advancing phase→db_committed
                //     INSIDE the same transaction.
                // (4) rename stage→final (same filesystem ⇒ atomic).
                // A failure between (2) and (4) leaves a journal row the sweep
                // reconciles by phase: staged rolls back (shared state provably
                // absent), db_committed rolls forward. No same-run cleanup —
                // one reconciliation code path for crashes and for retries.
                plan.commit(migrationKey);
                fs.mkdirSync(dirname(finalPath), { recursive: true });
                fs.renameSync(stagePath, finalPath);
                // (5) delete the journal row.
                stmt(cortexkitDb, "DELETE FROM migration_pending WHERE migration_key = ?").run(
                    migrationKey,
                );
            } else {
                // No journal (JSONL-only migration without a cortexkit DB):
                // write the session file directly.
                fs.writeFileAtomic(finalPath, jsonl);
            }
        }

        return {
            outputPath: finalPath,
            piSessionId,
            // entries.length - 2 subtracts the leading "session" + "model_change"
            // entries that every Pi JSONL file starts with. The result counts
            // every USER-VISIBLE entry: boundary marker, all migrated message
            // entries, and (when present) the trailing compaction marker. This
            // matches what users see as "migrated entries" in CLI output.
            // Audit tools sometimes flag this as off-by-N because they don't
            // know which entries are structural — that's a false positive.
            messageCount: buildResult.entries.length - 2,
            byteCount: Buffer.byteLength(jsonl, "utf8"),
            sourceMessageCount,
            compartmentsCopied: copyResult.compartmentsCopied,
            factsCopied: copyResult.factsCopied,
            boundariesApproximated: copyResult.boundariesApproximated,
            compactionMarkerWritten: compactionMarker.written,
            compactionBoundaryEntryId: compactionMarker.boundaryEntryId,
            compactionFirstKeptEntryId: compactionMarker.firstKeptEntryId,
            ...(migrationKey !== undefined ? { migrationKey } : {}),
            ...(journalActive ? { journalResumed } : {}),
            ...(recovery !== undefined ? { recovery } : {}),
            ...(cortexkitSchemaVersionBefore !== null && cortexkitDb !== null
                ? {
                      cortexkitSchemaVersionBefore,
                      cortexkitSchemaVersionAfter: getPersistedSchemaVersion(
                          cortexkitDb as DatabaseType,
                      ),
                  }
                : {}),
            dryRun: Boolean(opts.dryRun),
        };
    } finally {
        if (ownsDb) db.close();
        if (ownsCortexkitDb && cortexkitDb !== null) cortexkitDb.close();
    }
}

export function parseMigrateArgs(args: string[]): MigrateCliOptions {
    const opts: MigrateCliOptions = {};
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const readValue = (flag: string): string => {
            const value = args[++i];
            if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
            return value;
        };
        if (arg === "--from") opts.from = readValue(arg);
        else if (arg === "--to") opts.to = readValue(arg);
        else if (arg === "--session") opts.session = readValue(arg);
        else if (arg === "--max-messages") opts.maxMessages = Number(readValue(arg));
        else if (arg === "--dry-run") opts.dryRun = true;
        else if (arg === "--help" || arg === "-h") throw new Error("HELP");
        else throw new Error(`Unknown migrate flag: ${arg}`);
    }
    return opts;
}

export function printMigrateHelp(): void {
    console.log(`
  Magic Context doctor migrate
  ─────────────────────────────

  Copy OpenCode session message content into a new Pi-compatible JSONL session,
  PLUS the source session's Magic Context state (compartments + facts)
  into the shared cortexkit database under the new session id.

  Supported pairs:
    --from opencode --to pi
    --from opencode --to omp

  Usage:
    npx @cortexkit/magic-context@latest doctor migrate \\
      --from opencode --to <pi|omp> --session ses_xxx [--max-messages N] [--dry-run]

  Fidelity:
    - text, reasoning text, tool calls, and tool results are preserved
    - assistant 'usage' fields carry real input/output/cache token counts
      from the source so Pi's getContextUsage() reports realistic numbers
    - reasoning signatures are stripped; step-start/step-finish are skipped
    - file bytes are replaced with <file omitted: name> markers
    - compartments + session_facts are copied to the new Pi session_id;
      compartment boundary message IDs are remapped to the corresponding
      Pi entry IDs (nearest-at-or-before for boundaries that don't have
      a direct message-level Pi entry), and compartment start/end ordinals
      are recomputed in the ordinal basis the Pi runtime reader produces

  Crash safety:
    - each migration is tracked in the shared DB's migration_pending journal
      and staged outside the sessions tree; an interrupted run is reconciled
      by phase on the next 'doctor migrate' or plain 'doctor' run, reusing the
      original Pi session id instead of minting a second one
`);
}

/** Human-readable summary lines for a recovery sweep (used by migrate + doctor). */
export function formatMigrationSweepLines(report: MigrationSweepReport): string[] {
    const lines: string[] = [];
    if (report.rolledForward > 0) {
        lines.push(
            `Recovered ${report.rolledForward} interrupted session migration(s) by completing the staged file rename.`,
        );
    }
    if (report.rolledBack > 0) {
        lines.push(
            `Rolled back ${report.rolledBack} incomplete session migration(s) that never committed shared state.`,
        );
    }
    if (report.completed > 0) {
        lines.push(`Cleared ${report.completed} finished session-migration journal row(s).`);
    }
    for (const row of report.lost) {
        lines.push(
            `LOST session migration content: source ${row.source_session_id} → ${row.target_harness} session ${row.pi_session_id}; expected file ${row.final_path} (sha256 ${row.content_sha256}). Re-run doctor migrate for this session to rebuild it.`,
        );
    }
    return lines;
}

export async function runMigrateCli(args: string[]): Promise<number> {
    try {
        const parsed = parseMigrateArgs(args);
        ensureValidOptions(parsed);
        const target = parsed.to === "omp" ? "OMP" : "Pi";
        const result = migrateOpenCodeSessionToPi({
            sessionId: parsed.session,
            maxMessages: parsed.maxMessages,
            dryRun: parsed.dryRun,
            piSessionsRoot: parsed.to === "omp" ? getOmpSessionsRoot() : undefined,
            targetHarness: parsed.to === "omp" ? "omp" : "pi",
        });
        if (result.recovery) {
            for (const line of formatMigrationSweepLines(result.recovery)) {
                console.log(line);
            }
        }
        const action = result.dryRun ? "Would write" : "Wrote";
        console.log(`${action} ${target} session JSONL:`);
        console.log(`  path: ${result.outputPath}`);
        console.log(`  pi-compatible session id: ${result.piSessionId}`);
        console.log(`  source messages: ${result.sourceMessageCount}`);
        console.log(`  migrated entries: ${result.messageCount}`);
        console.log(`  bytes: ${result.byteCount}`);
        console.log(`  compartments copied: ${result.compartmentsCopied}`);
        console.log(`  session facts copied: ${result.factsCopied}`);
        if (result.cortexkitSchemaVersionBefore !== undefined) {
            console.log(
                `  Magic Context schema: v${result.cortexkitSchemaVersionBefore} → v${result.cortexkitSchemaVersionAfter}`,
            );
        }
        console.log(
            `  compaction marker: ${result.compactionMarkerWritten ? "yes" : "no"}${
                result.compactionMarkerWritten
                    ? ` (boundary: ${result.compactionBoundaryEntryId}, first kept: ${result.compactionFirstKeptEntryId})`
                    : ""
            }`,
        );
        if (result.boundariesApproximated > 0) {
            console.log(
                `  boundaries approximated: ${result.boundariesApproximated} (nearest-at-or-before)`,
            );
        }
        if (result.migrationKey !== undefined) {
            console.log(
                `  journal: ${result.migrationKey.slice(0, 12)}…${
                    result.journalResumed ? " (resumed interrupted attempt)" : ""
                }`,
            );
        }
        if (!result.dryRun) {
            console.log(`${target} may need to be restarted to pick up the new session file.`);
            if (result.cortexkitSchemaVersionBefore !== undefined) {
                console.log(
                    "If OpenCode or another harness is running, restart it before creating new sessions so it reloads the same schema fence.",
                );
            }
        }
        return 0;
    } catch (error) {
        if (error instanceof Error && error.message === "HELP") {
            printMigrateHelp();
            return 0;
        }
        console.error(error instanceof Error ? error.message : String(error));
        console.error("Run `doctor migrate --help` for usage.");
        return 1;
    }
}
