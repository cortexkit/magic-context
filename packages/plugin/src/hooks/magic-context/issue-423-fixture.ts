import type { RawMessage } from "./read-session-raw";
import type { MessageLike } from "./tag-messages";

function buildIssue423Fixture(
    count: number,
    firstOutputMultiplier: number,
    options: { reasoning: boolean; openTail: boolean; firstInputMultiplier?: number },
) {
    const output = "result value\n".repeat(1667);
    const pi: Array<Record<string, unknown>> = [
        {
            role: "user",
            content: "Finish the entire investigation without asking me to continue.",
            timestamp: 1,
        },
    ];
    const opencode: Array<MessageLike & { info: { id: string; role: string } }> = [
        { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: pi[0].content }] },
    ];
    const finalIndex = options.openTail ? count : count - 1;
    for (let i = 0; i <= finalIndex; i++) {
        const firstInputMultiplier = options.firstInputMultiplier ?? 0;
        const largeInput = i === 0 && firstInputMultiplier > 0;
        const name = largeInput
            ? "write"
            : i >= count - 4 && i < count
              ? "ctx_reduce"
              : i % 3 === 0
                ? "read"
                : i % 3 === 1
                  ? "edit"
                  : "bash";
        const callID = `call-${i}`;
        const input = largeInput
            ? { filePath: "first.ts", content: output.repeat(firstInputMultiplier) }
            : { index: i };
        const text = output.repeat(i === 0 ? firstOutputMultiplier : 1);
        const reasoning = options.reasoning
            ? [{ type: "thinking", thinking: `reasoning-${i}`, signature: `sig-${i}` }]
            : [];
        pi.push({
            role: "assistant",
            content: [
                ...reasoning.map((part) => ({
                    type: part.type,
                    thinking: part.thinking,
                    thinkingSignature: part.signature,
                })),
                { type: "toolCall", id: callID, name, arguments: input },
            ],
            stopReason: "toolUse",
            timestamp: pi.length + 1,
        });
        opencode.push({
            info: { id: `m${opencode.length + 1}`, role: "assistant" },
            parts: [
                ...reasoning,
                options.reasoning
                    ? { type: "tool-invocation", tool: name, callID, args: input }
                    : { type: "tool", tool: name, callID, state: { input, status: "running" } },
            ],
        });
        if (options.openTail && i === finalIndex) break;
        pi.push({
            role: "toolResult",
            toolCallId: callID,
            toolName: name,
            content: [{ type: "text", text }],
            timestamp: pi.length + 1,
        });
        opencode.push({
            info: { id: `m${opencode.length + 1}`, role: "user" },
            parts: [
                { type: "tool", tool: name, callID, state: { output: text, status: "completed" } },
            ],
        });
    }
    const raw: RawMessage[] = opencode.map((message, i) => ({
        ordinal: i + 1,
        id: message.info.id,
        role: message.info.role,
        parts: structuredClone(message.parts),
    }));
    const entries = pi.map((message, i) => ({ type: "message", id: `m${i + 1}`, message }));
    return { pi, opencode, raw, entries, output };
}

/** One prompt followed by completed tool rounds, then one invocation still awaiting its result. */
export function issue423Fixture(count = 120, firstOutputMultiplier = 1, firstInputMultiplier = 0) {
    return buildIssue423Fixture(count, firstOutputMultiplier, {
        reasoning: false,
        openTail: true,
        firstInputMultiplier,
    });
}

/** Completed reasoning/tool rounds that expose same-role merge seams when an arc disappears. */
export function issue423ReasoningFixture(count = 18) {
    return buildIssue423Fixture(count, 1, { reasoning: true, openTail: false });
}
