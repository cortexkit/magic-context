import { readFileSync } from "node:fs";
import type { PiSessionFile } from "./analyze-pi-cache-busts";

type Json = Record<string, unknown>;

// Keep the pre-streaming parser independent of the implementation under test.
export function referenceParsePiSessionFile(
	filePath: string,
): PiSessionFile | undefined {
	let lines: string[];
	try {
		lines = readFileSync(filePath, "utf8").split("\n");
	} catch {
		return undefined;
	}
	let sessionId = "";
	let cwd: string | undefined;
	const entries: PiSessionFile["entries"] = [];
	const usage: PiSessionFile["usage"] = [];
	let ordinal = 0;
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
		const raw = lines[lineIndex].trim();
		if (!raw) continue;
		let entry: Json;
		try {
			entry = JSON.parse(raw) as Json;
		} catch {
			continue;
		}
		const type = typeof entry.type === "string" ? entry.type : "unknown";
		const marker = {
			ordinal,
			line: lineIndex + 1,
			type,
			toolName: entryToolName(entry),
		};
		entries.push(marker);
		ordinal += 1;
		if (type === "session" && typeof entry.id === "string") {
			sessionId = entry.id;
			cwd = typeof entry.cwd === "string" ? entry.cwd : cwd;
			continue;
		}
		if (type !== "message") continue;
		const message = asJson(entry.message);
		if (message?.role !== "assistant") continue;
		const usageValue = message.usage ?? message.tokens;
		const usageRecord = asJson(usageValue);
		if (!usageRecord) continue;
		const cache = asJson(usageRecord.cache);
		const input = getAnyNumber(usageRecord, ["input", "inputTokens"]);
		const cacheRead = cache
			? getAnyNumber(cache, ["read", "cacheRead", "cache_read"])
			: getAnyNumber(usageRecord, ["cache_read", "cacheRead"]);
		const cacheWrite = cache
			? getAnyNumber(cache, ["write", "cacheWrite", "cache_write"])
			: getAnyNumber(usageRecord, ["cache_write", "cacheWrite"]);
		const timestamp =
			parseTimestamp(message.timestamp) || parseTimestamp(entry.timestamp);
		if (timestamp === 0) continue;
		usage.push({
			timestamp,
			createdAt: new Date(timestamp).toISOString(),
			line: lineIndex + 1,
			ordinal: marker.ordinal,
			messageId:
				typeof entry.id === "string" ? entry.id : `line-${lineIndex + 1}`,
			input,
			cacheRead,
			cacheWrite,
			total: input + cacheRead + cacheWrite,
			...(typeof message.api === "string" ? { api: message.api } : {}),
			...(typeof message.provider === "string"
				? { provider: message.provider }
				: {}),
			...(typeof message.model === "string" ? { model: message.model } : {}),
		});
	}
	if (!sessionId) return undefined;
	usage.sort(
		(left, right) =>
			left.timestamp - right.timestamp || left.ordinal - right.ordinal,
	);
	return { sessionId, path: filePath, cwd, entries, usage };
}

function asJson(value: unknown): Json | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Json)
		: undefined;
}

function finiteNonnegative(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}

function getAnyNumber(value: unknown, keys: readonly string[]): number {
	const record = asJson(value);
	if (!record) return 0;
	for (const key of keys) {
		const candidate = finiteNonnegative(record[key]);
		if (candidate !== undefined) return candidate;
	}
	return 0;
}

function parseTimestamp(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string") return 0;
	const numeric = Number(value);
	if (Number.isFinite(numeric)) return numeric;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function entryToolName(entry: Json): string | undefined {
	const message = asJson(entry.message);
	const content = Array.isArray(message?.content) ? message.content : [];
	for (const part of content) {
		const record = asJson(part);
		for (const key of ["name", "toolName", "tool_name"] as const) {
			if (typeof record?.[key] === "string") return record[key] as string;
		}
	}
	for (const key of ["name", "command", "toolName", "tool_name"] as const) {
		if (typeof entry[key] === "string") return entry[key] as string;
	}
	return undefined;
}
