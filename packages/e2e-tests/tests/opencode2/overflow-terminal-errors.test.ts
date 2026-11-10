import { openTestDb } from "../../src/test-db";
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { MockProvider } from "../../src/mock-provider/server";
import { isolation, spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";

// The standard lane uses its pinned CLI; exact-version compatibility runs use the
// CLI/schema overrides documented in src/opencode2-runner/README.md.
test("arms recovery for HTTP and streaming OpenAI overflows", async () => {
    const fixture = isolation();
    const probe = join(fixture.root, "error-probe");
    const trace = join(fixture.root, "http-response.jsonl");
    const events = join(fixture.root, "terminal-events.jsonl");
    mkdirSync(probe);
    writeFileSync(trace, "");
    writeFileSync(events, "");
    writeFileSync(
        join(probe, "server.js"),
        `
import { appendFileSync } from 'node:fs';
export default { id: 'overflow-error-probe', async setup(context) {
    (async () => {
        for await (const event of context.event.subscribe({})) {
            if (event.type.includes('failed') || event.type === 'session.error')
                appendFileSync(${JSON.stringify(events)}, JSON.stringify(event) + '\\n');
        }
    })().catch(() => {});
    await context.session.hook('http.response', async draft => {
        appendFileSync(${JSON.stringify(trace)}, JSON.stringify({
            keys: Object.keys(draft), kind: draft.kind, sessionID: draft.sessionID,
            model: draft.model, status: draft.response.status,
            body: draft.response.ok ? null : await draft.response.clone().text()
        }) + '\\n');
    });
}};
`,
    );
    const mock = new MockProvider();
    const upstream = await mock.start();
    mock.setDefault({
        text: "accepted baseline",
        usage: { input_tokens: 40_000, output_tokens: 10 },
    });
    const errorBody = {
        error: {
            message: "Your input exceeds the context window of this model",
            type: "invalid_request_error",
            param: null,
            code: "context_length_exceeded",
        },
    };
    let overflow: "http" | "sse" | undefined;
    let rejected = 0;
    const proxy = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
            if (overflow && request.method === "POST") {
                rejected++;
                if (overflow === "sse") {
                    const failure = {
                        type: "response.failed",
                        sequence_number: 1,
                        response: {
                            id: "resp_overflow",
                            object: "response",
                            created_at: 1,
                            model: "mock-model",
                            status: "failed",
                            output: [],
                            error: errorBody.error,
                        },
                    };
                    return new Response(
                        `event: response.failed\ndata: ${JSON.stringify(failure)}\n\ndata: [DONE]\n\n`,
                        {
                            headers: { "content-type": "text/event-stream" },
                        },
                    );
                }
                return Response.json(errorBody, { status: 400 });
            }
            const url = new URL(request.url);
            const headers = new Headers(request.headers);
            headers.delete("host");
            return fetch(`${upstream.baseURL}${url.pathname}${url.search}`, {
                method: request.method,
                headers,
                body: request.method === "POST" ? await request.arrayBuffer() : undefined,
            });
        },
    });
    const host = await spawnOpencode2({
        existingIsolation: fixture,
        existingMock: { mock, baseURL: `http://127.0.0.1:${proxy.port}` },
        prePlugin: probe,
        compactionAuto: false,
        modelContextLimit: 300_000,
        modelOutputLimit: 1_024,
        magicContextConfig: { dreamer: { disable: true }, memory: { enabled: false } },
    });
    try {
        const client = OpenCode.make({
            baseUrl: host.url,
            headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
        });
        await waitForPluginActive(client, host.cwd);
        const readState = (sessionID: string) => {
            const db = openTestDb(join(fixture.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db"), {
                readonly: true,
            });
            try {
                return db
                    .query(
                        "SELECT needs_emergency_recovery, detected_context_limit, last_input_tokens FROM session_meta WHERE session_id = ?",
                    )
                    .get(sessionID) as {
                    needs_emergency_recovery: number;
                    detected_context_limit: number;
                    last_input_tokens: number;
                } | null;
            } finally {
                db.close();
            }
        };
        for (const transport of ["http", "sse"] as const) {
            overflow = undefined;
            const session = await client.session.create({
                title: `issue 827 ${transport} overflow reproduction`,
                location: { directory: host.cwd },
                model: { providerID: "openai", id: "mock-model" },
            });
            const send = async (text: string) => {
                await client.session.prompt({ sessionID: session.id, text });
                return client.session.wait(
                    { sessionID: session.id },
                    { signal: AbortSignal.timeout(30_000) },
                );
            };
            await send("establish a successful baseline");
            const deadline = Date.now() + 10_000;
            while (readState(session.id)?.last_input_tokens !== 40_000 && Date.now() < deadline)
                await Bun.sleep(50);
            const before = readState(session.id);
            expect(before).toMatchObject({
                needs_emergency_recovery: 0,
                last_input_tokens: 40_000,
            });
            overflow = transport;
            const rejectedBefore = rejected;
            const outcome = await send("return the exact OpenAI overflow error");
            const failures = () =>
                readFileSync(events, "utf8")
                    .trim()
                    .split("\n")
                    .filter(Boolean)
                    .map(
                        (line) =>
                            JSON.parse(line) as {
                                type: string;
                                data?: { sessionID?: string; error?: unknown };
                            },
                    )
                    .filter(
                        (event) =>
                            event.type === "session.execution.failed" &&
                            event.data?.sessionID === session.id,
                    );
            const failureDeadline = Date.now() + 15_000;
            while (!failures().length && Date.now() < failureDeadline) await Bun.sleep(50);
            expect(JSON.stringify(failures())).toContain(
                "Your input exceeds the context window of this model",
            );
            const after = readState(session.id);
            console.log(
                JSON.stringify({
                    transport,
                    root: fixture.root,
                    sessionID: session.id,
                    before,
                    after,
                    rejected: rejected - rejectedBefore,
                    outcome,
                    httpResponses: readFileSync(trace, "utf8"),
                    terminalEvents: readFileSync(events, "utf8"),
                    pluginLog: readFileSync(fixture.env.MAGIC_CONTEXT_LOG_PATH!, "utf8"),
                }),
            );
            expect(rejected).toBeGreaterThan(rejectedBefore);
            expect(after).toMatchObject({ needs_emergency_recovery: 1 });
        }
    } finally {
        try {
            await host.stop();
        } finally {
            proxy.stop(true);
        }
    }
}, 120_000);
