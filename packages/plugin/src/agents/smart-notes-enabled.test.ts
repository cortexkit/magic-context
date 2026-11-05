import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@opencode-ai/plugin";
import { parsePluginConfig } from "../config";
import { sampleLiveConfig } from "../config/live-run-config";
import { stripUnsafeProjectConfigFields } from "../config/project-security";
import { evaluateSmartNotes } from "../features/magic-context/dreamer/evaluate-smart-notes";
import { writeTaskScheduleState } from "../features/magic-context/dreamer/storage-task-schedule";
import { buildDreamTaskRuntimeConfigs } from "../features/magic-context/dreamer/task-config";
import { resolveProjectIdentityForSession } from "../features/magic-context/memory/project-identity";
import { runDueCompiledSmartNoteChecks } from "../features/magic-context/smart-notes/runner";
import {
    addNote,
    closeDatabase,
    getNotes,
    markNoteReady,
    openDatabase,
} from "../features/magic-context/storage";
import { onNoteTrigger, peekNoteNudgeText } from "../hooks/magic-context/note-nudger";
import { buildSidebarSnapshot } from "../plugin/rpc-handlers";
import { createToolRegistry } from "../plugin/tool-registry";
import { createTestTempDirFromPath } from "../shared/test-temp-dir";
import { createCtxNoteTools } from "../tools/ctx-note/tools";
import { CTX_NOTE_LIGHT_DESCRIPTION } from "../tools/light-descriptions";
import { applyJsonSchemaParameterDescriptions } from "../tools/parameter-descriptions";
import { registerTools } from "../v2/hooks/tools";
import { buildMagicContextSection } from "./magic-context-prompt";
import golden from "./smart-notes-on.golden.json";

// Freeze the OpenCode/Pi note definitions and primary guidance from master before this switch existed:
// default-on must preserve sessions' cached prompts. Source copies came from git show at
// 8d8f44bdaaba450ae136e20dd2476b3b41294416; SHA-256 hashes JSON.stringify of rendered strings
// and { description, schema } tool surfaces, not expectations calculated by the gated implementation.
// The `guidance/...` digests were re-taken once, when the `<system-reminder>` sentence changed to
// say a wrapped instruction has its author's authority; the switch must still change nothing.

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const expected = golden as Record<string, string>;
const oldXdg = process.env.XDG_DATA_HOME;
let dir: string | undefined;
afterEach(() => {
    closeDatabase();
    if (oldXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = oldXdg;
    if (dir) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
    dir = createTestTempDirFromPath(join(tmpdir(), "smart-notes-enabled-"));
    process.env.XDG_DATA_HOME = dir;
    return openDatabase();
}

test("enabled guidance is byte-identical to master on every built-in primary variant", () => {
    for (const preset of ["full", "light"] as const)
        for (const reduce of [false, true])
            for (const memory of [false, true])
                for (const dreamer of [false, true])
                    for (const temporal of [false, true]) {
                        for (const enabled of [undefined, true]) {
                            const text = buildMagicContextSection(
                                null,
                                20,
                                reduce,
                                dreamer,
                                temporal,
                                false,
                                false,
                                undefined,
                                memory,
                                preset,
                                undefined,
                                enabled,
                            );
                            expect(digest(text)).toBe(
                                expected[
                                    `guidance/${preset}/${reduce}/${memory}/${dreamer}/${temporal}`
                                ],
                            );
                        }
                    }
});

test("disabled guidance removes every smart-note clause on OpenCode 1 and 2", () => {
    const override =
        "Custom guidance\n### Smart notes\n#### Verification\nUse an external condition to park work.\n### Ordinary notes\nKeep intentions in ctx_note.";
    const custom = buildMagicContextSection(
        null,
        20,
        true,
        true,
        false,
        false,
        false,
        undefined,
        true,
        "full",
        override,
        false,
    );
    expect(custom).not.toContain("external condition");
    expect(custom).toContain("Keep intentions in ctx_note");
    for (const preset of ["full", "light"] as const)
        for (const reduce of [false, true])
            for (const memory of [false, true]) {
                const text = buildMagicContextSection(
                    null,
                    20,
                    reduce,
                    true,
                    true,
                    false,
                    false,
                    undefined,
                    memory,
                    preset,
                    undefined,
                    false,
                );
                expect(text).not.toMatch(/surface_condition|smart.note|outside checker/i);
                expect(text).toContain("ctx_note");
            }
});

test("startup capability is user-only, default on, and excluded from live reload", () => {
    const boot = parsePluginConfig({});
    expect(boot.smart_notes.enabled).toBe(true);
    const off = parsePluginConfig({ smart_notes: { enabled: false } });
    expect(off.smart_notes.enabled).toBe(false);
    expect(sampleLiveConfig(boot, off).smart_notes.enabled).toBe(true);
    const project = { smart_notes: { enabled: false, retina_handoff: true } };
    const warnings = stripUnsafeProjectConfigFields(project);
    expect(project.smart_notes).toEqual({ retina_handoff: true } as never);
    expect(warnings.join(" ")).toContain("smart_notes.enabled");
});

test("disabled dreamer task and compiled sweep leave pending notes unchecked", async () => {
    const db = fixture();
    const project = "git:smart-notes-enabled";
    addNote(db, "smart", {
        projectPath: project,
        sessionId: "ses-off",
        content: "parked",
        surfaceCondition: "repository condition",
    });
    const config = parsePluginConfig({ dreamer: {}, smart_notes: { enabled: false } });
    expect(
        buildDreamTaskRuntimeConfigs(config.dreamer, "opencode", undefined, false).map(
            (t) => t.task,
        ),
    ).not.toContain("evaluate-smart-notes");
    const result = await evaluateSmartNotes({
        db,
        projectIdentity: project,
        smartNotesEnabled: false,
    } as never);
    expect(result).toEqual({ ran: false, pending: 1, surfaced: 0 });
    expect(
        await runDueCompiledSmartNoteChecks({
            db,
            projectIdentity: project,
            projectRoot: dir!,
            smartNotesEnabled: false,
        }),
    ).toEqual({ ran: 0, surfaced: 0, failed: 0, networkFailed: 0 });
    expect(getNotes(db, { projectPath: project })[0]?.lastCheckedAt).toBeNull();
});

test("OpenCode 1 and 2 disabled tool surfaces refuse cached conditions and retain ready/read/dismiss", async () => {
    const db = fixture();
    const config = parsePluginConfig({
        smart_notes: { enabled: false },
        dreamer: {},
        memory: { enabled: false },
    });
    const registry = createToolRegistry({
        ctx: { directory: dir! } as never,
        pluginConfig: config,
    });
    const registered: Array<{
        name: string;
        description: string;
        input: unknown;
        execute: (input: unknown, call: unknown) => Promise<{ content: string }>;
    }> = [];
    await registerTools(
        {
            location: { directory: dir },
            tool: {
                transform: async (callback: (editor: unknown) => void) =>
                    callback({ add: (definition: never) => registered.push(definition) }),
            },
        } as never,
        db,
        config,
    );
    const v2 = registered.find((t) => t.name === "ctx_note")!;
    expect(v2).toBeDefined();
    expect(
        JSON.stringify({
            description: registry.ctx_note.description,
            schema: tool.schema.toJSONSchema(tool.schema.object(registry.ctx_note.args)),
        }),
    ).not.toMatch(/surface_condition|smart.note|outside checker/i);
    expect(JSON.stringify({ description: v2.description, schema: v2.input })).not.toMatch(
        /surface_condition|smart.note|outside checker/i,
    );
    const call = { sessionID: "ses-off", messageID: "msg-off", agent: "build", progress: () => {} };
    expect(
        await registry.ctx_note.execute(
            { content: "old", surface_condition: "cached" } as never,
            { ...call, directory: dir } as never,
        ),
    ).toContain("Smart notes are disabled");
    expect(
        (await v2.execute({ content: "old", surface_condition: "cached" }, call)).content,
    ).toContain("Smart notes are disabled");
    expect(getNotes(db, {})).toHaveLength(0);
    const local = createCtxNoteTools({
        db,
        smartNotesEnabled: false,
        resolveProjectPath: () => "git:fixture",
    }).ctx_note;
    const ready = addNote(db, "smart", {
        projectPath: "git:fixture",
        content: "already fired",
        surfaceCondition: "done",
    });
    const pending = addNote(db, "smart", {
        projectPath: "git:fixture",
        content: "still parked",
        surfaceCondition: "later",
    });
    markNoteReady(db, ready.id, "already true");
    onNoteTrigger(db, "ses-off", "historian_complete");
    expect(peekNoteNudgeText(db, "ses-off", "u-1", "git:fixture")).toBeNull();
    expect(peekNoteNudgeText(db, "ses-off", "u-2", "git:fixture")).toContain("already fired");
    const ctx = { sessionID: "ses-off", directory: dir } as never;
    expect(await local.execute({ action: "read" }, ctx)).toContain("already fired");
    expect(await local.execute({ action: "read", note_ids: [pending.id] }, ctx)).toContain(
        "still parked",
    );
    expect(
        await local.execute({ action: "dismiss", note_ids: [ready.id, pending.id] }, ctx),
    ).toContain("Dismissed 2 of 2");
});

test("enabled ctx_note schema and description match master golden on both OpenCode versions", () => {
    for (const preset of ["full", "light"] as const)
        for (const enabled of [undefined, true]) {
            const definition = createCtxNoteTools({
                db: null as never,
                smartNotesEnabled: enabled,
            }).ctx_note;
            const schema = tool.schema.toJSONSchema(tool.schema.object(definition.args));
            applyJsonSchemaParameterDescriptions("ctx_note", schema, preset);
            expect(
                digest({
                    description:
                        preset === "light" ? CTX_NOTE_LIGHT_DESCRIPTION : definition.description,
                    schema,
                }),
            ).toBe(expected[`opencode/${preset}`]);
        }
});

test("disabled status omits parked task backlog and historical failure without deleting them", () => {
    const db = fixture();
    const projectPath = resolveProjectIdentityForSession(dir!)!;
    writeTaskScheduleState(db, {
        projectPath,
        task: "evaluate-smart-notes",
        schedule: "0 3 * * *",
        lastRunAt: null,
        nextDueAt: 1,
        lastStatus: "failed",
        lastError: "old evaluation failure",
        retryCount: 2,
    });
    const on = buildSidebarSnapshot(db, "ses-status", dir!, undefined, undefined, {
        smart_notes: { enabled: true },
    });
    expect(on.dreamerFailures?.map((state) => state.task)).toContain("evaluate-smart-notes");
    const off = buildSidebarSnapshot(db, "ses-status", dir!, undefined, undefined, {
        smart_notes: { enabled: false },
    });
    expect(off.dreamerBacklog).not.toHaveProperty("evaluate-smart-notes");
    expect(off.dreamerFailures?.map((state) => state.task)).not.toContain("evaluate-smart-notes");
    expect(
        buildSidebarSnapshot(db, "ses-status", dir!, undefined, undefined, {
            smart_notes: { enabled: true },
        }).dreamerFailures?.map((state) => state.task),
    ).toContain("evaluate-smart-notes");
});
