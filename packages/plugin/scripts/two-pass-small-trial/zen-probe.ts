import { mkdirSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { callMeter } from "../two-pass-activation-runs/activation-driver";
import { hostAdapter } from "../two-pass-activation-runs/host-adapters";
import { providerUsage } from "../two-pass-activation-runs/provider-meter";
import { CampaignLedger } from "../two-pass-live-replay/artifact-schema";
import { attestHost, disposableEnvironment } from "../two-pass-live-replay/host-drivers";

const ZEN_URL = "https://opencode.ai/inference/openai";
const MODEL = "deepseek-v4.1-flash-free";

if (import.meta.main) {
    const [root, install, variantArg] = process.argv.slice(2);
    const variant = variantArg === "high" ? "high" : variantArg === "max" ? "max" : undefined;
    if (!root || !install) throw new Error("usage: zen-probe.ts <root> <install> [high|max]");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const env = disposableEnvironment(root);
    const ledger = new CampaignLedger();
    const profile = {
        id: `zen-probe-${variant ?? "novariant"}`,
        family: "zen-probe",
        entry: {
            lane: "opencode-1",
            carrier: "opencode-session",
            provider: "opencode",
            modelId: MODEL,
            variant: variant ?? null,
            temperature: null,
            thinkingLevel: null,
        } as never,
        modelRoute: `opencode/${MODEL}`,
        priceClass: "free" as const,
        tariff: {
            inputUSDPerMillion: 0,
            outputUSDPerMillion: 0,
            source: "https://opencode.ai/docs/zen/#pricing",
        },
        configurationSource: "zen probe",
        variantSource: variant ? "explicit variant" : "unset variant",
    };
    const adapter = hostAdapter("opencode-1", {
        sourceRoot: install,
        mockProviderURL: ZEN_URL,
        modelId: MODEL,
        providerId: "opencode",
        providerPackage: "@ai-sdk/openai-compatible",
        outputCeiling: 32000,
        timeoutMs: 120_000,
        startupTimeoutMs: 300_000,
        foregroundOnly: true,
        grantFree: true,
        paidProvider: true,
        magicContext: {
            historian: {
                opencode: variant
                    ? { model: { model: `opencode/${MODEL}`, variant } }
                    : { model: `opencode/${MODEL}` },
            },
            memory: { enabled: false },
            embedding: { provider: "off" },
        },
    });
    const entry = join(install, "packages/plugin/dist/index.js");
    console.log(
        JSON.stringify({
            interfaces: networkInterfaces(),
            zenUrl: ZEN_URL,
            model: MODEL,
            variant: variant ?? null,
        }),
    );
    let host: Awaited<ReturnType<typeof adapter.start>> | undefined;
    try {
        host = await adapter.start({
            installRoot: install,
            pluginEntrypoint: entry,
            env,
            meter: callMeter(ledger, profile as never),
        });
        console.log(JSON.stringify({ pid: host.pid, carrier: host.carrier }));
        const before = await attestHost(root, env, host.pid);
        console.log(
            JSON.stringify({
                lsofTool: before.proof.tool,
                lsofPaths: before.proof.paths.slice(0, 20),
            }),
        );
        const session = (await host.runSession("Say hello in one short sentence.")) as {
            requests: Array<{
                request: { path: string; body: string; providerHost?: string };
                response: {
                    status: number;
                    body: string;
                    contentType: string;
                    responseHeaders?: Record<string, string>;
                };
                steps?: Array<{ inputTokens: number; outputTokens: number }>;
            }>;
        };
        const after = await attestHost(root, env, host.pid);
        mkdirSync(join(root, "out"), { recursive: true });
        writeFileSync(
            join(root, "out", `probe-${variant ?? "novariant"}.json`),
            JSON.stringify(
                {
                    requests: session.requests,
                    ledger: ledger.rows,
                    before: before.proof,
                    after: after.proof,
                },
                null,
                2,
            ),
        );
        console.log(
            JSON.stringify({ requests: session.requests.length, ledger: ledger.rows.length }),
        );
        for (const r of session.requests) {
            const body = JSON.parse(r.request.body) as Record<string, unknown>;
            console.log(
                JSON.stringify({
                    path: r.request.path,
                    providerHost: (r.request as { providerHost?: string }).providerHost ?? null,
                    model: body.model,
                    max_tokens: body.max_tokens ?? null,
                    max_completion_tokens: body.max_completion_tokens ?? null,
                    reasoning: body.reasoning ?? null,
                    thinking: body.thinking ?? null,
                    effort: (body as Record<string, unknown>).effort ?? null,
                    reasoning_effort: (body as Record<string, unknown>).reasoning_effort ?? null,
                    variant: (body as Record<string, unknown>).variant ?? null,
                    temperature: body.temperature ?? null,
                    messages: (body.messages as Array<unknown>).length,
                    stream: body.stream ?? null,
                    tools: Array.isArray(body.tools)
                        ? body.tools.length
                        : body.tools === undefined
                          ? "absent"
                          : body.tools,
                }),
            );
            const steps = providerUsage(
                r.response.body,
                r.response.contentType ?? "application/json",
            );
            console.log(
                JSON.stringify({
                    status: r.response.status,
                    contentType: r.response.contentType ?? null,
                    responseHeaders: r.response.responseHeaders ?? null,
                    steps: steps ?? null,
                    rawBytes: r.response.body.length,
                    rawPreview: r.response.body.slice(0, 2000),
                }),
            );
        }
    } finally {
        if (host) await host.stop();
    }
}
