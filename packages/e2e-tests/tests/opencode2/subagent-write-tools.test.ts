import { openTestDb } from "../../src/test-db";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { expectedOpenCode2Version } from "../../src/opencode2-runner/cli-resolution";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { inspectHostOpenFiles } from "../../src/host-open-files";
import { CLI, isolation, spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";
import { CHILD_SYSTEM, subagentWriteScenario } from "../../src/subagent-write-scenario";

test("OC2 task child hides memory and note tools; primary tools and bytes survive", async () => {
    const isolated = isolation();
    const probe = join(isolated.root, "worker-plugin");
    mkdirSync(probe);
    writeFileSync(join(probe, "index.js"), `export default { id: "write-policy-worker", async setup(context) {
        await context.agent.transform(editor => editor.update("write-worker", agent => {
            agent.mode = "subagent"; agent.hidden = false; agent.description = "Write policy worker";
            agent.system = ${JSON.stringify(CHILD_SYSTEM)};
            agent.permissions = [{ action: "*", resource: "*", effect: "allow" }];
        })); await context.agent.reload();
    } };`);
    const host = await spawnOpencode2({ existingIsolation: isolated, probePlugin: probe, providerID: "anthropic", compactionAuto: false,
        magicContextConfig: { dreamer: { disable: true }, memory: { enabled: true } },
    });
    const client = OpenCode.make({ baseUrl: host.url, headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` } });
    const parent = await client.session.create({ title: "Write policy primary", location: { directory: host.cwd }, model: { providerID: "anthropic", id: "mock-model" } });
    await waitForPluginActive(client, host.cwd);
    await waitForPluginActive(client, host.cwd, "write-policy-worker");
    const db = openTestDb(join(host.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db"), { readonly: true });
    const store = new Database(join(host.env.XDG_DATA_HOME!, "opencode", "opencode2.db"), { readonly: true });
    try {
        const version = JSON.parse(readFileSync(join(realpathSync(CLI), "..", "..", "package.json"), "utf8")).version;
        expect(version).toBe(expectedOpenCode2Version());
        const files = inspectHostOpenFiles(host.pid!, host.root, join(host.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db"));
        console.log(JSON.stringify({ version, root: host.root, pid: files.pid, lsofDatabases: files.databases }));
        await subagentWriteScenario({ host: "oc2", mock: host.mock, db, parent: parent.id,
            turn: async text => { await client.session.prompt({ sessionID: parent.id, text }); await client.session.wait({ sessionID: parent.id }, { signal: AbortSignal.timeout(30_000) }); },
            child: () => (store.query("SELECT id FROM session_v2 WHERE parent_id = ?").get(parent.id) as { id: string }).id,
        });
    } finally { db.close(); store.close(); await host.stop(); }
}, 120_000);
