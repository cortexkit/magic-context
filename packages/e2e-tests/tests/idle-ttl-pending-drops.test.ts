/**
 * Queued drops apply on the first pass after an idle longer than the cache TTL
 * (issue 545).
 *
 * Once the provider's cached prefix has expired, the next request pays a full
 * rebuild anyway, so that pass is where queued `ctx_reduce` drops belong. The
 * idle clock is `session_meta.last_response_time`, and only a response the
 * provider served may move it. On Pi it used to move on every `message_end`,
 * including the one Pi emits for the user's new prompt right before that
 * prompt's context pass. On OpenCode 1 it moved on the zero-token assistant
 * message OpenCode creates for a new request right before that request's
 * transform. Either way the pass after a long idle measured an idle of a few
 * milliseconds and deferred the drops. A failed request (a quota error, which
 * arrives with no usage) moved it too.
 *
 * The scenario uses a 6 second TTL and real waits past it. Each case first
 * shows the drop staying queued while the cache is warm, so the drain it then
 * requires cannot come from something other than the expired cache.
 */
import { afterAll, beforeAll, expect, it } from "bun:test";
import {
    createFreshSession,
    createScenarioHarness,
    forEachHost,
    type ScenarioHarness,
} from "../src/scenario-hosts";
import { openTestDb } from "../src/test-db";

const CACHE_TTL_MS = 6_000;
// 10% of a 100k window: far below the execute threshold, so only the idle
// clock can make these passes execute.
const LOW_USAGE = { input_tokens: 10_000, output_tokens: 10, cache_creation_input_tokens: 0 };

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

forEachHost(import.meta.url, "idle past the cache TTL applies queued drops", (host) => {
    let h: ScenarioHarness;

    beforeAll(async () => {
        h = await createScenarioHarness(host, {
            modelContextLimit: 100_000,
            magicContextConfig: {
                cache_ttl: `${CACHE_TTL_MS / 1000}s`,
                execute_threshold_percentage: 90,
                protected_tokens: 4_000,
                historian: { disable: true },
            },
        });
    });

    afterAll(async () => {
        await h.dispose();
    });

    const pendingDrops = (sessionId: string): number => {
        const row = h
            .contextDb()
            .prepare("SELECT COUNT(*) AS n FROM pending_ops WHERE session_id = ? AND harness = ?")
            .get(sessionId, h.harnessId) as { n: number } | null;
        return row?.n ?? 0;
    };

    const tagStatus = (sessionId: string, tagNumber: number): string | undefined => {
        const row = h
            .contextDb()
            .prepare(
                "SELECT status FROM tags WHERE session_id = ? AND harness = ? AND tag_number = ?",
            )
            .get(sessionId, h.harnessId, tagNumber) as { status: string } | null;
        return row?.status;
    };

    // One answered turn whose large reply pushes tag 1 out of the protected
    // tail, then a drop of tag 1 queued the way ctx_reduce queues it.
    const turnWithQueuedDrop = async (label: string): Promise<string> => {
        h.mock.reset();
        h.mock.setDefault({
            content: Array.from({ length: 24 }, (_, index) => ({
                type: "text",
                text: `${label} block ${index + 1}: ${h.ballast(200)}`,
            })),
            usage: LOW_USAGE,
        });
        // Each case needs its own session: tag 1 of a reused one is already dropped.
        const sessionId = await createFreshSession(h);
        await h.sendPrompt(sessionId, `${label}: first turn`, { timeoutMs: 60_000 });
        await h.waitFor(() => h.countTags(sessionId) > 0, { label: `${label}: tag ready` });
        const writable = openTestDb(h.contextDbPath());
        try {
            writable
                .prepare(
                    "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, 1, 'drop', ?, ?)",
                )
                .run(sessionId, Date.now(), h.harnessId);
        } finally {
            writable.close();
        }
        h.mock.reset();
        h.mock.setDefault({ text: `${label}: answer`, usage: LOW_USAGE });
        return sessionId;
    };

    it("applies the drop on the first pass after the user returns from the idle", async () => {
        const sessionId = await turnWithQueuedDrop("resume");

        // Warm cache: the next prompt defers the drop.
        await h.sendPrompt(sessionId, "resume: warm turn", { timeoutMs: 60_000 });
        expect(pendingDrops(sessionId)).toBe(1);
        expect(tagStatus(sessionId, 1)).toBe("active");

        await sleep(CACHE_TTL_MS + 2_000);
        await h.sendPrompt(sessionId, "resume: continue after the idle", { timeoutMs: 60_000 });

        expect(pendingDrops(sessionId)).toBe(0);
        expect(tagStatus(sessionId, 1)).toBe("dropped");
        expect(JSON.stringify(h.mock.lastRequest()!.body)).toContain("dropped §1§");
    }, 120_000);

    it("measures the idle from the last served response when a later request failed", async () => {
        const sessionId = await turnWithQueuedDrop("failed");

        // Part way into the TTL a request fails the way a spent quota does: the
        // provider refuses it and serves nothing. The pass building it defers.
        await sleep(CACHE_TTL_MS / 2);
        h.mock.reset();
        h.mock.setDefault({
            error: {
                status: 400,
                type: "invalid_request_error",
                message: "Your credit balance is too low to access the API.",
            },
        });
        try {
            await h.sendPrompt(sessionId, "failed: request refused", { timeoutMs: 60_000 });
        } catch {
            // Hosts may surface the refusal as a failed prompt; either way it is recorded.
        }
        expect(pendingDrops(sessionId)).toBe(1);

        // More than a TTL after the last served response, but less than one
        // after the failure: the cache is dead and the drop must apply.
        await sleep(CACHE_TTL_MS / 2 + 1_500);
        h.mock.reset();
        h.mock.setDefault({ text: "failed: answer", usage: LOW_USAGE });
        await h.sendPrompt(sessionId, "failed: continue", { timeoutMs: 60_000 });

        expect(pendingDrops(sessionId)).toBe(0);
        expect(tagStatus(sessionId, 1)).toBe("dropped");
        expect(JSON.stringify(h.mock.lastRequest()!.body)).toContain("dropped §1§");
    }, 120_000);
});
