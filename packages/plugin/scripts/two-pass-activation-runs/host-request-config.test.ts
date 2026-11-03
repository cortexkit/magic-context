import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfigs, type HostLane } from "./host-adapters";
import { mockProvider } from "./mock-provider";
import { mockMeteringProxy } from "./provider-meter";

describe("host request check configuration", () => {
    for (const lane of ["opencode-1", "opencode-2", "pi", "omp"] as HostLane[]) {
        it(`writes documented ${lane} thinking and output settings`, () => {
            const root = mkdtempSync(join(tmpdir(), "host-request-config-"));
            try {
                const env = { XDG_CONFIG_HOME: join(root, "config"), PI_CODING_AGENT_DIR: join(root, "agent") };
                mkdirSync(env.XDG_CONFIG_HOME, { recursive: true });
                const thinking = { thinking: { type: "enabled" } };
                writeConfigs(lane, root, root, env, "http://127.0.0.1:1234", {
                    sourceRoot: root, mockProviderURL: "http://127.0.0.1:1234", modelId: "deepseek-v4-flash",
                    providerId: "deepseek", outputCeiling: 65536, reasoning: true, modelOptions: thinking,
                    magicContext: { historian: { maxTokens: 65536, [lane === "pi" || lane === "omp" ? lane : "opencode"]: { model: "deepseek/deepseek-v4-flash" } } },
                }, { directory: root, entrypoint: join(root, "observer.js"), eventsPath: join(root, "events.jsonl") });
                const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
                if (lane === "pi" || lane === "omp") {
                    const model = read(join(env.PI_CODING_AGENT_DIR, "models.json")).providers.deepseek.models[0];
                    expect(model.reasoning).toBe(true);
                    expect(model.maxTokens).toBe(65536);
                } else {
                    const config = read(join(lane === "opencode-1" ? env.XDG_CONFIG_HOME : root, "opencode.json"));
                    const provider = (config.providers ?? config.provider).deepseek;
                    expect(provider.models["deepseek-v4-flash"].limit.output).toBe(65536);
                    expect(lane === "opencode-2" ? provider.body : provider.models["deepseek-v4-flash"].options).toEqual(thinking);
                }
            } finally { rmSync(root, { recursive: true, force: true }); }
        });
    }
});

describe("capturing provider truncation", () => {
    it("honors the configured provider timeout", async () => {
        const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
            await Bun.sleep(200);
            return Response.json({ usage: { prompt_tokens: 1, completion_tokens: 1 } });
        } });
        const proxy = await mockMeteringProxy({ upstream: upstream.url.href.replace(/\/$/, ""), timeoutMs: 20,
            outputCeiling: 64, classify: () => "unclassified", meter: { beforeSend: () => 0, settle() {} } });
        try {
            const response = await fetch(proxy.url, { method: "POST", body: "{}" });
            expect(response.status).toBe(502);
            expect(proxy.receipts).toHaveLength(0);
            expect(proxy.failures).toEqual(["provider_dispatch_failed"]);
        } finally { await proxy.close(); upstream.stop(true); }
    });

    for (const stream of [false, true]) {
        it(`captures exact bytes and emits length with stream=${stream}`, async () => {
            const server = mockProvider(() => "complete but capped JSON", undefined, undefined, () => "length");
            try {
                const raw = `{ "model": "deepseek-v4-flash", "stream": ${stream}, "messages": [] }`;
                const response = await fetch(`${server.url}/v1/chat/completions`, { method: "POST", body: raw });
                const body = await response.text();
                expect(server.requests[0]?.rawBody).toBe(raw);
                expect(body).toContain('"finish_reason":"length"');
                expect(body).not.toContain('"finish_reason":"stop"');
            } finally { server.close(); }
        });
    }
});
