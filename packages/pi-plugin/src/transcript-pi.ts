/**
 * Pi adapter for the harness-agnostic transcript interface.
 *
 * Pi delivers messages via `pi.on("context", ...)` as `AgentMessage[]`
 * (from `@earendil-works/pi-agent-core`). The event handler returns
 * `{ messages: AgentMessage[] }` to mutate the LLM-bound message array.
 * Unlike OpenCode where `Part.text` is mutated in place, Pi messages
 * have content arrays of typed parts (`TextContent | ThinkingContent
 * | ToolCall` for assistant; `TextContent | ImageContent` for user;
 * `(TextContent | ImageContent)[]` for toolResult). Because the Pi event
 * API expects the handler to RETURN a message array (rather than mutate
 * the passed-in one), we accumulate dirty-message tracking inside the
 * adapter and rebuild affected messages on `commit()`.
 *
 * ## Shape normalization
 *
 * The transform pipeline is OpenCode-shaped: it expects user messages
 * to contain tool_result parts (because OpenCode folds tool results
 * into the next user message). Pi keeps tool results as separate
 * top-level `ToolResultMessage` entries with role `"toolResult"`. The
 * normalization happens here:
 *
 *   - Adjacent `toolResult` messages preceding a user message are
 *     surfaced as `kind: "tool_result"` parts of that user message in
 *     the transcript view, NOT as separate transcript messages. Their
 *     positions in the source array are tracked so `commit()` can write
 *     mutations back to the original `ToolResultMessage` entries.
 *
 *   - When no user message follows a run of toolResults (e.g. the
 *     conversation tail ends with assistant + tool_result), they
 *     surface as a synthetic message with role `"user"` to preserve
 *     transform invariants. The synthetic message gets a deterministic
 *     `synth-user-<toolResultEntryId>` id so tags can bind to the tail
 *     tool output across transform passes.
 *
 * This is the *only* shape normalization the adapter performs. Anything
 * else (compaction markers, ordinal tracking, session-fact rendering)
 * is the transform pipeline's responsibility, not the adapter's.
 *
 * ## Mutation tracking
 *
 * Each part proxy holds a back-pointer to its source location: the
 * containing AgentMessage and the index into that message's content
 * array (or for tool_result parts surfaced into a user message, the
 * index of the source ToolResultMessage in the original array plus the
 * index into its content). On any mutating call (`setText`,
 * `setToolOutput`, `replaceWithSentinel`), the adapter marks the source
 * AgentMessage as dirty. `commit()` rebuilds dirty messages with the
 * mutated content and assembles the final `AgentMessage[]` for the
 * `pi.on("context", ...)` handler to return.
 *
 * ## Why not mutate AgentMessage content arrays in place?
 *
 * Two reasons:
 *
 *   1. AgentMessage content entries are typed unions and TypeScript
 *      treats them as readonly when we want to swap a `TextContent` for
 *      a sentinel that's also a `TextContent` — the unions don't allow
 *      heterogeneous in-place index assignment cleanly.
 *
 *   2. Pi's event API contract is "return a new array". Even if we
 *      mutate in place, returning the original array is allowed but
 *      doesn't give callers any guarantee about which messages
 *      changed. By tracking dirty messages explicitly we can, in the
 *      future, return only changed messages or skip rebuilding
 *      unchanged ones.
 *
 * Step 4b.1 ships the adapter contract. Step 4b.2 wires it into the
 * tagging+drops layer (which today only knows about MessageLike[]).
 */

import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { isRecord } from "@magic-context/core/shared/record-type-guard";
import type {
	Transcript,
	TranscriptMessage,
	TranscriptPart,
	TranscriptPartKind,
} from "@magic-context/core/shared/transcript";
import { hasUserAnswerMetadata } from "@magic-context/core/shared/user-answer";
import {
	canRemoveNativeToolCall,
	removeNativeToolCall,
} from "./native-replay-pi";
import { resolvePiHarnessKind } from "./pi-harness-kind";
import { resolvePiStableId, SYNTH_USER_ID_PREFIX } from "./read-session-pi";
import { isPiSystemEntry, type PiSystemEntry } from "./system-entry-pi";

// We re-declare the minimal subset of pi-ai message shapes we need.
// Importing from @earendil-works/pi-ai directly would couple the plugin
// build to pi-ai's exact version; the test fixtures in 4b.2 will need
// to construct synthetic messages, and a local type makes that easier.
// The shape MUST stay structurally compatible with pi-ai's exports.

type PiTextContent = { type: "text"; text: string; textSignature?: string };
type PiThinkingContent = {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
	redacted?: boolean;
};
type PiImageContent = { type: "image"; data: string; mimeType: string };
type PiToolCall = {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	thoughtSignature?: string;
};

type PiUserMessage = {
	role: "user";
	content: string | (PiTextContent | PiImageContent)[];
	timestamp: number;
};

type PiAssistantMessage = {
	role: "assistant";
	content: (PiTextContent | PiThinkingContent | PiToolCall)[];
	api: string;
	provider: string;
	model: string;
	responseId?: string;
	usage: unknown;
	stopReason: string;
	errorMessage?: string;
	timestamp: number;
};

type PiToolResultMessage = {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (PiTextContent | PiImageContent)[];
	details?: unknown;
	isError: boolean;
	timestamp: number;
};

type PiAgentMessage =
	| PiUserMessage
	| PiAssistantMessage
	| PiToolResultMessage
	| PiSystemEntry;
type MarkDirty = (messageIndex: number, toolCallId?: string) => void;

/**
 * Wrap a Pi `AgentMessage[]` as a Transcript. Builds the normalized
 * view (folding tool results into user messages) up front, then proxies
 * mutations through the adapter's dirty-message tracking.
 *
 * Accepts `unknown[]` rather than the actual `AgentMessage[]` from
 * `@earendil-works/pi-agent-core` because that type embeds CustomAgentMessages
 * declared via module augmentation, which makes generic inference brittle
 * across pi-coding-agent versions. We narrow to our recognized roles
 * (user/assistant/toolResult) at runtime; messages with other roles fall
 * through to the opaque path that touches no fields. Safe under TS's
 * structural typing.
 */
export function createPiTranscript(
	source: unknown[],
	sessionId: string | undefined,
	entryIds?: readonly (string | undefined)[],
	options: {
		preserveReasoningToolArcs?: boolean;
		/** Gate first structural application for every arc, including calls without native envelopes. */
		authorizeToolRemoval?: (callId: string) => boolean | "defer";
		/** Optional bulk persistence of the same decisions requested during measurement. */
		authorizeToolRemovals?: (callIds: readonly string[]) => void;
	} = {},
): Transcript & {
	/**
	 * Pi-only escape hatch: returns the rebuilt message array suitable
	 * for `{ messages }` in the `pi.on("context", ...)` result. Returns
	 * the original array if no mutations occurred — preserves identity
	 * so Pi can short-circuit downstream cache invalidation.
	 */
	getOutputMessages(): unknown[];
	/**
	 * Pi-only escape hatch: the mutable `working` array that part proxies
	 * (tagging, drops, caveman) write to and `commit()` flushes back to source.
	 *
	 * Phases that mutate messages OUTSIDE the transcript part API — reasoning
	 * clearing/replay, which empty local `part.thinking` in place — MUST target
	 * this array, not the original `source`. Tagging/drops/caveman
	 * REASSIGN `working[idx]` to fresh spread-copied objects; if reasoning mutated
	 * `source[idx]` (a now-divergent object) instead, the later `commit()` would
	 * overwrite `source[idx] = working[idx]` and silently discard the reasoning
	 * mutation while the cleared-reasoning watermark still advanced — a defer-pass
	 * replay divergence (wire keeps original reasoning, state says cleared) that
	 * busts the prompt cache. Routing reasoning through `working` keeps every
	 * mutation in the single channel `commit()` flushes.
	 */
	getWorkingMessages(): PiAgentMessage[];
	/**
	 * Pi-only change inventory for the native replay stage. Keys are current
	 * working-array indices; values are tool-call IDs whose arguments changed
	 * through a transcript part setter.
	 */
	getToolInputChanges(): ReadonlyMap<number, ReadonlySet<string>>;
	/** Splice emptied tool messages only after the caller captures positional stable IDs. */
	finalizeToolRemovals(): void;
	/** Prepare native removal decisions with one message walk, in tag order. */
	prepareToolRemovalMeasurements(callIds: readonly string[]): void;
} {
	const working = source.slice() as unknown as PiAgentMessage[];
	const dirtyMessages = new Set<number>();
	const removals = new Map<number, Set<number>>();
	toolRemovals.set(working, removals);
	if (options.authorizeToolRemoval)
		toolRemovalAuthorization.set(working, options.authorizeToolRemoval);
	const emptyRemovedMessages = new Set<unknown>();
	const toolInputChanges = new Map<number, Set<string>>();

	// Normalize: fold consecutive toolResult runs into the immediately
	// following user message as tool_result transcript parts. Track
	// source-array locations so commit() can write mutations back.
	const transcriptMessages: TranscriptMessage[] = buildTranscriptView(
		working,
		sessionId,
		(messageIndex, toolCallId) => {
			dirtyMessages.add(messageIndex);
			if (toolCallId === undefined) return;
			let toolCallIds = toolInputChanges.get(messageIndex);
			if (toolCallIds === undefined) {
				toolCallIds = new Set<string>();
				toolInputChanges.set(messageIndex, toolCallIds);
			}
			toolCallIds.add(toolCallId);
		},
		entryIds,
	);

	if (options.preserveReasoningToolArcs === false) {
		for (const message of transcriptMessages)
			message.requiresToolArcSkeleton = false;
	}
	let committed = false;

	return {
		messages: transcriptMessages,
		harness: resolvePiHarnessKind(),
		prepareToolRemovalMeasurements(callIds): void {
			if (!options.authorizeToolRemovals || callIds.length === 0) return;
			const requested = new Set(callIds);
			const eligible = new Set<string>();
			// Match canRemove() exactly. Do not freeze calls whose native envelope
			// cannot be structurally edited, even if they are selected for a skeleton.
			for (const message of working) {
				if (message.role !== "assistant" || !Array.isArray(message.content))
					continue;
				for (const part of message.content) {
					if (
						part.type === "toolCall" &&
						requested.has(part.id) &&
						canRemoveNativeToolCall(message, part.id)
					)
						eligible.add(part.id);
				}
			}
			options.authorizeToolRemovals(
				callIds.filter((callId) => eligible.has(callId)),
			);
		},
		commit(): void {
			if (committed) return;
			committed = true;
			for (const [index, parts] of removals) {
				const message = working[index];
				if (
					(message.role !== "assistant" && message.role !== "toolResult") ||
					!Array.isArray(message.content)
				)
					continue;
				const next = {
					...message,
					content: message.content.filter((_, i) => !parts.has(i)),
				} as PiAgentMessage;
				for (const i of parts) {
					const part = message.content[i];
					if (part?.type === "toolCall") removeNativeToolCall(next, part.id);
				}
				working[index] = next;
				dirtyMessages.add(index);
				const nativeItems = (
					next as { providerPayload?: { items?: unknown[] } }
				).providerPayload?.items;
				if (
					Array.isArray(next.content) &&
					next.content.length === 0 &&
					(!Array.isArray(nativeItems) || nativeItems.length === 0)
				)
					emptyRemovedMessages.add(next);
			}
			// Sync mutations from `working` back into `source` so that
			// any structural changes the caller applies to `source`
			// directly (e.g. `<session-history>` injection's splice +
			// message[0] prepend) compose correctly with our part-level
			// mutations.
			//
			// Without this, source[i] still holds the pre-mutation
			// shape (because part proxies wrote to `working[i]` only)
			// and downstream callers that operate on source would
			// either see stale content or skip mutated items entirely.
			//
			// The two arrays start identical (working = source.slice())
			// so copying just the dirty indices is sufficient.
			for (const idx of dirtyMessages) {
				if (idx < source.length && idx < working.length) {
					(source as unknown as PiAgentMessage[])[idx] = working[idx];
				}
			}
		},
		finalizeToolRemovals(): void {
			for (let i = source.length - 1; i >= 0; i--) {
				if (emptyRemovedMessages.has(source[i])) source.splice(i, 1);
			}
		},
		getOutputMessages(): unknown[] {
			// After commit(), source has all part-level mutations
			// applied AND any structural changes the caller made
			// directly to source (splices, unshifts). Returning source
			// is therefore authoritative.
			return source;
		},
		getWorkingMessages(): PiAgentMessage[] {
			return working;
		},
		getToolInputChanges(): ReadonlyMap<number, ReadonlySet<string>> {
			return toolInputChanges;
		},
	};
}

/**
 * Build the normalized transcript view from a Pi AgentMessage[].
 *
 * Walks the source array once, grouping toolResult runs with the
 * following user message. Each TranscriptMessage holds its parts
 * generated lazily (so part proxies can write back to `working`).
 */
function buildTranscriptView(
	working: PiAgentMessage[],
	sessionId: string | undefined,
	markDirty: MarkDirty,
	entryIds: readonly (string | undefined)[] | undefined,
): TranscriptMessage[] {
	const result: TranscriptMessage[] = [];

	let i = 0;
	while (i < working.length) {
		const msg = working[i];
		if (msg === undefined || isPiSystemEntry(msg)) {
			i += 1;
			continue;
		}

		if (msg.role === "toolResult") {
			// Collect contiguous toolResult run.
			const toolResultRun: { msg: PiToolResultMessage; index: number }[] = [];
			while (i < working.length) {
				const candidate = working[i];
				if (candidate === undefined || candidate.role !== "toolResult") break;
				toolResultRun.push({ msg: candidate, index: i });
				i += 1;
			}

			// Look ahead: if the next message is a user message, fold
			// the tool results into it. Otherwise emit a synthetic user
			// message for the run.
			const next = i < working.length ? working[i] : undefined;
			if (next?.role === "user") {
				result.push(
					createUserTranscriptMessage(
						working,
						i,
						sessionId,
						toolResultRun,
						markDirty,
						entryIds,
					),
				);
				i += 1;
			} else {
				result.push(
					createSyntheticToolResultUserMessage(
						working,
						sessionId,
						toolResultRun,
						markDirty,
						entryIds,
					),
				);
			}
			continue;
		}

		if (msg.role === "user") {
			result.push(
				createUserTranscriptMessage(
					working,
					i,
					sessionId,
					[],
					markDirty,
					entryIds,
				),
			);
			i += 1;
			continue;
		}

		if (msg.role === "assistant") {
			result.push(
				createAssistantTranscriptMessage(
					working,
					i,
					sessionId,
					markDirty,
					entryIds,
				),
			);
			i += 1;
			continue;
		}

		// Unknown role — surface as-is with kind "unknown" parts. Forward
		// compatibility for new Pi message kinds we don't recognize yet.
		result.push(
			createOpaqueTranscriptMessage(working, i, sessionId, markDirty, entryIds),
		);
		i += 1;
	}

	return result;
}

/**
 * Build a transcript message for a user message at `working[index]`,
 * optionally folding preceding toolResult parts into its parts list.
 */
function createUserTranscriptMessage(
	working: PiAgentMessage[],
	index: number,
	sessionId: string | undefined,
	foldedToolResults: { msg: PiToolResultMessage; index: number }[],
	markDirty: MarkDirty,
	entryIds: readonly (string | undefined)[] | undefined,
): TranscriptMessage {
	const userMsg = working[index] as PiUserMessage;

	// Pi user messages can have `content: string` (legacy) or
	// `content: (TextContent | ImageContent)[]`. Normalize: a string
	// becomes a single TextContent with locator pointing at partIndex 0.
	const isStringContent = typeof userMsg.content === "string";

	return {
		info: {
			id: extractStableId(userMsg, index, entryIds),
			role: "user",
			sessionId,
		},
		get parts(): TranscriptPart[] {
			const parts: TranscriptPart[] = [];

			// Folded tool results come FIRST (they precede the user's
			// own content in real conversation order).
			for (const { index: toolResultIndex } of foldedToolResults) {
				const toolMsg = working[toolResultIndex] as PiToolResultMessage;
				toolMsg.content.forEach((_, partIndex) => {
					parts.push(
						createPiToolResultPart(
							working,
							toolResultIndex,
							partIndex,
							markDirty,
						),
					);
				});
			}

			// Then the user's own content.
			if (isStringContent) {
				parts.push(createPiUserStringPart(working, index, markDirty));
			} else if (Array.isArray(userMsg.content)) {
				userMsg.content.forEach((_, partIndex) => {
					parts.push(
						createPiUserArrayPart(working, index, partIndex, markDirty),
					);
				});
			}

			return parts;
		},
	};
}

/**
 * Build a synthetic user message for a tool-result tail (toolResults
 * with no following user message). It uses the same synth-user- prefix
 * convention as read-session-pi.ts, keyed by the first underlying
 * toolResult entry id, so tail tool outputs have a stable tag owner but
 * cannot collide with real SessionEntry ids.
 */
function createSyntheticToolResultUserMessage(
	working: PiAgentMessage[],
	sessionId: string | undefined,
	toolResultRun: { msg: PiToolResultMessage; index: number }[],
	markDirty: MarkDirty,
	entryIds: readonly (string | undefined)[] | undefined,
): TranscriptMessage {
	return {
		info: {
			id: createSyntheticToolResultUserId(toolResultRun, entryIds),
			role: "user",
			sessionId,
		},
		get parts(): TranscriptPart[] {
			const parts: TranscriptPart[] = [];
			for (const { index: toolResultIndex } of toolResultRun) {
				const toolMsg = working[toolResultIndex] as PiToolResultMessage;
				toolMsg.content.forEach((_, partIndex) => {
					parts.push(
						createPiToolResultPart(
							working,
							toolResultIndex,
							partIndex,
							markDirty,
						),
					);
				});
			}
			return parts;
		},
	};
}

function createSyntheticToolResultUserId(
	toolResultRun: { msg: PiToolResultMessage; index: number }[],
	entryIds: readonly (string | undefined)[] | undefined,
): string | undefined {
	const first = toolResultRun[0];
	if (first === undefined) return undefined;
	const stableId = extractStableId(first.msg, first.index, entryIds);
	return stableId === undefined
		? undefined
		: `${SYNTH_USER_ID_PREFIX}${stableId}`;
}

function createAssistantTranscriptMessage(
	working: PiAgentMessage[],
	index: number,
	sessionId: string | undefined,
	markDirty: MarkDirty,
	entryIds: readonly (string | undefined)[] | undefined,
): TranscriptMessage {
	const msg = working[index] as PiAssistantMessage;
	return {
		info: {
			id: extractStableId(msg, index, entryIds),
			role: "assistant",
			sessionId,
		},
		get parts(): TranscriptPart[] {
			return msg.content.map((_, partIndex) =>
				createPiAssistantPart(working, index, partIndex, markDirty),
			);
		},
	};
}

function createOpaqueTranscriptMessage(
	working: PiAgentMessage[],
	index: number,
	sessionId: string | undefined,
	_markDirty: MarkDirty,
	entryIds: readonly (string | undefined)[] | undefined,
): TranscriptMessage {
	const msg = working[index];
	return {
		info: {
			id: extractStableId(msg, index, entryIds),
			role:
				typeof (msg as { role?: string })?.role === "string"
					? (msg as { role: string }).role
					: "unknown",
			sessionId,
		},
		// Unknown messages have no parts as far as the transform is
		// concerned. They pass through unmodified.
		get parts(): TranscriptPart[] {
			return [];
		},
	};
}

/* ------------------------------------------------------------------ */
/* Part proxies                                                       */
/* ------------------------------------------------------------------ */

function createPiUserStringPart(
	working: PiAgentMessage[],
	messageIndex: number,
	markDirty: MarkDirty,
): TranscriptPart {
	return {
		kind: "text",
		// User text parts do not need per-part ids: tagTranscript keys them by
		// the stable parent message id plus text ordinal.
		id: undefined,
		getText(): string | undefined {
			const msg = working[messageIndex] as PiUserMessage | undefined;
			if (msg === undefined) return undefined;
			return typeof msg.content === "string" ? msg.content : undefined;
		},
		setText(newText: string): boolean {
			const msg = working[messageIndex] as PiUserMessage | undefined;
			if (msg === undefined || typeof msg.content !== "string") return false;
			if (msg.content === newText) return false;
			working[messageIndex] = { ...msg, content: newText };
			markDirty(messageIndex);
			return true;
		},
		setToolOutput(): boolean {
			throw new Error("setToolOutput on user-text part");
		},
		getToolMetadata(): {
			toolName: undefined;
			inputByteSize: 0;
			inputTokenCount: 0;
		} {
			return { toolName: undefined, inputByteSize: 0, inputTokenCount: 0 };
		},
		replaceWithSentinel(sentinelText: string): boolean {
			const msg = working[messageIndex] as PiUserMessage | undefined;
			if (msg === undefined) return false;
			working[messageIndex] = { ...msg, content: sentinelText };
			markDirty(messageIndex);
			return true;
		},
	};
}

function createPiUserArrayPart(
	working: PiAgentMessage[],
	messageIndex: number,
	partIndex: number,
	markDirty: MarkDirty,
): TranscriptPart {
	const msg = working[messageIndex] as PiUserMessage;
	const part = Array.isArray(msg.content) ? msg.content[partIndex] : undefined;
	const kind: TranscriptPartKind = classifyContent(part);
	return {
		kind,
		// User array parts are not tool/content units. Text is keyed by parent
		// message id + ordinal; images remain non-droppable user payloads.
		id: undefined,
		getText(): string | undefined {
			const current = (working[messageIndex] as PiUserMessage).content;
			if (!Array.isArray(current)) return undefined;
			const p = current[partIndex];
			if (p?.type === "text") return p.text;
			return undefined;
		},
		setText(newText: string): boolean {
			const current = (working[messageIndex] as PiUserMessage).content;
			if (!Array.isArray(current)) return false;
			const p = current[partIndex];
			if (p?.type !== "text") return false;
			if (p.text === newText) return false;
			const newContent = current.slice();
			newContent[partIndex] = { ...p, text: newText };
			working[messageIndex] = {
				...(working[messageIndex] as PiUserMessage),
				content: newContent,
			};
			markDirty(messageIndex);
			return true;
		},
		setToolOutput(): boolean {
			throw new Error("setToolOutput on non-tool-result part");
		},
		getToolMetadata(): {
			toolName: undefined;
			inputByteSize: 0;
			inputTokenCount: 0;
		} {
			return { toolName: undefined, inputByteSize: 0, inputTokenCount: 0 };
		},
		replaceWithSentinel(sentinelText: string): boolean {
			const current = (working[messageIndex] as PiUserMessage).content;
			if (!Array.isArray(current)) return false;
			const newContent = current.slice();
			newContent[partIndex] = { type: "text", text: sentinelText };
			working[messageIndex] = {
				...(working[messageIndex] as PiUserMessage),
				content: newContent,
			};
			markDirty(messageIndex);
			return true;
		},
	};
}

function createPiAssistantPart(
	working: PiAgentMessage[],
	messageIndex: number,
	partIndex: number,
	markDirty: MarkDirty,
): TranscriptPart {
	const msg = working[messageIndex] as PiAssistantMessage;
	const part = msg.content[partIndex];
	const kind = classifyAssistantContent(part);
	const id = part?.type === "toolCall" ? part.id : undefined;

	return {
		kind,
		id,
		getText(): string | undefined {
			const current = (working[messageIndex] as PiAssistantMessage).content;
			const p = current[partIndex];
			if (p?.type === "text") return p.text;
			if (p?.type === "thinking") return p.thinking;
			if (p?.type === "toolCall") {
				try {
					return JSON.stringify(p.arguments);
				} catch {
					return undefined;
				}
			}
			return undefined;
		},
		setText(newText: string): boolean {
			const current = (working[messageIndex] as PiAssistantMessage).content;
			const p = current[partIndex];
			if (p?.type === "text") {
				if (p.text === newText) return false;
				const newContent = current.slice();
				newContent[partIndex] = { ...p, text: newText };
				working[messageIndex] = {
					...(working[messageIndex] as PiAssistantMessage),
					content: newContent,
				};
				markDirty(messageIndex);
				return true;
			}
			if (p?.type === "thinking") {
				if (p.thinking === newText) return false;
				const newContent = current.slice();
				newContent[partIndex] = { ...p, thinking: newText };
				working[messageIndex] = {
					...(working[messageIndex] as PiAssistantMessage),
					content: newContent,
				};
				markDirty(messageIndex);
				return true;
			}
			if (p?.type === "toolCall") {
				const replacementArgs = { __magic_context_replacement__: newText };
				try {
					if (JSON.stringify(p.arguments) === JSON.stringify(replacementArgs)) {
						return false;
					}
				} catch {
					// Non-serializable args still need to be replaceable.
				}
				const newContent = current.slice();
				// Spread the existing part so optional fields (thoughtSignature)
				// survive the rewrite — some providers reject a tool call whose
				// signature was stripped on re-send. Only `arguments` changes.
				newContent[partIndex] = {
					...p,
					arguments: replacementArgs,
				};
				working[messageIndex] = {
					...(working[messageIndex] as PiAssistantMessage),
					content: newContent,
				};
				markDirty(messageIndex, p.id);
				return true;
			}
			return false;
		},
		setToolOutput(): boolean {
			// Assistant messages don't have tool outputs in Pi — those
			// live in separate ToolResultMessage entries (handled by
			// createPiToolResultPart). Calling this on an assistant
			// part is always a programming error.
			throw new Error("setToolOutput on assistant part");
		},
		getToolMetadata(): {
			toolName: string | undefined;
			inputByteSize: number;
			inputTokenCount: number;
		} {
			const current = (working[messageIndex] as PiAssistantMessage).content;
			const p = current[partIndex];
			if (p?.type !== "toolCall") {
				return { toolName: undefined, inputByteSize: 0, inputTokenCount: 0 };
			}
			let inputByteSize = 0;
			let inputTokenCount = 0;
			try {
				const serialized = JSON.stringify(p.arguments);
				inputByteSize = serialized.length;
				inputTokenCount = serialized ? estimateTokens(serialized) : 0;
			} catch {
				inputByteSize = 0;
				inputTokenCount = 0;
			}
			return { toolName: p.name, inputByteSize, inputTokenCount };
		},
		getToolInput(): Record<string, unknown> | null {
			const current = (working[messageIndex] as PiAssistantMessage).content;
			const p = current[partIndex];
			if (p?.type !== "toolCall") return null;
			return p.arguments && typeof p.arguments === "object"
				? (p.arguments as Record<string, unknown>)
				: null;
		},
		setToolInput(input: Record<string, unknown>): boolean {
			const current = (working[messageIndex] as PiAssistantMessage).content;
			const p = current[partIndex];
			if (p?.type !== "toolCall") return false;
			try {
				if (JSON.stringify(p.arguments) === JSON.stringify(input)) return false;
			} catch {
				// non-serializable args: still replace
			}
			const newContent = current.slice();
			// Spread to preserve optional fields (id, name, thoughtSignature);
			// only `arguments` changes (mirrors setText's toolCall path).
			newContent[partIndex] = { ...p, arguments: input };
			working[messageIndex] = {
				...(working[messageIndex] as PiAssistantMessage),
				content: newContent,
			};
			markDirty(messageIndex, p.id);
			return true;
		},
		canRemove(): boolean | "defer" {
			const message = working[messageIndex] as PiAssistantMessage;
			const part = message.content[partIndex];
			if (
				part?.type !== "toolCall" ||
				!canRemoveNativeToolCall(message, part.id)
			)
				return false;
			return toolRemovalAuthorization.get(working)?.(part.id) ?? true;
		},
		remove(): boolean {
			return markToolRemoval(working, messageIndex, partIndex);
		},
		// Replace this assistant part's content with a sentinel placeholder.
		//
		// CRITICAL for toolCall parts: we MUST preserve `{ type: "toolCall",
		// id, name }` so the Pi → provider serializer still emits a
		// `function_call` / `tool_use` block with the original `call_id`.
		// The corresponding `toolResult` message in the conversation
		// references that same `call_id` (via `toolCallId`); breaking the
		// pairing causes the provider to reject the request with
		// errors like "No tool call found for function call output with
		// call_id …" (Codex) or "tool_use blocks must be followed by
		// matching tool_result blocks" (Anthropic).
		//
		// We therefore keep the toolCall shell with its id + name and
		// reduce `arguments` to a tiny marker object. Bulk argument
		// content is what we really want to drop; the structural shape
		// stays intact so message-pair integrity holds across the
		// API boundary.
		//
		// For non-toolCall assistant parts (text / thinking) we still
		// fall back to a plain text-sentinel replacement — those have no
		// pairing constraint and the bulk reduction is the only goal.
		replaceWithSentinel(sentinelText: string): boolean {
			const current = (working[messageIndex] as PiAssistantMessage).content;
			const existing = current[partIndex];
			const newContent = current.slice();
			if (existing && existing.type === "toolCall") {
				// Spread the existing part so optional fields (thoughtSignature)
				// survive the sentinel rewrite — the toolCall shell must stay a
				// faithful, provider-acceptable function_call/tool_use; only the
				// bulk `arguments` payload is reduced to the marker.
				newContent[partIndex] = {
					...existing,
					arguments: { dropped: sentinelText },
				};
			} else {
				newContent[partIndex] = { type: "text", text: sentinelText };
			}
			working[messageIndex] = {
				...(working[messageIndex] as PiAssistantMessage),
				content: newContent,
			};
			markDirty(
				messageIndex,
				existing?.type === "toolCall" ? existing.id : undefined,
			);
			return true;
		},
	};
}

function createPiToolResultPart(
	working: PiAgentMessage[],
	messageIndex: number,
	partIndex: number,
	markDirty: MarkDirty,
): TranscriptPart {
	const msg = working[messageIndex] as PiToolResultMessage;
	// Every block inside one Pi ToolResultMessage belongs to the same
	// droppable tool-output unit. Expose images as tool_result (not image)
	// so tagTranscript aggregates text + image blocks under msg.toolCallId
	// and a single drop replaces the whole result.
	const kind: TranscriptPartKind = "tool_result";
	return {
		kind,
		id: msg.toolCallId,
		remove(): boolean {
			return markToolRemoval(working, messageIndex, partIndex);
		},
		getText(): string | undefined {
			const current = (working[messageIndex] as PiToolResultMessage).content;
			const p = current[partIndex];
			return p?.type === "text" ? p.text : undefined;
		},
		setText(newText: string): boolean {
			// For tagging purposes, we do allow mutating the text of the
			// surfaced tool_result text slot. setToolOutput is the
			// canonical channel but setText is symmetric for tagging.
			const current = (working[messageIndex] as PiToolResultMessage).content;
			const p = current[partIndex];
			if (p?.type !== "text") return false;
			if (p.text === newText) return false;
			const newContent = current.slice();
			newContent[partIndex] = { ...p, text: newText };
			working[messageIndex] = {
				...(working[messageIndex] as PiToolResultMessage),
				content: newContent,
			};
			markDirty(messageIndex);
			return true;
		},
		setToolOutput(newText: string): boolean {
			// Truncated-mode drops route through here. setText() only mutates
			// `type:"text"` blocks, so an image (or any non-text) block in a tool
			// result would be left INTACT — the model would still see the image
			// bytes while the text became "[truncated]", and the drop bookkeeping
			// would overstate reclaimed space. Rewrite a non-text block to a text
			// sentinel (same conversion replaceWithSentinel does) so the whole
			// tool-result block is actually truncated. setText() is deliberately
			// NOT broadened — it's used by tag-prefix injection on normal passes,
			// where converting images would corrupt the wire.
			const current = (working[messageIndex] as PiToolResultMessage).content;
			const p = current[partIndex];
			if (p?.type === "text") return this.setText(newText);
			const newContent = current.slice();
			newContent[partIndex] = { type: "text", text: newText };
			working[messageIndex] = {
				...(working[messageIndex] as PiToolResultMessage),
				content: newContent,
			};
			markDirty(messageIndex);
			return true;
		},
		getToolMetadata(): {
			toolName: string;
			inputByteSize: number;
			inputTokenCount: number;
		} {
			return {
				toolName: (working[messageIndex] as PiToolResultMessage).toolName,
				inputByteSize: 0,
				inputTokenCount: 0,
			};
		},
		hasUserAnswer(): boolean {
			return hasUserAnswerMetadata(
				(working[messageIndex] as PiToolResultMessage).details,
			);
		},
		replaceWithSentinel(sentinelText: string): boolean {
			const current = (working[messageIndex] as PiToolResultMessage).content;
			const newContent = current.slice();
			newContent[partIndex] = { type: "text", text: sentinelText };
			working[messageIndex] = {
				...(working[messageIndex] as PiToolResultMessage),
				content: newContent,
			};
			markDirty(messageIndex);
			return true;
		},
		rawByteSize(): number {
			// Serialize the actual block so a non-text (image / structured)
			// tool-result is sized by its real payload, not the ~0 bytes that
			// getText() would report. Emergency-drop reclaim math depends on this.
			const current = (working[messageIndex] as PiToolResultMessage).content;
			const p = current[partIndex];
			if (p?.type === "text") return Buffer.byteLength(p.text, "utf8");
			try {
				return Buffer.byteLength(JSON.stringify(p ?? null), "utf8");
			} catch {
				return 0;
			}
		},
	};
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function classifyContent(part: unknown): TranscriptPartKind {
	if (!isRecord(part)) return "unknown";
	if (part.type === "text") return "text";
	if (part.type === "image") return "image";
	return "unknown";
}

function classifyAssistantContent(part: unknown): TranscriptPartKind {
	if (!isRecord(part)) return "unknown";
	if (part.type === "text") return "text";
	if (part.type === "thinking") return "thinking";
	if (part.type === "toolCall") return "tool_use";
	return "unknown";
}

/**
 * Pi messages don't carry a stable per-message id at the type level —
 * the SessionEntry layer wraps them with an entryId in the JSONL store,
 * but at the AgentMessage[] level we only have the message itself. As
 * a stable surrogate we use:
 *
 *   `pi-msg-${index}-${timestamp}-${role}`
 *
 * This is stable WITHIN a transform pass (the source array doesn't
 * change between adapter creation and commit) but NOT across passes if
 * messages get prepended/inserted. Cross-pass tracking should rely on
 * Pi's session-entry IDs from `ctx.sessionManager.getBranch()`, NOT on
 * these synthetic IDs. Step 4b.3 wires the session-entry layer.
 */
function extractStableId(
	msg: PiAgentMessage | undefined,
	index: number,
	entryIds: readonly (string | undefined)[] | undefined,
): string | undefined {
	// Single source of truth: prefer the real SessionEntry id (position-
	// independent → tags/source_contents/caveman keyed on it survive array
	// shifts), fall back to the unstable pi-msg-index id only when none resolves.
	// No entryIdByRef here: tagging runs at transcript-build time on the freshly
	// sliced `working` array, so positional entryIds[index] is exactly aligned.
	return resolvePiStableId(msg, index, entryIds);
}

// Part proxies keep positional indices until commit; splicing earlier would retarget later mutations.
const toolRemovals = new WeakMap<PiAgentMessage[], Map<number, Set<number>>>();
const toolRemovalAuthorization = new WeakMap<
	PiAgentMessage[],
	(callId: string) => boolean | "defer"
>();
function markToolRemoval(
	working: PiAgentMessage[],
	messageIndex: number,
	partIndex: number,
): boolean {
	const removals = toolRemovals.get(working);
	if (!removals) return false;
	const parts = removals.get(messageIndex) ?? new Set<number>();
	if (parts.has(partIndex)) return false;
	parts.add(partIndex);
	removals.set(messageIndex, parts);
	return true;
}
