import { describe, expect, it, mock } from "bun:test";
import {
	getCompartments,
	getSessionFacts,
} from "@magic-context/core/features/magic-context/compartment-storage";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import { getMemoriesByProject } from "@magic-context/core/features/magic-context/memory/storage-memory";
import {
	getHistorianFailureState,
	getPersistedNoteNudge,
} from "@magic-context/core/features/magic-context/storage";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import type { SubagentRunner } from "@magic-context/core/shared/subagent-runner";
import { runPiHistorian } from "./pi-historian-runner";
import { createTestDb } from "./test-utils.test";

function rawMessages(count = 12) {
	return Array.from({ length: count }, (_, index) => {
		const ordinal = index + 1;
		const isUser = ordinal % 2 === 1;
		return {
			ordinal,
			id: `m${ordinal}`,
			role: isUser ? "user" : "assistant",
			parts: [
				{
					type: "text",
					text: isUser
						? `User request ${ordinal}`
						: `Assistant response ${ordinal}`,
				},
			],
		};
	});
}

function successXml(fact = "Pi historian facts can promote to memory.") {
	return `<compartment start="1" end="2" title="Initial Pi slice">Summarized the first Pi turn.</compartment>\n<WORKFLOW_RULES>\n* ${fact}\n</WORKFLOW_RULES>`;
}

function runnerReturning(outputs: string[]): SubagentRunner {
	const run = mock(async () => {
		const text = outputs.shift() ?? "";
		return { ok: true as const, assistantText: text, durationMs: 1 };
	});
	return { harness: "pi", run } as unknown as SubagentRunner;
}

async function runHistorianWith(args: {
	outputs: string[];
	memoryEnabled?: boolean;
	autoPromote?: boolean;
	twoPass?: boolean;
	onPublished?: () => void;
	appendCompaction?: Parameters<typeof runPiHistorian>[0]["appendCompaction"];
	readBranchEntries?: () => unknown[];
}) {
	const db = createTestDb();
	const runner = runnerReturning([...args.outputs]);
	await runPiHistorian({
		db,
		sessionId: "ses-historian",
		directory: process.cwd(),
		provider: { readMessages: () => rawMessages() },
		runner,
		historianModel: "test/model",
		historianChunkTokens: 20_000,
		twoPass: args.twoPass,
		memoryEnabled: args.memoryEnabled,
		autoPromote: args.autoPromote,
		onPublished: args.onPublished,
		appendCompaction: args.appendCompaction,
		readBranchEntries: args.readBranchEntries,
	});
	return { db, runner };
}

describe("runPiHistorian", () => {
	it("runs the Pi subagent, parses output, and publishes compartments and facts", async () => {
		const { db, runner } = await runHistorianWith({ outputs: [successXml()] });
		try {
			expect(runner.run).toHaveBeenCalledTimes(1);
			expect(getCompartments(db, "ses-historian")).toEqual([
				expect.objectContaining({
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					title: "Initial Pi slice",
				}),
			]);
			expect(getSessionFacts(db, "ses-historian")).toEqual([
				expect.objectContaining({
					category: "WORKFLOW_RULES",
					content: "Pi historian facts can promote to memory.",
				}),
			]);
		} finally {
			closeQuietly(db);
		}
	});

	it("records historian failure when first pass and repair output are invalid", async () => {
		const { db, runner } = await runHistorianWith({
			outputs: ["not xml", "still not xml"],
		});
		try {
			expect(runner.run).toHaveBeenCalledTimes(2);
			expect(getCompartments(db, "ses-historian")).toEqual([]);
			expect(getHistorianFailureState(db, "ses-historian").failureCount).toBe(
				1,
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("writes Pi harness attribution on published compartments and facts", async () => {
		const { db } = await runHistorianWith({ outputs: [successXml()] });
		try {
			const compartmentHarness = db
				.prepare("SELECT harness FROM compartments WHERE session_id = ?")
				.get("ses-historian") as { harness: string };
			const factHarness = db
				.prepare("SELECT harness FROM session_facts WHERE session_id = ?")
				.get("ses-historian") as { harness: string };

			expect(compartmentHarness.harness).toBe("pi");
			expect(factHarness.harness).toBe("pi");
		} finally {
			closeQuietly(db);
		}
	});

	it("fires note-nudge trigger and onPublished after successful publication", async () => {
		const onPublished = mock(() => undefined);
		const { db } = await runHistorianWith({
			outputs: [successXml()],
			onPublished,
		});
		try {
			expect(onPublished).toHaveBeenCalledTimes(1);
			expect(getPersistedNoteNudge(db, "ses-historian").triggerPending).toBe(
				true,
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("appends a Pi-native compaction marker after publication", async () => {
		const appendCompaction = mock(() => "compact-1");
		const entries = Array.from({ length: 6 }, (_, index) => ({
			type: "message",
			id: `entry-${index + 1}`,
			message: { role: index % 2 === 0 ? "user" : "assistant" },
		}));
		const { db } = await runHistorianWith({
			outputs: [successXml()],
			appendCompaction,
			readBranchEntries: () => entries,
		});
		try {
			expect(appendCompaction).toHaveBeenCalledTimes(1);
			expect(appendCompaction).toHaveBeenCalledWith(
				expect.stringContaining("Initial Pi slice"),
				"entry-3",
				expect.any(Number),
				expect.objectContaining({
					source: "magic-context",
					lastCompactedOrdinal: 2,
				}),
				true,
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("promotes memories only when memoryEnabled and autoPromote allow it", async () => {
		const projectPath = resolveProjectIdentity(process.cwd());
		const allowed = await runHistorianWith({
			outputs: [successXml("Promote this Pi fact.")],
			memoryEnabled: true,
			autoPromote: true,
		});
		try {
			expect(
				getMemoriesByProject(allowed.db, projectPath).map(
					(memory) => memory.content,
				),
			).toContain("Promote this Pi fact.");
		} finally {
			closeQuietly(allowed.db);
		}

		const blocked = await runHistorianWith({
			outputs: [successXml("Do not promote this fact.")],
			memoryEnabled: false,
			autoPromote: true,
		});
		try {
			expect(getMemoriesByProject(blocked.db, projectPath)).toEqual([]);
		} finally {
			closeQuietly(blocked.db);
		}
	});

	describe("historian.two_pass", () => {
		it("does NOT run an editor pass when twoPass is false (default)", async () => {
			const { db, runner } = await runHistorianWith({
				outputs: [successXml()],
				// twoPass omitted → defaults to undefined/false
			});
			try {
				// One subagent run = first pass only.
				expect(runner.run).toHaveBeenCalledTimes(1);
			} finally {
				closeQuietly(db);
			}
		});

		it("runs the editor pass when twoPass=true and uses editor output", async () => {
			const draftXml = successXml("Draft fact only.");
			const editedXml = successXml("Edited fact replaced the draft.");
			const { db, runner } = await runHistorianWith({
				outputs: [draftXml, editedXml],
				twoPass: true,
			});
			try {
				// Two subagent runs = first pass + editor pass.
				expect(runner.run).toHaveBeenCalledTimes(2);
				// Editor output won — the persisted fact is from the editor.
				expect(getSessionFacts(db, "ses-historian")).toEqual([
					expect.objectContaining({
						content: "Edited fact replaced the draft.",
					}),
				]);
			} finally {
				closeQuietly(db);
			}
		});

		it("falls back to draft when editor output fails validation", async () => {
			const draftXml = successXml("Original draft fact.");
			// Editor returns garbage — validation fails, draft is preserved.
			const { db, runner } = await runHistorianWith({
				outputs: [draftXml, "not valid xml at all"],
				twoPass: true,
			});
			try {
				expect(runner.run).toHaveBeenCalledTimes(2);
				// Draft fact is published despite editor failure (no data loss).
				expect(getSessionFacts(db, "ses-historian")).toEqual([
					expect.objectContaining({ content: "Original draft fact." }),
				]);
				// Compartments still persisted.
				expect(getCompartments(db, "ses-historian")).toEqual([
					expect.objectContaining({ title: "Initial Pi slice" }),
				]);
			} finally {
				closeQuietly(db);
			}
		});

		it("does NOT run editor pass when first-pass + repair both fail", async () => {
			// First-pass and repair both invalid → editor pass should be
			// skipped because there's no draft to refine.
			const { db, runner } = await runHistorianWith({
				outputs: ["not xml", "still not xml"],
				twoPass: true,
			});
			try {
				// Exactly 2 calls: first-pass + repair. NOT 3 (no editor).
				expect(runner.run).toHaveBeenCalledTimes(2);
				expect(getCompartments(db, "ses-historian")).toEqual([]);
			} finally {
				closeQuietly(db);
			}
		});
	});
});
