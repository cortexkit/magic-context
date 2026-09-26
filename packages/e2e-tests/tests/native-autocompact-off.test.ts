/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { afterEach, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { TestHarness } from "../src/harness";
import { forEachHost } from "../src/scenario-hosts";

/**
 * OpenCode 1's own auto-compaction must not run in a session Magic Context
 * manages.
 *
 * OpenCode compacts automatically when a step's tokens reach the model's
 * usable window, unless `compaction.auto` is false. Magic Context disables
 * itself when it sees `auto=true`, but when no config layer it can read says
 * anything about compaction it stays enabled (a false disable would leave
 * nothing managing the window), and OpenCode's default is `auto=true`, so both
 * managers ran.
 *
 * The session here has no compaction setting anywhere, which is that
 * inconclusive state, and one reply whose usage crosses OpenCode's overflow
 * line. The positive control shows the same reply does trigger native
 * compaction when Magic Context is not managing compaction.
 */

const MODEL_CONTEXT_LIMIT = 200_000;
const OVERFLOW_USAGE = {
    input_tokens: 2_000,
    output_tokens: 100,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 197_000,
};
const SMALL_USAGE = {
    input_tokens: 500,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
};

// OpenCode 1 only: its native compaction and config layers are the subject.
forEachHost(import.meta.url, null, () => {
    let harness: TestHarness | undefined;

    afterEach(async () => {
        await harness?.dispose();
        harness = undefined;
    });

    /** Native compaction summaries OpenCode wrote, excluding Magic Context's own marker rows. */
    function nativeCompactionSummaries(h: TestHarness, sessionId: string): number {
        const dbPath = ["opencode.db", "opencode-local.db"]
            .map((f) => join(h.dataDir, "opencode", f))
            .find((p) => existsSync(p));
        expect(dbPath).toBeDefined();
        const db = new Database(dbPath!, { readonly: true });
        try {
            const row = db
                .query(
                    `SELECT COUNT(*) AS n FROM message
                     WHERE session_id = ?
                       AND json_extract(data, '$.role') = 'assistant'
                       AND json_extract(data, '$.summary') = 1
                       AND COALESCE(json_extract(data, '$.providerID'), '') <> 'magic-context'`,
                )
                .get(sessionId) as { n: number };
            return row.n;
        } finally {
            db.close();
        }
    }

    async function driveOverflowTurn(h: TestHarness): Promise<string> {
        let bigSent = false;
        h.mock.addMatcher((body) => {
            // Only the agent's own request carries tools; the title request does not.
            if (bigSent || !Array.isArray(body.tools) || body.tools.length === 0) return null;
            bigSent = true;
            return { text: "a long answer", usage: OVERFLOW_USAGE };
        });
        h.mock.setDefault({ text: "ok", usage: SMALL_USAGE });
        const sessionId = await h.createSession();
        await h.sendPrompt(sessionId, "answer at length", { timeoutMs: 90_000 });
        await h.waitForMockQuiescence({ label: "overflow turn settles" });
        expect(bigSent).toBe(true);
        return sessionId;
    }

    it("a Magic Context session with no compaction setting never runs native auto-compaction", async () => {
        harness = await TestHarness.create({
            omitConfigDirCompaction: true,
            modelContextLimit: MODEL_CONTEXT_LIMIT,
            magicContextConfig: { execute_threshold_percentage: 90 },
        });
        const sessionId = await driveOverflowTurn(harness);
        harness.assertMagicContextProcessed(sessionId);
        expect(nativeCompactionSummaries(harness, sessionId)).toBe(0);
    }, 150_000);

    it("positive control: the same reply triggers native compaction when Magic Context leaves compaction to OpenCode", async () => {
        harness = await TestHarness.create({
            omitConfigDirCompaction: true,
            modelContextLimit: MODEL_CONTEXT_LIMIT,
            magicContextConfig: { compaction: { enabled: false } },
        });
        const sessionId = await driveOverflowTurn(harness);
        expect(nativeCompactionSummaries(harness, sessionId)).toBeGreaterThan(0);
    }, 150_000);
});
