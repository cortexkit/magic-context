import type { MockResponse } from "./server";

type HistorianTurn = "turn_one" | "turn_two";

function text(value: unknown): string {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(text).join("\n");
    if (value && typeof value === "object") {
        const block = value as { text?: unknown; content?: unknown };
        return text(block.text ?? block.content);
    }
    return "";
}

/** Inspect the system contract and latest user turn, not the retained transcript. */
export function historianTurnInRequest(body: Record<string, unknown>): HistorianTurn | null {
    const messages = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : [];
    const system = [text(body.system), text(body.instructions)];
    const users: string[] = [];
    for (const message of messages) {
        if (!message || typeof message !== "object") continue;
        const { role, content } = message as { role?: string; content?: unknown };
        if (role === "system" || role === "developer") system.push(text(content));
        if (role === "user") users.push(text(content));
    }
    const combined = system.some((part) => part.includes("Reply with exactly one JSON object under a `result` wrapper."));
    // OpenCode 1 retains the registered XML system and sends the format contract in the user prompt.
    const formatInstruction = system.some((part) => part.includes("You are Historian")) && users.some((part) =>
        part.includes("Reply with exactly one JSON object with a result object. On turn one use"));
    if (!combined && !formatInstruction)
        return null;
    // Turn two keeps turn one's <new_messages> and reply in its conversation.
    for (const user of [...users].reverse()) {
        if (/^\s*Turn two: check each candidate fact, then compare it with project memory\.\s+allowed_fact_ids:/.test(user))
            return "turn_two";
        if (user.includes("<new_messages>")) return "turn_one";
    }
    return null;
}

export function emptyTurnTwoResponse(): MockResponse {
    return {
        text: JSON.stringify({ result: { step: "turn_two", decisions: [], scores: [] } }),
        usage: { input_tokens: 100, output_tokens: 20 },
    };
}

/** An explicit turn-two script takes precedence over the empty default. */
export function isTurnTwoResponse(response: MockResponse | null | undefined): boolean {
    try {
        return JSON.parse(response?.text ?? text(response?.content))?.result?.step === "turn_two";
    } catch {
        return false;
    }
}

/** Keep fixture XML and timing intact while honoring the requested wire contract. */
export function historianProtocolResponse(turn: HistorianTurn | null, response: MockResponse): MockResponse {
    if (!turn || response.error || response.openaiOutput) return response;
    const xml = response.text ?? text(response.content);
    if (!/^\s*<(?:output|compartments?)(?:\s|>)/.test(xml)) return response;
    const reply = turn === "turn_one"
        ? JSON.stringify({ result: { step: "turn_one", xml } })
        : emptyTurnTwoResponse().text!;
    return { ...response, content: undefined, text: reply };
}
