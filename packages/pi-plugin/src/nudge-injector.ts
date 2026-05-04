import type { ContextNudge } from "@magic-context/core/hooks/magic-context/nudger";
import type { ContextEvent } from "@mariozechner/pi-coding-agent";

type AgentMessage = ContextEvent["messages"][number];
type PiAssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

type TextLikeContent = { type: "text"; text: string };

const INSTRUCTION_NAME_PATTERN = /<instruction\s+name="([^"]+)">/;

/**
 * Inject a shared Magic Context nudge into Pi's LLM-bound AgentMessage array.
 *
 * OpenCode appends/reinjects nudges onto an existing safe assistant message and
 * stores that message id as an anchor for prompt-cache stability; see
 * `nudge-injection.ts` lines 80-127 for anchor reinjection and lines 134-183
 * for the backwards scan + in-place assistant mutation. It also avoids mutating
 * tool/thinking-bearing assistant messages because those may be protocol or
 * signed blocks (`nudge-injection.ts` lines 65-71 and 142-150).
 *
 * Pi's `context` event receives a fresh `AgentMessage[]` for each LLM-bound
 * transform and the handler replaces it by returning `{ messages }`, so there is
 * no long-lived Anthropic prompt-cache anchor to preserve at this layer. Rather
 * than rewriting user text or mutating a signed/tool-bearing assistant message,
 * this function returns a shallow-copied array with one synthetic assistant text
 * message inserted immediately before the latest user message. That keeps the
 * nudge role aligned with the shared `ContextNudge` (`type: "assistant"`) while
 * leaving every existing message object untouched.
 *
 * Idempotency: if the exact nudge text, or the same `<instruction name="...">`
 * wrapper, is already present in any text content, the original array reference
 * is returned unchanged. The nudger intentionally includes a leading `\n\n` in
 * `nudge.text`; this injector preserves it verbatim.
 */
export function injectPiNudge(
	messages: AgentMessage[],
	nudge: ContextNudge,
): AgentMessage[] {
	if (nudge.type !== "assistant" || nudge.text.length === 0) return messages;
	if (containsNudge(messages, nudge.text)) return messages;

	const output = messages.slice();
	const insertionIndex = findLatestUserMessageIndex(output);
	const nudgeMessage = createAssistantNudgeMessage(nudge.text, messages);

	if (insertionIndex === -1) {
		output.push(nudgeMessage);
	} else {
		output.splice(insertionIndex, 0, nudgeMessage);
	}

	return output;
}

function containsNudge(messages: AgentMessage[], nudgeText: string): boolean {
	const instructionName = extractInstructionName(nudgeText);
	for (const message of messages) {
		for (const text of getTextContent(message)) {
			if (text.includes(nudgeText)) return true;
			if (
				instructionName &&
				text.includes(`<instruction name="${instructionName}">`)
			) {
				return true;
			}
		}
	}
	return false;
}

function extractInstructionName(text: string): string | null {
	return INSTRUCTION_NAME_PATTERN.exec(text)?.[1] ?? null;
}

function findLatestUserMessageIndex(messages: AgentMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (getRole(messages[i]) === "user") return i;
	}
	return -1;
}

function createAssistantNudgeMessage(
	text: string,
	messages: AgentMessage[],
): PiAssistantMessage {
	const latestAssistant = findLatestAssistantMessage(messages);

	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: latestAssistant?.api ?? "magic-context",
		provider: latestAssistant?.provider ?? "magic-context",
		model: latestAssistant?.model ?? "magic-context/nudge",
		usage: latestAssistant?.usage ?? createZeroUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	} satisfies PiAssistantMessage;
}

function findLatestAssistantMessage(
	messages: AgentMessage[],
): PiAssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (isAssistantMessage(message)) return message;
	}
	return undefined;
}

function isAssistantMessage(
	message: AgentMessage | undefined,
): message is PiAssistantMessage {
	return getRole(message) === "assistant";
}

function createZeroUsage(): PiAssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}

function getTextContent(message: AgentMessage): string[] {
	if (!isRecord(message)) return [];
	const content = message.content;
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	return content.filter(isTextLikeContent).map((part) => part.text);
}

function getRole(message: AgentMessage | undefined): string | undefined {
	if (!isRecord(message)) return undefined;
	return typeof message.role === "string" ? message.role : undefined;
}

function isTextLikeContent(value: unknown): value is TextLikeContent {
	return (
		isRecord(value) && value.type === "text" && typeof value.text === "string"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}
