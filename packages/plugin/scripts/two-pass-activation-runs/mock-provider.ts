import { createHash } from "node:crypto";

/** Synthetic usage is deliberately different on every request to expose last-step accounting. */
export function mockProvider(replyText: (request: Record<string, any>) => string, captured?: (requests: unknown[]) => void,
    observeHeaders?: (headers: Headers) => void,
    finishReason: (request: Record<string, any>) => "stop" | "length" = () => "stop") {
    const requests: Array<{ path: string; method: string; rawBody: string; rawBodyHash: string; body: Record<string, any>; inputTokens: number; outputTokens: number }> = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
        observeHeaders?.(request.headers);
        const rawBody = await request.text();
        let body: Record<string, any>;
        try {
            const value = JSON.parse(rawBody);
            body = value && typeof value === "object" && !Array.isArray(value) ? value : { unparsed: rawBody };
        } catch { body = { unparsed: rawBody }; }
        const index = requests.length;
        const inputTokens = 101 + index * 103;
        const outputTokens = 11 + index * 7;
        requests.push({ path: new URL(request.url).pathname, method: request.method,
            rawBody, rawBodyHash: createHash("sha256").update(rawBody).digest("hex"), body, inputTokens, outputTokens });
        captured?.(requests);
        const text = replyText(body);
        const finish = finishReason(body);
        const anthropic = new URL(request.url).pathname.endsWith("/messages");
        if (!body.stream) return Response.json(anthropic ? {
            id: `mock-${index}`, type: "message", role: "assistant", model: body.model,
            content: [{ type: "text", text }], stop_reason: finish === "length" ? "max_tokens" : "end_turn",
            usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        } : { id: `mock-${index}`, object: "chat.completion", created: 1, model: body.model,
            choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: finish }],
            usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens } });
        const events = anthropic ? [
            { type: "message_start", message: { id: `mock-${index}`, type: "message", role: "assistant", model: body.model,
                content: [], stop_reason: null, usage: { input_tokens: inputTokens, output_tokens: 0 } } },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
            { type: "content_block_stop", index: 0 },
            { type: "message_delta", delta: { stop_reason: finish === "length" ? "max_tokens" : "end_turn", stop_sequence: null }, usage: { output_tokens: outputTokens } },
            { type: "message_stop" },
        ] : [
            { choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens } },
        ].map((event) => ({ id: `mock-${index}`, object: "chat.completion.chunk", created: 1, model: body.model, ...event }));
        return new Response(events.map((event: Record<string, unknown>) => `${anthropic ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`).join("") + (anthropic ? "" : "data: [DONE]\n\n"),
            { headers: { "content-type": "text/event-stream" } });
    } });
    return { url: server.url.href.replace(/\/$/, ""), requests, close: () => server.stop(true) };
}

export function historianMockReply(request: Record<string, any>): string {
    const text = JSON.stringify(request);
    const factIds = [...text.matchAll(/## Fact (\d+)/g)].map((match) => Number(match[1]));
    if (factIds.length) {
        const target = text.match(/#(\d+) rev \d+/)?.[1];
        return JSON.stringify({ result: { step: "turn_two", decisions: factIds.map((fact_id) => target
            ? { fact_id, check: "Audit fixture.", action: "conflict", target_id: Number(target) } : { fact_id, check: "Audit fixture.", action: "new" }), scores: [] } });
    }
    if (/messages_processed|compartments|historian/i.test(text)) {
        const xml = '<output><compartments><compartment start="1" end="1" title="Record the 64 KiB chunk size" episode_type="design" importance="50"><p1>I recorded the user instruction that chunk size is 64 KiB.</p1><p2>I recorded a 64 KiB chunk size.</p2><p3>The chunk size is 64 KiB.</p3><p4>64 KiB chunk size</p4></compartment><compartment start="2" end="2" title="Acknowledge the setting" episode_type="design" importance="20"><p1>I acknowledged the corrected setting.</p1><p2>I acknowledged it.</p2><p3>Setting acknowledged.</p3><p4>Acknowledged</p4></compartment></compartments><facts><CONFIG_VALUES>* [at_compartment=1 messages=1] Chunk size: 64 KiB.</CONFIG_VALUES></facts><meta><messages_processed>1-2</messages_processed><unprocessed_from>3</unprocessed_from></meta></output>';
        return /turn_one/.test(text) ? JSON.stringify({ result: { step: "turn_one", xml } }) : xml;
    }
    return "Acknowledged: the corrected chunk size is 64 KiB.";
}
