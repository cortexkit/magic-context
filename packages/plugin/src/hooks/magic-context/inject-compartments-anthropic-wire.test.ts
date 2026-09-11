/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage-meta-session";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { decodeCachedM0UpgradeIdentity } from "./compartment-render-epoch";
import { injectM0M1, type M0M1State } from "./inject-compartments";

const SESSION_ID = "ses_anthropic_wire_inject";
const PROJECT_ID = "git:anthropic-wire-project";

function makeDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    getOrCreateSessionMeta(db, SESSION_ID);
    return db;
}

const MODEL_KEY = "my_gateway/claude-opus-5";

function hardSignals(modelKey: string) {
    return {
        systemHash: "system-hash-1",
        toolSetHash: "tool-hash-1",
        modelKey,
        cacheExpired: false,
        lastResponseTime: 0,
    };
}

function pass(
    db: Database,
    state: M0M1State,
    options: {
        anthropicWireWidened?: boolean;
        isCacheBustingPass?: boolean;
        /** Empty string stands for "the live model is not observable this pass". */
        modelKey?: string;
    },
) {
    return injectM0M1({
        db,
        sessionId: SESSION_ID,
        messages: [],
        state,
        projectPath: PROJECT_ID,
        isCacheBustingPass: options.isCacheBustingPass ?? false,
        anthropicWireWidened: options.anthropicWireWidened,
        hardSignals: hardSignals(options.modelKey ?? MODEL_KEY),
        memoryInjectionBudgetTokens: 8_000,
        historyBudgetTokens: 60_000,
    });
}

/**
 * The empty-sentinel capability changes provider-visible tail bytes, so a change
 * has to fold m[0] exactly once rather than rewrite the tail underneath a cached
 * prefix on a defer pass. These tests pin "exactly once" in both directions and
 * pin the cases that must never fold.
 */
describe("m[0] upgrade identity: anthropic-wire capability", () => {
    it("folds once when a session's model is newly resolved as Anthropic wire", () => {
        const db = makeDb();
        try {
            const state = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
            // A session materialized before this capability existed carries no
            // component, which reads as "not widened".
            pass(db, state, { anthropicWireWidened: false, isCacheBustingPass: true });
            expect(
                decodeCachedM0UpgradeIdentity(state.cachedM0UpgradeState).anthropicWireWidened,
            ).toBe(false);

            const widened = pass(db, state, { anthropicWireWidened: true });
            expect(widened.decision).toEqual({ value: true, reason: "render_config" });
            expect(widened.m0RematerializedThisPass).toBe(true);
            expect(
                decodeCachedM0UpgradeIdentity(state.cachedM0UpgradeState).anthropicWireWidened,
            ).toBe(true);

            // Exactly once: the next pass replays the folded baseline.
            const settled = pass(db, state, { anthropicWireWidened: true });
            expect(settled.m0RematerializedThisPass).toBe(false);
            expect(settled.m0Bytes).toEqual(widened.m0Bytes);
        } finally {
            closeQuietly(db);
        }
    });

    it("folds once in the narrowing direction too", () => {
        const db = makeDb();
        try {
            const state = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
            pass(db, state, { anthropicWireWidened: true, isCacheBustingPass: true });

            const narrowed = pass(db, state, { anthropicWireWidened: false });
            expect(narrowed.decision).toEqual({ value: true, reason: "render_config" });

            const settled = pass(db, state, { anthropicWireWidened: false });
            expect(settled.m0RematerializedThisPass).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });

    it("never folds for a session that is not registry-widened", () => {
        const db = makeDb();
        try {
            const state = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
            // Canonical Anthropic and every non-Anthropic provider report `false`:
            // the component is absent on both sides, so this reason can never fire.
            pass(db, state, { anthropicWireWidened: false, isCacheBustingPass: true });
            expect(
                decodeCachedM0UpgradeIdentity(state.cachedM0UpgradeState).anthropicWireWidened,
            ).toBe(false);

            for (let index = 0; index < 3; index += 1) {
                const later = pass(db, state, { anthropicWireWidened: false });
                expect(later.m0RematerializedThisPass).toBe(false);
            }
        } finally {
            closeQuietly(db);
        }
    });

    it("never folds while the live model is not observable", () => {
        const db = makeDb();
        try {
            const state = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
            // A pass that cannot see its model must not fold: reading "unknown" as
            // "not widened" would fold once on the next pass that does resolve it,
            // on a session whose capability never changed.
            pass(db, state, {
                anthropicWireWidened: false,
                isCacheBustingPass: true,
                modelKey: "",
            });
            const unknown = pass(db, state, { anthropicWireWidened: true, modelKey: "" });
            expect(unknown.decision.reason).not.toBe("render_config");
        } finally {
            closeQuietly(db);
        }
    });

    it("leaves a changed model to the model-change trigger instead of double-attributing", () => {
        const db = makeDb();
        try {
            const state = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
            pass(db, state, { anthropicWireWidened: true, isCacheBustingPass: true });

            // Switching to a model that is not registry-widened flips the capability
            // AND the model key. One fold, attributed to the model change.
            const switched = pass(db, state, {
                anthropicWireWidened: false,
                modelKey: "openai/gpt-6",
            });
            expect(switched.decision).toEqual({
                value: true,
                reason: "model_change",
                m0ModelKeyPrev: MODEL_KEY,
                m0ModelKeyNew: "openai/gpt-6",
            });
        } finally {
            closeQuietly(db);
        }
    });

    it("treats an omitted capability as not widened rather than as a change", () => {
        const db = makeDb();
        try {
            const state = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
            pass(db, state, { isCacheBustingPass: true });
            const later = pass(db, state, {});
            expect(later.m0RematerializedThisPass).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });
});
