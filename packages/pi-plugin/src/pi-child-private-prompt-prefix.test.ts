import { expect, it } from "bun:test";
import { evaluateSmartNotes } from "@magic-context/core/features/magic-context/dreamer/evaluate-smart-notes";
import {
	acquireLeaseWithAcquisition,
	releaseLease,
} from "@magic-context/core/features/magic-context/dreamer/lease";
import { refreshPrimers } from "@magic-context/core/features/magic-context/dreamer/refresh-primers";
import { compileSmartNoteCheck } from "@magic-context/core/features/magic-context/smart-notes/compiler";
import { markSmartNoteCompilationFailure } from "@magic-context/core/features/magic-context/smart-notes/storage";
import { __wakePlaneTest } from "@magic-context/core/features/magic-context/smart-notes/wake-plane";
import { addNote } from "@magic-context/core/features/magic-context/storage-notes";
import {
	createPrimer,
	getActivePrimers,
	insertPrimerCandidates,
} from "@magic-context/core/features/magic-context/storage-primers";
import { reviewUserMemories } from "@magic-context/core/features/magic-context/user-memory/review-user-memories";
import { insertUserMemoryCandidates } from "@magic-context/core/features/magic-context/user-memory/storage-user-memory";
import { _resetKeepSubagentsForTesting } from "@magic-context/core/shared/keep-subagents";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { __test as dreamerTest } from "./dreamer";
import { buildArgs, extractCompletedToolCalls } from "./subagent-runner";
import { createTestDb } from "./test-utils.test";

const sourceText = "@skill://name";
type PromptRequest = { body: { parts: Array<{ text: string }> } };

function captureClient(answer: string, toolParts: unknown[] = []) {
	const requests: PromptRequest[] = [];
	const client = {
		backgroundSessionsAreHidden: true,
		session: {
			create: async () => ({ data: { id: "prefix-child" } }),
			prompt: async (request: PromptRequest) => {
				requests.push(request);
				return {};
			},
			messages: async () => ({
				data: [
					{
						info: { role: "assistant", finish: "stop", time: { created: 1 } },
						parts: [...toolParts, { type: "text", text: answer }],
					},
				],
			}),
			delete: async () => ({}),
		},
	};
	return { client, requests };
}

function expectPiPrefix(requests: PromptRequest[]) {
	expect(requests).toHaveLength(1);
	const userMessage = requests[0]!.body.parts[0]!.text;
	expect(userMessage).toContain(sourceText);
	const args = buildArgs(
		{ agent: "historian", systemPrompt: "fixed guidance", userMessage },
		{
			targetHarness: "pi",
			systemPromptPath: "/fixture/system.txt",
			historianCalibrationEntryPath: null,
		},
	);
	expect(args.at(-1)).toBe(userMessage);
	expect(args.at(-1)?.[0]).not.toBe("@");
}

async function withLease(
	run: (args: {
		db: ReturnType<typeof createTestDb>;
		holderId: string;
		leaseKey: string;
		leaseAcquisition: NonNullable<
			ReturnType<typeof acquireLeaseWithAcquisition>
		>;
	}) => Promise<void>,
) {
	const db = createTestDb();
	const holderId = "prefix-holder";
	const leaseKey = "prefix-lease";
	_resetKeepSubagentsForTesting();
	try {
		const leaseAcquisition = acquireLeaseWithAcquisition(
			db,
			holderId,
			leaseKey,
		);
		if (!leaseAcquisition)
			throw new Error("Could not acquire prompt fixture lease");
		await run({ db, holderId, leaseKey, leaseAcquisition });
	} finally {
		releaseLease(db, holderId, leaseKey);
		closeQuietly(db);
		_resetKeepSubagentsForTesting();
	}
}

it.each([
	"failed",
	"image-only",
] as const)("Pi refresh-primer after a %s read puts fixed text before a leading raw transcript mention", (outcome) =>
	withLease(async (lease) => {
		const project = "/fixture";
		const now = Date.now();
		const [candidateId] = insertPrimerCandidates(lease.db, [
			{
				projectPath: project,
				harness: "pi",
				sessionId: "origin",
				question: "How is the name handled?",
				sourceCompartmentStart: 1,
				sourceCompartmentEnd: 1,
				sourceStartMessageId: "origin-message",
				sourceEndMessageId: "origin-message",
				sourceMessageTime: now,
			},
		]);
		if (candidateId === undefined)
			throw new Error("Candidate fixture was not inserted");
		createPrimer(lease.db, {
			projectPath: project,
			question: "How is the name handled?",
			answer: "The old path.",
			totalSupport: 1,
			lastObservedAt: now,
			sourceCandidateIds: [candidateId],
		});
		const completed = extractCompletedToolCalls([
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "read-1",
						name: "read",
						arguments: { path: "/src/name.png" },
					},
				],
			},
			{
				role: "toolResult",
				toolCallId: "read-1",
				toolName: "read",
				isError: outcome === "failed",
				content:
					outcome === "failed"
						? [{ type: "text", text: "File not found" }]
						: [{ type: "image", data: "eA==", mimeType: "image/png" }],
			},
		]);
		const { client, requests } = captureClient(
			'{"answer":"See /src/name.ts."}',
			dreamerTest.syntheticToolParts(1, completed),
		);
		const result = await refreshPrimers({
			...lease,
			client: client as never,
			projectIdentity: project,
			parentSessionId: undefined,
			sessionDirectory: project,
			deadline: Date.now() + 60_000,
			rawProviderFactory: (sessionId) =>
				sessionId === "origin"
					? {
							readMessages: () => [
								{
									id: "origin-message",
									role: "user",
									ordinal: 1,
									parts: [{ type: "text", text: sourceText }],
								},
							],
						}
					: null,
		});
		expect(getActivePrimers(lease.db, project)[0]?.answer).toBe(
			outcome === "failed" ? "The old path." : "See /src/name.ts.",
		);
		expect(result.refreshed).toBe(outcome === "failed" ? 0 : 1);
		expectPiPrefix(requests);
	}));

it("Pi smart-note compiler puts fixed text before a leading source mention", async () => {
	_resetKeepSubagentsForTesting();
	try {
		const { client, requests } = captureClient(
			JSON.stringify({
				compiled_check: "function check(cap) { return { met: false }; }",
				manifest: { capabilities: [] },
				check_cron: "*/15 * * * *",
			}),
		);
		const result = await compileSmartNoteCheck({
			client: client as never,
			parentSessionId: undefined,
			sessionDirectory: process.cwd(),
			projectIdentity: "git:prefix-fixture",
			note: {
				id: 1,
				content: sourceText,
				surfaceCondition: "the supplied text alone proves the condition",
			},
			capabilityFactory: () => ({
				readFile: async () => null,
				gitHeadSha: async () => null,
				gitTag: async () => null,
				gitLog: async () => [],
				httpGet: async () => ({ status: 200, body: "" }),
			}),
			signal: new AbortController().signal,
			deadline: Date.now() + 30_000,
		});
		expect(result.ok).toBe(true);
		expectPiPrefix(requests);
	} finally {
		_resetKeepSubagentsForTesting();
	}
});

it("Pi smart-note confirmation puts fixed text before a leading source mention", () =>
	withLease(async (lease) => {
		__wakePlaneTest.reset();
		__wakePlaneTest.setCatalogProbe(async () => []);
		try {
			const projectIdentity = "git:prefix-fixture";
			const note = addNote(lease.db, "smart", {
				projectPath: projectIdentity,
				content: sourceText,
				surfaceCondition: "the supplied text alone proves the condition",
			});
			// Exhaust compilation so the evaluator reaches its read-only confirmation prompt.
			for (let i = 0; i < 3; i++)
				markSmartNoteCompilationFailure(
					lease.db,
					note.id,
					Date.now(),
					3,
					"fixture compilation failure",
					false,
				);
			const { client, requests } = captureClient('{"met":false}');
			const result = await evaluateSmartNotes({
				...lease,
				client: client as never,
				projectIdentity,
				parentSessionId: undefined,
				sessionDirectory: process.cwd(),
				deadline: Date.now() + 30_000,
			});
			expect(result.ran).toBe(true);
			expectPiPrefix(requests);
		} finally {
			__wakePlaneTest.reset();
		}
	}));

it("Pi user-memory review puts fixed text before a leading source mention", () =>
	withLease(async (lease) => {
		insertUserMemoryCandidates(lease.db, [
			{ content: sourceText, sessionId: "origin" },
		]);
		const { client, requests } = captureClient("{}");
		await reviewUserMemories({
			...lease,
			client: client as never,
			parentSessionId: undefined,
			sessionDirectory: process.cwd(),
			deadline: Date.now() + 60_000,
			promotionThreshold: 1,
		});
		expectPiPrefix(requests);
	}));
