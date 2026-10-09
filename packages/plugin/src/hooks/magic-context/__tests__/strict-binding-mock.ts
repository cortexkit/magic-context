export type Block = Record<string, unknown> & { type: string };
export type Wire = { role: string; content: Block[] }[];

export const PREFIX_ERROR = "400: Invalid signature in thinking block: bound to a different conversation";

/**
 * Provider-owned receipts for a Messages-protocol mock. A receipt is minted
 * from an accepted request when the provider emits thinking, never from the
 * client's later replay. Host adapters supply only provider-visible blocks.
 * Message IDs and empty host shells are not part of the provider conversation.
 */
export class StrictBindingMock {
    private receipts: { signature: string; block: Block; prefix: Wire; turn: number }[] = [];
    private turn = 0;

    newUserTurn(): void { this.turn++; }

    emit(request: Wire): Block {
        const rejection = this.check(request);
        if (rejection) throw new Error(rejection);
        const block: Block = {
            type: "thinking",
            thinking: `Inspect files, then continue step ${this.receipts.length + 1}.`,
            signature: `mock-signature-${this.receipts.length + 1}`,
        };
        this.receipts.push({ signature: block.signature as string, block: structuredClone(block), prefix: structuredClone(request), turn: this.turn });
        return block;
    }

    check(request: Wire): string | null {
        const kept = request.flatMap(m => m.content).filter(b => b.type === "thinking");
        const signatures = kept.map(b => b.signature);
        const missing = new Set(this.receipts.filter(r => !signatures.includes(r.signature)).map(r => r.signature));
        const retained = this.receipts.map((r, i) => signatures.includes(r.signature) ? i : -1).filter(i => i >= 0);
        if (retained.length && retained.at(-1)! - retained[0]! + 1 !== retained.length) return "400: middle thinking removal";
        for (const receipt of this.receipts) {
            if (receipt.turn === this.turn && missing.has(receipt.signature)) return "400: latest assistant turn thinking modified";
        }
        // Legal thinking-only deletions do not count as prefix edits. All other
        // content, including unsigned arcs and tool arguments/results, does.
        const normalize = (wire: Wire): string => JSON.stringify(wire.flatMap(m => m.content.filter(b => !(b.type === "thinking" && missing.has(b.signature as string))).map(b => [m.role, b])));
        const prefix: Wire = [];
        for (const message of request) {
            const partial = { role: message.role, content: [] as Block[] };
            prefix.push(partial);
            for (const block of message.content) {
                if (block.type === "thinking") {
                    const receipt = this.receipts.find(r => r.signature === block.signature);
                    if (!receipt || JSON.stringify(block) !== JSON.stringify(receipt.block)) return "400: thinking bytes modified";
                    if (normalize(prefix) !== normalize(receipt.prefix)) return PREFIX_ERROR;
                }
                partial.content.push(block);
            }
        }
        return null;
    }
}
