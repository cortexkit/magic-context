import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendCompartments } from "../../features/magic-context/compartment-storage";
import {
    isMemoryMigrationDone,
    markMemoryMigrationDone,
} from "../../features/magic-context/memory/memory-migration";
import { resolveProjectIdentity } from "../../features/magic-context/project-identity";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage-db";
import { acquireWrapupInProgress } from "../../features/magic-context/storage-meta-persisted";
import type { LiveSessionState } from "./live-session-state";
import {
    contextualizeUpgradeReason,
    extractRecompReason,
    isRecompComplete,
    isRecompFailure,
    isRecompSkip,
    type ManagedRecompContext,
    runManagedUpgrade,
} from "./recomp-orchestrator";

const tempDirs: string[] = [];
const originalXdg = process.env.XDG_DATA_HOME;
const originalTestDataDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;

function useTempDataHome(prefix: string): void {
    const dir = join(tmpdir(), `${prefix}${Math.random().toString(36).slice(2)}`);
    process.env.XDG_DATA_HOME = dir;
    process.env.MAGIC_CONTEXT_TEST_DATA_DIR = dir;
    tempDirs.push(dir);
}

afterEach(() => {
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdg;
    if (originalTestDataDir === undefined) delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
    else process.env.MAGIC_CONTEXT_TEST_DATA_DIR = originalTestDataDir;
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
        runMigration: true,
        userMemoriesEnabled: false,
        getNotificationParams: () => ({}),
        ...overrides,
    } as ManagedRecompContext;
}

describe("runManagedUpgrade — wrapup guard", () => {
    it("skips before migration-only upgrade work while wrapup is active", async () => {
        useTempDataHome("recomp-orch-wrapup-guard-");
        const db = openDatabase();
        const dir = "/tmp/recomp-orch-wrapup-guard";
        const sessionId = "ses-wrapup-upgrade";
        const project = resolveProjectIdentity(dir);
        const acquired = acquireWrapupInProgress(db, sessionId, {
            holderId: "wrapup-holder",
            messagesToKeep: 2,
            anchorRawMessageCount: 10,
            targetEligibleEndOrdinal: 8,
            lastCompartmentEnd: 0,
            chunkIndex: 1,
            expectedChunks: 2,
        });
        expect(acquired.ok).toBe(true);

        const ctx = makeCtx(db, dir);
        const message = await runManagedUpgrade(ctx, sessionId);

        expect(message).toContain("## Session Upgrade — Skipped");
        expect(message).toContain("/ctx-wrapup is already compacting");
        expect(isMemoryMigrationDone(db, project)).toBe(false);
    });
});

describe("runManagedUpgrade — already-upgraded guard", () => {
    it("is a no-op when there are no legacy compartments and migration is done", async () => {
        useTempDataHome("recomp-orch-noop-");
        const db = openDatabase();
        const dir = "/tmp/recomp-orch-noop";

        // Seed a v2 (legacy=0) compartment + mark this project's migration done.
        appendCompartments(db, "ses-up", [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 2,
                startMessageId: "m-1",
                endMessageId: "m-2",
                title: "v2 comp",
                content: "body",
                legacy: 0,
                p1: "body",
            },
        ]);
        markMemoryMigrationDone(db, resolveProjectIdentity(dir));

        const ctx = makeCtx(db, dir);
        const message = await runManagedUpgrade(ctx, "ses-up");

        expect(message).toContain("Already Up To Date");
        expect(isRecompFailure(message)).toBe(false);
        // Progress terminal recorded as a (clearing) "done", not "failed".
        const prog = ctx.liveSessionState.recompProgressBySession.get("ses-up");
        // "done" auto-clears after a grace period; allow either still-present done
        // or already-cleared — but it must never be "failed".
        expect(prog?.phase === "done" || prog === undefined).toBe(true);
    });

    it("reports no history when the session has zero compartments and migration done", async () => {
        useTempDataHome("recomp-orch-empty-");
        const db = openDatabase();
        const dir = "/tmp/recomp-orch-empty";
        markMemoryMigrationDone(db, resolveProjectIdentity(dir));

        const ctx = makeCtx(db, dir);
        const message = await runManagedUpgrade(ctx, "ses-empty");

        expect(message).toContain("Already Up To Date");
        expect(message).toContain("no compartment history");
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
        expect(isRecompFailure("## Session Upgrade — Skipped")).toBe(true);
        expect(isRecompFailure("## Magic Recomp — Complete\n\nRebuilt 5")).toBe(false);
        expect(isRecompFailure("## Session Upgrade — Already Up To Date")).toBe(false);
    });

    it("isRecompComplete requires a positive — Complete heading (Partial is NOT complete)", () => {
        // The upgrade gate uses isRecompComplete, not !isRecompFailure, because a
        // published "— Partial" rebuilt only a prefix: published===true and it is
        // NOT a Failed/Skipped heading, so !isRecompFailure would wrongly let it
        // run migration + declare "Complete" while tierless legacy rows remain.
        expect(isRecompComplete("## Magic Recomp — Complete\n\nRebuilt 5")).toBe(true);
        expect(isRecompComplete("## Session Upgrade — Complete")).toBe(true);
        // The bug: Partial is published + not a failure, but must NOT be complete.
        expect(isRecompComplete("## Magic Recomp — Partial\n\nRemaining 40-99 not rebuilt")).toBe(
            false,
        );
        expect(isRecompFailure("## Magic Recomp — Partial\n\nx")).toBe(false);
        // Lease-busy no-op has no status suffix → neither complete nor failure.
        expect(isRecompComplete("## Magic Recomp\n\nHistorian is already running…")).toBe(false);
        expect(isRecompComplete("## Magic Recomp — Failed\n\nx")).toBe(false);
    });

    it("treats the lease/activeRuns skip messages as failures (— Skipped suffix)", () => {
        // These no-op messages must NOT let the upgrade proceed to migration /
        // declare "complete" — the recomp wrote nothing (dogfood 2026-05-30).
        // Belt: the message heading now carries "— Skipped"; suspenders: the
        // orchestrator also gates on the `published:false` flag.
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

    it("contextualizeUpgradeReason rewrites /ctx-recomp -> /ctx-session-upgrade", () => {
        // Bug (dogfood 2026-05-31): the upgrade flow surfaced the shared recomp
        // skip text verbatim, telling the user to run `/ctx-recomp` — the wrong
        // command for the upgrade flow.
        const out = contextualizeUpgradeReason(
            "Historian returned no usable compartments. Try `/ctx-recomp` again.",
        );
        expect(out).not.toContain("/ctx-recomp");
        expect(out).toContain("/ctx-session-upgrade");
    });

    it("contextualizeUpgradeReason names historian.model for flat v1 output", () => {
        const out = contextualizeUpgradeReason(
            "Historian returned invalid compartment output: compartment 1 is missing the tiered paraphrase structure (p1..p4); re-emit with all four tiers",
        );
        expect(out).toContain("`historian.model`");
        expect(out).toContain("magic-context.jsonc");
        expect(out).toContain("No compartments were rewritten");
    });

    it("contextualizeUpgradeReason reframes the lease-busy skip as transient", () => {
        const out = contextualizeUpgradeReason(
            "Another process is already mutating compartment state for this session. Wait for it to finish, then try `/ctx-recomp` again.",
        );
        expect(out).toContain("/ctx-session-upgrade");
        expect(out).not.toContain("/ctx-recomp`"); // no stray recomp command
        expect(out.toLowerCase()).toMatch(/temporary|wait|comparter/);
    });
});
