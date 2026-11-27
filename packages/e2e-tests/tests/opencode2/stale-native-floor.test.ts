import { expect, test } from "bun:test";
import { join } from "node:path";
import { estimateTokens } from "../../../plugin/src/hooks/magic-context/read-session-formatting";
import { isolation, spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";
import {
    assertStoreIsolation, clientFor, expectExactlyOnce, expectUnchangedPrefix, probe,
    recomp, requestTokens, revert, type Session, state, turn, waitFor,
} from "./stale-floor-fixture";

const WINDOW = 60_000;
const TURN_TEXT = "durable history ".repeat(2500);
const HISTORIAN_MODEL = { id: "historian-model", contextLimit: 200_000 };

async function compact(s: Session): Promise<void> {
    const previous = state(s).checkpoints.length;
    await s.client.session.compact({ sessionID: s.sessionId });
    await s.client.session.wait({ sessionID: s.sessionId }, { signal: AbortSignal.timeout(60_000) });
    await waitFor(() => state(s), current => current.checkpoints.length > previous && !!current.cut, "host checkpoint");
}

async function withSession(label: string, testScenario: (s: Session, controls: {
    setPartial(value: boolean): void;
    enforceWindow(): void;
}) => Promise<void>, earlyCut = false): Promise<void> {
    const fixture = isolation();
    const logPath = join(fixture.root, `${label}.log`);
    fixture.env.MAGIC_CONTEXT_LOG_PATH = logPath;
    const host = await spawnOpencode2({
        existingIsolation: fixture,
        magicContextPlugin: process.env.MC_RELEASE_PLUGIN,
        modelContextLimit: WINDOW,
        modelOutputLimit: 1_024,
        compactionAuto: false,
        magicContextConfig: { memory: { enabled: false }, dreamer: { disable: true }, historian: { two_pass: false } },
        historianModel: HISTORIAN_MODEL,
    });
    try {
        let partial = false;
        let enforce = false;
        let ordinary = 0;
        host.mock.addMatcher((body) => {
            if (body.model === HISTORIAN_MODEL.id) {
                const range = JSON.stringify(body).match(/Messages (\d+)-(\d+):/);
                if (!range || (partial && range[1] !== "1"))
                    return { text: "No summary could be built.", usage: { input_tokens: 100, output_tokens: 10 } };
                return {
                    text: `<compartment start="${range[1]}" end="${range[2]}" title="History ${range[1]}-${range[2]}"><p1>Turns ${range[1]} to ${range[2]} recorded durable history.</p1></compartment>`,
                    usage: { input_tokens: 100, output_tokens: 40 },
                };
            }
            // Build the fixture with controlled usage, then enforce the actual
            // wire size when testing the production pressure path.
            const size = enforce ? requestTokens(body) : 100;
            if (enforce && size > WINDOW)
                return { error: { status: 400, type: "invalid_request_error", message: `prompt is too long: ${size} tokens > ${WINDOW} maximum` } };
            return { text: `ASSISTANT-WIRE-${String(++ordinary).padStart(5, "0")}#`, usage: { input_tokens: size, output_tokens: 10 } };
        });
        const client = clientFor(host);
        const session = await client.session.create({ title: label, location: { directory: host.cwd }, model: { providerID: "openai", id: "mock-model" } });
        await waitForPluginActive(client, host.cwd);
        const s = { host, client, sessionId: session.id, logPath };
        assertStoreIsolation(host);
        for (let index = 0; index < 24; index++) {
            await turn(s, `Turn ${index}: ${TURN_TEXT}`);
            if (index === 0 && earlyCut) await compact(s);
            if (index === 11 || index === 23) {
                const count = state(s).summaries.length;
                await client.session.command({ sessionID: session.id, name: "ctx-wrapup", text: "2" });
                await waitFor(() => state(s).summaries.length, size => size > count, "wrapup publication");
            }
        }
        await client.session.command({ sessionID: session.id, name: "ctx-flush", text: "" });
        await turn(s, "Turn 24: settle the baseline");
        await compact(s);
        await turn(s, "Turn 25: after the host compaction");
        // Let any background publisher settle before the explicit rebuild.
        let count = -1;
        for (;;) {
            const next = state(s).summaries.length;
            if (next === count) break;
            count = next;
            await Bun.sleep(1_500);
        }
        await client.session.command({ sessionID: session.id, name: "ctx-flush", text: "" });
        await turn(s, "Turn 26: settle the baseline after the compaction");
        await testScenario(s, {
            setPartial(value) { partial = value; },
            enforceWindow() { enforce = true; },
        });
    } finally {
        try { assertStoreIsolation(host); } finally { await host.stop(); }
    }
}

test("a partial rebuild after manual compact keeps the unreached rows visible", async () => {
    await withSession("native-partial", async (s, controls) => {
        const before = state(s);
        controls.setPartial(true);
        await recomp(s, "Partial");
        const after = state(s);
        expect(after.cut?.id).toBe(before.cut?.id);
        expect(after.summaries.at(-1)!.endMessage).toBeLessThan(before.summaries.at(-1)!.endMessage);
        const first = await probe(s, "native-partial-first");
        const next = await probe(s, "native-partial-next");
        expectExactlyOnce(first);
        expectExactlyOnce(next);
        expectUnchangedPrefix(first, next);
    });
}, 600_000);

test("a committed revert after the early checkpoint restores the surviving rows when no summary end survives", async () => {
    await withSession("native-revert", async (s) => {
        const before = state(s);
        expect(before.checkpoints).toHaveLength(2);
        const early = before.checkpoints[0]!;
        const firstEnd = before.seq.get(before.summaries[0]!.endId)!;
        const target = before.conversation.find(row => row.type === "user" && row.seq > early.seq && row.seq <= firstEnd);
        expect(target).toBeDefined();
        await revert(s, target!.id);
        const after = state(s);
        expect(after.cut?.id).toBe(early.id);
        expect(before.summaries.every(summary => !after.seq.has(summary.endId))).toBe(true);
        const first = await probe(s, "native-revert-first");
        const next = await probe(s, "native-revert-next");
        expectExactlyOnce(first);
        expectExactlyOnce(next);
        expect(first.heads).toEqual([]);
        expect(next.heads).toEqual([]);
        expect(state(s).summaries).toEqual([]);
        expectUnchangedPrefix(first, next);
    }, true);
}, 600_000);

test("pressure after a partial rebuild leaves an unreached range larger than the window", async () => {
    await withSession("native-pressure", async (s, controls) => {
        const before = state(s);
        controls.setPartial(true);
        await recomp(s, "Partial");
        const after = state(s);
        const first = after.seq.get(after.summaries.at(-1)!.endId)!;
        const last = before.seq.get(before.summaries.at(-1)!.endId)!;
        const unreached = after.conversation.filter(row => row.seq > first && row.seq <= last && row.type === "user");
        // Only count the known ballast, not system, tools, replies or tags.
        const gapTokens = estimateTokens(TURN_TEXT) * unreached.length;
        console.log(`over-window gap: ${unreached.length} long user rows, at least ${gapTokens} estimated tokens (window ${WINDOW})`);
        expect(gapTokens).toBeGreaterThan(WINDOW);
        controls.setPartial(false);
        controls.enforceWindow();
        for (let index = 0; index < 8; index++) {
            const result = await probe(s, `native-pressure-${index}`);
            const newest = state(s).summaries.at(-1)?.endMessage;
            console.log(`over-window turn ${index}: sent=${result.sent}, newest summary end=${newest}`);
        }
    });
}, 600_000);
