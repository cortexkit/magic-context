import { expect, test } from "bun:test";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { buildMockHistorianPayload } from "../../src/mock-historian";
import { MockProvider } from "../../src/mock-provider/server";
import {
    conversionFixture, SHARED_MOCK_MODEL_ID, SHARED_MOCK_PROVIDER_ID, spawnOpencode1,
} from "../../src/opencode2-runner/conversion-lane";
import { spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";
import { providerSystemText } from "../../src/provider-system-text";
import {
    assertStoreIsolation, clientFor, expectExactlyOnce, expectRestoredHistory, expectUnchangedPrefix, HISTORIAN_SYSTEM,
    IMPORTED_SUMMARY, probe, readRows, recomp, revert, type Session, state, summaries,
} from "./stale-floor-fixture";

const CONTEXT_LIMIT = 64_000;
const OUTPUT_LIMIT = 1_024;
const magicContextConfig = {
    execute_threshold_percentage: 40,
    history_budget_percentage: 0.15,
    memory: { enabled: false },
    dreamer: { disable: true },
};
const words = ["boundary", "historian", "compartment", "schedule", "pressure", "tokens", "window", "publish", "transform", "session", "marker", "budget", "eligible", "protected", "ordinal", "snapshot", "replay", "decision", "threshold"];

function ballast(tokens: number): string {
    const parts: string[] = [];
    for (let index = 0, size = 0; size < tokens * 4; index++) {
        const word = words[index % words.length]!;
        parts.push(index % 17 === 0 ? `${word}.` : word);
        size += word.length + 1;
    }
    return parts.join(" ");
}

function historianRange(body: Record<string, unknown>): { start: number; end: number } | undefined {
    const texts: string[] = [];
    function visit(value: unknown): void {
        if (typeof value === "string") texts.push(value);
        else if (value && typeof value === "object") for (const child of Object.values(value)) visit(child);
    }
    visit(body);
    for (const text of texts) {
        const match = text.match(/Messages (\d+)-(\d+):/);
        if (match) return { start: Number(match[1]), end: Number(match[2]) };
    }
    // OpenCode 1's ordinary historian prompt lists the ordinals directly.
    const ordinals = texts.filter(text => text.includes("<new_messages>"))
        .flatMap(text => [...text.matchAll(/\[(\d+)\]/g)].map(match => Number(match[1])));
    if (ordinals.length) return { start: Math.min(...ordinals), end: Math.max(...ordinals) };
}

async function withConvertedSession(label: string, turns: number, scenario: (s: Session, setPartial: (value: boolean) => void) => Promise<void>): Promise<void> {
    const fixture = conversionFixture(label);
    const mock = new MockProvider();
    const provider = await mock.start();
    let partial = false;
    let usage = 1_000;
    let reply = 0;
    mock.addMatcher((body) => {
        if (!providerSystemText(body).includes(HISTORIAN_SYSTEM))
            return { text: `ASSISTANT-WIRE-${String(++reply).padStart(5, "0")}#`, usage: { input_tokens: usage, output_tokens: 20 } };
        const range = historianRange(body);
        if (!range) return { text: "<output><compartments></compartments><facts></facts><unprocessed_from>1</unprocessed_from></output>", usage: { input_tokens: 500, output_tokens: 50 } };
        if (partial && range.start !== 1)
            return { text: "No summary could be built.", usage: { input_tokens: 100, output_tokens: 10 } };
        return {
            text: buildMockHistorianPayload({ ...range, title: `History ${range.start}-${range.end}`, body: `Turns ${range.start} to ${range.end} recorded durable history.` }),
            usage: { input_tokens: 500, output_tokens: 200 },
        };
    });
    try {
        const old = await spawnOpencode1({ fixture, mock, mockBaseURL: provider.baseURL, magicContextConfig, modelContextLimit: CONTEXT_LIMIT, modelOutputLimit: OUTPUT_LIMIT });
        let sessionId: string;
        try {
            const client = createOpencodeClient({ baseUrl: old.url });
            const created = await client.session.create({ query: { directory: fixture.cwd } });
            if (!created.data?.id) throw new Error(`OpenCode 1 session create failed: ${JSON.stringify(created.error)}`);
            sessionId = created.data.id;
            const prompt = async (text: string) => {
                const result = await client.session.prompt({ path: { id: sessionId }, body: { model: { providerID: SHARED_MOCK_PROVIDER_ID, modelID: SHARED_MOCK_MODEL_ID }, parts: [{ type: "text", text }] } });
                if (!result.data || result.data.info.error) throw new Error(`OpenCode 1 prompt failed: ${JSON.stringify(result.error ?? result.data?.info.error)}`);
            };
            for (let index = 1; index <= turns; index++) await prompt(`Turn ${index}: durable signal. ${ballast(3_000)}`);
            const marker = () => readRows<{ boundaryId: string }>(fixture.openCodeDbPath,
                `SELECT json_extract(data, '$.parentID') AS boundaryId FROM message
                WHERE session_id = ? AND json_extract(data, '$.summary') = 1
                AND json_extract(data, '$.providerID') = 'magic-context' ORDER BY time_created DESC LIMIT 1`, sessionId)[0];
            const ready = () => {
                const stored = summaries(fixture.contextDbPath, sessionId);
                return stored.length >= 2 && !!marker() && (stored.at(-1)?.endMessage ?? 0) >= 2 * turns - 4;
            };
            usage = 54_000;
            for (let round = 0; round < 30; round++) {
                await prompt(`Turn P${round}: pressure round. ${ballast(400)}`);
                const deadline = Date.now() + 4_000;
                while (Date.now() < deadline && !ready()) await Bun.sleep(200);
                if (ready()) break;
            }
            expect(ready()).toBe(true);
            usage = 1_000;
            for (let index = turns + 1; index <= turns + 3; index++) await prompt(`Turn ${index}: after the marker. ${ballast(600)}`);
        } finally {
            // The conversion harness checks open paths and private DB inode on stop.
            await old.stop();
        }
        const logPath = fixture.logPath("v2");
        fixture.env.MAGIC_CONTEXT_LOG_PATH = logPath;
        const host = await spawnOpencode2({ existingIsolation: fixture, existingMock: { mock, baseURL: provider.baseURL }, magicContextConfig, modelContextLimit: CONTEXT_LIMIT, modelOutputLimit: OUTPUT_LIMIT, compactionAuto: false });
        try {
            const client = clientFor(host);
            const s = { host, client, sessionId, logPath };
            await waitForPluginActive(client, fixture.cwd);
            assertStoreIsolation(host);
            expect(state(s).cut?.data.summary).toBe(IMPORTED_SUMMARY);
            const first = await probe(s, `${label}-before-first`);
            const next = await probe(s, `${label}-before-next`);
            expectExactlyOnce(first);
            expectExactlyOnce(next);
            expectUnchangedPrefix(first, next);
            await scenario(s, value => { partial = value; });
        } finally {
            try { assertStoreIsolation(host); } finally { await host.stopHost(); }
        }
    } finally {
        await mock.stop();
    }
}

async function shrink(s: Session, setPartial: (value: boolean) => void, label: string) {
    setPartial(true);
    await recomp(s, "Partial");
    setPartial(false);
    return [await probe(s, `${label}-partial-first`), await probe(s, `${label}-partial-next`)] as const;
}

test("a partial rebuild of converted history keeps rows below the imported checkpoint visible", async () => {
    await withConvertedSession("imported-partial", 30, async (s, setPartial) => {
        const [first, next] = await shrink(s, setPartial, "imported");
        const after = state(s);
        expect(after.seq.get(after.summaries.at(-1)!.endId)!).toBeLessThan(after.cut!.seq);
        expectRestoredHistory(first);
        expectRestoredHistory(next);
        expectUnchangedPrefix(first, next);
    });
}, 600_000);

async function rebuildAndRevert(s: Session, setPartial: (value: boolean) => void, label: string, keepsSummary: boolean): Promise<void> {
    await shrink(s, setPartial, label);
    await recomp(s, "Complete");
    expectExactlyOnce(await probe(s, `${label}-complete`));
    const before = state(s);
    const cut = before.cut!;
    const target = before.conversation.find(row => row.type === "user" && row.seq > cut.seq);
    expect(target).toBeDefined();
    await revert(s, target!.id);
    const after = state(s);
    expect(after.cut?.id).toBe(cut.id);
    const surviving = before.summaries.filter(summary => after.seq.has(summary.endId));
    expect(surviving.length < before.summaries.length).toBe(true);
    expect(surviving.length > 0).toBe(keepsSummary);
    if (keepsSummary) expect(after.seq.get(surviving.at(-1)!.endId)!).toBeLessThan(cut.seq);
    const first = await probe(s, `${label}-revert-first`);
    const next = await probe(s, `${label}-revert-next`);
    if (!keepsSummary) {
        expect(first.heads).toEqual([]);
        expect(next.heads).toEqual([]);
    }
    expectRestoredHistory(first);
    expectRestoredHistory(next);
    expect(state(s).summaries.map(summary => summary.endId)).toEqual(surviving.map(summary => summary.endId));
    expectUnchangedPrefix(first, next);
}

test("a revert after a completed rebuild restores rows between the surviving summary and imported checkpoint", async () => {
    await withConvertedSession("imported-reanchor", 30, (s, setPartial) => rebuildAndRevert(s, setPartial, "imported-reanchor", true));
}, 600_000);

test("a revert of all summary ends in converted history no longer serves the reverted summaries", async () => {
    await withConvertedSession("imported-retire-all", 10, (s, setPartial) => rebuildAndRevert(s, setPartial, "imported-retire-all", false));
}, 600_000);
