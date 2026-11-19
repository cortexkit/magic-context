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
 * One exception: when the session's stored compartments prove the walk no
 * longer starts where it did when they were written (the walk lost entries
 * in front of them), readers pass an ordinal offset and the branch is
 * numbered from offset + 1, behind empty slots for the unreachable ordinals.
 * `pi-ordinal-alignment.ts` derives that offset.
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

import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RawMessage } from "@magic-context/core/hooks/magic-context/read-session-raw";
import { stableStringify } from "@magic-context/core/shared/stable-json";

/**
 * Prefix for the synthetic-user RawMessage id emitted when a run of `toolResult`
 * entries is folded into a user turn (the toolResult→assistant transition). The
 * id is `${SYNTH_USER_ID_PREFIX}${firstRealToolResultEntryId}` — NOT a real
 * SessionEntry id. Pi's `getBranch()`/compaction replay matches against real
 * `entry.id`, so any consumer that needs a replay-safe real entry id must detect
 * this prefix and handle it — but the handling differs by consumer:
 *   • compaction-boundary selection (`findFirstKeptEntryId`) defers when the
 *     kept start is synthetic, because advancing would drop folded tool results.
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
	const real = resolvePiRealStableId(msg, index, entryIds, entryIdByRef);
	if (real !== undefined) return real;
	// 3. Unstable index id — last resort (synthetic / unresolved messages only).
	const m = msg as { role?: string; timestamp?: number };
	const role = m.role ?? "unknown";
	return typeof m.timestamp === "number"
		? `pi-msg-${index}-${m.timestamp}-${role}`
		: `pi-msg-${index}-${role}`;
}

/** Lanes 1 and 2 of resolvePiStableId: the real SessionEntry id, or undefined. */
export function resolvePiRealStableId(
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
	return undefined;
}

const PI_CONTENT_FALLBACK_ID = /^pi-msg-c[0-9a-f]{16}o\d+-/;

/** True for an id made by piContentFallbackIds (position-independent). */
export function isPiContentFallbackId(id: string): boolean {
	return PI_CONTENT_FALLBACK_ID.test(id);
}

/**
 * True for the older index-bearing fallback form `pi-msg-<index>-…`, whose id
 * changes whenever the message's array position changes.
 */
export function isPiIndexFallbackId(id: string): boolean {
	return /^pi-msg-\d+-/.test(id);
}

/**
 * Position-independent fallback ids for the messages of one context pass that
 * have no real SessionEntry id: `pi-msg-c<digest>o<occurrence>-<ts>-<role>`.
 *
 * The digest covers the message header (response id, timestamp, role, tool
 * call id) and its content, so the same message gets the same id wherever it
 * sits in the array. The index-bearing form changed as soon as something ahead
 * of the message appeared or disappeared (a compaction, a custom message, a
 * request-built message), and its tags were then orphaned or refused. The
 * occurrence counter separates exact duplicates in one array: the k-th
 * unresolved message with a given digest gets `o<k>`. The timestamp and role
 * suffix keep the shape `parsePiFallbackToolOwnerId` reads.
 *
 * Compute this once per pass on the input array, before any stage rewrites
 * message content: the digest is of the raw message, so later consumers must
 * read the id by index from the returned array rather than recompute it from
 * an edited copy. Entries with a real id are undefined.
 */
export function piContentFallbackIds(
	messages: readonly unknown[],
	resolveReal: (msg: unknown, index: number) => string | undefined,
): (string | undefined)[] {
	const occurrences = new Map<string, number>();
	return messages.map((message, index) => {
		if (!message || typeof message !== "object") return undefined;
		if (resolveReal(message, index) !== undefined) return undefined;
		const m = message as Record<string, unknown>;
		const role = typeof m.role === "string" ? m.role : "unknown";
		const digest = createHash("sha256")
			.update(
				stableStringify([
					typeof m.responseId === "string" ? m.responseId : null,
					typeof m.timestamp === "number" || typeof m.timestamp === "string"
						? m.timestamp
						: null,
					role,
					typeof m.toolCallId === "string" ? m.toolCallId : null,
					m.content ?? null,
				]),
			)
			.digest("hex")
			.slice(0, 16);
		const occurrence = occurrences.get(digest) ?? 0;
		occurrences.set(digest, occurrence + 1);
		const base = `pi-msg-c${digest}o${occurrence}`;
		return typeof m.timestamp === "number"
			? `${base}-${m.timestamp}-${role}`
			: `${base}-${role}`;
	});
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

/**
 * How many ordinals the session's stored coordinates place before the first
 * message of the branch walk (see `pi-ordinal-alignment.ts`). Either a known
 * count, or a function that derives it from the branch entries the reader
 * itself loaded, so the count always describes the entries being numbered.
 */
export type PiOrdinalOffsetSource =
	| number
	| ((branchEntries: readonly unknown[]) => number);

function resolveOrdinalOffset(
	source: PiOrdinalOffsetSource,
	entries: readonly unknown[],
): number {
	const value = typeof source === "function" ? source(entries) : source;
	return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export function readPiSessionSnapshot(
	ctx: ExtensionContext,
	ordinalOffset: PiOrdinalOffsetSource = 0,
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
		rawMessages: convertEntriesToRawMessages(
			entries,
			resolveOrdinalOffset(ordinalOffset, entries),
		),
	};
}

export function readPiSessionMessages(
	ctx: ExtensionContext,
	ordinalOffset: PiOrdinalOffsetSource = 0,
): RawMessage[] {
	return readPiSessionSnapshot(ctx, ordinalOffset).rawMessages;
}

export function readPiSessionMessagePage(
	ctx: ExtensionContext,
	afterOrdinal: number,
	limit: number,
	finalWatermark: number,
	ordinalOffset: PiOrdinalOffsetSource = 0,
): RawMessage[] {
	const sessionManager = ctx.sessionManager;
	const getBranch = (
		sessionManager as { getBranch?: (fromId?: string) => unknown[] } | undefined
	)?.getBranch;
	if (typeof getBranch !== "function") return [];
	try {
		const entries = getBranch.call(sessionManager);
		return Array.isArray(entries)
			? convertEntriesToRawMessagePage(
					entries,
					afterOrdinal,
					limit,
					finalWatermark,
					resolveOrdinalOffset(ordinalOffset, entries),
				)
			: [];
	} catch {
		return [];
	}
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

/**
 * The model to seed the live model pin with on the first context pass after a
 * restart (`provider/model`).
 *
 * Usually the last `model_change` (see findLastModelKeyFromBranch). But when
 * a `model_change` is newer than the newest assistant message, the user
 * switched models after the last reply, possibly before the restart: that
 * entry already names the model in use now, so seeding from it would make the
 * first pass compare the new model with itself and miss the switch. The
 * newest assistant message's model (failed or aborted replies included) is
 * then the model the pin held when the last reply ended, which is what a
 * process that never restarted would compare against.
 */
export function findRestartModelSeedFromBranch(
	entries: readonly unknown[] | null | undefined,
): string | undefined {
	if (!Array.isArray(entries)) return undefined;
	let switchedAfterLastReply = false;
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as {
			type?: unknown;
			message?: unknown;
			provider?: unknown;
			modelId?: unknown;
		} | null;
		if (e?.type === "model_change") {
			if (typeof e.provider === "string" && typeof e.modelId === "string")
				switchedAfterLastReply = true;
			continue;
		}
		if (e?.type !== "message") continue;
		const m = e.message as
			| { role?: unknown; provider?: unknown; model?: unknown }
			| undefined;
		if (m?.role !== "assistant") continue;
		if (
			typeof m.provider !== "string" ||
			m.provider.length === 0 ||
			typeof m.model !== "string" ||
			m.model.length === 0
		) {
			continue;
		}
		return switchedAfterLastReply
			? `${m.provider}/${m.model}`
			: findLastModelKeyFromBranch(entries);
	}
	return findLastModelKeyFromBranch(entries);
}

function rawEntryVersion(entry: MessageEntry): string | number {
	const record = entry as unknown as Record<string, unknown>;
	const updated = record.updatedAt ?? record.updated_at ?? record.timestamp;
	return typeof updated === "string" || typeof updated === "number"
		? updated
		: entry.id;
}

/** Pi/OMP persist JSONL entry timestamps as ISO strings; tolerate numeric SDK fixtures too. */
export function parsePiEntryTimestamp(entry: MessageEntry): number | null {
	const record = entry as unknown as Record<string, unknown>;
	const raw = record.timestamp;
	if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0)
		return raw;
	if (typeof raw !== "string" || raw.trim().length === 0) return null;
	const parsed = Date.parse(raw);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
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

const UNREACHABLE_PI_STORE_TYPE = "unavailable";

/**
 * The slot for an ordinal the stored coordinates count but the branch walk no
 * longer reaches (see `pi-ordinal-alignment.ts`). It has no id and no content:
 * like a protocol entry it keeps the numbering dense, and readers that need
 * text (historian chunks, the search index, ctx_expand) find nothing in it.
 * It carries a non-enumerable `storeType` of "unavailable" (the same
 * non-enumerable convention OpenCode 2 rows use), so a reader can tell it from
 * a real message without changing serialized output.
 */
export function unreachablePiOrdinalSlot(ordinal: number): RawMessage {
	const slot: RawMessage = { ordinal, id: "", role: "system", parts: [] };
	Object.defineProperty(slot, "storeType", {
		value: UNREACHABLE_PI_STORE_TYPE,
		enumerable: false,
	});
	return slot;
}

/** True for a slot whose message is no longer in the session's history. */
export function isUnreachablePiOrdinalSlot(message: RawMessage): boolean {
	return message.storeType === UNREACHABLE_PI_STORE_TYPE;
}

const READ_ENTRY = Symbol("read Pi entry");
const END_ENTRIES = Symbol("end Pi entries");

export function* iterateEntriesToRawMessageRange(
	entries: Iterable<unknown>,
	afterOrdinal: number,
	limit: number,
	finalWatermark: number,
	ordinalOffset = 0,
): Generator<RawMessage> {
	const input = entries[Symbol.iterator]();
	const converter = convertEntryStream(
		afterOrdinal,
		limit,
		finalWatermark,
		ordinalOffset,
	);
	let next: unknown;
	try {
		while (true) {
			const step = converter.next(next);
			if (step.done) return;
			if (step.value === READ_ENTRY) {
				const entry = input.next();
				next = entry.done ? END_ENTRIES : entry.value;
			} else yield step.value;
		}
	} finally {
		input.return?.();
	}
}

/** Acquire entries asynchronously using iterateEntriesToRawMessageRange's ordinal/folding rules. */
export async function* iterateAsyncEntriesToRawMessageRange(
	entries: AsyncIterable<unknown>,
	afterOrdinal: number,
	limit: number,
	finalWatermark: number,
): AsyncGenerator<RawMessage> {
	const input = entries[Symbol.asyncIterator]();
	const converter = convertEntryStream(afterOrdinal, limit, finalWatermark, 0);
	let next: unknown;
	try {
		while (true) {
			const step = converter.next(next);
			if (step.done) return;
			if (step.value === READ_ENTRY) {
				const entry = await input.next();
				next = entry.done ? END_ENTRIES : entry.value;
			} else yield step.value;
		}
	} finally {
		await input.return?.();
	}
}

function* convertEntryStream(
	afterOrdinal: number,
	limit: number,
	finalWatermark: number,
	ordinalOffset = 0,
): Generator<RawMessage | typeof READ_ENTRY, void, unknown> {
	let emitted = 0;
	const normalizedAfter = Math.max(0, Math.floor(afterOrdinal));
	const normalizedLimit = Math.max(1, Math.floor(limit));
	const normalizedWatermark = Math.max(
		normalizedAfter,
		Math.floor(finalWatermark),
	);
	const prefix =
		Number.isSafeInteger(ordinalOffset) && ordinalOffset > 0
			? ordinalOffset
			: 0;
	// Ordinals 1..prefix belong to messages the branch walk cannot reach; emit
	// their empty slots before numbering the branch from prefix + 1.
	const prefixEnd = Math.min(prefix, normalizedWatermark);
	for (let ordinal = normalizedAfter + 1; ordinal <= prefixEnd; ordinal++) {
		emitted++;
		yield unreachablePiOrdinalSlot(ordinal);
		if (emitted >= normalizedLimit) return;
	}
	if (prefix >= normalizedWatermark) return;
	let nextOrdinal = prefix + 1;
	let pendingToolResults: Array<{ msg: unknown; version: string | number }> =
		[];
	const buildToolParts = (
		results: ReadonlyArray<{ msg: unknown; version: string | number }>,
	): unknown[] =>
		results.flatMap(({ msg, version }) =>
			attachPiPartVersion(synthesizeToolResultParts(msg), version),
		);
	let hasPendingToolParts = false;
	let pendingFirstRealId = "";
	let pendingFirstRealVersion: string | number = "";
	let pendingFirstCreatedAt: number | null = null;

	const appendMessage = function* (
		id: string,
		role: string,
		version: string | number,
		createdAt: number | null,
		parts: () => unknown[],
	): Generator<RawMessage, boolean> {
		const ordinal = nextOrdinal++;
		if (ordinal > normalizedAfter && ordinal <= normalizedWatermark) {
			emitted++;
			yield {
				ordinal,
				id,
				role,
				parts: parts(),
				version,
				...(createdAt === null ? {} : { createdAt }),
			};
		}
		return emitted >= normalizedLimit || nextOrdinal > normalizedWatermark;
	};

	while (true) {
		const entry = yield READ_ENTRY;
		if (entry === END_ENTRIES) break;
		if (!isMessageEntry(entry)) continue;

		const msg = entry.message;
		const role = (msg as { role?: string }).role;
		if (role === "toolResult") {
			const callId = (msg as { toolCallId?: unknown }).toolCallId;
			if (typeof callId !== "string" || callId.length === 0) continue;
			const version = rawEntryVersion(entry);
			hasPendingToolParts = true;
			// Keep the result itself and build its parts only once the carrier's
			// ordinal is known: a non-chat entry (bashExecution, ...) between the
			// result and the next chat message takes an ordinal first, so the
			// result's position says nothing about whether its carrier is in range.
			pendingToolResults.push({ msg, version });
			if (pendingFirstRealId === "") {
				pendingFirstRealId = entry.id;
				pendingFirstRealVersion = version;
				pendingFirstCreatedAt = parsePiEntryTimestamp(entry);
			}
			continue;
		}

		if (role === "user") {
			const version = rawEntryVersion(entry);
			const bufferedToolResults = pendingToolResults;
			const done = yield* appendMessage(
				entry.id,
				"user",
				version,
				parsePiEntryTimestamp(entry),
				() => [
					...buildToolParts(bufferedToolResults),
					...attachPiPartVersion(synthesizeUserParts(msg), version),
				],
			);
			pendingToolResults = [];
			hasPendingToolParts = false;
			pendingFirstRealId = "";
			pendingFirstRealVersion = "";
			pendingFirstCreatedAt = null;
			if (done) break;
			continue;
		}

		if (role === "assistant") {
			if (hasPendingToolParts) {
				const bufferedToolResults = pendingToolResults;
				const pendingId = pendingFirstRealId;
				const pendingVersion = pendingFirstRealVersion;
				const done = yield* appendMessage(
					`${SYNTH_USER_ID_PREFIX}${pendingId}`,
					"user",
					pendingVersion,
					pendingFirstCreatedAt,
					() => buildToolParts(bufferedToolResults),
				);
				pendingToolResults = [];
				hasPendingToolParts = false;
				pendingFirstRealId = "";
				pendingFirstRealVersion = "";
				pendingFirstCreatedAt = null;
				if (done) break;
			}

			const version = rawEntryVersion(entry);
			if (
				yield* appendMessage(
					entry.id,
					"assistant",
					version,
					parsePiEntryTimestamp(entry),
					() => attachPiPartVersion(synthesizeAssistantParts(msg), version),
				)
			) {
				break;
			}
			continue;
		}

		// Protocol entries retain canonical ordinals so persisted boundaries do not
		// shift. Their empty content projection keeps system prompts and tool
		// declarations out of historian prose while chunk coverage absorbs the slot.
		if (
			yield* appendMessage(
				entry.id,
				typeof role === "string" ? role : "unknown",
				rawEntryVersion(entry),
				parsePiEntryTimestamp(entry),
				() => [],
			)
		) {
			break;
		}
	}

	if (
		hasPendingToolParts &&
		emitted < normalizedLimit &&
		nextOrdinal <= normalizedWatermark
	) {
		yield* appendMessage(
			`${SYNTH_USER_ID_PREFIX}${pendingFirstRealId}`,
			"user",
			pendingFirstRealVersion,
			pendingFirstCreatedAt,
			() => buildToolParts(pendingToolResults),
		);
	}
}

/** Pure full conversion exposed for callers that need an entire Pi branch. */
export function convertEntriesToRawMessages(
	entries: readonly unknown[],
	ordinalOffset = 0,
): RawMessage[] {
	return [
		...iterateEntriesToRawMessageRange(
			entries,
			0,
			Number.MAX_SAFE_INTEGER,
			Number.MAX_SAFE_INTEGER,
			ordinalOffset,
		),
	];
}

/** Convert a located assistant without hydrating unrelated historical bodies. */
export function convertPiAssistantEntryById(
	entries: readonly unknown[],
	entryId: string,
	ordinalOffset = 0,
): RawMessage | null {
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (!isMessageEntry(entry) || entry.id !== entryId) continue;
		if (
			(entry.message as { role?: unknown }).role !== "assistant" ||
			entryId.startsWith(SYNTH_USER_ID_PREFIX)
		) {
			return (
				convertEntriesToRawMessages(entries, ordinalOffset).find(
					(message) => message.id === entryId,
				) ?? null
			);
		}
		const raw = convertEntriesToRawMessages([entry])[0];
		return raw
			? {
					...raw,
					ordinal: countPiRawMessages(
						entries.slice(0, index + 1),
						ordinalOffset,
					),
				}
			: null;
	}
	return null;
}

/** Convert only one raw-message page without hydrating the rest of the Pi branch. */
export function convertEntriesToRawMessagePage(
	entries: Iterable<unknown>,
	afterOrdinal: number,
	limit: number,
	finalWatermark: number,
	ordinalOffset = 0,
): RawMessage[] {
	return [
		...iterateEntriesToRawMessageRange(
			entries,
			afterOrdinal,
			limit,
			finalWatermark,
			ordinalOffset,
		),
	];
}

export interface MessageEntry {
	type: "message";
	id: string;
	message: unknown;
	timestamp?: string | number;
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

/** Count folded ordinals without constructing historical tool output or copying content. */
export function countPiRawMessages(
	entries: readonly unknown[],
	ordinalOffset = 0,
): number {
	let count =
		Number.isSafeInteger(ordinalOffset) && ordinalOffset > 0
			? ordinalOffset
			: 0;
	let pendingTools = false;
	for (const entry of entries) {
		if (!isMessageEntry(entry)) continue;
		const message = entry.message as { role?: unknown; toolCallId?: unknown };
		if (message.role === "toolResult") {
			if (
				typeof message.toolCallId === "string" &&
				message.toolCallId.length > 0
			)
				pendingTools = true;
			continue;
		}
		if (message.role === "user") pendingTools = false;
		else if (message.role === "assistant" && pendingTools) {
			count++;
			pendingTools = false;
		}
		count++;
	}
	return count + Number(pendingTools);
}

/**
 * The branch-walk ordinal (numbered from 1, no offset) of each requested raw
 * message id that the branch contains, synthetic folded-tool ids included.
 * Counts exactly as `iterateEntriesToRawMessageRange` numbers, without
 * building any message content; ids the branch does not contain are absent
 * from the result. `onLocatedInPrefix` runs only if every target was found
 * without synthesizing a tool ordinal at the end of the branch.
 */
export function locatePiRawOrdinals(
	entries: Iterable<unknown>,
	wanted: ReadonlySet<string>,
	onLocatedInPrefix?: () => void,
): Map<string, number> {
	const found = new Map<string, number>();
	if (wanted.size === 0) return found;
	let ordinal = 0;
	let pendingFirstId: string | null = null;
	const note = (id: string): void => {
		if (wanted.has(id) && !found.has(id)) found.set(id, ordinal);
	};
	for (const entry of entries) {
		if (!isMessageEntry(entry)) continue;
		const message = entry.message as { role?: unknown; toolCallId?: unknown };
		if (message.role === "toolResult") {
			if (
				typeof message.toolCallId === "string" &&
				message.toolCallId.length > 0 &&
				pendingFirstId === null
			) {
				pendingFirstId = entry.id;
			}
			continue;
		}
		if (message.role === "user") {
			ordinal++;
			note(entry.id);
			pendingFirstId = null;
		} else {
			if (message.role === "assistant" && pendingFirstId !== null) {
				ordinal++;
				note(`${SYNTH_USER_ID_PREFIX}${pendingFirstId}`);
				pendingFirstId = null;
			}
			ordinal++;
			note(entry.id);
		}
		if (found.size === wanted.size) {
			onLocatedInPrefix?.();
			return found;
		}
	}
	if (pendingFirstId !== null) {
		ordinal++;
		note(`${SYNTH_USER_ID_PREFIX}${pendingFirstId}`);
	}
	return found;
}
