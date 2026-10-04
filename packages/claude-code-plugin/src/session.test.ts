import { describe, expect, test } from "bun:test";
import { utimesSync } from "node:fs";
import { join } from "node:path";
import { createTestTempDir } from "@magic-context/core/shared/test-temp-dir";
import { isValidSessionId, resolveHookSession, resolveMcpSession } from "./session";
import { userRecord, writeTranscript } from "./test-fixtures";

describe("resolveMcpSession", () => {
    test("uses the session id and project directory Claude Code exports", () => {
        const session = resolveMcpSession(
            {
                CLAUDE_CODE_SESSION_ID: "9100ae28-d193-40f3-807c-585c9445efe8",
                CLAUDE_PROJECT_DIR: "/work/app",
            },
            "/somewhere/else",
        );
        expect(session).toEqual({
            sessionId: "9100ae28-d193-40f3-807c-585c9445efe8",
            directory: "/work/app",
            source: "env",
        });
    });

    test("without the variables, takes the project's newest transcript", () => {
        const { dir } = createTestTempDir("mc-claude-code-session-");
        const configDir = join(dir, "claude");
        const older = writeTranscript(configDir, "/work/app", "older-session", [userRecord("a")]);
        writeTranscript(configDir, "/work/app", "newer-session", [userRecord("b")]);
        utimesSync(older, new Date(2020, 0, 1), new Date(2020, 0, 1));
        const session = resolveMcpSession({ CLAUDE_CONFIG_DIR: configDir }, "/work/app");
        expect(session).toEqual({
            sessionId: "newer-session",
            directory: "/work/app",
            source: "newest-transcript",
        });
    });

    test("falls back to a stable per-project id when there is nothing else", () => {
        const { dir } = createTestTempDir("mc-claude-code-session-fallback-");
        const env = { CLAUDE_CONFIG_DIR: join(dir, "claude") };
        const first = resolveMcpSession(env, "/work/app");
        expect(first.source).toBe("project-fallback");
        expect(first.sessionId).toMatch(/^claude-code-[0-9a-f]{16}$/);
        expect(resolveMcpSession(env, "/work/app").sessionId).toBe(first.sessionId);
        expect(resolveMcpSession(env, "/work/other").sessionId).not.toBe(first.sessionId);
    });

    test("ignores a malformed session id", () => {
        const { dir } = createTestTempDir("mc-claude-code-session-bad-");
        const session = resolveMcpSession(
            { CLAUDE_CODE_SESSION_ID: "../../etc", CLAUDE_CONFIG_DIR: join(dir, "claude") },
            "/work/app",
        );
        expect(session.source).toBe("project-fallback");
    });
});

describe("resolveHookSession", () => {
    test("reads session_id and cwd from the payload", () => {
        expect(resolveHookSession({ session_id: "abc-123", cwd: "/work/app" }, {}, "/x")).toEqual({
            sessionId: "abc-123",
            directory: "/work/app",
            source: "hook",
        });
    });

    test("CLAUDE_PROJECT_DIR wins over the payload cwd", () => {
        const session = resolveHookSession(
            { session_id: "abc-123", cwd: "/work/app/sub" },
            { CLAUDE_PROJECT_DIR: "/work/app" },
        );
        expect(session?.directory).toBe("/work/app");
    });

    test("falls back to the environment, then gives up", () => {
        expect(
            resolveHookSession({}, { CLAUDE_CODE_SESSION_ID: "from-env" }, "/w")?.sessionId,
        ).toBe("from-env");
        expect(resolveHookSession({ session_id: 42 }, {}, "/w")).toBeNull();
    });
});

test("isValidSessionId accepts Claude Code ids and rejects path-like values", () => {
    expect(isValidSessionId("552e06f0-5012-45be-973f-29c4fb7cdc36")).toBe(true);
    expect(isValidSessionId("a/b")).toBe(false);
    expect(isValidSessionId("")).toBe(false);
    expect(isValidSessionId(undefined)).toBe(false);
});
