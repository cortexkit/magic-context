import { join } from "node:path";
import { PRIMER_SEED_CAP_TOKENS } from "@magic-context/core/features/magic-context/dreamer/primer-seed";
import type { RawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { RAW_SUMMARY_TEXT_MAX_CHARS } from "@magic-context/core/hooks/magic-context/read-session-raw";
import {
	convertEntriesToRawMessagePage,
	iterateAsyncEntriesToRawMessageRange,
	iterateEntriesToRawMessageRange,
} from "../read-session-pi";
import {
	asyncLines,
	asyncSessionHeaders,
	lines,
} from "./bounded-session-reader";
import { resolvePiCodingAgentModule } from "./pi-session-api";

export interface PiPrimerRawProviderDeps {
	/** An explicit session directory, as accepted by SessionManager.listAll. */
	sessionDir?: string;
}

const MAX_PARTS = 256;
const TOOL_KEYS = [
	"description",
	"filePath",
	"path",
	"pattern",
	"query",
	"symbol",
	"module",
	"action",
	"command",
];

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
function short(value: unknown, max = 512): string | undefined {
	if (typeof value !== "string") return undefined;
	// Keep a long string unchanged when its estimated tokens fit the primer's
	// token budget; otherwise truncate it to the field's character limit.
	return value.length <= max || estimateTokens(value) <= PRIMER_SEED_CAP_TOKENS
		? value
		: value.slice(0, max);
}

/** Keep only text and the tool-input fields used by the OpenCode summary reader. */
function projectEntry(value: unknown): unknown {
	const entry = record(value);
	if (entry.type !== "message") return { type: entry.type };
	const message = record(entry.message);
	let content: unknown = [];
	if (message.role === "user" && typeof message.content === "string") {
		content = short(message.content, RAW_SUMMARY_TEXT_MAX_CHARS);
	} else if (message.role !== "toolResult" && Array.isArray(message.content)) {
		if (message.content.length > MAX_PARTS)
			throw new Error("Pi primer entry has too many parts");
		content = message.content.flatMap<unknown>((part) => {
			const p = record(part);
			if (p.type === "text")
				return [
					{ type: "text", text: short(p.text, RAW_SUMMARY_TEXT_MAX_CHARS) },
				];
			if (p.type !== "toolCall") return [];
			const args = record(p.arguments);
			return [
				{
					type: "toolCall",
					id: short(p.id),
					name: short(p.name),
					arguments: Object.fromEntries(
						TOOL_KEYS.map((key) => [key, short(args[key])]),
					),
				},
			];
		});
	}
	return {
		type: entry.type,
		id: entry.id,
		timestamp: entry.timestamp,
		message: {
			role: message.role,
			content,
			toolCallId: short(message.toolCallId),
			toolName: short(message.toolName),
		},
	};
}

function summaryProjector(): (parsed: unknown) => unknown {
	let pendingResults = 0;
	return (parsed) => {
		const entry = projectEntry(parsed);
		const e = record(entry);
		if (e.type === "message") {
			const m = record(e.message);
			if (m.role === "toolResult" && m.toolCallId) {
				// The canonical converter folds consecutive results into one user
				// row. Bound that row too, not only the number of rows in a page.
				if (++pendingResults > MAX_PARTS)
					throw new Error("Pi primer has too many consecutive tool results");
			} else if (m.role === "user" || m.role === "assistant")
				pendingResults = 0;
		}
		return entry;
	};
}

function* summaryEntries(path: string): Generator<unknown> {
	const project = summaryProjector();
	for (const line of lines(path)) {
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			/* Like Pi, ignore malformed lines rather than ending the session scan. */
		}
		if (entry !== undefined) yield project(entry);
	}
}

async function* asyncSummaryEntries(path: string): AsyncGenerator<unknown> {
	const project = summaryProjector();
	for await (const line of asyncLines(path)) {
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		yield project(entry);
	}
}

export function createPiPrimerRawProviderFactory(
	deps: PiPrimerRawProviderDeps = {},
): (sessionId: string) => Promise<RawMessageProvider | null> {
	return async (sessionId) => {
		try {
			let directory = deps.sessionDir;
			if (!directory) {
				const mod = (await resolvePiCodingAgentModule()) as {
					getAgentDir?: () => string;
				};
				if (!mod.getAgentDir) return null;
				directory = join(mod.getAgentDir(), "sessions");
			}
			let path: string | null = null;
			for await (const header of asyncSessionHeaders(
				directory,
				!deps.sessionDir,
			)) {
				if (header.id === sessionId) {
					path = header.path;
					break;
				}
			}
			if (!path) return null;
			const sessionPath = path;
			return {
				readMessages() {
					throw new Error("Pi primer history requires bounded pages");
				},
				iterateMessageRangeAsync(from, to) {
					return iterateAsyncEntriesToRawMessageRange(
						asyncSummaryEntries(sessionPath),
						from - 1,
						Number.MAX_SAFE_INTEGER,
						to,
					);
				},
				iterateMessageRange(from, to) {
					// One iterator owns the JSONL traversal. Closing it after an early
					// visitor exit also closes the bounded line reader's descriptor.
					return iterateEntriesToRawMessageRange(
						summaryEntries(path),
						from - 1,
						Number.MAX_SAFE_INTEGER,
						to,
					);
				},
				readMessagePage(after, limit, watermark) {
					// Re-open per page: no file descriptor survives early visitor
					// termination, and no earlier page or tool output is retained.
					return convertEntriesToRawMessagePage(
						summaryEntries(path),
						after,
						Math.min(50, limit),
						watermark,
					);
				},
			};
		} catch {
			return null;
		}
	};
}
