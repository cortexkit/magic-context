function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/**
 * Oh My Pi's coding-agent src/prompts/system/date-cwd-reminder.md is identical in
 * 18.10.4, 18.12.3, 18.12.6 and 18.13.2. Only its date and absolute, slash-
 * normalized cwd vary; neither field may introduce markup or the § character.
 */
export function piDateReminderText(value: unknown, cwd?: string): boolean {
	if (typeof value !== "string") return false;
	const match =
		/^<system-reminder>\nToday: (\d{4}-\d{2}-\d{2}); current working directory: '([^\r\n<>§]+)'\. Do not repeat this information in your reply\.\n<\/system-reminder>$/u.exec(
			value,
		);
	if (!match) return false;
	const [, date, path] = match;
	if (
		[...path].some(
			(character) =>
				character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
		)
	)
		return false;
	const parsed = new Date(`${date}T00:00:00Z`);
	if (
		!Number.isFinite(parsed.getTime()) ||
		parsed.toISOString().slice(0, 10) !== date
	)
		return false;
	if (!/^(?:\/|[A-Za-z]:\/)/u.test(path) || path.includes("\\")) return false;
	return cwd === undefined || path === cwd.replace(/\\/gu, "/");
}

/** Anthropic keeps the injector's string developer content as a string. */
export function piDateReminderWireText(
	content: unknown,
	cwd?: string,
): string | undefined {
	if (typeof content === "string")
		return piDateReminderText(content, cwd) ? content : undefined;
	if (!Array.isArray(content) || content.length !== 1) return undefined;
	const block = object(content[0]);
	const cache = object(block?.cache_control);
	// The provider may wrap string content only to attach a cache breakpoint.
	if (
		block?.type !== "text" ||
		!cache ||
		cache.type !== "ephemeral" ||
		Object.keys(block).some(
			(key) => !["type", "text", "cache_control"].includes(key),
		) ||
		Object.keys(cache).some((key) => !["type", "ttl", "scope"].includes(key)) ||
		(cache.ttl !== undefined && cache.ttl !== "5m" && cache.ttl !== "1h") ||
		(cache.scope !== undefined && cache.scope !== "global")
	)
		return undefined;
	return piDateReminderText(block.text, cwd)
		? (block.text as string)
		: undefined;
}

export const PI_DATE_REMINDER_APIS = new Set([
	"anthropic-messages",
	"openai-completions",
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
	"bedrock-converse-stream",
	"google-generative-ai",
	"google-vertex",
	"google-gemini-cli",
	"ollama-chat",
]);

function singleText(value: unknown, type?: string): unknown {
	if (!Array.isArray(value) || value.length !== 1) return undefined;
	const part = object(value[0]);
	return part &&
		(type === undefined
			? Object.keys(part).length === 1
			: part.type === type && Object.keys(part).length === 2)
		? part.text
		: undefined;
}

/**
 * pi-ai 17.1.7, 18.8.9, 18.11.3, 18.12.3, 18.12.6, 18.13.0 and
 * 18.13.2 serialize these developer controls as independent rows. Anthropic
 * alone needs a second alignment because the controls change neighbour roles.
 */
export function piWithoutDateReminders(
	payload: unknown,
	api: string,
	cwd: string | undefined,
	developerRole: boolean,
	includesPreparedFirstUser: (prefix: unknown) => boolean,
): unknown | undefined {
	const body = object(payload);
	if (!body) return undefined;
	const google = api.startsWith("google-");
	const envelope = google ? (object(body.request) ?? body) : body;
	const field = google
		? "contents"
		: api.endsWith("responses")
			? "input"
			: "messages";
	const messages = envelope[field];
	if (!Array.isArray(messages)) return undefined;
	let firstUser = false;
	let removed = false;
	const kept: unknown[] = [];
	for (const value of messages) {
		const row = object(value);
		if (!row) return undefined;
		const text = google
			? singleText(row.parts)
			: api === "bedrock-converse-stream"
				? singleText(row.content)
				: api.endsWith("responses")
					? (singleText(row.content, "input_text") ??
						(api === "openai-codex-responses" ? row.content : undefined))
					: row.content;
		if (piDateReminderText(text, cwd)) {
			const keys = google
				? ["role", "parts"]
				: api.endsWith("responses")
					? ["role", "content", "type"]
					: ["role", "content"];
			const role =
				api === "ollama-chat"
					? "system"
					: api === "openai-completions" && developerRole
						? "developer"
						: "user";
			if (
				!firstUser ||
				row.role !== role ||
				Object.keys(row).some((key) => !keys.includes(key)) ||
				(row.type !== undefined && row.type !== "message")
			)
				return undefined;
			if (!removed) {
				const prefix = { ...envelope, [field]: kept };
				if (
					!includesPreparedFirstUser(
						google && body.request !== undefined
							? { ...body, request: prefix }
							: prefix,
					)
				)
					return undefined;
			}
			removed = true;
			continue;
		}
		if (
			row.role === "user" &&
			(typeof row.content === "string" ||
				(Array.isArray(row.content) &&
					row.content.some(
						(part) =>
							object(part)?.type === "input_text" ||
							object(part)?.type === "text" ||
							typeof object(part)?.text === "string",
					)) ||
				(Array.isArray(row.parts) &&
					row.parts.some((part) => typeof object(part)?.text === "string")))
		)
			firstUser = true;
		kept.push(value);
	}
	if (!removed) return undefined;
	const filtered = { ...envelope, [field]: kept };
	return google && body.request !== undefined
		? { ...body, request: filtered }
		: filtered;
}
