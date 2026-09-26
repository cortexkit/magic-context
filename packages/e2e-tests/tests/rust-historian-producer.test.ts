/// <reference types="bun-types" />

/**
 * Rust historian producer coverage.
 *
 * The Broca process is deliberately separate from the OpenCode model mock. A
 * producer request is therefore a non-vacuous precondition for both success
 * and failure assertions in this suite.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { RustTestHarness } from "../src/rust-harness";
import { rustPrereqs } from "../src/rust-scenario-support";

interface HistorianStatus {
    state?: string;
    last_failure?: string | null;
    failure_backoff_at_ms?: number | null;
    consecutive_publish_failures?: number;
}

interface ModuleStatus {
    historian?: HistorianStatus;
    compartment_count?: number;
}

const expectInvalidOutput = process.env.MC_RUST_E2E_BROCA_EXPECT_BAD === "1";

describe.skipIf(!rustPrereqs.ok)("rust historian: hermetic Broca producer", () => {
    let h: RustTestHarness;

    beforeAll(async () => {
        h = await RustTestHarness.create({
            modelContextLimit: 30_000,
            magicContextConfig: {
                execute_threshold_percentage: 25,
                protected_tags: 1,
                compressor: { enabled: false },
            },
        });
    });

    afterAll(async () => {
        await h?.dispose();
    });

    async function status(sessionId: string): Promise<HistorianStatus> {
        const response = (await h.subc.moduleStatus(sessionId, h.env.workdir)) as ModuleStatus;
        return response.historian ?? {};
    }

    async function sessionStatus(sessionId: string): Promise<ModuleStatus> {
        return (await h.subc.moduleStatus(sessionId, h.env.workdir, "session.status")) as ModuleStatus;
    }

    async function waitForProducerRun(minimum: number): Promise<void> {
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
            if (h.subc.producerRequestCount() >= minimum) return;
            await Bun.sleep(100);
        }
        let pluginLog = "";
        try {
            pluginLog = readFileSync(h.logPath, "utf8").slice(-8000);
        } catch {
            // The harness may remove its temporary data directory during teardown.
        }
        throw new Error(`Broca producer was never contacted; rust passes=${JSON.stringify(h.readRustPasses().map((pass) => pass.raw))}\nproducer log:\n${h.subc.producerLog()}\nmodule log:\n${h.subc.moduleLog().slice(-8000)}\nplugin log:\n${pluginLog}`);
    }

    async function driveHistorian(sessionId: string): Promise<void> {
        for (let i = 1; i <= 10; i += 1) {
            h.mock.setDefault({
                text: `historian producer assistant ${i}`,
                usage: {
                    input_tokens: 2_500 * i,
                    output_tokens: 20,
                    cache_creation_input_tokens: 1_000,
                },
            });
            await h.sendPrompt(sessionId, `producer turn ${i}: ${h.ballast(2_000)}`);
        }
        h.mock.setDefault({
            text: "historian trigger",
            usage: {
                input_tokens: 27_000,
                output_tokens: 20,
                cache_creation_input_tokens: 2_000,
            },
        });
        await h.sendPrompt(sessionId, `producer trigger: ${h.ballast(2_000)}`);
        h.mock.setDefault({
            text: "historian follow-up",
            usage: { input_tokens: 500, output_tokens: 20, cache_creation_input_tokens: 0 },
        });
        await h.sendPrompt(sessionId, "producer follow-up starts the historian run");
    }

    it(
        "publishes deterministic tiered output and records producer contact",
        async () => {
            const sessionId = await h.createSession();
            await driveHistorian(sessionId);
            await waitForProducerRun(1);

            if (expectInvalidOutput) {
                const failed: HistorianStatus = {};
                const deadline = Date.now() + 120_000;
                while (Date.now() < deadline) {
                    Object.assign(failed, await status(sessionId));
                    if (failed.last_failure) break;
                    await Bun.sleep(100);
                }
                expect(failed.last_failure).toMatch(/tier|validat|compartment/i);
                expect(failed.failure_backoff_at_ms ?? 0).toBeGreaterThan(Date.now() - 120_000);
                expect(failed.failure_backoff_at_ms ?? 0).toBeGreaterThan(0);
                return;
            }

            const publishDeadline = Date.now() + 120_000;
            let published: ModuleStatus = {};
            while (Date.now() < publishDeadline) {
                published = await sessionStatus(sessionId);
                if ((published.compartment_count ?? 0) >= 1) break;
                await Bun.sleep(100);
            }
            expect(published.compartment_count ?? 0).toBeGreaterThanOrEqual(1);
            const final = await status(sessionId);
            expect(final.last_failure ?? null).toBeNull();
            expect(final.consecutive_publish_failures ?? 0).toBe(0);
        },
        300_000,
    );

    it(
        "fits an oversize completed tool arc, publishes it once, and advances past it",
        async () => {
            const oversize = await RustTestHarness.create({
                modelContextLimit: 30_000,
                magicContextConfig: {
                    execute_threshold_percentage: 25,
                    protected_tags: 1,
                    compressor: { enabled: false },
                    historian: { context_limit_tokens: 120_000 },
                },
            });
            try {
                // The stack keeps its Broca runner in the rewritten file, so this
                // scenario stays on the producer lane it measures.
                oversize.subc.writeModuleConfig({ historian: { context_limit_tokens: 120_000 } });
                const sessionId = await oversize.createSession();
                const description = `oversize historian arc ${oversize.ballast(180_000)}`;
                let toolEmitted = false;
                oversize.mock.addMatcher((body) => {
                    if (toolEmitted || !Array.isArray(body.tools)) return null;
                    const tool = body.tools.find((candidate) =>
                        /bash/i.test(String((candidate as { name?: unknown })?.name ?? "")),
                    ) as { name?: string } | undefined;
                    if (!tool?.name) return null;
                    toolEmitted = true;
                    return {
                        content: [
                            {
                                type: "tool_use",
                                id: "toolu_issue_467_oversize",
                                name: tool.name,
                                input: { command: "printf issue-467-ok", description },
                            },
                        ],
                        stop_reason: "tool_use",
                        usage: {
                            input_tokens: 500,
                            output_tokens: 20,
                            cache_creation_input_tokens: 100,
                        },
                    };
                });
                oversize.mock.setDefault({
                    text: "oversize tool arc completed",
                    usage: {
                        input_tokens: 500,
                        output_tokens: 20,
                        cache_creation_input_tokens: 100,
                    },
                });
                await oversize.sendPrompt(sessionId, "Create the completed oversize tool arc.");
                expect(toolEmitted).toBe(true);

                for (let index = 1; index <= 6; index += 1) {
                    oversize.mock.setDefault({
                        text: `oversize follow-up ${index}`,
                        usage: {
                            input_tokens: index === 6 ? 27_000 : 1_000,
                            output_tokens: 20,
                            cache_creation_input_tokens: index === 6 ? 2_000 : 100,
                        },
                    });
                    await oversize.sendPrompt(
                        sessionId,
                        `oversize follow-up ${index}: ${oversize.ballast(500)}`,
                    );
                }
                oversize.mock.setDefault({
                    text: "start oversize historian",
                    usage: {
                        input_tokens: 500,
                        output_tokens: 20,
                        cache_creation_input_tokens: 0,
                    },
                });
                await oversize.sendPrompt(sessionId, "Start the oversize historian pass.");

                await oversize.waitFor(() => oversize.subc.producerRequestCount() >= 1, {
                    timeoutMs: 120_000,
                    label: "oversize historian producer request",
                });
                const publishDeadline = Date.now() + 120_000;
                let published: ModuleStatus = {};
                while (Date.now() < publishDeadline) {
                    published = (await oversize.subc.moduleStatus(
                        sessionId,
                        oversize.env.workdir,
                        "session.status",
                    )) as ModuleStatus;
                    if ((published.compartment_count ?? 0) >= 1) break;
                    await Bun.sleep(100);
                }
                expect(published.compartment_count ?? 0).toBeGreaterThanOrEqual(1);
                expect(oversize.subc.producerLog()).toContain("truncation_markers=2");

                const producerRuns = oversize.subc.producerRequestCount();
                oversize.mock.setDefault({
                    text: "post-publication low pressure",
                    usage: {
                        input_tokens: 500,
                        output_tokens: 20,
                        cache_creation_input_tokens: 0,
                    },
                });
                await oversize.sendPrompt(sessionId, "Verify the published arc is not re-read.");
                await Bun.sleep(500);
                expect(oversize.subc.producerRequestCount()).toBe(producerRuns);
            } finally {
                await oversize.dispose();
            }
        },
        300_000,
    );

    it(
        "takes the loud historian failure path when Broca goes down mid-run",
        async () => {
            const sessionId = await h.createSession();
            // Establish a real Rust session without firing the historian yet. The
            // producer is then killed mid-session, before the first outage run.
            for (let i = 1; i <= 3; i += 1) {
                h.mock.setDefault({
                    text: `outage warmup ${i}`,
                    usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 50 },
                });
                await h.sendPrompt(sessionId, `outage warmup ${i}: ${h.ballast(400)}`);
            }
            const beforeFailure = h.subc.producerRequestCount();
            h.subc.killProducer();
            await h.subc.waitForProducerDeath();

            h.mock.setDefault({
                text: "producer outage follow-up",
                usage: {
                    input_tokens: 90_000,
                    output_tokens: 20,
                    cache_creation_input_tokens: 90_000,
                },
            });
            await h.sendPrompt(sessionId, `producer outage trigger: ${h.ballast(3_000)}`);
            await h.sendPrompt(sessionId, `producer outage follow-up: ${h.ballast(1_000)}`);

            const deadline = Date.now() + 120_000;
            let failed: HistorianStatus = {};
            while (Date.now() < deadline) {
                try {
                    failed = await status(sessionId);
                } catch {
                    // A provider disconnect can briefly tear down the daemon's
                    // management connection while the module records its failure.
                    await Bun.sleep(500);
                    continue;
                }
                if (failed.last_failure) break;
                await Bun.sleep(100);
            }
            expect(beforeFailure).toBeGreaterThan(0);
            expect(h.subc.producerRequestCount()).toBe(beforeFailure);
            expect(failed.last_failure).toMatch(/broca|producer|connect|route|unknown/i);
            expect(failed.failure_backoff_at_ms ?? 0).toBeGreaterThan(Date.now() - 120_000);
            expect(failed.failure_backoff_at_ms ?? 0).toBeGreaterThan(0);
        },
        300_000,
    );
});
