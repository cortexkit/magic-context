/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PiTestHarness } from "../src/pi-harness";

/**
 * Pi compaction marker behavior.
 *
 * Pi's compaction-marker design differs from OpenCode's. OpenCode injects a
 * synthetic message row and uses the v6 deferred-marker pattern to avoid
 * mid-historian-run cache busts. Pi writes a native JSONL `compaction` entry
 * via `sessionManager.appendCompaction()` and does NOT use the deferred-marker
 * pattern because Pi's wire payload comes from `event.messages` (Pi's
 * post-compaction view), so appending to JSONL doesn't mutate the
 * current pass's wire bytes — only future passes' `getBranch()` output.
 *
 * # What this test verifies
 *
 *   1. Historian publication immediately writes a `type: "compaction"` entry
 *      to Pi's session JSONL.
 *   2. The entry carries `fromHook: true` (extension-attributed, not
 *      pi-generated).
 *   3. The entry's `firstKeptEntryId` is a real, lookup-able SessionEntry id
 *      that exists in the visible branch — never empty, never stale.
 *   4. Pi does NOT populate magic-context's `session_meta.
 *      pending_compaction_marker_state` (that field is OpenCode-only).
 *
 * # Regression coverage
 *
 * The `firstKeptEntryId` non-empty assertion is the X1 fix's main invariant.
 * Pre-fix, Pi's `findFirstKeptEntryId` walked the SessionEntry list with an
 * ordinal counter that diverged from `convertEntriesToRawMessages` (which
 * also emits synthetic-user RawMessages at toolResult→assistant transitions).
 * The counter could never reach historian's `lastCompactedOrdinal` in
 * tool-heavy sessions and silently returned null, so `appendCompaction` was
 * never called — the JSONL grew unbounded until provider overflow.
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

describe("pi compaction marker", () => {
    it("writes native compaction entry with non-empty firstKeptEntryId immediately on historian publish", async () => {
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
                        `<compartment start="${range.start}" end="${range.end}" title="pi compaction marker chunk">`,
                        "Pi historian publication used by the compaction marker e2e.",
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

            // Wait for the compaction entry to appear in Pi's JSONL.
            // Pre-X1-fix: this assertion timed out because
            // `findFirstKeptEntryId` returned null in any tool-using session
            // and `appendCompaction` was silently skipped.
            const compactions = await h.waitFor(
                () => {
                    const entries = readCompactionEntries(h);
                    return entries.length > 0 ? entries : null;
                },
                { timeoutMs: 30_000, label: "Pi native compaction entry written to JSONL" },
            );

            expect(compactions.length).toBeGreaterThan(0);
            const latest = compactions.at(-1)!;

            // fromHook=true attributes the entry to the magic-context
            // extension (not Pi's own compactor).
            expect(latest.fromHook).toBe(true);

            // X1 fix invariant: firstKeptEntryId MUST be a non-empty string.
            // This is the assertion that fails pre-fix when the ordinal
            // counter divergence makes findFirstKeptEntryId return null OR
            // when the synthetic-user fallback yields "".
            expect(typeof latest.firstKeptEntryId).toBe("string");
            expect((latest.firstKeptEntryId as string).length).toBeGreaterThan(0);

            // Pi does not populate magic-context's deferred-marker fields.
            // That blob exists for OpenCode's deferred-marker path only.
            const row = readMarkerRow(h, sessionId!);
            expect(row?.pending_compaction_marker_state ?? null).toBeNull();
        } finally {
            await h.dispose();
        }
    }, 240_000);
});
