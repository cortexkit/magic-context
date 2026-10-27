import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { CURATE_SYSTEM_PROMPT } from "../../../plugin/src/features/magic-context/dreamer/task-prompts";
import { insertMemory } from "../../../plugin/src/features/magic-context/memory";
import { resolveProjectIdentityForSession } from "../../../plugin/src/features/magic-context/memory/project-identity";
import { Database } from "../../../plugin/src/shared/sqlite";
import { CLI, isolation, spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";

async function eventually(check: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (!check()) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
        await Bun.sleep(25);
    }
}

test("OC2 commits complete 80-character, incremental and replacement mapping replies with the offered variant", async () => {
    const root = join(tmpdir(), "magic-context", "issue-725");
    mkdirSync(root, { recursive: true });
    const previousTmp = process.env.TMPDIR;
    process.env.TMPDIR = root;
    const fixture = isolation();
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    const host = await spawnOpencode2({
        existingIsolation: fixture, compactionAuto: false,
        magicContextConfig: {
            transform_mode: "ts", keep_subagents: true, compaction: { enabled: false },
            memory: { auto_search: { enabled: false }, git_commit_indexing: { enabled: false } },
            dreamer: { opencode: { tasks: { "map-memories": { variant: "high" } } } },
        },
    });
    let db: Database | undefined;
    try {
        const configPath = join(host.cwd, "opencode.json");
        const config = JSON.parse(readFileSync(configPath, "utf8"));
        config.providers.openai.models["mock-model"].variants = [
            { id: "medium", settings: { reasoningEffort: "medium" } },
            { id: "high", settings: { reasoningEffort: "high" } },
        ];
        writeFileSync(configPath, JSON.stringify(config));
        const version = execFileSync(CLI, ["--version"], { env: fixture.env, encoding: "utf8" }).trim();
        const client = OpenCode.make({ baseUrl: host.url, headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` } });
        await waitForPluginActive(client, host.cwd);
        const catalog = await client.model.list({ location: { directory: host.cwd } });
        const model = catalog.data.find(row => row.providerID === "openai" && row.id === "mock-model")!;
        expect(model.variants.map(variant => variant.id)).toContain("high");
        console.log(`${version} model API variants=${JSON.stringify(model.variants)}`);
        const parent = await client.session.create({ title: "mapping owner", location: { directory: host.cwd }, model: { providerID: "openai", id: "mock-model" } });
        db = new Database(join(host.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db"));
        db.exec("PRAGMA busy_timeout=10000");
        const project = resolveProjectIdentityForSession(host.cwd)!;
        const runs = () => db!.prepare("SELECT id, tasks_json FROM dream_runs ORDER BY id").all() as Array<{ id: number; tasks_json: string }>;
        const proofs: unknown[] = [];
        const seenChildren = new Set<string>();
        let lastMemory = 0;
        for (const scenario of ["complete", "incremental", "replacement"]) {
            const id = insertMemory(db, { projectPath: project, category: "ARCHITECTURE", content: `The ${scenario} fixture claim is implemented by its backing file.` }).id;
            lastMemory = id;
            const file = `src/${"x".repeat(26 - String(id).length)}.ts`;
            mkdirSync(join(host.cwd, "src"), { recursive: true });
            writeFileSync(join(host.cwd, file), `export const claim = ${id};`);
            const final = `<mappings>\n<memory id="${id}" files="${file}"/>\n</mappings>`;
            expect(final.length).toBe(80);
            const before = runs().at(-1)?.id ?? 0;
            let calls = 0;
            let active = true;
            host.mock.addMatcher(body => {
                if (!active || !String(body.instructions).includes("You are a memory mapper")) return null;
                calls++;
                if (calls <= 2) {
                    const prefix = calls === 1 && scenario === "incremental" ? "<mappings>\n" :
                        calls === 1 && scenario === "replacement" ? '<mappings><memory id="999999" independent="true"/></mappings>' : "";
                    return { openaiOutput: [
                        ...(prefix ? [{ type: "message", id: `msg_${calls}`, role: "assistant", content: [{ type: "output_text", text: prefix, annotations: [] }] }] : []),
                        { type: "function_call", id: `fc_${calls}`, call_id: `call_${calls}`, name: "read", arguments: JSON.stringify({ filePath: join(host.cwd, file) }) },
                    ], usage: { input_tokens: 100, output_tokens: 10 } };
                }
                return { text: scenario === "incremental" ? final.slice("<mappings>\n".length) : final, usage: { input_tokens: 100, output_tokens: 10 } };
            });
            await client.session.command({ sessionID: parent.id, name: "ctx-dream", text: "map-memories" });
            await eventually(() => runs().some(row => row.id > before && row.tasks_json.includes('"map-memories"')), scenario);
            const result = runs().filter(row => row.id > before).flatMap(row => JSON.parse(row.tasks_json)).find(task => task.name === "map-memories");
            expect(result.status).toBe("completed");
            expect(db.prepare("SELECT file_path FROM memory_verifications WHERE memory_id = ?").all(id)).toEqual([{ file_path: file }]);
            expect(calls).toBe(3);
            active = false;
            const children = (await client.session.list({ directory: host.cwd, parentID: parent.id })).data;
            const child = children.find(child => !seenChildren.has(child.id))!;
            expect(child).toBeDefined();
            seenChildren.add(child.id);
            const recorded = await client.session.get({ sessionID: child.id });
            expect(recorded.model?.variant).toBe("high");
            const messages = await client.message.list({ sessionID: child.id, type: "assistant", order: "asc" });
            const expectedFinal = scenario === "incremental" ? final.slice("<mappings>\n".length) : final;
            const last = messages.data.at(-1)!;
            expect(last.type).toBe("assistant");
            if (last.type === "assistant") {
                expect(last.content.filter(part => part.type === "text").map(part => part.text).join("")).toBe(expectedFinal);
            }
            proofs.push({ scenario, final, model: recorded.model, messages });
        }
        const beforeCurate = runs().at(-1)!.id;
        host.mock.addMatcher(body => {
            if (!String(body.instructions).includes(CURATE_SYSTEM_PROMPT)) return null;
            if (!JSON.stringify(body.input).includes("function_call_output")) return {
                openaiOutput: [{ type: "function_call", id: "fc_curate", call_id: "call_curate", name: "ctx_memory", arguments: JSON.stringify({ action: "update", ids: [lastMemory], category: "ARCHITECTURE", content: "The replacement fixture claim is implemented by its backing file. The fixture remains local to this project." }) }],
                usage: { input_tokens: 100, output_tokens: 10 },
            };
            return { text: "Clarified the fixture memory.", usage: { input_tokens: 100, output_tokens: 10 } };
        });
        await client.session.command({ sessionID: parent.id, name: "ctx-dream", text: "curate" });
        await eventually(() => runs().some(row => row.id > beforeCurate && row.tasks_json.includes('"curate"')), "curate sibling");
        const curate = runs().filter(row => row.id > beforeCurate).flatMap(row => JSON.parse(row.tasks_json)).find(task => task.name === "curate");
        expect(curate.status).toBe("completed");
        expect(curate.progress).toContain("1 memory operation applied (update)");
        expect(host.pluginLog()).not.toContain("variant 'high' not offered");
        writeFileSync(join(host.root, "mapping-proof.json"), JSON.stringify({ version, catalog, proofs, curate }, null, 2));
        console.log(`3 mapping scenarios committed; curate sibling applied 1 operation; isolated artifacts=${host.root}`);
    } catch (error) {
        console.error(`Artifacts: ${host.root}`, host.pluginLog().slice(-8000), host.stderr().slice(-4000));
        throw error;
    } finally {
        db?.close();
        await host.stop();
    }
}, 120_000);
