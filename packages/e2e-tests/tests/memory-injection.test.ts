/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { realpathSync } from "node:fs";
import { resolve as pathResolve, join } from "node:path";
import { TestHarness } from "../src/harness";
// Use the production identity + hash helpers so this test is not coupled to
// Bun.hash's specific (version-dependent) output. The plugin computes the same
// identity and normalized hash internally; importing the helpers here keeps the
// test aligned with whatever the plugin does at runtime.
import { resolveProjectIdentity } from "../../plugin/src/features/magic-context/memory/project-identity";
import { computeNormalizedHash } from "../../plugin/src/features/magic-context/memory/normalize-hash";

/**
 * Memory injection — regression test for v0.9.1.
 *
 * Before v0.9.1, if a session had no compartments yet, prepareCompartmentInjection
 * returned null and <session-history> was never built. Memories were therefore not
 * injected until historian published its first compartment.
 *
 * This test seeds a project-scoped memory directly in the plugin DB before any
 * compartment exists, then drives a second turn and asserts that the request
 * body reaching the model contains <session-history> with <project-memory>
 * carrying our seeded directive — proving injection works even with zero
 * compartments.
 */

let h: TestHarness;

beforeAll(async () => {
    h = await TestHarness.create();
});

afterAll(async () => {
    await h.dispose();
});

/**
 * Compute the same project identity the plugin will resolve at runtime.
 *
 * CRITICAL: OpenCode passes a realpath-resolved directory to the plugin via
 * `hook.directory`. On macOS, `tmpdir()` returns a `/var/folders/...` path
 * that is a symlink to `/private/var/folders/...`. We must `realpathSync` here
 * so our call to `resolveProjectIdentity` matches what the plugin computes at
 * runtime; otherwise the memory seed lands on a different identity and the
 * injection misses silently.
 *
 * Delegates to the production `resolveProjectIdentity` so the test stays in
 * lockstep with the plugin's identity format and hash scheme (whatever they
 * happen to be at any given commit).
 */
function computeDirIdentity(directory: string): string {
    return resolveProjectIdentity(realpathSync(pathResolve(directory)));
}

/**
 * Seed a project-scoped memory row directly. We use a writable handle distinct
 * from the harness's read-only cached handle.
 */
function seedMemory(h: TestHarness, projectIdentity: string, content: string): void {
    // Plugin v0.16+ — shared cortexkit/magic-context path.
    const dbPath = join(h.opencode.env.dataDir, "cortexkit", "magic-context", "context.db");
    const db = new Database(dbPath);
    try {
        const now = Date.now();
        // Use the production hash helper so this matches the value the plugin
        // stores when it promotes a memory. Plugin uses Bun.CryptoHasher("md5"),
        // which is stable across Bun versions (unlike Bun.hash).
        const normalizedHash = computeNormalizedHash(content);
        db.prepare(
            `INSERT INTO memories (
                project_path, category, content, normalized_hash,
                source_session_id, source_type,
                seen_count, retrieval_count,
                first_seen_at, created_at, updated_at, last_seen_at,
                status
             ) VALUES (?, 'USER_DIRECTIVES', ?, ?, NULL, 'historian', 5, 0, ?, ?, ?, ?, 'active')`,
        ).run(projectIdentity, content, normalizedHash, now, now, now, now);
    } finally {
        db.close();
    }
}

describe("memory injection", () => {
    it("injects <project-memory> on first turn even with no compartments", async () => {
        h.mock.reset();
        h.mock.setDefault({
            text: "ack",
            usage: {
                input_tokens: 100,
                output_tokens: 10,
                cache_creation_input_tokens: 100,
                cache_read_input_tokens: 0,
            },
        });

        // Turn 1 — bootstrap so the plugin creates context.db and writes the
        // session_meta row. No memories seeded yet.
        const sessionId = await h.createSession();
        await h.sendPrompt(sessionId, "bootstrap turn");
        await h.waitFor(() => h.hasContextDb() && h.countTags(sessionId) > 0, {
            timeoutMs: 5000,
            label: "plugin initialized",
        });

        // Seed one memory scoped to the workdir's project identity.
        const projectIdentity = computeDirIdentity(h.opencode.env.workdir);
        seedMemory(
            h,
            projectIdentity,
            "test seeded directive: always prefer bun over npm for running scripts",
        );

        // Clear captured requests so the assertion targets only turn 2's payload.
        h.mock.reset();
        h.mock.setDefault({
            text: "ack 2",
            usage: {
                input_tokens: 150,
                output_tokens: 10,
                cache_creation_input_tokens: 150,
                cache_read_input_tokens: 0,
            },
        });

        await h.sendPrompt(sessionId, "second turn");

        // Still no compartments at this point — we're testing the zero-compartment
        // memory injection path specifically.
        expect(h.countCompartments(sessionId)).toBe(0);

        const req = h.mock.lastRequest();
        expect(req).not.toBeNull();

        // The <session-history> block is prepended to the first user message in
        // the visible array. Flatten everything and assert on the whole payload
        // — this way the test survives cosmetic ordering changes.
        const fullBody = JSON.stringify(req!.body);
        expect(fullBody).toContain("<session-history>");
        expect(fullBody).toContain("<project-memory>");
        expect(fullBody).toContain("test seeded directive");
    }, 60_000);
});
