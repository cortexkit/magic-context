import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression coverage for the `/ctx-recomp` post-completion signal contract.
 *
 * Pi `/ctx-recomp` runs DETACHED (background) so the single-process REPL stays
 * responsive — parity with OpenCode's `void runManagedRecomp`. Because it runs
 * in the background (not inside the user's turn), the post-publish signals MUST
 * be the DEFERRED variants (`signalPiDeferredHistoryRefresh` /
 * `signalPiDeferredMaterialization`), exactly like the background historian's
 * `onPublished`. The eager variants would force a materialization on whatever
 * transform pass happens to be running — possibly mid-turn — busting the cache.
 * The deferred signals stage the work so the next cache-busting pass at a turn
 * boundary drains it.
 *
 * These signals fire only when the recomp actually published, and they live
 * inside the detached `work()` body (which spawnPiRecompRun owns the try/catch
 * for), not on a failure path.
 */

const PATH = join(import.meta.dir, "ctx-recomp.ts");
const SRC = readFileSync(PATH, "utf8");

const codeOnly = SRC.split("\n")
	.filter((line) => !line.trim().startsWith("//"))
	.join("\n");

describe("/ctx-recomp post-completion signal contract", () => {
	test("runs detached via spawnPiRecompRun (non-blocking REPL)", () => {
		expect(codeOnly).toContain("spawnPiRecompRun(");
	});

	test("uses DEFERRED history-refresh signal (background-safe)", () => {
		expect(codeOnly).toContain("signalPiDeferredHistoryRefresh(sessionId)");
	});

	test("uses DEFERRED materialization signal (background-safe)", () => {
		expect(codeOnly).toContain("signalPiDeferredMaterialization(sessionId)");
	});

	test("does NOT use the eager signals (would materialize mid-turn from background)", () => {
		expect(codeOnly).not.toContain("signalPiHistoryRefresh(sessionId)");
		expect(codeOnly).not.toContain("signalPiPendingMaterialization(sessionId)");
	});

	test("signals fire only inside the published branch, not unconditionally", () => {
		const publishedGate = codeOnly.indexOf("if (result.published)");
		const deferredSignal = codeOnly.indexOf(
			"signalPiDeferredMaterialization(sessionId)",
		);
		expect(publishedGate).toBeGreaterThan(-1);
		expect(deferredSignal).toBeGreaterThan(publishedGate);
	});

	test("stages the marker (deferred) instead of applying it eagerly", () => {
		expect(codeOnly).toContain("stagePiRecompMarker(");
		expect(codeOnly).not.toContain("queueAndApplyPiRecompMarker(");
	});

	test("clears needs_emergency_recovery on a published recomp (parity with OpenCode)", () => {
		// A successful recomp resolves the overflow that may have armed
		// needs_emergency_recovery; without clearing it the flag force-bumps
		// pressure to 95% every later pass even though the session is now small.
		expect(codeOnly).toContain(
			"clearEmergencyRecovery(currentDeps.db, sessionId)",
		);
		// Must be inside the published branch, before the deferred signals.
		const publishedGate = codeOnly.indexOf("if (result.published)");
		const clearCall = codeOnly.indexOf(
			"clearEmergencyRecovery(currentDeps.db, sessionId)",
		);
		expect(clearCall).toBeGreaterThan(publishedGate);
	});

	test("captures session data before detached work and threads its abort signal", () => {
		expect(codeOnly).toContain("const snapshot = readPiSessionSnapshot(ctx)");
		expect(codeOnly).toContain("readMessages: () => snapshot.rawMessages");
		expect(codeOnly).toContain("branchEntries: snapshot.branchEntries");
		expect(codeOnly).toContain("work: async (signal)");
		expect(codeOnly).toContain("signal,");
		expect(codeOnly).not.toContain("readPiSessionMessages(ctx)");
	});
});
