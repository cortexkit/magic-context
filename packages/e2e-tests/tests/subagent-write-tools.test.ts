import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { TestHarness } from "../src/harness";
import { inspectHostOpenFiles } from "../src/host-open-files";
import { CHILD_SYSTEM, subagentWriteScenario } from "../src/subagent-write-scenario";

test("OC1 task child cannot write memories or notes; primary tools and bytes survive", async () => {
    const h = await TestHarness.create({
        magicContextConfig: { dreamer: { disable: true }, memory: { enabled: true } },
        openCodeConfigExtra: { agent: { "write-worker": { mode: "subagent", prompt: CHILD_SYSTEM, description: "Write policy worker", permission: { "*": "allow" } } } },
    });
    const store = new Database(join(h.dataDir, "opencode", "opencode.db"), { readonly: true });
    try {
        const version = await fetch(`${h.serverUrl}/global/health`).then(r => r.json()) as { version: string };
        expect(version.version).toMatch(/^1\./);
        const root = dirname(h.opencode.env.configDir);
        const files = inspectHostOpenFiles(h.opencode.pid, root, h.contextDbPath());
        console.log(JSON.stringify({ version: version.version, root, pid: files.pid, lsofDatabases: files.databases }));
        const parent = await h.createSession();
        await subagentWriteScenario({ host: "oc1", mock: h.mock, db: h.contextDb(), parent,
            turn: text => h.sendPrompt(parent, text, { timeoutMs: 30_000 }),
            child: () => (store.query("SELECT id FROM session WHERE parent_id = ?").get(parent) as { id: string }).id,
        });
    } finally { store.close(); await h.dispose(); }
}, 120_000);
