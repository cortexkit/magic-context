import { describe, expect, it, mock, spyOn } from "bun:test";
import { acquireCompartmentLease } from "@magic-context/core/features/magic-context/compartment-lease";
import {
	appendCompartments,
	getCompartments,
	getSessionFacts,
} from "@magic-context/core/features/magic-context/compartment-storage";
import { writeHardProjection } from "@magic-context/core/features/magic-context/memory/applied-projection";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	getMemoriesByProject,
	insertMemory,
} from "@magic-context/core/features/magic-context/memory/storage-memory";
import {
	getHistorianFailureState,
	getOverflowState,
	getPendingOps,
	getPendingPiCompactionMarkerState,
	getPersistedNoteNudge,
	insertTag,
	loadProtectedTailMeta,
	recordOverflowDetected,
	reserveProtectedTailDrainTokens,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { getUserMemoryCandidates } from "@magic-context/core/features/magic-context/user-memory/storage-user-memory";
import { producerPromptFailureReason } from "@magic-context/core/hooks/magic-context/producer-window-guard";
import type { ProtectedTailBoundarySnapshot } from "@magic-context/core/hooks/magic-context/protected-tail-boundary";
import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import type { RawMessage } from "@magic-context/core/hooks/magic-context/read-session-raw";
import * as loggerModule from "@magic-context/core/shared/logger";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import type {
	SubagentRunner,
	SubagentRunResult,
} from "@magic-context/core/shared/subagent-runner";
import {
	buildPiCompactionSummary,
	clearPiHistorianAlertState,
	runPiHistorian,
} from "./pi-historian-runner";
import { createTestDb } from "./test-utils.test";

describe("buildPiCompactionSummary", () => {
	const mk = (title: string) => ({ title, startMessage: 1, endMessage: 2 });

	it("joins all titles when at or below the cap", () => {
		const summary = buildPiCompactionSummary(["a", "b", "c", "d", "e"].map(mk));
		expect(summary).toBe("Magic Context compacted: a; b; c; d; e");
		expect(summary).not.toContain("more");
	});

	it("caps the title list and stays bounded for large compartment counts", () => {
		const many = Array.from({ length: 545 }, (_, i) => mk(`segment-${i}`));
		const summary = buildPiCompactionSummary(many);
		// Bounded: only the first 5 titles appear, plus a remainder count.
		expect(summary).toContain("Magic Context compacted 545 segments:");
		expect(summary).toContain(
			"segment-0; segment-1; segment-2; segment-3; segment-4",
		);
		expect(summary).toContain("…and 540 more");
		expect(summary).not.toContain("segment-5;");
		// Length must not scale with compartment count.
		expect(summary.length).toBeLessThan(200);
	});

	it("falls back to message range when titles are empty", () => {
		const summary = buildPiCompactionSummary([
			{ title: "  ", startMessage: 3, endMessage: 9 },
		]);
		expect(summary).toBe("Magic Context compacted messages 3-9.");
	});
});

function rawMessages(count = 12): RawMessage[] {
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

function completedArcMessages(): RawMessage[] {
	return [
		{
			ordinal: 1,
			id: "m1",
			role: "user",
			parts: [{ type: "text", text: "Inspect the failing flow." }],
		},
		{
			ordinal: 2,
			id: "m2",
			role: "assistant",
			parts: [
				{
					type: "tool",
					tool: "read",
					callID: "pi-call",
					state: { input: { path: "src/flow.ts" } },
				},
			],
		},
		{
			ordinal: 3,
			id: "m3",
			role: "user",
			parts: [
				{
					type: "tool",
					tool: "read",
					callID: "pi-call",
					state: { output: "flow contents" },
				},
			],
		},
		{
			ordinal: 4,
			id: "m4",
			role: "assistant",
			parts: [{ type: "text", text: "Applied the fix." }],
		},
		{
			ordinal: 5,
			id: "m5",
			role: "user",
			parts: [{ type: "text", text: "Keep this live tail." }],
		},
	];
}

function successXml(fact = "Pi historian facts can promote to memory.") {
	return `<compartment start="1" end="2" title="Initial Pi slice"><p1>Summarized the first Pi turn.</p1></compartment>\n<PROJECT_RULES>\n* ${fact}\n</PROJECT_RULES>`;
}

function successXmlWithUserObservation(observation: string) {
	return `${successXml()}\n<user_observations>\n* ${observation}\n</user_observations>`;
}

function successXmlWithEvent(fact: string) {
	return `${successXml(fact)}
<events>
<causal_incident at_compartment="1">
<summary>Pi wrapup promotion regression</summary>
<disposition>fixed</disposition>
</causal_incident>
</events>`;
}

function twoCompartmentSuccessXml() {
	return `<compartment start="1" end="2" title="Initial Pi slice"><p1>Summarized the first Pi turn.</p1></compartment>
<compartment start="3" end="4" title="Provisional Pi slice"><p1>Summarized the provisional Pi turn.</p1></compartment>
<PROJECT_RULES>
* Pi mid-loop wrapup facts must promote.
</PROJECT_RULES>`;
}

function makeBoundarySnapshot(
	overrides: Partial<ProtectedTailBoundarySnapshot> = {},
): ProtectedTailBoundarySnapshot {
	return {
		sessionId: "ses-historian",
		mode: "pi-trigger",
		offset: 1,
		offsetMessageId: "m1",
		protectedTailStart: 6,
		protectedTailStartMessageId: "m6",
		eligibleEndOrdinal: 6,
		eligibleEndMessageId: "m5",
		rawMessageCountAtTrigger: 12,
		rawLastMessageIdAtTrigger: "m12",
		N: 1000,
		usagePercentage: 80,
		usageInputTokens: 8000,
		usageSource: "live",
		contextLimit: 10_000,
		executeThresholdPercentage: 65,
		triggerBudget: 1000,
		priorBoundaryOrdinal: 6,
		migrationFloorActive: false,
		providerShapeVersion: "pi-folded-v1",
		cacheNamespace: "test:pi-historian",
		createdAt: 1,
		rawRangeFingerprint: "",
		trueRawEligibleTokens: 1000,
		oversizeAtomicUnit: false,
		boundaryReason: "test",
		...overrides,
	};
}

function runnerReturning(outputs: string[]): SubagentRunner {
	return runnerWithSteps(outputs);
}

function okRun(text: string): SubagentRunResult {
	return { ok: true, assistantText: text, durationMs: 1 };
}

function runnerWithSteps(
	steps: Array<string | SubagentRunResult | Error>,
): SubagentRunner {
	const run = mock(async () => {
		const step = steps.shift() ?? "";
		if (step instanceof Error) throw step;
		if (typeof step === "string") return okRun(step);
		return step;
	});
	return { harness: "pi", run } as unknown as SubagentRunner;
}

function attemptedModels(runner: SubagentRunner): Array<string | undefined> {
	return (
		runner.run as unknown as {
			mock: { calls: Array<[Parameters<SubagentRunner["run"]>[0]]> };
		}
	).mock.calls.map(([options]) => options.model);
}

function attemptedUserMessages(
	runner: SubagentRunner,
): Array<string | undefined> {
	return (
		runner.run as unknown as {
			mock: { calls: Array<[Parameters<SubagentRunner["run"]>[0]]> };
		}
	).mock.calls.map(([options]) => options.userMessage);
}

async function runHistorianWith(args: {
	outputs?: string[];
	runner?: SubagentRunner;
	historianModel?: string;
	fallbackModels?: Parameters<typeof runPiHistorian>[0]["fallbackModels"];
	fallbackModelId?: string;
	thinkingLevel?: string;
	memoryEnabled?: boolean;
	autoPromote?: boolean;
	userMemoriesEnabled?: boolean;
	twoPass?: boolean;
	signal?: AbortSignal;
	retryBackoffMs?: (retryIndex: number) => number;
	notifyIssue?: Parameters<typeof runPiHistorian>[0]["notifyIssue"];
	onPublished?: () => void;
	appendCompaction?: Parameters<typeof runPiHistorian>[0]["appendCompaction"];
	readBranchEntries?: () => unknown[];
	boundarySnapshot?: ProtectedTailBoundarySnapshot;
	refreshBoundarySnapshot?: () => ProtectedTailBoundarySnapshot;
	providerMessages?: RawMessage[];
	forceKeepLastCompartment?: boolean;
	historianChunkTokens?: number;
	historianContextLimit?: number;
	producerContextLimits?: ReadonlyMap<string, number>;
	resolveHostContextLimit?: (model: string) => number | undefined;
	resolveHostOutputLimit?: (model: string) => number | undefined;
	maxOutputTokens?: number;
	beforeRun?: (db: ReturnType<typeof createTestDb>) => void;
	ensureProjectRegistered?: Parameters<
		typeof runPiHistorian
	>[0]["ensureProjectRegistered"];
	memoryLifecycleLane?: Parameters<
		typeof runPiHistorian
	>[0]["memoryLifecycleLane"];
}) {
	const db = createTestDb();
	const runner = args.runner ?? runnerReturning([...(args.outputs ?? [])]);
	const holderId = "test-holder";
	expect(acquireCompartmentLease(db, "ses-historian", holderId)).not.toBeNull();
	args.beforeRun?.(db);
	await runPiHistorian({
		db,
		sessionId: "ses-historian",
		directory: process.cwd(),
		provider: { readMessages: () => args.providerMessages ?? rawMessages() },
		runner,
		historianModel: args.historianModel ?? "test/model",
		fallbackModels: args.fallbackModels,
		fallbackModelId: args.fallbackModelId,
		historianChunkTokens: args.historianChunkTokens ?? 20_000,
		historianContextLimit:
			args.historianContextLimit ??
			(args.resolveHostContextLimit ? undefined : 200_000),
		producerContextLimits:
			args.producerContextLimits ??
			new Map([
				[args.historianModel ?? "test/model", 200_000],
				...(args.fallbackModels ?? []).map(
					(entry) =>
						[typeof entry === "string" ? entry : entry.model, 200_000] as [
							string,
							number,
						],
				),
				...(args.fallbackModelId
					? [[args.fallbackModelId, 200_000] as [string, number]]
					: []),
			]),
		resolveHostContextLimit: args.resolveHostContextLimit,
		resolveHostOutputLimit: args.resolveHostOutputLimit,
		maxOutputTokens: args.maxOutputTokens,
		signal: args.signal,
		retryBackoffMs: args.retryBackoffMs,
		twoPass: args.twoPass,
		thinkingLevel: args.thinkingLevel,
		memoryEnabled: args.memoryEnabled,
		autoPromote: args.autoPromote,
		userMemoriesEnabled: args.userMemoriesEnabled,
		onPublished: args.onPublished,
		appendCompaction: args.appendCompaction,
		readBranchEntries: args.readBranchEntries,
		notifyIssue: args.notifyIssue,
		boundarySnapshot: args.boundarySnapshot,
		refreshBoundarySnapshot: args.refreshBoundarySnapshot,
		compartmentLeaseHolderId: holderId,
		ensureProjectRegistered: args.ensureProjectRegistered,
		forceKeepLastCompartment: args.forceKeepLastCompartment,
		memoryLifecycleLane: args.memoryLifecycleLane,
	});
	return { db, runner };
}

it("summarizes and promotes from the served owner instead of the historian directory", async () => {
	const { db, runner } = await runHistorianWith({
		outputs: [successXml("New served-owner fact.")],
		beforeRun: (db) => {
			updateSessionMeta(db, "ses-historian", {
				cachedM0Bytes: Buffer.from("served prefix"),
				cachedM0ProjectIdentity: "pj-SERVED",
			});
			insertMemory(db, {
				projectPath: "pj-SERVED",
				category: "PROJECT_RULES",
				content: "Served project dedup rule.",
			});
			insertMemory(db, {
				projectPath: resolveProjectIdentity(process.cwd()),
				category: "PROJECT_RULES",
				content: "Pending directory dedup rule.",
			});
		},
	});
	try {
		expect(attemptedUserMessages(runner)[0]).toContain(
			"Served project dedup rule.",
		);
		expect(attemptedUserMessages(runner)[0]).not.toContain(
			"Pending directory dedup rule.",
		);
		expect(
			db
				.prepare("SELECT project_path FROM memories WHERE content = ?")
				.get("New served-owner fact."),
		).toEqual({ project_path: "pj-SERVED" });
	} finally {
		closeQuietly(db);
	}
});

it("keeps independently attributable history indexing for a proven memory-off frame", async () => {
	const registered = mock(async () => {});
	const { db } = await runHistorianWith({
		outputs: [successXml()],
		memoryEnabled: false,
		ensureProjectRegistered: registered,
		beforeRun: (db) => {
			const m0Text =
				"<session-history>Only session history was rendered.</session-history>";
			updateSessionMeta(db, "ses-historian", {
				cachedM0Bytes: Buffer.from(m0Text),
				cachedM0ProjectIdentity: null,
				memoryBlockCount: 0,
			});
			writeHardProjection(db, {
				sessionId: "ses-historian",
				projectPath: undefined,
				m0Text,
				hardMemoryBlock: "",
				fragmentWatermark: 0,
				revisions: new Map(),
				textMemories: [],
				cueMemories: [],
				deltaMemories: [],
			});
		},
	});
	try {
		expect(getCompartments(db, "ses-historian")).toHaveLength(1);
		expect(registered).toHaveBeenCalledTimes(1);
		expect(db.prepare("SELECT COUNT(*) AS n FROM memories").get()).toEqual({
			n: 0,
		});
	} finally {
		closeQuietly(db);
	}
});

it("publishes a summary with an unproven owner without writing memory", async () => {
	let published = 0;
	const { db, runner } = await runHistorianWith({
		outputs: [
			successXmlWithUserObservation("User prefers explicit upload caps."),
		],
		memoryEnabled: true,
		autoPromote: true,
		userMemoriesEnabled: true,
		onPublished: () => {
			published++;
		},
		beforeRun: (db) =>
			updateSessionMeta(db, "ses-historian", {
				cachedM0Bytes: Buffer.from(
					"<session-history>Unattributed upgraded prefix</session-history>",
				),
				cachedM0ProjectIdentity: null,
			}),
	});
	try {
		expect(published).toBe(1);
		expect(getCompartments(db, "ses-historian").map((c) => c.title)).toEqual([
			"Initial Pi slice",
		]);
		expect(attemptedUserMessages(runner)[0]).not.toContain("<project-memory>");
		for (const table of [
			"memories",
			"memory_pending_facts",
			"memory_stage_attempts",
			"primer_candidates",
			"user_memory_candidates",
		]) {
			expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({
				n: 0,
			});
		}
	} finally {
		closeQuietly(db);
	}
});

function latestHistorianFailureReason(
	db: ReturnType<typeof createTestDb>,
): string | null {
	const row = db
		.prepare(
			"SELECT failure_reason FROM historian_runs WHERE session_id = ? ORDER BY id DESC LIMIT 1",
		)
		.get("ses-historian") as { failure_reason: string | null } | undefined;
	return row?.failure_reason ?? null;
}

describe("runPiHistorian", () => {
	it("uses the Pi registry with an empty cache and sends without a window when registry misses", async () => {
		for (const known of [true, false]) {
			const runner = runnerReturning([successXml()]);
			const logSpy = spyOn(loggerModule, "sessionLog").mockImplementation(
				() => {},
			);
			const { db } = await runHistorianWith({
				runner,
				historianModel: `test/uncached-${known}`,
				producerContextLimits: new Map(),
				resolveHostContextLimit: () => (known ? 200_000 : undefined),
			});
			try {
				expect(runner.run).toHaveBeenCalledTimes(1);
				expect(logSpy).toHaveBeenCalledWith(
					"ses-historian",
					known
						? `historian producer window for test/uncached-${known}: 200000 (host registry)`
						: `producer window unknown for test/uncached-${known}: sending unguarded`,
				);
			} finally {
				logSpy.mockRestore();
				closeQuietly(db);
			}
		}
	});

	it("uses the host catalog output ceiling when no cap is configured", async () => {
		const { db, runner } = await runHistorianWith({
			historianContextLimit: 200_000,
			resolveHostContextLimit: () => 64_000,
			resolveHostOutputLimit: () => 1_024,
			outputs: [successXml()],
		});
		try {
			expect(
				getHistorianFailureState(db, "ses-historian").lastError,
			).toBeNull();
			expect(runner.run).toHaveBeenCalledTimes(1);
			expect(runner.run.mock.calls[0]?.[0].maxOutputTokens).toBe(1_024);
		} finally {
			closeQuietly(db);
		}
	});

	it("releases reserved drain tokens when the producer refuses before dispatch", async () => {
		const { db, runner } = await runHistorianWith({
			outputs: [successXml()],
			historianContextLimit: 32_001,
			maxOutputTokens: 30_000,
		});
		try {
			expect(runner.run).not.toHaveBeenCalled();
			// A window that cannot hold even the fixed prompt parts is a failure
			// the next run cannot fix, so it is recorded (and backed off on), but
			// the prompt is sized before any drain budget is reserved.
			expect(getHistorianFailureState(db, "ses-historian").lastError).toContain(
				"producer_prompt_unfit",
			);
			expect(
				loadProtectedTailMeta(db, "ses-historian").protectedTailDrainTokens,
			).toBe(0);
		} finally {
			closeQuietly(db);
		}
	});
	it("does not spawn beyond the producer window and still spawns within the margin", async () => {
		const messages = rawMessages();
		const firstMessage = messages[0];
		if (!firstMessage)
			throw new Error("producer-window fixture requires a source message");
		messages[0] = {
			...firstMessage,
			parts: [{ type: "text", text: "producer source token ".repeat(20_000) }],
		};
		const refusedRunner = runnerReturning([successXml()]);
		const refused = await runHistorianWith({
			runner: refusedRunner,
			providerMessages: messages,
			historianChunkTokens: 100_000,
			historianContextLimit: 32_001,
			maxOutputTokens: 8_000,
		});
		try {
			expect(refusedRunner.run).toHaveBeenCalledTimes(0);
			// An uncalibrated model counts the historian system prompt double, so
			// this window cannot hold it: one recorded failure, no spawn.
			expect(
				getHistorianFailureState(refused.db, "ses-historian").lastError,
			).toContain("producer_prompt_unfit");
		} finally {
			closeQuietly(refused.db);
		}

		const admittedRunner = runnerReturning([successXml()]);
		const admitted = await runHistorianWith({
			runner: admittedRunner,
			providerMessages: messages,
			historianChunkTokens: 100_000,
			historianContextLimit: 1_000_000,
			maxOutputTokens: 32_000,
		});
		try {
			expect(admittedRunner.run).toHaveBeenCalledTimes(1);
		} finally {
			closeQuietly(admitted.db);
		}
	});

	it("clears emergency recovery on protected-tail-only no-op", async () => {
		const db = createTestDb();
		const runner = runnerReturning([successXml()]);
		recordOverflowDetected(db, "ses-historian", 100_000);
		appendCompartments(db, "ses-historian", [
			{
				sequence: 0,
				startMessage: 1,
				endMessage: 12,
				startMessageId: "m1",
				endMessageId: "m12",
				title: "prior",
				content: "already compacted",
			},
		]);
		try {
			await runPiHistorian({
				db,
				sessionId: "ses-historian",
				directory: process.cwd(),
				provider: { readMessages: () => rawMessages() },
				runner,
				historianModel: "test/model",
				historianChunkTokens: 20_000,
			});

			expect(runner.run).not.toHaveBeenCalled();
			expect(getOverflowState(db, "ses-historian").needsEmergencyRecovery).toBe(
				false,
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("records failure when existing stored compartments fail validation", async () => {
		const db = createTestDb();
		const runner = runnerReturning([successXml()]);
		appendCompartments(db, "ses-historian", [
			{
				sequence: 0,
				startMessage: 2,
				endMessage: 3,
				startMessageId: "m2",
				endMessageId: "m3",
				title: "gap",
				content: "invalid because message 1 is missing",
			},
		]);
		try {
			await runPiHistorian({
				db,
				sessionId: "ses-historian",
				directory: process.cwd(),
				provider: { readMessages: () => rawMessages() },
				runner,
				historianModel: "test/model",
				historianChunkTokens: 20_000,
			});

			expect(runner.run).not.toHaveBeenCalled();
			expect(getHistorianFailureState(db, "ses-historian").failureCount).toBe(
				1,
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("logs internal budget state when the protected-tail drain budget is spent", async () => {
		const boundary = makeBoundarySnapshot();
		const usable = Math.round(
			(boundary.contextLimit * boundary.executeThresholdPercentage) / 100,
		);
		const logSpy = spyOn(loggerModule, "sessionLog").mockImplementation(
			() => {},
		);
		const { db, runner } = await runHistorianWith({
			outputs: [successXml()],
			boundarySnapshot: boundary,
			beforeRun: (db) => {
				for (let i = 0; i < 3; i++) {
					const reservation = reserveProtectedTailDrainTokens({
						db,
						sessionId: "ses-historian",
						runId: `pre-${i}`,
						trueRawTokens: 3000,
						usagePercentage: boundary.usagePercentage,
						usable,
						perRunCap: 3000,
						executeThresholdPercentage: boundary.executeThresholdPercentage,
					});
					expect(reservation.ok).toBe(true);
				}
			},
		});
		try {
			expect(runner.run).not.toHaveBeenCalled();
			expect(
				loadProtectedTailMeta(db, "ses-historian").protectedTailDrainTokens,
			).toBe(9000);
			expect(logSpy).toHaveBeenCalledWith(
				"ses-historian",
				"historian skip: internal drain budget spent (9000/9000 tokens; resets in 10m)",
			);
		} finally {
			logSpy.mockRestore();
			closeQuietly(db);
		}
	});

	it("rolls back reserved drain tokens when the Pi chunk is empty", async () => {
		const emptyMessages = rawMessages(4).map((message) => ({
			...message,
			parts: [],
		}));
		const { db, runner } = await runHistorianWith({
			outputs: [successXml()],
			providerMessages: emptyMessages,
			boundarySnapshot: makeBoundarySnapshot({
				protectedTailStart: 5,
				protectedTailStartMessageId: null,
				eligibleEndOrdinal: 5,
				eligibleEndMessageId: "m4",
				rawMessageCountAtTrigger: 4,
				rawLastMessageIdAtTrigger: "m4",
			}),
		});
		try {
			expect(runner.run).not.toHaveBeenCalled();
			expect(
				loadProtectedTailMeta(db, "ses-historian").protectedTailDrainTokens,
			).toBe(0);
		} finally {
			closeQuietly(db);
		}
	});

	it("refreshes a stale protected-tail snapshot and proceeds when the current boundary is runnable", async () => {
		const staleBoundary = makeBoundarySnapshot({
			rawLastMessageIdAtTrigger: "old-m12",
			rawRangeFingerprint: "stale-fingerprint",
		});
		const refreshedBoundary = makeBoundarySnapshot({
			protectedTailStart: 3,
			protectedTailStartMessageId: "m3",
			eligibleEndOrdinal: 3,
			eligibleEndMessageId: "m2",
		});
		const refreshBoundarySnapshot = mock(() => refreshedBoundary);
		const { db, runner } = await runHistorianWith({
			outputs: [successXml()],
			boundarySnapshot: staleBoundary,
			refreshBoundarySnapshot,
		});
		try {
			expect(refreshBoundarySnapshot).toHaveBeenCalledTimes(1);
			expect(runner.run).toHaveBeenCalledTimes(1);
			expect(getCompartments(db, "ses-historian")).toEqual([
				expect.objectContaining({
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					title: "Initial Pi slice",
				}),
			]);
		} finally {
			closeQuietly(db);
		}
	});

	it("keeps the stale-snapshot no-op fallback when the refreshed boundary is not runnable", async () => {
		const staleBoundary = makeBoundarySnapshot({
			rawLastMessageIdAtTrigger: "old-m12",
			rawRangeFingerprint: "stale-fingerprint",
		});
		const refreshBoundarySnapshot = mock(() =>
			makeBoundarySnapshot({
				protectedTailStart: 1,
				protectedTailStartMessageId: "m1",
				eligibleEndOrdinal: 1,
				eligibleEndMessageId: null,
				trueRawEligibleTokens: 0,
			}),
		);
		const { db, runner } = await runHistorianWith({
			outputs: [successXml()],
			boundarySnapshot: staleBoundary,
			refreshBoundarySnapshot,
		});
		try {
			expect(refreshBoundarySnapshot).toHaveBeenCalledTimes(1);
			expect(runner.run).not.toHaveBeenCalled();
			expect(getCompartments(db, "ses-historian")).toEqual([]);
		} finally {
			closeQuietly(db);
		}
	});

	it("stores userObservations as candidates (post-commit) when user memories are enabled", async () => {
		const { db } = await runHistorianWith({
			outputs: [successXmlWithUserObservation("User prefers concise answers.")],
			userMemoriesEnabled: true,
		});
		try {
			expect(getUserMemoryCandidates(db)).toEqual([
				expect.objectContaining({
					content: "User prefers concise answers.",
					sessionId: "ses-historian",
					sourceCompartmentStart: 1,
					sourceCompartmentEnd: 2,
				}),
			]);
		} finally {
			closeQuietly(db);
		}
	});
	it("does NOT store userObservations when user memories are disabled (privacy gate)", async () => {
		const { db } = await runHistorianWith({
			outputs: [successXmlWithUserObservation("User prefers concise answers.")],
			userMemoriesEnabled: false,
		});
		try {
			expect(getUserMemoryCandidates(db)).toEqual([]);
		} finally {
			closeQuietly(db);
		}
	});
	it("Pi publish selects drop candidates and reads raw messages before taking the writer", async () => {
		const scanStates: boolean[] = [];
		const queueStates: boolean[] = [];
		const rawReadStates: boolean[] = [];
		let publishingDb: ReturnType<typeof createTestDb> | undefined;
		let restorePrepare = () => {};
		const { db } = await runHistorianWith({
			outputs: [successXml()],
			memoryEnabled: false,
			get providerMessages() {
				if (!publishingDb) throw new Error("Provider ran before fixture setup");
				rawReadStates.push(publishingDb.inTransaction);
				return rawMessages();
			},
			beforeRun(db) {
				publishingDb = db;
				insertTag(db, "ses-historian", "m1:p0", "message", 10, 1);
				const prepare = db.prepare.bind(db);
				const prepareSpy = spyOn(db, "prepare").mockImplementation((sql) => {
					const statement = prepare(sql);
					if (
						sql.startsWith("SELECT") &&
						sql.includes("FROM tags") &&
						sql.includes("status = 'active'")
					) {
						const all = statement.all.bind(statement);
						spyOn(statement, "all").mockImplementation((...params) => {
							scanStates.push(db.inTransaction);
							return all(...params);
						});
					}
					if (sql.startsWith("INSERT INTO pending_ops")) {
						const run = statement.run.bind(statement);
						spyOn(statement, "run").mockImplementation((...params) => {
							queueStates.push(db.inTransaction);
							return run(...params);
						});
					}
					return statement;
				});
				restorePrepare = () => prepareSpy.mockRestore();
			},
		});
		try {
			expect(getCompartments(db, "ses-historian")).toHaveLength(1);
			expect(getPendingOps(db, "ses-historian").map((op) => op.tagId)).toEqual([
				1,
			]);
			expect(scanStates.length).toBeGreaterThan(0);
			expect(scanStates.every((inTransaction) => !inTransaction)).toBe(true);
			expect(rawReadStates.length).toBeGreaterThan(0);
			expect(rawReadStates.every((inTransaction) => !inTransaction)).toBe(true);
			expect(queueStates).toEqual([true]);
		} finally {
			restorePrepare();
			closeQuietly(db);
		}
	});

	it("runs the Pi subagent and records facts and events that actually publish", async () => {
		const { db, runner } = await runHistorianWith({
			outputs: [
				successXmlWithEvent("Pi historian facts can promote to memory."),
			],
		});
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
			// v2 faithful fact lifecycle: facts are NOT written to session_facts
			// (no REPLACE). They flow to project memory via promotion.
			expect(getSessionFacts(db, "ses-historian")).toEqual([]);
			const projectPath = resolveProjectIdentity(process.cwd());
			expect(
				getMemoriesByProject(db, projectPath).map((m) => m.content),
			).toContain("Pi historian facts can promote to memory.");
			const row = db
				.prepare(
					"SELECT facts_emitted, events_emitted, facts_by_category_json FROM historian_runs WHERE session_id = ? ORDER BY id DESC LIMIT 1",
				)
				.get("ses-historian") as {
				facts_emitted: number;
				events_emitted: number;
				facts_by_category_json: string;
			};
			expect(row.facts_emitted).toBe(1);
			expect(row.events_emitted).toBe(1);
			expect(JSON.parse(row.facts_by_category_json)).toEqual(
				expect.objectContaining({ facts_promoted: 1, events_published: 1 }),
			);
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

	it("passes repair feedback to fallback models after repair validation fails", async () => {
		const { db, runner } = await runHistorianWith({
			outputs: [
				"not xml",
				"still not xml",
				successXml("Pi fallback recovered the history."),
			],
			fallbackModels: ["fallback/model"],
		});
		try {
			expect(attemptedModels(runner)).toEqual([
				"test/model",
				"test/model",
				"fallback/model",
			]);
			const userMessages = attemptedUserMessages(runner);
			expect(userMessages).toHaveLength(3);
			expect(userMessages[1]).toContain("Validation error:");
			expect(userMessages[1]).toContain("Previous invalid XML:\nnot xml");
			expect(userMessages[2]).toBe(userMessages[1]);
			expect(getCompartments(db, "ses-historian")).toHaveLength(1);
		} finally {
			closeQuietly(db);
		}
	});

	it("records the classified Zen refusal instead of generic empty output", async () => {
		const { db } = await runHistorianWith({
			historianModel: "opencode/free",
			runner: runnerWithSteps([
				{
					ok: false,
					reason: "no_assistant",
					error:
						"opencode_zen_free_tier: choose another historian model for Pi (FreeTierError).",
					durationMs: 1,
					meta: { failureClass: "opencode_zen_free_tier" },
				},
			]),
		});
		try {
			expect(latestHistorianFailureReason(db)).toBe("opencode_zen_free_tier");
		} finally {
			closeQuietly(db);
		}
	});

	it("records a classified custom OpenAI-compatible provider error", async () => {
		const customModel = "local-cpa/gpt-5.6-sol";
		const { db } = await runHistorianWith({
			historianModel: customModel,
			runner: runnerWithSteps([
				{
					ok: false,
					reason: "model_failed",
					error:
						"OpenAI API error (404): model not found; private provider details",
					durationMs: 1,
				},
			]),
		});
		try {
			expect(latestHistorianFailureReason(db)).toBe(
				"provider_error:http_404:model_not_found",
			);
			expect(latestHistorianFailureReason(db)).not.toContain(
				"private provider details",
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("records empty_output when a custom OpenAI-compatible provider returns no text", async () => {
		const { db } = await runHistorianWith({
			historianModel: "local-cpa/gpt-5.6-sol",
			runner: runnerReturning([""]),
		});
		try {
			expect(latestHistorianFailureReason(db)).toBe("empty_output");
		} finally {
			closeQuietly(db);
		}
	});

	it("preserves a safe Pi extension-load stderr diagnostic on subprocess exit", async () => {
		const stderrLine =
			"Error: Failed to load extension '/tmp/pi/extensions/workspace.js': TypeError: loadAccounts is not a function";
		const { db } = await runHistorianWith({
			runner: runnerWithSteps([
				{
					ok: false,
					reason: "non_zero_exit",
					error: "pi exited (code=1, signal=null) without emitting agent_end",
					durationMs: 1,
					meta: {
						exitCode: 1,
						stderr: `${stderrLine}\nassistant response text`,
					},
				},
			]),
		});
		try {
			const reason = latestHistorianFailureReason(db);
			expect(reason).toBe(`subprocess_exit:1:${stderrLine}`);
			expect(reason).toContain("loadAccounts is not a function");
			expect(reason).not.toContain("assistant response text");
		} finally {
			closeQuietly(db);
		}
	});

	it("does not retain arbitrary stderr after a Pi subprocess exit", async () => {
		const { db } = await runHistorianWith({
			runner: runnerWithSteps([
				{
					ok: false,
					reason: "non_zero_exit",
					error: "pi exited (code=2, signal=null) without emitting agent_end",
					durationMs: 1,
					meta: { exitCode: 2, stderr: "model output must not be stored" },
				},
			]),
		});
		try {
			expect(latestHistorianFailureReason(db)).toBe("subprocess_exit:2");
		} finally {
			closeQuietly(db);
		}
	});

	const failureClassCases: Array<{
		name: string;
		steps: Array<SubagentRunResult | string>;
		expected: string;
	}> = [
		{
			name: "provider status and class",
			steps: Array.from({ length: 3 }, () => ({
				ok: false as const,
				reason: "model_failed" as const,
				error: "OpenAI API error (429): rate_limit_error private details",
				durationMs: 1,
			})),
			expected: "provider_error:http_429:rate_limit_error",
		},
		{
			name: "timeout",
			steps: Array.from({ length: 3 }, () => ({
				ok: false as const,
				reason: "timeout" as const,
				error: "subagent timed out",
				durationMs: 1,
			})),
			expected: "timeout",
		},
		{
			name: "abort",
			steps: [
				{
					ok: false,
					reason: "abort",
					error: "pi subagent aborted by caller",
					durationMs: 1,
				},
			],
			expected: "aborted",
		},
		{
			name: "parse failure",
			steps: [
				{
					ok: false,
					reason: "parse_failed",
					error: "malformed provider event containing private text",
					durationMs: 1,
				},
			],
			expected: "parse_failed",
		},
		{
			name: "subprocess exit code",
			steps: [
				{
					ok: false,
					reason: "non_zero_exit",
					error: "pi exited (code=7, signal=null) without agent_end",
					durationMs: 1,
				},
			],
			expected: "subprocess_exit:7",
		},
	];

	for (const failureCase of failureClassCases) {
		it(`records a non-empty classified reason for ${failureCase.name}`, async () => {
			const { db } = await runHistorianWith({
				runner: runnerWithSteps(failureCase.steps),
				retryBackoffMs: () => 0,
			});
			try {
				const reason = latestHistorianFailureReason(db);
				expect(reason).toBe(failureCase.expected);
				expect(reason?.length).toBeGreaterThan(0);
				expect(reason?.length).toBeLessThanOrEqual(512);
				expect(reason).not.toContain("private details");
				expect(reason).not.toContain("private text");
			} finally {
				closeQuietly(db);
			}
		});
	}

	for (const host of ["Pi", "OMP"]) {
		it(`${host} reports an exhausted configured historian chain without calling the session model`, async () => {
			clearPiHistorianAlertState("ses-historian");
			const notices: string[] = [];
			const { db, runner } = await runHistorianWith({
				historianModel: `${host.toLowerCase()}/historian`,
				outputs: [
					"",
					"",
					successXml("Session model must not recover history."),
				],
				fallbackModels: ["fallback/model"],
				fallbackModelId: "session/model",
				notifyIssue: (message) => {
					notices.push(message);
				},
			});
			try {
				expect(attemptedModels(runner)).toEqual([
					`${host.toLowerCase()}/historian`,
					"fallback/model",
				]);
				const options = (
					runner.run as unknown as {
						mock: { calls: Array<[Parameters<SubagentRunner["run"]>[0]]> };
					}
				).mock.calls.map(([invocation]) => invocation);
				expect(options.map((invocation) => invocation.accountingTask)).toEqual([
					undefined,
					"fallback",
				]);
				expect(getCompartments(db, "ses-historian")).toEqual([]);
				expect(getHistorianFailureState(db, "ses-historian").failureCount).toBe(
					1,
				);
				expect(notices.join("\n")).toContain(
					"History compression could not finish",
				);
			} finally {
				closeQuietly(db);
			}
		});

		it(`${host} keeps a successful configured historian on its configured chain`, async () => {
			const { db, runner } = await runHistorianWith({
				historianModel: `${host.toLowerCase()}/historian`,
				outputs: ["", successXml("Configured fallback recovered history.")],
				fallbackModels: ["fallback/model"],
				fallbackModelId: "session/model",
			});
			try {
				expect(attemptedModels(runner)).toEqual([
					`${host.toLowerCase()}/historian`,
					"fallback/model",
				]);
				expect(getHistorianFailureState(db, "ses-historian").failureCount).toBe(
					0,
				);
				expect(getCompartments(db, "ses-historian")).toHaveLength(1);
			} finally {
				closeQuietly(db);
			}
		});
	}

	it("uses only each Pi fallback's own thinking level", async () => {
		const { db, runner } = await runHistorianWith({
			outputs: ["", "", successXml("Qualified fallback recovered Pi history.")],
			thinkingLevel: "high",
			fallbackModels: [
				{ model: "qualified/model", qualifier: "low" },
				"bare/model",
			],
		});
		try {
			const options = (
				runner.run as unknown as {
					mock: { calls: Array<[Parameters<SubagentRunner["run"]>[0]]> };
				}
			).mock.calls.map(([options]) => options);
			expect(options.map((option) => option.thinkingLevel)).toEqual([
				"high",
				"low",
				undefined,
			]);
		} finally {
			closeQuietly(db);
		}
	});

	it("does not duplicate the session model when it is already the historian model", async () => {
		const { db, runner } = await runHistorianWith({
			outputs: [""],
			fallbackModelId: "test/model",
		});
		try {
			expect(attemptedModels(runner)).toEqual(["test/model"]);
			expect(getHistorianFailureState(db, "ses-historian").failureCount).toBe(
				1,
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("does not duplicate the session model when it is already a configured fallback", async () => {
		const { db, runner } = await runHistorianWith({
			outputs: ["", ""],
			fallbackModels: ["session/model"],
			fallbackModelId: "session/model",
		});
		try {
			expect(attemptedModels(runner)).toEqual(["test/model", "session/model"]);
			expect(getHistorianFailureState(db, "ses-historian").failureCount).toBe(
				1,
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("retries transient historian prompt failures on the same model before succeeding", async () => {
		const runner = runnerWithSteps([
			new Error("429 rate limit from provider"),
			successXml("Transient retry recovered Pi history."),
		]);
		const { db } = await runHistorianWith({
			runner,
			retryBackoffMs: () => 0,
		});
		try {
			expect(attemptedModels(runner)).toEqual(["test/model", "test/model"]);
			expect(
				(
					runner.run as unknown as {
						mock: { calls: Array<[{ cacheTail?: string }]> };
					}
				).mock.calls.map(([options]) => options.cacheTail),
			).toEqual(["skip", "write"]);
			expect(getCompartments(db, "ses-historian")).toHaveLength(1);
		} finally {
			closeQuietly(db);
		}
	});

	it("advances to fallback immediately for non-transient historian prompt failures", async () => {
		const runner = runnerWithSteps([
			new Error("401 unauthorized"),
			successXml("Fallback model recovered Pi history."),
		]);
		const { db } = await runHistorianWith({
			runner,
			fallbackModels: ["fallback/model"],
			retryBackoffMs: () => 0,
		});
		try {
			expect(attemptedModels(runner)).toEqual(["test/model", "fallback/model"]);
			expect(
				(
					runner.run as unknown as {
						mock: { calls: Array<[{ cacheTail?: string }]> };
					}
				).mock.calls.map(([options]) => options.cacheTail),
			).toEqual(["skip", "skip"]);
			expect(getCompartments(db, "ses-historian")).toHaveLength(1);
		} finally {
			closeQuietly(db);
		}
	});

	it("does not retry a request error just because a token count contains 500", async () => {
		const runner = runnerWithSteps([
			new Error(
				"invalid_request_error: prompt is too long: 250000 tokens > 200000 maximum",
			),
			successXml("Fallback model recovered Pi history."),
		]);
		const { db } = await runHistorianWith({
			runner,
			fallbackModels: ["fallback/model"],
			retryBackoffMs: () => 0,
		});
		try {
			expect(attemptedModels(runner)).toEqual(["test/model", "fallback/model"]);
		} finally {
			closeQuietly(db);
		}
	});

	it("retries a provider outage whose text merely contains the letters auth", async () => {
		const runner = runnerWithSteps([
			new Error("503 upstream author-profile service unavailable"),
			successXml("Transient retry recovered Pi history."),
		]);
		const { db } = await runHistorianWith({
			runner,
			fallbackModels: ["fallback/model"],
			retryBackoffMs: () => 0,
		});
		try {
			expect(attemptedModels(runner)).toEqual(["test/model", "test/model"]);
		} finally {
			closeQuietly(db);
		}
	});

	it("does not retry or advance fallbacks after an abort signal", async () => {
		const controller = new AbortController();
		controller.abort();
		const runner = runnerWithSteps([successXml()]);
		const { db } = await runHistorianWith({
			runner,
			fallbackModels: ["fallback/model"],
			signal: controller.signal,
			retryBackoffMs: () => 0,
		});
		try {
			expect(runner.run).not.toHaveBeenCalled();
			expect(getCompartments(db, "ses-historian")).toEqual([]);
		} finally {
			closeQuietly(db);
		}
	});

	it("notifies failed historian runs once with a stable reference code", async () => {
		clearPiHistorianAlertState("ses-historian");
		const notices: string[] = [];
		const notifyIssue = mock((text: string) => {
			notices.push(text);
		});
		const first = await runHistorianWith({ outputs: [""], notifyIssue });
		try {
			expect(notifyIssue).toHaveBeenCalledTimes(1);
			expect(notices[0]).toContain(
				"History compression could not finish this turn. It will retry automatically. (MC-H01)",
			);
			expect(notices[0]).not.toContain("Historian returned empty output");
		} finally {
			closeQuietly(first.db);
		}

		const second = await runHistorianWith({ outputs: [""], notifyIssue });
		try {
			expect(notifyIssue).toHaveBeenCalledTimes(1);
		} finally {
			closeQuietly(second.db);
			clearPiHistorianAlertState("ses-historian");
		}
	});

	it("writes Pi harness attribution on published compartments", async () => {
		const { db } = await runHistorianWith({ outputs: [successXml()] });
		try {
			const compartmentHarness = db
				.prepare("SELECT harness FROM compartments WHERE session_id = ?")
				.get("ses-historian") as { harness: string };

			expect(compartmentHarness.harness).toBe("pi");
			// v2 faithful facts: no session_facts rows are written anymore;
			// facts are promoted to project memory instead.
			const factRow = db
				.prepare("SELECT harness FROM session_facts WHERE session_id = ?")
				.get("ses-historian");
			expect(factRow).toBeNull();
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

	it("keeps publish succeeded and signaled when post-commit project registration throws", async () => {
		const onPublished = mock(() => undefined);
		const ensureProjectRegistered = mock(async () => {
			throw new Error("embedding provider unavailable");
		});
		const { db } = await runHistorianWith({
			outputs: [successXml("Pi durable fact survives registration outage.")],
			onPublished,
			ensureProjectRegistered,
		});
		try {
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(onPublished).toHaveBeenCalledTimes(1);
			expect(getCompartments(db, "ses-historian")).toHaveLength(1);
			expect(
				loadProtectedTailMeta(db, "ses-historian").priorBoundaryOrdinal,
			).toBe(3);
			const projectPath = resolveProjectIdentity(process.cwd());
			expect(
				getMemoriesByProject(db, projectPath).map((memory) => memory.content),
			).toContain("Pi durable fact survives registration outage.");
			expect(
				db
					.prepare(
						"SELECT status FROM historian_runs WHERE session_id = ? ORDER BY id DESC LIMIT 1",
					)
					.get("ses-historian"),
			).toEqual({ status: "success" });
		} finally {
			closeQuietly(db);
		}
	});

	it("queues a Pi-native compaction marker after publication", async () => {
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
			expect(appendCompaction).not.toHaveBeenCalled();
			expect(getPendingPiCompactionMarkerState(db, "ses-historian")).toEqual(
				expect.objectContaining({
					firstKeptEntryId: "entry-3",
					endMessageId: "m2",
					ordinal: 2,
					tokensBefore: expect.any(Number),
					summary: expect.stringContaining("Initial Pi slice"),
				}),
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("persists and reports a marker that must wait for a future kept entry", async () => {
		const notifyIssue = mock(async () => undefined);
		const entries = Array.from({ length: 2 }, (_, index) => ({
			type: "message",
			id: `entry-${index + 1}`,
			message: { role: index % 2 === 0 ? "user" : "assistant" },
		}));
		const { db } = await runHistorianWith({
			outputs: [successXml()],
			readBranchEntries: () => entries,
			notifyIssue,
		});
		try {
			expect(getPendingPiCompactionMarkerState(db, "ses-historian")).toEqual(
				expect.objectContaining({
					firstKeptEntryId: null,
					endMessageId: "m2",
					ordinal: 2,
				}),
			);
			expect(notifyIssue).toHaveBeenCalledWith(
				expect.stringContaining("waiting for a resolvable kept entry"),
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("does not let Pi discard-last reopen a completed invocation/result arc", async () => {
		const { db } = await runHistorianWith({
			outputs: [twoCompartmentSuccessXml()],
			providerMessages: completedArcMessages(),
			boundarySnapshot: makeBoundarySnapshot({
				protectedTailStart: 5,
				protectedTailStartMessageId: "m5",
				eligibleEndOrdinal: 5,
				eligibleEndMessageId: "m4",
				rawMessageCountAtTrigger: 5,
				rawLastMessageIdAtTrigger: "m5",
			}),
		});
		try {
			expect(
				getCompartments(db, "ses-historian").map(
					(compartment) => compartment.endMessage,
				),
			).toEqual([2, 4]);
		} finally {
			closeQuietly(db);
		}
	});

	it("keeps the provisional final compartment during emergency recovery", async () => {
		const { db } = await runHistorianWith({
			outputs: [twoCompartmentSuccessXml()],
			providerMessages: rawMessages(5),
			boundarySnapshot: makeBoundarySnapshot({
				protectedTailStart: 5,
				protectedTailStartMessageId: "m5",
				eligibleEndOrdinal: 5,
				eligibleEndMessageId: "m4",
				rawMessageCountAtTrigger: 5,
				rawLastMessageIdAtTrigger: "m5",
			}),
			beforeRun: (database) => {
				recordOverflowDetected(database, "ses-historian", 100_000);
			},
		});
		try {
			const compartments = getCompartments(db, "ses-historian");
			expect(compartments.map((compartment) => compartment.endMessage)).toEqual(
				[2, 4],
			);
			expect(compartments.map((compartment) => compartment.title)).toEqual([
				"Initial Pi slice",
				"Provisional Pi slice",
			]);
		} finally {
			closeQuietly(db);
		}
	});

	it("downgrades forced final keep on token-capped chunks so discard-last healing still applies", async () => {
		const projectPath = resolveProjectIdentity(process.cwd());
		const longMessages = rawMessages(10).map((message) => ({
			...message,
			parts: [
				{
					type: "text",
					text: `${message.parts[0]?.text ?? "message"} alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu alpha beta gamma delta`,
				},
			],
		}));
		const midLoop = await runHistorianWith({
			outputs: [twoCompartmentSuccessXml()],
			providerMessages: longMessages,
			boundarySnapshot: makeBoundarySnapshot({
				protectedTailStart: 7,
				protectedTailStartMessageId: "m7",
				eligibleEndOrdinal: 7,
				eligibleEndMessageId: "m6",
			}),
			historianChunkTokens: 100,
			forceKeepLastCompartment: true,
		});
		try {
			// The downgrade proof is the HEALING: an un-downgraded forced keep
			// would persist both compartments. The token-capped chunk instead
			// drops the provisional tail, and discard-last runs skip unanchored
			// promotion by long-standing design (the discarded range re-reads
			// next iteration; reworded facts would double-store).
			expect(getCompartments(midLoop.db, "ses-historian")).toHaveLength(1);
			expect(getCompartments(midLoop.db, "ses-historian")[0]?.endMessage).toBe(
				2,
			);
			expect(getMemoriesByProject(midLoop.db, projectPath)).toEqual([]);
		} finally {
			closeQuietly(midLoop.db);
		}

		const logSpy = spyOn(loggerModule, "sessionLog").mockImplementation(
			() => {},
		);
		const finalChunk = await runHistorianWith({
			outputs: [successXmlWithEvent("Pi final wrapup facts stay deferred.")],
			forceKeepLastCompartment: true,
		});
		try {
			expect(getCompartments(finalChunk.db, "ses-historian")).toHaveLength(1);
			expect(getMemoriesByProject(finalChunk.db, projectPath)).toEqual([]);
			const row = finalChunk.db
				.prepare(
					"SELECT facts_emitted, events_emitted, facts_by_category_json FROM historian_runs WHERE session_id = ? ORDER BY id DESC LIMIT 1",
				)
				.get("ses-historian") as {
				facts_emitted: number;
				events_emitted: number;
				facts_by_category_json: string;
			};
			expect(row.facts_emitted).toBe(1);
			expect(row.events_emitted).toBe(1);
			expect(JSON.parse(row.facts_by_category_json)).toEqual(
				expect.objectContaining({ facts_promoted: 0, events_published: 0 }),
			);
			expect(logSpy).toHaveBeenCalledWith(
				"ses-historian",
				expect.stringContaining(
					"historian unanchored promotion skipped: reason=weak_lookahead_final_compartment",
				),
			);
		} finally {
			logSpy.mockRestore();
			closeQuietly(finalChunk.db);
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
				expect(runner.run).toHaveBeenNthCalledWith(
					2,
					expect.not.objectContaining({ fallbackModels: expect.anything() }),
				);
				// Editor output won — the promoted fact is from the editor.
				const projectPath = resolveProjectIdentity(process.cwd());
				expect(
					getMemoriesByProject(db, projectPath).map((m) => m.content),
				).toContain("Edited fact replaced the draft.");
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
				// Draft fact is promoted despite editor failure (no data loss).
				const projectPath = resolveProjectIdentity(process.cwd());
				expect(
					getMemoriesByProject(db, projectPath).map((m) => m.content),
				).toContain("Original draft fact.");
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

it("persists a boundary-only marker for a fully filtered Pi head without spawning a producer", async () => {
	const messages = rawMessages(3);
	messages[0].parts = [{ type: "text", text: "ignored status", ignored: true }];
	messages[1].role = "assistant";
	messages[1].parts = [{ type: "reasoning", text: "aborted thinking" }];
	const { db, runner } = await runHistorianWith({
		providerMessages: messages,
		boundarySnapshot: makeBoundarySnapshot({
			protectedTailStart: 3,
			eligibleEndOrdinal: 3,
			rawMessageCountAtTrigger: 3,
			usagePercentage: 114,
		}),
	});
	try {
		expect(runner.run).toHaveBeenCalledTimes(0);
		const rows = getCompartments(db, "ses-historian");
		expect(rows).toHaveLength(1);
		expect(rows[0].endMessage).toBe(2);
		expect(rows[0].content).toBe("");
		expect(rows[0].endMessageId).toBe(messages[1].id);
	} finally {
		closeQuietly(db);
	}
});

describe("Pi historian prompt sized to the producer window", () => {
	it("counts a window too small for the fixed prompt as one failure and backs off until the window changes", async () => {
		const db = createTestDb();
		const holderId = "unfit-holder";
		expect(
			acquireCompartmentLease(db, "ses-historian", holderId),
		).not.toBeNull();
		const notices: string[] = [];
		const runner = runnerReturning([successXml()]);
		const run = (historianContextLimit: number) =>
			runPiHistorian({
				db,
				sessionId: "ses-historian",
				directory: process.cwd(),
				provider: { readMessages: () => rawMessages() },
				runner,
				historianModel: "test/model",
				historianChunkTokens: 20_000,
				historianContextLimit,
				producerContextLimits: new Map([["test/model", historianContextLimit]]),
				maxOutputTokens: 30_000,
				notifyIssue: async (message) => {
					notices.push(message);
				},
				compartmentLeaseHolderId: holderId,
			});
		try {
			clearPiHistorianAlertState("ses-historian");
			// 32k window with a 30k output reserve: not even the system prompt fits.
			await run(32_001);
			expect(getHistorianFailureState(db, "ses-historian").failureCount).toBe(
				1,
			);
			expect(getHistorianFailureState(db, "ses-historian").lastError).toContain(
				"producer_prompt_unfit",
			);
			expect(latestHistorianFailureReason(db)).toContain(
				"producer_prompt_unfit",
			);
			expect(notices.filter((text) => text.includes("(MC-H05)"))).toHaveLength(
				1,
			);

			// Nothing changed: no second failure, no spawn.
			clearPiHistorianAlertState("ses-historian");
			await run(32_001);
			await run(32_001);
			expect(getHistorianFailureState(db, "ses-historian").failureCount).toBe(
				1,
			);
			expect(notices).toHaveLength(1);
			expect(runner.run).not.toHaveBeenCalled();

			// A larger window changes the outcome, so the historian runs again.
			await run(1_000_000);
			expect(runner.run).toHaveBeenCalledTimes(1);
			expect(
				getCompartments(db, "ses-historian").map((row) => [
					row.startMessage,
					row.endMessage,
				]),
			).toEqual([[1, 2]]);
		} finally {
			closeQuietly(db);
		}
	});

	it("trims the memory block so the chunk fits a window the full prompt would overflow", async () => {
		const memoryCount = 600;
		const runner = runnerReturning([successXml()]);
		const { db } = await runHistorianWith({
			runner,
			historianContextLimit: 100_000,
			maxOutputTokens: 8_000,
			beforeRun: (database) => {
				const projectPath = resolveProjectIdentity(process.cwd());
				for (let index = 0; index < memoryCount; index += 1) {
					insertMemory(database, {
						projectPath,
						category: "ARCHITECTURE",
						content: `Remembered architecture fact number ${index}: ${"the module keeps a durable ledger of every decision it made ".repeat(4)}`,
					});
				}
			},
		});
		try {
			expect(runner.run).toHaveBeenCalledTimes(1);
			const options = (
				runner.run as unknown as {
					mock: { calls: Array<[Parameters<SubagentRunner["run"]>[0]]> };
				}
			).mock.calls[0]?.[0];
			const user = options?.userMessage ?? "";
			const keptLines = user
				.split("\n")
				.filter((line) => line.startsWith("- Remembered"));
			expect(keptLines.length).toBeGreaterThan(0);
			expect(keptLines.length).toBeLessThan(memoryCount);
			expect(user).toContain("User request 1");
			expect(
				producerPromptFailureReason({
					sourceLocal: estimateTokens(user),
					systemLocal: estimateTokens(options?.systemPrompt ?? ""),
					toolsLocal: 0,
					modelKey: "test/model",
					contextLimitTokens: 100_000,
					maxOutputTokens: 8_000,
				}),
			).toBeNull();
			expect(getHistorianFailureState(db, "ses-historian").failureCount).toBe(
				0,
			);
		} finally {
			closeQuietly(db);
		}
	});
});

describe("runPiHistorian turn one", () => {
	const projectPath = resolveProjectIdentity(process.cwd());
	const anchoredXml = `<compartment start="1" end="2" title="Initial Pi slice"><p1>Summarized the first Pi turn.</p1></compartment>
<PROJECT_RULES>
* [at_compartment=1 messages=1] Pi turn-one facts carry anchors.
* [at_compartment=unknown] Pi unknown anchors are not guessed.
</PROJECT_RULES>`;
	const sentUserMessages = (runner: SubagentRunner): string[] =>
		(
			runner.run as unknown as {
				mock: { calls: Array<[Parameters<SubagentRunner["run"]>[0]]> };
			}
		).mock.calls.map(([options]) => options.userMessage);
	const pendingFacts = (db: ReturnType<typeof createTestDb>) =>
		db
			.prepare(
				"SELECT fact_index, compartment_id, content, anchor_known, state, fact_attempts, reason FROM memory_pending_facts ORDER BY id",
			)
			.all();
	const publications = (db: ReturnType<typeof createTestDb>) =>
		db
			.prepare(
				"SELECT publication_id, source_session_id, commit_order FROM memory_publications",
			)
			.all() as Array<{
			publication_id: string;
			source_session_id: string;
			commit_order: number | null;
		}>;

	it("keeps today's promotion on the dormant lane and commits the publication once", async () => {
		const { db } = await runHistorianWith({
			outputs: [successXml("Pi dormant lane still promotes.")],
		});
		try {
			expect(
				getMemoriesByProject(db, projectPath).map((m) => m.content),
			).toContain("Pi dormant lane still promotes.");
			expect(pendingFacts(db)).toEqual([]);
			const [publication] = publications(db);
			expect(publications(db)).toHaveLength(1);
			expect(publication).toMatchObject({
				source_session_id: "ses-historian",
				commit_order: 1,
			});
			expect(
				db
					.prepare(
						"SELECT publication_id, run_attempt, stage, harness, state FROM memory_stage_attempts",
					)
					.all(),
			).toEqual([
				{
					publication_id: publication!.publication_id,
					run_attempt: 1,
					stage: "turn_one",
					harness: "pi",
					state: "published",
				},
			]);
			expect(
				db.prepare("SELECT compartment_id FROM memory_activity_ledger").all(),
			).toEqual([
				{ compartment_id: getCompartments(db, "ses-historian")[0]!.id },
			]);
		} finally {
			closeQuietly(db);
		}
	});

	it("records each fact as an authority_elsewhere candidate on a dormant lane the module owns", async () => {
		let memoriesBefore: unknown[] = [];
		const { db } = await runHistorianWith({
			outputs: [successXml("Pi facts survive module authority.")],
			beforeRun: (db) => {
				db.prepare(
					"INSERT INTO authority_managed(project_path, context_store_uuid, marked_at) VALUES (?, 'module-store', 1)",
				).run(projectPath);
				memoriesBefore = db.prepare("SELECT * FROM memories").all();
			},
		});
		try {
			expect(getCompartments(db, "ses-historian")).toHaveLength(1);
			expect(db.prepare("SELECT * FROM memories").all()).toEqual(
				memoriesBefore,
			);
			expect(pendingFacts(db)).toEqual([
				{
					fact_index: 0,
					compartment_id: null,
					content: "Pi facts survive module authority.",
					anchor_known: 0,
					state: "retryable",
					fact_attempts: 0,
					reason: "authority_elsewhere",
				},
			]);
			expect(publications(db).map((row) => row.commit_order)).toEqual([1]);
		} finally {
			closeQuietly(db);
		}
	});

	it("keeps the memory block and promotes when enabled is requested without an RPC carrier", async () => {
		const { db, runner } = await runHistorianWith({
			outputs: [anchoredXml],
			memoryLifecycleLane: "enabled",
			beforeRun: (db) => {
				insertMemory(db, {
					projectPath,
					category: "NAMING",
					content: "Pi memory hidden from turn one.",
					sourceType: "historian",
				});
			},
		});
		try {
			const [sent] = sentUserMessages(runner);
			expect(sent).toContain("Pi memory hidden from turn one.");
			expect(sent).not.toContain("<fact_anchors>required</fact_anchors>");
			expect(pendingFacts(db)).toEqual([]);
			expect(
				db
					.prepare(
						"SELECT start_ordinal, end_ordinal, role, joined_text FROM memory_fact_blocks",
					)
					.all(),
			).toEqual([]);
			expect(
				getMemoriesByProject(db, projectPath).map((m) => m.content),
			).toEqual(
				expect.arrayContaining([
					"Pi memory hidden from turn one.",
					"Pi turn-one facts carry anchors.",
					"Pi unknown anchors are not guessed.",
				]),
			);
		} finally {
			closeQuietly(db);
		}
	});
});

describe("runPiHistorian when the store is busy before dispatch", () => {
	it("skips the run without counting a failure when turn one's send cannot be recorded", async () => {
		const { db, runner } = await runHistorianWith({
			outputs: [successXml("Pi busy-store fact.")],
			beforeRun: (db) => {
				// Recording the send reports a store that stayed busy past its timeout.
				const prepare = db.prepare.bind(db);
				Object.defineProperty(db, "prepare", {
					configurable: true,
					writable: true,
					value: (sql: string) => {
						if (/INSERT INTO memory_stage_attempts/.test(sql)) {
							throw Object.assign(new Error("database is locked"), {
								code: "SQLITE_BUSY",
							});
						}
						return prepare(sql);
					},
				});
			},
		});
		try {
			expect(runner.run).not.toHaveBeenCalled();
			expect(getCompartments(db, "ses-historian")).toEqual([]);
			expect(getHistorianFailureState(db, "ses-historian").failureCount).toBe(
				0,
			);
			expect(
				db
					.prepare(
						"SELECT historian_drain_failure_at AS at FROM session_meta WHERE session_id = ?",
					)
					.get("ses-historian"),
			).toEqual({ at: 0 });
			expect(
				db
					.prepare(
						"SELECT status, failure_reason FROM historian_runs WHERE session_id = ? ORDER BY id DESC LIMIT 1",
					)
					.get("ses-historian"),
			).toEqual({ status: "noop", failure_reason: "turn_one_send_store_busy" });
			expect(
				db.prepare("SELECT COUNT(*) AS n FROM memory_publications").get(),
			).toEqual({ n: 0 });
		} finally {
			closeQuietly(db);
		}
	});
});
