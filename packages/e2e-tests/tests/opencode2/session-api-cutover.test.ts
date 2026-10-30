import { openTestDb } from "../../src/test-db";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { Database } from "../../../plugin/src/shared/sqlite";
import { ensureSharedOpenCode2 } from "../../scripts/ensure-shared-opencode2";
import { inspectOpenFiles, isolation, spawnOpencode2, waitForPluginActive, waitForPluginLog } from "../../src/opencode2-runner/spawn";

const oldCLI = ensureSharedOpenCode2("2.0.21");
const newCLI = ensureSharedOpenCode2("2.0.22");
const clientFor = (host: Awaited<ReturnType<typeof spawnOpencode2>>) => OpenCode.make({ baseUrl: host.url, headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` } });
async function eventually<T>(read: () => T | undefined, timeoutMs = 30000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const result = read();
        if (result !== undefined) return result;
        if (Date.now() >= deadline) throw new Error("cutover evidence timed out");
        await Bun.sleep(100);
    }
}
function withDB<T>(path: string, read: (db: Database) => T): T {
    const db = openTestDb(path, undefined, Database);
    db.exec("PRAGMA busy_timeout = 5000");
    try { return read(db); } finally { db.close(); }
}
const records = (path: string) => withDB(path, (db) => db.prepare("SELECT key, value FROM schema_migrations_meta WHERE key GLOB 'opencode2_hidden_children:*'").all() as Array<{ key: string; value: string }>);

async function assertOldHostRefusal(compact = false): Promise<void> {
    const host = await spawnOpencode2({ cli: oldCLI });
    try {
        const client = clientFor(host);
        const session = await client.session.create({ location: { directory: host.cwd }, title: "unsupported host", model: { providerID: "openai", id: "mock-model" } });
        await waitForPluginActive(client, host.cwd);
        const before = host.mock.requests().length;
        for (let index = 0; index < 2; index++) {
            await client.session.prompt({ sessionID: session.id, text: `must not reach provider ${index}` });
            await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(15000) });
        }
        if (compact) {
            const admission = await client.session.compact({ sessionID: session.id });
            expect(admission.type).toBe("compaction");
            await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(15000) });
        }
        const log = await waitForPluginLog(host.env, "OpenCode 2.0.22");
        expect(log).toContain("Magic Context is disabled: OpenCode 2.0.22");
        expect(log.match(/Magic Context is disabled: OpenCode 2\.0\.22/g)).toHaveLength(1);
        expect(host.mock.requests().length).toBe(before);
        expect(host.stderr()).not.toContain("Failed to load plugin");
        expect(host.stderr()).not.toContain("Failed to drain Session");
        const hostDb = join(host.env.XDG_DATA_HOME!, "opencode", host.env.OPENCODE_DB!);
        await eventually(() => withDB(hostDb, (db) => (db.prepare("SELECT data FROM session_message WHERE session_id = ?").all(session.id) as Array<{data: string}>).some((row) => row.data.includes("OpenCode 2.0.22"))) ? true : undefined);
        const versionMessages = withDB(hostDb, (db) => (db.prepare("SELECT data FROM session_message WHERE session_id = ?").all(session.id) as Array<{ data: string }>).filter((row) => row.data.includes("OpenCode 2.0.22")).map((row) => JSON.parse(row.data)));
        expect(versionMessages).toHaveLength(1);
        const open = inspectOpenFiles(host.pid!, host.root, host.env);
        console.log(JSON.stringify({ refusalCLI: oldCLI, versionMessages, openDatabases: open.filter((path) => /\.(db|sqlite)(-(wal|shm))?$/.test(path)) }));
    } finally { await host.stop(); }
}

test("OpenCode 2.0.21 refuses once with the minimum version and never reaches a provider", () => assertOldHostRefusal(), 60000);
test("OpenCode 2.0.21 refuses host compaction without reaching a provider", () => assertOldHostRefusal(true), 60000);

test("OpenCode 2.0.22 cleans active and retired legacy records on the same store", async () => {
    const fixture = isolation();
    const path = join(fixture.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db");
    // A saved pre-cutover build lets release verification create the rows with the old executor.
    // Ordinary regression runs seed the same on-disk format without retaining old runtime code.
    const baseline = process.env.MC_E2E_LEGACY_PLUGIN;
    const old = await spawnOpencode2({ existingIsolation: fixture, cli: baseline ? oldCLI : newCLI,
        includeMagicContext: Boolean(baseline), magicContextPlugin: baseline,
        magicContextConfig: { historian: { two_pass: false }, dreamer: { tasks: { "review-user-memories": { schedule: "0 3 * * *" } } } },
    });
    let ids: string[] = [];
    let parentID = "";
    try {
        const client = clientFor(old);
        const parent = await client.session.create({ location: { directory: old.cwd }, title: "upgrade parent", model: { providerID: "openai", id: "mock-model" } });
        parentID = parent.id;
        if (baseline) {
            await waitForPluginActive(client, old.cwd);
            for (let index = 0; index < 6; index++) {
                await client.session.prompt({ sessionID: parent.id, text: `Source ${index}: ${"durable history ".repeat(80)}` });
                await client.session.wait({ sessionID: parent.id });
            }
            old.mock.addMatcher((body) => {
                const range = JSON.stringify(body).match(/Messages (\d+)-(\d+):/);
                return range ? { text: `<compartment start="${range[1]}" end="${range[2]}" title="Rebuilt"><p1>History.</p1></compartment>`, usage: { input_tokens: 100, output_tokens: 40 } } : null;
            });
            await client.session.command({ sessionID: parent.id, name: "ctx-recomp", text: "" });
            await eventually(() => records(path).some((row) => Object.values(JSON.parse(row.value).active ?? {}).some((child: any) => child.ever_settled === true)) ? true : undefined);
            withDB(path, (db) => {
                for (let index = 0; index < 3; index++) db.prepare("INSERT INTO user_memory_candidates (content, session_id, created_at) VALUES (?, ?, ?)").run(`Prefers concise answers ${index}`, parent.id, Date.now());
            });
            old.mock.addMatcher((body) => JSON.stringify(body).includes("user memories") ? { error: { status: 400, type: "invalid_request_error", message: "cutover retired-child proof" } } : null);
            old.mock.setDefault({ error: { status: 400, type: "invalid_request_error", message: "cutover retired-child proof" } });
            await client.session.command({ sessionID: parent.id, name: "ctx-dream", text: "review-user-memories" });
            await eventually(() => records(path).some((row) => (JSON.parse(row.value).retired_children ?? []).length > 0) ? true : undefined);
        } else {
            const active = await client.session.create({ title: "old active", location: { directory: old.cwd }, metadata: { magic_context: "hidden-run" } });
            const retired = await client.session.create({ title: "old retired", location: { directory: old.cwd }, metadata: { magic_context: "hidden-run" } });
            withDB(path, (db) => db.prepare("INSERT INTO schema_migrations_meta (key, value) VALUES (?, ?)").run("opencode2_hidden_children:fixture", JSON.stringify({ version: 1, active: { historian: { id: active.id } }, retired_children: [{ id: retired.id }] })));
        }
        const rows = records(path);
        expect(rows.some((row) => Object.keys(JSON.parse(row.value).active ?? {}).length > 0)).toBe(true);
        expect(rows.some((row) => (JSON.parse(row.value).retired_children ?? []).length > 0)).toBe(true);
        ids = rows.flatMap((row) => { const meta = JSON.parse(row.value); return [...Object.values(meta.active ?? {}), ...(meta.retired_children ?? [])].map((child: any) => child.id as string); });
        expect(ids.length).toBeGreaterThanOrEqual(2);
        for (const id of ids) expect((await client.session.get({ sessionID: id })).id).toBe(id);
        console.log(JSON.stringify({ legacyCLI: baseline ? oldCLI : newCLI, baseline: baseline ?? "seeded regression", recordedChildren: ids, records: rows.map((row) => ({ key: row.key, value: JSON.parse(row.value) })), openDatabases: inspectOpenFiles(old.pid!, old.root, old.env).filter((path) => /\.(db|sqlite)(-(wal|shm))?$/.test(path)) }));
    } finally { await old.stop(); }
    const upgraded = await spawnOpencode2({ existingIsolation: fixture, cli: newCLI });
    try {
        const client = clientFor(upgraded);
        await waitForPluginActive(client, upgraded.cwd);
        await eventually(() => records(path).length === 0 ? true : undefined);
        for (const id of ids) await expect(client.session.get({ sessionID: id })).rejects.toThrow();
        expect((await client.session.get({ sessionID: parentID })).id).toBe(parentID);
        await Bun.sleep(500);
        const openDatabases = inspectOpenFiles(upgraded.pid!, upgraded.root, upgraded.env).filter((path) => /\.(db|sqlite)(-(wal|shm))?$/.test(path));
        expect(withDB(path, (db) => db.prepare("SELECT value FROM schema_migrations_meta WHERE key = 'opencode2_hidden_children_cleanup_complete'").get())).toEqual({ value: "true" });
        console.log(JSON.stringify({ upgradedCLI: newCLI, removedChildren: ids, remainingRecords: records(path), openDatabases }));
    } catch (error) {
        console.error(upgraded.stderr());
        throw error;
    } finally { await upgraded.stop(); }
}, 180000);
