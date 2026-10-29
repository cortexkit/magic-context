import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { runMigrations } from "@magic-context/core/features/magic-context/migrations";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { getTagsBySession } from "@magic-context/core/features/magic-context/storage-tags";
import { setHarness } from "@magic-context/core/shared/harness";
import {
	createSqliteTurnDatabase,
	type Database,
} from "@magic-context/core/shared/sqlite";
import {
	__setPiTagSnapshotWorkerForTests,
	loadPiTagSnapshotCandidate,
	PI_FALLBACK_ROW_COLUMNS,
	PI_FALLBACK_ROW_PREDICATE,
	type PiFallbackTagRow,
	projectPiPassTag,
} from "./tag-snapshot-pi";

export type PiMessage = ContextEvent["messages"][number];

export function createTestDb(path = ":memory:"): Database {
	setHarness("pi");
	const db = createSqliteTurnDatabase(path);
	initializeDatabase(db);
	runMigrations(db);
	if (path === ":memory:") {
		// In-memory fixtures cannot be opened by a read-only worker connection.
		// This explicit fixture loader exercises owner publication; file-backed
		// hydration tests use the real worker and measure its transport separately.
		__setPiTagSnapshotWorkerForTests(db, (request, cached) => ({
			result: loadPiTagSnapshotCandidate(async (candidate) => {
				for (const row of getTagsBySession(db, request.sessionId))
					candidate.appendTag(
						request.projection === "pass" ? projectPiPassTag(row) : row,
					);
				candidate.end("tags");
				for (const row of db
					.prepare(
						`SELECT ${PI_FALLBACK_ROW_COLUMNS} FROM tags WHERE session_id = ? AND ${PI_FALLBACK_ROW_PREDICATE} ORDER BY tag_number, id`,
					)
					.all(request.sessionId))
					candidate.appendFallback(row as PiFallbackTagRow);
				candidate.end("fallback");
			}, cached).then((candidate) => ({
				candidate,
				generation: db
					.prepare(
						`SELECT COALESCE((SELECT value FROM schema_migrations_meta WHERE key = ?), '0') AS revision, COALESCE((SELECT tags_version FROM session_meta WHERE session_id = ?), 0) AS durable`,
					)
					.get(`tag_revision:${request.sessionId}`, request.sessionId) as {
					revision: string;
					durable: number;
				},
			})),
			released: Promise.resolve(),
			cancel: () => {},
		}));
	}
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

/**
 * Assistant usage recording a heavy reasoning step (more than the bounded
 * signed-thinking hold's 1,500 tokens), so a signed turn below the hold cap is
 * held for it.
 */
export function heavyReasoningUsage(reasoning = 1_600) {
	return {
		input: 0,
		output: reasoning,
		reasoning,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: reasoning,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
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

export function fakeContext(
	sessionId = "ses-test",
	cwd = process.cwd(),
	entryIds: string[] = ["entry-1"],
	/**
	 * Optional message references used as `entry.message` on each fake
	 * SessionEntry. Pi's runtime keeps `entry.message === sourceAgentMessage`
	 * by reference (session-manager.js:580), and Magic Context's
	 * `collectMessageEntryIdsByRef` relies on that reference identity to
	 * map event.messages → entry ids. Tests that want boundary-id
	 * resolution to work should pass the same message objects they put
	 * into `event.messages`. Without explicit messages, we fall back to
	 * synthesized userMessage instances — which intentionally do NOT
	 * match anything the test passes via `event.messages`, exercising
	 * the unmapped-slot fallback path.
	 */
	messages?: PiMessage[],
) {
	return {
		cwd,
		hasUI: true,
		signal: new AbortController().signal,
		ui: { notify: () => undefined },
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () =>
				entryIds.map((id, index) => ({
					type: "message",
					id,
					message: messages?.[index] ?? userMessage("", index + 1),
				})),
		},
		getContextUsage: () => ({ tokens: 0, percent: 0, contextWindow: 100_000 }),
	};
}
