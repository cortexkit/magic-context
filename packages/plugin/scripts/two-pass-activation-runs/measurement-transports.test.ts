import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disposableEnvironment } from "../two-pass-live-replay/host-drivers";
import { measurementTransport } from "./measurement-transports";
import { scopedCredentials } from "./scoped-credentials";
import type { MeasurementRequest } from "./cache-measurement-driver";

test("first-party child retains raw history and reports observed cache usage against mock only", async () => {
    const parent = join(realpathSync(tmpdir()), "magic-context");
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, "anthropic-mock-"));
    const requests: Array<Record<string, any>> = [];
    const mock = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
        expect(request.headers.get("x-api-key")).toBe("mock-only-key");
        requests.push(await request.json() as Record<string, any>);
        return Response.json({ content: [{ type: "text", text: requests.length === 1 ? "raw first reply\n" : "second reply" }],
            usage: { input_tokens: requests.length === 1 ? 20 : 5, output_tokens: 7,
                cache_creation_input_tokens: requests.length === 1 ? 80 : 0,
                cache_read_input_tokens: requests.length === 2 ? 95 : 0 } });
    } });
    const transport = measurementTransport({ mockAnthropicEndpoint: `${mock.url}v1/messages` });
    let session: Awaited<ReturnType<typeof transport.openAnthropic>> | undefined;
    try {
        const env = { ...disposableEnvironment(root), ANTHROPIC_API_KEY: "mock-only-key" };
        session = await transport.openAnthropic({ root, env, model: "claude-sonnet-5-5" });
        expect(env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(readdirSync(join(root, "anthropic-client")).sort()).toEqual(["anthropic-worker.ts", "client-witness.jsonl"]);
        expect(readFileSync(join(root, "anthropic-client/anthropic-worker.ts"), "utf8")).not.toContain("mock-only-key");
        expect(readFileSync(join(root, "anthropic-client/client-witness.jsonl"), "utf8")).toBe("");
        const first: MeasurementRequest = { model: "claude-sonnet-5-5", maxOutputTokens: 20, system: "fixed system",
            messages: [{ role: "user", content: "first prompt" }], tools: [], mode: "best_effort" };
        const reply = await session.send(first);
        expect(reply.steps).toEqual([{ inputTokens: 100, outputTokens: 7 }]);
        const second = await session.send({ ...first, messages: [...first.messages,
            { role: "assistant", content: reply.text }, { role: "user", content: "second prompt" }] });
        expect(second.usage?.cache_read_input_tokens).toBe(95);
        expect(requests).toHaveLength(2);
        expect(requests[1].system).toEqual(requests[0].system);
        expect(requests[1].messages[0]).toEqual(requests[0].messages[0]);
        expect(requests[1].messages[1].content).toEqual([{ type: "text", text: "raw first reply\n" }]);
        expect(session.maxSteps).toBe(1);
        expect(session.hostRetries).toBe(2);
        expect(session.isolation.proof.pid).not.toBe(process.pid);
        expect(session.isolation.proof.output).toContain(root);
        await expect(session.send(first)).rejects.toThrow("measurement_session_bounds");
    } finally { await session?.close(); mock.stop(true); rmSync(root, { recursive: true, force: true }); }
});

test("measurement endpoint overrides cannot target a real provider", () => {
    expect(() => measurementTransport({ mockAnthropicEndpoint: "https://api.anthropic.com/v1/messages" })).toThrow("mock_endpoint_not_loopback");
});

test("first-party worker propagates credential_no_credit and stops subsequent sends", async () => {
    const parent = join(realpathSync(tmpdir()), "magic-context");
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, "anthropic-credit-"));
    let calls = 0;
    const mock = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
        calls++;
        return Response.json({ error: { type: "invalid_request_error", message: "Your credit balance is too low" } }, { status: 400 });
    } });
    const transport = measurementTransport({ mockAnthropicEndpoint: `${mock.url}v1/messages` });
    let session: Awaited<ReturnType<typeof transport.openAnthropic>> | undefined;
    try {
        session = await transport.openAnthropic({ root, model: "claude-sonnet-5-5",
            env: { ...disposableEnvironment(root), ANTHROPIC_API_KEY: "mock-credit-key" } });
        const request: MeasurementRequest = { model: "claude-sonnet-5-5", maxOutputTokens: 10, system: "mock only",
            messages: [{ role: "user", content: "mock only" }], tools: [], mode: "best_effort" };
        await expect(session.send(request)).rejects.toThrow("credential_no_credit");
        await expect(session.send(request)).rejects.toThrow("credential_no_credit");
        expect(calls).toBe(1);
    } finally { await session?.close(); mock.stop(true); rmSync(root, { recursive: true, force: true }); }
});

test("CKCRED adapter fetches only the exact authorized grant with an in-memory token", async () => {
    const calls: unknown[] = [];
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
        const credentials = scopedCredentials({ enrollmentToken: "mock-enrollment-token", async connect() { return {
            async getScoped(request) { calls.push(request); return { material: "mock-material" }; },
            close() { calls.push("closed"); },
        }; }, async onRunEnded(id) { calls.push({ ended: id }); } });
        expect(await credentials.getScoped("apikey:anthropic")).toBe("mock-material");
        await credentials.notifyRunEnded("apikey:anthropic");
        expect(calls).toEqual([{ credentialId: "apikey:anthropic", enrollmentToken: "mock-enrollment-token" }, "closed", { ended: "apikey:anthropic" }]);
    } finally { Object.defineProperty(process, "platform", platform); }
});

test("Linux cannot construct or connect a credential broker", () => {
    let connections = 0;
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
        expect(() => scopedCredentials({ enrollmentToken: "mock-token", async connect() {
            connections++; throw new Error("broker_must_not_be_constructed");
        }, async onRunEnded() {} })).toThrow("credential_broker_trusted_host_required");
        expect(connections).toBe(0);
    } finally { Object.defineProperty(process, "platform", platform); }
});
