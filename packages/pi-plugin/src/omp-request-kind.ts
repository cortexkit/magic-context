import type { ContextEvent } from "@earendil-works/pi-coding-agent";

// OMP marks an ephemeral request with a developer reminder and a final user
// prompt, both attributed to "agent" in the context event. Provider adapters
// erase attribution; reminder text on the wire is not proof of a side request.
const SIDE_REMINDER =
	"<system-reminder>\nEphemeral side-channel turn; reuses current conversation context.\nTool catalog attached only to keep prompt cache warm; tools NOT available this turn.\nDo NOT emit tool calls; reply plain text only. Tool calls discarded without execution.\n</system-reminder>";

function textContainsReminder(value: unknown): boolean {
	if (typeof value === "string") return value.trim() === SIDE_REMINDER;
	if (!Array.isArray(value)) return false;
	return value.some((block) => {
		if (!block || typeof block !== "object") return false;
		const part = block as { text?: unknown; content?: unknown };
		return typeof part.text === "string" && part.text.trim() === SIDE_REMINDER;
	});
}

export function isOmpSideContext(event: ContextEvent): boolean {
	const tail = event.messages.at(-1) as
		| { role?: unknown; attribution?: unknown }
		| undefined;
	if (tail?.role !== "user" || tail.attribution !== "agent") return false;
	return event.messages.some((message) => {
		const row = message as {
			role?: unknown;
			attribution?: unknown;
			content?: unknown;
		};
		return (
			row.role === "developer" &&
			row.attribution === "agent" &&
			textContainsReminder(row.content)
		);
	});
}

// The opening of OMP's stock advisor prompt (pi-coding-agent
// prompts/advisor/system.md). OMP makes it the first element of every
// advisor's system prompt and appends WATCHDOG.yml instructions after it
// (session/session-advisors.ts, #buildAdvisorRuntime), so it identifies stock
// and customised advisors alike. Up to 18.20.1 the file began with this
// conventions block; 18.20.2 removed it. Any other text before the role line,
// such as 18.2.6's differently worded conventions block, is not accepted.
const ADVISOR_CONVENTIONS =
	"<conventions>\nRFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. `NEVER`=`MUST NOT`; `AVOID`=`SHOULD NOT`.\n</conventions>\n\n";
const ADVISOR_ROLE =
	"User, code-quality, robustness advocate; peer-shadow main agent.\n";
const ADVISOR_WORKFLOW =
	"<workflow>\nReceive incremental agent transcript, including thoughts.\n";
// OMP's heading on the first message of every advisor update
// (advisor/delta-split.ts), and the row OMP puts first once it has compacted
// the advisor's own context (pi-agent-core
// compaction/prompts/compaction-summary-context.md).
const SESSION_UPDATE = "### Session update\n\n";
const COMPACTION_SUMMARY =
	"Prior model work/tool state available.\nMUST build on prior work; NEVER duplicate prior work.\n\n<summary>\n";
const CAPTURE_PREFIX =
	"Automated capture turn — not a user reply; user has not responded to your previous turn.";

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function firstText(
	value: unknown,
	type: "text" | "input_text",
): string | undefined {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return undefined;
	const part = record(value[0]);
	return part?.type === type && typeof part.text === "string"
		? part.text
		: undefined;
}

// Only consume the leading instruction run emitted by a provider adapter. A
// quoted prompt in user content, or instructions later in history, cannot turn
// an ordinary conversation into an advisor request.
function leadingInstructions(
	messages: unknown[],
	roles: readonly string[],
	inputBlocks = false,
) {
	const system: string[] = [];
	let index = 0;
	while (index < messages.length) {
		const message = record(messages[index]);
		if (typeof message?.role !== "string" || !roles.includes(message.role))
			break;
		const content = message.content;
		if (typeof content === "string") system.push(content);
		else if (
			inputBlocks &&
			message.type === "message" &&
			Array.isArray(content) &&
			content.length > 0 &&
			content.every(
				(part) =>
					record(part)?.type === "input_text" &&
					typeof record(part)?.text === "string",
			)
		) {
			// OpenAI Codex wraps extra developer prompts as type:"message" with
			// input_text blocks, unlike the other adapters' string content.
			system.push(content.map((part) => record(part)?.text).join("\n"));
		} else return undefined;
		index++;
	}
	return { system, messages: messages.slice(index) };
}

// OMP uses different envelopes for Messages, chat-completions and Responses.
// Keep their instruction locations and tool encodings separate: accepting a
// hybrid envelope would let unrelated fields establish an advisor exemption.
function providerRequest(payload: unknown) {
	const body = record(payload);
	if (!body || !Array.isArray(body.tools)) return undefined;
	if (Array.isArray(body.input)) {
		if (
			"messages" in body ||
			"system" in body ||
			(body.instructions !== undefined && typeof body.instructions !== "string")
		)
			return undefined;
		// Responses puts the advisor prompt in instructions or leading input
		// system/developer messages. Codex may also prepend extra developer
		// prompts to input, but instructions still owns the advisor identity.
		const leading = leadingInstructions(
			body.input,
			typeof body.instructions === "string"
				? ["developer"]
				: ["system", "developer"],
			typeof body.instructions === "string",
		);
		if (!leading) return undefined;
		return {
			messages: leading.messages,
			system:
				typeof body.instructions === "string"
					? [body.instructions]
					: leading.system.slice(0, 1),
			tools: body.tools.map((tool) => {
				const entry = record(tool);
				return entry?.type === "function" && !("function" in entry)
					? entry.name
					: undefined;
			}),
			textType: "input_text" as const,
		};
	}
	if (
		!Array.isArray(body.messages) ||
		"input" in body ||
		"instructions" in body
	)
		return undefined;
	if (!("system" in body)) {
		const leading = leadingInstructions(body.messages, ["system", "developer"]);
		if (!leading?.system.length) return undefined;
		return {
			...leading,
			system: leading.system.slice(0, 1),
			tools: body.tools.map((tool) => {
				const entry = record(tool);
				return entry?.type === "function" && !("name" in entry)
					? record(entry.function)?.name
					: undefined;
			}),
			textType: "text" as const,
		};
	}
	const system =
		typeof body.system === "string"
			? [body.system]
			: Array.isArray(body.system)
				? body.system.map(firstTextBlock)
				: [];
	const tools = body.tools.map((tool) => {
		const entry = record(tool);
		const name =
			entry && !("function" in entry) && entry.type !== "function"
				? entry.name
				: undefined;
		// Anthropic's OAuth login and escapeBuiltinToolNames option send
		// "_advise" instead of "advise". Undo that single provider prefix;
		// ordinary API-key requests can already have the unprefixed name.
		return typeof name === "string"
			? name.startsWith("_")
				? name.slice(1)
				: name
			: undefined;
	});
	return { messages: body.messages, system, tools, textType: "text" as const };
}

function firstTextBlock(value: unknown): string | undefined {
	const part = record(value);
	return part?.type === "text" && typeof part.text === "string"
		? part.text
		: undefined;
}

/** Whether an instruction text starts with OMP's stock advisor prompt, with or without its pre-18.20.2 conventions block. */
export function isOmpStockAdvisorPrompt(text: string | undefined): boolean {
	if (typeof text !== "string") return false;
	const body = text.startsWith(ADVISOR_CONVENTIONS)
		? text.slice(ADVISOR_CONVENTIONS.length)
		: text;
	return body.startsWith(ADVISOR_ROLE) && body.includes(ADVISOR_WORKFLOW);
}

/**
 * OMP's advisor reviews formatted copies of new conversation messages in its
 * own agent history. The stock advisor prompt must lead the provider's
 * instruction slot, which a typed prompt, a resumed history or a compaction
 * summary can never reach; the first-row heading alone is not enough, because
 * a user can type it as the first prompt of an ordinary session.
 */
export function isOmpAdvisorRequest(payload: unknown): boolean {
	const request = providerRequest(payload);
	if (!request?.tools.includes("advise")) return false;
	if (!request.system.some(isOmpStockAdvisorPrompt)) return false;
	const first = record(request.messages[0]);
	if (first?.role !== "user") return false;
	let text = firstText(first.content, request.textType)?.replace(
		/^<system-reminder>\nToday: [^\n]+\n<\/system-reminder>(?:\n|$)/,
		"",
	);
	// OpenAI adapters separate the date and working-directory reminder from
	// the review text. If the first block is only that reminder, read the next.
	if (text === "" && Array.isArray(first.content))
		text = firstText(first.content.slice(1, 2), request.textType);
	return (
		text?.startsWith(SESSION_UPDATE) === true ||
		text?.startsWith(COMPACTION_SUMMARY) === true
	);
}

/** OMP auto-learn copies raw conversation messages, skipping Magic Context's tagging/pruning; a main-pass receipt cannot authorize that copy. */
export function isOmpUnmanagedCaptureRequest(payload: unknown): boolean {
	return isOmpLegacyCaptureRequest(payload) || isOmpAutolearnCapture(payload);
}

/** The capture shape of OMP releases whose capture agent carried only the capture tools. */
function isOmpLegacyCaptureRequest(payload: unknown): boolean {
	const request = providerRequest(payload);
	if (
		!request?.tools.length ||
		!request.tools.every((name) => name === "manage_skill" || name === "learn")
	)
		return false;
	const last = record(request.messages.at(-1));
	return (
		last?.role === "user" &&
		firstText(last.content, request.textType)?.startsWith(CAPTURE_PREFIX) ===
			true
	);
}

// The prompt of OMP's automatic auto-learn capture turn (autolearn.autoContinue):
// prompts/system/autolearn-nudge-autocontinue.md, trimmed (autolearn/controller.ts:24).
// The same text in @oh-my-pi/pi-coding-agent 18.19.0, 18.20.0 and 18.20.3.
export const OMP_AUTOLEARN_CAPTURE_PROMPT =
	"Automated capture turn \u2014 not a user reply; user has not responded to your previous turn. Do not treat this prompt as their answer, approval to continue, or acceptance of any pending action; only the user can do so.\n\nIf your previous turn produced reusable output, capture it now only if it will genuinely help next time: repeatable procedure \u2192 managed skill (`manage_skill`); durable fact, convention, or user preference \u2192 remember with `learn` when memory enabled. If nothing worth keeping, do nothing.\n\nThen stop. Do not run other tools, resume prior work, answer pending questions, or produce a continuation reply. Yield; wait for the user's next prompt.";

// OMP's date and working-directory reminder (prompts/system/date-cwd-reminder.md,
// the same in 18.19.0, 18.20.0 and 18.20.3). It may prefix the newest user turn,
// in the same text or as its own leading block.
const DATE_CWD_REMINDER =
	/^<system-reminder>\nToday: [^\n]*; current working directory: '[^\n]*'\. Do not repeat this information in your reply\.\n<\/system-reminder>(?:\n|$)/;

function textBlocks(value: unknown, type: "text" | "input_text") {
	if (typeof value === "string") return [value];
	if (!Array.isArray(value)) return undefined;
	const texts: string[] = [];
	for (const block of value) {
		const part = record(block);
		if (part?.type !== type || typeof part.text !== "string") return undefined;
		texts.push(part.text);
	}
	return texts;
}

/** Whether a row is the capture prompt, after OMP's optional date reminder. */
function isCapturePrompt(
	row: Record<string, unknown>,
	type: "text" | "input_text",
) {
	if (row.role !== "user" && row.role !== "developer") return false;
	const texts = textBlocks(row.content, type);
	if (!texts?.length) return false;
	let [first, ...rest] = texts;
	first = first.replace(DATE_CWD_REMINDER, "");
	if (first === "" && rest.length) [first, ...rest] = rest;
	return rest.length === 0 && first === OMP_AUTOLEARN_CAPTURE_PROMPT;
}

const RESPONSES_TURN_ITEMS = new Set([
	"reasoning",
	"function_call",
	"function_call_output",
	"custom_tool_call",
	"custom_tool_call_output",
]);

/**
 * Rows the capture agent's own turns append after its prompt: its assistant
 * replies and tool exchanges, in each provider's encoding, and OMP's trailing
 * Juice item.
 */
function isCaptureTurnRow(row: Record<string, unknown>): boolean {
	if (row.role === "assistant" || row.role === "tool") return true;
	if (typeof row.type === "string" && RESPONSES_TURN_ITEMS.has(row.type))
		return true;
	if (isOmpJuiceItem(row)) return true;
	// Anthropic Messages returns tool results in a user row of result blocks.
	return (
		row.role === "user" &&
		Array.isArray(row.content) &&
		row.content.length > 0 &&
		row.content.every((block) => record(block)?.type === "tool_result")
	);
}

/**
 * OMP's automatic auto-learn capture (18.19.0, 18.20.0, 18.20.3; sdk.ts
 * createAutoLearnCaptureRunner :1802, :1816, :1826). After a main-session run
 * ends, a separate capture agent resends the session's raw messages with the
 * main system prompt, every main tool plus manage_skill and learn
 * (captureToolList :1775, :1789, :1799), and the capture prompt as its newest
 * turn. It runs no context hook, but OMP sends its requests through the main
 * session's before_provider_request hook. Later capture requests append the
 * capture agent's own replies and tool exchanges after the prompt.
 */
function isOmpAutolearnCapture(payload: unknown): boolean {
	const request = providerRequest(payload);
	// OMP starts no capture without one of its capture tools (sdk.ts :1807,
	// :1821, :1831).
	if (
		!request?.tools.some((name) => name === "manage_skill" || name === "learn")
	)
		return false;
	for (let index = request.messages.length - 1; index >= 0; index--) {
		const row = record(request.messages[index]);
		if (!row) return false;
		if (isCaptureTurnRow(row)) continue;
		return isCapturePrompt(row, request.textType);
	}
	return false;
}

// The values OMP's getJuiceValue can return (JUICE_EFFORT_MAP, with 8 for an
// unknown effort): @oh-my-pi/pi-ai src/providers/openai-shared.ts :3275-3288
// in 18.19.0 and 18.20.0, :3328-3341 in 18.20.3.
const JUICE_VALUES = new Set(["0", "2", "4", "8", "48", "112", "960"]);

/** OMP's reasoning-off Juice item, exactly as buildParams writes it. */
function isOmpJuiceItem(value: unknown): boolean {
	const item = record(value);
	if (!item || Object.keys(item).length !== 2 || item.role !== "developer")
		return false;
	const content = item.content;
	if (!Array.isArray(content) || content.length !== 1) return false;
	const part = record(content[0]);
	if (!part || Object.keys(part).length !== 2 || part.type !== "input_text")
		return false;
	const juice = /^# Juice: (\d+) !important$/.exec(String(part.text));
	return juice !== null && JUICE_VALUES.has(juice[1]);
}

/**
 * The request without OMP's trailing reasoning-off Juice item, which belongs
 * to no message and to none of Magic Context's prepared rows.
 *
 * When OMP forces reasoning off (externalThinking with the think tool, or a
 * caller's forceReasoningOff) for a model whose compat requires it, the
 * openai-responses provider appends a developer item `# Juice: <n> !important`
 * after the whole input, n being getJuiceValue of the requested effort
 * (buildParams, src/providers/openai-responses.ts :1972-1979 in 18.19.0 and
 * 18.20.0, :2020-2027 in 18.20.3). A chained continuation carries it after its
 * delta, and the chain records the request without it
 * (buildOpenAIResponsesChainedParams, :601-626 in 18.19.0 and 18.20.0,
 * :603-628 in 18.20.3). Other APIs never add it, and the catalog
 * sets the compat flag only for openai-responses (pi-catalog
 * src/compat/axes.ts:188).
 */
export function piWithoutOmpJuice(
	payload: unknown,
	model: { api?: unknown; compat?: unknown } | undefined,
): unknown {
	const body = record(payload);
	if (
		model?.api !== "openai-responses" ||
		record(model.compat)?.requiresReasoningOffJuiceInstruction !== true ||
		!body ||
		!Array.isArray(body.input) ||
		!isOmpJuiceItem(body.input.at(-1))
	)
		return payload;
	return { ...body, input: body.input.slice(0, -1) };
}
