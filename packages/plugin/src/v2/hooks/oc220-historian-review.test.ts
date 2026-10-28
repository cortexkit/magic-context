import { expect, test } from "bun:test";
import {
    readSessionChunk,
    withRawMessageProvider,
} from "../../hooks/magic-context/read-session-chunk";
import type { RawMessage } from "../../hooks/magic-context/read-session-raw";
import type { StoreRow } from "../store-reader";
import { rawMessages } from "./store";

for (const source of ["shared", "oc2"] as const) {
    test(`historian review: ${source} merges users around an instruction without losing its ordinal`, () => {
        const input: RawMessage[] = [
            { id: "u1", ordinal: 1, role: "user", parts: [{ type: "text", text: "first" }] },
            {
                id: "sys2",
                ordinal: 2,
                role: "system",
                parts: [{ type: "text", text: "instructions" }],
            },
            { id: "u3", ordinal: 3, role: "user", parts: [{ type: "text", text: "second" }] },
        ];
        const messages =
            source === "shared"
                ? input
                : rawMessages(
                      input.map(
                          (message) =>
                              ({
                                  id: message.id,
                                  session_id: "historian-review",
                                  seq: message.ordinal,
                                  type: message.role,
                                  data: { text: (message.parts[0] as { text: string }).text },
                              }) as StoreRow,
                      ),
                  );
        const chunk = withRawMessageProvider(
            "historian-review",
            {
                readMessages: () => messages,
                getMessageCount: () => messages.length,
            },
            () => readSessionChunk("historian-review", 10_000, 1, 4),
        );
        expect(chunk.text).toBe("[1-3] U: first / second");
        expect(chunk.lines.map(({ ordinal, messageId }) => [ordinal, messageId])).toEqual([
            [1, "u1"],
            [2, "sys2"],
            [3, "u3"],
        ]);
        expect(chunk.messageCount).toBe(3);
        expect(chunk.endIndex).toBe(3);
        expect(chunk.endMessageId).toBe("u3");
    });
}
