/**
 * Pi-side `<session-history>` injection — mirrors OpenCode's
 * `prepareCompartmentInjection` + `renderCompartmentInjection`
 * (packages/plugin/src/hooks/magic-context/inject-compartments.ts).
 *
 * Pi differences:
 *   - Pi messages have `content: string | (TextContent | ImageContent)[]`,
 *     not OpenCode's `parts: unknown[]`. We project Pi messages into a
 *     minimal MessageLike-shaped view so the shared
 *     `prepareCompartmentInjection` can do its DB read + cache lookup +
 *     boundary trim. The actual render writes back to Pi shape.
 *   - Pi messages don't have a stable per-message id at the AgentMessage
 *     layer. We synthesize one using the same `pi-msg-${index}-${ts}-${role}`
 *     scheme `transcript-pi.ts` uses, so the boundary-trim cutoff comparison
 *     stays consistent across passes.
 *
 * Cache safety:
 *   - `prepareCompartmentInjection` honors its own injection cache. On
 *     defer passes (`isCacheBusting=false`) the cached prepared block is
 *     replayed, the boundary trim is re-applied, and we just re-write the
 *     cached block into Pi message[0]. Provider prompt cache stays stable.
 *   - On cache-busting passes (historian/compressor publish, /ctx-flush)
 *     the cache is rebuilt and the new block is written. Caller is
 *     responsible for setting `isCacheBusting` correctly via the shared
 *     historyRefreshSessions signal.
 */

import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import {
	type PreparedCompartmentInjection,
	prepareCompartmentInjection,
} from "@magic-context/core/hooks/magic-context/inject-compartments";
import type { MessageLike } from "@magic-context/core/hooks/magic-context/tag-messages";
import { sessionLog as logSession } from "@magic-context/core/shared/logger";

/**
 * Pi message shapes — kept structurally compatible with
 * `@mariozechner/pi-coding-agent`'s `AgentMessage` union. Same minimal
 * subset transcript-pi.ts uses.
 */
type PiTextContent = { type: "text"; text: string; textSignature?: string };
type PiImageContent = { type: "image"; data: string; mimeType: string };
type PiUserMessage = {
	role: "user";
	content: string | (PiTextContent | PiImageContent)[];
	timestamp?: number;
};
type PiAssistantMessage = {
	role: "assistant";
	content: unknown[];
	timestamp?: number;
};
type PiToolResultMessage = {
	role: "toolResult";
	content: unknown[];
	timestamp?: number;
};
type PiAgentMessage = PiUserMessage | PiAssistantMessage | PiToolResultMessage;

/**
 * Resolve the cross-pass-stable id for the i-th Pi message.
 *
 * Pi historian writes boundary IDs into the `compartments.start_message_id`
 * / `end_message_id` columns using SessionEntry IDs (the JSONL entry UUIDs)
 * via `read-session-pi.ts` → `RawMessage.id = entry.id`. Boundary lookup
 * MUST use the same scheme — otherwise injected `<session-history>` cannot
 * trim raw history because the cutoff id never matches anything in the
 * AgentMessage[] view.
 *
 * Pi's `pi.on("context")` event delivers `AgentMessage[]` only, with no
 * back-reference to the SessionEntry layer. Caller is responsible for
 * walking `ctx.sessionManager.getBranch()`, filtering to message-type
 * entries (the same filter `buildSessionContext` applies), and producing
 * an `entryIds: (string | undefined)[]` array indexed 1:1 with `piMessages`.
 *
 * When `entryIds[i]` is missing or undefined we fall back to a synthesized
 * `pi-msg-${index}-${ts}-${role}` id. That synthesized form has zero
 * cross-pass stability (the index moves whenever earlier messages are
 * trimmed) but is harmless because no compartment boundary will ever
 * match it. The fallback only exists so that the projection has *some*
 * id field for the trim machinery; it never produces a real cutoff.
 */
function resolveStableId(
	msg: PiAgentMessage,
	index: number,
	entryIds: readonly (string | undefined)[] | undefined,
): string {
	const provided = entryIds?.[index];
	if (typeof provided === "string" && provided.length > 0) return provided;
	const ts = msg.timestamp;
	const role = msg.role;
	if (typeof ts !== "number") return `pi-msg-${index}-${role}`;
	return `pi-msg-${index}-${ts}-${role}`;
}

/**
 * Build a minimal MessageLike-shaped projection of Pi messages so the
 * shared compartment-injection trim logic can run. Only the `info.id`
 * field is read (for the `findIndex(m => m.info.id === lastEndMessageId)`
 * cutoff search). `parts` stays empty because the trim logic doesn't
 * read part content.
 *
 * The returned array is a brand-new array, NOT a live view into Pi
 * messages. The shared `prepareCompartmentInjection` calls `splice` on
 * this projection to remove covered messages — those mutations stay
 * local to the projection and we map the resulting cutoff back to Pi
 * messages ourselves.
 */
function buildMessageLikeProjection(
	piMessages: PiAgentMessage[],
	entryIds: readonly (string | undefined)[] | undefined,
): MessageLike[] {
	const projection: MessageLike[] = [];
	for (let i = 0; i < piMessages.length; i++) {
		const msg = piMessages[i];
		if (!msg) continue;
		projection.push({
			info: {
				id: resolveStableId(msg, i, entryIds),
				role: msg.role,
				sessionID: undefined,
			},
			parts: [],
		});
	}
	return projection;
}

/**
 * Mutate `piMessages` in place: remove every message whose synthesized
 * id appears at or before the cutoff. Preserves the rest of the array.
 *
 * Mirrors the `messages.splice(0, cutoffIndex+1)` behavior the shared
 * `prepareCompartmentInjection` does on its (OpenCode) MessageLike[].
 *
 * Returns the count of messages removed — used for log parity.
 */
function trimPiMessagesToBoundary(
	piMessages: PiAgentMessage[],
	entryIds: readonly (string | undefined)[] | undefined,
	cutoffMessageId: string,
): number {
	if (cutoffMessageId.length === 0) return 0;
	let cutoffIndex = -1;
	for (let i = 0; i < piMessages.length; i++) {
		const msg = piMessages[i];
		if (msg && resolveStableId(msg, i, entryIds) === cutoffMessageId) {
			cutoffIndex = i;
			break;
		}
	}
	if (cutoffIndex < 0) return 0;

	// Collect all toolCall IDs from messages being trimmed. Any
	// immediately-following toolResult messages that reference those IDs
	// would become orphaned (their paired toolCall is gone), causing
	// providers to reject the request. Advance the cutoff past them.
	const removedCallIds = new Set<string>();
	for (let i = 0; i <= cutoffIndex; i++) {
		const msg = piMessages[i];
		if (!msg || msg.role !== "assistant") continue;
		const assistantMsg = msg as { role: "assistant"; content: unknown[] };
		if (!Array.isArray(assistantMsg.content)) continue;
		for (const part of assistantMsg.content) {
			if (
				part &&
				typeof part === "object" &&
				(part as Record<string, unknown>).type === "toolCall" &&
				typeof (part as Record<string, unknown>).id === "string"
			) {
				removedCallIds.add((part as Record<string, unknown>).id as string);
			}
		}
	}
	// Advance past any orphaned toolResult messages.
	if (removedCallIds.size > 0) {
		let i = cutoffIndex + 1;
		while (i < piMessages.length) {
			const msg = piMessages[i];
			if (
				msg &&
				msg.role === "toolResult" &&
				typeof (msg as Record<string, unknown>).toolCallId === "string" &&
				removedCallIds.has(
					(msg as Record<string, unknown>).toolCallId as string,
				)
			) {
				cutoffIndex = i;
				i++;
			} else {
				break;
			}
		}
	}

	const removed = cutoffIndex + 1;
	piMessages.splice(0, removed);
	return removed;
}

/**
 * Find the first user message in the Pi AgentMessage[] and prepend the
 * `<session-history>` block to its first text content. Mirrors
 * OpenCode's `findFirstTextPart` + `textPart.text = block + textPart.text`
 * write pattern.
 *
 * Pi user messages can have `content: string` (legacy) or
 * `content: (TextContent | ImageContent)[]`. For the string case we
 * convert to an array first. For the array case we prepend a new text
 * content block at index 0 (matching how OpenCode injects ahead of any
 * existing text part).
 *
 * If no user message exists at all (e.g. session starts with assistant
 * output, edge case) we synthesize a leading user message holding only
 * the history block — same fallback OpenCode uses (`messages.unshift({
 * info: { role: "user", ... }, parts: [{ type: "text", text: block }] })`).
 *
 * Returns true when an injection happened.
 */
function injectHistoryBlockIntoFirstUserMessage(
	piMessages: PiAgentMessage[],
	historyBlock: string,
): boolean {
	for (let i = 0; i < piMessages.length; i++) {
		const msg = piMessages[i];
		if (!msg || msg.role !== "user") continue;

		const userMsg = msg as PiUserMessage;
		if (typeof userMsg.content === "string") {
			// Convert string → array form so the history block sits as a
			// distinct text block ahead of the user's text. Matches the
			// OpenCode write pattern (block + "\n\n" + existing text).
			piMessages[i] = {
				...userMsg,
				content: [
					{ type: "text", text: `${historyBlock}\n\n${userMsg.content}` },
				],
			};
			return true;
		}
		if (Array.isArray(userMsg.content)) {
			// Find the first text content; prepend block to it. Falls back
			// to inserting a new text block at the front when the array is
			// image-only or empty.
			const contentArr = userMsg.content;
			const firstTextIndex = contentArr.findIndex(
				(p) =>
					p &&
					typeof p === "object" &&
					(p as { type?: unknown }).type === "text",
			);
			if (firstTextIndex >= 0) {
				const existing = contentArr[firstTextIndex] as PiTextContent;
				const newContent = contentArr.slice();
				newContent[firstTextIndex] = {
					...existing,
					text: `${historyBlock}\n\n${existing.text}`,
				};
				piMessages[i] = { ...userMsg, content: newContent };
			} else {
				const newContent = [
					{ type: "text" as const, text: historyBlock },
					...contentArr,
				];
				piMessages[i] = { ...userMsg, content: newContent };
			}
			return true;
		}

		// Unknown content shape — replace with array containing only the
		// history block. Defensive; AgentMessage's shape doesn't allow
		// other content forms today.
		piMessages[i] = {
			...userMsg,
			content: [{ type: "text", text: historyBlock }],
		};
		return true;
	}

	// No user message anywhere — inject a synthetic leading user message
	// holding only the history block. Same fallback OpenCode uses.
	piMessages.unshift({
		role: "user",
		content: [{ type: "text", text: historyBlock }],
		timestamp: Date.now(),
	});
	return true;
}

export interface PiInjectionResult {
	injected: boolean;
	compartmentCount: number;
	factCount: number;
	memoryCount: number;
	skippedVisibleMessages: number;
}

/**
 * Prepare and write the `<session-history>` block into a Pi message
 * array. Owns the full inject lifecycle: builds the projection, calls
 * the shared prepareCompartmentInjection, applies the boundary trim
 * back to Pi messages, and writes the rendered block into the first
 * user message.
 *
 * Caller MUST manage `isCacheBusting` via the shared
 * `historyRefreshSessions` signal — same contract as OpenCode. On defer
 * passes (`isCacheBusting=false`) the shared injection cache replays
 * the previous result so provider prompt cache stays stable.
 */
export function injectSessionHistoryIntoPi(
	db: ContextDatabase,
	sessionId: string,
	piMessages: PiAgentMessage[],
	isCacheBusting: boolean,
	projectPath: string | undefined,
	injectionBudgetTokens: number | undefined,
	temporalAwareness: boolean | undefined,
	entryIds?: readonly (string | undefined)[],
): PiInjectionResult {
	// Project Pi messages into a MessageLike[] so the shared trimmer can
	// find the cutoff by synthesized id. Mutations to the projection are
	// intentionally discarded — we re-do the trim against piMessages
	// using the boundary id the shared call returns.
	const projection = buildMessageLikeProjection(piMessages, entryIds);
	const beforeProjectionLen = projection.length;
	const prepared: PreparedCompartmentInjection | null =
		prepareCompartmentInjection(
			db,
			sessionId,
			projection,
			isCacheBusting,
			projectPath,
			injectionBudgetTokens,
			temporalAwareness,
		);

	if (!prepared) {
		return {
			injected: false,
			compartmentCount: 0,
			factCount: 0,
			memoryCount: 0,
			skippedVisibleMessages: 0,
		};
	}

	// Apply the same boundary trim the shared call performed on the
	// projection, but back to the real Pi message array. The projection
	// already reflects the trim (its length shrank); we use the cached
	// boundary id to do the equivalent trim on Pi.
	const boundaryId = prepared.compartmentEndMessageId;
	const skippedVisible =
		boundaryId.length > 0
			? trimPiMessagesToBoundary(piMessages, entryIds, boundaryId)
			: prepared.skippedVisibleMessages;

	// Render: write the prepared block into Pi message[0]'s first text
	// content. `prepared.block` is the inner XML; the wrapper tags are
	// added here so the format matches OpenCode exactly.
	const historyBlock = `<session-history>\n${prepared.block}\n</session-history>`;
	const wrote = injectHistoryBlockIntoFirstUserMessage(
		piMessages,
		historyBlock,
	);

	if (wrote) {
		const memoryLabel =
			prepared.memoryCount > 0 ? ` + ${prepared.memoryCount} memories` : "";
		if (prepared.compartmentCount > 0) {
			logSession(
				sessionId,
				`pi: injected ${prepared.compartmentCount} compartments + ${prepared.factCount} facts${memoryLabel} into message[0] (skipped ${skippedVisible}/${beforeProjectionLen} visible messages)`,
			);
		} else {
			logSession(
				sessionId,
				`pi: injected ${prepared.factCount} facts${memoryLabel} into message[0] (no compartments yet)`,
			);
		}
	}

	return {
		injected: wrote,
		compartmentCount: prepared.compartmentCount,
		factCount: prepared.factCount,
		memoryCount: prepared.memoryCount,
		skippedVisibleMessages: skippedVisible,
	};
}
