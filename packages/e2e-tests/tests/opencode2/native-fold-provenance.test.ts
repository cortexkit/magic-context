import { expect, test } from "bun:test";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { Database } from "../../../plugin/src/shared/sqlite";
import { isolation, inspectOpenFiles, spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";

test("real host KV deletion revokes digest-only provenance before any restarted context pass", async () => {
    const fixture = isolation();
    fixture.env.MC_OC2_HOST_FOLD_ROWS = "999999";
    const options = {
        existingIsolation: fixture, compactionAuto: false, modelContextLimit: 100000, modelOutputLimit: 1024,
        magicContextConfig: { cache_ttl: "never", protected_tokens: 1500, historian: { disable: true },
            dreamer: { disable: true }, memory: { enabled: false } },
    };
    let host = await spawnOpencode2(options);
    const clientFor = () => OpenCode.make({ baseUrl: host.url, headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` } });
    const samples: unknown[] = [];
    const sample = () => {
        const paths = inspectOpenFiles(host.pid!, fixture.root, host.env).filter(path => /\.db(?:-wal|-shm)?$/.test(path));
        expect(paths.length).toBeGreaterThan(0);
        expect(paths.every(path => path.startsWith(fixture.root + "/"))).toBe(true);
        samples.push({ pid: host.pid, paths });
    };
    const rows = () => {
        const db = new Database(join(fixture.env.XDG_DATA_HOME!, "opencode", fixture.env.OPENCODE_DB!), { readonly: true });
        try { return db.prepare("SELECT key, value FROM kv WHERE key LIKE '%:native-fold/%'").all() as { key: string; value: string }[]; }
        finally { db.close(); }
    };
    try {
        let client = clientFor();
        await waitForPluginActive(client, fixture.cwd);
        const session = await client.session.create({ title: "durable provenance deletion", location: { directory: fixture.cwd },
            model: { providerID: "openai", id: "mock-model" } });
        for (let i = 0; i < 9; i++) {
            await client.session.prompt({ sessionID: session.id, text: `PRIVATE_RAW_${i}: ${"history ".repeat(100)}` });
            await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(60000) });
        }
        await client.session.compact({ sessionID: session.id });
        await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(60000) });
        const before = rows();
        expect(before.length).toBe(1);
        expect(before[0]!.key).toContain(`native-fold/v2/${session.id}`);
        const saved = JSON.parse(before[0]!.value) as { payload: string };
        const provenance = JSON.parse(saved.payload);
        expect(Object.keys(provenance).sort()).toEqual(["admissionID", "historyDigest", "sessionID", "sourceDigest", "summaryDigest"]);
        expect(saved.payload).not.toContain("PRIVATE_RAW_");
        sample();
        await host.stopHost();
        host = await spawnOpencode2(options);
        client = clientFor();
        await waitForPluginActive(client, fixture.cwd);
        sample();
        await client.session.remove({ sessionID: session.id });
        // Event handling may finish after the HTTP removal returns, so allow the
        // session deletion subscriber to remove the provenance row before checking it.
        const deadline = Date.now() + 10000;
        while (rows().length && Date.now() < deadline) await Bun.sleep(25);
        const after = rows();
        expect(after).toEqual([]);
        console.log("PROVENANCE_KV_EVIDENCE " + JSON.stringify({ version: process.env.MC_E2E_OPENCODE2_VERSION, root: fixture.root, before, after, samples }));
    } finally { await host.stop(); }
}, 180000);
