import { expect, test } from "bun:test";
import { MockProvider } from "./server";

test("mock refuses a port already owned on its advertised IPv4 address", async () => {
    const foreign = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("foreign") });
    const mock = new MockProvider();
    try {
        await expect(mock.start({ port: foreign.port })).rejects.toThrow();
    } finally {
        await mock.stop();
        foreign.stop(true);
    }
});

test("advertised mock URL reaches the mock and unknown paths retain its 404 signature", async () => {
    const mock = new MockProvider();
    try {
        const { baseURL } = await mock.start();
        mock.setDefault({ text: "owned", usage: { input_tokens: 1, output_tokens: 1 } });
        const response = await fetch(`${baseURL}/messages`, { method: "POST", body: JSON.stringify({ model: "mock", messages: [], stream: false }) });
        expect(response.status).toBe(200);
        expect(mock.requests()).toHaveLength(1);
        const miss = await fetch(`${baseURL}/unknown`);
        expect(miss.status).toBe(404);
        expect(await miss.json()).toEqual({ error: "not_found", path: "/unknown" });
    } finally {
        await mock.stop();
    }
});

test("an Anthropic stream sends its start and keep-alive before the held answer", async () => {
    const mock = new MockProvider();
    const release = Promise.withResolvers<void>();
    try {
        const { baseURL } = await mock.start();
        mock.setDefault({
            text: "held answer",
            streamHoldUntil: release.promise,
            usage: { input_tokens: 1, output_tokens: 1 },
        });
        const response = await fetch(`${baseURL}/messages`, {
            method: "POST",
            body: JSON.stringify({ model: "mock", messages: [], stream: true }),
        });
        expect(response.status).toBe(200);
        const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
        let opening = "";
        while (!opening.includes('"type":"ping"')) {
            const part = await reader.read();
            if (part.done) throw new Error("stream ended before its keep-alive");
            opening += part.value;
        }
        expect(opening).toStartWith("event: message_start\n");
        expect(opening).not.toContain("event: content_block_start");
        expect(opening).not.toContain("event: message_stop");
        release.resolve();
        let answer = "";
        for (;;) {
            const part = await reader.read();
            if (part.done) break;
            answer += part.value;
        }
        expect(answer).toContain("held answer");
        expect(answer).toContain("event: message_stop");
    } finally {
        release.resolve();
        await mock.stop();
    }
}, 10_000);

test("an Anthropic stream can disconnect while held and be released afterward", async () => {
    const mock = new MockProvider();
    const release = Promise.withResolvers<void>();
    try {
        const { baseURL } = await mock.start();
        mock.setDefault({
            text: "held answer",
            streamHoldUntil: release.promise,
            usage: { input_tokens: 1, output_tokens: 1 },
        });
        const response = await fetch(`${baseURL}/messages`, {
            method: "POST",
            body: JSON.stringify({ model: "mock", messages: [], stream: true }),
        });
        const reader = response.body!.getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toStartWith(
            "event: message_start\n",
        );
        await reader.cancel();
        release.resolve();
        expect(await reader.read()).toEqual({ done: true, value: undefined });
    } finally {
        release.resolve();
        await mock.stop();
    }
});
