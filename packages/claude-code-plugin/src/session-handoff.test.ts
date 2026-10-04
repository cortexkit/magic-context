import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    claudePidFromEnv,
    pruneSessionHandoffs,
    readCurrentSession,
    recordCurrentSession,
} from "./session-handoff";

const handoffDir = () => join(tmpdir(), "claude-code", "magic-context", "sessions");

describe("session hand-off", () => {
    test("the latest record for a Claude Code process wins", () => {
        const now = Date.now();
        recordCurrentSession(40001, { sessionId: "first", directory: "/work/app", updatedAt: now });
        recordCurrentSession(40001, {
            sessionId: "after-clear",
            directory: "/work/app",
            updatedAt: now,
        });
        expect(readCurrentSession(40001, now - 1000)).toEqual({
            sessionId: "after-clear",
            directory: "/work/app",
            updatedAt: now,
        });
        expect(readCurrentSession(40002, 0)).toBeNull();
    });

    test("a record from before the server started belongs to an earlier process", () => {
        recordCurrentSession(40003, { sessionId: "old", directory: "/w", updatedAt: 1000 });
        expect(readCurrentSession(40003, 2000)).toBeNull();
        expect(readCurrentSession(40003, 500)?.sessionId).toBe("old");
    });

    test("ignores unreadable or malformed records", () => {
        mkdirSync(handoffDir(), { recursive: true });
        writeFileSync(join(handoffDir(), "40004.json"), "{not json");
        writeFileSync(
            join(handoffDir(), "40005.json"),
            JSON.stringify({ sessionId: "../x", directory: "/w", updatedAt: Date.now() }),
        );
        expect(readCurrentSession(40004, 0)).toBeNull();
        expect(readCurrentSession(40005, 0)).toBeNull();
    });

    test("prunes records untouched for a week", () => {
        recordCurrentSession(40006, { sessionId: "stale", directory: "/w", updatedAt: 1 });
        recordCurrentSession(40007, { sessionId: "fresh", directory: "/w", updatedAt: 1 });
        const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
        utimesSync(join(handoffDir(), "40006.json"), old, old);
        expect(pruneSessionHandoffs()).toBeGreaterThanOrEqual(1);
        expect(existsSync(join(handoffDir(), "40006.json"))).toBe(false);
        expect(existsSync(join(handoffDir(), "40007.json"))).toBe(true);
    });

    test("reads Claude Code's PID from CLAUDE_PID", () => {
        expect(claudePidFromEnv({ CLAUDE_PID: "2940684" })).toBe(2940684);
        expect(claudePidFromEnv({ CLAUDE_PID: "1" })).toBeNull();
        expect(claudePidFromEnv({ CLAUDE_PID: "abc" })).toBeNull();
        expect(claudePidFromEnv({})).toBeNull();
    });
});
