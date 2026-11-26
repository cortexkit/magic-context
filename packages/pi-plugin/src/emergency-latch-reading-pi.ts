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
 * This module keeps the provider's own reading (the prompt size the last
 * reply reported, as stored at message_end) and its identity (the session
 * entry of that reply) for the latch, and answers whether the reading on this
 * pass is still that one: the same identity, or the same value. A new reply
 * that reports the same value after we removed content is a reading that does
 * not respond to what we send, which is the case the latch exists for. Only
 * when both differ (or, without an identity, when the value differs) has the
 * provider measured something new.
 *
 * Kept in memory only, like the saved copy of the last request the count is
 * made from. A latch stored by an earlier process has no record here; the
 * reading then counts as new and the planner's own comparison still applies.
 */

import { piMessageAnchorsLiveUsage } from "./pi-pressure";

/** The provider's reading a pass is based on. */
export interface PiProviderReading {
	/** Prompt tokens the last reply reported; 0 when none is stored. */
	tokens: number;
	/** Session entry id of that reply, when the branch shows one. */
	identity?: string;
}

interface LatchedReading extends PiProviderReading {
	/** The latch's stored sample when this was recorded, to detect a newer latch. */
	sample: number;
}

const latchedReadingBySession = new Map<string, LatchedReading>();

/**
 * The newest reply on the branch whose usage Pi anchors its live figure on
 * (see piMessageAnchorsLiveUsage): the entry id identifies the provider
 * reading. Undefined when the branch shows no such reply.
 */
export function piProviderReadingIdentity(
	branchEntries: readonly unknown[] | null | undefined,
): string | undefined {
	if (!branchEntries) return undefined;
	for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
		const entry = branchEntries[index] as
			| { type?: unknown; id?: unknown; message?: unknown }
			| null
			| undefined;
		if (!entry || typeof entry !== "object" || entry.type !== "message")
			continue;
		if (!piMessageAnchorsLiveUsage(entry.message)) continue;
		return typeof entry.id === "string" && entry.id.length > 0
			? entry.id
			: undefined;
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
