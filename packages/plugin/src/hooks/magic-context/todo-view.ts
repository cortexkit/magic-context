/**
 * Todo state synthesis — synthetic todowrite injection.
 *
 * Instead of inventing a custom `<current-todos>` block (which agents would
 * need to learn to parse), we synthesize a realistic `todowrite` tool part
 * and inject it into the latest assistant message on cache-busting passes.
 * The agent reads it through their existing todowrite-tracking mental model:
 * the wire shape is identical to OpenCode's stored todowrite tool parts
 * (`{type: "tool", callID, tool: "todowrite", state: {input, output, ...}}`).
 *
 * Cache safety:
 *   - Snapshot capture (in hook-handlers.ts on tool.execute.after) writes DB
 *     only — no message mutation.
 *   - Injection happens in transform-postprocess-phase.ts AFTER tagging and
 *     AFTER applyPendingOperations, so the synthetic part never gets tagged
 *     and is invisible to ctx_reduce and heuristic cleanup.
 *   - The synthetic callID is deterministic (sha256(stateJson)) so a stable
 *     snapshot produces a stable wire shape across passes; on defer passes we
 *     re-inject the same part at the same anchor, idempotent via callID match.
 *
 * Wire shape verified against:
 *   - OpenCode source: ~/Work/OSS/opencode/packages/opencode/src/tool/todo.ts
 *   - Production OpenCode DB sample: part where data LIKE '%"tool":"todowrite"%'
 */

import { createHash } from "node:crypto";

// The statuses and priorities OpenCode's `todowrite` describes to the model.
// OpenCode's todo schema declares `status` and `priority` as plain strings and
// names these values only in their descriptions, so agents can write others
// (for example `blocked`). They are therefore not a closed set here: capture
// and replay keep any other value as written. Pi's own `todowrite` tool uses
// them as its parameter enum.
export const TODO_STATUS_PENDING = "pending";
export const TODO_STATUS_IN_PROGRESS = "in_progress";
export const TODO_STATUS_COMPLETED = "completed";
export const TODO_STATUS_CANCELLED = "cancelled";

export const TODO_PRIORITY_HIGH = "high";
export const TODO_PRIORITY_MEDIUM = "medium";
export const TODO_PRIORITY_LOW = "low";

export const TODO_STATUSES = [
    TODO_STATUS_PENDING,
    TODO_STATUS_IN_PROGRESS,
    TODO_STATUS_COMPLETED,
    TODO_STATUS_CANCELLED,
] as const;

export const TODO_PRIORITIES = [
    TODO_PRIORITY_HIGH,
    TODO_PRIORITY_MEDIUM,
    TODO_PRIORITY_LOW,
] as const;

interface TodoInputItem {
    content: string;
    status: string;
    priority?: string;
}

export interface TodoItem {
    content: string;
    status: string;
    priority: string;
}

/**
 * The only statuses that end a todo. Every other status, including custom ones
 * such as `blocked`, counts as still open, so a list keeps its reminder until
 * each item is completed or cancelled.
 */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
    TODO_STATUS_COMPLETED,
    TODO_STATUS_CANCELLED,
]);

/**
 * The set of statuses real OpenCode `todowrite` excludes when computing the
 * tool-part `title` (e.g. "3 todos"). OpenCode counts only `completed` as
 * "done"; cancelled and custom-status todos still appear in the title's
 * active count.
 *
 * Source: ~/Work/OSS/opencode/packages/opencode/src/tool/todo.ts:47-52.
 */
export const TITLE_DONE_STATUSES: ReadonlySet<string> = new Set([TODO_STATUS_COMPLETED]);

const SYNTHETIC_CALL_ID_PREFIX = "mc_synthetic_todo_";

/**
 * The snapshot an explicit empty `todowrite` list stores. It builds no
 * reminder, so capture stores it as well when a `todowrite` list can't be
 * read: keeping the older snapshot instead would replay an outdated plan as
 * the agent's latest one.
 */
export const CLEARED_TODO_STATE_JSON = "[]";

/**
 * Normalize a `todowrite` args.todos array into a stable JSON string.
 *
 * Any status and priority string is kept as written, the way OpenCode's todo
 * schema accepts it; a missing priority becomes `medium`. Returns `null` when
 * the list can't be read: it is not an array, or an item is not an object with
 * a string `content`, a non-empty string `status`, and a `priority` that is
 * either absent or a string.
 *
 * The output always lists `content`, `status`, then `priority` and drops other
 * fields, so the same list produces the same JSON (and the same synthetic call
 * id) on every pass and after a JSON round trip. Used by the snapshot capture
 * path (`hook-handlers.ts`).
 */
export function normalizeTodoStateJson(todos: unknown): string | null {
    if (!Array.isArray(todos)) return null;

    const normalized: TodoItem[] = [];
    for (const todo of todos) {
        if (!isTodoItem(todo)) return null;
        normalized.push({
            content: todo.content,
            status: todo.status,
            priority: todo.priority ?? TODO_PRIORITY_MEDIUM,
        });
    }

    return JSON.stringify(normalized);
}

/**
 * A synthetic OpenCode tool part matching the wire shape of a real
 * `todowrite` tool result.
 *
 * NOTE — deliberate field omissions vs OpenCode `ToolPart`:
 *   - `id`, `sessionID`, `messageID`: OpenCode generates these from
 *     `Identifier.ascending(...)` for parts that originate from real tool
 *     calls and persist to the OpenCode DB. The synthetic part is
 *     transform-only (never persisted to OpenCode's DB), so these fields
 *     would be meaningless. The OpenCode wire serializer
 *     (`MessageV2.toModelMessagesEffect`) only reads `part.state.*`,
 *     `part.callID`, `part.tool`, and `part.metadata` — none of the
 *     omitted fields participate in wire serialization. Verified against
 *     ~/Work/OSS/opencode/packages/opencode/src/session/message-v2.ts:851-884.
 */
export interface SyntheticTodoPart {
    type: "tool";
    callID: string;
    tool: "todowrite";
    state: {
        status: "completed";
        input: { todos: TodoItem[] };
        output: string;
        title: string;
        metadata: { todos: TodoItem[]; truncated: false };
        time: { start: number; end: number };
    };
    /** Marker so other plugin code can detect synthetic parts and skip them. */
    syntheticTodoMarker: true;
}

/**
 * Build a synthetic todowrite tool part from a normalized state JSON.
 * Returns `null` if the state can't be read, is empty, or all todos are
 * terminal — in those cases the agent doesn't need a reminder.
 */
export function buildSyntheticTodoPart(stateJson: string): SyntheticTodoPart | null {
    const todos = parseTodoState(stateJson);
    if (todos === null || todos.length === 0) return null;

    // Skip if every todo is terminal — agent has nothing in flight, no point reminding.
    if (todos.every((t) => TERMINAL_STATUSES.has(t.status))) return null;

    const callID = computeSyntheticCallId(stateJson);
    // Match OpenCode's `${todos.length - completed.length} todos` exactly:
    // exclude only `completed`, NOT `cancelled`. See todo.ts:47-52.
    const activeCount = todos.filter((t) => !TITLE_DONE_STATUSES.has(t.status)).length;

    // Match OpenCode's todowrite output exactly: pretty-printed JSON of the full todos array.
    // See ~/Work/OSS/opencode/packages/opencode/src/tool/todo.ts:46-52.
    const output = JSON.stringify(todos, null, 2);

    // `time.start === time.end` is a deliberate signal that this is synthetic.
    // OpenCode itself never produces a zero-duration tool execution.
    const ts = 0;

    return {
        type: "tool",
        callID,
        tool: "todowrite",
        state: {
            status: "completed",
            input: { todos },
            output,
            title: `${activeCount} todos`,
            metadata: { todos, truncated: false },
            time: { start: ts, end: ts },
        },
        syntheticTodoMarker: true,
    };
}

/**
 * Compute a deterministic call_id from the snapshot JSON. Stable for stable
 * state; identical state across passes produces identical callID, which
 * gives byte-identical wire shape on both cache-busting and defer passes.
 *
 * Format chosen to clearly distinguish from real provider-generated IDs:
 *   - Anthropic: `toolu_<24 base62 chars>`
 *   - OpenAI:    `call_<random>`
 *   - Synthetic: `mc_synthetic_todo_<16 hex chars>`
 *
 * Providers do not validate callID format — they only require matching IDs
 * between tool_use and tool_result.
 */
export function computeSyntheticCallId(stateJson: string): string {
    const hash = createHash("sha256").update(stateJson).digest("hex").slice(0, 16);
    return `${SYNTHETIC_CALL_ID_PREFIX}${hash}`;
}

/**
 * Detect whether a part is a synthetic todo part this module produced.
 * Used to skip synthetic parts during tagging and other tool-walk passes.
 */
export function isSyntheticTodoPart(part: unknown): boolean {
    if (part === null || typeof part !== "object") return false;
    const p = part as {
        syntheticTodoMarker?: unknown;
        callID?: unknown;
        type?: unknown;
        tool?: unknown;
    };
    if (p.syntheticTodoMarker === true) return true;
    // Defensive fallback: detect by callID prefix in case the marker field
    // gets stripped during serialization somewhere downstream. Tightened to
    // also require the part to look like a todowrite tool part — a stray
    // object with a synthetic-prefixed callID elsewhere should not match.
    return (
        p.type === "tool" &&
        p.tool === "todowrite" &&
        typeof p.callID === "string" &&
        p.callID.startsWith(SYNTHETIC_CALL_ID_PREFIX)
    );
}

function parseTodoState(stateJson: string): TodoItem[] | null {
    if (stateJson.length === 0) return null;
    try {
        const parsed = JSON.parse(stateJson);
        if (!Array.isArray(parsed)) return null;
        const result: TodoItem[] = [];
        for (const item of parsed) {
            if (!isTodoItem(item)) return null;
            result.push({
                content: item.content,
                status: item.status,
                priority: item.priority ?? TODO_PRIORITY_MEDIUM,
            });
        }
        return result;
    } catch {
        return null;
    }
}

function isTodoItem(value: unknown): value is TodoInputItem {
    if (value === null || typeof value !== "object") return false;
    const todo = value as Record<string, unknown>;
    return (
        typeof todo.content === "string" &&
        typeof todo.status === "string" &&
        todo.status.length > 0 &&
        (todo.priority === undefined || typeof todo.priority === "string")
    );
}
