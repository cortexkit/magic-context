import { stripPersistedAssistantText } from "@magic-context/core/hooks/magic-context/tag-content-primitives";
import { sessionLog } from "@magic-context/core/shared/logger";
import { isRecord } from "@magic-context/core/shared/record-type-guard";

import { isPiSystemEntry } from "./system-entry-pi";

const DROP_PLACEHOLDER = /^\[dropped §\d+§\]$/u;
const TAG_LABEL = /^§\d+§ /u;
const RESPONSES_APIS = new Set([
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
]);

/** The exact text a dropped part is sent as: `[dropped §N§]` and nothing else. */
export function isPiDropPlaceholder(text: string): boolean {
	return DROP_PLACEHOLDER.test(text);
}

type NativeEnvelope = {
	message: Record<string, unknown>;
	payload: Record<string, unknown>;
	items: unknown[];
};

type ToolCallIdentity = {
	callId: string;
	itemId?: string;
};

type ToolCallMatch = {
	index: number;
	item: Record<string, unknown>;
	kind: "function_call" | "custom_tool_call";
};

function getNativeEnvelope(message: unknown): NativeEnvelope | undefined {
	if (!isRecord(message) || isPiSystemEntry(message)) return undefined;
	const payload = message.providerPayload;
	if (
		!isRecord(payload) ||
		payload.type !== "openaiResponsesHistory" ||
		!Array.isArray(payload.items)
	) {
		return undefined;
	}
	return { message, payload, items: payload.items };
}

function parseToolCallId(toolCallId: string): ToolCallIdentity | undefined {
	if (toolCallId.length === 0) return undefined;

	const separator = toolCallId.indexOf("|");
	if (separator === -1) return { callId: toolCallId };
	if (
		separator === 0 ||
		separator === toolCallId.length - 1 ||
		toolCallId.indexOf("|", separator + 1) !== -1
	) {
		return undefined;
	}
	return {
		callId: toolCallId.slice(0, separator),
		itemId: toolCallId.slice(separator + 1),
	};
}

function findNativeToolCall(
	items: unknown[],
	identity: ToolCallIdentity,
): ToolCallMatch | undefined {
	let match: ToolCallMatch | undefined;
	let matchingCallIds = 0;

	for (let index = 0; index < items.length; index += 1) {
		const item = items[index];
		if (!isRecord(item)) continue;
		const kind = item.type;
		if (kind !== "function_call" && kind !== "custom_tool_call") continue;
		if (item.call_id !== identity.callId) continue;
		matchingCallIds++;
		if (
			identity.itemId !== undefined &&
			typeof item.id === "string" &&
			item.id.length > 0 &&
			item.id !== identity.itemId
		) {
			continue;
		}
		if (match !== undefined) return undefined;
		match = { index, item, kind };
	}

	// OMP synthesizes block ids when the captured native item has no id.
	if (
		match &&
		(typeof match.item.id !== "string" || match.item.id.length === 0) &&
		matchingCallIds !== 1
	) {
		return undefined;
	}
	return match;
}

export function rewriteNativeToolInput(
	message: unknown,
	toolCallId: string,
	input: Record<string, unknown>,
): void {
	const envelope = getNativeEnvelope(message);
	if (!envelope) return;

	const identity = parseToolCallId(toolCallId);
	if (!identity) return;
	const match = findNativeToolCall(envelope.items, identity);
	if (!match) return;

	const field = match.kind === "function_call" ? "arguments" : "input";
	let nextValue: string | undefined;
	if (match.kind === "function_call") {
		try {
			nextValue = JSON.stringify(input);
		} catch {
			return;
		}
	} else {
		nextValue = typeof input.input === "string" ? input.input : "";
	}
	if (typeof nextValue !== "string" || match.item[field] === nextValue) return;

	const items = envelope.items.slice();
	items[match.index] = { ...match.item, [field]: nextValue };
	envelope.message.providerPayload = { ...envelope.payload, items };
}

function textIdentity(
	part: unknown,
): { id: string; phase: unknown } | undefined {
	if (
		!isRecord(part) ||
		part.type !== "text" ||
		typeof part.textSignature !== "string"
	)
		return undefined;
	try {
		const signature: unknown = JSON.parse(part.textSignature);
		if (
			isRecord(signature) &&
			signature.v === 1 &&
			typeof signature.id === "string" &&
			signature.id.length > 0 &&
			(signature.phase === undefined ||
				signature.phase === "commentary" ||
				signature.phase === "final_answer")
		) {
			return { id: signature.id, phase: signature.phase };
		}
	} catch {}
	return undefined;
}

type NativeTextSlot = { itemIndex: number; outputIndex: number; text: string };

/**
 * Pair every typed text block with the native output text that Oh My Pi
 * replays in its place, in order, as the dispatch check pairs them
 * (`piResponsesAssistantTexts`). Undefined unless they pair one to one.
 */
function nativeTextSlots(
	content: readonly unknown[],
	items: readonly unknown[],
): NativeTextSlot[] | undefined {
	const slots: NativeTextSlot[] = [];
	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		const item = items[itemIndex];
		if (!isRecord(item)) return undefined;
		if (
			item.type === "reasoning" ||
			item.type === "function_call" ||
			item.type === "custom_tool_call"
		)
			continue;
		if (
			item.type !== "message" ||
			item.role !== "assistant" ||
			!Array.isArray(item.content)
		)
			return undefined;
		for (
			let outputIndex = 0;
			outputIndex < item.content.length;
			outputIndex++
		) {
			const output = item.content[outputIndex];
			if (
				!isRecord(output) ||
				output.type !== "output_text" ||
				typeof output.text !== "string"
			)
				return undefined;
			slots.push({ itemIndex, outputIndex, text: output.text });
		}
	}
	const blocks = content.filter(
		(block) => isRecord(block) && block.type === "text",
	).length;
	return slots.length === blocks ? slots : undefined;
}

/**
 * The native output that an unsigned text block replays as, when Oh My Pi's
 * assistant-message hook explains the missing signature. The hook removes a
 * block's signature only when it rewrites that block's text, and leaves the
 * native item as the provider returned it. So the native text must differ
 * from its own cleanup, and that cleanup must equal the text the block had
 * before this pass. Every other text block must pair as the dispatch check
 * pairs it, so the positional pairing cannot shift onto another item.
 */
function hookRewrittenSlot(
	previous: readonly unknown[],
	partIndex: number,
	items: readonly unknown[],
): NativeTextSlot | undefined {
	const slots = nativeTextSlots(previous, items);
	if (!slots) return undefined;
	let ordinal = 0;
	let target: NativeTextSlot | undefined;
	for (let index = 0; index < previous.length; index++) {
		const block = previous[index];
		if (!isRecord(block) || block.type !== "text") continue;
		const slot = slots[ordinal++];
		const item = items[slot.itemIndex] as Record<string, unknown>;
		if (typeof block.text !== "string") return undefined;
		if ("textSignature" in block) {
			const identity = textIdentity(block);
			if (
				index === partIndex ||
				!identity ||
				item.id !== identity.id ||
				item.phase !== identity.phase
			)
				return undefined;
			continue;
		}
		const stripped = stripPersistedAssistantText(slot.text);
		if (stripped !== block.text.replace(TAG_LABEL, "")) return undefined;
		if (index !== partIndex) continue;
		if (stripped === slot.text || (item.content as unknown[]).length !== 1)
			return undefined;
		target = slot;
	}
	return target;
}

/** Whether an item is an assistant message with no visible text, which Oh My Pi does not replay. */
function emptyAssistantMessage(item: Record<string, unknown>): boolean {
	if (item.type !== "message" || item.role !== "assistant") return false;
	if (typeof item.content === "string") return !/\S/u.test(item.content);
	return (
		Array.isArray(item.content) &&
		!item.content.some(
			(part) =>
				isRecord(part) &&
				((part.type === "output_text" &&
					typeof part.text === "string" &&
					/\S/u.test(part.text)) ||
					(part.type === "refusal" &&
						typeof part.refusal === "string" &&
						/\S/u.test(part.refusal))),
		)
	);
}

/**
 * The stored native items Oh My Pi sends in place of this assistant turn, or
 * undefined when it rebuilds the turn from its typed blocks instead. It
 * replays only a turn from the target's own api and model whose payload
 * belongs to the target provider and still holds some visible output
 * (openai-codex-responses.ts:4361-4416 and utils.ts:363-383, 681-692 in
 * 18.18.1). The OpenAI and Azure Responses lanes can also rebuild a turn
 * from its blocks when a request does not replay native history (Oh My Pi's
 * `nativeHistory.replay` is false) and the turn holds server state bound to
 * an earlier connection; this treats those turns as replayed too.
 */
function replayedNativeItems(
	message: Record<string, unknown>,
	model: { api?: unknown; id?: unknown; provider?: unknown },
): unknown[] | undefined {
	const payload = message.providerPayload;
	if (
		message.api !== model.api ||
		message.model !== model.id ||
		!isRecord(payload) ||
		payload.type !== "openaiResponsesHistory" ||
		!Array.isArray(payload.items) ||
		(payload.provider ?? message.provider ?? model.provider) !== model.provider
	)
		return undefined;
	return payload.items.some(
		(item) =>
			!isRecord(item) ||
			(item.type !== "reasoning" && !emptyAssistantMessage(item)),
	)
		? payload.items
		: undefined;
}

/** Whether a signed block's own native item, found by id and phase, holds this exact text. */
function signedItemHolds(
	block: Record<string, unknown>,
	items: readonly unknown[],
	text: string,
): boolean {
	const identity = textIdentity(block);
	if (!identity) return false;
	const matches = items.filter(
		(item) =>
			isRecord(item) &&
			item.type === "message" &&
			item.role === "assistant" &&
			item.id === identity.id &&
			item.phase === identity.phase,
	) as Record<string, unknown>[];
	const outputs =
		matches.length === 1 && Array.isArray(matches[0].content)
			? matches[0].content.filter(
					(output) => isRecord(output) && output.type === "output_text",
				)
			: [];
	return (
		outputs.length === 1 && (outputs[0] as { text?: unknown }).text === text
	);
}

/**
 * Name the first assistant turn whose dropped part would reach the provider
 * as its original text: Oh My Pi replays the turn's stored native items, and
 * the native output that pairs with a `[dropped §N§]` block does not hold
 * that placeholder. Blocks pair in order as `nativeTextSlots` pairs them; when
 * they cannot, a signed block is looked up by its id and phase, the way the
 * signed mirror finds it. This only reads the prepared messages, so it can run
 * when the turn structure itself cannot be compared, and a turn with no
 * placeholder is never named.
 */
export function piNativeDropMismatch(
	messages: readonly unknown[],
	model: { api?: unknown; id?: unknown; provider?: unknown } | undefined,
): string | undefined {
	if (!model || !RESPONSES_APIS.has(String(model.api))) return undefined;
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (
			!isRecord(message) ||
			message.role !== "assistant" ||
			!Array.isArray(message.content) ||
			!message.content.some(
				(block) =>
					isRecord(block) &&
					block.type === "text" &&
					typeof block.text === "string" &&
					isPiDropPlaceholder(block.text),
			)
		)
			continue;
		const items = replayedNativeItems(message, model);
		if (!items) continue;
		const slots = nativeTextSlots(message.content, items);
		let ordinal = 0;
		for (const block of message.content) {
			if (!isRecord(block) || block.type !== "text") continue;
			const slot = slots?.[ordinal++];
			if (typeof block.text !== "string" || !isPiDropPlaceholder(block.text))
				continue;
			const reached = slots
				? slot?.text === block.text
				: signedItemHolds(block, items, block.text);
			if (!reached) return `message=${index} comparison=native_drop`;
		}
	}
	return undefined;
}

/**
 * Mirror prepared text edits without converting or discarding opaque native history.
 *
 * A signed block finds its native item by the signature's id and phase. With
 * `unsignedDrops` (Oh My Pi only), a dropped block whose signature the host's
 * assistant-message hook removed also gets its placeholder mirrored, into the
 * native item that hook left behind (see `hookRewrittenSlot`). Without that,
 * the host would replay the dropped text itself, and the dispatch check would
 * refuse every later turn of the session.
 */
export function rewriteNativeAssistantTexts(
	message: unknown,
	previous: unknown,
	sessionId?: string,
	options: { unsignedDrops?: boolean } = {},
): void {
	const envelope = getNativeEnvelope(message);
	if (
		envelope?.message.role !== "assistant" ||
		!isRecord(previous) ||
		!Array.isArray(previous.content) ||
		!Array.isArray(envelope.message.content)
	)
		return;
	const content = envelope.message.content;
	// Pair unsigned blocks against the items as they arrived; the signed
	// rewrites below replace text only, so positions stay valid.
	const arrivedItems = envelope.items;
	const unsignedDrops =
		options.unsignedDrops === true &&
		RESPONSES_APIS.has(String(envelope.message.api)) &&
		envelope.payload.dt === true;
	for (let index = 0; index < content.length; index++) {
		const part = content[index];
		const before = previous.content[index];
		if (
			!isRecord(part) ||
			part.type !== "text" ||
			typeof part.text !== "string" ||
			!isRecord(before) ||
			before.type !== "text" ||
			typeof before.text !== "string"
		)
			continue;
		// The Responses dispatch check accepts cached text without the leading
		// "§N§ " label added by tagging. Keep those native bytes cache-stable when
		// the label is the only difference, rather than introducing a wire edit.
		if (
			part.text.replace(/^§\d+§ /u, "") === before.text.replace(/^§\d+§ /u, "")
		)
			continue;
		const identity = textIdentity(part);
		if (
			identity === undefined &&
			unsignedDrops &&
			isPiDropPlaceholder(part.text) &&
			!("textSignature" in part)
		) {
			const slot = hookRewrittenSlot(previous.content, index, arrivedItems);
			if (slot) {
				// Keep the item's id, phase and every other field; only its one
				// output text becomes the placeholder the typed block now holds.
				const item = envelope.items[slot.itemIndex] as Record<string, unknown>;
				const outputs = (item.content as unknown[]).slice();
				outputs[slot.outputIndex] = {
					...(outputs[slot.outputIndex] as Record<string, unknown>),
					text: part.text,
				};
				const items = envelope.items.slice();
				items[slot.itemIndex] = { ...item, content: outputs };
				envelope.items = items;
				envelope.payload = { ...envelope.payload, items };
				envelope.message.providerPayload = envelope.payload;
				continue;
			}
		}
		const sameIdentity = (value: unknown) => {
			const other = textIdentity(value);
			return (
				identity !== undefined &&
				other?.id === identity.id &&
				other.phase === identity.phase
			);
		};
		const matches = envelope.items.flatMap((item, itemIndex) =>
			isRecord(item) &&
			item.type === "message" &&
			item.role === "assistant" &&
			identity !== undefined &&
			item.id === identity.id &&
			item.phase === identity.phase
				? [{ item, itemIndex }]
				: [],
		);
		const match = matches[0];
		const outputs =
			match && Array.isArray(match.item.content)
				? match.item.content.flatMap((output, outputIndex) =>
						isRecord(output) &&
						output.type === "output_text" &&
						typeof output.text === "string"
							? [{ output, outputIndex }]
							: [],
					)
				: [];
		if (
			!identity ||
			content.filter(sameIdentity).length !== 1 ||
			previous.content.filter(sameIdentity).length !== 1 ||
			matches.length !== 1 ||
			outputs.length !== 1
		) {
			if (sessionId)
				sessionLog(
					sessionId,
					`native assistant text replay skipped: missing or ambiguous id/phase match at part ${index} (items=${matches.length}, outputs=${outputs.length}); retaining native history for dispatch validation`,
				);
			continue;
		}
		const { output, outputIndex } = outputs[0];
		if (output.text === part.text) continue;
		const nextContent = (match.item.content as unknown[]).slice();
		nextContent[outputIndex] = { ...output, text: part.text };
		// Copy only the path to the selected text. Reasoning, IDs, signatures and
		// native-only fields retain their bytes and relative order.
		const items = envelope.items.slice();
		items[match.itemIndex] = { ...match.item, content: nextContent };
		envelope.items = items;
		envelope.payload = { ...envelope.payload, items };
		envelope.message.providerPayload = envelope.payload;
	}
}

function hasRedactedThinkingContent(message: Record<string, unknown>): boolean {
	if (!Array.isArray(message.content)) return false;
	for (const part of message.content) {
		if (isRecord(part) && part.type === "thinking" && part.redacted === true)
			return true;
	}
	return false;
}

export function canClearNativeReasoning(model: unknown): boolean {
	if (
		!isRecord(model) ||
		model.api !== "openai-codex-responses" ||
		!isRecord(model.compat)
	) {
		return false;
	}
	const compat = model.compat;
	if (
		compat.requiresReasoningContentForAllAssistantTurns !== false ||
		compat.requiresReasoningContentForToolCalls !== false
	) {
		return false;
	}
	if (compat.whenThinking == null) return true;
	return (
		isRecord(compat.whenThinking) &&
		compat.whenThinking.requiresReasoningContentForAllAssistantTurns ===
			false &&
		compat.whenThinking.requiresReasoningContentForToolCalls === false
	);
}

export function clearNativeReasoning(
	message: unknown,
	allowed: boolean,
): "not-native" | "cleared" | "preserved" {
	const envelope = getNativeEnvelope(message);
	if (!envelope) return "not-native";
	if (hasRedactedThinkingContent(envelope.message)) return "preserved";

	let reasoningCount = 0;
	let hasComputerCall = false;
	for (const item of envelope.items) {
		if (!isRecord(item)) continue;
		if (item.type === "computer_call") {
			hasComputerCall = true;
			continue;
		}
		if (item.type !== "reasoning") continue;

		reasoningCount += 1;
		if (
			typeof item.encrypted_content !== "string" ||
			item.encrypted_content.length === 0 ||
			(item.content !== undefined &&
				(!Array.isArray(item.content) || item.content.length > 0))
		) {
			return "preserved";
		}
	}

	if (reasoningCount === 0) return "not-native";
	if (!allowed || envelope.payload.dt !== true || hasComputerCall) {
		return "preserved";
	}

	const items = envelope.items.filter(
		(item) => !isRecord(item) || item.type !== "reasoning",
	);
	envelope.message.providerPayload = { ...envelope.payload, items };
	return "cleared";
}

/** Remove the captured invocation alongside its normalized toolCall, never unrelated native items. */
export function removeNativeToolCall(
	message: unknown,
	toolCallId: string,
): void {
	const envelope = getNativeEnvelope(message);
	const identity = parseToolCallId(toolCallId);
	if (!envelope || !identity) return;
	const match = findNativeToolCall(envelope.items, identity);
	if (!match) return;
	envelope.message.providerPayload = {
		...envelope.payload,
		items: envelope.items.filter((_, index) => index !== match.index),
	};
}

export function canRemoveNativeToolCall(
	message: unknown,
	toolCallId: string,
): boolean {
	const envelope = getNativeEnvelope(message);
	if (!envelope) return !isRecord(message) || message.providerPayload == null;
	const identity = parseToolCallId(toolCallId);
	return (
		identity !== undefined &&
		findNativeToolCall(envelope.items, identity) !== undefined
	);
}

/** Durable input-lane decision: this complete arc was authorized for removal on a busting pass. */
export const NATIVE_TOOL_REMOVAL_MARKER =
	'{"__magic_context_remove_tool_arc__":true}';
