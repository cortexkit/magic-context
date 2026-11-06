import type { RawMessage } from "./read-session-raw";

/** Parallel results finish in reverse order; selected batches insert a user message before their final result. */
export function issue424Fixture(
    count = 300,
    firstPayloadMultiplier = 1,
    seed = 1,
    payload: "outputs" | "inputs" = "outputs",
) {
    const pi: Array<Record<string, unknown>> = [
        { role: "user", content: "Investigate the entire project." },
    ];
    const raw: RawMessage[] = [
        {
            ordinal: 1,
            id: "m1",
            role: "user",
            parts: [{ type: "text", text: "Investigate the entire project." }],
        },
    ];
    const push = (message: Record<string, unknown>, role: string, parts: unknown[]) => {
        pi.push(message);
        raw.push({ ordinal: raw.length + 1, id: `m${raw.length + 1}`, role, parts });
    };
    let random = seed;
    for (let batch = 0; batch < count; batch++) {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        const calls = Array.from({ length: 2 + (random % 2) }, (_, i) => `batch-${batch}-${i}`);
        const multiplier = batch === 0 ? firstPayloadMultiplier : 1;
        const name = payload === "inputs" ? "write" : "read";
        const input =
            payload === "inputs"
                ? {
                      filePath: `batch-${batch}.ts`,
                      content: "result value\n".repeat(1667 * multiplier),
                  }
                : { batch };
        push(
            {
                role: "assistant",
                stopReason: "toolUse",
                content: calls.map((id) => ({
                    type: "toolCall",
                    id,
                    name,
                    arguments: input,
                })),
            },
            "assistant",
            calls.map((callID) => ({
                type: "tool",
                callID,
                tool: name,
                state: { input, status: "running" },
            })),
        );
        for (let i = calls.length - 1; i >= 0; i--) {
            if (i === 0 && batch % 50 === 25) {
                push({ role: "user", content: "Also check the related tests." }, "user", [
                    { type: "text", text: "Also check the related tests." },
                ]);
            }
            const text = "result value\n".repeat(1667 * (payload === "outputs" ? multiplier : 1));
            const callID = calls[i];
            if (callID === undefined) throw new Error("Missing fixture call");
            push(
                {
                    role: "toolResult",
                    toolCallId: callID,
                    toolName: name,
                    content: [{ type: "text", text }],
                },
                "user",
                [
                    {
                        type: "tool",
                        callID,
                        tool: name,
                        state: { output: text, status: "completed" },
                    },
                ],
            );
        }
    }
    return {
        raw,
        entries: pi.map((message, i) => ({ type: "message", id: `m${i + 1}`, message })),
    };
}
