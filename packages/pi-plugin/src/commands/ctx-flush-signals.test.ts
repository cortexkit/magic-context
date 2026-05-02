import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression coverage for the `/ctx-flush` signal contract.
 *
 * The bug: Pi `/ctx-flush` only signaled `historyRefresh`. OpenCode's
 * `onFlush` (`hook.ts:438-441`) signals all THREE refresh sets — so
 * Pi's `/ctx-flush` couldn't actually force pending-op materialization
 * (the whole point of the command) unless the scheduler was already
 * going to execute, and disk-backed adjuncts (project-docs,
 * user-profile, key-files) wouldn't refresh either.
 *
 * Source-inspection test rather than a runtime mock because the contract
 * is short and stable, and the bug is structural (which signals are
 * called).
 */

const PATH = join(import.meta.dir, "ctx-flush.ts");
const SRC = readFileSync(PATH, "utf8");

// Strip comments so the contract checks look at code only — comments
// legitimately reference signal names to explain WHY they're called.
const codeOnly = SRC.split("\n")
	.filter((line) => !line.trim().startsWith("//"))
	.join("\n");

describe("/ctx-flush signal contract", () => {
	test("calls signalPiHistoryRefresh", () => {
		expect(codeOnly).toContain("signalPiHistoryRefresh(sessionId)");
	});

	test("calls signalPiPendingMaterialization (forces pending-op materialization)", () => {
		expect(codeOnly).toContain("signalPiPendingMaterialization(sessionId)");
	});

	test("calls signalPiSystemPromptRefresh (re-reads disk-backed adjuncts)", () => {
		expect(codeOnly).toContain("signalPiSystemPromptRefresh(sessionId)");
	});

	test("imports all three signal helpers from context-handler", () => {
		expect(SRC).toMatch(
			/from\s+"\.\.\/context-handler"/, // import block target
		);
		expect(SRC).toContain("signalPiHistoryRefresh");
		expect(SRC).toContain("signalPiPendingMaterialization");
		expect(SRC).toContain("signalPiSystemPromptRefresh");
	});
});
