import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { queuePendingOp } from "../../../plugin/src/features/magic-context/storage-ops";
import { Database } from "../../../plugin/src/shared/sqlite";
import { CHECKPOINT_NOTE } from "../../../plugin/src/v2/fold/summary";
import {
    CLI,
    inspectOpenFiles,
    isolation,
    readPluginLog,
    spawnOpencode2,
    waitForPluginActive,
} from "../../src/opencode2-runner/spawn";

// OpenCode can call the compaction hook while no checkpoint row is running.
// From 2.3.1 it prepares a compaction in the background after a reply that
// reports high usage (on by default). Its automatic checkpoints, on every
// tested version, ask the hook before any row exists too, and so do 2.0.22 and
// 2.1.0 for a model in provider compaction mode. Nothing is cut when the hook
// runs, and the stored history head must stay what the session last sent: the
// two head messages (m[0] and m[1]) replay byte for byte on every later pass
// that has no rebuild of its own, and a queued drop waits for a rebuild that
// pays for a rewrite (a later real fold, or the force band under pressure).
// Before the fix the hook stored a newly rendered head (the summary served in
// m[1] moved into m[0]) and the next pass sent it, rewriting the provider's
// cached prefix while it logged a cache hit.
//
// Two plugins registered before and after Magic Context hold the hook call
// until this test has read the stored session row, so the comparison brackets
// exactly that call.

const hostVersion = spawnSync(CLI, ["--version"], { env: isolation().env, encoding: "utf8" })
    .stdout.trim()
    .replace(/^opencode\s+v?/, "");
const [major = 0, minor = 0, patch = 0] = hostVersion.split(".").map(Number);
const backgroundHost = major > 2 || (major === 2 && (minor > 3 || (minor === 3 && patch >= 1)));

type Snapshot = {
    label: string;
    row: Record<string, string> | null;
    checkpoints: number;
    requests: number;
    summary: string;
};

function barrierPlugin(root: string, label: "before" | "after", observer: string) {
    const dir = join(root, `rowless-barrier-${label}`);
    mkdirSync(dir);
    writeFileSync(
        join(dir, "server.js"),
        `export default { id: "rowless-barrier-${label}", async setup(context) {
    await context.session.hook("compaction", async (draft) => {
        const url = new URL(${JSON.stringify(observer)});
        url.searchParams.set("label", ${JSON.stringify(label)});
        url.searchParams.set("session", draft.sessionID);
        url.searchParams.set("summary", draft.result?.summary ?? "");
        await (await fetch(url)).text();
    });
}};
`,
    );
    return dir;
}

/**
 * background: 2.3.1+ with every host compaction setting at its default; a
 * reply at 45% of the window makes the host prepare a compaction while nothing
 * is due. provider: 2.0.22/2.1.0 with the model in provider compaction mode.
 * auto: the runner's ordinary automatic compaction. In those two a reply just
 * past the host's compaction threshold makes it ask the hook, store a completed
 * automatic checkpoint and send the next turn under pressure.
 */
type Arm = "background" | "provider" | "auto";

async function scenario(arm: Arm) {
    const fixture = isolation();
    const contextPath = join(fixture.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db");
    const sourcePath = join(fixture.env.XDG_DATA_HOME!, "opencode", fixture.env.OPENCODE_DB!);
    let sessionID = "";
    let requests = () => 0;
    const snapshots: Snapshot[] = [];
    const storedRow = () => {
        const db = new Database(contextPath, { readonly: true });
        try {
            const columns = (
                db.prepare("PRAGMA table_info(session_meta)").all() as Array<{ name: string }>
            ).map((column) => column.name);
            return db
                .prepare(
                    `SELECT ${columns.map((name) => `quote("${name}") AS "${name}"`).join(", ")} FROM session_meta WHERE session_id = ?`,
                )
                .get(sessionID) as Record<string, string> | null;
        } finally {
            db.close();
        }
    };
    const checkpointRows = () => {
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
    const observer = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
            const url = new URL(request.url);
            if (sessionID && url.searchParams.get("session") === sessionID)
                snapshots.push({
                    label: url.searchParams.get("label") ?? "",
                    row: storedRow(),
                    checkpoints: checkpointRows(),
                    requests: requests(),
                    summary: url.searchParams.get("summary") ?? "",
                });
            return new Response("ok");
        },
    });
    const observerURL = `http://127.0.0.1:${observer.port}/snapshot`;
    const options = {
        existingIsolation: fixture,
        prePlugin: barrierPlugin(fixture.root, "before", observerURL),
        probePlugin: barrierPlugin(fixture.root, "after", observerURL),
        modelOutputLimit: 1024,
        // The historian's /ctx-wrapup publishes nothing on a 16k window, so every
        // arm uses a 100k window and scales the pressure to it.
        modelContextLimit: 100_000,
        ...(arm === "background" ? { compactionConfig: {} } : {}),
        ...(arm === "provider" ? { modelCompaction: { mode: "provider" } } : {}),
        magicContextConfig: {
            cache_ttl: "never",
            execute_threshold_percentage: 65,
            protected_tokens: 200,
            temporal_awareness: false,
            historian: { two_pass: false },
            dreamer: { disable: true },
            memory: { enabled: false },
        },
    };
    let host = await spawnOpencode2(options);
    const mock = host.mock;
    requests = () => mock.requests().length;
    const reply = (inputTokens: number) =>
        mock.setDefault({
            text: "DETERMINISTIC_ANSWER",
            usage: { input_tokens: inputTokens, output_tokens: 10 },
        });
    reply(100);
    mock.addMatcher((body: unknown) => {
        const range = JSON.stringify(body).match(/Messages (\d+)-(\d+):/);
        if (!range) return null;
        return {
            text: `<compartment start="${range[1]}" end="${range[2]}" title="Retained history"><p1>HIST_SUMMARY preserves the earlier work.</p1></compartment>`,
            usage: { input_tokens: 100, output_tokens: 40 },
        };
    });
    const connect = () =>
        OpenCode.make({
            baseUrl: host.url,
            headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
        });
    let client = connect();
    const historian = (body: unknown) => /Messages (\d+)-(\d+):/.test(JSON.stringify(body));
    const served: Array<{ turn: string; input: string[] }> = [];
    // Set to a path prefix to keep each request, the session's log lines and
    // their digests for comparing two builds.
    const dump = process.env.MC_E2E_ROWLESS_DUMP && `${process.env.MC_E2E_ROWLESS_DUMP}-${arm}`;
    try {
        await waitForPluginActive(client, fixture.cwd);
        const session = await client.session.create({
            location: { directory: fixture.cwd },
            model: { providerID: "openai", id: "mock-model" },
        });
        sessionID = session.id;
        const turn = async (text: string) => {
            const start = mock.requests().length;
            await client.session.prompt({ sessionID, text });
            await client.session.wait({ sessionID }, { signal: AbortSignal.timeout(60000) });
            const request = mock
                .requests()
                .slice(start)
                .filter((candidate) => !historian(candidate.body))
                .at(-1);
            expect(request).toBeDefined();
            const input = (request!.body.input as unknown[]).map((item) =>
                JSON.stringify(item)
                    .replace(/msg_resp_[0-9a-f]+_/g, "msg_resp_")
                    .replaceAll(fixture.root, "<root>"),
            );
            served.push({ turn: text.slice(0, 12), input });
            return input;
        };
        // OpenCode 2.3+ sends its own developer header as the first input item:
        // Magic Context's two history head messages are the first two user items.
        const heads = (input: string[]) =>
            input.filter((item) => JSON.parse(item).role === "user").slice(0, 2);
        const context = () => new Database(contextPath);
        const pending = () => {
            const db = context();
            try {
                return (
                    db
                        .prepare("SELECT COUNT(*) AS n FROM pending_ops WHERE session_id=?")
                        .get(sessionID) as { n: number }
                ).n;
            } finally {
                db.close();
            }
        };

        for (let i = 0; i < 10; i++) await turn(`RAW_${i}: ${"durable history ".repeat(50)}`);
        // Publish history and serve it through m[1], the incremental summary
        // message, without folding it into m[0].
        await client.session.command({ sessionID, name: "ctx-wrapup", text: "2" });
        const deadline = Date.now() + 60000;
        for (;;) {
            const db = context();
            try {
                const { n } = db
                    .prepare("SELECT COUNT(*) AS n FROM compartments WHERE session_id=?")
                    .get(sessionID) as { n: number };
                const { state } = db
                    .prepare(
                        "SELECT wrapup_in_progress_state AS state FROM session_meta WHERE session_id=?",
                    )
                    .get(sessionID) as { state: string | null };
                if (n > 0 && !state) break;
            } finally {
                db.close();
            }
            if (Date.now() > deadline)
                throw new Error(
                    `the historian published no history:\n${readPluginLog(fixture.env)
                        .split("\n")
                        .slice(-15)
                        .map((line) => line.slice(0, 400))
                        .join("\n")}\nhost:\n${host
                        .stderr()
                        .split("\n")
                        .filter((line) => /error|command|wrapup/i.test(line))
                        .slice(-10)
                        .map((line) => line.slice(0, 400))
                        .join("\n")}`,
                );
            await Bun.sleep(100);
        }
        await client.session.command({ sessionID, name: "ctx-flush", text: "" });
        await turn("FLUSHED: continue");
        for (let i = 0; i < 4; i++) await turn(`MID_${i}: ${"newer work ".repeat(200)}`);

        // Queue a drop that only a rebuild may apply.
        const source = new Database(sourcePath, { readonly: true });
        const mid0 = (
            source
                .prepare(
                    "SELECT id FROM session_message WHERE session_id=? AND type='user' AND json_extract(data,'$.text') LIKE 'MID_0:%'",
                )
                .get(sessionID) as { id: string }
        ).id;
        source.close();
        {
            const db = context();
            try {
                const { tag } = db
                    .prepare("SELECT tag_number AS tag FROM tags WHERE session_id=? AND message_id=?")
                    .get(sessionID, `${mid0}:p0`) as { tag: number };
                queuePendingOp(db, sessionID, tag, "drop");
            } finally {
                db.close();
            }
        }
        const held = await turn("HELD: continue");
        expect(held.join("\n")).toContain("MID_0:");
        expect(pending()).toBe(1);
        // Precondition: the published summary is served in m[1], not in m[0].
        expect(heads(held)).toHaveLength(2);
        expect(heads(held)[0]).not.toContain("HIST_SUMMARY");
        expect(heads(held)[1]).toContain("HIST_SUMMARY");

        // The reply to this request reports high usage. It still carries the
        // served heads.
        reply(arm === "background" ? 45_000 : 99_500);
        const high = await turn("HIGH: continue");
        reply(100);
        expect(heads(high)).toEqual(heads(held));
        // Older hosts ask only when the next turn is admitted.
        if (!backgroundHost) expect(snapshots).toEqual([]);

        // Each line of the plugin log for this session after a given point.
        const sessionLog = () =>
            readPluginLog(fixture.env)
                .split("\n")
                .filter((line) => line.includes(`[${sessionID}]`));

        // Every message after the history the summary covers (rows 1-18, the
        // first nine turns) is in a request exactly once; none it covers is.
        const sent: string[] = ["RAW_9:", "FLUSHED:", "MID_1:", "MID_2:", "MID_3:", "HELD:", "HIGH:"];
        const expectEachOnce = (input: string[]) => {
            const text = input.join("\n");
            for (const marker of sent)
                expect([marker, text.split(marker).length - 1]).toEqual([marker, 1]);
            for (const marker of ["RAW_0:", "RAW_8:"])
                expect([marker, text.split(marker).length - 1]).toEqual([marker, 0]);
        };
        const snapshotPair = () => {
            console.log(
                `${arm} hook snapshots: ${JSON.stringify(snapshots.map(({ row: _row, ...rest }) => rest))} legacyAnswer=${sessionLog().some((line) => line.includes("v2 compaction hook: fired"))}`,
            );
            expect(snapshots.map((entry) => entry.label)).toEqual(["before", "after"]);
            const [before, after] = snapshots as [Snapshot, Snapshot];
            // No checkpoint row before the hook ran, and no provider request
            // between the two snapshots. From 2.3.1 an automatic checkpoint
            // records its start while the hooks run, so the row can appear
            // between the two snapshots and Magic Context may then answer it as
            // a running checkpoint (the hold before it makes that likely);
            // either way the stored row must not change. Older hosts record the
            // row only after the hooks return.
            expect(before.checkpoints).toBe(0);
            expect([0, ...(arm === "auto" && backgroundHost ? [1] : [])]).toContain(
                after.checkpoints,
            );
            expect(after.requests).toBe(before.requests);
            expect(after.summary).toBe(CHECKPOINT_NOTE);
            // The stored session row is byte-identical across the call.
            expect(after.row).toEqual(before.row);
            const paths = inspectOpenFiles(host.pid!, fixture.root, fixture.env);
            console.log(
                `open database paths after the hook: ${JSON.stringify(paths.filter((path) => /\.db(-wal|-shm)?$/.test(path)).map((path) => path.replace(fixture.root, "<root>")))}`,
            );
        };

        let last: string[];
        if (arm === "background") {
            // The host prepares a compaction in the background after that reply.
            const waitUntil = Date.now() + 30000;
            while (!snapshots.some((entry) => entry.label === "after")) {
                if (Date.now() > waitUntil) throw new Error("no background compaction request");
                await Bun.sleep(50);
            }
            snapshotPair();
            const logged = sessionLog().length;
            const low1 = await turn("LOW_1: continue");
            const low2 = await turn("LOW_2: continue");
            expect(checkpointRows()).toBe(0);
            // Both head messages are byte-identical before and after the call,
            // and each request keeps the previous one as its prefix.
            expect(heads(low1)).toEqual(heads(high));
            expect(heads(low2)).toEqual(heads(high));
            expect(low1.slice(0, high.length)).toEqual(high);
            expect(low2.slice(0, low1.length)).toEqual(low1);
            const lowLog = sessionLog().slice(logged).join("\n");
            expect(lowLog).toContain("rewrite permission: allowed=false");
            expect(lowLog).not.toMatch(/HARD fold decision: .*executed=true/);
            // The drop stays queued for a real rebuild.
            expect(low2.join("\n")).toContain("MID_0:");
            expect(pending()).toBe(1);
            sent.push("LOW_1:", "LOW_2:");
            expectEachOnce(low2);
            last = low2;
        } else {
            // The host asks for the checkpoint before any row exists (2.3.1+ may
            // already have asked after the high reply), stores it, and sends the
            // next turn under pressure.
            const logged = sessionLog().length;
            const pressure = await turn("PRESSURE: continue");
            snapshotPair();
            // The host stored an automatic checkpoint holding Magic Context's note.
            const db = new Database(sourcePath, { readonly: true });
            const stored = db
                .prepare(
                    "SELECT data FROM session_message WHERE session_id=? AND type='compaction' ORDER BY seq",
                )
                .all(sessionID) as Array<{ data: string }>;
            db.close();
            expect(
                stored.map((row) => {
                    const data = JSON.parse(row.data) as { status?: string; summary?: string };
                    return [data.status, data.summary];
                }),
            ).toEqual([["completed", CHECKPOINT_NOTE]]);
            // Pressure pays for a rewrite of the conversation (the force band), not
            // of the history head: both head messages stay as served, the summary
            // stays in m[1], and the queued drop lands on that request.
            const pressureLog = sessionLog().slice(logged).join("\n");
            expect(pressureLog).not.toMatch(/HARD fold decision: .*executed=true/);
            expect(pressureLog).toContain("rewrite permission: allowed=true ride=force");
            expect(heads(pressure)).toEqual(heads(high));
            expect(heads(pressure)[1]).toContain("HIST_SUMMARY");
            expect(pressure.join("\n")).not.toContain("MID_0:");
            expect(pending()).toBe(0);
            sent.push("PRESSURE:");
            expectEachOnce(pressure);
            const next = await turn("NEXT: continue");
            expect(next.slice(0, pressure.length)).toEqual(pressure);
            sent.push("NEXT:");
            last = next;
        }

        // A restart alone changes nothing: the next request keeps the last one
        // as its prefix.
        await host.stopHost();
        host = await spawnOpencode2({ ...options, existingMock: { mock, baseURL: host.mockBaseURL } });
        client = connect();
        await waitForPluginActive(client, fixture.cwd);
        const restarted = await turn("RESTARTED: continue");
        expect(restarted.slice(0, last.length)).toEqual(last);
        sent.push("RESTARTED:");

        // A real rebuild: a restart that changes the system prompt folds the
        // summary from m[1] into m[0] exactly once, and any drop still queued
        // lands on it.
        await host.stopHost();
        host = await spawnOpencode2({
            ...options,
            existingMock: { mock, baseURL: host.mockBaseURL },
            magicContextConfig: { ...options.magicContextConfig, language: "tr" },
        });
        client = connect();
        await waitForPluginActive(client, fixture.cwd);
        const rebuilt = await turn("REBUILT: continue");
        expect(heads(rebuilt)[0]).not.toBe(heads(high)[0]);
        expect(heads(rebuilt)[0]!.split("HIST_SUMMARY").length - 1).toBe(1);
        expect(heads(rebuilt)[1]).not.toContain("HIST_SUMMARY");
        expect(rebuilt.join("\n")).not.toContain("MID_0:");
        expect(pending()).toBe(0);
        sent.push("REBUILT:");
        expectEachOnce(rebuilt);
        const after = await turn("AFTER: continue");
        expect(after.slice(0, rebuilt.length)).toEqual(rebuilt);
    } finally {
        if (dump) {
            writeFileSync(
                `${dump}.log`,
                readPluginLog(fixture.env)
                    .split("\n")
                    .filter((line) => sessionID && line.includes(`[${sessionID}]`))
                    .join("\n"),
            );
            writeFileSync(`${dump}.inputs.json`, JSON.stringify(served));
            writeFileSync(
                dump,
                JSON.stringify(
                    served.map(({ turn, input }) => ({
                        turn,
                        sha: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
                        heads: input
                            .filter((item) => JSON.parse(item).role === "user")
                            .slice(0, 2)
                            .map((item) => createHash("sha256").update(item).digest("hex")),
                    })),
                    null,
                    2,
                ),
            );
        }
        observer.stop(true);
        await host.stop();
    }
}

(backgroundHost ? test : test.skip)(
    `a background compaction request with no running checkpoint row keeps the served history head (OpenCode ${hostVersion})`,
    () => scenario("background"),
    300000,
);

(backgroundHost ? test.skip : test)(
    `a provider-mode compaction request with no running checkpoint row keeps the served history head (OpenCode ${hostVersion})`,
    () => scenario("provider"),
    300000,
);

test(`an automatic checkpoint keeps the served history head (OpenCode ${hostVersion})`, () =>
    scenario("auto"), 300000);
