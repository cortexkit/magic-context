// The TypeScript dreamer's real scheduler pass (`runDueTasksForProject`) against a
// context.db shared with a Rust dreamer in the calling Rust test. The host has no
// ck-mc module client, so it never asks which tasks Rust owns (no `rustOwnedTasks`).
//
// Usage: bun dream-shared-schedule-ts.ts <context.db> <project> <schedule> <mode> <signal-dir>
//   mode "pass":  one scheduler pass.
//   mode "hold":  one pass whose task run waits for <signal-dir>/release after
//                 writing <signal-dir>/holding, so the Rust side can act while this
//                 dreamer holds the domain lease mid-run.
//   mode "pause": one pass that, after planning and before it takes the domain
//                 lease, writes <signal-dir>/planned and waits for <signal-dir>/go,
//                 so the Rust side can run the same slot in between.
// Each task run inserts one row into `cross_runtime_runs` (runtime 'typescript').
// Prints one JSON line: {"ran": <tasks executed by this pass>}.
import { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    type DreamTaskRuntimeConfig,
    runDueTasksForProject,
} from "../../../../packages/plugin/src/features/magic-context/dreamer/task-scheduler";

const [contextPath, project, schedule, mode, signalDir] = process.argv.slice(2);
if (!contextPath || !project || !schedule || !mode || !signalDir) {
    throw new Error("usage: <context.db> <project> <schedule> <mode> <signal-dir>");
}

const waitFor = (name: string) => {
    const deadline = Date.now() + 60_000;
    while (!existsSync(join(signalDir, name))) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${name}`);
        Bun.sleepSync(10);
    }
};

const db = new Database(contextPath);
db.exec("PRAGMA busy_timeout = 5000");
let paused = false;

if (mode === "pause") {
    // Pause exactly between planning and the lease acquisition, outside any
    // transaction, by intercepting the first BEGIN IMMEDIATE the domain-group
    // runner issues: the one that opens its lease acquisition. (The acquisition
    // function itself is not on the stack: it tail-calls the transaction helper.)
    // Earlier writes, such as schedule reconciliation while planning, pass through.
    const exec = db.exec.bind(db);
    db.exec = ((sql: string, ...rest: unknown[]) => {
        if (
            !paused &&
            sql === "BEGIN IMMEDIATE" &&
            new Error().stack?.includes("runDomainGroupWithCooldown")
        ) {
            paused = true;
            writeFileSync(join(signalDir, "planned"), "");
            waitFor("go");
        }
        return (exec as (sql: string, ...rest: unknown[]) => unknown)(sql, ...rest);
    }) as typeof db.exec;
}

const tasks: DreamTaskRuntimeConfig[] = [{ task: "curate", schedule, timeoutMinutes: 5 }];

const ran = await runDueTasksForProject({
    db,
    projectIdentity: project,
    tasks,
    projectMemoryEnabled: true,
    executor: async () => {
        const startedAt = Date.now();
        if (mode === "hold") {
            writeFileSync(join(signalDir, "holding"), "");
            waitFor("release");
        }
        db.prepare(
            "INSERT INTO cross_runtime_runs(runtime, started_at, finished_at) VALUES ('typescript', ?, ?)",
        ).run(startedAt, Date.now());
        return { status: "completed" };
    },
});
console.log(JSON.stringify({ ran }));
// A pause that never happened would leave the caller waiting for nothing.
if (mode === "pause" && !paused) throw new Error("the pass never reached its lease acquisition");
