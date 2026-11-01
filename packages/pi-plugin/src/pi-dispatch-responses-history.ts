import { stripPersistedAssistantText } from "@magic-context/core/hooks/magic-context/tag-content-primitives";
import { piOmitsTruncatedAssistant } from "./pi-dispatch-assistant-history";
import type { PiChatHistoryModel } from "./pi-dispatch-chat-history";
import type { PiDispatchHost } from "./pi-dispatch-structure";

const MAX_TEXT_UNITS = 32 * 1024 * 1024;

function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function wellFormed(text: string): string {
	return text.replace(
		/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
		"\uFFFD",
	);
}

function textIdentity(text: string, phase: unknown): string {
	return JSON.stringify([
		text,
		phase === "commentary" || phase === "final_answer" ? phase : null,
	]);
}

function signaturePhase(block: Record<string, unknown>): unknown {
	try {
		if (typeof block.textSignature === "string") {
			const signature = object(JSON.parse(block.textSignature));
			if (signature?.v === 1 && typeof signature.id === "string")
				return signature.phase;
		}
	} catch {}
	return undefined;
}

function demotedThinking(
	text: string,
	model: PiChatHistoryModel,
): string | undefined {
	// Oh My Pi wraps earlier reasoning with the target model's thinking delimiters,
	// not the source model's. Keep the supported catalog subset explicit; for
	// unknown delimiters require the managed-head opener without comparing rows.
	// pi-ai/src/dialect/demotion.ts:33-39; pi-catalog/src/identity/dialect.ts:18-41
	// (OMP 18.10.4 and 18.11.0).
	const id = model.id?.toLowerCase() ?? "";
	if (/^(?:[^/]+\/)?muse-spark-1\.3(?:-|$)/u.test(id))
		return `<thinking>\n${wellFormed(text)}\n</thinking>`;
	if (/^(?:[^/]+\/)?(?:gpt-|o[134](?:-|$)|chatgpt-|codex-)/u.test(id))
		return `<think>\n${wellFormed(text)}\n</think>`;
	return undefined;
}

export interface PiResponsesUnsignedAlternatives {
	fallback?: readonly string[];
	cold?: readonly string[];
}

/** Cold replay is safe only for plaintext reasoning with no surviving server state. */
function coldReplayable(items: unknown[]): boolean {
	let reasoning = false;
	for (const value of items) {
		const item = object(value);
		if (typeof item?.encrypted_content === "string") return false;
		if (item?.type !== "reasoning") continue;
		if (
			!Array.isArray(item.content) ||
			!item.content.some((part) => object(part)?.type === "reasoning_text")
		)
			return false;
		reasoning = true;
	}
	// The supported native items below lose their top-level IDs in OMP's
	// sanitizer; computer items, whose IDs can survive, are not admitted here.
	return reasoning;
}

/**
 * Capture ordered [text, phase] pairs as JSON strings for OpenAI Responses replay.
 * Cached provider items must bind to signed prepared blocks, except for OMP's
 * narrowly recognized unsigned hook rewrite. Other edits require prepared text.
 */
export function piResponsesAssistantTexts(
	value: unknown,
	model: PiChatHistoryModel | undefined,
	host?: PiDispatchHost,
	alternatives?: PiResponsesUnsignedAlternatives,
): readonly string[] | undefined {
	const message = object(value);
	if (!message || !Array.isArray(message.content)) return undefined;
	if (piOmitsTruncatedAssistant(message)) return [];
	const texts: string[] = [];
	const blocks: Record<string, unknown>[] = [];
	const sameModel =
		model !== undefined &&
		typeof model.api === "string" &&
		typeof model.id === "string" &&
		typeof model.provider === "string" &&
		message.api === model.api &&
		message.model === model.id &&
		message.provider === model.provider;
	let units = 0;
	for (const value of message.content) {
		const block = object(value);
		if (block?.type === "toolCall") continue;
		// Thinking from this exact API/provider/model becomes a reasoning item or
		// vanishes. Other thinking becomes visible text with the target's delimiters.
		// OMP can also replay a full trace natively when its catalog identifies both
		// deployments as the same portable model; leave that catalog-dependent case
		// unmodeled rather than asserting it contributes visible text.
		// transform-messages.ts:1036-1086; openai-shared.ts:2478-2531 (both versions).
		if (block?.type === "thinking") {
			if (sameModel) continue;
			if (typeof block.thinking !== "string" || !model) return undefined;
			if (!block.thinking.trim()) continue;
			const compat = object(model.compat);
			if (
				block.summary === false &&
				(compat?.requiresReasoningContentForToolCalls === true ||
					compat?.requiresReasoningContentForAllAssistantTurns === true)
			)
				return undefined;
			const text = demotedThinking(block.thinking, model);
			if (text === undefined) return undefined;
			units += text.length;
			if (units > MAX_TEXT_UNITS) return undefined;
			texts.push(textIdentity(text, undefined));
			continue;
		}
		if (block?.type !== "text" || typeof block.text !== "string")
			return undefined;
		units += block.text.length;
		if (units > MAX_TEXT_UNITS) return undefined;
		texts.push(
			textIdentity(
				wellFormed(block.text),
				sameModel ? signaturePhase(block) : undefined,
			),
		);
		blocks.push(block);
	}
	// Oh My Pi emits each text block as an output_text item and keeps commentary,
	// so collapsing role rows must retain every block rather than just the first.
	// @oh-my-pi/pi-ai/src/providers/openai-shared.ts:2503-2531 (18.10.4).
	const payload = object(message.providerPayload);
	if (
		message.api !== model?.api ||
		typeof model?.id !== "string" ||
		typeof model?.provider !== "string" ||
		message.model !== model?.id ||
		(payload?.provider ?? message.provider) !== model?.provider ||
		payload?.type !== "openaiResponsesHistory" ||
		payload.dt !== true ||
		!Array.isArray(payload.items)
	)
		return texts;
	// Matching API/model/provider selects cached wire items instead of converting
	// the prepared blocks. The cache's dt flag marks items to append; without it,
	// replay replaces all preceding input. Allow only append-only text whose v1
	// signature binds the cached item ID and phase to the prepared block, and whose
	// text differs at most by our leading ordinal label. OMP's unsigned rewrite
	// exception below requires the hook's exact cleanup relation instead.
	// openai-shared.ts:2204-2260; utils.ts:653-663 (18.10.4).
	//
	// A real Codex turn stores every native output item it produced, so the cache
	// normally holds reasoning and function_call items around its messages. OMP
	// replays those items as they are: reasoning never reaches a text row, and the
	// dispatch comparator checks function_call IDs against the prepared calls.
	// Only assistant message items carry text. OMP drops a whitespace-only one
	// when the cache has other output; it still has to bind to a prepared block.
	// openai-codex-responses.ts:3272-3275, 5068-5101; utils.ts:352-420 (18.11.3,
	// unchanged from 18.10.4 and 18.11.1).
	const replay: string[] = [];
	let bound = 0;
	let output = false;
	const allowUnsigned =
		host === "omp" &&
		message.role === "assistant" &&
		[
			"openai-responses",
			"azure-openai-responses",
			"openai-codex-responses",
		].includes(model?.api ?? "");
	let unsigned = false;
	let rewrittenText = false;
	for (const value of payload.items) {
		const item = object(value);
		if (item?.type === "reasoning") continue;
		if (item?.type === "function_call" || item?.type === "custom_tool_call") {
			output = true;
			continue;
		}
		if (
			item?.type !== "message" ||
			item.role !== "assistant" ||
			!Array.isArray(item.content)
		)
			return texts;
		const itemTexts: string[] = [];
		for (const value of item.content) {
			const part = object(value);
			const block = blocks[bound];
			if (
				!block ||
				part?.type !== "output_text" ||
				typeof part.text !== "string"
			)
				return texts;
			let signature: Record<string, unknown> | undefined;
			try {
				if (typeof block.textSignature === "string")
					signature = object(JSON.parse(block.textSignature));
			} catch {
				return texts;
			}
			const signed =
				signature?.v === 1 &&
				typeof signature.id === "string" &&
				item.id === signature.id &&
				item.phase === signature.phase &&
				part.text === (block.text as string).replace(/^§\d+§ /u, "");
			if (!signed) {
				// OMP removes the signature when its assistant-message hook rewrites
				// text, but its native encoder still replays the original payload.
				// Use the hook's own cleanup, including mid-text notation and trimming.
				// Remove only our current prepared ordinal from the visible side;
				// unrelated visible edits must not inherit the native text or phase.
				const stripped = stripPersistedAssistantText(part.text);
				if (
					!allowUnsigned ||
					"textSignature" in block ||
					stripped !== (block.text as string).replace(/^§\d+§ /u, "")
				)
					return texts;
				unsigned = true;
				// Reapplying the echoed ordinal can restore the original bytes, but
				// the hook still removed the signature. Native replay owns the phase
				// even when the prepared text now equals the cached output text.
				rewrittenText ||= part.text !== stripped;
			}
			bound++;
			itemTexts.push(part.text);
		}
		if (!itemTexts.some((text) => /\S/u.test(text))) continue;
		output = true;
		for (const text of itemTexts)
			replay.push(textIdentity(wellFormed(text), item.phase));
	}
	// Every prepared text block must own exactly one cached text, in order. With
	// no replayable output OMP converts the blocks instead, so keep their texts.
	if (!output || bound !== blocks.length || (unsigned && !rewrittenText))
		return texts;
	if (unsigned && alternatives) {
		alternatives.fallback = texts;
		alternatives.cold = coldReplayable(payload.items) ? replay : texts;
	}
	return replay;
}

/** Keep every wire text item when adjacent assistant items share one role row. */
export function piResponsesWireTexts(
	value: unknown,
	phase?: unknown,
): readonly string[] | undefined {
	if (
		phase !== undefined &&
		phase !== null &&
		phase !== "commentary" &&
		phase !== "final_answer"
	)
		return undefined;
	if (typeof value === "string") return [textIdentity(value, phase)];
	if (!Array.isArray(value)) return undefined;
	const texts: string[] = [];
	let units = 0;
	for (const partValue of value) {
		const part = object(partValue);
		if (part?.type !== "output_text" || typeof part.text !== "string")
			return undefined;
		units += part.text.length;
		if (units > MAX_TEXT_UNITS) return undefined;
		texts.push(textIdentity(part.text, phase));
	}
	return texts;
}
