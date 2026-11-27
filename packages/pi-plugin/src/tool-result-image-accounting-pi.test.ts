import { describe, expect, it } from "bun:test";
import { getProtectionWindowForSession } from "@magic-context/core/features/magic-context/protection-window";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import type { MessageLike } from "@magic-context/core/hooks/magic-context/tag-messages";
import { toolReclaimDistanceEntries } from "@magic-context/core/hooks/magic-context/tool-reclaim";
import type { Database } from "@magic-context/core/shared/sqlite";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import { piToolImageCostTokens } from "./pi-overflow-recovery";
import { estimatePiOutgoingInputTokens } from "./pi-raw-fallback";
import {
	PI_NON_VISION_TOOL_IMAGE_PLACEHOLDER,
	PI_NON_VISION_USER_IMAGE_PLACEHOLDER,
	piImageWireTokens,
	piMessagesWithWireImages,
	piModelAcceptsImages,
	STRIPPED_IMAGE_MARKER,
} from "./strip-processed-images-pi";
import { assistantToolCall, createTestDb } from "./test-utils.test";
import { PI_IMAGE_TOKENS } from "./tokenize-pi-messages";
import { createPiTranscript } from "./transcript-pi";

// A generated image as Pi carries it: several hundred kilobytes of base64.
const IMAGE_DATA = "iVBORw0KGgo".repeat(60_000);

it.each([
	[true, true, STRIPPED_IMAGE_MARKER],
	[false, false, PI_NON_VISION_USER_IMAGE_PLACEHOLDER],
])("prices user images for reclaim distance at wire cost (frozen=%s, vision=%s)", (stripped, modelAcceptsImages, expected) => {
	const image = { type: "image", data: IMAGE_DATA, mimeType: "image/png" };
	const raw = [{ role: "user", content: [image], timestamp: 1 }];
	const before = JSON.stringify(raw);
	const transcript = createPiTranscript(raw, "image-distance", ["user-image"], {
		imageTokens: () =>
			piImageWireTokens({
				block: image,
				role: "user",
				stripped,
				modelAcceptsImages,
			}),
	});
	const distance = toolReclaimDistanceEntries(
		transcript.messages as unknown as MessageLike[],
		new Map(),
	);
	expect(distance.map((entry) => entry.tokens)).toEqual([
		estimateTokens(expected),
	]);
	expect(JSON.stringify(transcript.getOutputMessages())).toBe(before);
});

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
	imageTokens?: (messageIndex: number, partIndex: number) => number,
) {
	const transcript = createPiTranscript(
		makeMessages() as never,
		sessionId,
		entryIds,
		{ imageTokens },
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

			// A 49,152-token protection floor: about 41 image outputs fill it, so
			// the older ones stay outside the protected tail.
			const window = getProtectionWindowForSession(db, sessionId, 49_152);
			// Expected from what each output carries, not from the stored rows: its
			// caption plus one image. The newest outputs are protected until their
			// total reaches the floor, the one that crosses it included.
			let expectedProtected = 0;
			let carried = 0;
			for (let index = outputs - 1; index >= 0 && carried < 49_152; index--) {
				carried += estimateTokens(`Generated image ${index}`) + PI_IMAGE_TOKENS;
				expectedProtected += 1;
			}
			expect(expectedProtected).toBe(41);
			expect(window.status.protectedCount).toBe(expectedProtected);
			const tags = toolRows(db, sessionId).map((row) => row.tag_number);
			expect(tags).toHaveLength(outputs);
			expect([...window.protectedTagNumbers].sort((a, b) => a - b)).toEqual(
				tags.slice(outputs - expectedProtected),
			);
		} finally {
			closeQuietly(db);
		}
	});
});

describe("Pi tool-result images the request does not carry", () => {
	const caption = "Generated image saved to out/cat.png";
	const makeMessages = () => [
		assistantToolCall("call-one", "generate_image", { prompt: "cat" }, 1),
		imageToolResult("call-one", "generate_image", caption, 3, 2),
	];
	const entryIds = ["a1", "r1"];
	const resultIndex = 1;
	const blockAt = (messageIndex: number, partIndex: number) =>
		(makeMessages()[messageIndex] as { content: unknown[] } | undefined)
			?.content[partIndex];

	it("count the processed-image strip's marker once the strip froze the result, and the image again if it returns", () => {
		const db = createTestDb();
		const sessionId = "ses-image-tool-stripped";
		try {
			const tagger = createTagger();
			tagger.initFromDb(sessionId, db);
			let frozen = new Set<string>();
			const wireTokens = (messageIndex: number, partIndex: number) =>
				piImageWireTokens({
					role: "toolResult",
					block: blockAt(messageIndex, partIndex),
					stripped: frozen.has(entryIds[messageIndex] ?? ""),
					modelAcceptsImages: true,
				});
			const count = () => toolRows(db, sessionId)[0]?.token_count;

			tagPass(db, tagger, sessionId, makeMessages, entryIds, false, wireTokens);
			expect(count()).toBe(estimateTokens(caption) + 3 * PI_IMAGE_TOKENS);

			// A later rebuild froze the result: its images go out as markers.
			frozen = new Set([entryIds[resultIndex] as string]);
			tagPass(db, tagger, sessionId, makeMessages, entryIds, true, wireTokens);
			const stripped =
				estimateTokens(caption) + 3 * estimateTokens(STRIPPED_IMAGE_MARKER);
			expect(count()).toBe(stripped);
			expect(stripped).toBeLessThan(40);
			// Replaying the frozen request keeps the count.
			tagPass(db, tagger, sessionId, makeMessages, entryIds, true, wireTokens);
			expect(count()).toBe(stripped);

			frozen = new Set();
			tagPass(db, tagger, sessionId, makeMessages, entryIds, true, wireTokens);
			expect(count()).toBe(estimateTokens(caption) + 3 * PI_IMAGE_TOKENS);
		} finally {
			closeQuietly(db);
		}
	});

	it("count the host's note for a model without image input", () => {
		const db = createTestDb();
		const sessionId = "ses-image-tool-text-model";
		try {
			const tagger = createTagger();
			tagger.initFromDb(sessionId, db);
			const textOnly = (messageIndex: number, partIndex: number) =>
				piImageWireTokens({
					role: "toolResult",
					block: blockAt(messageIndex, partIndex),
					stripped: false,
					modelAcceptsImages: piModelAcceptsImages({ input: ["text"] }),
				});
			tagPass(db, tagger, sessionId, makeMessages, entryIds, false, textOnly);
			expect(toolRows(db, sessionId)[0]?.token_count).toBe(
				estimateTokens(caption) +
					3 * estimateTokens(PI_NON_VISION_TOOL_IMAGE_PLACEHOLDER),
			);
			expect(piModelAcceptsImages({ input: ["text", "image"] })).toBe(true);
			// A model descriptor without an input list keeps images counted.
			expect(piModelAcceptsImages({ id: "unknown" })).toBe(true);
		} finally {
			closeQuietly(db);
		}
	});
});

describe("one image rule for tag counts, the emergency planner and the local estimate", () => {
	const caption = "Generated image saved to out/cat.png";
	const messages = () => [
		{
			role: "user",
			content: [{ type: "text", text: "draw a cat" }],
			timestamp: 1,
		},
		assistantToolCall("call-one", "generate_image", { prompt: "cat" }, 2),
		imageToolResult("call-one", "generate_image", caption, 2, 3),
	];
	const textOnly = (message: unknown) =>
		piMessagesWithWireImages([message], { modelAcceptsImages: false })[0];

	it("leaves the request untouched while the model takes images and nothing is stripped", () => {
		const served = messages();
		expect(piMessagesWithWireImages(served, { modelAcceptsImages: true })).toBe(
			served,
		);
	});

	it("replaces each image a text-only model cannot take with the host's note", () => {
		const sent = piMessagesWithWireImages(messages(), {
			modelAcceptsImages: false,
		});
		expect((sent[2] as { content: unknown[] }).content).toEqual([
			{ type: "text", text: caption },
			{ type: "text", text: PI_NON_VISION_TOOL_IMAGE_PLACEHOLDER },
			{ type: "text", text: PI_NON_VISION_TOOL_IMAGE_PLACEHOLDER },
		]);
	});

	it("gives the emergency planner no image mass for images the request does not carry", () => {
		expect(piToolImageCostTokens(messages()).get("call-one")).toBe(
			2 * PI_IMAGE_TOKENS,
		);
		const textModel = piMessagesWithWireImages(messages(), {
			modelAcceptsImages: false,
		});
		expect(piToolImageCostTokens(textModel).get("call-one")).toBeUndefined();
		const stripped = piMessagesWithWireImages(messages(), {
			modelAcceptsImages: true,
			strippedMessage: (_message, index) => index === 2,
		});
		expect(piToolImageCostTokens(stripped).get("call-one")).toBeUndefined();
	});

	it("prices a text-only model's request with the note, not 1,200 tokens per image", () => {
		const envelope = {
			modelKey: "test/text-only",
			systemTokens: 100,
			toolDefinitionTokens: 50,
		};
		const withImages = estimatePiOutgoingInputTokens(messages(), envelope);
		const textModel = estimatePiOutgoingInputTokens(messages(), {
			...envelope,
			modelAcceptsImages: false,
		});
		const asSent = estimatePiOutgoingInputTokens(
			messages().map(textOnly),
			envelope,
		);
		expect(textModel.trusted).toBe(true);
		expect(textModel.tokens).toBe(asSent.tokens);
		expect(withImages.tokens - textModel.tokens).toBeGreaterThan(
			2 * PI_IMAGE_TOKENS - 100,
		);
	});
});
