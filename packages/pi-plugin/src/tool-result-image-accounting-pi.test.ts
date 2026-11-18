import { describe, expect, it } from "bun:test";
import { getProtectionWindowForSession } from "@magic-context/core/features/magic-context/protection-window";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import type { Database } from "@magic-context/core/shared/sqlite";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import { assistantToolCall, createTestDb } from "./test-utils.test";
import { PI_IMAGE_TOKENS } from "./tokenize-pi-messages";
import { createPiTranscript } from "./transcript-pi";

// A generated image as Pi carries it: several hundred kilobytes of base64.
const IMAGE_DATA = "iVBORw0KGgo".repeat(60_000);

function imageToolResult(
	callId: string,
	toolName: string,
	caption: string,
	images: number,
	timestamp: number,
) {
	return {
		role: "toolResult",
		toolCallId: callId,
		toolName,
		content: [
			{ type: "text", text: caption },
			...Array.from({ length: images }, () => ({
				type: "image",
				data: IMAGE_DATA,
				mimeType: "image/png",
			})),
		],
		isError: false,
		timestamp,
	};
}

interface ToolRow {
	tag_number: number;
	byte_size: number;
	token_count: number | null;
}

function toolRows(db: Database, sessionId: string): ToolRow[] {
	return db
		.prepare(
			"SELECT tag_number, byte_size, token_count FROM tags WHERE session_id = ? AND type = 'tool' ORDER BY tag_number",
		)
		.all(sessionId) as ToolRow[];
}

/** One tagging pass over fresh copies of the messages, as each Pi pass sees them. */
function tagPass(
	db: Database,
	tagger: ReturnType<typeof createTagger>,
	sessionId: string,
	makeMessages: () => unknown[],
	entryIds: string[],
	reuse: boolean,
) {
	const transcript = createPiTranscript(
		makeMessages() as never,
		sessionId,
		entryIds,
	);
	tagTranscript(sessionId, transcript, tagger, db, {
		reuseMessageIds: reuse ? new Set(entryIds) : undefined,
	});
	transcript.commit();
}

describe("Pi tool results that carry images", () => {
	it("count each image at the per-image token cost, plus the result's text", () => {
		const db = createTestDb();
		const sessionId = "ses-image-tool-accounting";
		try {
			const tagger = createTagger();
			tagger.initFromDb(sessionId, db);
			const caption = "Generated image saved to out/cat.png";
			const makeMessages = () => [
				assistantToolCall("call-one", "generate_image", { prompt: "cat" }, 1),
				imageToolResult("call-one", "generate_image", caption, 1, 2),
				assistantToolCall("call-two", "generate_image", { prompt: "dogs" }, 3),
				imageToolResult("call-two", "generate_image", caption, 2, 4),
				assistantToolCall("call-text", "read", { path: "notes.md" }, 5),
				{
					role: "toolResult",
					toolCallId: "call-text",
					toolName: "read",
					content: [{ type: "text", text: "plain text output ".repeat(40) }],
					isError: false,
					timestamp: 6,
				},
			];
			const entryIds = ["a1", "r1", "a2", "r2", "a3", "r3"];
			tagPass(db, tagger, sessionId, makeMessages, entryIds, false);

			const [one, two, text] = toolRows(db, sessionId);
			const captionTokens = estimateTokens(caption);
			// The image block is the largest part, so byte_size still records it.
			expect(one?.byte_size).toBeGreaterThan(IMAGE_DATA.length);
			expect(one?.token_count).toBe(captionTokens + PI_IMAGE_TOKENS);
			expect(two?.token_count).toBe(captionTokens + 2 * PI_IMAGE_TOKENS);
			// A result without images keeps its text count exactly.
			expect(text?.token_count).toBe(
				estimateTokens("plain text output ".repeat(40)),
			);

			// Replaying the same request leaves every count where it is.
			tagPass(db, tagger, sessionId, makeMessages, entryIds, true);
			expect(toolRows(db, sessionId)).toEqual([one, two, text] as ToolRow[]);
		} finally {
			closeQuietly(db);
		}
	});

	it("repair a row recorded at its caption size on the next pass", () => {
		const db = createTestDb();
		const sessionId = "ses-image-tool-repair";
		try {
			const tagger = createTagger();
			tagger.initFromDb(sessionId, db);
			const caption = "Read image file [image/png]";
			const makeMessages = () => [
				assistantToolCall("call-read", "read", { path: "shot.png" }, 1),
				imageToolResult("call-read", "read", caption, 1, 2),
			];
			const entryIds = ["a1", "r1"];
			tagPass(db, tagger, sessionId, makeMessages, entryIds, false);
			const [tagged] = toolRows(db, sessionId);

			// A row an earlier release wrote: the image's bytes, a caption-sized count.
			db.prepare(
				"UPDATE tags SET token_count = 35 WHERE session_id = ? AND type = 'tool'",
			).run(sessionId);
			tagger.cleanup(sessionId);
			tagger.initFromDb(sessionId, db);

			tagPass(db, tagger, sessionId, makeMessages, entryIds, true);
			expect(toolRows(db, sessionId)).toEqual([tagged] as ToolRow[]);
			expect(tagged?.token_count).toBe(
				estimateTokens(caption) + PI_IMAGE_TOKENS,
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("keep the protected tail from covering every image output", () => {
		const db = createTestDb();
		const sessionId = "ses-image-tool-protection";
		try {
			const tagger = createTagger();
			tagger.initFromDb(sessionId, db);
			const outputs = 60;
			const makeMessages = () =>
				Array.from({ length: outputs }, (_, index) => [
					assistantToolCall(
						`call-${index}`,
						"generate_image",
						{ prompt: `image ${index}` },
						index * 2 + 1,
					),
					imageToolResult(
						`call-${index}`,
						"generate_image",
						`Generated image ${index}`,
						1,
						index * 2 + 2,
					),
				]).flat();
			const entryIds = Array.from({ length: outputs * 2 }, (_, i) => `e${i}`);
			tagPass(db, tagger, sessionId, makeMessages, entryIds, false);

			// A 49,152-token protection floor, as on the affected Pi session where
			// the protected tail covered every image output.
			const window = getProtectionWindowForSession(db, sessionId, 49_152);
			let newest = 0;
			let mass = 0;
			for (const row of toolRows(db, sessionId).reverse()) {
				newest += 1;
				mass += row.token_count ?? 0;
				if (mass >= 49_152) break;
			}
			// About 40 outputs of one image each fill the budget; older ones may go.
			expect(newest).toBeLessThan(outputs);
			expect(window.status.protectedCount).toBe(newest);
			expect(window.cutoff).toBeGreaterThan(
				toolRows(db, sessionId)[0]?.tag_number ?? 0,
			);
		} finally {
			closeQuietly(db);
		}
	});
});
