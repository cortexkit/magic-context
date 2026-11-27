/// <reference types="bun-types" />

import { afterAll, beforeAll, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { estimateTokens } from "../../plugin/src/hooks/magic-context/read-session-formatting";
import { TestHarness } from "../src/harness";

// Issue 608 on OpenCode 1. A 1.x `/fork` is an unlinked copy: the host gives
// the copy new message ids and records no link to the session it came from
// (`session.parent_id` is subagent parentage, not fork linkage), so Magic
// Context cannot seed the fork from its parent. What it must still do is never
// send the fork's raw history when that is over the model's window: the
// first pass of a session with no Magic Context state is counted, and an
// over-window one is reduced (historian, emergency drops) or refused, never
// sent as is.

const WINDOW = 60_000;
const TURN_TEXT = "durable history ".repeat(2500);
const HISTORIAN_MARKER = "the hippocampus of a long-running coding agent";

function isHistorian(body: Record<string, unknown>): boolean {
    return JSON.stringify(body.system ?? "").includes(HISTORIAN_MARKER);
}

function requestTokens(body: Record<string, unknown>): number {
    return estimateTokens(
        JSON.stringify({ messages: body.messages, system: body.system, tools: body.tools }),
    );
}

let h: TestHarness;
const oversized: number[] = [];
let enforced = false;

beforeAll(async () => {
    h = await TestHarness.create({
        modelContextLimit: WINDOW,
        magicContextConfig: {
            // Auto-search waits on an embedding model this throwaway root
            // does not have; it is unrelated to what this test checks.
            memory: { enabled: false, auto_search: { enabled: false } },
            embedding: { provider: "off" },
            dreamer: { disable: true },
            historian: { two_pass: false },
        },
    });
    // Registered first so it sees every request, the way a provider does.
    h.mock.addMatcher((body) => {
        if (isHistorian(body)) return null;
        const tokens = requestTokens(body);
        if (tokens <= WINDOW) return null;
        oversized.push(tokens);
        if (!enforced) return null;
        return {
            error: {
                status: 400,
                type: "invalid_request_error",
                message: `prompt is too long: ${tokens} tokens > ${WINDOW} maximum`,
            },
        };
    });
    h.mock.addMatcher((body) => {
        if (!isHistorian(body)) return null;
        const range = JSON.stringify(body).match(/Messages (\d+)-(\d+):/);
        if (!range) return null;
        return {
            text: `<compartment start="${range[1]}" end="${range[2]}" title="History ${range[1]}-${range[2]}"><p1>Turns ${range[1]} to ${range[2]} recorded durable history.</p1></compartment>`,
            usage: { input_tokens: 100, output_tokens: 40 },
        };
    });
}, 120_000);

afterAll(async () => {
    await h?.dispose();
});

function pluginLog(): string {
    const path = join(h.dataDir, "cortexkit", "magic-context-e2e.log");
    return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function forbiddenOpenFiles(): string[] {
    const result = Bun.spawnSync(["lsof", "-Fn", "-p", String(h.opencode.pid)]);
    const home = process.env.HOME ?? "";
    const forbidden = [
        join(home, ".local/share/opencode"),
        join(home, ".local/share/cortexkit/magic-context"),
        join(home, ".config/opencode"),
        join(home, ".config/cortexkit"),
    ];
    return new TextDecoder()
        .decode(result.stdout)
        .split("\n")
        .filter((line) => line.startsWith("n/"))
        .map((line) => line.slice(1))
        .filter((path) => forbidden.some((root) => path.startsWith(root)));
}

async function prompt(sessionId: string, text: string): Promise<void> {
    await h.client.session.prompt({
        path: { id: sessionId },
        body: {
            model: { providerID: "mock-anthropic", modelID: "mock-sonnet" },
            parts: [{ type: "text", text }],
        },
    });
}

function servedFor(marker: string, from: number): number[] {
    return h.mock
        .requests()
        .slice(from)
        .filter((request) => !isHistorian(request.body) && JSON.stringify(request.body).includes(marker))
        .map((request) => requestTokens(request.body));
}

it(
    "an OpenCode 1 fork over the window is reduced or refused, never sent as is, and inherits nothing",
    async () => {
        const parent = await h.createSession();
        for (let index = 0; index < 24; index++) await prompt(parent, `Turn ${index}: ${TURN_TEXT}`);

        const response = await fetch(
            `${h.opencode.url}/session/${encodeURIComponent(parent)}/fork?directory=${encodeURIComponent(h.workdir)}`,
            { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
        );
        expect(response.ok).toBe(true);
        const fork = ((await response.json()) as { id: string }).id;
        expect(fork).not.toBe(parent);
        expect(forbiddenOpenFiles()).toEqual([]);
        // The parent need not send an oversized request for its copied raw history
        // to be oversized. Inspect the clone before Magic Context can reduce it.
        const client = createOpencodeClient({ baseUrl: h.opencode.url });
        const forkHistory = await client.session.messages({
            path: { id: fork }, query: { directory: h.workdir }, throwOnError: true,
        });
        const rawText = forkHistory.data!
            .flatMap(({ parts }) => parts.filter((part) => part.type === "text").map((part) => part.text))
            .join("\n");
        expect(estimateTokens(rawText)).toBeGreaterThan(WINDOW);

        enforced = true;
        oversized.length = 0;
        const attempts: Array<{ attempt: number; served: number[] }> = [];
        for (let attempt = 0; attempt < 10; attempt++) {
            const start = h.mock.requests().length;
            const marker = `fork attempt ${attempt}`;
            await prompt(fork, marker).catch(() => undefined);
            await Bun.sleep(500);
            const served = servedFor(marker, start);
            attempts.push({ attempt, served });
            if (served.length > 0) break;
        }
        const log = pluginLog();
        const lines = log
            .split("\n")
            .filter(
                (line) =>
                    line.includes(fork) &&
                    /over-window first pass|fork inheritance|lkg_|historian did not complete/.test(line),
            )
            .map((line) => line.slice(0, 400))
            .slice(0, 12);
        console.log(
            `[fork-over-window-oc1] ${JSON.stringify({ attempts, oversized, lines })}`,
        );
        expect(oversized).toEqual([]);
        expect(log).toContain(`[${fork}] transform: over-window first pass`);
        // No linkage on this host, so nothing is seeded.
        expect(log).not.toContain(`[${fork}] v2 fork inheritance`);
        // The historian advances on each attempt until its per-session drain
        // budget is spent; the session is then refused until the budget
        // resets. Whatever was served fits; nothing else reached the provider.
        expect(log).toContain(`[${fork}] over-window first pass not sent`);
        for (const entry of attempts)
            for (const size of entry.served) expect(size).toBeLessThan(WINDOW);
        expect(forbiddenOpenFiles()).toEqual([]);
    },
    1_200_000,
);
