/**
 * Which session a Claude Code process is on now.
 *
 * Claude Code starts the MCP server once per process, with the session id of that
 * moment in its environment. `/clear` and `/resume` move the process to another
 * session without restarting the server (observed with Claude Code 2.1), so the
 * server's own id goes stale. The SessionStart hook runs on every move, so it
 * records the current session for its Claude Code process, and the server reads
 * that record before each tool call.
 *
 * The process is identified by its PID: the MCP server is Claude Code's direct
 * child (`process.ppid`), and Claude Code passes its PID to hooks as `CLAUDE_PID`.
 * When either is missing the server keeps the session it started with.
 */

import {
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getMagicContextTempDir } from "@magic-context/core/shared/data-path";
import { isValidSessionId } from "./session";

export interface SessionHandoff {
    sessionId: string;
    /** Project directory of the session. */
    directory: string;
    updatedAt: number;
}

const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

function handoffDirectory(): string {
    return join(getMagicContextTempDir("claude-code"), "sessions");
}

function handoffPath(claudePid: number): string {
    return join(handoffDirectory(), `${claudePid}.json`);
}

/** Claude Code's PID as hooks see it, or null when it is not provided. */
export function claudePidFromEnv(env: NodeJS.ProcessEnv = process.env): number | null {
    const pid = Number(env.CLAUDE_PID);
    return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

/** Record the session a Claude Code process just started, resumed or cleared into. */
export function recordCurrentSession(claudePid: number, handoff: SessionHandoff): void {
    mkdirSync(handoffDirectory(), { recursive: true, mode: 0o700 });
    const path = handoffPath(claudePid);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(handoff), { mode: 0o600 });
    renameSync(temporary, path);
}

/**
 * The session a Claude Code process recorded, or null. A record older than
 * `notBefore` belongs to an earlier process that had the same PID.
 */
export function readCurrentSession(claudePid: number, notBefore: number): SessionHandoff | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(handoffPath(claudePid), "utf8"));
    } catch {
        return null;
    }
    if (parsed === null || typeof parsed !== "object") return null;
    const { sessionId, directory, updatedAt } = parsed as Record<string, unknown>;
    if (!isValidSessionId(sessionId) || typeof directory !== "string") return null;
    if (typeof updatedAt !== "number" || updatedAt < notBefore) return null;
    return { sessionId, directory, updatedAt };
}

/** Remove records no live process can still be reading. */
export function pruneSessionHandoffs(now: number = Date.now()): number {
    let entries: string[];
    try {
        entries = readdirSync(handoffDirectory());
    } catch {
        return 0;
    }
    let removed = 0;
    for (const entry of entries) {
        const path = join(handoffDirectory(), entry);
        try {
            if (now - statSync(path).mtimeMs > STALE_AFTER_MS) {
                rmSync(path, { force: true });
                removed++;
            }
        } catch {
            // Another hook removed it first.
        }
    }
    return removed;
}
