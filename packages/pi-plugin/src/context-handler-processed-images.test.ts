import { describe, expect, it, spyOn } from "bun:test";
import {
	getMaxDroppedTagNumber,
	getProcessedImageStrippedIds,
	getTagsBySession,
	insertTag,
	updateSessionMeta,
	updateTagStatus,
} from "@magic-context/core/features/magic-context/storage";
import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
	signalPiPendingMaterialization,
} from "./context-handler";
import * as images from "./strip-processed-images-pi";
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

const image = () => ({
	type: "image" as const,
	mimeType: "image/png",
	data: "a".repeat(240),
});
const marker = { type: "text", text: "[image stripped]" };
// Three later tool results of this size fill the 4,000-token protected window,
// so the older images fall outside it. They are kept small enough, and out of
// the tool inputs, that the image tool output stays short of the age sweep's
// distance (three newer user turns or a quarter of the usable window): an image
// output now counts its image, so a far-behind one would be reclaimed whole
// before the processed-image strip this file covers could reach it.
const protectionPayload = (() => {
	let payload = "";
	for (let i = 0; estimateTokens(payload) < 1_600; i++)
		payload += `token_${i} `;
	return payload;
})();

function fixture(api = "openai-completions") {
	const db = createTestDb();
	const sessionId = `processed-images-${api}`;
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, {
		db,
		protectedTags: 0,
		protectedTokens: 4000,
		heuristics: { clearReasoningAge: 999 },
	});
	const handler = fake.handlers.get("context") as (
		event: { messages: PiMessage[] },
		ctx: never,
	) => Promise<{ messages: PiMessage[] }>;
	const strip = spyOn(images, "stripPiProcessedImages");
	const build = () => [
		userMessage(
			[{ type: "text", text: "old screenshot" }, image(), image()],
			1,
		),
		assistantToolCall("shot", "screenshot", {}, 2),
		{ ...toolResultMessage("shot", "", 3), content: [image()] } as PiMessage,
		assistantMessage("answered images", 4),
		userMessage([{ type: "text", text: "newer screenshot" }, image()], 5),
		assistantMessage("answered newer image", 6),
		// Later tool inputs and results move old images outside the protected token window.
		...Array.from({ length: 3 }, (_, i) => [
			assistantToolCall(`later-${i}`, "screenshot", { page: i }, 10 + i * 2),
			toolResultMessage(`later-${i}`, protectionPayload, 11 + i * 2),
		]).flat(),
		userMessage([image()], 7),
	];
	return {
		db,
		sessionId,
		strip,
		build,
		async pass(raw = build(), provider = "opencode-zen", id = "gpt-5") {
			// Rebuild from original messages, as Pi does on each context event.
			const messages = structuredClone(raw);
			strip.mockClear();
			const result = await handler({ messages }, {
				...fakeContext(
					sessionId,
					process.cwd(),
					messages.map((_, i) => `entry-${i}`),
					messages,
				),
				model: { provider, id, api, contextWindow: 100_000 },
			} as never);
			expect(result?.messages).toBeDefined();
			return result.messages;
		},
		warm() {
			updateSessionMeta(db, sessionId, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
				lastContextPercentage: 1,
				lastInputTokens: 1_000,
			});
		},
		age(offBranch = false) {
			// Drop the answer at entry-3 to advance the dropped-tag watermark
			// past both older images. An off-branch drop changes only the watermark.
			const tags = getTagsBySession(db, sessionId);
			const watermark = offBranch
				? Math.max(...tags.map((tag) => tag.tagNumber)) + 1
				: Math.max(
						...tags
							.filter((tag) => tag.messageId.startsWith("entry-3"))
							.map((tag) => tag.tagNumber),
					);
			expect(watermark).toBeGreaterThan(0);
			if (offBranch)
				insertTag(db, sessionId, "off-branch", "tool", 10, watermark);
			updateTagStatus(db, sessionId, watermark, "dropped");
			expect(getMaxDroppedTagNumber(db, sessionId)).toBe(watermark);
		},
		close() {
			strip.mockRestore();
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		},
	};
}

function contentOf(messages: PiMessage[], timestamp: number) {
	return messages.find((message) => message.timestamp === timestamp)?.content;
}

function latestDetection(f: ReturnType<typeof fixture>) {
	expect(f.strip).toHaveBeenCalledTimes(1);
	return f.strip.mock.calls[0]?.[0].detect;
}

describe("Pi processed-image provider wiring", () => {
	for (const api of ["openai-completions", "openai-responses"]) {
		it(`Zen ${api} strips on an admitted rewrite and replays frozen image bytes on defer and provider switch`, async () => {
			const f = fixture(api);
			try {
				await f.pass();
				f.warm();
				f.age();
				signalPiPendingMaterialization(f.sessionId);
				const rewritten = await f.pass();
				expect(contentOf(rewritten, 1)).toEqual([
					expect.objectContaining({ type: "text" }),
					marker,
					marker,
				]);
				expect(f.strip.mock.calls[0]?.[0].protectedCutoff).toBeGreaterThan(2);
				expect(
					f.strip.mock.calls[0]?.[0].messageIdToMaxTag.get("entry-2"),
				).toBe(2);
				expect(contentOf(rewritten, 3)).toEqual([marker]);
				expect(
					f.strip.mock.calls[0]?.[0].messageIdToMaxTag.get("entry-2"),
				).toBe(2);
				expect(latestDetection(f)).toBe(true);
				expect(contentOf(rewritten, 5)).toContainEqual(image());
				expect(contentOf(rewritten, 7)).toEqual([image()]);
				expect(
					[...getProcessedImageStrippedIds(f.db, f.sessionId)].sort(),
				).toEqual(["entry-0", "entry-2"]);
				f.warm();
				const deferred = await f.pass();
				expect(latestDetection(f)).toBe(false);
				expect(JSON.stringify(deferred)).toBe(JSON.stringify(rewritten));
				const switched = await f.pass(
					f.build(),
					"custom-openai",
					"other-vision",
				);
				expect(JSON.stringify(switched)).toBe(JSON.stringify(rewritten));
				expect(
					[...getProcessedImageStrippedIds(f.db, f.sessionId)].sort(),
				).toEqual(["entry-0", "entry-2"]);
			} finally {
				f.close();
			}
		});
	}

	it("without frozen ids, zero-watermark rewrites and aged defer requests keep the base request bytes", async () => {
		const f = fixture();
		try {
			const first = await f.pass();
			// The base non-Anthropic request tags text but retains every image byte.
			const baseRequest = f.build();
			for (const [index, text] of [
				[0, "§1§ old screenshot"],
				[3, "§3§ answered images"],
				[4, "§4§ newer screenshot"],
				[5, "§5§ answered newer image"],
				[7, `§6§ ${protectionPayload}`],
				[9, `§7§ ${protectionPayload}`],
				[11, `§8§ ${protectionPayload}`],
			] as const) {
				const parts = baseRequest[index]?.content;
				if (!Array.isArray(parts)) throw new Error("expected content parts");
				parts[0] = { type: "text", text };
			}
			expect(JSON.stringify(first)).toBe(JSON.stringify(baseRequest));
			expect(getMaxDroppedTagNumber(f.db, f.sessionId)).toBe(0);
			expect(getProcessedImageStrippedIds(f.db, f.sessionId).size).toBe(0);
			f.warm();
			f.age(true);
			for (let pass = 0; pass < 2; pass++) {
				const deferred = await f.pass();
				expect(f.strip.mock.calls.every(([args]) => !args.detect)).toBe(true);
				expect(getProcessedImageStrippedIds(f.db, f.sessionId).size).toBe(0);
				expect(JSON.stringify(deferred)).toBe(JSON.stringify(first));
			}
		} finally {
			f.close();
		}
	});

	it("protected signed thinking prevents new image detection", async () => {
		const f = fixture("anthropic-messages");
		try {
			// Allocate tags before any drop, then add signed thinking after a
			// restart to check that a protected prefix cannot discover new images.
			await f.pass();
			f.age();
			clearContextHandlerSession(f.sessionId);
			const raw = f.build().slice(0, 4);
			raw.push(
				assistantMessage("signed answer", 8, {
					provider: "anthropic",
					model: "claude-opus-5-5",
					content: [
						{
							type: "thinking",
							thinking: "signed",
							thinkingSignature: "signature",
						},
						{ type: "text", text: "signed answer" },
					],
				}),
			);
			const served = await f.pass(raw, "anthropic", "claude-opus-5-5");
			expect(latestDetection(f)).toBe(false);
			expect(contentOf(served, 1)).toContainEqual(image());
			expect(contentOf(served, 3)).toEqual([image()]);
			expect(JSON.stringify(served)).toContain("signature");
			expect(getProcessedImageStrippedIds(f.db, f.sessionId).size).toBe(0);
		} finally {
			f.close();
		}
	});
});
