/// <reference types="bun-types" />

// How the Rust-mode adapter moves its frozen last-known-good (LKG) state around
// failures, refusals, replays served from outside the adapter, restarts and
// admission checks. While frozen, every pass must keep serving the bytes the
// provider last saw (plus the new raw tail) until a pass installs something
// else; a pass that serves nothing must leave that state exactly as it was.

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";

import { runMigrations } from "../../features/magic-context/migrations";
import type { ContextDatabase } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage-meta";
import {
    addMergedReasoningStrippedIds,
    clearEmergencyRecovery,
    getOverflowState,
    getThinkingBindingRecoveryTarget,
    recordDetectedContextLimit,
    recordOverflowDetected,
    resetEmergencyRecoveryRegistryForTest,
    thinkingBindingRecoveryFrozenId,
} from "../../features/magic-context/storage-meta-persisted";
import {
    __resetToolDefinitionMeasurements,
    recordToolDefinition,
} from "../../features/magic-context/tool-definition-tokens";
import { __test as transformDecisionTest } from "../../features/magic-context/transform-decision-log";
import { createMessagesTransformHandler } from "../../plugin/messages-transform";
import * as logger from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import forceFixture from "./__fixtures__/rust-signed-thinking-reset/force.json";
import idleFixture from "./__fixtures__/rust-signed-thinking-reset/idle.json";
import rewriteFixture from "./__fixtures__/rust-signed-thinking-reset/rewrite.json";
import { DegradedPassRefusalError } from "./degraded-pass-refusal";
import { EmergencyFailClosedError, SIGNED_TURN_OVER_LIMIT } from "./emergency-fail-closed";
import { resolveTrustedContextLimit } from "./event-resolvers";
import { estimateFinalWireInputTokens } from "./final-wire-token-estimate";
import { armLatestThinkingRecovery } from "./latest-thinking-recovery";
import { createDbLkgPersistence } from "./lkg-persist";
import { getInMemorySlot, registerLkgPersistence, resetLkgSlotsForTest } from "./lkg-slot";
import { setRawMessageProvider } from "./read-session-chunk";
import { closeReadOnlySessionDb } from "./read-session-db";
import {
    liveRustLkgReplayParticipantCountForTest,
    resolveRustLkgReplayParticipant,
} from "./rust-lkg-freeze-registry";
import { createRustModeTransform, type RustModeModuleClient } from "./rust-mode-transform";
import { StorageBusyRefusalError } from "./storage-busy-refusal";
import type { TransformDeps } from "./transform";
import type { MessageLike } from "./transform-operations";

const MODEL = { providerID: "anthropic", modelID: "claude-opus-5-5" };
const MODEL_KEY = "anthropic/claude-opus-5-5";

const databases: ContextDatabase[] = [];
const unregisters: Array<() => void> = [];
let sessionCounter = 0;

afterEach(() => {
    __resetToolDefinitionMeasurements();
    resetEmergencyRecoveryRegistryForTest();
    registerLkgPersistence(undefined);
    resetLkgSlotsForTest();
    closeReadOnlySessionDb();
    transformDecisionTest.reset();
    for (const unregister of unregisters.splice(0)) unregister();
    for (const db of databases.splice(0)) closeQuietly(db);
});

function makeDb(): ContextDatabase {
    const db = new Database(":memory:") as ContextDatabase;
    initializeDatabase(db);
    runMigrations(db);
    databases.push(db);
    return db;
}

function installRawProvider(sessionId: string): void {
    const row = { id: "m1", timeCreated: 1, contributesOrdinal: true, hasValidInfo: true };
    unregisters.push(
        setRawMessageProvider(sessionId, {
            readMessages: () => [row],
            readMessageOrdinalPage: (after, limit) =>
                !after || row.timeCreated > after.timeCreated || row.id > after.id
                    ? [row].slice(0, limit)
                    : [],
            getStoredMessageCount: () => 1,
            readMessagePartsById: () => ({
                id: "m1",
                role: "user",
                parts: [{ type: "text", text: "question" }],
                createdAt: 1,
            }),
        }),
    );
}

function user(sessionId: string, id: string, text: string): MessageLike {
    return {
        info: { id, role: "user", sessionID: sessionId, model: { ...MODEL } },
        parts: [{ type: "text", text }],
    } as MessageLike;
}

function assistant(sessionId: string, id: string): MessageLike {
    return {
        info: { id, role: "assistant", sessionID: sessionId },
        parts: [{ type: "text", text: `answer of ${id}` }],
    } as MessageLike;
}

function thinkingAssistant(sessionId: string, id: string): MessageLike {
    return {
        info: { id, role: "assistant", sessionID: sessionId },
        parts: [
            {
                type: "reasoning",
                text: `thinking of ${id}`,
                metadata: { anthropic: { signature: `signature-${id}` } },
            },
            { type: "text", text: `answer of ${id}` },
        ],
    } as MessageLike;
}

function sha(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** The module tags every user message the way the Rust tag overlay does. */
function tagAllUsers(input: MessageLike[]): unknown[] {
    return structuredClone(input).map((message, index) =>
        message.info.role === "user"
            ? {
                  ...message,
                  parts: message.parts.map((part) => {
                      const record = part as { type?: string; text?: string };
                      return record.type === "text" && typeof record.text === "string"
                          ? { ...record, text: `§${index + 1}§ ${record.text}` }
                          : part;
                  }),
              }
            : message,
    );
}

function sqliteBusy(): Error {
    return Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
}

/** A decision string, "throw" for a module failure, or "throw-busy" for a SQLite busy error. */
type Step = "throw" | "throw-busy" | string;

/**
 * A Rust session on a prefix-bound model whose module answers each pass from a
 * script and renders the input through `moduleOutput`. Captures commit inline.
 * `run` calls the adapter directly; `runWrapped` goes through the production
 * messages-transform wrapper, whose hook can also be told to fail with a SQLite
 * busy error before the adapter runs.
 */
function frozenSession(label: string, options: { compactionOff?: boolean } = {}) {
    sessionCounter += 1;
    const sessionId = `rust-frozen-defects-${label}-${sessionCounter}-${Date.now()}`;
    const db = makeDb();
    installRawProvider(sessionId);
    recordDetectedContextLimit(db, sessionId, 200_000, MODEL_KEY);
    let pass = 0;
    const script: Step[] = [];
    let moduleOutput: (input: MessageLike[]) => unknown[] = (input) => structuredClone(input);
    let responseExtras: Record<string, unknown> = {};
    let lastInput: MessageLike[] = [];
    let statusFails = false;
    const moduleClient: RustModeModuleClient = {
        call: async ({ method, body }) => {
            if (method === "session.status" && statusFails) throw new Error("no answer");
            if (method !== "transform") return { ok: true };
            // Page uploads are not separate scheduler decisions; only the final page applies.
            if (body?.transform_page_complete === false) return { ok: true };
            pass += 1;
            const step = script.shift() ?? "SOFT+";
            if (step === "throw") throw new Error("daemon unavailable");
            if (step === "throw-busy") throw sqliteBusy();
            return {
                decision: step,
                prefix_bust_permitted: step === "HARD" || step === "SOFT",
                served_from: "transform",
                row_version: pass,
                native_messages: moduleOutput(lastInput),
                ...responseExtras,
            };
        },
    };
    const deps: TransformDeps = {
        tagger: {} as TransformDeps["tagger"],
        scheduler: {} as TransformDeps["scheduler"],
        contextUsageMap: new Map(),
        db,
        protectedTokens: 4,
        clearReasoningAge: 50,
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        directory: "/tmp/project",
        projectPath: "/tmp/project",
        memoryConfig: { enabled: false, injectionBudgetTokens: 1000, autoPromote: false },
        liveModelBySession: new Map([[sessionId, { ...MODEL }]]),
        sessionDirectoryBySession: new Map(),
        transformMode: "rust",
        rustModeModuleClient: moduleClient,
        historianRunner: "broca",
        getModelKey: () => MODEL_KEY,
        ...(options.compactionOff ? { compactionOff: true } : {}),
    };
    let estimatorOverride: typeof estimateFinalWireInputTokens | undefined;
    let resetFenceHook: ((sessionId: string) => void) | undefined;
    const makeAdapter = () =>
        createRustModeTransform(deps, {
            moduleClient,
            modulePageMaxBytes: 512 * 1024,
            scheduleLkgCapture: (capture) => capture(),
            afterSignedThinkingResetFenceForTests: (id) => resetFenceHook?.(id),
            rawFallbackEstimatorForTests: (args) =>
                (estimatorOverride ?? estimateFinalWireInputTokens)(args),
        });
    let transform = makeAdapter();
    const meta = () => {
        const sessionMeta = getOrCreateSessionMeta(db, sessionId);
        recordToolDefinition("anthropic", "claude-opus-5-5", undefined, "read", "read fixture", {
            type: "object",
        });
        if (sessionMeta.systemPromptTokens <= 0) {
            updateSessionMeta(db, sessionId, { systemPromptTokens: 100 });
            sessionMeta.systemPromptTokens = 100;
        }
        return sessionMeta;
    };
    const run = async (input: MessageLike[], step?: Step) => {
        if (step !== undefined) script.push(step);
        lastInput = input;
        const output = { messages: [...input] as unknown[] };
        await transform.run(sessionId, input, output, meta());
        return structuredClone(output.messages);
    };
    let hookFailure: (() => Error) | null = null;
    const handler = createMessagesTransformHandler({
        magicContext: {
            "experimental.chat.messages.transform": async (_input, output) => {
                if (hookFailure) {
                    const failure = hookFailure;
                    hookFailure = null;
                    throw failure();
                }
                const messages = output.messages as unknown as MessageLike[];
                await transform.run(sessionId, messages, output, meta());
            },
        },
        // As in production: the wrapper replays through its own instance's adapter.
        rustReplayParticipant: () => transform.replayParticipant,
    });
    /** A wrapper of a TypeScript-mode instance in the same process (no Rust adapter). */
    const typescriptHandler = createMessagesTransformHandler({
        magicContext: {
            "experimental.chat.messages.transform": async () => {
                throw sqliteBusy();
            },
        },
        rustReplayParticipant: () => null,
    });
    /**
     * One pass through the wrapper. `"hook-busy"` fails the hook with a SQLite busy
     * error before the adapter runs; `"hook-error"` with an ordinary error.
     */
    const runWrapped = async (input: MessageLike[], step?: Step | "hook-busy" | "hook-error") => {
        if (step === "hook-busy") hookFailure = sqliteBusy;
        else if (step === "hook-error") hookFailure = () => new Error("transform bug");
        else if (step !== undefined) script.push(step);
        lastInput = input;
        const output = { messages: [...input] };
        await handler({}, output as never);
        return structuredClone(output.messages as unknown[]);
    };
    const frozenFields = () => {
        const state = transform.getState(sessionId);
        return {
            lkgRepresentationFrozen: state.lkgRepresentationFrozen,
            lkgFrozenAtInputCount: state.lkgFrozenAtInputCount,
            lkgFrozenHealthyPasses: state.lkgFrozenHealthyPasses,
            lkgLastServedCaptureSequence: state.lkgLastServedCaptureSequence,
        };
    };
    return {
        sessionId,
        db,
        deps,
        get transform() {
            return transform;
        },
        /**
         * A new process: a fresh adapter on the same database, with the in-memory
         * slot store emptied so the next read hydrates the durable slot.
         */
        restart: () => {
            resetLkgSlotsForTest();
            registerLkgPersistence(createDbLkgPersistence(db));
            transform = makeAdapter();
        },
        run,
        runWrapped,
        /** One pass through a TypeScript-mode instance's wrapper whose hook is busy. */
        runTypescriptWrapperBusy: async (input: MessageLike[]) => {
            const output = { messages: [...input] };
            await typescriptHandler({}, output as never);
            return structuredClone(output.messages as unknown[]);
        },
        /**
         * An in-process rebuild that has not disposed the old adapter yet: a fresh
         * adapter on the same stores, with the old one still registered.
         */
        rebuildWithoutDispose: () => {
            const old = transform;
            transform = makeAdapter();
            return old;
        },
        frozenFields,
        setStatusFails: (value: boolean) => {
            statusFails = value;
        },
        /** Replace the adapter's token estimator for fit checks (undefined restores it). */
        setEstimator: (value: typeof estimateFinalWireInputTokens | undefined) => {
            estimatorOverride = value;
        },
        setModuleOutput: (value: (input: MessageLike[]) => unknown[]) => {
            moduleOutput = value;
        },
        /** Extra fields (such as `signed_thinking_reset`) added to every later module response. */
        setResponseExtras: (value: Record<string, unknown>) => {
            responseExtras = value;
        },
        /** Crash seam: runs after a reset's strip fence, before the old LKG slot is dropped. */
        setResetFenceHook: (value: ((sessionId: string) => void) | undefined) => {
            resetFenceHook = value;
        },
        /** Arm emergency recovery without provider proof, so no LKG replay is admitted. */
        armEmergency: () =>
            recordOverflowDetected(db, sessionId, undefined, MODEL_KEY, "proactive_model_shrink"),
        disarmEmergency: () => {
            resetEmergencyRecoveryRegistryForTest();
            clearEmergencyRecovery(db, sessionId);
            expect(getOverflowState(db, sessionId).needsEmergencyRecovery).toBe(false);
        },
        /**
         * Report provider usage. The emergency band reads input tokens against the
         * model's hard wall; the parked-retry pressure bypass reads the percentage.
         */
        setUsage: (percentage: number, inputTokens: number) => {
            deps.contextUsageMap.set(sessionId, {
                usage: { inputTokens, percentage },
                updatedAt: Date.now(),
                hasUsageTokens: true,
            });
        },
    };
}

/** HARD, a module failure that freezes, then two frozen defers that each capture. */
async function freezeWithTwoDefers(s: ReturnType<typeof frozenSession>) {
    const sid = s.sessionId;
    await s.run([user(sid, "m1", "question")], "HARD");
    const conversation: MessageLike[] = [
        user(sid, "m1", "question"),
        thinkingAssistant(sid, "a1"),
        user(sid, "m2", "turn 2"),
    ];
    await s.run([...conversation], "throw");
    conversation.push(assistant(sid, "a2"), user(sid, "m3", "turn 3"));
    await s.run([...conversation], "SOFT+");
    conversation.push(assistant(sid, "a3"), user(sid, "m4", "turn 4"));
    const lastServed = await s.run([...conversation], "SOFT+");
    expect(s.frozenFields().lkgRepresentationFrozen).toBe(true);
    expect(s.frozenFields().lkgLastServedCaptureSequence).not.toBeNull();
    return { conversation, lastServed };
}

describe("a pass that serves nothing leaves the freeze as it was", () => {
    it("a failed replay that refuses keeps the freeze and the last-served proof", async () => {
        const s = frozenSession("refused-replay");
        const sid = s.sessionId;
        const { conversation, lastServed } = await freezeWithTwoDefers(s);
        const before = s.frozenFields();

        // The module fails and no replay is admitted while emergency recovery is
        // armed, so with compaction on the pass refuses.
        s.armEmergency();
        conversation.push(assistant(sid, "a4"), user(sid, "m5", "turn 5"));
        await expect(s.run([...conversation], "throw")).rejects.toBeInstanceOf(
            EmergencyFailClosedError,
        );
        expect(s.frozenFields()).toEqual(before);

        // The module recovers and tags everything; the freeze still serves the bytes
        // the provider saw before the refusal, extended only by the new tail.
        s.disarmEmergency();
        s.setModuleOutput(tagAllUsers);
        const served = await s.run([...conversation], "SOFT+");
        expect(sha(served.slice(0, lastServed.length))).toBe(sha(lastServed));
        expect(sha(served.slice(lastServed.length))).toBe(
            sha(conversation.slice(lastServed.length)),
        );
        expect(s.frozenFields().lkgRepresentationFrozen).toBe(true);
    });

    it("a 95% emergency refusal leaves frozen state and last-served proof unchanged", async () => {
        const s = frozenSession("emergency-refusal");
        const sid = s.sessionId;
        const { conversation } = await freezeWithTwoDefers(s);
        const before = s.frozenFields();

        s.setUsage(97, 10_000_000);
        conversation.push(assistant(sid, "a4"), user(sid, "m5", "turn 5"));
        await expect(s.run([...conversation], "throw")).rejects.toBeInstanceOf(
            EmergencyFailClosedError,
        );
        expect(s.frozenFields()).toEqual(before);
    });

    it("a compaction-off raw serve clears the freeze", async () => {
        const s = frozenSession("compaction-off-raw", { compactionOff: true });
        const sid = s.sessionId;
        const { conversation } = await freezeWithTwoDefers(s);

        // No replay is admitted, so compaction-off serves the raw input: the frozen
        // bytes are gone from the wire and the freeze must go with them.
        s.armEmergency();
        conversation.push(assistant(sid, "a4"), user(sid, "m5", "turn 5"));
        const served = await s.run([...conversation], "throw");
        expect(sha(served)).toBe(sha(conversation));
        expect(s.frozenFields()).toMatchObject({
            lkgRepresentationFrozen: false,
            lkgFrozenAtInputCount: null,
            lkgFrozenHealthyPasses: 0,
        });
    });
});

/**
 * HARD, one captured defer, then three module failures that cannot replay while
 * emergency recovery is armed: the session parks without ever freezing.
 */
async function parkWithoutReplay(s: ReturnType<typeof frozenSession>) {
    const sid = s.sessionId;
    const conversation: MessageLike[] = [user(sid, "m1", "question")];
    await s.runWrapped([...conversation], "HARD");
    conversation.push(assistant(sid, "a1"), user(sid, "m2", "turn 2"));
    await s.runWrapped([...conversation], "SOFT+");
    s.armEmergency();
    for (let turn = 3; turn <= 5; turn += 1) {
        conversation.push(assistant(sid, `a${turn - 1}`), user(sid, `m${turn}`, `turn ${turn}`));
        await expect(s.runWrapped([...conversation], "throw")).rejects.toBeInstanceOf(
            EmergencyFailClosedError,
        );
    }
    s.disarmEmergency();
    expect(s.transform.getState(sid).parked).toBe(true);
    expect(s.frozenFields().lkgRepresentationFrozen).toBe(false);
    return conversation;
}

describe("every last-known-good serve freezes the adapter", () => {
    it("a storage-busy wrapper replay freezes the adapter", async () => {
        const s = frozenSession("wrapper-busy");
        const sid = s.sessionId;
        const conversation: MessageLike[] = [user(sid, "m1", "question")];
        await s.runWrapped([...conversation], "HARD");
        expect(s.frozenFields().lkgRepresentationFrozen).toBe(false);

        // The hook fails with a SQLite busy error; the wrapper serves the slot plus
        // the raw tail.
        conversation.push(assistant(sid, "a1"), user(sid, "m2", "turn 2"));
        const replayed = await s.runWrapped([...conversation], "hook-busy");
        expect(sha(replayed)).toBe(sha(conversation));

        // The module is back and tags everything; the provider holds the replayed
        // bytes, so the adapter keeps serving them.
        s.setModuleOutput(tagAllUsers);
        conversation.push(assistant(sid, "a2"), user(sid, "m3", "turn 3"));
        const served = await s.runWrapped([...conversation], "SOFT+");
        expect(sha(served)).toBe(sha(conversation));
        expect(s.frozenFields().lkgRepresentationFrozen).toBe(true);
    });

    it("a parked replay and a probe-failure replay freeze the adapter", async () => {
        // Parked shortcut: the first pass after parking replays without asking the module.
        const parked = frozenSession("parked-shortcut");
        const parkedConversation = await parkWithoutReplay(parked);
        const parkedPid = parked.sessionId;
        parkedConversation.push(assistant(parkedPid, "a5"), user(parkedPid, "m6", "turn 6"));
        const parkedReplay = await parked.runWrapped([...parkedConversation]);
        expect(sha(parkedReplay)).toBe(sha(parkedConversation));
        // Usage at or above the bypass percentage skips the shortcut, so this pass
        // probes the module, finds it healthy, and asks it to transform.
        parked.setUsage(92, 1_000);
        parked.setModuleOutput(tagAllUsers);
        parkedConversation.push(assistant(parkedPid, "a6"), user(parkedPid, "m7", "turn 7"));
        const parkedServed = await parked.runWrapped([...parkedConversation], "SOFT+");
        expect(sha(parkedServed)).toBe(sha(parkedConversation));
        expect(parked.frozenFields().lkgRepresentationFrozen).toBe(true);

        // Probe failure: the health probe fails and the pass replays instead.
        const probed = frozenSession("probe-failure");
        const probedConversation = await parkWithoutReplay(probed);
        const probedSid = probed.sessionId;
        probed.setUsage(92, 1_000);
        probed.setStatusFails(true);
        probedConversation.push(assistant(probedSid, "a5"), user(probedSid, "m6", "turn 6"));
        const probedReplay = await probed.runWrapped([...probedConversation]);
        expect(sha(probedReplay)).toBe(sha(probedConversation));
        probed.setStatusFails(false);
        probed.setModuleOutput(tagAllUsers);
        probedConversation.push(assistant(probedSid, "a6"), user(probedSid, "m7", "turn 7"));
        const probedServed = await probed.runWrapped([...probedConversation], "SOFT+");
        expect(sha(probedServed)).toBe(sha(probedConversation));
        expect(probed.frozenFields().lkgRepresentationFrozen).toBe(true);
    });
});

describe("the wrapper admits a replay the way the adapter does", () => {
    it("the wrapper declines a replay after the adapter's 95% refusal", async () => {
        const s = frozenSession("wrapper-emergency-band");
        const sid = s.sessionId;
        await s.runWrapped([user(sid, "m1", "question")], "HARD");
        s.setUsage(97, 10_000_000);
        const conversation = [
            user(sid, "m1", "question"),
            assistant(sid, "a1"),
            user(sid, "m2", "turn 2"),
        ];
        // A busy error inside the emergency band makes the adapter refuse with a
        // storage-busy refusal; the wrapper must not serve the slot in its place.
        await expect(s.runWrapped([...conversation], "throw-busy")).rejects.toBeInstanceOf(
            StorageBusyRefusalError,
        );
        expect(s.frozenFields().lkgRepresentationFrozen).toBe(false);
    });

    it("the wrapper declines a replay in the emergency band when the busy error comes from outside the adapter", async () => {
        const s = frozenSession("wrapper-emergency-band-hook");
        const sid = s.sessionId;
        await s.runWrapped([user(sid, "m1", "question")], "HARD");
        s.setUsage(97, 10_000_000);
        const conversation = [
            user(sid, "m1", "question"),
            assistant(sid, "a1"),
            user(sid, "m2", "turn 2"),
        ];
        // The hook fails before the adapter runs, so no refusal carries the
        // adapter's emergency stage; the wrapper must still ask the adapter.
        await expect(s.runWrapped([...conversation], "hook-busy")).rejects.toBeInstanceOf(
            StorageBusyRefusalError,
        );
        expect(s.frozenFields().lkgRepresentationFrozen).toBe(false);
    });

    it("the wrapper declines a replay that does not fit", async () => {
        const s = frozenSession("wrapper-over-limit");
        const sid = s.sessionId;
        await s.runWrapped([user(sid, "m1", "question")], "HARD");
        const limit = resolveTrustedContextLimit(MODEL.providerID, MODEL.modelID, {
            db: s.db,
            sessionID: sid,
        });
        expect(limit).toBeGreaterThan(0);
        // A raw tail far past the trusted limit, with emergency recovery not armed.
        const huge = "lorem ipsum dolor sit amet ".repeat(Math.ceil(((limit ?? 0) * 2) / 5));
        const conversation = [
            user(sid, "m1", "question"),
            assistant(sid, "a1"),
            user(sid, "m2", huge),
        ];
        await expect(s.runWrapped([...conversation], "hook-busy")).rejects.toBeInstanceOf(
            StorageBusyRefusalError,
        );
        expect(s.frozenFields().lkgRepresentationFrozen).toBe(false);
    });

    it("wrapper and adapter replays of the same tail are byte-identical", async () => {
        const s = frozenSession("replay-parity");
        const sid = s.sessionId;
        // The HARD strips a1's thinking and persists that strip.
        await s.runWrapped(
            [user(sid, "m1", "question"), thinkingAssistant(sid, "a1"), user(sid, "m2", "turn 2")],
            "HARD",
        );
        // a2 arrives raw on the replays; a persisted strip covers it as well.
        expect(
            addMergedReasoningStrippedIds(s.db, sid, [thinkingBindingRecoveryFrozenId("a2")]),
        ).toBe(true);
        const conversation = [
            user(sid, "m1", "question"),
            thinkingAssistant(sid, "a1"),
            user(sid, "m2", "turn 2"),
            thinkingAssistant(sid, "a2"),
            user(sid, "m3", "turn 3"),
            thinkingAssistant(sid, "a3"),
            user(sid, "m4", "turn 4"),
        ];
        const adapterReplay = await s.runWrapped(structuredClone(conversation), "throw");
        const wrapperReplay = await s.runWrapped(structuredClone(conversation), "hook-busy");
        expect(wrapperReplay.length).toBe(adapterReplay.length);
        for (const [index, message] of adapterReplay.entries()) {
            expect(JSON.stringify(wrapperReplay[index])).toBe(JSON.stringify(message));
        }
        const replayed = adapterReplay as MessageLike[];
        const reasoningOf = (id: string) =>
            replayed
                .find((message) => message.info.id === id)
                ?.parts.some((part) => (part as { type?: string }).type === "reasoning");
        expect(reasoningOf("a1")).toBe(false);
        expect(reasoningOf("a2")).toBe(false);
        expect(reasoningOf("a3")).toBe(true);
    });
});

describe("a restart resumes a freeze the durable slot proves", () => {
    function textOf(messages: unknown[], id: string): string {
        const message = (messages as MessageLike[]).find((candidate) => candidate.info.id === id);
        return (message?.parts ?? [])
            .map((part) => (part as { text?: string }).text ?? "")
            .join("|");
    }

    it("a restarted adapter resumes the freeze from a captured frozen slot", async () => {
        const s = frozenSession("restart-frozen");
        const sid = s.sessionId;
        s.setModuleOutput(tagAllUsers);
        await s.run([user(sid, "m1", "question")], "HARD");
        const conversation: MessageLike[] = [
            user(sid, "m1", "question"),
            thinkingAssistant(sid, "a1"),
            user(sid, "m2", "turn 2"),
        ];
        await s.run([...conversation], "throw");
        conversation.push(assistant(sid, "a2"), user(sid, "m3", "turn 3"));
        await s.run([...conversation], "SOFT+");
        conversation.push(assistant(sid, "a3"), user(sid, "m4", "turn 4"));
        const lastServed = await s.run([...conversation], "SOFT+");
        // The freeze served m2 onward untagged and captured exactly that.
        expect(textOf(lastServed, "m1")).toBe("§1§ question");
        expect(textOf(lastServed, "m2")).toBe("turn 2");

        s.restart();
        conversation.push(assistant(sid, "a4"), user(sid, "m5", "turn 5"));
        const served = await s.run([...conversation], "SOFT+");
        expect(sha(served.slice(0, lastServed.length))).toBe(sha(lastServed));
        expect(sha(served.slice(lastServed.length))).toBe(
            sha(conversation.slice(lastServed.length)),
        );
        expect(s.frozenFields().lkgRepresentationFrozen).toBe(true);
    });

    it("a restart resumes a frozen slot whose raw tail carries a persisted thinking strip", async () => {
        const s = frozenSession("restart-frozen-stripped-tail");
        const sid = s.sessionId;
        s.setModuleOutput(tagAllUsers);
        await s.run([user(sid, "m1", "question")], "HARD");
        // a3's thinking is in the persisted strip set, so every replay sends it
        // stripped while the host still sends it with its thinking.
        expect(
            addMergedReasoningStrippedIds(s.db, sid, [thinkingBindingRecoveryFrozenId("a3")]),
        ).toBe(true);
        const conversation: MessageLike[] = [
            user(sid, "m1", "question"),
            assistant(sid, "a1"),
            user(sid, "m2", "turn 2"),
        ];
        await s.run([...conversation], "throw");
        conversation.push(assistant(sid, "a2"), user(sid, "m3", "turn 3"));
        await s.run([...conversation], "SOFT+");
        // The last frozen pass ends on a3 (a turn still in progress), so the
        // captured slot ends with a3 stripped.
        conversation.push(thinkingAssistant(sid, "a3"));
        const lastServed = await s.run([...conversation], "SOFT+");
        expect(
            (lastServed.at(-1) as MessageLike).parts.some(
                (part) => (part as { type?: string }).type === "reasoning",
            ),
        ).toBe(false);

        // After the restart, only a key that applies the persisted strips sees the
        // slot's stripped a3 as the host's a3, which keeps the slot's raw run intact.
        s.restart();
        const served = await s.run([...conversation], "SOFT+");
        expect(sha(served)).toBe(sha(lastServed));
        expect(s.frozenFields().lkgRepresentationFrozen).toBe(true);
    });

    it("a restart of a healthy session does not freeze", async () => {
        const s = frozenSession("restart-healthy");
        const sid = s.sessionId;
        s.setModuleOutput(tagAllUsers);
        const conversation: MessageLike[] = [
            user(sid, "m1", "question"),
            thinkingAssistant(sid, "a1"),
            user(sid, "m2", "turn 2"),
        ];
        // The HARD strips a1's thinking and saves that strip, so the durable slot
        // holds a1 without it while the module keeps rendering a1 as the host sent it.
        const busted = await s.run([...conversation], "HARD");
        conversation.push(assistant(sid, "a2"), user(sid, "m3", "turn 3"));
        const defer = await s.run([...conversation], "SOFT+");
        expect(sha(defer.slice(0, busted.length))).toBe(sha(busted));

        s.restart();
        conversation.push(assistant(sid, "a3"), user(sid, "m4", "turn 4"));
        const served = await s.run([...conversation], "SOFT+");
        expect(sha(served.slice(0, defer.length))).toBe(sha(defer));
        expect(textOf(served, "m4")).toBe("§7§ turn 4");
        expect(s.frozenFields().lkgRepresentationFrozen).toBe(false);
    });

    it("restart right after an uncaptured failure replay preserves its raw tail", async () => {
        // The slot predates the raw tail, but the separate served-part evidence
        // survives restart and keeps the module's later tags hidden.
        const s = frozenSession("restart-after-failure");
        const sid = s.sessionId;
        s.setModuleOutput(tagAllUsers);
        await s.run([user(sid, "m1", "question")], "HARD");
        const conversation: MessageLike[] = [
            user(sid, "m1", "question"),
            assistant(sid, "a1"),
            user(sid, "m2", "turn 2"),
        ];
        const replayed = await s.run([...conversation], "throw");
        expect(textOf(replayed, "m2")).toBe("turn 2");

        s.restart();
        const served = await s.run([...conversation], "SOFT+");
        expect(textOf(served, "m2")).toBe("turn 2");
        expect(s.frozenFields().lkgRepresentationFrozen).toBe(false);
    });

    it("a restart right after an uncaptured failure replay keeps thinking bound to its unchanged raw tail", async () => {
        const s = frozenSession("restart-after-failure-thinking");
        const sid = s.sessionId;
        s.setModuleOutput(tagAllUsers);
        await s.run([user(sid, "m1", "question")], "HARD");
        const conversation: MessageLike[] = [
            user(sid, "m1", "question"),
            assistant(sid, "a1"),
            user(sid, "m2", "turn 2"),
        ];
        // The failure replay serves m2 untagged and captures nothing; the model's
        // signed answer a2 is bound to that untagged m2.
        const replayed = await s.run([...conversation], "throw");
        expect(textOf(replayed, "m2")).toBe("turn 2");
        conversation.push(thinkingAssistant(sid, "a2"), user(sid, "m3", "turn 3"));

        s.restart();
        const served = await s.run([...conversation], "SOFT+");
        expect(textOf(served, "m2")).toBe("turn 2");
        expect(hasReasoningOn(served, "a2")).toBe(true);
        // The same raw representation is retained on the next healthy pass.
        conversation.push(assistant(sid, "a3"), user(sid, "m4", "turn 4"));
        const next = await s.run([...conversation], "SOFT+");
        expect(sha(next.slice(0, served.length))).toBe(sha(served));
    });

    it("a restart of a healthy session keeps the newest assistant's thinking", async () => {
        const s = frozenSession("restart-healthy-thinking");
        const sid = s.sessionId;
        // Like the Rust overlay, the module tags assistant text as well as user text,
        // so the newest assistant itself renders differently from the host's copy.
        s.setModuleOutput((input) =>
            (tagAllUsers(input) as MessageLike[]).map((message) =>
                message.info.role === "assistant"
                    ? {
                          ...message,
                          parts: message.parts.map((part) => {
                              const record = part as { type?: string; text?: string };
                              return record.type === "text" && typeof record.text === "string"
                                  ? { ...record, text: `§a§ ${record.text}` }
                                  : part;
                          }),
                      }
                    : message,
            ),
        );
        await s.run([user(sid, "m1", "question")], "HARD");
        const conversation: MessageLike[] = [
            user(sid, "m1", "question"),
            assistant(sid, "a1"),
            user(sid, "m2", "turn 2"),
        ];
        const defer = await s.run([...conversation], "SOFT+");

        // Every healthy pass captured, so the only messages after the slot are the
        // answer to the last served array and the new user turn.
        s.restart();
        conversation.push(thinkingAssistant(sid, "a2"), user(sid, "m3", "turn 3"));
        const served = await s.run([...conversation], "SOFT+");
        expect(sha(served.slice(0, defer.length))).toBe(sha(defer));
        expect(hasReasoningOn(served, "a2")).toBe(true);
        expect(s.frozenFields().lkgRepresentationFrozen).toBe(false);
    });
});

function hasReasoningOn(messages: readonly unknown[], id: string): boolean {
    const message = messages.find((entry) => (entry as MessageLike).info.id === id) as
        | MessageLike
        | undefined;
    return message?.parts.some((part) => (part as { type?: string }).type === "reasoning") ?? false;
}

describe("a healthy frozen pass is admitted like any other replay", () => {
    // Eight megabytes of text: over any context limit by the four-bytes-per-token
    // proxy, so the measurement needs no tokenizer run.
    const HUGE = "x".repeat(8 * 1024 * 1024);

    /** The module compacts the huge message to a short placeholder. */
    function compacting(input: MessageLike[]): unknown[] {
        return tagAllUsers(input).map((message) => {
            const record = message as MessageLike;
            return record.info.id === "m-huge"
                ? { ...record, parts: [{ type: "text", text: "[compacted tool output]" }] }
                : message;
        });
    }

    function logLines(spy: ReturnType<typeof spyOn>, sessionId: string): string[] {
        return spy.mock.calls
            .filter(([loggedSession]) => loggedSession === sessionId)
            .map(([, message]) => String(message));
    }

    it("frozen bytes over a trusted limit release only when module output fits", async () => {
        const logSpy = spyOn(logger, "sessionLog").mockImplementation(() => {});
        try {
            for (const moduleCompacts of [true, false]) {
                const s = frozenSession(moduleCompacts ? "fit-release" : "fit-both-over");
                const sid = s.sessionId;
                const { conversation, lastServed } = await freezeWithTwoDefers(s);
                s.setModuleOutput(moduleCompacts ? compacting : tagAllUsers);
                conversation.push(assistant(sid, "a4"), user(sid, "m-huge", HUGE));
                if (moduleCompacts) {
                    const served = await s.run([...conversation], "SOFT+");
                    const lines = logLines(logSpy, sid);
                    // The frozen bytes cannot be sent and the module's can: adopt them.
                    expect(lines).toContain(
                        "lkg_frozen_replay_released reason=frozen_over_context_limit",
                    );
                    expect(s.frozenFields().lkgRepresentationFrozen).toBe(false);
                    const huge = (served as MessageLike[]).find(
                        (message) => message.info.id === "m-huge",
                    );
                    expect(JSON.stringify(huge?.parts)).toContain("[compacted tool output]");
                } else {
                    // Neither candidate fits. Keep the last-served representation,
                    // but refuse this request instead of sending known-over bytes.
                    await expect(s.run([...conversation], "SOFT+")).rejects.toBeInstanceOf(
                        EmergencyFailClosedError,
                    );
                    const lines = logLines(logSpy, sid);
                    expect(lines.some((line) => line.startsWith("frozen_fit_both_over"))).toBe(
                        true,
                    );
                    expect(
                        lines.some((line) => line.startsWith("lkg_frozen_replay_released")),
                    ).toBe(false);
                    expect(s.frozenFields().lkgRepresentationFrozen).toBe(true);
                    expect(sha(JSON.parse(getInMemorySlot(sid)!.jsonPrefix))).toBe(sha(lastServed));
                }
            }
        } finally {
            logSpy.mockRestore();
        }
    });

    it("an untrusted estimate keeps the freeze", async () => {
        const logSpy = spyOn(logger, "sessionLog").mockImplementation(() => {});
        try {
            const s = frozenSession("fit-untrusted");
            const sid = s.sessionId;
            const { conversation, lastServed } = await freezeWithTwoDefers(s);
            // The estimate says far over the limit but is not trusted, and the byte
            // proxy is under: nothing is proven, so the freeze stays.
            s.setEstimator(() => ({ tokens: 50_000_000, trusted: false }) as never);
            s.setModuleOutput(compacting);
            conversation.push(assistant(sid, "a4"), user(sid, "m5", "turn 5"));
            const served = await s.run([...conversation], "SOFT+");
            expect(sha(served.slice(0, lastServed.length))).toBe(sha(lastServed));
            expect(s.frozenFields().lkgRepresentationFrozen).toBe(true);
            expect(
                logLines(logSpy, sid).some((line) => line.startsWith("frozen_fit_unproven")),
            ).toBe(true);
        } finally {
            logSpy.mockRestore();
        }
    });

    it("frozen bytes over a provider-proven limit with module output also over refuse and keep the freeze", async () => {
        const s = frozenSession("emergency-both-over");
        const sid = s.sessionId;
        const { conversation } = await freezeWithTwoDefers(s);
        // Emergency recovery is armed and the provider proved a 200k limit for this
        // model; the huge message keeps both arrays over it.
        s.armEmergency();
        s.setModuleOutput(tagAllUsers);
        const before = s.frozenFields();
        // Over the 200k proven limit by the byte proxy (about 1 MB). Real words, not
        // one unbroken run: with recovery armed the adapter tokenizes the input, and
        // the tokenizer is quadratic on a single multi-megabyte word.
        const overProven = "lorem ipsum dolor sit amet ".repeat(40_000);
        conversation.push(assistant(sid, "a4"), user(sid, "m-huge", overProven));
        const refusal = s.run([...conversation], "SOFT+");
        await expect(refusal).rejects.toBeInstanceOf(EmergencyFailClosedError);
        // The module is healthy, so the user is told what is wrong and what to do,
        // not that the engine is reconnecting.
        await expect(refusal).rejects.toThrow("(MC-H07)");
        await expect(refusal).rejects.not.toThrow("reconnecting");
        expect(s.frozenFields()).toEqual(before);
        expect(s.transform.getState(sid).consecutiveFailures).toBe(0);

        // The freeze can still end: a module bust (what /ctx-flush requests) whose
        // output fits is served, and thinking the freeze served raw is stripped.
        s.setModuleOutput((input) =>
            tagAllUsers(input).map((message) => {
                const native = message as MessageLike;
                return {
                    ...native,
                    parts:
                        native.info.id === "m-huge"
                            ? [{ type: "text", text: "[compacted]" }]
                            : native.parts.filter(
                                  (part) => (part as { type?: string }).type !== "reasoning",
                              ),
                };
            }),
        );
        s.setResponseExtras({ signed_thinking_reset: true });
        const served = await s.run([...conversation], "HARD");
        expect(s.frozenFields().lkgRepresentationFrozen).toBe(false);
        expect(JSON.stringify(served)).toContain("[compacted]");
        const a1 = (served as MessageLike[]).find((message) => message.info.id === "a1");
        expect(a1?.parts.some((part) => (part as { type?: string }).type === "reasoning")).toBe(
            false,
        );
    });
});

describe("the frozen path validates the array it serves", () => {
    it("a persisted strip that makes a frozen reasoning run valid keeps the freeze", async () => {
        const logSpy = spyOn(logger, "sessionLog").mockImplementation(() => {});
        try {
            const s = frozenSession("frozen-run-valid-after-strip");
            const sid = s.sessionId;
            await s.run([user(sid, "m1", "question")], "HARD");
            // Two adjacent thinking assistants merge into one provider assistant turn,
            // where thinking is only valid at the start of the first message. The
            // newer one's thinking is in the persisted strip set, which makes the
            // run valid once the strip is applied.
            expect(
                addMergedReasoningStrippedIds(s.db, sid, [thinkingBindingRecoveryFrozenId("a2")]),
            ).toBe(true);
            const conversation: MessageLike[] = [
                user(sid, "m1", "question"),
                thinkingAssistant(sid, "a1"),
                thinkingAssistant(sid, "a2"),
                user(sid, "m2", "turn 2"),
            ];
            const replayed = await s.run([...conversation], "throw");
            expect(s.frozenFields().lkgRepresentationFrozen).toBe(true);

            s.setModuleOutput(tagAllUsers);
            conversation.push(assistant(sid, "a3"), user(sid, "m3", "turn 3"));
            const served = await s.run([...conversation], "SOFT+");
            expect(sha(served.slice(0, replayed.length))).toBe(sha(replayed));
            expect(s.frozenFields().lkgRepresentationFrozen).toBe(true);
            const lines = logSpy.mock.calls
                .filter(([loggedSession]) => loggedSession === sid)
                .map(([, message]) => String(message));
            expect(lines).toContain("lkg_frozen_replay_served");
            expect(lines.some((line) => line.includes("lkg_anthropic_reasoning_run_invalid"))).toBe(
                false,
            );
            expect(getInMemorySlot(sid)).toBeDefined();
        } finally {
            logSpy.mockRestore();
        }
    });
});

describe("a wrapper replays through its own instance's adapter", () => {
    it("after a rebuild that has not disposed the old adapter, the replay freezes the new one", async () => {
        const s = frozenSession("wrapper-bound-rebuild");
        const sid = s.sessionId;
        const conversation: MessageLike[] = [user(sid, "m1", "question")];
        await s.runWrapped([...conversation], "HARD");
        // The old adapter has run the session and is still registered; the new one
        // has not run it yet, so the process-wide registry would pick the old one.
        const old = s.rebuildWithoutDispose();
        conversation.push(assistant(sid, "a1"), user(sid, "m2", "turn 2"));
        await s.runWrapped([...conversation], "hook-busy");
        expect(s.frozenFields().lkgRepresentationFrozen).toBe(true);
        expect(old.getState(sid).lkgRepresentationFrozen).toBe(false);
    });

    it("a TypeScript-mode instance's replay does not freeze a Rust adapter", async () => {
        const s = frozenSession("wrapper-bound-typescript");
        const sid = s.sessionId;
        const conversation: MessageLike[] = [user(sid, "m1", "question")];
        await s.runWrapped([...conversation], "HARD");
        conversation.push(assistant(sid, "a1"), user(sid, "m2", "turn 2"));
        // The only registered Rust adapter has run this session, yet the wrapper of
        // a TypeScript-mode instance serves its replay without attributing it.
        await s.runTypescriptWrapperBusy([...conversation]);
        expect(s.frozenFields().lkgRepresentationFrozen).toBe(false);
    });
});

describe("the wrapper never sends a Rust session's raw input with compaction on", () => {
    it("an ordinary failure whose replay cannot serve refuses instead of passing the input through", async () => {
        const s = frozenSession("wrapper-no-raw");
        const sid = s.sessionId;
        const { conversation } = await freezeWithTwoDefers(s);
        const before = s.frozenFields();
        // Emergency recovery blocks the wrapper's replay, and the wrapper must not
        // hand the raw input back instead while the adapter stays frozen.
        s.armEmergency();
        conversation.push(assistant(sid, "a4"), user(sid, "m5", "turn 5"));
        await expect(s.runWrapped([...conversation], "hook-error")).rejects.toBeInstanceOf(
            DegradedPassRefusalError,
        );
        expect(s.frozenFields()).toEqual(before);
    });

    it("an ordinary failure with a replay that serves still replays", async () => {
        const s = frozenSession("wrapper-replays-on-error");
        const sid = s.sessionId;
        const conversation: MessageLike[] = [user(sid, "m1", "question")];
        await s.runWrapped([...conversation], "HARD");
        conversation.push(assistant(sid, "a1"), user(sid, "m2", "turn 2"));
        const replayed = await s.runWrapped([...conversation], "hook-error");
        expect(sha(replayed)).toBe(sha(conversation));
        expect(s.frozenFields().lkgRepresentationFrozen).toBe(true);
    });
});

describe("the replay registry follows the adapter's lifetime", () => {
    it("a disposed adapter is no longer offered to the wrapper's replay", async () => {
        const s = frozenSession("registry-dispose");
        const sid = s.sessionId;
        await s.runWrapped([user(sid, "m1", "question")], "HARD");
        expect(resolveRustLkgReplayParticipant(sid)).toBeDefined();
        const before = liveRustLkgReplayParticipantCountForTest();
        s.transform.dispose();
        expect(liveRustLkgReplayParticipantCountForTest()).toBe(before - 1);
        // No other adapter has run the session, so with several adapters alive in
        // this test process the wrapper attributes it to none of them.
        if (before - 1 !== 1) expect(resolveRustLkgReplayParticipant(sid)).toBeUndefined();
    });
});

// Real Rust engine output replayed through this adapter. The fixtures are the
// `R2_HOST_FIXTURE` lines printed by the mc-module test
// `review_r2_native_engine_exports_force_and_idle_for_host_strip`: a session with an older
// signed turn and an open signed tool loop (a4..a6 signed, a7 unsigned), before and after
// a force-band pass, an idle-expired pass, and a pass whose m0/m1 head was rebuilt. A signed thinking block is valid only while every byte before it is unchanged.
// Force and idle passes keep the head, so every block through the last kept reasoning must
// stay in the healthy and previously frozen host states; after a provider rejection of the
// open turn, only that turn's thinking goes. A rewritten head invalidates all of them, so
// none may be served, in the healthy, reactive-recovery and previously frozen states alike.
type HostFixture = {
    input: MessageLike[];
    before: { native_messages: MessageLike[] };
    pressured: {
        native_messages: MessageLike[];
        prefix_bust_permitted: boolean;
        signed_thinking_reset?: boolean;
    };
};
const signedThinkingFixtures = {
    force: forceFixture as unknown as HostFixture,
    idle: idleFixture as unknown as HostFixture,
    rewrite: rewriteFixture as unknown as HostFixture,
};

function reasoningIds(messages: MessageLike[]): string[] {
    return messages
        .filter((message) =>
            message.parts.some((part) => (part as { type?: unknown }).type === "reasoning"),
        )
        .map((message) => String(message.info.id));
}

/** The served messages through the last reasoning part of message `a6`, the fixture's
 * newest signed step: everything a kept signature is bound to. */
function prefixThroughKeptThinking(messages: MessageLike[]): string {
    const end = messages.findIndex((message) => message.info.id === "a6");
    expect(end).toBeGreaterThanOrEqual(0);
    const copy = structuredClone(messages.slice(0, end + 1));
    const kept = copy.at(-1) as MessageLike;
    const last = kept.parts.findLastIndex(
        (part) => (part as { type?: unknown }).type === "reasoning",
    );
    expect(last).toBeGreaterThanOrEqual(0);
    kept.parts = kept.parts.slice(0, last + 1);
    return JSON.stringify(copy);
}

/**
 * Serve the fixture's baseline, put the host in `mode` (healthy; reactive, with a provider
 * rejection armed; or frozen, after a module failure), then serve the pressured pass. When
 * given, `override` replaces the module's pressured native output and extra response fields.
 */
async function runSignedThinkingFixture(
    label: string,
    fixture: HostFixture,
    mode: "healthy" | "reactive" | "frozen",
    step: string,
    override?: { output: MessageLike[]; extras: Record<string, unknown> },
) {
    const s = frozenSession(label);
    const remap = (messages: MessageLike[]) =>
        structuredClone(messages).map((message) => {
            message.info.sessionID = s.sessionId;
            return message;
        });
    const input = remap(fixture.input);
    s.setModuleOutput(() => remap(fixture.before.native_messages));
    const before = (await s.run(input, "SOFT+")) as MessageLike[];
    if (mode === "reactive") armLatestThinkingRecovery(s.db, s.sessionId);
    if (mode === "frozen") await s.run(input, "throw");
    s.setUsage(step === "HARD" ? 66 : 86, step === "HARD" ? 132_000 : 172_000);
    const pressuredOutput = override?.output ?? fixture.pressured.native_messages;
    s.setModuleOutput(() => remap(pressuredOutput));
    s.setResponseExtras(
        override?.extras ??
            (fixture.pressured.signed_thinking_reset ? { signed_thinking_reset: true } : {}),
    );
    const after = (await s.run(input, step)) as MessageLike[];
    s.setResponseExtras({});
    return { s, input, before, after };
}

describe("Rust host thinking strips with real engine output", () => {
    for (const kind of ["force", "idle"] as const) {
        for (const mode of ["healthy", "frozen"] as const) {
            it(`keeps every block through the kept thinking on ${kind} (${mode})`, async () => {
                const fixture = signedThinkingFixtures[kind];
                expect(fixture.pressured.prefix_bust_permitted).toBe(true);
                expect(fixture.pressured.signed_thinking_reset ?? false).toBe(false);
                const { before, after } = await runSignedThinkingFixture(
                    `signed-${kind}-${mode}`,
                    fixture,
                    mode,
                    "SOFT",
                );
                expect(prefixThroughKeptThinking(after)).toBe(prefixThroughKeptThinking(before));
            });
        }
        // The provider rejected the open turn (a4..a7) while it carried all its
        // original thinking, so restoring would resend the refused bytes. The
        // recovery removes that turn's thinking instead; every byte before the
        // turn, the older turn's kept block included, stays as it was served.
        it(`removes only the rejected open turn's thinking on ${kind} (reactive)`, async () => {
            const fixture = signedThinkingFixtures[kind];
            expect(fixture.pressured.prefix_bust_permitted).toBe(true);
            expect(fixture.pressured.signed_thinking_reset ?? false).toBe(false);
            const { before, after } = await runSignedThinkingFixture(
                `signed-${kind}-reactive`,
                fixture,
                "reactive",
                "SOFT",
            );
            const beforeTurn = (messages: MessageLike[]) => {
                const start = messages.findIndex((message) => message.info.id === "a4");
                expect(start).toBeGreaterThan(0);
                return JSON.stringify(messages.slice(0, start));
            };
            expect(beforeTurn(after)).toBe(beforeTurn(before));
            expect(reasoningIds(before)).toEqual(expect.arrayContaining(["a4", "a5", "a6"]));
            expect(reasoningIds(after)).toEqual(
                reasoningIds(before).filter((id) => !["a4", "a5", "a6"].includes(id)),
            );
        });
    }
    for (const mode of ["healthy", "reactive", "frozen"] as const) {
        it(`a rewritten head serves no signed thinking, now or on the next pass (${mode})`, async () => {
            const fixture = signedThinkingFixtures.rewrite;
            expect(fixture.pressured.prefix_bust_permitted).toBe(true);
            expect(fixture.pressured.signed_thinking_reset).toBe(true);
            const { s, input, after } = await runSignedThinkingFixture(
                `signed-rewrite-${mode}`,
                fixture,
                mode,
                "HARD",
            );
            expect(reasoningIds(after)).toEqual([]);
            // The module replays its persisted strip on the next pass; the host must not
            // restore the turn's original signed thinking either.
            const next = (await s.run(input, "SOFT+")) as MessageLike[];
            expect(reasoningIds(next)).toEqual([]);
        });
    }
    // The reported `signed_thinking_reset`, not the module's own output, drives the host:
    // given output that still carries signed thinking, the host strips every block of it.
    for (const mode of ["healthy", "reactive"] as const) {
        it(`a reported reset strips thinking the module output still carries (${mode})`, async () => {
            const fixture = signedThinkingFixtures.rewrite;
            const withThinking = signedThinkingFixtures.force.pressured.native_messages;
            expect(reasoningIds(withThinking).length).toBeGreaterThan(0);
            const { after } = await runSignedThinkingFixture(
                `signed-reset-decision-${mode}`,
                fixture,
                mode,
                "HARD",
                { output: withThinking, extras: { signed_thinking_reset: true } },
            );
            expect(reasoningIds(after)).toEqual([]);
        });
    }
});

describe("a signed-thinking reset survives a crash and never ships over the window", () => {
    // The module commits the reset before it answers, but the host's LKG snapshot and
    // reactive recovery are separate state. The host records a strip fence for every
    // thinking-bearing assistant of the input before it touches either. LKG admission applies
    // that fence: a snapshot taken before the reset still carries the fenced thinking, so it
    // no longer matches what a replay would serve and is not admitted. A crash after the
    // fence therefore never resurrects the removed thinking; the turn is refused until the
    // module answers, which then serves its persisted reset.
    it("a crash after the reset fence, before the old snapshot is dropped, never replays the removed thinking", async () => {
        const fixture = signedThinkingFixtures.rewrite;
        const s = frozenSession("signed-reset-crash");
        const remap = (messages: MessageLike[]) =>
            structuredClone(messages).map((message) => {
                message.info.sessionID = s.sessionId;
                return message;
            });
        const input = remap(fixture.input);
        s.setModuleOutput(() => remap(fixture.before.native_messages));
        const before = (await s.run(input, "SOFT+")) as MessageLike[];
        expect(reasoningIds(before).length).toBeGreaterThan(0);

        // The reset pass: real engine output, already stripped by the module.
        s.setUsage(66, 132_000);
        s.setModuleOutput(() => remap(fixture.pressured.native_messages));
        s.setResponseExtras({ signed_thinking_reset: true });
        s.setResetFenceHook(() => {
            throw new Error("simulated crash after the reset fence");
        });
        // The interrupted pass falls back to the pre-reset snapshot, which the fence refuses.
        await expect(s.run(input, "HARD")).rejects.toBeInstanceOf(EmergencyFailClosedError);
        s.setResetFenceHook(undefined);
        s.setResponseExtras({});

        // A new process whose module cannot answer finds only that snapshot: still refused,
        // never served with the thinking the module removed.
        s.restart();
        await expect(s.run(input, "throw")).rejects.toBeInstanceOf(EmergencyFailClosedError);

        // Once the module answers again it replays its persisted reset.
        s.setModuleOutput(() => remap(fixture.pressured.native_messages));
        const healthy = (await s.run(input, "SOFT+")) as MessageLike[];
        expect(reasoningIds(healthy)).toEqual([]);
        expect(healthy.map((message) => message.info.id)).toEqual(
            remap(fixture.pressured.native_messages).map((message) => message.info.id),
        );
    });

    // Reactive recovery is ended only once the stripped replacement is captured: a crash
    // before that leaves it armed, and the fence alone keeps the old thinking out.
    it("a crash after the reset fence leaves reactive recovery armed until a captured replacement", async () => {
        const fixture = signedThinkingFixtures.rewrite;
        const s = frozenSession("signed-reset-crash-reactive");
        const remap = (messages: MessageLike[]) =>
            structuredClone(messages).map((message) => {
                message.info.sessionID = s.sessionId;
                return message;
            });
        const input = remap(fixture.input);
        s.setModuleOutput(() => remap(fixture.before.native_messages));
        await s.run(input, "SOFT+");
        armLatestThinkingRecovery(s.db, s.sessionId);
        s.setUsage(66, 132_000);
        s.setModuleOutput(() => remap(fixture.pressured.native_messages));
        s.setResponseExtras({ signed_thinking_reset: true });
        s.setResetFenceHook(() => {
            throw new Error("simulated crash after the reset fence");
        });
        await expect(s.run(input, "HARD")).rejects.toBeInstanceOf(EmergencyFailClosedError);
        expect(getThinkingBindingRecoveryTarget(s.db, s.sessionId) ?? "").toStartWith(
            "latest_thinking_original",
        );
        // The completed reset pass captures its replacement, then ends the recovery.
        s.setResetFenceHook(undefined);
        const served = (await s.run(input, "HARD")) as MessageLike[];
        expect(reasoningIds(served)).toEqual([]);
        expect(getThinkingBindingRecoveryTarget(s.db, s.sessionId) ?? "").toBe("");
    });

    it("a reset whose whole request is still over the window is refused, not sent", async () => {
        const fixture = signedThinkingFixtures.rewrite;
        const s = frozenSession("signed-reset-over-window");
        const remap = (messages: MessageLike[]) =>
            structuredClone(messages).map((message) => {
                message.info.sessionID = s.sessionId;
                return message;
            });
        const input = remap(fixture.input);
        s.setModuleOutput(() => remap(fixture.before.native_messages));
        await s.run(input, "SOFT+");
        // The module's output on the reset pass still carries a prompt far over the 200k
        // limit (about 1 MB of real words), so the host's final-wire estimate proves the whole
        // request over the window even though no signed thinking is left to strip.
        const huge = "lorem ipsum dolor sit amet ".repeat(40_000);
        s.setModuleOutput(() =>
            remap(fixture.pressured.native_messages).map((message) =>
                message.info.id === "u3"
                    ? { ...message, parts: [{ type: "text", text: huge }] }
                    : message,
            ),
        );
        s.setResponseExtras({ signed_thinking_reset: true });
        const refused = s.run(input, "HARD");
        await expect(refused).rejects.toBeInstanceOf(EmergencyFailClosedError);
        await expect(refused).rejects.toThrow(SIGNED_TURN_OVER_LIMIT);
    });
});
