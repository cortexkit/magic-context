import { expect, test } from "bun:test";
import { openTestDb } from "../src/test-db";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TestHarness } from "../src/harness";
import { buildMockHistorianPayload, findHistorianOrdinalRange } from "../src/mock-historian";
import { readSessionChunk, withRawMessageProvider } from "../../plugin/src/hooks/magic-context/read-session-chunk";
import { estimateTokens } from "../../plugin/src/hooks/magic-context/read-session-formatting";

test("real OpenCode historian sees communication answers; expand stays cheap unless verbose", async () => {
    const h = await TestHarness.create({
        magicContextConfig: { execute_threshold_percentage: 40 },
        openCodeConfigExtra: { plugin: [
            pathToFileURL(resolve(import.meta.dir, "../../plugin/dist/index.js")).href,
            pathToFileURL(resolve(import.meta.dir, "../src/fixtures/historian-communication-tools.ts")).href,
        ] },
    });
    try {
        const root = dirname(h.opencode.env.configDir);
        const artifactDir = process.env.MC_EXPANSION_ARTIFACTS ?? join(root, "proof");
        mkdirSync(artifactDir, { recursive: true });
        const files = spawnSync("lsof", ["-p", String(h.opencode.pid), "-Fn"], { encoding: "utf8" });
        expect(files.status).toBe(0);
        const dbPaths = files.stdout.split("\n").filter((line) => /^n.*\.db(?:$|-)/.test(line)).map((line) => line.slice(1));
        expect(dbPaths.length).toBeGreaterThan(0);
        expect(dbPaths.every((path) => path.startsWith(`${root}/`))).toBe(true);
        writeFileSync(join(artifactDir, "host-lsof.txt"), files.stdout);
        const version = await fetch(`${h.serverUrl}/global/health`).then((r) => r.json()) as { version?: string };
        // The OpenCode 1 lane installs the latest 1.x release, so pin the major
        // version this test covers rather than one patch release.
        expect(version.version).toMatch(/^1\./);

        h.mock.addMatcher((body) => {
            if (!JSON.stringify(body.system).includes("the hippocampus of a long-running coding agent")) return null;
            const range = findHistorianOrdinalRange(body);
            return { text: range ? buildMockHistorianPayload({ start: range.start, end: range.end, title: "Communication", body: "The peer reviewed the parser and the operator chose strict mode." }) : "<output><compartments></compartments><facts></facts></output>", usage: { input_tokens: 500, output_tokens: 200 } };
        });
        let sentCommunication = false;
        h.mock.addMatcher((body) => {
            if (sentCommunication || !JSON.stringify(body.system).includes("You are opencode,")) return null;
            sentCommunication = true;
            return { content: [
                { type: "text", text: "Coordinating the parser review." },
                { type: "tool_use", id: "pm_proof", name: "peer_send", input: { agent: "Ada", message: "Check parser boundaries." } },
                { type: "tool_use", id: "ask_proof", name: "ask", input: { question: "Which mode?", options: ["Strict", "Fast"] } },
            ], stop_reason: "tool_use", usage: { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0 } };
        });
        h.mock.setDefault({ text: "Acknowledged.", usage: { input_tokens: 1000, output_tokens: 20, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0 } });
        const session = await h.createSession();
        for (let i = 1; i <= 10; i++) await h.sendPrompt(session, `Review turn ${i}. ${h.ballast(3000)}`);
        h.mock.setDefault({ text: "Ready to summarize.", usage: { input_tokens: 90_000, output_tokens: 20, cache_creation_input_tokens: 90_000, cache_read_input_tokens: 0 } });
        await h.sendPrompt(session, "Trigger historian.");
        h.mock.setDefault({ text: "Continue.", usage: { input_tokens: 500, output_tokens: 20 } });
        await h.sendPrompt(session, "Fold settled history.");
        await h.waitFor(() => h.mock.requests().some((r) => JSON.stringify(r.body.system).includes("the hippocampus of a long-running coding agent")), { timeoutMs: 30_000, label: "historian communication prompt" });
        const request = h.mock.requests().find((r) => JSON.stringify(r.body.system).includes("the hippocampus of a long-running coding agent"))!;
        const prompt = JSON.stringify(request.body.messages);
        expect(prompt).toContain("TC: PM to Ada: Check parser boundaries.");
        expect(prompt).toContain("→ Strict: preserve call boundaries.");
        writeFileSync(join(artifactDir, "historian-request.json"), JSON.stringify(request.body, null, 2));

        // Read only this host's throwaway store. The same raw history drives both
        // renders, so their difference measures the actual input budget cost.
        const db = openTestDb(join(h.dataDir, "opencode", "opencode.db"), { readonly: true });
        const rows = db.query("SELECT id, data FROM message WHERE session_id = ? ORDER BY id").all(session) as Array<{ id: string; data: string }>;
        const messages = rows.map((row, index) => ({ ordinal: index + 1, id: row.id, role: JSON.parse(row.data).role as string,
            parts: (db.query("SELECT data FROM part WHERE message_id = ? ORDER BY id").all(row.id) as Array<{ data: string }>).map((p) => JSON.parse(p.data)) }));
        const rangeEnd = Math.min(20, messages.length);
        withRawMessageProvider(session, { readMessages: () => messages, getMessageCount: () => messages.length }, () => {
            const before = readSessionChunk(session, 100_000, 1, rangeEnd + 1, { expand: false });
            const after = readSessionChunk(session, 100_000, 1, rangeEnd + 1);
            expect(before.text).not.toContain("Check parser boundaries.");
            expect(after.text).toContain("Check parser boundaries.");
            writeFileSync(join(artifactDir, "chunks.json"), JSON.stringify({ before: before.text, after: after.text, beforeTokens: estimateTokens(before.text), afterTokens: estimateTokens(after.text) }, null, 2));
        });
        // Exercise the host-registered ctx_expand tool, not a parallel formatter.
        const call = async (verbose: boolean) => {
            // A short range avoids OpenCode's independent output-byte truncator,
            // which would otherwise hide the end of this intentionally bulky history.
            h.mock.script([{ content: [{ type: "tool_use", id: `expand_${verbose}`, name: "ctx_expand", input: { start: 1, end: Math.min(rangeEnd, 3), verbose } }], stop_reason: "tool_use", usage: { input_tokens: 500, output_tokens: 40 } }, { text: "Recovered.", usage: { input_tokens: 500, output_tokens: 20 } }]);
            await h.sendPrompt(session, `Recover history ${verbose ? "verbosely" : "cheaply"}.`);
            const result = db.query("SELECT data FROM part WHERE session_id = ? ORDER BY id DESC").all(session) as Array<{ data: string }>;
            return result.map((p) => JSON.parse(p.data)).find((p) => p.type === "tool" && p.callID === `expand_${verbose}`)?.state.output as string;
        };
        const cheap = await call(false);
        const verbose = await call(true);
        expect(cheap).not.toContain("Check parser boundaries.");
        const cheapRange = /Messages (\d+)-(\d+) \(/.exec(cheap)!;
        expect(cheapRange).not.toBeNull();
        withRawMessageProvider(session, { readMessages: () => messages, getMessageCount: () => messages.length }, () => {
            const legacy = readSessionChunk(session, 15_000, Number(cheapRange[1]), Number(cheapRange[2]) + 1, { expand: false });
            expect(cheap.split("\n\n")[1]).toBe(legacy.text);
        });
        expect(verbose).toContain("PM to Ada: Check parser boundaries.");
        expect(verbose).toContain("Strict: preserve call boundaries.");
        writeFileSync(join(artifactDir, "ctx-expand-default.txt"), cheap);
        writeFileSync(join(artifactDir, "ctx-expand-verbose.txt"), verbose);
        db.close();
        console.log(`OpenCode ${version.version} pid=${h.opencode.pid}; isolated DBs=${dbPaths.join(", ")}; proof=${artifactDir}`);
    } catch (error) {
        const artifactDir = process.env.MC_EXPANSION_ARTIFACTS;
        if (artifactDir) {
            mkdirSync(artifactDir, { recursive: true });
            writeFileSync(join(artifactDir, "failed-host-stdout.txt"), h.opencode.stdout());
            writeFileSync(join(artifactDir, "failed-host-stderr.txt"), h.opencode.stderr());
            writeFileSync(join(artifactDir, "failed-requests.json"), JSON.stringify(h.mock.requests(), null, 2));
            if (h.hasContextDb()) writeFileSync(join(artifactDir, "failed-meta.json"), JSON.stringify(h.contextDb().query("SELECT * FROM session_meta").all(), null, 2));
        }
        throw error;
    } finally { await h.dispose(); }
}, 120_000);
