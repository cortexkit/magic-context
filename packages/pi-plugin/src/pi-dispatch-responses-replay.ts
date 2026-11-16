import type { PiChatHistoryModel } from "./pi-dispatch-chat-history";
import { piResponsesColdReplayable } from "./pi-dispatch-responses-history";

/**
 * Oh My Pi's native replay of an assistant turn's tool calls on the OpenAI
 * Responses routes, and the input repairs it runs afterwards, mirrored on the
 * dispatch fence's prepared rows.
 *
 * When a turn came from the request's own model, OMP sends the output items
 * the provider returned for it (kept in the message's `providerPayload`)
 * instead of items rebuilt from the message. Those items keep the call ids the
 * provider sent. When the provider reused a call id, OMP has already renamed
 * the later call in the message (`call_0` becomes `call_0_dup1`), so the stored
 * items no longer name every call in the message: OMP appends each call they
 * lack after them, and later gives every call left without an output a
 * placeholder output. A two-call reply with ids [call_0, call_0] therefore goes
 * out as call_0, call_0, call_0_dup1; replies [call_0] then [call_1, call_0]
 * go out as call_0, its output, call_1, call_0, a placeholder output for that
 * call_0, call_0_dup1, then the two real outputs.
 *
 * The same in @oh-my-pi/pi-ai 18.19.0, 18.20.0 and 18.20.3 (line numbers for
 * 18.19.0 and 18.20.0, then 18.20.3):
 * - src/providers/transform-messages.ts:227 deduplicateToolCallIds renames a
 *   reused id (mirrored by projectMissingToolResults in pi-dispatch-structure);
 * - src/providers/openai-shared.ts buildResponsesInput replays the stored items
 *   of a turn from the request's api and model at :2368-2455 (:2415-2502),
 *   appending pickUnrecordedResponsesToolCalls (:1582, :1585);
 * - then repairOrphanResponsesToolOutputs (:1661, :1664),
 *   repairOrphanResponsesToolCalls (:1718, :1721) and
 *   hoistInterleavedResponsesToolBatchMessages (:1791, :1794) run over the
 *   whole input, in that order (:2512-2514, :2560-2562);
 * - src/providers/openai-codex/request-transformer.ts:244 sanitizeCodexCallId
 *   is how pickUnrecordedResponsesToolCalls compares ids.
 */

function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

const RESPONSES_APIS = [
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
];

/**
 * The part of an id that sanitizeCodexCallId keeps: what precedes the first
 * `|` or newline. That function maps two ids to the same value exactly when
 * these parts are equal (it hashes a part it cannot pass through unchanged),
 * barring a hash collision, so comparing the parts decides the same question.
 */
function callBase(id: string): string {
	const separator = id.search(/[\n|]/);
	return separator > 0
		? id.slice(0, separator)
		: separator === 0
			? id.slice(1)
			: id;
}

/** One assistant turn's calls as OMP sends them when it replays the turn's stored items. */
export interface PiResponsesReplayedCalls {
	/** Call ids in wire order: the stored items' own, then each prepared call they lack. */
	calls: readonly string[];
	/** The wire `call_id` of each entry in `calls`. */
	wireCalls: readonly string[];
	/** Where the replayed text parts sit among the calls: one `text` per output_text part, one `call` per call. */
	order: readonly ("text" | "call")[];
	/** Whether OMP replays the stored items even without warm provider state. */
	cold: boolean;
}

/**
 * The calls OMP sends for an assistant turn when it replays the turn's stored
 * output items. Undefined when OMP would rebuild the turn from the message
 * instead, when the stored items hold anything but reasoning, assistant text
 * and calls (left unmodeled, so the prepared rows keep the rebuilt calls), or
 * when the replay sends exactly the calls the rebuilt turn would.
 */
export function piResponsesReplayedCalls(
	value: unknown,
	calls: readonly string[],
	wireCalls: readonly (string | undefined)[] | undefined,
	model: PiChatHistoryModel | undefined,
): PiResponsesReplayedCalls | undefined {
	const message = object(value);
	if (message?.role !== "assistant" || !model?.api) return undefined;
	if (!RESPONSES_APIS.includes(model.api)) return undefined;
	if (
		message.api !== model.api ||
		message.model !== model.id ||
		typeof model.provider !== "string"
	)
		return undefined;
	const payload = object(message.providerPayload);
	// A payload without the dt flag replaces all earlier input when replayed,
	// which the prepared rows do not model at all; leave it as it was.
	if (
		payload?.type !== "openaiResponsesHistory" ||
		payload.dt !== true ||
		!Array.isArray(payload.items) ||
		(payload.provider ?? message.provider ?? model.provider) !== model.provider
	)
		return undefined;
	const stored: string[] = [];
	const order: ("text" | "call")[] = [];
	let output = false;
	for (const value of payload.items) {
		const item = object(value);
		if (item?.type === "reasoning") continue;
		if (item?.type === "function_call" || item?.type === "custom_tool_call") {
			if (typeof item.call_id !== "string" || !item.call_id.trim())
				return undefined;
			stored.push(item.call_id);
			order.push("call");
			output = true;
			continue;
		}
		if (
			item?.type !== "message" ||
			item.role !== "assistant" ||
			!Array.isArray(item.content)
		)
			return undefined;
		const texts: string[] = [];
		for (const value of item.content) {
			const part = object(value);
			if (part?.type !== "output_text" || typeof part.text !== "string")
				return undefined;
			texts.push(part.text);
		}
		// OMP's sanitizer drops an assistant message with no visible text; the
		// text rows (piResponsesAssistantTexts) skip it the same way.
		if (!texts.some((text) => /\S/u.test(text))) continue;
		output = true;
		for (const _text of texts) order.push("text");
	}
	// With no replayable output OMP rebuilds the turn from the message.
	if (!output) return undefined;
	// Only reasoning, assistant text and calls remain, so every stored call sits
	// in the final window pickUnrecordedResponsesToolCalls reads.
	const recorded = new Set(stored.map(callBase));
	const replayed = [...stored];
	const wires = [...stored];
	for (let index = 0; index < calls.length; index++) {
		if (recorded.has(callBase(calls[index]))) continue;
		const wire = wireCalls?.[index];
		if (wire === undefined) return undefined;
		replayed.push(calls[index]);
		wires.push(wire);
		order.push("call");
	}
	if (
		wireCalls &&
		wires.length === wireCalls.length &&
		wires.every((id, index) => id === wireCalls[index])
	)
		return undefined;
	return {
		calls: replayed,
		wireCalls: wires,
		order,
		cold: piResponsesColdReplayable(payload.items),
	};
}

/** The row fields the replay plan reads and writes; the prepared rows carry more. */
export interface PiResponsesReplayRow {
	role: string;
	calls: string[];
	results: string[];
	wireCalls?: (string | undefined)[];
	wireResults?: (string | undefined)[];
	responseTexts?: string[];
}

/** One prepared row of a request plan; an assistant row also carries the plan's texts for it. */
export type PiResponsesPlanEntry<R extends PiResponsesReplayRow> =
	| { row: R; texts?: undefined }
	| {
			row: R;
			texts: readonly string[];
			/** Set when this plan sends the turn's stored items. */
			replayed?: PiResponsesReplayedCalls;
	  };

type ReplayItem<R> =
	| { kind: "other"; row: R }
	/** A placeholder output (OMP's repair) has no prepared row. */
	| { kind: "output"; id: string; row?: R }
	| { kind: "text"; text: string; source: R }
	| { kind: "call"; id: string; wire: string; source: R };

type BatchKind = "call" | "output" | "assistant-message" | "other";

function batchKind<R>(item: ReplayItem<R>): BatchKind {
	return item.kind === "text"
		? "assistant-message"
		: item.kind === "call" || item.kind === "output"
			? item.kind
			: "other";
}

function batchCallId<R>(item: ReplayItem<R>): string | undefined {
	return item.kind === "call"
		? item.wire
		: item.kind === "output"
			? item.id
			: undefined;
}

/**
 * hoistInterleavedResponsesToolBatchMessages, line for line, over plan items:
 * an assistant message inside a run of calls and outputs moves to the start of
 * that batch. openai-shared.ts:1791-1878 (18.19.0, 18.20.0), :1794-1881 (18.20.3).
 */
function hoistBatchMessages<R>(items: readonly ReplayItem<R>[]): ReplayItem<R>[] {
	const hasEarlierBatchCall = (index: number, callId: string): boolean => {
		for (let probe = index - 1; probe >= 0; probe--) {
			const kind = batchKind(items[probe]);
			if (kind === "other") return false;
			if (kind === "call" && batchCallId(items[probe]) === callId) return true;
		}
		return false;
	};
	const bucketOf = new Map<number, number>();
	const insertBefore = new Map<number, number[]>();
	for (let index = 0; index < items.length; index++) {
		if (batchKind(items[index]) !== "output") continue;
		if (index > 0 && batchKind(items[index - 1]) === "output") continue;
		const pending = new Set<string>();
		for (let probe = index; probe < items.length; probe++) {
			if (batchKind(items[probe]) !== "output") break;
			const callId = batchCallId(items[probe]);
			if (callId) pending.add(callId);
		}
		let start = index;
		let sawCall = false;
		const messageIndexes: number[] = [];
		while (start > 0) {
			const item = items[start - 1];
			const kind = batchKind(item);
			if (kind === "call") {
				sawCall = true;
				const callId = batchCallId(item);
				if (callId) pending.delete(callId);
			} else if (kind === "output") {
				const callId = batchCallId(item);
				if (!callId || !hasEarlierBatchCall(start - 1, callId)) break;
				let ownsEarlierCall = false;
				for (const owned of pending) {
					if (hasEarlierBatchCall(start - 1, owned)) {
						ownsEarlierCall = true;
						break;
					}
				}
				if (!ownsEarlierCall) break;
				pending.add(callId);
			} else if (kind === "assistant-message") {
				messageIndexes.push(start - 1);
			} else {
				break;
			}
			start -= 1;
		}
		if (!sawCall || messageIndexes.length === 0) continue;
		messageIndexes.reverse();
		const target = insertBefore.get(start) ?? [];
		for (const messageIndex of messageIndexes) {
			const previousStart = bucketOf.get(messageIndex);
			if (previousStart !== undefined) {
				const previous = insertBefore.get(previousStart);
				const slot = previous?.indexOf(messageIndex) ?? -1;
				if (previous && slot >= 0) previous.splice(slot, 1);
			}
			bucketOf.set(messageIndex, start);
			target.push(messageIndex);
		}
		insertBefore.set(start, target);
	}
	if (bucketOf.size === 0) return items.slice();
	const result: ReplayItem<R>[] = [];
	for (let index = 0; index < items.length; index++) {
		const pending = insertBefore.get(index);
		if (pending)
			for (const messageIndex of pending) result.push(items[messageIndex]);
		if (bucketOf.has(index)) continue;
		result.push(items[index]);
	}
	return result;
}

/**
 * The rows OMP's Responses input has for one request plan, built item by item
 * the way buildResponsesInput builds it and read back the way the dispatch
 * comparator reads the wire: reasoning is invisible, adjacent assistant text
 * and calls share one row, and every output is its own row.
 *
 * A turn the plan replays from its stored items contributes them in stored
 * order; any other turn contributes its texts and then its calls, an order
 * that the grouping cannot tell apart from any other within one turn. Then:
 * - an output whose call is not earlier in the input would become an assistant
 *   note (repairOrphanResponsesToolOutputs); that is not modeled, so the plan
 *   is left as it was (undefined);
 * - a call with no later output gains a placeholder output right after it
 *   (repairOrphanResponsesToolCalls);
 * - assistant text inside a call batch moves before the batch (hoist above).
 *
 * Undefined, keeping the caller's existing rows, when a row cannot be placed:
 * a call or result without a wire id, a result row with other than one
 * result, or replayed text parts that do not pair with the plan's texts.
 */
export function piResponsesReplayRows<R extends PiResponsesReplayRow>(
	entries: readonly PiResponsesPlanEntry<R>[],
	placeholder: (callId: string) => R,
	assistant: (source: R) => R,
): R[] | undefined {
	const items: ReplayItem<R>[] = [];
	for (const entry of entries) {
		const row = entry.row;
		if (entry.texts === undefined) {
			if (row.role !== "toolResult") {
				items.push({ kind: "other", row });
				continue;
			}
			const wire = row.wireResults?.[0];
			if (row.results.length !== 1 || wire === undefined) return undefined;
			items.push({ kind: "output", id: wire, row });
			continue;
		}
		const { texts, replayed } = entry;
		if (replayed) {
			const textSlots = replayed.order.filter((kind) => kind === "text");
			if (textSlots.length !== texts.length) return undefined;
			let text = 0;
			let call = 0;
			for (const kind of replayed.order) {
				if (kind === "text")
					items.push({ kind: "text", text: texts[text++], source: row });
				else {
					items.push({
						kind: "call",
						id: replayed.calls[call],
						wire: replayed.wireCalls[call],
						source: row,
					});
					call++;
				}
			}
			continue;
		}
		for (const text of texts) items.push({ kind: "text", text, source: row });
		for (let index = 0; index < row.calls.length; index++) {
			const wire = row.wireCalls?.[index];
			if (wire === undefined) return undefined;
			items.push({ kind: "call", id: row.calls[index], wire, source: row });
		}
	}
	const preceding = new Set<string>();
	for (const item of items) {
		if (item.kind === "call") preceding.add(item.wire);
		else if (item.kind === "output" && !preceding.has(item.id))
			return undefined;
	}
	const later = new Set<string>();
	const orphans = new Set<number>();
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item.kind === "output") later.add(item.id);
		else if (item.kind === "call" && !later.has(item.wire)) orphans.add(index);
	}
	const repaired = items.flatMap((item, index): ReplayItem<R>[] =>
		item.kind === "call" && orphans.has(index)
			? [item, { kind: "output", id: item.wire }]
			: [item],
	);
	const rows: R[] = [];
	let open: R | undefined;
	for (const item of hoistBatchMessages(repaired)) {
		if (item.kind === "other" || item.kind === "output") {
			rows.push(
				item.kind === "other" ? item.row : (item.row ?? placeholder(item.id)),
			);
			open = undefined;
			continue;
		}
		if (!open) {
			open = assistant(item.source);
			rows.push(open);
		}
		if (item.kind === "text") open.responseTexts?.push(item.text);
		else {
			open.calls.push(item.id);
			open.wireCalls?.push(item.wire);
		}
	}
	return rows;
}
