import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
        expect(before[0]!.key).toContain(`native-fold/v3/${session.id}`);
        const saved = JSON.parse(before[0]!.value) as { payload: string; digest: string };
        expect(saved.digest).toBe(createHash("sha256").update(saved.payload).digest("hex"));
        const provenance = JSON.parse(saved.payload);
        expect(Object.keys(provenance).sort()).toEqual(["proof", "replay", "version"]);
        expect(provenance.version).toBe(3);
        expect(Object.keys(provenance.proof).sort()).toEqual(["admissionID", "historyDigest", "sessionID", "sourceDigest", "summaryDigest"]);
        expect(provenance.proof.sessionID).toBe(session.id);
        for (const key of ["sourceDigest", "summaryDigest", "historyDigest"])
            expect(provenance.proof[key]).toMatch(/^[a-f0-9]{64}$/);
        const replay = provenance.replay;
        expect(Object.keys(replay).every(key => ["floor", "controls", "blocked", "upgrade", "withoutRecentContext"].includes(key))).toBe(true);
        expect(Object.keys(replay.floor).sort()).toEqual(["after", "digest", "id", "kind", "seq"]);
        expect(["start", "summary", "checkpoint", "host-checkpoint"]).toContain(replay.floor.kind);
        expect(replay.floor.digest).toMatch(/^[a-f0-9]{64}$/);
        expect(Number.isSafeInteger(replay.floor.seq)).toBe(true);
        expect(Number.isSafeInteger(replay.floor.after)).toBe(true);
        expect(replay.floor.after).toBe(["start", "host-checkpoint"].includes(replay.floor.kind) ? replay.floor.seq - 1 : replay.floor.seq);
        expect(Array.isArray(replay.controls)).toBe(true);
        for (const control of replay.controls) {
            expect(Object.keys(control).every(key => ["after", "effort", "previous"].includes(key))).toBe(true);
            for (const key of ["effort", "previous"])
                expect(control[key] === undefined || ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(control[key])).toBe(true);
        }
        expect(replay.blocked === undefined || typeof replay.blocked === "boolean").toBe(true);
        expect(replay.withoutRecentContext === undefined || typeof replay.withoutRecentContext === "boolean").toBe(true);
        if (replay.upgrade) {
            expect(Object.keys(replay.upgrade).sort()).toEqual(["admissionID", "mode"]);
            expect(["bounded", "host-checkpoint", "source-repair"]).toContain(replay.upgrade.mode);
        }
        const source = new Database(join(fixture.env.XDG_DATA_HOME!, "opencode", fixture.env.OPENCODE_DB!), { readonly: true });
        try {
            const floor = source.prepare("SELECT seq FROM session_message WHERE session_id=? AND id=?").get(session.id, replay.floor.id) as { seq: number } | null;
            expect(floor?.seq).toBe(replay.floor.seq);
            const cut = source.prepare("SELECT data FROM session_message WHERE session_id=? AND id=? AND type='compaction'").get(session.id, provenance.proof.admissionID) as { data: string } | null;
            expect(cut).toBeTruthy();
            expect(provenance.proof.summaryDigest).toBe(createHash("sha256").update(JSON.parse(cut!.data).summary ?? "").digest("hex"));
            for (const control of replay.controls) if (control.after)
                expect(source.prepare("SELECT id FROM session_message WHERE session_id=? AND id=?").get(session.id, control.after)).toBeTruthy();
        } finally { source.close(); }
        expect(saved.payload).not.toContain("PRIVATE_RAW_");
        expect(saved.payload).not.toContain("history ");
        expect(saved.payload).not.toContain(fixture.root);
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
