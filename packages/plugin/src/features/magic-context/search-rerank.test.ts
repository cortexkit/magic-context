import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fixture from "../../../../../scripts/fixtures/ctx-search-known-answers.json";
import * as logger from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { insertMemory } from "./memory";
import type { SynapseClientLike } from "./memory/embedding-synapse";
import { ensureMessagesIndexed } from "./message-index";
import { runMigrations } from "./migrations";
import {
    formatSearchResults,
    searchMessageHistory,
    type UnifiedSearchOptions,
    type UnifiedSearchResult,
    unifiedSearch,
} from "./search";
import {
    candidateText,
    candidateTexts,
    emptySearchLanes,
    fuseSearchLanes,
    isProseQuery,
    pinReranker,
    prepareReranker,
    RERANK_MODEL,
    type RerankSession,
    rerankSearchResults,
} from "./search-rerank";
import { initializeDatabase } from "./storage-db";

const fingerprint = "a".repeat(64);
const catalog = {
    table_epoch: 2,
    models: [{ model_id: RERANK_MODEL, certified: true, fingerprints: [fingerprint] }],
};
const identity = { project_root: "git:test", harness: "test", session: "s" };
const hit = (id: number): UnifiedSearchResult => ({
    source: "memory",
    memoryId: id,
    content: `memory ${id}`,
    category: "ARCHITECTURE",
    matchType: "fts",
    score: 1 / id,
});
function client(call: (method: string, params: unknown) => unknown): SynapseClientLike {
    return {
        call: async <T>(_module: string, method: string, params?: unknown) =>
            (await call(method, params)) as T,
        close() {},
    };
}
const baseline = [hit(1), hit(2)];
const pool = [hit(2), hit(3), hit(1)];
function session(response: unknown, reject = false): RerankSession {
    return {
        client: client(() => {
            if (reject) throw response;
            return response;
        }),
        lane: { fingerprint, tableEpoch: 2 },
        identity,
    };
}
const response = { fingerprint, table_epoch: 2, scores: [0, 1, 1] };
const texts = pool.map((row) => row.content);
let db: Database | undefined;
afterEach(() => {
    db?.close();
    db = undefined;
});
function store(): Database {
    db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    for (let i = 0; i < 40; i++)
        insertMemory(db, {
            projectPath: "git:test",
            category: "ARCHITECTURE",
            content: `prompt cache budget stable explanation ${i}`,
        });
    return db;
}
const options: UnifiedSearchOptions = {
    explicitSearch: true,
    embeddingEnabled: false,
    countRetrievals: false,
    measurementDisabled: true,
    sources: ["memory"],
    limit: 10,
};

describe("prose classifier", () => {
    test.each([
        ["Chinese", "摘要块为什么只增不减，活跃块会打断候选区间"],
        ["Japanese", "会話の履歴を保存する仕組みを説明してください"],
        ["Korean", "이전 대화 기록을 검색하는 방법을 설명해 주세요"],
        ["Thai", "ทำไมระบบจึงเก็บประวัติการสนทนาไว้ในฐานข้อมูล"],
        ["Lao", "ລະບົບເກັບປະຫວັດການສົນທະນາໄວ້ໃນຖານຂໍ້ມູນ"],
        ["Khmer", "ប្រព័ន្ធរក្សាទុកប្រវត្តិការសន្ទនានៅក្នុងមូលដ្ឋានទិន្នន័យ"],
        ["Cyrillic", "Почему история сообщений хранится в базе данных"],
        ["Arabic", "لماذا يتم حفظ سجل المحادثات في قاعدة البيانات"],
        ["Devanagari", "बातचीत का इतिहास डेटाबेस में क्यों रखा जाता है"],
        ["accented Latin", "où sont conservées les données de la dernière session"],
        ["mixed Chinese and identifiers", "子代理开关为什么要拆成 compress 和 memoryWrite 两项"],
        ["mixed Japanese and identifiers", "ctx_search はどのように会話の履歴を検索しますか"],
    ])("recognizes %s prose", (_script, query) => {
        expect(isProseQuery(query)).toBe(true);
    });
    test.each([
        "压缩",
        "история сообщений",
        "src/features/搜索/cache.ts:118",
        "C:\\项目\\搜索\\缓存.ts",
        "TypeError: 无法读取历史记录中的属性",
        "SQLITE_CANTOPEN: 无法打开历史记录数据库文件",
        "错误详情 at search (历史记录)",
        '"为什么需要保存完整的历史记录"',
        "为什么需要保存历史记录\n以及如何恢复它们",
        "为什么需要保存历史记录;如何恢复它们",
        "历史记录::缓存预算为什么需要保持稳定",
        "历史记录=缓存预算为什么需要保持稳定",
    ])("keeps literal and code exclusions for %s", (query) => {
        expect(isProseQuery(query)).toBe(false);
    });
    test("manual fixture has zero literal false positives and a declared conservative miss", () => {
        const queries = [...fixture.queries, ...fixture.rerankSupplementQueries];
        const matrix = { trueProse: 0, missedProse: 0, falseProse: 0, trueLiteral: 0 };
        for (const row of queries) {
            const prose = isProseQuery(row.query);
            if (row.shape === "prose") matrix[prose ? "trueProse" : "missedProse"]++;
            else matrix[prose ? "falseProse" : "trueLiteral"]++;
        }
        expect(matrix).toEqual({ trueProse: 39, missedProse: 1, falseProse: 0, trueLiteral: 12 });
    });
    test("rejects literal, error, hash, path and short symbol queries", () => {
        for (const query of [
            "getVisibleMemoryIds",
            "cache_ttl",
            "ctx_reduce_enabled",
            "sqlite-vec",
            "issue #195",
            "a".repeat(40),
            "src/search.ts",
            "Error: Cannot read properties of undefined",
            "Cannot read properties of undefined (reading 'map')",
            "SQLITE_CANTOPEN: unable to open database file",
            '"the cache budget is stable"',
            "foo bar",
            "foo::bar baz quux",
            "cache_ttl fooBar symbol_name",
        ])
            expect(isProseQuery(query)).toBe(false);
        expect(isProseQuery("Why does ctx_search hide visible memories?")).toBe(true);
        expect(isProseQuery("shadow mode byte compare Rust transform")).toBe(true);
    });
});

test("RRF stable lane order, duplicate votes and message containment match the spike", () => {
    const lanes = emptySearchLanes();
    const compartment: UnifiedSearchResult = {
        source: "compartment",
        compartmentId: 9,
        sessionId: "s",
        startOrdinal: 1,
        endOrdinal: 10,
        title: "compartment",
        content: "compartment",
        score: 1,
        matchType: "semantic",
    };
    lanes.memory_fts = [hit(1), hit(1), hit(2)];
    lanes.message_fts = [1, 2].map((ordinal) => ({
        source: "message",
        messageId: `m${ordinal}`,
        messageOrdinal: ordinal,
        content: "message",
        role: "user",
        score: 1,
    }));
    lanes.chunk_vector = [compartment];
    expect(fuseSearchLanes(lanes)).toEqual([compartment, hit(1), hit(2)]);
});

test("candidate recipe preserves UTF-8 and its byte budgets", () => {
    const text = candidateText("location", "é".repeat(90), "🙂".repeat(1000));
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024);
    expect(Buffer.byteLength(text.split("\n")[1])).toBe(120);
    expect(text).not.toContain("�");
});

test("pins certified catalog fingerprint and orders raw logits with stable ties in one call", async () => {
    expect(pinReranker({ result: catalog })).toEqual({ fingerprint, tableEpoch: 2 });
    let calls = 0;
    const current = {
        ...session(response),
        client: client((method, params) => {
            calls++;
            expect(method).toBe("rerank.score");
            expect(params).toEqual({
                model: RERANK_MODEL,
                query: "How does this work?",
                candidates: texts,
                required_fingerprint: fingerprint,
                allow_equivalent: false,
                max_queue_ms: 100,
                deadline_ms: 1500,
            });
            return { result: response };
        }),
    };
    expect(
        await rerankSearchResults(current, "How does this work?", baseline, pool, texts, 10),
    ).toEqual([pool[1], pool[2], pool[0]]);
    expect(calls).toBe(1);
});

for (const code of [
    "queue_full",
    "shape_compiling",
    "model_loading",
    "deadline_exceeded",
    "internal_error",
    "unavailable",
]) {
    test(`${code} retains arm A rather than fused order`, async () => {
        expect(
            await rerankSearchResults(
                session({ code }, true),
                "How does this work?",
                baseline,
                pool,
                texts,
                10,
            ),
        ).toBe(baseline);
    });
}
for (const [name, invalid] of Object.entries({
    fingerprint: { ...response, fingerprint: "b".repeat(64) },
    epoch: { ...response, table_epoch: 3 },
    count: { ...response, scores: [1] },
    nonfinite: { ...response, scores: [NaN, 1, 2] },
    type: { ...response, scores: ["1", 1, 2] },
    envelope: null,
    returnedError: { error: { code: "queue_full" } },
})) {
    test(`${name} validation retains arm A`, async () => {
        expect(
            await rerankSearchResults(
                session(invalid),
                "How does this work?",
                baseline,
                pool,
                texts,
                10,
            ),
        ).toBe(baseline);
    });
}
test("transport failure retains arm A", async () => {
    expect(
        await rerankSearchResults(
            session(new Error("socket closed"), true),
            "How does this work?",
            baseline,
            pool,
            texts,
            10,
        ),
    ).toBe(baseline);
});
test("client-side deadline retains arm A even if transport ignores timeout", async () => {
    const current = { ...session(response), client: client(() => new Promise(() => {})) };
    const start = performance.now();
    expect(
        await rerankSearchResults(current, "How does this work?", baseline, pool, texts, 10),
    ).toBe(baseline);
    expect(performance.now() - start).toBeLessThan(1900);
});
test("missing Synapse and catalog mismatches cannot enable lane capture", async () => {
    expect(await prepareReranker("git:test", "s", undefined, null)).toBeNull();
    for (const invalid of [
        null,
        { models: [] },
        { ...catalog, table_epoch: undefined },
        { ...catalog, models: [{ ...catalog.models[0], certified: false }] },
        {
            ...catalog,
            models: [{ ...catalog.models[0], fingerprints: [fingerprint, fingerprint] }],
        },
    ])
        expect(
            await prepareReranker(
                "git:test",
                "s",
                undefined,
                client(() => invalid),
            ),
        ).toBeNull();
});

test("classifier gate and auto-search never contact Synapse", async () => {
    const database = store();
    let calls = 0;
    const service = client(() => {
        calls++;
        return catalog;
    });
    for (const query of [
        "cache_ttl",
        "getVisibleMemoryIds",
        "src/search.ts",
        '"prompt cache budget stable"',
    ])
        await unifiedSearch(database, "s", "git:test", query, {
            ...options,
            rerankClient: service,
        });
    await unifiedSearch(database, "s", "git:test", "prompt cache budget stable", {
        ...options,
        explicitSearch: false,
        rerankClient: service,
    });
    expect(calls).toBe(0);
});

test("standalone and every failure return byte-identical results and formatted output", async () => {
    const database = store();
    const shared = { ...options, visibleMemoryIds: new Set([1]), from: 0, to: Date.now() + 1000 };
    const query = "prompt cache budget stable";
    const expected = await unifiedSearch(database, "s", "git:test", query, {
        ...shared,
        rerank: false,
    });
    for (const service of [
        null,
        client(() => {
            throw { code: "ENOENT" };
        }),
        client((method) =>
            method === "models.list" ? catalog : { error: { code: "queue_full" } },
        ),
        client((method) =>
            method === "models.list" ? catalog : { ...response, fingerprint: "wrong" },
        ),
    ]) {
        const actual = await unifiedSearch(database, "s", "git:test", query, {
            ...shared,
            rerankClient: service,
        });
        expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
        expect(formatSearchResults(query, actual, "s")).toBe(
            formatSearchResults(query, expected, "s"),
        );
    }
});

test("product captures eligible lanes once and passes only fused top twenty texts", async () => {
    const database = store();
    let scoreCalls = 0;
    const actual = await unifiedSearch(database, "s", "git:test", "prompt cache budget stable", {
        ...options,
        visibleMemoryIds: new Set([1]),
        rerankClient: client((method, params) => {
            if (method === "models.list") return catalog;
            scoreCalls++;
            const request = params as { candidates: string[] };
            expect(request.candidates.length).toBe(20);
            expect(request.candidates.some((text) => text.startsWith("memory 1 "))).toBe(false);
            return { ...response, scores: request.candidates.map((_, index) => index) };
        }),
    });
    expect(scoreCalls).toBe(1);
    expect(actual).toHaveLength(10);
    expect(actual.some((row) => row.source === "memory" && row.memoryId === 1)).toBe(false);
    expect(
        candidateTexts(database, "s", "git:test", actual).every(
            (text) => Buffer.byteLength(text) <= 1024,
        ),
    ).toBe(true);
});

test("explicit multilingual prose reaches the reranker", async () => {
    const database = store();
    const query = "缓存预算为什么需要保持稳定 cache";
    let scoreCalls = 0;
    const actual = await unifiedSearch(database, "s", "git:test", query, {
        ...options,
        rerankClient: client((method, params) => {
            if (method === "models.list") return catalog;
            scoreCalls++;
            const request = params as { query: string; candidates: string[] };
            expect(request.query).toBe(query);
            expect(request.candidates).toHaveLength(20);
            return { ...response, scores: request.candidates.map((_, index) => index) };
        }),
    });
    expect(scoreCalls).toBe(1);
    expect(actual).toHaveLength(10);
});

test("fallback logs once per reason without changing results", async () => {
    const logged = spyOn(logger, "log").mockImplementation(() => {});
    try {
        for (let i = 0; i < 2; i++) {
            expect(
                await rerankSearchResults(
                    session({ code: "log_contract_control" }, true),
                    "How does this work?",
                    baseline,
                    pool,
                    texts,
                    10,
                ),
            ).toBe(baseline);
        }
        expect(logged).toHaveBeenCalledTimes(1);
        expect(logged.mock.calls[0][0]).toContain("log_contract_control");
    } finally {
        logged.mockRestore();
    }
});

test("message lane capture preserves arm A scores, probes and ordinal filters", () => {
    const database = store();
    ensureMessagesIndexed(database, "s", () =>
        Array.from({ length: 180 }, (_, i) => ({
            ordinal: i + 1,
            id: `m${i + 1}`,
            role: "assistant",
            parts: [{ type: "text", text: `ctx_cache prompt cache budget explanation ${i}` }],
        })),
    );
    for (const probes of [[], ["ctx_cache"]]) {
        for (const limit of [3, 10, 30, 75]) {
            const request = {
                sessionId: "s",
                query: "prompt cache budget explanation",
                limit,
                probes,
                maxOrdinal: 80,
                dateRange: null,
                collectDiagnostics: true,
                relaxedRecall: true,
            };
            const before = searchMessageHistory(database, request);
            const after = searchMessageHistory(database, { ...request, captureLimit: 75 });
            expect(after.results).toEqual(before.results);
            expect(after.suppressedLiveMessageMatches).toBe(before.suppressedLiveMessageMatches);
            expect(after.laneResults?.every((row) => row.messageOrdinal <= 80)).toBe(true);
        }
    }
});
