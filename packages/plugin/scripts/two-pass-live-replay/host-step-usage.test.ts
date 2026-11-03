import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTurnOneAuthorizationRequest } from "../../src/features/magic-context/memory/turn-two";
import type { HiddenCompletionExecutor } from "../../src/hooks/magic-context/compartment-runner-types";
import { callMeter } from "../two-pass-activation-runs/activation-driver";
import { CampaignLedger, type Profile } from "./artifact-schema";
import { disposableEnvironment, openCodeDriver } from "./host-drivers";

test("OpenCode 2 carrier meters every observed provider step", async () => {
    const parent = join(realpathSync(tmpdir()), "magic-context");
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, "oc2-usage-contract-"));
    const steps = [
        { inputTokens: 101, outputTokens: 11 },
        { inputTokens: 307, outputTokens: 17 },
        { inputTokens: 509, outputTokens: 23 },
    ];
    const entry = buildTurnOneAuthorizationRequest({ lane: "opencode-2", carrier: "hidden-completion", provider: "mock", modelId: "fixture", variant: null, temperature: null, thinkingLevel: null },
        { system: "system", formatInstruction: "format", toolSurface: [], checkToolSurface: [] }).requestedIdentity;
    const profile: Profile = { id: "mock-step-accounting", family: "mock", entry, modelRoute: "mock/fixture", priceClass: "paid",
        tariff: { inputUSDPerMillion: 1, outputUSDPerMillion: 2, source: "synthetic accounting fixture" }, configurationSource: "fixture", variantSource: "fixture" };
    const ledger = new CampaignLedger();
    const meter = callMeter(ledger, profile);
    const executor = {
        capabilities: { harness: "opencode2" },
        async open() { return { id: "hidden-1", childSessionId: "child-1" }; },
        async attempt() {},
        async collect() { return { text: "{}", lengthCapped: false }; },
        async close() {},
    } as unknown as HiddenCompletionExecutor;
    try {
        const isolation = { root, env: disposableEnvironment(root), proof: { pid: 42, tool: "fixture", output: root, paths: [join(root, "host.db")] } };
        const driver = openCodeDriver({ executor, host: { pid: 42, harness: "opencode2", carrier: "hidden-completion" },
            isolation, testHandleListing: async () => isolation,
            entry, parentSessionId: "parent-1", agent: "historian", timeoutMs: 1000, outputCeiling: 100,
            hostRetryLimit: 0, observedToolSurface: [], async observeUsage() { return { steps }; } });
        const child = await driver.open("system", "format", "turn_one");
        const reservation = meter.beforeSend({ kind: "turn_one", inputTokens: 1000, outputCeiling: 100, maxSteps: 4, hostRetries: 0 });
        const reply = await child.send("prompt", false, "send-1");
        expect(reply.steps).toEqual([
            { inputTokens: 101, outputTokens: 11 },
            { inputTokens: 307, outputTokens: 17 },
            { inputTokens: 509, outputTokens: 23 },
        ]);
        meter.settle(reservation, reply.steps);
        expect(ledger.rows[reservation].charged).toBeCloseTo(0.001019, 12);
        expect(ledger.rows[reservation].settled).toBe(true);
        await child.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
});
