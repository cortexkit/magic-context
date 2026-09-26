/// <reference types="bun-types" />

/**
 * Rust mode on OpenCode 1 with no Broca registered and no runner configured.
 *
 * Rust mode must not need Broca. When the user names no `historian.runner`, the
 * module decides the runner from the harness that sent the request, and for an
 * OpenCode host that is the host itself: the module queues the assembled run,
 * this process's pull loop claims it, runs the completion on the configured
 * historian model (the mock provider here), and reports the text back; the
 * module validates and publishes it exactly as it would a Broca answer.
 *
 * The negative control names `runner: broca` with no Broca registered: the fold
 * is refused the way Broca's absence has always refused it, and nothing falls
 * back to the host.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { buildMockHistorianPayload, historianRangeInRequest } from "../src/mock-historian";
import { RustTestHarness } from "../src/rust-harness";
import { rustPrereqs } from "../src/rust-scenario-support";

interface ModuleStatus {
    compartment_count?: number;
    historian?: {
        last_failure?: string | null;
        last_no_fire?: string | null;
        runner?: Record<string, unknown>;
    };
}

const MODEL = "mock-anthropic/mock-sonnet";

describe.skipIf(!rustPrereqs.ok)("rust historian: host runner by default on OpenCode 1", () => {
    let h: RustTestHarness | undefined;

    afterEach(async () => {
        await h?.dispose();
        h = undefined;
    });

    async function create(historianRunner: "broca" | null): Promise<RustTestHarness> {
        return await RustTestHarness.create({
            modelContextLimit: 30_000,
            // No Broca process joins the daemon at all.
            startHistorianProducer: false,
            historianRunner,
            magicContextConfig: {
                execute_threshold_percentage: 25,
                protected_tags: 1,
                compressor: { enabled: false },
                historian: {
                    opencode: { model: MODEL },
                    ...(historianRunner ? { runner: historianRunner } : {}),
                },
            },
        });
    }

    /** Answer every historian prompt with a valid compartment covering its chunk. */
    function answerHistorianPrompts(harness: RustTestHarness): { prompts: number } {
        const seen = { prompts: 0 };
        harness.mock.addMatcher((body) => {
            const range = historianRangeInRequest(body);
            if (!range) return null;
            seen.prompts += 1;
            return {
                text: buildMockHistorianPayload({
                    ...range,
                    title: "host runner default chunk",
                    body: "Folded by the host runner with no Broca registered.",
                }),
                usage: { input_tokens: 500, output_tokens: 80, cache_creation_input_tokens: 0 },
            };
        });
        return seen;
    }

    async function driveHistorian(harness: RustTestHarness, sessionId: string): Promise<void> {
        for (let i = 1; i <= 10; i += 1) {
            harness.mock.setDefault({
                text: `host runner assistant ${i}`,
                usage: {
                    input_tokens: 2_500 * i,
                    output_tokens: 20,
                    cache_creation_input_tokens: 1_000,
                },
            });
            await harness.sendPrompt(sessionId, `host runner turn ${i}: ${harness.ballast(2_000)}`);
        }
        harness.mock.setDefault({
            text: "host runner trigger",
            usage: { input_tokens: 27_000, output_tokens: 20, cache_creation_input_tokens: 2_000 },
        });
        await harness.sendPrompt(sessionId, `host runner trigger: ${harness.ballast(2_000)}`);
        harness.mock.setDefault({
            text: "host runner follow-up",
            usage: { input_tokens: 500, output_tokens: 20, cache_creation_input_tokens: 0 },
        });
        await harness.sendPrompt(sessionId, "host runner follow-up starts the historian run");
    }

    async function sessionStatus(harness: RustTestHarness, sessionId: string): Promise<ModuleStatus> {
        return (await harness.subc.moduleStatus(
            sessionId,
            harness.env.workdir,
            "session.status",
        )) as ModuleStatus;
    }

    function pluginLog(harness: RustTestHarness): string {
        try {
            return readFileSync(harness.logPath, "utf8");
        } catch {
            return "";
        }
    }

    it(
        "folds through the host with no Broca and no runner configured",
        async () => {
            h = await create(null);
            const seen = answerHistorianPrompts(h);
            const sessionId = await h.createSession();
            await driveHistorian(h, sessionId);

            const deadline = Date.now() + 180_000;
            let status: ModuleStatus = {};
            while (Date.now() < deadline) {
                status = await sessionStatus(h, sessionId);
                if ((status.compartment_count ?? 0) >= 1) break;
                // Keep passes flowing: the pull loop polls on each transform pass.
                await h.sendPrompt(sessionId, "host runner keep-alive");
                await Bun.sleep(500);
            }
            console.log(
                `host runner default: compartments=${status.compartment_count ?? 0} historian prompts=${seen.prompts} runner=${JSON.stringify(status.historian?.runner)} last_failure=${status.historian?.last_failure ?? null} last_no_fire=${status.historian?.last_no_fire ?? null}`,
            );
            const lane = (text: string) =>
                text
                    .split("\n")
                    .filter((line) => /historian host runner|historian\.(pending|claim|complete)|host lane|queued/i.test(line))
                    .slice(-40)
                    .join("\n");
            console.log(`plugin claim-lane lines:\n${lane(pluginLog(h))}`);
            console.log(`module claim-lane lines:\n${lane(h.subc.moduleLog())}`);
            // The completion ran on this process's carrier against the mock...
            expect(seen.prompts).toBeGreaterThanOrEqual(1);
            // ...the module published it...
            expect(status.compartment_count ?? 0).toBeGreaterThanOrEqual(1);
            expect(status.historian?.last_failure ?? null).toBeNull();
            // ...and nothing was ever sent to a Broca producer, because none exists.
            expect(h.subc.producerRequestCount()).toBe(0);
            expect(status.historian?.runner).toEqual({
                runner: "host",
                source: "default_for_harness",
                harness: "opencode",
                observed: "last_completion",
            });
        },
        600_000,
    );

    it(
        "refuses as before when runner: broca is configured and no Broca is registered",
        async () => {
            h = await create("broca");
            const seen = answerHistorianPrompts(h);
            const sessionId = await h.createSession();
            await driveHistorian(h, sessionId);

            const deadline = Date.now() + 180_000;
            let status: ModuleStatus = {};
            while (Date.now() < deadline) {
                status = await sessionStatus(h, sessionId);
                if (status.historian?.last_failure) break;
                await Bun.sleep(250);
            }
            console.log(
                `broca without broca: compartments=${status.compartment_count ?? 0} historian prompts=${seen.prompts} runner=${JSON.stringify(status.historian?.runner)} last_failure=${status.historian?.last_failure ?? null}`,
            );
            // The daemon answers a route to an unregistered module with
            // `unknown_module`; the module records it as the producer start failure,
            // exactly as it did before the default changed.
            expect(status.historian?.last_failure ?? "").toMatch(
                /unknown_module|open_failed|no_models/,
            );
            expect(status.compartment_count ?? 0).toBe(0);
            // No fall back to the host: the historian prompt never reached the model.
            expect(seen.prompts).toBe(0);
            expect(status.historian?.runner).toEqual({
                runner: "broca",
                source: "configured",
                harness: "opencode",
                observed: "last_completion",
            });
        },
        600_000,
    );
});
