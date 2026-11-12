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
 *
 * Anthropic checks the last assistant turn in the request: the last run of
 * assistant messages and tool results, opened by a real user message. A real
 * user message after that run does not end the check, so a request that ends
 * in a new user message is still checked against the turn before it. That
 * turn's thinking must be sent exactly as returned, or not at all: an edited,
 * reordered or partly removed set (a gap) is rejected.
 */
export class LatestTurnThinkingValidator {
    /** A fixture may resume a provider-accepted legacy cache from known responses,
     * never infer it from the client's possibly edited replay. */
    resumeLegacy(scope: string, _userTurns: number, thinking: unknown[]): void {
        this.turns.set(scope, { thinking: structuredClone(thinking) as Block[], newTurn: false });
    }
	/**
	 * The thinking the mock returned for the latest assistant turn it answered,
	 * and whether the response to the request being answered starts a new turn.
	 */
	private turns = new Map<string, { thinking: Block[]; newTurn: boolean }>();

	check(scope: string, messages: Message[]): string | null {
		let lastAssistant = messages.length - 1;
		while (lastAssistant >= 0 && messages[lastAssistant]!.role !== "assistant")
			lastAssistant -= 1;
		// A response to a request that ends in a real user message after the
		// last assistant turn opens a new turn; otherwise it continues that turn.
		const newTurn = latestRealUserIndex(messages) > lastAssistant;
		const previous = this.turns.get(scope);
		if (!previous) {
			this.turns.set(scope, { thinking: [], newTurn });
			return null;
		}
		previous.newTurn = newTurn;
		if (lastAssistant < 0) return null;
		const start = latestRealUserIndex(messages.slice(0, lastAssistant)) + 1;
		const actual = messages
			.slice(start, lastAssistant + 1)
			.filter((m) => m.role === "assistant")
			.flatMap(blocks)
			.filter((b) => b.type === "thinking" || b.type === "redacted_thinking");
		if (bytes(actual) === bytes(previous.thinking)) return null;
		// Removing every block of the turn is accepted: Opus 5.5 accepted a
		// request with all signed thinking removed when probed live. Only the
		// blocks returned after that request are expected from then on.
		if (actual.length === 0) {
			previous.thinking = [];
			return null;
		}
		return "messages.1.content.0: thinking or redacted_thinking blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.";
	}

	returned(scope: string, content: unknown[]): void {
		const turn = this.turns.get(scope);
		if (!turn) throw new Error("Thinking validator did not check this request");
		if (turn.newTurn) {
			turn.thinking = [];
			turn.newTurn = false;
		}
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
