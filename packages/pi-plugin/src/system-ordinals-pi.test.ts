import { describe, expect, it } from "bun:test";
import {
	appendCompartments,
	getCompartments,
	getLastCompartmentEndMessage,
} from "@magic-context/core/features/magic-context/compartment-storage";
import { validateChunkCoverage } from "@magic-context/core/hooks/magic-context/compartment-runner-validation";
import {
	readSessionChunk,
	withRawMessageProvider,
} from "@magic-context/core/hooks/magic-context/read-session-chunk";
import entries from "./fixtures/system-ordinals-pi.input.json";
import golden from "./fixtures/system-ordinals-pi.master.json";
import { __test } from "./inject-compartments-pi";
import { findFirstKeptEntryId } from "./pi-historian-runner";
import {
	convertEntriesToRawMessagePage,
	convertEntriesToRawMessages,
} from "./read-session-pi";
import { createTestDb, fakeContext } from "./test-utils.test";
import { createCtxExpandTool } from "./tools/ctx-expand";

describe("Pi canonical system ordinals", () => {
	it("matches the real master converter golden with two interleaved system entries", () => {
		expect(JSON.stringify(convertEntriesToRawMessages(entries))).toBe(
			JSON.stringify(golden.rawMessages),
		);
		const last = golden.rawMessages.at(-1);
		if (!last) throw new Error("missing golden watermark");
		for (let after = 0; after < last.ordinal; after++) {
			const positions = (
				messages: readonly { ordinal: number; id: string; role: string }[],
			) => messages.map(({ ordinal, id, role }) => ({ ordinal, id, role }));
			expect(
				positions(
					convertEntriesToRawMessagePage(entries, after, 2, last.ordinal),
				),
			).toEqual(
				positions(
					golden.rawMessages
						.filter((message) => message.ordinal > after)
						.slice(0, 2),
				),
			);
		}
	});
	it("absorbs leading and mid-span system ordinal coverage without historian prose", () => {
		const sessionId = "system-ordinal-coverage";
		const raw = convertEntriesToRawMessages(entries);
		const chunk = withRawMessageProvider(
			sessionId,
			{ readMessages: () => raw },
			() => readSessionChunk(sessionId, 10000),
		);
		expect(chunk.lines).toEqual(
			golden.rawMessages.map((message) => ({
				ordinal: message.ordinal,
				messageId: message.id,
			})),
		);
		expect(validateChunkCoverage(chunk)).toBeNull();
		expect(chunk.text).toContain("Inspect the source file");
		expect(chunk.text).toContain("Explain the result");
		expect(chunk.text).not.toContain("INITIAL_SYSTEM_NOT_HISTORIAN_PROSE");
		expect(chunk.text).not.toContain("DELTA_SYSTEM_NOT_HISTORIAN_PROSE");
	});
	it("pre-fix persisted compartments and watermarks still resolve the same messages", async () => {
		const db = createTestDb();
		const sessionId = "system-ordinal-persisted";
		try {
			const start = golden.rawMessages[0];
			const end = golden.rawMessages.find((message) => message.id === "u1");
			if (!start || !end) throw new Error("missing golden boundaries");
			appendCompartments(db, sessionId, [
				{
					sequence: 0,
					startMessage: start.ordinal,
					endMessage: end.ordinal,
					startMessageId: start.id,
					endMessageId: end.id,
					title: "pre-fix compartment",
					content: "source inspected",
				},
			]);
			const persisted = getCompartments(db, sessionId)[0];
			if (!persisted) throw new Error("missing persisted compartment");
			const raw = convertEntriesToRawMessages(entries);
			expect(
				raw
					.filter(
						(message) =>
							message.ordinal >= persisted.startMessage &&
							message.ordinal <= persisted.endMessage,
					)
					.map((message) => message.id),
			).toEqual(
				golden.rawMessages
					.filter((message) => message.ordinal <= end.ordinal)
					.map((message) => message.id),
			);
			const watermark = getLastCompartmentEndMessage(db, sessionId);
			expect(
				JSON.stringify(
					convertEntriesToRawMessagePage(
						entries,
						watermark,
						100,
						golden.rawMessages.length,
					),
				),
			).toBe(
				JSON.stringify(
					golden.rawMessages.filter((message) => message.ordinal > end.ordinal),
				),
			);
			const ctx = {
				...fakeContext(sessionId),
				sessionManager: {
					getSessionId: () => sessionId,
					getBranch: () => entries,
				},
			};
			const expanded = await createCtxExpandTool({ db }).execute(
				"expand",
				{ message: persisted.endMessage },
				new AbortController().signal,
				undefined,
				ctx as never,
			);
			expect(expanded.isError).not.toBe(true);
			const text = (expanded.content[0] as { text: string }).text;
			expect(text).toContain("Explain the result");
			expect(text).not.toContain("The source implements a reader.");
			const messages = structuredClone(entries.map((entry) => entry.message));
			__test.trimPiMessagesToBoundary(
				messages as Parameters<typeof __test.trimPiMessagesToBoundary>[0],
				entries.map((entry) => entry.id),
				persisted.endMessageId,
			);
			// The compartment ends on the prompt u1 and its reply follows, so the
			// boundary sits inside u1's turn: the cut keeps u1 so the reply is not
			// served without the prompt it answers (see keptPromptIndex).
			expect(messages.map((message) => message.role)).toEqual([
				"system",
				"system",
				"user",
				"assistant",
			]);
			expect(messages.at(-1)).toEqual(entries.at(-1)?.message);
		} finally {
			db.close();
		}
	});
	it("keeps native marker boundaries off system entries without renumbering the next user", () => {
		const simple = entries.filter((entry) =>
			["s0", "u0", "s1", "u1"].includes(entry.id),
		);
		expect(findFirstKeptEntryId(simple, 2)).toBe("u1");
		expect(
			convertEntriesToRawMessages(simple).find((message) => message.id === "u1")
				?.ordinal,
		).toBe(4);
	});
});
