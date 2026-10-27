import {
	piAgentHistory,
	piIsDeveloperHistory,
} from "./pi-dispatch-agent-history";
import {
	type PiAnthropicOptionalThinking,
	piAnthropicAssistantReplay,
	piAnthropicOptionalThinking,
	piExplainsOptionalAssistant,
	piOmitsTruncatedAssistant,
} from "./pi-dispatch-assistant-history";
import {
	type PiChatHistoryModel,
	piChatHistoryPlan,
	piMatchesChatImages,
} from "./pi-dispatch-chat-history";
import { piGoogleConversation } from "./pi-dispatch-google";
import {
	type PiImageBudgetPlan,
	type PiImageRun,
	type PiInputImage,
	piImageBudgetPlan,
	piMatchesImages,
	piRecordImages,
	piRemainingImages,
	piWireImageCount,
	piWireImages,
} from "./pi-dispatch-image-budget";
import {
	piResponsesAssistantTexts,
	piResponsesWireTexts,
} from "./pi-dispatch-responses-history";
import { piToolCallWireId } from "./pi-dispatch-tool-ids";
import { piToolCallPairing } from "./pi-dispatch-tool-pairing";

interface MessageStructure {
	role: "user" | "assistant" | "toolResult" | "system";
	calls: string[];
	results: string[];
	wireCalls?: (string | undefined)[];
	wireResults?: (string | undefined)[];
	callNames?: string[];
	resultNames?: string[];
	timestamp?: number;
	exactText?: string;
	systemText?: readonly string[];
	exactImages?: readonly string[];
	wireContent?: unknown;
	wireRole?: unknown;
	idlessCalls?: boolean[];
	idlessResults?: boolean[];
	/** JSON [text, phase] pairs for every assistant text block, retained in wire order. */
	responseTexts?: string[];
	images?: readonly PiInputImage[];
	/**
	 * Set on an assistant the Anthropic converter may or may not send; see
	 * piAnthropicAssistantReplay. When the row is sent, each wire block must
	 * come from this evidence (see piExplainsOptionalAssistant), or be the
	 * converter's thinking placeholder.
	 */
	optionalThinking?: PiAnthropicOptionalThinking;
}

/**
 * Rows before developer promotion and Continue pads, for a request whose
 * prepared history has optional assistants. The comparator rebuilds the
 * expected rows for each choice of sent optional assistants.
 */
interface PiAnthropicOptionalPlan {
	rows: readonly MessageStructure[];
	/** Developer rows that become system rows when placed after a user turn
	 * and before an assistant or the end, with their system texts. */
	promotable: ReadonlyMap<MessageStructure, readonly string[]>;
}

/** Transport-independent roles and ordered tool IDs, captured before text transforms. */
export interface PiPreparedStructure {
	messages: readonly MessageStructure[];
	chatMessages?: readonly MessageStructure[];
	responsesMessages?: readonly MessageStructure[];
	responsesAlternatives?: readonly (readonly MessageStructure[])[];
	api?: string;
	googleFunctionIds?: boolean;
	structuralSkipReason?: string;
	imageBudget?: PiImageBudgetPlan<MessageStructure>;
	/** Set when the Anthropic Continue-pad rule was modeled for this route. */
	anthropicContinuePad?: boolean;
	/** Set when some prepared assistants may be absent from the wire. */
	anthropicOptional?: PiAnthropicOptionalPlan;
}

const MAX_MESSAGES = 100_000;
const ORPHAN_NOTE = Symbol("prepared orphan tool result");

/**
 * Neutral user nudge Oh My Pi's Anthropic converter inserts between adjacent
 * assistant params (and after a trailing assistant for non-compaction
 * requests) so the API does not reject consecutive assistant messages.
 * The pad is a string-content user row, placed directly after the earlier
 * assistant with request controls looked through.
 * @oh-my-pi/pi-ai 18.10.4 providers/anthropic.ts:5992-6001,6065-6075,6098-6101;
 * 18.12.3 :6159-6163,6232-6242,6265-6268; 18.12.6 :6356-6360,6429-6439,6462-6465.
 * All three pin the same rule; 17.1.7 has the same repair without the
 * control look-through. Only this converter pads: Bedrock converse,
 * Google/Vertex, Ollama, OpenAI completions/responses and Pi's own
 * converter emit adjacent assistants unchanged or reject them, so the pad
 * is modeled only for the Anthropic Messages route on the OMP host.
 * Bedrock/Vertex endpoint variants of that route share the same api and
 * converter, so they are covered; Plain Pi never pads, so it is excluded.
 */
export const ANTHROPIC_CONTINUE_PAD_TEXT = "Continue.";
const ANTHROPIC_CONTINUE_PAD_APIS = new Set(["anthropic-messages"]);

/**
 * Whether this route models the Anthropic adjacent-assistant repair.
 * One shared predicate for the prepared builder, the trailing-pad allowance
 * and the tests; do not copy the api/host rule elsewhere.
 */
export function piModelsAnthropicContinuePad(
	api: string | undefined,
	host: PiDispatchHost,
): boolean {
	return (
		host === "omp" && api !== undefined && ANTHROPIC_CONTINUE_PAD_APIS.has(api)
	);
}

/** Whether a wire row is the string-content Continue pad. */
function isAnthropicContinuePadRow(row: MessageStructure): boolean {
	return row.role === "user" && row.wireContent === ANTHROPIC_CONTINUE_PAD_TEXT;
}
// APIs whose Oh My Pi provider runs transformMessages, so the host's tool-call
// windows and interrupted-assistant omissions are known for them. Source lines
// below are @oh-my-pi/pi-ai src/providers/, in version order 18.8.9 / 18.11.3 /
// 18.12.3 (the pinned package versions):
// - openai-completions: openai-completions.ts:2310/2371/2372 (convertMessages).
// - openrouter: src/stream.ts:991/975/925 routes it to openai-responses, or to
//   openai-completions when PI_OPENROUTER_RESPONSES=0.
// - openai-responses: openai-responses.ts:1568/1611/1612, and
//   azure-openai-responses: azure-openai-responses.ts:373 (all three), call
//   buildResponsesInput, which runs it at openai-shared.ts:2121/2162/2162.
// - openai-codex-responses: openai-codex-responses.ts:4973/5013/4977.
// - anthropic-messages: anthropic.ts:5210/5818/5835.
// - bedrock-converse-stream: amazon-bedrock.ts:1089/1090/1093.
// - google-generative-ai, google-vertex, google-gemini-cli: google.ts:35 (all),
//   google-vertex.ts:33/32/32 and google-gemini-cli.ts:1256/1266/1266 reach
//   google-shared.ts convertMessages, which runs it at :169/165/213.
// - ollama-chat: ollama.ts:257/260/269. devin-agent: devin.ts:234/248/248.
// - factory-droid-agent: factory-droid.ts streamWire sends every route through
//   factory-droid/gemini.ts:175/179/190 or the Anthropic, Responses or Chat streams.
// - apple-foundation-models: apple-foundation-models.ts:194 (all three).
// cursor-agent (providers/cursor.ts) and gitlab-duo-agent
// (gitlab-duo-workflow.ts:2581, "bypasses transformMessages") do not, and an
// extension's custom API is unknown. Those use projectUnmodeledToolResults,
// which keeps every result where the history has it.
const TRANSFORM_MESSAGES_APIS = new Set([
	"openai-completions",
	"openai-responses",
	"openrouter",
	"openai-codex-responses",
	"azure-openai-responses",
	"anthropic-messages",
	"bedrock-converse-stream",
	"google-generative-ai",
	"google-gemini-cli",
	"google-vertex",
	"ollama-chat",
	"factory-droid-agent",
	"devin-agent",
	"apple-foundation-models",
]);

function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function messageStructure(value: unknown): MessageStructure | undefined {
	const message = object(value);
	if (!message) return undefined;
	const role = [
		"custom",
		"hookMessage",
		"developer",
		"branchSummary",
		"compactionSummary",
		"bashExecution",
		"pythonExecution",
	].includes(String(message.role))
		? "user"
		: message.role;
	if (
		role !== "user" &&
		role !== "assistant" &&
		role !== "toolResult" &&
		role !== "system"
	)
		return undefined;
	const row: MessageStructure = { role, calls: [], results: [] };
	if (ORPHAN_NOTE in message && typeof message.content === "string") {
		if (message.content.length > 32 * 1024 * 1024) return undefined;
		row.exactText = message.content;
	}
	if (typeof message.timestamp === "number") row.timestamp = message.timestamp;
	if (role === "toolResult") {
		if (typeof message.toolCallId !== "string") return undefined;
		row.results.push(message.toolCallId);
	}
	if (role === "assistant" && Array.isArray(message.content)) {
		for (const value of message.content) {
			const block = object(value);
			if (block?.type !== "toolCall" && block?.type !== "tool_use") continue;
			if (typeof block.id !== "string") return undefined;
			row.calls.push(block.id);
			row.callNames ??= [];
			row.callNames.push(typeof block.name === "string" ? block.name : "");
		}
	}
	return row;
}

/**
 * Which host serializes the prepared history. Oh My Pi and Pi ship different
 * transformMessages tool-call window rules; see projectMissingToolResults.
 */
export type PiDispatchHost = "omp" | "pi";

interface WindowCall {
	id: string;
	name: string;
}

function windowCalls(message: Record<string, unknown>): WindowCall[] {
	if (!Array.isArray(message.content)) return [];
	return message.content.flatMap((value) => {
		const block = object(value);
		return block?.type === "toolCall" && typeof block.id === "string"
			? [
					{
						id: block.id,
						name: typeof block.name === "string" ? block.name : "",
					},
				]
			: [];
	});
}

/**
 * The `_dup` suffix and per-segment id budget the provider hands
 * transformMessages for a reused call id. openai-completions.ts and devin.ts
 * pass their own; every other provider takes the defaults ("_dup", 64).
 */
function duplicateSuffix(model?: PiChatHistoryModel): {
	prefix: string;
	max: number;
} {
	const compat = object(model?.compat);
	if (model?.api === "openai-completions") {
		if (compat?.requiresMistralToolIds === true)
			return { prefix: "dup", max: 9 };
		if (compat?.usesOpenAIToolCallIdLimit === true)
			return { prefix: "_dup", max: 40 };
	}
	if (model?.api === "devin-agent") return { prefix: "_dup", max: 40 };
	return { prefix: "_dup", max: 64 };
}

/** transform-messages.ts appendDuplicateSuffix: every composite segment gets the suffix. */
function appendDuplicateSuffix(id: string, suffix: string, max: number) {
	const segment = (part: string) =>
		part.length + suffix.length <= max
			? `${part}${suffix}`
			: `${part.slice(0, Math.max(0, max - suffix.length))}${suffix}`;
	return id.includes("|") ? id.split("|").map(segment).join("|") : segment(id);
}

/**
 * Mirror the host's tool-call window pass so prepared rows sit where the host
 * puts them. Oh My Pi and Pi differ:
 *
 * Oh My Pi (identical in 18.2.6, 18.8.9, 18.11.3, 18.12.3 and 18.12.5;
 * @oh-my-pi/pi-ai src/providers/transform-messages.ts deduplicateToolCallIds,
 * takeRealToolResult, flushPendingToolCalls, flushPendingAbortedToolCalls and
 * the second pass of transformMessages):
 * - A reused call id is renamed with a duplicate suffix (`_dupN`, or `dupN`
 *   for Mistral-style ids), and the next result for that id follows it. A
 *   later turn reusing the id discards the earlier turn's unclaimed renames.
 * - Every assistant, user, developer or other non-result message closes the
 *   open window. Each call still unanswered there takes the earliest real
 *   result for its pairing key that sits after the call's assistant message
 *   and was not taken before, and that result moves into the window; a call
 *   with no such result gets a "No result provided" stub. An aborted or
 *   errored turn's calls get an "aborted" stub stamped with that turn's
 *   timestamp; without a timestamp its window never closes.
 * - A result for an already answered call is dropped, so a moved result never
 *   appears again at its old position. So is a result whose call is valid but
 *   whose window is not open (it arrived before its call).
 * - On providers that use transformMessages, a result whose call is not in
 *   the history is dropped while a window is unanswered; otherwise its
 *   nonblank text becomes a `<stale-tool-result>` user note.
 *
 * Pi (0.87.1 and 1.3.0; @earendil-works/pi-ai dist/api/transform-messages.js)
 * never moves a result. Only assistant and user messages close a window, and
 * only calls with no result after their assistant message get a stub. System
 * messages inside an open window are held until it closes. Errored and aborted
 * assistant messages are not replayed at all.
 *
 * The input is not mutated; the projection may add, drop, move or replace rows
 * and rename duplicate tool ids.
 */
function projectMissingToolResults(
	messages: readonly unknown[],
	model?: PiChatHistoryModel,
	host: PiDispatchHost = "omp",
): unknown[] {
	// Excluded executions never reach the host transform (convertToLlm drops
	// them), so they neither close a window nor take a position.
	const input = messages.filter((value) => {
		const message = object(value);
		return !(
			(message?.role === "bashExecution" ||
				message?.role === "pythonExecution") &&
			message.excludeFromContext === true
		);
	});
	if (host === "pi") return projectPiToolResults(input);
	const api = model?.api;
	if (!TRANSFORM_MESSAGES_APIS.has(api ?? ""))
		return projectUnmodeledToolResults(messages);
	const pairingId = piToolCallPairing(input);
	const { prefix, max } = duplicateSuffix(model);
	// Deduplication pass: rename reused call ids and file every real result by
	// its pairing key at its position.
	const seen = new Map<string, number>();
	const renames = new Map<string, (string | undefined)[]>();
	const realResults = new Map<
		string,
		{ index: number; message: unknown; consumed: boolean }[]
	>();
	const validToolUseIds = new Set<string>();
	const deduplicated = input.map((value, index) => {
		const message = object(value);
		if (
			message?.role === "toolResult" &&
			typeof message.toolCallId === "string"
		) {
			let key = pairingId(message.toolCallId);
			let output: unknown = value;
			const queue = renames.get(key);
			if (queue?.length) {
				const replacement = queue.shift();
				if (!queue.length) renames.delete(key);
				if (replacement !== undefined) {
					output = { ...message, toolCallId: replacement };
					key = pairingId(replacement);
				}
			}
			const entry = { index, message: output, consumed: false };
			const entries = realResults.get(key);
			if (entries) entries.push(entry);
			else realResults.set(key, [entry]);
			return output;
		}
		if (message?.role !== "assistant" || !Array.isArray(message.content))
			return value;
		const touched = new Set<string>();
		let changed = false;
		const content = message.content.map((part) => {
			const block = object(part);
			if (block?.type !== "toolCall" || typeof block.id !== "string")
				return part;
			const key = pairingId(block.id);
			// An earlier turn's unclaimed renames for this id are discarded: its
			// call is stubbed, and the next result belongs to this turn.
			if (!touched.has(key)) {
				touched.add(key);
				renames.delete(key);
			}
			const count = seen.get(key) ?? 0;
			const queue = renames.get(key) ?? [];
			renames.set(key, queue);
			if (count === 0) {
				seen.set(key, 1);
				queue.push(undefined);
				return part;
			}
			let suffix = count;
			let replacement = appendDuplicateSuffix(
				block.id,
				`${prefix}${suffix}`,
				max,
			);
			while (seen.has(pairingId(replacement))) {
				suffix++;
				replacement = appendDuplicateSuffix(
					block.id,
					`${prefix}${suffix}`,
					max,
				);
			}
			seen.set(key, suffix + 1);
			seen.set(pairingId(replacement), 1);
			queue.push(replacement);
			changed = true;
			return { ...block, id: replacement };
		});
		for (const call of windowCalls({ content }))
			validToolUseIds.add(pairingId(call.id));
		return changed ? { ...message, content } : value;
	});
	const takeRealResult = (id: string, afterIndex: number) => {
		for (const entry of realResults.get(pairingId(id)) ?? []) {
			if (entry.consumed || entry.index <= afterIndex) continue;
			entry.consumed = true;
			return entry.message;
		}
		return undefined;
	};
	const projected: unknown[] = [];
	// Pairing keys of calls that already have their one provider-visible result.
	const answered = new Set<string>();
	let pending: WindowCall[] = [];
	let pendingStart = -1;
	let aborted = new Map<string, WindowCall>();
	let abortedTimestamp: unknown;
	let abortedStart = -1;
	const stub = (call: WindowCall, text: string, timestamp: unknown) => ({
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text }],
		isError: true,
		timestamp,
	});
	const flush = (boundaryTimestamp?: unknown) => {
		for (const call of pending) {
			const key = pairingId(call.id);
			if (answered.has(key)) continue;
			projected.push(
				takeRealResult(call.id, pendingStart) ??
					stub(call, "No result provided", boundaryTimestamp),
			);
			answered.add(key);
		}
		pending = [];
		// The host keeps an aborted window open while its turn has no timestamp.
		if (abortedTimestamp === undefined) return;
		for (const call of aborted.values()) {
			const key = pairingId(call.id);
			if (answered.has(key)) continue;
			projected.push(
				takeRealResult(call.id, abortedStart) ??
					stub(call, "aborted", abortedTimestamp),
			);
			answered.add(key);
		}
		aborted = new Map();
		abortedTimestamp = undefined;
	};
	for (let index = 0; index < deduplicated.length; index++) {
		const value = deduplicated[index];
		const message = object(value);
		if (message?.role === "assistant") {
			flush(message.timestamp);
			// The host closes the preceding window before omitting this turn.
			if (piOmitsTruncatedAssistant(message)) continue;
			projected.push(value);
			const calls = windowCalls(message);
			if (message.stopReason === "aborted" || message.stopReason === "error") {
				aborted = new Map(calls.map((call) => [pairingId(call.id), call]));
				abortedTimestamp = message.timestamp;
				abortedStart = index;
			} else if (calls.length) {
				pending = calls;
				pendingStart = index;
			}
			continue;
		}
		if (
			message?.role !== "toolResult" ||
			typeof message.toolCallId !== "string"
		) {
			if (message?.role !== "toolResult") flush(message?.timestamp);
			projected.push(value);
			continue;
		}
		const key = pairingId(message.toolCallId);
		if (answered.has(key)) continue;
		if (
			aborted.has(key) ||
			pending.some((call) => pairingId(call.id) === key)
		) {
			aborted.delete(key);
			answered.add(key);
			projected.push(value);
			continue;
		}
		if (validToolUseIds.has(key)) continue;
		if (
			typeof message.toolName !== "string" ||
			!Array.isArray(message.content)
		) {
			// A malformed result is preserved unchanged.
			projected.push(value);
			continue;
		}
		// Native replay drops an orphan inside an unresolved normal or aborted
		// result window; otherwise it preserves nonblank text as an unprivileged
		// user note.
		if (
			pending.some((call) => !answered.has(pairingId(call.id))) ||
			aborted.size > 0
		)
			continue;
		const parts = message.content.flatMap((value) => {
			const part = object(value);
			return part?.type === "text" &&
				typeof part.text === "string" &&
				part.text.trim()
				? [part.text]
				: [];
		});
		if (!parts.length) continue;
		const error = message.isError ? ' is-error="true"' : "";
		const note = `<stale-tool-result tool="${message.toolName}" id="${message.toolCallId}"${error}>\n${parts.join("\n")}\n</stale-tool-result>`;
		projected.push({
			role: "user",
			content:
				api === "ollama-chat"
					? note
					: new TextDecoder().decode(new TextEncoder().encode(note)),
			timestamp: message.timestamp,
			[ORPHAN_NOTE]: true,
		});
	}
	flush();
	return projected;
}

/**
 * The projection for APIs whose provider does not run transformMessages (see
 * TRANSFORM_MESSAGES_APIS), whose tool-result handling is not known.
 * It synthesizes a stub at every boundary for a call with no later result and
 * leaves every result where the history has it; it never moves, drops or
 * renames anything. It writes no <stale-tool-result> notes, because those come
 * from transformMessages.
 */
function projectUnmodeledToolResults(messages: readonly unknown[]): unknown[] {
	const responsesComponents = new Set<string>();
	const opaqueIds = new Set<string>();
	const component = (id: string) => {
		const pipe = id.indexOf("|");
		return pipe > 0 ? id.slice(0, pipe) : id;
	};
	for (const value of messages) {
		const message = object(value);
		if (message?.role !== "assistant" || !Array.isArray(message.content))
			continue;
		for (const value of message.content) {
			const block = object(value);
			if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
			if (
				[
					"openai-responses",
					"azure-openai-responses",
					"openai-codex-responses",
				].includes(String(message.api))
			)
				responsesComponents.add(component(block.id));
			else if (block.id.includes("|")) opaqueIds.add(block.id);
		}
	}
	// Responses item suffixes are not part of the call identity; opaque Chat IDs
	// containing a pipe remain whole.
	const pairingId = (id: string) =>
		!opaqueIds.has(id) && responsesComponents.has(component(id))
			? component(id)
			: id;
	const lastResult = new Map<string, number>();
	messages.forEach((value, index) => {
		const message = object(value);
		if (
			message?.role === "toolResult" &&
			typeof message.toolCallId === "string"
		)
			lastResult.set(pairingId(message.toolCallId), index);
	});
	const projected: unknown[] = [];
	const resolved = new Set<string>();
	let pending: WindowCall[] = [];
	let start = -1;
	let aborted = false;
	let timestamp: unknown;
	const flush = (boundaryTimestamp?: unknown) => {
		for (const call of pending) {
			const key = pairingId(call.id);
			if (resolved.has(key) || (lastResult.get(key) ?? -1) > start) continue;
			projected.push({
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [
					{ type: "text", text: aborted ? "aborted" : "No result provided" },
				],
				isError: true,
				timestamp: aborted ? timestamp : boundaryTimestamp,
			});
			resolved.add(key);
		}
		pending = [];
	};
	for (let index = 0; index < messages.length; index++) {
		const value = messages[index];
		const message = object(value);
		if (
			(message?.role === "bashExecution" ||
				message?.role === "pythonExecution") &&
			message.excludeFromContext === true
		)
			continue;
		// Unresolved calls are flushed at every non-result boundary and at EOF. A
		// later real result prevents synthesis and keeps its own position.
		if (message?.role !== "toolResult") flush(message?.timestamp);
		else if (
			typeof message.toolCallId === "string" &&
			pending.some(
				(call) => pairingId(call.id) === pairingId(String(message.toolCallId)),
			)
		)
			resolved.add(pairingId(message.toolCallId));
		projected.push(value);
		if (message?.role !== "assistant" || !Array.isArray(message.content))
			continue;
		start = index;
		aborted =
			message.stopReason === "aborted" || message.stopReason === "error";
		timestamp = message.timestamp;
		if (aborted && typeof timestamp !== "number") continue;
		pending.push(...windowCalls(message));
	}
	flush();
	return projected;
}

/** Pi's window pass; see projectMissingToolResults. */
function projectPiToolResults(messages: readonly unknown[]): unknown[] {
	const projected: unknown[] = [];
	let pending: WindowCall[] = [];
	let answered = new Set<string>();
	const held: unknown[] = [];
	const close = (timestamp?: unknown) => {
		for (const call of pending)
			if (!answered.has(call.id))
				projected.push({
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text: "No result provided" }],
					isError: true,
					timestamp,
				});
		pending = [];
		answered = new Set();
		projected.push(...held);
		held.length = 0;
	};
	for (const value of messages) {
		const message = object(value);
		const role = message?.role;
		if (role === "assistant") {
			close(message?.timestamp);
			if (message?.stopReason === "error" || message?.stopReason === "aborted")
				continue;
			const calls = message ? windowCalls(message) : [];
			if (calls.length) pending = calls;
		} else if (role === "toolResult") {
			if (typeof message?.toolCallId === "string")
				answered.add(message.toolCallId);
		} else if (role === "system" && pending.length) {
			held.push(value);
			continue;
		} else if (
			// Pi's convertToLlm turns these into user messages before the transform.
			[
				"user",
				"custom",
				"bashExecution",
				"branchSummary",
				"compactionSummary",
			].includes(String(role))
		)
			close(message?.timestamp);
		projected.push(value);
	}
	close();
	return projected;
}

export function piPreparedStructure(
	messages: readonly unknown[],
	model?: PiChatHistoryModel,
	host: PiDispatchHost = "omp",
): PiPreparedStructure | undefined {
	return buildPiPreparedStructure(messages, model, undefined, host);
}

/** Prepare the returned OMP messages and their dispatch receipt in one walk. */
export function preparePiDispatch<T>(
	messages: T[],
	model: PiChatHistoryModel | undefined,
	omp: boolean,
): { messages: T[]; structure: PiPreparedStructure | undefined } {
	let output = messages;
	const structure = buildPiPreparedStructure(
		messages,
		model,
		omp
			? (index, source) => {
					// OMP replays a user compaction carrier instead of its readable summary.
					// Assistant payloads may be the only copy of encrypted reasoning.
					if (object(source.providerPayload)?.type !== "openaiResponsesHistory")
						return;
					if (output === messages) output = messages.slice();
					const { providerPayload: _payload, ...copy } = source;
					output[index] = copy as T;
				}
			: undefined,
		omp ? "omp" : "pi",
	);
	return { messages: output, structure };
}

function buildPiPreparedStructure(
	messages: readonly unknown[],
	model?: PiChatHistoryModel,
	prepareUser?: (index: number, source: Record<string, unknown>) => void,
	host: PiDispatchHost = "omp",
): PiPreparedStructure | undefined {
	if (!messages.length || messages.length > MAX_MESSAGES) return undefined;
	for (let index = 0; index < messages.length; index++) {
		const source = object(messages[index]);
		if (source?.role === "user" || source?.role === "compactionSummary")
			prepareUser?.(index, source);
	}
	const projectedMessages = projectMissingToolResults(
		model?.api && host === "omp"
			? piAgentHistory(messages, model.api)
			: messages,
		model,
		host,
	);
	if (projectedMessages.length > MAX_MESSAGES) return undefined;
	const rows: MessageStructure[] = [];
	const toolNames = new Map<string, string>();
	const toolIds = new Map<string, string | undefined>();
	const responsesToolIds = new Map<string, string | undefined>();
	const byIndex = new Map<number, MessageStructure>();
	const imageBudget = piImageBudgetPlan<MessageStructure>(model);
	let valid = true;
	for (let index = 0; index < projectedMessages.length; index++) {
		const message = projectedMessages[index];
		const source = object(message);
		// History injection and the provider renderer both put instructions before
		// conversation turns. Ignore only that leading system/developer prefix on
		// both sides; positioned system messages are conversation rows instead.
		if (
			rows.length === 0 &&
			(source?.role === "system" || source?.role === "developer")
		)
			continue;
		if (
			(source?.role === "bashExecution" ||
				source?.role === "pythonExecution") &&
			source.excludeFromContext === true
		)
			continue;
		const row = messageStructure(message);
		if (!row) {
			if (!prepareUser) return undefined;
			valid = false;
			continue;
		}
		// These providers omit a user/developer row with no nonblank text or
		// images. In particular, a compaction summary with blocks: [] has no wrapper.
		if (
			[
				"openai-completions",
				"openrouter",
				"anthropic-messages",
				"bedrock-converse-stream",
				"google-generative-ai",
				"google-gemini-cli",
				"google-vertex",
				"openai-responses",
				"azure-openai-responses",
				"openai-codex-responses",
			].includes(model?.api ?? "") &&
			(source?.role === "user" || source?.role === "developer") &&
			(typeof source.content === "string"
				? !source.content.trim()
				: Array.isArray(source.content) &&
					!source.content.some((value) => {
						const block = object(value);
						return (
							block?.type === "image" ||
							(block?.type === "text" &&
								typeof block.text === "string" &&
								block.text.trim())
						);
					}))
		)
			continue;
		if (source?.role === "assistant") {
			// The Anthropic converter sends no row for an assistant whose blocks
			// it skips, and may or may not send one whose only blocks are
			// thinking. Earlier passes still count the assistant, since the
			// host's replay pass keeps it.
			const replay = piAnthropicAssistantReplay(source, model, host);
			if (replay === "dropped") continue;
			if (replay === "optional")
				row.optionalThinking = piAnthropicOptionalThinking(source);
		}
		row.calls.forEach((id, index) => {
			toolNames.set(id, row.callNames?.[index] ?? "");
			if (model?.api) {
				const normalized = piToolCallWireId(id, model, source);
				row.wireCalls ??= [];
				row.wireCalls.push(normalized);
				toolIds.set(id, normalized);
				if (
					[
						"openai-responses",
						"azure-openai-responses",
						"openai-codex-responses",
					].includes(String(source?.api))
				)
					responsesToolIds.set(id.split("|", 1)[0], normalized);
			}
		});
		if (row.results.length) {
			row.resultNames = row.results.map((id) => toolNames.get(id) ?? "");
			if (model?.api)
				row.wireResults = row.results.map((id) =>
					toolIds.has(id)
						? toolIds.get(id)
						: responsesToolIds.get(id.split("|", 1)[0]),
				);
		}
		rows.push(row);
		byIndex.set(index, row);
		piRecordImages(imageBudget, row, source);
	}
	if (!valid) return undefined;
	// The rows before developer promotion and Continue pads, which the
	// comparator rebuilds when an optional assistant is left out.
	const baseRows = [...rows];
	const promotable = new Map<MessageStructure, readonly string[]>();
	// OMP renders non-user-attributed developer messages as system only after a
	// user turn (including tool results packed into user) and before assistant or end.
	// Iterate backwards, as the serializer does, so a promoted notice prevents
	// the notice immediately before it from becoming a consecutive system row.
	// @oh-my-pi/pi-ai 18.12.3, providers/anthropic.ts:6150-6210.
	const positionedRows = [...byIndex];
	for (let position = positionedRows.length - 1; position >= 0; position--) {
		const [index, row] = positionedRows[position];
		const source = object(projectedMessages[index]);
		if (!source) return undefined;
		const content = source.content;
		const parts =
			typeof content === "string" ? [{ type: "text", text: content }] : content;
		const textOnly =
			Array.isArray(parts) &&
			parts.every(
				(part) =>
					object(part)?.type === "text" &&
					typeof object(part)?.text === "string",
			);
		const systemTexts = () => {
			// Called only when textOnly holds, so every part is a text block.
			const texts = (parts as { text: string }[]).map((part) => part.text);
			return model?.api === "anthropic-messages"
				? texts
						.filter((text) => text.trim())
						.map((text) =>
							new TextDecoder().decode(new TextEncoder().encode(text)),
						)
				: texts;
		};
		if (piIsDeveloperHistory(source) && source.attribution !== "user") {
			const previous = rows[position - 1];
			const next = rows[position + 1];
			const anthropicPromotable =
				model?.api === "anthropic-messages" &&
				object(model.compat)?.supportsMidConversationSystem === true &&
				textOnly;
			if (anthropicPromotable) promotable.set(row, systemTexts());
			if (
				model?.api === "ollama-chat" ||
				(anthropicPromotable &&
					(previous?.role === "user" || previous?.role === "toolResult") &&
					(!next || next.role === "assistant"))
			)
				row.role = "system";
		}
		if (row.role === "system") {
			if (!textOnly) return undefined;
			row.systemText = systemTexts();
		}
	}
	// Model OMP's adjacent-assistant repair on the Anthropic route: an assistant
	// directly followed by another assistant gains a neutral user Continue pad.
	// Prepared rows hold no request controls, so looking through them is vacuous
	// here while matching the host walk that skips them. The pad carries exact
	// text so only the host's neutral nudge matches, not any other user turn.
	const modelsContinuePad = piModelsAnthropicContinuePad(model?.api, host);
	if (modelsContinuePad) {
		for (let position = rows.length - 1; position > 0; position--) {
			if (
				rows[position]?.role === "assistant" &&
				rows[position - 1]?.role === "assistant"
			)
				rows.splice(position, 0, {
					role: "user",
					calls: [],
					results: [],
					exactText: ANTHROPIC_CONTINUE_PAD_TEXT,
				});
		}
	}
	const responsesApi = responsesLane(model?.api);
	let responsesMessages: MessageStructure[] | undefined = responsesApi
		? []
		: undefined;
	const fallbackMessages: MessageStructure[] = [];
	const coldMessages: MessageStructure[] = [];
	let unsignedAlternatives = false;
	const appendResponse = (
		output: MessageStructure[],
		row: MessageStructure,
		texts: readonly string[],
	) => {
		if (!texts.length && !row.calls.length) return;
		const previous = output.at(-1);
		if (previous?.role === "assistant") {
			previous.calls.push(...row.calls);
			previous.wireCalls?.push(...(row.wireCalls ?? []));
			previous.responseTexts?.push(...texts);
		} else
			output.push({
				...row,
				calls: [...row.calls],
				...(row.wireCalls ? { wireCalls: [...row.wireCalls] } : {}),
				responseTexts: [...texts],
			});
	};
	if (responsesMessages) {
		for (const [index, row] of byIndex) {
			if (row.role !== "assistant") {
				responsesMessages.push(row);
				fallbackMessages.push(row);
				coldMessages.push(row);
				continue;
			}
			const alternatives: {
				fallback?: readonly string[];
				cold?: readonly string[];
			} = {};
			const texts = piResponsesAssistantTexts(
				projectedMessages[index],
				model,
				host,
				alternatives,
			);
			if (!texts) {
				responsesMessages = undefined;
				break;
			}
			// OpenAI Responses encodes assistant text and calls as separate input
			// items. Its normalized role rows combine adjacent assistant messages;
			// mirror that on prepared history without discarding any text or call ID.
			unsignedAlternatives ||= alternatives.fallback !== undefined;
			appendResponse(responsesMessages, row, texts);
			appendResponse(fallbackMessages, row, alternatives.fallback ?? texts);
			appendResponse(coldMessages, row, alternatives.cold ?? texts);
		}
	}
	const plan = piChatHistoryPlan(projectedMessages, model);
	let pendingToolImages: PiImageRun[] = [];
	const chatMessages = plan?.flatMap((step): MessageStructure[] => {
		if (step.kind === "source") {
			const row = byIndex.get(step.index);
			const images = row && imageBudget?.rows.get(row);
			if (row?.role === "toolResult" && images) pendingToolImages.push(images);
			return row ? [row] : [];
		}
		const row: MessageStructure = {
			role: "user",
			calls: [],
			results: [],
			...(step.kind === "note"
				? { exactText: step.text }
				: { exactImages: step.urls }),
		};
		if (step.kind === "images" && imageBudget && pendingToolImages.length) {
			imageBudget.rows.set(row, {
				first: pendingToolImages[0].first,
				images: pendingToolImages.flatMap((run) => run.images),
				synthesized: true,
			});
			pendingToolImages = [];
		}
		return [row];
	});
	return {
		messages: rows,
		...(imageBudget?.count ? { imageBudget } : {}),
		...(responsesApi && !responsesMessages
			? { structuralSkipReason: "Responses history transform is not modeled" }
			: model?.api === "openai-completions" && !chatMessages
				? { structuralSkipReason: "Chat history transform is not modeled" }
				: {}),
		...(chatMessages ? { chatMessages } : {}),
		...(responsesMessages ? { responsesMessages } : {}),
		// OMP 17.1.7 openai-shared.ts:1691-1719 chooses replay per request.
		// 18.12.x :2267-2271 additionally replays cold-safe turns (:2098-2107).
		// Each alternative is a complete fallback or cold message list for the
		// whole request; individual rows cannot choose different alternatives.
		...(responsesMessages && unsignedAlternatives
			? { responsesAlternatives: [fallbackMessages, coldMessages] }
			: {}),
		...(model?.api ? { api: model.api } : {}),
		...(modelsContinuePad ? { anthropicContinuePad: true as const } : {}),
		...(modelsContinuePad && baseRows.some((row) => row.optionalThinking)
			? { anthropicOptional: { rows: baseRows, promotable } }
			: {}),
		...(model?.api?.startsWith("google-")
			? {
					googleFunctionIds:
						object(model.compat)?.supportsFunctionPartId === true,
				}
			: {}),
	};
}

function responsesLane(api: string | undefined): boolean {
	return [
		"openai-responses",
		"azure-openai-responses",
		"openai-codex-responses",
	].includes(api ?? "");
}

function payloadStructure(
	payload: unknown,
	ollama = false,
	responsesItems = false,
	imageProjection = false,
): MessageStructure[] | undefined {
	const body = object(payload);
	if (!body) return undefined;
	const google = piGoogleConversation(payload);
	if (google)
		return googleStructure(google.contents as unknown[], imageProjection);
	const bedrock = body.inferenceConfig !== undefined;
	if (body.messages === undefined && typeof body.input === "string")
		return [{ role: "user", calls: [], results: [] }];
	const responses = body.messages === undefined && Array.isArray(body.input);
	const messages = responses ? body.input : body.messages;
	if (!Array.isArray(messages) || messages.length > MAX_MESSAGES)
		return undefined;
	const rows: MessageStructure[] = [];
	for (const value of messages) {
		const message = object(value);
		if (!message) return undefined;
		// Chat Completions and Azure Responses render context.systemPrompt before
		// context.messages, using system or developer roles. Leading instructions are not
		// prepared turns. piConversationFields keeps the original instruction rows
		// for exact comparison with the first admitted request on later dispatches.
		if (
			rows.length === 0 &&
			(message.role === "system" || message.role === "developer")
		)
			continue;
		// Oh My Pi's Anthropic provider inserts request-control system messages while
		// building the request, after the context pass, so they are never prepared
		// turns. Their content holds only tool_addition/tool_removal blocks; an
		// effort-only control has empty content and carries its effort in
		// output_config. A control can sit at the end of the request, before an
		// earlier response it was recorded with, or before the turn's user message,
		// so it is skipped wherever it appears. @oh-my-pi/pi-ai
		// src/providers/anthropic.ts insertAnthropicControlMarkers (18.12.6).
		if (
			message.role === "system" &&
			Array.isArray(message.content) &&
			message.content.every((block) =>
				["tool_addition", "tool_removal"].includes(String(object(block)?.type)),
			)
		)
			continue;
		// Responses emits reasoning/text/calls as separate items for one assistant
		// turn. Only its call/result IDs survive every supported replay mode.
		if (responses && message.type === "reasoning") continue;
		if (
			responses &&
			["function_call", "custom_tool_call", "computer_call"].includes(
				String(message.type),
			)
		) {
			if (typeof message.call_id !== "string") return undefined;
			let assistant = rows.at(-1);
			if (assistant?.role !== "assistant") {
				assistant = {
					role: "assistant",
					calls: [],
					results: [],
					...(responsesItems ? { responseTexts: [] } : {}),
				};
				rows.push(assistant);
			}
			assistant.calls.push(message.call_id);
			continue;
		}
		if (
			responses &&
			[
				"function_call_output",
				"custom_tool_call_output",
				"computer_call_output",
			].includes(String(message.type))
		) {
			if (typeof message.call_id !== "string") return undefined;
			rows.push({ role: "toolResult", calls: [], results: [message.call_id] });
			if (imageProjection)
				rows[rows.length - 1].images = piWireImages(message.output);
			continue;
		}
		if (message.role === "tool") {
			if (
				message.tool_call_id === undefined &&
				ollama &&
				typeof message.tool_name === "string"
			) {
				// Oh My Pi's Ollama converter emits no pairing IDs, only tool_name.
				// Match the prepared call's name at this exact result position so a
				// reordered or unrelated answer cannot borrow an earlier call's receipt.
				// @oh-my-pi/pi-ai/src/providers/ollama.ts:209-215,229-243 (18.10.4).
				rows.push({
					role: "toolResult",
					calls: [],
					results: [""],
					resultNames: [message.tool_name],
					idlessResults: [true],
					...(imageProjection
						? { images: piWireImages(message.content, message.images) }
						: {}),
				});
				continue;
			}
			if (typeof message.tool_call_id !== "string") return undefined;
			rows.push({
				role: "toolResult",
				calls: [],
				results: [message.tool_call_id],
				...(imageProjection
					? {
							images: piWireImages(
								message.content,
								ollama ? message.images : undefined,
							),
						}
					: {}),
			});
			continue;
		}
		if (message.role === "user" && Array.isArray(message.content)) {
			const results = message.content.filter(
				(block) =>
					object(block)?.type === "tool_result" ||
					(bedrock && object(block)?.toolResult),
			);
			if (results.length) {
				// Anthropic and Bedrock pack a consecutive result run into one user message;
				// expand it back to the prepared array's roles and result IDs.
				for (const block of results) {
					const id = bedrock ? block.toolResult?.toolUseId : block.tool_use_id;
					if (typeof id !== "string") return undefined;
					rows.push({
						role: "toolResult",
						calls: [],
						results: [id],
						...(imageProjection
							? {
									images: piWireImages(
										bedrock ? block.toolResult?.content : block.content,
									),
								}
							: {}),
					});
				}
				if (imageProjection) {
					const images = piWireImages(
						message.content.filter((block) => !results.includes(block)),
					);
					if (images.length)
						rows.push({ role: "user", calls: [], results: [], images });
				}
				continue;
			}
		}
		const row = messageStructure(message);
		if (!row) return undefined;
		row.wireContent = message.content;
		if (imageProjection)
			row.images = piWireImages(
				message.content,
				ollama ? message.images : undefined,
			);
		if (responses && responsesItems && row.role === "assistant") {
			const texts = piResponsesWireTexts(message.content, message.phase);
			if (!texts) return undefined;
			row.responseTexts = [...texts];
		}
		row.wireRole = message.role;
		if (bedrock && row.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (!block?.toolUse) continue;
				if (typeof block.toolUse.toolUseId !== "string") return undefined;
				row.calls.push(block.toolUse.toolUseId);
			}
		}
		if (Array.isArray(message.tool_calls)) {
			for (const call of message.tool_calls) {
				const source = object(call);
				if (!source) return undefined;
				if (source.id === undefined && ollama) {
					const fn = object(source.function);
					if (typeof fn?.name !== "string") return undefined;
					row.calls.push("");
					row.callNames ??= [];
					row.callNames.push(fn.name);
					row.idlessCalls ??= [];
					row.idlessCalls.push(true);
				} else {
					if (typeof source.id !== "string") return undefined;
					row.calls.push(source.id);
					if (ollama) {
						row.callNames ??= [];
						row.callNames.push("");
						row.idlessCalls ??= [];
						row.idlessCalls.push(false);
					}
				}
			}
		}
		if (
			responses &&
			row.role === "assistant" &&
			rows.at(-1)?.role === "assistant"
		) {
			const previous = rows[rows.length - 1];
			previous.calls.push(...row.calls);
			if (responsesItems)
				previous.responseTexts?.push(...(row.responseTexts ?? []));
		} else rows.push(row);
	}
	return rows;
}

function googleStructure(
	contents: unknown[],
	imageProjection = false,
): MessageStructure[] | undefined {
	if (contents.length > MAX_MESSAGES) return undefined;
	const rows: MessageStructure[] = [];
	for (const value of contents) {
		const message = object(value);
		if (!message || !Array.isArray(message.parts)) return undefined;
		if (message.role !== "user" && message.role !== "model") return undefined;
		const row: MessageStructure = {
			role: message.role === "model" ? "assistant" : "user",
			calls: [],
			results: [],
			...(imageProjection ? { images: piWireImages(message.parts) } : {}),
			wireRole: message.role,
			wireContent: message.parts,
		};
		const results: MessageStructure[] = [];
		for (const value of message.parts) {
			const part = object(value);
			if (!part) return undefined;
			if (part.functionCall) {
				const call = object(part.functionCall);
				if (
					row.role !== "assistant" ||
					typeof call?.name !== "string" ||
					(call.id !== undefined && typeof call.id !== "string")
				)
					return undefined;
				row.calls.push((call.id as string) ?? "");
				row.callNames ??= [];
				row.callNames.push(call.name);
			}
			if (part.functionResponse) {
				const result = object(part.functionResponse);
				if (
					row.role !== "user" ||
					typeof result?.name !== "string" ||
					(result.id !== undefined && typeof result.id !== "string")
				)
					return undefined;
				results.push({
					role: "toolResult",
					calls: [],
					results: [(result.id as string) ?? ""],
					resultNames: [result.name],
					...(imageProjection ? { images: piWireImages(result.parts) } : {}),
				});
			}
		}
		// Gemini packs adjacent function results into one user content. Its older
		// models omit IDs, but preserve the ordered function names and result run.
		if (results.length) {
			rows.push(...results);
			if (imageProjection && row.images?.length)
				rows.push({ role: "user", calls: [], results: [], images: row.images });
		} else rows.push(row);
	}
	return rows;
}

function wireId(
	id: string,
	anthropic: boolean,
	responses: boolean,
): string | undefined {
	if (anthropic) return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
	if (responses) {
		const callId = id.split(/[\n|]/, 1)[0];
		// Long/foreign IDs can be provider-hashed. Without that provider's
		// model/compat state we cannot prove the mapping, so refuse rather than guess.
		return /^[a-zA-Z0-9_-]{1,64}$/.test(callId) ? callId : undefined;
	}
	return id;
}

function matchesUserText(
	content: unknown,
	text: string,
	api: string | undefined,
	responses: boolean,
	googleOrBedrock: boolean,
): boolean {
	if (responses || googleOrBedrock) {
		if (!Array.isArray(content) || content.length !== 1) return false;
		const block = object(content[0]);
		return (
			!!block &&
			block.text === text &&
			(responses
				? block.type === "input_text"
				: Object.keys(block).length === 1)
		);
	}
	if (
		(api === "anthropic-messages" || api === "factory-droid-agent") &&
		Array.isArray(content)
	) {
		const block = content.length === 1 ? object(content[0]) : undefined;
		return block?.type === "text" && block.text === text;
	}
	return content === text;
}

type StructureComparison =
	| "role"
	| "call id"
	| "result id"
	| "name"
	| "count"
	| "timestamp"
	| "content"
	| "alignment"
	| "exception";

function safeRole(
	row: MessageStructure | undefined,
	readable: boolean,
): string {
	if (!readable) return "unreadable";
	if (!row) return "missing";
	return ["user", "assistant", "toolResult", "system"].includes(row.role)
		? row.role
		: "unknown";
}

function safeCount(value: number | undefined): number | "unreadable" {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: "unreadable";
}

function structureDetail(
	index: number,
	expected: readonly MessageStructure[] | undefined,
	actual: readonly MessageStructure[] | undefined,
	comparison: StructureComparison,
): string {
	const expectedRow = expected?.[index];
	const actualRow = actual?.[index];
	// Only enum roles and numeric counts may leave the comparator. IDs, names,
	// message text and exception messages must never enter refusal diagnostics.
	return `row=${index} expectedRows=${safeCount(expected?.length)} actualRows=${safeCount(actual?.length)} expectedRole=${safeRole(expectedRow, !!expected)} actualRole=${safeRole(actualRow, !!actual)} expectedCalls=${safeCount(expected ? (expectedRow?.calls.length ?? 0) : undefined)} actualCalls=${safeCount(actual ? (actualRow?.calls.length ?? 0) : undefined)} expectedResults=${safeCount(expected ? (expectedRow?.results.length ?? 0) : undefined)} actualResults=${safeCount(actual ? (actualRow?.results.length ?? 0) : undefined)} comparison=${comparison}`;
}

/** Derive only image-dependent rows; all other structural receipts are reused unchanged. */
function trimPreparedImageRows(
	rows: readonly MessageStructure[],
	budget: PiImageBudgetPlan<MessageStructure>,
	drops: number,
): MessageStructure[] {
	const projected: MessageStructure[] = [];
	let hoisted: PiInputImage[] = [];
	const flush = () => {
		if (hoisted.length)
			projected.push({ role: "user", calls: [], results: [], images: hoisted });
		hoisted = [];
	};
	for (const row of rows) {
		if (row.role !== "toolResult") flush();
		const run = budget.rows.get(row);
		if (
			!run ||
			(budget.api === "openai-completions" && row.role === "toolResult")
		) {
			projected.push(row);
			continue;
		}
		const images = piRemainingImages(run, drops);
		if (run.synthesized) {
			if (images.length)
				projected.push({
					...row,
					images,
					exactImages: row.exactImages?.slice(
						run.images.length - images.length,
					),
				});
		} else if (run.hoisted) {
			projected.push(row);
			hoisted.push(...images);
		} else projected.push({ ...row, images });
	}
	flush();
	return projected;
}

/**
 * Count the ways the wire rows read as the prepared rows with some optional
 * assistants left out, stopping at two. Leaving an assistant out changes its
 * neighbours as the converter does: OMP puts a Continue pad between two
 * assistants that end up adjacent, and promotes a developer row to system
 * only between a user turn and an assistant or the end (see
 * buildPiPreparedStructure). Each wire row maps to exactly one prepared row
 * or pad; a trailing Continue pad after a final assistant is also accepted.
 *
 * The walk is forward over prepared rows. A state is the last chosen row,
 * whose final form waits for the next chosen row, the role of the row chosen
 * before it, and the wire row it must match. Required rows cannot be skipped,
 * so a state reaches only the run of optional rows that follows it.
 */
function countAnthropicOptionalAlignments(
	plan: PiAnthropicOptionalPlan,
	base: readonly MessageStructure[],
	wire: readonly MessageStructure[],
	compare: (
		expected: MessageStructure,
		actual: MessageStructure,
	) => StructureComparison | undefined,
): number {
	const pad: MessageStructure = {
		role: "user",
		calls: [],
		results: [],
		exactText: ANTHROPIC_CONTINUE_PAD_TEXT,
	};
	// Promoted rows were rewritten in place for the all-present rows; their
	// role before promotion is always user.
	const role = (index: number) =>
		plan.promotable.has(base[index]) ? "user" : base[index].role;
	const final = (
		index: number,
		previous: string | undefined,
		next: string | undefined,
	): MessageStructure => {
		const row = base[index];
		const systemText = plan.promotable.get(row);
		if (!systemText) return row;
		const promoted =
			(previous === "user" || previous === "toolResult") &&
			(next === undefined || next === "assistant");
		return promoted
			? { ...row, role: "system", systemText }
			: { ...row, role: "user", systemText: undefined };
	};
	const matches = (expected: MessageStructure, at: number) =>
		at < wire.length && compare(expected, wire[at]) === undefined;
	// states[index] maps "previous role|wire position" to a path count.
	const states = new Map<number, Map<string, number>>();
	const add = (
		index: number,
		previous: string | undefined,
		at: number,
		count: number,
	) => {
		let bucket = states.get(index);
		if (!bucket) {
			bucket = new Map();
			states.set(index, bucket);
		}
		const key = `${previous ?? ""}|${at}`;
		bucket.set(key, Math.min(2, (bucket.get(key) ?? 0) + count));
	};
	let complete = 0;
	const advance = (
		current: number,
		previous: string | undefined,
		at: number,
		count: number,
	) => {
		// Place the current row once its successor is known, then a pad when
		// both are assistants.
		const place = (next: number | undefined): number | undefined => {
			if (current < 0) return at;
			const nextRole = next === undefined ? undefined : role(next);
			if (!matches(final(current, previous, nextRole), at)) return undefined;
			let after = at + 1;
			if (role(current) === "assistant" && nextRole === "assistant") {
				if (!matches(pad, after)) return undefined;
				after++;
			}
			return after;
		};
		for (let next = current + 1; next < base.length; next++) {
			const after = place(next);
			if (after !== undefined)
				add(next, current < 0 ? undefined : role(current), after, count);
			if (!base[next].optionalThinking) return;
		}
		// Every remaining row is optional and left out: the current row ends
		// the request.
		if (current < 0) {
			if (wire.length === 0) complete = Math.min(2, complete + count);
			return;
		}
		const after = place(undefined);
		if (
			after === wire.length ||
			(after === wire.length - 1 &&
				role(current) === "assistant" &&
				isAnthropicContinuePadRow(wire[after]))
		)
			complete = Math.min(2, complete + count);
	};
	advance(-1, undefined, 0, 1);
	for (let index = 0; index < base.length && complete < 2; index++) {
		const bucket = states.get(index);
		if (!bucket) continue;
		states.delete(index);
		for (const [key, count] of bucket) {
			const split = key.lastIndexOf("|");
			const previous = key.slice(0, split) || undefined;
			advance(index, previous, Number(key.slice(split + 1)), count);
		}
	}
	return complete;
}

/** Return metadata for the first differing zero-based normalized row, or no mismatch. */
export function piPreparedStructureMismatch(
	payload: unknown,
	prepared: PiPreparedStructure | undefined,
	onImageTrim?: (counts: {
		planned: number;
		actual: number;
		trimmed: number;
	}) => void,
): string | undefined {
	// Where the comparison was when something threw, plus the built-in error
	// class. Both are fixed vocabularies, so an exception's message or a
	// getter's value can never reach the refusal text.
	let stage = "image count";
	let row = 0;
	let expectedRows: readonly MessageStructure[] | undefined;
	let rows: readonly MessageStructure[] | undefined;
	try {
		if (prepared?.structuralSkipReason) return undefined;
		const imageBudget = prepared?.imageBudget;
		const actualImages = imageBudget ? piWireImageCount(payload) : 0;
		const trimmed = imageBudget ? imageBudget.count - actualImages : 0;
		if (trimmed < 0) return "comparison=image count";
		// An equal count must take the original structural comparison, including
		// its existing provider text equivalences. Image projection is trim-only.
		const imageProjection = trimmed > 0;
		stage = "wire rows";
		const body = object(payload);
		const ollama =
			prepared?.api === "ollama-chat" &&
			!!body &&
			Array.isArray(body.messages) &&
			body.input === undefined &&
			body.system === undefined &&
			body.inferenceConfig === undefined;
		const responses =
			body?.messages === undefined && Array.isArray(body?.input);
		rows = payloadStructure(
			payload,
			ollama,
			responses && !!prepared?.responsesMessages,
			imageProjection,
		);
		const chat =
			!!body &&
			Array.isArray(body.messages) &&
			(prepared?.api === "openai-completions" || body.system === undefined) &&
			body.input === undefined &&
			body.inferenceConfig === undefined;
		stage = "prepared rows";
		expectedRows =
			responses && prepared?.responsesMessages
				? prepared.responsesMessages
				: chat && prepared?.chatMessages
					? prepared.chatMessages
					: prepared?.messages;
		if (responses && rows && prepared?.responsesAlternatives) {
			const actual = rows;
			expectedRows =
				[prepared.responsesMessages, ...prepared.responsesAlternatives].find(
					(candidate) =>
						candidate?.length === actual.length &&
						candidate.every(
							(expected, index) =>
								JSON.stringify(expected.responseTexts) ===
								JSON.stringify(actual[index].responseTexts),
						),
				) ?? expectedRows;
		}
		const optionalPlan =
			expectedRows === prepared?.messages
				? prepared?.anthropicOptional
				: undefined;
		if (expectedRows && imageProjection && imageBudget)
			expectedRows = trimPreparedImageRows(expectedRows, imageBudget, trimmed);
		if (!rows || !expectedRows)
			return structureDetail(0, expectedRows, rows, "count");
		if (!body) return structureDetail(0, expectedRows, rows, "count");
		stage = "row comparison";
		const google = !!piGoogleConversation(payload);
		const anthropic =
			google ||
			body.inferenceConfig !== undefined ||
			prepared?.api === "anthropic-messages" ||
			(!prepared?.api &&
				body.max_tokens !== undefined &&
				Array.isArray(body.system));
		// One prepared row against one wire row: the comparison that failed, or
		// none when the wire row is the one prepared.
		const compareRow = (
			expected: MessageStructure,
			actual: MessageStructure,
		): StructureComparison | undefined => {
			if (actual.role !== expected.role) return "role";
			if (expected.systemText !== undefined) {
				const texts = expected.systemText;
				const content = actual.wireContent;
				const actualTexts =
					typeof content === "string"
						? [content]
						: Array.isArray(content) &&
								content.every(
									(part) =>
										object(part)?.type === "text" &&
										typeof object(part)?.text === "string",
								)
							? content.map((part) => part.text)
							: undefined;
				if (
					!actualTexts ||
					(typeof content === "string"
						? content !== texts.join("\n")
						: JSON.stringify(actualTexts) !== JSON.stringify(texts))
				)
					return "content";
			}
			if (
				imageProjection &&
				!piMatchesImages(actual.images ?? [], expected.images ?? [])
			)
				return "content";
			if (
				expected.responseTexts !== undefined &&
				(expected.responseTexts.length !== actual.responseTexts?.length ||
					expected.responseTexts.some(
						(text, index) => text !== actual.responseTexts?.[index],
					))
			)
				return "content";
			if (
				expected.exactText !== undefined ||
				expected.exactImages !== undefined
			) {
				if (actual.wireRole !== "user") return "role";
				if (
					(expected.exactText !== undefined &&
						!matchesUserText(
							actual.wireContent,
							expected.exactText,
							prepared?.api,
							responses,
							google || body.inferenceConfig !== undefined,
						)) ||
					(expected.exactImages !== undefined &&
						!piMatchesChatImages(actual.wireContent, expected.exactImages))
				)
					return "content";
			}
			if (
				actual.calls.length !== expected.calls.length ||
				actual.results.length !== expected.results.length
			)
				return "count";
			if (
				actual.timestamp !== undefined &&
				actual.timestamp !== expected.timestamp
			)
				return "timestamp";
			for (let j = 0; j < actual.calls.length; j++)
				if (
					(google &&
						actual.calls[j] === "" &&
						prepared?.googleFunctionIds !== true) ||
					(ollama && actual.idlessCalls?.[j] === true)
						? !expected.callNames?.[j] ||
							actual.callNames?.[j] !== expected.callNames[j]
						: (google && prepared?.googleFunctionIds === false) ||
							actual.calls[j] !==
								(expected.wireCalls
									? expected.wireCalls[j]
									: wireId(expected.calls[j], anthropic, responses))
				)
					return (google && actual.calls[j] === "") ||
						(ollama && actual.idlessCalls?.[j] === true)
						? "name"
						: "call id";
			for (let j = 0; j < actual.results.length; j++)
				if (
					(google &&
						actual.results[j] === "" &&
						prepared?.googleFunctionIds !== true) ||
					(ollama && actual.idlessResults?.[j] === true)
						? !expected.resultNames?.[j] ||
							actual.resultNames?.[j] !== expected.resultNames[j]
						: (google && prepared?.googleFunctionIds === false) ||
							actual.results[j] !==
								(expected.wireResults
									? expected.wireResults[j]
									: wireId(expected.results[j], anthropic, responses))
				)
					return (google && actual.results[j] === "") ||
						(ollama && actual.idlessResults?.[j] === true)
						? "name"
						: "result id";
			if (
				expected.optionalThinking &&
				!piExplainsOptionalAssistant(
					expected.optionalThinking,
					actual.wireContent,
				)
			)
				return "content";
			return undefined;
		};
		// Some prepared assistants may be absent from the wire. Count the ways
		// the wire can be read as the prepared rows with some of them left out;
		// exactly one must fit, and more than one refuses. With none, the
		// comparison below against the rows with every assistant present names
		// the first difference.
		if (optionalPlan) {
			stage = "optional assistants";
			const alignments = countAnthropicOptionalAlignments(
				optionalPlan,
				imageProjection && imageBudget
					? trimPreparedImageRows(optionalPlan.rows, imageBudget, trimmed)
					: optionalPlan.rows,
				rows,
				compareRow,
			);
			if (alignments > 1)
				return structureDetail(0, expectedRows, rows, "alignment");
			if (alignments === 1) {
				if (imageProjection && imageBudget)
					onImageTrim?.({
						planned: imageBudget.count,
						actual: actualImages,
						trimmed,
					});
				return undefined;
			}
			stage = "row comparison";
		}
		for (let i = 0; i < Math.min(rows.length, expectedRows.length); i++) {
			row = i;
			const comparison = compareRow(expectedRows[i], rows[i]);
			if (comparison) return structureDetail(i, expectedRows, rows, comparison);
		}
		if (rows.length !== expectedRows.length) {
			// OMP appends the same neutral Continue pad after a trailing assistant
			// for live requests, but not for compaction requests. Accept the single
			// trailing pad when the prepared turn ends with an assistant on a
			// route that models the repair. Interior pads are already prepared
			// with exact text, so any other length still refuses.
			const lastActual = rows[rows.length - 1] as MessageStructure | undefined;
			const allowsTrailingPad =
				prepared?.anthropicContinuePad === true &&
				expectedRows.length > 0 &&
				expectedRows[expectedRows.length - 1]?.role === "assistant" &&
				rows.length === expectedRows.length + 1 &&
				!!lastActual &&
				isAnthropicContinuePadRow(lastActual);
			if (!allowsTrailingPad)
				return structureDetail(
					Math.min(rows.length, expectedRows.length),
					expectedRows,
					rows,
					"count",
				);
		}
		// No reading of the wire fit the optional assistants, so the wire is not
		// the prepared turn even where the all-present rows above raised nothing.
		if (optionalPlan)
			return structureDetail(0, expectedRows, rows, "alignment");
		if (imageProjection && imageBudget)
			onImageTrim?.({
				planned: imageBudget.count,
				actual: actualImages,
				trimmed,
			});
		return undefined;
	} catch (error) {
		// Unreadable payloads still fail closed; report where, not what was read.
		const name =
			error instanceof Error &&
			[
				"Error",
				"TypeError",
				"RangeError",
				"SyntaxError",
				"ReferenceError",
			].includes(error.constructor.name)
				? error.constructor.name
				: "unknown";
		return `${structureDetail(row, expectedRows, rows, "exception")} stage=${stage} error=${name}`;
	}
}

/** Check the latest turn as well as every preceding role and ordered tool ID. */
export function piMatchesPreparedStructure(
	payload: unknown,
	prepared: PiPreparedStructure | undefined,
): boolean {
	return piPreparedStructureMismatch(payload, prepared) === undefined;
}
