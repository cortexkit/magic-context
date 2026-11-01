// Generates crates/mc-module/testdata/dream_tasks/retrospective.json: what the
// TypeScript dreamer's retrospective task reads, decides and writes over a fixed
// session history, run twice in sequence on one database. The history is read
// by the production OpenCode provider (OpenCodeRetrospectiveRawProvider) from an
// OpenCode-shaped database; the same messages are emitted as raw-archive rows for
// the Rust reader. The Rust retrospective must send the same gate lines and
// friction window and write the same memories, observations, processed window
// and watermark.
//
//   bun crates/mc-module/gen/gen-dream-retrospective-golden.ts          # write
//   bun crates/mc-module/gen/gen-dream-retrospective-golden.ts --check  # compare

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { Database } from "../../../packages/plugin/src/shared/sqlite";
import { OpenCodeRetrospectiveRawProvider } from "../../../packages/plugin/src/features/magic-context/dreamer/retrospective-raw-provider";
import { createDreamTaskExecutor } from "../../../packages/plugin/src/features/magic-context/dreamer/task-executor";
import { leaseKeyFor } from "../../../packages/plugin/src/features/magic-context/dreamer/task-registry";

const root = resolve(import.meta.dir, "../../..");
const goldenPath = resolve(root, "crates/mc-module/testdata/dream_tasks/retrospective.json");

// The Rust host fixture holds its leases from 1000 ms for two minutes; every
// message and write time below stays inside that window.
const NOW = 100_000;
// The Rust host fixture's project key.
const PROJECT = "project";

interface Part {
    type: string;
    [key: string]: unknown;
}
interface Msg {
    id: string;
    session: string;
    role: "user" | "assistant";
    ts: number;
    parts: Part[];
}

const text = (t: string, extra: Record<string, unknown> = {}): Part => ({ type: "text", text: t, ...extra });
const tool = (name: string, state: Record<string, unknown>): Part => ({ type: "tool", tool: name, state });

/** Messages added before each run. */
const batches: Msg[][] = [
    [
        { id: "a1", session: "ses-a", role: "user", ts: 1000, parts: [text("Please run the focused tests before you report the change as done.")] },
        { id: "a2", session: "ses-a", role: "assistant", ts: 1100, parts: [text("Done, it works."), tool("bash", { status: "completed", output: "ok" })] },
        {
            id: "a3",
            session: "ses-a",
            role: "user",
            ts: 1200,
            parts: [
                text("Injected context the user never typed.", { synthetic: true }),
                text("  You did not run the tests again; run the focused tests before reporting done.  "),
                text("ignored aside", { ignored: true }),
            ],
        },
        { id: "a4", session: "ses-a", role: "user", ts: 1300, parts: [text("<system-reminder>background task finished</system-reminder>")] },
        { id: "a5", session: "ses-a", role: "assistant", ts: 1400, parts: [tool("read", { status: "error", error: "file not found" })] },
        { id: "a6", session: "ses-a", role: "user", ts: 1500, parts: [text("<!-- OMO_INTERNAL_INITIATOR -->Thanks, that works now.")] },
        { id: "b1", session: "ses-b", role: "user", ts: 1250, parts: [text("Stop guessing file paths and read the directory listing first.")] },
        // A delegated child session: never read.
        { id: "s1", session: "ses-sub", role: "user", ts: 1210, parts: [text("Subagent task prompt that says this is wrong and failed.")] },
        // Another project: never read.
        { id: "f1", session: "ses-foreign", role: "user", ts: 1220, parts: [text("FOREIGN project message.")] },
    ],
    [{ id: "a7", session: "ses-a", role: "user", ts: 1600, parts: [text("Looks good, please continue with the next step.")] }],
];

const sessions = [
    { session: "ses-a", project: PROJECT, subagent: 0 },
    { session: "ses-b", project: PROJECT, subagent: 0 },
    { session: "ses-sub", project: PROJECT, subagent: 1 },
    { session: "ses-foreign", project: "git:other", subagent: 0 },
];

/** The reviewer's answers per run: the gate, then (on a hit) the deepen turn. */
const answers: Array<{ gate: string; deepen?: string }> = [
    {
        gate: "y: 3, 4",
        deepen: `<learnings>
  <learning route="memory" category="PROJECT_RULES">Run the focused test suite and report its result before calling a change done.</learning>
  <learning route="memory" category="PROJECT_RULES">Run the focused test suite and report its result before calling a change done.</learning>
  <learning route="observation">Prefers explicit verification evidence in completion summaries.</learning>
  <learning route="memory" category="CONSTRAINTS">On 2026-06-01 the build broke.</learning>
  <learning route="memory" category="WORKFLOW">Not a valid category.</learning>
</learnings>`,
    },
    { gate: "n" },
];

const opencode = new Database(":memory:");
opencode.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);`);

const db = new Database(":memory:");
db.exec(
    (await readFile(resolve(root, "crates/mc-store/testdata/context_schema/schema.sql"), "utf8")).replaceAll(
        ":applied_at",
        "1",
    ),
);
for (const s of sessions) {
    db.prepare("INSERT INTO session_projects(session_id,harness,project_path,updated_at) VALUES (?,?,?,0)").run(
        s.session,
        "opencode",
        s.project,
    );
    db.prepare("INSERT INTO session_meta(session_id,harness,is_subagent) VALUES (?,'opencode',?)").run(s.session, s.subagent);
}

/** One-based position of each message in its session, as the archive keeps it. */
const ordinals = new Map<string, number>();
function add(batch: Msg[]): unknown[] {
    const archived = [];
    for (const m of batch) {
        opencode
            .prepare("INSERT INTO message(id,session_id,time_created,data) VALUES (?,?,?,?)")
            .run(m.id, m.session, m.ts, JSON.stringify({ id: m.id, sessionID: m.session, role: m.role, time: { created: m.ts } }));
        m.parts.forEach((part, index) => {
            opencode
                .prepare("INSERT INTO part(id,message_id,session_id,time_created,data) VALUES (?,?,?,?,?)")
                .run(`${m.id}-p${index}`, m.id, m.session, m.ts + index, JSON.stringify(part));
        });
        const ordinal = (ordinals.get(m.session) ?? 0) + 1;
        ordinals.set(m.session, ordinal);
        archived.push({
            sessionId: m.session,
            message: { id: m.id, role: m.role, parts: m.parts, ordinal, createdAt: m.ts, completedAt: null, version: null },
        });
        // The plugin's session-activity row: the newest message time.
        db.prepare(
            "INSERT INTO schema_migrations_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(excluded.value AS INTEGER) > CAST(value AS INTEGER)",
        ).run(`retrospective_activity:${m.session}`, String(m.ts));
    }
    return archived;
}

Date.now = () => NOW;
const runs = [];
for (const [index, batch] of batches.entries()) {
    const archived = add(batch);
    const answer = answers[index];
    const prompts: Array<{ system: string; prompt: string }> = [];
    let lastSystem = "";
    const client = {
        session: {
            list: async () => ({ data: [{ id: "ses-parent", title: "ordinary session" }] }),
            create: async () => ({ data: { id: "retro-child" } }),
            prompt: async (args: { body?: { system?: string; parts?: Array<{ text?: string }> } }) => {
                lastSystem = args.body?.system ?? "";
                prompts.push({ system: lastSystem, prompt: args.body?.parts?.[0]?.text ?? "" });
                return {};
            },
            messages: async () => ({
                data: [
                    {
                        info: { role: "assistant", time: { created: NOW } },
                        parts: [
                            { type: "text", text: lastSystem.includes("friction detector") ? answer.gate : (answer.deepen ?? "") },
                        ],
                    },
                ],
            }),
            delete: async () => ({}),
        },
    };
    const executor = createDreamTaskExecutor({
        client: client as never,
        sessionDirectory: "/fixture",
        openOpenCodeDb: () => null,
        retrospectiveRawProvider: (contextDb) => new OpenCodeRetrospectiveRawProvider({ contextDb, opencodeDb: opencode }),
        userMemoryCollectionEnabled: true,
    });
    const result = (await executor(
        { task: "retrospective", schedule: "0 5 * * *", timeoutMinutes: 20, retrospectiveRecencyDays: 30 },
        { db, projectIdentity: PROJECT, holderId: "holder", leaseKey: leaseKeyFor("retrospective", PROJECT) },
    )) as { status: string; schedulePatch?: { retrospectiveWatermarkMs?: number } };
    if (result.status !== "completed") throw new Error(`run ${index} did not complete: ${JSON.stringify(result)}`);
    // The TypeScript scheduler persists the watermark from the schedule patch.
    const watermark = result.schedulePatch?.retrospectiveWatermarkMs;
    if (typeof watermark === "number") {
        db.prepare(
            "INSERT INTO task_schedule_state(project_path,task,retrospective_watermark_ms) VALUES (?,'retrospective',?) ON CONFLICT(project_path,task) DO UPDATE SET retrospective_watermark_ms=excluded.retrospective_watermark_ms",
        ).run(PROJECT, watermark);
    }
    const friction = prompts[1]?.prompt.match(/### Friction window\n([\s\S]*?)\n\n### /)?.[1] ?? null;
    runs.push({
        archived,
        answer,
        gateUserText: prompts[0]?.prompt ?? null,
        frictionWindow: friction,
        modelCalls: prompts.length,
        watermark: watermark ?? null,
        memories: db
            .prepare(
                "SELECT project_path,category,content,source_session_id,source_type,metadata_json,status FROM memories ORDER BY id",
            )
            .all(),
        candidates: db.prepare("SELECT content,session_id,created_at,source_compartment_start,source_compartment_end FROM user_memory_candidates ORDER BY id").all(),
        processedWindows: db.prepare("SELECT project_path,window_key FROM retrospective_processed_windows ORDER BY window_key").all(),
    });
}

const out = { project: PROJECT, now: NOW, sessions, runs };
const rendered = `${JSON.stringify(out, null, 2)}\n`;
if (process.argv.includes("--check")) {
    if ((await readFile(goldenPath, "utf8")) !== rendered) {
        throw new Error(
            "retrospective golden drifted from the TypeScript dreamer; regenerate with bun crates/mc-module/gen/gen-dream-retrospective-golden.ts",
        );
    }
    console.log("retrospective golden matches the TypeScript dreamer");
} else {
    await mkdir(dirname(goldenPath), { recursive: true });
    await writeFile(goldenPath, rendered);
    console.log(`wrote ${goldenPath}`);
}
