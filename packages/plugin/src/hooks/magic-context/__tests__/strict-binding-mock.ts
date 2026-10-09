/**
 * A Messages-protocol provider mock that enforces Anthropic's strict thinking
 * binding the way Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5 do for accounts
 * created on or after 2026-08-31 (and for older accounts that set
 * `thinking.block_binding.prefix_mismatch_behavior: "error"`):
 *
 * - every signed thinking block is bound to the exact request prefix that was
 *   served when the provider produced it;
 * - any later change to that prefix (a deleted or edited message, a shortened
 *   tool_result, a changed tool_use input, an inserted block) invalidates the
 *   block and every later kept block;
 * - removing thinking blocks is not a prefix edit when they are removed from
 *   the start, from the end, or all of them; removing one from the middle is;
 * - thinking produced inside the current user turn may not be removed or
 *   changed at all.
 *
 * Receipts are minted from the request the provider accepted, never from the
 * client's later replay, so the mock cannot agree with a client that rewrites
 * its own history. Hosts convert their message arrays to `Wire` with only the
 * blocks their provider adapter actually sends (empty text and unsigned
 * reasoning are filtered by the real adapters and must be filtered here too).
 */
export type Block = Record<string, unknown> & { type: string };
export type Wire = { role: string; content: Block[] }[];

export const PREFIX_ERROR =
    "400: Invalid `signature` in `thinking` block: bound to a different conversation";
export const MIDDLE_ERROR = "400: a thinking block was removed from the middle";
export const LATEST_TURN_ERROR =
    "400: thinking blocks in the latest assistant turn cannot be modified";
export const BYTES_ERROR = "400: thinking block bytes or signature were modified";

interface Receipt {
    signature: string;
    block: Block;
    prefix: Wire;
    turn: number;
}

export class StrictBindingMock {
    private receipts: Receipt[] = [];
    private turn = 0;
    /** Every request the mock answered, in order. */
    readonly accepted: Wire[] = [];

    /** A real user message started a new turn; earlier thinking becomes removable. */
    newUserTurn(): void {
        this.turn++;
    }

    /**
     * Validate a request and answer it. With `withThinking` the answer carries a
     * new signed thinking block bound to this request; otherwise it carries
     * none (an interleaved step without thinking). Throws on a rejected request.
     */
    respond(request: Wire, withThinking = true): Block | null {
        const rejection = this.check(request);
        if (rejection) throw new Error(rejection);
        this.accepted.push(structuredClone(request));
        if (!withThinking) return null;
        const n = this.receipts.length + 1;
        const block: Block = {
            type: "thinking",
            thinking: `Inspect the next file, then continue (step ${n}).`,
            signature: `mock-signature-${n}`,
        };
        this.receipts.push({
            signature: block.signature as string,
            block: structuredClone(block),
            prefix: structuredClone(request),
            turn: this.turn,
        });
        return block;
    }

    /** The rejection a strict-binding provider would return, or null when accepted. */
    check(request: Wire): string | null {
        const sent = request.flatMap((m) => m.content).filter((b) => b.type === "thinking");
        const sentSignatures = new Set(sent.map((b) => b.signature as string));
        for (const block of sent) {
            const receipt = this.receipts.find((r) => r.signature === block.signature);
            if (!receipt || JSON.stringify(block) !== JSON.stringify(receipt.block))
                return BYTES_ERROR;
        }
        const kept = this.receipts
            .map((r, index) => (sentSignatures.has(r.signature) ? index : -1))
            .filter((index) => index >= 0);
        if (kept.length > 0 && kept.at(-1)! - kept[0]! + 1 !== kept.length) return MIDDLE_ERROR;
        if (this.receipts.some((r) => r.turn === this.turn && !sentSignatures.has(r.signature)))
            return LATEST_TURN_ERROR;
        // Legal thinking removals are not prefix edits; every other block is.
        const removed = new Set(
            this.receipts.filter((r) => !sentSignatures.has(r.signature)).map((r) => r.signature),
        );
        const normalize = (wire: Wire): string =>
            JSON.stringify(
                wire.flatMap((m) =>
                    m.content
                        .filter(
                            (b) => !(b.type === "thinking" && removed.has(b.signature as string)),
                        )
                        .map((b) => [m.role, b]),
                ),
            );
        const prefix: Wire = [];
        for (const message of request) {
            const partial = { role: message.role, content: [] as Block[] };
            prefix.push(partial);
            for (const block of message.content) {
                if (block.type === "thinking") {
                    const receipt = this.receipts.find((r) => r.signature === block.signature)!;
                    if (normalize(prefix) !== normalize(receipt.prefix)) return PREFIX_ERROR;
                }
                partial.content.push(block);
            }
        }
        return null;
    }
}

/** The request with every thinking block removed: what changed besides thinking. */
export function withoutThinking(wire: Wire): string {
    return JSON.stringify(
        wire.flatMap((m) => m.content.filter((b) => b.type !== "thinking").map((b) => [m.role, b])),
    );
}

/**
 * When `MC_AUDIT_STRICT=1`, every audit case asserts that the request is valid
 * under strict binding, so the exposed lanes fail. By default an exposed lane
 * asserts the exact rejection it produces today, which keeps the suite green
 * while pinning both the exposure and its reason.
 */
export const STRICT_AUDIT = process.env.MC_AUDIT_STRICT === "1";
