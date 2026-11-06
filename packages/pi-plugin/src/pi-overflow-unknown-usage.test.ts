import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import {
	getOrCreateSessionMeta,
	getTagsBySession,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import {
	getOverflowState,
	recordOverflowDetected,
	resetEmergencyRecoveryRegistryForTest,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { calibrationForModelKey } from "@magic-context/core/hooks/magic-context/decision-calibration";
import {
	_resetHarnessForTesting,
	setHarness,
} from "@magic-context/core/shared/harness";
import * as logger from "@magic-context/core/shared/logger";
import {
	__test,
	clearContextHandlerSession,
	recordPiLiveModel,
	registerPiContextHandler,
	signalPiPendingMaterialization,
} from "./context-handler";
import { getPiChannel1Baseline } from "./ctx-reduce-nudge-pi";
import {
	piRecoveryFitCalibration,
	piRecoveryToolImageTokens,
	resolvePiOverflowRecoveryUsage,
} from "./pi-overflow-recovery";
import * as pressure from "./pi-pressure";
import {
	assistantMessage,
	assistantToolCall,
	createFakePi,
	createTestDb,
	fakeContext,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

beforeEach(() => {
	_resetHarnessForTesting();
	setHarness("pi");
});
afterEach(_resetHarnessForTesting);

const sessionId = "overflow-without-input-count";
const modelKey = "mock/mock";

function fixture(long = false, compactionOff = false) {
	const db = createTestDb();
	updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
	const fake = createFakePi();
	const pi = {
		...fake.pi,
		getAllTools: () => [
			{
				name: "read",
				description: "Read a file",
				parameters: { type: "object" },
			},
		],
	};
	registerPiContextHandler(pi as never, {
		compactionOff,
		db,
		protectedTags: 0,
		heuristics: {},
		scheduler: { executeThresholdPercentage: 65 },
	});
	const handler = fake.handlers.get("context");
	if (!handler) throw new Error("missing context handler");
	const build = () => {
		const messages = [userMessage("Read both images", 1)];
		if (long)
			for (let i = 0; i < 400; i++)
				messages.push(
					assistantMessage(`Earlier answer ${i} ${"word ".repeat(20)}`, i + 2),
				);
		for (let i = 0; i < 2; i++) {
			messages.push(
				assistantToolCall(
					`image-${i}`,
					"read",
					{ path: `${i}.png` },
					500 + i * 2,
				),
			);
			messages.push({
				...toolResultMessage(`image-${i}`, "Image read", 501 + i * 2),
				toolName: "read",
				content: [
					{ type: "image", mimeType: "image/png", data: "A".repeat(220_000) },
				],
			} as never);
		}
		messages.push(userMessage("Continue", 510));
		return messages;
	};
	return {
		db,
		async run(tokens = 0, percent = 0, envelope = true) {
			const messages = build();
			const base = fakeContext(
				sessionId,
				process.cwd(),
				messages.map((_, i) => `entry-${i}`),
				messages,
			);
			const branch = base.sessionManager.getBranch().map((entry, i) => ({
				...entry,
				parentId: i ? `entry-${i - 1}` : null,
			}));
			const ctx = {
				...fakeContext(
					sessionId,
					process.cwd(),
					messages.map((_, i) => `entry-${i}`),
					messages,
				),
				sessionManager: {
					...base.sessionManager,
					getBranch: () => branch,
					getEntry: (id: string) => branch.find((entry) => entry.id === id),
					getLeafId: () => branch.at(-1)?.id,
				},
				model: { provider: "mock", id: "mock", contextWindow: 100_000 },
				getSystemPrompt: envelope
					? () => "You are a helpful assistant."
					: undefined,
				getContextUsage: () => ({ tokens, percent, contextWindow: 100_000 }),
			};
			recordPiLiveModel(sessionId, modelKey);
			return (await handler({ messages } as never, ctx as never)) as {
				messages: unknown[];
			};
		},
		arm(
			origin:
				| "provider_overflow"
				| "proactive_model_shrink" = "provider_overflow",
		) {
			recordOverflowDetected(db, sessionId, 100_000, modelKey, origin);
			updateSessionMeta(db, sessionId, {
				lastInputTokens: 0,
				lastContextPercentage: 0,
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
			});
		},
		close() {
			clearContextHandlerSession(sessionId);
			resetEmergencyRecoveryRegistryForTest();
			db.close();
		},
	};
}

it("drops two large image results on a rebuilding proven-overflow pass with zero usage", async () => {
	const f = fixture(true);
	const log = spyOn(logger, "sessionLog");
	try {
		await f.run(1000, 1);
		f.arm();
		signalPiPendingMaterialization(sessionId);
		const result = await f.run();
		expect(
			getTagsBySession(f.db, sessionId)
				.filter((tag) => tag.type === "tool")
				.map((tag) => tag.status),
		).toEqual(["dropped", "dropped"]);
		expect(JSON.stringify(result.messages)).not.toContain('"type":"image"');
		expect(getOrCreateSessionMeta(f.db, sessionId).lastInputTokens).toBe(0);
		expect(
			log.mock.calls.some(([, line]) =>
				line.includes("overflow unknown-usage recovery:"),
			),
		).toBe(true);
		console.log(
			log.mock.calls
				.filter(([, line]) => line.includes("overflow unknown-usage recovery:"))
				.map(([, line]) => line)
				.join("\n"),
		);
	} finally {
		log.mockRestore();
		f.close();
	}
});

it("does not price unknown usage or change bytes on a non-rebuilding overflow pass", async () => {
	const f = fixture(false, true);
	const passes: boolean[] = [];
	const restore = __test.setPipelineResultObserverForTests((_id, result) =>
		passes.push(result.prefixBustPermitted),
	);
	try {
		const prime = await f.run(1000, 1);
		passes.length = 0;
		f.arm();
		const result = await f.run();
		expect(passes).toEqual([false]);
		expect(result.messages).toEqual(prime.messages);
		expect(
			getTagsBySession(f.db, sessionId)
				.filter((tag) => tag.type === "tool")
				.every((tag) => tag.status === "active"),
		).toBe(true);
	} finally {
		restore();
		f.close();
	}
});

it("requires provider-overflow provenance rather than missing usage or synthetic pressure", async () => {
	for (const origin of [undefined, "proactive_model_shrink"] as const) {
		const f = fixture();
		const log = spyOn(logger, "sessionLog");
		try {
			await f.run(1000, 1);
			if (origin) f.arm(origin);
			signalPiPendingMaterialization(sessionId);
			await f.run(0, 95);
			expect(
				log.mock.calls.some(([, line]) =>
					line.includes("overflow unknown-usage recovery:"),
				),
			).toBe(false);
			expect(getOrCreateSessionMeta(f.db, sessionId).lastInputTokens).toBe(0);
		} finally {
			log.mockRestore();
			f.close();
		}
	}
});

it("refuses an unknown-usage proven overflow without a whole-request estimate and keeps recovery armed", async () => {
	const f = fixture();
	try {
		await f.run(1000, 1);
		f.arm();
		signalPiPendingMaterialization(sessionId);
		await expect(f.run(0, 0, false)).rejects.toThrow("unknown-usage");
		expect(
			getOverflowState(f.db, sessionId, modelKey).needsEmergencyRecovery,
		).toBe(true);
	} finally {
		f.close();
	}
});

it("stores the same decisions as one pass given the rendered recovery estimate up front", async () => {
	const clock = spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
	const log = spyOn(logger, "sessionLog");
	const snapshot = (f: ReturnType<typeof fixture>) => ({
		channel: getPiChannel1Baseline(sessionId),
		database: Object.fromEntries(
			(
				f.db
					.prepare(
						"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
					)
					.all() as { name: string }[]
			).map(({ name }) => [
				name,
				f.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all(),
			]),
		),
	});
	let f = fixture();
	try {
		await f.run(1000, 1);
		f.arm();
		signalPiPendingMaterialization(sessionId);
		const retry = await f.run();
		const line = log.mock.calls.find(([, line]) =>
			line.includes("overflow unknown-usage recovery:"),
		)?.[1];
		const tokens = Number(line?.match(/inputTokens=(\d+)/)?.[1]);
		expect(tokens).toBeGreaterThan(0);
		const retriedState = snapshot(f);
		f.close();
		f = fixture();
		await f.run(1000, 1);
		f.arm();
		signalPiPendingMaterialization(sessionId);
		const pressureSpy = spyOn(
			pressure,
			"resolvePiPressureSnapshotWithEstimateGuard",
		).mockReturnValueOnce({
			inputTokens: tokens,
			percentage: Math.max(95, (tokens / 100_000) * 100),
		});
		const passes: boolean[] = [];
		const restore = __test.setPipelineResultObserverForTests((_id, result) =>
			passes.push(result.prefixBustPermitted),
		);
		try {
			const single = await f.run();
			expect(passes).toEqual([true]);
			expect(single.messages).toEqual(retry.messages);
			expect(snapshot(f)).toEqual(retriedState);
		} finally {
			restore();
			pressureSpy.mockRestore();
		}
	} finally {
		f.close();
		clock.mockRestore();
		log.mockRestore();
	}
});

it("keeps a normal zero-usage pass without overflow provenance byte-identical", async () => {
	const f = fixture();
	const passes: boolean[] = [];
	const log = spyOn(logger, "sessionLog");
	const restore = __test.setPipelineResultObserverForTests((_id, result) =>
		passes.push(result.prefixBustPermitted),
	);
	try {
		const prime = await f.run(1000, 1);
		passes.length = 0;
		const result = await f.run();
		expect(passes).toEqual([false]);
		expect(result.messages).toEqual(prime.messages);
		expect(
			log.mock.calls.some(([, line]) =>
				line.includes("overflow unknown-usage recovery:"),
			),
		).toBe(false);
	} finally {
		restore();
		log.mockRestore();
		f.close();
	}
});

it("requires both rebuild permission and provider provenance before counting", () => {
	const usage = { inputTokens: 0, percentage: 95 };
	for (const [pricedPass, providerOverflow] of [
		[false, true],
		[true, false],
	] as const) {
		expect(
			resolvePiOverflowRecoveryUsage({
				usage,
				pricedPass,
				providerOverflow,
				get messages(): never {
					throw new Error("must not read a non-priced request");
				},
				envelope: undefined,
				usableHardLimit: 100_000,
			}),
		).toBe(usage);
	}
});

it("keeps fractional calibrated reclaim units and declines ambiguous image ownership", () => {
	const calibration = {
		...calibrationForModelKey(modelKey),
		seeded: true,
		toolsRatio: 1.25,
		proseRatio: 1.5,
	};
	expect(piRecoveryFitCalibration(calibration)).toMatchObject({
		toolsRatio: 1.25,
		proseRatio: 1.5,
	});
	const result = {
		role: "toolResult",
		toolCallId: "reused",
		content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
	};
	expect(piRecoveryToolImageTokens([result]).get("reused")).toBeGreaterThan(0);
	expect(piRecoveryToolImageTokens([result, result]).size).toBe(0);
});
