import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { closeDatabase, openDatabase } from "./storage-db";
import {
    recordHistorianRun,
    summarizeImportance,
    tallyFactsByCategory,
} from "./storage-historian-runs";
import { clearSession } from "./storage-meta-session";
import { deleteSessionScopedRows } from "./storage-session-tables";
import { recordSubagentInvocation } from "./storage-subagent-invocations";

let tempHome: string;
let prevDataHome: string | undefined;

beforeEach(() => {
    prevDataHome = process.env.XDG_DATA_HOME;
    tempHome = createTestTempDirFromPath(join(tmpdir(), "mc-hr-"));
    process.env.XDG_DATA_HOME = tempHome;
    closeDatabase();
});

afterEach(() => {
    closeDatabase();
    if (prevDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevDataHome;
    rmSync(tempHome, { recursive: true, force: true });
});

test("summarizeImportance handles empty + mixed values", () => {
    expect(summarizeImportance([])).toEqual({ min: null, max: null, avg: null });
    expect(summarizeImportance([42])).toEqual({ min: 42, max: 42, avg: 42 });
    expect(summarizeImportance([10, 20, 60])).toEqual({ min: 10, max: 60, avg: 30 });
});

test("tallyFactsByCategory counts by category with UNKNOWN fallback", () => {
    expect(
        tallyFactsByCategory([
            { category: "ARCHITECTURE" },
            { category: "ARCHITECTURE" },
            { category: "CONFIG_VALUES" },
            { category: null },
            {},
        ]),
    ).toEqual({ ARCHITECTURE: 2, CONFIG_VALUES: 1, UNKNOWN: 2 });
});

test("records a success run with full metrics and reads back", () => {
    const db = openDatabase();
    const id = recordHistorianRun(db, {
        sessionId: "ses-1",
        harness: "opencode",
        subagentInvocationId: 99,
        runKind: "incremental",
        status: "success",
        chunkStartOrdinal: 1,
        chunkEndOrdinal: 165,
        unprocessedFrom: 166,
        compartmentsProduced: 3,
        compartmentIdMin: 10,
        compartmentIdMax: 12,
        factsEmitted: 4,
        factsByCategory: { ARCHITECTURE: 3, NAMING: 1 },
        factsPromoted: 3,
        eventsEmitted: 2,
        eventsPublished: 1,
        importanceMin: 25,
        importanceMax: 88,
        importanceAvg: 56.5,
        discardedLast: true,
        legacy: false,
    });
    expect(typeof id).toBe("number");

    const row = db.prepare("SELECT * FROM historian_runs WHERE id = ?").get(id) as Record<
        string,
        unknown
    >;
    expect(row.session_id).toBe("ses-1");
    expect(row.subagent_invocation_id).toBe(99);
    expect(row.run_kind).toBe("incremental");
    expect(row.status).toBe("success");
    expect(row.failure_reason).toBeNull();
    expect(row.chunk_start_ordinal).toBe(1);
    expect(row.chunk_end_ordinal).toBe(165);
    expect(row.unprocessed_from).toBe(166);
    expect(row.compartments_produced).toBe(3);
    expect(row.compartment_id_min).toBe(10);
    expect(row.compartment_id_max).toBe(12);
    expect(row.facts_emitted).toBe(4);
    expect(JSON.parse(row.facts_by_category_json as string)).toEqual({
        ARCHITECTURE: 3,
        NAMING: 1,
        facts_promoted: 3,
        events_published: 1,
    });
    expect(row.events_emitted).toBe(2);
    expect(row.importance_avg).toBe(56.5);
    expect(row.discarded_last).toBe(1);
    expect(row.legacy).toBe(0);
});

test("records an MC-authored failure reason without rewriting it", () => {
    const db = openDatabase();
    const id = recordHistorianRun(db, {
        sessionId: "ses-2",
        harness: "pi",
        runKind: "recomp",
        status: "failed",
        failureReason: "validation: bad output",
    });
    const row = db
        .prepare(
            "SELECT status, failure_reason, compartments_produced, subagent_invocation_id FROM historian_runs WHERE id = ?",
        )
        .get(id) as Record<string, unknown>;
    expect(row.status).toBe("failed");
    expect(row.failure_reason).toBe("validation: bad output");
    expect(row.compartments_produced).toBe(0);
    expect(row.subagent_invocation_id).toBeNull();
});

test("uses provider_error only for missing reasons and caps MC-authored reasons verbatim", () => {
    const db = openDatabase();
    const missingReasonId = recordHistorianRun(db, {
        sessionId: "ses-missing-reason",
        harness: "pi",
        runKind: "incremental",
        status: "failed",
        failureReason: "  ",
    });
    const opencodeMissingReasonId = recordHistorianRun(db, {
        sessionId: "ses-opencode-missing-reason",
        harness: "opencode",
        runKind: "incremental",
        status: "failed",
        failureReason: null,
    });
    const producerReason = "producer_prompt_unfit: 32k window cannot hold the fixed prompt";
    const producerReasonId = recordHistorianRun(db, {
        sessionId: "ses-producer-reason",
        harness: "pi",
        runKind: "incremental",
        status: "failed",
        failureReason: producerReason,
    });
    const longReasonId = recordHistorianRun(db, {
        sessionId: "ses-long-reason",
        harness: "opencode",
        runKind: "incremental",
        status: "failed",
        failureReason: `${producerReason} ${"x".repeat(600)}`,
    });

    const storedReasons = db
        .prepare("SELECT failure_reason FROM historian_runs WHERE id IN (?, ?, ?, ?) ORDER BY id")
        .all(missingReasonId, opencodeMissingReasonId, producerReasonId, longReasonId) as Array<{
        failure_reason: string;
    }>;
    expect(storedReasons.map((row) => row.failure_reason)).toEqual([
        "provider_error",
        "provider_error",
        producerReason,
        `${producerReason} ${"x".repeat(512 - producerReason.length - 1)}`,
    ]);
});

test("clearSession deletes a session's historian_runs", () => {
    const db = openDatabase();
    recordHistorianRun(db, {
        sessionId: "ses-clear",
        harness: "opencode",
        runKind: "incremental",
        status: "success",
    });
    expect(
        (
            db
                .prepare("SELECT COUNT(*) AS c FROM historian_runs WHERE session_id = ?")
                .get("ses-clear") as { c: number }
        ).c,
    ).toBe(1);

    clearSession(db, "ses-clear");

    expect(
        (
            db
                .prepare("SELECT COUNT(*) AS c FROM historian_runs WHERE session_id = ?")
                .get("ses-clear") as { c: number }
        ).c,
    ).toBe(0);
});

test("session cleanup removes both historian tables for the selected non-OpenCode harness", () => {
    const db = openDatabase();
    for (const harness of ["pi", "opencode"] as const) {
        for (const sessionId of ["deleted", "swept", "kept"]) {
            const subagentInvocationId = recordSubagentInvocation(db, {
                sessionId,
                harness,
                subagent: "historian",
                task: "turn_one",
                providerId: "test-provider",
                modelId: "test-model",
                startedAt: 1,
                endedAt: 2,
                status: "completed",
                inputTokens: 1,
                outputTokens: 1,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
            });
            expect(
                recordHistorianRun(db, {
                    sessionId,
                    harness,
                    subagentInvocationId,
                    runKind: "incremental",
                    status: "success",
                }),
            ).not.toBeNull();
        }
    }

    clearSession(db, "deleted", false, true, "pi");
    db.transaction(() => deleteSessionScopedRows(db, ["swept"], "pi")).immediate();

    for (const table of ["historian_runs", "subagent_invocations"]) {
        expect(db.prepare(`SELECT harness, session_id FROM ${table} ORDER BY 1, 2`).all()).toEqual([
            { harness: "opencode", session_id: "deleted" },
            { harness: "opencode", session_id: "kept" },
            { harness: "opencode", session_id: "swept" },
            { harness: "pi", session_id: "kept" },
        ]);
    }
});
