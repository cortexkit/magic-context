import { openTestDb } from "../../src/test-db";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { seedTaskScheduleState } from "../../../plugin/src/features/magic-context/dreamer/storage-task-schedule";
import { resolveProjectIdentity } from "../../../plugin/src/features/magic-context/memory/project-identity";
import { insertMemory } from "../../../plugin/src/features/magic-context/memory";
import { spawnOpencode2, waitForPluginActive } from '../../src/opencode2-runner/spawn';

async function fixture(config: unknown) {
    const observer = mkdtempSync(join(tmpdir(), "mc-s3-events-"));
    writeFileSync(join(observer, "index.js"), `import {appendFileSync} from 'node:fs'; import {join} from 'node:path';
export default {id:'s3-events',setup(context){ process.env.MAGIC_CONTEXT_LOG_PATH=join(context.location.directory,'mc.log'); const control=new AbortController(); void (async()=>{for await(const event of context.event.subscribe({signal:control.signal})) appendFileSync(join(context.location.directory,'events.jsonl'),JSON.stringify(event)+'\\n');})(); return ()=>control.abort(); }};`);
    const host = await spawnOpencode2({
        probePlugin: observer,
        modelContextLimit: 16_000,
        modelOutputLimit: 1024,
    });
    const directory = join(host.env.XDG_CONFIG_HOME!, "cortexkit");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "magic-context.jsonc"), JSON.stringify(config));
    const client = OpenCode.make({ baseUrl: host.url, headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` } });
    const session = await client.session.create({ location: { directory: host.cwd }, model: { providerID: "openai", id: "mock-model" } });
    await waitForPluginActive(client, host.cwd);
    const turn = async (text: string) => {
        await client.session.prompt({ sessionID: session.id, text });
        await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(20000) });
    };
    return { host, client, session, turn };
}
async function eventually(predicate: () => boolean) {
    const deadline = Date.now() + 15000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error("automatic task did not finish within 15s");
        await Bun.sleep(25);
    }
}

test("R36 automatic pressure schedules one historian generate on real GA without a test hook", async () => {
    const { host, session, turn } = await fixture({ auto_update: false, protected_tokens: 4000, memory: { enabled: false }, historian: { two_pass: false }, dreamer: { disable: true } });
    try {
        host.mock.setDefault({ text: "source answer", usage: { input_tokens: 100, output_tokens: 10 } });
        for (let index = 0; index < 8; index++) await turn(`source-${index} ${"bounded history ".repeat(700)}`);
        let hidden = 0;
        host.mock.addMatcher(body => {
            const range = JSON.stringify(body).match(/Messages (\d+)-(\d+):/);
            if (!range) return null;
            hidden++;
            return { text: `<compartment start="${range[1]}" end="${range[2]}" title="Organic history"><p1>The bounded source turns were preserved.</p1></compartment>`, usage: { input_tokens: 100, output_tokens: 10 } };
        });
        host.mock.setDefault({ text: "pressure answer", usage: { input_tokens: 11000, output_tokens: 10 } });
        await turn("Prime organic pressure");
        host.mock.setDefault({ text: "normal turn", usage: { input_tokens: 100, output_tokens: 10 } });
        const before = host.mock.requests().length;
        await turn("Observe organic historian");
        const db = openTestDb(join(host.env.XDG_DATA_HOME!, "cortexkit/magic-context/context.db"));
        db.exec("PRAGMA busy_timeout = 5000");
        await eventually(() => (db.prepare("SELECT count(*) AS n FROM historian_runs WHERE session_id = ? AND status = 'success'").get(session.id) as { n: number }).n > 0);
        expect(hidden).toBe(1);
        expect(host.mock.requests().length - before).toBe(2);
        expect(db.prepare("SELECT harness FROM historian_runs WHERE session_id = ?").all(session.id)).toEqual([{ harness: "opencode2" }]);
        db.close();
    } catch (error) { console.error(host.stderr().slice(-4000));
        try { console.error(readFileSync(join(host.cwd, "mc.log"), "utf8").split("\n").filter(line => /trigger|historian|compartment|boundar/i.test(line)).slice(-30).join("\n")); console.error(readFileSync(join(host.cwd, "events.jsonl"), "utf8").slice(-2500)); } catch {}
        throw error; }
    finally { await host.stop(); }
}, 60000);

test("R22 automatic execution-ended event dispatches due classify through real GA generate", async () => {
    const schedule = "* * * * *";
    const { host, session, turn } = await fixture({ auto_update: false, historian: { disable: true }, dreamer: { disable: false, tasks: { "classify-memories": { schedule } } } });
    try {
        host.mock.setDefault({ text: "normal turn", usage: { input_tokens: 100, output_tokens: 10 } });
        await turn("Initialize project");
        const db = openTestDb(join(host.env.XDG_DATA_HOME!, "cortexkit/magic-context/context.db"));
        db.exec("PRAGMA busy_timeout = 5000");
        const project = resolveProjectIdentity(host.cwd)!;
        for (let index = 0; index < 10; index++) insertMemory(db as never, { projectPath: project, category: "ARCHITECTURE", content: `Unique project architecture fact ${index}`, sourceSessionId: session.id });
        seedTaskScheduleState(db as never, project, "classify-memories", 1, null, schedule);
        db.prepare("UPDATE task_schedule_state SET next_due_at = 1 WHERE project_path = ? AND task = 'classify-memories'").run(project);
        let hidden = 0;
        host.mock.addMatcher(body => {
            const prompt = JSON.stringify(body);
            if (!prompt.includes("<classify>")) return null;
            const ids = [...prompt.matchAll(/\[(\d+)\]/g)].map(match => Number(match[1]));
            hidden++;
            return { text: `<classify>${[...new Set(ids)].map(id => `<memory id="${id}" importance="50" scope="project" shareable="true" />`).join("")}</classify>`, usage: { input_tokens: 100, output_tokens: 10 } };
        });
        const before = host.mock.requests().length;
        await turn("Wake scheduled classifier");
        await eventually(() => (db.prepare("SELECT count(*) AS n FROM memories WHERE project_path = ? AND classified_at IS NOT NULL").get(project) as { n: number }).n === 10);
        expect(hidden).toBe(1);
        expect(host.mock.requests().length - before).toBe(2);
        db.close();
    } catch (error) { console.error(host.stderr().slice(-4000));
        try { console.error(readFileSync(join(host.cwd, "mc.log"), "utf8").split("\n").filter(line => /trigger|historian|compartment|boundar/i.test(line)).slice(-30).join("\n")); console.error(readFileSync(join(host.cwd, "events.jsonl"), "utf8").slice(-2500)); } catch {}
        throw error; }
    finally { await host.stop(); }
}, 60000);
