import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { isolation, spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";

// A host restart whose configuration changes the system prompt must pay for the
// change once. The first pass after the restart already sends new system bytes,
// so the provider rebuilds its cache there anyway; the HARD fold Magic Context
// runs for the changed prompt hash (which re-renders its cached history prefix,
// m[0]) has to ride that same pass. Detecting the change one pass
// later makes a second, separate cache rebuild.
//
// The prompt is changed by a Magic Context config change: `language` adds a
// reply-language line to the guidance Magic Context puts in the system prompt,
// and changes nothing else about the session.
//
// A ctx_reduce drop is queued before the restart. Queued drops apply only on a
// pass that already loses the provider cache, so the pass that applies it shows
// which pass the prompt change was detected on, and a late detection shows up as
// a second large cache write rather than only as a log line.

type Body = { model?: string; instructions?: unknown; input?: Array<{ role?: string }> };

// Large enough that the first message leaves the protected working set, so the
// drop queued for it is applied on the next cache-losing pass instead of held.
const FILLER = "alpha bravo charlie delta echo foxtrot golf hotel india juliet ".repeat(400);

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** Ordered provider-visible units of one request: the instructions, then each input item. */
function units(body: Body): string[] {
    return [
        ...(body.instructions === undefined ? [] : [JSON.stringify(body.instructions)]),
        ...(body.input ?? []).map((item) => JSON.stringify(item)),
    ];
}

/** Responses can carry instructions separately or as developer input items. */
function systemPrompt(body: Body): string {
    return JSON.stringify([body.instructions, ...(body.input ?? []).filter((item) => item.role === "developer")]);
}

/**
 * A prefix-cache model of the provider: a request reads from cache the longest
 * run of leading units it shares with any earlier request, and writes the rest.
 * The mock provider does not cache, so this is the measure of what a caching
 * provider would read and write for the same bytes.
 */
function cacheUse(previous: string[][], current: string[]) {
    let shared = 0;
    for (const earlier of previous) {
        let index = 0;
        while (index < earlier.length && index < current.length && earlier[index] === current[index]) index += 1;
        shared = Math.max(shared, index);
    }
    const bytes = (list: string[]) => list.reduce((total, unit) => total + Buffer.byteLength(unit), 0);
    return { readBytes: bytes(current.slice(0, shared)), writeBytes: bytes(current.slice(shared)), sharedUnits: shared };
}

test("a restart that changes the system prompt pays exactly one HARD fold, on the first pass after the restart", async () => {
    const fixture = isolation();
    const logPath = join(fixture.root, "magic-context.log");
    fixture.env.MAGIC_CONTEXT_LOG_PATH = logPath;
    const baseConfig = { historian: { disable: true }, dreamer: { disable: true }, memory: { enabled: false } };
    const options = { mockResponse: { text: "ok", usage: { input_tokens: 100, output_tokens: 20 } } };
    let host = await spawnOpencode2({ ...options, existingIsolation: fixture, magicContextConfig: baseConfig });
    const mock = host.mock;
    const log = () => (existsSync(logPath) ? readFileSync(logPath, "utf8") : "");
    const connect = () =>
        OpenCode.make({ baseUrl: host.url, headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` } });
    try {
        let client = connect();
        const session = await client.session.create({
            location: { directory: host.cwd },
            model: { providerID: "openai", id: "mock-model" },
        });
        await waitForPluginActive(client, host.cwd);
        const sessionLines = () => log().split("\n").filter((line) => line.includes(`[${session.id}]`));
        const passLines = () => sessionLines().filter((line) => line.includes("transform: injected m[0]/m[1]"));
        const passes: Array<{
            turn: string;
            decision: string;
            hardReasons: string[];
            hashChanged: boolean;
            systemPrompt: string;
            units: string[];
        }> = [];
        const turn = async (text: string) => {
            const before = mock.requests().length;
            const logged = sessionLines().length;
            const decided = passLines().length;
            await client.session.prompt({ sessionID: session.id, text });
            await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(60_000) });
            const bodies = mock
                .requests()
                .slice(before)
                .map((request) => request.body as Body)
                .filter((body) => body.model === "mock-model" && JSON.stringify(body).includes(text));
            expect(bodies.length).toBeGreaterThan(0);
            // The plugin log is flushed on a timer, so wait until every request of
            // this turn has its pass decision in the log.
            const deadline = Date.now() + 30_000;
            while (passLines().length < decided + bodies.length && Date.now() < deadline) await Bun.sleep(100);
            expect({ text, decisions: passLines().length - decided }).toEqual({ text, decisions: bodies.length });
            // One pass is the log lines up to and including its decision line.
            let segment: string[] = [];
            let index = 0;
            for (const line of sessionLines().slice(logged)) {
                segment.push(line);
                if (!line.includes("transform: injected m[0]/m[1]")) continue;
                passes.push({
                    turn: text,
                    decision: line.replace(/^.*transform: injected m\[0\]\/m\[1\] /, ""),
                    hardReasons: segment.flatMap((entry) => {
                        const match = entry.match(/m\[0\] HARD fold decision: reason=(\S+) executed=true/);
                        return match ? [match[1]!] : [];
                    }),
                    hashChanged: segment.some((entry) => entry.includes("system prompt hash changed")),
                    systemPrompt: systemPrompt(bodies[index]!),
                    units: units(bodies[index]!),
                });
                segment = [];
                index += 1;
            }
        };
        let dropIssued = false;
        mock.addMatcher((body) => {
            const wire = JSON.stringify(body);
            if (dropIssued || !wire.includes("BEFORE-RESTART-2") || !wire.includes('"name":"ctx_reduce"')) return null;
            dropIssued = true;
            return {
                openaiOutput: [
                    {
                        type: "function_call",
                        id: "fc_drop_fixture",
                        call_id: "call_drop_fixture",
                        name: "ctx_reduce",
                        arguments: JSON.stringify({ drop: "1" }),
                    },
                ],
                usage: { input_tokens: 100, output_tokens: 20 },
            };
        });

        await turn(`BEFORE-RESTART-1 ${FILLER}`);
        await turn(`BEFORE-RESTART-2 ${FILLER}`);
        expect(dropIssued).toBe(true);
        // Precondition: ctx_reduce queued the drop for a later cache-losing pass. Its tool
        // result is neither an error nor a "Held" answer (the reply for a message still
        // inside the protected recent window).
        const dropResult = JSON.stringify(
            (passes.at(-1)!.units.map((unit) => JSON.parse(unit)) as Array<{ type?: string; output?: unknown }>).find(
                (item) => item?.type === "function_call_output",
            ),
        );
        expect(dropResult).not.toContain("Error");
        expect(dropResult).not.toContain("Held");
        const firstMessageServed = (pass: { units: string[] }) =>
            pass.units.some((unit) => unit.includes("BEFORE-RESTART-1 alpha"));
        expect(firstMessageServed(passes.at(-1)!)).toBe(true);
        const beforeRestart = passes.length;
        await host.stopHost();
        host = await spawnOpencode2({
            ...options,
            existingIsolation: { root: host.root, env: host.env, cwd: host.cwd },
            existingMock: { mock, baseURL: host.mockBaseURL },
            magicContextConfig: { ...baseConfig, language: "tr" },
        });
        client = connect();
        await waitForPluginActive(client, host.cwd);
        await turn("AFTER-RESTART-1");
        await turn("AFTER-RESTART-2");
        await turn("AFTER-RESTART-3");

        const measured = passes.map((pass, index) => ({
            turn: pass.turn.slice(0, 20),
            decision: pass.decision,
            hardReasons: pass.hardReasons,
            hashChanged: pass.hashChanged,
            firstMessageServed: firstMessageServed(pass),
            ...cacheUse(
                passes.slice(0, index).map((earlier) => earlier.units),
                pass.units,
            ),
        }));
        // Printed so a run shows, pass by pass, the fold decision and how much of the
        // request a caching provider would read from cache and write anew.
        console.log(JSON.stringify(measured, null, 2));

        const after = measured.slice(beforeRestart);
        const afterPasses = passes.slice(beforeRestart);
        expect(after.length).toBe(3);
        // Precondition: the config change really changed the system prompt the provider saw.
        expect(passes[beforeRestart - 1]!.systemPrompt).not.toContain("Turkish");
        expect(afterPasses[0]!.systemPrompt).toContain("Turkish");
        // Exactly one HARD fold across the three passes after the restart, on the first of them,
        // and the queued drop rides it.
        expect(after.map((pass) => pass.hardReasons)).toEqual([["system_hash"], [], []]);
        expect(after.map((pass) => pass.hashChanged)).toEqual([true, false, false]);
        expect(after.map((pass) => pass.firstMessageServed)).toEqual([false, false, false]);
        expect(after[1]!.decision).toBe("(rematerialized=false, reason=cache_hit)");
        expect(after[2]!.decision).toBe("(rematerialized=false, reason=cache_hit)");
        // The passes after the rebuilt one read their whole prefix from cache: the
        // bytes the priced pass sent are, unit for unit, the start of the next request.
        for (const [priced, next] of [
            [afterPasses[0]!, afterPasses[1]!],
            [afterPasses[1]!, afterPasses[2]!],
        ] as const) {
            expect(sha(next.units.slice(0, priced.units.length).join("\n"))).toBe(sha(priced.units.join("\n")));
        }
        expect(after[1]!.sharedUnits).toBe(afterPasses[0]!.units.length);
        expect(after[2]!.sharedUnits).toBe(afterPasses[1]!.units.length);
    } catch (error) {
        console.error(host.stderr().slice(-3000), log().slice(-8000));
        throw error;
    } finally {
        await host.stop();
    }
}, 240_000);
