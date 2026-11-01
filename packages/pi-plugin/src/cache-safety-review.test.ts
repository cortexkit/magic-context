import { expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getPendingOps,
	getTagsBySession,
	queuePendingOp,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { getNativeReplayState } from "@magic-context/core/features/magic-context/storage-native-replay";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import {
	applyFlushedStatuses,
	applyPendingOperations,
} from "@magic-context/core/hooks/magic-context/apply-operations";
import {
	type MessageLike,
	tagMessages,
} from "@magic-context/core/hooks/magic-context/tag-messages";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import { createTestTempDirFromPath } from "@magic-context/core/shared/test-temp-dir";
import { adaptPayload } from "../../plugin/src/v2/hooks/payload";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
	signalPiPendingMaterialization,
} from "./context-handler";
import * as imageCleanup from "./strip-processed-images-pi";
import {
	assistantMessage,
	assistantToolCall,
	createFakePi,
	createTestDb,
	fakeContext,
	type PiMessage,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";
import { createPiTranscript } from "./transcript-pi";

const session = "independent-cache-review";
type Lane = "pi" | "oc1" | "oc2";
function rawHistory(lane: Lane): unknown[] {
	const calls = Array.from({ length: 6 }, (_, i) => ({
		id: `call-${i}`,
		name: "read",
		input: { path: `file-${i}.ts` },
		output: `result ${i}\n`.repeat(80),
	}));
	if (lane === "pi")
		return [
			userMessage("read", 1),
			...calls.flatMap((c, i) => [
				assistantToolCall(c.id, c.name, c.input, i * 3 + 2),
				toolResultMessage(c.id, c.output, i * 3 + 3),
			]),
			userMessage("continue", 100),
		];
	if (lane === "oc1")
		return [
			{
				info: { id: "u1", role: "user" },
				parts: [{ type: "text", text: "read" }],
			},
			...calls.map((c) => ({
				info: { id: `owner-${c.id}`, role: "assistant" },
				parts: [
					{
						type: "tool",
						tool: c.name,
						callID: c.id,
						state: { status: "completed", input: c.input, output: c.output },
					},
				],
			})),
			{
				info: { id: "u2", role: "user" },
				parts: [{ type: "text", text: "continue" }],
			},
		];
	return [
		{ id: "u1", role: "user", content: [{ type: "text", text: "read" }] },
		...calls.flatMap((c) => [
			{
				id: `owner-${c.id}`,
				role: "assistant",
				content: [
					{ type: "tool-call", id: c.id, name: c.name, input: c.input },
				],
			},
			{
				id: `result-${c.id}`,
				role: "tool",
				content: [
					{
						type: "tool-result",
						id: c.id,
						name: c.name,
						result: { type: "text", value: c.output },
					},
				],
			},
		]),
		{ id: "u2", role: "user", content: [{ type: "text", text: "continue" }] },
	];
}
function project(
	lane: Lane,
	raw: unknown[],
	db: ReturnType<typeof createTestDb>,
) {
	const tagger = createTagger();
	tagger.initFromDb(session, db);
	if (lane === "pi") {
		const transcript = createPiTranscript(raw, session);
		return {
			...tagTranscript(session, transcript, tagger, db),
			commit: () => transcript.commit(),
		};
	}
	if (lane === "oc1") {
		const tagged = tagMessages(session, raw as MessageLike[], tagger, db);
		return { ...tagged, commit: () => tagged.batch.finalize() };
	}
	const draft = {
		sessionID: session,
		model: { providerID: "anthropic", id: "model" },
		agent: "build",
		messages: raw,
		system: [],
		tools: {},
		options: {},
	};
	const adapted = adaptPayload(draft as never);
	const tagged = tagMessages(session, adapted.messages, tagger, db);
	return {
		...tagged,
		commit: () => {
			tagged.batch.finalize();
			adapted.commit();
			raw.splice(0, raw.length, ...draft.messages);
		},
	};
}

for (const lane of ["pi", "oc1", "oc2"] as const)
	for (const fault of ["mode", "status", "queue"] as const)
		for (let position = 0; position < 3; position++) {
			test(`cache review F12 ${lane}: ${fault} failure at batch position ${position + 1} preserves queue, bytes and restart`, () => {
				const root = createTestTempDirFromPath(join(tmpdir(), "cache-review-"));
				const path = join(root, "fixture.db");
				let db = createTestDb(path);
				try {
					const raw = rawHistory(lane);
					project(lane, raw, db).commit();
					const taggedRaw = structuredClone(raw);
					const toolTags = getTagsBySession(db, session)
						.filter((t) => t.type === "tool")
						.slice(0, 3);
					for (const t of toolTags)
						queuePendingOp(db, session, t.tagNumber, "drop");
					const failedTag = toolTags[position].tagNumber;
					const sql =
						fault === "queue"
							? `BEFORE DELETE ON pending_ops WHEN OLD.tag_id = ${failedTag}`
							: `BEFORE UPDATE OF ${fault === "mode" ? "drop_mode" : "status"} ON tags WHEN NEW.tag_number = ${failedTag}`;
					db.exec(
						`CREATE TEMP TRIGGER reject_review ${sql} BEGIN SELECT RAISE(ABORT, 'review write fault'); END`,
					);
					const live = project(lane, raw, db);
					expect(() =>
						applyPendingOperations(session, db, live.targets, new Set()),
					).toThrow("review write fault");
					live.commit();
					const partialBytes = JSON.stringify(raw);
					expect(getPendingOps(db, session).map((o) => o.tagId)).toEqual(
						toolTags.map((t) => t.tagNumber),
					);
					expect(
						getTagsBySession(db, session)
							.filter((t) => t.type === "tool")
							.map((t) => t.status),
					).toEqual(Array.from({ length: 6 }, () => "active"));
					expect(raw).toEqual(taggedRaw);

					db.close();
					db = createTestDb(path);
					const deferred = structuredClone(taggedRaw);
					const replay = project(lane, deferred, db);
					applyFlushedStatuses(session, db, replay.targets);
					replay.commit();
					expect(JSON.stringify(deferred)).toBe(partialBytes);
					const retried = structuredClone(taggedRaw);
					const retry = project(lane, retried, db);
					applyFlushedStatuses(session, db, retry.targets);
					applyPendingOperations(session, db, retry.targets, new Set());
					retry.commit();
					expect(getPendingOps(db, session)).toEqual([]);
					expect(
						getTagsBySession(db, session)
							.filter((t) => t.type === "tool")
							.slice(0, 3)
							.map((t) => t.status),
					).toEqual(["dropped", "dropped", "dropped"]);
					const finalReplay = structuredClone(taggedRaw);
					const final = project(lane, finalReplay, db);
					applyFlushedStatuses(session, db, final.targets);
					final.commit();
					expect(finalReplay).toEqual(retried);
				} finally {
					db.close();
					rmSync(root, { recursive: true, force: true });
				}
			});
		}

for (const [provider, api] of [
	["openai", "openai-responses"],
	["opencode-zen", "openai-completions"],
	["openai-codex", "openai-codex-responses"],
]) {
	for (const faultPosition of [-1, 0, 1, 2])
		test(`cache review F11 ${api}: ${faultPosition < 0 ? "defer cannot first-apply; admitted cleanup and replay preserve complete pairs" : `write failure ${faultPosition + 1} rejects dispatch and rolls back the lane`}`, async () => {
			const db = createTestDb();
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				protectedTokens: 0,
				protectedTags: 0,
				heuristics: {},
				scheduler: { executeThresholdPercentage: 65 },
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: PiMessage[] },
				ctx: never,
			) => Promise<{ messages: PiMessage[] }>;
			const build = (count: number) => [
				userMessage("start", 1),
				...Array.from({ length: count }, (_, i) => [
					assistantToolCall(`reduce-${i}`, "ctx_reduce", {}, i * 2 + 100),
					{
						...toolResultMessage(`reduce-${i}`, "r".repeat(20000), i * 2 + 101),
						toolName: "ctx_reduce",
					},
				]).flat(),
				// Age reclaim needs three newer user turns before a quiet old output is eligible.
				...Array.from({ length: 3 }, (_, i) => [
					userMessage(`follow-up ${i + 1}`, 150 + i * 2),
					assistantMessage(`response ${i + 1}`, 151 + i * 2),
				]).flat(),
				assistantMessage("answer", 200),
				userMessage("continue", 201),
			];
			const pass = async (count: number) => {
				const messages = build(count);
				return handler({ messages }, {
					...fakeContext(
						session,
						process.cwd(),
						messages.map((m) => `entry-${m.timestamp}`),
						messages,
					),
					model: { provider, id: "gpt-5", api, contextWindow: 100000 },
					getContextUsage: () => ({
						tokens: 1000,
						percent: 1,
						contextWindow: 100000,
					}),
				} as never);
			};
			const warm = () =>
				updateSessionMeta(db, session, {
					lastResponseTime: Date.now(),
					cacheTtl: "59m",
					lastContextPercentage: 1,
					lastInputTokens: 1000,
				});
			try {
				await pass(3);
				warm();
				const held = await pass(6);
				expect(
					getTagsBySession(db, session)
						.filter((t) => t.type === "tool")
						.every((t) => t.status === "active"),
				).toBe(true);
				expect(JSON.stringify(held.messages)).toContain('"id":"reduce-0"');
				warm();
				signalPiPendingMaterialization(session);
				if (faultPosition >= 0) {
					const tag = getTagsBySession(db, session).filter(
						(t) => t.type === "tool",
					)[faultPosition];
					db.exec(
						`CREATE TEMP TRIGGER reject_stale_review BEFORE UPDATE OF status ON tags WHEN NEW.tag_number = ${tag.tagNumber} AND NEW.status = 'dropped' BEGIN SELECT RAISE(ABORT, 'stale review fault'); END`,
					);
				}
				const count = 3;
				if (faultPosition >= 0) {
					await expect(pass(6)).rejects.toThrow("stale review fault");
					// Native permissions and drops are one atomic lane. A rejected
					// request must not leave unserved drops for a later defer to replay.
					expect(
						getTagsBySession(db, session)
							.filter((t) => t.type === "tool")
							.map((t) => t.status),
					).toEqual(Array.from({ length: 6 }, () => "active"));
					expect(getNativeReplayState(db, session).toolInputs.size).toBe(0);
					db.exec("DROP TRIGGER reject_stale_review");
					// The still-permitted rebuild lands the whole cleanup lane, then
					// the ordinary defer below must replay exactly those served bytes.
				}
				const admitted = await pass(6);
				expect(
					getTagsBySession(db, session)
						.filter((t) => t.type === "tool")
						.map((t) => t.status),
				).toEqual(
					Array.from({ length: 6 }, (_, i) =>
						i < count ? "dropped" : "active",
					),
				);
				const calls = admitted.messages.flatMap((m) =>
					m.role === "assistant"
						? m.content
								.filter((p) => p.type === "toolCall")
								.map((p) => (p as { id: string }).id)
						: [],
				);
				const results = admitted.messages
					.filter((m) => m.role === "toolResult")
					.map((m) => (m as { toolCallId: string }).toolCallId);
				expect(calls).toEqual(
					Array.from({ length: 6 - count }, (_, i) => `reduce-${i + count}`),
				);
				expect(results).toEqual(calls);
				warm();
				expect(JSON.stringify((await pass(6)).messages)).toBe(
					JSON.stringify(admitted.messages),
				);
			} finally {
				clearContextHandlerSession(session);
				db.close();
			}
		});
}

// Pi groups tool results into transcript user rows. A group's id can differ from
// the id of the native message that holds an image. Each captures the handler's real
// tag map and calls the image helper directly, with the tool's tag as the highest
// dropped tag. A second call fixes only the map, isolating its effect on image
// selection. Setting usage to 95% bypasses recency protection; the tests do not
// exercise the handler's pressure-based permission to rewrite earlier messages.
for (const parallel of [false, true]) {
	test(`cache review F4 projection: ${parallel ? "parallel results" : "result folded into user"} use each native result's own tag`, async () => {
		const db = createTestDb();
		const fake = createFakePi();
		registerPiContextHandler(fake.pi as never, {
			db,
			heuristics: {},
			protectedTokens: 0,
			protectedTags: 0,
		});
		const messages: PiMessage[] = [
			userMessage("start", 1),
			assistantToolCall("first", "read", {}, 2),
		];
		if (parallel)
			(messages[1] as { content: unknown[] }).content.push({
				type: "toolCall",
				id: "second",
				name: "read",
				arguments: {},
			});
		messages.push(toolResultMessage("first", "first result", 3));
		if (parallel)
			messages.push(toolResultMessage("second", "second result", 4));
		if (!parallel) messages.push(userMessage("follow-up", 5));
		messages.push(assistantMessage("answer", 6));
		const imageResult = messages.find(
			(m) =>
				m.role === "toolResult" &&
				m.toolCallId === (parallel ? "second" : "first"),
		) as { content: unknown[] };
		imageResult.content.push({
			type: "image",
			mimeType: "image/png",
			data: "x".repeat(201),
		});
		const strip = imageCleanup.stripPiProcessedImages;
		const spy = spyOn(imageCleanup, "stripPiProcessedImages");
		try {
			const handler = fake.handlers.get("context") as (
				event: { messages: PiMessage[] },
				ctx: never,
			) => Promise<unknown>;
			await handler({ messages }, {
				...fakeContext(
					session,
					process.cwd(),
					messages.map((m) => `entry-${m.timestamp}`),
					messages,
				),
				model: {
					provider: "anthropic",
					id: "claude-sonnet-4",
					api: "anthropic-messages",
					contextWindow: 100000,
				},
			} as never);
			const args = spy.mock.calls.at(-1)?.[0];
			expect(args).toBeDefined();
			const tag = getTagsBySession(db, session).find(
				(t) =>
					t.type === "tool" && t.messageId === (parallel ? "second" : "first"),
			)!;
			const nativeId = parallel ? "entry-4" : "entry-3";
			const plan = {
				...args!,
				detect: true,
				watermark: tag.tagNumber,
				protectedCutoff: null,
				usagePercentage: 95,
				stableId: (m: unknown) =>
					`entry-${(m as { timestamp: number }).timestamp}`,
			};
			const correctedTags = new Map(plan.messageIdToMaxTag).set(
				nativeId,
				tag.tagNumber,
			);
			expect(
				strip({
					...plan,
					sessionId: "projection-control",
					messages: structuredClone(plan.messages),
					messageIdToMaxTag: correctedTags,
				}).stripped,
			).toBe(1);
			expect(
				strip({
					...plan,
					sessionId: "projection-actual",
					messages: structuredClone(plan.messages),
				}).stripped,
			).toBe(1);
		} finally {
			spy.mockRestore();
			clearContextHandlerSession(session);
			db.close();
		}
	});
}

test("cache review F4 projection: image-only user must not inherit a preceding folded tool tag", async () => {
	const db = createTestDb();
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, {
		db,
		heuristics: {},
		protectedTokens: 0,
		protectedTags: 0,
	});
	const messages = [
		userMessage("start", 1),
		assistantToolCall("read", "read", {}, 2),
		toolResultMessage("read", "result", 3),
		userMessage(
			[{ type: "image", mimeType: "image/png", data: "x".repeat(201) }],
			4,
		),
		assistantMessage("answer", 5),
	];
	const strip = imageCleanup.stripPiProcessedImages;
	const spy = spyOn(imageCleanup, "stripPiProcessedImages");
	try {
		const handler = fake.handlers.get("context") as (
			event: { messages: PiMessage[] },
			ctx: never,
		) => Promise<unknown>;
		await handler({ messages }, {
			...fakeContext(
				session,
				process.cwd(),
				messages.map((m) => `entry-${m.timestamp}`),
				messages,
			),
			model: {
				provider: "anthropic",
				id: "claude-sonnet-4",
				api: "anthropic-messages",
				contextWindow: 100000,
			},
		} as never);
		const args = spy.mock.calls.at(-1)![0];
		const tool = getTagsBySession(db, session).find((t) => t.type === "tool")!;
		const plan = {
			...args,
			detect: true,
			watermark: tool.tagNumber,
			protectedCutoff: null,
			usagePercentage: 95,
			stableId: (m: unknown) =>
				`entry-${(m as { timestamp: number }).timestamp}`,
		};
		const corrected = new Map(plan.messageIdToMaxTag);
		corrected.delete("entry-4");
		expect(
			strip({
				...plan,
				sessionId: "user-control",
				messages: structuredClone(plan.messages),
				messageIdToMaxTag: corrected,
			}).stripped,
		).toBe(0);
		expect(
			strip({
				...plan,
				sessionId: "user-actual",
				messages: structuredClone(plan.messages),
			}).stripped,
		).toBe(0);
	} finally {
		spy.mockRestore();
		clearContextHandlerSession(session);
		db.close();
	}
});
