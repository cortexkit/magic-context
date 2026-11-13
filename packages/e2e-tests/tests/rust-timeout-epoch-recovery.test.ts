/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { openTestDb } from "../src/test-db";
import { join } from "node:path";
import { RustTestHarness } from "../src/rust-harness";
import { rustPrereqs } from "../src/rust-scenario-support";

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

describe.skipIf(!rustPrereqs.ok)("rust timeout epoch recovery", () => {
    let h: RustTestHarness;

    beforeAll(async () => {
        h = await RustTestHarness.create({
            driveFaultBinary: true,
            startHistorianProducer: false,
            moduleEnv: { CK_LOG: "debug" },
        });
    });

    afterAll(async () => {
        await h?.dispose();
    });

    it("recovers a timed-out steady session with one HARD before returning to SOFT", async () => {
        const sessionId = await h.createSession();
        await h.sendPrompt(sessionId, "establish the rust session");
        await h.sendPrompt(sessionId, "confirm the rust session is steady");
        const steady = await h.waitForRustPasses(2);
        expect(steady.slice(-2).map((pass) => pass.decision)).toEqual(["HARD", "SOFT+"]);

        await h.subc.killModuleAndWait();
        regressPersistedTagEpoch(h, sessionId);
        await h.subc.restoreModule({
            MC_DRIVE_FAULT: "transform_timeout",
            MC_DRIVE_FAULT_COUNT: "1",
            // The client waits 15s, then retries the exact final request for up to 45s
            // without applying the transaction twice. This stall must outlast both.
            MC_DRIVE_FAULT_DELAY_MS: "65000",
        });

        const beforeTimeout = h.readRustPasses().length;
        await h.sendPrompt(sessionId, "exercise the stalled module request", { timeoutMs: 90_000 });
        const timeoutPasses = await h.waitForRustPasses(beforeTimeout + 1, 30_000);
        // While the timed-out module is unavailable, a previously captured,
        // size-limited last-known-good payload is preferable to raw history;
        // neither option applies a result from the module.
        expect(timeoutPasses.at(-1)?.applied).toBe(false);
        const servedFrom = timeoutPasses.at(-1)?.servedFrom;
        expect(servedFrom).toBeDefined();
        expect(["raw", "lkg"]).toContain(servedFrom!);
        // Let the delayed execution finish before testing recovery.
        await Bun.sleep(7_000);

        const beforeRecovery = timeoutPasses.length;
        await h.sendPrompt(sessionId, "first recovery pass", { timeoutMs: 90_000 });
        await h.sendPrompt(sessionId, "second recovery pass", { timeoutMs: 90_000 });
        const recovery = (await h.waitForRustPasses(beforeRecovery + 2, 30_000)).slice(
            beforeRecovery,
            beforeRecovery + 2,
        );
        expect(recovery.map((pass) => pass.decision)).toEqual(["HARD", "SOFT+"]);
        const staleIdentityEvaluations = h.subc
            .moduleLog()
            .split("\n")
            .filter(
                (line) =>
                    line.includes("render identity") &&
                    line.includes("changed=true") &&
                    line.includes("tfe:4:tfe3"),
            );
        expect(staleIdentityEvaluations).toHaveLength(1);
        expect(staleIdentityEvaluations[0]).toContain("observed=true coordinator=true");
        expect(staleIdentityEvaluations[0]).toContain("tfe:4:tfe4");
        expect(staleIdentityEvaluations[0]).not.toContain("|mur:");
    }, 300_000);
});
