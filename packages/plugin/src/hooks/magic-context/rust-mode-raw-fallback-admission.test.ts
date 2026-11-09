/// <reference types="bun-types" />

// The raw full-history fallback is admitted exactly like a last-known-good
// replay: against the trusted limit (never the larger usable hard limit), with
// the four-bytes-per-token proxy counting only what the provider request carries.

import { afterEach, describe, expect, it } from "bun:test";

import { runMigrations } from "../../features/magic-context/migrations";
import type { ContextDatabase } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage-meta";
import { resetEmergencyRecoveryRegistryForTest } from "../../features/magic-context/storage-meta-persisted";
import { clearModelsDevCache, refreshModelLimitsFromApi } from "../../shared/models-dev-cache";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { resolveContextWindowGeometry, resolveTrustedContextLimit } from "./event-resolvers";
import type { estimateFinalWireInputTokens } from "./final-wire-token-estimate";
import { registerLkgPersistence, resetLkgSlotsForTest } from "./lkg-slot";
import { RawFallbackContextLimitError } from "./raw-fallback-context-limit";
import { setRawMessageProvider } from "./read-session-chunk";
import { closeReadOnlySessionDb } from "./read-session-db";
import { resetRustLkgReplayParticipantsForTest } from "./rust-lkg-freeze-registry";
import { createRustModeTransform, type RustModeModuleClient } from "./rust-mode-transform";
import type { TransformDeps } from "./transform";
import type { MessageLike } from "./transform-operations";

// GitHub Copilot's gpt-5-mini as OpenCode's catalog lists it: a 264k window, a
// 128k prompt limit Copilot enforces, a 64k output limit.
const COPILOT = { providerID: "github-copilot", modelID: "gpt-5-mini" };

const databases: ContextDatabase[] = [];
const unregisters: Array<() => void> = [];
let sessionCounter = 0;

afterEach(() => {
    resetEmergencyRecoveryRegistryForTest();
    registerLkgPersistence(undefined);
    resetLkgSlotsForTest();
    resetRustLkgReplayParticipantsForTest();
    closeReadOnlySessionDb();
    clearModelsDevCache();
    for (const unregister of unregisters.splice(0)) unregister();
    for (const db of databases.splice(0)) closeQuietly(db);
});

async function registerCopilotRow(): Promise<void> {
    await refreshModelLimitsFromApi({
        config: {
            providers: async () => ({
                data: {
                    providers: [
                        {
                            id: COPILOT.providerID,
                            models: {
                                [COPILOT.modelID]: {
                                    limit: { context: 264_000, input: 128_000, output: 64_000 },
                                },
                            },
                        },
                    ],
                },
            }),
        },
    });
}

function trustedEstimate(tokens: number): ReturnType<typeof estimateFinalWireInputTokens> {
    return {
        tokens,
        trusted: true,
        messageTokens: { conversation: tokens, toolCall: 0 },
        systemTokens: 0,
        toolDefinitionTokens: 0,
    };
}

/**
 * A compaction-off Rust session whose module is down, so every pass serves the
 * raw input when the raw fallback admits it and throws when it refuses.
 */
function fallbackSession(estimate: () => ReturnType<typeof estimateFinalWireInputTokens>) {
    sessionCounter += 1;
    const sessionId = `rust-raw-fallback-admission-${sessionCounter}-${Date.now()}`;
    const db = new Database(":memory:") as ContextDatabase;
    initializeDatabase(db);
    runMigrations(db);
    databases.push(db);
    const row = { id: "m1", timeCreated: 1, contributesOrdinal: true, hasValidInfo: true };
    unregisters.push(
        setRawMessageProvider(sessionId, {
            readMessages: () => [row],
            readMessageOrdinalPage: () => [],
            getStoredMessageCount: () => 1,
            readMessagePartsById: () => ({
                id: "m1",
                role: "user",
                parts: [{ type: "text", text: "question" }],
                createdAt: 1,
            }),
        }),
    );
    const moduleClient: RustModeModuleClient = {
        call: async ({ method }) => {
            if (method === "transform") throw new Error("daemon unavailable");
            return { ok: true };
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
        liveModelBySession: new Map([[sessionId, { ...COPILOT }]]),
        sessionDirectoryBySession: new Map(),
        transformMode: "rust",
        rustModeModuleClient: moduleClient,
        historianRunner: "broca",
        compactionOff: true,
    };
    const transform = createRustModeTransform(deps, {
        moduleClient,
        rawFallbackEstimatorForTests: estimate,
    });
    const run = async (input: MessageLike[]) => {
        const sessionMeta = getOrCreateSessionMeta(db, sessionId);
        if (sessionMeta.systemPromptTokens <= 0) {
            updateSessionMeta(db, sessionId, { systemPromptTokens: 100 });
            sessionMeta.systemPromptTokens = 100;
        }
        const output = { messages: [...input] as unknown[] };
        await transform.run(sessionId, input, output, sessionMeta);
        return output.messages;
    };
    return { sessionId, db, run };
}

function user(sessionId: string, id: string, text: string): MessageLike {
    return {
        info: { id, role: "user", sessionID: sessionId, model: { ...COPILOT } },
        parts: [{ type: "text", text }],
    } as MessageLike;
}

/** An assistant whose edit tool keeps a whole file before and after in metadata. */
function editingAssistant(sessionId: string, id: string, fileBytes: number): MessageLike {
    const before = "x".repeat(fileBytes);
    return {
        info: { id, role: "assistant", sessionID: sessionId },
        parts: [
            {
                type: "tool",
                tool: "edit",
                callID: `call-${id}`,
                state: {
                    status: "completed",
                    input: { filePath: "/tmp/project/big.ts", oldString: "a", newString: "b" },
                    output: "Edit applied successfully.",
                    metadata: { filediff: { before, after: `${before}b` } },
                    time: { start: 1, end: 2 },
                },
            },
            { type: "text", text: `edited in ${id}` },
        ],
    } as MessageLike;
}

describe("the raw fallback is admitted like a last-known-good replay", () => {
    it("refuses a raw fallback over the prompt limit Copilot enforces", async () => {
        await registerCopilotRow();
        // A 150k-token history, over the 128k prompt limit Copilot enforces. That
        // declared limit caps the usable hard limit as well, so the history is
        // over both.
        const s = fallbackSession(() => trustedEstimate(150_000));
        const ctx = { db: s.db, sessionID: s.sessionId };
        expect(resolveTrustedContextLimit(COPILOT.providerID, COPILOT.modelID, ctx)).toBe(128_000);
        expect(
            resolveContextWindowGeometry(COPILOT.providerID, COPILOT.modelID, ctx)?.usableHard,
        ).toBe(128_000);
        const input = [user(s.sessionId, "m1", "question")];
        const outcome = await s.run(input).catch((error: unknown) => error);
        expect(outcome).toBeInstanceOf(RawFallbackContextLimitError);
        expect((outcome as RawFallbackContextLimitError).contextLimitTokens).toBe(128_000);
    });

    it("admits a raw fallback whose only bulk is tool metadata the wire never carries", async () => {
        await registerCopilotRow();
        const s = fallbackSession(() => trustedEstimate(5_000));
        // Two edits of a 300 KB file: about 1.2 MB of file copies in tool metadata,
        // over the 512 KB a whole-message byte count allows a 128k limit, while
        // the request itself is small.
        const input = [
            user(s.sessionId, "m1", "question"),
            editingAssistant(s.sessionId, "a1", 300_000),
            user(s.sessionId, "m2", "turn 2"),
            editingAssistant(s.sessionId, "a2", 300_000),
            user(s.sessionId, "m3", "turn 3"),
        ];
        const outcome = await s.run(input).catch((error: unknown) => error);
        expect(outcome).not.toBeInstanceOf(Error);
        expect((outcome as unknown[]).length).toBe(input.length);
    });
});
