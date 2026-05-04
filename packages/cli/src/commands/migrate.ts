import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import type { Database as DatabaseType } from "@magic-context/core/shared/sqlite";
import { Database } from "@magic-context/core/shared/sqlite";

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
    piSessionsRoot?: string;
    provider?: string;
    modelId?: string;
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
    dryRun: boolean;
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
    existsSync(path: string): boolean;
    mkdirSync(path: string, options?: { recursive?: boolean }): unknown;
    writeFileSync(path: string, data: string): unknown;
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

function defaultOpenCodeDbPath(): string {
    return join(homedir(), ".local", "share", "opencode", "opencode.db");
}

function defaultCortexkitDbPath(): string {
    return join(getMagicContextStorageDir(), "context.db");
}

function defaultPiSessionsRoot(): string {
    return join(homedir(), ".pi", "agent", "sessions");
}

function defaultFs(): FileSystemLike {
    return { existsSync, mkdirSync, writeFileSync };
}

function stmt<T>(db: DatabaseLike, sql: string): StatementLike<T> {
    return db.prepare(sql) as unknown as StatementLike<T>;
}

export function projectPathToPiDirSlug(projectPath: string): string {
    return `--${projectPath.replace(/^\/+|\/+$/g, "").replaceAll("/", "-")}--`;
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
     * Map from OpenCode message_id → the LAST Pi entry id derived from
     * that source message. Compartment boundary remapping uses this:
     * `start_message_id` / `end_message_id` reference OpenCode message
     * ids, and we want the corresponding LAST Pi entry (which captures
     * all parts of that source message).
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
}): BuildEntriesResult {
    const sessionUuid = generateUuidV7(params.now);
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

    const messageIdToLastPiEntryId = new Map<string, string>();
    const orderedSourceMessageIds: string[] = [];

    let parentId = boundary.id as string;
    for (const message of params.messages) {
        const role = roleFromMessage(message);
        if (!role) continue;
        const timestamp = isoFromMs(message.time_created, params.now);
        const tokens = tokensFromMessage(message);
        const usage = tokensToPiUsage(tokens);

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
                lastEntryIdForMessage = parentId;
            }
        }
        if (lastEntryIdForMessage !== null) {
            messageIdToLastPiEntryId.set(message.id, lastEntryIdForMessage);
            orderedSourceMessageIds.push(message.id);
        }
    }

    return {
        entries,
        piSessionId: sessionUuid,
        messageIdToLastPiEntryId,
        orderedSourceMessageIds,
    };
}

function fetchRows(db: DatabaseLike, sessionId: string, maxMessages: number | undefined) {
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
    const parts = ids.length
        ? stmt<OpenCodePartRow>(
              db,
              `SELECT id, message_id, time_created, data FROM part WHERE message_id IN (${ids.map(() => "?").join(",")}) ORDER BY time_created, id`,
          ).all(...ids)
        : [];

    return { session, sourceMessageCount, messages, parts };
}

/**
 * Translate an OpenCode boundary id to the equivalent Pi entry id.
 *
 * Strategy (in order):
 *   1. If the OpenCode message id maps directly to a Pi entry, use that.
 *   2. Otherwise find the nearest source message whose chronological
 *      position is at-or-before the missing one and use ITS Pi entry.
 *      "At-or-before" is by index in `orderedSourceMessageIds`.
 *   3. If no message at-or-before exists (boundary precedes the
 *      earliest migrated message), return undefined and the caller
 *      drops the compartment.
 *
 * Returns `{ piEntryId, exact }` so the caller can count approximations.
 */
function remapBoundaryId(
    openCodeMessageId: string,
    messageIdToLastPiEntryId: Map<string, string>,
    orderedSourceMessageIds: readonly string[],
): { piEntryId: string; exact: boolean } | undefined {
    const direct = messageIdToLastPiEntryId.get(openCodeMessageId);
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
    messageIdToLastPiEntryId: Map<string, string>;
    orderedSourceMessageIds: readonly string[];
    now: number;
    dryRun: boolean;
}): CopyMagicContextStateResult {
    const sourceCompartments = stmt<CortexkitCompartmentRow>(
        args.cortexkitDb,
        `SELECT sequence, start_message, end_message, start_message_id, end_message_id,
              title, content, created_at
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
    const remappedCompartments: Array<{
        sequence: number;
        start_message: number;
        end_message: number;
        start_message_id: string;
        end_message_id: string;
        title: string;
        content: string;
    }> = [];

    for (const c of sourceCompartments) {
        const startRemap = remapBoundaryId(
            c.start_message_id,
            args.messageIdToLastPiEntryId,
            args.orderedSourceMessageIds,
        );
        const endRemap = remapBoundaryId(
            c.end_message_id,
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
        });
    }

    if (args.dryRun) {
        return {
            compartmentsCopied: remappedCompartments.length,
            factsCopied: sourceFacts.length,
            boundariesApproximated,
            lastCompartmentEndPiEntryId: remappedCompartments.at(-1)?.end_message_id,
        };
    }

    // Insert compartments + facts under (harness='pi', session_id=<new>).
    // The shared DB schema includes `harness TEXT NOT NULL DEFAULT 'opencode'`
    // on both tables, and (session_id, sequence) is UNIQUE on compartments —
    // new Pi session uuid means no conflict.
    const insertCompartment = stmt(
        args.cortexkitDb,
        `INSERT INTO compartments (
       session_id, sequence, start_message, end_message,
       start_message_id, end_message_id, title, content,
       created_at, harness
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pi')`,
    );
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
            args.now,
        );
    }

    const insertFact = stmt(
        args.cortexkitDb,
        `INSERT INTO session_facts (
       session_id, category, content, created_at, updated_at, harness
     ) VALUES (?, ?, ?, ?, ?, 'pi')`,
    );
    for (const f of sourceFacts) {
        insertFact.run(args.piSessionId, f.category, f.content, f.created_at, f.updated_at);
    }

    return {
        compartmentsCopied: remappedCompartments.length,
        factsCopied: sourceFacts.length,
        boundariesApproximated,
        lastCompartmentEndPiEntryId: remappedCompartments.at(-1)?.end_message_id,
    };
}

function ensureValidOptions(
    opts: MigrateCliOptions,
): asserts opts is Required<Pick<MigrateCliOptions, "from" | "to" | "session">> &
    MigrateCliOptions {
    if (!opts.from) throw new Error("Missing required flag: --from <opencode>");
    if (!opts.to) throw new Error("Missing required flag: --to <pi>");
    if (opts.from !== "opencode" || opts.to !== "pi") {
        if (opts.from === "pi" && opts.to === "opencode") {
            throw new Error(
                "Migration pi → opencode is not yet supported (V1 supports only opencode → pi)",
            );
        }
        throw new Error(
            `Unsupported migration: ${opts.from} → ${opts.to} (V1 supports only opencode → pi)`,
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
    const db = opts.db ?? new Database(opencodeDbPath, { readonly: true });

    // Cortexkit DB: when not provided explicitly, open the canonical
    // shared DB read-write (we'll INSERT into compartments + session_facts).
    // Pass null to skip the cortexkit copy entirely (legacy V1 behavior).
    let cortexkitDb: DatabaseLike | null;
    let ownsCortexkitDb = false;
    if (opts.cortexkitDb === null) {
        cortexkitDb = null;
    } else if (opts.cortexkitDb !== undefined) {
        cortexkitDb = opts.cortexkitDb;
    } else {
        try {
            cortexkitDb = new Database(defaultCortexkitDbPath());
            ownsCortexkitDb = true;
        } catch {
            // If the cortexkit DB doesn't exist yet (Magic Context never
            // loaded on this machine), skip the copy gracefully — the
            // migration still produces a usable Pi JSONL.
            cortexkitDb = null;
        }
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
        const buildResult = buildPiEntries({
            session,
            messages,
            parts,
            now,
            provider,
            modelId,
        });
        // Copy magic-context durable state (compartments + facts) to the
        // new Pi session_id when the cortexkit DB is reachable.
        let copyResult: CopyMagicContextStateResult = {
            compartmentsCopied: 0,
            factsCopied: 0,
            boundariesApproximated: 0,
        };
        if (cortexkitDb !== null) {
            copyResult = copyMagicContextState({
                cortexkitDb,
                sourceSessionId: session.id,
                piSessionId: buildResult.piSessionId,
                messageIdToLastPiEntryId: buildResult.messageIdToLastPiEntryId,
                orderedSourceMessageIds: buildResult.orderedSourceMessageIds,
                now: now.getTime(),
                dryRun: Boolean(opts.dryRun),
            });
        }

        const compactionMarker = insertCompactionMarker(
            buildResult.entries,
            copyResult.lastCompartmentEndPiEntryId,
        );

        const outputPath = join(
            outputDir,
            `${formatPiFilenameTimestamp(now)}_${buildResult.piSessionId}.jsonl`,
        );
        const jsonl = `${buildResult.entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;

        if (!opts.dryRun) {
            if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
            fs.writeFileSync(outputPath, jsonl);
        }

        return {
            outputPath,
            piSessionId: buildResult.piSessionId,
            messageCount: buildResult.entries.length - 2,
            byteCount: Buffer.byteLength(jsonl, "utf8"),
            sourceMessageCount,
            compartmentsCopied: copyResult.compartmentsCopied,
            factsCopied: copyResult.factsCopied,
            boundariesApproximated: copyResult.boundariesApproximated,
            compactionMarkerWritten: compactionMarker.written,
            compactionBoundaryEntryId: compactionMarker.boundaryEntryId,
            compactionFirstKeptEntryId: compactionMarker.firstKeptEntryId,
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

  Copy OpenCode session message content into a new Pi JSONL session,
  PLUS the source session's Magic Context state (compartments + facts)
  into the shared cortexkit database under the new Pi session id.

  Supported pairs (V1):
    --from opencode --to pi

  Usage:
    bunx --bun @cortexkit/opencode-magic-context@latest doctor migrate \\
      --from opencode --to pi --session ses_xxx [--max-messages N] [--dry-run]

  Fidelity:
    - text, reasoning text, tool calls, and tool results are preserved
    - assistant 'usage' fields carry real input/output/cache token counts
      from the source so Pi's getContextUsage() reports realistic numbers
    - reasoning signatures are stripped; step-start/step-finish are skipped
    - file bytes are replaced with <file omitted: name> markers
    - compartments + session_facts are copied to the new Pi session_id;
      compartment boundary message IDs are remapped to the corresponding
      Pi entry IDs (nearest-at-or-before for boundaries that don't have
      a direct message-level Pi entry)
`);
}

export async function runMigrateCli(args: string[]): Promise<number> {
    try {
        const parsed = parseMigrateArgs(args);
        ensureValidOptions(parsed);
        const result = migrateOpenCodeSessionToPi({
            sessionId: parsed.session,
            maxMessages: parsed.maxMessages,
            dryRun: parsed.dryRun,
        });
        const action = result.dryRun ? "Would write" : "Wrote";
        console.log(`${action} Pi session JSONL:`);
        console.log(`  path: ${result.outputPath}`);
        console.log(`  pi session id: ${result.piSessionId}`);
        console.log(`  source messages: ${result.sourceMessageCount}`);
        console.log(`  migrated entries: ${result.messageCount}`);
        console.log(`  bytes: ${result.byteCount}`);
        console.log(`  compartments copied: ${result.compartmentsCopied}`);
        console.log(`  session facts copied: ${result.factsCopied}`);
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
        if (!result.dryRun) {
            console.log("Pi may need to be restarted to pick up the new session file.");
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
