/// <reference types="bun-types" />

/**
 * Regression suite for `createSystemPromptHashHandler`'s drain semantics.
 *
 * Oracle review 2026-04-26 Finding A1 caught a real bug: the handler's
 * unconditional drain of `systemPromptRefreshSessions` at the end of the
 * handler was silently dropping the flag added by hash-change detection
 * earlier in the same handler call. That meant a real prompt-content
 * change set the flag, then immediately discarded it before any future
 * pass could observe it — adjuncts (project docs, user profile, key
 * files) stayed stale forever.
 *
 * The fix made the drain conditional on the value of `isCacheBusting`
 * captured at the top of the handler. These tests lock that contract in.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    openDatabase,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { createSystemPromptHashHandler } from "./system-prompt-hash";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

function useTempDataHome(prefix: string): void {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

afterEach(() => {
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
});

function buildHandler(opts?: {
    historyRefreshSessions?: Set<string>;
    systemPromptRefreshSessions?: Set<string>;
    pendingMaterializationSessions?: Set<string>;
}): ReturnType<typeof createSystemPromptHashHandler> {
    return createSystemPromptHashHandler({
        db: openDatabase(),
        protectedTags: 1,
        ctxReduceEnabled: true,
        dropToolStructure: true,
        dreamerEnabled: false,
        injectDocs: false,
        directory: "/tmp",
        historyRefreshSessions: opts?.historyRefreshSessions ?? new Set<string>(),
        systemPromptRefreshSessions: opts?.systemPromptRefreshSessions ?? new Set<string>(),
        pendingMaterializationSessions: opts?.pendingMaterializationSessions ?? new Set<string>(),
        lastHeuristicsTurnId: new Map<string, string>(),
    });
}

describe("system-prompt-hash drain semantics (Oracle review 2026-04-26 Finding A1)", () => {
    it("drains pre-existing systemPromptRefresh flag set by /ctx-flush", async () => {
        useTempDataHome("sph-drain-existing-");
        const sessionId = "ses-existing-flag";
        const systemPromptRefreshSessions = new Set<string>([sessionId]);

        const { handler } = buildHandler({ systemPromptRefreshSessions });

        // Seed a prior hash so this looks like an existing session, no
        // hash change on this pass.
        const db = openDatabase();
        getOrCreateSessionMeta(db, sessionId);
        updateSessionMeta(db, sessionId, {
            systemPromptHash: "deadbeef",
            systemPromptTokens: 100,
        });

        await handler({ sessionID: sessionId }, { system: ["You are a helpful agent."] });

        // Flag was set on entry → handler consumed it → drain.
        expect(systemPromptRefreshSessions.has(sessionId)).toBe(false);
    });

    it("does NOT drain just-added flag from hash-change detection (the bug Oracle caught)", async () => {
        useTempDataHome("sph-drain-just-added-");
        const sessionId = "ses-hash-change";
        const systemPromptRefreshSessions = new Set<string>(); // empty on entry
        const historyRefreshSessions = new Set<string>();
        const pendingMaterializationSessions = new Set<string>();

        const { handler } = buildHandler({
            historyRefreshSessions,
            systemPromptRefreshSessions,
            pendingMaterializationSessions,
        });

        // Seed a prior hash that will mismatch the prompt below.
        const db = openDatabase();
        getOrCreateSessionMeta(db, sessionId);
        updateSessionMeta(db, sessionId, {
            systemPromptHash: "stalehash",
            systemPromptTokens: 100,
        });

        await handler(
            { sessionID: sessionId },
            { system: ["You are a helpful agent.", "New system content here"] },
        );

        // Hash detection added all three signals.
        expect(historyRefreshSessions.has(sessionId)).toBe(true);
        expect(pendingMaterializationSessions.has(sessionId)).toBe(true);

        // CRITICAL: systemPromptRefreshSessions was added by hash-change
        // detection AFTER `isCacheBusting` was captured at the top of
        // the handler. The drain at the end is conditional on that
        // captured value (false in this case), so the just-added flag
        // must SURVIVE for the next pass to consume.
        expect(systemPromptRefreshSessions.has(sessionId)).toBe(true);
    });

    it("does NOT drain if handler short-circuits before the drain (early return)", async () => {
        useTempDataHome("sph-drain-early-return-");
        const sessionId = "ses-empty-prompt";
        const systemPromptRefreshSessions = new Set<string>([sessionId]);

        const { handler } = buildHandler({ systemPromptRefreshSessions });

        // Empty system prompt triggers early return at line 375.
        await handler({ sessionID: sessionId }, { system: [] });

        // The handler returned early before reaching the drain. With the
        // OLD unconditional drain, the flag would have been dropped
        // anyway because the early return is BEFORE the drain. With the
        // current code structure, the drain still only fires after Step
        // 3 — so this test documents that early returns preserve the
        // flag for a future valid pass to consume.
        //
        // Note: this is a low-severity Oracle finding D — the main fix
        // was for Finding A1, but the conditional drain also makes
        // early-return paths safer by default.
        expect(systemPromptRefreshSessions.has(sessionId)).toBe(true);
    });

    it("on subsequent pass after hash-change pass, drains the surviving flag", async () => {
        useTempDataHome("sph-drain-followup-");
        const sessionId = "ses-followup";
        const systemPromptRefreshSessions = new Set<string>();
        const historyRefreshSessions = new Set<string>();
        const pendingMaterializationSessions = new Set<string>();

        const { handler } = buildHandler({
            historyRefreshSessions,
            systemPromptRefreshSessions,
            pendingMaterializationSessions,
        });

        const db = openDatabase();
        getOrCreateSessionMeta(db, sessionId);
        updateSessionMeta(db, sessionId, {
            systemPromptHash: "stalehash",
            systemPromptTokens: 100,
        });

        // Pass 1: hash mismatch → flag added but survives.
        await handler({ sessionID: sessionId }, { system: ["New prompt content"] });
        expect(systemPromptRefreshSessions.has(sessionId)).toBe(true);

        // Pass 2: same prompt content (hash now matches stored value
        // from Pass 1). Flag was set on entry → handler reads adjuncts
        // with isCacheBusting=true → drain.
        await handler({ sessionID: sessionId }, { system: ["New prompt content"] });
        expect(systemPromptRefreshSessions.has(sessionId)).toBe(false);
    });
});
