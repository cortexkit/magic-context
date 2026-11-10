/// <reference types="bun-types" />

/**
 * Live sessions paid two epoch HARDs about twenty seconds apart after a module
 * restart, both reporting `identity_delta=base`. The restarted module rejects
 * the adapter's first tail-delta request with need_full_sync, and the adapter
 * retries with the complete message array. That retry rebuilt the request
 * without the session's reasoning variant, so the module recorded a render
 * identity lacking `variant:<effort>` (HARD), and the next ordinary pass sent
 * the variant again (second HARD).
 *
 * The module keeps the variant in the render identity only for providers whose
 * effort change busts the provider cache (the Anthropic family, including
 * Bedrock). The session therefore runs on a Bedrock-named mock provider and
 * sends every turn with a variant. The older restart fixture in
 * rust-timeout-double-hard.test.ts sends no variant and uses a provider whose
 * variant the module strips, so its retry and its next pass always agreed.
 *
 * Drives the FULL production path: opencode → plugin → subc daemon → ck-mc.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { openTestDb } from "../src/test-db";
import { join } from "node:path";
import { RustTestHarness } from "../src/rust-harness";
import { rustPrereqs } from "../src/rust-scenario-support";

const VARIANT = "high";
const PASSES_AFTER_RESTART = 4;

function persistedRenderIdentity(h: RustTestHarness, sessionId: string): string {
    const db = openTestDb(join(h.env.dataDir, "cortexkit", "magic-context", "store.db"), {
        readonly: true,
    });
    try {
        const row = db
            .prepare("SELECT meta FROM mc_cache_state WHERE session_id = ?")
            .get(sessionId) as { meta: string } | undefined;
        if (!row) throw new Error(`missing module cache row for ${sessionId}`);
        return (JSON.parse(row.meta) as { last_render_config?: string }).last_render_config ?? "";
    } finally {
        db.close();
    }
}

function passLines(log: string): string[] {
    return log.split("\n").filter((line) => line.includes("rust pass: "));
}

describe.skipIf(!rustPrereqs.ok)("rust restart variant double HARD", () => {
    let h: RustTestHarness;

    beforeAll(async () => {
        h = await RustTestHarness.create({
            providerID: "mock-bedrock",
            startHistorianProducer: false,
        });
    });

    afterAll(async () => {
        await h?.dispose();
    });

    it(
        "keeps the render identity of the full-array retry after a restart",
        async () => {
            const sessionId = await h.createSession();
            await h.sendPrompt(sessionId, "establish the rust session", { variant: VARIANT });
            await h.sendPrompt(sessionId, "confirm the rust session is steady", {
                variant: VARIANT,
            });
            const steady = await h.waitForRustPasses(2);
            expect(steady.at(-1)?.decision).toBe("SOFT+");
            expect(steady.at(-1)?.wireMessages).toBeLessThanOrEqual(4);
            const steadyIdentity = persistedRenderIdentity(h, sessionId);
            // Without the variant in the identity this fixture cannot observe the defect.
            expect(steadyIdentity).toContain(`variant:${VARIANT}`);

            await h.subc.killModuleAndWait();
            await h.subc.restoreModule();

            const logOffset = h.diagnosticLog().length;
            const beforeRestart = h.readRustPasses().length;
            const identities: string[] = [];
            for (let turn = 0; turn < PASSES_AFTER_RESTART; turn += 1) {
                await h.sendPrompt(sessionId, `pass ${turn} after the restart`, {
                    variant: VARIANT,
                    timeoutMs: 90_000,
                });
                await h.waitForRustPasses(beforeRestart + turn + 1, 60_000);
                identities.push(persistedRenderIdentity(h, sessionId));
            }
            const after = h.readRustPasses().slice(beforeRestart);
            const tail = h.diagnosticLog().slice(logOffset);
            const hardLines = passLines(tail).filter((line) => line.includes("decision=HARD"));
            console.log(
                `[rust-restart-variant-double-hard] decisions=${after.map((pass) => pass.decision).join(",")}`,
            );

            // The re-seed must go through the full-array retry the live sessions took.
            expect(tail).toContain("need_full_sync retry=full");
            expect(after.every((pass) => pass.applied)).toBe(true);
            expect(after.map((pass) => pass.decision)).toEqual(Array(PASSES_AFTER_RESTART).fill("SOFT+"));
            // The identity the re-seed pass records is the one every later pass keeps.
            expect(identities).toEqual(identities.map(() => steadyIdentity));
            // Compare full lines so a failure names each HARD's reason and identity_delta.
            expect(hardLines.slice(1)).toEqual([]);
        },
        600_000,
    );
});
