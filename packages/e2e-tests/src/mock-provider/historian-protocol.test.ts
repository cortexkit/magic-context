import { expect, test } from "bun:test";
import { COMPARTMENT_AGENT_SYSTEM_PROMPT } from "../../../plugin/src/hooks/magic-context/historian-prompt.generated";
import { TWO_PASS_SYSTEM, TWO_PASS_TURN_TWO } from "../../../plugin/src/hooks/magic-context/two-pass-prompts/prompts.generated";
import { buildMockHistorianPayload } from "../mock-historian";
import { historianTurnInRequest } from "./historian-protocol";
import { MockProvider, type MockResponse } from "./server";

const xml = buildMockHistorianPayload({ start: 1, end: 2, title: 'Quotes " & newline', body: "Summary\nwith <markup>." });
const usage = { input_tokens: 10, output_tokens: 20 };
const turnOne = "<new_messages>\n[1] U: task\n[2] A: done\n</new_messages>";
const turnTwo = TWO_PASS_TURN_TWO.replace("{{ALLOWED_FACT_IDS}}", "[]");

type API = "messages" | "chat/completions" | "responses";

function request(api: API, system: string, second = false): Record<string, unknown> {
    const messages = [
        { role: "user", content: [{ type: "text", text: turnOne }] },
        ...(second ? [
            { role: "assistant", content: [{ type: "text", text: JSON.stringify({ result: { step: "turn_one", xml } }) }] },
            { role: "user", content: [{ type: "text", text: turnTwo }] },
        ] : []),
    ];
    if (api === "messages") return { model: "mock", system: [{ type: "text", text: system }], messages, stream: false };
    if (api === "responses") return { model: "mock", instructions: system, input: messages, stream: false };
    return { model: "mock", messages: [{ role: "system", content: system }, ...messages], stream: false };
}

async function complete(mock: MockProvider, baseURL: string, api: API, body: Record<string, unknown>): Promise<string> {
    const response = await fetch(`${baseURL}/${api}`, { method: "POST", body: JSON.stringify(body) });
    expect(response.status).toBe(200);
    expect(mock.lastRequest()?.responseStatus).toBe(200);
    if (api === "chat/completions") {
        const events = (await response.text()).split("\n").filter((line) => line.startsWith("data: ") && line !== "data: [DONE]");
        return events.map((line) => {
            const chunk = JSON.parse(line.slice(6)) as { choices: Array<{ delta: { content?: string } }> };
            return chunk.choices[0].delta.content ?? "";
        }).join("");
    }
    const result = await response.json() as { content: Array<{ text: string }>; output: Array<{ type: string; content: Array<{ text: string }> }> };
    if (api === "messages") return result.content[0].text;
    return result.output.find((item) => item.type === "message")!.content[0].text;
}

for (const api of ["messages", "chat/completions", "responses"] as const) {
    test(`${api}: historian XML follows the requested one-pass or two-pass protocol`, async () => {
        const mock = new MockProvider();
        try {
            const { baseURL } = await mock.start();
            mock.addMatcher(() => ({ text: xml, usage }));
            expect(await complete(mock, baseURL, api, request(api, COMPARTMENT_AGENT_SYSTEM_PROMPT))).toBe(xml);
            expect(JSON.parse(await complete(mock, baseURL, api, request(api, TWO_PASS_SYSTEM)))).toEqual({ result: { step: "turn_one", xml } });
            expect(JSON.parse(await complete(mock, baseURL, api, request(api, TWO_PASS_SYSTEM, true)))).toEqual({ result: { step: "turn_two", decisions: [], scores: [] } });
        } finally {
            await mock.stop();
        }
    });
}

test("unscripted turn two leaves the next foreground response queued", async () => {
    const mock = new MockProvider();
    try {
        const { baseURL } = await mock.start();
        mock.script([{ text: "next foreground", usage }]);
        expect(JSON.parse(await complete(mock, baseURL, "messages", request("messages", TWO_PASS_SYSTEM, true)))).toEqual({ result: { step: "turn_two", decisions: [], scores: [] } });
        expect(await complete(mock, baseURL, "messages", { messages: [], stream: false })).toBe("next foreground");
    } finally {
        await mock.stop();
    }
});

test("registered XML system honors the explicit format instruction across retained turns", async () => {
    const mock = new MockProvider();
    const format = 'Reply with exactly one JSON object with a result object. On turn one use {"result":{"step":"turn_one","xml":"..."}}.';
    try {
        const { baseURL } = await mock.start();
        mock.addMatcher(() => ({ text: xml, usage }));
        for (const second of [false, true]) {
            const body = request("messages", COMPARTMENT_AGENT_SYSTEM_PROMPT, second);
            const messages = body.messages as Array<{ role: string; content: Array<{ type: string; text: string }> }>;
            messages[0].content.push({ type: "text", text: format });
            // A separate trailing format reminder must not hide the current turn's prompt.
            messages.push({ role: "user", content: [{ type: "text", text: format }] });
            const result = JSON.parse(await complete(mock, baseURL, "messages", body));
            expect(result).toEqual(second
                ? { result: { step: "turn_two", decisions: [], scores: [] } }
                : { result: { step: "turn_one", xml } });
        }
    } finally {
        await mock.stop();
    }
});

for (const route of ["matcher", "queue", "default"] as const) {
    test(`explicit turn-two decisions survive the ${route} route`, async () => {
        const mock = new MockProvider();
        const scripted: MockResponse = { text: JSON.stringify({ result: { step: "turn_two", decisions: [{ fact_id: 7, action: "abstain" }], scores: [] } }), usage };
        try {
            const { baseURL } = await mock.start();
            if (route === "matcher") mock.addMatcher(() => scripted);
            if (route === "queue") mock.script([scripted]);
            if (route === "default") mock.setDefault(scripted);
            expect(await complete(mock, baseURL, "messages", request("messages", TWO_PASS_SYSTEM, true))).toBe(scripted.text!);
        } finally {
            await mock.stop();
        }
    });
}

test("turn classification ignores retained turn-one XML and foreground transcript quotes", () => {
    expect(historianTurnInRequest(request("messages", TWO_PASS_SYSTEM, true))).toBe("turn_two");
    expect(historianTurnInRequest(request("messages", "Ordinary assistant"))).toBeNull();
    expect(historianTurnInRequest({ system: "Ordinary assistant", messages: [{ role: "user", content: TWO_PASS_SYSTEM + turnOne }] })).toBeNull();
    expect(historianTurnInRequest({ system: TWO_PASS_SYSTEM, messages: [{ role: "user", content: `<new_messages>\n${turnTwo}\n</new_messages>` }] })).toBe("turn_one");
    const body = request("responses", TWO_PASS_SYSTEM, true);
    body.input = [{ role: "developer", content: TWO_PASS_SYSTEM }, ...(body.input as unknown[])];
    delete body.instructions;
    expect(historianTurnInRequest(body)).toBe("turn_two");
});

test("content-only XML is wrapped once and explicit turn-one envelopes remain untouched", async () => {
    const mock = new MockProvider();
    try {
        const { baseURL } = await mock.start();
        const wrapped = JSON.stringify({ result: { step: "turn_one", xml } });
        mock.script([{ content: [{ type: "text", text: xml }], usage }, { text: wrapped, usage }]);
        expect(await complete(mock, baseURL, "messages", request("messages", TWO_PASS_SYSTEM))).toBe(wrapped);
        expect(await complete(mock, baseURL, "messages", request("messages", TWO_PASS_SYSTEM))).toBe(wrapped);
    } finally {
        await mock.stop();
    }
});
