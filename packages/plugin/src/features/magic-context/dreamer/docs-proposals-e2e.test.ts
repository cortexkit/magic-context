import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DREAMER_DOCS_ALLOWED_TOOLS } from "../../../agents/dreamer";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { isolatedTestGitEnv } from "../../../shared/test-git-env";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { listPendingDocsProposals } from "./docs-proposals";
import { acquireLease } from "./lease";
import { getDreamRuns } from "./storage-dream-runs";
import { getTaskScheduleState, writeTaskStateJson } from "./storage-task-schedule";
import { createDreamTaskExecutor } from "./task-executor";
import { leaseKeyFor } from "./task-registry";
import { runManualDream } from "./task-scheduler";

let dir: string;
let db: Database;
afterEach(() => {
    if (db) closeQuietly(db);
    if (dir) rmSync(dir, { recursive: true, force: true });
});

function fixture(architecture = "# Architecture\n\n## Core\nOld sentence.\n") {
    dir = createTestTempDirFromPath(join(tmpdir(), "mc-docs-e2e-"));
    const git = (...args: string[]) =>
        execFileSync("git", args, {
            windowsHide: true,
            cwd: dir,
            encoding: "utf8",
            env: isolatedTestGitEnv(),
        }).trim();
    const file = join(dir, "ARCHITECTURE.md");
    writeFileSync(file, architecture);
    writeFileSync(join(dir, "STRUCTURE.md"), "# Structure\n\n## Layout\nLayout.\n");
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("add", ".");
    git("commit", "-qm", "base docs");
    writeFileSync(join(dir, "src.ts"), "export const core = true;\n");
    git("add", ".");
    git("commit", "-qm", "core implementation");
    const before = readFileSync(file);
    const structureBefore = readFileSync(join(dir, "STRUCTURE.md"));
    db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return { git, file, before, structureBefore };
}

const validChange = {
    file: "ARCHITECTURE.md",
    action: "replace",
    heading: "## Core",
    text: "## Core\nCurrent sentence.",
    reason: "Core source contradicts old description",
};
const proposal = JSON.stringify([validChange]);
const primary = { providerID: "test", modelID: "docs-primary" };
const fallback = { providerID: "test", modelID: "docs-fallback" };

function retryFixture(
    outputs: string[],
    options: { architecture?: string; docsMaxTokens?: number; onPrompt?: () => void } = {},
) {
    const repo = fixture(options.architecture);
    const models: unknown[] = [];
    const prompts: string[] = [];
    const client = {
        session: {
            list: async () => ({ data: [{ id: "parent" }] }),
            create: async () => ({ data: { id: "child" } }),
            prompt: async (args: { body: { model: unknown; parts: { text: string }[] } }) => {
                models.push(args.body.model);
                prompts.push(args.body.parts[0].text);
                options.onPrompt?.();
                return {};
            },
            messages: async () => ({
                data: [
                    {
                        info: { role: "assistant", time: { created: Date.now() } },
                        parts: [{ type: "text", text: outputs[models.length - 1] }],
                    },
                ],
            }),
            delete: async () => ({}),
        },
    };
    const executor = createDreamTaskExecutor({
        client: client as never,
        sessionDirectory: dir,
        openOpenCodeDb: () => null,
    });
    const leaseKey = leaseKeyFor("maintain-docs", dir);
    const config = {
        task: "maintain-docs" as const,
        schedule: "0 4 * * *",
        timeoutMinutes: 20,
        model: "test/docs-primary",
        fallbackModels: ["test/docs-fallback"],
        docsMaxTokens: options.docsMaxTokens,
    };
    const run = () => {
        expect(acquireLease(db, "holder", leaseKey)).toBe(true);
        return executor(config, { db, projectIdentity: dir, holderId: "holder", leaseKey });
    };
    const runManual = () =>
        runManualDream({ db, projectIdentity: dir, tasks: [config], executor, task: config.task });
    return { ...repo, models, prompts, run, runManual };
}

test("maintain-docs stub model cannot edit docs, emits a proposal and skips the next run", async () => {
    const { git, file, before } = fixture();
    expect(DREAMER_DOCS_ALLOWED_TOOLS).not.toContain("write");
    expect(DREAMER_DOCS_ALLOWED_TOOLS).not.toContain("edit");
    expect(DREAMER_DOCS_ALLOWED_TOOLS).not.toContain("bash");
    let prompts = 0;
    const client = {
        session: {
            list: async () => ({ data: [{ id: "parent" }] }),
            create: async () => ({ data: { id: "child" } }),
            prompt: async (args: { body: { agent: string } }) => {
                prompts++;
                expect(args.body.agent).toBe("dreamer-docs");
                return {};
            },
            messages: async () => ({
                data: [
                    {
                        info: { role: "assistant", time: { created: Date.now() } },
                        parts: [
                            {
                                type: "tool",
                                tool: "write",
                                state: {
                                    status: "error",
                                    input: { filePath: file, content: "MALICIOUS EDIT" },
                                    error: "permission denied",
                                },
                            },
                            { type: "text", text: proposal },
                        ],
                    },
                ],
            }),
            delete: async () => ({}),
        },
    };
    const executor = createDreamTaskExecutor({
        client: client as never,
        sessionDirectory: dir,
        openOpenCodeDb: () => null,
    });
    const leaseKey = leaseKeyFor("maintain-docs", dir);
    expect(acquireLease(db, "holder", leaseKey)).toBe(true);
    const ctx = { db, projectIdentity: dir, holderId: "holder", leaseKey };
    const config = { task: "maintain-docs" as const, schedule: "0 4 * * *", timeoutMinutes: 20 };
    const first = await executor(config, ctx);
    expect(first.status).toBe("completed");
    expect(JSON.parse(first.schedulePatch?.taskStateJson ?? "null")).toEqual({
        head: git("rev-parse", "HEAD"),
    });
    writeTaskStateJson(db, dir, "maintain-docs", first.schedulePatch?.taskStateJson ?? "{}");
    expect(readFileSync(file)).toEqual(before);
    expect(listPendingDocsProposals(dir)).toHaveLength(1);
    const second = await executor(config, ctx);
    expect(second.status).toBe("completed");
    expect(second.detail).toBe("no commits since last run");
    expect(prompts).toBe(1);
    expect(readFileSync(file)).toEqual(before);
});

test.each([
    "dismissed",
    "applied",
])("maintain-docs reviews deferred commits after the pending proposal is %s", async (resolution) => {
    const change = { ...validChange, text: "## Core\nCurrent description of `src.ts`." };
    const { git, file, prompts, runManual } = retryFixture([JSON.stringify([change]), "[]"], {
        architecture: "# Architecture\n\n## Core\nOld description of `src.ts`.\n",
    });
    expect((await runManual()).ran).toEqual(["maintain-docs"]);
    expect(listPendingDocsProposals(dir)).toHaveLength(1);
    const [pending] = listPendingDocsProposals(dir);

    writeFileSync(join(dir, "src.ts"), "export const core = false;\n");
    git("add", "src.ts");
    git("commit", "-qm", "change documented implementation");
    expect((await runManual()).details).toEqual(["pending proposal matches current docs"]);
    expect(prompts).toHaveLength(1);

    if (resolution === "dismissed") {
        rmSync(pending);
    } else {
        writeFileSync(file, `# Architecture\n\n${change.text}\n`);
        git("add", "ARCHITECTURE.md");
        git("commit", "-qm", "apply docs proposal");
    }

    const after = await runManual();
    expect(after.details).toEqual(["no corrections proposed"]);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("+export const core = false;");
    expect(getTaskScheduleState(db, dir, "maintain-docs")?.taskStateJson).toBe(
        JSON.stringify({ head: git("rev-parse", "HEAD") }),
    );
});

test("maintain-docs retries non-JSON prose with the fallback and writes only a proposal", async () => {
    const { run, models, file, before, structureBefore, git } = retryFixture([
        "I could not produce the proposal.",
        `\`\`\`json\n${proposal}\n\`\`\``,
    ]);
    const result = await run();
    expect(models).toEqual([primary, fallback]);
    expect(result.status).toBe("completed");
    expect(JSON.parse(result.schedulePatch?.taskStateJson ?? "null")).toEqual({
        head: git("rev-parse", "HEAD"),
    });
    const pending = listPendingDocsProposals(dir);
    expect(pending).toHaveLength(1);
    expect(readFileSync(pending[0]!, "utf8")).toContain("Current sentence.");
    expect(readFileSync(file)).toEqual(before);
    expect(readFileSync(join(dir, "STRUCTURE.md"))).toEqual(structureBefore);
});

test("maintain-docs records a dropped entry and checkpoints the remaining proposal", async () => {
    const { run, models, file, before, git } = retryFixture([JSON.stringify([null, validChange])]);
    const result = await run();
    expect(models).toEqual([primary]);
    expect(result.status).toBe("completed");
    expect(result.detail).toContain("entry 1");
    expect(result.detail).toContain("expected an object");
    expect(JSON.parse(getDreamRuns(db, dir)[0]!.tasks_json)[0].progress).toBe(result.detail);
    expect(JSON.parse(result.schedulePatch?.taskStateJson ?? "null")).toEqual({
        head: git("rev-parse", "HEAD"),
    });
    const pending = listPendingDocsProposals(dir);
    expect(pending).toHaveLength(1);
    expect(readFileSync(pending[0]!, "utf8")).toContain("+Current sentence.");
    expect(readFileSync(file)).toEqual(before);
});

test("maintain-docs fails exhausted invalid output without an anchor or proposal", async () => {
    const { run, models, file, before, structureBefore } = retryFixture([
        "I could not produce the proposal.",
        JSON.stringify(validChange),
    ]);
    const result = await run();
    expect(models).toEqual([primary, fallback]);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("All models exhausted");
    expect(result.schedulePatch?.taskStateJson).toBeUndefined();
    expect(listPendingDocsProposals(dir)).toEqual([]);
    expect(readFileSync(file)).toEqual(before);
    expect(readFileSync(join(dir, "STRUCTURE.md"))).toEqual(structureBefore);
});

test.each([
    "[]",
    " \n [] \t",
    "```json\n[]\n```",
    " \n```json\n [] \n```\n",
])("maintain-docs normalizes empty proposal %j as no corrections", async (output) => {
    const { run, models, file, before, structureBefore, git } = retryFixture([output]);
    const result = await run();
    expect(models).toEqual([primary]);
    expect(result.status).toBe("completed");
    expect(result.detail).toBe("no corrections proposed");
    expect(JSON.parse(result.schedulePatch?.taskStateJson ?? "null")).toEqual({
        head: git("rev-parse", "HEAD"),
    });
    expect(listPendingDocsProposals(dir)).toEqual([]);
    expect(readFileSync(file)).toEqual(before);
    expect(readFileSync(join(dir, "STRUCTURE.md"))).toEqual(structureBefore);
});

test.each([
    ["one-line reason", { reason: "" }],
    ["protected region", { text: "## Core\nRemoved hand authored text." }],
    ["over budget", {}],
    ["invalid addition", { action: "add", heading: "## Extra", text: "## Extra\n## Sneaked\n" }],
    ["invalid replacement", { text: "## Wrong heading\nCurrent sentence." }],
] as const)("maintain-docs records %s and checkpoints even with no applicable entries", async (failure, change) => {
    const { run, models, file, before, structureBefore, git } = retryFixture(
        [JSON.stringify([{ ...validChange, ...change }])],
        {
            architecture:
                failure === "protected region"
                    ? "# Architecture\n\n## Core\n<!-- mc:protected START -->\nHand authored\n<!-- mc:protected END -->\n"
                    : undefined,
            docsMaxTokens: failure === "over budget" ? 1 : undefined,
        },
    );
    const result = await run();
    expect(models).toEqual([primary]);
    expect(result.status).toBe("completed");
    expect(result.detail).toContain(`no corrections proposed; dropped entry 1:`);
    expect(result.detail).toContain(failure);
    expect(JSON.parse(getDreamRuns(db, dir)[0]!.tasks_json)[0].progress).toBe(result.detail);
    expect(JSON.parse(result.schedulePatch?.taskStateJson ?? "null")).toEqual({
        head: git("rev-parse", "HEAD"),
    });
    expect(listPendingDocsProposals(dir)).toEqual([]);
    expect(readFileSync(file)).toEqual(before);
    expect(readFileSync(join(dir, "STRUCTURE.md"))).toEqual(structureBefore);
});

test("maintain-docs fails closed on base drift without retrying or checkpointing", async () => {
    const drifted = "# Structure\n\nDrifted.\n";
    const { run, models, file, before } = retryFixture([proposal], {
        onPrompt: () => writeFileSync(join(dir, "STRUCTURE.md"), drifted),
    });
    const result = await run();
    expect(models).toEqual([primary]);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("base drifted");
    expect(result.schedulePatch?.taskStateJson).toBeUndefined();
    expect(listPendingDocsProposals(dir)).toEqual([]);
    expect(readFileSync(file)).toEqual(before);
    expect(readFileSync(join(dir, "STRUCTURE.md"), "utf8")).toBe(drifted);
});
