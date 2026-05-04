import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression coverage for the `/ctx-recomp` post-completion signal contract.
 *
 * The bug: Pi `/ctx-recomp` published rebuilt compartments + queued drops
 * via the shared core, but did NOT signal the post-publish state to
 * the next pipeline pass. OpenCode's `hook.ts:477-480` passes
 * `onInjectionCacheCleared` to `executeContextRecomp` which does both
 * `historyRefresh` + `pendingMaterialization`. Without these, Pi
 * users would see a fresh recomp's drops sit in `pending_ops` until
 * usage crossed 85% force-materialization, and the live `<session-history>`
 * block would render the old compartments until the next natural
 * cache-busting turn.
 *
 * Compressor cooldown is also reset because the freshly rebuilt
 * compartments may legitimately need compression on the next
 * opportunity, but the in-memory cooldown timer would block the
 * compressor from picking them up inside its 10-min window.
 */

const PATH = join(import.meta.dir, "ctx-recomp.ts");
const SRC = readFileSync(PATH, "utf8");

const codeOnly = SRC.split("\n")
	.filter((line) => !line.trim().startsWith("//"))
	.join("\n");

describe("/ctx-recomp post-completion signal contract", () => {
	test("calls signalPiHistoryRefresh after successful recomp", () => {
		expect(codeOnly).toContain("signalPiHistoryRefresh(sessionId)");
	});

	test("calls signalPiPendingMaterialization after successful recomp", () => {
		expect(codeOnly).toContain("signalPiPendingMaterialization(sessionId)");
	});

	test("clears compressor state after successful recomp", () => {
		expect(codeOnly).toContain("clearPiCompressorState(sessionId)");
	});

	test("signal block lives BEFORE the catch — failed recomps don't fire signals", () => {
		// The order matters: we don't want a failed recomp to refresh
		// `<session-history>` cache when nothing actually changed in
		// the compartment store. Verify the signal CALLS (not the
		// imports) appear inside the `try` block and not the catch /
		// finally blocks. Match the call form `signalPi…(sessionId)`
		// so we skip the import line.
		const tryStart = codeOnly.indexOf("try {");
		const catchStart = codeOnly.indexOf("} catch (error)");
		const finallyStart = codeOnly.indexOf("} finally {");
		expect(tryStart).toBeGreaterThan(-1);
		expect(catchStart).toBeGreaterThan(tryStart);
		const signalCallIdx = codeOnly.indexOf(
			"signalPiPendingMaterialization(sessionId)",
		);
		expect(signalCallIdx).toBeGreaterThan(tryStart);
		expect(signalCallIdx).toBeLessThan(catchStart);
		expect(signalCallIdx).toBeLessThan(finallyStart);
	});

	test("imports clearPiCompressorState from pi-compressor-runner", () => {
		expect(SRC).toMatch(/from\s+"\.\.\/pi-compressor-runner"/);
		expect(SRC).toContain("clearPiCompressorState");
	});
});
