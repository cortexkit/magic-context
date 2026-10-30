import { openTestDb } from "../../src/test-db";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { Database } from "../../../plugin/src/shared/sqlite";
import { isolation, inspectOpenFiles, spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";

test("a fork of an invisible fold renders inherited compartments without reviving checkpoint recent-context", async () => {
    const fixture = isolation();
    fixture.env.MC_OC2_INVISIBLE_FOLD = "1";
    fixture.env.MC_OC2_HOST_FOLD_ROWS = "999999";
    const host = await spawnOpencode2({
        existingIsolation: fixture,
        magicContextPlugin: process.env.MC_REVIEW_PLUGIN,
        compactionAuto: false,
        modelContextLimit: 100000,
        modelOutputLimit: 1024,
        magicContextConfig: {
            cache_ttl: "never", protected_tokens: 1500,
            historian: { two_pass: false }, dreamer: { disable: true },
            memory: { enabled: false }, keep_subagents: true,
        },
    });
    const client = OpenCode.make({ baseUrl: host.url, headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` } });
    let db: Database | undefined;
    try {
        await waitForPluginActive(client, host.cwd);
        const paths = inspectOpenFiles(host.pid!, host.root, host.env).filter(path => /\.db(?:-wal|-shm)?$/.test(path));
        expect(paths.length).toBeGreaterThan(0);
        expect(paths.every(path => path.startsWith(fixture.root + "/"))).toBe(true);
        const session = await client.session.create({ title: "invisible fold fork cache witness", location: { directory: host.cwd }, model: { providerID: "openai", id: "mock-model" } });
        host.mock.setDefault({ text: "deterministic answer", usage: { input_tokens: 100, output_tokens: 10 } });
        let hidden = 0;
        host.mock.addMatcher((body: unknown) => {
            const range = JSON.stringify(body).match(/Messages (\d+)-(\d+):/);
            if (!range) return null;
            hidden++;
            return { text: `<compartment start="${range[1]}" end="${range[2]}" title="Retained history"><p1>FORK_SUMMARY preserves the earlier work.</p1></compartment>`, usage: { input_tokens: 100, output_tokens: 40 } };
        });
        const turn = async (sessionID: string, text: string) => {
            await client.session.prompt({ sessionID, text });
            await client.session.wait({ sessionID }, { signal: AbortSignal.timeout(60000) });
            return host.mock.requests().at(-1)!.body;
        };
        for (let i = 0; i < 9; i++) await turn(session.id, `FORK_RAW_${i}: ${"durable history ".repeat(50)}`);
        await client.session.compact({ sessionID: session.id });
        await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(60000) });
        await turn(session.id, "after fold");
        await turn(session.id, "ordinary defer");
        await client.session.command({ sessionID: session.id, name: "ctx-wrapup", text: "2" });
        db = openTestDb(join(fixture.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db"), { readonly: true }, Database);
        const count = (id: string) => (db!.prepare("SELECT COUNT(*) AS n FROM compartments WHERE session_id=?").get(id) as { n: number }).n;
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline) {
            const meta = db.prepare("SELECT wrapup_in_progress_state AS state FROM session_meta WHERE session_id=?").get(session.id) as { state: string | null };
            if (hidden && count(session.id) && !meta.state) break;
            await Bun.sleep(50);
        }
        expect(hidden).toBeGreaterThan(0);
        expect(count(session.id)).toBeGreaterThan(0);
        await client.session.command({ sessionID: session.id, name: "ctx-flush", text: "" });
        const parent = await turn(session.id, "explicit flush");
        expect(JSON.stringify(parent.input)).toContain("FORK_SUMMARY");
        expect(JSON.stringify(parent.input).includes("<conversation-checkpoint>")).toBe(false);
        expect(JSON.stringify(parent.input).includes("FORK_RAW_")).toBe(false);

        const fork = await client.session.fork({ sessionID: session.id });
        const request = await turn(fork.id, "continue from inherited history");
        expect(count(fork.id)).toBeGreaterThan(0);
        expect(JSON.stringify(request.input)).toContain("FORK_SUMMARY");
        // The copied host checkpoint contains an obsolete serialized tail. Once
        // compartments cover those rows, that tail must not become the fork's frozen history head.
        expect(JSON.stringify(request.input).includes("<conversation-checkpoint>")).toBe(false);
        expect(JSON.stringify(request.input).includes("FORK_RAW_")).toBe(false);
    } finally {
        db?.close();
        await host.stop();
    }
}, 180000);
