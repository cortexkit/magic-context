import { isDeepStrictEqual } from "node:util";
import {
	exactReusablePrefix,
	type LkgInputSnapshot,
	lkgContentFields,
} from "@magic-context/core/hooks/magic-context/lkg-slot";
import { piEncodeChainTail } from "./pi-dispatch-chain-tail";
import type { PiChatHistoryModel } from "./pi-dispatch-chat-history";

/**
 * Oh My Pi's Responses providers can continue a conversation from the copy the
 * provider stored instead of resending it. With WebSockets on, the Codex
 * provider checks that the new request extends the previous request plus its
 * response, then sends only the appended items and names the stored response in
 * `previous_response_id`. Only after that does it emit before_provider_request
 * (@oh-my-pi/pi-ai 18.12.3, src/providers/openai-codex-responses.ts:3864-3880
 * builds the delta; 1875 and 1955-1962 hand that frame to onPayload). Such a
 * frame carries none of the managed history head, so the dispatch fence checks
 * it as the full request it continues. This module records what each admitted
 * request carried and which response the provider returned to it.
 */

function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** One context pass's prepared messages, compared position by position. */
export interface PiPreparedHistory {
	snapshots: readonly LkgInputSnapshot[];
	/** The provider response ID stored on each assistant message, if any. */
	responseIds: readonly (string | undefined)[];
	/** Native response and encoded input tail after the latest completed assistant. */
	continuation?: {
		index: number;
		responseItems: readonly unknown[];
		delta: readonly unknown[];
	};
}

/** An admitted managed request: the full input it carried and the pass that prepared it. */
export interface PiChainRequest {
	/** Every input item the provider holds for this request, chains expanded. */
	input: readonly unknown[];
	prepared: PiPreparedHistory;
}

/** The provider's completed response to the latest admitted managed request. */
export interface PiChainAnchor extends PiChainRequest {
	responseId: string;
	/** The response's native output items, which the provider keeps with it. */
	responseItems: readonly unknown[];
	/**
	 * The context pass whose request was admitted after this response. Only
	 * that pass may still continue from it, and only by resending its own
	 * already-admitted chained frame unchanged (a provider retry).
	 */
	supersededBy?: object;
}

/** Per-session continuation state kept across runs (continuations start new runs). */
export interface PiChainState {
	/** Admitted and still waiting for its completed response. */
	awaiting?: PiChainRequest;
	anchor?: PiChainAnchor;
}

/** Only these Oh My Pi serializers chain requests through previous_response_id. */
export function piChainCapableApi(api: unknown): boolean {
	return (
		api === "openai-codex-responses" ||
		api === "openai-responses" ||
		api === "azure-openai-responses"
	);
}

function injectedHeadIndex(messages: readonly unknown[]): number {
	let index = 0;
	while (object(messages[index])?.role === "system") index++;
	const m0 = object(messages[index]);
	const m1 = object(messages[index + 1]);
	const syntheticUser = (message: Record<string, unknown> | undefined) =>
		message?.role === "user" &&
		Object.keys(message).every((key) =>
			["role", "content", "timestamp"].includes(key),
		);
	if (!syntheticUser(m0) || !syntheticUser(m1)) return -1;
	const m0Content = m0?.content;
	const m1Content = m1?.content;
	if (!Array.isArray(m0Content) || !Array.isArray(m1Content)) return -1;
	const m0Text = object(m0Content[0]);
	const m1Text = object(m1Content[0]);
	return m0Content.length >= 1 &&
		m0Content.length <= 2 &&
		(m0Content.length === 1 || object(m0Content[1])?.type === "image") &&
		m1Content.length === 1 &&
		m0Text?.type === "text" &&
		typeof m0Text.text === "string" &&
		/^(<project-docs>|<user-profile>|<covered-system-messages>|<session-history>)/.test(
			m0Text.text,
		) &&
		m0Text.text.includes("</session-history>") &&
		m1Text?.type === "text" &&
		typeof m1Text.text === "string" &&
		/^(<session-history-since>|<knowledge-updates>)/.test(m1Text.text)
		? index
		: -1;
}

export function piPreparedHistory(
	messages: readonly unknown[],
	model?: PiChatHistoryModel,
): PiPreparedHistory | undefined {
	const snapshots: LkgInputSnapshot[] = [];
	const responseIds: (string | undefined)[] = [];
	const head = injectedHeadIndex(messages);
	for (const [index, message] of messages.entries()) {
		const source = object(message);
		// Only the injector's two leading synthetic users derive timestamps from
		// the visible head, which a drain can remove. Exclude those placement
		// timestamps only from chain identity, never from the served messages or
		// LKG snapshots; every other field (including m0/m1 text) stays exact.
		const identity =
			head >= 0 && (index === head || index === head + 1)
				? Object.fromEntries(
						Object.entries(source ?? {}).filter(([key]) => key !== "timestamp"),
					)
				: message;
		const fields = lkgContentFields(identity);
		if (!fields) return undefined;
		// Position is the identity here: both arrays are prepared output of the
		// same session, and a shifted message must not match its neighbour.
		snapshots.push({ id: "", fields });
		responseIds.push(
			source?.role === "assistant" &&
				typeof source.responseId === "string" &&
				source.responseId.length > 0
				? source.responseId
				: undefined,
		);
	}
	const prepared: PiPreparedHistory = { snapshots, responseIds };
	let index = responseIds.length - 1;
	while (index >= 0 && responseIds[index] === undefined) index--;
	const assistant = object(messages[index]);
	const response = piChainResponse(assistant);
	if (model && assistant && response) {
		const delta = piEncodeChainTail(
			messages.slice(index + 1),
			assistant,
			response.responseItems,
			model,
		);
		if (delta) prepared.continuation = { index, ...response, delta };
	}
	return prepared;
}

/** A Responses body that continues a stored response; undefined for a full request. */
export function piChainedRequest(
	payload: unknown,
): { previousResponseId: string; delta: readonly unknown[] } | undefined {
	const body = object(payload);
	if (!body || body.previous_response_id === undefined) return undefined;
	const id = body.previous_response_id;
	if (
		body.messages !== undefined ||
		!Array.isArray(body.input) ||
		typeof id !== "string" ||
		!id
	)
		throw new Error("invalid chained continuation frame");
	return { previousResponseId: id, delta: body.input };
}

/**
 * The continuation point a finalized assistant message provides, read from Oh
 * My Pi's `assistant_message` event. That event is awaited before the message
 * enters context and before the next provider request (@oh-my-pi/pi-agent-core
 * 18.12.3 src/agent-loop.ts:2309-2310 and 2592-2593; pi-coding-agent sdk.ts:
 * 4561-4575). `responseId` comes from the provider's response.completed event
 * and `providerPayload` holds that response's native output items
 * (openai-codex-responses.ts:2739-2748 and 3272-3275).
 *
 * The event also runs for messages that ended in an error or abort, so only a
 * completed response (`stop` or `toolUse`) counts: errors, aborts and length
 * cut-offs are not continuation points, and neither is a message whose items
 * would replace rather than extend the input (no `dt` flag). A stream aborted
 * through the request signal skips this event entirely (agent-loop.ts:
 * 2225-2236 and 2795-2838), so the request it answered gets no anchor at all.
 */
export function piChainResponse(
	message: unknown,
): { responseId: string; responseItems: readonly unknown[] } | undefined {
	const source = object(message);
	if (source?.role !== "assistant") return undefined;
	if (source.stopReason !== "stop" && source.stopReason !== "toolUse")
		return undefined;
	if (typeof source.responseId !== "string" || !source.responseId)
		return undefined;
	const payload = object(source.providerPayload);
	if (
		payload?.type !== "openaiResponsesHistory" ||
		payload.dt !== true ||
		!Array.isArray(payload.items)
	)
		return undefined;
	return {
		responseId: source.responseId,
		responseItems: structuredClone(payload.items),
	};
}

/**
 * Expand a chained frame into the full request the provider will process, or
 * name why it is not a continuation of this session's managed dispatch.
 * Reasons never include IDs or message text.
 */
export function piExpandChainedRequest(
	payload: Record<string, unknown>,
	chained: { previousResponseId: string; delta: readonly unknown[] },
	anchor: PiChainAnchor | undefined,
	prepared: PiPreparedHistory | undefined,
	pass: { current: object | undefined; resend: boolean },
):
	| { payload: Record<string, unknown>; input: unknown[] }
	| { refusal: string } {
	if (!anchor)
		return {
			refusal:
				"no completed managed response is recorded for this continuation",
		};
	// After a later admitted request the response is stale, except for that
	// request's own pass resending its admitted continuation; the fence's byte
	// identity check then requires the resend to be unchanged.
	if (
		anchor.supersededBy !== undefined &&
		(anchor.supersededBy !== pass.current || !pass.resend)
	)
		return {
			refusal: "the last managed request has no completed response",
		};
	if (chained.previousResponseId !== anchor.responseId)
		return {
			refusal:
				"continuation does not follow the last managed request's response",
		};
	if (!prepared)
		return { refusal: "this pass's prepared history was not recorded" };
	// The provider holds exactly the previous request plus its response, so this
	// pass must have prepared that same history followed by the response itself.
	const carried = anchor.prepared.snapshots.length;
	if (
		exactReusablePrefix(prepared.snapshots, anchor.prepared.snapshots) !==
		carried
	)
		return {
			refusal: "prepared history does not extend the previous managed request",
		};
	if (prepared.responseIds[carried] !== anchor.responseId)
		return {
			refusal:
				"prepared history does not continue from the previous managed response",
		};
	const continuation = prepared.continuation;
	if (
		!continuation ||
		continuation.index !== carried ||
		!isDeepStrictEqual(continuation.responseItems, anchor.responseItems)
	)
		return {
			refusal:
				"prepared response or tail encoding cannot continue the recorded response",
		};
	if (!isDeepStrictEqual(continuation.delta, chained.delta))
		return { refusal: "delta differs from the prepared provider input tail" };
	const input = [...anchor.input, ...anchor.responseItems, ...chained.delta];
	const { previous_response_id: _previous, ...rest } = payload;
	return { payload: { ...rest, input }, input };
}
