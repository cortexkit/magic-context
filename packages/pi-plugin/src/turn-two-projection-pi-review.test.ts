/**
 * Independent review of memory slice S6 (historian turn two), commit dafaede1: Pi
 * projection. Report: .cortexkit/internal-docs/investigations/reports/memory-s6-review.md.
 *
 * Part of the normal suite. The `review probe` passed when the review was written and
 * stays as a permanent regression test: it is evidence that an edit applied by turn two
 * (lane enabled in this test) is held back on Pi's SOFT and defer passes and shown at
 * the next genuine HARD fold, with no mutation-log row.
 */
import { expect, test } from "bun:test";
import type { CheckRequest } from "@magic-context/core/features/magic-context/memory/lifecycle-gates";
import {
	getMemoryById,
	insertMemory,
} from "@magic-context/core/features/magic-context/memory/storage-memory";
import {
	allocateTurnOneSend,
	commitTurnOnePublication,
} from "@magic-context/core/features/magic-context/memory/turn-one-publication";
import { runTurnTwo } from "@magic-context/core/features/magic-context/memory/turn-two";
import { authorizationFixture } from "@magic-context/core/features/magic-context/memory/turn-two-test-fixtures.test";
import { createProjectionFixture } from "@magic-context/core/shared/memory-projection-fixtures.test";
import { injectM0M1Pi, materializeM0Pi } from "./inject-compartments-pi";
import { createTestDb } from "./test-utils.test";

const authorization = authorizationFixture(
	{
		lane: "pi",
		carrier: "pi-historian-rpc",
		provider: "test",
		modelId: "validated-model",
		variant: null,
		temperature: 0,
		thinkingLevel: null,
	},
	"historian system prompt",
);
const PROFILE = authorization.profile;

function textOf(message: unknown): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part: { type?: string; text?: string }) =>
			part.type === "text" && typeof part.text === "string" ? [part.text] : [],
		)
		.join("");
}

test("review probe: an applied turn-two edit is invisible on Pi SOFT and defer passes and appears at the next genuine HARD", async () => {
	const f = createProjectionFixture("s6-review-pi", createTestDb);
	try {
		const [session] = f.sessions;
		const state = (cacheExpired = false) => ({
			sessionId: session,
			projectIdentity: f.projectPath,
			projectDirectory: f.directory,
			injectDocs: false,
			hardSignals: {
				systemHash: "system",
				modelKey: "anthropic/claude",
				cacheExpired,
				lastResponseTime: cacheExpired ? Date.now() + 60_000 : 1,
			},
		});
		const pass = (busting: boolean, cacheExpired = false) => {
			const messages: Parameters<typeof injectM0M1Pi>[2] = [];
			const result = injectM0M1Pi(
				state(cacheExpired),
				f.db,
				messages,
				undefined,
				busting,
			);
			return {
				m0: textOf(messages[0]),
				m1: textOf(messages[1]),
				materialized: result.m0Materialized,
			};
		};
		const memory = insertMemory(f.db, {
			projectPath: f.projectPath,
			category: "CONSTRAINTS",
			content: "Old rule. Keep rule.",
		});
		materializeM0Pi(state(), f.db);
		const before = pass(true);
		expect(before.m0).toContain("Old rule. Keep rule.");
		const send = allocateTurnOneSend(f.db, {
			projectPath: f.projectPath,
			sessionId: session,
			harness: "pi",
			carrier: "test",
			lane: "enabled",
			chunkStart: 1,
			chunkEnd: 50,
		});
		authorization.persist(f.db, send.stageKey);
		f.db.transaction(() =>
			commitTurnOnePublication(f.db, {
				send,
				projectPath: f.projectPath,
				sessionId: session,
				compartments: [
					{
						id: 1,
						startMessage: 1,
						endMessage: 50,
						replyStartMessage: 1,
						replyEndMessage: 50,
					},
				],
				blocks: [
					{
						role: "user",
						startOrdinal: 42,
						endOrdinal: 42,
						parts: ["New rule."],
					},
				],
				candidateFacts: [
					{
						category: "CONSTRAINTS",
						content: "New rule replaces the old one",
						anchor: { compartmentIndex: 1, startOrdinal: 42, endOrdinal: 42 },
					},
				],
				honourAnchors: true,
			}),
		)();
		const logRows = () =>
			(
				f.db.prepare("SELECT COUNT(*) AS n FROM memory_mutation_log").get() as {
					n: number;
				}
			).n;
		const logBefore = logRows();
		const result = await runTurnTwo(f.db, {
			projectPath: f.projectPath,
			publicationId: send.publicationId,
			sessionId: session,
			lane: "enabled",
			carrier: {
				carrier: "stub",
				harness: "pi",
				enforcedJson: true,
				childSessionId: "pi-child",
				async send(prompt) {
					const ids = [...prompt.matchAll(/^## Fact (\d+)/gm)].map((match) =>
						Number(match[1]),
					);
					return {
						text: JSON.stringify({
							result: {
								step: "turn_two",
								decisions: ids.map((id) => ({
									fact_id: id,
									check: "Audit fixture.",
									action: "edit",
									target_id: memory.id,
									revision: 1,
									removed: [],
									replaced: [
										{
											memory_id: memory.id,
											clause: 1,
											block: 42,
											excerpt: "New rule.",
										},
									],
									kept: [{ memory_id: memory.id, clause: 2 }],
									added: [
										{ text: "New rule. ", block: 42, excerpt: "New rule." },
									],
									final_text: "New rule. Keep rule.",
								})),
							},
						}),
						lengthCapped: false,
						profile: PROFILE,
					};
				},
				async check(request: CheckRequest) {
					const passing =
						request.kind === "disproof" || request.kind === "support"
							? "yes"
							: "no";
					return {
						verdicts: (request.kind === "compatibility"
							? request.pairs
							: request.operands
						).map((operand) => ({
							id: operand.id,
							verdict: passing as "yes" | "no",
						})),
						profile: authorization.checkProfile(request.systemHash),
						usage: null,
					};
				},
			},
			memoryEnabled: true,
			autoPromote: true,
			validatedProfiles: authorization.rows,
		});
		expect(result.status).toBe("resolved");
		expect(getMemoryById(f.db, memory.id)?.content).toBe(
			"New rule. Keep rule.",
		);
		expect(logRows()).toBe(logBefore);
		f.gate.blocking = true;
		try {
			for (const busting of [true, false, true, false]) {
				f.gate.allowDashboardPayloads = busting;
				const served = pass(busting);
				expect(served.m0).toBe(before.m0);
				expect(served.m1).toBe(before.m1);
				expect(served.materialized).toBe(false);
			}
		} finally {
			f.gate.blocking = false;
			f.gate.allowDashboardPayloads = false;
		}
		expect(f.gate.blocked).toEqual([]);
		const hard = pass(true, true);
		expect(hard.materialized).toBe(true);
		expect(hard.m0).toContain("New rule. Keep rule.");
		expect(hard.m0).not.toContain("Old rule.");
	} finally {
		f.close();
	}
});
