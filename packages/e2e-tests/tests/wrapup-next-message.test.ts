import { expect, test } from "bun:test";
import { dirname } from "node:path";
import { Database } from "../../plugin/src/shared/sqlite";
import { TestHarness } from "../src/harness";
import { inspectHostOpenFiles } from "../src/host-open-files";

// OpenCode adds Anthropic's cache breakpoints to whichever messages are last
// on the request. Compare Magic Context's content separately from that metadata.
const contentBytes = (messages: unknown[]) =>
    JSON.stringify(messages, (key, value) => key === "cache_control" ? undefined : value);

test("OpenCode 1 wrapup replaces covered raw history once on the next request", async () => {
    const summary = "WRAPUP_SUMMARY preserves older work.";
    const h = await TestHarness.create({
        modelContextLimit: 200_000,
        magicContextConfig: {
            cache_ttl: "never",
            execute_threshold_percentage: 65,
            memory: { enabled: false },
            dreamer: { disable: true },
            historian: { two_pass: false },
        },
        openCodeConfigExtra: { compaction: { auto: false } },
        mockDefault: { text: "ordinary turn", usage: { input_tokens: 100, output_tokens: 10 } },
    });
    try {
        const sessionId = await h.createSession();
        const inventory = inspectHostOpenFiles(h.opencode.pid, dirname(h.dataDir));
        expect(inventory.databases.length).toBeGreaterThan(0);
        console.log(`lsof -p ${inventory.pid}: ${JSON.stringify(inventory.databases)}`);
        h.mock.addMatcher((body) => {
            const range = JSON.stringify(body).match(/Messages (\d+)-(\d+):/);
            return range
                ? {
                      text: `<compartment start="${range[1]}" end="${range[2]}" title="Retained history"><p1>${summary}</p1></compartment>`,
                      usage: { input_tokens: 100, output_tokens: 40 },
                  }
                : null;
        });
        const turn = async (text: string) => {
            const offset = h.requests().length;
            await h.sendPrompt(sessionId, text);
            const matches = h.requests().slice(offset).filter(({ body }) =>
                JSON.stringify(body.messages)?.includes(text),
            );
            expect(matches).toHaveLength(1);
            return matches[0]!.body.messages!;
        };
        const command = async (command: string, args: string) => {
            const result = await fetch(`${h.serverUrl}/session/${sessionId}/command?directory=${encodeURIComponent(h.workdir)}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ command, arguments: args }),
            });
            expect(result.ok).toBe(true);
            await result.text();
        };
        const count = () => (h.contextDb().query("SELECT count(*) AS n FROM compartments WHERE session_id = ?").get(sessionId) as { n: number }).n;

        const seed = (index: number) => `WRAPUP_RAW_${index}: ${"durable history ".repeat(35)}`;
        for (let index = 0; index < 7; index++) await h.sendPrompt(sessionId, seed(index));
        const before = await turn(seed(7));
        expect(JSON.stringify(before)).toContain("WRAPUP_RAW_0:");
        expect(JSON.stringify(before)).not.toContain(summary);
        expect(count()).toBe(0);
        await command("ctx-wrapup", "6");
        const published = count();
        expect(published).toBeGreaterThan(0);

        const after = await turn("Ordinary request after wrapup");
        expect(JSON.stringify(after)).toContain(summary);
        for (let index = 0; index < 5; index++) {
            expect(JSON.stringify(after)).not.toContain(`WRAPUP_RAW_${index}:`);
        }
        for (let index = 5; index < 8; index++) {
            expect(JSON.stringify(after)).toContain(`WRAPUP_RAW_${index}:`);
        }
        // Anthropic merges adjacent user messages into content blocks.
        const baseline = (wire: unknown[]) =>
            JSON.stringify((wire[0] as { content: unknown[] }).content[0]);
        expect(baseline(before)).toContain("<session-history>");
        expect(baseline(after)).toBe(baseline(before));
        const defer = await turn("Ordinary defer after refresh");
        expect(contentBytes(defer.slice(0, after.length))).toBe(contentBytes(after));

        // A queued drop gives an accidental explicit refresh real work to do.
        const retained = contentBytes(defer).match(/\u00a7(\d+)\u00a7 ordinary turn/);
        if (!retained) throw new Error("Expected a tagged assistant reply in the kept tail");
        const tag = Number(retained[1]);
        const writer = new Database(h.contextDbPath(), { fileMustExist: true });
        try {
            writer.prepare(
                "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, ?, 'drop', ?, 'opencode')",
            ).run(sessionId, tag, Date.now());
        } finally {
            writer.close();
        }
        const pending = () => (h.contextDb().query(
            "SELECT count(*) AS n FROM pending_ops WHERE session_id = ? AND tag_id = ? AND harness = 'opencode'",
        ).get(sessionId, tag) as { n: number }).n;
        await command("ctx-wrapup", "100");
        expect(count()).toBe(published);
        const afterEmpty = await turn("Ordinary request after empty wrapup");
        expect(pending()).toBe(1);
        expect(contentBytes(afterEmpty.slice(0, defer.length))).toBe(contentBytes(defer));

        await command("ctx-flush", "");
        const afterFlush = await turn("Ordinary request after explicit flush");
        expect(pending()).toBe(0);
        expect(contentBytes(afterFlush)).not.toContain(retained[0]);
    } finally {
        await h.dispose();
    }
}, 120_000);
