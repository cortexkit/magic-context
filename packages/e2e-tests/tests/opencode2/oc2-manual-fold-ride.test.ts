import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { queuePendingOp } from "../../../plugin/src/features/magic-context/storage-ops";
import { Database } from "../../../plugin/src/shared/sqlite";
import { CLI, isolation, spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";

// A manual /compact on a session with published history. The compaction hook
// answers with Magic Context's history and commits a new history head (the two
// synthetic messages, m[0] and m[1], that start every request), so the next
// request starts with different bytes and the provider's cached prefix is lost
// on that pass whatever else happens. Measured on real 2.0.22, 2.1.0, 2.2.5 and
// 2.2.6 hosts, that pass logs `rewrite permission: allowed=false ride=none`,
// so work queued for the next rebuild (here a drop such as the agent's
// ctx_reduce tool queues) waits for a second, avoidable rebuild instead of
// landing with this one.

const hostVersion = spawnSync(CLI, ["--version"], { encoding: "utf8" }).stdout.trim().replace(/^opencode\s+v?/, "");
const [major = 0, minor = 0, patch = 0] = hostVersion.split(".").map(Number);
// `experimental.part_rows` moves assistant content into `session_part` from 2.2.6.
const partRowsHost = major > 2 || (major === 2 && (minor > 2 || (minor === 2 && patch >= 6)));

async function manualFoldSession(partRows: boolean) {
    const fixture = isolation();
    fixture.env.MC_OC2_HOST_FOLD_ROWS = "999999";
    const options = {
        existingIsolation: fixture, compactionAuto: false, modelContextLimit: 100000, modelOutputLimit: 1024,
        ...(partRows ? { extraConfig: { experimental: { part_rows: true } } } : {}),
        magicContextConfig: { cache_ttl: "never", protected_tokens: 200, historian: { two_pass: false }, dreamer: { disable: true }, memory: { enabled: false } },
    };
    let host = await spawnOpencode2(options);
    const answer = () => {
        host.mock.setDefault({ text: "DETERMINISTIC_ANSWER", usage: { input_tokens: 100, output_tokens: 10 } });
        host.mock.addMatcher((body: unknown) => {
            const range = JSON.stringify(body).match(/Messages (\d+)-(\d+):/);
            if (!range) return null;
            return { text: `<compartment start="${range[1]}" end="${range[2]}" title="Retained history"><p1>HIST_SUMMARY preserves the earlier work.</p1></compartment>`, usage: { input_tokens: 100, output_tokens: 40 } };
        });
    };
    answer();
    const clientFor = () => OpenCode.make({ baseUrl: host.url, headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` } });
    let client = clientFor();
    const context = () => new Database(join(fixture.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db"));
    const source = () => new Database(join(fixture.env.XDG_DATA_HOME!, "opencode", fixture.env.OPENCODE_DB!), { readonly: true });
    await waitForPluginActive(client, fixture.cwd);
    const session = await client.session.create({ location: { directory: fixture.cwd }, model: { providerID: "openai", id: "mock-model" } });
    const historian = (body: unknown) => /Messages (\d+)-(\d+):/.test(JSON.stringify(body));
    const turn = async (text: string) => {
        const start = host.mock.requests().length;
        await client.session.prompt({ sessionID: session.id, text });
        await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(60000) });
        const request = host.mock.requests().slice(start).filter((candidate) => !historian(candidate.body)).at(-1);
        expect(request).toBeDefined();
        return (request!.body.input as unknown[]).map((item) => JSON.stringify(item).replace(/msg_resp_[0-9a-f]+_/g, "msg_resp_"));
    };
    for (let i = 0; i < 10; i++) await turn(`RAW_${i}: ${"durable history ".repeat(50)}`);
    // With part rows the historian reads no assistant content and publishes
    // nothing, so that session keeps raw history only.
    if (!partRows) {
        await client.session.command({ sessionID: session.id, name: "ctx-wrapup", text: "2" });
        const deadline = Date.now() + 60000;
        for (;;) {
            const db = context();
            try {
                const { n } = db.prepare("SELECT COUNT(*) AS n FROM compartments WHERE session_id=?").get(session.id) as { n: number };
                const { state } = db.prepare("SELECT wrapup_in_progress_state AS state FROM session_meta WHERE session_id=?").get(session.id) as { state: string | null };
                if (n > 0 && !state) break;
            } finally { db.close(); }
            if (Date.now() > deadline) throw new Error("the historian published no history");
            await Bun.sleep(100);
        }
        await client.session.command({ sessionID: session.id, name: "ctx-flush", text: "" });
        await turn("FLUSHED: continue");
    }
    for (let i = 0; i < 4; i++) await turn(`MID_${i}: ${"newer work ".repeat(200)}`);
    return {
        host: () => host, session, turn, context, source,
        async restart() {
            await host.stopHost();
            host = await spawnOpencode2(options);
            answer();
            client = clientFor();
            await waitForPluginActive(client, fixture.cwd);
        },
        async compact() {
            await client.session.compact({ sessionID: session.id });
            await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(60000) });
        },
    };
}

test.failing("the request after a manual compaction that rebuilt the history head carries the queued drop", async () => {
    const s = await manualFoldSession(false);
    try {
        await s.turn("BEFORE_FOLD: continue");
        const sourceDb = s.source();
        const mid0 = (sourceDb.prepare("SELECT id FROM session_message WHERE session_id=? AND type='user' AND json_extract(data,'$.text') LIKE 'MID_0:%'").get(s.session.id) as { id: string }).id;
        sourceDb.close();
        const db = s.context();
        const pending = () => (db.prepare("SELECT COUNT(*) AS n FROM pending_ops WHERE session_id=?").get(s.session.id) as { n: number }).n;
        try {
            const { tag } = db.prepare("SELECT tag_number AS tag FROM tags WHERE session_id=? AND message_id=?").get(s.session.id, `${mid0}:p0`) as { tag: number };
            queuePendingOp(db, s.session.id, tag, "drop");
            const held = await s.turn("HELD: continue");
            expect(held.join("\n")).toContain("MID_0:");
            expect(pending()).toBe(1);
            await s.compact();
            const after = await s.turn("AFTER_FOLD: continue");
            // Every row between the history coverage and the host's cut comes back
            // exactly once, without the host's checkpoint wrapper.
            const text = after.join("\n");
            for (const marker of ["RAW_9:", "FLUSHED:", "MID_1:", "MID_3:", "BEFORE_FOLD:", "HELD:"])
                expect(text.split(marker).length - 1).toBe(1);
            expect(text).not.toContain("conversation-checkpoint");
            expect(text).not.toContain("recent-context");
            // The head changed, so the provider cache was lost on this pass...
            expect(after[0]).not.toBe(held[0]);
            expect(after[0]).toContain("HIST_SUMMARY");
            // ...and the held drop must land with it.
            expect(text).not.toContain("MID_0:");
            expect(pending()).toBe(0);
        } finally { db.close(); }
    } finally { await s.host().stop(); }
}, 240000);

(partRowsHost ? test.failing : test.skip)("with experimental part_rows, rows restored after a manual compaction keep their assistant replies", async () => {
    const s = await manualFoldSession(true);
    try {
        const before = await s.turn("BEFORE_FOLD: continue");
        const replies = (input: string[]) => input.filter((item) => item.includes("DETERMINISTIC_ANSWER")).length;
        expect(replies(before)).toBeGreaterThan(5);
        await s.compact();
        const after = await s.turn("AFTER_FOLD: continue");
        // Each later request carries every earlier reply: the ones restored from
        // the store before the cut, plus the reply to the previous turn.
        expect(replies(after)).toBe(replies(before) + 1);
        await s.restart();
        const restarted = await s.turn("RESTART: continue");
        expect(replies(restarted)).toBe(replies(before) + 2);
    } finally { await s.host().stop(); }
}, 240000);
