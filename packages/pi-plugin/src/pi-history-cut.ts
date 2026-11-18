/**
 * The history cut: which raw Pi messages a summary boundary removes from the
 * request, and which one it keeps. The request's cut (inject-compartments-pi.ts)
 * and the Pi compaction marker that trims the host's own branch
 * (compaction-marker-manager-pi.ts, pi-historian-runner.ts, pi-recomp-marker.ts)
 * both decide it here, so the marker never hides a message the request keeps.
 */
import { SYNTH_USER_ID_PREFIX } from "./read-session-pi";
import { isPiSystemEntry } from "./system-entry-pi";

/** The fields of a Pi message the cut reads. */
export interface PiCutMessage {
	role?: unknown;
	content?: unknown;
	toolCallId?: unknown;
	stopReason?: unknown;
}

/**
 * The messages at the given indexes that the cut at `cutoffIndex` removes: every
 * message up to and including the boundary except Pi system entries, the halves
 * of tool calls split by it, and not the prompt keptPromptIndex keeps.
 *
 * The sweep repeats in both directions across Pi's split tool-call shape. It is
 * scoped by the owning assistant message index, not by bare callId: Pi may reuse
 * callIds across turns, and a global callId match can delete a valid kept-tail
 * pair from a later turn. Pair ownership is inferred from the nearest assistant
 * carrying that callId (backward first, then forward for legacy shapes where a
 * result precedes its call).
 *
 * `promptReachesBoundary` applies when the boundary was placed by branch
 * position rather than found among the messages (see keptPromptIndex).
 */
export function planPiHistoryCut(
	messages: readonly unknown[],
	cutoffIndex: number,
	promptReachesBoundary?: (index: number) => boolean,
): Set<number> {
	const remove = new Set<number>();
	for (let i = 0; i <= cutoffIndex; i++) {
		if (!isPiSystemEntry(messages[i])) remove.add(i);
	}

	let changed = true;
	while (changed) {
		changed = false;
		const removedCallKeys = new Set<string>();
		const removedResultKeys = new Set<string>();

		for (const index of remove) {
			const msg = messages[index] as PiCutMessage | undefined;
			if (!msg) continue;
			if (msg.role === "assistant") {
				for (const callId of getPiToolCallIds(msg)) {
					removedCallKeys.add(toolPairKey(callId, index));
				}
			} else if (msg.role === "toolResult") {
				const callId = getPiToolResultCallId(msg);
				const ownerIndex = callId
					? findToolResultOwnerAssistantIndex(messages, index, callId)
					: null;
				if (callId && ownerIndex !== null) {
					removedResultKeys.add(toolPairKey(callId, ownerIndex));
				}
			}
		}

		for (let i = 0; i < messages.length; i++) {
			if (remove.has(i)) continue;
			const msg = messages[i] as PiCutMessage | undefined;
			if (!msg) continue;
			if (msg.role === "toolResult") {
				const callId = getPiToolResultCallId(msg);
				const ownerIndex = callId
					? findToolResultOwnerAssistantIndex(messages, i, callId)
					: null;
				if (
					callId &&
					ownerIndex !== null &&
					removedCallKeys.has(toolPairKey(callId, ownerIndex))
				) {
					remove.add(i);
					changed = true;
				}
				continue;
			}
			if (msg.role === "assistant") {
				const callIds = getPiToolCallIds(msg);
				if (
					callIds.some((callId) =>
						removedResultKeys.has(toolPairKey(callId, i)),
					)
				) {
					remove.add(i);
					changed = true;
				}
			}
		}
	}
	// The kept prompt is a user message, which the sweep never removes, so taking
	// it out of the cut afterwards leaves the tool pairs as the sweep settled them.
	// It is chosen from what remains after the cut, so a call the sweep removes
	// after the boundary does not count as the turn going on.
	const keptPrompt = keptPromptIndex(
		messages,
		cutoffIndex,
		remove,
		promptReachesBoundary,
	);
	if (keptPrompt >= 0) remove.delete(keptPrompt);
	return remove;
}

/**
 * The first message the cut keeps that is not a Pi system entry, or -1 while
 * the cut keeps none yet. The cut keeps system entries in place; a compaction
 * marker never starts at one, because Pi's compaction snapshot carries their
 * effective state.
 */
export function firstMessageKeptByPiHistoryCut(
	messages: readonly unknown[],
	remove: ReadonlySet<number>,
): number {
	for (let i = 0; i < messages.length; i++) {
		if (!remove.has(i) && !isPiSystemEntry(messages[i])) return i;
	}
	return -1;
}

export type PiMarkerKeptEntry =
	| { kind: "resolved"; entryId: string }
	| { kind: "waiting" }
	| { kind: "missing" };

/**
 * The entry a Pi compaction marker keeps first for a summary ending at
 * `endMessageId`: the first message the history cut keeps, read from the
 * branch's message entries. When the summary ends inside a turn, the cut keeps
 * that turn's prompt, so the marker starts at the prompt instead of hiding it
 * (a `/ctx-recomp` run while a reply streams ends on the prompt or a tool result
 * of the live turn). When the summary ends a finished turn, this is the first
 * message after the boundary, the entry the marker has always kept.
 *
 * A folded tool-result boundary (`synth-user-<id>`) is the result entry `<id>`,
 * as the cut reads it. `waiting`: no message follows the boundary yet, or the
 * cut keeps none. `missing`: the boundary message is not on this branch, and
 * the caller places the marker by stored ordinal as before.
 */
export function resolvePiMarkerKeptEntry(
	branchEntries: readonly unknown[],
	endMessageId: string,
): PiMarkerKeptEntry {
	const boundaryId = endMessageId.startsWith(SYNTH_USER_ID_PREFIX)
		? endMessageId.slice(SYNTH_USER_ID_PREFIX.length)
		: endMessageId;
	if (boundaryId.length === 0) return { kind: "missing" };
	const messages: unknown[] = [];
	const ids: string[] = [];
	for (const raw of branchEntries) {
		const entry = raw as {
			type?: unknown;
			id?: unknown;
			message?: unknown;
		} | null;
		if (
			entry?.type !== "message" ||
			typeof entry.id !== "string" ||
			entry.id.length === 0 ||
			!entry.message ||
			typeof entry.message !== "object"
		)
			continue;
		messages.push(entry.message);
		ids.push(entry.id);
	}
	const cutoffIndex = ids.indexOf(boundaryId);
	if (cutoffIndex < 0) return { kind: "missing" };
	// With nothing after the boundary yet, the cut cannot tell whether the turn
	// it ends in is closed: it keeps that turn's prompt now, and drops it once
	// the next prompt arrives. Wait for the next message, as the marker always
	// has for a summary that reaches the end of the branch.
	if (!messages.slice(cutoffIndex + 1).some((m) => !isPiSystemEntry(m)))
		return { kind: "waiting" };
	const kept = firstMessageKeptByPiHistoryCut(
		messages,
		planPiHistoryCut(messages, cutoffIndex),
	);
	return kept < 0
		? { kind: "waiting" }
		: { kind: "resolved", entryId: ids[kept] as string };
}

/**
 * The one message at or before the cut point that the cut keeps, or -1: the
 * last user prompt at or before it, while the boundary sits inside that
 * prompt's turn. The turn is closed when the first user or assistant message
 * after the cut point that the cut does not remove (`removed`) is a user
 * prompt. A failed reply does not count there, because Pi hides one before it
 * retries and may show it again after a restart. On the branch-position path
 * the boundary must also follow the prompt with no other user prompt between
 * them (`promptReachesBoundary`), which matters when the hidden boundary is
 * itself a prompt.
 *
 * Why: a summary can end inside the live turn, for example a full rebuild of
 * every summary (the `/ctx-recomp` command) that ends on the last raw message,
 * here a failed reply Pi hid. Cutting
 * there would remove the prompt the model is answering. The rule reads only the
 * messages around the boundary, never which prompt is newest, so later passes
 * keep the same cut, and finding the boundary by id or by branch position keeps
 * the same prompt. The prompt stays served even though the summary covers it.
 *
 * Cache: a boundary that closes a turn keeps nothing, so those cuts are
 * unchanged. A session whose boundary sits inside a turn, live or older, gets
 * that turn's prompt back once, on the first pass after this rule shipped, and
 * keeps it until a newer summary moves the boundary.
 *
 * Known one-time flip: if Pi exits while it retries a hidden failed reply that
 * ends the summary, the person's next prompt lands right after the boundary,
 * the turn reads as closed, and the prompt kept until then is cut once.
 */
function keptPromptIndex(
	messages: readonly unknown[],
	cutoffIndex: number,
	removed: ReadonlySet<number>,
	promptReachesBoundary?: (index: number) => boolean,
): number {
	let promptIndex = -1;
	for (let i = cutoffIndex; i >= 0; i--) {
		if ((messages[i] as PiCutMessage | undefined)?.role === "user") {
			promptIndex = i;
			break;
		}
	}
	if (promptIndex < 0) return -1;
	for (let i = cutoffIndex + 1; i < messages.length; i++) {
		if (removed.has(i)) continue;
		const message = messages[i] as PiCutMessage | undefined;
		if (message?.role === "user") return -1;
		if (message?.role === "assistant" && message.stopReason !== "error") break;
	}
	if (promptReachesBoundary && !promptReachesBoundary(promptIndex)) return -1;
	return promptIndex;
}

function toolPairKey(callId: string, assistantIndex: number): string {
	return `${callId}\0${assistantIndex}`;
}

function findToolResultOwnerAssistantIndex(
	messages: readonly unknown[],
	resultIndex: number,
	callId: string,
): number | null {
	for (let i = resultIndex - 1; i >= 0; i--) {
		const msg = messages[i] as PiCutMessage | undefined;
		if (msg?.role === "assistant" && getPiToolCallIds(msg).includes(callId)) {
			return i;
		}
	}
	for (let i = resultIndex + 1; i < messages.length; i++) {
		const msg = messages[i] as PiCutMessage | undefined;
		if (msg?.role === "assistant" && getPiToolCallIds(msg).includes(callId)) {
			return i;
		}
	}
	return null;
}

function getPiToolCallIds(message: PiCutMessage): string[] {
	if (!Array.isArray(message.content)) return [];
	const ids: string[] = [];
	for (const part of message.content) {
		if (
			part &&
			typeof part === "object" &&
			(part as Record<string, unknown>).type === "toolCall" &&
			typeof (part as Record<string, unknown>).id === "string"
		) {
			ids.push((part as Record<string, unknown>).id as string);
		}
	}
	return ids;
}

function getPiToolResultCallId(message: PiCutMessage): string | null {
	const callId = message.toolCallId;
	return typeof callId === "string" && callId.length > 0 ? callId : null;
}
