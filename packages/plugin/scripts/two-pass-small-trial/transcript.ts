import { requestHash } from "./prompts";
import type { Request } from "./provider";

function fence(text: string, language = "text"): string {
    const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
    const ticks = "`".repeat(longest + 1);
    return `${ticks}${language}\n${text}\n${ticks}`;
}

/** Full contents, with hashes of the actual serialized requests, not a preview. */
export function transcript(input: {
    caseId: number;
    firstRequest: Request;
    firstReply?: string;
    secondRequest?: Request;
    secondReply?: string;
    providerReplies?: Array<{ turn: number; attempt: number; raw: string }>;
}): string {
    const lines = [`# Case ${input.caseId} — exact two-pass transcript`, ""];
    for (const [turn, req, reply] of [
        [1, input.firstRequest, input.firstReply],
        [2, input.secondRequest, input.secondReply],
    ] as const) {
        if (!req) continue;
        const { messages, ...settings } = req;
        lines.push(
            `## Turn ${turn} request`,
            `SHA256 (JSON request): ${requestHash(req)}`,
            `UTF-8 bytes (JSON request): ${Buffer.byteLength(JSON.stringify(req))}`,
            "",
            "### Settings",
            fence(JSON.stringify(settings, null, 2), "json"),
        );
        messages.forEach((message, index) => {
            lines.push("", `### Message ${index + 1} — ${message.role}`, fence(message.content));
        });
        if (reply !== undefined) lines.push("", `## Turn ${turn} reply — assistant`, fence(reply));
        for (const response of input.providerReplies ?? []) {
            if (response.turn === turn)
                lines.push(
                    "",
                    `## Turn ${turn} provider response — attempt ${response.attempt + 1}`,
                    fence(response.raw, "json"),
                );
        }
    }
    return `${lines.join("\n")}\n`;
}
