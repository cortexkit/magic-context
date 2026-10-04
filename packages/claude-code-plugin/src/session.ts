/**
 * Which Claude Code session and project a Magic Context process belongs to.
 *
 * Claude Code hands both to every MCP server and hook it starts:
 *   - `CLAUDE_CODE_SESSION_ID`: the session id, equal to the `session_id` in hook
 *     payloads and the transcript file's basename.
 *   - `CLAUDE_PROJECT_DIR`: the directory Claude Code was started in. Hooks and
 *     MCP servers also start with it as their working directory.
 *
 * Older Claude Code builds do not export the session id to MCP servers. For
 * those the newest transcript of the project is the best available guess, and a
 * per-project fallback id keeps notes working when no transcript exists yet.
 */

import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { claudeConfigDir, encodeProjectDirectory } from "./transcript";

export type SessionSource = "env" | "hook" | "newest-transcript" | "project-fallback";

export interface ClaudeCodeSession {
    sessionId: string;
    /** Project directory Claude Code was started in. */
    directory: string;
    source: SessionSource;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export function isValidSessionId(value: unknown): value is string {
    return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

export function resolveProjectDirectory(
    env: NodeJS.ProcessEnv = process.env,
    fallback: string = process.cwd(),
): string {
    const fromEnv = env.CLAUDE_PROJECT_DIR?.trim();
    return fromEnv ? fromEnv : fallback;
}

function newestTranscriptSessionId(directory: string, env: NodeJS.ProcessEnv): string | null {
    const projectDirectory = join(
        claudeConfigDir(env),
        "projects",
        encodeProjectDirectory(directory),
    );
    let newest: { id: string; mtimeMs: number } | null = null;
    let entries: string[];
    try {
        entries = readdirSync(projectDirectory);
    } catch {
        return null;
    }
    for (const entry of entries) {
        if (!entry.endsWith(".jsonl")) continue;
        const id = entry.slice(0, -".jsonl".length);
        if (!isValidSessionId(id)) continue;
        try {
            const { mtimeMs } = statSync(join(projectDirectory, entry));
            if (!newest || mtimeMs > newest.mtimeMs) newest = { id, mtimeMs };
        } catch {
            // The file vanished between listing and stat; skip it.
        }
    }
    return newest?.id ?? null;
}

/** The session an MCP server process serves (one process per Claude Code session). */
export function resolveMcpSession(
    env: NodeJS.ProcessEnv = process.env,
    cwd: string = process.cwd(),
): ClaudeCodeSession {
    const directory = resolveProjectDirectory(env, cwd);
    const fromEnv = env.CLAUDE_CODE_SESSION_ID?.trim();
    if (isValidSessionId(fromEnv)) return { sessionId: fromEnv, directory, source: "env" };
    const newest = newestTranscriptSessionId(directory, env);
    if (newest) return { sessionId: newest, directory, source: "newest-transcript" };
    const digest = createHash("sha256").update(directory).digest("hex").slice(0, 16);
    return { sessionId: `claude-code-${digest}`, directory, source: "project-fallback" };
}

/** The session a hook invocation belongs to, from its stdin payload. */
export function resolveHookSession(
    payload: { session_id?: unknown; cwd?: unknown },
    env: NodeJS.ProcessEnv = process.env,
    cwd: string = process.cwd(),
): ClaudeCodeSession | null {
    const sessionId = isValidSessionId(payload.session_id)
        ? payload.session_id
        : (env.CLAUDE_CODE_SESSION_ID?.trim() ?? "");
    if (!isValidSessionId(sessionId)) return null;
    const payloadCwd =
        typeof payload.cwd === "string" && payload.cwd.length > 0 ? payload.cwd : cwd;
    return { sessionId, directory: resolveProjectDirectory(env, payloadCwd), source: "hook" };
}
