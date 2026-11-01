import { describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    clearSession,
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage-meta";
import { clearSessionRenderCache } from "../../features/magic-context/storage-session-cache";
import {
    getSessionToolDefinitionTokens,
    recordToolDefinition,
    recordToolDefinitionSet,
} from "../../features/magic-context/tool-definition-tokens";
import { Database } from "../../shared/sqlite";
import { createTestTempDir } from "../../shared/test-temp-dir";
import * as decayRender from "./decay-render";
import {
    HOST_BREAKDOWN_KEY,
    HostTokenMeasurementCache,
    persistHostTokenBreakdown as persistAttribution,
    scheduleHostTokenBreakdown as scheduleAttribution,
} from "./host-token-breakdown";
import { computeM0BlockTokens } from "./m0-token-breakdown";
import * as tokenCount from "./token-count-exact";
import { calibrateBuckets } from "./tokenizer-calibration";

export const drainHostBreakdown = () => new Promise((resolve) => setTimeout(resolve, 10));

// Neutral calibration keeps these tolerance/cache fixtures independent of model catalogs.
function testPass(
    session: string,
    pass: {
        measuredAt: number;
        prefixChanged: boolean;
        conversationTokens: number;
        toolCallTokens: number;
        toolDefinitionTokens?: number;
    },
) {
    return {
        ...pass,
        projectIdentity: undefined,
        readAttribution: (blocks: ReturnType<typeof computeM0BlockTokens>) => {
            const tools = pass.toolDefinitionTokens ?? getSessionToolDefinitionTokens(session) ?? 0;
            const injected =
                blocks.docsTokens +
                blocks.profileTokens +
                blocks.memoryTokens +
                blocks.compartmentTokens;
            return calibrateBuckets({
                inputTokens: pass.conversationTokens + pass.toolCallTokens + tools,
                systemLocal: 0,
                toolDefsLocal: tools,
                compartmentsLocal: blocks.compartmentTokens,
                factsLocal: blocks.factTokens,
                memoriesLocal: blocks.memoryTokens,
                docsLocal: blocks.docsTokens,
                profileLocal: blocks.profileTokens,
                conversationLocal: Math.max(0, pass.conversationTokens - injected),
                toolCallsLocal: pass.toolCallTokens,
                calibration: { systemRatio: 1, toolsRatio: 1, proseRatio: 1 },
            });
        },
    };
}
const persistHostTokenBreakdown = (
    db: Database,
    session: string,
    pass: Parameters<typeof testPass>[1],
) => persistAttribution(db, session, testPass(session, pass));
const scheduleHostTokenBreakdown = (
    db: Database,
    session: string,
    pass: Parameters<typeof testPass>[1],
) => scheduleAttribution(db, session, testPass(session, pass));

test("host token measurements leave tokenizer loading to the prompt preload", () => {
    const breakdownUrl = new URL("./host-token-breakdown.ts", import.meta.url).href;
    const formattingUrl = new URL("./read-session-formatting.ts", import.meta.url).href;
    // A fresh process detects import-time loads even when earlier tests already used the tokenizer.
    const script = `
        const { HostTokenMeasurementCache } = await import(${JSON.stringify(breakdownUrl)});
        const { getTokenizerNativeMemoryStats, preloadTokenizer } = await import(${JSON.stringify(formattingUrl)});
        const afterImport = getTokenizerNativeMemoryStats();
        const cache = new HostTokenMeasurementCache();
        const afterConstruction = getTokenizerNativeMemoryStats();
        const preloaded = await preloadTokenizer();
        const tokens = cache.text("hello");
        console.log(JSON.stringify({ afterImport, afterConstruction, preloaded, tokens }));
    `;
    const child = spawnSync(process.execPath, ["--no-install", "-e", script], {
        encoding: "utf8",
        timeout: 20_000,
        windowsHide: true,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stderr).toBe("");
    const result = JSON.parse(child.stdout);
    expect(result.afterImport.loadAttempted).toBe(false);
    expect(result.afterImport.loaded).toBe(false);
    expect(result.afterConstruction.loadAttempted).toBe(false);
    expect(result.afterConstruction.loaded).toBe(false);
    expect(result.preloaded).toBe(true);
    expect(result.tokens).toBe(1);
});

test("prefix attribution reads once per fold or delta refresh, never on a memoized defer, and reloads after restart or clear", async () => {
    const { dir, cleanup } = createTestTempDir("host-token-prefix-memo-");
    const filename = join(dir, "context.db");
    let db = new Database(filename);
    initializeDatabase(db);
    runMigrations(db);
    const session = "host-prefix-memo";
    getOrCreateSessionMeta(db, session);
    updateSessionMeta(db, session, {
        cachedM0Bytes: Buffer.from(
            "<project-docs>memo docs</project-docs><user-profile>memo profile</user-profile><project-memory>memo memory</project-memory><session-history>memo history</session-history>",
        ),
    });
    let reads = 0;
    const observeReads = () => {
        const prepare = db.prepare.bind(db);
        return spyOn(db, "prepare").mockImplementation(((sql: string) => {
            const statement = prepare(sql);
            if (!sql.trimStart().startsWith("SELECT") || !sql.includes("FROM session_render_cache"))
                return statement;
            return new Proxy(statement, {
                get(target, key) {
                    const value = Reflect.get(target, key, target);
                    if (typeof value !== "function") return value;
                    return (...args: unknown[]) => {
                        if (key === "all" || key === "get") reads++;
                        return value.apply(target, args);
                    };
                },
            });
        }) as never);
    };
    let readSpy = observeReads();
    const extract = spyOn(decayRender, "extractM0Block");
    const pass = {
        prefixChanged: false,
        conversationTokens: 50_000,
        toolCallTokens: 80_000,
        toolDefinitionTokens: 10_000,
    };
    let clock = 1;
    const run = (prefixChanged = false, updates = {}) =>
        persistHostTokenBreakdown(db, session, {
            ...pass,
            measuredAt: clock++,
            prefixChanged,
            ...updates,
        });
    const reset = () => {
        reads = 0;
        extract.mockClear();
    };
    let hasDelta = false;
    const expectOneDerivation = () => {
        expect(reads).toBe(1);
        // The shared sidebar helper only extracts a history delta when m[1] exists.
        expect(extract).toHaveBeenCalledTimes(hasDelta ? 5 : 4);
        for (const tag of ["project-docs", "user-profile", "project-memory", "session-history"])
            expect(extract.mock.calls.filter(([, actual]) => actual === tag)).toHaveLength(1);
        expect(extract.mock.calls.filter(([, tag]) => tag === "new-compartments")).toHaveLength(
            hasDelta ? 1 : 0,
        );
    };
    try {
        expect(run()).toBe(true);
        expectOneDerivation();
        reset();
        expect(run()).toBe(false);
        expect(reads).toBe(0);
        expect(extract).not.toHaveBeenCalled();

        expect(run(false, { conversationTokens: 51_000, toolCallTokens: 81_000 })).toBe(true);
        expect(reads).toBe(0);
        expect(extract).not.toHaveBeenCalled();

        // Coalescing a fold's deferred task with a later defer must keep the dirty prefix.
        scheduleHostTokenBreakdown(db, session, {
            ...pass,
            measuredAt: clock++,
            prefixChanged: true,
        });
        scheduleHostTokenBreakdown(db, session, { ...pass, measuredAt: clock++ });
        await drainHostBreakdown();
        expectOneDerivation();

        reset();
        expect(run(true)).toBe(false);
        expectOneDerivation();

        updateSessionMeta(db, session, {
            cachedM1Bytes: Buffer.from(
                `<new-compartments>${"new history ".repeat(1000)}</new-compartments>`,
            ),
        });
        hasDelta = true;
        reset();
        expect(run(true)).toBe(true);
        expectOneDerivation();
        reset();
        expect(run()).toBe(false);
        expect(reads).toBe(0);
        expect(extract).not.toHaveBeenCalled();

        // A fold can persist its prefix before a later stage refuses the pass.
        // The next pass has no new fold flag, but must still refresh attribution.
        updateSessionMeta(db, session, {
            cachedM1Bytes: Buffer.from(
                `<new-compartments>${"changed history ".repeat(2000)}</new-compartments>`,
            ),
        });
        reset();
        expect(run()).toBe(true);
        expectOneDerivation();

        readSpy.mockRestore();
        db.close();
        db = new Database(filename);
        readSpy = observeReads();
        reset();
        expect(run()).toBe(false);
        expectOneDerivation();

        scheduleHostTokenBreakdown(db, session, { ...pass, measuredAt: clock++ });
        clearSessionRenderCache(db, session);
        hasDelta = false;
        reset();
        await drainHostBreakdown();
        expect(reads).toBe(0);
        expect(extract).not.toHaveBeenCalled();
        reset();
        expect(run()).toBe(true);
        expectOneDerivation();

        clearSession(db, session);
        getOrCreateSessionMeta(db, session);
        reset();
        expect(run()).toBe(true);
        expectOneDerivation();
    } finally {
        extract.mockRestore();
        readSpy.mockRestore();
        db.close();
        cleanup();
    }
});

describe("host pass token breakdown", () => {
    for (const generation of ["OpenCode 1", "OpenCode 2"]) {
        test(`${generation} reuses request tool counts, persists once, and accumulates threshold changes`, async () => {
            const db = new Database(":memory:");
            initializeDatabase(db);
            const session = `host-breakdown-${generation}`;
            getOrCreateSessionMeta(db, session);
            const schema = {
                id: "read",
                description: `Read a file ${generation}`,
                parameters: { type: "object" },
            };
            if (generation === "OpenCode 1")
                recordToolDefinition(
                    "anthropic",
                    "opus",
                    "build",
                    schema.id,
                    schema.description,
                    schema.parameters,
                    session,
                );
            else recordToolDefinitionSet("anthropic", "opus", "build", [schema], session);
            const m0 = `<project-docs>host pass docs ${generation}</project-docs><user-profile>host pass profile ${generation}</user-profile><project-memory>host pass memory ${generation}</project-memory><session-history>host pass history ${generation}</session-history>`;
            updateSessionMeta(db, session, {
                cachedM0Bytes: Buffer.from(m0),
                conversationTokens: 50_000,
                toolCallTokens: 80_000,
            });
            const saved = () =>
                db
                    .prepare(
                        "SELECT value FROM session_render_cache WHERE session_id=? AND cache_key=?",
                    )
                    .get(session, HOST_BREAKDOWN_KEY) as { value: string } | null;
            const writes = () =>
                (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
            const pass = {
                measuredAt: 123,
                prefixChanged: false,
                conversationTokens: 50_000,
                toolCallTokens: 80_000,
            };
            const encode = spyOn(tokenCount, "countTokensExactly");
            try {
                scheduleHostTokenBreakdown(db, session, pass);
                expect(saved()).toBeNull();
                expect(encode).not.toHaveBeenCalled();
                await drainHostBreakdown();
                expect(encode).toHaveBeenCalledTimes(4);
                const first = saved()!.value;
                const parts = JSON.parse(first).parts;
                expect(parts.tool_definitions).toBeGreaterThan(0);
                expect(parts.project_docs).toBeGreaterThan(0);
                expect(parts.user_profile).toBeGreaterThan(0);
                expect(parts.history_raw).toBeLessThan(50_000);
                expect(parts.tool_calls_results).toBe(80_000);
                expect(parts.last_user_message).toBe(0);
                encode.mockClear();
                const before = writes();
                scheduleHostTokenBreakdown(db, session, { ...pass, measuredAt: 124 });
                await drainHostBreakdown();
                expect(saved()!.value).toBe(first);
                expect(writes()).toBe(before);
                expect(encode).not.toHaveBeenCalled();
                computeM0BlockTokens(db, session, {
                    m0Text: m0,
                    projectIdentity: undefined,
                    injectionBudgetTokens: undefined,
                    memoryBlockCount: 0,
                });
                expect(encode).not.toHaveBeenCalled();
                expect(
                    persistHostTokenBreakdown(db, session, {
                        ...pass,
                        measuredAt: 125,
                        toolDefinitionTokens: parts.tool_definitions,
                        toolCallTokens: 80_500,
                    }),
                ).toBe(false);
                expect(writes()).toBe(before);
                expect(
                    persistHostTokenBreakdown(db, session, {
                        ...pass,
                        measuredAt: 126,
                        toolDefinitionTokens: parts.tool_definitions,
                        toolCallTokens: 80_501,
                    }),
                ).toBe(true);
                expect(JSON.parse(saved()!.value).measured_at).toBe(126);
            } finally {
                encode.mockRestore();
                db.close();
            }
        });
    }

    test("one percent can trigger before 500 tokens and unmeasured tools match the sidebar's zero", () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        getOrCreateSessionMeta(db, "small");
        try {
            const pass = {
                measuredAt: 1,
                prefixChanged: false,
                conversationTokens: 1000,
                toolCallTokens: 1000,
            };
            expect(persistHostTokenBreakdown(db, "small", pass)).toBe(true);
            expect(
                persistHostTokenBreakdown(db, "small", {
                    ...pass,
                    measuredAt: 2,
                    conversationTokens: 1010,
                }),
            ).toBe(false);
            expect(
                persistHostTokenBreakdown(db, "small", {
                    ...pass,
                    measuredAt: 3,
                    conversationTokens: 1011,
                }),
            ).toBe(true);
            const row = db
                .prepare(
                    "SELECT value FROM session_render_cache WHERE session_id='small' AND cache_key=?",
                )
                .get(HOST_BREAKDOWN_KEY) as { value: string };
            expect(JSON.parse(row.value).parts.tool_definitions).toBe(0);
            expect(persistHostTokenBreakdown(db, "small", { ...pass, measuredAt: 2 })).toBe(false);
        } finally {
            db.close();
        }
    });

    test("hash cache measures a changed block or tool set once", () => {
        let calls = 0;
        const cache = new HostTokenMeasurementCache((text) => {
            calls++;
            return text.length;
        });
        expect(cache.text("docs")).toBe(4);
        expect(cache.text("docs")).toBe(4);
        expect(cache.tools(["schema"])).toBe(6);
        expect(cache.tools(["schema"])).toBe(6);
        expect(calls).toBe(2);
        expect(cache.text("new docs")).toBe(8);
        expect(cache.tools(["schema", "new schema"])).toBe(16);
        expect(calls).toBe(4);
    });
});
