/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
    clearDeferredExecutePendingIfMatches,
    type DeferredExecutePayload,
    peekDeferredExecutePending,
    setDeferredExecutePendingIfAbsent,
} from "../../features/magic-context/storage-meta-persisted";
import { ensureSessionMetaRow } from "../../features/magic-context/storage-meta-shared";
import { Database } from "../../shared/sqlite";
import {
    applyMidTurnDeferral,
    type BypassReason,
    detectMidTurnBypassReason,
} from "./boundary-execution";

function createDb(): Database {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE session_meta (
            session_id TEXT PRIMARY KEY,
            harness TEXT NOT NULL DEFAULT 'opencode',
            last_response_time INTEGER NOT NULL DEFAULT 0,
            cache_ttl TEXT NOT NULL DEFAULT '5m',
            counter INTEGER NOT NULL DEFAULT 0,
            last_nudge_tokens INTEGER NOT NULL DEFAULT 0,
            last_nudge_band TEXT NOT NULL DEFAULT '',
            last_transform_error TEXT NOT NULL DEFAULT '',
            is_subagent INTEGER NOT NULL DEFAULT 0,
            last_context_percentage REAL NOT NULL DEFAULT 0,
            last_input_tokens INTEGER NOT NULL DEFAULT 0,
            times_execute_threshold_reached INTEGER NOT NULL DEFAULT 0,
            compartment_in_progress INTEGER NOT NULL DEFAULT 0,
            system_prompt_hash TEXT NOT NULL DEFAULT '',
            system_prompt_tokens INTEGER NOT NULL DEFAULT 0,
            conversation_tokens INTEGER NOT NULL DEFAULT 0,
            tool_call_tokens INTEGER NOT NULL DEFAULT 0,
            cleared_reasoning_through_tag INTEGER NOT NULL DEFAULT 0,
            last_todo_state TEXT NOT NULL DEFAULT '',
            deferred_execute_state TEXT
        )
    `);
    return db;
}

function flag(id = "flag-1"): DeferredExecutePayload {
    return { id, reason: "execute-none", recordedAt: 1_700_000_000_000 };
}

function applyGate(input: {
    db: Database;
    sessionId: string;
    base: "execute" | "defer";
    midTurn: boolean;
    percentage?: number;
    historyRefresh?: boolean;
    isSubagent?: boolean;
}): { effective: "execute" | "defer"; sideEffect: "set-flag" | "none"; bypass: BypassReason } {
    const historyRefreshSessions = new Set<string>();
    if (input.historyRefresh) historyRefreshSessions.add(input.sessionId);
    const bypass = detectMidTurnBypassReason({
        contextUsage: { percentage: input.percentage ?? 0 },
        sessionMeta: { isSubagent: input.isSubagent ?? false },
        historyRefreshSessions,
        sessionId: input.sessionId,
    });
    const { midTurnAdjustedSchedulerDecision, sideEffect } = applyMidTurnDeferral({
        base: input.base,
        bypassReason: bypass,
        midTurn: input.midTurn,
    });
    if (sideEffect === "set-flag") {
        setDeferredExecutePendingIfAbsent(input.db, input.sessionId, flag("gate-flag"));
    } else {
        ensureSessionMetaRow(input.db, input.sessionId);
    }
    return { effective: midTurnAdjustedSchedulerDecision, sideEffect, bypass };
}

function drainIfWorkExecuted(db: Database, sessionId: string): boolean {
    const current = peekDeferredExecutePending(db, sessionId);
    if (current === null) return false;
    return clearDeferredExecutePendingIfMatches(db, sessionId, current);
}

describe("boundary execution OpenCode integration", () => {
    it("1. mid-turn execute without prior flag defers and sets a flag", () => {
        const db = createDb();
        const result = applyGate({ db, sessionId: "s1", base: "execute", midTurn: true });
        expect(result).toEqual({ effective: "defer", sideEffect: "set-flag", bypass: "none" });
        expect(peekDeferredExecutePending(db, "s1")?.id).toBe("gate-flag");
    });

    it("2. boundary execute without prior flag executes and drain no-ops", () => {
        const db = createDb();
        const result = applyGate({ db, sessionId: "s1", base: "execute", midTurn: false });
        expect(result.effective).toBe("execute");
        expect(drainIfWorkExecuted(db, "s1")).toBe(false);
    });

    it("3. boundary execute with prior flag executes and drains", () => {
        const db = createDb();
        setDeferredExecutePendingIfAbsent(db, "s1", flag());
        const result = applyGate({ db, sessionId: "s1", base: "execute", midTurn: false });
        expect(result.effective).toBe("execute");
        expect(drainIfWorkExecuted(db, "s1")).toBe(true);
        expect(peekDeferredExecutePending(db, "s1")).toBeNull();
    });

    it("4. boundary defer with prior flag preserves the flag", () => {
        const db = createDb();
        setDeferredExecutePendingIfAbsent(db, "s1", flag());
        const result = applyGate({ db, sessionId: "s1", base: "defer", midTurn: false });
        expect(result.effective).toBe("defer");
        expect(peekDeferredExecutePending(db, "s1")?.id).toBe("flag-1");
    });

    it("5. mid-turn force-materialize bypass executes and drains prior flag", () => {
        const db = createDb();
        setDeferredExecutePendingIfAbsent(db, "s1", flag());
        const result = applyGate({
            db,
            sessionId: "s1",
            base: "execute",
            midTurn: true,
            percentage: 87,
        });
        expect(result.bypass).toBe("force-materialize");
        expect(result.effective).toBe("execute");
        expect(drainIfWorkExecuted(db, "s1")).toBe(true);
    });

    it("6. emergency await style force pass drains prior flag", () => {
        const db = createDb();
        setDeferredExecutePendingIfAbsent(db, "s1", flag());
        const result = applyGate({
            db,
            sessionId: "s1",
            base: "execute",
            midTurn: false,
            percentage: 95,
        });
        expect(result.bypass).toBe("force-materialize");
        expect(drainIfWorkExecuted(db, "s1")).toBe(true);
    });

    it("7. prior flag is not overwritten by a second mid-turn defer", () => {
        const db = createDb();
        setDeferredExecutePendingIfAbsent(db, "s1", flag("original"));
        const result = applyGate({ db, sessionId: "s1", base: "execute", midTurn: true });
        expect(result.sideEffect).toBe("set-flag");
        expect(peekDeferredExecutePending(db, "s1")?.id).toBe("original");
    });

    it("8. mid-turn explicit-bust bypass executes and drains", () => {
        const db = createDb();
        setDeferredExecutePendingIfAbsent(db, "s1", flag());
        const result = applyGate({
            db,
            sessionId: "s1",
            base: "execute",
            midTurn: true,
            historyRefresh: true,
        });
        expect(result.bypass).toBe("explicit-bust");
        expect(result.effective).toBe("execute");
        expect(drainIfWorkExecuted(db, "s1")).toBe(true);
    });

    it("8.5. history refresh producers also signal pending materialization", () => {
        expect(findUnpairedOpenCodeProducers()).toEqual([]);
        expect(findUnpairedPiProducers()).toEqual([]);
    });

    it("9. subagent mid-turn bypasses deferral", () => {
        const db = createDb();
        const result = applyGate({
            db,
            sessionId: "s1",
            base: "execute",
            midTurn: true,
            isSubagent: true,
        });
        expect(result.bypass).toBe("subagent");
        expect(result.effective).toBe("execute");
    });

    it("10. drain only on success preserves a prior flag when work fails", () => {
        const db = createDb();
        setDeferredExecutePendingIfAbsent(db, "s1", flag());
        const workExecutedSuccessfully = false;
        if (workExecutedSuccessfully) drainIfWorkExecuted(db, "s1");
        expect(peekDeferredExecutePending(db, "s1")?.id).toBe("flag-1");
    });

    it("11. no-op successful execute work still drains the flag", () => {
        const db = createDb();
        setDeferredExecutePendingIfAbsent(db, "s1", flag());
        const pendingOpsRanSuccessfully = true;
        if (pendingOpsRanSuccessfully) drainIfWorkExecuted(db, "s1");
        expect(peekDeferredExecutePending(db, "s1")).toBeNull();
    });
});

function repoRoot(): string {
    return process.cwd().endsWith(join("packages", "plugin"))
        ? join(process.cwd(), "../..")
        : process.cwd();
}

function sourceFiles(dir: string): string[] {
    const result: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) result.push(...sourceFiles(full));
        else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
            result.push(full);
        }
    }
    return result;
}

function blockAround(source: string, index: number): string {
    let depth = 0;
    let start = 0;
    for (let i = index; i >= 0; i--) {
        const ch = source[i];
        if (ch === "}") depth++;
        if (ch === "{") {
            if (depth === 0) {
                start = i;
                break;
            }
            depth--;
        }
    }
    depth = 0;
    let end = source.length;
    for (let i = start; i < source.length; i++) {
        const ch = source[i];
        if (ch === "{") depth++;
        if (ch === "}") {
            depth--;
            if (depth === 0) {
                end = i;
                break;
            }
        }
    }
    return source.slice(start, end);
}

function findUnpairedOpenCodeProducers(): string[] {
    const root = repoRoot();
    const base = join(root, "packages/plugin/src");
    const failures: string[] = [];
    for (const file of sourceFiles(base)) {
        const source = readFileSync(file, "utf8");
        for (const match of source.matchAll(/historyRefreshSessions\.add\(/g)) {
            if (
                !blockAround(source, match.index ?? 0).includes(
                    "pendingMaterializationSessions.add(",
                )
            ) {
                failures.push(relative(root, file));
            }
        }
    }
    return failures;
}

function findUnpairedPiProducers(): string[] {
    const root = repoRoot();
    const base = join(root, "packages/pi-plugin/src");
    const failures: string[] = [];
    for (const file of sourceFiles(base)) {
        const source = readFileSync(file, "utf8");
        for (const match of source.matchAll(/signalPiHistoryRefresh\(/g)) {
            const prefix = source.slice(Math.max(0, (match.index ?? 0) - 32), match.index ?? 0);
            if (prefix.includes("function ")) continue;
            if (
                !blockAround(source, match.index ?? 0).includes("signalPiPendingMaterialization(")
            ) {
                failures.push(relative(root, file));
            }
        }
    }
    return failures;
}
