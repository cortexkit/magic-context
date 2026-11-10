/// <reference types="bun-types" />

/**
 * Incident regression #2: the cold-start seed omitted TS dropped-tag state, so
 * the first rust wire exploded (476K vs 110K) because previously-dropped content
 * came back at full size. The fix seeds TS drops as frozen reductions at cold
 * start so the first rust pass reproduces them.
 *
 * This drives the exact incident shape end to end:
 *   1. Build a session under TS mode and apply a ctx_reduce drop under pressure
 *      so a `[dropped §N§]` reduction exists in TS state.
 *   2. Flip the project config ts → rust and RESTART serve against the same data
 *      dir (opencode.db + context.db survive).
 *   3. The first rust pass must reproduce the drop (not re-expand it): the served
 *      wire is SMALLER than the raw message array, and does not balloon past a
 *      sane bound relative to the TS-mode wire.
 *
 * Assertion style: wire-size bounds and presence of the drop marker, from the
 * fake provider's full request bodies. Raw-array size is measured directly from
 * opencode.db (the bytes opencode would send with no transform).
 */

import { openTestDb } from "../src/test-db";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { RustTestHarness } from "../src/rust-harness";
import { rustPrereqs } from "../src/rust-scenario-support";

/** Sum of every message-part JSON byte for a session in opencode.db — the raw,
 *  untransformed array size opencode would otherwise send to the provider. */
function rawArrayBytes(h: RustTestHarness, sessionId: string): number {
    const ocPath = join(h.env.dataDir, "opencode", "opencode.db");
    const db = openTestDb(ocPath, { readonly: true });
    try {
        const parts = db
            .prepare(
                "SELECT p.data AS data FROM part p JOIN message m ON m.id = p.message_id WHERE m.session_id = ?",
            )
            .all(sessionId) as Array<{ data: string }>;
        return parts.reduce((sum, part) => sum + Buffer.byteLength(part.data), 0);
    } finally {
        db.close();
    }
}

describe.skipIf(!rustPrereqs.ok)("rust invariant: cold-start drop seed", () => {
    let h: RustTestHarness;

    beforeAll(async () => {
        // Small context limit + real content ballast so pressure genuinely
        // crosses the execute threshold (the module measures true-raw content,
        // not the mock's fabricated usage). Start in TS mode.
        h = await RustTestHarness.create({
            modelContextLimit: 30_000,
            startInTsMode: true,
            // This drill must reach the first Rust transform with only the TS
            // frozen reduction; a historian publication would legitimately replace
            // that sentinel with m0 before the cold-start seed can be observed.
            startHistorianProducer: false,
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

    it("seeds TS dropped-tag state into the first rust pass without context expansion", async () => {
        const sessionId = await h.createSession();

        // Build TS-mode state with taggable content.
        for (let i = 1; i <= 3; i += 1) {
            h.mock.setDefault({
                text: `assistant reply ${i}`,
                usage: {
                    input_tokens: 2_000 * i,
                    output_tokens: 20,
                    cache_creation_input_tokens: 1_000,
                },
            });
            await h.sendPrompt(sessionId, `turn ${i}: ${h.ballast(1_500)}`);
        }
        await Bun.sleep(500);

        // Drop the first visible tag via an agent-issued ctx_reduce.
        const tsWire = h.lastMainWireSerialized();
        const tags = [...new Set([...tsWire.matchAll(/§(\d+)§/g)].map((m) => Number(m[1])))].sort(
            (a, b) => a - b,
        );
        expect(tags.length).toBeGreaterThan(0);
        const dropTag = tags[0]!;

        let dropEmitted = false;
        h.mock.addMatcher((body) => {
            if (dropEmitted || !JSON.stringify(body.system ?? "").includes("## Magic Context")) {
                return null;
            }
            const tools = body.tools;
            if (!Array.isArray(tools)) return null;
            const name = (
                tools.find((t) => /ctx_reduce/.test(String((t as { name?: unknown })?.name ?? ""))) as
                    | { name?: string }
                    | undefined
            )?.name;
            if (!name) return null;
            dropEmitted = true;
            return {
                content: [
                    { type: "tool_use", id: `toolu_reduce_${Date.now()}`, name, input: { drop: String(dropTag) } },
                ],
                stop_reason: "tool_use",
                usage: { input_tokens: 8_000, output_tokens: 20, cache_creation_input_tokens: 1_000 },
            };
        });
        await h.sendPrompt(sessionId, `turn 4: reduce tag ${dropTag}`);

        // Cross the force band so the pending drop has a legitimate originating bust.
        for (let i = 5; i <= 7; i += 1) {
            h.mock.setDefault({
                text: `pressure ${i}`,
                usage: { input_tokens: 27_000, output_tokens: 20, cache_creation_input_tokens: 2_000 },
            });
            await h.sendPrompt(sessionId, `turn ${i}: ${h.ballast(1_500)}`);
        }
        await Bun.sleep(800);

        // TS-mode drop landed: the served wire carries a [dropped …] marker.
        expect(dropEmitted).toBe(true);
        const tsFinalWire = h.lastMainWireSerialized();
        expect(tsFinalWire).toContain("[dropped");
        const tsWireBytes = h.lastMainWireBytes();
        const rawBytes = rawArrayBytes(h, sessionId);

        // FLIP ts → rust and restart serve against the same data dir.
        await h.restart({
            rust: true,
            magicContextConfig: {
                execute_threshold_percentage: 25,
                protected_tags: 1,
                compressor: { enabled: false },
            },
        });

        // First rust pass. The cold-start seed must translate the TS frozen
        // reduction so the drop is reproduced, not re-expanded.
        h.mock.setDefault({
            text: "after flip",
            usage: { input_tokens: 20_000, output_tokens: 20, cache_creation_input_tokens: 2_000 },
        });
        await h.sendPrompt(sessionId, `turn 8: after flip ${h.ballast(300)}`);
        await Bun.sleep(800);

        const rustPasses = await h.waitForRustPasses(1);
        expect(rustPasses.length).toBeGreaterThan(0);
        const rustWire = h.lastMainWireSerialized();
        const rustWireBytes = h.lastMainWireBytes();

        // Invariant 1: the drop is seeded as a frozen reduction — the first rust
        // wire still carries the [dropped …] marker (the dropped content did NOT
        // come back at full size, the exact incident #2 explosion).
        expect(rustWire).toContain("[dropped");

        // Invariant 2: the first rust wire is SMALLER than the raw message array.
        // If the seed were omitted, the dropped content would re-expand and the
        // wire would meet or exceed the raw array (the incident behavior).
        expect(rustWireBytes).toBeLessThan(rawBytes);

        // Invariant 3: no context expansion beyond a sane bound vs the TS-mode
        // wire. The incident ballooned 4.3x (476K vs 110K); a correct seed keeps
        // the rust wire within a small multiple of the TS wire. 2x is far below
        // the incident and far above normal per-pass jitter (~4%).
        expect(rustWireBytes).toBeLessThan(tsWireBytes * 2);
    }, 300_000);
});
