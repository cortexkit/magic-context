/**
 * Entry point of the Magic Context hook command (`dist/hook.js <event>`).
 *
 * Claude Code runs it with the hook payload as JSON on stdin and reads JSON from
 * stdout. A hook must never get in the way of a session, so every failure ends in
 * exit code 0 with a note on stderr, and a storage problem is reported to the user
 * as a one-line `systemMessage`.
 */
import "./boot-harness";
import { readFileSync } from "node:fs";
import { flushLogger } from "@magic-context/core/shared/logger";
import { setCaptureScope } from "./capture";
import { buildSessionContext, type SessionStartSource } from "./inject";
import { pruneVanishedTranscriptIndexes } from "./maintenance";
import { openRuntime, StorageUnavailableError } from "./runtime";
import { resolveHookSession } from "./session";
import { claudePidFromEnv, pruneSessionHandoffs, recordCurrentSession } from "./session-handoff";

console.log = console.error;
console.info = console.error;
console.debug = console.error;

const SESSION_START_SOURCES: readonly SessionStartSource[] = [
    "startup",
    "resume",
    "clear",
    "compact",
];

function readPayload(): Record<string, unknown> {
    let raw = "";
    try {
        raw = readFileSync(0, "utf8");
    } catch {
        return {};
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

function emit(output: Record<string, unknown>): void {
    process.stdout.write(`${JSON.stringify(output)}\n`);
}

function sessionStart(payload: Record<string, unknown>): void {
    const session = resolveHookSession(payload);
    if (!session) {
        console.error("[magic-context] SessionStart payload carried no usable session id");
        return;
    }
    const source =
        SESSION_START_SOURCES.find((candidate) => candidate === payload.source) ?? "startup";
    // Tell this process's MCP server which session it now serves, before anything can fail.
    const claudePid = claudePidFromEnv();
    if (claudePid !== null) {
        try {
            recordCurrentSession(claudePid, {
                sessionId: session.sessionId,
                directory: session.directory,
                updatedAt: Date.now(),
            });
        } catch (error) {
            console.error(`[magic-context] could not record the current session: ${String(error)}`);
        }
    }
    let runtime: ReturnType<typeof openRuntime>;
    try {
        runtime = openRuntime(session.directory);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`[magic-context] ${reason}`);
        if (error instanceof StorageUnavailableError) {
            emit({ systemMessage: `Magic Context memory is not loaded. ${reason}` });
        }
        return;
    }
    try {
        setCaptureScope(session.sessionId, {
            disabled: runtime.config.enabled !== true,
            memoryDisabled: runtime.config.memory?.enabled === false,
        });
    } catch (error) {
        console.error(`[magic-context] could not record capture settings: ${String(error)}`);
    }
    try {
        const context = buildSessionContext(runtime, session, source);
        if (context) {
            emit({
                hookSpecificOutput: {
                    hookEventName: "SessionStart",
                    additionalContext: context.text,
                },
            });
        }
        // Housekeeping runs after the context is out, and must never fail the hook.
        try {
            pruneVanishedTranscriptIndexes(runtime.db);
            pruneSessionHandoffs();
        } catch (error) {
            console.error(`[magic-context] index pruning skipped: ${String(error)}`);
        }
    } finally {
        runtime.close();
    }
}

const event = process.argv[2];
try {
    if (event === "session-start") sessionStart(readPayload());
    else console.error(`[magic-context] unknown hook event: ${event ?? "(none)"}`);
} catch (error) {
    console.error(`[magic-context] hook ${event ?? ""} failed: ${String(error)}`);
}
// The core logger buffers on a timer that exiting would cut short.
flushLogger();
process.exit(0);
