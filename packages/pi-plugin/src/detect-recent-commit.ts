/**
 * Pi-side recent-commit detector for note-nudge `commit_detected` trigger.
 *
 * Scans the last few assistant messages for commit-hash mentions paired
 * with commit-related verbs ("commit", "merge", "cherry-pick", "rebas").
 * Mirrors OpenCode's logic in `tag-messages.ts` (the `commitDetected`
 * walk near the COMMIT_LOOKBACK constant), but runs against Pi's
 * `AgentMessage[]` shape since Pi doesn't have OpenCode's MessageLike
 * structure.
 *
 * Used inside runPipeline to fire `onNoteTrigger(db, sessionId,
 * "commit_detected")` when a NEW commit appears (i.e. one the previous
 * pass did not already see). Tracking the last-seen state lives in
 * `commitSeenLastPass` per-session, mirroring OpenCode parity.
 */

// We accept a broad `unknown[]` and inspect each entry defensively.
// Pi's `event.messages` from the `pi.on("context", ...)` hook is the
// canonical input. Avoiding a hard dependency on the internal
// AgentMessage type keeps this helper resilient to Pi-side type
// renames and makes it harness-agnostic.

const COMMIT_LOOKBACK = 5;
const COMMIT_HASH_PATTERN = /\b[0-9a-f]{7,12}\b/;
const COMMIT_VERB_PATTERN = /\b(commit|committed|cherry-pick|merge|rebas)/i;

/**
 * Detect whether the recent assistant messages mention a commit hash
 * in a commit-related context. Returns `true` if any of the last
 * COMMIT_LOOKBACK assistant messages contain a 7-12 char hex string
 * paired with a commit verb in the same text part.
 */
export function detectRecentCommit(messages: unknown[]): boolean {
	let assistantsScanned = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (
			!message ||
			typeof message !== "object" ||
			!("role" in message) ||
			message.role !== "assistant"
		) {
			continue;
		}
		assistantsScanned++;
		if (assistantsScanned > COMMIT_LOOKBACK) break;

		// AgentMessage.content is an array of parts. Walk text parts
		// only — commit hashes cited in tool args/results don't count
		// (they're noisy, e.g. `git log` output dumping every commit).
		if (!("content" in message)) continue;
		const content = (message as { content: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (
				part &&
				typeof part === "object" &&
				"type" in part &&
				part.type === "text" &&
				"text" in part &&
				typeof part.text === "string"
			) {
				const text = part.text;
				if (COMMIT_HASH_PATTERN.test(text) && COMMIT_VERB_PATTERN.test(text)) {
					return true;
				}
			}
		}
	}
	return false;
}
