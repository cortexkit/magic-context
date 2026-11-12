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

/**
 * Whether Oh My Pi's replay of a native output text stands for a prepared
 * text block: the two are equal once the block's leading `§N§ ` label, which
 * tagging adds and native replay never carries, is removed.
 */
export function nativeTextMatchesBlock(
	nativeText: string,
	blockText: string,
): boolean {
	return nativeText === blockText.replace(TAG_LABEL, "");
}

/**
 * Whether a native output text belongs to an unsigned text block that Oh My
 * Pi's assistant-message hook produced. Oh My Pi removes a block's
 * `textSignature` whenever that hook changes its text, and our hook changes
 * text only to remove tag notation the model copied. The hook's own cleanup of
 * the native text must then match the block. That covers both ways Oh My Pi
 * stores the result: up to 18.18 the native item keeps the model's original
 * bytes, and from 18.19.0 Oh My Pi also copies the cleaned text into the
 * native item, so native and block hold the same bytes. Any other difference
 * (another edit, tag notation or surrounding whitespace left in the native
 * text) fails the relation.
 */
export function hookCleanedTextMatchesBlock(
	nativeText: string,
	blockText: string,
): boolean {
	return nativeTextMatchesBlock(
		stripPersistedAssistantText(nativeText),
		blockText,
	);
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
 * assistant-message hook explains the missing signature (see
 * `hookCleanedTextMatchesBlock`): the hook's cleanup of the native text must
 * equal the text the block had before this pass. Up to Oh My Pi 18.18 the
 * native text still holds the model's original bytes there; from 18.19.0 it
 * holds the cleaned text, the same bytes as the block. Either way Oh My Pi
 * replays that native item in place of the block, so any edit of the block
 * (a drop placeholder, compression) has to go into it. Every other text block must also fit its
 * positional item, so the pairing cannot shift onto another item: a signed
 * block by its id and phase, an unsigned one by the same hook relation. (The
 * dispatch check also compares a signed block's text, so it can still refuse
 * a turn this pairing accepts.)
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
		if (!hookCleanedTextMatchesBlock(slot.text, block.text)) return undefined;
		if (index !== partIndex) continue;
		if ((item.content as unknown[]).length !== 1) return undefined;
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
 * The stored native items Oh My Pi can send in place of this assistant turn,
 * or undefined when it always rebuilds the turn from its typed blocks. It
 * replays only a turn from the target's own api and model whose payload
 * belongs to the target provider and still holds some visible output
 * (openai-codex-responses.ts:4361-4416 and utils.ts:363-383, 681-692 in
 * 18.18.1). The OpenAI Responses lane can still rebuild such a turn when a
 * request does not replay native history, so only the request itself shows
 * which form went out; see `piNativeDropWireMismatch`.
 */
function replayableNativeItems(
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

/** The one output text of a signed block's own native item, found by id and phase. */
function signedItemText(
	block: Record<string, unknown>,
	items: readonly unknown[],
): string | undefined {
	const identity = textIdentity(block);
	if (!identity) return undefined;
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
	const text = (outputs[0] as { text?: unknown } | undefined)?.text;
	return outputs.length === 1 && typeof text === "string" ? text : undefined;
}

/** A dropped part in a turn whose native items Oh My Pi may replay. */
export interface PiNativeDropExpectation {
	/** Position of the assistant message in the prepared messages. */
	message: number;
	/** The `[dropped §N§]` text the request must carry for this part. */
	placeholder: string;
	/** Text the part's own native output still holds instead, if any. */
	stale?: string;
}

/**
 * Every dropped part whose turn Oh My Pi may replay from stored native items,
 * with the native text that would go out in its place if the drop never
 * reached that item. A signed block finds its item by id and phase, the way
 * `rewriteNativeAssistantTexts` writes a signed edit; an unsigned block pairs
 * in order, as `nativeTextSlots` pairs it. Reads only; turns without a
 * placeholder are never listed.
 */
export function piNativeDropExpectations(
	messages: readonly unknown[],
	model: { api?: unknown; id?: unknown; provider?: unknown } | undefined,
): PiNativeDropExpectation[] {
	const expectations: PiNativeDropExpectation[] = [];
	if (!model || !RESPONSES_APIS.has(String(model.api))) return expectations;
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
		const items = replayableNativeItems(message, model);
		if (!items) continue;
		const slots = nativeTextSlots(message.content, items);
		let ordinal = 0;
		for (const block of message.content) {
			if (!isRecord(block) || block.type !== "text") continue;
			const slot = slots?.[ordinal++];
			if (typeof block.text !== "string" || !isPiDropPlaceholder(block.text))
				continue;
			const native =
				"textSignature" in block ? signedItemText(block, items) : slot?.text;
			expectations.push({
				message: index,
				placeholder: block.text,
				...(native !== undefined && native !== block.text
					? { stale: native }
					: {}),
			});
		}
	}
	return expectations;
}

/** Every assistant output text in a Responses request body, or undefined without input items. */
function wireAssistantTexts(payload: unknown): Set<string> | undefined {
	const input = isRecord(payload) ? payload.input : undefined;
	if (!Array.isArray(input)) return undefined;
	const texts = new Set<string>();
	for (const item of input) {
		if (!isRecord(item) || item.role !== "assistant") continue;
		if (typeof item.content === "string") texts.add(item.content);
		else if (Array.isArray(item.content))
			for (const part of item.content)
				if (isRecord(part) && typeof part.text === "string")
					texts.add(part.text);
	}
	return texts;
}

/**
 * Name the first dropped part that the request about to be sent does not
 * carry as its placeholder, or that still carries its stale native text.
 * Oh My Pi sends a turn either as its stored native items or rebuilt from its
 * typed blocks, and either form must hold the placeholder; only the request
 * shows which form it took. A placeholder names one tag, so it cannot stand
 * in for another part. This holds whether or not the turn structure itself
 * could be compared, and with no expectations it never refuses.
 */
export function piNativeDropWireMismatch(
	payload: unknown,
	expectations: readonly PiNativeDropExpectation[] | undefined,
): string | undefined {
	if (!expectations?.length) return undefined;
	const texts = wireAssistantTexts(payload);
	for (const expected of expectations)
		if (
			!texts?.has(expected.placeholder) ||
			(expected.stale !== undefined && texts.has(expected.stale))
		)
			return `message=${expected.message} comparison=native_drop`;
	return undefined;
}

/**
 * Mirror prepared text edits without converting or discarding opaque native history.
 *
 * A signed block finds its native item by the signature's id and phase. With
 * `unsignedEdits` (Oh My Pi only), an edited block whose signature the host's
 * assistant-message hook removed (a drop placeholder, caveman compression,
 * stripped inline thinking) also gets its new text mirrored, into the native
 * item that hook left behind (see `hookRewrittenSlot`). Without that, the host
 * would replay the text from before the edit, and the dispatch check would
 * refuse every later turn of the session.
 */
export function rewriteNativeAssistantTexts(
	message: unknown,
	previous: unknown,
	sessionId?: string,
	options: { unsignedEdits?: boolean } = {},
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
	const unsignedEdits =
		options.unsignedEdits === true &&
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
		if (identity === undefined && unsignedEdits && !("textSignature" in part)) {
			const slot = hookRewrittenSlot(previous.content, index, arrivedItems);
			if (slot) {
				// Keep the item's id, phase and every other field; only its one
				// output text becomes the block's new text. Native replay never
				// carries the leading "§N§ " label tagging adds, and the dispatch
				// check pairs the two without it (`nativeTextMatchesBlock`).
				const item = envelope.items[slot.itemIndex] as Record<string, unknown>;
				const outputs = (item.content as unknown[]).slice();
				outputs[slot.outputIndex] = {
					...(outputs[slot.outputIndex] as Record<string, unknown>),
					text: part.text.replace(TAG_LABEL, ""),
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
