// Pi parity for the ctx_reduce nudge redesign (Channels 1 & 2).
//
// Band/guard math is shared from `@magic-context/core`; Pi's rendered-entry
// classifier is a shape-specific twin because Pi keeps thinking, signatures,
// tool calls, and tool results in different envelopes:
//
//   Channel 1 (in-turn tool-output nudge): OpenCode appends to a tool's
//   `output.output` string in `tool.execute.after`; Pi appends a TextContent
//   block to a `toolResult.content[]` in `pi.on("tool_result")`. Both persist
//   (OpenCode→DB, Pi→JSONL via `appendMessage` on `message_end`) and replay
//   verbatim, so both are "free sticky" with no anchor/CAS/replay machinery.
//
//   Channel 2 (ceiling nudge): OpenCode delivers via the in-process client's
//   `promptAsync` (which joins the in-flight runner on OpenCode >= 1.17.7). Pi
//   queues a hidden custom message through `pi.sendMessage` with
//   `deliverAs: "nextTurn"`. The `channel2_nudge_state` lease is persisted and
//   token-bound, so sibling processes sharing a session database cannot change a
//   lease after another process has claimed it. It carries the intent from the
//   pipeline point that records it to the later `tool_result` or `agent_end`
//   event that delivers it.

import { randomUUID } from "node:crypto";
import {
	casChannel2NudgeClaim,
	casChannel2NudgeState,
	claimChannel2NudgeState,
	getChannel1NudgeState,
	getChannel2NudgeClaim,
	getChannel2NudgeState,
	getLastNudgeUndropped,
	resetLastNudgeCycle,
	setChannel1NudgeState,
	setLastNudgeUndropped,
} from "@magic-context/core/features/magic-context/storage";
import {
	buildChannel1Reminder,
	buildChannel2Reminder,
	CHANNEL1_SENTINEL,
	decideChannel1,
	evaluateChannel2,
	reclaimableToolOutputCount,
	type Channel1State as SharedChannel1State,
	shouldUseStickyChannel1Reminder,
} from "@magic-context/core/hooks/magic-context/ctx-reduce-nudge";
import { sessionLog } from "@magic-context/core/shared/logger";
import type { Database } from "@magic-context/core/shared/sqlite";

import { measurePiToolResultDelta } from "./tail-hygiene-walk-pi";

export type Channel1State = SharedChannel1State;

// Per-session Channel 1 metric baseline. Written at the end of each pipeline
// pass (post-drop), read in the `tool_result` handler. Primary-only: subagents
// never get a baseline, which is how Channel 1 stays off for them (matches
// OpenCode's `channel1StateBySession` gating).
const channel1StateBySession = new Map<string, Channel1State>();

export function setPiChannel1Baseline(
	sessionId: string,
	state: Channel1State,
): void {
	channel1StateBySession.set(sessionId, state);
}

export function getPiChannel1Baseline(
	sessionId: string,
): Channel1State | undefined {
	return channel1StateBySession.get(sessionId);
}

export function clearPiChannel1State(sessionId: string): void {
	channel1StateBySession.delete(sessionId);
}

/** Mark that the agent ran ctx_reduce since the last baseline refresh (suppress self-nag). */
export function markPiChannel1Reduced(sessionId: string, db?: Database): void {
	const state = channel1StateBySession.get(sessionId);
	if (state) {
		state.reducedSinceRefresh = true;
		state.evaluable = false;
		state.generationInvalidated = true;
	}
	if (db) resetLastNudgeCycle(db, sessionId);
}

interface PiTextContent {
	type: "text";
	text: string;
}

function isPiTextContent(c: unknown): c is PiTextContent {
	return (
		c !== null &&
		typeof c === "object" &&
		(c as { type?: unknown }).type === "text" &&
		typeof (c as { text?: unknown }).text === "string"
	);
}

/** Concatenated text of a `toolResult.content[]` (image blocks ignored). */
function toolResultText(content: readonly unknown[]): string {
	let text = "";
	for (const c of content) {
		if (isPiTextContent(c)) text += c.text;
	}
	return text;
}

/**
 * Channel 1 decision for a just-finished tool result. Returns the reminder
 * TextContent block to append (so the caller's `tool_result` handler can return
 * `{ content: [...event.content, block] }`), or null when no nudge should fire.
 * `toolName` of `ctx_reduce` short-circuits to suppression (the agent is
 * actively managing context) — mirrors OpenCode's `tool.execute.after` branch.
 */
export function maybeChannel1ReminderForToolResult(args: {
	db: Database;
	sessionId: string;
	toolName: string;
	content: readonly unknown[];
}): PiTextContent | null {
	const { db, sessionId, toolName } = args;
	const state = channel1StateBySession.get(sessionId);
	if (!state) return null; // primary-only: no baseline ⇒ subagent ⇒ off

	if (toolName === "ctx_reduce") {
		state.reducedSinceRefresh = true;
		state.evaluable = false;
		state.generationInvalidated = true;
		resetLastNudgeCycle(db, sessionId);
		return null;
	}

	const text = toolResultText(args.content);
	// Content-based idempotency (bare `<system-reminder>` opener is the marker).
	if (text.includes(CHANNEL1_SENTINEL)) return null;

	// The result enters the rendered tail on the next context pass. Until then,
	// the recency reserve protects this newest tool output: it increases total
	// tail tokens (T), while reclaimable tokens (U) remain unchanged.
	const deltaTokens = measurePiToolResultDelta(args.content);
	if (deltaTokens === 0) return null;
	state.turnDeltaT += deltaTokens;

	if (state.agentDropsAppliedThisPass) return null;

	const nudgeState = getChannel1NudgeState(db, sessionId);
	const decision = decideChannel1({
		...state,
		lastNudgeUndropped: getLastNudgeUndropped(db, sessionId),
		lastNudgeLevel: nudgeState.level,
		hasRecentReduce: state.reducedSinceRefresh,
	});

	setLastNudgeUndropped(db, sessionId, decision.nextLastNudge);
	if (!decision.fire) {
		setChannel1NudgeState(db, sessionId, {
			level: decision.nextLastNudgeLevel,
			ordinal: decision.nextLastNudgeLevel === "" ? 0 : nudgeState.ordinal,
		});
		return null;
	}

	const sticky = shouldUseStickyChannel1Reminder({
		lastLevel: nudgeState.level,
		lastOrdinal: nudgeState.ordinal,
		level: decision.level,
		currentRealUserTurnCount: state.realUserTurnCount,
	});
	const block = {
		type: "text" as const,
		text: buildChannel1Reminder(
			decision.level,
			decision.undroppedTokens,
			reclaimableToolOutputCount(state.baselineParts),
			state.oldestReclaimableToolTags,
			sticky,
		),
	};
	setChannel1NudgeState(db, sessionId, {
		level: decision.level,
		ordinal: state.realUserTurnCount,
	});
	return block;
}

/**
 * Minimal shape of the Pi API needed to deliver a Channel 2 ceiling nudge.
 * Uses `sendMessage` (custom message) rather than `sendUserMessage` so the nudge
 * can render `display: false` — hidden from the Pi TUI while still reaching the
 * model (Pi converts a `role:"custom"` entry to a model-visible user message via
 * `convertToLlm`). This is the Pi parity for OpenCode marking the same nudge
 * `synthetic: true`: an agent-directed steer should drive the run + reach the
 * model but NOT show up as a literal user turn the user didn't type. Available
 * since published pi-coding-agent 0.74.0 (our floor); MC already uses
 * `sendMessage` for /ctx-status.
 */
interface PiSendMessage {
	sendMessage: (
		message: {
			customType: string;
			content: string;
			display: boolean;
			details?: unknown;
		},
		options?: {
			deliverAs?: "steer" | "followUp" | "nextTurn";
			triggerTurn?: boolean;
		},
	) => void;
}

const CHANNEL2_NUDGE_CUSTOM_TYPE = "magic-context:ceiling-nudge";

/**
 * Deliver a pending Channel 2 ceiling nudge for `sessionId`, if any. Safe to
 * call from both delivery sites; no-ops unless a `pending` intent exists.
 * Delivered as a hidden custom message (`sendMessage` + `display:false`) so it
 * reaches the model but is not presented as a literal user turn.
 *
 * Both delivery sites queue the message with deliverAs "nextTurn". Pi adds it
 * to the next real user turn instead of steering the active turn or starting an
 * autonomous follow-up. This avoids a busy-session race where an external user
 * prompt can be refused while Pi drains the synthetic continuation.
 *
 * Lease: pending → claimed(token) → delivered. A token is issued while claiming,
 * re-checked immediately before send, and required to confirm or revert. This
 * prevents a sibling process from changing a newer claimant's lease. Returns
 * true only when delivery is confirmed.
 */
export function maybeDeliverChannel2Pi(
	pi: PiSendMessage,
	db: Database,
	sessionId: string,
): boolean {
	let state: string;
	try {
		state = getChannel2NudgeState(db, sessionId);
	} catch {
		return false;
	}
	if (state !== "pending") return false;

	// Revalidate from the same U/T baseline shape used when the pipeline armed
	// the intent. Unknown or generation-invalidated measurements hold `pending`;
	// a known false fourth-band predicate cancels it to the re-armable state.
	const baseline = channel1StateBySession.get(sessionId);
	if (!baseline) return false;
	const evaluation = evaluateChannel2(baseline);
	if (!evaluation.evaluable) return false;
	if (!evaluation.shouldTrigger) {
		try {
			casChannel2NudgeState(db, sessionId, "pending", "");
		} catch {
			// If resetting the intent fails, a later evaluation pass retries the
			// reset and re-checks whether the nudge is still needed.
		}
		return false;
	}
	const undropped = evaluation.reclaimableTokens;

	const claimToken = randomUUID();
	if (!claimChannel2NudgeState(db, sessionId, claimToken)) return false;

	try {
		const message = {
			customType: CHANNEL2_NUDGE_CUSTOM_TYPE,
			content: buildChannel2Reminder(
				undropped,
				reclaimableToolOutputCount(baseline.baselineParts),
				baseline.oldestReclaimableToolTags,
			),
			display: false,
			details: { kind: "channel-2-ceiling-nudge" },
		};
		const claim = getChannel2NudgeClaim(db, sessionId);
		if (claim.state !== "claimed" || claim.claimToken !== claimToken) {
			sessionLog(
				sessionId,
				`channel2 ceiling nudge delivery skipped: claim no longer owned before send (state=${claim.state || "empty"})`,
			);
			return false;
		}
		// display:false keeps the synthetic entry out of the Pi TUI while
		// convertToLlm still presents it to the model on the next real user turn.
		pi.sendMessage(message, { deliverAs: "nextTurn" });
	} catch (error) {
		try {
			const restored = casChannel2NudgeClaim(
				db,
				sessionId,
				"pending",
				claimToken,
			);
			if (restored) {
				sessionLog(
					sessionId,
					"channel2 ceiling nudge delivery failed (will retry):",
					error,
				);
			} else {
				sessionLog(
					sessionId,
					"channel2 ceiling nudge delivery failed after its claim was no longer owned; lease state left unchanged:",
					error,
				);
			}
		} catch (revertError) {
			sessionLog(
				sessionId,
				"channel2 ceiling nudge delivery failed; token-bound pending restore was busy so the stale claim will heal later:",
				{ deliveryError: error, revertError },
			);
		}
		return false;
	}

	try {
		const confirmed = casChannel2NudgeClaim(
			db,
			sessionId,
			"delivered",
			claimToken,
		);
		if (confirmed) {
			sessionLog(sessionId, "channel2 ceiling nudge delivered");
			return true;
		}
		const claim = getChannel2NudgeClaim(db, sessionId);
		sessionLog(
			sessionId,
			`channel2 ceiling nudge sent but claim confirmation was not ours (state=${claim.state || "empty"}); leaving existing lease state unchanged`,
		);
		return false;
	} catch (error) {
		// The nudge has already been handed to Pi; never re-arm on a post-send
		// confirm failure, or a transient DB error can duplicate a cycle delivery.
		sessionLog(
			sessionId,
			"channel2 ceiling nudge sent but token-confirm failed; lease state left unchanged:",
			error,
		);
		return false;
	}
}
