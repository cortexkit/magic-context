import { describe, expect, it } from "bun:test";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import {
	assistantMessage,
	assistantToolCall,
	createTestDb,
	textOf,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";
import { createPiTranscript } from "./transcript-pi";

type ToolTokenCacheEntry = { text: string; tokenCount: number };

class CountingToolTokenCache extends Map<string, ToolTokenCacheEntry> {
	writes = 0;

	override set(key: string, value: ToolTokenCacheEntry): this {
		this.writes += 1;
		return super.set(key, value);
	}

	resetWrites(): void {
		this.writes = 0;
	}
}

class LegacyAggregateToolTokenCache extends CountingToolTokenCache {
	private aggregateKey(key: string): string {
		const suffix = key.indexOf("\0result-part:");
		return suffix === -1 ? key : key.slice(0, suffix);
	}

	override get(key: string): ToolTokenCacheEntry | undefined {
		return super.get(this.aggregateKey(key));
	}

	override set(key: string, value: ToolTokenCacheEntry): this {
		return super.set(this.aggregateKey(key), value);
	}
}

describe("createPiTranscript", () => {
	it("tags only tool result text and replays image children byte-identically", () => {
		const db = createTestDb();
		try {
			const image = { type: "image", data: "aW1n", mimeType: "image/jpeg" };
			const result = {
				...toolResultMessage("attachment-call", "Read result"),
				content: [{ type: "text", text: "Read result" }, image],
			};
			const messages = [
				assistantToolCall("attachment-call", "read", {}),
				result,
			];
			const tagger = createTagger();
			tagger.initFromDb("ses-attachment", db);
			const transcript = createPiTranscript(messages, "ses-attachment");
			tagTranscript("ses-attachment", transcript, tagger, db);
			transcript.commit();
			const output = messages[1] as typeof result;
			expect(output.content[0]).toEqual({
				type: "text",
				text: "§1§ Read result",
			});
			expect(output.content[1]).toBe(image);
			const bytes = JSON.stringify(output);
			const replay = createPiTranscript(messages, "ses-attachment");
			tagTranscript("ses-attachment", replay, tagger, db);
			replay.commit();
			expect(JSON.stringify(messages[1])).toBe(bytes);
		} finally {
			closeQuietly(db);
		}
	});
	it("scoped gate Pi finalization preserves unrelated reasoning-only assistant", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-scoped-pi";
			const reasoning = {
				...assistantMessage("", 13),
				content: [
					{
						type: "thinking",
						thinking: "signed reasoning",
						thinkingSignature: "signature",
					},
				],
			};
			const messages = [
				assistantToolCall("scoped-call", "Read", { path: "x" }),
				toolResultMessage("scoped-call", "spent"),
				reasoning,
			];
			const transcript = createPiTranscript(messages, sessionId);
			const tagger = createTagger();
			tagger.initFromDb(sessionId, db);
			const { targets } = tagTranscript(sessionId, transcript, tagger, db);
			expect([...targets.values()][0]?.drop()).toBe("removed");
			transcript.commit();
			transcript.finalizeToolRemovals();
			expect(transcript.getOutputMessages()).toEqual([reasoning]);
			console.log(
				"SCOPED_GATE Pi removed tool arc; unrelated reasoning retained",
			);
		} finally {
			closeQuietly(db);
		}
	});
	it("round-trips Pi messages through transcript mutation and commit", () => {
		const messages = [userMessage("hello", 10), assistantMessage("world", 11)];
		const transcript = createPiTranscript(messages, "ses-transcript");

		expect(transcript.messages[0]?.parts[0]?.setText("hello tagged")).toBe(
			true,
		);
		transcript.commit();
		const output = transcript.getOutputMessages();

		// commit() now syncs mutations from `working` back into source so
		// downstream callers (e.g. `<session-history>` injection) can splice
		// or unshift on the same array Pi sent us. Output is therefore the
		// SAME reference as the source input, with mutations applied in
		// place at the dirty indices.
		expect(output).toBe(messages);
		expect(textOf(output[0] as never)).toBe("hello tagged");
		expect(textOf(output[1] as never)).toBe("world");
	});

	it("preserves source identity when there are no mutations", () => {
		const messages = [
			userMessage("unchanged", 10),
			assistantMessage("same", 11),
		];
		const transcript = createPiTranscript(messages, "ses-transcript");

		transcript.commit();

		expect(transcript.getOutputMessages()).toBe(messages);
	});

	it("defers native tool input replay while retaining current Pi mutations", () => {
		const text = "Keep the native response untouched until authorization";
		const reasoning = {
			type: "reasoning",
			encrypted_content: "unrelated-encrypted-reasoning",
		};
		const hostedOutput = {
			type: "image_generation_call",
			result: "image-data",
		};
		const native = {
			type: "openaiResponsesHistory",
			dt: true,
			items: [
				reasoning,
				hostedOutput,
				{
					type: "message",
					role: "assistant",
					id: "msg-answer",
					content: [{ type: "output_text", text }],
				},
				{
					type: "function_call",
					id: "fc-sentinel",
					call_id: "call-sentinel",
					name: "write",
					arguments: JSON.stringify({ content: "large original input" }),
				},
				{
					type: "function_call",
					id: "fc-text",
					call_id: "call-text",
					name: "edit",
					arguments: JSON.stringify({ patch: "large original patch" }),
				},
				{
					type: "function_call",
					id: "fc-input",
					call_id: "call-input",
					name: "read",
					arguments: JSON.stringify({ path: "large original file" }),
				},
			],
		};
		const nativeSnapshot = structuredClone(native);
		const original = {
			...assistantMessage(text, 1, {
				content: [
					{ type: "text", text, textSignature: "msg-answer" },
					{
						type: "toolCall",
						id: "call-sentinel|fc-sentinel",
						name: "write",
						arguments: { content: "large original input" },
					},
					{
						type: "toolCall",
						id: "call-text|fc-text",
						name: "edit",
						arguments: { patch: "large original patch" },
					},
					{
						type: "toolCall",
						id: "call-input|fc-input",
						name: "read",
						arguments: { path: "large original file" },
					},
				],
			}),
			providerPayload: native,
		};
		const messages = [userMessage("prior context", 0), original];
		const assistantMessageIndex = 1;
		const transcript = createPiTranscript(messages, "ses-native-replay");
		const parts = transcript.messages[assistantMessageIndex]?.parts ?? [];

		expect(parts[0]?.setText("ordinary content changed")).toBe(true);
		expect(parts[1]?.replaceWithSentinel("[dropped input]")).toBe(true);
		expect(parts[2]?.setText("[truncated input]")).toBe(true);
		expect(parts[3]?.setToolInput?.({ path: "short.txt" })).toBe(true);
		expect(
			Array.from(
				transcript.getToolInputChanges().get(assistantMessageIndex) ?? [],
			),
		).toEqual([
			"call-sentinel|fc-sentinel",
			"call-text|fc-text",
			"call-input|fc-input",
		]);

		transcript.commit();
		const output = transcript.getOutputMessages() as Array<{
			content: Array<{
				type: string;
				text?: string;
				id?: string;
				arguments?: Record<string, unknown>;
			}>;
			providerPayload: typeof native;
		}>;
		expect(output[assistantMessageIndex]?.content).toEqual([
			{
				type: "text",
				text: "ordinary content changed",
				textSignature: "msg-answer",
			},
			{
				type: "toolCall",
				id: "call-sentinel|fc-sentinel",
				name: "write",
				arguments: { dropped: "[dropped input]" },
			},
			{
				type: "toolCall",
				id: "call-text|fc-text",
				name: "edit",
				arguments: { __magic_context_replacement__: "[truncated input]" },
			},
			{
				type: "toolCall",
				id: "call-input|fc-input",
				name: "read",
				arguments: { path: "short.txt" },
			},
		]);
		expect(output[assistantMessageIndex]?.providerPayload).toBe(native);
		expect(output[assistantMessageIndex]?.providerPayload).toEqual(
			nativeSnapshot,
		);
	});

	it("leaves Pi and OMP whitespace-only assistant framing untagged after peeling MC tags", () => {
		const vectors = [
			{
				harness: "pi",
				message: assistantMessage("  \n\t", 11),
				expectedText: "  \n\t",
			},
			{
				harness: "omp",
				message: {
					role: "assistant" as const,
					content: [{ type: "text" as const, text: "§77§  \n\t" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-fable-5-1",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					stopReason: "stop",
					timestamp: 11,
				},
				expectedText: "§77§  \n\t",
			},
		] as const;

		for (const vector of vectors) {
			const db = createTestDb();
			try {
				const sessionId = `ses-${vector.harness}-blank-framing`;
				const tagger = createTagger();
				tagger.initFromDb(sessionId, db);
				const transcript = createPiTranscript(
					[vector.message] as never,
					sessionId,
					[`entry-${vector.harness}-assistant`],
				);

				const { targets } = tagTranscript(sessionId, transcript, tagger, db);
				transcript.commit();

				expect(targets.size).toBe(0);
				expect(textOf(transcript.getOutputMessages()[0] as never)).toBe(
					vector.expectedText,
				);
				const stored = db
					.prepare("SELECT COUNT(*) AS count FROM tags WHERE session_id = ?")
					.get(sessionId) as { count: number };
				expect(stored.count).toBe(0);
			} finally {
				closeQuietly(db);
			}
		}
	});

	it("injects tag prefixes into user, assistant, and folded tool-result text", () => {
		const messages = [
			userMessage("user text", 10),
			assistantMessage("assistant text", 11),
			toolResultMessage("call-1", "tool output", 12),
			userMessage("after tool", 13),
		];
		const transcript = createPiTranscript(messages, "ses-transcript");

		for (const msg of transcript.messages) {
			for (const part of msg.parts) {
				const current = part.getText();
				if (current) part.setText(`§99§ ${current}`);
			}
		}
		transcript.commit();
		const output = transcript.getOutputMessages();

		expect(textOf(output[0] as never)).toBe("§99§ user text");
		expect(textOf(output[1] as never)).toBe("§99§ assistant text");
		expect(textOf(output[2] as never)).toBe("§99§ tool output");
		expect(textOf(output[3] as never)).toBe("§99§ after tool");
	});

	it("supports tag-prefix removal via part text mutation", () => {
		const messages = [
			userMessage("§1§ keep me", 10),
			assistantMessage("§2§ keep assistant", 11),
		];
		const transcript = createPiTranscript(messages, "ses-transcript");

		for (const msg of transcript.messages) {
			for (const part of msg.parts) {
				part.setText((part.getText() ?? "").replace(/§\d+§\s*/g, ""));
			}
		}
		transcript.commit();
		const output = transcript.getOutputMessages();

		expect(textOf(output[0] as never)).toBe("keep me");
		expect(textOf(output[1] as never)).toBe("keep assistant");
	});

	it("preserves mixed user content shape for string and array messages", () => {
		const messages = [
			userMessage("string user", 10),
			userMessage(
				[
					{ type: "text", text: "array text" },
					{ type: "image", data: "abc", mimeType: "image/png" },
				],
				11,
			),
		];
		const transcript = createPiTranscript(messages, "ses-transcript");

		transcript.messages[0]?.parts[0]?.setText("changed string");
		transcript.messages[1]?.parts[0]?.setText("changed array");
		transcript.commit();
		const output = transcript.getOutputMessages() as typeof messages;

		expect(typeof (output[0] as { content: unknown }).content).toBe("string");
		expect(Array.isArray((output[1] as { content: unknown }).content)).toBe(
			true,
		);
		expect(textOf(output[0] as never)).toBe("changed string");
		expect(textOf(output[1] as never)).toBe("changed array");
	});

	it("falls back to replacing toolCall arguments through setText", () => {
		const messages = [
			assistantToolCall("call-1", "Read", { path: "large-file.txt" }),
		];
		const transcript = createPiTranscript(messages, "ses-transcript");
		const part = transcript.messages[0]?.parts[0];

		expect(() => part?.setToolOutput("[truncated]")).toThrow(
			"setToolOutput on assistant part",
		);
		expect(part?.setText("[truncated]")).toBe(true);
		transcript.commit();

		const output = transcript.getOutputMessages() as Array<{
			content: Array<{ type: string; arguments?: Record<string, unknown> }>;
		}>;
		expect(output[0]?.content[0]).toMatchObject({
			type: "toolCall",
			arguments: { __magic_context_replacement__: "[truncated]" },
		});
	});

	it("getToolInput returns the toolCall arguments object, null for non-tool parts", () => {
		const messages = [
			assistantToolCall("call-1", "ctx_note", {
				action: "dismiss",
				note_id: 42,
			}),
			userMessage("plain text", 11),
		];
		const transcript = createPiTranscript(messages, "ses-transcript");
		const toolPart = transcript.messages[0]?.parts[0];
		const textPart = transcript.messages[1]?.parts[0];

		expect(toolPart?.getToolInput?.()).toEqual({
			action: "dismiss",
			note_id: 42,
		});
		// non-tool (text) part has no input
		expect(textPart?.getToolInput?.() ?? null).toBeNull();
	});

	it("setToolInput replaces toolCall arguments, preserving id/name", () => {
		const messages = [
			assistantToolCall("call-1", "edit", {
				filePath: "spec.md",
				oldString: "a".repeat(200),
			}),
		];
		const transcript = createPiTranscript(messages, "ses-transcript");
		const part = transcript.messages[0]?.parts[0];

		expect(
			part?.setToolInput?.({ filePath: "spec.md", oldString: "clamped" }),
		).toBe(true);
		transcript.commit();

		const output = transcript.getOutputMessages() as Array<{
			content: Array<{
				type: string;
				id?: string;
				name?: string;
				arguments?: unknown;
			}>;
		}>;
		const toolCall = output[0]?.content[0];
		expect(toolCall).toMatchObject({
			type: "toolCall",
			id: "call-1",
			name: "edit",
			arguments: { filePath: "spec.md", oldString: "clamped" },
		});
	});

	it("folds Pi toolResult messages into the following user transcript message", () => {
		const messages = [
			assistantToolCall("call-1", "Read", { path: "x" }),
			toolResultMessage("call-1", "file contents"),
			userMessage("continue", 13),
		];
		const transcript = createPiTranscript(messages, "ses-transcript");

		expect(transcript.messages).toHaveLength(2);
		expect(transcript.messages[1]?.info.role).toBe("user");
		expect(transcript.messages[1]?.parts.map((part) => part.kind)).toEqual([
			"tool_result",
			"text",
		]);
	});
	it("gives tail synthetic tool-result users a stable deterministic id", () => {
		const makeTranscriptId = () => {
			const messages = [
				assistantToolCall("call-tail", "Read", { path: "tail.txt" }, 11),
				toolResultMessage("call-tail", "tail output", 12),
			];
			const transcript = createPiTranscript(messages, "ses-transcript", [
				"entry-assistant",
				"entry-tool-result",
			]);

			return transcript.messages[1]?.info.id;
		};

		expect(makeTranscriptId()).toBe("synth-user-entry-tool-result");
		expect(makeTranscriptId()).toBe(makeTranscriptId());
	});

	it("covers image and multi-block tool results with one droppable tag", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-image-tool-result";
			const messages = [
				assistantToolCall("call-image", "Read", { path: "image.png" }, 11),
				{
					role: "toolResult",
					toolCallId: "call-image",
					toolName: "Read",
					content: [
						{ type: "image", data: "base64-image", mimeType: "image/png" },
						{ type: "text", text: "caption one" },
						{ type: "text", text: "caption two" },
					],
					isError: false,
					timestamp: 12,
				},
				// A later completed call, so the image call does not end the
				// conversation (drop() keeps that one as a skeleton instead).
				assistantToolCall("call-next", "Read", { path: "next.txt" }, 13),
				{
					role: "toolResult",
					toolCallId: "call-next",
					toolName: "Read",
					content: [{ type: "text", text: "next" }],
					isError: false,
					timestamp: 14,
				},
			];
			const tagger = createTagger();
			tagger.initFromDb(sessionId, db);
			const transcript = createPiTranscript(messages, sessionId, [
				"entry-assistant",
				"entry-tool-result",
				"entry-next-assistant",
				"entry-next-tool-result",
			]);

			expect(transcript.messages[1]?.info.id).toBe(
				"synth-user-entry-tool-result",
			);
			expect(transcript.messages[1]?.parts.map((part) => part.kind)).toEqual([
				"tool_result",
				"tool_result",
				"tool_result",
			]);

			const { targets } = tagTranscript(sessionId, transcript, tagger, db);
			expect(targets.size).toBe(2);

			const target = Array.from(targets.values())[0];
			expect(target?.drop()).toBe("removed");
			transcript.commit();

			const output = transcript.getOutputMessages() as Array<{
				content?: Array<{ type: string; text?: string }>;
			}>;
			expect(output[0]?.content).toEqual([]);
			expect(output[1]?.content).toEqual([]);
			transcript.finalizeToolRemovals();
			expect(output).toHaveLength(2);
		} finally {
			closeQuietly(db);
		}
	});

	it("keeps multi-block token memoization byte- and accounting-neutral", () => {
		const runScenario = (toolTokenCache: CountingToolTokenCache) => {
			const db = createTestDb();
			const sessionId = "ses-multi-block-token-cache";
			try {
				const tagger = createTagger();
				tagger.initFromDb(sessionId, db);
				const makeMessages = () => [
					assistantToolCall(
						"call-multi-cache",
						"Read",
						{ path: "large.txt" },
						11,
					),
					{
						role: "toolResult" as const,
						toolCallId: "call-multi-cache",
						toolName: "Read",
						content: [
							{ type: "text" as const, text: "first block ".repeat(200) },
							{ type: "text" as const, text: "second block ".repeat(300) },
						],
						isError: false,
						timestamp: 12,
					},
				];
				const entryIds = ["entry-assistant", "entry-tool-result"];

				const seed = createPiTranscript(makeMessages(), sessionId, entryIds);
				tagTranscript(sessionId, seed, tagger, db, { toolTokenCache });
				seed.commit();
				toolTokenCache.resetWrites();

				const replay = createPiTranscript(makeMessages(), sessionId, entryIds);
				tagTranscript(sessionId, replay, tagger, db, {
					reuseMessageIds: new Set(["entry-assistant", "entry-tool-result"]),
					toolTokenCache,
				});
				replay.commit();
				const rows = db
					.prepare(
						`SELECT tag_number, message_id, tool_owner_message_id,
						        byte_size, input_byte_size, token_count, input_token_count
						 FROM tags WHERE session_id = ? ORDER BY tag_number`,
					)
					.all(sessionId);
				return {
					cacheWrites: toolTokenCache.writes,
					outputBytes: JSON.stringify(replay.getOutputMessages()),
					rows,
				};
			} finally {
				closeQuietly(db);
			}
		};

		const legacy = runScenario(new LegacyAggregateToolTokenCache());
		const blockScoped = runScenario(new CountingToolTokenCache());

		expect(legacy.cacheWrites).toBe(2);
		expect(blockScoped.cacheWrites).toBe(0);
		expect(blockScoped.outputBytes).toBe(legacy.outputBytes);
		expect(blockScoped.rows).toEqual(legacy.rows);
	});

	it("truncates mixed tool-result image blocks into stable text sentinels", () => {
		const messages = [
			assistantToolCall("call-image", "Read", { path: "image.png" }, 11),
			{
				role: "toolResult",
				toolCallId: "call-image",
				toolName: "Read",
				content: [
					{ type: "image", data: "base64-image", mimeType: "image/png" },
					{ type: "text", text: "caption" },
				],
				isError: false,
				timestamp: 12,
			},
		];
		const transcript = createPiTranscript(messages, "ses-truncated-image", [
			"entry-assistant",
			"entry-tool-result",
		]);
		const toolResultParts = transcript.messages[1]?.parts ?? [];

		// Truncated-mode drop: every block (incl. the image) must become a text
		// "[truncated]" sentinel — the image bytes must NOT survive on the wire.
		for (const part of toolResultParts) {
			expect(part.setToolOutput("[truncated]")).toBe(true);
		}
		transcript.commit();
		const output = transcript.getOutputMessages() as Array<{
			content?: Array<{ type: string; text?: string }>;
		}>;
		const firstApplication = JSON.stringify(output[1]?.content);

		expect(output[1]?.content).toEqual([
			{ type: "text", text: "[truncated]" },
			{ type: "text", text: "[truncated]" },
		]);

		// Replay must be byte-identical (defer-pass cache stability).
		const replay = createPiTranscript(output as never, "ses-truncated-image", [
			"entry-assistant",
			"entry-tool-result",
		]);
		for (const part of replay.messages[1]?.parts ?? []) {
			part.setToolOutput("[truncated]");
		}
		replay.commit();
		expect(JSON.stringify(output[1]?.content)).toBe(firstApplication);
	});
});
