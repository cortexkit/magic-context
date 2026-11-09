import { expect, test } from "bun:test";
import { awaitOpenCode2Transport, openCode2MagicContextConfig, openCode2ProviderSettings } from "../src/opencode2-runner/spawn";

test("launcher defaults retain the existing serialized mock config", () => {
    expect(JSON.stringify(openCode2ProviderSettings({}, "http://127.0.0.1:1234")))
        .toBe('{"baseURL":"http://127.0.0.1:1234","apiKey":"mock-key"}');
    expect(JSON.stringify(openCode2MagicContextConfig({ magicContextConfig: {} })))
        .toBe('{"auto_update":false,"execute_threshold_percentage":40,"history_budget_percentage":0.15,"embedding":{"provider":"off"},"historian":{"opencode":{"model":"openai/mock-model"}},"dreamer":{"disable":true,"opencode":{"model":"openai/mock-model"}}}');
});

test("live settings and config remain explicit and do not inherit mock pins", () => {
    const magicContextConfig = { protected_tokens: 16000 };
    expect(openCode2MagicContextConfig({ magicContextConfig, preserveMagicContextDefaults: true }))
        .toBe(magicContextConfig);
    const providerSettings = { baseURL: "https://api.deepseek.com", apiKey: "test-only" };
    expect(openCode2ProviderSettings({ providerSettings }, "unused")).toBe(providerSettings);
});

test("transport readiness remains off for existing callers and issues no extra probe", async () => {
    let probes = 0;
    await awaitOpenCode2Transport(false, async () => { probes++; });
    expect(probes).toBe(0);
});

test("opt-in readiness retries only startup 503 and logs every retry", async () => {
    let probes = 0;
    let now = 0;
    const lines: string[] = [];
    await awaitOpenCode2Transport(true, async () => {
        if (++probes < 3) throw { reason: "UnexpectedStatus", cause: { status: 503 } };
    }, { now: () => now, pause: async (ms) => { now += ms; }, log: (line) => lines.push(line) });
    expect(probes).toBe(3);
    expect(lines).toHaveLength(2);
    expect(now).toBe(200);
    await expect(awaitOpenCode2Transport(true, async () => {
        throw { reason: "UnexpectedStatus", cause: { status: 401 } };
    })).rejects.toEqual({ reason: "UnexpectedStatus", cause: { status: 401 } });
});

test("opt-in startup 503 readiness is bounded at 30 seconds", async () => {
    let now = 0;
    await expect(awaitOpenCode2Transport(true, async () => {
        throw { reason: "UnexpectedStatus", cause: { status: 503 } };
    }, { now: () => now, pause: async (ms) => { now += ms; } })).rejects.toThrow("exceeded 30s");
    expect(now).toBe(30000);
});
