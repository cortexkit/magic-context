import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDatabase, openDatabase } from "../../features/magic-context/storage-db";
import type { HiddenCompletionExecutor } from "./compartment-runner-types";
import type { LiveSessionState } from "./live-session-state";
import {
    buildRecompDeps,
    extractRecompReason,
    isRecompFailure,
    isRecompSkip,
    type ManagedRecompContext,
} from "./recomp-orchestrator";

const tempDirs: string[] = [];
const originalXdg = process.env.XDG_DATA_HOME;

function useTempDataHome(prefix: string): void {
    const dir = join(tmpdir(), `${prefix}${Math.random().toString(36).slice(2)}`);
    process.env.XDG_DATA_HOME = dir;
    tempDirs.push(dir);
}

afterEach(() => {
    closeDatabase();
    if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdg;
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
});

function makeLiveSessionState(): LiveSessionState {
    return {
        liveModelBySession: new Map(),
        sessionDirectoryBySession: new Map(),
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        deferredHistoryRefreshSessions: new Set(),
        recompProgressBySession: new Map(),
    } as unknown as LiveSessionState;
}

function makeCtx(
    db: ReturnType<typeof openDatabase>,
    directory: string,
    overrides?: Partial<ManagedRecompContext>,
): ManagedRecompContext {
    return {
        client: {} as ManagedRecompContext["client"],
        db,
        liveSessionState: makeLiveSessionState(),
        directory,
        historianChunkTokens: 10_000,
        historianTimeoutMs: 60_000,
        memoryEnabled: true,
        autoPromote: false,
        fallbackModels: [],
        userMemoriesEnabled: false,
        getNotificationParams: () => ({}),
        ...overrides,
    } as ManagedRecompContext;
}

describe("managed recomp completion executor", () => {
    it("forwards the host checkpoint strategy without selecting the v1 writer", () => {
        useTempDataHome("recomp-orch-marker-");
        const db = openDatabase();
        const compactionMarkerStrategy = { setPending: () => {}, publish: () => false };
        const deps = buildRecompDeps(
            makeCtx(db, "/tmp/recomp-orch-marker", { compactionMarkerStrategy }),
            "ses-marker",
        );
        expect(deps.compactionMarkerStrategy).toBe(compactionMarkerStrategy);
    });

    it("forwards a host executor when no SDK client is available", () => {
        useTempDataHome("recomp-orch-executor-");
        const db = openDatabase();
        const executor = {} as HiddenCompletionExecutor;
        const ctx = makeCtx(db, "/tmp/recomp-orch-executor", {
            client: undefined as never,
            hiddenCompletionExecutor: executor,
        });

        const deps = buildRecompDeps(ctx, "ses-executor");

        expect(deps.client).toBeUndefined();
        expect(deps.hiddenCompletionExecutor).toBe(executor);
    });
});

describe("runManagedRecomp clears stale emergency recovery", () => {
    // A successful recomp resolves the overflow that may have armed
    // needs_emergency_recovery; runManagedRecomp must clear it on the "done"
    // terminal phase ONLY (not on skipped/failed), so the flag stops force-
    // bumping pressure to 95% every later pass once the session is small again.
    // The full behavioral path needs a live historian client; this guard pins
    // the clear-on-done wiring against a silent revert.
    const SRC = readFileSync(join(import.meta.dir, "recomp-orchestrator.ts"), "utf8");

    it("clears the flag only in the done terminal phase", () => {
        expect(SRC).toContain("clearEmergencyRecovery(ctx.db, sessionId)");
        const doneGate = SRC.indexOf('terminalPhase === "done"');
        const clearCall = SRC.indexOf("clearEmergencyRecovery(ctx.db, sessionId)");
        expect(doneGate).toBeGreaterThan(-1);
        expect(clearCall).toBeGreaterThan(doneGate);
    });
});

describe("recomp message helpers", () => {
    it("isRecompFailure detects Failed/Skipped headings only", () => {
        expect(isRecompFailure("## Magic Recomp — Failed\n\nreason")).toBe(true);
        expect(isRecompFailure("## Magic Recomp — Skipped")).toBe(true);
        expect(isRecompFailure("## Magic Recomp — Complete\n\nRebuilt 5")).toBe(false);
        expect(isRecompFailure("## Magic Recomp — Partial\n\nRemaining 40-99")).toBe(false);
    });

    it("treats the lease/activeRuns skip messages as failures (— Skipped suffix)", () => {
        // These no-op messages must not read as a completed rebuild — the recomp
        // wrote nothing (dogfood 2026-05-30). Belt: the message heading carries
        // "— Skipped"; suspenders: callers also gate on the `published:false` flag.
        expect(
            isRecompFailure(
                "## Magic Recomp — Skipped\n\nHistorian is already running for this session. Wait for it to finish, then try `/ctx-recomp` again.",
            ),
        ).toBe(true);
        expect(
            isRecompFailure(
                "## Magic Recomp — Skipped\n\nAnother process is already mutating compartment state for this session. Wait for it to finish, then try `/ctx-recomp` again.",
            ),
        ).toBe(true);
    });

    it("isRecompSkip distinguishes a transient lease-busy skip from a hard failure", () => {
        // A skip is the lease/already-running no-op — transient, retry succeeds.
        // It must be reported as "skipped" (neutral, auto-clears), NOT red "failed".
        expect(
            isRecompSkip(
                "## Magic Recomp — Skipped\n\nHistorian is already running for this session. Wait for it to finish, then try `/ctx-recomp` again.",
            ),
        ).toBe(true);
        // Suffix-less lease/already-running no-op (no "— Skipped" heading).
        expect(isRecompSkip("## Magic Recomp\n\nHistorian is already running…")).toBe(true);
        expect(
            isRecompSkip(
                "## Magic Recomp\n\nAnother process is already mutating compartment state",
            ),
        ).toBe(true);
        // A genuine failure or a normal completion is NOT a skip.
        expect(isRecompSkip("## Magic Recomp — Failed\n\nHistorian returned no output")).toBe(
            false,
        );
        expect(isRecompSkip("## Magic Recomp — Complete\n\nRebuilt 5")).toBe(false);
    });

    it("extractRecompReason strips markdown headings and blank lines", () => {
        expect(
            extractRecompReason(
                "## Magic Recomp — Failed\n\nHistorian returned no usable compartments.",
            ),
        ).toBe("Historian returned no usable compartments.");
    });
});
