import { openTestDb } from "../../src/test-db";
import { expect, test } from "bun:test";
import { expectedOpenCode2Version } from "../../src/opencode2-runner/cli-resolution";
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { CANONICAL_DREAM_TASKS } from "../../../plugin/src/features/magic-context/dreamer/task-registry";
import { BOOT_SQLITE_BUSY_TIMEOUT_MS } from "../../../plugin/src/features/magic-context/storage-db";
import { getDreamTaskBacklog } from "../../../plugin/src/features/magic-context/dreamer/task-gates";
import { Database } from "../../../plugin/src/shared/sqlite";
import { gaDatabasePath } from "../../../plugin/src/v2/store-reader";
import { CLI, inspectOpenFiles, isolation, spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";

for (const mode of ["manual", "scheduled"] as const) {
    test(`OpenCode 2 ${mode} retrospective reads five real user sessions and drains their backlog`, async () => {
        const artifactRoot = join(tmpdir(), "magic-context", "issue-602-retrospective");
        mkdirSync(artifactRoot, { recursive: true });
        const previousTmp = process.env.TMPDIR;
        process.env.TMPDIR = realpathSync(artifactRoot);
        const fixture = isolation();
        if (previousTmp === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTmp;
        const version = spawnSync(CLI, ["--version"], { env: fixture.env, encoding: "utf8" });
        expect(version.status).toBe(0);
        expect(version.stdout.trim()).toBe(`opencode v${expectedOpenCode2Version()}`);
        const host = await spawnOpencode2({
            existingIsolation: fixture, serviceMode: true, compactionAuto: false,
            magicContextConfig: {
                transform_mode: "ts", compaction: { enabled: false },
                dreamer: { tasks: Object.fromEntries(CANONICAL_DREAM_TASKS.map(task => [task, {
                    schedule: task === "retrospective" && mode === "scheduled" ? "0 0 * * *" : "",
                }])) },
            },
        });
        let contextDb: Database | undefined;
        let hostDb: Database | undefined;
        try {
            expect(host.root.startsWith(realpathSync(artifactRoot))).toBe(true);
            const client = OpenCode.make({ baseUrl: host.url, headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` } });
            await waitForPluginActive(client, host.cwd);
            host.mock.setDefault({ text: "ordinary reply", usage: { input_tokens: 100, output_tokens: 10 } });
            host.mock.addMatcher(body => {
                if (String(body.instructions).includes("friction")) return { text: "n", usage: { input_tokens: 120, output_tokens: 5 } };
                return null;
            });
            const sessions: string[] = [];
            for (let index = 0; index < 5; index++) {
                const session = await client.session.create({ title: `real-user-${index}`, location: { directory: host.cwd }, model: { providerID: "openai", id: "mock-model" } });
                sessions.push(session.id);
                await client.session.prompt({ sessionID: session.id, text: `RETROSPECTIVE_OPENING_${index}: Please explain this project rule.` });
                await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(20000) });
                // The friction gate only reviews a user line that answers an assistant
                // reply, so each session needs a follow-up after its opening message.
                await client.session.prompt({ sessionID: session.id, text: `RETROSPECTIVE_REAL_USER_${index}: That rule is wrong, please correct it.` });
                await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(20000) });
            }
            contextDb = openTestDb(join(host.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db"), undefined, Database);
            contextDb.exec(`PRAGMA busy_timeout=${BOOT_SQLITE_BUSY_TIMEOUT_MS}`);
            const reschedule = (project: string) => {
                // Own the writer before changing the fixture's schedule; a completed
                // prompt can still be publishing its first-render state on another connection.
                contextDb!.transaction(() => {
                    contextDb!.prepare("UPDATE task_schedule_state SET next_due_at = 1 WHERE project_path = ? AND task = 'retrospective'").run(project);
                }).immediate();
            };
            hostDb = new Database(gaDatabasePath(host.env.XDG_DATA_HOME!, "latest", host.env), { readonly: true, fileMustExist: true });
            const project = (contextDb.prepare("SELECT project_path FROM session_projects WHERE session_id = ? AND harness = 'opencode2'").get(sessions[0]!) as { project_path: string }).project_path;
            expect(getDreamTaskBacklog(contextDb, project, "retrospective").pending).toBe(5);
            for (const id of sessions) expect(hostDb.prepare("SELECT id FROM session_message WHERE session_id = ? AND type = 'user'").get(id)).toBeTruthy();
            const beforePaths = inspectOpenFiles(host.pid!, host.root, host.env);
            writeFileSync(join(host.root, "lsof-before.json"), JSON.stringify(beforePaths, null, 2));
            if (mode === "manual") {
                await client.session.command({ sessionID: sessions[0]!, name: "ctx-dream", text: "retrospective" });
            } else {
                reschedule(project);
                await client.session.prompt({ sessionID: sessions[0]!, text: "RETROSPECTIVE_REAL_USER_WAKE: Please continue." });
                await client.session.wait({ sessionID: sessions[0]! }, { signal: AbortSignal.timeout(20000) });
            }
            const deadline = Date.now() + 20000;
            for (;;) {
                const run = contextDb.prepare("SELECT tasks_json FROM dream_runs WHERE project_path = ? ORDER BY id DESC LIMIT 1").get(project) as { tasks_json: string } | undefined;
                if (run && getDreamTaskBacklog(contextDb, project, "retrospective").pending === 0) break;
                if (Date.now() > deadline) throw new Error(`No ${mode} retrospective run: ${host.pluginLog()}`);
                await Bun.sleep(50);
            }
            const run = contextDb.prepare("SELECT * FROM dream_runs WHERE project_path = ? ORDER BY id DESC LIMIT 1").get(project) as { tasks_json: string; tasks_succeeded: number };
            expect(run.tasks_succeeded).toBe(1);
            expect(JSON.parse(run.tasks_json)[0]).toMatchObject({ name: "retrospective", status: "completed", backlog: { pendingAtStart: 5, pendingAtEnd: 0, processed: 5 } });
            const wire = host.mock.requests().filter(request => String(request.body.instructions).includes("friction"));
            expect(wire).toHaveLength(1);
            const input = JSON.stringify(wire[0]!.body.input);
            for (let index = 0; index < 5; index++) expect(input).toContain(`RETROSPECTIVE_REAL_USER_${index}`);
            expect(input).not.toContain("ordinary reply");
            expect(getDreamTaskBacklog(contextDb, project, "retrospective").pending).toBe(0);
            // A later real user turn must reopen the gate on the same root;
            // completion-time or missing activity keys can falsely hide it.
            if (mode === "scheduled") reschedule(project);
            await client.session.prompt({ sessionID: sessions[0]!, text: "RETROSPECTIVE_REAL_USER_NEXT: Please revisit that rule." });
            await client.session.wait({ sessionID: sessions[0]! }, { signal: AbortSignal.timeout(20000) });
            if (mode === "manual") await client.session.command({ sessionID: sessions[0]!, name: "ctx-dream", text: "retrospective" });
            const secondDeadline = Date.now() + 20000;
            let second: { tasks_json: string };
            for (;;) {
                const runs = contextDb.prepare("SELECT tasks_json FROM dream_runs WHERE project_path = ? ORDER BY id").all(project) as Array<{ tasks_json: string }>;
                if (runs.length === 2 && getDreamTaskBacklog(contextDb, project, "retrospective").pending === 0) { second = runs[1]!; break; }
                if (Date.now() > secondDeadline) throw new Error("Later user activity did not reopen retrospective");
                await Bun.sleep(50);
            }
            expect(JSON.parse(second.tasks_json)[0]).toMatchObject({ status: "completed", backlog: { pendingAtStart: 1, pendingAtEnd: 0, processed: 1 } });
            const secondWire = host.mock.requests().filter(request => String(request.body.instructions).includes("friction"));
            expect(secondWire).toHaveLength(2);
            expect(JSON.stringify(secondWire[1]!.body.input)).toContain("RETROSPECTIVE_REAL_USER_NEXT");
            expect(getDreamTaskBacklog(contextDb, project, "retrospective").pending).toBe(0);
            const afterPaths = inspectOpenFiles(host.pid!, host.root, host.env);
            writeFileSync(join(host.root, "lsof-after.json"), JSON.stringify(afterPaths, null, 2));
            writeFileSync(join(host.root, "proof.json"), JSON.stringify({ mode, version: version.stdout.trim(), pid: host.pid, root: host.root, env: host.env, sessions, run, second, requests: secondWire, dbPaths: afterPaths.filter(path => /\.db(?:-wal|-shm)?$/.test(path)) }, null, 2));
            console.log(`Host proof: ${mode} ${version.stdout.trim()} pid=${host.pid} 5 -> 0; artifacts=${host.root}`);
        } catch (error) {
            console.error(`Host artifacts: ${host.root}`, host.stderr().slice(-2000), host.pluginLog().slice(-8000));
            throw error;
        } finally {
            contextDb?.close(); hostDb?.close();
            writeFileSync(join(host.root, "plugin.log"), host.pluginLog());
            await host.stop();
        }
    }, 120000);
}
