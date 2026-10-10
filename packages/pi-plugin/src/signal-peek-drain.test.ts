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
	consumeDeferredHistoryRefresh,
	consumeDeferredMaterialization,
	consumePendingMaterialization,
	hasPendingMaterialization,
	hasSystemPromptRefresh,
	signalPiDeferredHistoryRefresh,
	signalPiDeferredMaterialization,
	signalPiHistoryRefresh,
	signalPiPendingMaterialization,
	signalPiSystemPromptRefresh,
	signalPiSystemPromptRefreshForProject,
	trackSessionForProject,
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

	test("deferred signals are independent one-shot drains", () => {
		signalPiDeferredHistoryRefresh("ses-deferred");
		signalPiDeferredMaterialization("ses-deferred");
		expect(consumeDeferredHistoryRefresh("ses-deferred")).toBe(true);
		expect(consumeDeferredHistoryRefresh("ses-deferred")).toBe(false);
		expect(consumeDeferredMaterialization("ses-deferred")).toBe(true);
		expect(consumeDeferredMaterialization("ses-deferred")).toBe(false);
	});

	test("project system-prompt refresh helper signals all tracked sessions", () => {
		trackSessionForProject("/project-a", "ses-a1");
		trackSessionForProject("/project-a", "ses-a2");
		signalPiSystemPromptRefreshForProject("/project-a");
		expect(hasSystemPromptRefresh("ses-a1")).toBe(true);
		expect(hasSystemPromptRefresh("ses-a2")).toBe(true);
		clearSystemPromptRefresh("ses-a1");
		clearSystemPromptRefresh("ses-a2");
	});
});

describe("source contract: peek-then-drain in runPipeline (history)", () => {
	const code = stripComments(CONTEXT_HANDLER_SRC);

	test("runPipeline does NOT eager-delete historyRefreshSessions before work", () => {
		// The outer handler must retain the signal until the pipeline succeeds,
		// whether the pipeline promise is awaited directly or through the pass guard.
		const pipeline =
			/await\s+(?:\b(?:guardAwait|budget\.waitMandatory)\(\s*)?runPipeline\(/.exec(
				code,
			);
		expect(pipeline).not.toBeNull();
		const before = code.slice(0, pipeline?.index);
		expect(before).not.toContain("historyRefreshSessions.delete(sessionId)");
	});

	test("history drain happens AFTER injectM0M1Pi succeeds", () => {
		// Find the injection block inside runPipeline. The drain must be:
		//  1. Inside the try block (so it only runs on success)
		//  2. After the injectM0M1Pi seam returns
		//  3. Guarded by isCacheBusting
		// Anchor on the LAST call site: the wire-injection seam. The pre-fold
		// probe (fold-execution gate) also calls injectM0M1PiForRun earlier in
		// runPipeline, and the drain contract applies to the wire injection only.
		const idx = code.lastIndexOf("injectM0M1PiForRun(");
		expect(idx).toBeGreaterThan(0);
		// Look at the next ~600 chars after the injection call
		const segment = code.slice(idx, idx + 2400);
		// The drain must mention historyRefreshSessions.delete and isCacheBusting
		expect(segment).toContain("historyRefreshSessions.delete(args.sessionId)");
		expect(segment).toMatch(/if\s*\(\s*args\.isCacheBusting\s*\)/);
	});

	test("deferred publication drains only on a bust-opportunity gate", () => {
		// canConsumeDeferredLate must be computed independently from the scheduler
		// decision and force threshold, not derived from shouldRunHeuristics. The
		// old inverted form let raw deferred-set membership authorize its own bust.
		// This must mirror OpenCode's canConsumeDeferredOnThisPass.
		expect(code).not.toMatch(
			/const\s+canConsumeDeferredLate\s*=\s*baseShouldApplyPendingOps\s*\|\|\s*shouldRunHeuristics/,
		);
		expect(code).toMatch(
			/const\s+canConsumeDeferredLate\s*=\s*[\s\S]*?args\.schedulerDecision\s*===\s*"execute"/,
		);
		expect(code).toContain("args.forceMaterialization === true");
		expect(code).toContain(
			"args.contextUsage.percentage >= forceMaterializationPercentage",
		);
		expect(code).toContain("const deferredMaterialize =");
		expect(code).toContain("const deferredHistoryRefresh =");
		expect(code).toContain(
			"deferredMaterializationConsumedThisPass = consumeDeferredMaterialization(",
		);
		expect(code).toContain("consumeDeferredHistoryRefresh(args.sessionId)");
	});

	test("once-per-turn heuristics guard uses latest user turn id", () => {
		expect(code).toContain("lastHeuristicsTurnIdBySession");
		expect(code).toContain("alreadyRanHeuristicsThisTurn");
		expect(code).toContain(
			'args.schedulerDecision === "execute" && !alreadyRanHeuristicsThisTurn',
		);
	});

	test("raw message provider unregister is retained and cleaned", () => {
		expect(code).toContain("rawMessageProviderUnregistersBySession");
		expect(code).toContain(
			"rawMessageProviderUnregistersBySession.set(sessionId, unregisterRaw)",
		);
		expect(code).toContain(
			"rawMessageProviderUnregistersBySession.delete(sessionId)",
		);
	});

	test("model switch reset clears usage, reasoning, failure, limit, and recovery state", () => {
		expect(code).toContain("clearedReasoningThroughTag: 0");
		expect(code).toContain("clearHistorianFailureState(options.db, sessionId)");
		expect(code).toContain(
			"clearPersistedReasoningWatermark(options.db, sessionId)",
		);
		expect(code).toContain("clearDetectedContextLimit(options.db, sessionId)");
		expect(code).toContain("clearEmergencyRecovery(options.db, sessionId)");
		expect(code).toContain(
			"sessionMetaForUsage.clearedReasoningThroughTag = 0",
		);
	});

	test("note nudges are wired after runPipeline", () => {
		// The rolling/sticky reminders were removed in the ctx_reduce nudge
		// redesign (replaced by Channel 1 tool-result append + Channel 2
		// sendUserMessage). Note nudges still run after the pipeline completes.
		const pipelineIdx = code.search(
			/const\s+result\s*=\s*await\s+(?:\b(?:guardAwait|budget\.waitMandatory)\(\s*)?runPipeline\(/,
		);
		const noteIdx = code.indexOf("applyNoteNudges(");
		expect(pipelineIdx).toBeGreaterThan(0);
		expect(noteIdx).toBeGreaterThan(pipelineIdx);
		expect(code).toContain("isCacheBusting || result.executedWorkThisPass");
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
		const catchIndex = code.indexOf("} catch", idx);
		expect(catchIndex).toBeGreaterThan(idx);
		const segment = code.slice(idx, catchIndex);
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

	test("system-prompt injection supports global disable, skip signatures, and existing prompt dedup", () => {
		// Council #4 (project-config bleed on /cd): these decisions use
		// effectiveConfig — the config re-resolved from the CURRENT checkout's
		// cwd on a project switch — not the launch-cwd boot `config`.
		expect(code).toContain(
			"effectiveConfig.system_prompt_injection?.enabled === false",
		);
		expect(code).toContain(
			"effectiveConfig.system_prompt_injection?.skip_signatures",
		);
		expect(code).toContain("existingSystemPrompt: event.systemPrompt");
	});

	test("message_end indexes the ended assistant by deferred id lookup", () => {
		// The lookup itself is exercised in message-end-index-pi.test.ts.
		expect(code).toContain(
			"schedulePiAssistantIndexOnMessageEnd(db, sessionId, event.message",
		);
		expect(code).toContain("readBranch: () => {");
		expect(code).not.toContain(
			"readMessages: () => readPiSessionMessages(ctx)",
		);
	});

	test("runtime project identity resolves from ctx.cwd and tracks prompt path sessions", () => {
		expect(code).toContain("function resolveCurrentProject");
		expect(code).toContain("const projectDir = ctx.cwd");
		expect(code).toContain(
			"trackSessionForProject(currentProject.projectIdentity, sessionId)",
		);
		expect(code).toContain("resolveProject: resolveCurrentProject");
	});

	test("todowrite capture only accepts the built-in tool name", () => {
		expect(code).toContain('b.name !== "todowrite"');
		expect(code).not.toContain("^todo.*write");
	});

	test("project-docs m0 injection uses the flag independent of dreamer.disable", () => {
		expect(code).toContain("injectDocs: cfg.dreamer?.inject_docs !== false");
		expect(code).not.toContain(
			"isDreamerRunnable(config) && (config.dreamer?.inject_docs",
		);
	});

	test("hash-change path remains eager for all three refresh sets", () => {
		const idx = code.indexOf("if (result.hashChanged)");
		expect(idx).toBeGreaterThan(0);
		const segment = code.slice(idx, idx + 500);
		expect(segment).toContain("signalPiHistoryRefresh(sessionId)");
		expect(segment).toContain("signalPiSystemPromptRefresh(sessionId)");
		expect(segment).toContain("signalPiPendingMaterialization(sessionId)");
	});
});
