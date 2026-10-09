type Message = { role: string; content: unknown };
type Block = { type?: string };

const blocks = (message: Message): Block[] =>
	Array.isArray(message.content) ? (message.content as Block[]) : [];
const bytes = (value: unknown) =>
	JSON.stringify(value, (key, item) =>
		key === "cache_control" ? undefined : item,
	);

/** Tool results continue a turn; only a user message with other content ends it. */
export function latestRealUserIndex(messages: Message[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role !== "user") continue;
		if (
			!Array.isArray(message.content) ||
			blocks(message).some((b) => b.type !== "tool_result")
		)
			return i;
	}
	return -1;
}

/**
 * Provider-side oracle, opt-in for fixtures. Expected bytes come only from
 * responses emitted by the mock, never from the client's replayed history.
 * Scope separates concurrently running parent, child and title-generator calls.
 */
export class LatestTurnThinkingValidator {
    /** A fixture may resume a provider-accepted legacy cache from known responses,
     * never infer it from the client's possibly edited replay. */
    resumeLegacy(scope: string, userTurns: number, thinking: unknown[]): void {
        this.turns.set(scope, { userTurns, thinking: structuredClone(thinking) as Block[] });
    }
	private turns = new Map<string, { userTurns: number; thinking: Block[] }>();

	check(scope: string, messages: Message[]): string | null {
		const boundary = latestRealUserIndex(messages);
		const userTurns = messages.filter(
			(message) =>
				message.role === "user" &&
				(!Array.isArray(message.content) ||
					blocks(message).some((b) => b.type !== "tool_result")),
		).length;
		const previous = this.turns.get(scope);
		// Rewording an existing prompt is an edit, not a new user turn. In
		// particular it must not let a prefix edit erase the expected thinking.
		if (!previous || userTurns > previous.userTurns) {
			this.turns.set(scope, { userTurns, thinking: [] });
			return null;
		}
		const actual = messages
			.slice(boundary + 1)
			.filter((m) => m.role === "assistant")
			.flatMap(blocks)
			.filter((b) => b.type === "thinking" || b.type === "redacted_thinking");
		if (bytes(actual) === bytes(previous.thinking)) return null;
		return "messages.1.content.0: thinking or redacted_thinking blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.";
	}

	returned(scope: string, content: unknown[]): void {
		const turn = this.turns.get(scope);
		if (!turn) throw new Error("Thinking validator did not check this request");
		turn.thinking.push(
			...structuredClone(
				content.filter((b: unknown) => {
					const type = (b as Block).type;
					return type === "thinking" || type === "redacted_thinking";
				}) as Block[],
			),
		);
	}
}
