import { describe, expect, it, mock } from "bun:test";
import {
	appendCompartments,
	getCompartments,
} from "@magic-context/core/features/magic-context/compartment-storage";
import {
	getAverageCompressionDepth,
	incrementCompressionDepth,
} from "@magic-context/core/features/magic-context/storage";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import type { SubagentRunner } from "@magic-context/core/shared/subagent-runner";
import {
	runPiCompressionPassIfNeeded,
	selectPiCompressionBand,
} from "./pi-compressor-runner";
import { createTestDb } from "./test-utils.test";

function runnerReturning(text: string): SubagentRunner {
	return {
		harness: "pi",
		run: mock(async () => ({
			ok: true as const,
			assistantText: text,
			durationMs: 1,
		})),
	} as unknown as SubagentRunner;
}

function makeScored(depths: number[]) {
	return depths.map((averageDepth, index) => ({
		index,
		averageDepth,
		tokenEstimate: 10,
		compartment: {
			id: index + 1,
			sessionId: "ses-compressor",
			sequence: index,
			startMessage: index * 2 + 1,
			endMessage: index * 2 + 2,
			startMessageId: `m${index * 2 + 1}`,
			endMessageId: `m${index * 2 + 2}`,
			title: `c${index}`,
			content: `content ${index}`,
			createdAt: 1,
		},
	}));
}

function seedCompartments(
	db: ReturnType<typeof createTestDb>,
	count = 14,
): void {
	appendCompartments(
		db,
		"ses-compressor",
		Array.from({ length: count }, (_, index) => ({
			sequence: index,
			startMessage: index * 2 + 1,
			endMessage: index * 2 + 2,
			startMessageId: `m${index * 2 + 1}`,
			endMessageId: `m${index * 2 + 2}`,
			title: `Compartment ${index}`,
			content: "word ".repeat(120),
		})),
	);
}

describe("selectPiCompressionBand", () => {
	it("prefers the lowest available depth tier before older deeper compartments", () => {
		const selected = selectPiCompressionBand(makeScored([1, 1, 0, 0, 0]), {
			maxPickable: 15,
			maxMergeDepth: 5,
			graceCompartments: 0,
			floorHeadroom: 10,
		});
		expect(selected.map((s) => s.index)).toEqual([2, 3, 4]);
	});

	it("honors the freshness grace tail", () => {
		const selected = selectPiCompressionBand(makeScored([0, 0, 0, 0]), {
			maxPickable: 15,
			maxMergeDepth: 5,
			graceCompartments: 2,
			floorHeadroom: 10,
		});
		expect(selected.map((s) => s.index)).toEqual([0, 1]);
	});

	it("skips tiers already at max depth", () => {
		const selected = selectPiCompressionBand(makeScored([4, 4, 1, 1]), {
			maxPickable: 15,
			maxMergeDepth: 4,
			graceCompartments: 0,
			floorHeadroom: 10,
		});
		expect(selected.map((s) => s.index)).toEqual([2, 3]);
	});
});

describe("runPiCompressionPassIfNeeded", () => {
	it("compresses an eligible band, rewrites compartments, and increments depth", async () => {
		const db = createTestDb();
		try {
			seedCompartments(db, 14);
			const onPublished = mock(() => undefined);
			const runner = runnerReturning(
				`<compartment start="1" end="6" title="Merged A">merged content</compartment>\n<compartment start="7" end="12" title="Merged B">merged content</compartment>`,
			);

			const didCompress = await runPiCompressionPassIfNeeded({
				db,
				sessionId: "ses-compressor",
				directory: process.cwd(),
				runner,
				historianModel: "test/model",
				historyBudgetTokens: 100,
				minCompartmentRatio: 1000,
				graceCompartments: 2,
				maxCompartmentsPerPass: 6,
				onPublished,
			});

			expect(didCompress).toBe(true);
			expect(onPublished).toHaveBeenCalledTimes(1);
			expect(
				getCompartments(db, "ses-compressor")
					.map((c) => c.title)
					.slice(0, 2),
			).toEqual(["Merged A", "Merged B"]);
			expect(getAverageCompressionDepth(db, "ses-compressor", 1, 12)).toBe(1);
		} finally {
			closeQuietly(db);
		}
	});

	it("uses depth-5 title-only collapse without invoking the model", async () => {
		const db = createTestDb();
		try {
			seedCompartments(db, 12);
			incrementCompressionDepth(db, "ses-compressor", 1, 24);
			incrementCompressionDepth(db, "ses-compressor", 1, 24);
			incrementCompressionDepth(db, "ses-compressor", 1, 24);
			incrementCompressionDepth(db, "ses-compressor", 1, 24);
			const runner = runnerReturning("should not be used");

			const didCompress = await runPiCompressionPassIfNeeded({
				db,
				sessionId: "ses-compressor",
				directory: process.cwd(),
				runner,
				historianModel: "test/model",
				historyBudgetTokens: 100,
				graceCompartments: 0,
				maxMergeDepth: 5,
				maxCompartmentsPerPass: 4,
			});

			expect(didCompress).toBe(true);
			expect(runner.run).toHaveBeenCalledTimes(0);
			expect(getCompartments(db, "ses-compressor")[0]?.content).toBe("");
		} finally {
			closeQuietly(db);
		}
	});
});
