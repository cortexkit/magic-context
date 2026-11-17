import { afterEach, expect, test } from "bun:test";
import { runMigrations } from "@magic-context/core/features/magic-context/migrations";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage-meta";
import { calibrationForModelKey } from "@magic-context/core/hooks/magic-context/decision-calibration";
import { outgoingContextRefusal } from "@magic-context/core/hooks/magic-context/emergency-fail-closed";
import { resetLkgSlotsForTest } from "@magic-context/core/hooks/magic-context/lkg-slot";
import { Database } from "@magic-context/core/shared/sqlite";
import { persistPiPressureFromMessageEnd } from "./index";
import {
	clearPiLkgSessionState,
	createPiLkgCoordinator,
	notePiLkgProviderUsage,
} from "./pi-lkg";
import { readPiLkgFitEnvelope } from "./pi-lkg-fit-envelope";
import {
	assertPiRawFallbackFits,
	estimatePiOutgoingInputTokens,
} from "./pi-raw-fallback";

const key = "openai-codex/gpt-5.6-sol";
const databases: Database[] = [];
const sessions: string[] = [];
afterEach(() => {
	for (const session of sessions.splice(0)) clearPiLkgSessionState(session);
	resetLkgSlotsForTest();
	for (const db of databases.splice(0)) db.close();
});
function harness(modelKey = key, prefixOverride?: unknown[]) {
	const provider = modelKey.slice(0, modelKey.indexOf("/"));
	const db = new Database(":memory:");
	databases.push(db);
	initializeDatabase(db);
	runMigrations(db);
	const sessionId = `measured-${sessions.length}`;
	sessions.push(sessionId);
	let capture: (() => void) | undefined;
	const coordinator = createPiLkgCoordinator(db, (run) => {
		capture = run;
	});
	const envelope = readPiLkgFitEnvelope(
		{ getSystemPrompt: () => "Complete host prompt." },
		{ getAllTools: () => [] },
		modelKey,
		calibrationForModelKey(modelKey),
	);
	if (!envelope?.envelopeSignature)
		throw new Error("complete envelope required");
	const prefix = prefixOverride ?? [
		{
			role: "user",
			timestamp: 1,
			content: [
				{
					type: "image",
					mimeType: "image/png",
					data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yaz0AAAAASUVORK5CYII=",
				},
			],
		},
	];
	const snapshot = coordinator.beginPass({
		sessionId,
		messages: prefix,
		entryIds: ["input"],
		modelKey,
		providerKey: provider,
	});
	const recapture = (flush = true) => {
		coordinator.captureAppliedPass({
			snapshot,
			outputMessages: prefix,
			outputEntryIds: ["input"],
			cacheBusting: false,
			hostEnvelopeSignature: envelope.envelopeSignature,
		});
		if (!capture) throw new Error("scheduled capture required");
		if (flush) {
			capture();
			capture = undefined;
		}
	};
	recapture();
	const assistant = {
		role: "assistant",
		content: [{ type: "text", text: "Accepted reply" }],
		model: modelKey.slice(modelKey.indexOf("/") + 1),
		provider,
		timestamp: Date.now() + 1,
		stopReason: "stop",
		usage: {
			input: 100,
			cacheRead: 20,
			cacheWrite: 10,
			output: 10,
			totalTokens: 140,
		},
	};
	const tail = [
		assistant,
		{ role: "user", content: "new tail", timestamp: Date.now() + 2 },
	];
	const replay = (parent = "input") =>
		coordinator.replay(
			coordinator.beginPass({
				sessionId,
				messages: [...prefix, ...tail],
				entryIds: ["input", "answer", "new-input"],
				modelKey,
				providerKey: provider,
			}),
			(id) => (id === "answer" ? parent : undefined),
		);
	return {
		db,
		sessionId,
		coordinator,
		prefix,
		captureMessages(
			messages: unknown[],
			entryIds: string[],
			outputMessages = messages,
			outputEntryIds = entryIds,
		) {
			coordinator.captureAppliedPass({
				snapshot: coordinator.beginPass({
					sessionId,
					messages,
					entryIds,
					modelKey,
					providerKey: provider,
				}),
				outputMessages,
				outputEntryIds,
				cacheBusting: false,
				hostEnvelopeSignature: envelope.envelopeSignature,
			});
			if (!capture) throw new Error("scheduled capture required");
			capture();
			capture = undefined;
		},
		outgoing(messages: readonly unknown[], parent = "input") {
			const snapshot = coordinator.beginPass({
				sessionId,
				messages: [...prefix, ...tail],
				entryIds: ["input", "answer", "new-input"],
				modelKey,
				providerKey: provider,
			});
			return coordinator.measureOutgoingPrefix(snapshot, messages, (id) =>
				id === "answer" ? parent : undefined,
			);
		},
		envelope,
		assistant,
		tail,
		replay,
		recapture,
	};
}

test("Pi healthy refusal prefers correlated provider usage and prices only the new tail", () => {
	const h = harness("anthropic/claude-fable-5-1", [
		{ role: "user", content: "word ".repeat(20000) },
	]);
	expect(notePiLkgProviderUsage(h.sessionId, "input", h.assistant)).toBe(true);
	const messages = [
		...h.prefix,
		{
			...h.assistant,
			content: [{ type: "text", text: "§2§ Accepted reply" }],
		},
		h.tail[1],
	];
	const basis = h.outgoing(messages);
	expect(basis?.inputTokens).toBe(130);
	const estimate = estimatePiOutgoingInputTokens(messages, h.envelope, basis);
	expect(estimate.tokens).toBeGreaterThan(16000);
	expect(estimate.refusalGrade).toBe(true);
	expect(estimate.refusalBasis).toBe("provider-prefix");
	expect(estimate.refusalTokens).toBeLessThan(200);
	expect(outgoingContextRefusal(estimate, 16000)).toBeUndefined();
	expect(
		h.outgoing([{ role: "user", content: "changed prefix" }, ...h.tail]),
	).toBeUndefined();
	expect(h.outgoing(messages, "wrong-parent")).toBeUndefined();
	const mismatched = estimatePiOutgoingInputTokens(
		messages,
		{ ...h.envelope!, envelopeSignature: "different" },
		basis,
	);
	expect(mismatched.refusalBasis).toBe("calibrated");
});

test("Pi measured preceding overflow does not refuse a fitting protected subset", () => {
	const h = harness("anthropic/claude-fable-5-1", [
		{ role: "user", content: "hello" },
	]);
	h.assistant.usage.input = 17000;
	expect(notePiLkgProviderUsage(h.sessionId, "input", h.assistant)).toBe(true);
	const messages = [...h.prefix, ...h.tail];
	const estimate = estimatePiOutgoingInputTokens(
		messages,
		h.envelope,
		h.outgoing(messages),
	);
	expect(estimate.tokens).toBeLessThan(1000);
	expect(estimate.refusalTokens).toBeGreaterThan(16000);
	expect(outgoingContextRefusal(estimate, 16000, 0)).toBeUndefined();
	expect(outgoingContextRefusal(estimate, 16000, 10)).toBeUndefined();
});

test("correlated provider input includes cached tokens and prices only the appended reply and new tail", () => {
	const h = harness();
	expect(notePiLkgProviderUsage(h.sessionId, "input", h.assistant)).toBe(true);
	const replay = h.replay();
	if (!replay.ok) throw new Error(replay.reason);
	expect(replay.measuredPrefix?.inputTokens).toBe(130);
	expect(replay.measuredPrefix?.appendedMessages).toEqual(h.tail);
	const logs: string[] = [];
	// The already accepted image prefix is priced by the provider's own input
	// count. Without that basis the whole request is priced from host metadata,
	// the image at its per-image cost, which a 500-token limit cannot hold while
	// the measured basis can.
	expect(() =>
		assertPiRawFallbackFits(
			replay.messages,
			5000,
			(line) => logs.push(line),
			null,
			h.envelope,
			replay.measuredPrefix,
		),
	).not.toThrow();
	expect(logs.join("\n")).toContain(
		"lkg_fit_basis=provider_input measured_input=130",
	);
	expect(() =>
		assertPiRawFallbackFits(
			replay.messages,
			500,
			() => {},
			null,
			h.envelope,
			replay.measuredPrefix,
		),
	).not.toThrow();
	expect(() =>
		assertPiRawFallbackFits(replay.messages, 500, () => {}, null, h.envelope),
	).toThrow();
	if (!replay.measuredPrefix)
		throw new Error("correlated provider basis required");
	const tooLarge = { ...replay.measuredPrefix, inputTokens: 5001 };
	expect(() =>
		assertPiRawFallbackFits(
			replay.messages,
			5000,
			() => {},
			null,
			h.envelope,
			tooLarge,
		),
	).toThrow();
});

test("provider usage from a different model is not a captured-slot fit basis", () => {
	const h = harness();
	h.assistant.model = "different-model";
	expect(notePiLkgProviderUsage(h.sessionId, "input", h.assistant)).toBe(false);
	const replay = h.replay();
	if (!replay.ok) throw new Error(replay.reason);
	expect(replay.measuredPrefix).toBeUndefined();
	// Priced from host metadata, the image prefix alone exceeds this limit.
	const logs: string[] = [];
	expect(() =>
		assertPiRawFallbackFits(
			replay.messages,
			500,
			(line) => logs.push(line),
			null,
			h.envelope,
			replay.measuredPrefix,
		),
	).toThrow();
	expect(logs.join("\n")).toContain("lkg_fit_basis=host_metadata");
});

test("provider usage requires the real JSONL parent and the exact captured pass", () => {
	const h = harness();
	expect(notePiLkgProviderUsage(h.sessionId, "wrong-parent", h.assistant)).toBe(
		false,
	);
	expect(notePiLkgProviderUsage(h.sessionId, "input", h.assistant)).toBe(true);
	const wrongParent = h.replay("different-parent");
	expect(wrongParent.ok && wrongParent.measuredPrefix).toBeUndefined();
});

for (const flush of [true, false]) {
	test(`identical unmeasured recapture retains the correlated provider prefix (deferred commit ${flush ? "flushed" : "pending"})`, () => {
		const h = harness();
		expect(notePiLkgProviderUsage(h.sessionId, "input", h.assistant)).toBe(
			true,
		);
		h.recapture(flush);
		const replay = h.replay();
		if (!replay.ok) throw new Error(replay.reason);
		expect(replay.measuredPrefix?.inputTokens).toBe(130);
		expect(replay.measuredPrefix?.appendedMessages).toEqual(h.tail);
	});
}

test("append-only unmeasured capture and set-aside estimate retain provider-priced fit without changing replay bytes", async () => {
	const h = harness("anthropic/claude-fable-5-1", [
		{ role: "user", content: "word ".repeat(310000) },
	]);
	h.assistant.usage.input = 262325;
	h.assistant.usage.totalTokens = 262365;
	expect(notePiLkgProviderUsage(h.sessionId, "input", h.assistant)).toBe(true);
	await persistPiPressureFromMessageEnd({
		db: h.db,
		sessionId: h.sessionId,
		message: h.assistant,
		piContextWindow: 500000,
	});
	const appended = [...h.prefix, ...h.tail];
	h.captureMessages(appended, ["input", "answer", "new-input"]);
	const failedReply = {
		...h.assistant,
		stopReason: "error",
		usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, totalTokens: 0 },
	};
	expect(notePiLkgProviderUsage(h.sessionId, "new-input", failedReply)).toBe(
		false,
	);
	const newTail = [
		failedReply,
		{ role: "user", content: "retry", timestamp: Date.now() + 2 },
	];
	await persistPiPressureFromMessageEnd({
		db: h.db,
		sessionId: h.sessionId,
		message: newTail[1],
		piContextWindow: 500000,
		piTokens: 418211,
		piTokensIsRawBranchEstimate: true,
	});
	expect(getOrCreateSessionMeta(h.db, h.sessionId).lastInputTokens).toBe(
		262355,
	);
	const replay = h.coordinator.replay(
		h.coordinator.beginPass({
			sessionId: h.sessionId,
			messages: [...appended, ...newTail],
			entryIds: ["input", "answer", "new-input", "failed", "retry"],
			modelKey: "anthropic/claude-fable-5-1",
			providerKey: "anthropic",
		}),
		(id) => (id === "answer" ? "input" : "new-input"),
	);
	if (!replay.ok) throw new Error(replay.reason);
	expect(JSON.stringify(replay.messages)).toBe(
		JSON.stringify([...appended, ...newTail]),
	);
	expect(replay.measuredPrefix?.inputTokens).toBe(262355);
	expect(replay.measuredPrefix?.appendedMessages).toEqual([
		...h.tail,
		...newTail,
	]);
	const logs: string[] = [];
	expect(() =>
		assertPiRawFallbackFits(
			replay.messages,
			375000,
			(line) => logs.push(line),
			null,
			h.envelope,
			replay.measuredPrefix,
		),
	).not.toThrow();
	expect(logs.join("\n")).toContain(
		"lkg_fit_basis=provider_input measured_input=262355",
	);
	// The same bytes must still fail closed without a correlated measurement.
	expect(() =>
		assertPiRawFallbackFits(
			replay.messages,
			375000,
			() => {},
			null,
			h.envelope,
		),
	).toThrow();
	const healthy = h.outgoing(appended);
	expect(healthy?.inputTokens).toBe(262355);
	expect(healthy?.appendedMessages).toEqual(h.tail);
	expect(h.outgoing(appended, "wrong-parent")).toBeUndefined();
});

for (const change of ["rewrite", "drop", "envelope"] as const) {
	test(`unmeasured ${change} capture cannot borrow an earlier provider measurement`, () => {
		const h = harness();
		expect(notePiLkgProviderUsage(h.sessionId, "input", h.assistant)).toBe(
			true,
		);
		const messages = [...h.prefix, ...h.tail];
		const ids = ["input", "answer", "new-input"];
		const output = [...messages];
		const outputIds = [...ids];
		if (change === "rewrite")
			output[0] = { role: "user", content: "changed earlier served bytes" };
		if (change === "drop") {
			output.shift();
			outputIds.shift();
		}
		if (change === "envelope") h.envelope.envelopeSignature = "changed-host";
		h.captureMessages(messages, ids, output, outputIds);
		const replay = h.coordinator.replay(
			h.coordinator.beginPass({
				sessionId: h.sessionId,
				messages: [...messages, { role: "user", content: "retry" }],
				entryIds: [...ids, "retry"],
				modelKey: key,
				providerKey: "openai-codex",
			}),
			(id) => (id === "answer" ? "input" : "new-input"),
		);
		if (!replay.ok) throw new Error(replay.reason);
		expect(replay.measuredPrefix).toBeUndefined();
		// Restoring the old bytes cannot resurrect invalidated provider evidence.
		h.captureMessages(messages, ids);
		const restored = h.outgoing(messages);
		expect(restored).toBeUndefined();
	});
}

test("a new correlated provider reply replaces the retained older measurement", () => {
	const h = harness();
	expect(notePiLkgProviderUsage(h.sessionId, "input", h.assistant)).toBe(true);
	const appended = [...h.prefix, ...h.tail];
	h.captureMessages(appended, ["input", "answer", "new-input"]);
	const newReply = {
		...h.assistant,
		timestamp: Date.now() + 1,
		usage: {
			input: 200,
			cacheRead: 20,
			cacheWrite: 10,
			output: 10,
			totalTokens: 240,
		},
	};
	expect(notePiLkgProviderUsage(h.sessionId, "new-input", newReply)).toBe(true);
	const tail = [newReply, { role: "user", content: "next input" }];
	const replay = h.coordinator.replay(
		h.coordinator.beginPass({
			sessionId: h.sessionId,
			messages: [...appended, ...tail],
			entryIds: ["input", "answer", "new-input", "new-answer", "next-input"],
			modelKey: key,
			providerKey: "openai-codex",
		}),
		(id) => (id === "new-answer" ? "new-input" : "input"),
	);
	if (!replay.ok) throw new Error(replay.reason);
	expect(replay.measuredPrefix?.inputTokens).toBe(230);
	expect(replay.measuredPrefix?.appendedMessages).toEqual(tail);
});

test("an over-limit replay without any provider measurement remains fail closed", () => {
	const h = harness("anthropic/claude-fable-5-1", [
		{ role: "user", content: "word ".repeat(310000) },
	]);
	const replay = h.replay();
	if (!replay.ok) throw new Error(replay.reason);
	expect(replay.measuredPrefix).toBeUndefined();
	const logs: string[] = [];
	expect(() =>
		assertPiRawFallbackFits(
			replay.messages,
			375000,
			(line) => logs.push(line),
			null,
			h.envelope,
			replay.measuredPrefix,
		),
	).toThrow();
	expect(logs.join("\n")).toContain(
		"lkg_fit_basis=host_metadata measured_input=0",
	);
	expect(logs.join("\n")).toContain("raw_fallback_over_context_limit");
});

test("changed host metadata cannot borrow the old measured prefix", () => {
	const h = harness();
	notePiLkgProviderUsage(h.sessionId, "input", h.assistant);
	const replay = h.replay();
	if (!replay.ok) throw new Error(replay.reason);
	const changed = {
		...h.envelope,
		envelopeSignature: "changed-system-or-tools",
	};
	const logs: string[] = [];
	// The measured prefix would fit 500 tokens; host metadata pricing does not.
	expect(() =>
		assertPiRawFallbackFits(
			replay.messages,
			500,
			(line) => logs.push(line),
			null,
			changed,
			replay.measuredPrefix,
		),
	).toThrow();
	expect(logs.join("\n")).toContain("lkg_fit_basis=host_metadata");
	expect(() =>
		assertPiRawFallbackFits(
			replay.messages,
			500,
			() => {},
			null,
			h.envelope,
			replay.measuredPrefix,
		),
	).not.toThrow();
});

test("unaccepted, incomplete or older usage cannot become a measured prefix", () => {
	const h = harness();
	for (const message of [
		{ ...h.assistant, stopReason: "error" },
		{ ...h.assistant, stopReason: "aborted" },
		{ ...h.assistant, timestamp: 1 },
		{ ...h.assistant, provider: "another-provider" },
		{ ...h.assistant, usage: { input: 100 } },
	])
		expect(notePiLkgProviderUsage(h.sessionId, "input", message)).toBe(false);
});

for (const flush of [true, false]) {
	test(`unchanged capture preserves provider-measured resend without a database write (deferred commit ${flush ? "flushed" : "pending"})`, () => {
		const h = harness();
		const changes = () => h.db.prepare("SELECT total_changes() AS n").get();
		const before = changes();
		h.recapture(flush);
		h.assistant.timestamp = Date.now() + 1;
		expect(notePiLkgProviderUsage(h.sessionId, "input", h.assistant)).toBe(
			true,
		);
		const replay = h.replay();
		if (!replay.ok) throw new Error(replay.reason);
		expect(replay.measuredPrefix?.inputTokens).toBe(130);
		expect(() =>
			assertPiRawFallbackFits(
				replay.messages,
				5000,
				() => {},
				null,
				h.envelope,
				replay.measuredPrefix,
			),
		).not.toThrow();
		expect(changes()).toEqual(before);
	});
}
