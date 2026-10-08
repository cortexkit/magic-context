import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { restoreRow } from "../../../plugin/src/v2/fold/restore";
import { V2StoreReader } from "../../../plugin/src/v2/store-reader";
import { MockProvider } from "../../src/mock-provider/server";
import { conversionFixture, spawnOpencode1 } from "../../src/opencode2-runner/conversion-lane";
import {
    inspectOpenFiles,
    spawnOpencode2,
    waitForPluginActive,
} from "../../src/opencode2-runner/spawn";

const config = {
    memory: { enabled: false },
    historian: { disable: true },
    dreamer: { disable: true },
};
const usage = { input_tokens: 100, output_tokens: 10 };

function outputs(body: Record<string, unknown>): Map<string, string> {
    const input = body.input as Array<{ type: string; call_id?: string; output?: string }>;
    return new Map(
        input
            .filter((item) => item.type === "function_call_output")
            .map((item) => [item.call_id!, item.output!]),
    );
}

async function scenario(converted: boolean) {
    const calls = [
        ...Array.from({ length: converted ? 10 : 1 }, (_, i) => `missing-read-${i}`),
        "successful-read",
    ];
    const errors = calls.slice(0, -1);
    const fixture = conversionFixture("issue-631");
    writeFileSync(join(fixture.cwd, "exists.txt"), "successful read: café\nsecond line\n");
    const mock = new MockProvider();
    const provider = await mock.start();
    mock.setDefault({ text: "done", usage });
    let sessionID: string | undefined;
    if (converted) {
        const v1 = await spawnOpencode1({
            fixture,
            mock,
            mockBaseURL: provider.baseURL,
            magicContextConfig: config,
        });
        try {
            const client = createOpencodeClient({ baseUrl: v1.url });
            const session = await client.session.create({ body: { title: "error conversion" } });
            sessionID = session.data!.id;
            mock.enqueue({
                content: calls.map((id, i) => ({
                    type: "tool_use",
                    id,
                    name: "read",
                    input: {
                        filePath: join(
                            fixture.cwd,
                            i === calls.length - 1 ? "exists.txt" : `does-not-exist-${i}.txt`,
                        ),
                    },
                })),
                stop_reason: "tool_use",
                usage,
            });
            await client.session.prompt({
                path: { id: sessionID },
                body: { parts: [{ type: "text", text: "read both files" }] },
            });
        } finally {
            await v1.stop();
        }
    }
    const trace = join(fixture.root, "tool-status.jsonl");
    const probe = join(fixture.root, "status-probe");
    // Observe the returned draft, not just the unchanged underlying store.
    mkdirSync(probe);
    writeFileSync(
        join(probe, "server.js"),
        `import { appendFileSync } from "node:fs";
        export default { id: "error-status-probe", async setup(context) {
            await context.session.hook("context", (draft) => appendFileSync(${JSON.stringify(trace)}, JSON.stringify({
                sessionID: draft.sessionID, results: draft.messages.flatMap(m => m.content).filter(p => p.type === "tool-result").map(p => ({
                    id: p.id, result: p.result, resultType: p.resultType, status: p.resultType === "error" || p.result?.type === "error" ? "error" : "completed"
                })) }) + "\\n"));
        } };`,
    );
    const host = await spawnOpencode2({
        existingIsolation: fixture,
        probePlugin: probe,
        existingMock: { mock, baseURL: provider.baseURL },
        magicContextConfig: config,
        compactionAuto: false,
    });
    try {
        const paths = inspectOpenFiles(host.pid!, host.root, host.env);
        console.log(
            `[error-compaction] converted=${converted} pid=${host.pid} lsof DB=${paths.find((path) => path === fixture.openCodeDbPath)} root=${host.root}`,
        );
        const client = OpenCode.make({
            baseUrl: host.url,
            headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
        });
        if (!sessionID) {
            sessionID = (
                await client.session.create({
                    title: "error compaction",
                    location: { directory: host.cwd },
                    model: { providerID: "openai", id: "mock-model" },
                })
            ).id;
        }
        await waitForPluginActive(client, host.cwd);
        const turn = async (text: string) => {
            await client.session.prompt({ sessionID: sessionID!, text });
            await client.session.wait(
                { sessionID: sessionID! },
                { signal: AbortSignal.timeout(60_000) },
            );
        };
        if (!converted) {
            mock.enqueue({
                openaiOutput: calls.map((id, i) => ({
                    type: "function_call",
                    id: `fc_${id}`,
                    call_id: id,
                    name: "read",
                    arguments: JSON.stringify({
                        path: join(
                            host.cwd,
                            i === calls.length - 1 ? "exists.txt" : `does-not-exist-${i}.txt`,
                        ),
                    }),
                })),
                usage,
            });
            await turn("read both files");
        }
        await turn("before compact");
        const beforeRequest = mock.requests().at(-1)!;
        writeFileSync(join(fixture.root, "request-before-compact.json"), beforeRequest.rawBody!);
        const before = outputs(beforeRequest.body);
        expect(before.size).toBe(calls.length);
        for (const id of errors) {
            expect(before.get(id)).toContain("File not found:");
            expect(before.get(id)).toMatch(/^§\d+§ /);
        }
        expect(before.get(calls.at(-1)!)).toContain("successful read:");
        const statuses = () =>
            (
                readFileSync(trace, "utf8")
                    .trim()
                    .split("\n")
                    .map((line) => JSON.parse(line)) as Array<{
                    sessionID: string;
                    results: Array<{ id: string; status: string }>;
                }>
            )
                .filter((entry) => entry.sessionID === sessionID)
                .at(-1)!
                .results.map(({ id, status }) => ({ id, status }));
        expect(statuses().sort((a, b) => a.id.localeCompare(b.id))).toEqual(
            calls
                .map((id) => ({ id, status: errors.includes(id) ? "error" : "completed" }))
                .sort((a, b) => a.id.localeCompare(b.id)),
        );
        const requestCount = mock.requests().length;
        await client.session.compact({ sessionID });
        await client.session.wait({ sessionID }, { signal: AbortSignal.timeout(60_000) });
        expect(mock.requests().length).toBe(requestCount);
        const reader = new V2StoreReader(fixture.openCodeDbPath);
        try {
            expect(reader.latestCompaction(sessionID)?.data.status).toBe("completed");
            const tools = reader
                .history(sessionID)
                .filter((row) => row.type === "assistant")
                .flatMap((row) => row.data.content ?? [])
                .filter((part) => part.type === "tool");
            expect(tools.map((part) => (part.state as { status: string }).status)).toEqual(
                calls.map((id) => (errors.includes(id) ? "error" : "completed")),
            );
            const restored = reader
                .history(sessionID)
                .flatMap((row) => restoreRow(row, { providerID: "openai", id: "mock-model" }));
            expect(
                restored
                    .flatMap((message) => message.content)
                    .find((part) => part.id === calls[0] && part.type === "tool-result")
                    ?.resultType,
            ).toBe("error");
        } finally {
            reader.close();
        }
        await turn("after compact");
        const afterRequest = mock.requests().at(-1)!;
        writeFileSync(join(fixture.root, "request-after-compact.json"), afterRequest.rawBody!);
        const after = outputs(afterRequest.body);
        expect(statuses().sort((a, b) => a.id.localeCompare(b.id))).toEqual(
            calls
                .map((id) => ({ id, status: errors.includes(id) ? "error" : "completed" }))
                .sort((a, b) => a.id.localeCompare(b.id)),
        );
        for (const id of calls) {
            console.log(
                `[error-compaction] ${id} before=${JSON.stringify(before.get(id))} after=${JSON.stringify(after.get(id))}`,
            );
            expect(Buffer.from(after.get(id)!)).toEqual(Buffer.from(before.get(id)!));
        }
    } finally {
        await host.stop();
    }
}

test(
    "errored and successful read results keep their bytes across /compact on OpenCode 2",
    () => scenario(false),
    180_000,
);
test(
    "converted OpenCode 1 error results keep their bytes across /compact on OpenCode 2",
    () => scenario(true),
    180_000,
);
