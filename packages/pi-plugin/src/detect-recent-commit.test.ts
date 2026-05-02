/**
 * Regression coverage for `detectRecentCommit`.
 *
 * Pin the parity-critical behaviors against OpenCode's commit-detection
 * walk in `tag-messages.ts`:
 *
 *   1. Detects 7-12 char hex paired with a commit verb in same text part
 *   2. Walks at most COMMIT_LOOKBACK (5) recent assistant messages
 *   3. Skips user / toolResult messages
 *   4. Doesn't match commit hashes inside tool args / non-text parts
 *   5. Returns false when no verb-paired hash exists in recent assistants
 */

import { describe, expect, it } from "bun:test";
import { detectRecentCommit } from "./detect-recent-commit";

function assistant(text: string) {
	return { role: "assistant", content: [{ type: "text", text }] };
}

function user(text: string) {
	return { role: "user", content: [{ type: "text", text }] };
}

function toolResult(text: string) {
	return {
		role: "toolResult",
		content: [{ type: "text", text }],
	};
}

describe("detectRecentCommit", () => {
	it("returns true when an assistant message has a hash + verb pair", async () => {
		expect(
			detectRecentCommit([assistant("Committed 4abc123 with the fix")]),
		).toBe(true);
	});

	it("recognizes 'committed' (past tense) as a commit verb", () => {
		expect(
			detectRecentCommit([assistant("I committed 1234abc to master")]),
		).toBe(true);
	});

	it("recognizes 'merge' / 'rebase' / 'cherry-pick' as commit verbs", () => {
		expect(detectRecentCommit([assistant("merged abc1234 into main")])).toBe(
			true,
		);
		expect(
			detectRecentCommit([assistant("rebased onto a1b2c3d cleanly")]),
		).toBe(true);
		expect(
			detectRecentCommit([assistant("cherry-pick of feedb4d landed clean")]),
		).toBe(true);
	});

	it("returns false when text has a hash but no verb", () => {
		expect(
			detectRecentCommit([
				assistant("Just sayin' something about hash 1234567"),
			]),
		).toBe(false);
	});

	it("returns false when text has a verb but no hash", () => {
		expect(
			detectRecentCommit([assistant("I plan to commit later today")]),
		).toBe(false);
	});

	it("ignores user messages even if they mention a commit", () => {
		expect(detectRecentCommit([user("Did you commit abc1234 yet?")])).toBe(
			false,
		);
	});

	it("ignores toolResult messages even if they mention commits", () => {
		expect(detectRecentCommit([toolResult("commit abc1234 by alice")])).toBe(
			false,
		);
	});

	it("scans up to COMMIT_LOOKBACK (5) most-recent assistant messages", () => {
		// Insert 6 assistant messages — only the last 5 are scanned.
		// The OLDEST (index 0) carries the verb+hash pair; it should be
		// outside the lookback window and not detected.
		const messages = [
			assistant("Way back: committed deadbeef"),
			assistant("filler 1"),
			assistant("filler 2"),
			assistant("filler 3"),
			assistant("filler 4"),
			assistant("filler 5"),
		];
		expect(detectRecentCommit(messages)).toBe(false);
	});

	it("matches a hash + verb in any of the last 5 assistant messages", () => {
		// Same setup as above, but the verb+hash pair is within the
		// last 5 — detected.
		const messages = [
			assistant("filler 0"),
			assistant("filler 1"),
			assistant("merged abc1234 successfully"),
			assistant("filler 3"),
			assistant("filler 4"),
			assistant("filler 5"),
		];
		expect(detectRecentCommit(messages)).toBe(true);
	});

	it("returns false on empty input", () => {
		expect(detectRecentCommit([])).toBe(false);
	});

	it("doesn't match commit hashes embedded in toolCall args (no text part)", () => {
		// An assistant message whose only content is a toolCall part —
		// no text — must not match even if the args reference a hash.
		const message = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call-1",
					name: "Bash",
					arguments: { command: "git show abc1234 // committed earlier" },
				},
			],
		};
		expect(detectRecentCommit([message])).toBe(false);
	});

	it("requires hash AND verb in the SAME text part", () => {
		// Hash in one part, verb in another — should NOT match. This
		// matches OpenCode's behavior (per-part scan, not message-wide).
		const message = {
			role: "assistant",
			content: [
				{ type: "text", text: "Talking about commits in general." },
				{ type: "text", text: "Hash is abc1234567." },
			],
		};
		expect(detectRecentCommit([message])).toBe(false);
	});

	it("matches when hash and verb are in the same text part across multi-part assistant", () => {
		const message = {
			role: "assistant",
			content: [
				{ type: "text", text: "Some intro text." },
				{ type: "text", text: "Now committed abc1234 with all the fixes." },
			],
		};
		expect(detectRecentCommit([message])).toBe(true);
	});

	it("rejects too-short hex (< 7 chars)", () => {
		expect(detectRecentCommit([assistant("committed abc12")])).toBe(false);
	});

	it("rejects too-long hex (> 12 chars)", () => {
		expect(
			detectRecentCommit([
				assistant("committed abc1234567890abcdef but unsure"),
			]),
		).toBe(false);
	});

	it("works on a session-shaped messages array (mixed roles)", () => {
		const messages = [
			user("please commit when done"),
			assistant("on it"),
			toolResult("file edited"),
			assistant("Committed abc1234 with the fix; ready for review."),
		];
		expect(detectRecentCommit(messages)).toBe(true);
	});
});
