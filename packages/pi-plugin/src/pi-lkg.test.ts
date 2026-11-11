import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import { runMigrations } from "@magic-context/core/features/magic-context/migrations";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage-meta-session";
import { loadPersistedLkgSlot } from "@magic-context/core/hooks/magic-context/lkg-persist";
import {
	getSlot,
	resetLkgSlotsForTest,
} from "@magic-context/core/hooks/magic-context/lkg-slot";
import { Database } from "@magic-context/core/shared/sqlite";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { createTestTempDir } from "@magic-context/core/shared/test-temp-dir";
import {
	clearContextHandlerSession,
	__test as contextTest,
	registerPiContextHandler,
} from "./context-handler";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import {
	createPiLkgCoordinator,
	type PiLkgCaptureTiming,
	resolvePiLkgOutputEntryIds,
} from "./pi-lkg";
import { assertPiRawFallbackFits } from "./pi-raw-fallback";
import { readPiCommittedServedNumbers } from "./pi-served-identities";
import { flushPiServedArrayLedger } from "./served-array-ledger";
import {
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

function message(content: string): Record<string, unknown> {
	return { role: "user", content, timestamp: 1 };
}

function createHarness(onTiming?: (sample: PiLkgCaptureTiming) => void) {
	const db = new Database(":memory:");
	initializeDatabase(db);
	runMigrations(db);
	let scheduledCapture: (() => void) | undefined;
	const coordinator = createPiLkgCoordinator(
		db,
		(capture) => {
			scheduledCapture = capture;
		},
		onTiming,
	);
	return {
		db,
		coordinator,
		flushCapture(): void {
			const capture = scheduledCapture;
			scheduledCapture = undefined;
			if (!capture) throw new Error("expected a scheduled LKG capture");
			capture();
		},
	};
}

const databases: Database[] = [];

afterEach(() => {
	resetLkgSlotsForTest();
	for (const db of databases) closeQuietly(db);
	databases.length = 0;
});

for (const api of ["google-generative-ai", "anthropic-messages"]) {
	it(`${api}: real handler publishes only managed rows and replays them before late extension insertion`, async () => {
		const { dir: root, cleanup } = createTestTempDir("pi-foreign-publication-");
		const prior = [process.env.XDG_DATA_HOME, process.env.XDG_CONFIG_HOME];
		process.env.XDG_DATA_HOME = root;
		process.env.XDG_CONFIG_HOME = root;
		__setPiHarnessKindForTesting("omp");
		const db = createTestDb(join(root, "context.db"));
		const sessionId = `foreign-write-${api}`;
		const fake = createFakePi();
		Object.assign(fake.pi, {
			appendEntry: () => undefined,
			getAllTools: () => [],
			getActiveTools: () => [],
		});
		let raw = [userMessage("persist this own prompt", 1)];
		const ctx = Object.assign(fakeContext(sessionId, root, ["entry"], raw), {
			model: {
				api,
				provider: "test",
				id: "test",
				contextWindow: 100000,
				maxTokens: 4096,
			},
			getSystemPrompt: () => "system",
		});
		const entries = () => [{ type: "message", id: "entry", message: raw[0] }];
		Object.assign(ctx.sessionManager, {
			getEntries: entries,
			getBranch: entries,
		});
		registerPiContextHandler(fake.pi as never, { db });
		const recoveryLines: string[] = [];
		const restoreRecovery = contextTest.setLkgRecoveryLogObserverForTests(
			(line) => recoveryLines.push(line),
		);
		const context = fake.handlers.get("context")!;
		const dispatch = fake.handlers.get("before_provider_request")!;
		const serve = async () => {
			raw = [userMessage("persist this own prompt", 1)];
			const result = (await context(
				{ messages: raw } as never,
				ctx as never,
			)) as { messages: Record<string, unknown>[] };
			// A later context hook creates a new array, as Superpowers does. The
			// real handler and guarded dispatch, not this test, own all persistence.
			const late = [
				{ role: "user", content: "FOREIGN_BOOTSTRAP_NEVER_PERSIST" },
				...result.messages,
			];
			const payload =
				api === "google-generative-ai"
					? {
							contents: late.map((row) => ({
								role: row.role,
								parts:
									typeof row.content === "string"
										? [{ text: row.content }]
										: (row.content as { text: string }[]).map((part) => ({
												text: part.text,
											})),
							})),
						}
					: { system: "system", max_tokens: 100, messages: late };
			expect(dispatch({ payload } as never, ctx as never)).toBeUndefined();
			await new Promise((resolve) => setImmediate(resolve));
			return result;
		};
		let locker: Database | undefined;
		try {
			updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
			const first = await serve();
			const saved = loadPersistedLkgSlot(db, sessionId)?.jsonPrefix;
			expect(saved).toBe(JSON.stringify(first.messages));
			expect(saved).toContain("§1§ persist this own prompt");
			expect(saved).not.toContain("FOREIGN_BOOTSTRAP_NEVER_PERSIST");
			expect(readPiCommittedServedNumbers(db, sessionId)).toEqual([1]);
			locker = new Database(join(root, "context.db"));
			db.exec("PRAGMA busy_timeout=0");
			locker.exec("BEGIN IMMEDIATE");
			let recovered: Awaited<ReturnType<typeof serve>>;
			try {
				recovered = await serve();
			} catch (cause) {
				throw new Error(recoveryLines.join("\n"), { cause });
			}
			expect(recoveryLines.join("\n")).toContain("LKG replay served");
			expect(recovered.messages).toEqual(first.messages);
			expect(getSlot(sessionId)?.jsonPrefix).toBe(saved);
			expect(loadPersistedLkgSlot(db, sessionId)?.jsonPrefix).toBe(saved);
			expect(readPiCommittedServedNumbers(db, sessionId)).toEqual([1]);
		} finally {
			restoreRecovery();
			if (locker) {
				locker.exec("ROLLBACK");
				closeQuietly(locker);
			}
			flushPiServedArrayLedger();
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
			__setPiHarnessKindForTesting(undefined);
			for (const [index, key] of [
				"XDG_DATA_HOME",
				"XDG_CONFIG_HOME",
			].entries()) {
				if (prior[index] === undefined) delete process.env[key];
				else process.env[key] = prior[index];
			}
			cleanup();
		}
	});
}

describe("Pi incremental LKG capture", () => {
	it("detaches exact nested output fields and rejects same-length in-place rewrites", () => {
		const harness = createHarness();
		databases.push(harness.db);
		const output = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						name: "read",
						arguments: { path: "alpha", values: [null, true, 1, undefined] },
					},
				],
				timestamp: 1,
			},
		];
		const snapshot = harness.coordinator.beginPass({
			sessionId: "nested-output",
			messages: output,
			entryIds: ["entry"],
			modelKey: "test/model",
			providerKey: "test",
		});
		const capture = () =>
			harness.coordinator.captureAppliedPass({
				snapshot,
				outputMessages: output,
				outputEntryIds: ["entry"],
				cacheBusting: false,
			});
		const originalJson = JSON.stringify(output);
		expect(capture()?.json).toBe(originalJson);
		harness.flushCapture();
		output[0].content[0].arguments.path = "bravo";
		const changedJson = JSON.stringify(output);
		expect(changedJson).not.toBe(originalJson);
		expect(capture()?.json).toBe(changedJson);
		harness.flushCapture();
		expect(getSlot("nested-output")?.jsonPrefix).toBe(changedJson);
	});

	it("keeps sparse and custom-JSON output on the one-shot serialization path", () => {
		const harness = createHarness();
		databases.push(harness.db);
		const snapshot = harness.coordinator.beginPass({
			sessionId: "custom-output",
			messages: [message("input")],
			entryIds: ["entry"],
			modelKey: "test/model",
			providerKey: "test",
		});
		for (const content of [new Array(2), { toJSON: () => "custom" }]) {
			const output = [{ role: "user", content, timestamp: 1 }];
			expect(
				harness.coordinator.captureAppliedPass({
					snapshot,
					outputMessages: output,
					outputEntryIds: ["entry"],
					cacheBusting: false,
				}),
			).toBeUndefined();
			harness.flushCapture();
			expect(getSlot("custom-output")?.jsonPrefix).toBe(JSON.stringify(output));
		}
	});
	it("refuses replay when the same entry id returns to old same-length content", () => {
		const harness = createHarness();
		databases.push(harness.db);
		const sessionId = "pi-lkg-same-id-content-change";
		const entryIds = ["entry-1"];

		const original = [message("alpha")];
		const first = harness.coordinator.beginPass({
			sessionId,
			messages: original,
			entryIds,
			modelKey: "test/model",
			providerKey: "test",
		});
		harness.coordinator.captureAppliedPass({
			snapshot: first,
			outputMessages: original,
			cacheBusting: false,
		});
		harness.flushCapture();

		const changed = [message("bravo")];
		const second = harness.coordinator.beginPass({
			sessionId,
			messages: changed,
			entryIds,
			modelKey: "test/model",
			providerKey: "test",
		});
		harness.coordinator.captureAppliedPass({
			snapshot: second,
			outputMessages: changed,
			cacheBusting: false,
		});
		harness.flushCapture();

		const row = harness.db
			.prepare(
				"SELECT input_content_signatures FROM lkg_slots WHERE session_id = ?",
			)
			.get(sessionId) as { input_content_signatures: string } | undefined;
		expect(JSON.parse(row?.input_content_signatures ?? "[]")).toHaveLength(1);

		const reverted = harness.coordinator.beginPass({
			sessionId,
			messages: original,
			entryIds,
			modelKey: "test/model",
			providerKey: "test",
		});
		expect(harness.coordinator.replay(reverted)).toEqual({
			ok: false,
			reason: "lkg_content_mismatch",
		});
	});

	it("does not read live message objects from the deferred commit", () => {
		const harness = createHarness();
		databases.push(harness.db);
		const sessionId = "pi-lkg-detached-input";
		const liveMessage = message("alpha");
		const liveInput = [liveMessage];
		const snapshot = harness.coordinator.beginPass({
			sessionId,
			messages: liveInput,
			entryIds: ["entry-1"],
			modelKey: "test/model",
			providerKey: "test",
		});
		harness.coordinator.captureAppliedPass({
			snapshot,
			outputMessages: liveInput,
			cacheBusting: false,
		});
		liveMessage.content = "bravo";
		harness.flushCapture();

		const replaySnapshot = harness.coordinator.beginPass({
			sessionId,
			messages: [message("alpha")],
			entryIds: ["entry-1"],
			modelKey: "test/model",
			providerKey: "test",
		});
		expect(harness.coordinator.replay(replaySnapshot)).toEqual({
			ok: true,
			messages: [message("alpha")],
		});
	});

	it("reuses every prior digest on an append-only pass", () => {
		const timings: PiLkgCaptureTiming[] = [];
		const harness = createHarness((sample) => timings.push(sample));
		databases.push(harness.db);
		const sessionId = "pi-lkg-append-only";
		const initial = [message("one"), message("two"), message("three")];
		const initialIds = ["entry-1", "entry-2", "entry-3"];
		const first = harness.coordinator.beginPass({
			sessionId,
			messages: initial,
			entryIds: initialIds,
			modelKey: "test/model",
			providerKey: "test",
		});
		harness.coordinator.captureAppliedPass({
			snapshot: first,
			outputMessages: initial,
			cacheBusting: false,
		});
		harness.flushCapture();

		const appended = [...initial, message("four")];
		const appendedIds = [...initialIds, "entry-4"];
		const second = harness.coordinator.beginPass({
			sessionId,
			messages: appended,
			entryIds: appendedIds,
			modelKey: "test/model",
			providerKey: "test",
		});
		harness.coordinator.captureAppliedPass({
			snapshot: second,
			outputMessages: appended,
			cacheBusting: false,
		});
		harness.flushCapture();

		expect(timings.at(-1)?.reusedPrefix).toBe(appended.length - 1);
	});
});

describe("Pi contracted LKG", () => {
	for (const divergence of ["none", "content", "interior-gap"] as const) {
		it(`replays a captured suffix plus append only without ${divergence} divergence`, () => {
			const harness = createHarness();
			databases.push(harness.db);
			const sessionId = `contracted-${divergence}`;
			const inputs = [
				message("covered"),
				message("survivor"),
				message("interior"),
				message("anchor"),
			];
			const output = [
				message("summary"),
				message("served covered"),
				message("served survivor"),
				message("served interior"),
				message("served anchor"),
			];
			const snapshot = harness.coordinator.beginPass({
				sessionId,
				messages: inputs,
				entryIds: ["a", "b", "c", "d"],
				modelKey: "model",
				providerKey: "provider",
			});
			harness.coordinator.captureAppliedPass({
				snapshot,
				outputMessages: output,
				outputEntryIds: [null, "a", "b", "c", "d"],
				cacheBusting: false,
			});
			harness.flushCapture();
			const next = harness.coordinator.beginPass({
				sessionId,
				messages: [
					divergence === "content" ? message("changed") : inputs[1],
					...(divergence === "interior-gap" ? [] : [inputs[2]]),
					inputs[3],
					message("appended"),
				],
				entryIds: [
					"b",
					...(divergence === "interior-gap" ? [] : ["c"]),
					"d",
					"e",
				],
				modelKey: "model",
				providerKey: "provider",
			});
			const replay = harness.coordinator.replay(next);
			if (divergence === "none")
				expect(replay).toEqual({
					ok: true,
					messages: [output[0], ...output.slice(2), message("appended")],
				});
			else expect(replay.ok).toBe(false);
			resetLkgSlotsForTest();
			const restarted = createPiLkgCoordinator(harness.db);
			expect(restarted.replay(next)).toEqual(replay);
		});
	}
	it("captures stable unmapped entries but rejects ambiguous duplicate identities", () => {
		const harness = createHarness();
		databases.push(harness.db);
		const args = {
			sessionId: "unmapped",
			messages: [message("one"), message("host injected"), message("three")],
			entryIds: ["a", undefined, "c"],
			modelKey: null,
			providerKey: null,
		};
		const snapshot = harness.coordinator.beginPass(args);
		expect(snapshot.preparationFailure).toBeNull();
		harness.coordinator.captureAppliedPass({
			snapshot,
			outputMessages: args.messages,
			cacheBusting: false,
		});
		harness.flushCapture();
		expect(
			harness.coordinator.replay(harness.coordinator.beginPass(args)),
		).toEqual({
			ok: true,
			messages: args.messages,
		});
		expect(
			harness.coordinator.beginPass({
				...args,
				messages: [message("one"), message("same"), message("same")],
				entryIds: ["a", undefined, undefined],
			}).preparationFailure,
		).toBe("lkg_duplicate_entry_id");
	});
});

it("Pi high-fill recovery replays a mapped contraction with 16 stable host entries instead of over-wall raw", () => {
	const harness = createHarness();
	databases.push(harness.db);
	const inputs = Array.from({ length: 2927 }, (_, index) =>
		message(`${index}: ${"x".repeat(350)}`),
	);
	const ids = inputs.map((_, index) =>
		index >= 500 && index < 516 ? undefined : `entry-${index}`,
	);
	const snapshot = harness.coordinator.beginPass({
		sessionId: "pi-high-fill",
		messages: inputs,
		entryIds: ids,
		modelKey: "openai-codex/gpt-5.6-sol",
		providerKey: "openai-codex",
	});
	expect(snapshot.preparationFailure).toBeNull();
	// Model a successful transform's boundary trim and frozen tool reductions.
	const served = inputs
		.slice(1420)
		.map((_, index) => message(`frozen output ${index + 1420}`));
	harness.coordinator.captureAppliedPass({
		snapshot,
		outputMessages: served,
		outputEntryIds: snapshot.inputs.slice(1420).map((input) => input.id),
		cacheBusting: true,
	});
	harness.flushCapture();
	const nextInputs = [
		...inputs.slice(268),
		message("new one"),
		message("new two"),
	];
	const next = harness.coordinator.beginPass({
		sessionId: "pi-high-fill",
		messages: nextInputs,
		entryIds: [...ids.slice(268), "new-1", "new-2"],
		modelKey: "openai-codex/gpt-5.6-sol",
		providerKey: "openai-codex",
	});
	expect(() =>
		assertPiRawFallbackFits(
			nextInputs,
			204000,
			() => {},
			new Error("database is locked"),
			{
				modelKey: "openai-codex/gpt-5.6-sol",
				systemTokens: 100,
				toolDefinitionTokens: 0,
			},
		),
	).toThrow();
	const replay = harness.coordinator.replay(next);
	expect(replay.ok).toBe(true);
	if (!replay.ok) throw new Error(replay.reason);
	expect(replay.messages).toEqual([
		...served,
		message("new one"),
		message("new two"),
	]);
	expect(() =>
		assertPiRawFallbackFits(
			replay.messages,
			204000,
			() => {},
			new Error("database is locked"),
			{
				modelKey: "openai-codex/gpt-5.6-sol",
				systemTokens: 100,
				toolDefinitionTokens: 0,
			},
		),
	).not.toThrow();
});

it("rejects corrupt durable output ownership before contraction", () => {
	const harness = createHarness();
	databases.push(harness.db);
	const snapshot = harness.coordinator.beginPass({
		sessionId: "corrupt-ownership",
		messages: [message("a"), message("b")],
		entryIds: ["a", "b"],
		modelKey: null,
		providerKey: null,
	});
	harness.coordinator.captureAppliedPass({
		snapshot,
		outputMessages: [message("b")],
		outputEntryIds: ["b"],
		cacheBusting: false,
	});
	harness.flushCapture();
	harness.db
		.prepare("UPDATE lkg_slots SET input_id_seq = ? WHERE session_id = ?")
		.run(
			JSON.stringify({
				version: 1,
				inputIds: ["a", "b"],
				piOutputEntryIds: ["not-owned"],
			}),
			"corrupt-ownership",
		);
	resetLkgSlotsForTest();
	const restarted = createPiLkgCoordinator(harness.db);
	const next = restarted.beginPass({
		sessionId: "corrupt-ownership",
		messages: [message("b")],
		entryIds: ["b"],
		modelKey: null,
		providerKey: null,
	});
	expect(restarted.replay(next)).toEqual({ ok: false, reason: "lkg_miss" });
});

it("maps synthetic todo results to their assistant owner without guessing ambiguous owners", () => {
	const assistant = {
		role: "assistant",
		content: [{ type: "toolCall", id: "todo-call", syntheticTodoMarker: true }],
	};
	const result = {
		role: "toolResult",
		toolCallId: "todo-call",
		syntheticTodoMarker: true,
	};
	expect(
		resolvePiLkgOutputEntryIds(
			[message("summary"), assistant, result],
			1,
			(entry) => (entry === assistant ? "owner" : undefined),
		),
	).toEqual([null, "owner", "owner"]);
	const duplicate = structuredClone(assistant);
	expect(
		resolvePiLkgOutputEntryIds([assistant, duplicate, result], 0, (entry) =>
			entry === assistant
				? "first"
				: entry === duplicate
					? "second"
					: undefined,
		),
	).toEqual(["first", "second", undefined]);
});

it("reuses cloned output serialization and skips unchanged LKG persistence", () => {
	const harness = createHarness();
	databases.push(harness.db);
	const inputs = [message("large image data".repeat(10000))];
	const args = {
		sessionId: "pi-lkg-unchanged-output-cost",
		messages: inputs,
		entryIds: ["one"],
		modelKey: "model",
		providerKey: "provider",
	};
	const capture = (messages: typeof inputs) => {
		harness.coordinator.captureAppliedPass({
			snapshot: harness.coordinator.beginPass({ ...args, messages }),
			outputMessages: messages,
			outputEntryIds: ["one"],
			cacheBusting: false,
		});
		harness.flushCapture();
	};
	capture(inputs);
	const changes = () =>
		(harness.db.prepare("SELECT total_changes() AS n").get() as { n: number })
			.n;
	const before = changes();
	const clone = structuredClone(inputs);
	const stringify = spyOn(JSON, "stringify");
	try {
		capture(clone);
		expect(
			stringify.mock.calls.filter(
				([value]) => value === clone || value === clone[0],
			),
		).toHaveLength(0);
		expect(changes()).toBe(before);
	} finally {
		stringify.mockRestore();
	}
	const clonedMessage = clone[0];
	if (!clonedMessage) throw new Error("expected cloned message");
	clonedMessage.content = "rewritten";
	capture(clone);
	expect(changes()).toBeGreaterThan(before);
	expect(
		harness.coordinator.replay(
			harness.coordinator.beginPass({ ...args, messages: clone }),
		),
	).toEqual({ ok: true, messages: clone });
});

it("reuses input fingerprints across a cache-busting capture while invalidating replay", () => {
	const timings: PiLkgCaptureTiming[] = [];
	const harness = createHarness((sample) => timings.push(sample));
	databases.push(harness.db);
	const args = {
		sessionId: "pi-lkg-busted-prefix-reuse",
		messages: [message("one"), message("two")],
		entryIds: ["one", "two"],
		modelKey: "model",
		providerKey: "provider",
	};
	harness.coordinator.captureAppliedPass({
		snapshot: harness.coordinator.beginPass(args),
		outputMessages: args.messages,
		outputEntryIds: args.entryIds,
		cacheBusting: false,
	});
	harness.flushCapture();
	const appended = {
		...args,
		messages: [...args.messages, message("three")],
		entryIds: [...args.entryIds, "three"],
	};
	harness.coordinator.captureAppliedPass({
		snapshot: harness.coordinator.beginPass(appended),
		outputMessages: appended.messages,
		outputEntryIds: appended.entryIds,
		cacheBusting: true,
	});
	expect(
		harness.coordinator.replay(harness.coordinator.beginPass(appended)).ok,
	).toBe(false);
	harness.flushCapture();
	expect(timings.at(-1)?.reusedPrefix).toBe(2);
	expect(
		harness.coordinator.replay(harness.coordinator.beginPass(appended)),
	).toEqual({ ok: true, messages: appended.messages });
});

it("preserves JSON serialization for non-plain output values", () => {
	const harness = createHarness();
	databases.push(harness.db);
	const args = {
		sessionId: "pi-lkg-date-output",
		messages: [message("input")],
		entryIds: ["one"],
		modelKey: null,
		providerKey: null,
	};
	for (const date of ["2026-01-01", "2026-02-01"]) {
		const output = [{ ...message("output"), details: new Date(date) }];
		harness.coordinator.captureAppliedPass({
			snapshot: harness.coordinator.beginPass(args),
			outputMessages: output,
			outputEntryIds: ["one"],
			cacheBusting: false,
		});
		harness.flushCapture();
		expect(
			harness.coordinator.replay(harness.coordinator.beginPass(args)),
		).toEqual({ ok: true, messages: JSON.parse(JSON.stringify(output)) });
	}
});

it("serializes custom output accessors exactly once", () => {
	const harness = createHarness();
	databases.push(harness.db);
	const args = {
		sessionId: "pi-lkg-accessor-output",
		messages: [message("input")],
		entryIds: ["one"],
		modelKey: null,
		providerKey: null,
	};
	let reads = 0;
	const output = [
		{
			role: "user",
			get content() {
				return `read-${++reads}`;
			},
		},
	];
	harness.coordinator.captureAppliedPass({
		snapshot: harness.coordinator.beginPass(args),
		outputMessages: output,
		outputEntryIds: ["one"],
		cacheBusting: false,
	});
	harness.flushCapture();
	expect(reads).toBe(1);
	expect(
		harness.coordinator.replay(harness.coordinator.beginPass(args)),
	).toEqual({ ok: true, messages: [{ role: "user", content: "read-1" }] });
});

it("LKG own-slot digest reuse stops at a same-id same-length input rewrite", () => {
	const harness = createHarness();
	databases.push(harness.db);
	const capture = (text: string) => {
		const messages = [message("prefix"), message(text)];
		const snapshot = harness.coordinator.beginPass({
			sessionId: "own-digest-rewrite",
			messages,
			entryIds: ["one", "two"],
			modelKey: "test/model",
			providerKey: "test",
		});
		harness.coordinator.captureAppliedPass({
			snapshot,
			outputMessages: messages,
			outputEntryIds: ["one", "two"],
			cacheBusting: false,
		});
		harness.flushCapture();
		return getSlot("own-digest-rewrite")?.inputContentDigests;
	};
	const before = capture("alpha");
	const after = capture("bravo");
	expect(before?.length).toBe(2);
	expect(after?.[0]).toBe(before?.[0] as string);
	expect(after?.[1]).not.toBe(before?.[1] as string);
});
