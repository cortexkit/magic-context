/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DreamerConfigSchema } from "../../config/schema/magic-context";
import {
    deleteTaskScheduleRowsForProject,
    writeTaskScheduleState,
} from "../../features/magic-context/dreamer/storage-task-schedule";
import { insertMemory } from "../../features/magic-context/memory/storage-memory";
import { openDatabase } from "../../features/magic-context/storage";
import { startDreamTrigger } from "./dream-trigger";

/**
 * A context whose event stream delivers one finished session execution.
 * `handled` resolves when the trigger asks for the next event, which it does
 * only after its scheduler pass for the first one has returned.
 */
function contextWithOneExecution(
    directory: string,
    /** Where the host says the finished session lives; defaults to this context's own location. */
    sessionLocation: { directory: string; workspaceID?: string } = { directory },
) {
    let markHandled: () => void = () => undefined;
    const handled = new Promise<void>((resolve) => {
        markHandled = resolve;
    });
    const context = {
        location: { directory },
        session: { get: async () => ({ location: sessionLocation }) },
        event: {
            subscribe: ({ signal }: { signal: AbortSignal }) =>
                (async function* () {
                    yield { type: "session.execution.succeeded", data: { sessionID: "ses-v2" } };
                    markHandled();
                    await new Promise<void>((resolve) =>
                        signal.addEventListener("abort", () => resolve(), { once: true }),
                    );
                })(),
        },
    } as never;
    return { context, handled };
}

// Every production call into the scheduled pass must say whether the project's
// memory is on; a call that leaves it out schedules a memory-disabled project.
test("every scheduled-pass caller forwards the project's memory switch", () => {
    const src = join(import.meta.dir, "../..");
    const callers: Array<[string, string]> = [
        ["plugin/dream-timer.ts", "projectMemoryEnabled: reg.memoryEnabled !== false"],
        [
            "hooks/magic-context/hook.ts",
            "projectMemoryEnabled: deps.config.memory?.enabled !== false",
        ],
        ["v2/hooks/dream-trigger.ts", "projectMemoryEnabled: args.projectMemoryEnabled"],
        ["v2/hooks/context.ts", "projectMemoryEnabled: config.memory.enabled"],
    ];
    for (const [file, forwarded] of callers) {
        expect(readFileSync(join(src, file), "utf8")).toContain(forwarded);
    }
});

// OpenCode 2 reaches the scheduler through this trigger rather than the dream
// timer, so the project's memory switch must be forwarded here as well.
for (const projectMemoryEnabled of [false, true]) {
    const label = projectMemoryEnabled
        ? "schedules a project with memory enabled"
        : "schedules nothing for a project with memory disabled and leaves its rows";
    test(`OpenCode 2 ${label}`, async () => {
        const db = openDatabase();
        if (!db) throw new Error("test database unavailable");
        const projectIdentity = `git:v2-trigger-memory-${projectMemoryEnabled ? "on" : "off"}`;
        insertMemory(db, { projectPath: projectIdentity, category: "PROJECT_RULES", content: "r" });
        writeTaskScheduleState(db, {
            projectPath: projectIdentity,
            task: "verify",
            lastRunAt: null,
            // Not due, so the enabled case finishes without running a task.
            nextDueAt: Date.now() + 60 * 60_000,
            schedule: "0 3 * * *",
            lastStatus: null,
            lastError: null,
            retryCount: 0,
        });
        const readTasks = () =>
            (
                db
                    .prepare("SELECT task FROM task_schedule_state WHERE project_path = ?")
                    .all(projectIdentity) as Array<{ task: string }>
            ).map((row) => row.task);

        const { context, handled } = contextWithOneExecution("/tmp/v2-project");
        const trigger = startDreamTrigger(context, {
            config: DreamerConfigSchema.parse({}),
            executor: { capabilities: { tools: false } } as never,
            projectIdentity: () => projectIdentity,
            projectMemoryEnabled,
            openReader: () => ({ rootSessionActivity: () => new Map(), close() {} }),
        });
        try {
            await handled;
            if (projectMemoryEnabled) {
                // The pass keeps verify and seeds classify-memories, a memory task
                // this host can run without a tool loop.
                expect(readTasks()).toContain("verify");
                expect(readTasks()).toContain("classify-memories");
            } else {
                // The pass adds nothing and keeps the existing verify row.
                expect(readTasks()).toEqual(["verify"]);
            }
        } finally {
            await trigger.dispose();
            deleteTaskScheduleRowsForProject(db, projectIdentity);
        }
    });
}

// OpenCode 2 delivers every location's events to every plugin instance. A run
// started here for another location's session would hang its child under that
// session; the child takes that location, so its turns reach a plugin instance
// that never registered the run, and run there unshaped with the user's tools.
test("OpenCode 2 starts no dream run for a session in another directory or another workspace", async () => {
    const db = openDatabase();
    if (!db) throw new Error("test database unavailable");
    for (const [label, foreign] of [
        ["directory", { directory: "/tmp/v2-other-project" }],
        ["workspace", { directory: "/tmp/v2-project", workspaceID: "wrk_1" }],
    ] as const) {
        const projectIdentity = `git:v2-trigger-foreign-${label}`;
        insertMemory(db, { projectPath: projectIdentity, category: "PROJECT_RULES", content: "r" });
        const readTasks = () =>
            (
                db
                    .prepare("SELECT task FROM task_schedule_state WHERE project_path = ?")
                    .all(projectIdentity) as Array<{ task: string }>
            ).map((row) => row.task);
        const { context, handled } = contextWithOneExecution("/tmp/v2-project", foreign);
        const trigger = startDreamTrigger(context, {
            config: DreamerConfigSchema.parse({}),
            executor: { capabilities: { tools: false } } as never,
            projectIdentity: () => projectIdentity,
            projectMemoryEnabled: true,
            openReader: () => ({ rootSessionActivity: () => new Map(), close() {} }),
        });
        try {
            await handled;
            // The pass never reached the scheduler: it seeded no task rows.
            expect({ label, tasks: readTasks() }).toEqual({ label, tasks: [] });
        } finally {
            await trigger.dispose();
            deleteTaskScheduleRowsForProject(db, projectIdentity);
        }
    }
});

test("OpenCode 2 starts no dream run while the live config disables the dreamer", async () => {
    const db = openDatabase();
    if (!db) throw new Error("test database unavailable");
    const projectIdentity = "git:v2-trigger-live-disable";
    insertMemory(db, { projectPath: projectIdentity, category: "PROJECT_RULES", content: "r" });
    const readTasks = () =>
        (
            db
                .prepare("SELECT task FROM task_schedule_state WHERE project_path = ?")
                .all(projectIdentity) as Array<{ task: string }>
        ).map((row) => row.task);
    const { context, handled } = contextWithOneExecution("/tmp/v2-project");
    const trigger = startDreamTrigger(context, {
        // Enabled at boot; the user has since set `dreamer.disable: true`.
        config: DreamerConfigSchema.parse({}),
        sample: () => ({ config: DreamerConfigSchema.parse({ disable: true }) }),
        executor: { capabilities: { tools: false } } as never,
        projectIdentity: () => projectIdentity,
        projectMemoryEnabled: true,
        openReader: () => ({ rootSessionActivity: () => new Map(), close() {} }),
    });
    try {
        await handled;
        expect(readTasks()).toEqual([]);
    } finally {
        await trigger.dispose();
        deleteTaskScheduleRowsForProject(db, projectIdentity);
    }
});
