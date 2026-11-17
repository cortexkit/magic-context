import { afterEach, expect, it, spyOn } from "bun:test";
import {
	getTagsBySession,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { resetEmergencyRecoveryRegistryForTest } from "@magic-context/core/features/magic-context/storage-meta-persisted";
import * as logger from "@magic-context/core/shared/logger";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	clearContextHandlerSession,
	recordPiLiveModel,
	registerPiContextHandler,
} from "./context-handler";
import {
	assistantMessage,
	assistantToolCall,
	createFakePi,
	createTestDb,
	fakeContext,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";
import { PI_IMAGE_TOKENS } from "./tokenize-pi-messages";

// Issue 938: the force-band emergency drop counted the images inside
// droppable tool outputs as fixed mass, so it refused to drop the very outputs
// that carried them ("fixed floor ... exceeds ceiling").

const WINDOW = 100_000;
const IMAGES = 60;
const sessionId = "pi-image-emergency-drop";
const modelKey = "mock/mock";

afterEach(() => {
	clearContextHandlerSession(sessionId);
	resetEmergencyRecoveryRegistryForTest();
});

function buildMessages(): unknown[] {
	const messages: unknown[] = [userMessage("Make the images", 1)];
	for (let i = 0; i < IMAGES; i++) {
		const at = 10 + i * 3;
		messages.push(
			assistantToolCall(`img-${i}`, "generate_image", { prompt: `${i}` }, at),
			{
				...toolResultMessage(`img-${i}`, `generated image ${i}`, at + 1),
				toolName: "generate_image",
				content: [
					{ type: "text", text: `generated image ${i}` },
					{ type: "image", mimeType: "image/png", data: "A".repeat(2_000) },
				],
			},
			assistantMessage(`Here is image ${i}.`, at + 2),
		);
	}
	messages.push(userMessage("Make one more", 10 + IMAGES * 3));
	return messages;
}

function imageCount(messages: readonly unknown[]): number {
	let count = 0;
	for (const message of messages) {
		const content = (message as { content?: unknown }).content;
		if (Array.isArray(content))
			for (const part of content)
				if ((part as { type?: string })?.type === "image") count += 1;
	}
	return count;
}

it("drops image-bearing tool outputs at the force band instead of counting their images as fixed", async () => {
	const db = createTestDb();
	const lines: string[] = [];
	const log = spyOn(logger, "sessionLog").mockImplementation(
		(_id, ...parts) => {
			lines.push(parts.map(String).join(" "));
		},
	);
	try {
		updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
		const fake = createFakePi();
		registerPiContextHandler(
			{
				...fake.pi,
				getAllTools: () => [
					{
						name: "generate_image",
						description: "Make an image",
						parameters: { type: "object" },
					},
				],
			} as never,
			{
				db,
				protectedTags: 0,
				heuristics: {},
				scheduler: { executeThresholdPercentage: 50 },
			},
		);
		const handler = fake.handlers.get("context") as (
			event: { messages: unknown[] },
			ctx: never,
		) => Promise<{ messages: unknown[] }>;
		const pass = async (tokens: number) => {
			const messages = buildMessages();
			recordPiLiveModel(sessionId, modelKey);
			return handler({ messages }, {
				...fakeContext(
					sessionId,
					process.cwd(),
					messages.map((_, i) => `entry-${i}`),
					messages as never,
				),
				model: { provider: "mock", id: "mock", contextWindow: WINDOW },
				getSystemPrompt: () => "You are an image agent.",
				getContextUsage: () => ({
					tokens,
					percent: (tokens / WINDOW) * 100,
					contextWindow: WINDOW,
				}),
			} as never);
		};

		// Below the force band nothing is dropped: every image is served.
		const quiet = await pass(20_000);
		expect(imageCount(quiet.messages)).toBe(IMAGES);

		// The provider's reading prices the images at their token cost, so it
		// is almost all image mass: 60 images, 72k tokens of a 100k window.
		const reading = IMAGES * PI_IMAGE_TOKENS + 18_000;
		updateSessionMeta(db, sessionId, {
			lastResponseTime: Date.now(),
			cacheTtl: "59m",
			lastContextPercentage: (reading / WINDOW) * 100,
			lastInputTokens: reading,
		});
		const forced = await pass(reading);

		const emergency = lines.filter((line) =>
			/emergency (candidates|tiered drop)/.test(line),
		);
		const droppedTools = getTagsBySession(db, sessionId).filter(
			(tag) => tag.type === "tool" && tag.status === "dropped",
		);
		expect(
			emergency.some((line) => line.includes("emergency tiered drop:")),
			emergency.join("\n"),
		).toBe(true);
		expect(droppedTools.length).toBeGreaterThan(0);
		expect(imageCount(forced.messages)).toBeLessThan(IMAGES);
	} finally {
		log.mockRestore();
		closeQuietly(db);
	}
});
