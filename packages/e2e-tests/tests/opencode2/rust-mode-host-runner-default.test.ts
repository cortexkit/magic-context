/// <reference types="bun-types" />

/**
 * Rust mode on OpenCode 2 with no Broca registered and no runner configured.
 *
 * The module decides the runner from the harness when the user names none, and
 * for an OpenCode 2 host that is the host: the module queues the fold, the
 * plugin's pull loop claims it and runs the completion through the OpenCode 2
 * hidden-child carrier on the configured historian model (the mock here), and
 * the module publishes the report. No Broca process joins the daemon at all, so
 * a fold that lands can only have come through the host.
 *
 * Its own file on purpose: each scenario boots a hermetic daemon, a module and a
 * GA host, and two such stacks in one Bun process do not both come up.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { OpenCode } from "@opencode/client";
import { buildMockHistorianPayload, historianRangeInRequest } from "../../src/mock-historian";
import { isolation, spawnOpencode2 } from "../../src/opencode2-runner/spawn";
import {
    buildHermeticBinaries,
    detectRustModePrereqs,
    HermeticSubcStack,
} from "../../src/rust-runner/hermetic-subc";

const prereqs = detectRustModePrereqs();

interface ModuleStatus {
    compartment_count?: number;
    historian?: {
        last_failure?: string | null;
        last_no_fire?: string | null;
        runner?: Record<string, unknown>;
    };
}

/**
 * Real prose mass: the module measures true content rather than the usage the
 * mock reports, and the tokenizer collapses repeated filler.
 */
const BALLAST_WORDS = [
    "boundary", "historian", "compartment", "schedule", "pressure", "tokens",
    "window", "publish", "transform", "session", "marker", "budget", "eligible",
    "protected", "ordinal", "snapshot", "replay", "decision", "threshold",
];

function ballast(tokens: number): string {
    const target = tokens * 4;
    const parts: string[] = [];
    let length = 0;
    for (let index = 0; length < target; index += 1) {
        const word = BALLAST_WORDS[index % BALLAST_WORDS.length]!;
        parts.push(index % 17 === 0 ? `${word}.` : word);
        length += word.length + 1;
    }
    return parts.join(" ");
}

describe.skipIf(!prereqs.ok)(
    `rust mode on OpenCode 2: host runner by default${prereqs.ok ? "" : ` (skipped: ${prereqs.skipReason})`}`,
    () => {
        let host: Awaited<ReturnType<typeof spawnOpencode2>>;
        let subc: HermeticSubcStack;
        const seen = { historianPrompts: 0 };

        beforeAll(async () => {
            const fixture = isolation();
            const binaries = await buildHermeticBinaries(prereqs.subconsciousRoot!);
            subc = await HermeticSubcStack.start({
                dataDir: fixture.env.XDG_DATA_HOME!,
                ckMcBin: binaries.ckMcBin,
                ckSubcBin: binaries.ckSubcBin,
                // No Broca, and no runner named in the module's user tier.
                startProducer: false,
                historianRunner: null,
            });
            host = await spawnOpencode2({
                existingIsolation: fixture,
                modelContextLimit: 24_000,
                modelOutputLimit: 1_024,
                magicContextConfig: {
                    transform_mode: "rust",
                    subc: { connection_file: subc.connectionFile },
                    memory: { enabled: false },
                    dreamer: { disable: true },
                    // No `runner` here either: the plugin's pull loop is on by default.
                    historian: { opencode: { model: "openai/mock-model" } },
                    execute_threshold_percentage: 40,
                    history_budget_percentage: 0.15,
                },
            });
            host.mock.addMatcher((body) => {
                const range = historianRangeInRequest(body);
                if (range) {
                    seen.historianPrompts += 1;
                    return {
                        text: buildMockHistorianPayload({
                            ...range,
                            title: "opencode2 host runner chunk",
                            body: "Folded on the OpenCode 2 host with no Broca registered.",
                        }),
                        usage: { input_tokens: 500, output_tokens: 80 },
                    };
                }
                // Usage tracks the bytes actually sent, the way a provider reports it.
                const wire = body.input ?? body.messages ?? [];
                return {
                    text: "ok",
                    usage: { input_tokens: Math.round(JSON.stringify(wire).length / 4), output_tokens: 20 },
                };
            });
        }, 900_000);

        afterAll(async () => {
            await host?.stop();
            await subc?.stop();
        });

        it("folds through the host with no Broca and no runner configured", async () => {
            const client = OpenCode.make({
                baseUrl: host.url,
                headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
            });
            const session = await client.session.create({
                location: { directory: host.cwd },
                model: { providerID: "openai", id: "mock-model" },
            });
            const status = async (): Promise<ModuleStatus> =>
                (await subc.moduleStatus(session.id, host.cwd, "session.status")) as ModuleStatus;

            let latest: ModuleStatus = {};
            for (let round = 0; round < 24; round += 1) {
                await client.session.prompt({
                    sessionID: session.id,
                    text: `turn ${round + 1}: durable signal for chunk ${round + 1}. ${ballast(3_000)}`,
                });
                await client.session.wait(
                    { sessionID: session.id },
                    { signal: AbortSignal.timeout(180_000) },
                );
                const deadline = Date.now() + 6_000;
                while (Date.now() < deadline) {
                    latest = await status();
                    if ((latest.compartment_count ?? 0) >= 1) break;
                    await Bun.sleep(250);
                }
                if ((latest.compartment_count ?? 0) >= 1) break;
            }
            console.log(
                `opencode2 host runner default: compartments=${latest.compartment_count ?? 0} historian prompts=${seen.historianPrompts} runner=${JSON.stringify(latest.historian?.runner)} last_failure=${latest.historian?.last_failure ?? null} last_no_fire=${latest.historian?.last_no_fire ?? null}`,
            );
            if ((latest.compartment_count ?? 0) < 1) {
                console.log(`module log tail:\n${subc.moduleLog().slice(-6000)}`);
            }
            expect(seen.historianPrompts).toBeGreaterThanOrEqual(1);
            expect(latest.compartment_count ?? 0).toBeGreaterThanOrEqual(1);
            expect(latest.historian?.last_failure ?? null).toBeNull();
            expect(subc.producerRequestCount()).toBe(0);
            expect(latest.historian?.runner).toEqual({
                runner: "host",
                source: "default_for_harness",
                harness: "opencode2",
                observed: "last_completion",
            });
        }, 1_800_000);
    },
);
