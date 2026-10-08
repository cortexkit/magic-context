import { expect } from "bun:test";
import { cpSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { closeDatabase } from "../../../plugin/src/features/magic-context/storage-db";
import { conversionFixture } from "../../src/opencode2-runner/conversion-lane";
import {
    inspectOpenFiles,
    spawnOpencode2,
    waitForPluginActive,
} from "../../src/opencode2-runner/spawn";
import { MockProvider } from "../../src/mock-provider/server";

// Caller supplies the pre-fix built plugin; all host/store activity stays inside this fixture.
const baseline = process.env.MC_E2E_ERROR_BASELINE_PLUGIN;
if (!baseline) throw new Error("Set MC_E2E_ERROR_BASELINE_PLUGIN to the pre-fix plugin snapshot");
const fixture = conversionFixture("issue-631");
const mock = new MockProvider();
const provider = await mock.start();
mock.setDefault({ text: "done", usage: { input_tokens: 100, output_tokens: 10 } });
const options = {
    existingIsolation: fixture,
    existingMock: { mock, baseURL: provider.baseURL },
    compactionAuto: false,
    magicContextConfig: {
        memory: { enabled: false },
        historian: { disable: true },
        dreamer: { disable: true },
    },
};
let host: Awaited<ReturnType<typeof spawnOpencode2>> | undefined;
async function boot(plugin?: string) {
    host = await spawnOpencode2({ ...options, magicContextPlugin: plugin });
    closeDatabase();
    const paths = inspectOpenFiles(host.pid!, host.root, host.env);
    console.log(`lsof pid=${host.pid} DB=${paths.find((path) => path === fixture.openCodeDbPath)}`);
    const client = OpenCode.make({
        baseUrl: host.url,
        headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
    });
    await waitForPluginActive(client, fixture.cwd);
    return client;
}
async function turn(client: ReturnType<typeof OpenCode.make>, sessionID: string, text: string) {
    await client.session.prompt({ sessionID, text });
    await client.session.wait({ sessionID }, { signal: AbortSignal.timeout(60_000) });
    return mock.requests().at(-1)!;
}
function output(body: Record<string, unknown>, callID: string): string {
    return (body.input as Array<{ type: string; call_id: string; output: string }>).find(
        (part) => part.type === "function_call_output" && part.call_id === callID,
    )!.output;
}
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
try {
    let client = await boot(baseline);
    const create = () =>
        client.session.create({
            title: "byte comparison",
            location: { directory: fixture.cwd },
            model: { providerID: "openai", id: "mock-model" },
        });
    const successful = await create();
    writeFileSync(join(fixture.cwd, "exists.txt"), "successful bytes: café\nsecond line\n");
    mock.enqueue({
        openaiOutput: [
            {
                type: "function_call",
                id: "fc_success",
                call_id: "success",
                name: "read",
                arguments: JSON.stringify({ path: join(fixture.cwd, "exists.txt") }),
            },
        ],
        usage: { input_tokens: 100, output_tokens: 10 },
    });
    await turn(client, successful.id, "read existing file");
    await client.session.compact({ sessionID: successful.id });
    await client.session.wait({ sessionID: successful.id });
    await host!.stopHost();
    // Offline snapshot of private data only, replayed at the same paths for a full raw-body comparison.
    const snapshot = join(fixture.root, "data-snapshot");
    cpSync(fixture.env.XDG_DATA_HOME!, snapshot, { recursive: true });
    client = await boot(baseline);
    const before = await turn(client, successful.id, "identical comparison prompt");
    expect(output(before.body, "success")).toContain("successful bytes:");
    writeFileSync(join(fixture.root, "success-before.json"), before.rawBody!);
    await host!.stopHost();
    rmSync(fixture.env.XDG_DATA_HOME!, { recursive: true });
    cpSync(snapshot, fixture.env.XDG_DATA_HOME!, { recursive: true });
    client = await boot();
    const after = await turn(client, successful.id, "identical comparison prompt");
    writeFileSync(join(fixture.root, "success-after.json"), after.rawBody!);
    expect(Buffer.from(after.rawBody!)).toEqual(Buffer.from(before.rawBody!));
    console.log(
        `NO-ERROR FULL REQUEST BYTE IDENTITY bytes=${Buffer.byteLength(before.rawBody!)} sha256=${hash(before.rawBody!)} before=${hash(before.rawBody!)} after=${hash(after.rawBody!)}`,
    );
    await host!.stopHost();

    client = await boot(baseline);
    const failed = await create();
    mock.enqueue({
        openaiOutput: [
            {
                type: "function_call",
                id: "fc_error",
                call_id: "failure",
                name: "read",
                arguments: JSON.stringify({ path: join(fixture.cwd, "does-not-exist.txt") }),
            },
        ],
        usage: { input_tokens: 100, output_tokens: 10 },
    });
    const original = output((await turn(client, failed.id, "read missing file")).body, "failure");
    expect(original).toContain("File not found:");
    await client.session.compact({ sessionID: failed.id });
    await client.session.wait({ sessionID: failed.id });
    const lost = output((await turn(client, failed.id, "before upgrade")).body, "failure");
    expect(lost).toMatch(/^§\d+§ $/);
    await host!.stopHost();
    client = await boot();
    const recovered = output((await turn(client, failed.id, "after upgrade")).body, "failure");
    expect(Buffer.from(recovered)).toEqual(Buffer.from(original));
    writeFileSync(
        join(fixture.root, "upgrade.json"),
        JSON.stringify({ original, lost, recovered }, null, 2),
    );
    console.log(
        `ALREADY-COMPACTED UPGRADE recovered=${JSON.stringify(recovered)} artifacts=${fixture.root}`,
    );
} finally {
    await host?.stopHost();
    await mock.stop();
}
