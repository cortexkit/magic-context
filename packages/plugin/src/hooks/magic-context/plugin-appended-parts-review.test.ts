/// <reference types="bun-types" />

/**
 * Tests the rule that leaves text parts another OpenCode 1 plugin appends
 * untagged: across an upgrade, a legacy tag must serve exactly the bytes the
 * previous release served while the other plugin's text is unchanged,
 * including on defer passes.
 *
 * "Old" passes run the same code with no foreign-part collector, which is
 * exactly what the release before the rule did: with `foreignTextParts` unset
 * no part is foreign, the legacy scan finds nothing and the ordinal fallback's
 * accept is unchanged.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __resetMessageIndexAsyncForTests } from "../../features/magic-context/message-index-async";
import type { Scheduler } from "../../features/magic-context/scheduler";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import { updateCavemanDepth, updateTagStatus } from "../../features/magic-context/storage-tags";
import { createTagger } from "../../features/magic-context/tagger";
import { __test as transformDecisionTest } from "../../features/magic-context/transform-decision-log";
import type { ContextUsage } from "../../features/magic-context/types";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { collectForeignTextParts } from "./foreign-text-parts";
import { resetLkgSlotsForTest } from "./lkg-slot";
import { __ignoredNotificationTest } from "./send-session-notification";
import { createTransform } from "./transform";

const SESSION = "ses-review-foreign";

type Part = Record<string, unknown>;
const stored = (id: string, text: string): Part => ({ id, type: "text", text });
const appended = (text: string): Part => ({ type: "text", text });

// ── Transform-level: old release for some passes, then the new release ──

const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
let tempDir: string | undefined;

describe("transform-level upgrade witnesses (defer passes)", () => {
    beforeEach(() => {
        __ignoredNotificationTest.setHoldDetector(() => false);
        tempDir = createTestTempDirFromPath(join(tmpdir(), "context-review-foreign-"));
        process.env.XDG_DATA_HOME = tempDir;
        process.env.XDG_CACHE_HOME = tempDir;
    });

    afterEach(() => {
        __ignoredNotificationTest.reset();
        __resetMessageIndexAsyncForTests();
        transformDecisionTest.reset();
        resetLkgSlotsForTest();
        closeDatabase();
        if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = originalXdgDataHome;
        if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
        else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
        if (tempDir)
            rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        tempDir = undefined;
    });

    function harness() {
        const sessionId = SESSION;
        const scheduler: Scheduler = { shouldExecute: () => "defer" };
        const contextUsageMap = new Map<string, { usage: ContextUsage; updatedAt: number }>([
            [sessionId, { usage: { percentage: 30, inputTokens: 60_000 }, updatedAt: Date.now() }],
        ]);
        const db = openDatabase();
        const make = (rule: "old" | "new") =>
            createTransform({
                // A fresh tagger per release: an upgrade restarts the process.
                tagger: createTagger(),
                ...(rule === "new" ? { collectForeignTextParts } : {}),
                scheduler,
                contextUsageMap,
                db,
                historyRefreshSessions: new Set<string>(),
                pendingMaterializationSessions: new Set<string>(),
                lastHeuristicsTurnId: new Map<string, string>(),
                clearReasoningAge: 50,
                protectedTokens: 0,
            });
        const serve = async (
            transform: ReturnType<typeof make>,
            userParts: Part[],
        ): Promise<string> => {
            const messages = [
                {
                    info: { id: "m-user", role: "user", sessionID: sessionId },
                    parts: structuredClone(userParts),
                },
                {
                    info: { id: "m-assistant", role: "assistant", sessionID: sessionId },
                    parts: [{ id: "prt_a", type: "text", text: "Working on it" }],
                },
            ];
            await transform({}, { messages });
            return JSON.stringify(messages);
        };
        return { db, make, serve };
    }

    it("Q1: a legacy tag the old release dropped serves the same bytes after the upgrade", async () => {
        const { db, make, serve } = harness();
        const parts = [stored("prt_1", "Plan this change"), appended("<transition-marker/>")];
        const old = make("old");
        await serve(old, parts);
        // The old release dropped the marker's tag (ctx_reduce + an execute pass).
        updateTagStatus(db, SESSION, 2, "dropped");
        const oldBytes = await serve(old, parts);

        const newBytes = await serve(make("new"), parts);

        expect(newBytes).toBe(oldBytes);
    });

    it("Q1: a legacy tag the old release caveman-compressed serves the same bytes after the upgrade", async () => {
        const { db, make, serve } = harness();
        const marker =
            "<transition-marker>The quick brown fox is really just very quickly jumping over the extremely lazy dog that is basically sleeping.</transition-marker>";
        const parts = [stored("prt_1", "Plan this change"), appended(marker)];
        const old = make("old");
        await serve(old, parts);
        updateCavemanDepth(db, SESSION, 2, 1);
        const oldBytes = await serve(old, parts);

        const newBytes = await serve(make("new"), parts);

        expect(newBytes).toBe(oldBytes);
    });

    it("Q1 control: an active legacy tag with unchanged text is byte-identical across the upgrade", async () => {
        const { make, serve } = harness();
        const parts = [stored("prt_1", "Plan this change"), appended("<transition-marker/>")];
        const old = make("old");
        await serve(old, parts);
        const oldBytes = await serve(old, parts);

        const upgraded = make("new");
        const first = await serve(upgraded, parts);
        const second = await serve(upgraded, parts);

        expect(first).toBe(oldBytes);
        expect(second).toBe(oldBytes);
    });
});
