/// <reference types="bun-types" />
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";

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
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPluginConfigDetailed } from "../../config";
import { historianRunConfig } from "../../config/live-run-config";
import { LiveConfigReader } from "../../config/live-snapshot";
import {
    appendCompartments,
    type CompartmentInput,
} from "../../features/magic-context/compartment-storage";
import { LATEST_MIGRATION_VERSION } from "../../features/magic-context/migrations";
import { v2ToolDefinitionsHash } from "../../features/magic-context/request-tool-definitions";
import { clearCachedM0M1, getOrCreateSessionMeta } from "../../features/magic-context/storage";
import {
    initializeDatabase,
    LATEST_SUPPORTED_VERSION,
} from "../../features/magic-context/storage-db";
import { resolveHistorianModel } from "../../shared/model-resolution";
import { Database } from "../../shared/sqlite";
import {
    readCachedM0ToolDefinitionsHash,
    withCachedM0ToolDefinitionsHash,
} from "./compartment-render-epoch";
import {
    clearInjectionCache,
    injectM0M1,
    type M0HardSignals,
    materializeM0,
    mustMaterialize,
} from "./inject-compartments";

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
    const dir = createTestTempDirFromPath(join(tmpdir(), "mc-taxonomy-test-"));
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
    systemHashPrev: string | null;
    systemHashNew: string | null;
    m0ModelKeyPrev: string | null;
    m0ModelKeyNew: string | null;
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
        systemHashPrev: result.decision.systemHashPrev ?? null,
        systemHashNew: result.decision.systemHashNew ?? null,
        m0ModelKeyPrev: result.decision.m0ModelKeyPrev ?? null,
        m0ModelKeyNew: result.decision.m0ModelKeyNew ?? null,
    };
}

afterEach(() => {
    if (db) db.close();
    clearInjectionCache(SESSION_ID);
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
});

describe("m[0]/m[1] materialization taxonomy", () => {
    it("request identity adoption is one metadata write, not an upgrade-state fold, across defer and restart", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Frozen baseline")]);
        const baseline = pass({ projectDirectory, isCacheBustingPass: true });
        db.exec(`CREATE TEMP TABLE adoption_writes (identity TEXT);
            CREATE TEMP TRIGGER count_adoption AFTER UPDATE OF cached_m0_upgrade_state ON session_meta
            BEGIN INSERT INTO adoption_writes VALUES (NEW.cached_m0_upgrade_state); END`);
        const hard = { ...BASE_HARD, toolDefinitionsHash: "observed-tools" };
        const state = getOrCreateSessionMeta(db, SESSION_ID);
        const before = state.cachedM0UpgradeState;
        expect(
            mustMaterialize({
                db,
                sessionId: SESSION_ID,
                state,
                projectPath: PROJECT_PATH,
                projectDirectory,
                historyBudgetTokens: 98_000,
                hardSignals: BASE_HARD,
            }).value,
        ).toBe(false);
        expect(db.query("SELECT COUNT(*) AS n FROM adoption_writes").get()).toEqual({ n: 0 });
        const decide = () =>
            mustMaterialize({
                db,
                sessionId: SESSION_ID,
                state,
                projectPath: PROJECT_PATH,
                projectDirectory,
                historyBudgetTokens: 98_000,
                hardSignals: hard,
            });
        expect(decide()).toMatchObject({ value: false, reason: null });
        expect(decide()).toMatchObject({ value: false, reason: null });
        expect(db.query("SELECT COUNT(*) AS n FROM adoption_writes").get()).toEqual({ n: 1 });
        expect(withCachedM0ToolDefinitionsHash(state.cachedM0UpgradeState, null)).toBe(before);
        const replay = pass({ projectDirectory, isCacheBustingPass: false, hard });
        expect(replay.reason).toBeNull();
        expect([replay.m0, replay.m1]).toEqual([baseline.m0, baseline.m1]);
        clearInjectionCache(SESSION_ID);
        expect(pass({ projectDirectory, isCacheBustingPass: false, hard }).rematerialized).toBe(
            false,
        );
        expect(db.query("SELECT COUNT(*) AS n FROM adoption_writes").get()).toEqual({ n: 1 });
    });

    it("stale adoption cannot overwrite a concurrently folded tool identity", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Frozen baseline")]);
        pass({ projectDirectory, isCacheBustingPass: true });
        const stale = getOrCreateSessionMeta(db, SESSION_ID);
        appendCompartments(db, SESSION_ID, [compartment(1, "B", "Concurrent fold")]);
        const hard = { ...BASE_HARD, toolDefinitionsHash: "concurrent-tools" };
        pass({ projectDirectory, isCacheBustingPass: false, hard });
        const committed = getOrCreateSessionMeta(db, SESSION_ID);
        const decision = mustMaterialize({
            db,
            sessionId: SESSION_ID,
            state: stale,
            projectPath: PROJECT_PATH,
            projectDirectory,
            historyBudgetTokens: 98_000,
            hardSignals: { ...BASE_HARD, toolDefinitionsHash: "stale-tools" },
        });
        expect(decision.value).toBe(false);
        const after = getOrCreateSessionMeta(db, SESSION_ID);
        expect(after.cachedM0UpgradeState).toBe(committed.cachedM0UpgradeState);
        expect(after.cachedM0Bytes).toEqual(committed.cachedM0Bytes);
        expect(after.cachedM0MaterializedAt).toBe(committed.cachedM0MaterializedAt);
        expect(readCachedM0ToolDefinitionsHash(stale.cachedM0UpgradeState)).toBeNull();
        expect(pass({ projectDirectory, isCacheBustingPass: false, hard }).rematerialized).toBe(
            false,
        );
    });

    it("cached-row recovery retains the tool component for the following restart pass", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Frozen baseline")]);
        pass({ projectDirectory, isCacheBustingPass: true });
        const state = getOrCreateSessionMeta(db, SESSION_ID);
        const identity = withCachedM0ToolDefinitionsHash(
            state.cachedM0UpgradeState,
            "sibling-tools",
        );
        const result = injectM0M1({
            db,
            sessionId: SESSION_ID,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            historyBudgetTokens: 98_000,
            hardSignals: BASE_HARD,
            isCacheBustingPass: true,
            beforeCacheCommitForTest: () => {
                db.prepare(
                    "UPDATE session_meta SET cached_m0_upgrade_state = ? WHERE session_id = ?",
                ).run(identity, SESSION_ID);
            },
        });
        expect(result.m0RematerializedThisPass).toBe(false);
        expect(readCachedM0ToolDefinitionsHash(state.cachedM0UpgradeState)).toBe("sibling-tools");
        clearInjectionCache(SESSION_ID);
        expect(
            pass({
                projectDirectory,
                isCacheBustingPass: false,
                hard: { ...BASE_HARD, toolDefinitionsHash: "sibling-tools" },
            }).rematerialized,
        ).toBe(false);
    });

    it("session request definitions adopt an upgraded baseline silently, then fold exactly once per real change", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Alpha baseline")]);
        const baseline = pass({ projectDirectory, isCacheBustingPass: true });
        const legacyIdentity = getOrCreateSessionMeta(db, SESSION_ID).cachedM0UpgradeState;
        const tools = {
            read: { description: "Read a file", input: { type: "object", properties: {} } },
        };
        const hash = v2ToolDefinitionsHash(tools);
        const signal = { ...BASE_HARD, toolDefinitionsHash: hash };
        const upgraded = pass({ projectDirectory, isCacheBustingPass: false, hard: signal });
        expect(upgraded.rematerialized).toBe(false);
        expect([upgraded.m0, upgraded.m1]).toEqual([baseline.m0, baseline.m1]);
        expect(
            readCachedM0ToolDefinitionsHash(
                getOrCreateSessionMeta(db, SESSION_ID).cachedM0UpgradeState,
            ),
        ).toBe(hash);
        expect(
            withCachedM0ToolDefinitionsHash(
                getOrCreateSessionMeta(db, SESSION_ID).cachedM0UpgradeState,
                null,
            ),
        ).toBe(legacyIdentity);

        // Changing field insertion order does not change OpenCode's projected
        // definition; a JSON round trip also leaves the served definitions alone.
        const reordered = {
            read: { input: tools.read.input, description: tools.read.description },
        };
        expect(v2ToolDefinitionsHash(reordered)).toBe(hash);
        expect(v2ToolDefinitionsHash(JSON.parse(JSON.stringify(tools)))).toBe(hash);
        appendCompartments(db, SESSION_ID, [compartment(1, "B", "Bravo delta")]);
        const unchanged = pass({ projectDirectory, isCacheBustingPass: false, hard: signal });
        expect([unchanged.m0, unchanged.m1]).toEqual([baseline.m0, baseline.m1]);

        const described = { read: { ...tools.read, description: "Read the whole file" } };
        const reschemed = {
            read: {
                ...tools.read,
                input: { type: "object", properties: { path: { type: "string" } } },
            },
        };
        expect(v2ToolDefinitionsHash(reschemed)).toBe(hash);
        const schemaOnly = pass({
            projectDirectory,
            isCacheBustingPass: false,
            hard: { ...BASE_HARD, toolDefinitionsHash: v2ToolDefinitionsHash(reschemed) },
        });
        expect(schemaOnly.rematerialized).toBe(false);
        expect([schemaOnly.m0, schemaOnly.m1]).toEqual([baseline.m0, baseline.m1]);
        const variants = [described];
        for (const definitions of variants) {
            const hard = { ...BASE_HARD, toolDefinitionsHash: v2ToolDefinitionsHash(definitions) };
            const state = getOrCreateSessionMeta(db, SESSION_ID);
            const run = () =>
                injectM0M1({
                    db,
                    sessionId: SESSION_ID,
                    state,
                    projectPath: PROJECT_PATH,
                    projectDirectory,
                    historyBudgetTokens: 98_000,
                    isCacheBustingPass: false,
                    hardSignals: hard,
                });
            const folded = run();
            expect(folded.decision.reason).toBe("tool_definitions");
            expect(folded.decision.toolDefinitionsChange?.firstDifferingTool).not.toBe("unknown");
            expect(folded.m0RematerializedThisPass).toBe(true);
            expect(folded.m0Bytes!.toString()).toContain("Bravo delta");
            expect(readCachedM0ToolDefinitionsHash(state.cachedM0UpgradeState)).toBe(
                hard.toolDefinitionsHash,
            );
            expect(run().m0RematerializedThisPass).toBe(false);
            expect(pass({ projectDirectory, isCacheBustingPass: false, hard }).rematerialized).toBe(
                false,
            );
        }
        const unknown = pass({ projectDirectory, isCacheBustingPass: false, hard: BASE_HARD });
        expect(unknown.rematerialized).toBe(false);
    });

    it.each([
        "add",
        "remove",
        "rename",
        "re-describe",
    ] as const)("%s alone folds the observed name/description set exactly once", (change) => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const tools = {
            read: { description: "Read a file", input: { type: "object", properties: {} } },
            write: { description: "Write a file", input: { type: "object", properties: {} } },
        };
        const initial = { ...BASE_HARD, toolDefinitionsHash: v2ToolDefinitionsHash(tools) };
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Alpha baseline")]);
        const baseline = pass({ projectDirectory, isCacheBustingPass: true, hard: initial });
        appendCompartments(db, SESSION_ID, [compartment(1, "B", "Bravo held until a rebuild")]);
        expect(pass({ projectDirectory, isCacheBustingPass: false, hard: initial }).m0).toBe(
            baseline.m0,
        );
        const changed: Record<string, { description: string; input: unknown }> = { ...tools };
        if (change === "add") changed.list = { description: "List a directory", input: {} };
        if (change === "remove") delete changed.write;
        if (change === "rename") {
            delete changed.read;
            changed.reader = tools.read;
        }
        if (change === "re-describe")
            changed.read = { ...tools.read, description: "Read the entire file" };
        const hard = { ...BASE_HARD, toolDefinitionsHash: v2ToolDefinitionsHash(changed) };
        const folded = pass({ projectDirectory, isCacheBustingPass: false, hard });
        expect(folded.reason).toBe("tool_definitions");
        expect(folded.rematerialized).toBe(true);
        expect(folded.m0).toContain("Bravo held until a rebuild");
        for (let index = 0; index < 2; index++) {
            const next = pass({ projectDirectory, isCacheBustingPass: false, hard });
            expect(next.rematerialized).toBe(false);
            expect([next.m0, next.m1]).toEqual([folded.m0, folded.m1]);
        }
    });

    it.each([
        "schema-only",
        "tool reordering",
    ] as const)("%s never folds or releases held history", (change) => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const tools = {
            read: { description: "Read a file", input: { properties: {} } },
            write: { description: "Write a file", input: { type: "object", properties: {} } },
        };
        const hash = v2ToolDefinitionsHash(tools);
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Alpha baseline")]);
        const baseline = pass({
            projectDirectory,
            isCacheBustingPass: true,
            hard: { ...BASE_HARD, toolDefinitionsHash: hash },
        });
        appendCompartments(db, SESSION_ID, [compartment(1, "B", "Bravo held until a rebuild")]);
        const variants =
            change === "schema-only"
                ? [
                      {
                          ...tools,
                          read: { ...tools.read, input: { type: "object", properties: {} } },
                      },
                      {
                          ...tools,
                          read: {
                              ...tools.read,
                              input: {
                                  type: "object",
                                  properties: { path: { type: "string" } },
                                  required: ["path"],
                              },
                          },
                      },
                  ]
                : [{ write: tools.write, read: tools.read }, { ...tools }];
        for (const definitions of variants) {
            expect(v2ToolDefinitionsHash(definitions)).toBe(hash);
            const next = pass({
                projectDirectory,
                isCacheBustingPass: false,
                hard: { ...BASE_HARD, toolDefinitionsHash: v2ToolDefinitionsHash(definitions) },
            });
            expect(next.rematerialized).toBe(false);
            expect([next.m0, next.m1]).toEqual([baseline.m0, baseline.m1]);
        }
    });

    it("an older raw-schema fingerprint adopts the name/description scope without a paid fold", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Alpha baseline")]);
        const baseline = pass({ projectDirectory, isCacheBustingPass: true });
        const state = getOrCreateSessionMeta(db, SESSION_ID);
        const legacy = JSON.stringify({
            hash: "old-raw-schema",
            tools: [["read", "old-content-digest"]],
        });
        db.prepare("UPDATE session_meta SET cached_m0_upgrade_state = ? WHERE session_id = ?").run(
            withCachedM0ToolDefinitionsHash(state.cachedM0UpgradeState, legacy),
            SESSION_ID,
        );
        const hard = {
            ...BASE_HARD,
            toolDefinitionsHash: v2ToolDefinitionsHash({
                read: { description: "Read a file", input: {} },
            }),
        };
        const adopted = pass({ projectDirectory, isCacheBustingPass: false, hard });
        expect(adopted.rematerialized).toBe(false);
        expect([adopted.m0, adopted.m1]).toEqual([baseline.m0, baseline.m1]);
        expect(
            readCachedM0ToolDefinitionsHash(
                getOrCreateSessionMeta(db, SESSION_ID).cachedM0UpgradeState,
            ),
        ).toBe(hard.toolDefinitionsHash);
        expect(pass({ projectDirectory, isCacheBustingPass: false, hard }).rematerialized).toBe(
            false,
        );
    });

    it("request tool identity is written and cleared atomically with the frozen markers at fence 95", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        expect(LATEST_MIGRATION_VERSION).toBe(95);
        expect(LATEST_SUPPORTED_VERSION).toBe(95);
        expect(
            (db.prepare("PRAGMA table_info(session_meta)").all() as Array<{ name: string }>).map(
                ({ name }) => name,
            ),
        ).not.toContain("cached_m0_tool_definitions_hash");
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Alpha baseline")]);
        const beforeSignals = { ...BASE_HARD, toolDefinitionsHash: "tools-before" };
        pass({ projectDirectory, isCacheBustingPass: true, hard: beforeSignals });
        const snapshot = () =>
            db
                .prepare(`SELECT hex(cached_m0_bytes) AS m0, hex(cached_m1_bytes) AS m1,
            cached_m0_upgrade_state AS identity, cached_m0_system_hash AS system,
            cached_m0_model_key AS model, cached_m0_materialized_at AS at,
            cached_m0_max_compartment_seq AS seq FROM session_meta WHERE session_id = ?`)
                .get(SESSION_ID);
        const before = snapshot();
        expect(
            readCachedM0ToolDefinitionsHash(
                getOrCreateSessionMeta(db, SESSION_ID).cachedM0UpgradeState,
            ),
        ).toBe("tools-before");
        appendCompartments(db, SESSION_ID, [compartment(1, "B", "Bravo delta")]);
        db.exec(`CREATE TEMP TRIGGER reject_fold_marker BEFORE UPDATE OF cached_m0_bytes ON session_meta
            BEGIN SELECT RAISE(ABORT, 'fold write rejected'); END`);
        expect(() =>
            materializeM0({
                db,
                sessionId: SESSION_ID,
                state: getOrCreateSessionMeta(db, SESSION_ID),
                projectPath: PROJECT_PATH,
                projectDirectory,
                historyBudgetTokens: 98_000,
                hardSignals: { ...BASE_HARD, toolDefinitionsHash: "tools-after" },
            }),
        ).toThrow("fold write rejected");
        expect(snapshot()).toEqual(before);
        db.exec("DROP TRIGGER reject_fold_marker");
        const folded = pass({
            projectDirectory,
            isCacheBustingPass: false,
            hard: { ...BASE_HARD, toolDefinitionsHash: "tools-after" },
        });
        expect(folded.rematerialized).toBe(true);
        expect(folded.m0).toContain("Bravo delta");
        expect(
            readCachedM0ToolDefinitionsHash(
                getOrCreateSessionMeta(db, SESSION_ID).cachedM0UpgradeState,
            ),
        ).toBe("tools-after");
        const committed = snapshot();
        db.exec(`CREATE TEMP TRIGGER reject_clear_marker BEFORE UPDATE OF cached_m0_bytes ON session_meta
            WHEN NEW.cached_m0_bytes IS NULL BEGIN SELECT RAISE(ABORT, 'clear write rejected'); END`);
        expect(() => clearCachedM0M1(db, SESSION_ID)).toThrow("clear write rejected");
        expect(snapshot()).toEqual(committed);
        db.exec("DROP TRIGGER reject_clear_marker");
        clearCachedM0M1(db, SESSION_ID);
        const cleared = getOrCreateSessionMeta(db, SESSION_ID);
        expect(cleared.cachedM0Bytes).toBeNull();
        expect(cleared.cachedM1Bytes).toBeNull();
        expect(cleared.cachedM0UpgradeState).toBeNull();
        expect(cleared.cachedM0SystemHash).toBeNull();
        expect(cleared.cachedM0ModelKey).toBeNull();
        expect(readCachedM0ToolDefinitionsHash(cleared.cachedM0UpgradeState)).toBeNull();
    });

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
        expect(hard.m0ModelKeyPrev).toBe("anthropic/opus");
        expect(hard.m0ModelKeyNew).toBe("anthropic/sonnet");
        expect(hard.systemHashPrev).toBeNull();
        expect(hard.systemHashNew).toBeNull();
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
        expect(hard.systemHashPrev).toBe("sys-v1");
        expect(hard.systemHashNew).toBe("sys-v2");
        expect(hard.m0ModelKeyPrev).toBeNull();
        expect(hard.m0ModelKeyNew).toBeNull();
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
    it("does not hard-fold when the current model switches from canonical to Pi alias spelling", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const canonical = { ...BASE_HARD, modelKey: "openai/gpt-5.6-sol" };
        pass({ projectDirectory, isCacheBustingPass: true, hard: canonical });

        const aliasOnly = pass({
            projectDirectory,
            isCacheBustingPass: true,
            hard: { ...BASE_HARD, modelKey: "openai-codex/gpt-5.6-sol" },
        });

        expect(aliasOnly.rematerialized).toBe(false);
        expect(aliasOnly.reason).toBeNull();
    });

    it("persists a Pi-native baseline canonically, then accepts the reverse spelling flip", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        pass({
            projectDirectory,
            isCacheBustingPass: true,
            hard: { ...BASE_HARD, modelKey: "openai-codex/gpt-5.6-sol" },
        });

        expect(getOrCreateSessionMeta(db, SESSION_ID).cachedM0ModelKey).toBe("openai/gpt-5.6-sol");
        const aliasOnly = pass({
            projectDirectory,
            isCacheBustingPass: true,
            hard: { ...BASE_HARD, modelKey: "openai/gpt-5.6-sol" },
        });

        expect(aliasOnly.rematerialized).toBe(false);
        expect(aliasOnly.reason).toBeNull();
    });

    it("does not hard-fold when an existing cached baseline stores a native alias", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        pass({
            projectDirectory,
            isCacheBustingPass: true,
            hard: { ...BASE_HARD, modelKey: "openai/gpt-5.6-sol" },
        });
        db.prepare("UPDATE session_meta SET cached_m0_model_key = ? WHERE session_id = ?").run(
            "openai-codex/gpt-5.6-sol",
            SESSION_ID,
        );

        const upgraded = pass({
            projectDirectory,
            isCacheBustingPass: true,
            hard: { ...BASE_HARD, modelKey: "openai/gpt-5.6-sol" },
        });

        expect(upgraded.rematerialized).toBe(false);
        expect(upgraded.reason).toBeNull();
    });

    it("still hard-folds for different models in the same alias family", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        pass({
            projectDirectory,
            isCacheBustingPass: true,
            hard: { ...BASE_HARD, modelKey: "openai-codex/gpt-5.6-sol" },
        });

        const realSwitch = pass({
            projectDirectory,
            isCacheBustingPass: true,
            hard: { ...BASE_HARD, modelKey: "openai/gpt-5.6-codex" },
        });

        expect(realSwitch.rematerialized).toBe(true);
        expect(realSwitch.reason).toBe("model_change");
    });
});

it("class-B protected_tokens edit remains boot-bound across a live-config defer pass", () => {
    const projectDirectory = makeProjectDir();
    const configHome = makeProjectDir();
    const oldHome = process.env.HOME;
    const oldConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.HOME = configHome;
    process.env.XDG_CONFIG_HOME = configHome;
    const configDir = join(configHome, "cortexkit");
    mkdirSync(configDir, { recursive: true });
    const configFile = join(configDir, "magic-context.jsonc");
    try {
        writeFileSync(
            configFile,
            JSON.stringify({
                protected_tokens: 16000,
                toast_duration_ms: 1500,
                historian: { opencode: { model: "old/model" } },
            }),
        );
        const load = () => loadPluginConfigDetailed(projectDirectory, false).config;
        const boot = load();
        const reader = new LiveConfigReader(projectDirectory, boot, load, () => {});
        reader.poll();
        db = makeDb();
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Alpha baseline")]);
        const seeded = pass({ projectDirectory, isCacheBustingPass: true });
        writeFileSync(
            configFile,
            JSON.stringify({
                protected_tokens: 24000,
                toast_duration_ms: 2900,
                historian: { opencode: { model: "new/model-long" } },
            }),
        );
        const run = historianRunConfig(boot, reader.poll().effective);
        expect(run.protected_tokens).toBe(16000);
        expect(run.toast_duration_ms).toBe(2900);
        expect(resolveHistorianModel(run, "opencode").primary?.model).toBe("new/model-long");
        const deferred = pass({ projectDirectory, isCacheBustingPass: false });
        expect(deferred.m0).toBe(seeded.m0);
        expect(deferred.m1).toBe(seeded.m1);
        expect(deferred.rematerialized).toBe(false);
    } finally {
        if (oldHome === undefined) delete process.env.HOME;
        else process.env.HOME = oldHome;
        if (oldConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = oldConfigHome;
    }
});
