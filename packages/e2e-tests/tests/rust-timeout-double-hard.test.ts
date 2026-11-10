/// <reference types="bun-types" />

/**
 * Live sessions showed two epoch HARDs a few seconds apart after a module
 * timeout (and after a provider 400): one pass re-rendered, and the very next
 * pass re-rendered again. Each HARD re-writes the whole provider cache.
 *
 * This drives the real adapter against the real module: a steady session, a
 * module restart that also changes the session's render identity (as a redeploy
 * does), a first transform that times out, the recovery pass, and twenty
 * ordinary passes after it. At most the one legitimate HARD may appear from the
 * recovery on, and the adapter must never fall back to a whole-session ordinal
 * re-read.
 *
 * Known limit: restoring the old need_full_sync state re-seed does not produce a
 * second HARD in this fixture, so the live double HARD needs something this
 * session lacks (a long compacted history with compartments and a mirrored
 * compartment cursor, or historian activity around the restart).
 *
 * Drives the FULL production path: opencode → plugin → subc daemon → ck-mc.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { openTestDb } from "../src/test-db";
import { join } from "node:path";
import { RustTestHarness } from "../src/rust-harness";
import { rustPrereqs } from "../src/rust-scenario-support";

const STEADY_PASSES_AFTER_RECOVERY = 20;

/**
 * Stand in for a module redeploy: the live incidents hit every active session at
 * once, which is a restarted module whose render identity differs from the one
 * persisted for the session. Rewrite the persisted identity to an older tag epoch
 * so the restarted module sees a legitimate identity change (one HARD).
 */
function regressPersistedTagEpoch(h: RustTestHarness, sessionId: string): void {
    const db = openTestDb(join(h.env.dataDir, "cortexkit", "magic-context", "store.db"));
    try {
        const row = db
            .prepare("SELECT meta FROM mc_cache_state WHERE session_id = ?")
            .get(sessionId) as { meta: string } | undefined;
        if (!row) throw new Error(`missing module cache row for ${sessionId}`);
        const meta = JSON.parse(row.meta) as {
            last_render_config?: string;
            tagging_surface_active?: boolean;
        };
        const current = meta.last_render_config ?? "";
        if (!current.includes("tfe4")) {
            throw new Error(`steady identity has no tfe4 component: ${current}`);
        }
        meta.last_render_config = current.replace("tfe4", "tfe3");
        meta.tagging_surface_active = false;
        db.prepare("UPDATE mc_cache_state SET meta = ? WHERE session_id = ?").run(
            JSON.stringify(meta),
            sessionId,
        );
    } finally {
        db.close();
    }
}

function passLines(log: string): string[] {
    return log.split("\n").filter((line) => line.includes("rust pass: "));
}

describe.skipIf(!rustPrereqs.ok)("rust timeout double HARD", () => {
    let h: RustTestHarness;

    beforeAll(async () => {
        h = await RustTestHarness.create({
            driveFaultBinary: true,
            startHistorianProducer: false,
        });
    });

    afterAll(async () => {
        await h?.dispose();
    });

    it(
        "renders at most one HARD from a timed-out pass through twenty steady passes",
        async () => {
            const sessionId = await h.createSession();
            await h.sendPrompt(sessionId, "establish the rust session");
            await h.sendPrompt(sessionId, "confirm the rust session is steady");
            const steady = await h.waitForRustPasses(2);
            expect(steady.at(-1)?.decision).toBe("SOFT+");

            await h.subc.killModuleAndWait();
            regressPersistedTagEpoch(h, sessionId);
            await h.subc.restoreModule({
                MC_DRIVE_FAULT: "transform_timeout",
                MC_DRIVE_FAULT_COUNT: "1",
                // Outlast the client's 15s deadline plus its 45s retry of the exact final request.
                MC_DRIVE_FAULT_DELAY_MS: "65000",
            });

            const logOffset = h.diagnosticLog().length;
            const beforeTimeout = h.readRustPasses().length;
            await h.sendPrompt(sessionId, "exercise the stalled module request", {
                timeoutMs: 90_000,
            });
            const timeoutPasses = await h.waitForRustPasses(beforeTimeout + 1, 30_000);
            expect(timeoutPasses.at(-1)).toMatchObject({ applied: false });
            await Bun.sleep(7_000);

            const beforeRecovery = h.readRustPasses().length;
            const turns = STEADY_PASSES_AFTER_RECOVERY + 1;
            for (let turn = 0; turn < turns; turn += 1) {
                await h.sendPrompt(sessionId, `pass ${turn} after the timeout`, {
                    timeoutMs: 90_000,
                });
            }
            const after = (await h.waitForRustPasses(beforeRecovery + turns, 60_000)).slice(
                beforeRecovery,
            );
            const tail = h.diagnosticLog().slice(logOffset);
            const hardLines = passLines(tail).filter((line) => line.includes("decision=HARD"));
            console.log(
                `[rust-timeout-double-hard] decisions=${after.map((pass) => pass.decision).join(",")} ` +
                    `full_retries=${tail.split("\n").filter((line) => line.includes("need_full_sync retry=full")).length}`,
            );
            // A restarted module may retain its saved delta base, or the adapter
            // may send complete arrays first. Either path can recover; unit tests
            // also cover a module that asks for a complete sync because it cannot
            // apply deltas.
            expect(after.length).toBeGreaterThanOrEqual(turns);
            expect(after.every((pass) => pass.applied)).toBe(true);
            // Compare the full lines so a failure names each HARD's reason and
            // identity_delta components.
            expect(hardLines.slice(1)).toEqual([]);
            expect(tail).not.toContain("stage=rust.ordinal_rebuild");
        },
        600_000,
    );
});
