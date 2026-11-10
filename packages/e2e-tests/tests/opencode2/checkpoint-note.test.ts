import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OpenCode } from "@opencode/client";
import { Database } from "../../../plugin/src/shared/sqlite";
import { CHECKPOINT_NOTE } from "../../../plugin/src/v2/fold/summary";
import { MockProvider } from "../../src/mock-provider/server";
import {
    inspectOpenFiles,
    isolation,
    spawnOpencode2,
    waitForPluginActive,
} from "../../src/opencode2-runner/spawn";

// One session, served three ways from the same stored snapshot: without a host
// checkpoint, with an automatic idle checkpoint, and with a manual /compact.
// Every checkpoint Magic Context answers stores the fixed note, and the provider
// receives the same bytes on every turn of every branch, including the first
// turn after a host restart.
const TURNS = [
    "establish the managed baseline",
    "warm continuation before the checkpoint",
    "first continuation after the checkpoint",
    "first continuation after a host restart",
];
const TTL_MS = 5000;
type Branch = "control" | "automatic" | "manual";

test("OpenCode 2 checkpoints store the note while every request stays byte-identical across the fold and a restart", async () => {
    const fixture = isolation();
    // Project docs give the history head real content, which automatic folding requires.
    writeFileSync(
        join(fixture.cwd, "ARCHITECTURE.md"),
        "# Architecture\n\nA small service that answers deterministic replies.\n",
    );
    const mock = new MockProvider();
    const provider = await mock.start();
    mock.setDefault({ text: "deterministic reply", usage: { input_tokens: 100, output_tokens: 10 } });
    const options = {
        existingIsolation: fixture,
        existingMock: { mock, baseURL: provider.baseURL },
        compactionAuto: false,
        modelContextLimit: 200000,
        modelOutputLimit: 1024,
        magicContextConfig: {
            cache_ttl: `${TTL_MS / 1000}s`,
            temporal_awareness: false,
            historian: { disable: true },
            dreamer: { disable: true },
            memory: { enabled: false },
        },
    };
    const dbPath = join(fixture.env.XDG_DATA_HOME!, "opencode", fixture.env.OPENCODE_DB!);
    const snapshot = mkdtempSync(join(dirname(fixture.root), "mc-opencode2-note-snapshot-"));
    let host: Awaited<ReturnType<typeof spawnOpencode2>> | undefined;
    const clientFor = () =>
        OpenCode.make({
            baseUrl: host!.url,
            headers: { authorization: `Basic ${btoa(`opencode:${host!.password}`)}` },
        });
    const boot = async () => {
        host = await spawnOpencode2(options);
        const client = clientFor();
        await waitForPluginActive(client, fixture.cwd);
        const paths = inspectOpenFiles(host.pid!, fixture.root, host.env).filter((path) =>
            /\.db(?:-wal|-shm)?$/.test(path),
        );
        expect(paths.length).toBeGreaterThan(0);
        expect(paths.every((path) => path.startsWith(`${fixture.root}/`))).toBe(true);
        return client;
    };
    const checkpoints = (sessionID: string) => {
        const db = new Database(dbPath, { readonly: true });
        try {
            return (
                db
                    .prepare(
                        "SELECT data FROM session_message WHERE session_id=? AND type='compaction' ORDER BY seq",
                    )
                    .all(sessionID) as Array<{ data: string }>
            ).map((row) => JSON.parse(row.data) as { status?: string; summary?: string; reason?: string });
        } finally {
            db.close();
        }
    };
    const evidence: Record<string, unknown> = {};
    try {
        let client = await boot();
        const sessionID = (
            await client.session.create({
                title: "checkpoint note",
                location: { directory: fixture.cwd },
                model: { providerID: "openai", id: "mock-model" },
            })
        ).id;
        await host!.stopHost();
        cpSync(fixture.root, snapshot, { recursive: true });
        const wire: Record<Branch, string[]> = { control: [], automatic: [], manual: [] };
        for (const branch of ["control", "automatic", "manual"] as const) {
            rmSync(fixture.root, { recursive: true, force: true });
            cpSync(snapshot, fixture.root, { recursive: true });
            // Only the automatic branch lets the idle policy nominate a checkpoint.
            fixture.env.MC_OC2_HOST_FOLD_ROWS = branch === "automatic" ? "1" : "0";
            mock.script(
                TURNS.map((_, n) => ({
                    openaiOutput: [
                        {
                            type: "message",
                            id: `msg_checkpoint_note_turn_${n}`,
                            role: "assistant",
                            content: [
                                {
                                    type: "output_text",
                                    text: "deterministic reply",
                                    annotations: [],
                                    logprobs: [],
                                },
                            ],
                        },
                    ],
                    usage: { input_tokens: 100, output_tokens: 10 },
                })),
            );
            client = await boot();
            for (const [index, text] of TURNS.entries()) {
                if (index === 2) {
                    // Every branch idles past the cache lifetime, so all three
                    // serve the next turn from the same clock state.
                    const idleUntil = Date.now() + TTL_MS + 1500;
                    if (branch === "manual") {
                        await client.session.compact({ sessionID });
                        await client.session.wait(
                            { sessionID },
                            { signal: AbortSignal.timeout(60000) },
                        );
                    }
                    while (Date.now() < idleUntil) await Bun.sleep(100);
                    if (branch === "automatic") {
                        const deadline = Date.now() + 30000;
                        while (
                            !checkpoints(sessionID).some((row) => row.status === "completed") &&
                            Date.now() < deadline
                        )
                            await Bun.sleep(100);
                    }
                }
                if (index === 3) {
                    await host!.stopHost();
                    client = await boot();
                }
                const offset = mock.requests().length;
                await client.session.prompt({ sessionID, text });
                await client.session.wait({ sessionID }, { signal: AbortSignal.timeout(60000) });
                const requests = mock.requests().slice(offset);
                expect(requests.length).toBe(1);
                wire[branch].push(requests[0]!.rawBody!);
            }
            const stored = checkpoints(sessionID);
            evidence[branch] = {
                checkpoints: stored.map((row) => ({
                    status: row.status,
                    reason: row.reason,
                    summary: row.summary,
                })),
                requests: wire[branch].map((body) => ({
                    bytes: Buffer.byteLength(body),
                    sha256: createHash("sha256").update(body).digest("hex"),
                })),
            };
            if (branch === "control") expect(stored).toEqual([]);
            else {
                const completed = stored.filter((row) => row.status === "completed");
                expect(completed).toHaveLength(1);
                expect(completed[0]!.summary).toBe(CHECKPOINT_NOTE);
                if (branch === "manual") expect(completed[0]!.reason).toBe("manual");
            }
            for (const body of wire[branch]) expect(body).not.toContain(CHECKPOINT_NOTE);
            await host!.stopHost();
        }
        console.log(
            `CHECKPOINT_NOTE_EVIDENCE ${JSON.stringify({ version: process.env.MC_E2E_OPENCODE2_VERSION, root: fixture.root, evidence })}`,
        );
        for (const branch of ["automatic", "manual"] as const)
            for (const [index, body] of wire[branch].entries())
                expect(body, `${branch} turn ${index}`).toBe(wire.control[index]!);
    } finally {
        await host?.stopHost();
        await mock.stop();
        rmSync(snapshot, { recursive: true, force: true });
        rmSync(fixture.root, { recursive: true, force: true });
    }
}, 300000);
