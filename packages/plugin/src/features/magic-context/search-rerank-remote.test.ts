import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { RerankConfigSchema } from "../../config/schema/magic-context";
import * as logger from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { insertMemory } from "./memory";
import { runMigrations } from "./migrations";
import { formatSearchResults, type UnifiedSearchResult, unifiedSearch } from "./search";
import {
    candidateText,
    prepareReranker,
    remoteRerankSkipped,
    rerankSearchResults,
} from "./search-rerank";
import { initializeDatabase } from "./storage-db";

const KEY = "FAKE_RERANK_KEY_DO_NOT_LEAK_765";
const query = "why does prompt cache budget stay stable";
const pool: UnifiedSearchResult[] = [1, 2, 3].map((memoryId) => ({
    source: "memory",
    memoryId,
    category: "ARCHITECTURE",
    content: `memory ${memoryId}`,
    matchType: "fts",
    score: 1 / memoryId,
}));
const baseline = [pool[2], pool[0]];
const texts = pool.map((row) => candidateText("memory", row.content, "🙂".repeat(1000)));
let server: ReturnType<typeof Bun.serve> | undefined;
let db: Database | undefined;
afterEach(() => {
    server?.stop(true);
    server = undefined;
    db?.close();
    db = undefined;
});
function remote(handler: (req: Request) => Response | Promise<Response>, tei = false, extra = {}) {
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
    return RerankConfigSchema.parse({
        provider: "remote",
        endpoint: `${tei ? "tei+" : ""}${server.url}`,
        model: "reranker",
        api_key: KEY,
        ...extra,
    });
}
function store() {
    db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    for (let i = 0; i < 30; i++)
        insertMemory(db, {
            projectPath: "git:test",
            category: "ARCHITECTURE",
            content: `prompt cache budget stable explanation ${i}`,
        });
    return db;
}
const options = {
    embeddingEnabled: false,
    countRetrievals: false,
    measurementDisabled: true,
    sources: ["memory" as const],
    limit: 10,
    rerankClient: null,
};

for (const tei of [false, true])
    describe(tei ? "TEI" : "Cohere-compatible", () => {
        test("maps shuffled indexes and keeps stable ties using the shared candidate recipe", async () => {
            let calls = 0;
            const config = remote(async (req) => {
                calls++;
                expect(new URL(req.url).pathname).toBe("/rerank");
                expect(req.method).toBe("POST");
                expect(req.headers.get("Authorization")).toBe(`Bearer ${KEY}`);
                // No `top_n`: Voyage refuses it, and the others score every
                // document without it.
                expect(await req.json()).toEqual(
                    tei ? { query, texts } : { model: "reranker", query, documents: texts },
                );
                const rows = [
                    { index: 2, score: 5 },
                    { index: 0, score: -1 },
                    { index: 1, score: 5 },
                ];
                return Response.json(
                    tei
                        ? rows
                        : {
                              results: rows.map(({ index, score }) => ({
                                  index,
                                  relevance_score: score,
                              })),
                          },
                );
            }, tei);
            const session = await prepareReranker("git:test", "s", undefined, null, config);
            expect(session).not.toBeNull();
            expect(await rerankSearchResults(session!, query, baseline, pool, texts, 3)).toEqual([
                pool[1],
                pool[2],
                pool[0],
            ]);
            expect(calls).toBe(1);
            expect(
                texts.every((text) => Buffer.byteLength(text) <= 1024 && !text.includes("�")),
            ).toBe(true);
        });
        const valid = [
            { index: 0, score: 1 },
            { index: 1, score: 2 },
            { index: 2, score: 3 },
        ];
        for (const [name, rows] of Object.entries({
            negative: [{ index: -1, score: 1 }, ...valid.slice(1)],
            outOfRange: [{ index: 3, score: 1 }, ...valid.slice(1)],
            fractional: [{ index: 0.5, score: 1 }, ...valid.slice(1)],
            stringIndex: [{ index: "0", score: 1 }, ...valid.slice(1)],
            missingIndex: [{ score: 1 }, ...valid.slice(1)],
            duplicate: [valid[1], valid[1], valid[2]],
            missing: valid.slice(1),
            extra: [...valid, { index: 3, score: 4 }],
            nullScore: [{ index: 0, score: null }, ...valid.slice(1)],
            stringScore: [{ index: 0, score: "1" }, ...valid.slice(1)],
            missingScore: [{ index: 0 }, ...valid.slice(1)],
            nullRow: [null, ...valid.slice(1)],
            notArray: {},
            envelope: null,
        }))
            test(`rejects ${name} reply without partially reranking`, async () => {
                const config = remote(() => {
                    if (tei) return Response.json(rows);
                    return Response.json({
                        results: Array.isArray(rows)
                            ? rows.map(
                                  (row) =>
                                      row && {
                                          index: "index" in row ? row.index : undefined,
                                          relevance_score: "score" in row ? row.score : undefined,
                                      },
                              )
                            : rows,
                    });
                }, tei);
                let skipped = "";
                expect(
                    await rerankSearchResults(
                        { remote: config },
                        query,
                        baseline,
                        pool,
                        texts,
                        3,
                        undefined,
                        (line) => {
                            skipped = line;
                        },
                    ),
                ).toBe(baseline);
                expect(skipped).toBe("Reranking skipped: invalid_reply");
            });
        test("rejects nonfinite JSON numeric scores", async () => {
            const config = remote(
                () =>
                    new Response(
                        tei
                            ? '[{"index":0,"score":1e400},{"index":1,"score":2},{"index":2,"score":3}]'
                            : '{"results":[{"index":0,"relevance_score":1e400},{"index":1,"relevance_score":2},{"index":2,"relevance_score":3}]}',
                    ),
                tei,
            );
            expect(
                await rerankSearchResults({ remote: config }, query, baseline, pool, texts, 3),
            ).toBe(baseline);
        });
    });

test("refuses twenty-one candidates in one batch without a hosted call", async () => {
    let calls = 0;
    const config = remote(() => {
        calls++;
        return Response.json({});
    });
    const tooMany = Array.from({ length: 21 }, () => pool[0]);
    let skipped = "";
    expect(
        await rerankSearchResults(
            { remote: config },
            query,
            baseline,
            tooMany,
            tooMany.map(() => "text"),
            10,
            undefined,
            (line) => {
                skipped = line;
            },
        ),
    ).toBe(baseline);
    expect(calls).toBe(0);
    expect(skipped).toBe("Reranking skipped: validation");
});

test("remote timeout retains original order and never tries Synapse", async () => {
    const config = remote(() => new Promise(() => {}), false, { timeout_ms: 50 });
    let skipped = "";
    const start = performance.now();
    expect(
        await rerankSearchResults(
            { remote: config },
            query,
            baseline,
            pool,
            texts,
            3,
            undefined,
            (line) => {
                skipped = line;
            },
        ),
    ).toBe(baseline);
    expect(skipped).toBe("Reranking skipped: timeout");
    expect(performance.now() - start).toBeLessThan(1000);
});

test("ctx_search abort signal cancels a hosted call mid-request", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const seen = new Promise<void>((resolve) => {
        started = resolve;
    });
    const config = remote(() => {
        started();
        return new Promise(() => {});
    });
    const database = store();
    let skipped = "";
    const result = unifiedSearch(database, "s", "git:test", query, {
        ...options,
        explicitSearch: true,
        rerankConfig: config,
        signal: controller.signal,
        onRerankSkipped: (line) => {
            skipped = line;
        },
    });
    await seen;
    controller.abort(new Error(KEY));
    await result;
    expect(skipped).toBe("Reranking skipped: aborted");
});

test("automatic search and literal queries never make hosted calls", async () => {
    let calls = 0;
    const config = remote(() => {
        calls++;
        return Response.json({});
    });
    const database = store();
    await unifiedSearch(database, "s", "git:test", query, {
        ...options,
        rerankConfig: config,
        explicitSearch: false,
    });
    await unifiedSearch(database, "s", "git:test", "cache_ttl", {
        ...options,
        rerankConfig: config,
        explicitSearch: true,
    });
    expect(calls).toBe(0);
});

test("a Voyage-style reply under data reranks like results", async () => {
    const config = remote(async (req) => {
        const body = (await req.json()) as Record<string, unknown>;
        // Voyage answers 400 to any request carrying top_n.
        if ("top_n" in body) return new Response("top_n is not supported", { status: 400 });
        return Response.json({
            object: "list",
            data: [
                { relevance_score: 5, index: 2 },
                { relevance_score: -1, index: 0 },
                { relevance_score: 5, index: 1 },
            ],
            model: "reranker",
            usage: { total_tokens: 0 },
        });
    }, false);
    const session = await prepareReranker("git:test", "s", undefined, null, config);
    expect(session).not.toBeNull();
    expect(await rerankSearchResults(session!, query, baseline, pool, texts, 3)).toEqual([
        pool[1],
        pool[2],
        pool[0],
    ]);
});

test("top_n bounds the shared fused candidate pool and failure keeps baseline bytes", async () => {
    let calls = 0;
    let synapseCalls = 0;
    const config = remote(
        async (req) => {
            calls++;
            const body = (await req.json()) as { documents: string[]; top_n?: number };
            expect(body.documents).toHaveLength(4);
            expect(body.top_n).toBeUndefined();
            return new Response(KEY, { status: 503 });
        },
        false,
        { top_n: 4 },
    );
    const database = store();
    const expected = await unifiedSearch(database, "s", "git:test", query, {
        ...options,
        explicitSearch: true,
        rerank: false,
    });
    let skipped = "";
    const actual = await unifiedSearch(database, "s", "git:test", query, {
        ...options,
        rerankClient: {
            async call() {
                synapseCalls++;
                throw new Error("Synapse must not be called");
            },
            close() {},
        },
        explicitSearch: true,
        rerankConfig: config,
        onRerankSkipped: (line) => {
            skipped = line;
        },
    });
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
    expect(formatSearchResults(query, actual, "s")).toBe(formatSearchResults(query, expected, "s"));
    expect(skipped).toBe("Reranking skipped: http_503");
    expect(calls).toBe(1);
    expect(synapseCalls).toBe(0);
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
        name: string;
    }[];
    for (const { name } of tables) {
        expect(
            JSON.stringify(database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()),
        ).not.toContain(KEY);
    }
});

test("remote errors and untrusted reasons redact keys and bodies from logs and output", async () => {
    const logged = spyOn(logger, "log").mockImplementation(() => {});
    const lines: string[] = [];
    try {
        const config = remote(() => new Response(`provider body ${KEY}`, { status: 401 }));
        await rerankSearchResults(
            { remote: config },
            query,
            baseline,
            pool,
            texts,
            3,
            undefined,
            (line) => lines.push(line),
        );
        remoteRerankSkipped(KEY, (line) => lines.push(line));
        expect(lines).toEqual(["Reranking skipped: http_401", "Reranking skipped: remote_error"]);
        expect(lines.every((line) => line.length <= 80)).toBe(true);
        expect(JSON.stringify({ lines, logs: logged.mock.calls })).not.toContain(KEY);
        expect(JSON.stringify(logged.mock.calls)).not.toContain("provider body");
    } finally {
        logged.mockRestore();
    }
});

test("invalid JSON and network errors return safe reasons", async () => {
    const config = remote(() => new Response(KEY));
    let skipped = "";
    expect(
        await rerankSearchResults(
            { remote: config },
            query,
            baseline,
            pool,
            texts,
            3,
            undefined,
            (line) => {
                skipped = line;
            },
        ),
    ).toBe(baseline);
    expect(skipped).toBe("Reranking skipped: remote_error");
    server!.stop(true);
    expect(
        await rerankSearchResults(
            { remote: config },
            query,
            baseline,
            pool,
            texts,
            3,
            undefined,
            (line) => {
                skipped = line;
            },
        ),
    ).toBe(baseline);
    expect(skipped).toBe("Reranking skipped: remote_error");
});

test("rerank config defaults and timeout clamps", () => {
    expect(RerankConfigSchema.parse({}).provider).toBe("synapse");
    expect(RerankConfigSchema.parse({}).timeout_ms).toBe(1500);
    expect(RerankConfigSchema.parse({ timeout_ms: 1 }).timeout_ms).toBe(50);
    expect(RerankConfigSchema.parse({ timeout_ms: 90000 }).timeout_ms).toBe(15000);
    expect(RerankConfigSchema.safeParse({ provider: "remote" }).success).toBe(false);
    expect(RerankConfigSchema.safeParse({ top_n: 21 }).success).toBe(false);
});
