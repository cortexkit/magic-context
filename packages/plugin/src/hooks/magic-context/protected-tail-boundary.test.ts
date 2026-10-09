/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import {
    deriveMinForceEligibleTokens,
    deriveProtectedTailTokenTarget,
    MIN_FORCE_ELIGIBLE_TOKENS_CAP,
} from "./protected-tail-boundary";
import { buildTrueRawTokenIndexFromTokenCountsForTest } from "./read-session-true-raw-tokens";

describe("protected-tail size walk", () => {
    it("finds the largest ordinal whose suffix still covers the target tokens", () => {
        const index = buildTrueRawTokenIndexFromTokenCountsForTest("canary", [100, 100, 100]);

        expect(index.findSuffixStartForTokens(150)).toBe(2);
        expect(index.findSuffixStartForTokens(301)).toBe(1);
        expect(index.findSuffixStartForTokens(300)).toBe(1);
        expect(index.findSuffixStartForTokens(0)).toBe(4);
    });
});

describe("protected-tail N clamp", () => {
    it("keeps 8K and 12K windows from collapsing to a 1-token protected tail", () => {
        const eightK = deriveProtectedTailTokenTarget({
            contextLimit: 8_000,
            executeThresholdPercentage: 65,
            usagePercentage: 30,
        });
        const twelveK = deriveProtectedTailTokenTarget({
            contextLimit: 12_000,
            executeThresholdPercentage: 65,
            usagePercentage: 95,
        });

        expect(eightK.ceilingN).toBe(2_080);
        expect(eightK.N).toBe(2_000);
        expect(twelveK.ceilingN).toBe(3_120);
        expect(twelveK.N).toBe(2_000);
        expect(eightK.effectiveFloor).toBeLessThanOrEqual(eightK.ceilingN);
        expect(twelveK.effectiveFloor).toBeLessThanOrEqual(twelveK.ceilingN);
    });

    it("derives the force-head minimum from the scaled tail size", () => {
        expect(MIN_FORCE_ELIGIBLE_TOKENS_CAP).toBe(1_000);
        expect(deriveMinForceEligibleTokens(8)).toBe(1);
        expect(deriveMinForceEligibleTokens(16_000)).toBe(1_000);
    });
});

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    applyHeadCap,
    hasRunnableCompartmentWindow,
    type ProtectedTailBoundarySnapshot,
    recordHighPressureNoEligibleHead,
    resolveOpenCodeProtectedTailBoundary,
    resolveWrapupProtectedTailBoundary,
    validateBoundarySnapshot,
} from "./protected-tail-boundary";

const boundaryTempDirs: string[] = [];
const originalBoundaryXdg = process.env.XDG_DATA_HOME;

afterEach(() => {
    if (originalBoundaryXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalBoundaryXdg;
    for (const dir of boundaryTempDirs) rmSync(dir, { recursive: true, force: true });
    boundaryTempDirs.length = 0;
});

function useBoundaryTempDataHome(prefix: string): void {
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
    boundaryTempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

function createBoundaryOpenCodeDb(
    sessionId: string,
    messages: Array<{ id: string; role: string; parts: unknown[]; rawData?: string }>,
): Database {
    const dbPath = join(process.env.XDG_DATA_HOME!, "opencode", "opencode.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE part (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    `);
    const insertMessage = db.prepare(
        "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    );
    const insertPart = db.prepare(
        "INSERT INTO part (message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    );
    messages.forEach((message, index) => {
        const timestamp = index + 1;
        insertMessage.run(
            message.id,
            sessionId,
            timestamp,
            timestamp,
            message.rawData ??
                JSON.stringify({ id: message.id, role: message.role, sessionID: sessionId }),
        );
        message.parts.forEach((part) => {
            insertPart.run(message.id, sessionId, timestamp, timestamp, JSON.stringify(part));
        });
    });
    return db;
}

function createContextDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    return db;
}

describe("protected-tail boundary integration", () => {
    it("exposes a runnable head for a sparse #132-shaped session under pressure", () => {
        useBoundaryTempDataHome("protected-tail-132-");
        const sessionId = "ses-132";
        const opencodeDb = createBoundaryOpenCodeDb(sessionId, [
            {
                id: "m1",
                role: "user",
                parts: [{ type: "text", text: "start the long autonomous task" }],
            },
            { id: "m2", role: "assistant", parts: [{ type: "text", text: "working" }] },
            { id: "m3", role: "user", parts: [{ type: "text", text: "continue" }] },
            ...Array.from({ length: 20 }, (_, index) => ({
                id: `m${index + 4}`,
                role: "assistant",
                parts: [{ type: "text", text: `autonomous output ${index} `.repeat(1000) }],
            })),
        ]);
        const db = createContextDb();
        try {
            const snapshot = resolveOpenCodeProtectedTailBoundary({
                db,
                sessionId,
                mode: "trigger",
                contextLimit: 12_000,
                executeThresholdPercentage: 65,
                usage: { percentage: 95, inputTokens: 7_400 },
                usageSource: "live",
            });

            expect(snapshot.protectedTailStart).toBeGreaterThan(1);
            expect(hasRunnableCompartmentWindow(snapshot)).toBe(true);
        } finally {
            closeQuietly(db);
            closeQuietly(opencodeDb);
        }
    });

    it("accepts a fresh zero-compartment snapshot (offset clamp parity with the resolver)", () => {
        // Regression: the resolver clamps offset = max(1, lastCompartmentEnd+1),
        // so a zero-compartment session resolves offset=1 (lastEnd=-1 → 0 → 1).
        // validateBoundarySnapshot recomputed the expectation WITHOUT the clamp
        // (-1+1 = 0 ≠ 1) and rejected every first-compartment snapshot as
        // "last compartment moved: offset 1 -> 0" — a fresh session could never
        // publish its first compartment (caught by the historian-success e2e).
        useBoundaryTempDataHome("protected-tail-first-");
        const sessionId = "ses-first-compartment";
        const opencodeDb = createBoundaryOpenCodeDb(sessionId, [
            { id: "m1", role: "user", parts: [{ type: "text", text: "eligible".repeat(800) }] },
            { id: "m2", role: "assistant", parts: [{ type: "text", text: "reply".repeat(800) }] },
            { id: "m3", role: "user", parts: [{ type: "text", text: "protected".repeat(2000) }] },
        ]);
        const db = createContextDb();
        try {
            const snapshot = resolveOpenCodeProtectedTailBoundary({
                db,
                sessionId,
                mode: "trigger",
                contextLimit: 12_000,
                executeThresholdPercentage: 65,
                usage: { percentage: 95, inputTokens: 7_400 },
                usageSource: "live",
            });
            expect(snapshot.offset).toBe(1);
            expect(validateBoundarySnapshot({ db, snapshot })).toEqual({ ok: true });
        } finally {
            closeQuietly(db);
            closeQuietly(opencodeDb);
        }
    });
    it("validates fresh snapshots when malformed rows create ordinal gaps", () => {
        useBoundaryTempDataHome("protected-tail-ordinal-gap-");
        const sessionId = "ses-ordinal-gap";
        const opencodeDb = createBoundaryOpenCodeDb(sessionId, [
            { id: "m1", role: "user", parts: [{ type: "text", text: "eligible".repeat(800) }] },
            { id: "bad-json", role: "assistant", rawData: "{not json", parts: [] },
            { id: "m3", role: "assistant", parts: [{ type: "text", text: "reply".repeat(800) }] },
            { id: "m4", role: "user", parts: [{ type: "text", text: "protected".repeat(2000) }] },
        ]);
        const db = createContextDb();
        try {
            const snapshot = resolveOpenCodeProtectedTailBoundary({
                db,
                sessionId,
                mode: "trigger",
                contextLimit: 12_000,
                executeThresholdPercentage: 65,
                usage: { percentage: 95, inputTokens: 7_400 },
                usageSource: "live",
            });

            expect(snapshot.rawMessageCountAtTrigger).toBe(4);
            expect(validateBoundarySnapshot({ db, snapshot })).toEqual({ ok: true });
        } finally {
            closeQuietly(db);
            closeQuietly(opencodeDb);
        }
    });

    it("never crosses the newest meaningful user message on routine passes (live-prompt floor)", () => {
        // Tool-heavy in-flight turn: newest user prompt followed by a large
        // assistant/tool suffix. Pure token sizing would protect only the
        // assistant suffix and leave the live prompt eligible — the historian
        // would compact the prompt the agent is actively answering (observed
        // live: compaction divider rendered at the session tail).
        useBoundaryTempDataHome("protected-tail-live-prompt-");
        const sessionId = "ses-live-prompt-floor";
        const messages: Array<{ id: string; role: string; parts: unknown[] }> = [];
        // Old eligible history (real content mass).
        for (let i = 1; i <= 4; i++) {
            messages.push({
                id: `m-old-${i}`,
                role: i % 2 === 1 ? "user" : "assistant",
                parts: [{ type: "text", text: `old content ${i} `.repeat(600) }],
            });
        }
        // The live prompt (newest meaningful user message).
        messages.push({
            id: "m-live-prompt",
            role: "user",
            parts: [{ type: "text", text: "Okay now let's check open issues before we start." }],
        });
        // In-flight tool-heavy assistant suffix — big enough that the token
        // target N is satisfied by the suffix alone.
        for (let i = 1; i <= 4; i++) {
            messages.push({
                id: `m-tail-a${i}`,
                role: "assistant",
                parts: [
                    {
                        type: "tool",
                        callID: `read:${i}`,
                        tool: "read",
                        state: {
                            status: "completed",
                            input: { filePath: `/tmp/f${i}.ts` },
                            output: `tool output ${i} `.repeat(2000),
                        },
                    },
                ],
            });
        }
        const opencodeDb = createBoundaryOpenCodeDb(sessionId, messages);
        const db = createContextDb();
        try {
            const livePromptOrdinal = 5;
            const snapshot = resolveOpenCodeProtectedTailBoundary({
                db,
                sessionId,
                mode: "trigger",
                contextLimit: 64_000,
                executeThresholdPercentage: 65,
                usage: { percentage: 50, inputTokens: 32_000 },
                usageSource: "live",
            });
            // The live prompt and everything after it stays protected.
            expect(snapshot.protectedTailStart).toBeLessThanOrEqual(livePromptOrdinal);

            // At T=90, 85% remains below the derived 92% force band. Reverting
            // this gate to literal 80 would lift the floor and cross the prompt.
            const raisedThreshold = resolveOpenCodeProtectedTailBoundary({
                db,
                sessionId,
                mode: "trigger",
                contextLimit: 64_000,
                executeThresholdPercentage: 90,
                usage: { percentage: 85, inputTokens: 54_400 },
                usageSource: "live",
            });
            expect(raisedThreshold.protectedTailStart).toBeLessThanOrEqual(livePromptOrdinal);

            // Default configurations still lift the floor at the unchanged 85% band.
            const defaultThreshold = resolveOpenCodeProtectedTailBoundary({
                db,
                sessionId,
                mode: "trigger",
                contextLimit: 64_000,
                executeThresholdPercentage: 65,
                usage: { percentage: 85, inputTokens: 54_400 },
                usageSource: "live",
            });
            expect(defaultThreshold.protectedTailStart).toBeGreaterThan(livePromptOrdinal);

            // Emergency-scaled re-resolution (force-path second attempt) is
            // ALLOWED to cross the floor — sparse sessions must remain
            // compactable under genuine pressure (#132).
            const emergency = resolveOpenCodeProtectedTailBoundary({
                db,
                sessionId,
                mode: "trigger",
                contextLimit: 64_000,
                executeThresholdPercentage: 65,
                usage: { percentage: 96, inputTokens: 61_000 },
                usageSource: "live",
                emergencyTailScale: 0.25,
            });
            expect(emergency.protectedTailStart).toBeGreaterThanOrEqual(
                snapshot.protectedTailStart,
            );
        } finally {
            closeQuietly(db);
            closeQuietly(opencodeDb);
        }
    });

    it("does not let an interrupted (dead) open tool arc at the eligible-head edge freeze the historian", () => {
        // Production regression: an interrupted bash call (state.status="running",
        // no output, ever) landing right after the last compartment boundary
        // dragged the protected-tail boundary back to offset on every pass,
        // leaving a zero-token eligible head -> "unsummarized tail too small" ->
        // historian dormant ~24h despite a huge compactable conversation tail.
        useBoundaryTempDataHome("protected-tail-dead-arc-");
        const sessionId = "ses-dead-open-arc";
        const messages: Array<{ id: string; role: string; parts: unknown[] }> = [];
        // The dead/interrupted tool call at the very head of the tail (offset).
        messages.push({
            id: "m-dead-bash",
            role: "assistant",
            parts: [
                {
                    type: "tool",
                    callID: "toolu_dead",
                    tool: "bash",
                    // open arc: input present, NO output — never completes.
                    state: { status: "running", input: { command: "sleep 999" } },
                },
            ],
        });
        // A large compactable conversation tail AFTER the dead arc.
        for (let i = 1; i <= 8; i++) {
            messages.push({
                id: `m-conv-${i}`,
                role: i % 2 === 1 ? "user" : "assistant",
                parts: [{ type: "text", text: `conversation turn ${i} `.repeat(800) }],
            });
        }
        const opencodeDb = createBoundaryOpenCodeDb(sessionId, messages);
        const db = createContextDb();
        try {
            const snapshot = resolveOpenCodeProtectedTailBoundary({
                db,
                sessionId,
                mode: "trigger",
                contextLimit: 64_000,
                executeThresholdPercentage: 65,
                usage: { percentage: 60, inputTokens: 38_000 },
                usageSource: "live",
            });
            // The eligible head must be NON-empty: the dead arc is ignored, so the
            // conversation tail is compactable.
            expect(snapshot.eligibleEndOrdinal).toBeGreaterThan(snapshot.offset);
            expect(snapshot.trueRawEligibleTokens).toBeGreaterThan(0);
        } finally {
            closeQuietly(db);
            closeQuietly(opencodeDb);
        }
    });

    it("manual-full-recomp is not frozen by a stale (dead) open tool arc at offset", () => {
        // The same interrupted bash call that froze the trigger path must not
        // freeze /ctx-recomp (the user's manual escape hatch): a dead open arc
        // older than the recent window is ignored, so recomp gets a full
        // eligible range to rebuild.
        useBoundaryTempDataHome("protected-tail-recomp-dead-arc-");
        const sessionId = "ses-recomp-dead-open-arc";
        const messages: Array<{ id: string; role: string; parts: unknown[] }> = [];
        messages.push({
            id: "m-dead-bash",
            role: "assistant",
            parts: [
                {
                    type: "tool",
                    callID: "toolu_dead",
                    tool: "bash",
                    state: { status: "running", input: { command: "sleep 999" } },
                },
            ],
        });
        for (let i = 1; i <= 8; i++) {
            messages.push({
                id: `m-conv-${i}`,
                role: i % 2 === 1 ? "user" : "assistant",
                parts: [{ type: "text", text: `conversation turn ${i} `.repeat(800) }],
            });
        }
        const opencodeDb = createBoundaryOpenCodeDb(sessionId, messages);
        const db = createContextDb();
        try {
            const snapshot = resolveOpenCodeProtectedTailBoundary({
                db,
                sessionId,
                mode: "manual-full-recomp",
                contextLimit: 64_000,
                executeThresholdPercentage: 65,
                usageSource: "manual-none",
            });
            expect(snapshot.eligibleEndOrdinal).toBeGreaterThan(snapshot.offset);
        } finally {
            closeQuietly(db);
            closeQuietly(opencodeDb);
        }
    });

    it("bails out when a boundary snapshot's eligible raw range changes", () => {
        useBoundaryTempDataHome("protected-tail-stale-");
        const sessionId = "ses-stale-boundary";
        // m1/m2 carry REAL content mass: the eligible head must exceed the
        // 256-token hysteresis snap or the eligible range collapses to empty
        // and there is no fingerprint to invalidate (this test then passes
        // vacuously 2014 it did for a while, masked by the offset-clamp bug).
        const opencodeDb = createBoundaryOpenCodeDb(sessionId, [
            { id: "m1", role: "user", parts: [{ type: "text", text: "eligible ".repeat(400) }] },
            {
                id: "m2",
                role: "assistant",
                parts: [{ type: "text", text: "also eligible ".repeat(400) }],
            },
            { id: "m3", role: "user", parts: [{ type: "text", text: "protected".repeat(2000) }] },
        ]);
        const db = createContextDb();
        try {
            const snapshot = resolveOpenCodeProtectedTailBoundary({
                db,
                sessionId,
                mode: "trigger",
                contextLimit: 8_000,
                executeThresholdPercentage: 65,
                usage: { percentage: 95, inputTokens: 5_000 },
                usageSource: "live",
            });
            opencodeDb
                .prepare(
                    "INSERT INTO part (message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
                )
                .run("m1", sessionId, 1, 1, JSON.stringify({ type: "text", text: "late edit" }));

            expect(validateBoundarySnapshot({ db, snapshot })).toEqual(
                expect.objectContaining({ ok: false, reason: "stale_snapshot" }),
            );
        } finally {
            closeQuietly(db);
            closeQuietly(opencodeDb);
        }
    });
});

it("manual full recomp protects an in-progress open tool arc", () => {
    useBoundaryTempDataHome("protected-tail-manual-open-arc-");
    const sessionId = "ses-manual-open-arc";
    const opencodeDb = createBoundaryOpenCodeDb(sessionId, [
        { id: "m1", role: "user", parts: [{ type: "text", text: "eligible" }] },
        {
            id: "m2",
            role: "assistant",
            parts: [{ type: "tool", callID: "call-open", state: { input: { command: "long" } } }],
        },
        { id: "m3", role: "assistant", parts: [{ type: "text", text: "still running" }] },
    ]);
    const db = createContextDb();
    try {
        const snapshot = resolveOpenCodeProtectedTailBoundary({
            db,
            sessionId,
            mode: "manual-full-recomp",
            contextLimit: 128_000,
            executeThresholdPercentage: 65,
            usage: null,
            usageSource: "manual-none",
        });

        expect(snapshot.protectedTailStart).toBe(2);
        expect(snapshot.eligibleEndOrdinal).toBe(2);
    } finally {
        closeQuietly(db);
        closeQuietly(opencodeDb);
    }
});

import type { RawMessage } from "./read-session-raw";
import {
    buildToolArcs,
    buildTrueRawTokenIndex,
    computeRawRangeFingerprint,
    fenceBoundaryForToolArcs,
} from "./read-session-true-raw-tokens";

it("fingerprints and true-raw tokens change when nested tool output grows with the same id and part count", () => {
    const short: RawMessage[] = [
        {
            ordinal: 1,
            id: "m1",
            role: "assistant",
            version: 1,
            parts: [{ type: "tool", callID: "call-1", state: { output: "short" } }],
        },
    ];
    const long: RawMessage[] = [
        {
            ordinal: 1,
            id: "m1",
            role: "assistant",
            version: 1,
            parts: [{ type: "tool", callID: "call-1", state: { output: "long ".repeat(2000) } }],
        },
    ];

    expect(computeRawRangeFingerprint(short, 1, 2)).not.toBe(
        computeRawRangeFingerprint(long, 1, 2),
    );
    const shortTokens = buildTrueRawTokenIndex("ses-cache", short, {
        providerShapeVersion: "opencode-v1",
        cacheNamespace: "same-session",
    }).rangeTokens(1, 2);
    const longTokens = buildTrueRawTokenIndex("ses-cache", long, {
        providerShapeVersion: "opencode-v1",
        cacheNamespace: "same-session",
    }).rangeTokens(1, 2);
    expect(longTokens).toBeGreaterThan(shortTokens);
});

it("fingerprints same-length edits to counted content fields", () => {
    const before: RawMessage[] = [
        {
            ordinal: 1,
            id: "m1",
            role: "assistant",
            version: 1,
            parts: [
                { type: "text", text: "alpha" },
                { type: "thinking", thinking: "bravo" },
                { type: "tool", callID: "call-1", state: { input: { q: "one" }, output: "delta" } },
            ],
        },
    ];
    const after: RawMessage[] = [
        {
            ordinal: 1,
            id: "m1",
            role: "assistant",
            version: 1,
            parts: [
                { type: "text", text: "omega" },
                { type: "thinking", thinking: "gamma" },
                { type: "tool", callID: "call-1", state: { input: { q: "two" }, output: "sigma" } },
            ],
        },
    ];

    expect(computeRawRangeFingerprint(before, 1, 2)).not.toBe(
        computeRawRangeFingerprint(after, 1, 2),
    );
});

it("re-fences a head cap when a recent open arc lands inside an admitted completed component", () => {
    const index = buildTrueRawTokenIndexFromTokenCountsForTest(
        "completed-component-after-open-clamp",
        Array(10).fill(100),
    );

    expect(
        applyHeadCap({
            index,
            protectedTailStart: 10,
            offset: 4,
            arcs: [
                { callId: "completed", invOrdinal: 2, resOrdinal: 8 },
                { callId: "open", invOrdinal: 7, resOrdinal: null },
            ],
            lastCompartmentEndOrdinal: 3,
            capTokens: 10_000,
            recentOpenArcCutoff: 7,
        }),
    ).toEqual({ eligibleEndOrdinal: 9, oversizeAtomicUnit: false });
});

it("does not clamp a completed component back into the protected tail at ordinal 300", () => {
    const tokens = Array(473).fill(400);
    tokens[298] = 258;
    const index = buildTrueRawTokenIndexFromTokenCountsForTest("edge-299", tokens);
    const head = applyHeadCap({
        index,
        offset: 299,
        protectedTailStart: 300,
        arcs: [
            { callId: "outer", invOrdinal: 298, resOrdinal: 301 },
            { callId: "inner", invOrdinal: 299, resOrdinal: 302 },
        ],
        lastCompartmentEndOrdinal: 298,
        capTokens: 100_000,
        recentOpenArcCutoff: 450,
    });

    // Neither side of the component fits between the publication floor and live tail.
    expect(head.eligibleEndOrdinal).toBe(299);
    expect(index.rangeTokens(299, head.eligibleEndOrdinal)).toBe(0);
});

it("re-fences an open invocation inside a completed tool component", () => {
    expect(
        fenceBoundaryForToolArcs(
            10,
            [
                { callId: "completed", invOrdinal: 7, resOrdinal: 12 },
                { callId: "open", invOrdinal: 9, resOrdinal: null },
            ],
            0,
            9,
        ),
    ).toBe(7);
});

it("moves a candidate boundary forward to the first later open tool invocation", () => {
    expect(
        fenceBoundaryForToolArcs(10, [{ callId: "open", invOrdinal: 20, resOrdinal: null }], 9, 10),
    ).toBe(20);
});

it("ignores a stale open arc older than the recent-open-arc cutoff (does not fence the boundary)", () => {
    // Regression: an interrupted/abandoned tool invocation at the eligible-head
    // edge (here ordinal 5, well before the cutoff of 50) must NOT drag the
    // boundary back to itself — that collapse froze the historian for ~24h.
    expect(
        fenceBoundaryForToolArcs(50, [{ callId: "dead", invOrdinal: 5, resOrdinal: null }], 1, 50),
    ).toBe(50);
});

it("still protects a recent open arc at/after the recent-open-arc cutoff", () => {
    // The current in-flight call (ordinal 60 >= cutoff 50) is still protected.
    expect(
        fenceBoundaryForToolArcs(50, [{ callId: "live", invOrdinal: 60, resOrdinal: null }], 1, 50),
    ).toBe(60);
});

it("classifies property-presence tool states for open and null-output arcs", () => {
    expect(
        buildToolArcs([
            {
                ordinal: 1,
                id: "m1",
                role: "assistant",
                parts: [{ type: "tool", callID: "empty-open", providerExecuted: false, state: {} }],
            },
        ]),
    ).toEqual([{ callId: "empty-open", invOrdinal: 1, resOrdinal: null }]);

    expect(
        buildToolArcs([
            {
                ordinal: 1,
                id: "m1",
                role: "assistant",
                parts: [
                    { type: "tool", callID: "null-output", state: { input: { command: "x" } } },
                ],
            },
            {
                ordinal: 2,
                id: "m2",
                role: "user",
                parts: [{ type: "tool", callID: "null-output", state: { output: null } }],
            },
        ]),
    ).toEqual([{ callId: "null-output", invOrdinal: 1, resOrdinal: 2 }]);
});

it("bails a snapshot when the current context limit differs from the trigger limit", () => {
    useBoundaryTempDataHome("protected-tail-model-switch-");
    const sessionId = "ses-model-switch";
    const opencodeDb = createBoundaryOpenCodeDb(sessionId, [
        { id: "m1", role: "user", parts: [{ type: "text", text: "eligible" }] },
        { id: "m2", role: "assistant", parts: [{ type: "text", text: "tail".repeat(2000) }] },
    ]);
    const db = createContextDb();
    try {
        const snapshot = resolveOpenCodeProtectedTailBoundary({
            db,
            sessionId,
            mode: "trigger",
            contextLimit: 1_000_000,
            executeThresholdPercentage: 65,
            usage: { percentage: 85, inputTokens: 500_000 },
            usageSource: "live",
        });
        expect(validateBoundarySnapshot({ db, snapshot, currentContextLimit: 8_000 })).toEqual(
            expect.objectContaining({ ok: false, reason: "model_or_limit_changed" }),
        );
    } finally {
        closeQuietly(db);
        closeQuietly(opencodeDb);
    }
});

function pressureGateSnapshot(
    sessionId: string,
    executeThresholdPercentage: number,
): ProtectedTailBoundarySnapshot {
    return {
        sessionId,
        mode: "trigger",
        offset: 1,
        offsetMessageId: "m1",
        protectedTailStart: 2,
        protectedTailStartMessageId: "m2",
        eligibleEndOrdinal: 1,
        eligibleEndMessageId: null,
        rawMessageCountAtTrigger: 2,
        rawLastMessageIdAtTrigger: "m2",
        N: 2_000,
        usagePercentage: 85,
        usageInputTokens: 85_000,
        usageSource: "live",
        contextLimit: 100_000,
        executeThresholdPercentage,
        triggerBudget: 5_000,
        priorBoundaryOrdinal: 1,
        migrationFloorActive: false,
        providerShapeVersion: "opencode-v1",
        cacheNamespace: "pressure-gate-test",
        createdAt: 1,
        rawRangeFingerprint: "stable",
        trueRawEligibleTokens: 500,
        oversizeAtomicUnit: false,
        boundaryReason: "size-walk",
    };
}

it("rejects an empty capped window at both force thresholds while keeping the raised no-head gate", () => {
    const raised = pressureGateSnapshot("ses-raised-pressure-gates", 90);
    const defaultThreshold = pressureGateSnapshot("ses-default-pressure-gates", 65);

    // Token mass before capping cannot make an empty publication window runnable.
    expect(hasRunnableCompartmentWindow(raised)).toBe(false);
    expect(hasRunnableCompartmentWindow(defaultThreshold)).toBe(false);

    const db = createContextDb();
    try {
        expect(recordHighPressureNoEligibleHead(db, raised)).toBe(0);
        expect(recordHighPressureNoEligibleHead(db, defaultThreshold)).toBe(1);
    } finally {
        closeQuietly(db);
    }
});

it("treats an emergency-scaled complete small head as runnable even below the force token floor", () => {
    expect(
        hasRunnableCompartmentWindow({
            sessionId: "ses-small-head",
            mode: "trigger",
            offset: 1,
            rawMessageCount: 2,
            protectedTailStart: 2,
            eligibleEndOrdinal: 2,
            N: 2_000,
            usableTokens: 7_800,
            usagePercentage: 82,
            usageInputTokens: 9_840,
            usageSource: "live",
            contextLimit: 12_000,
            executeThresholdPercentage: 65,
            trueRawEligibleTokens: 1,
            trueRawTailTokens: 2_000,
            boundaryReason: "size-walk",
            rawRangeFingerprint: "stable",
        }),
    ).toBe(true);
});

describe("wrapup protected-tail boundary", () => {
    it("counts raw messages of any role and keeps the newest N raw", () => {
        useBoundaryTempDataHome("wrapup-boundary-meaningful-");
        const sessionId = "ses-wrapup-meaningful";
        createBoundaryOpenCodeDb(sessionId, [
            { id: "m1", role: "user", parts: [{ type: "text", text: "one" }] },
            { id: "m2", role: "assistant", parts: [{ type: "text", text: "a" }] },
            { id: "m3", role: "user", parts: [{ type: "text", text: "ignored", ignored: true }] },
            { id: "m4", role: "user", parts: [{ type: "text", text: "two" }] },
            { id: "m5", role: "assistant", parts: [{ type: "text", text: "b" }] },
            { id: "m6", role: "user", parts: [{ type: "text", text: "three" }] },
            { id: "m7", role: "assistant", parts: [{ type: "text", text: "c" }] },
            { id: "m8", role: "user", parts: [{ type: "text", text: "four" }] },
        ]);
        const db = createContextDb();
        const plan = resolveWrapupProtectedTailBoundary({
            db,
            sessionId,
            mode: "manual-wrapup",
            contextLimit: 128_000,
            executeThresholdPercentage: 65,
            usage: null,
            usageSource: "manual-none",
            messagesToKeep: 2,
        });

        expect(plan.rawMessagesAboveLastCompartment).toBe(8);
        // keep=2 raw messages over 8 ordinals -> candidate ordinal 7 (m7), then the
        // user-boundary snap prefers the nearby user message m8... snapping only
        // moves EARLIER, so the nearest user at or before 7 is m6 (ordinal 6).
        expect(plan.targetProtectedTailStart).toBe(6);
        expect(plan.snapshot.eligibleEndOrdinal).toBeGreaterThan(1);
        expect(plan.snapshot.eligibleEndOrdinal).toBeLessThanOrEqual(6);
        closeQuietly(db);
    });

    it("snaps outward so a closed tool arc is not split at the keep watermark", () => {
        useBoundaryTempDataHome("wrapup-boundary-arc-");
        const sessionId = "ses-wrapup-arc";
        createBoundaryOpenCodeDb(sessionId, [
            { id: "m1", role: "user", parts: [{ type: "text", text: "one" }] },
            {
                id: "m2",
                role: "assistant",
                parts: [{ type: "tool", id: "t1", state: { status: "pending" } }],
            },
            { id: "m3", role: "user", parts: [{ type: "text", text: "two" }] },
            {
                id: "m4",
                role: "tool",
                parts: [{ type: "tool_result", id: "t1", content: "result" }],
            },
            { id: "m5", role: "user", parts: [{ type: "text", text: "three" }] },
        ]);
        const db = createContextDb();
        const plan = resolveWrapupProtectedTailBoundary({
            db,
            sessionId,
            mode: "manual-wrapup",
            contextLimit: 128_000,
            executeThresholdPercentage: 65,
            usage: null,
            usageSource: "manual-none",
            messagesToKeep: 2,
        });

        expect(plan.targetProtectedTailStart).toBe(1);
        expect(plan.snapshot.boundaryReason).toBe("manual-wrapup-user-snap");
        closeQuietly(db);
    });

    it("re-fences after user snap when the snapped user is inside an earlier tool arc", () => {
        useBoundaryTempDataHome("wrapup-boundary-refence-");
        const sessionId = "ses-wrapup-refence";
        createBoundaryOpenCodeDb(sessionId, [
            { id: "m1", role: "user", parts: [{ type: "text", text: "one" }] },
            {
                id: "m2",
                role: "assistant",
                parts: [{ type: "tool", id: "outer", state: { status: "pending" } }],
            },
            { id: "m3", role: "user", parts: [{ type: "text", text: "queued while outer runs" }] },
            { id: "m4", role: "assistant", parts: [{ type: "text", text: "still working" }] },
            {
                id: "m5",
                role: "assistant",
                parts: [{ type: "tool", id: "inner", state: { status: "pending" } }],
            },
            {
                id: "m6",
                role: "tool",
                parts: [{ type: "tool_result", id: "outer", content: "outer result" }],
            },
            { id: "m7", role: "user", parts: [{ type: "text", text: "queued while inner runs" }] },
            {
                id: "m8",
                role: "tool",
                parts: [{ type: "tool_result", id: "inner", content: "inner result" }],
            },
            { id: "m9", role: "user", parts: [{ type: "text", text: "newest kept" }] },
        ]);
        const db = createContextDb();
        const plan = resolveWrapupProtectedTailBoundary({
            db,
            sessionId,
            mode: "manual-wrapup",
            contextLimit: 128_000,
            executeThresholdPercentage: 65,
            usage: null,
            usageSource: "manual-none",
            messagesToKeep: 2,
        });

        expect(plan.targetProtectedTailStart).toBeLessThanOrEqual(2);
        closeQuietly(db);
    });
});
