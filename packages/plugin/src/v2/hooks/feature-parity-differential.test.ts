import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MagicContextConfigSchema } from "../../config/schema/magic-context";
import * as embedding from "../../features/magic-context/memory/embedding";
import { resolveProjectIdentityForSession } from "../../features/magic-context/memory/project-identity";
import {
    closeDatabase,
    getTagsBySession,
    openDatabase,
} from "../../features/magic-context/storage";
import { getAutoSearchHintDecisions } from "../../features/magic-context/storage-meta-persisted";
import { createTagger } from "../../features/magic-context/tagger";
import { replayHint } from "../../hooks/magic-context/auto-search-replay.fixture";
import { autoSearchTestSnapshot } from "../../hooks/magic-context/auto-search-snapshot.fixture";
import * as search from "../../hooks/magic-context/auto-search-worker-client";
import { resetLkgSlotsForTest } from "../../hooks/magic-context/lkg-slot";
import { createTransform, type TransformDeps } from "../../hooks/magic-context/transform";
import type { MessageLike } from "../../hooks/magic-context/transform-operations";
import { scaleTest } from "../../shared/slow-test";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import { createV2AutoEmbedSession, createV2TransformFeatureDeps } from "./transform-features";

const dir = createTestTempDir("mc-v2-off-differential-").dir;
const oldXdg = process.env.XDG_DATA_HOME;
const oldConfig = process.env.XDG_CONFIG_HOME;
process.env.XDG_DATA_HOME = dir;
process.env.XDG_CONFIG_HOME = join(dir, "config");
const config = MagicContextConfigSchema.parse({
    memory: {
        enabled: false,
        auto_search: { enabled: false },
        git_commit_indexing: { enabled: false },
    },
    embedding: { provider: "off" },
    dreamer: { disable: true, inject_docs: false },
    historian: { disable: true },
    temporal_awareness: false,
    mural: { enabled: false },
    caveman_text_compression: { enabled: false },
    protected_tools: {},
    commit_cluster_trigger: { enabled: false },
});
const baselineDb = openDatabase(join(dir, "baseline.db"))!;
const wiredDb = openDatabase(join(dir, "wired.db"))!;
if (!baselineDb || !wiredDb) throw new Error("throwaway stores unavailable");
mkdirSync(join(dir, "config/cortexkit"), { recursive: true });
writeFileSync(join(dir, "config/cortexkit/magic-context.jsonc"), JSON.stringify(config));
afterAll(() => {
    closeDatabase();
    resetLkgSlotsForTest();
    cleanupTestTempDir(dir);
    if (oldXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = oldXdg;
    if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldConfig;
});

function transform(
    db: typeof baselineDb,
    session: string,
    decision: () => "execute" | "defer",
    extra: Partial<TransformDeps> = {},
) {
    return createTransform({
        db,
        tagger: createTagger(),
        scheduler: { shouldExecute: decision },
        contextUsageMap: new Map([
            [session, { usage: { percentage: 90, inputTokens: 180_000 }, updatedAt: Date.now() }],
        ]),
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        liveModelBySession: new Map([[session, { providerID: "openai", modelID: "gpt-4.1" }]]),
        storeGeneration: "v2",
        directory: dir,
        projectPath: dir,
        hostRawMessages: () => [],
        hostPrepareRawOrdinals: async () => true,
        memoryConfig: {
            enabled: false,
            injectionBudgetTokens: config.memory.injection_budget_tokens,
            autoPromote: false,
        },
        protectedTokens: 1,
        keepReasoningTokens: 100_000,
        // No hidden executor is installed and the historian is disabled, so
        // mirror the production OpenCode 2 historian admission gate.
        historianRunnable: false,
        ...extra,
    });
}

const prose =
    "Please review the implementation and verify the results carefully before we continue with the next step. ";
function messages(session: string, turns: number, salt = 0): MessageLike[] {
    return Array.from({ length: turns * 2 }, (_, n) => ({
        info: {
            id: `${n % 2 ? "a" : "u"}${n}`,
            role: n % 2 ? "assistant" : "user",
            sessionID: session,
            time: { created: 1700000000000 + n * 60000 },
        },
        parts: [{ type: "text", text: `${salt}/${n}: ${prose.repeat(1 + ((n + salt) % 5))}` }],
    }));
}

const disabledParity = "v2 disabled features preserve baseline bytes over randomized passes";
for (let shard = 0; shard < 4; shard++) {
    scaleTest(
        `${disabledParity} shard ${shard + 1}/4`,
        async (slow) => {
            let random = 709;
            const next = () => {
                random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
                return random;
            };
            const size = slow ? 60 : 12;
            const firstPass = shard * size;
            for (let pass = 0; pass < firstPass + size; pass++) {
                const session = `ses709diff-${pass}`;
                const decision = next() % 3 ? "defer" : "execute";
                const turns = 1 + (next() % 12);
                const salt = next() % 200;
                const omitTail = next() % 2;
                // Advance the original stream before selecting this disjoint batch.
                if (pass < firstPass) continue;
                const source = messages(session, turns, salt);
                if (omitTail) source.pop();
                const oldOutput = { messages: structuredClone(source) };
                const newOutput = { messages: structuredClone(source) };
                resetLkgSlotsForTest();
                await transform(baselineDb, session, () => decision)({}, oldOutput);
                resetLkgSlotsForTest();
                await transform(wiredDb, session, () => decision, {
                    ...createV2TransformFeatureDeps(config, false, dir),
                    commitSeenLastPass: new Map(),
                    projectPath: resolveProjectIdentityForSession(dir),
                    maybeAutoEmbedSession: createV2AutoEmbedSession({
                        db: wiredDb,
                        resolveDirectory: () => dir,
                        recompProgressBySession: new Map(),
                    }),
                    getHistorianChunkTokens: () => 20000,
                    getFallbackModelId: () => "openai/gpt-4.1",
                })({}, newOutput);
                expect(JSON.stringify(newOutput), `randomized pass ${pass} (${decision})`).toBe(
                    JSON.stringify(oldOutput),
                );
            }
            await new Promise((resolve) => setTimeout(resolve, 0));
        },
        60000,
    );
}

test("enabling caveman and autoSearch cannot first-edit a same-turn defer prefix", async () => {
    const session = "ses709toggle";
    const source = messages(session, 12);
    let decision: "execute" | "defer" = "execute";
    const controls = createV2TransformFeatureDeps(config, false, dir);
    const stableState = {
        lastHeuristicsTurnId: new Map<string, string>(),
        contextUsageMap: new Map([
            [session, { usage: { percentage: 10, inputTokens: 20_000 }, updatedAt: Date.now() }],
        ]),
    };
    const run = transform(wiredDb, session, () => decision, { ...controls, ...stableState });
    const first = { messages: structuredClone(source) };
    await run({}, first);
    decision = "defer";
    controls.autoSearch.enabled = true;
    // The transform retains these option objects, just as a restarted host reads enabled controls.
    const enabled = MagicContextConfigSchema.parse({
        ...config,
        caveman_text_compression: { enabled: true, min_chars: 100 },
    });
    const second = { messages: structuredClone(source) };
    const restarted = transform(wiredDb, session, () => decision, {
        ...createV2TransformFeatureDeps(enabled, false, dir),
        autoSearch: controls.autoSearch,
        ...stableState,
    });
    await restarted({}, second);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(getTagsBySession(wiredDb, session).some((tag) => (tag.cavemanDepth ?? 0) > 0)).toBe(
        false,
    );
});

test("v2 caveman first-applies on an allowed pass and replays byte-identically on defer", async () => {
    const session = "ses709caveman";
    let decision: "execute" | "defer" = "execute";
    const enabled = MagicContextConfigSchema.parse({
        ...config,
        caveman_text_compression: { enabled: true, min_chars: 100 },
    });
    const run = transform(wiredDb, session, () => decision, {
        ...createV2TransformFeatureDeps(enabled, false, dir),
        pendingMaterializationSessions: new Set([session]),
    });
    const first = { messages: messages(session, 12) };
    await run({}, first);
    expect(getTagsBySession(wiredDb, session).some((tag) => (tag.cavemanDepth ?? 0) > 0)).toBe(
        true,
    );
    decision = "defer";
    const replay = { messages: messages(session, 12) };
    await run({}, replay);
    expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
});

test("v2 autoSearch first-attaches only to a fresh user tail and replays its exact hint", async () => {
    const session = "ses709hint";
    const enabled = MagicContextConfigSchema.parse({
        ...config,
        memory: { ...config.memory, auto_search: { enabled: true } },
    });
    const project = resolveProjectIdentityForSession(dir)!;
    const snapshot = spyOn(embedding, "getProjectEmbeddingSnapshot").mockReturnValue(
        autoSearchTestSnapshot(project),
    );
    const lookup = spyOn(search, "searchAutoHint").mockResolvedValue([
        {
            source: "message",
            content: "Review the implementation and verify the results carefully.",
            score: replayHint.score,
            messageOrdinal: 0,
            messageId: "prior-message",
            role: "assistant",
        },
    ]);
    const run = transform(wiredDb, session, () => "defer", {
        ...createV2TransformFeatureDeps(enabled, false, dir),
        projectPath: project,
        contextUsageMap: new Map([
            [session, { usage: { percentage: 10, inputTokens: 20_000 }, updatedAt: Date.now() }],
        ]),
    });
    try {
        const oldTail = { messages: messages(session, 2) };
        await run({}, oldTail);
        expect(lookup).not.toHaveBeenCalled();
        expect(getAutoSearchHintDecisions(wiredDb, session)).toEqual([]);
        const source = messages(session, 3);
        source.pop();
        const fresh = { messages: structuredClone(source) };
        await run({}, fresh);
        expect(lookup).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(fresh)).toContain("<ctx-search-hint>");
        expect(getAutoSearchHintDecisions(wiredDb, session)).toMatchObject([
            { messageId: "u4", decision: "hint" },
        ]);
        const replay = { messages: structuredClone(source) };
        await run({}, replay);
        expect(lookup).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(replay)).toBe(JSON.stringify(fresh));
    } finally {
        lookup.mockRestore();
        snapshot.mockRestore();
    }
});
