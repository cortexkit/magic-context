import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression coverage for the "context kept climbing after historian
 * ran" bug.
 *
 * Symptom: user reported usage at 64% climbing to 69%+ even after a
 * successful historian run published new compartments. Drops the
 * historian queued sat in `pending_ops` and never materialized until
 * usage crossed the 85% force-materialization threshold.
 *
 * Root cause: Pi historian + compressor `onPublished` callbacks only
 * called `signalPiHistoryRefresh(sessionId)`, missing the matching
 * `signalPiPendingMaterialization(sessionId)` call. Without that
 * second signal, the next pipeline pass had no reason to materialize
 * pending ops (`runPipeline` gates on
 * `consumePendingMaterialization()`), so the queued drops never ran.
 *
 * OpenCode parity reference: `transform.ts:502-505` signals BOTH sets
 * inside `onInjectionCacheCleared` (the equivalent callback). Comment
 * explicitly enumerates why both are needed.
 *
 * Source-inspection tests (rather than runtime mocks) because the bug
 * is structural — what goes inside the `onPublished` callback — and
 * the contract is short and stable enough to pin via grep.
 */

const HANDLER_PATH = join(import.meta.dir, "context-handler.ts");
const HANDLER_SRC = readFileSync(HANDLER_PATH, "utf8");

function extractOnPublishedBodies(src: string): string[] {
	// Find every `onPublished: () => { ... },` callback in the file.
	// The current implementation has exactly two: one on the historian
	// runner deps and one on the compressor runner deps.
	const bodies: string[] = [];
	let cursor = 0;
	while (true) {
		const start = src.indexOf("onPublished: () => {", cursor);
		if (start === -1) break;
		// Find the matching `},` for this arrow body.
		let depth = 0;
		let i = start;
		while (i < src.length) {
			const ch = src[i];
			if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) {
					bodies.push(src.slice(start, i + 1));
					cursor = i + 1;
					break;
				}
			}
			i++;
		}
		if (i >= src.length) break;
	}
	return bodies;
}

describe("historian + compressor onPublished signals", () => {
	const bodies = extractOnPublishedBodies(HANDLER_SRC);

	test("found exactly two onPublished callbacks (historian + compressor)", () => {
		// If this changes, the rest of the assertions below need
		// re-validation — adding a third runner without signaling both
		// sets would resurrect the bug.
		expect(bodies.length).toBe(2);
	});

	test("every onPublished signals signalPiHistoryRefresh", () => {
		for (const body of bodies) {
			expect(body).toContain("signalPiHistoryRefresh(sessionId)");
		}
	});

	test("every onPublished signals signalPiPendingMaterialization", () => {
		// THE bug: this signal was missing from both callbacks. Without
		// it, drops the runner queued sit until 85% emergency.
		for (const body of bodies) {
			expect(body).toContain("signalPiPendingMaterialization(sessionId)");
		}
	});

	test("every onPublished does NOT signal signalPiSystemPromptRefresh", () => {
		// OpenCode parity: historian/compressor publish doesn't change
		// disk-backed adjuncts (project-docs, user-profile, key-files),
		// so re-reading them would burn IO for nothing. transform.ts:499
		// makes this same intentional choice.
		for (const body of bodies) {
			expect(body).not.toContain("signalPiSystemPromptRefresh");
		}
	});
});
