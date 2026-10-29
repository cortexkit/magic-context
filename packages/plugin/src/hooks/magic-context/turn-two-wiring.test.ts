/// <reference types="bun-types" />

/**
 * Production host wiring for memory-lifecycle turn two.
 *
 * Each OpenCode host reads its own settings and hands the historian runner the
 * `historian.turn_two` switch, the reviewed allowlist and any trial
 * authorization. These tests capture what each host puts in the runner's deps,
 * then show that the runner's selection against that input enables turn two only
 * for an allowlist entry matching the identity the host builds.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MagicContextConfigSchema } from "../../config/schema/magic-context";
import { replaceAllCompartments } from "../../features/magic-context/compartment-storage";
import { resolveProjectIdentity } from "../../features/magic-context/memory/project-identity";
import { selectTurnOneExecution } from "../../features/magic-context/memory/turn-one-publication";
import { loadTurnTwoAllowlist } from "../../features/magic-context/memory/turn-two-allowlist";
import {
    closeDatabase,
    openDatabase,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import type { PluginContext } from "../../plugin/types";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { COMPARTMENT_AGENT_COMBINED_SYSTEM_PROMPT } from "./compartment-prompt";
import * as runnerModule from "./compartment-runner";
import type { HiddenCompartmentRunnerDeps } from "./compartment-runner-types";
import { openCodeTurnOneAuthorization } from "./historian-turn-two-step";
import { createMagicContextHook } from "./hook";
import { createLiveSessionState } from "./live-session-state";
import {
    clearProducerModelObservations,
    observeProducerModelsForTest,
} from "./producer-window-test-support";
import { buildRecompDeps, type ManagedRecompContext } from "./recomp-orchestrator";
import { __ignoredNotificationTest } from "./send-session-notification";
import { runCompartmentPhase } from "./transform-compartment-phase";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

const SESSION = "ses-turn-two-wiring";
const DIRECTORY = join(tmpdir(), "turn-two-wiring-project");
/** The historian model these tests configure and observe for the window guard. */
const HISTORIAN_MODEL = "test/validation-historian";

const RAW_MESSAGES = [
    { id: "m-1", role: "user", text: "zero" },
    { id: "m-2", role: "assistant", text: "one" },
    { id: "m-3", role: "user", text: "Cap the upload at 64 KiB." },
    { id: "m-4", role: "assistant", text: "Done." },
    ...[5, 6, 7, 8, 9].map((n) => ({ id: `m-${n}`, role: "user", text: `protected ${n}` })),
];

/** The turn-one identity OpenCode 1 builds for the carrier these tests' client provides. */
const openCodeOneRequest = () =>
    openCodeTurnOneAuthorization({
        harness: "opencode",
        carrier: "opencode-session",
        model: HISTORIAN_MODEL,
        system: COMPARTMENT_AGENT_COMBINED_SYSTEM_PROMPT,
    });

beforeEach(async () => {
    await observeProducerModelsForTest([HISTORIAN_MODEL]);
    __ignoredNotificationTest.setHoldDetector(() => false);
});

afterEach(() => {
    clearProducerModelObservations();
    __ignoredNotificationTest.reset();
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    tempDirs.length = 0;
});

function useTempDataHome(prefix: string): void {
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

/**
 * Create the store for a trial-authorization case: a canonical, non-symlinked
 * disposable root under $TMPDIR/magic-context that also holds the open database,
 * which is the only shape trial authorization accepts.
 */
function openTrialStore(suffix: string): { db: Database; root: string } {
    // The helper inserts its own ownership prefix, so the base must be built
    // directly rather than through it for the root to sit at the expected depth.
    const base = join(realpathSync.native(tmpdir()), "magic-context");
    mkdirSync(base, { recursive: true });
    const root = createTestTempDirFromPath(join(base, `turn-two-wiring-${suffix}-`));
    const canonical = realpathSync.native(root);
    const dataHome = join(canonical, "data");
    mkdirSync(dataHome, { recursive: true });
    process.env.XDG_DATA_HOME = dataHome;
    tempDirs.push(root);
    return { db: openDatabase(), root: canonical };
}

function createOpenCodeSession(sessionId: string): void {
    const dbPath = join(process.env.XDG_DATA_HOME!, "opencode", "opencode.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS part (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
        `);
        RAW_MESSAGES.forEach((message, index) => {
            const at = index + 1;
            db.prepare(
                "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
            ).run(
                message.id,
                sessionId,
                at,
                at,
                JSON.stringify({ id: message.id, role: message.role, sessionID: sessionId }),
            );
            db.prepare(
                "INSERT INTO part (message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
            ).run(
                message.id,
                sessionId,
                at,
                at,
                JSON.stringify({ type: "text", text: message.text }),
            );
        });
    } finally {
        closeQuietly(db);
    }
}

function seedPriorCompartment(db: Database, sessionId: string): void {
    replaceAllCompartments(db, sessionId, [
        {
            sequence: 0,
            startMessage: 1,
            endMessage: 2,
            startMessageId: "m-1",
            endMessageId: "m-2",
            title: "Earlier work",
            content: "Old summary",
        },
    ]);
}

function sdkClient(): PluginContext["client"] {
    return {
        session: {
            get: async () => ({ data: { directory: DIRECTORY } }),
            create: async () => ({ data: { id: `ses-child-${Math.random()}` } }),
            prompt: async () => ({}),
            messages: async () => ({ data: [] }),
            delete: async () => ({}),
        },
    } as unknown as PluginContext["client"];
}

/**
 * Run one turn-two phase pass and return the deps of every historian start it
 * made. The start is spied out: these tests are about the wiring, not the run.
 */
async function capturePhaseStarts(
    db: Database,
    settings: { historianTwoPass?: boolean; historianTurnTwo?: "allowlist" | "off" },
): Promise<HiddenCompartmentRunnerDeps[]> {
    const started: HiddenCompartmentRunnerDeps[] = [];
    const spy = spyOn(runnerModule, "startCompartmentAgent").mockImplementation(
        (deps: HiddenCompartmentRunnerDeps) => {
            started.push(deps);
        },
    );
    try {
        await runCompartmentPhase({
            canRunCompartments: true,
            fullFeatureMode: true,
            sessionMeta: { compartmentInProgress: true },
            contextUsage: { percentage: 25 },
            boundaryContextLimit: 200_000,
            boundaryExecuteThresholdPercentage: 65,
            boundaryUsage: { percentage: 25, inputTokens: 50_000 },
            boundaryUsageSource: "live",
            db,
            sessionId: SESSION,
            resolvedSessionId: SESSION,
            historianChunkTokens: 10_000,
            compartmentDirectory: DIRECTORY,
            historianModel: HISTORIAN_MODEL,
            messages: [],
            pendingCompartmentInjection: null,
            deferredHistoryRefreshSessions: new Set<string>(),
            client: sdkClient(),
            ...settings,
        });
    } finally {
        spy.mockRestore();
    }
    return started;
}

describe("OpenCode hosts hand turn_two, the allowlist and trial evidence to the runner", () => {
    it("the phase forwards historian.turn_two and injects no host-side lane inputs", async () => {
        useTempDataHome("turn-two-wiring-phase-");
        createOpenCodeSession(SESSION);
        const db = openDatabase();
        seedPriorCompartment(db, SESSION);
        const started = await capturePhaseStarts(db, {
            historianTwoPass: false,
            historianTurnTwo: "off",
        });
        expect(started).toHaveLength(1);
        expect(started[0]?.historianTurnTwo).toBe("off");
        expect(started[0]?.historianTwoPass).toBe(false);
        // The runner falls back to the shipped allowlist. validatedProfiles is the
        // test-only row source and no host may set it.
        expect(started[0]?.memoryLifecycleAllowlist).toBeUndefined();
        expect(started[0]?.memoryLifecycleTrialAuthorization).toBeUndefined();
        expect(started[0]?.memoryLifecycleValidatedProfiles).toBeUndefined();
        expect(loadTurnTwoAllowlist().entries).toEqual([]);
    });

    it("OpenCode 1 recomp context carries the live switch beside two_pass", () => {
        useTempDataHome("turn-two-wiring-recomp-");
        const db = openDatabase();
        const ctx = {
            client: sdkClient(),
            db,
            liveSessionState: createLiveSessionState(),
            directory: DIRECTORY,
            historianChunkTokens: 10_000,
            historianTimeoutMs: 60_000,
            memoryEnabled: true,
            autoPromote: false,
            fallbackModels: [],
            userMemoriesEnabled: false,
            getNotificationParams: () => ({}),
            historianTwoPass: true,
            historianTurnTwo: "off",
        } as unknown as ManagedRecompContext;
        const deps = buildRecompDeps(ctx, SESSION);
        expect(deps.historianTurnTwo).toBe("off");
        expect(deps.historianTwoPass).toBe(true);
        expect(deps.memoryLifecycleValidatedProfiles).toBeUndefined();
    });

    it("OpenCode 1 hook reaches the historian start with the sampled switch", async () => {
        useTempDataHome("turn-two-wiring-hook-");
        createOpenCodeSession(SESSION);
        const db = openDatabase();
        seedPriorCompartment(db, SESSION);
        // The flag is what asks the phase for a start; a firing from the ordinary
        // trigger path is covered by the phase test above.
        updateSessionMeta(db, SESSION, { compartmentInProgress: true });
        const config = MagicContextConfigSchema.parse({
            historian: { turn_two: "off", two_pass: true },
        });
        const started: Array<{ turnTwo?: string; twoPass?: boolean }> = [];
        const start = spyOn(runnerModule, "startCompartmentAgent").mockImplementation(
            (deps: HiddenCompartmentRunnerDeps) => {
                started.push({
                    turnTwo: deps.historianTurnTwo,
                    twoPass: deps.historianTwoPass,
                });
            },
        );
        try {
            const hook = createMagicContextHook({
                client: sdkClient(),
                tagger: createTagger(),
                scheduler: { shouldExecute: () => "defer" },
                compactionHandler: { onCompacted: () => {} },
                directory: DIRECTORY,
                config,
                contextUsageMap: new Map([
                    [
                        SESSION,
                        {
                            usage: { percentage: 25, inputTokens: 50_000 },
                            updatedAt: Date.now(),
                        },
                    ],
                ]),
                liveSessionState: createLiveSessionState(),
            } as unknown as Parameters<typeof createMagicContextHook>[0]);
            expect(hook).not.toBeNull();
            const messages = RAW_MESSAGES.map((message) => ({
                info: { id: message.id, role: message.role, sessionID: SESSION },
                parts: [{ type: "text", text: message.text }],
            }));
            await hook!["experimental.chat.messages.transform"]!({}, {
                messages,
            } as unknown as Parameters<
                NonNullable<
                    ReturnType<typeof createMagicContextHook>
                >["experimental.chat.messages.transform"]
            >[1]);
            expect(started.length).toBeGreaterThan(0);
            // The hook samples config per firing; both switches arrive as configured.
            expect(started.at(-1)).toEqual({ turnTwo: "off", twoPass: true });
        } finally {
            start.mockRestore();
        }
    });
});

describe("the runner's selection against what the hosts hand it", () => {
    it("the shipped empty allowlist keeps an OpenCode 1 firing dormant", () => {
        useTempDataHome("turn-two-wiring-empty-");
        const db = openDatabase();
        expect(
            selectTurnOneExecution(db, {
                projectPath: resolveProjectIdentity(DIRECTORY),
                request: openCodeOneRequest(),
                turnTwo: "allowlist",
                twoPass: false,
                canContinue: true,
                allowlist: loadTurnTwoAllowlist(),
            }).lane,
        ).toBe("dormant");
    });

    it("an allowlist entry matching the OpenCode 1 identity enables it, and only that entry", () => {
        useTempDataHome("turn-two-wiring-select-");
        const db = openDatabase();
        const request = openCodeOneRequest();
        const entry = request.requestedIdentity;
        // The entry is the host's own identity, not a hand-copied tuple: this proves
        // the identity a host builds is the one selection compares against.
        const matching = loadTurnTwoAllowlist({ version: 1, entries: [entry] });
        expect(matching.entries).toHaveLength(1);
        const lane = (allowlist: ReturnType<typeof loadTurnTwoAllowlist>, turnTwo = "allowlist") =>
            selectTurnOneExecution(db, {
                projectPath: resolveProjectIdentity(DIRECTORY),
                request,
                turnTwo: turnTwo as "allowlist" | "off",
                twoPass: false,
                canContinue: true,
                allowlist,
            }).lane;
        expect(lane(matching)).toBe("enabled");
        expect(
            lane(
                loadTurnTwoAllowlist({ version: 1, entries: [{ ...entry, lane: "omp" as const }] }),
            ),
        ).toBe("dormant");
        expect(
            lane(
                loadTurnTwoAllowlist({
                    version: 1,
                    entries: [{ ...entry, modelId: "another-model" }],
                }),
            ),
        ).toBe("dormant");
        expect(lane(matching, "off")).toBe("dormant");
        expect(lane(loadTurnTwoAllowlist())).toBe("dormant");
    });

    it("trial authorization on the disposable root enables the lane and refuses a different root", () => {
        const { db, root } = openTrialStore("accepted");
        const request = openCodeOneRequest();
        const other = openTrialStore("other");
        const input = {
            projectPath: resolveProjectIdentity(DIRECTORY),
            request,
            turnTwo: "allowlist" as const,
            twoPass: false,
            canContinue: true,
            allowlist: loadTurnTwoAllowlist(),
        };
        expect(
            selectTurnOneExecution(db, {
                ...input,
                trialAuthorization: { candidate: request.requestedIdentity, attestedRoot: root },
            }),
        ).toMatchObject({ lane: "enabled", refused: false });
        // Trial evidence is exclusive: a root that does not hold this store refuses.
        const wrongRoot = selectTurnOneExecution(db, {
            ...input,
            trialAuthorization: { candidate: request.requestedIdentity, attestedRoot: other.root },
        });
        expect(wrongRoot).toMatchObject({ lane: "dormant", refused: true });
        other.db.close();
    });
});
