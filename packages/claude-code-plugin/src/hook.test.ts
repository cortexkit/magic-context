import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestTempDir } from "@magic-context/core/shared/test-temp-dir";
import { setCaptureScope } from "./capture";
import { saveSkill } from "./operation-skills/store";
import { readCurrentSession } from "./session-handoff";
import {
    assistantRecord,
    toJsonl,
    toolResultRecord,
    toolUseBlock,
    userRecord,
} from "./test-fixtures";

const HOOK = join(import.meta.dir, "hook.ts");
const STOP_HOOK = join(import.meta.dir, "stop-hook.ts");
const PROMPT_HOOK = join(import.meta.dir, "prompt-hook.ts");

/** Run the hook as Claude Code does: a child process with the payload on stdin. */
function runHook(event: string, stdin: string, env: Record<string, string> = {}) {
    const result = spawnSync(process.execPath, [HOOK, event], {
        input: stdin,
        encoding: "utf8",
        env: { ...process.env, ...env },
        timeout: 30_000,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("hook command", () => {
    test("SessionStart prints additionalContext for Claude Code", () => {
        const { dir } = createTestTempDir("mc-claude-code-hook-");
        const project = join(dir, "project");
        mkdirSync(project);
        const result = runHook(
            "session-start",
            JSON.stringify({
                session_id: "hook-session-1",
                transcript_path: join(dir, "missing.jsonl"),
                cwd: project,
                hook_event_name: "SessionStart",
                source: "compact",
            }),
        );
        expect(result.status).toBe(0);
        const output = JSON.parse(result.stdout);
        expect(output.hookSpecificOutput.hookEventName).toBe("SessionStart");
        expect(output.hookSpecificOutput.additionalContext).toContain("<magic-context>");
        expect(output.hookSpecificOutput.additionalContext).toContain(
            "Claude Code just compacted this conversation",
        );
    });

    test("records the session for the Claude Code process that ran it", () => {
        const { dir } = createTestTempDir("mc-claude-code-hook-handoff-");
        const result = runHook(
            "session-start",
            JSON.stringify({ session_id: "after-clear-1", cwd: dir, source: "clear" }),
            { CLAUDE_PID: "41001" },
        );
        expect(result.status).toBe(0);
        expect(readCurrentSession(41001, Date.now() - 60_000)).toMatchObject({
            sessionId: "after-clear-1",
            directory: dir,
        });
    });

    test("the Stop hook asks the session's model to capture verified work, once", () => {
        const { dir } = createTestTempDir("mc-claude-code-stop-hook-");
        const transcriptPath = join(dir, "s.jsonl");
        writeFileSync(
            transcriptPath,
            toJsonl([
                userRecord("make the save button persist"),
                assistantRecord("m1", [toolUseBlock("e1", "Edit", { file_path: "a.ts" })]),
                toolResultRecord("e1", "ok"),
                assistantRecord("m2", [toolUseBlock("b1", "Bash", { command: "npm test" })]),
                toolResultRecord("b1", "passed"),
            ]),
        );
        const stop = (active: boolean) =>
            spawnSync(process.execPath, [STOP_HOOK], {
                input: JSON.stringify({
                    session_id: "stop-hook-1",
                    transcript_path: transcriptPath,
                    hook_event_name: "Stop",
                    stop_hook_active: active,
                }),
                encoding: "utf8",
                env: { ...process.env, MAGIC_CONTEXT_CAPTURE_AFTER: "2" },
            });
        const first = stop(false);
        expect(first.status).toBe(0);
        const output = JSON.parse(first.stdout);
        expect(output.decision).toBe("block");
        expect(output.reason).toContain("ctx_skill");
        const second = stop(true);
        expect(second.status).toBe(0);
        expect(second.stdout).toBe("");
        const garbage = spawnSync(process.execPath, [STOP_HOOK], {
            input: "nope",
            encoding: "utf8",
        });
        expect(garbage.status).toBe(0);
        expect(garbage.stdout).toBe("");
    });

    test("UserPromptSubmit adds the recorded operation a prompt names", () => {
        const { dir } = createTestTempDir("mc-claude-code-prompt-hook-");
        mkdirSync(join(dir, "web"));
        writeFileSync(join(dir, "web/app.js"), "save.onclick = saveNote;\n");
        saveSkill(dir, {
            name: "notes",
            title: "备注",
            description: "Notes.",
            operations: [
                {
                    id: "save-note",
                    trigger: { kind: "button", label: "保存备注", location: "web/app.js:1" },
                    action: { summary: "POSTs the note" },
                    apis: [{ method: "POST", endpoint: "/api/notes" }],
                    writes: [{ target: "data/notes.json" }],
                    state: [],
                    filesToModify: [],
                    steps: ["curl -X POST $BASE/api/notes"],
                    verification: { method: "curl" },
                },
            ],
        });
        const sessionId = `prompt-hook-${Date.now()}`;
        const prompt = (text: string) =>
            spawnSync(process.execPath, [PROMPT_HOOK], {
                input: JSON.stringify({
                    session_id: sessionId,
                    cwd: dir,
                    hook_event_name: "UserPromptSubmit",
                    prompt: text,
                }),
                encoding: "utf8",
                env: { ...process.env, CLAUDE_PROJECT_DIR: "" },
            });
        const hit = prompt("点一下保存备注");
        expect(hit.status).toBe(0);
        const output = JSON.parse(hit.stdout).hookSpecificOutput;
        expect(output.hookEventName).toBe("UserPromptSubmit");
        expect(output.additionalContext).toContain("`POST /api/notes`");
        expect(prompt("hello").stdout).toBe("");

        setCaptureScope(sessionId, { disabled: true, memoryDisabled: false });
        expect(prompt("点一下保存备注").stdout).toBe("");
        const garbage = spawnSync(process.execPath, [PROMPT_HOOK], {
            input: "nope",
            encoding: "utf8",
        });
        expect(garbage.status).toBe(0);
        expect(garbage.stdout).toBe("");
    });

    test("never fails the session: bad input and unknown events exit 0 without output", () => {
        for (const [event, stdin] of [
            ["session-start", "not json"],
            ["session-start", "[]"],
            ["something-else", "{}"],
        ] as const) {
            const result = runHook(event, stdin);
            expect(result.status).toBe(0);
            expect(result.stdout).toBe("");
        }
    });

    test("an unusable store becomes a one-line notice for the user", () => {
        const { dir } = createTestTempDir("mc-claude-code-hook-store-");
        const result = runHook(
            "session-start",
            JSON.stringify({ session_id: "hook-session-2", cwd: dir, source: "startup" }),
            // A regular file where the storage directory should be.
            {
                NODE_ENV: "production",
                MAGIC_CONTEXT_TEST_DATA_DIR: "",
                MAGIC_CONTEXT_STORAGE_DIR: join(import.meta.dir, "hook.ts"),
            },
        );
        expect(result.status).toBe(0);
        const output = JSON.parse(result.stdout);
        expect(output.systemMessage).toStartWith("Magic Context memory is not loaded.");
        expect(output.hookSpecificOutput).toBeUndefined();
    });
});
