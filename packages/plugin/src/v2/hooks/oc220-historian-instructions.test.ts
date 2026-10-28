import { expect, test } from "bun:test";
import { isHostUnservedRow } from "../../hooks/magic-context/host-served-rows";
import {
    readSessionChunk,
    withRawMessageProvider,
} from "../../hooks/magic-context/read-session-chunk";
import type { RawMessage } from "../../hooks/magic-context/read-session-raw";
import type { StoreRow } from "../store-reader";
import { rawMessages } from "./store";

const update =
    'The context under "k" changed and supersedes the previous value:\n<context key="k">\nv2\n</context>';
const removal = 'The context under "k" no longer applies. Disregard it.';

const row = (seq: number, type: StoreRow["type"], text: string): StoreRow =>
    ({
        id: `row-${seq}`,
        session_id: "instructions",
        type,
        seq,
        data:
            type === "assistant"
                ? { content: [{ type: "text", text }], model: { providerID: "p", id: "m" } }
                : {
                      text,
                      ...(type === "system"
                          ? { metadata: { notice: "instructions", instructionSources: ["api/k"] } }
                          : {}),
                  },
    }) as StoreRow;

function chunk(messages: RawMessage[]) {
    return withRawMessageProvider(
        "instructions",
        { readMessages: () => messages, getMessageCount: () => messages.length },
        () => readSessionChunk("instructions", 10_000, 1, messages.length + 1),
    );
}

test("OC2 2.2.0 historian: instruction updates are not the user's words", () => {
    const messages = rawMessages([
        row(1, "user", "Review the cache."),
        row(2, "assistant", "Reviewing."),
        row(3, "system", update),
        row(4, "user", "Continue the review."),
        row(5, "system", removal),
    ]);
    expect(messages[2]!.role).toBe("system");
    expect(messages.map(isHostUnservedRow)).toEqual([false, false, true, false, true]);
    const result = chunk(messages);
    expect(result.text).toBe(
        "[1] U: Review the cache.\n[2] A: Reviewing.\n[3-4] U: Continue the review.",
    );
    expect(result.text).not.toContain("context under");
    expect(result.lines.map(({ ordinal, messageId }) => [ordinal, messageId])).toEqual(
        messages.map(({ ordinal, id }) => [ordinal, id]),
    );
    expect(result.lines.map(isHostUnservedRow)).toEqual([false, false, true, false, true]);
    expect(result.endIndex).toBe(5);
    expect(result.endMessageId).toBe("row-5");
    expect(result.messageCount).toBe(5);
    // Ordinary rows retain the pre-instruction projection and transcript bytes.
    const ordinary = rawMessages([
        row(1, "user", "Review the cache."),
        row(2, "assistant", "Reviewing."),
    ]);
    expect(JSON.stringify(ordinary)).toBe(
        '[{"id":"row-1","ordinal":1,"role":"user","parts":[{"type":"text","text":"Review the cache."}]},{"id":"row-2","ordinal":2,"role":"assistant","parts":[{"type":"text","text":"Reviewing."}]}]',
    );
    expect(chunk(ordinary).text).toBe("[1] U: Review the cache.\n[2] A: Reviewing.");
});

test("shared historian: system text is metadata-only even without the OC2 projection", () => {
    const result = chunk([
        { id: "u1", ordinal: 1, role: "user", parts: [{ type: "text", text: "hello" }] },
        { id: "sys", ordinal: 2, role: "system", parts: [{ type: "text", text: update }] },
        { id: "a3", ordinal: 3, role: "assistant", parts: [{ type: "text", text: "done" }] },
    ]);
    expect(result.text).toBe("[1] U: hello\n[2-3] A: done");
    expect(result.lines.map((line) => line.ordinal)).toEqual([1, 2, 3]);
    expect(result.messageCount).toBe(3);
    expect(result.hasMore).toBe(false);
});
