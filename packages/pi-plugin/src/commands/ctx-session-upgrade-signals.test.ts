import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Contract coverage for `/ctx-session-upgrade`'s detached, background-safe
 * execution.
 *
 * The upgrade (multi-pass recomp + memory migration) runs DETACHED via
 * spawnPiRecompRun so the single-process Pi REPL stays responsive — parity with
 * OpenCode's `void runManagedUpgrade`. A previous build awaited the recomp
 * inline in the command handler, which froze ALL input (prompts and even
 * /ctx-status) for the whole upgrade (dogfood 2026-06-01: a 1105-message
 * upgrade locked the REPL across several ~4-min historian passes).
 *
 * Because it runs in the background, the post-publish signals MUST be the
 * DEFERRED variants (staged for the next cache-busting pass at a turn boundary),
 * and the native compaction marker MUST be staged (not applied eagerly, which
 * mutates getBranch immediately and could land mid-turn).
 */

const PATH = join(import.meta.dir, "ctx-session-upgrade.ts");
const SRC = readFileSync(PATH, "utf8");
const codeOnly = SRC.split("\n")
	.filter((line) => !line.trim().startsWith("//"))
	.join("\n");

describe("/ctx-session-upgrade detached execution contract", () => {
	test("runs detached via spawnPiRecompRun (non-blocking REPL)", () => {
		expect(codeOnly).toContain("spawnPiRecompRun(");
	});

	test("uses DEFERRED signals (background-safe), not eager", () => {
		expect(codeOnly).toContain("signalPiDeferredHistoryRefresh(sessionId)");
		expect(codeOnly).toContain("signalPiDeferredMaterialization(sessionId)");
		expect(codeOnly).not.toContain("signalPiHistoryRefresh(sessionId)");
		expect(codeOnly).not.toContain("signalPiPendingMaterialization(sessionId)");
	});

	test("stages the marker (deferred) instead of applying it eagerly", () => {
		expect(codeOnly).toContain("stagePiRecompMarker(");
		expect(codeOnly).not.toContain("queueAndApplyPiRecompMarker(");
	});

	test("guards against double-spawn while a recomp/upgrade is in flight", () => {
		expect(codeOnly).toContain("isPiRecompInFlight(sessionId)");
	});

	test("still gates migration + Complete on a published full recomp", () => {
		// Background execution must not weaken the published/Complete gate that
		// prevents migrating + declaring Complete on a skipped/partial recomp.
		expect(codeOnly).toContain("isRecompComplete(recompResult.message)");
		expect(codeOnly).toContain("!recompResult.published");
	});

	test("captures snapshots and threads cancellation through recomp and migration", () => {
		expect(codeOnly).toContain("readPiSessionSnapshot(ctx)");
		expect(codeOnly).toContain("readMessages: () => snapshot.rawMessages");
		expect(codeOnly).toContain("branchEntries: snapshot.branchEntries");
		expect(codeOnly).toContain("runMigration(signal)");
		expect(codeOnly).toContain("work: async (signal)");
		expect(codeOnly).not.toContain("readPiSessionMessages(ctx)");
	});
});
