/**
 * Regression: PEEK-then-drain-on-success pattern for the three
 * runtime signal sets (Oracle audit Round 8 finding #6).
 *
 * Before the fix, Pi eagerly drained the signal at the START of the
 * relevant phase — if the rebuild work threw, the signal was lost and
 * the next pass didn't retry. OpenCode peeks first, then drains AFTER
 * the work succeeds, so a mid-pipeline failure leaves the flag set for
 * retry.
 *
 * These tests are source-pinning rather than runtime mocks because the
 * bug shape is structural — the difference between "delete-before-work"
 * and "delete-after-success" is what matters and that's stable across
 * runtime mocking.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
	clearSystemPromptRefresh,
	consumePendingMaterialization,
	hasPendingMaterialization,
	hasSystemPromptRefresh,
	signalPiHistoryRefresh,
	signalPiPendingMaterialization,
	signalPiSystemPromptRefresh,
} from "./context-handler";
import { createTestDb } from "./test-utils.test";

const CONTEXT_HANDLER_SRC = readFileSync(
	join(import.meta.dir, "context-handler.ts"),
	"utf-8",
);
const INDEX_SRC = readFileSync(join(import.meta.dir, "index.ts"), "utf-8");

function stripComments(src: string): string {
	// Strip both /* ... */ and // ... single-line comments so source-pinning
	// assertions match real code only.
	let out = src.replace(/\/\*[\s\S]*?\*\//g, "");
	out = out.replace(/^\s*\/\/.*$/gm, "");
	out = out.replace(/(?<![:\w])\/\/.*$/gm, "");
	return out;
}

describe("signal helpers: peek vs drain semantics", () => {
	test("hasSystemPromptRefresh is non-draining (idempotent reads)", () => {
		const db = createTestDb();
		try {
			signalPiSystemPromptRefresh("ses-peek-1");
			expect(hasSystemPromptRefresh("ses-peek-1")).toBe(true);
			expect(hasSystemPromptRefresh("ses-peek-1")).toBe(true);
			// drain
			expect(clearSystemPromptRefresh("ses-peek-1")).toBe(true);
			// post-drain peek must be false
			expect(hasSystemPromptRefresh("ses-peek-1")).toBe(false);
		} finally {
			db.close();
		}
	});

	test("clearSystemPromptRefresh returns prior wasSet state and drains", () => {
		const db = createTestDb();
		try {
			expect(clearSystemPromptRefresh("ses-clear-empty")).toBe(false);
			signalPiSystemPromptRefresh("ses-clear-set");
			expect(clearSystemPromptRefresh("ses-clear-set")).toBe(true);
			expect(clearSystemPromptRefresh("ses-clear-set")).toBe(false);
		} finally {
			db.close();
		}
	});

	test("hasPendingMaterialization is non-draining", () => {
		const db = createTestDb();
		try {
			signalPiPendingMaterialization("ses-pm-peek");
			expect(hasPendingMaterialization("ses-pm-peek")).toBe(true);
			expect(hasPendingMaterialization("ses-pm-peek")).toBe(true);
			expect(consumePendingMaterialization("ses-pm-peek")).toBe(true);
			expect(hasPendingMaterialization("ses-pm-peek")).toBe(false);
		} finally {
			db.close();
		}
	});

	test("consumePendingMaterialization drains and is idempotent on empty", () => {
		const db = createTestDb();
		try {
			expect(consumePendingMaterialization("ses-cpm-empty")).toBe(false);
			signalPiPendingMaterialization("ses-cpm-set");
			expect(consumePendingMaterialization("ses-cpm-set")).toBe(true);
			expect(consumePendingMaterialization("ses-cpm-set")).toBe(false);
		} finally {
			db.close();
		}
	});

	test("history refresh signal can be set and re-set after drain", () => {
		const db = createTestDb();
		try {
			signalPiHistoryRefresh("ses-history");
			signalPiHistoryRefresh("ses-history");
			signalPiSystemPromptRefresh("ses-history");
			signalPiPendingMaterialization("ses-history");
			// After clearing pendingMaterialization, the other two stay set.
			expect(consumePendingMaterialization("ses-history")).toBe(true);
			expect(hasSystemPromptRefresh("ses-history")).toBe(true);
		} finally {
			db.close();
		}
	});
});

describe("source contract: peek-then-drain in runPipeline (history)", () => {
	const code = stripComments(CONTEXT_HANDLER_SRC);

	test("runPipeline does NOT eager-delete historyRefreshSessions before work", () => {
		// The eager-delete used to live in the outer pi.on("context") handler
		// (around line 1052) before runPipeline. Confirm it's gone.
		// Find the outer ctx-handler lifecycle area, before runPipeline call.
		const before = code.split("await runPipeline(")[0];
		expect(before).not.toContain("historyRefreshSessions.delete(sessionId)");
	});

	test("history drain happens AFTER injectSessionHistoryIntoPi succeeds", () => {
		// Find the injection block inside runPipeline. The drain must be:
		//  1. Inside the try block (so it only runs on success)
		//  2. After the injectSessionHistoryIntoPi call returns
		//  3. Guarded by isCacheBusting
		const idx = code.indexOf("injectSessionHistoryIntoPi(");
		expect(idx).toBeGreaterThan(0);
		// Look at the next ~600 chars after the injection call
		const segment = code.slice(idx, idx + 1200);
		// The drain must mention historyRefreshSessions.delete and isCacheBusting
		expect(segment).toContain("historyRefreshSessions.delete(args.sessionId)");
		expect(segment).toMatch(/if\s*\(\s*args\.isCacheBusting\s*\)/);
	});
});

describe("source contract: peek-then-drain in runPipeline (pending materialization)", () => {
	const code = stripComments(CONTEXT_HANDLER_SRC);

	test("gate uses hasPendingMaterialization, not consume", () => {
		// The gate must not drain the signal at decision time. The drain
		// happens AFTER applyPendingOperations succeeds.
		// Match across formatter line wraps with a tolerant regex.
		expect(code).toMatch(
			/const\s+hasPendingMaterializeSignal\s*=\s*hasPendingMaterialization\(/,
		);
		// And confirm the variable is NOT directly assigned from the
		// draining helper (regression guard for the pre-fix pattern).
		expect(code).not.toMatch(
			/const\s+hasPendingMaterializeSignal\s*=\s*consumePendingMaterialization\(/,
		);
	});

	test("drain happens AFTER applyPendingOperations succeeds", () => {
		// Find the gate body. After the applyPendingOperations call there
		// must be a conditional consumePendingMaterialization drain
		// guarded by hasPendingMaterializeSignal, all inside the same
		// `if` block (so a throw from applyPendingOperations skips the drain).
		const idx = code.indexOf("applyPendingOperations(");
		expect(idx).toBeGreaterThan(0);
		const segment = code.slice(idx, idx + 800);
		expect(segment).toContain("consumePendingMaterialization(args.sessionId)");
		expect(segment).toMatch(/if\s*\(\s*hasPendingMaterializeSignal\s*\)/);
	});
});

describe("source contract: peek-then-drain in before_agent_start (system prompt)", () => {
	const code = stripComments(INDEX_SRC);

	test("uses hasSystemPromptRefresh peek, not the old draining helper", () => {
		// The old code called consumeSystemPromptRefresh(sessionId) at the
		// start of the handler. After the fix it calls hasSystemPromptRefresh.
		expect(code).toContain("hasSystemPromptRefresh(sessionId)");
		expect(code).not.toContain("consumeSystemPromptRefresh(sessionId)");
	});

	test("clearSystemPromptRefresh fires AFTER processSystemPromptForCache", () => {
		const processIdx = code.indexOf("processSystemPromptForCache(");
		const clearIdx = code.indexOf("clearSystemPromptRefresh(sessionId)");
		expect(processIdx).toBeGreaterThan(0);
		expect(clearIdx).toBeGreaterThan(0);
		expect(clearIdx).toBeGreaterThan(processIdx);
	});

	test("clear is guarded by the captured isCacheBusting boolean", () => {
		// Pattern: `if (isCacheBusting) { clearSystemPromptRefresh(...) }`
		// The clear MUST be conditional on the captured variable, not a
		// re-read of the set, so signals added later in the same pass
		// (e.g. result.hashChanged path) survive to the next prompt.
		const clearIdx = code.indexOf("clearSystemPromptRefresh(sessionId)");
		const window = code.slice(Math.max(0, clearIdx - 200), clearIdx + 100);
		expect(window).toMatch(/if\s*\(\s*isCacheBusting\s*\)/);
	});
});
