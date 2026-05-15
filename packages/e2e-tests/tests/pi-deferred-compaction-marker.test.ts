/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PiTestHarness } from "../src/pi-harness";

/**
 * Pi deferred compaction marker parity (plan v6).
 *
 * OpenCode writes compaction markers as synthetic message rows. Pi must not do
 * that; it owns a native JSONL `compaction` entry written through
 * `sessionManager.appendCompaction(boundary)`. The v6 invariant is still the
 * same across harnesses:
 *
 *   1. Historian publication stores a
 *      `session_meta.pending_compaction_marker_state` blob immediately.
 *   2. A low-pressure/defer pass leaves that blob byte-identical.
 *   3. The next cache-busting/materialization pass appends Pi's native
 *      compaction entry and CAS-clears the pending blob.
 *
 * This test observes both stores: Magic Context SQLite for pending/applied
 * state, and Pi's session JSONL for the native `type: "compaction"` entry.
 */

const HISTORIAN_SYSTEM_MARKER = "You condense long AI coding sessions";

interface MarkerRow {
    pending_compaction_marker_state: string | null;
    compaction_marker_state: string | null;
}

function isHistorianRequest(body: Record<string, unknown>): boolean {
    const system = body.system;
    if (typeof system === "string") return system.includes(HISTORIAN_SYSTEM_MARKER);
    if (Array.isArray(system)) {
        return system.some((block) => {
            const text = (block as { text?: unknown } | null)?.text;
            return typeof text === "string" && text.includes(HISTORIAN_SYSTEM_MARKER);
        });
    }
    return false;
}

function findOrdinalRange(body: Record<string, unknown>): { start: number; end: number } | null {
    const messages = body.messages as Array<{ content?: unknown }> | undefined;
    if (!messages) return null;
    for (const message of messages) {
        const content = Array.isArray(message.content) ? message.content : [];
        for (const block of content) {
            const text = (block as { text?: unknown } | null)?.text;
            if (typeof text !== "string" || !text.includes("<new_messages>")) continue;
            const ordinals = [...text.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
            if (ordinals.length > 0) return { start: Math.min(...ordinals), end: Math.max(...ordinals) };
        }
    }
    return null;
}

function readMarkerRow(h: PiTestHarness, sessionId: string): MarkerRow | null {
    const db = new Database(h.contextDbPath(), { readonly: true });
    try {
        return db
            .prepare(
                "SELECT pending_compaction_marker_state, compaction_marker_state FROM session_meta WHERE session_id = ?",
            )
            .get(sessionId) as MarkerRow | null;
    } finally {
        db.close();
    }
}

function latestSessionFile(h: PiTestHarness): string | null {
    const roots = [join(h.env.agentDir, "sessions"), h.env.agentDir];
    const files: string[] = [];
    const visit = (dir: string) => {
        if (!existsSync(dir)) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) visit(path);
            else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
        }
    };
    for (const root of roots) visit(root);
    files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return files[0] ?? null;
}

function readCompactionEntries(h: PiTestHarness): Array<Record<string, unknown>> {
    const file = latestSessionFile(h);
    if (!file) return [];
    return readFileSync(file, "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => entry.type === "compaction");
}

describe("pi deferred compaction marker", () => {
    it("persists pending state, preserves it on defer, then applies a native Pi compaction", async () => {
        const h = await PiTestHarness.create({
            modelContextLimit: 100_000,
            magicContextConfig: {
                execute_threshold_percentage: 40,
                compaction_markers: true,
                historian: { model: "anthropic/claude-haiku-4-5" },
            },
        });
        try {
            h.mock.addMatcher((body) => {
                if (!isHistorianRequest(body)) return null;
                const range = findOrdinalRange(body) ?? { start: 1, end: 2 };
                return {
                    text: [
                        "<output>",
                        "<compartments>",
                        `<compartment start="${range.start}" end="${range.end}" title="pi deferred marker chunk">`,
                        "Pi historian publication used by the deferred marker parity e2e.",
                        "</compartment>",
                        "</compartments>",
                        "<facts></facts>",
                        `<unprocessed_from>${range.end + 1}</unprocessed_from>`,
                        "</output>",
                    ].join("\n"),
                    usage: { input_tokens: 500, output_tokens: 200, cache_creation_input_tokens: 500 },
                };
            });
            h.mock.setDefault({
                text: "fill",
                usage: { input_tokens: 1_000, output_tokens: 20, cache_creation_input_tokens: 1_000 },
            });

            let sessionId: string | null = null;
            for (let i = 1; i <= 10; i++) {
                const turn = await h.sendPrompt(`pi marker warmup turn ${i}: durable context for historian`, {
                    timeoutMs: 60_000,
                });
                sessionId = turn.sessionId;
            }
            expect(sessionId).toBeTruthy();

            h.mock.setDefault({
                text: "big",
                usage: { input_tokens: 90_000, output_tokens: 20, cache_creation_input_tokens: 90_000 },
            });
            await h.sendPrompt("pi marker trigger turn crosses execute threshold", { timeoutMs: 60_000 });

            h.mock.setDefault({
                text: "after-trigger",
                usage: { input_tokens: 500, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 500 },
            });
            await h.sendPrompt("pi marker post-trigger turn lets historian publish", { timeoutMs: 60_000 });

            const afterPublish = await h.waitFor(
                () => {
                    const row = readMarkerRow(h, sessionId!);
                    return row?.pending_compaction_marker_state ? row : null;
                },
                { timeoutMs: 30_000, label: "Pi pending_compaction_marker_state after publish" },
            );
            const pendingBlob = afterPublish.pending_compaction_marker_state;
            expect(pendingBlob).toBeTruthy();
            const parsed = JSON.parse(pendingBlob!);
            expect(typeof parsed.ordinal).toBe("number");
            expect(typeof parsed.endMessageId).toBe("string");
            expect(typeof parsed.publishedAt).toBe("number");
            expect(readCompactionEntries(h)).toHaveLength(0);

            await h.sendPrompt("pi marker low pressure defer pass must not consume pending", { timeoutMs: 60_000 });
            const afterDefer = readMarkerRow(h, sessionId!);
            expect(afterDefer?.pending_compaction_marker_state).toBe(pendingBlob);
            expect(readCompactionEntries(h)).toHaveLength(0);

            h.mock.setDefault({
                text: "prime-high-usage",
                usage: { input_tokens: 90_000, output_tokens: 20, cache_creation_input_tokens: 90_000 },
            });
            await h.sendPrompt("pi marker prime cache-busting pass", { timeoutMs: 60_000 });
            h.mock.setDefault({
                text: "apply-marker",
                usage: { input_tokens: 500, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 500 },
            });
            await h.sendPrompt("pi marker cache-busting pass applies native compaction", { timeoutMs: 60_000 });

            const afterApply = readMarkerRow(h, sessionId!);
            expect(afterApply?.pending_compaction_marker_state).toBeNull();
            expect(afterApply?.compaction_marker_state).toBeTruthy();
            const compactions = readCompactionEntries(h);
            expect(compactions.length).toBeGreaterThan(0);
            expect(compactions.at(-1)?.fromHook).toBe(true);
        } finally {
            await h.dispose();
        }
    }, 240_000);
});
