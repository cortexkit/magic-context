import { expect, it } from "bun:test";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
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
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { createTestDb } from "./test-utils.test";

const projectPath = resolveProjectIdentity(process.cwd());
if (!projectPath)
	throw new Error("Turn-two fixtures require a project identity");

const authorization = authorizationFixture(
	{
		lane: "pi",
		carrier: "pi-historian-rpc",
		provider: "test",
		modelId: "review-model",
		variant: null,
		temperature: null,
		thinkingLevel: null,
	},
	"historian system",
	[],
);

function publication(db: ReturnType<typeof createTestDb>) {
	const send = allocateTurnOneSend(db, {
		projectPath,
		sessionId: "ses-review",
		harness: "pi",
		carrier: "pi-historian-rpc",
		lane: "enabled",
		chunkStart: 1,
		chunkEnd: 2,
	});
	authorization.persist(db, send.stageKey);
	db.transaction(() =>
		commitTurnOnePublication(db, {
			send,
			projectPath,
			sessionId: "ses-review",
			compartments: [
				{
					id: 1,
					startMessage: 1,
					endMessage: 2,
					replyStartMessage: 1,
					replyEndMessage: 2,
				},
			],
			blocks: [
				{ role: "user", startOrdinal: 1, endOrdinal: 1, parts: ["New rule."] },
			],
			candidateFacts: [
				{
					category: "CONSTRAINTS",
					content: "New rule.",
					anchor: { compartmentIndex: 1, startOrdinal: 1, endOrdinal: 1 },
				},
			],
			honourAnchors: true,
		}),
	)();
	return send;
}

// The Pi carrier exercises the shared resolver's drop/log contract without a child process.
for (const action of ["retire", "promote_rule"] as const) {
	it(`witness: Pi turn two drops and logs ${action} without creating a proposal`, async () => {
		const db = createTestDb();
		const send = publication(db);
		const memory = insertMemory(db, {
			projectPath,
			category: "CONSTRAINTS",
			content: "An active rule.",
		});
		const logs: string[] = [];
		try {
			await runTurnTwo(db, {
				projectPath,
				publicationId: send.publicationId,
				sessionId: "ses-review",
				lane: "enabled",
				carrier: {
					harness: "pi",
					carrier: "pi-historian-rpc",
					enforcedJson: true,
					childSessionId: `review-${action}`,
					send: async () => ({
						text: JSON.stringify({
							result: {
								step: "turn_two",
								decisions: [
									{
										fact_id: 1,
										check: "Audit fixture.",
										action,
										target_id: memory.id,
									},
								],
							},
						}),
						lengthCapped: false,
						profile: authorization.profile,
						usage: null,
					}),
					check: async () => {
						throw new Error("Dropped actions must not request a check");
					},
				},
				memoryEnabled: true,
				autoPromote: true,
				validatedProfiles: authorization.rows,
				log: (line) => logs.push(line),
			});
			expect(getMemoryById(db, memory.id)?.status).toBe("active");
			expect(
				db.prepare("SELECT COUNT(*) AS n FROM memory_tool_proposals").get(),
			).toEqual({ n: 0 });
			expect(logs.some((line) => line.includes(action))).toBe(true);
		} finally {
			closeQuietly(db);
		}
	});
}
