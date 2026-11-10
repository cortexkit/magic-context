/// <reference types="bun-types" />

import { openTestDb } from "../src/test-db";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { RustTestHarness } from "../src/rust-harness";
import { rustPrereqs } from "../src/rust-scenario-support";

function valueOf(response: Record<string, unknown>): Record<string, unknown> {
    return response.result && typeof response.result === "object"
        ? (response.result as Record<string, unknown>)
        : response;
}

async function waitForCompartment(h: RustTestHarness, sessionId: string): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
        const status = valueOf(
            await h.subc.moduleStatus(sessionId, h.env.workdir, "session.status"),
        );
        if (Number(status.compartment_count ?? 0) > 0) return status;
        await Bun.sleep(250);
    }
    throw new Error("timed out waiting for a durable Rust compartment");
}

describe.skipIf(!rustPrereqs.ok)("rust maintenance command contract", () => {
    let h: RustTestHarness;

    beforeAll(async () => {
        h = await RustTestHarness.create({
            modelContextLimit: 30_000,
            // The historian gets its own 128k mock model: the 30k session window
            // builds pressure quickly but cannot hold a historian prompt.
            historianModelContextLimit: 128_000,
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

    it("persists the canonical historian no-fire cause", async () => {
        const sessionId = await h.createSession();
        h.mock.setDefault({
            text: "historian no-fire reply",
            usage: {
                input_tokens: 100,
                output_tokens: 20,
                cache_creation_input_tokens: 0,
            },
        });
        await h.sendPrompt(sessionId, "historian no-fire evaluation");

        const store = openTestDb(
            join(h.env.dataDir, "cortexkit", "magic-context", "store.db"),
            { readonly: true },
        );
        store.exec("PRAGMA query_only = ON");
        try {
            const row = store
                .prepare(
                    "SELECT json_extract(meta, '$.historian.last_no_fire') AS last_no_fire FROM mc_cache_state WHERE session_id = ?",
                )
                .get(sessionId) as { last_no_fire: string | null };
            expect(row.last_no_fire).toContain("raw_cause=BelowProactiveFloor");
            expect(row.last_no_fire).toContain("canonical_cause=below_proactive_floor");
        } finally {
            store.close();
        }
    }, 120_000);

    it("records wrapup and recomp dispositions with monotonic cache versions", async () => {
        const sessionId = await h.createSession();
        for (let turn = 1; turn <= 10; turn += 1) {
            h.mock.setDefault({
                text: `maintenance reply ${turn}`,
                usage: {
                    input_tokens: turn * 3_000,
                    output_tokens: 20,
                    cache_creation_input_tokens: 2_000,
                },
            });
            await h.sendPrompt(
                sessionId,
                `maintenance turn ${turn}: ${h.ballast(2_500)}`,
            );
            await Bun.sleep(150);
        }

        const before = await waitForCompartment(h, sessionId);
        expect(Number(before.coverage_ordinal ?? 0)).toBeGreaterThan(0);

        const store = openTestDb(
            join(h.env.dataDir, "cortexkit", "magic-context", "store.db"),
            { readonly: true },
        );
        store.exec("PRAGMA query_only = ON");
        try {
            const rowBefore = store
                .prepare("SELECT row_version FROM mc_cache_state WHERE session_id = ?")
                .get(sessionId) as { row_version: number };

            const wrapup = valueOf(
                await h.subc.moduleRequest(sessionId, h.env.workdir, {
                    method: "session.wrapup",
                    keep: 2,
                    command_id: "hunt14-wrapup",
                }),
            );
            if (wrapup.ok !== true) {
                throw new Error(`session.wrapup failed: ${JSON.stringify(wrapup)}`);
            }
            const wrapupDisposition = wrapup.disposition;
            if (typeof wrapupDisposition !== "string") {
                throw new Error("session.wrapup response omitted its disposition");
            }
            expect(wrapupDisposition).toBe("nothing_to_compact");

            const wrapupRow = store
                .prepare(
                    "SELECT disposition, rounds FROM mc_wrapup_commands WHERE session_id = ? AND command_id = ?",
                )
                .get(sessionId, "hunt14-wrapup") as { disposition: string; rounds: number };
            expect(wrapupRow.disposition).toBe(wrapupDisposition);
            expect(wrapupRow.rounds).toBe(0);

            const afterWrapup = valueOf(
                await h.subc.moduleStatus(sessionId, h.env.workdir, "session.status"),
            );
            const rowAfterWrapup = store
                .prepare("SELECT row_version FROM mc_cache_state WHERE session_id = ?")
                .get(sessionId) as { row_version: number };
            expect(rowAfterWrapup.row_version).toBeGreaterThanOrEqual(rowBefore.row_version);
            expect(Number(afterWrapup.coverage_ordinal ?? 0)).toBeGreaterThan(0);

            const recomp = valueOf(
                await h.subc.moduleRequest(sessionId, h.env.workdir, {
                    method: "session.recomp",
                    command_id: "hunt14-recomp",
                }),
            );
            expect(recomp.ok).toBe(true);
            expect(recomp.disposition).toBe("started");

            const recompRow = store
                .prepare(
                    "SELECT disposition FROM mc_recomp_commands WHERE session_id = ? AND command_id = ?",
                )
                .get(sessionId, "hunt14-recomp") as { disposition: string };
            expect(recompRow.disposition).toBe("started");

            const afterRecomp = valueOf(
                await h.subc.moduleStatus(sessionId, h.env.workdir, "session.status"),
            );
            const rowAfterRecomp = store
                .prepare("SELECT row_version FROM mc_cache_state WHERE session_id = ?")
                .get(sessionId) as { row_version: number };
            expect(rowAfterRecomp.row_version).toBeGreaterThan(rowAfterWrapup.row_version);
            expect(Number(afterRecomp.compartment_count ?? 0)).toBe(0);
            expect(afterRecomp.coverage_ordinal ?? null).toBeNull();
        } finally {
            store.close();
        }
    }, 300_000);
});
