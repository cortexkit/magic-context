/**
 * Standalone wall-time probe: run this script alone, never from the test suite.
 * Four concurrent Bun test files and their host subprocesses compete for CPU,
 * so suite timing cannot measure the index's own maintenance work reliably.
 * The suite asserts actual hashing/rendering/comparison counters instead.
 * Run: MC_SLOW_TESTS=0 BUN_JSC_useOMGJIT=0 bun scripts/benchmark-foreign-evidence.ts
 */
import assert from "node:assert/strict";
import { piCheckPreparedDispatch } from "../src/pi-dispatch-acceptance";
import {
	createPiForeignSessionIndex,
	piForeignEvidence,
	piForeignEvidenceStats,
	piMaterializeForeignEvidence,
	piProtectPreparedRows,
} from "../src/pi-dispatch-foreign";
import { piPreparedStructure } from "../src/pi-dispatch-structure";
import { piForeignPreparedTags } from "../src/pi-foreign-session-index";

const model = { api: "anthropic-messages", provider: "test", id: "test" };
const rows = Number(process.argv[2] ?? 9000);
const words = Number(process.argv[3] ?? 700);
assert(Number.isSafeInteger(rows) && rows > 0 && rows <= 9000);
assert(Number.isSafeInteger(words) && words > 0 && words <= 1000);
function measure() {
	const input = Array.from({ length: rows }, (_, index) => ({
		role: "user",
		timestamp: index,
		content: `${index}: ${"body ".repeat(words)}`,
	}));
	const output = input.map((message, index) => ({
		...message,
		content: `§${index + 1}§ ${message.content}`,
	}));
	const entries = input.map((message, index) => ({
		type: "message",
		id: `entry-${index}`,
		message,
	}));
	let reads = 0,
		checks = 0;
	const check = (condition: unknown, message: string) => {
		checks++;
		assert(condition, message);
	};
	const source = {
		getEntries: () => {
			reads++;
			return [...entries];
		},
	};
	const index = createPiForeignSessionIndex();
	const structure = piPreparedStructure(output, model);
	const evidence = piForeignEvidence(source, input, index);
	piProtectPreparedRows(evidence, output, structure);
	check(
		piForeignEvidenceStats(evidence).hashes === 0,
		"context preparation hashed payloads",
	);
	check(
		piCheckPreparedDispatch(
			{ system: "system", messages: output },
			structure,
			evidence,
		).mismatch === undefined,
		"matching dispatch refused",
	);
	check(reads === 0, "matching dispatch read the whole session");
	check(
		piForeignEvidenceStats(evidence).hashes === 0 &&
			piForeignEvidenceStats(evidence).wireHashes === 0,
		"matching dispatch hashed history or candidate text",
	);
	const coldStart = performance.now();
	check(piMaterializeForeignEvidence(evidence), "cold evidence unreadable");
	piForeignPreparedTags(evidence);
	const coldMs = performance.now() - coldStart;
	const hashes = piForeignEvidenceStats(evidence).hashes;
	const renders = piForeignEvidenceStats(evidence).renders;
	check(
		hashes >= input.length,
		"cold evidence did not exercise actual hashing",
	);
	const samples: number[] = [];
	for (let pass = 0; pass < 12; pass++) {
		const next = piForeignEvidence(source, input, index);
		piProtectPreparedRows(next, output, structure);
		const start = performance.now();
		const usable = piMaterializeForeignEvidence(next);
		piForeignPreparedTags(next);
		samples.push(performance.now() - start);
		check(usable, "warm evidence unreadable");
		check(
			piForeignEvidenceStats(next).hashes === hashes &&
				piForeignEvidenceStats(next).renders === renders,
			"warm evidence rehashed or re-rendered history",
		);
	}
	const full: number[] = [],
		base: number[] = [];
	const bootstrap = "foreign bootstrap ".repeat(250);
	const wire = {
		system: "system",
		messages: [{ role: "user", content: bootstrap }, ...output],
	};
	for (let pass = 0; pass < 6; pass++) {
		const next = piForeignEvidence(source, input, index);
		piProtectPreparedRows(next, output, structure);
		const before = performance.now();
		check(
			piCheckPreparedDispatch(
				{ system: "system", messages: output },
				structure,
				next,
			).mismatch === undefined,
			"warm matching dispatch refused",
		);
		base.push(performance.now() - before);
		const start = performance.now();
		check(
			piCheckPreparedDispatch(wire, structure, next).mismatch === undefined,
			"warm foreign dispatch refused",
		);
		full.push(performance.now() - start);
		check(
			piForeignEvidenceStats(next).hashes === hashes &&
				piForeignEvidenceStats(next).renders === renders &&
				piForeignEvidenceStats(next).wireHashes === pass + 1,
			"warm dispatch rehashed history or hashed its bounded candidate more than once",
		);
	}
	const median = (values: number[]) =>
		values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
	const warmEvidenceMedianMs = median(samples);
	return {
		bun: Bun.version,
		messages: input.length,
		chars: input.reduce((sum, row) => sum + row.content.length, 0),
		coldEvidenceMs: coldMs,
		warmEvidenceMedianMs,
		fullDispatchMedianMs: median(full),
		matchingDispatchMedianMs: median(base),
		warmHashes: 0,
		warmEntryRenders: piForeignEvidenceStats(evidence).renders - renders,
		wireCandidateHashes: piForeignEvidenceStats(evidence).wireHashes,
		foreignChars: bootstrap.length,
		matchingHashes: 0,
		matchingEntryReads: 0,
		checksBeforeTimingAssertion: checks,
		timingLimitMs: 5,
	};
}

// A fresh virtual machine and JavaScriptCore process slow cold setup and the
// unchanged comparator.
// Discard one complete sequence before measuring either index or dispatch work.
measure();
const measurement = measure();
console.log(
	JSON.stringify({
		...measurement,
		discardedWarmupSequences: 1,
		evidenceVsMatchingRatio:
			measurement.warmEvidenceMedianMs / measurement.matchingDispatchMedianMs,
	}),
);
// Keep measurements visible even when scheduling or a regression trips the budget.
assert(
	measurement.warmEvidenceMedianMs < 5,
	"warm session-evidence maintenance exceeded 5 ms; run this probe alone",
);
