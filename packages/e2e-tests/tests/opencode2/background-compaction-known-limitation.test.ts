import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { OpenCode } from "@opencode/client";
import { Database } from "../../../plugin/src/shared/sqlite";
import { gaDatabasePath, V2StoreReader } from "../../../plugin/src/v2/store-reader";
import { buildMockHistorianPayload, findHistorianOrdinalRange } from "../../src/mock-historian";
import { pinnedOpenCode2Version } from "../../src/opencode2-runner/cli-resolution";
import {
    inspectOpenFiles,
    isolation,
    spawnOpencode2,
    waitForPluginActive,
} from "../../src/opencode2-runner/spawn";
import { cleanupE2ETempDir } from "../../src/temp-dir";

// OpenCode 2.3.1 added background compaction: after a reply with high usage
// the host calls the plugin's compaction hook early, while no checkpoint row
// exists, and keeps the answer. A later /compact is completed from that answer
// without calling the hook again, so the hook's manual branch (which folds the
// newly published history into the head Magic Context serves) never runs.
//
// The early call is held by a probe plugin that reports it to this test over
// loopback and waits for the reply, so the order "early call, then historian
// publication, then /compact" is fixed by events, not by timing.

const PROBE = resolve(import.meta.dir, "background-compaction-probe");
const version = process.env.MC_E2E_OPENCODE2_VERSION ?? pinnedOpenCode2Version();
const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
/** Hosts that prepare a compaction in the background by default. */
const backgroundHost = major > 2 || (major === 2 && (minor > 3 || (minor === 3 && patch >= 1)));
const HISTORIAN_MARKER = "the hippocampus of a long-running coding agent";

type Body = Record<string, unknown>;
const isHistorian = (body: Body) => JSON.stringify(body.system ?? "").includes(HISTORIAN_MARKER);
/** The provider messages without Anthropic's moving cache breakpoints. */
const withoutCacheControl = (value: unknown): unknown =>
    Array.isArray(value)
        ? value.map(withoutCacheControl)
        : value && typeof value === "object"
          ? Object.fromEntries(
                Object.entries(value as Record<string, unknown>)
                    .filter(([key]) => key !== "cache_control")
                    .map(([key, item]) => [key, withoutCacheControl(item)]),
            )
          : value;

/** Filler text of about `tokens` tokens, the same words the scenario harness uses. */
function ballast(tokens: number): string {
    const words = [
        "boundary",
        "historian",
        "compartment",
        "schedule",
        "pressure",
        "tokens",
        "window",
        "publish",
        "transform",
        "session",
        "marker",
        "budget",
        "eligible",
        "protected",
        "ordinal",
        "snapshot",
        "replay",
        "decision",
        "threshold",
        "baseline",
        "measure",
        "archive",
        "deliver",
    ] as const;
    const parts: string[] = [];
    let length = 0;
    for (let index = 0; length < tokens * 4; index++) {
        const word = words[index % words.length] ?? words[0];
        parts.push(`${word}${index % 17 === 0 ? "." : ""}`);
        length += word.length + 1;
    }
    return parts.join(" ");
}

/** A loopback server that answers each probe report, holding it while `holding` is set. */
function barrier() {
    const calls: Array<{ messages: number; answered: boolean }> = [];
    let holding = false;
    let release: (() => void) | undefined;
    let arrived: ((count: number) => void) | undefined;
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
            calls.push(JSON.parse(await request.text()));
            arrived?.(calls.length);
            if (holding) await new Promise<void>((resolveHold) => (release = resolveHold));
            return new Response("ok");
        },
    });
    return {
        url: `http://127.0.0.1:${server.port}/`,
        calls,
        hold() {
            holding = true;
        },
        /** Resolves when the probe reports call number `count`. */
        reached(count: number, timeoutMs = 60_000) {
            if (calls.length >= count) return Promise.resolve();
            return new Promise<void>((resolveReached, reject) => {
                const timer = setTimeout(
                    () => reject(new Error(`compaction hook call ${count} never arrived`)),
                    timeoutMs,
                );
                arrived = (seen) => {
                    if (seen < count) return;
                    clearTimeout(timer);
                    resolveReached();
                };
            });
        },
        release() {
            holding = false;
            release?.();
            release = undefined;
        },
        stop: () => server.stop(true),
    };
}

(backgroundHost ? test : test.skip)(
    "known limitation: a background-prepared /compact preserves history but does not shrink the next request",
    async () => {
        const fixture = isolation();
        const { MAGIC_CONTEXT_STORAGE_DIR: contextDir, XDG_DATA_HOME: dataDir } = fixture.env;
        assert(contextDir && dataDir, "runner must supply private database directories");
        const gate = barrier();
        fixture.env.MC_E2E_COMPACTION_BARRIER_URL = gate.url;
        const host = await spawnOpencode2({
            existingIsolation: fixture,
            providerID: "anthropic",
            modelOutputLimit: 8192,
            probePlugin: PROBE,
            magicContextConfig: { execute_threshold_percentage: 40 },
            compactionConfig: {
                auto: true,
                background: true,
                buffer: 1024,
                keep: { tokens: 1024 },
            },
        }).catch((error) => {
            gate.stop();
            cleanupE2ETempDir(fixture.root);
            throw error;
        });
        const mock = host.mock;
        const client = OpenCode.make({
            baseUrl: host.url,
            headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
        });
        const contextDb = () =>
            new Database(join(contextDir, "context.db"), {
                readonly: true,
            });
        const sourcePath = gaDatabasePath(dataDir, "latest", fixture.env);
        const compartments = (sessionID: string) => {
            const db = contextDb();
            try {
                return (
                    db
                        .prepare("SELECT COUNT(*) AS n FROM compartments WHERE session_id = ?")
                        .get(sessionID) as {
                        n: number;
                    }
                ).n;
            } finally {
                db.close();
            }
        };
        const checkpoints = (sessionID: string) => {
            const db = new Database(sourcePath, { readonly: true });
            try {
                return (
                    db
                        .prepare(
                            "SELECT COUNT(*) AS n FROM session_message WHERE session_id = ? AND type = 'compaction'",
                        )
                        .get(sessionID) as { n: number }
                ).n;
            } finally {
                db.close();
            }
        };
        const historian = (body: Body) => {
            if (!isHistorian(body)) return null;
            const range = findHistorianOrdinalRange(body);
            return {
                text: range
                    ? buildMockHistorianPayload({
                          start: range.start,
                          end: range.end,
                          title: "e2e background compaction chunk",
                          body: "Initial turns driven by the e2e harness before a background-prepared compaction.",
                      })
                    : "<output><compartments></compartments><facts></facts><unprocessed_from>1</unprocessed_from></output>",
                usage: {
                    input_tokens: 500,
                    output_tokens: 200,
                    cache_creation_input_tokens: 500,
                    cache_read_input_tokens: 0,
                },
            };
        };
        const small = {
            text: "after-trigger",
            usage: {
                input_tokens: 500,
                output_tokens: 10,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 500,
            },
        };
        try {
            mock.reset();
            mock.addMatcher(historian);
            mock.setDefault({
                text: "fill",
                usage: {
                    input_tokens: 1_000,
                    output_tokens: 20,
                    cache_creation_input_tokens: 1_000,
                    cache_read_input_tokens: 0,
                },
            });
            await waitForPluginActive(client, fixture.cwd);
            const session = await client.session.create({
                location: { directory: fixture.cwd },
                model: { providerID: "anthropic", id: "mock-model" },
            });
            const send = async (text: string) => {
                await client.session.prompt({ sessionID: session.id, text });
                await client.session.wait(
                    { sessionID: session.id },
                    { signal: AbortSignal.timeout(180_000) },
                );
            };
            /** The provider messages of the primary request that carried `text`. */
            const turn = async (text: string) => {
                const start = mock.requests().length;
                await send(text);
                const request = mock
                    .requests()
                    .slice(start)
                    .filter((candidate) => !isHistorian(candidate.body as Body))
                    .filter((candidate) => JSON.stringify(candidate.body).includes(text))
                    .at(-1);
                if (!request) throw new Error(`no primary request carried ${text}`);
                return JSON.stringify((request.body as Body).messages);
            };
            for (let i = 1; i <= 10; i++)
                await turn(
                    `turn ${i}: meaningful prompt carrying durable signal for chunk ${i}. ${ballast(3_000)}`,
                );
            mock.setDefault({
                text: "big",
                usage: {
                    input_tokens: 90_000,
                    output_tokens: 20,
                    cache_creation_input_tokens: 90_000,
                    cache_read_input_tokens: 0,
                },
            });
            gate.hold();
            const pressure = turn("turn 11: trigger turn with real content.");
            // Magic Context has answered the background call before there is a
            // checkpoint row or any published history.
            await gate.reached(1);
            expect(gate.calls[0]?.answered).toBe(true);
            expect(checkpoints(session.id)).toBe(0);
            expect(compartments(session.id)).toBe(0);
            gate.release();
            await pressure;
            mock.setDefault(small);
            const before = await turn("turn 12: post-trigger follow-up.");
            const deadline = Date.now() + 60_000;
            while (compartments(session.id) === 0) {
                if (Date.now() > deadline)
                    throw new Error("the historian published no compartment");
                await Bun.sleep(100);
            }
            expect(gate.calls).toHaveLength(1);
            const reader = new V2StoreReader(sourcePath);
            const source = new Database(sourcePath, { readonly: true });
            const rawHistory = source.prepare(
                "SELECT id, type, data FROM session_message WHERE session_id = ? AND type IN ('user', 'assistant') ORDER BY seq",
            );
            const providerCalls = mock.requests().length;
            try {
                const priorHistory = rawHistory.all(session.id);
                expect(priorHistory.length).toBeGreaterThanOrEqual(24);
                await client.session.compact({ sessionID: session.id });
                await client.session.wait(
                    { sessionID: session.id },
                    { signal: AbortSignal.timeout(60_000) },
                );
                // No new compaction hook or provider call: the host used its prepared answer.
                expect(gate.calls).toHaveLength(1);
                expect(mock.requests().length).toBe(providerCalls);
                expect(reader.latestCompaction(session.id)?.data).toMatchObject({
                    reason: "manual",
                    status: "completed",
                });
                expect(rawHistory.all(session.id)).toEqual(priorHistory);
            } finally {
                source.close();
                reader.close();
            }
            const after = await turn("turn 13: first request after the compaction.");
            const priorMessages = withoutCacheControl(JSON.parse(before)) as unknown[];
            const nextMessages = withoutCacheControl(JSON.parse(after)) as unknown[];
            expect(Buffer.byteLength(after)).toBeGreaterThanOrEqual(Buffer.byteLength(before));
            expect(nextMessages.slice(0, priorMessages.length)).toEqual(priorMessages);
            for (let i = 1; i <= 10; i++) {
                const marker = `durable signal for chunk ${i}.`;
                expect(after.split(marker)).toHaveLength(2);
            }
            assert(host.pid, "runner must supply a PID for the lsof guard");
            const databases = inspectOpenFiles(host.pid, fixture.root, fixture.env).filter((path) =>
                /\.db(?:-wal|-shm)?$/.test(path),
            );
            console.log(
                `OpenCode ${version}: ${Buffer.byteLength(before)} -> ${Buffer.byteLength(after)} provider message bytes; lsof databases: ${[...new Set(databases)].sort().join(", ")}`,
            );
        } finally {
            gate.release();
            try {
                await host.stop();
            } finally {
                gate.stop();
                cleanupE2ETempDir(fixture.root);
            }
        }
    },
    600_000,
);
