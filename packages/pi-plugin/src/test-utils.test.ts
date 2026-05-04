import { runMigrations } from "@magic-context/core/features/magic-context/migrations";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { setHarness } from "@magic-context/core/shared/harness";
import { Database } from "@magic-context/core/shared/sqlite";
import type { ContextEvent } from "@mariozechner/pi-coding-agent";

export type PiMessage = ContextEvent["messages"][number];

export function createTestDb(): Database {
	setHarness("pi");
	const db = new Database(":memory:");
	initializeDatabase(db);
	runMigrations(db);
	return db;
}

export function userMessage(
	content:
		| string
		| Array<
				| { type: "text"; text: string }
				| { type: "image"; data: string; mimeType: string }
		  >,
	timestamp = 1,
): PiMessage {
	return { role: "user", content, timestamp } as PiMessage;
}

export function assistantMessage(
	text: string,
	timestamp = 2,
	extra: Partial<Record<string, unknown>> = {},
): PiMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
		...extra,
	} as PiMessage;
}

export function assistantToolCall(
	id: string,
	name: string,
	args: Record<string, unknown> = {},
	timestamp = 2,
): PiMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: {},
		stopReason: "stop",
		timestamp,
	} as PiMessage;
}

export function toolResultMessage(
	toolCallId: string,
	text: string,
	timestamp = 3,
): PiMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "Read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	} as PiMessage;
}

export function textOf(message: PiMessage | undefined): string {
	if (!message) return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => {
			return (
				typeof part === "object" &&
				part !== null &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string"
			);
		})
		.map((part) => part.text)
		.join("");
}

export function createFakePi() {
	const handlers = new Map<string, (...args: never[]) => unknown>();
	const commands = new Map<string, unknown>();
	const sentMessages: string[] = [];
	return {
		pi: {
			on: (event: string, handler: (...args: never[]) => unknown) => {
				handlers.set(event, handler);
			},
			registerCommand: (name: string, command: unknown) => {
				commands.set(name, command);
			},
			sendUserMessage: (message: string) => {
				sentMessages.push(message);
			},
		},
		handlers,
		commands,
		sentMessages,
	};
}

export function fakeContext(sessionId = "ses-test", cwd = process.cwd()) {
	return {
		cwd,
		hasUI: true,
		signal: new AbortController().signal,
		ui: { notify: () => undefined },
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => [],
		},
		getContextUsage: () => ({ tokens: 0, percent: 0, contextWindow: 100_000 }),
	};
}
