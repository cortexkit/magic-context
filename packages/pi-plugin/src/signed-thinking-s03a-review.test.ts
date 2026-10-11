import { describe, expect, spyOn, test } from "bun:test";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	encodePiContentDecision,
	getPiContentDecisions,
} from "@magic-context/core/features/magic-context/pi-content-decisions";
import {
	getActiveTagsBySession,
	getOrCreateSessionMeta,
	getStrippedPlaceholderIds,
	setStrippedPlaceholderIds,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import * as compartmentTrigger from "@magic-context/core/hooks/magic-context/compartment-trigger";
import {
	createEditAdmission,
	isAdmissionUser,
	thinkingAnchor,
} from "@magic-context/core/hooks/magic-context/edit-admission";
import { protectNewTagMutations } from "@magic-context/core/hooks/magic-context/latest-assistant-turn";
import * as noteNudger from "@magic-context/core/hooks/magic-context/note-nudger";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import {
	type Block,
	StrictBindingMock,
	type Wire,
} from "../../plugin/src/hooks/magic-context/__tests__/strict-binding-mock";
import {
	__test,
	clearContextHandlerSession,
	hasPiParkedBustTrigger,
	registerPiContextHandler,
	signalPiHistoryRefresh,
} from "./context-handler";
import { applyPiHeuristicCleanup } from "./heuristic-cleanup-pi";
import * as rawFallback from "./pi-raw-fallback";
import * as todoInject from "./pi-todo-inject";
import * as thinkingRecovery from "./provider-error-recovery-pi";
import { replayPiReminderStrips } from "./reminder-strip-pi";
import { stripPiDroppedPlaceholderMessages } from "./strip-placeholders-pi";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	type PiMessage,
	textOf,
	userMessage,
} from "./test-utils.test";
import { createPiTranscript } from "./transcript-pi";

// History edits must preserve text preceding kept signed thinking. These opt-in
// tests expose existing placeholder/reminder-strip defects without making ordinary
// test runs fail for known defects.
const review = process.env.MC_S03A_REVIEW === "1" ? describe : describe.skip;
const thinking = {
	type: "thinking",
	thinking: "kept",
	thinkingSignature: "signed",
};

review("signed-thinking s03a review: Pi", () => {
	test("stable-id cutover must not remove a placeholder that was previously sent", () => {
		const db = createTestDb();
		const sessionId = "s03a-cutover";
		try {
			getOrCreateSessionMeta(db, sessionId);
			setStrippedPlaceholderIds(db, sessionId, ["pi-msg-1-2-assistant"]);
			const user = userMessage("continue", 1);
			const old = assistantMessage("[dropped §2§]", 2);
			const fresh = assistantMessage("[dropped §3§]", 3);
			const provider = new StrictBindingMock();
			provider.newUserTurn();
			const receipt = provider.respond(requestWire([user, fresh]))!;
			const retained = {
				type: "thinking",
				thinking: receipt.thinking,
				thinkingSignature: receipt.signature,
			};
			const signed = assistantMessage("answer", 4, {
				content: [retained, { type: "text", text: "answer" }],
			});
			expect(provider.check(requestWire([user, fresh, signed]))).toBeNull();
			const messages = [user, old, fresh, signed];
			const ids = new Map<object, string>([
				[user, "u"],
				[old, "old"],
				[fresh, "fresh"],
				[signed, "signed"],
			]);
			const admission = createEditAdmission({
				messages,
				stableId: (message) => ids.get(message),
				partsOf: (message) =>
					Array.isArray(message.content) ? message.content : [],
				isRealUser: isAdmissionUser,
				prefixBound: true,
				isRetainedThinking: (_message, part) => part === retained,
				anchorOf: thinkingAnchor,
			});
			expect(admission.frame.kind).toBe("boundary");
			expect(
				admission.admit({ kind: "message", id: "fresh", block: "whole" }),
			).toBe(false);
			// The old placeholder was omitted, but the fresh one was present in the
			// request that produced the signature. Changing stored omission IDs from
			// positional IDs to session-entry IDs must not omit previously sent text.
			const sentPrefix = JSON.stringify(requestWire([user, fresh]));
			stripPiDroppedPlaceholderMessages({
				db,
				sessionId,
				messages,
				isCacheBusting: false,
				forceDiscovery: true,
				stableIdByRef: ids,
				admit: (message) =>
					admission.admit({
						kind: "message",
						id: ids.get(message as object),
						block: "whole",
					}),
			});
			expect(messages.includes(signed)).toBe(true);
			console.log(`CUTOVER-REJECTION ${provider.check(requestWire(messages))}`);
			expect(
				JSON.stringify(
					requestWire(messages.filter((m) => m === user || m === fresh)),
				),
			).toBe(sentPrefix);
			expect(provider.check(requestWire(messages))).toBeNull();
		} finally {
			db.close();
		}
	});

	test("a rejected reminder strip must not freeze a replay decision", () => {
		const db = createTestDb();
		const sessionId = "s03a-rejected-reminder";
		try {
			getOrCreateSessionMeta(db, sessionId);
			const messages = [
				userMessage("words <system-reminder>noise</system-reminder>", 1),
				assistantMessage("answer", 2, {
					content: [thinking, { type: "text", text: "answer" }],
				}),
			];
			const original = structuredClone(messages);
			const tagger = createTagger();
			tagger.initFromDb(sessionId, db);
			const transcript = createPiTranscript(messages, sessionId, ["u", "a"]);
			const view = transcript.messages.map((message) => ({
				...message,
				parts: message.parts,
			}));
			const { targets } = tagTranscript(
				sessionId,
				{ ...transcript, messages: view },
				tagger,
				db,
				{ skipPrefixInjection: true },
			);
			const guarded = protectNewTagMutations(
				view,
				targets,
				new Set([view[1].parts[0]]),
				true,
			);
			const tag = getActiveTagsBySession(db, sessionId).find(
				(tag) => tag.messageId === "u:p0",
			)!;
			expect(guarded.get(tag.tagNumber)?.thinkingRewriteProtected).toBe(true);
			const result = applyPiHeuristicCleanup(sessionId, db, guarded, messages, {
				protectedTags: 0,
				staleReduceStripEnabled: false,
			});
			expect(result.droppedInjections).toBe(0);
			expect(targets.get(tag.tagNumber)?.getContent?.()).toContain(
				"<system-reminder>",
			);
			const persisted = getPiContentDecisions(db, sessionId).has(
				encodePiContentDecision("reminder-strip", tag.messageId),
			);
			replayPiReminderStrips({
				db,
				sessionId,
				targets,
				activeTags: getActiveTagsBySession(db, sessionId),
				legacyReminderTagNumbers: new Set(),
				cacheBusting: false,
			});
			transcript.commit();
			// Check the adapter's resulting messages as well as the zero
			// droppedInjections count returned by applyPiHeuristicCleanup.
			expect((messages[1].content as unknown[])[0]).toEqual(thinking);
			const next = createPiTranscript(original, sessionId, ["u", "a"]);
			const nextView = next.messages.map((message) => ({
				...message,
				parts: message.parts,
			}));
			const nextTargets = tagTranscript(
				sessionId,
				{ ...next, messages: nextView },
				tagger,
				db,
				{ skipPrefixInjection: true },
			).targets;
			replayPiReminderStrips({
				db,
				sessionId,
				targets: nextTargets,
				activeTags: getActiveTagsBySession(db, sessionId),
				legacyReminderTagNumbers: new Set(),
				cacheBusting: false,
			});
			next.commit();
			expect((original[1].content as unknown[])[0]).toEqual(thinking);
			console.log(
				`REMINDER-REJECTION persisted=${persisted} served=${JSON.stringify(textOf(messages[0]))} next=${JSON.stringify(textOf(original[0]))}`,
			);
			expect(textOf(messages[0])).toContain("<system-reminder>");
			expect(textOf(original[0])).toContain("<system-reminder>");
			expect(persisted).toBe(false);
		} finally {
			db.close();
		}
	});

	test("ordinary placeholder discovery holds then lands on one safe refresh", () => {
		const db = createTestDb();
		const sessionId = "s03a-placeholder-release";
		try {
			getOrCreateSessionMeta(db, sessionId);
			const marker = assistantMessage("[dropped §7§]", 2);
			const signed = assistantMessage("answer", 3, { content: [thinking] });
			const source = [userMessage("continue", 1), marker, signed];
			const ids = new Map<object, string>(
				source.map((message, index) => [message, `id-${index}`]),
			);
			let held = true;
			const run = (refresh: boolean) => {
				const messages = [...source];
				const result = stripPiDroppedPlaceholderMessages({
					db,
					sessionId,
					messages,
					stableIdByRef: ids,
					isCacheBusting: refresh,
					admit: () => !held,
				});
				return { messages, result };
			};
			expect(run(true).messages).toContain(marker);
			expect(getStrippedPlaceholderIds(db, sessionId).size).toBe(0);
			expect(run(false).messages).toContain(marker);
			held = false;
			expect(run(true).result.discovered).toBe(1);
			expect(run(false).result.discovered).toBe(0);
			expect(run(false).messages).not.toContain(marker);
		} finally {
			db.close();
		}
	});
});

review("signed-thinking s03a review: unheld Pi history consumers", () => {
	for (const consumer of [
		"note nudges",
		"synthetic todo",
		"historian publishedHistoryRide",
		"proactive thinking strip",
		"last-good envelope",
	] as const) {
		test(`${consumer} preserves the raw refresh signal without a hold`, async () => {
			const db = createTestDb();
			const sessionId = `s03a-consumer-${consumer}`;
			const fake = createFakePi();
			getOrCreateSessionMeta(db, sessionId);
			updateSessionMeta(db, sessionId, {
				piStableIdScheme: 1,
				cacheTtl: "59m",
				lastResponseTime: Date.now(),
				lastTodoState: JSON.stringify([
					{
						content: "inspect parser",
						status: "in_progress",
						priority: "high",
					},
				]),
			});
			const note = spyOn(noteNudger, "observeNoteNudgeServe");
			const todo = spyOn(todoInject, "injectSyntheticTodowriteForPi");
			const historian = spyOn(
				compartmentTrigger,
				"checkCompartmentTrigger",
			).mockReturnValue({ shouldFire: false });
			const strip = spyOn(thinkingRecovery, "applyPiProactiveThinkingStrip");
			const estimate = spyOn(rawFallback, "estimatePiOutgoingInputTokens");
			try {
				registerPiContextHandler(fake.pi as never, {
					db,
					todowriteEnabled: true,
					injection: {
						injectionBudgetTokens: 4000,
						memoryEnabled: false,
						injectDocs: false,
					},
					historian: {
						model: "fake/model",
						historianChunkTokens: 1,
						runner: {
							run: async () => {
								throw new Error("Provider calls are forbidden in review tests");
							},
						} as never,
					},
				});
				const raw = [
					userMessage("inspect parser", 1),
					assistantMessage("working", 2),
				];
				const handler = fake.handlers.get("context")!;
				const pass = async () => {
					const source = structuredClone(raw);
					return handler(
						{ messages: source } as never,
						{
							...fakeContext(sessionId, process.cwd(), ["u", "a"], source),
							model: {
								provider: "anthropic",
								id: "claude-opus-5-5",
								api: "anthropic-messages",
								contextWindow: 100_000,
							},
						} as never,
					);
				};
				await pass();
				for (const rawSignal of [false, true]) {
					note.mockClear();
					todo.mockClear();
					historian.mockClear();
					strip.mockClear();
					estimate.mockClear();
					if (rawSignal) signalPiHistoryRefresh(sessionId);
					await pass();
					expect(hasPiParkedBustTrigger(sessionId)).toBe(false);
					if (consumer === "note nudges") {
						expect(note.mock.calls.length).toBeGreaterThan(0);
						expect(note.mock.calls.at(-1)![0].isCacheBustingPass).toBe(
							rawSignal,
						);
					} else if (consumer === "synthetic todo") {
						expect(todo.mock.calls.length).toBeGreaterThan(0);
						expect(todo.mock.calls.at(-1)![0].isCacheBusting).toBe(rawSignal);
					} else if (consumer === "historian publishedHistoryRide") {
						expect(historian.mock.calls.length).toBeGreaterThan(0);
						expect(historian.mock.calls.at(-1)!.at(-1)).toMatchObject({
							publishedHistory: rawSignal,
						});
					} else if (consumer === "proactive thinking strip") {
						expect(strip.mock.calls.length).toBeGreaterThan(0);
						expect(strip.mock.calls.at(-1)![0].cacheBustingPass).toBe(
							rawSignal,
						);
					} else {
						expect(estimate.mock.calls.length > 0).toBe(rawSignal);
					}
				}
			} finally {
				note.mockRestore();
				todo.mockRestore();
				historian.mockRestore();
				strip.mockRestore();
				estimate.mockRestore();
				clearContextHandlerSession(sessionId);
				db.close();
			}
		});
	}
});

function requestWire(messages: PiMessage[]): Wire {
	return messages.flatMap((message) => {
		const parts =
			typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content;
		const content: Block[] = parts.flatMap((part): Block[] => {
			const p = part as unknown as Record<string, unknown>;
			if (p.type === "thinking")
				return [
					{
						type: "thinking",
						thinking: p.thinking,
						signature: p.thinkingSignature,
					},
				];
			if (p.type === "text" && p.text) return [{ type: "text", text: p.text }];
			return [];
		});
		return content.length ? [{ role: message.role, content }] : [];
	});
}

async function historyFixture(sessionId: string, legacy = false) {
	const db = createTestDb();
	getOrCreateSessionMeta(db, sessionId);
	updateSessionMeta(db, sessionId, {
		piStableIdScheme: legacy ? 0 : 1,
		cacheTtl: "59m",
		lastResponseTime: Date.now(),
	});
	let resolvedIds = !legacy;
	const raw = [
		userMessage("inspect parser", 1),
		assistantMessage("[dropped §998§]", 2),
	];
	const ids = ["u", "placeholder"];
	const mock = new StrictBindingMock();
	mock.newUserTurn();
	let model = "claude-opus-5-5";
	let busted = false;
	let fake = createFakePi();
	const register = () =>
		registerPiContextHandler(fake.pi as never, {
			db,
			protectedTokens: 4000,
			onPostprocess: (result) => {
				busted = result.bustedThisPass;
			},
			injection: {
				injectionBudgetTokens: 4000,
				memoryEnabled: false,
				injectDocs: false,
			},
			heuristics: { keepReasoningTokens: 1_000_000 },
		});
	register();
	const pass = async () => {
		const source = structuredClone(raw);
		const ctx = {
			...fakeContext(sessionId, process.cwd(), ids, source),
			model: {
				provider: "anthropic",
				id: model,
				api: "anthropic-messages",
				contextWindow: 100_000,
			},
			getContextUsage: () => ({
				tokens: 20_000,
				percent: 20,
				contextWindow: 100_000,
			}),
		};
		if (!resolvedIds)
			ctx.sessionManager.getBranch = () => {
				throw new Error("branch temporarily unavailable");
			};
		const result = (await fake.handlers.get("context")!(
			{ messages: source } as never,
			ctx as never,
		)) as { messages: PiMessage[] } | undefined;
		return { messages: result?.messages ?? source, busted };
	};
	const first = await pass();
	expect(JSON.stringify(requestWire(first.messages))).toContain(
		"[dropped §998§]",
	);
	const block = mock.respond(requestWire(first.messages))!;
	raw.push(
		assistantMessage("continue", 3, {
			provider: "anthropic",
			model,
			api: "anthropic-messages",
			content: [
				{
					type: "thinking",
					thinking: block.thinking,
					thinkingSignature: block.signature,
				},
				{ type: "text", text: "continue" },
			],
		}),
	);
	ids.push("signed");
	const signed = await pass();
	expect(mock.check(requestWire(signed.messages))).toBeNull();
	return {
		db,
		sessionId,
		mock,
		raw,
		ids,
		pass,
		userTurn: () => {
			mock.newUserTurn();
			raw.push(userMessage("continue parser work", 4));
			ids.push("next-user");
		},
		resolveEntryIds: () => {
			resolvedIds = true;
		},
		setModel: (id: string) => {
			model = id;
		},
		restart: () => {
			clearContextHandlerSession(sessionId);
			fake = createFakePi();
			register();
		},
		close: () => {
			clearContextHandlerSession(sessionId);
			db.close();
		},
	};
}

review("signed-thinking s03a review: kept Pi signal", () => {
	test("handler stable-id migration preserves a sent placeholder under thinking", async () => {
		const f = await historyFixture("s03a-handler-cutover", true);
		try {
			const before = await f.pass();
			expect(f.mock.check(requestWire(before.messages))).toBeNull();
			f.resolveEntryIds();
			const after = await f.pass();
			expect(JSON.stringify(requestWire(before.messages))).toContain(
				"[dropped §998§]",
			);
			expect(JSON.stringify(requestWire(after.messages))).not.toContain(
				"[dropped §998§]",
			);
			console.log(
				`HANDLER-CUTOVER-REJECTION ${f.mock.check(requestWire(after.messages))}`,
			);
			expect(f.mock.check(requestWire(after.messages))).toBeNull();
		} finally {
			f.close();
		}
	});
	for (const release of ["new user", "model change"] as const) {
		for (const fold of [false, true]) {
			test(`history ${fold ? "fold" : "refresh"} releases once at ${release}`, async () => {
				const f = await historyFixture(`s03a-${release}-${fold}`);
				try {
					if (fold)
						appendCompartments(f.db, f.sessionId, [
							{
								sequence: 0,
								startMessage: 1,
								endMessage: 2,
								startMessageId: "u",
								endMessageId: "placeholder",
								title: "parser",
								content: "inspection complete",
							},
						]);
					signalPiHistoryRefresh(f.sessionId);
					await f.pass();
					expect(__test.hasHistoryRefreshForTests(f.sessionId)).toBe(true);
					expect(hasPiParkedBustTrigger(f.sessionId)).toBe(true);
					for (let repeat = 0; repeat < 3; repeat++) {
						const held = await f.pass();
						expect(held.busted).toBe(false);
						expect(JSON.stringify(requestWire(held.messages))).toContain(
							"[dropped §998§]",
						);
					}
					if (release === "new user") f.userTurn();
					else f.setModel("claude-opus-4-6");
					const landed = await f.pass();
					expect(landed.busted).toBe(true);
					if (release === "new user")
						expect(f.mock.check(requestWire(landed.messages))).toBeNull();
					expect(JSON.stringify(requestWire(landed.messages))).not.toContain(
						"[dropped §998§]",
					);
					expect(__test.hasHistoryRefreshForTests(f.sessionId)).toBe(false);
					expect(hasPiParkedBustTrigger(f.sessionId)).toBe(false);
					expect((await f.pass()).busted).toBe(false);
					f.userTurn();
					expect((await f.pass()).busted).toBe(false);
				} finally {
					f.close();
				}
			});
		}
	}
	test("history fold without a hold consumes the raw refresh once", async () => {
		const f = await historyFixture("s03a-unheld-fold");
		try {
			f.userTurn();
			appendCompartments(f.db, f.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "u",
					endMessageId: "placeholder",
					title: "parser",
					content: "inspection complete",
				},
			]);
			signalPiHistoryRefresh(f.sessionId);
			const folded = await f.pass();
			expect(folded.busted).toBe(true);
			expect(__test.hasHistoryRefreshForTests(f.sessionId)).toBe(false);
			expect(hasPiParkedBustTrigger(f.sessionId)).toBe(false);
			expect(f.mock.check(requestWire(folded.messages))).toBeNull();
			expect((await f.pass()).busted).toBe(false);
		} finally {
			f.close();
		}
	});

	test("a kept history refresh survives restart until safe release", async () => {
		const f = await historyFixture("s03a-history-restart");
		try {
			signalPiHistoryRefresh(f.sessionId);
			await f.pass();
			expect(hasPiParkedBustTrigger(f.sessionId)).toBe(true);
			f.restart();
			f.userTurn();
			const release = await f.pass();
			const releaseBytes = JSON.stringify(requestWire(release.messages));
			signalPiHistoryRefresh(f.sessionId);
			const laterRefresh = await f.pass();
			expect(JSON.stringify(requestWire(laterRefresh.messages))).not.toContain(
				"[dropped §998§]",
			);
			expect((await f.pass()).busted).toBe(false);
			expect(releaseBytes).not.toContain("[dropped §998§]");
		} finally {
			f.close();
		}
	});
});
