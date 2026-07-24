/// <reference types="bun-types" />

// Cache-stability gate for the SOFT+ / SOFT / HARD materialization taxonomy.
//
// This is THE regression guard for the m[0]/m[1] split. The contract:
//   SOFT+ (defer pass, nothing new)      → m[0] AND m[1] replay BYTE-IDENTICAL.
//   SOFT  (exec / cache-busting pass)    → m[1] re-renders, m[0] stays identical.
//   HARD  (TTL idle / system / tools /   → m[0] re-materializes (fold m[1] in),
//          model change, or content)        m[1] resets to placeholder.
//
// The bug this guards against: a routine historian publish (new compartment)
// must NEVER mutate m[0] — folding m[0] on every publish busts the Anthropic
// prompt-cache prefix for the whole conversation. New compartments are an m[1]
// delta that folds into m[0] only on a HARD bust.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    appendCompartments,
    type CompartmentInput,
} from "../../features/magic-context/compartment-storage";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { clearInjectionCache, injectM0M1, type M0HardSignals } from "./inject-compartments";

const SESSION_ID = "ses_taxonomy";
const PROJECT_PATH = "/tmp/test-taxonomy-project";
const M1_PLACEHOLDER =
    "<session-history-since>(no new content since last materialization)</session-history-since>";

let db: Database;
const tempDirs: string[] = [];

function makeDb(): Database {
    const d = new Database(":memory:");
    initializeDatabase(d);
    getOrCreateSessionMeta(d, SESSION_ID);
    return d;
}

function makeProjectDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "mc-taxonomy-test-"));
    tempDirs.push(dir);
    return dir;
}

function compartment(seq: number, title: string, body: string): CompartmentInput {
    return {
        sequence: seq,
        startMessage: seq,
        endMessage: seq,
        startMessageId: `m${seq}`,
        endMessageId: `m${seq}`,
        title,
        content: body,
        // p1 present → stored as v2 (legacy=0), so upgrade_state stays "ready"
        // and does not itself trigger a HARD bust.
        p1: body,
    };
}

// The stable provider-identity baseline. Holding these constant means no HARD
// signal fires, isolating the compartment/SOFT behavior under test.
const BASE_HARD: M0HardSignals = {
    systemHash: "sys-v1",
    modelKey: "anthropic/opus",
    cacheExpired: false,
    lastResponseTime: 0,
};

interface PassResult {
    m0: string;
    m1: string;
    rematerialized: boolean;
    reason: string | null;
}

function pass(opts: {
    projectDirectory: string;
    isCacheBustingPass: boolean;
    hard?: M0HardSignals;
}): PassResult {
    // Mirror production: read fresh session_meta each pass (the persisted m[0]/m[1]
    // markers drive the decision), so byte-identity is proven through the DB.
    const state = getOrCreateSessionMeta(db, SESSION_ID);
    const result = injectM0M1({
        db,
        sessionId: SESSION_ID,
        state,
        projectPath: PROJECT_PATH,
        projectDirectory: opts.projectDirectory,
        historyBudgetTokens: 98_000,
        isCacheBustingPass: opts.isCacheBustingPass,
        hardSignals: opts.hard ?? BASE_HARD,
    });
    return {
        m0: result.m0Bytes ? result.m0Bytes.toString("utf8") : "",
        m1: result.m1Text ?? "",
        rematerialized: result.m0RematerializedThisPass,
        reason: result.decision.reason,
    };
}

afterEach(() => {
    if (db) db.close();
    clearInjectionCache(SESSION_ID);
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
});

describe("m[0]/m[1] materialization taxonomy", () => {
    it("SOFT+: a new compartment + defer passes replay m[0] AND m[1] byte-identical", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        // Baseline: compartment A folded into m[0] via first_render.
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Alpha baseline")]);
        const baseline = pass({ projectDirectory, isCacheBustingPass: true });
        expect(baseline.reason).toBe("first_render");

        // Publish compartment B (the routine historian publish).
        appendCompartments(db, SESSION_ID, [compartment(1, "B", "Bravo delta")]);

        // Defer passes: NOTHING re-renders. m[0] and m[1] are byte-identical to
        // the baseline — B does NOT leak in (it surfaces only on an exec pass).
        const d1 = pass({ projectDirectory, isCacheBustingPass: false });
        const d2 = pass({ projectDirectory, isCacheBustingPass: false });
        expect(d1.rematerialized).toBe(false);
        expect(d1.m0).toBe(baseline.m0);
        expect(d1.m1).toBe(baseline.m1);
        expect(d2.m0).toBe(baseline.m0);
        expect(d2.m1).toBe(baseline.m1);
        expect(d1.m1).not.toContain("Bravo delta");
    });

    it("SOFT: an exec pass surfaces the new compartment in m[1] WITHOUT mutating m[0]", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Alpha baseline")]);
        const baseline = pass({ projectDirectory, isCacheBustingPass: true });
        appendCompartments(db, SESSION_ID, [compartment(1, "B", "Bravo delta")]);

        const soft = pass({ projectDirectory, isCacheBustingPass: true });
        // m[0] is the frozen prefix — byte-identical. No HARD fold.
        expect(soft.rematerialized).toBe(false);
        expect(soft.m0).toBe(baseline.m0);
        // m[1] re-rendered and now carries B as a <new-compartments> delta.
        expect(soft.m1).not.toBe(baseline.m1);
        expect(soft.m1).toContain("Bravo delta");
        expect(soft.m0).not.toContain("Bravo delta");
    });

    it("HARD (model change): folds m[1] into m[0] and resets m[1] to placeholder", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Alpha baseline")]);
        pass({ projectDirectory, isCacheBustingPass: true });
        appendCompartments(db, SESSION_ID, [compartment(1, "B", "Bravo delta")]);
        // Surface B in m[1] first (SOFT), then the model switches.
        pass({ projectDirectory, isCacheBustingPass: true });

        const hard = pass({
            projectDirectory,
            isCacheBustingPass: true,
            hard: { ...BASE_HARD, modelKey: "anthropic/sonnet" },
        });
        expect(hard.reason).toBe("model_change");
        expect(hard.rematerialized).toBe(true);
        // B is now folded into the m[0] baseline; m[1] resets to placeholder.
        expect(hard.m0).toContain("Bravo delta");
        expect(hard.m1).toBe(M1_PLACEHOLDER);
    });

    it("HARD (system hash change): re-materializes m[0]", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Alpha baseline")]);
        pass({ projectDirectory, isCacheBustingPass: true });

        const hard = pass({
            projectDirectory,
            isCacheBustingPass: true,
            hard: { ...BASE_HARD, systemHash: "sys-v2" },
        });
        expect(hard.reason).toBe("system_hash");
        expect(hard.rematerialized).toBe(true);
    });

    it("an EMPTY current HARD signal is never treated as a change (no spurious fold)", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Alpha baseline")]);
        pass({ projectDirectory, isCacheBustingPass: true });

        // Unknown signals this pass (e.g. before tool.definition fires) must NOT
        // fold — "" means "no signal", not "changed to empty".
        const unknown = pass({
            projectDirectory,
            isCacheBustingPass: true,
            hard: {
                systemHash: "",
                modelKey: "",
                cacheExpired: false,
                lastResponseTime: 0,
            },
        });
        expect(unknown.rematerialized).toBe(false);
    });

    it("HARD (TTL idle): folds ONCE, then is idempotent across the multi-pass turn", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Alpha baseline")]);
        pass({ projectDirectory, isCacheBustingPass: true });

        // Simulate "came back after idle": the m[0] baseline was materialized in
        // the past, and a response completed AFTER that baseline (lastResponseTime
        // > materializedAt). Both are real past timestamps so the post-fold
        // materializedAt (= now) exceeds lastResponseTime → idempotent.
        const tPast = Date.now() - 60 * 60 * 1000;
        db.prepare(
            "UPDATE session_meta SET cached_m0_materialized_at = ? WHERE session_id = ?",
        ).run(tPast, SESSION_ID);
        const ttlHard: M0HardSignals = {
            ...BASE_HARD,
            cacheExpired: true,
            lastResponseTime: tPast + 1000,
        };

        const fold = pass({ projectDirectory, isCacheBustingPass: true, hard: ttlHard });
        expect(fold.reason).toBe("ttl_idle");
        expect(fold.rematerialized).toBe(true);

        // Same signals again within the turn: cacheExpired stays true, but the
        // fold advanced materializedAt to now, so lastResponseTime (past) is no
        // longer > materializedAt → no re-fold.
        const again = pass({ projectDirectory, isCacheBustingPass: true, hard: ttlHard });
        expect(again.rematerialized).toBe(false);
        expect(again.reason).not.toBe("ttl_idle");
    });

    it("consumer-contract: mustMaterialize respects cacheExpired=false (never-ttl lanes stay warm)", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Alpha baseline")]);
        pass({ projectDirectory, isCacheBustingPass: true });

        // "never" resolves to Infinity in parseCacheTtl, so hardCacheExpired is
        // always false. Verify mustMaterialize does NOT fire ttl_idle even when
        // lastResponseTime is ancient — the "never" lane stays warm.
        const tPast = Date.now() - 10 * 24 * 60 * 60 * 1000; // 10 days ago
        db.prepare(
            "UPDATE session_meta SET cached_m0_materialized_at = ? WHERE session_id = ?",
        ).run(tPast - 1000, SESSION_ID);
        const neverHard: M0HardSignals = {
            ...BASE_HARD,
            cacheExpired: false, // "never" → hardCacheExpired stays false
            lastResponseTime: tPast,
        };

        const result = pass({ projectDirectory, isCacheBustingPass: true, hard: neverHard });
        expect(result.reason).not.toBe("ttl_idle");
        expect(result.rematerialized).toBe(false);
    });

    it("pressure backstop: small m[0] + large m[1] folds via the absolute m[1] cap", () => {
        // The ratio test (m1 > 15% of m0) is suppressed when m[0] is below the
        // 2000-char floor, so without an absolute cap a tiny-m[0] session could
        // grow m[1] unbounded after the max_compartment_seq trigger was removed.
        // The absolute cap (m[1] > 20% of the history budget) catches this.
        db = makeDb();
        const projectDirectory = makeProjectDir();
        // Tiny baseline m[0] (well under the 2000-char ratio floor).
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Ax")]);
        // Drive with a SMALL history budget so the absolute cap (20% of budget) is
        // easily exceeded by a few new compartments rendered at full P1 in m[1].
        const smallBudget: M0HardSignals = BASE_HARD;
        const baseline = injectM0M1({
            db,
            sessionId: SESSION_ID,
            state: getOrCreateSessionMeta(db, SESSION_ID),
            projectPath: PROJECT_PATH,
            projectDirectory,
            historyBudgetTokens: 60,
            isCacheBustingPass: true,
            hardSignals: smallBudget,
        });
        expect(baseline.decision.reason).toBe("first_render");

        // Append several compartments → m[1] grows past 20% of the 60-token budget.
        appendCompartments(db, SESSION_ID, [
            compartment(1, "B", "Bravo delta with enough words to consume tokens"),
            compartment(2, "C", "Charlie delta with more words again to consume more tokens"),
            compartment(3, "D", "Delta delta even more words here for tokens and tokens"),
        ]);
        const folded = injectM0M1({
            db,
            sessionId: SESSION_ID,
            state: getOrCreateSessionMeta(db, SESSION_ID),
            projectPath: PROJECT_PATH,
            projectDirectory,
            historyBudgetTokens: 60,
            isCacheBustingPass: true,
            hardSignals: smallBudget,
        });
        // The absolute-cap backstop folded m[1] into m[0] this pass.
        expect(folded.m0RematerializedThisPass).toBe(true);
        expect(folded.m1Text).toBe(M1_PLACEHOLDER);
    });

    it("HARD markers persist across a simulated restart (DB read, not in-memory)", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Alpha baseline")]);
        pass({ projectDirectory, isCacheBustingPass: true, hard: BASE_HARD });

        // Fresh state read from DB (mirrors a restart): the persisted markers must
        // match BASE_HARD so a same-identity pass does NOT spuriously fold.
        const restartState = getOrCreateSessionMeta(db, SESSION_ID);
        expect(restartState.cachedM0ModelKey).toBe("anthropic/opus");
        expect(restartState.cachedM0SystemHash).toBe("sys-v1");

        const noFold = pass({ projectDirectory, isCacheBustingPass: true, hard: BASE_HARD });
        expect(noFold.rematerialized).toBe(false);
    });
});
