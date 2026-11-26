/**
 * The provider reading an emergency batch was planned on, kept beside the
 * pressure-episode latch, so a later pass can tell whether the provider has
 * reported anything new since that batch.
 *
 * After an emergency batch the emergency planner sets our count of the last
 * request aside while the reading is still the one the batch was planned on,
 * and infers the fixed part from the usage reading alone: at 95% or more of
 * the context window the latch does not hold, and with the count a reading
 * that no longer responds to what we send would drop each newly arrived
 * result on every pass. The planner compares the figure it
 * is given with the figure the latch stored. On Pi that figure is derived: the
 * larger of the provider's reading and Pi's live figure, which adds Pi's own
 * estimate of the messages after the last reply. That estimate changes on
 * every request while the provider's reading stays put, so the planner's
 * comparison alone sees a new reading on alternate requests.
 *
 * This module reads the provider's own reading from the branch: the newest
 * reply that reports usage (the one Pi anchors its live figure on), its
 * prompt size as the provider reported it, and the session entry of that
 * reply as its identity. The figure message_end stores is not used: after a
 * tool result it stores Pi's live figure, which already includes the
 * estimate. The reading is kept with the latch, and a later pass asks
 * whether its reading is still that one: the same reply, or the same value.
 * A new reply that reports the same value after we removed content is a
 * reading that does not respond to what we send, which is the case the latch
 * exists for. Only when both differ has the provider measured something new.
 * A pass whose branch shows no such reply has no provider reading to compare,
 * and the planner's own comparison decides.
 *
 * Kept in memory only, like the saved copy of the last request the count is
 * made from. A latch stored by an earlier process has no record here; the
 * reading then counts as new and the planner's own comparison still applies.
 */

import {
	extractAssistantUsage,
	piMessageAnchorsLiveUsage,
	piUsageInputTokens,
} from "./pi-pressure";

/** The provider's reading a pass is based on. */
export interface PiProviderReading {
	/** Prompt tokens the reply reported; 0 when its usage has no prompt size. */
	tokens: number;
	/** Session entry id of that reply, when it has one. */
	identity?: string;
}

interface LatchedReading extends PiProviderReading {
	/** The latch's stored sample when this was recorded, to detect a newer latch. */
	sample: number;
}

const latchedReadingBySession = new Map<string, LatchedReading>();

/**
 * The provider reading on the branch: the newest reply whose usage Pi anchors
 * its live figure on (see piMessageAnchorsLiveUsage), with the prompt size it
 * reported and its entry id. Undefined when the branch shows no such reply.
 */
export function piProviderReadingFromBranch(
	branchEntries: readonly unknown[] | null | undefined,
): PiProviderReading | undefined {
	if (!branchEntries) return undefined;
	for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
		const entry = branchEntries[index] as
			| { type?: unknown; id?: unknown; message?: unknown }
			| null
			| undefined;
		if (!entry || typeof entry !== "object" || entry.type !== "message")
			continue;
		if (!piMessageAnchorsLiveUsage(entry.message)) continue;
		return {
			tokens: piUsageInputTokens(extractAssistantUsage(entry.message)) ?? 0,
			...(typeof entry.id === "string" && entry.id.length > 0
				? { identity: entry.id }
				: {}),
		};
	}
	return undefined;
}
/** Record the provider reading beside the latch sample just stored. */
export function recordPiLatchedReading(
	sessionId: string,
	sample: number,
	reading: PiProviderReading | undefined,
): void {
	if (!reading) {
		latchedReadingBySession.delete(sessionId);
		return;
	}
	latchedReadingBySession.set(sessionId, {
		sample: Math.max(0, Math.round(sample)),
		tokens: reading.tokens,
		...(reading.identity ? { identity: reading.identity } : {}),
	});
}

/**
 * Why the provider reading of this pass is still the one the latch's batch
 * was planned on, or undefined when it is not (or the latch has no record).
 * `latchSample` is the latch's stored sample now; 0 means no latch.
 */
export function piReadingRepeatsLatch(
	sessionId: string,
	latchSample: number,
	reading: PiProviderReading | undefined,
): string | undefined {
	if (!(latchSample > 0) || !reading) return undefined;
	const latched = latchedReadingBySession.get(sessionId);
	if (!latched || latched.sample !== Math.round(latchSample)) return undefined;
	if (latched.identity && latched.identity === reading.identity)
		return `the same reply (${latched.identity})`;
	const now = Math.round(reading.tokens);
	if (latched.tokens > 0 && now > 0 && Math.round(latched.tokens) === now)
		return `the same value (${now})`;
	return undefined;
}

export function clearPiLatchedReading(sessionId: string): void {
	latchedReadingBySession.delete(sessionId);
}
