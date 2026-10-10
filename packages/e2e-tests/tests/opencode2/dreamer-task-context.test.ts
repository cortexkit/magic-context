import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { CANONICAL_DREAM_TASKS } from "../../../plugin/src/features/magic-context/dreamer/task-registry";
import {
    CURATE_SYSTEM_PROMPT,
    FRICTION_GATE_SYSTEM_PROMPT,
    RETROSPECTIVE_SYSTEM_PROMPT,
} from "../../../plugin/src/features/magic-context/dreamer/task-prompts";
import { insertMemory } from "../../../plugin/src/features/magic-context/memory";
import { resolveProjectIdentityForSession } from "../../../plugin/src/features/magic-context/memory/project-identity";
import { insertPrimerCandidates } from "../../../plugin/src/features/magic-context/storage-primers";
import { Database } from "../../../plugin/src/shared/sqlite";
import { CLI, isolation, spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";

const TASKS = ["retrospective", "curate", "map-memories", "verify", "classify-memories", "promote-primers"];

interface RunRow {
    id: number;
    project_path: string;
    parent_session_id: string | null;
    tasks_json: string;
}
interface TaskResult {
    name: string;
    status: string;
    progress?: string;
    skipReason?: string;
}

async function eventually(check: () => boolean, label: string, timeoutMs = 240_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
        await Bun.sleep(50);
    }
}

function makeDue(db: Database, project: string, tasks: string[]): void {
    for (const task of tasks) {
        db.prepare(`INSERT INTO task_schedule_state
            (project_path, task, last_run_at, next_due_at, schedule, last_status, last_error, retry_count)
            VALUES (?, ?, NULL, 1, NULL, NULL, NULL, 0)
            ON CONFLICT(project_path, task) DO UPDATE SET
                last_run_at = NULL, next_due_at = 1, last_status = NULL, retry_count = 0`).run(project, task);
    }
}

// Exercise production ctx_* tools rather than replacements. The second location
// simulates a project used in Oh My Pi (OMP): memories reference a fixture OMP
// session and primer candidates carry harness=omp. With no OpenCode user session
// there, scheduled model tasks must not borrow a parent from the first location.
test("OpenCode 2 shapes all six dream routes and keeps timer work in its owning location", async () => {
    const root = /\/magic-context\/[^/]+(?:\/.*)?$/.test(tmpdir())
        ? tmpdir() : join(tmpdir(), "magic-context", "issue-647");
    mkdirSync(root, { recursive: true });
    const previousTmp = process.env.TMPDIR;
    process.env.TMPDIR = root;
    const fixture = isolation();
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    const other = join(fixture.root, "omp-project");
    mkdirSync(other);
    const host = await spawnOpencode2({
        existingIsolation: fixture, serviceMode: true, compactionAuto: false,
        magicContextConfig: {
            transform_mode: "ts", compaction: { enabled: false },
            memory: { auto_search: { enabled: false }, git_commit_indexing: { enabled: false } },
            dreamer: { tasks: Object.fromEntries(CANONICAL_DREAM_TASKS.map(task => [task, {
                schedule: TASKS.includes(task) ? "0 0 * * *" : "",
            }])) },
        },
    });
    let db: Database | undefined;
    try {
        const version = execFileSync(CLI, ["--version"], { env: fixture.env, encoding: "utf8" }).trim();
        const client = OpenCode.make({ baseUrl: host.url, headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` } });
        copyFileSync(join(host.cwd, "opencode.json"), join(other, "opencode.json"));
        for (const directory of [host.cwd, other]) await waitForPluginActive(client, directory);
        const opened = execFileSync("lsof", ["-Fn", "-p", String(host.pid)], { encoding: "utf8" });
        const paths = opened.split("\n").filter(line => /^n.*\.db(?:-wal|-shm)?$/.test(line)).map(line => line.slice(1));
        expect(paths.length).toBeGreaterThan(0);
        expect(paths.every(path => path.startsWith(`${host.root}/`))).toBe(true);
        writeFileSync(join(host.root, "issue-647-lsof.txt"), opened);
        console.log(`${version} pid=${host.pid} isolated databases=${JSON.stringify(paths)}`);

        const project = resolveProjectIdentityForSession(host.cwd)!;
        const otherProject = resolveProjectIdentityForSession(other)!;
        const ids: number[] = [];
        let memoryCalls = 0;
        let searchCalls = 0;
        host.mock.setDefault({ text: "ordinary reply", usage: { input_tokens: 100, output_tokens: 10 } });
        host.mock.addMatcher(body => {
            const system = String(body.instructions);
            const input = JSON.stringify(body.input) ?? "";
            const hasResult = input.includes("function_call_output");
            let text: string | undefined;
            if (system.includes(FRICTION_GATE_SYSTEM_PROMPT)) {
                const ordinals = [...input.matchAll(/(\d+): REAL_USER_/g)].map(match => match[1]);
                text = `y: ${ordinals.join(", ")}`;
            }
            else if (system.includes(RETROSPECTIVE_SYSTEM_PROMPT)) {
                if (!hasResult) {
                    searchCalls++;
                    return { openaiOutput: [{ type: "function_call", id: `fc_search_${searchCalls}`, call_id: `call_search_${searchCalls}`, name: "ctx_search", arguments: JSON.stringify({ query: "Fixture", limit: 3 }) }], usage: { input_tokens: 100, output_tokens: 10 } };
                }
                text = "<learnings></learnings>";
            } else if (system.includes(CURATE_SYSTEM_PROMPT)) {
                if (!hasResult) {
                    memoryCalls++;
                    return { openaiOutput: [{ type: "function_call", id: `fc_update_${memoryCalls}`, call_id: `call_update_${memoryCalls}`, name: "ctx_memory", arguments: JSON.stringify({ action: "update", ids: [ids[0]], content: `Fixture claim is recorded in fact.txt. Clarification ${memoryCalls} preserves the fixture fact.` }) }], usage: { input_tokens: 100, output_tokens: 10 } };
                }
                text = "Kept the fixture fact and clarified its wording.";
            } else if (system.includes("You are a memory mapper")) text = `<mappings>${ids.map(id => `<memory id="${id}" files="fact.txt"/>`).join("")}</mappings>`;
            else if (system.includes("You are a memory verifier")) text = `<verify>${ids.map(id => `<verified id="${id}" files="fact.txt"/>`).join("")}</verify>`;
            else if (system.includes("<classify>")) text = `<classify>${ids.map(id => `<memory id="${id}" importance="70" scope="project" shareable="true"/>`).join("")}</classify>`;
            return text ? { text, usage: { input_tokens: 100, output_tokens: 5 } } : null;
        });
        const sessions: string[] = [];
        for (let index = 0; index < 5; index++) {
            const session = await client.session.create({ title: `real-user-${index}`, location: { directory: host.cwd }, model: { providerID: "openai", id: "mock-model" } });
            sessions.push(session.id);
            await client.session.prompt({ sessionID: session.id, text: `REAL_USER_${index}: repeated correction about the Fixture project rule.` });
            await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(20_000) });
        }
        db = new Database(join(host.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db"));
        db.exec("PRAGMA busy_timeout=10000");
        for (let index = 0; index < 10; index++) {
            ids.push(insertMemory(db, { projectPath: project, category: "ARCHITECTURE", content: `Fixture claim ${index} is recorded in fact.txt.` }).id);
            insertMemory(db, { projectPath: otherProject, category: "ARCHITECTURE", content: `OMP fixture claim ${index} is recorded in fact.txt.`, sourceSessionId: "omp-history" });
        }
        for (const directory of [host.cwd, other]) writeFileSync(join(directory, "fact.txt"), "Fixture facts");
        const rows = () => db!.prepare("SELECT id, project_path, parent_session_id, tasks_json FROM dream_runs ORDER BY id").all() as RunRow[];
        const results = (row: RunRow) => JSON.parse(row.tasks_json) as TaskResult[];
        for (const task of TASKS) {
            const before = rows().at(-1)?.id ?? 0;
            await client.session.command({ sessionID: sessions[0]!, name: "ctx-dream", text: task });
            await eventually(() => rows().some(row => row.id > before && results(row).some(result => result.name === task)), task, 20_000);
            const result = rows().filter(row => row.id > before).flatMap(results).find(result => result.name === task)!;
            expect(result.status).toBe("completed");
            if (task === "curate") expect(result.progress).toContain("1 memory operation applied (update)");
        }
        expect(searchCalls).toBe(1);
        expect(memoryCalls).toBe(1);
        const beforeTimer = rows().at(-1)!.id;
        // Real user turns give the retrospective scan new work beyond its saved watermark.
        // Inserting messages directly into the database would bypass host activity tracking.
        for (const sessionID of sessions) {
            await client.session.prompt({ sessionID, text: "REAL_USER_NEXT: revisit the Fixture correction." });
            await client.session.wait({ sessionID }, { signal: AbortSignal.timeout(20_000) });
        }
        insertPrimerCandidates(db, [0, 8].map(days => ({
            projectPath: otherProject, harness: "omp", sessionId: `omp-candidate-${days}`,
            question: "Where are the fixture facts recorded?",
            sourceStartMessageId: `omp-start-${days}`, sourceEndMessageId: `omp-end-${days}`,
            sourceMessageTime: Date.now() - days * 86_400_000,
        })));
        makeDue(db, project, ["curate", "retrospective"]);
        makeDue(db, otherProject, TASKS);
        // Maintenance waits two minutes for startup reads and migrations, then staggers
        // projects by roughly a second. Waiting for the real scheduler, rather than
        // invoking its tick directly, checks that timer work is dispatched to its owner.
        await eventually(() => {
            const fresh = rows().filter(row => row.id > beforeTimer);
            return ["curate", "retrospective"].every(task => fresh.some(row => row.project_path === project && results(row).some(result => result.name === task))) &&
                ["curate", "map-memories", "verify", "classify-memories", "promote-primers"].every(task => fresh.some(row => row.project_path === otherProject && results(row).some(result => result.name === task)));
        }, "two-directory scheduled dream runs");
        const fresh = rows().filter(row => row.id > beforeTimer);
        for (const row of fresh) {
            if (row.project_path === project) {
                expect(sessions).toContain(row.parent_session_id!);
                for (const result of results(row)) expect(result.status).toBe("completed");
            } else if (row.project_path === otherProject) {
                expect(row.parent_session_id).toBeNull();
                for (const result of results(row)) {
                    if (result.name === "promote-primers") expect(result.status).toBe("completed");
                    else {
                        expect(result.status).toBe("skipped");
                        expect(result.skipReason).toContain("no session in this directory");
                    }
                }
            }
        }
        expect(searchCalls).toBe(2);
        expect(memoryCalls).toBe(2);
        await eventually(() => host.pluginLog().includes("timer tick (startup)"), "buffered startup timer log", 5_000);
        expect(host.pluginLog()).toContain("timer tick (startup)");
        for (const request of host.mock.requests()) {
            const wire = JSON.stringify(request.body);
            expect(wire).not.toContain("mc:hidden:");
            expect(wire).not.toContain(otherProject);
        }
        expect(host.pluginLog()).not.toContain("hidden_prompt_unrecognized");
        writeFileSync(join(host.root, "issue-647-proof.json"), JSON.stringify({ version, pid: host.pid, project, otherProject, runs: rows(), requests: host.mock.requests(), memoryCalls, searchCalls }, null, 2));
        console.log(`six manual tasks and two-location timer controls completed; artifacts=${host.root}`);
    } catch (error) {
        console.error(`Artifacts: ${host.root}`, host.pluginLog().slice(-8000));
        throw error;
    } finally {
        db?.close();
        writeFileSync(join(host.root, "issue-647-plugin.log"), host.pluginLog());
        await host.stop();
    }
}, 300_000);
