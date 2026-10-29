import { protectedToolTagNumbers } from "@magic-context/core/features/magic-context/reclaim-protection";
import { estimateImageTokensFromDataUrl } from "@magic-context/core/hooks/magic-context/image-token-estimate";
import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { rememberCurrentToolOutputCount } from "@magic-context/core/hooks/magic-context/tail-hygiene-output-count";
import {
	compareMeasuredTailPrefix,
	freezeTailHygieneMeasurement,
	stripChannel1ReminderSpans,
	type TailHygieneBaseline,
	type TailHygieneMeasurement,
	type TailHygienePartKind,
	type TailHygienePartMeasurement,
	type TailHygienePrefixMismatch,
} from "@magic-context/core/hooks/magic-context/tail-hygiene-walk";
import {
	piJsonHash,
	TailHygieneJsonMemo,
} from "@magic-context/core/shared/tail-hygiene-json";
import { providerVisiblePiPart } from "./provider-visible-parts-pi";
import { isPiSystemEntry } from "./system-entry-pi";
import type { PiTagMetadata } from "./tag-snapshot-pi";

const TAG_PREFIX = /^§(\d+)§\s*/;
const SYNTHETIC_TODO_PREFIX = "mc_synthetic_todo_";
const MAX_CONTENT_MEMO_ENTRIES = 100_000;
const MAX_CONTENT_MEMO_BYTES = 64 * 1024 * 1024;
const contentMemo = new Map<
	string,
	{ hash: string; tokens: number | undefined; keyBytes: number }
>();
let contentMemoBytes = 0;

/**
 * Forget every memoized token count. The memo is process-global, so a test that
 * stubs the token estimator must clear it first, or it reads counts an earlier
 * test cached with the real estimator for the same content.
 */
export function clearPiTailHygieneContentMemo(): void {
	contentMemo.clear();
	contentMemoBytes = 0;
}

export const __test = {
	contentMemoStats: () => ({
		entries: contentMemo.size,
		bytes: contentMemoBytes,
	}),
};

const FNV1A_32_OFFSET = 0x811c9dc5;
const FNV1A_32_PRIME = 0x01000193;

export interface PiTailHygieneWalkInput {
	messages: readonly unknown[];
	/** Active request API, not the API recorded on an older assistant message. */
	providerApi?: string;
	tags: readonly PiTagMetadata[];
	/** Reuse the same key object for one connection/session lifetime, with canonical immutable row snapshots only. */
	tagCacheKey?: object;
	/**
	 * Canonical protection-window membership derived from persisted row mass and the
	 * snapshotted floor. Coordinate space: tag-number. An empty set is an empty window.
	 */
	protectedTagNumbers: ReadonlySet<number>;
	protectedToolTags?: ReadonlySet<number>;
	/** Active tags whose drop is queued but has not yet changed the rendered Pi entries. */
	pendingDropTagNumbers?: ReadonlySet<number>;
	stableId?: (message: unknown, index: number) => string | undefined;
	syntheticLeadingCount?: number;
	syntheticMessages?: ReadonlySet<object>;
}

interface PiToolArc {
	key: string;
	callId: string;
	ownerId: string;
	ownerIndex: number;
	toolName: string | null;
	sentinel: boolean;
	tag?: PiTagMetadata;
	parts: Record<string, unknown>[];
}

interface DraftPart {
	key: string;
	kind: TailHygienePartKind;
	content: string;
	contentHash?: string;
	tokens: number;
	tag?: PiTagMetadata;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function fnv1a32(value: string): string {
	let hash = FNV1A_32_OFFSET;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, FNV1A_32_PRIME);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

function safeStableStringify(value: unknown): string {
	const seen = new Set<object>();
	try {
		return (
			JSON.stringify(value, (_key, current) => {
				if (!isRecord(current) || Array.isArray(current)) return current;
				if (seen.has(current)) return "[Circular]";
				seen.add(current);
				return Object.fromEntries(
					Object.entries(current).sort(([left], [right]) =>
						left.localeCompare(right),
					),
				);
			}) ?? ""
		);
	} catch {
		return "";
	}
}

function memoizedContent(
	kind: TailHygienePartKind,
	content: string,
): { hash: string; tokens: number | undefined } {
	const key = `${kind}\0${content}`;
	const cached = contentMemo.get(key);
	if (cached) return cached;
	const measured = {
		hash: fnv1a32(key),
		tokens: kind === "excluded" ? 0 : undefined,
		keyBytes: key.length * 2 + 32,
	};
	contentMemo.set(key, measured);
	contentMemoBytes += measured.keyBytes;
	while (
		contentMemo.size > MAX_CONTENT_MEMO_ENTRIES ||
		contentMemoBytes > MAX_CONTENT_MEMO_BYTES
	) {
		const oldest = contentMemo.keys().next().value;
		if (typeof oldest !== "string") break;
		const removed = contentMemo.get(oldest);
		if (removed) contentMemoBytes -= removed.keyBytes;
		contentMemo.delete(oldest);
	}
	return measured;
}

function memoizedTokens(kind: TailHygienePartKind, content: string): number {
	const measured = memoizedContent(kind, content);
	if (measured.tokens === undefined) {
		measured.tokens = estimateTokens(content);
	}
	return measured.tokens;
}

function partHash(kind: TailHygienePartKind, content: string): string {
	return memoizedContent(kind, content).hash;
}

function parseVisibleTag(
	content: string,
	tagsByNumber: ReadonlyMap<number, PiTagMetadata>,
): PiTagMetadata | undefined {
	const match = content.trimStart().match(TAG_PREFIX);
	if (!match) return undefined;
	const tagNumber = Number(match[1]);
	return Number.isSafeInteger(tagNumber)
		? tagsByNumber.get(tagNumber)
		: undefined;
}

function isDropSentinel(content: string): boolean {
	const head = content
		.trimStart()
		.replace(TAG_PREFIX, "")
		.trimStart()
		.toLowerCase();
	return head.startsWith("[dropped") || head.startsWith("[truncated");
}

function messageIdentity(
	message: unknown,
	index: number,
	stableId: PiTailHygieneWalkInput["stableId"],
): string {
	const resolved = stableId?.(message, index);
	if (resolved) return resolved;
	if (isRecord(message)) {
		if (
			typeof message.responseId === "string" &&
			message.responseId.length > 0
		) {
			return `response:${message.responseId}`;
		}
		if (typeof message.timestamp === "number") {
			return `timestamp:${message.timestamp}:${String(message.role ?? "unknown")}`;
		}
	}
	return `pi-message:${index}`;
}

function isSyntheticMessage(
	message: Record<string, unknown>,
	index: number,
	input: PiTailHygieneWalkInput,
): boolean {
	if (index < Math.max(0, input.syntheticLeadingCount ?? 0)) return true;
	if (input.syntheticMessages?.has(message)) return true;
	if (message.syntheticTodoMarker === true) return true;
	const role = typeof message.role === "string" ? message.role : "";
	return (
		isPiSystemEntry(message) ||
		role === "custom" ||
		role === "compactionSummary"
	);
}

/**
 * Counts only JSONL `user` entries that the rendered-entry classifier keeps
 * as user-authored. `isSyntheticMessage` excludes m0/m1 through
 * `syntheticLeadingCount` and Channel-2's hidden `custom` entries.
 */
export function countRealPiUserMessages(input: PiTailHygieneWalkInput): number {
	let count = 0;
	for (let index = 0; index < input.messages.length; index += 1) {
		const message = input.messages[index];
		if (!isRecord(message) || message.role !== "user") continue;
		if (!isSyntheticMessage(message, index, input)) count += 1;
	}
	return count;
}

function imageContentAndTokens(part: Record<string, unknown>): {
	content: string;
	tokens: number;
} {
	const data = typeof part.data === "string" ? part.data : "";
	const mimeType =
		typeof part.mimeType === "string" ? part.mimeType : "image/png";
	const content = data.startsWith("data:")
		? data
		: `data:${mimeType};base64,${data}`;
	return {
		content,
		tokens: content.length > 0 ? estimateImageTokensFromDataUrl(content) : 0,
	};
}

function messageIdForTag(tag: PiTagMetadata): string | null {
	if (tag.type === "tool") return tag.toolOwnerMessageId;
	const positional = tag.messageId.match(/^(.*):(?:p|file)\d+$/);
	if (positional) return positional[1] ?? null;
	const contentDerived = tag.messageId.indexOf(":mc-text-v1:");
	return contentDerived >= 0 ? tag.messageId.slice(0, contentDerived) : null;
}

function neighborhoodConsistent(input: {
	orphanTagNumber: number;
	messageIndex: number;
	boundsByMessageIndex: ReadonlyMap<number, { min: number; max: number }>;
	messageCount: number;
}): boolean {
	let previousMax: number | null = null;
	for (let index = 0; index <= input.messageIndex; index += 1) {
		const bound = input.boundsByMessageIndex.get(index);
		if (bound)
			previousMax =
				previousMax === null ? bound.max : Math.max(previousMax, bound.max);
	}
	let nextMin: number | null = null;
	for (
		let index = input.messageIndex + 1;
		index < input.messageCount;
		index += 1
	) {
		const bound = input.boundsByMessageIndex.get(index);
		if (bound)
			nextMin = nextMin === null ? bound.min : Math.min(nextMin, bound.min);
	}
	return (
		previousMax !== null &&
		nextMin !== null &&
		input.orphanTagNumber >= previousMax &&
		input.orphanTagNumber <= nextMin
	);
}

function collectToolArcs(input: PiTailHygieneWalkInput): {
	arcs: PiToolArc[];
	arcByPart: ReadonlyMap<object, PiToolArc>;
	messageIds: readonly string[];
} {
	const arcs: PiToolArc[] = [];
	const arcByPart = new Map<object, PiToolArc>();
	const pendingByCall = new Map<string, PiToolArc[]>();
	const messageIds = input.messages.map((message, index) =>
		messageIdentity(message, index, input.stableId),
	);

	for (
		let messageIndex = 0;
		messageIndex < input.messages.length;
		messageIndex += 1
	) {
		const raw = input.messages[messageIndex];
		if (!isRecord(raw)) continue;
		const role = raw.role;
		if (role === "assistant" && Array.isArray(raw.content)) {
			for (let partIndex = 0; partIndex < raw.content.length; partIndex += 1) {
				const part = raw.content[partIndex];
				if (!isRecord(part) || part.type !== "toolCall") continue;
				if (typeof part.id !== "string" || part.id.length === 0) continue;
				const ownerId =
					messageIds[messageIndex] ?? `pi-message:${messageIndex}`;
				const arc: PiToolArc = {
					key: `${ownerId}\0${part.id}\0${partIndex}`,
					callId: part.id,
					ownerId,
					ownerIndex: messageIndex,
					toolName: typeof part.name === "string" ? part.name : null,
					sentinel:
						isRecord(part.arguments) &&
						typeof part.arguments.__magic_context_dropped__ === "string",
					parts: [part],
				};
				arcs.push(arc);
				arcByPart.set(part, arc);
				const pending = pendingByCall.get(part.id) ?? [];
				pending.push(arc);
				pendingByCall.set(part.id, pending);
			}
			continue;
		}
		if (role !== "toolResult") continue;
		if (typeof raw.toolCallId !== "string" || raw.toolCallId.length === 0)
			continue;
		const pending = pendingByCall.get(raw.toolCallId);
		const matched = pending?.pop();
		const ownerId =
			matched?.ownerId ??
			messageIds[messageIndex] ??
			`pi-message:${messageIndex}`;
		const arc: PiToolArc = matched ?? {
			key: `${ownerId}\0${raw.toolCallId}\0result:${messageIndex}`,
			callId: raw.toolCallId,
			ownerId,
			ownerIndex: messageIndex,
			toolName: typeof raw.toolName === "string" ? raw.toolName : null,
			sentinel: false,
			parts: [],
		};
		if (!matched) arcs.push(arc);
		if (!Array.isArray(raw.content)) continue;
		for (const part of raw.content) {
			if (!isRecord(part)) continue;
			arc.parts.push(part);
			arcByPart.set(part, arc);
			if (
				part.type === "text" &&
				typeof part.text === "string" &&
				isDropSentinel(part.text)
			) {
				arc.sentinel = true;
			}
		}
	}
	return { arcs, arcByPart, messageIds };
}

interface PiTagAttribution {
	tags: readonly PiTagMetadata[];
	messageTags: Map<string, PiTagMetadata>;
	tagsByNumber: Map<number, PiTagMetadata>;
	exactToolTags: Map<string, PiTagMetadata>;
	orphanTagsByCall: Map<string, PiTagMetadata[]>;
	boundsByOwner: Map<string, { min: number; max: number }>;
	rowsByOwner: Map<string, Set<PiTagMetadata>>;
	simple: boolean;
}

const tagAttributions = new WeakMap<object, PiTagAttribution>();

function tagAttribution(input: PiTailHygieneWalkInput): PiTagAttribution {
	const cacheable = input.tagCacheKey;
	let cached = cacheable
		? tagAttributions.get(input.tagCacheKey as object)
		: undefined;
	const wasSimple = cached?.simple === true;
	const added: PiTagMetadata[] = [];
	const removed: PiTagMetadata[] = [];
	if (cached) {
		if (cached.tags === input.tags) return cached;
		// Snapshot arrays have canonical tag-number order and stable unchanged
		// row objects. Merge their deltas without rebuilding historical maps.
		let oldIndex = 0;
		let newIndex = 0;
		while (oldIndex < cached.tags.length || newIndex < input.tags.length) {
			const old = cached.tags[oldIndex];
			const next = input.tags[newIndex];
			if (old && (!next || old.tagNumber < next.tagNumber)) {
				removed.push(old);
				oldIndex++;
			} else if (next && (!old || next.tagNumber < old.tagNumber)) {
				added.push(next);
				newIndex++;
			} else {
				if (old !== next) {
					if (old) removed.push(old);
					if (next) added.push(next);
				}
				oldIndex++;
				newIndex++;
			}
		}
		// Duplicate-number or duplicate-key legacy stores retain the original
		// last-row-wins full projection on edits; a simple delta cannot prove it.
		if (!cached.simple && (removed.length || added.length)) cached = undefined;
	}
	if (!cached) {
		removed.length = 0;
		added.length = 0;
		for (const tag of input.tags) added.push(tag);
		cached = {
			tags: input.tags,
			messageTags: new Map(),
			tagsByNumber: new Map(),
			exactToolTags: new Map(),
			orphanTagsByCall: new Map(),
			boundsByOwner: new Map(),
			rowsByOwner: new Map(),
			simple: true,
		};
	}
	const dirtyOwners = new Set<string>();
	for (const tag of removed) {
		cached.tagsByNumber.delete(tag.tagNumber);
		if (tag.type !== "tool") cached.messageTags.delete(tag.messageId);
		else if (tag.toolOwnerMessageId !== null)
			cached.exactToolTags.delete(
				`${tag.toolOwnerMessageId}\0${tag.messageId}`,
			);
		else {
			const rows =
				cached.orphanTagsByCall
					.get(tag.messageId)
					?.filter((row) => row !== tag) ?? [];
			if (rows.length) cached.orphanTagsByCall.set(tag.messageId, rows);
			else cached.orphanTagsByCall.delete(tag.messageId);
		}
		const owner = messageIdForTag(tag);
		if (owner !== null) {
			cached.rowsByOwner.get(owner)?.delete(tag);
			dirtyOwners.add(owner);
		}
	}
	for (const tag of added) {
		if (cached.tagsByNumber.has(tag.tagNumber)) cached.simple = false;
		cached.tagsByNumber.set(tag.tagNumber, tag);
		if (tag.type === "tool") {
			if (tag.toolOwnerMessageId === null) {
				const rows = cached.orphanTagsByCall.get(tag.messageId) ?? [];
				rows.push(tag);
				cached.orphanTagsByCall.set(tag.messageId, rows);
			} else {
				const key = `${tag.toolOwnerMessageId}\0${tag.messageId}`;
				if (cached.exactToolTags.has(key)) cached.simple = false;
				cached.exactToolTags.set(key, tag);
			}
		} else {
			if (cached.messageTags.has(tag.messageId)) cached.simple = false;
			cached.messageTags.set(tag.messageId, tag);
		}
		const owner = messageIdForTag(tag);
		if (owner === null) continue;
		const rows = cached.rowsByOwner.get(owner) ?? new Set();
		rows.add(tag);
		cached.rowsByOwner.set(owner, rows);
		dirtyOwners.add(owner);
	}
	for (const owner of dirtyOwners) {
		const rows = cached.rowsByOwner.get(owner);
		if (!rows?.size) {
			cached.rowsByOwner.delete(owner);
			cached.boundsByOwner.delete(owner);
			continue;
		}
		let min = Infinity;
		let max = -Infinity;
		for (const row of rows) {
			min = Math.min(min, row.tagNumber);
			max = Math.max(max, row.tagNumber);
		}
		cached.boundsByOwner.set(owner, { min, max });
	}
	// A lower-number newcomer can collide with an unchanged higher-number key.
	// The incremental insertion order is not canonical; rebuild on the first
	// transition to duplicate keys so the last canonical row still wins.
	if (wasSimple && !cached.simple)
		cached = tagAttribution({ ...input, tagCacheKey: undefined });
	cached.tags = input.tags;
	if (cacheable) tagAttributions.set(input.tagCacheKey as object, cached);
	return cached;
}

function attributeTags(
	input: PiTailHygieneWalkInput,
	arcs: readonly PiToolArc[],
	messageIds: readonly string[],
): {
	messageTags: ReadonlyMap<string, PiTagMetadata>;
	tagsByNumber: ReadonlyMap<number, PiTagMetadata>;
} {
	const {
		messageTags,
		tagsByNumber,
		exactToolTags,
		orphanTagsByCall,
		boundsByOwner,
	} = tagAttribution({
		...input,
		tags: attributionProjection(input, arcs, messageIds),
	});
	const messageIndexById = new Map<string, number>();
	for (let index = 0; index < messageIds.length; index += 1) {
		const id = input.stableId?.(input.messages[index], index);
		if (id) messageIndexById.set(id, index);
	}
	const boundsByMessageIndex = new Map<number, { min: number; max: number }>();

	for (const [ownerId, index] of messageIndexById) {
		const bounds = boundsByOwner.get(ownerId);
		if (bounds) boundsByMessageIndex.set(index, bounds);
	}

	const orphanCandidates = new Map<string, Map<string, PiToolArc[]>>();
	for (const arc of arcs) {
		const exact = exactToolTags.get(`${arc.ownerId}\0${arc.callId}`);
		if (exact) {
			arc.tag = exact;
			continue;
		}
		const orphans = orphanTagsByCall.get(arc.callId);
		if (orphans?.length !== 1) continue;
		if (
			!neighborhoodConsistent({
				orphanTagNumber: orphans[0].tagNumber,
				messageIndex: arc.ownerIndex,
				boundsByMessageIndex,
				messageCount: input.messages.length,
			})
		) {
			continue;
		}
		const byOwner =
			orphanCandidates.get(arc.callId) ?? new Map<string, PiToolArc[]>();
		const ownerArcs = byOwner.get(arc.ownerId) ?? [];
		ownerArcs.push(arc);
		byOwner.set(arc.ownerId, ownerArcs);
		orphanCandidates.set(arc.callId, byOwner);
	}
	for (const [callId, byOwner] of orphanCandidates) {
		if (byOwner.size !== 1) continue;
		const orphan = orphanTagsByCall.get(callId)?.[0];
		if (!orphan) continue;
		for (const ownerArcs of byOwner.values()) {
			for (const arc of ownerArcs) arc.tag = orphan;
		}
	}
	// Pi writes the tag number into rendered tool-result text. This remains the
	// authoritative attribution fallback when a late post-process cloned the
	// message object and the real SessionEntry owner id is no longer ref-resolvable.
	for (const arc of arcs) {
		if (arc.tag) continue;
		for (const part of arc.parts) {
			if (part.type !== "text" || typeof part.text !== "string") continue;
			const visible = parseVisibleTag(part.text, tagsByNumber);
			if (visible?.type === "tool") {
				arc.tag = visible;
				break;
			}
		}
	}
	return { messageTags, tagsByNumber };
}

/** Index only identities the rendered request can ask about, from the pinned pass rows. */
function attributionProjection(
	input: PiTailHygieneWalkInput,
	arcs: readonly PiToolArc[],
	messageIds: readonly string[],
): readonly PiTagMetadata[] {
	const owners = new Set(messageIds);
	const calls = new Set<string>();
	const numbers = new Set<number>();
	for (const arc of arcs) {
		owners.add(arc.ownerId);
		calls.add(arc.callId);
	}
	const notePrefix = (text: string) => {
		for (const candidate of [text, stripChannel1ReminderSpans(text)]) {
			const match = candidate.trimStart().match(TAG_PREFIX);
			if (match) numbers.add(Number(match[1]));
		}
	};
	for (let index = 0; index < input.messages.length; index++) {
		const id = input.stableId?.(input.messages[index], index);
		if (id) owners.add(id);
		const message = input.messages[index];
		if (!isRecord(message)) continue;
		if (typeof message.content === "string") notePrefix(message.content);
		else if (Array.isArray(message.content)) {
			for (const part of message.content)
				if (isRecord(part) && typeof part.text === "string")
					notePrefix(part.text);
		}
	}
	return input.tags.filter((tag) => {
		if (numbers.has(tag.tagNumber)) return true;
		const owner = messageIdForTag(tag);
		if (owner !== null && owners.has(owner)) return true;
		// Orphan uniqueness is all-status and session-wide for each visible call.
		return (
			tag.type === "tool" &&
			tag.toolOwnerMessageId === null &&
			calls.has(tag.messageId)
		);
	});
}

const partJsonMemo = new TailHygieneJsonMemo();
let excludedViews = new WeakMap<object, unknown>();

function excludedDraftForApi(
	key: string,
	value: unknown,
	providerApi?: string,
): DraftPart {
	let view =
		value !== null && typeof value === "object"
			? excludedViews.get(value)
			: undefined;
	if (view === undefined) {
		view = providerVisiblePiPart(value, providerApi);
		if (value !== null && typeof value === "object")
			excludedViews.set(value, view);
	}
	return {
		key,
		kind: "excluded",
		content: "",
		contentHash: partJsonMemo.get(
			key,
			view,
			() =>
				typeof view === "string"
					? partHash("excluded", view)
					: piJsonHash(view, () => safeStableStringify(view)),
			true,
		),
		tokens: 0,
	};
}

function finalizeParts(
	drafts: readonly DraftPart[],
	pendingDropTagNumbers: ReadonlySet<number>,
	protectedTagNumbers: ReadonlySet<number>,
	newestMessagePartStart: number,
	protectedToolTags?: ReadonlySet<number>,
): TailHygieneMeasurement {
	const visibleTags = new Map<number, PiTagMetadata>();
	for (const part of drafts) {
		if (part.kind !== "excluded" && part.tag)
			visibleTags.set(part.tag.tagNumber, part.tag);
	}
	const protectedNumbers = new Set(protectedTagNumbers);
	const exemplarNumbers =
		protectedToolTags ?? protectedToolTagNumbers([...visibleTags.values()]);
	for (const tagNumber of exemplarNumbers) protectedNumbers.add(tagNumber);

	let u = 0;
	let t = 0;
	const parts = drafts.map((draft): TailHygienePartMeasurement => {
		const protectedPart = draft.tag
			? protectedNumbers.has(draft.tag.tagNumber)
			: false;
		const tokens = Math.max(0, draft.tokens);
		const queuedForDrop = draft.tag
			? pendingDropTagNumbers.has(draft.tag.tagNumber)
			: false;
		const uTokens =
			draft.tag?.status === "active" &&
			!protectedPart &&
			!queuedForDrop &&
			draft.kind !== "excluded"
				? tokens
				: 0;
		t += tokens;
		u += uTokens;
		return {
			key: draft.key,
			contentHash: draft.contentHash ?? partHash(draft.kind, draft.content),
			kind: draft.kind,
			tokens,
			uTokens,
			tagNumber: draft.tag?.tagNumber ?? null,
			tagStatus: draft.tag?.status ?? null,
			protected: protectedPart,
			queuedForDrop,
		};
	});
	const clampedT = Math.max(0, t);
	return {
		u: Math.min(clampedT, Math.max(0, u)),
		t: clampedT,
		contentSignature: fnv1a32(
			parts.map((part) => `${part.key}:${part.contentHash}`).join("\0"),
		),
		parts,
		newestMessagePartStart: Math.min(
			Math.max(0, newestMessagePartStart),
			parts.length,
		),
	};
}

export function measurePiTailHygiene(
	input: PiTailHygieneWalkInput,
): TailHygieneMeasurement & { realUserTurnCount: number } {
	partJsonMemo.beginPass();
	excludedViews = new WeakMap();
	// Standalone walk/refresh callers can omit providerApi. The context handler
	// supplies ctx.model.api so a model switch uses the active request converter,
	// not the API recorded on an older assistant message.
	let providerApi = input.providerApi;
	if (providerApi === undefined) {
		for (let index = input.messages.length - 1; index >= 0; index--) {
			const message = input.messages[index];
			if (
				isRecord(message) &&
				message.role === "assistant" &&
				typeof message.api === "string"
			) {
				providerApi = message.api;
				break;
			}
		}
	}
	const excludedDraft = (key: string, value: unknown): DraftPart =>
		excludedDraftForApi(key, value, providerApi);
	const { arcs, arcByPart, messageIds } = collectToolArcs(input);
	const { messageTags, tagsByNumber } = attributeTags(input, arcs, messageIds);
	const drafts: DraftPart[] = [];
	let newestMessagePartStart = 0;
	let realUserTurnCount = 0;

	for (
		let messageIndex = 0;
		messageIndex < input.messages.length;
		messageIndex += 1
	) {
		const raw = input.messages[messageIndex];
		if (messageIndex === input.messages.length - 1)
			newestMessagePartStart = drafts.length;
		const messageKey = messageIds[messageIndex] ?? `pi-message:${messageIndex}`;
		if (!isRecord(raw)) {
			drafts.push(excludedDraft(`${messageKey}\0excluded`, raw));
			continue;
		}
		if (isSyntheticMessage(raw, messageIndex, input)) {
			drafts.push(excludedDraft(`${messageKey}\0synthetic`, raw));
			continue;
		}
		const role = raw.role;
		if (role === "user") realUserTurnCount++;
		if (role !== "user" && role !== "assistant" && role !== "toolResult") {
			drafts.push(excludedDraft(`${messageKey}\0excluded-role`, raw));
			continue;
		}
		if (typeof raw.content === "string") {
			const content = raw.content;
			const tag =
				parseVisibleTag(content, tagsByNumber) ??
				messageTags.get(`${messageKey}:p0`);
			if (!content || isDropSentinel(content)) {
				drafts.push(excludedDraft(`${messageKey}\0text:0`, content));
			} else {
				drafts.push({
					key: `${messageKey}\0text:0`,
					kind: "text",
					content,
					tokens: memoizedTokens("text", content),
					tag,
				});
			}
			continue;
		}
		if (!Array.isArray(raw.content)) {
			drafts.push(
				excludedDraft(`${messageKey}\0excluded-content`, raw.content),
			);
			continue;
		}
		let textOrdinal = 0;
		for (let partIndex = 0; partIndex < raw.content.length; partIndex += 1) {
			const part = raw.content[partIndex];
			const key = `${messageKey}\0${partIndex}`;
			if (!isRecord(part)) {
				drafts.push(excludedDraft(`${key}\0excluded`, part));
				continue;
			}
			if (part.syntheticTodoMarker === true) {
				drafts.push(excludedDraft(`${key}\0synthetic-todo`, part));
				continue;
			}
			if (
				part.type === "thinking" ||
				part.type === "reasoning" ||
				part.type === "redacted_thinking"
			) {
				drafts.push(excludedDraft(`${key}\0reasoning`, part));
				continue;
			}
			if (part.type === "text" && typeof part.text === "string") {
				if (role === "toolResult") {
					const arc = arcByPart.get(part);
					const content = stripChannel1ReminderSpans(part.text);
					const tag = parseVisibleTag(content, tagsByNumber) ?? arc?.tag;
					if (!content) {
						drafts.push(excludedDraft(`${key}\0toolOutput`, content));
					} else {
						drafts.push({
							key: `${key}\0toolOutput`,
							kind: "toolOutput",
							content,
							tokens: memoizedTokens("toolOutput", content),
							tag: arc?.sentinel ? undefined : tag,
						});
					}
					continue;
				}
				const content = stripChannel1ReminderSpans(part.text);
				const tag =
					parseVisibleTag(content, tagsByNumber) ??
					messageTags.get(`${messageKey}:p${textOrdinal}`);
				textOrdinal += 1;
				if (!content || isDropSentinel(content)) {
					drafts.push(excludedDraft(`${key}\0text`, content));
				} else {
					drafts.push({
						key: `${key}\0text`,
						kind: "text",
						content,
						tokens: memoizedTokens("text", content),
						tag,
					});
				}
				continue;
			}
			if (part.type === "image") {
				const image = imageContentAndTokens(part);
				const arc = role === "toolResult" ? arcByPart.get(part) : undefined;
				const tag =
					arc?.tag ?? messageTags.get(`${messageKey}:file${partIndex}`);
				if (arc?.sentinel || !image.content) {
					drafts.push(excludedDraft(`${key}\0image`, part));
				} else {
					drafts.push({
						key: `${key}\0${role === "toolResult" ? "toolOutput" : "file"}`,
						kind: role === "toolResult" ? "toolOutput" : "file",
						content: image.content,
						tokens: image.tokens,
						tag,
					});
				}
				continue;
			}
			if (part.type === "toolCall") {
				const arc = arcByPart.get(part);
				const callId = typeof part.id === "string" ? part.id : "";
				if (
					part.syntheticTodoMarker === true ||
					callId.startsWith(SYNTHETIC_TODO_PREFIX)
				) {
					drafts.push(excludedDraft(`${key}\0toolInput`, part));
					continue;
				}
				const content = partJsonMemo.get(`${key}\0input`, part.arguments, () =>
					safeStableStringify(part.arguments),
				);
				if (!content) {
					drafts.push(excludedDraft(`${key}\0toolInput`, part));
				} else {
					drafts.push({
						key: `${key}\0toolInput`,
						kind: "toolInput",
						content,
						tokens: memoizedTokens("toolInput", content),
						tag: arc?.sentinel ? undefined : arc?.tag,
					});
				}
				continue;
			}
			drafts.push(excludedDraft(`${key}\0excluded`, part));
		}
	}
	return {
		...finalizeParts(
			drafts,
			input.pendingDropTagNumbers ?? new Set<number>(),
			input.protectedTagNumbers,
			newestMessagePartStart,
			input.protectedToolTags,
		),
		realUserTurnCount,
	};
}

export function refreshPiTailHygieneBaseline(
	input: PiTailHygieneWalkInput & {
		cacheBusting: boolean;
		protectedTools?: Readonly<Record<string, number>>;
		previous?: TailHygieneBaseline;
		calibration?: { toolsRatio: number; proseRatio: number };
		hygieneUnitsVersion?: number;
		now?: number;
	},
): TailHygieneBaseline & { realUserTurnCount: number } {
	const protectedToolsPolicy = adoptedProtectedToolsPolicy(
		input.protectedTools,
		input.previous?.protectedToolsPolicy,
		input.cacheBusting,
		!!input.previous,
	);
	input = {
		...input,
		protectedToolTags: protectedToolTagNumbers(
			input.tags,
			protectedToolsPolicy,
		),
	};
	const rawMeasured = measurePiTailHygiene(input);
	const frozenCalibration =
		!input.cacheBusting && input.previous
			? {
					toolsRatio: input.previous.toolsRatio,
					proseRatio: input.previous.proseRatio,
					hygieneUnitsVersion: input.previous.hygieneUnitsVersion,
				}
			: {
					toolsRatio: input.calibration?.toolsRatio ?? 1,
					proseRatio: input.calibration?.proseRatio ?? 1,
					hygieneUnitsVersion: input.hygieneUnitsVersion ?? 1,
				};
	const measured: TailHygieneMeasurement = {
		...rawMeasured,
		parts: rawMeasured.parts.map((part) => {
			const ratio =
				part.kind === "toolInput" || part.kind === "toolOutput"
					? frozenCalibration.toolsRatio
					: part.kind === "text" || part.kind === "file"
						? frozenCalibration.proseRatio
						: 1;
			return {
				...part,
				tokens: part.tokens * ratio,
				uTokens: part.uTokens * ratio,
			};
		}),
	};
	const now = input.now ?? Date.now();
	const refrozen = (
		mismatch?: TailHygienePrefixMismatch,
	): TailHygieneBaseline & { realUserTurnCount: number } =>
		rememberCurrentToolOutputCount(
			{
				...freezeTailHygieneMeasurement(measured),
				protectedToolsPolicy,
				hygieneUnitsVersion: frozenCalibration.hygieneUnitsVersion,
				toolsRatio: frozenCalibration.toolsRatio,
				proseRatio: frozenCalibration.proseRatio,
				baselineGeneration: (input.previous?.baselineGeneration ?? 0) + 1,
				computedAt: now,
				evaluable: true,
				generationInvalidated: false,
				contentSignature: measured.contentSignature,
				channel1PostReduceGrace: input.previous?.channel1PostReduceGrace,
				lastPrefixMismatch: mismatch,
				realUserTurnCount: rawMeasured.realUserTurnCount,
			},
			measured,
		);
	if (input.cacheBusting || !input.previous) return refrozen();

	const prefix = compareMeasuredTailPrefix(
		input.previous.baselineParts,
		measured.parts,
	);
	// A defer pass cannot attribute this change to an append, and this walk measures
	// the rendered tail rather than producing wire bytes, so re-measure instead of
	// holding the stale baseline until the next cache-busting pass. Holding left the
	// reclaim reminders unevaluable for as long as the session went without a bust.
	if (!prefix.valid) return refrozen(prefix.mismatch);
	let turnDeltaT = 0;
	// Queue membership is an action-state delta: it reduces the actionable token
	// backlog while the frozen baseline and still-rendered token total remain unchanged.
	let turnDeltaU = prefix.boundaryAdvanceU + prefix.queuedDropDeltaU;
	for (
		let index = input.previous.baselineParts.length;
		index < measured.parts.length;
		index += 1
	) {
		const part = measured.parts[index];
		turnDeltaT += part.tokens;
		// Tool-output tokens are not reclaimable while their parts are protected. As new
		// outputs extend the measured tail, include outputs that have aged out of protection.
		if (part.kind !== "toolOutput" || !part.protected)
			turnDeltaU += part.uTokens;
	}
	return rememberCurrentToolOutputCount(
		{
			...input.previous,
			protectedToolsPolicy,
			turnDeltaU,
			turnDeltaT,
			evaluable: true,
			generationInvalidated: false,
			contentSignature: measured.contentSignature,
			lastPrefixMismatch: undefined,
			realUserTurnCount: rawMeasured.realUserTurnCount,
		},
		measured,
	);
}

export function effectivePiTailHygiene(
	baseline: Pick<
		TailHygieneBaseline,
		"baselineU" | "baselineT" | "turnDeltaU" | "turnDeltaT"
	>,
): { u: number; t: number } {
	const t = Math.ceil(Math.max(0, baseline.baselineT + baseline.turnDeltaT));
	const u = Math.min(
		t,
		Math.ceil(Math.max(0, baseline.baselineU + baseline.turnDeltaU)),
	);
	return { u, t };
}

export function measurePiToolResultDelta(content: readonly unknown[]): number {
	let tokens = 0;
	for (const part of content) {
		if (!isRecord(part)) continue;
		if (part.type === "text" && typeof part.text === "string") {
			const text = stripChannel1ReminderSpans(part.text);
			if (text && !isDropSentinel(text))
				tokens += memoizedTokens("toolOutput", text);
		} else if (part.type === "image") {
			tokens += imageContentAndTokens(part).tokens;
		}
	}
	return Math.max(0, tokens);
}

export function assertPiTailHygieneContentUnchanged(
	input: PiTailHygieneWalkInput & { expectedSignature: string },
): void {
	const current = measurePiTailHygiene(input);
	if (current.contentSignature !== input.expectedSignature) {
		throw new Error(
			"Pi tail hygiene walk was not the last byte-affecting operation",
		);
	}
}

import { adoptedProtectedToolsPolicy } from "@magic-context/core/features/magic-context/reclaim-protection";
