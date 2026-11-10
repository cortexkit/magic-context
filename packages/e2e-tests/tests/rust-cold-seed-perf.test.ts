/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { openTestDb } from "../src/test-db";
import { join } from "node:path";
import { buildPagedModuleTransformPayloads, MODULE_PAGE_MAX_BYTES } from "../../plugin/src/hooks/magic-context/module-wire";
import { RustTestHarness } from "../src/rust-harness";
import { rustPrereqs } from "../src/rust-scenario-support";

const PERF_GATE = process.env.MC_PERF_GATE === "1";
const PERF_FULL_OUTPUT = process.env.MC_PERF_FULL_OUTPUT === "1";
const REPLAY_STORE_PATH = process.env.MC_PERF_STORE_PATH;
const REPLAY_SESSION_ID = process.env.MC_PERF_SESSION_ID;
const MESSAGE_COUNT = 9_600;
const TOOL_MESSAGE_COUNT = 8_000;
const COVERED_MESSAGE_COUNT = 9_200;
const COMPARTMENT_COUNT = 148;
const COLD_BUILD_OUTPUT_LIMIT_MS = 1_000;
const COLD_HANDLER_LIMIT_MS = 2_500;
const COLD_SERIALIZED_MESSAGE_LIMIT = MESSAGE_COUNT - COVERED_MESSAGE_COUNT + 2;

function astroCompartments() {
    return Array.from({ length: COMPARTMENT_COUNT }, (_, index) => {
        const sequence = index + 1;
        const start = Math.floor((index * COVERED_MESSAGE_COUNT) / COMPARTMENT_COUNT) + 1;
        const end = Math.floor((sequence * COVERED_MESSAGE_COUNT) / COMPARTMENT_COUNT);
        const startMid = `msg_perf_${(start - 1).toString().padStart(5, "0")}`;
        const endMid = `msg_perf_${(end - 1).toString().padStart(5, "0")}`;
        const endBlockIndex = end <= TOOL_MESSAGE_COUNT ? 1 : 0;
        return {
            sequence,
            start_message: start,
            end_message: end,
            start_message_id: startMid,
            end_message_id: endMid,
            start_block_index: 0,
            end_block_index: endBlockIndex,
            title: `ASTRO history ${sequence}`,
            content: `Summary of messages ${start}-${end}`,
            p1: `Summary of messages ${start}-${end}`,
            importance: 50,
            episode_type: "feature",
            legacy: 0,
            created_at: sequence,
        };
    });
}

function astroShape(sessionId: string): Record<string, unknown> {
    const messages: Record<string, unknown>[] = [];
    const nativeMessages: Record<string, unknown>[] = [];
    for (let index = 0; index < MESSAGE_COUNT; index += 1) {
        const mid = `msg_perf_${index.toString().padStart(5, "0")}`;
        const ordinal = index + 1;
        if (index < TOOL_MESSAGE_COUNT) {
            const callID = `call_perf_${index.toString().padStart(5, "0")}`;
            const nativeOutput = `tool output ${index} ${"x".repeat(8_500)}`;
            const ckOutput = `tool result ${index} ${"z".repeat(64)}`;
            const input = { path: `src/fixture-${index % 97}.ts`, line: index };
            messages.push({
                mid,
                ordinal,
                ck: {
                    role: "assistant",
                    content: [
                        { kind: { type: "tool_call", id: callID, name: "read", input } },
                        {
                            kind: {
                                type: "tool_result",
                                id: callID,
                                tool_name: "read",
                                output: { kind: { type: "text", text: ckOutput } },
                            },
                        },
                    ],
                    meta: { harness_id: mid, ordinal, synthetic: false, summary: false, errored: false },
                },
            });
            nativeMessages.push({
                info: { id: mid, role: "assistant", sessionID: sessionId },
                parts: [
                    {
                        type: "tool",
                        callID,
                        tool: "read",
                        state: { status: "completed", input, output: nativeOutput },
                    },
                ],
            });
        } else {
            const role = index % 2 === 0 ? "user" : "assistant";
            const text = `message ${index} ${"y".repeat(1_000)}`;
            messages.push({
                mid,
                ordinal,
                ck: {
                    role,
                    content: [{ kind: { type: "text", text } }],
                    meta: { harness_id: mid, ordinal, synthetic: false, summary: false, errored: false },
                },
            });
            nativeMessages.push({
                info: { id: mid, role, sessionID: sessionId },
                parts: [{ type: "text", text }],
            });
        }
    }
    const fingerprint = createHash("sha256")
        .update(JSON.stringify(messages.map((message) => message.mid)))
        .digest("hex");
    return {
        method: "transform",
        kind: "transform",
        v: 2,
        serializer_profile: "opencode-aisdk",
        // Keep the complete native input tree, but keep the generated response below the
        // server's maximum response-frame size; separate tests cover large native attachments.
        serve_native: false,
        session_id: sessionId,
        render_config: "provider:anthropic|model:perf-fixture",
        system_prompt_hash: "perf-system",
        upgrade_state: "stable",
        protected_tags: 5,
        messages,
        native_messages: nativeMessages,
        tool_input_key_orders: {},
        full_array_fingerprint: fingerprint,
        usage: {
            current_total_input_tokens: 20_000,
            context_limit_tokens: 200_000,
            final_wire_input_tokens: 20_000,
            final_wire_trusted: true,
        },
        provider_id: "anthropic",
        model_key: "perf-fixture",
        channel2_nudge_state: "idle",
        emergency_recovery_armed: false,
    };
}

// The structural assertions (status, page count, serialized-message ceiling) are
// load-independent and run in every lane; only the wall-clock budgets are gated
// behind MC_PERF_GATE, so an ungated run still records timings instead of
// skipping the file (the hermetic runner treats an all-skip file as a crash).
describe.skipIf(!rustPrereqs.ok)("rust performance: ASTRO-shape cold seed", () => {
    let h: RustTestHarness;

    beforeAll(async () => {
        h = await RustTestHarness.create({
            startHistorianProducer: false,
            seedModuleStorePath: REPLAY_STORE_PATH,
        });
    });

    afterAll(async () => {
        await h?.dispose();
    });

    it(
        "keeps a 9.6k-message, 8k-tool cold full transform below the load-class budget",
        async () => {
            const sessionId = REPLAY_SESSION_ID ?? "ses_astro_shape_perf";
            if (!PERF_FULL_OUTPUT && !REPLAY_STORE_PATH) {
                // Compartments are shared context rows, so seed them directly in context.db.
                const db = openTestDb(join(h.env.dataDir, "cortexkit", "magic-context", "context.db"));
                try {
                    db.transaction(() => {
                        for (const row of astroCompartments()) {
                            const columns = Object.keys(row);
                            db.prepare(`INSERT INTO compartments (session_id, ${columns.join(", ")}) VALUES (?, ${columns.map(() => "?").join(", ")})`)
                                .run(sessionId, ...Object.values(row));
                        }
                    })();
                    expect(db.query("SELECT COUNT(*) AS n FROM compartments WHERE session_id=?").get(sessionId)).toEqual({ n: COMPARTMENT_COUNT });
                } finally {
                    db.close();
                }
            }

            const payload = astroShape(sessionId);
            const configuredPageBytes = Number(process.env.MC_PERF_PAGE_BYTES);
            const pageBytes = Number.isSafeInteger(configuredPageBytes) && configuredPageBytes > 0
                ? configuredPageBytes
                : MODULE_PAGE_MAX_BYTES;
            const pages = buildPagedModuleTransformPayloads(payload, pageBytes);
            const wireBytes = pages.reduce((sum, page) => sum + page.bytes, 0);
            await h.subc.moduleSeriesRequest(
                sessionId,
                h.env.workdir,
                pages.map((page) => page.page),
                600_000,
            );
            await h.subc.restartModule();
            const coldPages = buildPagedModuleTransformPayloads(payload, pageBytes);
            const startedAt = performance.now();
            const responses = await h.subc.moduleSeriesRequest(
                sessionId,
                h.env.workdir,
                coldPages.map((page) => page.page),
                600_000,
            );
            const elapsedMs = performance.now() - startedAt;
            const result = responses.at(-1) ?? {};
            const timings = (result.timings ?? {}) as Record<string, number>;
            console.log(
                `rust-cold-seed-perf wire_bytes=${wireBytes} pages=${pages.length} wall_ms=${elapsedMs.toFixed(1)} ` +
                    `handler_total=${Number(timings.handler_total ?? 0).toFixed(1)} total=${Number(timings.total ?? 0).toFixed(1)} ` +
                    `request_decode=${Number(timings.request_decode ?? 0).toFixed(1)} handler_prepare=${Number(timings.handler_prepare ?? 0).toFixed(1)} ` +
                    `transform_execute=${Number(timings.transform_execute ?? 0).toFixed(1)} handler_followup=${Number(timings.handler_followup ?? 0).toFixed(1)} ` +
                    `state_evolution=${Number(timings.state_evolution ?? 0).toFixed(1)} build_output=${Number(timings.build_output ?? 0).toFixed(1)} ` +
                    `build_serialize_misses=${Number(timings.build_serialize_misses ?? 0).toFixed(1)} build_serialized_messages=${Number(timings.build_serialized_messages ?? 0)} build_tail_loop=${Number(timings.build_tail_loop ?? 0).toFixed(1)} ` +
                    `native_attach=${Number(timings.native_attach ?? 0).toFixed(1)} post_attach=${Number(timings.post_attach ?? 0).toFixed(1)}`,
            );
            expect(result.status).toBe("ok");
            expect(pages.length).toBeGreaterThan(1);
            const serializedMessageLimit = PERF_FULL_OUTPUT
                ? MESSAGE_COUNT + 2
                : COLD_SERIALIZED_MESSAGE_LIMIT;
            expect(Number(timings.build_serialized_messages)).toBeLessThanOrEqual(serializedMessageLimit);
            if (PERF_GATE && !PERF_FULL_OUTPUT) {
                expect(Number(timings.build_output)).toBeLessThan(COLD_BUILD_OUTPUT_LIMIT_MS);
                expect(Number(timings.handler_total)).toBeLessThan(COLD_HANDLER_LIMIT_MS);
            }
        },
        600_000,
    );
});
