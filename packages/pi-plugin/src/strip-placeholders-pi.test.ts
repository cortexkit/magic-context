import { describe, expect, it } from "bun:test";
import {
	getStrippedPlaceholderIds,
	setStrippedPlaceholderIds,
} from "@magic-context/core/features/magic-context/storage";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import markerParity from "../../../testdata/marker-only-parity.json";
import {
	isPiMarkerOnlyText,
	stripPiDroppedPlaceholderMessages,
} from "./strip-placeholders-pi";
import { assistantMessage, createTestDb, userMessage } from "./test-utils.test";

describe("stripPiDroppedPlaceholderMessages", () => {
	for (const text of [
		"[dropped ]",
		"[dropped  ]",
		"[dropped 42]",
		"[dropped\t]",
		"[dropped\n]",
		"[dropped §§]",
		"§775§ [dropped ]",
		"§775§ [dropped ]\n[dropped §12§]",
	]) {
		it(`removes a model-written blank or numeric dropped marker: ${JSON.stringify(text)}`, () => {
			const db = createTestDb();
			try {
				const messages = [
					userMessage("continue", 1),
					assistantMessage(text, 2),
				];
				expect(
					stripPiDroppedPlaceholderMessages({
						db,
						sessionId: "ses-blank-tag",
						messages,
						isCacheBusting: true,
					}),
				).toEqual({ removed: 1, discovered: 1 });
				expect(messages).toEqual([userMessage("continue", 1)]);
				expect(isPiMarkerOnlyText(text)).toBe(true);
			} finally {
				closeQuietly(db);
			}
		});
	}

	for (const content of [
		[{ type: "text", text: "Done. [dropped ]" }],
		[{ type: "text", text: "```\n[dropped ]\n```" }],
		[
			{ type: "text", text: "[dropped ]" },
			{ type: "toolCall", id: "call", name: "run", arguments: {} },
		],
		[
			{ type: "text", text: "[dropped ]" },
			{ type: "thinking", thinking: "Let me check the source." },
		],
	]) {
		it(`keeps blank dropped markers accompanied by content: ${JSON.stringify(content)}`, () => {
			const db = createTestDb();
			try {
				const messages = [assistantMessage("keep", 2, { content })];
				const wire = JSON.stringify(messages);
				expect(
					stripPiDroppedPlaceholderMessages({
						db,
						sessionId: "ses-keep-blank-tag",
						messages,
						isCacheBusting: true,
					}),
				).toEqual({ removed: 0, discovered: 0 });
				expect(JSON.stringify(messages)).toBe(wire);
			} finally {
				closeQuietly(db);
			}
		});
	}

	it("classifies the shared marker-only parity examples", () => {
		for (const text of markerParity.positive)
			expect(isPiMarkerOnlyText(text)).toBe(true);
		for (const text of markerParity.negative)
			expect(isPiMarkerOnlyText(text)).toBe(false);
	});

	it("removes shared blank and marker part combinations", () => {
		const db = createTestDb();
		try {
			for (const [index, parts] of [
				...markerParity.positivePartCombinations,
				...markerParity.positive.map((text) => [text]),
			].entries()) {
				const assistant = assistantMessage("marker", index + 2, {
					content: parts.map((text) => ({ type: "text", text })),
				});
				const messages = [userMessage("continue", 1), assistant];
				expect(
					stripPiDroppedPlaceholderMessages({
						db,
						sessionId: `ses-mixed-${index}`,
						messages,
						isCacheBusting: true,
					}),
				).toEqual({ removed: 1, discovered: 1 });
				expect(messages).not.toContain(assistant);
			}
			const messages = [
				userMessage("continue", 1),
				assistantMessage("blank", 2, { content: " \t" }),
			];
			expect(
				stripPiDroppedPlaceholderMessages({
					db,
					sessionId: "ses-blank-string",
					messages,
					isCacheBusting: true,
				}),
			).toEqual({ removed: 1, discovered: 1 });
		} finally {
			closeQuietly(db);
		}
	});

	it("removes marker-only text and thinking but retains tool-bearing replies", () => {
		const db = createTestDb();
		try {
			const marker = assistantMessage("marker", 2, {
				content: [
					{ type: "text", text: "§672§ [dropped §672§]" },
					{ type: "thinking", thinking: "[cleared]" },
				],
			});
			const tool = assistantMessage("tool", 3, {
				content: [
					{ type: "text", text: "[cleared]" },
					{ type: "toolCall", id: "call", name: "run", arguments: {} },
				],
			});
			const messages = [userMessage("continue", 1), marker, tool];
			expect(
				stripPiDroppedPlaceholderMessages({
					db,
					sessionId: "ses-thinking-marker",
					messages,
					isCacheBusting: true,
				}),
			).toEqual({ removed: 1, discovered: 1 });
			expect(messages).toContain(tool);
			expect(messages).not.toContain(marker);
		} finally {
			closeQuietly(db);
		}
	});

	it("defers a new blank-tag marker byte-identically until the next rebuild", () => {
		const db = createTestDb();
		try {
			const first = [
				userMessage("continue", 1),
				assistantMessage("§672§ [dropped §672§]", 2),
			];
			const bust = stripPiDroppedPlaceholderMessages({
				db,
				sessionId: "ses-marker",
				messages: first,
				isCacheBusting: true,
			});
			expect(bust).toEqual({ removed: 1, discovered: 1 });
			const appended = assistantMessage("§775§ [dropped ]", 3);
			const deferWire = JSON.stringify([...first, appended]);
			const replay = [
				userMessage("continue", 1),
				assistantMessage("§672§ [dropped §672§]", 2),
				structuredClone(appended),
			];
			const prefix = JSON.stringify(first);
			const defer = stripPiDroppedPlaceholderMessages({
				db,
				sessionId: "ses-marker",
				messages: replay,
				isCacheBusting: false,
			});
			expect(defer).toEqual({ removed: 1, discovered: 0 });
			expect(JSON.stringify(replay.slice(0, first.length))).toBe(prefix);
			expect(JSON.stringify(replay)).toBe(deferWire);
			expect(replay).toHaveLength(2);
			expect(getStrippedPlaceholderIds(db, "ses-marker").size).toBe(1);

			const rebuilt = [
				userMessage("continue", 1),
				assistantMessage("§672§ [dropped §672§]", 2),
				structuredClone(appended),
			];
			expect(
				stripPiDroppedPlaceholderMessages({
					db,
					sessionId: "ses-marker",
					messages: rebuilt,
					isCacheBusting: true,
				}),
			).toEqual({ removed: 2, discovered: 1 });
			expect(rebuilt).toEqual(first);
			expect(getStrippedPlaceholderIds(db, "ses-marker").size).toBe(2);
		} finally {
			closeQuietly(db);
		}
	});
	it("discovers and removes ONLY assistant placeholder-only messages, never user-role", () => {
		const db = createTestDb();
		try {
			// A user message reduced to only [dropped §N§] must NOT be removed:
			// user messages anchor turn boundaries (parity with OpenCode's
			// strip-content "Never neutralize user-role messages"). Only the
			// assistant placeholder is stripped.
			const messages = [
				userMessage("keep", 1),
				assistantMessage("[dropped §2§]", 2),
				userMessage([{ type: "text", text: "[dropped §3§]" }], 3),
				assistantMessage("real answer", 4),
			];

			const result = stripPiDroppedPlaceholderMessages({
				db,
				sessionId: "ses-placeholders",
				messages,
				isCacheBusting: true,
			});

			// Only the assistant placeholder (#2) is removed; the all-[dropped]
			// USER message (#3) is preserved.
			expect(result).toEqual({ removed: 1, discovered: 1 });
			expect(messages.map((m) => (m as { role: string }).role)).toEqual([
				"user",
				"user",
				"assistant",
			]);
			expect(
				(messages[1] as { content: { text: string }[] }).content[0].text,
			).toBe("[dropped §3§]");
			expect(getStrippedPlaceholderIds(db, "ses-placeholders").size).toBe(1);
		} finally {
			closeQuietly(db);
		}
	});

	it("does not recognize the stripped-image marker as a dropped sentinel", () => {
		const db = createTestDb();
		try {
			const marker = assistantMessage("[image stripped]", 2);
			const messages = [userMessage("keep", 1), marker];
			const result = stripPiDroppedPlaceholderMessages({
				db,
				sessionId: "ses-image-marker",
				messages,
				isCacheBusting: true,
			});

			expect(result).toEqual({ removed: 0, discovered: 0 });
			expect(messages).toContain(marker);
		} finally {
			closeQuietly(db);
		}
	});

	it("replays persisted stripping on defer passes without discovering new ids", () => {
		const db = createTestDb();
		try {
			const first = [
				userMessage("keep", 1),
				assistantMessage("[dropped §2§]", 2),
			];
			stripPiDroppedPlaceholderMessages({
				db,
				sessionId: "ses-placeholders",
				messages: first,
				isCacheBusting: true,
			});

			const replay = [
				userMessage("keep", 1),
				assistantMessage("[dropped §2§]", 2),
				assistantMessage("[dropped §3§]", 3),
			];
			const result = stripPiDroppedPlaceholderMessages({
				db,
				sessionId: "ses-placeholders",
				messages: replay,
				isCacheBusting: false,
			});

			expect(result).toEqual({ removed: 1, discovered: 0 });
			expect(replay).toHaveLength(2);
		} finally {
			closeQuietly(db);
		}
	});

	it("leaves newly discovered placeholders in place when durable CAS persistence fails", () => {
		const db = createTestDb();
		try {
			const runPass = () => {
				const placeholder = assistantMessage("[dropped §2§]", 2);
				const messages = [userMessage("keep", 1), placeholder];
				const stableIdByRef = new Map<object, string>([
					[messages[0] as object, "entry-keep"],
					[placeholder as object, "entry-placeholder"],
				]);
				const result = stripPiDroppedPlaceholderMessages({
					db,
					sessionId: "ses-cas-failure",
					messages,
					isCacheBusting: true,
					stableIdByRef,
					applyDelta: () => false,
				});
				return { result, wire: JSON.stringify(messages) };
			};

			const first = runPass();
			const second = runPass();
			expect(first.result).toEqual({ removed: 0, discovered: 0 });
			expect(second.wire).toBe(first.wire);
			expect(getStrippedPlaceholderIds(db, "ses-cas-failure").size).toBe(0);
		} finally {
			closeQuietly(db);
		}
	});

	it("prunes below-boundary ids from the persisted set on cache-busting passes", () => {
		const db = createTestDb();
		try {
			// Pass 1: discover two placeholders under real carried ids.
			const phA = assistantMessage("[dropped §2§]", 2);
			const phB = assistantMessage("[dropped §3§]", 3);
			const pass1 = [userMessage("keep", 1), phA, phB];
			const map1 = new Map<object, string>([
				[pass1[0] as object, "entry-keep"],
				[phA as object, "entry-A"],
				[phB as object, "entry-B"],
			]);
			stripPiDroppedPlaceholderMessages({
				db,
				sessionId: "ses-prune",
				messages: pass1,
				isCacheBusting: true,
				stableIdByRef: map1,
			});
			expect(getStrippedPlaceholderIds(db, "ses-prune").size).toBe(2);

			// Pass 2 (cache-busting): entry-A has fallen below the compaction
			// boundary (no longer in the window); only entry-B remains present.
			// The persisted set must prune entry-A.
			const phB2 = assistantMessage("[dropped §3§]", 3);
			const pass2 = [userMessage("keep", 1), phB2];
			const map2 = new Map<object, string>([
				[pass2[0] as object, "entry-keep"],
				[phB2 as object, "entry-B"],
			]);
			stripPiDroppedPlaceholderMessages({
				db,
				sessionId: "ses-prune",
				messages: pass2,
				isCacheBusting: true,
				stableIdByRef: map2,
			});
			const remaining = getStrippedPlaceholderIds(db, "ses-prune");
			expect(remaining.has("entry-B")).toBe(true);
			expect(remaining.has("entry-A")).toBe(false); // pruned below-boundary
			expect(remaining.size).toBe(1);
		} finally {
			closeQuietly(db);
		}
	});

	it("does NOT prune on defer passes (storage-only GC gated to cache-busting)", () => {
		const db = createTestDb();
		try {
			const phA = assistantMessage("[dropped §2§]", 2);
			const pass1 = [userMessage("keep", 1), phA];
			const map1 = new Map<object, string>([
				[pass1[0] as object, "entry-keep"],
				[phA as object, "entry-A"],
			]);
			stripPiDroppedPlaceholderMessages({
				db,
				sessionId: "ses-defer-noprune",
				messages: pass1,
				isCacheBusting: true,
				stableIdByRef: map1,
			});
			expect(
				getStrippedPlaceholderIds(db, "ses-defer-noprune").has("entry-A"),
			).toBe(true);

			// Defer pass where entry-A is absent — must NOT prune (defer passes
			// never mutate persisted replay state).
			const pass2 = [userMessage("keep", 1)];
			const map2 = new Map<object, string>([
				[pass2[0] as object, "entry-keep"],
			]);
			stripPiDroppedPlaceholderMessages({
				db,
				sessionId: "ses-defer-noprune",
				messages: pass2,
				isCacheBusting: false,
				stableIdByRef: map2,
			});
			expect(
				getStrippedPlaceholderIds(db, "ses-defer-noprune").has("entry-A"),
			).toBe(true);
		} finally {
			closeQuietly(db);
		}
	});

	it("uses the carried-id map by object-ref and survives an index shift", () => {
		const db = createTestDb();
		try {
			// Pass 1: discover under a real entry id carried by object-ref.
			const placeholder = assistantMessage("[dropped §9§]", 2);
			const pass1 = [userMessage("keep", 1), placeholder];
			const map1 = new Map<object, string>([
				[pass1[0] as object, "entry-keep"],
				[placeholder as object, "entry-PH"],
			]);
			const r1 = stripPiDroppedPlaceholderMessages({
				db,
				sessionId: "ses-carry",
				messages: pass1,
				isCacheBusting: true,
				stableIdByRef: map1,
			});
			expect(r1).toEqual({ removed: 1, discovered: 1 });
			// Persisted under the REAL id, not pi-msg-*.
			expect(getStrippedPlaceholderIds(db, "ses-carry").has("entry-PH")).toBe(
				true,
			);

			// Pass 2 (defer): the SAME placeholder object now sits at a DIFFERENT
			// index (prefix grew), and a synthetic m[0] prepend (NOT in the map) is
			// at the head. Removal must still strip the placeholder by object-ref
			// and SKIP the unmapped synthetic prepend.
			const syntheticPrepend = userMessage("<session-history>…", 0);
			const pass2 = [
				syntheticPrepend,
				userMessage("newer", 3),
				userMessage("keep", 1),
				placeholder,
			];
			const map2 = new Map<object, string>([
				[pass2[1] as object, "entry-newer"],
				[pass2[2] as object, "entry-keep"],
				[placeholder as object, "entry-PH"],
				// syntheticPrepend deliberately absent → skip-on-miss.
			]);
			const r2 = stripPiDroppedPlaceholderMessages({
				db,
				sessionId: "ses-carry",
				messages: pass2,
				isCacheBusting: false,
				stableIdByRef: map2,
			});
			expect(r2.removed).toBe(1); // only the placeholder
			expect(pass2).not.toContain(placeholder);
			expect(pass2).toContain(syntheticPrepend); // unmapped → never stripped
		} finally {
			closeQuietly(db);
		}
	});
});

describe("stripPiDroppedPlaceholderMessages never removes a tool call owner", () => {
	const owner = (id: string, t: number) =>
		assistantMessage("", t, {
			content: [
				{ type: "thinking", thinking: "" },
				{ type: "toolCall", id, name: "read", arguments: {} },
			],
		});
	const result = (id: string, t: number) =>
		({
			role: "toolResult",
			toolCallId: id,
			toolName: "read",
			content: [{ type: "text", text: `[dropped §${t}§]` }],
			isError: false,
			timestamp: t,
		}) as never;
	const build = () => {
		const messages = [
			userMessage("go", 1),
			owner("call-a", 2),
			result("call-a", 3),
			assistantMessage("", 4, {
				content: [{ type: "thinking", thinking: "" }],
			}),
			userMessage("next", 5),
		] as object[];
		const ids = new Map(messages.map((m, i) => [m, `entry-${i}`] as const));
		return { messages: messages as unknown[], ids };
	};
	const idsOf = (built: ReturnType<typeof build>) =>
		built.messages.map((m) => built.ids.get(m as object));

	it("keeps a frozen message that owns a live tool call on a defer pass and keeps its id", () => {
		const db = createTestDb();
		try {
			// entry-1 was frozen while its call was absent; entry-3 is a real placeholder.
			setStrippedPlaceholderIds(
				db,
				"ses-owner",
				new Set(["entry-1", "entry-3"]),
			);
			const built = build();
			stripPiDroppedPlaceholderMessages({
				db,
				sessionId: "ses-owner",
				messages: built.messages,
				isCacheBusting: false,
				canFirstApply: false,
				stableIdByRef: built.ids,
			});
			expect(idsOf(built)).toEqual([
				"entry-0",
				"entry-1",
				"entry-2",
				"entry-4",
			]);
			expect(getStrippedPlaceholderIds(db, "ses-owner")).toEqual(
				new Set(["entry-1", "entry-3"]),
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("forgets a poisoned id on a busting pass and keeps replaying the genuine one", () => {
		const db = createTestDb();
		try {
			setStrippedPlaceholderIds(
				db,
				"ses-heal",
				new Set(["entry-1", "entry-3"]),
			);
			const busting = build();
			stripPiDroppedPlaceholderMessages({
				db,
				sessionId: "ses-heal",
				messages: busting.messages,
				isCacheBusting: false,
				canFirstApply: true,
				stableIdByRef: busting.ids,
			});
			expect(idsOf(busting)).toEqual([
				"entry-0",
				"entry-1",
				"entry-2",
				"entry-4",
			]);
			expect(getStrippedPlaceholderIds(db, "ses-heal")).toEqual(
				new Set(["entry-3"]),
			);
			const defer = build();
			stripPiDroppedPlaceholderMessages({
				db,
				sessionId: "ses-heal",
				messages: defer.messages,
				isCacheBusting: false,
				stableIdByRef: defer.ids,
			});
			expect(idsOf(defer)).toEqual(idsOf(busting));
		} finally {
			closeQuietly(db);
		}
	});
});
