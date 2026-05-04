/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { realpathSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { computeNormalizedHash } from "../../plugin/src/features/magic-context/memory/normalize-hash";
import { resolveProjectIdentity } from "../../plugin/src/features/magic-context/memory/project-identity";
import { PiTestHarness } from "../src/pi-harness";

let h: PiTestHarness;

beforeAll(async () => {
    h = await PiTestHarness.create();
});

afterAll(async () => {
    await h.dispose();
});

function seedMemory(content: string): void {
    const db = new Database(h.contextDbPath());
    try {
        const now = Date.now();
        db.prepare(
            `INSERT INTO memories (
                project_path, category, content, normalized_hash,
                source_session_id, source_type, seen_count, retrieval_count,
                first_seen_at, created_at, updated_at, last_seen_at, status
            ) VALUES (?, 'USER_DIRECTIVES', ?, ?, NULL, 'historian', 1, 0, ?, ?, ?, ?, 'active')`,
        ).run(
            resolveProjectIdentity(realpathSync(pathResolve(h.env.workdir))),
            content,
            computeNormalizedHash(content),
            now,
            now,
            now,
            now,
        );
    } finally {
        db.close();
    }
}

describe("pi memory injection", () => {
    it("injects <project-memory> into the Pi system prompt", async () => {
        h.mock.reset();
        h.mock.setDefault({
            text: "bootstrap",
            usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 100 },
        });
        const bootstrap = await h.sendPrompt("bootstrap pi memory db", { timeoutMs: 60_000 });
        expect(bootstrap.exitCode).toBe(0);

        const directive = "pi seeded directive: prefer stable cross-harness memory checks";
        seedMemory(directive);

        h.mock.reset();
        h.mock.setDefault({
            text: "after seed",
            usage: { input_tokens: 120, output_tokens: 10, cache_creation_input_tokens: 120 },
        });
        await h.sendPrompt("read my project memory", { timeoutMs: 60_000 });

        const body = JSON.stringify(h.mock.lastRequest()!.body);
        expect(body).toContain("<project-memory>");
        expect(body).toContain(directive);
    }, 60_000);
});
