/**
 * An idle longer than the cache TTL keeps queued drops queued until a real
 * rebuild (issue 545, where the expired cache used to land them).
 *
 * The provider forgets its cached prompt after the TTL, but the request's bytes
 * are unchanged, so resending them costs the same one cache write a rebuild
 * would, and rebuilding would also throw away context and kept reasoning the
 * agent may still need. So the first request after a long idle must be the
 * previous request plus the newly appended messages: a queued `ctx_reduce` drop
 * stays queued and its tag stays active. The drop lands on the next real
 * rebuild; here that is `/ctx-flush`, which the scenario drives on every host.
 *
 * The idle clock (`session_meta.last_response_time`) no longer decides
 * anything, but it still feeds the cache diagnostics, and only a response the
 * provider served may move it. A failed request (a quota error, which arrives
 * with no usage) must leave it where the last served response put it.
 *
 * The scenario uses a 6 second TTL and real waits past it.
 */
import { afterAll, beforeAll, expect, it } from "bun:test";
import type { CapturedRequest } from "../src/mock-provider/server";
import {
    createFreshSession,
    createScenarioHarness,
    forEachHost,
    requestCtxFlush,
    type ScenarioHarness,
} from "../src/scenario-hosts";
import { openTestDb } from "../src/test-db";

const CACHE_TTL_MS = 6_000;
// 10% of a 100k window: far below the execute threshold, so pressure never
// makes these passes execute and only the flush can rebuild.
const LOW_USAGE = { input_tokens: 10_000, output_tokens: 10, cache_creation_input_tokens: 0 };

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Hosts move cache breakpoints forward as messages append. Compare every other
// byte of the system prompt, tools and messages.
const bytes = (value: unknown) =>
    JSON.stringify(value, (key, item) => (key === "cache_control" ? undefined : item));

/** `after` must be `before` plus newly appended messages, byte for byte. */
function expectAppendOnly(before: CapturedRequest, after: CapturedRequest): void {
    expect(bytes(after.body.system)).toBe(bytes(before.body.system));
    expect(bytes(after.body.tools)).toBe(bytes(before.body.tools));
    expect(bytes(after.body.messages?.slice(0, before.body.messages?.length))).toBe(
        bytes(before.body.messages),
    );
}

forEachHost(import.meta.url, "idle past the cache TTL keeps queued drops until a real rebuild", (host) => {
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

    const responseClock = (sessionId: string): number =>
        (
            h
                .contextDb()
                .prepare(
                    "SELECT last_response_time AS at FROM session_meta WHERE session_id = ? AND harness = ?",
                )
                .get(sessionId, h.harnessId) as { at: number }
        ).at;

    /** The newest request that served the session itself (title generation has no tools). */
    const lastSessionRequest = (): CapturedRequest => {
        const request = h
            .requests()
            .filter(
                (candidate) =>
                    Array.isArray(candidate.body.tools) &&
                    candidate.body.tools.length > 0 &&
                    JSON.stringify(candidate.body.system).includes("## Magic Context"),
            )
            .at(-1);
        if (!request) throw new Error("no session request captured");
        return request;
    };

    // One answered turn whose large reply pushes tag 1 out of the protected
    // tail, then a drop of tag 1 queued the way ctx_reduce queues it. Returns
    // the session and the request that turn served.
    const turnWithQueuedDrop = async (
        label: string,
    ): Promise<{ sessionId: string; served: CapturedRequest }> => {
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
        const served = lastSessionRequest();
        h.mock.reset();
        h.mock.setDefault({ text: `${label}: answer`, usage: LOW_USAGE });
        return { sessionId, served };
    };

    /** The drop is still queued and the served request still carries tag 1. */
    const expectDropQueued = (sessionId: string): void => {
        expect(pendingDrops(sessionId)).toBe(1);
        expect(tagStatus(sessionId, 1)).toBe("active");
        expect(JSON.stringify(lastSessionRequest().body)).not.toContain("dropped §1§");
    };

    /** `/ctx-flush` rebuilds the next request, and the queued drop lands on it. */
    const flushLandsDrop = async (sessionId: string, label: string): Promise<void> => {
        await requestCtxFlush(h, sessionId);
        await h.sendPrompt(sessionId, `${label}: after the flush`, { timeoutMs: 60_000 });
        expect(pendingDrops(sessionId)).toBe(0);
        expect(tagStatus(sessionId, 1)).toBe("dropped");
        expect(JSON.stringify(lastSessionRequest().body)).toContain("dropped §1§");
    };

    it("replays the request after the idle with the drop still queued, and lands the drop on /ctx-flush", async () => {
        const { sessionId } = await turnWithQueuedDrop("resume");

        // Warm cache: the next prompt defers the drop.
        await h.sendPrompt(sessionId, "resume: warm turn", { timeoutMs: 60_000 });
        expectDropQueued(sessionId);
        const warm = lastSessionRequest();

        await sleep(CACHE_TTL_MS + 2_000);
        await h.sendPrompt(sessionId, "resume: continue after the idle", { timeoutMs: 60_000 });

        // The expired cache changes nothing: same bytes plus the new prompt.
        expectDropQueued(sessionId);
        expectAppendOnly(warm, lastSessionRequest());

        await flushLandsDrop(sessionId, "resume");
    }, 120_000);

    it("keeps the idle clock on the last served response through a failed request, and the drop queued until /ctx-flush", async () => {
        const { sessionId, served } = await turnWithQueuedDrop("failed");

        // Part way into the TTL a request fails the way a spent quota does: the
        // provider refuses it and serves nothing. The pass building it defers.
        await sleep(CACHE_TTL_MS / 2);
        // Read the clock after the wait, so a late completion write for the
        // served reply has already landed.
        const servedClock = responseClock(sessionId);
        expect(servedClock).toBeGreaterThan(0);
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
        await h.waitForMockQuiescence();
        expectDropQueued(sessionId);
        expectAppendOnly(served, lastSessionRequest());
        // Nothing was served, so the idle clock stays where the last reply put it.
        expect(responseClock(sessionId)).toBe(servedClock);

        // More than a TTL after the last served response, but less than one
        // after the failure: the cache is dead, and that still rebuilds nothing.
        await sleep(CACHE_TTL_MS / 2 + 1_500);
        h.mock.reset();
        h.mock.setDefault({ text: "failed: answer", usage: LOW_USAGE });
        await h.sendPrompt(sessionId, "failed: continue", { timeoutMs: 60_000 });
        expectDropQueued(sessionId);
        expectAppendOnly(served, lastSessionRequest());
        // A served reply moves the clock again. Hosts can record its completion
        // just after the prompt call returns, so wait for it.
        await h.waitFor(() => responseClock(sessionId) > servedClock, {
            timeoutMs: 5_000,
            label: "served reply moves the idle clock",
        });

        await flushLandsDrop(sessionId, "failed");
    }, 120_000);
});
