// Run by the Rust differential test. Both clients POST to this one loopback
// server; the TypeScript provider is imported directly, not reimplemented.
import { OpenAICompatibleEmbeddingProvider } from "../../../../packages/plugin/src/features/magic-context/memory/embedding-openai";

interface Case {
    config: {
        model: string;
        api_key?: string;
        input_type?: string;
        query_input_type?: string;
        query_instruction?: string | false;
        document_prefix?: string;
        truncate?: string;
        max_input_tokens?: number;
    };
    kind: "query" | "passage";
    texts: string[];
    status?: number;
    raw_response?: string;
    response?: unknown;
}
const cases: Case[] = await Bun.file(Bun.argv[2]!).json();
const requests: unknown[] = [];
const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
        const bytes = new Uint8Array(await request.arrayBuffer());
        const body = new TextDecoder().decode(bytes);
        const transportHeaders = new Set(["host", "content-length", "connection", "user-agent", "accept-encoding", "accept"]);
        const headers = Object.fromEntries(
            [...request.headers].filter(([key]) => !transportHeaders.has(key)),
        );
        if (headers.authorization) {
            const scheme = headers.authorization.split(/\s+/, 1)[0];
            headers.authorization = `${scheme} <redacted>`;
        }
        requests.push({ method: request.method, path: new URL(request.url).pathname, headers, body: Array.from(bytes) });
        const index = Number(new URL(request.url).pathname.match(/case-(\d+)/)?.[1]);
        const test = cases[index]!;
        const input = (JSON.parse(body) as { input: string[] }).input;
        const response = test.response ?? {
            model: test.config.model.trim(),
            data: input.map((_, index) => ({ index, embedding: [3 + index, 4, -0.125, 1 / 3] })).reverse(),
        };
        return new Response(test.raw_response ?? JSON.stringify(response), {
            status: test.status ?? 200,
            headers: { "content-type": "application/json" },
        });
    },
});
try {
    const endpoint = `http://127.0.0.1:${server.port}/v1`;
    const results = [];
    for (const [index, test] of cases.entries()) {
        const config = test.config;
        const caseEndpoint = `${endpoint}/case-${index}`;
        const provider = new OpenAICompatibleEmbeddingProvider({
            endpoint: ` ${caseEndpoint}/// `,
            model: config.model,
            apiKey: config.api_key,
            inputType: config.input_type,
            queryInputType: config.query_input_type,
            queryInstruction: config.query_instruction,
            documentPrefix: config.document_prefix,
            truncate: config.truncate,
            maxInputTokens: config.max_input_tokens,
        });
        const vectors = await provider.embedBatch(test.texts, undefined, test.kind);
        // An HTTP 429 is back-pressure, not a failure: it leaves no failure class,
        // only a cooldown on this endpoint. Report it so Rust can be held to it.
        const rateLimited = provider._getRateLimitedUntil() > Date.now();
        results.push({ endpoint: caseEndpoint, modelId: provider.modelId, vectors: vectors.map((v) => v && Array.from(v)), failure: provider.getLastFailureReason()?.class ?? null, retryable: provider.getLastFailureReason()?.retryable ?? null, rateLimited });
    }
    console.log(JSON.stringify({ endpoint, results, requests }));
    // Keep the same server alive until Rust finishes its half of the experiment.
    for await (const _ of Bun.stdin.stream()) break;
    console.log(JSON.stringify({ requests }));
} finally {
    server.stop(true);
}
