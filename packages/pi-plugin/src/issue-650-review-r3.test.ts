import { afterEach, expect, spyOn, test } from "bun:test";
import {
	encodePiContentDecision,
	PI_CONTENT_DECISION_LIMIT,
} from "@magic-context/core/features/magic-context/pi-content-decisions";
import * as calibration from "@magic-context/core/features/magic-context/session-decision-calibration";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage-meta";
import { saveSourceContent } from "@magic-context/core/features/magic-context/storage-source";
import {
	insertTag,
	updateTagStatus,
} from "@magic-context/core/features/magic-context/storage-tags";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { __test as decisions } from "@magic-context/core/features/magic-context/transform-decision-log";
import {
	dropSlot,
	getSlot,
	resetLkgSlotsForTest,
} from "@magic-context/core/hooks/magic-context/lkg-slot";
import * as logger from "@magic-context/core/shared/logger";
import type { Database } from "@magic-context/core/shared/sqlite";
import {
	__test,
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import * as injection from "./inject-compartments-pi";
import {
	piCachedMessageSurvivor,
	piMessageEntryFingerprint,
} from "./pi-message-identity";
import * as identityRepair from "./pi-tag-identity-repair";
import {
	acknowledgePiIdentityRebuilds,
	readPiIdentityRebuilds,
	readPiIdentityRecurrences,
} from "./pi-tag-identity-repair";
import * as toolIdentity from "./pi-tool-identity";
import { piCachedToolSurvivor } from "./pi-tool-identity";
import { observePiPublicationForTest } from "./publication-observer-fixture.test";
import { piContentFallbackIds } from "./read-session-pi";
import {
	capturePiServedArray,
	clearPiServedArraySession,
} from "./served-array-ledger";
import {
	assistantMessage,
	assistantToolCall,
	createFakePi,
	createTestDb,
	fakeContext,
	heavyReasoningUsage,
	type PiMessage,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

// Each "finding" was pinned as an expected failure (test.failing) by the review
// that found it; the fix made all of them ordinary passing tests.
const sessions: string[] = [];
afterEach(() => {
	resetLkgSlotsForTest();
	decisions.reset();
	for (const id of sessions.splice(0)) {
		clearContextHandlerSession(id);
		clearPiServedArraySession(id);
	}
});
function session(name: string) {
	const id = `650-r3-${name}-${Math.random().toString(36).slice(2)}`;
	sessions.push(id);
	return id;
}
function rows(db: Database, id: string) {
	return db
		.prepare(
			"SELECT tag_number FROM tags WHERE session_id = ? AND type = 'tool' ORDER BY tag_number",
		)
		.all(id);
}
function seedTool(db: Database, id: string) {
	insertTag(db, id, "call", "tool", 100, 8, 0, "codemode", 40, "real");
	insertTag(
		db,
		id,
		"call",
		"tool",
		100,
		154,
		0,
		"codemode",
		40,
		"pi-msg-1-20-assistant",
	);
	updateSessionMeta(db, id, { piStableIdScheme: 1 });
	// Historically served tags 8 and 154 do not prove which tag decorated the
	// call in the most recent request.
	capturePiServedArray(id, [], { servedTagNumbers: [8, 154] });
	clearPiServedArraySession(id);
}
function toolInput(): PiMessage[] {
	return [
		userMessage("first", 1),
		assistantToolCall("call", "codemode", { code: "console.log(1)" }, 20),
		toolResultMessage("call", "1", 21),
		userMessage("next", 22),
	];
}
function adopt(
	db: Database,
	id: string,
	input = toolInput(),
	deferUnprovenRebuild = false,
) {
	return __test.adoptPiFallbackTags(db, id, createTagger(), new Map(), {
		allowUnprovenRebuild: true,
		deferUnprovenRebuild,
		messages: input,
		resolveStableId: (_message: unknown, index: number) =>
			["first", "real", "result", "next"][index],
	});
}
async function turns(db: Database, id: string, count = 3) {
	const input = toolInput();
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, { db, protectedTags: 0 });
	const ctx = fakeContext(
		id,
		process.cwd(),
		["first", "real", "result", "next"],
		input,
	);
	const handler = fake.handlers.get("context")!;
	const served: string[] = [];
	const refused: string[] = [];
	for (let n = 0; n < count; n++) {
		try {
			const result = (await handler(
				{ messages: structuredClone(input) } as never,
				ctx as never,
			)) as { messages: unknown[] };
			served.push(JSON.stringify(result.messages));
		} catch (error) {
			refused.push(String(error));
		}
	}
	return { served, refused };
}
function ledger(db: Database, id: string, entries: string[] | string) {
	db.prepare(
		"UPDATE session_meta SET merged_reasoning_stripped_ids = ? WHERE session_id = ?",
	).run(typeof entries === "string" ? entries : JSON.stringify(entries), id);
}
function blockDecisionWrite(
	db: Database,
	kind: string,
	message = "injected decision write failure",
) {
	// Inject an I/O failure only for the requested decision, not all session
	// writes. Once-guards are written to their own fold-guard row in
	// schema_migrations_meta; every other decision goes to the shared ledger.
	if (kind === "tag-identity-repair-once") {
		for (const event of ["INSERT", "UPDATE"])
			db.exec(
				`CREATE TRIGGER fail_identity_guard_${event} BEFORE ${event} ON schema_migrations_meta WHEN NEW.key LIKE 'pi_identity_fold_guards:%' BEGIN SELECT RAISE(FAIL, '${message}'); END`,
			);
		return;
	}
	db.exec(
		`CREATE TRIGGER fail_identity_decision BEFORE UPDATE OF merged_reasoning_stripped_ids ON session_meta WHEN NEW.merged_reasoning_stripped_ids LIKE '%${kind}%' BEGIN SELECT RAISE(FAIL, '${message}'); END`,
	);
}

test("review 650 r3 partner: an intact ledger serves three turns with one repair", async () => {
	const db = createTestDb();
	const id = session("intact");
	try {
		seedTool(db, id);
		const result = await turns(db, id);
		expect(result.refused).toEqual([]);
		expect(result.served).toHaveLength(3);
		expect(new Set(result.served).size).toBe(1);
		expect(result.served[0]).toContain("§154§ 1");
		expect(rows(db, id)).toEqual([{ tag_number: 154 }]);
	} finally {
		db.close();
	}
});
for (const damaged of [
	"not-json",
	JSON.stringify({ decisions: [] }),
	JSON.stringify([17]),
] as const) {
	test(`review 650 r3 finding: damaged outer ledger ${damaged} must not repeatedly refuse an identity conflict`, async () => {
		const db = createTestDb();
		const id = session("damaged");
		try {
			seedTool(db, id);
			ledger(db, id, damaged);
			const result = await turns(db, id);
			expect(result.refused.length).toBeLessThanOrEqual(1);
			expect(result.served.length).toBeGreaterThanOrEqual(2);
		} finally {
			db.close();
		}
	});
}
for (const kind of [
	"tag-identity-repair-once",
	"tag-identity-repair-pending",
] as const) {
	test(`review 650 r3 finding: failed ${kind} write must serve unmerged rather than repeatedly refuse`, async () => {
		const db = createTestDb();
		const id = session(kind);
		try {
			seedTool(db, id);
			blockDecisionWrite(db, kind);
			const result = await turns(db, id);
			expect(result.refused.length).toBeLessThanOrEqual(1);
			expect(result.served.length).toBeGreaterThanOrEqual(2);
			expect(rows(db, id)).toEqual([{ tag_number: 8 }, { tag_number: 154 }]);
		} finally {
			db.close();
		}
	});
}

test("review 650 r3 partner: damaged pending payload is ignored and three turns are served", async () => {
	const db = createTestDb();
	const id = session("damaged-payload");
	try {
		seedTool(db, id);
		ledger(db, id, [
			encodePiContentDecision("tag-identity-repair-pending", "{broken"),
		]);
		const result = await turns(db, id);
		expect(result.refused).toEqual([]);
		expect(result.served).toHaveLength(3);
	} finally {
		db.close();
	}
});

function fillLedger(db: Database, id: string, count: number) {
	ledger(
		db,
		id,
		Array.from({ length: count }, (_, n) =>
			encodePiContentDecision("tag-identity-repair-once", `spent-${n}`),
		),
	);
}
test("review 650 r3 partner: full and one-free-slot ledgers serve duplicates without an unrecorded repair", async () => {
	for (const count of [
		PI_CONTENT_DECISION_LIMIT,
		PI_CONTENT_DECISION_LIMIT - 1,
	]) {
		const db = createTestDb();
		const id = session(`full-${count}`);
		try {
			seedTool(db, id);
			fillLedger(db, id, count);
			const result = await turns(db, id);
			expect(result.refused).toEqual([]);
			expect(result.served).toHaveLength(3);
			expect(new Set(result.served).size).toBe(1);
			expect(readPiIdentityRebuilds(db, id)).toEqual([]);
			if (count === PI_CONTENT_DECISION_LIMIT) {
				// No room for the pending-rebuild record: the fold is undone. The
				// first unmerged pass serves 8; its new cached proof may fold on
				// pass two.
				expect(result.served[0]).toContain("§8§ 1");
				expect(decisions.getPendingPi(id)?.materializeReason).not.toBe(
					"tag_identity_repair",
				);
			} else {
				// The once-guard is stored in the fold-guard row, so the one free
				// slot holds the pending-rebuild record and the declared repair
				// runs as in an intact ledger.
				expect(result.served[0]).toContain("§154§ 1");
				expect(rows(db, id)).toEqual([{ tag_number: 154 }]);
			}
		} finally {
			db.close();
		}
	}
});
test("review 650 r3 finding: a full ledger must record and log recurrence once, not on every turn", async () => {
	const db = createTestDb();
	const id = session("full-log");
	const log = spyOn(logger, "sessionLog");
	try {
		seedTool(db, id);
		fillLedger(db, id, PI_CONTENT_DECISION_LIMIT);
		// No returned array is captured between these adoption attempts, so neither
		// duplicate number gains proof of being the call's most recently served tag.
		for (let n = 0; n < 3; n++) adopt(db, id);
		expect(rows(db, id)).toEqual([{ tag_number: 8 }, { tag_number: 154 }]);
		expect(
			log.mock.calls.filter(([, line]) =>
				String(line).includes("tag identity recurred after its one repair"),
			),
		).toHaveLength(1);
		expect(readPiIdentityRecurrences(db, id)).toHaveLength(1);
	} finally {
		log.mockRestore();
		db.close();
	}
});

function cachedTool(quotedArguments: boolean): PiMessage[] {
	return [
		userMessage("§155§ first", 1),
		assistantToolCall(
			"call",
			"codemode",
			{
				code: quotedArguments
					? "console.log('[dropped §8§]')"
					: "console.log('§8§')",
			},
			20,
		),
		toolResultMessage("call", "§154§ 1", 21),
		userMessage("§156§ next", 22),
	];
}
test("review 650 r3 partner: a bare tag quote in model arguments does not veto the proven tool survivor", () => {
	const db = createTestDb();
	const id = session("bare-argument-quote");
	try {
		seedTool(db, id);
		capturePiServedArray(id, cachedTool(false), { servedTagNumbers: [8, 154] });
		expect(
			piCachedToolSurvivor(id, "call", 20, [
				{ tagNumber: 8, status: "active" },
				{ tagNumber: 154, status: "active" },
			]),
		).toBe(154);
		expect(adopt(db, id).rebuilds).toEqual([]);
		expect(rows(db, id)).toEqual([{ tag_number: 154 }]);
	} finally {
		db.close();
	}
});
test("review 650 r3 finding: a dropped receipt quoted inside model arguments must not trigger an unproven repair", () => {
	const db = createTestDb();
	const id = session("dropped-argument-quote");
	try {
		seedTool(db, id);
		capturePiServedArray(id, cachedTool(true), { servedTagNumbers: [8, 154] });
		const outcome = adopt(db, id);
		expect(rows(db, id)).toEqual([{ tag_number: 154 }]);
		expect(outcome.rebuilds).toEqual([]);
	} finally {
		db.close();
	}
});

function seedMessage(db: Database, id: string, dropped: boolean) {
	const message = userMessage("original source", 1);
	const fp = piMessageEntryFingerprint(message)!;
	insertTag(db, id, "real:p0", "message", 30, 20, 0, null, 20, null, fp);
	insertTag(
		db,
		id,
		"pi-msg-0-1-user:p0",
		"message",
		30,
		440,
		0,
		null,
		20,
		null,
		fp,
	);
	for (const number of [20, 440])
		saveSourceContent(db, id, number, "original source");
	if (dropped) updateTagStatus(db, id, 20, "dropped");
	updateSessionMeta(db, id, { piStableIdScheme: 1 });
	capturePiServedArray(
		id,
		[
			userMessage(dropped ? "[dropped §20§]" : "§20§ original source", 1),
			assistantMessage("§441§ prior", 2),
			userMessage("§442§ next", 3),
		],
		{ servedTagNumbers: [20, 440] },
	);
	return fp;
}
function adoptMessage(db: Database, id: string, fp: string) {
	return __test.adoptPiFallbackTags(
		db,
		id,
		createTagger(),
		new Map([["real", fp]]),
		{
			allowUnprovenRebuild: true,
		},
	);
}
test("review 650 r3 partner: an active cached message keeps the older proven number, not newest 440", () => {
	const db = createTestDb();
	const id = session("active-message");
	try {
		const fp = seedMessage(db, id, false);
		expect(
			piCachedMessageSurvivor(id, fp, 0, [
				{ tagNumber: 20, status: "active" },
				{ tagNumber: 440, status: "active" },
			]),
		).toBe(20);
		expect(adoptMessage(db, id, fp).rebuilds).toEqual([]);
		expect(
			db
				.prepare("SELECT tag_number, status FROM tags WHERE session_id = ?")
				.all(id),
		).toEqual([{ tag_number: 20, status: "active" }]);
	} finally {
		db.close();
	}
});
test("review 650 r3 finding: a cached dropped message must keep proven 20 without rebuilding to 440", () => {
	const db = createTestDb();
	const id = session("dropped-message");
	try {
		const fp = seedMessage(db, id, true);
		const outcome = adoptMessage(db, id, fp);
		expect(
			db
				.prepare("SELECT tag_number, status FROM tags WHERE session_id = ?")
				.all(id),
		).toEqual([{ tag_number: 20, status: "dropped" }]);
		expect(outcome.rebuilds).toEqual([]);
	} finally {
		db.close();
	}
});

function repairThenAdopt(db: Database, id: string, targetReal: boolean) {
	const message = userMessage("host-built context note", 7);
	const fingerprint = piMessageEntryFingerprint(message)!;
	const [fallback] = piContentFallbackIds([message], () => undefined);
	for (const [messageId, number] of [
		["pi-msg-0-7-user:p0", 20],
		[`${fallback}:p0`, 440],
	] as const) {
		insertTag(
			db,
			id,
			messageId,
			"message",
			40,
			number,
			0,
			null,
			20,
			null,
			fingerprint,
		);
	}
	capturePiServedArray(id, [], { servedTagNumbers: [20, 440] });
	clearPiServedArraySession(id);
	const first = __test.adoptPiFallbackTags(
		db,
		id,
		createTagger(),
		new Map([[fallback!, fingerprint]]),
		{ allowUnprovenRebuild: true },
	);
	expect(first.rebuilds).toHaveLength(1);
	acknowledgePiIdentityRebuilds(db, id);
	insertTag(
		db,
		id,
		targetReal ? "real:p0" : "pi-msg-3-7-user:p0",
		"message",
		40,
		600,
		0,
		null,
		20,
		null,
		fingerprint,
	);
	capturePiServedArray(id, [], { servedTagNumbers: [600] });
	clearPiServedArraySession(id);
	return __test.adoptPiFallbackTags(
		db,
		id,
		createTagger(),
		new Map([[targetReal ? "real" : fallback!, fingerprint]]),
		{ allowUnprovenRebuild: true },
	);
}
test("review 650 r3 partner: a recurring message with the same fallback key gets no second repair", () => {
	const db = createTestDb();
	const id = session("same-message-key");
	try {
		expect(repairThenAdopt(db, id, false).rebuilds).toEqual([]);
		expect(readPiIdentityRecurrences(db, id)).toHaveLength(1);
	} finally {
		db.close();
	}
});
test("review 650 r3 finding: a repaired fallback message gaining a real entry id must not buy a second rebuild", () => {
	const db = createTestDb();
	const id = session("new-message-key");
	try {
		expect(repairThenAdopt(db, id, true).rebuilds).toEqual([]);
		expect(readPiIdentityRecurrences(db, id)).toHaveLength(1);
	} finally {
		db.close();
	}
});

test("review 650 r3 finding: a proven dropped message changes cached bytes on the next turn", async () => {
	const db = createTestDb();
	const id = session("dropped-message-turn");
	try {
		seedMessage(db, id, true);
		const cached = JSON.stringify([
			userMessage("[dropped §20§]", 1),
			assistantMessage("§441§ prior", 2),
			userMessage("§442§ next", 3),
		]);
		const input = [
			userMessage("original source", 1),
			assistantMessage("prior", 2),
			userMessage("next", 3),
		];
		const fake = createFakePi();
		registerPiContextHandler(fake.pi as never, { db, protectedTags: 0 });
		const result = (await fake.handlers.get("context")!(
			{ messages: structuredClone(input) } as never,
			fakeContext(id, process.cwd(), ["real", "prior", "next"], input) as never,
		)) as { messages: unknown[] };
		expect(JSON.stringify(result.messages)).toBe(cached);
		expect(decisions.getPendingPi(id)?.materializeReason).not.toBe(
			"tag_identity_repair",
		);
	} finally {
		db.close();
	}
});
for (const kind of [
	"tag-identity-repair-once",
	"tag-identity-repair-pending",
] as const) {
	test(`review 650 r3 partner: a busy ${kind} write leaves rows unmerged without refusing`, () => {
		const db = createTestDb();
		const id = session(`busy-${kind}`);
		try {
			seedTool(db, id);
			blockDecisionWrite(db, kind, "database is locked");
			expect(adopt(db, id).rebuilds).toEqual([]);
			expect(rows(db, id)).toEqual([{ tag_number: 8 }, { tag_number: 154 }]);
		} finally {
			db.close();
		}
	});
}

async function rewindUnsavedNotes(identical: boolean) {
	const db = createTestDb();
	const id = session(identical ? "twin-rewind" : "distinct-rewind");
	const publication = observePiPublicationForTest(id);
	try {
		updateSessionMeta(db, id, { piStableIdScheme: 1 });
		const first = userMessage("host-built note", 7);
		const second = userMessage(
			identical ? "host-built note" : "other host-built note",
			7,
		);
		const hello = userMessage("hello", 10);
		const fake = createFakePi();
		registerPiContextHandler(fake.pi as never, { db, protectedTags: 0 });
		const ctx = fakeContext(id, process.cwd(), ["hello"], [hello]);
		const handler = fake.handlers.get("context")!;
		const before = (await handler(
			{ messages: [first, second, hello] } as never,
			ctx as never,
		)) as { messages: PiMessage[] };
		if (identical)
			publication.expect("numbers_only", "lkg_duplicate_entry_id", 1);
		const fallbackIds = piContentFallbackIds([first, second], () => undefined);
		const dropped = db
			.prepare(
				"SELECT tag_number FROM tags WHERE session_id = ? AND message_id = ?",
			)
			.get(id, `${fallbackIds[0]}:p0`) as { tag_number: number };
		updateTagStatus(db, id, dropped.tag_number, "dropped");
		// Rebuild the message list without the first occurrence but keep the second;
		// the tag previously served for that second occurrence is still active.
		const after = (await handler(
			{ messages: [structuredClone(second), hello] } as never,
			ctx as never,
		)) as { messages: PiMessage[] };
		return { expected: before.messages[1], actual: after.messages[0] };
	} finally {
		publication.restore();
		db.close();
	}
}
test("review 650 r3 partner: removing an unrelated unsaved note does not change the surviving note", async () => {
	const result = await rewindUnsavedNotes(false);
	expect(result.actual).toEqual(result.expected);
});
test("review 650 r3 finding: removing the first identical unsaved note must not transfer its dropped tag to the second", async () => {
	const result = await rewindUnsavedNotes(true);
	expect(result.actual).toEqual(result.expected);
});

test("held unproven tool repair waits for a permitted prefix rebuild", () => {
	const db = createTestDb();
	const id = session("held-repair");
	try {
		seedTool(db, id);
		for (let pass = 0; pass < 2; pass++) {
			expect(adopt(db, id, toolInput(), true).rebuilds).toEqual([]);
			expect(rows(db, id)).toEqual([{ tag_number: 8 }, { tag_number: 154 }]);
		}
		expect(adopt(db, id).rebuilds).toHaveLength(1);
		expect(rows(db, id)).toEqual([{ tag_number: 154 }]);
	} finally {
		db.close();
	}
});

for (const proof of [
	"replayable LKG",
	"missing LKG",
	"unpriceable LKG",
] as const) {
	test(`carried identity repair with ${proof} preserves the hold or pays one declared bust`, async () => {
		const db = createTestDb();
		const id = session(`carried-${proof}`);
		getOrCreateSessionMeta(db, id);
		updateSessionMeta(db, id, {
			piStableIdScheme: 1,
			lastResponseTime: Date.now(),
			cacheTtl: "13h",
		});
		insertTag(db, id, "call", "tool", 100, 8, 0, "codemode", 40, "real");
		const call = assistantToolCall(
			"call",
			"codemode",
			{ code: "console.log(1)" },
			20,
		);
		Object.assign(call, {
			provider: "anthropic",
			model: "claude-opus-5-5",
			api: "anthropic-messages",
			// A heavy step, so the bounded hold keeps this turn's prefix.
			usage: heavyReasoningUsage(),
		});
		(call.content as unknown[]).unshift({
			type: "thinking",
			thinking: "immutable thought",
			thinkingSignature: "signed",
		});
		const source = [
			userMessage("first", 1),
			call,
			toolResultMessage("call", "1", 21),
		];
		const ids = ["first", "real", "result"];
		const fake = createFakePi();
		Object.assign(fake.pi, {
			getAllTools: () => [
				{
					name: "codemode",
					description: "Run code",
					parameters: {
						type: "object",
						properties: { code: { type: "string" } },
					},
				},
				// Magic Context registers ctx_reduce, so the session can call it.
				{
					name: "ctx_reduce",
					description: "Mark tags for dropping",
					parameters: {
						type: "object",
						properties: { drop: { type: "string" } },
					},
				},
			],
			getActiveTools: () => ["codemode", "ctx_reduce"],
		});
		registerPiContextHandler(fake.pi as never, {
			db,
			tagger: createTagger(),
			protectedTokens: 4000,
			injection: {
				injectionBudgetTokens: 1000,
				memoryEnabled: false,
				injectDocs: false,
			},
			heuristics: { keepReasoningTokens: 10000 },
			scheduler: { executeThresholdPercentage: 65 },
		});
		const handler = fake.handlers.get("context")!;
		const serve = async (warm = false) => {
			const messages = structuredClone(warm ? source.slice(0, 1) : source);
			const ctx = {
				...fakeContext(
					id,
					process.cwd(),
					warm ? ids.slice(0, 1) : ids,
					messages,
				),
				getSystemPrompt: () => "Use codemode to run code for the current task.",
				model: {
					provider: "anthropic",
					id: "claude-opus-5-5",
					api: "anthropic-messages",
					contextWindow: 100000,
				},
				getContextUsage: () => ({
					tokens: 66000,
					percent: 66,
					contextWindow: 100000,
				}),
			};
			return (
				(await handler({ messages } as never, ctx as never)) as {
					messages: unknown[];
				}
			).messages;
		};
		const resultText = (messages: unknown[]) =>
			JSON.stringify(
				messages.find(
					(message) =>
						(message as { toolCallId?: string }).toolCallId === "call",
				),
			);
		try {
			await serve(true);
			const baseline = await serve();
			expect(resultText(baseline)).toContain("§8§");
			expect(getSlot(id)).toBeDefined();
			// Simulate a writer without cached survivor proof committing tag 154
			// in place of tag 8, without ever serving that new number to Pi.
			insertTag(
				db,
				id,
				"call",
				"tool",
				100,
				154,
				0,
				"codemode",
				40,
				"pi-msg-1-20-assistant",
			);
			capturePiServedArray(id, baseline, { servedTagNumbers: [8, 154] });
			const otherWriterProof = spyOn(
				toolIdentity,
				"piCachedToolSurvivor",
			).mockReturnValue(undefined);
			try {
				expect(adopt(db, id).rebuilds).toHaveLength(1);
			} finally {
				otherWriterProof.mockRestore();
			}
			expect(rows(db, id)).toEqual([{ tag_number: 154 }]);
			if (proof === "missing LKG")
				dropSlot(id, "test-missing-carried-repair-proof");
			if (proof === "unpriceable LKG")
				Object.assign(fake.pi, { getAllTools: () => undefined });
			source.push(
				assistantMessage("NEW RAW TAIL", 22, {
					provider: "anthropic",
					model: "claude-opus-5-5",
				}),
			);
			ids.push("tail");
			const pairBefore = [
				getOrCreateSessionMeta(db, id).cachedM0Bytes?.toString(),
				getOrCreateSessionMeta(db, id).cachedM1Bytes?.toString(),
			];
			const ack = spyOn(identityRepair, "acknowledgePiIdentityRebuilds");
			const clear = spyOn(injection, "clearM0M1PiCache");
			const calibrate = spyOn(calibration, "sessionDecisionCalibration");
			const logs = spyOn(logger, "sessionLog");
			try {
				const first = await serve();
				const second = await serve();
				expect(JSON.stringify(second)).toBe(JSON.stringify(first));
				const identityCalibration = () =>
					calibrate.mock.calls.filter(
						(args) => args[2]?.bustReason === "tag_identity_repair",
					);
				if (proof === "replayable LKG") {
					expect(JSON.stringify(first.slice(0, baseline.length))).toBe(
						JSON.stringify(baseline),
					);
					expect(resultText(first)).toContain("§8§");
					expect(JSON.stringify(first)).toContain("NEW RAW TAIL");
					expect(readPiIdentityRebuilds(db, id)).toHaveLength(1);
					expect(ack).not.toHaveBeenCalled();
					expect(clear).not.toHaveBeenCalled();
					expect(identityCalibration()).toHaveLength(0);
					expect([
						getOrCreateSessionMeta(db, id).cachedM0Bytes?.toString(),
						getOrCreateSessionMeta(db, id).cachedM1Bytes?.toString(),
					]).toEqual(pairBefore);
					source.push(userMessage("next real user", 23));
					ids.push("next");
					expect(resultText(await serve())).toContain("§154§");
				} else {
					expect(JSON.stringify(first)).not.toContain("thinkingSignature");
					expect(resultText(first)).toContain("§154§");
					expect(resultText(first)).not.toContain("§8§");
				}
				expect(readPiIdentityRebuilds(db, id)).toHaveLength(0);
				expect(ack).toHaveBeenCalledTimes(1);
				expect(clear).toHaveBeenCalledTimes(1);
				expect(identityCalibration()).toHaveLength(1);
			} finally {
				ack.mockRestore();
				clear.mockRestore();
				calibrate.mockRestore();
				logs.mockRestore();
			}
		} finally {
			db.close();
		}
	});
}
