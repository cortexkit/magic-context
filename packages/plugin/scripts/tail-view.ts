#!/usr/bin/env bun

/**
 * Show all user/assistant messages since the last compartment,
 * marking dropped ones with [D].
 *
 * Usage:
 *   bun scripts/tail-view.ts <session_id>
 *   bun scripts/tail-view.ts <session_id> --all    # include tool calls
 *   bun scripts/tail-view.ts <session_id> --from N  # from ordinal N
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";

// --- DB paths ---

function getDataDir(): string {
	return join(process.env.HOME ?? "~", ".local", "share");
}

function openOpenCodeDb(): Database {
	return new Database(join(getDataDir(), "opencode", "opencode.db"), { readonly: true });
}

function openPluginDb(): Database {
	return new Database(
		join(getDataDir(), "opencode", "storage", "plugin", "magic-context", "context.db"),
		{ readonly: true },
	);
}

// --- Types ---

interface RawMessageRow {
	id: string;
	data: string;
}

interface RawPartRow {
	message_id: string;
	data: string;
}

interface ParsedPart {
	type: string;
	text?: string;
	callID?: string;
	[key: string]: unknown;
}

interface TailMessage {
	ordinal: number;
	messageId: string;
	role: string;
	textParts: { partIndex: number; text: string; tagNumber: number | null; dropped: boolean }[];
	toolParts: { callId: string; tagNumber: number | null; dropped: boolean; toolName?: string }[];
}

// --- Read OpenCode messages ---

function readSessionMessages(
	ocDb: Database,
	sessionId: string,
): { id: string; role: string; parts: ParsedPart[] }[] {
	const messageRows = ocDb
		.prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC")
		.all(sessionId)
		.filter((row): row is RawMessageRow => {
			const r = row as Record<string, unknown>;
			return typeof r.id === "string" && typeof r.data === "string";
		});

	const partRows = ocDb
		.prepare(
			"SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created ASC, id ASC",
		)
		.all(sessionId)
		.filter((row): row is RawPartRow => {
			const r = row as Record<string, unknown>;
			return typeof r.message_id === "string" && typeof r.data === "string";
		});

	const partsByMessageId = new Map<string, ParsedPart[]>();
	for (const part of partRows) {
		const list = partsByMessageId.get(part.message_id) ?? [];
		try {
			list.push(JSON.parse(part.data) as ParsedPart);
		} catch {
			// skip unparseable parts
		}
		partsByMessageId.set(part.message_id, list);
	}

	return messageRows.map((row) => {
		let role = "unknown";
		try {
			const info = JSON.parse(row.data) as Record<string, unknown>;
			if (typeof info.role === "string") role = info.role;
		} catch {
			// ignore
		}
		return {
			id: row.id,
			role,
			parts: partsByMessageId.get(row.id) ?? [],
		};
	});
}

// --- Read tag status ---

interface TagInfo {
	tagNumber: number;
	messageId: string;
	type: string;
	status: string;
}

function readTags(pluginDb: Database, sessionId: string): TagInfo[] {
	const rows = pluginDb
		.prepare("SELECT tag_number, message_id, type, status FROM tags WHERE session_id = ?")
		.all(sessionId);
	return (rows as Record<string, unknown>[]).map((row) => ({
		tagNumber: row.tag_number as number,
		messageId: row.message_id as string,
		type: row.type as string,
		status: row.status as string,
	}));
}

// --- Get last compartment end ---

function getLastCompartmentEnd(pluginDb: Database, sessionId: string): number {
	const row = pluginDb
		.prepare("SELECT MAX(end_message) as max_end FROM compartments WHERE session_id = ?")
		.get(sessionId) as { max_end: number | null } | null;
	return row?.max_end ?? 0;
}

// --- Extract text from parts ---

function extractPartText(part: ParsedPart): string | null {
	if (part.type === "text" && typeof part.text === "string") {
		return part.text;
	}
	return null;
}

function isToolPart(part: ParsedPart): boolean {
	return part.type === "tool-invocation" || part.type === "tool-result";
}

// --- Build tail view ---

function buildTailMessages(
	ocDb: Database,
	pluginDb: Database,
	sessionId: string,
	fromOrdinal: number,
): TailMessage[] {
	const messages = readSessionMessages(ocDb, sessionId);
	const tags = readTags(pluginDb, sessionId);

	// Build tag lookup: messageId (from tag) -> TagInfo
	// Message tags: "msg_xxx:pN" -> tag
	// Tool tags: "toolu_xxx" -> tag
	const tagByKey = new Map<string, TagInfo>();
	for (const tag of tags) {
		tagByKey.set(tag.messageId, tag);
	}

	const result: TailMessage[] = [];

	for (let i = 0; i < messages.length; i++) {
		const ordinal = i + 1;
		if (ordinal < fromOrdinal) continue;

		const msg = messages[i]!;
		const textParts: TailMessage["textParts"] = [];
		const toolParts: TailMessage["toolParts"] = [];

		for (let partIdx = 0; partIdx < msg.parts.length; partIdx++) {
			const part = msg.parts[partIdx]!;
			const text = extractPartText(part);

			if (text !== null) {
				const tagKey = `${msg.id}:p${partIdx}`;
				const tag = tagByKey.get(tagKey);
				textParts.push({
					partIndex: partIdx,
					text,
					tagNumber: tag?.tagNumber ?? null,
					dropped: tag?.status === "dropped",
				});
			} else if (isToolPart(part)) {
				const callId =
					typeof part.toolInvocationId === "string"
						? part.toolInvocationId
						: typeof part.callID === "string"
							? part.callID
							: null;
				if (callId) {
					const tag = tagByKey.get(callId);
					toolParts.push({
						callId,
						tagNumber: tag?.tagNumber ?? null,
						dropped: tag?.status === "dropped",
						toolName: typeof part.toolName === "string" ? part.toolName : undefined,
					});
				}
			}
		}

		if (textParts.length > 0 || toolParts.length > 0) {
			result.push({
				ordinal,
				messageId: msg.id,
				role: msg.role,
				textParts,
				toolParts,
			});
		}
	}

	return result;
}

// --- Format output ---

function roleLabel(role: string): string {
	switch (role) {
		case "user":
			return "U";
		case "assistant":
			return "A";
		case "system":
			return "S";
		default:
			return role.charAt(0).toUpperCase();
	}
}

function truncate(text: string, maxLen: number): string {
	const oneLine = text.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
	if (oneLine.length <= maxLen) return oneLine;
	return `${oneLine.slice(0, maxLen - 3)}...`;
}

function formatTailView(messages: TailMessage[], includeTools: boolean): string {
	const lines: string[] = [];
	let totalMessages = 0;
	let droppedMessages = 0;
	let activeMessages = 0;

	for (const msg of messages) {
		const hasText = msg.textParts.length > 0;
		const hasTools = msg.toolParts.length > 0;

		if (!includeTools && !hasText) continue;

		totalMessages++;

		// Check if ALL parts of this message are dropped
		const allTextDropped = msg.textParts.every((p) => p.dropped);
		const allToolDropped = msg.toolParts.every((p) => p.dropped);
		const allDropped = allTextDropped && allToolDropped && (hasText || hasTools);

		if (allDropped) {
			droppedMessages++;
		} else {
			activeMessages++;
		}

		// Show text parts
		for (const tp of msg.textParts) {
			const dropMark = tp.dropped ? "[D]" : "   ";
			const tagStr = tp.tagNumber !== null ? `§${tp.tagNumber}§` : "§?§";
			const preview = truncate(tp.text, 120);
			lines.push(`${dropMark} ${tagStr.padEnd(9)} ${roleLabel(msg.role)} #${String(msg.ordinal).padEnd(5)} ${preview}`);
		}

		// Show tool parts (if requested)
		if (includeTools) {
			for (const tp of msg.toolParts) {
				const dropMark = tp.dropped ? "[D]" : "   ";
				const tagStr = tp.tagNumber !== null ? `§${tp.tagNumber}§` : "§?§";
				const toolLabel = tp.toolName ? `tool:${tp.toolName}` : `tool:${tp.callId.slice(0, 20)}`;
				lines.push(`${dropMark} ${tagStr.padEnd(9)} ${roleLabel(msg.role)} #${String(msg.ordinal).padEnd(5)} ${toolLabel}`);
			}
		}
	}

	const header = [
		"",
		`Total messages: ${totalMessages}  Active: ${activeMessages}  Dropped: ${droppedMessages}`,
		"─".repeat(80),
		"",
	];

	return [...header, ...lines].join("\n");
}

// --- Main ---

function parseArgs(argv: string[]): { sessionId: string; includeTools: boolean; fromOrdinal: number | null } {
	let sessionId = "";
	let includeTools = false;
	let fromOrdinal: number | null = null;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--all") {
			includeTools = true;
		} else if (arg === "--from") {
			const val = argv[i + 1];
			if (!val) throw new Error("Missing value for --from");
			fromOrdinal = Number.parseInt(val, 10);
			if (Number.isNaN(fromOrdinal)) throw new Error(`Invalid --from value: ${val}`);
			i++;
		} else if (!sessionId) {
			sessionId = arg;
		}
	}

	if (!sessionId) {
		throw new Error("Usage: bun scripts/tail-view.ts <session_id> [--all] [--from N]");
	}

	return { sessionId, includeTools, fromOrdinal };
}

function main(): void {
	const args = parseArgs(process.argv.slice(2));
	const ocDb = openOpenCodeDb();
	const pluginDb = openPluginDb();

	try {
		const lastCompartmentEnd = getLastCompartmentEnd(pluginDb, args.sessionId);
		const fromOrdinal = args.fromOrdinal ?? lastCompartmentEnd + 1;

		console.log(`Session: ${args.sessionId}`);
		console.log(`Last compartment end: ${lastCompartmentEnd}`);
		console.log(`Showing from ordinal: ${fromOrdinal}`);

		const messages = buildTailMessages(ocDb, pluginDb, args.sessionId, fromOrdinal);
		const output = formatTailView(messages, args.includeTools);
		console.log(output);
	} finally {
		ocDb.close();
		pluginDb.close();
	}
}

main();
