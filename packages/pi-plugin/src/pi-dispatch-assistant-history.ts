import type { PiDispatchHost } from "./pi-dispatch-structure";

/**
 * Oh My Pi does not replay interrupted assistants with no text or tool call.
 * Test block presence, not text content: even an empty text block keeps a turn.
 * Call only where the host's transformMessages is known to run; plain Pi has
 * different replay rules.
 * @oh-my-pi/pi-ai src/providers/transform-messages.ts, predicate / replay drop:
 * 18.8.9:361/1197, 18.11.3:462/1369, 18.12.3:483/1398. Same semantics in all
 * three; the predicate became exported after 18.8.9. 18.12.6 and 18.13.0 ship
 * the same file as 18.12.3.
 */
export function piOmitsTruncatedAssistant(
	message: Record<string, unknown>,
): boolean {
	return (
		(message.stopReason === "length" ||
			message.stopReason === "error" ||
			message.stopReason === "aborted") &&
		Array.isArray(message.content) &&
		!message.content.some(
			(block) => block?.type === "text" || block?.type === "toolCall",
		)
	);
}

/**
 * What the Anthropic Messages converter does with an assistant that the
 * host's replay pass kept (see piOmitsTruncatedAssistant):
 * - "kept": a block can reach the wire and its omission is not established,
 *   so the assistant row is required.
 * - "dropped": every block is always skipped, so the converter sends no row.
 * - "optional": the only blocks that could reach the wire are thinking or
 *   redacted thinking, and whether they do depends on request-time state the
 *   prepared history cannot show. The row may be present or absent.
 */
export type PiAnthropicAssistantReplay = "kept" | "dropped" | "optional";

/** Thinking evidence an optional assistant may carry onto the wire. */
export interface PiAnthropicOptionalThinking {
	/** Nonblank signatures of the assistant's thinking blocks. */
	signatures: readonly string[];
	/** Nonblank payloads of the assistant's redacted thinking blocks. */
	redacted: readonly string[];
	/** Trimmed, well-formed text of the assistant's nonblank thinking blocks. */
	texts: readonly string[];
	/** Whether the assistant has a server-side fallback boundary block. */
	fallback: boolean;
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function nonblank(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function wellFormed(text: string): string {
	return text.replace(
		/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
		"\uFFFD",
	);
}

/**
 * Classify an assistant the host replay kept, for the Anthropic Messages route.
 *
 * Oh My Pi (@oh-my-pi/pi-ai src/providers/anthropic.ts
 * convertAnthropicMessages, assistant branch at 18.12.3:5946, 18.12.6:6143,
 * 18.13.0:6320; the skip rules are identical in all three) skips:
 * - text whose trim() is empty (18.12.3:5975, 18.12.6:6172, 18.13.0:6349);
 * - every thinking block when the request sets dropAllThinking, and a signed
 *   one whose signature is in droppedThinkingBlocks (5981-5986 / 6178-6183 /
 *   6355-6360);
 * - when the message has signed thinking (hasSignedThinking, 5955 / 6152 /
 *   6329), unsigned thinking with blank text; otherwise thinking with blank
 *   text (5987-6023 / 6184-6220 / 6361-6397). Signed thinking with blank text
 *   is sent only in the hasSignedThinking branch;
 * - redacted thinking under dropAllThinking or droppedThinkingBlocks, or
 *   with blank data (6024-6030 / 6221-6227 / 6398-6404);
 * - block types it has no branch for, such as images.
 * It always sends tool calls as tool_use blocks (6040 / 6237 / 6414) and
 * server-tool blocks as they are (6031 / 6228 / 6405), and drops the whole
 * assistant when nothing is left
 * (`if (blocks.length === 0) continue;` at 6088 / 6285 / 6462). 18.13.0 may
 * prepend a placeholder thinking block (6479-6481), but only after that check.
 * Before the converter, transformMessages (identical in the three versions)
 * removes images (transform-messages.ts:1183), keeps server-tool blocks only
 * for the same provider on this API (:1163-1169), drops thinking with
 * neither a signature nor text (:1068, :1091), and may strip a signature,
 * drop thinking for another credential or deployment, or demote thinking to
 * text (:1022-1161). Those choices, dropAllThinking and droppedThinkingBlocks
 * depend on the request, the credential and the model catalog, so an
 * assistant whose only possible survivors are thinking blocks from the same
 * provider on this API is "optional". Foreign thinking is required when it
 * could survive: it normally becomes text before the converter's thinking
 * filters, and preparation cannot see per-attempt native-replay overrides.
 * A fallback block survives only on requests that opt into server-side
 * fallback (collapseFallbackSegments at 5744 / 5915 / 6063), so an assistant
 * whose only possible survivor is a fallback block can also be absent. That
 * shape is not modelled: it is classified "kept", as it was before.
 *
 * Plain Pi (@earendil-works/pi-ai dist/api/anthropic-messages.js, assistant
 * branch at 0.87.1:1019-1078 and 1.3.0:1123-1182) also skips text whose
 * trim() is empty and thinking with blank text and no nonblank signature,
 * and drops an assistant with no blocks left. Its transformMessages
 * (transform-messages.js 0.87.1:72-93, 1.3.0:91-101) drops thinking from
 * another model; 0.87.1 turns nonblank foreign thinking into text where 1.3.0
 * drops it. Only skips shared by both versions mark a Pi assistant "dropped";
 * Pi never produces "optional" because its replay has no request-time state.
 */
export function piAnthropicAssistantReplay(
	message: Record<string, unknown>,
	model: { api?: string; id?: string; provider?: string } | undefined,
	host: PiDispatchHost,
): PiAnthropicAssistantReplay {
	if (model?.api !== "anthropic-messages" || !Array.isArray(message.content))
		return "kept";
	const sameModel =
		message.provider === model.provider &&
		message.api === model.api &&
		message.model === model.id;
	let thinking = false;
	let fallback = false;
	for (const value of message.content) {
		const block = object(value);
		if (!block) return "kept";
		if (block.type === "toolCall") return "kept";
		if (block.type === "text") {
			// A malformed text block would stop the converter; keep the row.
			if (typeof block.text !== "string" || block.text.trim()) return "kept";
			continue;
		}
		if (block.type === "thinking") {
			if (host === "pi") {
				// Pi sends redacted thinking for the same model and drops it
				// otherwise. It sends nonblank thinking from the same model, and
				// what it does with foreign nonblank thinking differs by version,
				// so both keep the row. Blank thinking survives only with a
				// nonblank signature from the same model.
				if (block.redacted === true) {
					if (sameModel) return "kept";
					continue;
				}
				if (typeof block.thinking !== "string") return "kept";
				if (nonblank(block.thinking)) return "kept";
				if (sameModel && nonblank(block.thinkingSignature)) return "kept";
				continue;
			}
			if (typeof block.thinking !== "string") return "kept";
			if (message.api !== model.api) {
				// Foreign nonblank reasoning normally becomes required text. Even
				// with native replay enabled, refuse its omission rather than guess
				// whether a per-attempt override demoted it before thinking drops.
				if (nonblank(block.thinking)) return "kept";
				continue;
			}
			if (
				message.provider !== model.provider &&
				(nonblank(block.thinking) || nonblank(block.thinkingSignature))
			)
				return "kept";
			if (nonblank(block.thinking) || nonblank(block.thinkingSignature))
				thinking = true;
			continue;
		}
		if (host === "omp" && block.type === "redactedThinking") {
			if (typeof block.data !== "string") return "kept";
			if (message.api !== model.api) continue;
			if (message.provider !== model.provider && nonblank(block.data))
				return "kept";
			if (nonblank(block.data)) thinking = true;
			continue;
		}
		if (host === "omp" && block.type === "anthropicServerTool") {
			if (
				message.api === "anthropic-messages" &&
				message.provider === model.provider
			)
				return "kept";
			continue;
		}
		if (host === "omp" && block.type === "fallback") fallback = true;
		// Images and unknown block types never reach the wire.
	}
	if (thinking) return "optional";
	return fallback ? "kept" : "dropped";
}

/** Collect what an optional assistant may still send; see piAnthropicAssistantReplay. */
export function piAnthropicOptionalThinking(
	message: Record<string, unknown>,
): PiAnthropicOptionalThinking {
	const signatures: string[] = [];
	const redacted: string[] = [];
	const texts: string[] = [];
	let fallback = false;
	for (const value of Array.isArray(message.content) ? message.content : []) {
		const block = object(value);
		if (block?.type === "thinking") {
			if (nonblank(block.thinkingSignature))
				signatures.push(block.thinkingSignature);
			if (nonblank(block.thinking))
				texts.push(wellFormed(block.thinking).trim());
		} else if (block?.type === "redactedThinking" && nonblank(block.data))
			redacted.push(block.data);
		else if (block?.type === "fallback") fallback = true;
	}
	return { signatures, redacted, texts, fallback };
}

/**
 * Placeholder thinking OMP 18.13.0 prepends to a sent assistant with no
 * thinking block when the model requires thinking presence
 * (providers/anthropic.ts:6479-6481).
 */
const THINKING_PRESENCE_PLACEHOLDER =
	"(no reasoning was returned for this turn)";

/**
 * Whether a sent optional assistant's wire content comes from its prepared
 * thinking, so the row cannot stand in for a different assistant. Signed
 * thinking must carry one of the prepared signatures, and redacted thinking
 * one of the prepared payloads. Unsigned thinking and text are the prepared
 * thinking replayed without a signature or demoted to text, which may wrap
 * it in the target model's thinking delimiters, so each must contain a
 * prepared thinking text. A fallback block needs a prepared fallback block.
 */
export function piExplainsOptionalAssistant(
	thinking: PiAnthropicOptionalThinking,
	content: unknown,
): boolean {
	const fromThinking = (text: unknown) =>
		typeof text === "string" &&
		thinking.texts.some((prepared) => text.includes(prepared));
	return (
		Array.isArray(content) &&
		content.length > 0 &&
		content.every((value) => {
			const block = object(value);
			if (block?.type === "thinking") {
				if (nonblank(block.signature))
					return thinking.signatures.includes(block.signature);
				return (
					block.thinking === THINKING_PRESENCE_PLACEHOLDER ||
					fromThinking(block.thinking)
				);
			}
			if (block?.type === "redacted_thinking")
				return (
					typeof block.data === "string" &&
					thinking.redacted.includes(block.data)
				);
			if (block?.type === "text") return fromThinking(block.text);
			if (block?.type === "fallback") return thinking.fallback;
			return false;
		})
	);
}
