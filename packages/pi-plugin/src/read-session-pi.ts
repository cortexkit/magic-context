/**
 * Pi-side raw session reader.
 *
 * Reads from `pi.sessionManager.getBranch()` and produces the same
 * `RawMessage[]` shape OpenCode uses for historian input. The shared
 * `read-session-formatting.ts` and `read-session-chunk.ts` modules
 * are duck-typed against `parts: unknown[]` with specific field
 * conventions, so by synthesizing OpenCode-compatible parts here we
 * reuse 100% of the formatting/chunking/trigger logic unchanged.
 *
 * # Shape mapping
 *
 * Pi's session branch is a `SessionEntry[]` from
 * `@earendil-works/pi-coding-agent` core/session-manager.d.ts:
 *
 *   SessionMessageEntry { id, parentId, type: "message", timestamp,
 *                         message: AgentMessage }
 *
 * Where `AgentMessage` is one of:
 *   - UserMessage:     { role: "user", content: string | (Text|Image)[] }
 *   - AssistantMessage:{ role: "assistant", content: (Text|Thinking|ToolCall)[] }
 *   - ToolResultMessage:{ role: "toolResult", toolCallId, toolName,
 *                         content: (Text|Image)[] }
 *
 * Shared `RawMessage` is `{ ordinal, id, role, parts: unknown[] }`.
 *
 * Mapping:
 *   - User & assistant messages each become one RawMessage with parts
 *     synthesized in OpenCode's shape.
 *   - ToolResult messages get folded into the IMMEDIATELY-FOLLOWING
 *     user message as `{ type: "tool", tool, callID, state: { output } }`
 *     parts. This matches OpenCode's convention: tool results live in
 *     the next user turn, paired by callID with the assistant's
 *     prior tool_use parts.
 *   - When a tool-result run has no following user message (live tail
 *     ends with `assistant + tool_result`), we emit a synthetic user
 *     RawMessage with no stable id (id="" and ordinal still
 *     incremented). Formatting treats it as a normal user turn.
 *
 * # Ordinals
 *
 * Ordinals are assigned by walking the branch in order and counting
 * monotonically from 1. The mapping is stable for the duration of a
 * Pi session because `getBranch()` returns the linear sequence from
 * root to leaf — entries are append-only on the active branch.
 *
 * # Entry types we skip
 *
 * `getBranch()` may return non-message entries (thinking_level_change,
 * model_change, compaction, branch_summary, custom, label,
 * session_info, custom_message). We skip everything except
 * SessionMessageEntry — those carry no `parts` content the historian
 * needs to summarize. Future steps may surface compaction/branch
 * summary entries differently if needed.
 *
 * # Why not use Pi's compaction directly?
 *
 * Pi has its own compaction primitive (CompactionEntry +
 * `pi.compact()`). Magic Context replaces it with historian-driven
 * compartments because:
 *   1. Compartments preserve a structured XML view of older turns
 *      (categorized facts, ranges, dates) that Pi's monolithic
 *      summary text can't.
 *   2. Cross-harness consistency: OpenCode users see the same
 *      `<session-history>` shape regardless of which harness ran the
 *      historian.
 *   3. Pi's compaction lives in the session JSONL file; magic-context
 *      compartments live in the shared cortexkit DB scoped by
 *      sessionId. Different storage, different lifecycle.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RawMessage } from "@magic-context/core/hooks/magic-context/read-session-raw";

/**
 * Prefix for the synthetic-user RawMessage id emitted when a run of `toolResult`
 * entries is folded into a user turn (the toolResult→assistant transition). The
 * id is `${SYNTH_USER_ID_PREFIX}${firstRealToolResultEntryId}` — NOT a real
 * SessionEntry id. Pi's `getBranch()`/compaction replay matches against real
 * `entry.id`, so any consumer that needs a replay-safe real entry id must detect
 * this prefix and handle it — but the handling differs by consumer:
 *   • compaction-boundary selection (`findFirstKeptEntryId`) DEFERS — it returns
 *     null when the kept-start lands on a synthetic-user fold, so the marker is
 *     re-tried next pass rather than cutting the tail at an orphaned toolResult.
 *   • boundary trimming (`trimPiMessagesToBoundary`) RESOLVES — it strips the
 *     prefix to recover the underlying real toolResult entry id and trims there.
 * Exported so those consumers share one definition instead of re-deriving the
 * `synth-user-` literal.
 */
export const SYNTH_USER_ID_PREFIX = "synth-user-";

/**
 * The single source of truth for a Pi message's durable stable id.
 *
 * Pi `AgentMessage`s carry no stable per-message id at the type level — the
 * SessionEntry layer wraps them with a real `entry.id` in the JSONL store. This
 * resolver returns that real id whenever it can, because real entry ids are
 * POSITION-INDEPENDENT: they survive the structural shifts the visible message
 * array undergoes every pass (compaction-marker prefix trim, custom_message
 * inserts from other extensions). The `pi-msg-${index}-...` fallback is
 * index-based and therefore DRIFTS across those shifts — any durable state keyed
 * on a drifting id (tags, source_contents, caveman depth, drop-state, reasoning
 * watermark, placeholder ids) silently orphans → prompt-cache bust + resurfaced
 * reasoning/tools. So the fallback is a last resort, used only for messages with
 * no resolvable real entry id (synthetic compaction summaries, custom_message
 * wrappers).
 *
 * Precedence (locked by design review):
 *   1. `entryIdByRef.get(msg)` — reference identity. Splice-safe, but MISSES a
 *      message whose object was cloned this pass (tagging/drops replace
 *      working[i] with a spread copy). Best-effort first try.
 *   2. `entryIds[index]` — positional real entry id, aligned to the array the
 *      caller resolved ids against. MANDATORY fallback: it covers the cloned-ref
 *      case (1) misses, and is valid wherever the caller passes an entryIds array
 *      still index-aligned to `msg`'s array (pre-injection-splice consumers).
 *   3. `pi-msg-${index}-${ts}-${role}` — unstable index id. Only when neither real
 *      id resolves.
 *
 * All Pi stable-id consumers MUST route through this one function so the id a
 * message gets is identical across the transcript-tag path, the reasoning-replay
 * lookup path, the heuristic-cleanup owner path, and the compaction-trim path —
 * any divergence makes cross-path lookups (e.g. reasoning's messageIdToMaxTag)
 * silently miss.
 */
export function resolvePiStableId(
	msg: unknown,
	index: number,
	entryIds?: readonly (string | undefined)[],
	entryIdByRef?: ReadonlyMap<object, string>,
): string | undefined {
	if (!msg || typeof msg !== "object") return undefined;
	// 1. Reference identity — preferred, splice-safe (misses cloned objects).
	const byRef = entryIdByRef?.get(msg as object);
	if (typeof byRef === "string" && byRef.length > 0) return byRef;
	// 2. Positional real entry id — mandatory fallback (covers cloned-ref misses).
	const positional = entryIds?.[index];
	if (typeof positional === "string" && positional.length > 0)
		return positional;
	// 3. Unstable index id — last resort (synthetic / unresolved messages only).
	const m = msg as { role?: string; timestamp?: number };
	const role = m.role ?? "unknown";
	return typeof m.timestamp === "number"
		? `pi-msg-${index}-${m.timestamp}-${role}`
		: `pi-msg-${index}-${role}`;
}

export function isMidTurnPi(
	event: unknown,
	_sessionId: string,
	branchEntries?: readonly unknown[] | null,
): boolean {
	const messages = (event as { messages?: unknown })?.messages;
	if (!Array.isArray(messages)) return false;

	let latestAssistantIndex = -1;
	let latestAssistant: Record<string, unknown> | null = null;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg !== null && typeof msg === "object") {
			const record = msg as Record<string, unknown>;
			if (record.role === "assistant") {
				latestAssistantIndex = i;
				latestAssistant = record;
				break;
			}
		}
	}

	if (latestAssistant === null) return false;
	if (hasRealUserAfter(messages, latestAssistantIndex, branchEntries))
		return false;
	if (latestAssistant.stopReason === "toolUse") return true;

	const toolCallIds = getToolCallIds(latestAssistant.content);
	if (toolCallIds.size === 0) return false;

	const pairedToolResultIds = new Set<string>();
	for (const msg of messages.slice(latestAssistantIndex + 1)) {
		if (msg === null || typeof msg !== "object") continue;
		const record = msg as Record<string, unknown>;
		if (record.role !== "toolResult") continue;
		if (typeof record.toolCallId === "string") {
			pairedToolResultIds.add(record.toolCallId);
		}
	}

	for (const id of toolCallIds) {
		if (!pairedToolResultIds.has(id)) return true;
	}
	return false;
}

function hasRealUserAfter(
	messages: readonly unknown[],
	latestAssistantIndex: number,
	branchEntries?: readonly unknown[] | null,
): boolean {
	if (!branchEntries) return false;
	const genuineUserMessages = new Set<object>();
	for (const entry of branchEntries) {
		if (entry === null || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		if (record.type !== "message") continue;
		const message = record.message;
		if (message === null || typeof message !== "object") continue;
		if ((message as Record<string, unknown>).role === "user") {
			genuineUserMessages.add(message);
		}
	}

	// A wire-shaped user role is not enough: steer/custom entries can be converted
	// to user messages for the model. Only a genuine branch message ends the lock.
	for (const msg of messages.slice(latestAssistantIndex + 1)) {
		if (
			msg !== null &&
			typeof msg === "object" &&
			genuineUserMessages.has(msg)
		) {
			return true;
		}
	}
	return false;
}

function getToolCallIds(content: unknown): Set<string> {
	const ids = new Set<string>();
	if (!Array.isArray(content)) return ids;
	for (const item of content) {
		if (item === null || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		if (record.type === "toolCall" && typeof record.id === "string") {
			ids.add(record.id);
		}
	}
	return ids;
}

/**
 * Read the active Pi session branch and synthesize an OpenCode-shape
 * RawMessage[]. Returns an empty array if no branch is available.
 *
 * The function is pure given `getBranch()` is pure (which it is — Pi
 * documents it as a defensive copy). Safe to call repeatedly per
 * transform pass; the per-transform cache (`withRawSessionMessageCache`
 * from the shared module) wraps individual sessionId lookups so
 * repeated calls inside a single trigger evaluation don't re-walk the
 * branch.
 */
export interface PiSessionSnapshot {
	branchEntries: readonly unknown[];
	rawMessages: RawMessage[];
}

export function readPiSessionSnapshot(
	ctx: ExtensionContext,
): PiSessionSnapshot {
	const sm = ctx.sessionManager;
	if (sm === undefined) return { branchEntries: [], rawMessages: [] };
	const getBranch = (sm as { getBranch?: (fromId?: string) => unknown[] })
		.getBranch;
	if (typeof getBranch !== "function")
		return { branchEntries: [], rawMessages: [] };

	let entries: unknown[];
	try {
		entries = getBranch.call(sm);
	} catch {
		return { branchEntries: [], rawMessages: [] };
	}
	if (!Array.isArray(entries)) return { branchEntries: [], rawMessages: [] };

	return {
		branchEntries: entries,
		rawMessages: convertEntriesToRawMessages(entries),
	};
}

export function readPiSessionMessages(ctx: ExtensionContext): RawMessage[] {
	return readPiSessionSnapshot(ctx).rawMessages;
}

/**
 * Resolve the LAST model the session was using, from the JSONL branch's
 * `model_change` entries (shape: `{type:"model_change", provider, modelId}`).
 * Returned as a `provider/modelId` key matching resolvePiContextModelKey.
 *
 * Used to seed liveModelBySession on the first context pass after a process
 * restart: liveModelBySession is in-memory, so after a restart previousModelKey
 * is undefined and a model change that happened while the process was down would
 * NOT be detected — leaking the previous model's detected-context-limit /
 * reasoning-watermark / historian-failure state into the new model. Seeding from
 * the JSONL lets the first-pass model-change comparison fire correctly. Mirrors
 * OpenCode seeding liveModelBySession from the latest assistant message's model.
 *
 * Returns undefined when the branch has no model_change entry (older sessions /
 * edge cases) — the caller then leaves previousModelKey undefined, preserving
 * today's no-reset behavior (no regression).
 *
 * Takes the ALREADY-READ branch entries (not ctx): the context handler reads
 * `getBranch()` exactly once per event (a perf invariant — the branch is the
 * whole JSONL); this must reuse that read, not re-walk.
 */
export function findLastModelKeyFromBranch(
	entries: readonly unknown[] | null | undefined,
): string | undefined {
	if (!Array.isArray(entries)) return undefined;

	// Walk backwards: the last model_change is the session's current model.
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (!e || typeof e !== "object") continue;
		const v = e as { type?: unknown; provider?: unknown; modelId?: unknown };
		if (v.type !== "model_change") continue;
		if (
			typeof v.provider === "string" &&
			v.provider.length > 0 &&
			typeof v.modelId === "string" &&
			v.modelId.length > 0
		) {
			return `${v.provider}/${v.modelId}`;
		}
	}
	return undefined;
}

function rawEntryVersion(entry: MessageEntry): string | number {
	const record = entry as unknown as Record<string, unknown>;
	const updated = record.updatedAt ?? record.updated_at ?? record.timestamp;
	return typeof updated === "string" || typeof updated === "number"
		? updated
		: entry.id;
}

function attachPiPartVersion(
	parts: unknown[],
	version: string | number,
): unknown[] {
	return parts.map((part) => {
		if (part === null || typeof part !== "object" || Array.isArray(part))
			return part;
		try {
			Object.defineProperty(part, "__magicContextPartUpdatedAt", {
				value: version,
				enumerable: false,
				configurable: true,
			});
		} catch {
			// The recursive content fingerprint still changes when a part cannot be annotated.
		}
		return part;
	});
}

/**
 * Pure conversion exposed for unit testing — call sites in production
 * always go through `readPiSessionMessages`.
 */
export function convertEntriesToRawMessages(
	entries: readonly unknown[],
): RawMessage[] {
	const result: RawMessage[] = [];
	let nextOrdinal = 1;

	// Buffer for tool-result runs waiting to fold into the next user
	// message. Each item is the synthesized "tool" part shape.
	let pendingToolParts: unknown[] = [];
	// Track the first real toolResult entry id contributing to the current
	// pending buffer. When tool-results fold into a synthetic user (the
	// toolResult→assistant transition pattern, which is the common case
	// for tool-heavy sessions), we need the synthetic user to carry a
	// real, lookup-able entry id rather than an empty string.
	//
	// Without this, downstream consumers break:
	//   - `read-session-chunk.ts` puts `messageId: ""` into `chunk.lines`,
	//     which then propagates into compartment `end_message_id`, leaving
	//     the magic-context inject path unable to trim the visible message
	//     tail to the compartment boundary (Bug X2).
	//   - Pi compaction-marker placement via `findFirstKeptEntryId` lands
	//     on the synthetic ordinal and either skips (returns null → no
	//     marker written, JSONL grows unbounded, Bug X1) or returns an
	//     unusable id.
	let pendingFirstRealId = "";
	let pendingFirstRealVersion: string | number = "";

	for (const entry of entries) {
		if (!isMessageEntry(entry)) {
			// Skip non-message entries (thinking_level_change, model_change,
			// compaction, branch_summary, custom, label, session_info,
			// custom_message). They don't carry parts the historian needs.
			continue;
		}

		const msg = entry.message;
		const role = (msg as { role?: string }).role;

		if (role === "toolResult") {
			const version = rawEntryVersion(entry);
			pendingToolParts.push(
				...attachPiPartVersion(synthesizeToolResultParts(msg), version),
			);
			if (pendingFirstRealId === "") {
				pendingFirstRealId = entry.id;
				pendingFirstRealVersion = version;
			}
			continue;
		}

		if (role === "user") {
			// Fold any pending tool-result parts into THIS user's parts
			// (they precede the user's own content in real conversation
			// order, matching OpenCode's flow).
			const version = rawEntryVersion(entry);
			const parts: unknown[] = [
				...pendingToolParts,
				...attachPiPartVersion(synthesizeUserParts(msg), version),
			];
			pendingToolParts = [];
			pendingFirstRealId = "";
			pendingFirstRealVersion = "";
			result.push({
				ordinal: nextOrdinal++,
				id: entry.id,
				role: "user",
				parts,
				version,
			});
			continue;
		}

		if (role === "assistant") {
			// If there are pending tool-result parts when we hit an
			// assistant, fold them as a synthetic user turn before
			// emitting the assistant. This is THE common pattern in
			// tool-heavy sessions (the agent finishes a tool round and
			// fires the next assistant turn without a user in between),
			// so the synthetic user must carry a real entry id — the
			// first toolResult that was folded in.
			if (pendingToolParts.length > 0) {
				result.push({
					ordinal: nextOrdinal++,
					id: `${SYNTH_USER_ID_PREFIX}${pendingFirstRealId}`,
					role: "user",
					parts: pendingToolParts,
					version: pendingFirstRealVersion,
				});
				pendingToolParts = [];
				pendingFirstRealId = "";
				pendingFirstRealVersion = "";
			}

			const version = rawEntryVersion(entry);
			result.push({
				ordinal: nextOrdinal++,
				id: entry.id,
				role: "assistant",
				parts: attachPiPartVersion(synthesizeAssistantParts(msg), version),
				version,
			});
			continue;
		}

		// Unknown role — pass through with raw parts so formatting can
		// drop them into "noise" lines. Forward compatibility for new
		// AgentMessage roles Pi may add later.
		result.push({
			ordinal: nextOrdinal++,
			id: entry.id,
			role: typeof role === "string" ? role : "unknown",
			parts: [],
			version: rawEntryVersion(entry),
		});
	}

	// Tail tool-results with no following user message: emit synthetic
	// user turn so they're still part of the chunked history. As with
	// the assistant-trigger case above, this synthetic user must carry
	// a real entry id (the first folded toolResult).
	if (pendingToolParts.length > 0) {
		result.push({
			ordinal: nextOrdinal,
			id: `${SYNTH_USER_ID_PREFIX}${pendingFirstRealId}`,
			role: "user",
			parts: pendingToolParts,
			version: pendingFirstRealVersion,
		});
	}

	return result;
}

interface MessageEntry {
	type: "message";
	id: string;
	message: unknown;
}

function isMessageEntry(value: unknown): value is MessageEntry {
	if (value === null || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	if (v.type !== "message") return false;
	if (typeof v.id !== "string") return false;
	if (v.message === null || typeof v.message !== "object") return false;
	return true;
}

/**
 * User content can be `string` or `(TextContent | ImageContent)[]`.
 * Synthesize OpenCode-shape `{ type: "text", text }` parts (image
 * parts are dropped — historian ignores them anyway).
 */
function synthesizeUserParts(msg: unknown): unknown[] {
	const m = msg as { content?: unknown };
	if (typeof m.content === "string") {
		if (m.content.trim().length === 0) return [];
		return [{ type: "text", text: m.content }];
	}
	if (!Array.isArray(m.content)) return [];

	const parts: unknown[] = [];
	for (const c of m.content) {
		if (c === null || typeof c !== "object") continue;
		const cc = c as Record<string, unknown>;
		if (cc.type === "text" && typeof cc.text === "string") {
			parts.push({ type: "text", text: cc.text });
		}
		// Skip image content — historian doesn't summarize images and
		// embedding image bytes in chunks would blow the token budget.
	}
	return parts;
}

/**
 * Assistant content is `(TextContent | ThinkingContent | ToolCall)[]`.
 * We map:
 *   - text  → `{ type: "text", text }` (kept)
 *   - thinking → DROPPED (historian doesn't summarize reasoning)
 *   - toolCall → `{ type: "tool", tool: name, callID: id,
 *                   state: { input: arguments, output: undefined } }`
 *
 * Tool calls without a paired result (output undefined) still surface
 * in TC: lines so historian sees what was attempted.
 */
function synthesizeAssistantParts(msg: unknown): unknown[] {
	const m = msg as { content?: unknown };
	if (!Array.isArray(m.content)) return [];

	const parts: unknown[] = [];
	for (const c of m.content) {
		if (c === null || typeof c !== "object") continue;
		const cc = c as Record<string, unknown>;
		if (cc.type === "text" && typeof cc.text === "string") {
			parts.push({ type: "text", text: cc.text });
		} else if (cc.type === "toolCall" && typeof cc.id === "string") {
			parts.push({
				type: "tool",
				tool: typeof cc.name === "string" ? cc.name : "unknown",
				callID: cc.id,
				state: {
					input: cc.arguments ?? {},
				},
			});
		}
		// thinking parts dropped intentionally
	}
	return parts;
}

/**
 * ToolResult content is `(TextContent | ImageContent)[]`. We collapse
 * to a single `{ type: "tool", tool, callID, state: { output } }`
 * part, joining text fragments. The OpenCode formatting layer expects
 * one tool part per call result; multiple text fragments inside one
 * ToolResultMessage are concatenated.
 */
function synthesizeToolResultParts(msg: unknown): unknown[] {
	const m = msg as {
		toolCallId?: unknown;
		toolName?: unknown;
		content?: unknown;
	};
	const callID = typeof m.toolCallId === "string" ? m.toolCallId : "";
	const tool = typeof m.toolName === "string" ? m.toolName : "unknown";

	if (!callID) return []; // no useful pairing handle

	let output = "";
	if (Array.isArray(m.content)) {
		const fragments: string[] = [];
		for (const c of m.content) {
			if (c === null || typeof c !== "object") continue;
			const cc = c as Record<string, unknown>;
			if (cc.type === "text" && typeof cc.text === "string") {
				fragments.push(cc.text);
			}
		}
		output = fragments.join("\n");
	}

	return [
		{
			type: "tool",
			tool,
			callID,
			state: {
				output,
			},
		},
	];
}
