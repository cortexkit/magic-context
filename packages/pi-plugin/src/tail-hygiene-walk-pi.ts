import type { TagEntry } from "@magic-context/core/features/magic-context/types";
import { estimateImageTokensFromDataUrl } from "@magic-context/core/hooks/magic-context/image-token-estimate";
import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import {
	stripChannel1ReminderSpans,
	type TailHygieneBaseline,
	type TailHygieneMeasurement,
	type TailHygienePartKind,
	type TailHygienePartMeasurement,
} from "@magic-context/core/hooks/magic-context/tail-hygiene-walk";
import { PI_CTX_REDUCE_KEEP } from "./heuristic-cleanup-pi";

const TAG_PREFIX = /^§(\d+)§\s*/;
const SYNTHETIC_TODO_PREFIX = "mc_synthetic_todo_";
const MAX_CONTENT_MEMO_ENTRIES = 100_000;
const MAX_CONTENT_MEMO_BYTES = 64 * 1024 * 1024;
const contentMemo = new Map<
	string,
	{ hash: string; tokens: number; keyBytes: number }
>();
let contentMemoBytes = 0;
const FNV1A_32_OFFSET = 0x811c9dc5;
const FNV1A_32_PRIME = 0x01000193;

export interface PiTailHygieneWalkInput {
	messages: readonly unknown[];
	tags: readonly TagEntry[];
	protectedTags: number;
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
	tag?: TagEntry;
	parts: Record<string, unknown>[];
}

interface DraftPart {
	key: string;
	kind: TailHygienePartKind;
	content: string;
	tokens: number;
	tag?: TagEntry;
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
): { hash: string; tokens: number } {
	const key = `${kind}\0${content}`;
	const cached = contentMemo.get(key);
	if (cached) return cached;
	const measured = {
		hash: fnv1a32(key),
		tokens: kind === "excluded" ? 0 : estimateTokens(content),
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
	return memoizedContent(kind, content).tokens;
}

function partHash(kind: TailHygienePartKind, content: string): string {
	return memoizedContent(kind, content).hash;
}

function parseVisibleTag(
	content: string,
	tagsByNumber: ReadonlyMap<number, TagEntry>,
): TagEntry | undefined {
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
	return role === "system" || role === "custom" || role === "compactionSummary";
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

function messageIdForTag(tag: TagEntry): string | null {
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

function attributeTags(
	input: PiTailHygieneWalkInput,
	arcs: readonly PiToolArc[],
	messageIds: readonly string[],
): {
	messageTags: ReadonlyMap<string, TagEntry>;
	tagsByNumber: ReadonlyMap<number, TagEntry>;
} {
	const messageTags = new Map<string, TagEntry>();
	const tagsByNumber = new Map<number, TagEntry>();
	const exactToolTags = new Map<string, TagEntry>();
	const orphanTagsByCall = new Map<string, TagEntry[]>();
	const messageIndexById = new Map<string, number>();
	for (let index = 0; index < messageIds.length; index += 1) {
		const id = input.stableId?.(input.messages[index], index);
		if (id) messageIndexById.set(id, index);
	}
	const boundsByMessageIndex = new Map<number, { min: number; max: number }>();

	for (const tag of input.tags) {
		tagsByNumber.set(tag.tagNumber, tag);
		if (tag.type === "tool") {
			if (tag.toolOwnerMessageId === null) {
				const rows = orphanTagsByCall.get(tag.messageId) ?? [];
				rows.push(tag);
				orphanTagsByCall.set(tag.messageId, rows);
			} else {
				exactToolTags.set(`${tag.toolOwnerMessageId}\0${tag.messageId}`, tag);
			}
		} else {
			messageTags.set(tag.messageId, tag);
		}
		const ownerId = messageIdForTag(tag);
		const messageIndex =
			ownerId === null ? undefined : messageIndexById.get(ownerId);
		if (messageIndex === undefined) continue;
		const current = boundsByMessageIndex.get(messageIndex);
		boundsByMessageIndex.set(messageIndex, {
			min: current ? Math.min(current.min, tag.tagNumber) : tag.tagNumber,
			max: current ? Math.max(current.max, tag.tagNumber) : tag.tagNumber,
		});
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

function excludedDraft(key: string, value: unknown): DraftPart {
	return {
		key,
		kind: "excluded",
		content: typeof value === "string" ? value : safeStableStringify(value),
		tokens: 0,
	};
}

function finalizeParts(
	drafts: readonly DraftPart[],
	protectedTags: number,
	pendingDropTagNumbers: ReadonlySet<number>,
): TailHygieneMeasurement {
	const visibleTags = new Map<number, TagEntry>();
	for (const part of drafts) {
		if (part.kind !== "excluded" && part.tag)
			visibleTags.set(part.tag.tagNumber, part.tag);
	}
	const protectedNumbers = new Set(
		[...visibleTags.keys()]
			.sort((left, right) => right - left)
			.slice(0, Math.max(0, protectedTags)),
	);
	const exemplarNumbers = [...visibleTags.values()]
		.filter((tag) => tag.type === "tool" && tag.toolName === "ctx_reduce")
		.sort((left, right) => right.tagNumber - left.tagNumber)
		.slice(0, PI_CTX_REDUCE_KEEP)
		.map((tag) => tag.tagNumber);
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
			draft.tag && !protectedPart && !queuedForDrop && draft.kind !== "excluded"
				? tokens
				: 0;
		t += tokens;
		u += uTokens;
		return {
			key: draft.key,
			contentHash: partHash(draft.kind, draft.content),
			kind: draft.kind,
			tokens,
			uTokens,
			tagNumber: draft.tag?.tagNumber ?? null,
			// Pi derives liveness from rendered sentinels. A visible attributed part is
			// active for baseline/delta purposes regardless of the durable row's status.
			tagStatus: draft.tag ? "active" : null,
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
	};
}

export function measurePiTailHygiene(
	input: PiTailHygieneWalkInput,
): TailHygieneMeasurement {
	const { arcs, arcByPart, messageIds } = collectToolArcs(input);
	const { messageTags, tagsByNumber } = attributeTags(input, arcs, messageIds);
	const drafts: DraftPart[] = [];

	for (
		let messageIndex = 0;
		messageIndex < input.messages.length;
		messageIndex += 1
	) {
		const raw = input.messages[messageIndex];
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
					if (arc?.sentinel || !content || isDropSentinel(content)) {
						drafts.push(excludedDraft(`${key}\0toolOutput`, content));
					} else {
						drafts.push({
							key: `${key}\0toolOutput`,
							kind: "toolOutput",
							content,
							tokens: memoizedTokens("toolOutput", content),
							tag,
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
					callId.startsWith(SYNTHETIC_TODO_PREFIX) ||
					arc?.sentinel
				) {
					drafts.push(excludedDraft(`${key}\0toolInput`, part));
					continue;
				}
				const content = safeStableStringify(part.arguments);
				if (!content) {
					drafts.push(excludedDraft(`${key}\0toolInput`, part));
				} else {
					drafts.push({
						key: `${key}\0toolInput`,
						kind: "toolInput",
						content,
						tokens: memoizedTokens("toolInput", content),
						tag: arc?.tag,
					});
				}
				continue;
			}
			drafts.push(excludedDraft(`${key}\0excluded`, part));
		}
	}
	return finalizeParts(
		drafts,
		input.protectedTags,
		input.pendingDropTagNumbers ?? new Set<number>(),
	);
}

function sameMeasuredPrefix(
	baseline: readonly TailHygienePartMeasurement[],
	current: readonly TailHygienePartMeasurement[],
): { valid: boolean; boundaryAdvanceU: number; queuedDropDeltaU: number } {
	if (current.length < baseline.length)
		return { valid: false, boundaryAdvanceU: 0, queuedDropDeltaU: 0 };
	let boundaryAdvanceU = 0;
	let queuedDropDeltaU = 0;
	for (let index = 0; index < baseline.length; index += 1) {
		const before = baseline[index];
		const after = current[index];
		if (
			before.key !== after.key ||
			before.contentHash !== after.contentHash ||
			before.kind !== after.kind ||
			before.tokens !== after.tokens ||
			before.tagNumber !== after.tagNumber ||
			before.tagStatus !== after.tagStatus
		) {
			return { valid: false, boundaryAdvanceU: 0, queuedDropDeltaU: 0 };
		}
		if (!before.protected && after.protected)
			return { valid: false, boundaryAdvanceU: 0, queuedDropDeltaU: 0 };
		if (before.protected && !after.protected) {
			if (after.tagStatus !== "active")
				return { valid: false, boundaryAdvanceU: 0, queuedDropDeltaU: 0 };
			boundaryAdvanceU += after.uTokens;
		} else if (before.queuedForDrop !== after.queuedForDrop) {
			if (before.tagStatus !== "active" || after.tagStatus !== "active")
				return { valid: false, boundaryAdvanceU: 0, queuedDropDeltaU: 0 };
			queuedDropDeltaU += after.uTokens - before.uTokens;
		} else if (before.uTokens !== after.uTokens) {
			return { valid: false, boundaryAdvanceU: 0, queuedDropDeltaU: 0 };
		}
	}
	return { valid: true, boundaryAdvanceU, queuedDropDeltaU };
}

export function refreshPiTailHygieneBaseline(
	input: PiTailHygieneWalkInput & {
		cacheBusting: boolean;
		previous?: TailHygieneBaseline;
		now?: number;
	},
): TailHygieneBaseline {
	const measured = measurePiTailHygiene(input);
	const now = input.now ?? Date.now();
	if (!input.cacheBusting && input.previous?.generationInvalidated) {
		return { ...input.previous, contentSignature: measured.contentSignature };
	}
	if (input.cacheBusting || !input.previous) {
		return {
			baselineU: measured.u,
			baselineT: measured.t,
			turnDeltaU: 0,
			turnDeltaT: 0,
			baselineGeneration: (input.previous?.baselineGeneration ?? 0) + 1,
			computedAt: now,
			evaluable: true,
			generationInvalidated: false,
			baselineParts: measured.parts,
			contentSignature: measured.contentSignature,
		};
	}

	const prefix = sameMeasuredPrefix(
		input.previous.baselineParts,
		measured.parts,
	);
	if (!prefix.valid) {
		return {
			...input.previous,
			evaluable: false,
			generationInvalidated: true,
			contentSignature: measured.contentSignature,
		};
	}
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
		if (part.kind !== "toolOutput") turnDeltaU += part.uTokens;
	}
	return {
		...input.previous,
		turnDeltaU,
		turnDeltaT,
		evaluable: true,
		generationInvalidated: false,
		contentSignature: measured.contentSignature,
	};
}

export function effectivePiTailHygiene(
	baseline: Pick<
		TailHygieneBaseline,
		"baselineU" | "baselineT" | "turnDeltaU" | "turnDeltaT"
	>,
): { u: number; t: number } {
	const t = Math.max(0, baseline.baselineT + baseline.turnDeltaT);
	const u = Math.min(t, Math.max(0, baseline.baselineU + baseline.turnDeltaU));
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
