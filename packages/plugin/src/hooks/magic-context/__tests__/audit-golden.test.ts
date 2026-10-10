import { expect, it } from "bun:test";
import { PREFIX_ERROR, StrictBindingMock, type Wire } from "./strict-binding-mock";

it("mint-only capture preserves deterministic receipts without hiding invalid prefixes", () => {
    const mock = new StrictBindingMock(true);
    mock.newUserTurn();
    const first: Wire = [{ role: "user", content: [{ type: "text", text: "original" }] }];
    const signed = mock.respond(first)!;
    const changed: Wire = [
        { role: "user", content: [{ type: "text", text: "changed" }] },
        { role: "assistant", content: [signed] },
    ];
    expect(mock.check(changed)).toBe(PREFIX_ERROR);
    expect(mock.respond(changed)?.signature).toBe("mock-signature-2");
    expect(mock.hasCurrentTurnThinking(changed)).toBe(true);
    mock.newUserTurn();
    expect(mock.hasCurrentTurnThinking(changed)).toBe(false);
    expect(mock.accepted).toHaveLength(2);
});
